// Claude drives the desktop: a manual computer-use loop (computer_toolset_20260801) so every
// action passes through our safety checks before xdotool runs it.
//
// One conversation per spoken/typed command. Earlier commands come in as a short text recap
// instead of a growing transcript, and the transcript within a task is append-only (pruning old
// screenshots would invalidate later thinking blocks).

import Anthropic from '@anthropic-ai/sdk';
import type { Desktop } from './computer.ts';
import { MouseWatch, needsConfirm } from './safety.ts';

type Beta = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;

export type AgentEvent =
  | { type: 'start'; command: string }
  | { type: 'progress'; text: string }
  | { type: 'action'; name: string; input: unknown; ok: boolean; detail?: string }
  | { type: 'turn'; step: number; ms: number; input: number; cacheRead: number; output: number }
  | { type: 'shot'; png: string }
  | { type: 'confirm'; question: string }
  | { type: 'confirmed'; ok: boolean }
  | { type: 'done'; summary: string; steps: number; ms: number }
  | { type: 'stopped'; reason: string }
  | { type: 'error'; message: string }
  /** Push-to-talk key tapped (from server/hotkey.ts, not the agent). */
  | { type: 'ptt' };

export type AgentOpts = {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps: number;
  /** On: ask_user + risky-action gate + mouse-takeover/corner aborts. Off: none of those interrupt the task. */
  safeMode: boolean;
};

const CONFIRM_TIMEOUT_MS = 60_000;
const RECAP = 5;

const ASK_USER: Anthropic.Beta.Messages.BetaTool = {
  name: 'ask_user',
  description:
    "Ask the person a short yes/no question out loud and wait for their answer. Use it right before anything that sends, posts, buys, pays, deletes, or can't be undone, and when guessing wrong could do harm. Returns what they said.",
  input_schema: {
    type: 'object',
    properties: { question: { type: 'string', description: 'One short yes/no question, read aloud.' } },
    required: ['question'],
    additionalProperties: false,
  },
  strict: true,
};

function system(w: number, h: number, safe: boolean): string {
  // Stable per screen size and mode, so it caches.
  const safeRules = safe
    ? `
- Call ask_user before sending a message, posting, buying, paying, deleting files, or anything else that can't be undone. Keep the question short.
- If the person moves the mouse, you will be stopped; that is expected.`
    : '';
  return `You control a real Ubuntu desktop (GNOME on X11, ${w}x${h}) for the person sitting at it. They give you short spoken commands; do what they ask with the computer tools, then stop.

How to work:
- Prefer the keyboard when it is reliable: the Super key opens GNOME Activities, where you can type an app name and press Return; ctrl+l focuses a browser address bar; alt+F4 closes a window.
- Batch several actions in one turn when you are confident of the result (for example: click a field, type, press Return), then check with a screenshot.
- A browser tab or window titled "Gymote Desktop" is your own control panel. Never click, type into, or close it; switch away from it to do the task.
- A small dark pill near the bottom of the screen is a status overlay. Ignore it; it never takes focus.
- If something unexpected appears (a login prompt, a payment page, a permission dialog), stop and say so instead of guessing.${safeRules}

When you are finished (or can't continue), reply with one short sentence that will be read aloud, saying what you did or what went wrong. No markdown.`;
}

export class Agent {
  private client: Anthropic | null = null;
  private desktop: Desktop;
  private opts: AgentOpts;
  private emit: (e: AgentEvent) => void;
  private watch: MouseWatch;
  private abort: AbortController | null = null;
  private pendingConfirm: ((ok: boolean) => void) | null = null;
  private history: { command: string; summary: string }[] = [];

  constructor(desktop: Desktop, opts: AgentOpts, emit: (e: AgentEvent) => void) {
    this.desktop = desktop;
    this.opts = opts;
    this.emit = emit;
    this.watch = new MouseWatch(desktop);
  }

  get running(): boolean {
    return this.abort !== null;
  }

  get confirming(): boolean {
    return this.pendingConfirm !== null;
  }

  stop(reason = 'stopped'): void {
    this.abort?.abort(new Error(reason));
    this.pendingConfirm?.(false);
  }

  confirm(ok: boolean): boolean {
    if (!this.pendingConfirm) return false;
    this.pendingConfirm(ok);
    return true;
  }

  /** Runs one command to completion (or stop). Resolves when the task is over; never throws. */
  async run(command: string): Promise<void> {
    if (this.abort) throw new Error('a task is already running');
    const abort = new AbortController();
    this.abort = abort;
    const t0 = Date.now();
    this.emit({ type: 'start', command });
    if (this.opts.safeMode) this.watch.start((reason) => this.stop(reason));

    try {
      const summary = await this.loop(command, abort.signal);
      this.history.push({ command, summary: summary.text });
      if (this.history.length > RECAP) this.history.shift();
      this.emit({ type: 'done', summary: summary.text, steps: summary.steps, ms: Date.now() - t0 });
    } catch (e) {
      if (abort.signal.aborted) {
        const reason = abort.signal.reason instanceof Error ? abort.signal.reason.message : 'stopped';
        this.history.push({ command, summary: `(stopped: ${reason})` });
        this.emit({ type: 'stopped', reason });
      } else {
        console.error('[agent]', e);
        const message = e instanceof Anthropic.APIError ? `Claude ${e.status}: ${e.message}` : String(e instanceof Error ? e.message : e);
        this.emit({ type: 'error', message });
      }
    } finally {
      this.watch.stop();
      this.pendingConfirm = null;
      this.abort = null;
    }
  }

