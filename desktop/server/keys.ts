// Keystroke mode: say a key, the computer presses it. No AI: server/keys.py hears a fixed word list
// with Vosk (offline, ~0.2 s), and this turns the words into xdotool key presses.
//
//   "left"            tap Left               "hold up"   keydown Up (stays down)
//   "stop up"         keyup Up               "stop"      (alone, then a pause) release everything held
//   "release down"    same as "stop down"
//
// Words can run together ("left left jump"); each acts as soon as it's heard.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Wall clock with ms, for the GM_DEBUG_KEYS log. */
const clock = () => new Date().toISOString().slice(11, 23);

/** Spoken word → X keysym. Add a row to teach it a key (the word must be in Vosk's vocabulary). */
export const KEYMAP: Record<string, string> = {
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  space: 'space',
  jump: 'space',
  enter: 'Return',
  escape: 'Escape',
};
const MODIFIERS = ['hold', 'stop', 'release'] as const;
/**
 * How long a tap holds the key down. xdotool's own `key` holds it ~6 ms, shorter than a frame, so
 * games that check key state once per frame miss it at random.
 */
export const TAP_HOLD_MS = 40;
export const GRAMMAR = [...Object.keys(KEYMAP), ...MODIFIERS];

export type KeyAction =
  | { kind: 'tap' | 'down' | 'up'; key: string; said: string }
  | { kind: 'release'; keys: string[]; said: string };

/** Words in, key actions out. Pure, so scripts/keys-test.ts can check it without a mic. */
export class KeyParser {
  /** Keysyms currently held down by "hold". */
  readonly held = new Set<string>();
  private pending: 'hold' | 'stop' | null = null;

  word(w: string): KeyAction[] {
    const out: KeyAction[] = [];
    if (w === 'hold' || w === 'stop' || w === 'release') {
      // "stop hold up": the first stop had no key, so it meant "release everything".
      if (this.pending === 'stop') out.push(...this.releaseAll('stop'));
      this.pending = w === 'hold' ? 'hold' : 'stop';
      return out;
    }
    const key = KEYMAP[w];
    if (!key) return out;
    const mod = this.pending;
    this.pending = null;
    if (mod === 'hold') {
      if (this.held.has(key)) return out;
      this.held.add(key);
      out.push({ kind: 'down', key, said: `hold ${w}` });
    } else if (mod === 'stop') {
      this.held.delete(key);
      out.push({ kind: 'up', key, said: `stop ${w}` });
    } else {
      // A tap of a held key presses and releases it, so it's no longer held.
      this.held.delete(key);
      out.push({ kind: 'tap', key, said: w });
    }
    return out;
  }

  /** The utterance ended (a pause). A dangling "stop" releases everything; a dangling "hold" is dropped. */
  end(): KeyAction[] {
    const mod = this.pending;
    this.pending = null;
    return mod === 'stop' ? this.releaseAll('stop') : [];
  }

  releaseAll(said = 'release all'): KeyAction[] {
    this.pending = null;
    if (!this.held.size) return [];
    const keys = [...this.held];
    this.held.clear();
    return [{ kind: 'release', keys, said }];
  }
}

