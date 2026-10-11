// Orion from the phone: Orion starts recording the laptop mic, OK sends what you said to Claude
// (os-control-spike's computer-use agent), Cancel throws it away. While Claude works, Cancel stops it.
// With SAFE_MODE=1 Claude may ask a yes/no question first: OK = yes, Cancel = no.
//
// Recording only ever goes to Claude on OK; after MAX_MS without one it's thrown away.
// The mic and Scribe are server/speech.ts, shared with dictation.

import { Agent, type AgentEvent, type AgentOpts } from './agent.ts';
import { Desktop } from './computer.ts';
import { pcmMs, Recorder, transcribe, wav, type SttOpts } from './speech.ts';

export type { SttOpts } from './speech.ts';

const MAX_MS = 60_000;
const LISTENING = '● Orion is listening… press OK on the phone';
/** Below this much audio, OK has nothing to send. */
const MIN_MS = 300;
/** Screen memory tools (server/memory/tools.ts), in words. */
const ACTION_TEXT: Record<string, string> = {
  search_memory: 'searching memory',
  memory_timeline: 'going through memory',
  view_memory_screenshot: 'looking at an earlier screen',
};

export type OrionState = 'idle' | 'listening' | 'transcribing' | 'working' | 'confirm';
export type OverlayMsg = {
  state: 'listening' | 'transcribing' | 'working' | 'done' | 'error' | 'info' | 'hidden';
  level?: number;
  text?: string;
};

// Vite re-runs the plugin when a server file changes: stop the old run's task and recording.
const g = globalThis as { __gymoteOrion?: Orion };

export class Orion {
  state: OrionState = 'idle';
  /** What to show under the state: the last progress note, question, or summary. */
  text = '';
  private rec = new Recorder();
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private desktop = new Desktop();
  private ready: Promise<void>;
  private agent: Agent;

  constructor(
    agentOpts: AgentOpts,
    private stt: SttOpts,
    private hasClaude: boolean,
    private onChange: () => void,
    private overlay: (m: OverlayMsg) => void,
    /** What was asked and how it ended, for screen memory's log. */
    private log: (text: string) => void = () => {},
  ) {
    g.__gymoteOrion?.dispose();
    g.__gymoteOrion = this;
    this.ready = this.desktop.init().catch((e) => console.warn('[orion] xdotool getdisplaygeometry failed:', e));
    this.agent = new Agent(this.desktop, agentOpts, (e) => this.onAgent(e));
  }

  /** Why Orion can't run, or null. */
  get missing(): string | null {
    if (!this.hasClaude) return 'no ANTHROPIC_API_KEY in .env';
    if (!this.stt.elevenKey) return 'no ELEVENLABS_API_KEY in .env';
    return null;
  }

  start() {
    if (this.state !== 'idle') return;
    if (this.missing) return this.set('idle', `Orion is off: ${this.missing}`, { state: 'error' });
    this.rec.start(
      (level) => this.overlay({ state: 'listening', level, text: LISTENING }),
      (e) => {
        console.warn('[orion] arecord failed:', e.message);
        this.discard();
        this.set('idle', `Mic failed: ${e.message}`, { state: 'error' });
      },
    );
    // Never send on its own: Claude only acts on an explicit OK. A forgotten recording is dropped.
    this.capTimer = setTimeout(() => {
      this.discard();
      this.set('idle', 'Listening timed out, nothing sent.', { state: 'info', text: 'Orion: listening timed out (60 s), nothing sent' });
    }, MAX_MS);
    this.set('listening', 'Say the command, then press OK.', { state: 'listening', level: 0, text: LISTENING });
  }

  async ok() {
    if (this.state === 'confirm') return void this.agent.confirm(true);
    if (this.state !== 'listening') return;
    const pcm = this.rec.stop();
    this.discard();
    if (pcmMs(pcm) < MIN_MS) return this.set('idle', 'Didn’t hear anything.', { state: 'error' });
    this.set('transcribing', 'Transcribing…', { state: 'transcribing' });
    let command: string;
    try {
      command = await transcribe(wav(pcm), this.stt);
    } catch (e) {
      console.warn('[orion] stt failed:', (e as Error).message);
      return this.set('idle', `Transcription failed: ${(e as Error).message.slice(0, 80)}`, { state: 'error' });
    }
    // Cancel may have come in while Scribe was working (TS can't see that `set` changed state).
    if ((this.state as OrionState) !== 'transcribing') return;
    if (!command) return this.set('idle', 'Didn’t catch that.', { state: 'error' });
    console.log(`[orion] command ${JSON.stringify(command)}`);
    this.log(`asked “${command}”`);
    await this.ready;
    this.set('working', `“${command}”`, { state: 'working' });
    void this.agent.run(command);
  }

  cancel() {
    if (this.state === 'listening') {
      this.discard();
      this.set('idle', 'Cancelled.', { state: 'info', text: 'Orion cancelled' });
    } else if (this.state === 'transcribing') {
      this.set('idle', 'Cancelled.', { state: 'info', text: 'Orion cancelled' });
    } else if (this.state === 'confirm') {
      this.agent.confirm(false);
    } else if (this.state === 'working') {
      this.agent.stop('cancelled from the phone');
    }
  }

  dispose() {
    this.discard();
    this.agent.stop('server reloaded');
  }

  private discard() {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.rec.stop();
  }

  private onAgent(e: AgentEvent) {
    if (e.type === 'shot') return;
    console.log('[orion]', JSON.stringify(e).slice(0, 300));
    switch (e.type) {
      case 'progress':
        return this.set('working', e.text, { state: 'working' });
      case 'action':
        return this.set('working', `${ACTION_TEXT[e.name] ?? e.name}${e.ok ? '' : ' (failed)'}`, { state: 'working' });
      case 'confirm':
        return this.set('confirm', e.question, { state: 'working', text: `${e.question}  (OK = yes, Cancel = no)` });
      case 'confirmed':
        return this.set('working', e.ok ? 'Going ahead.' : 'Not doing that.', { state: 'working' });
      case 'done':
        this.log(`answered “${e.summary}”`);
        return this.set('idle', e.summary, { state: 'done' });
      case 'stopped':
        return this.set('idle', `Stopped: ${e.reason}`, { state: 'info' });
      case 'error':
        return this.set('idle', `Error: ${e.message}`, { state: 'error' });
    }
  }

  private set(state: OrionState, text: string, overlay: OverlayMsg) {
    this.state = state;
    this.text = text;
    this.overlay({ text: state === 'working' ? `Orion: ${text}` : text, ...overlay });
    this.onChange();
  }
}