  private async loop(command: string, signal: AbortSignal): Promise<{ text: string; steps: number }> {
    this.client ??= new Anthropic();
    const [w, h] = this.desktop.shotSize;
    const recap = this.history.length
      ? `Earlier commands this session (most recent last):\n${this.history.map((x) => `- "${x.command}" → ${x.summary}`).join('\n')}\n\n`
      : '';

    // Start with a screenshot so the first turn can act instead of asking for one.
    const first = await this.desktop.screenshot();
    this.emit({ type: 'shot', png: first.toString('base64') });
    const messages: Beta[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${recap}Command: ${command}\n\nThe current screen:` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: first.toString('base64') } },
        ],
      },
    ];

    let narration = '';
    let approvedFor = 0; // actions left that a recent "yes" covers

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      const t = Date.now();
      const msg = await this.client.beta.messages.create(
        {
          model: this.opts.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
          fallbacks: 'default',
          thinking: { type: 'adaptive', display: 'updates' },
          output_config: { effort: this.opts.effort },
          cache_control: { type: 'ephemeral' },
          system: system(w, h, this.opts.safeMode),
          tools: this.opts.safeMode ? [{ type: 'computer_toolset_20260801' }, ASK_USER] : [{ type: 'computer_toolset_20260801' }],
          messages,
        },
        { signal },
      );
      this.emit({
        type: 'turn',
        step,
        ms: Date.now() - t,
        input: msg.usage.input_tokens,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        output: msg.usage.output_tokens,
      });
      messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });

      const said: string[] = [];
      for (const b of msg.content) {
        if (b.type === 'thinking' && b.thinking.trim()) {
          narration = b.thinking;
          this.emit({ type: 'progress', text: b.thinking.trim() });
        } else if (b.type === 'text' && b.text.trim()) {
          narration = b.text;
          said.push(b.text.trim());
        }
      }

      if (msg.stop_reason === 'refusal') {
        throw new Error(`Claude declined (${msg.stop_details?.category ?? 'no category'})`);
      }
      if (msg.stop_reason === 'pause_turn') continue;
      if (msg.stop_reason !== 'tool_use') {
        return { text: said.join(' ') || 'Done.', steps: step };
      }

      const uses = msg.content.filter((b): b is ToolUse => b.type === 'tool_use');
      const results: ToolResult[] = [];
      let failed = false;
      let sawImage = false;

      for (const use of uses) {
        signal.throwIfAborted();
        const input = (use.input ?? {}) as Record<string, unknown>;
        const isComputer = use.toolset_name === 'computer';
        const base = { type: 'tool_result' as const, tool_use_id: use.id, ...(isComputer ? { toolset_name: 'computer' } : {}) };

        // Batch rule: after the first failure, the rest are reported as not run.
        if (failed) {
          results.push({ ...base, is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' });
          continue;
        }

        if (!isComputer && use.name === 'ask_user') {
          const ok = await this.ask(String(input.question ?? 'Should I continue?'), signal);
          if (ok) approvedFor = 4;
          results.push({ ...base, content: ok ? 'The person said yes.' : "The person said no. Don't do it; stop or find another way." });
          continue;
        }
        if (!isComputer) {
          results.push({ ...base, is_error: true, content: `Unknown tool ${use.name}` });
          failed = true;
          continue;
        }

        const risky = this.opts.safeMode && needsConfirm(use.name, input, narration, approvedFor > 0);
        if (risky) {
          const ok = await this.ask(risky, signal);
          if (!ok) {
            results.push({ ...base, is_error: true, content: 'The person declined this action when asked. Do not retry it.' });
            failed = true;
            continue;
          }
          approvedFor = 4;
        }
        if (approvedFor > 0) approvedFor--;

        try {
          const r = await this.watch.during(() => this.desktop.execute(use.name, input, signal));
          if ('png' in r) {
            sawImage = true;
            const data = r.png.toString('base64');
            this.emit({ type: 'shot', png: data });
            this.emit({ type: 'action', name: use.name, input, ok: true });
            results.push({ ...base, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] });
          } else {
            sawImage = false;
            this.emit({ type: 'action', name: use.name, input, ok: true, detail: r.text === 'OK' ? undefined : r.text });
            results.push({ ...base, content: [{ type: 'text', text: r.text }] });
          }
        } catch (e) {
          signal.throwIfAborted();
          const detail = e instanceof Error ? e.message : String(e);
          this.emit({ type: 'action', name: use.name, input, ok: false, detail });
          results.push({ ...base, is_error: true, content: `Error: ${detail}` });
          failed = true;
        }
      }

      // If the batch didn't end on a screenshot, attach one so Claude sees the result without
      // spending a turn asking for it.
      const last = results[results.length - 1];
      if (!sawImage && last && last.toolset_name === 'computer' && !last.is_error) {
        const png = (await this.desktop.screenshot()).toString('base64');
        this.emit({ type: 'shot', png });
        const prior = Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: String(last.content ?? 'OK') }];
        last.content = [...prior, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }];
      }

      messages.push({ role: 'user', content: results });
    }

    return { text: `I stopped after ${this.opts.maxSteps} steps without finishing.`, steps: this.opts.maxSteps };
  }

  /** Puts a yes/no question to the person (UI + voice) and waits. Mouse moves don't count as takeover here. */
  private ask(question: string, signal: AbortSignal): Promise<boolean> {
    return this.watch.during(
      () =>
        new Promise<boolean>((resolve) => {
          const finish = (ok: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            this.pendingConfirm = null;
            this.emit({ type: 'confirmed', ok });
            resolve(ok);
          };
          const onAbort = () => finish(false);
          const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
          signal.addEventListener('abort', onAbort, { once: true });
          this.pendingConfirm = finish;
          this.emit({ type: 'confirm', question });
        }),
    );
  }
}