export function xdotoolArgs(a: KeyAction): string[] {
  if (a.kind === 'release') return ['keyup', ...a.keys];
  if (a.kind === 'tap') return ['keydown', a.key, 'sleep', String(TAP_HOLD_MS / 1000), 'keyup', a.key];
  return [a.kind === 'down' ? 'keydown' : 'keyup', a.key];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs key actions one after another (so "hold up … stop up" can't arrive reversed), keeping taps
 * at least `gapMs` apart: games that animate a move (Bloxorz rolling the block) ignore keys until
 * it's done, so "right right right" said quickly would lose presses. Taps queue; none are dropped
 * unless cancel() is called (keystroke mode turned off).
 */
export class KeyPresser {
  gapMs = 0;
  private chain = Promise.resolve();
  private lastTapAt = -Infinity;
  private generation = 0;
  private exec: (args: string[]) => Promise<unknown>;

  constructor(exec: (args: string[]) => Promise<unknown>) {
    this.exec = exec;
  }

  /** Resolves once the action ran (or was cancelled); `ms` is the time from queueing to done. */
  press(a: KeyAction, onDone?: (ms: number) => void): Promise<void> {
    const gen = this.generation;
    const queued = performance.now();
    this.chain = this.chain.then(async () => {
      if (a.kind === 'tap') {
        const wait = this.lastTapAt + this.gapMs - performance.now();
        if (wait > 0) await sleep(wait);
        if (gen !== this.generation) return;
        this.lastTapAt = performance.now();
      }
      try {
        await this.exec(xdotoolArgs(a));
      } catch (e) {
        console.warn('[keys] xdotool failed:', (e as Error).message);
      }
      onDone?.(performance.now() - queued);
    });
    return this.chain;
  }

  /** Drops taps still waiting for their gap (key-ups and releases still run). */
  cancel() {
    this.generation++;
  }
}

const VENV_PY = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
const MODEL = fileURLToPath(new URL('../models/vosk-model-small-en-us-0.15', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./keys.py', import.meta.url));

export type KeysStatus = 'unavailable' | 'off' | 'loading' | 'on';

// Vite re-runs the plugin when a server file changes: the old listener must not keep pressing keys.
const g = globalThis as { __gymoteKeys?: KeyMode };

/**
 * Runs keys.py and presses what it hears. `wanted` is the phone's toggle; `suspended` is set while
 * Orion listens or works, so the spoken command isn't typed as keys.
 */
export class KeyMode {
  readonly available = existsSync(VENV_PY) && existsSync(MODEL);
  private proc: ChildProcess | null = null;
  private loaded = false;
  private wanted = false;
  private suspended = false;
  private listening = false;
  private parser = new KeyParser();
  // GM_DRY_RUN=1 (like the pointer): log instead of pressing, for testing without touching the desktop.
  private presser = new KeyPresser((args) =>
    process.env.GM_DRY_RUN ? Promise.resolve(console.log(`[dry] xdotool ${args.join(' ')}`)) : run('xdotool', args),
  );

  private onHeard: (a: KeyAction) => void;
  private onStatus: () => void;

  constructor(onHeard: (a: KeyAction) => void, onStatus: () => void) {
    this.onHeard = onHeard;
    this.onStatus = onStatus;
    g.__gymoteKeys?.dispose();
    g.__gymoteKeys = this;
    if (!this.available) console.warn('[keys] no .venv or Vosk model: run `npm run setup:keys` for keystroke mode');
  }

  get status(): KeysStatus {
    if (!this.available) return 'unavailable';
    if (!this.wanted) return 'off';
    return this.loaded ? 'on' : 'loading';
  }

  get on(): boolean {
    return this.wanted;
  }

  set(on: boolean) {
    if (!this.available) return;
    this.wanted = on;
    this.sync();
  }

  /** Minimum time between taps, ms (the control page's "gap between keys"). */
  setGap(ms: number) {
    this.presser.gapMs = Math.max(0, Math.min(2000, ms));
  }

  get gap(): number {
    return this.presser.gapMs;
  }

  suspend(s: boolean) {
    this.suspended = s;
    this.sync();
  }

  dispose() {
    this.wanted = false;
    this.sync();
    this.proc?.kill();
    this.proc = null;
  }

  private sync() {
    const listen = this.wanted && !this.suspended;
    if (listen && !this.proc) this.spawn();
    if (listen !== this.listening && this.loaded) {
      this.listening = listen;
      this.proc?.stdin?.write(listen ? 'on\n' : 'off\n');
    }
    // Never leave a key stuck down (or a queued tap pending) when we stop listening.
    if (!listen) {
      this.presser.cancel();
      this.parser.releaseAll().forEach((a) => this.press(a));
    }
    this.onStatus();
  }

  private spawn() {
    const child = spawn(VENV_PY, [SCRIPT, MODEL, ...GRAMMAR], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = child;
    this.loaded = false;
    this.listening = false;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) this.line(line);
    });
    child.on('exit', (code) => {
      if (this.proc !== child) return;
      console.warn(`[keys] keys.py exited (${code})`);
      this.proc = null;
      this.loaded = this.listening = false;
      this.wanted = false;
      this.parser.releaseAll().forEach((a) => this.press(a));
      this.onStatus();
    });
  }

  private line(line: string) {
    let msg: { type: string; w?: string; message?: string; text?: string; src?: string; at?: number; behind?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      this.loaded = true;
      console.log('[keys] Vosk ready');
      this.sync();
    } else if (msg.type === 'partial') {
      console.log(`[keys] ${clock()} partial @${msg.at?.toFixed(2)}s "${msg.text}"`);
    } else if (msg.type === 'word' && msg.w) {
      const where = `${msg.src} @${msg.at?.toFixed(2)}s, ${msg.behind} ms behind`;
      const actions = this.parser.word(msg.w);
      if (process.env.GM_DEBUG_KEYS && !actions.length) console.log(`[keys] ${clock()} heard ${msg.w} (${where})`);
      actions.forEach((a) => this.press(a, where));
    } else if (msg.type === 'end') {
      this.parser.end().forEach((a) => this.press(a));
    } else if (msg.type === 'error') {
      console.warn(`[keys] ${msg.message}`);
    }
  }

  private press(a: KeyAction, where = '') {
    // One xdotool per action. No --clearmodifiers: games read raw keys.
    const heardAt = clock();
    void this.presser.press(a, (ms) => {
      if (process.env.GM_DEBUG_KEYS) console.log(`[keys] ${heardAt} heard "${a.said}"${where ? ` (${where})` : ''} → ${xdotoolArgs(a).join(' ')}, done +${Math.round(ms)} ms`);
    });
    this.onHeard(a);
  }
}
