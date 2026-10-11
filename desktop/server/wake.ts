// "Hey Mars": server/wake.py listens offline (Vosk, a tiny grammar) and this turns what it hears
// into callbacks: the wake phrase starts Mars listening (the phone's OK still sends), and a spoken
// "yes" / "no" answers Mars's question while it asks one. Built like keystroke mode (keys.ts).
//
// Nothing leaves the laptop: Mars's own recorder only starts after the wake phrase.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { KeysStatus } from '../src/net/link.ts';

const VENV_PY = fileURLToPath(new URL('../.venv/bin/python', import.meta.url));
const MODEL = fileURLToPath(new URL('../models/vosk-model-small-en-us-0.15', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./wake.py', import.meta.url));

// Vite re-runs the plugin when a server file changes: stop the old run's listener.
const g = globalThis as { __gymoteWake?: WakeWord };

export class WakeWord {
  readonly available = existsSync(VENV_PY) && existsSync(MODEL);
  private proc: ChildProcess | null = null;
  private loaded = false;
  private wanted = false;
  private suspended = false;
  private listening = false;
  private onWake: () => void;
  private onAnswer: (yes: boolean) => void;
  private onStatus: () => void;

  constructor(onWake: () => void, onAnswer: (yes: boolean) => void, onStatus: () => void) {
    this.onWake = onWake;
    this.onAnswer = onAnswer;
    this.onStatus = onStatus;
    g.__gymoteWake?.dispose();
    g.__gymoteWake = this;
    if (!this.available) console.warn('[wake] no .venv or Vosk model: run `npm run setup:keys` for "Hey Mars"');
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

  /** Stop hearing for a while (Mars or dictation has the mic, Mars is talking). */
  suspend(s: boolean) {
    if (s === this.suspended) return;
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
    this.onStatus();
  }

  private spawn() {
    const child = spawn(VENV_PY, [SCRIPT, MODEL], { stdio: ['pipe', 'pipe', 'inherit'] });
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
      console.warn(`[wake] wake.py exited (${code})`);
      this.proc = null;
      this.loaded = this.listening = false;
      this.wanted = false;
      this.onStatus();
    });
  }

  private line(line: string) {
    let msg: { type: string; yes?: boolean; message?: string; text?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      this.loaded = true;
      console.log('[wake] listening for "Hey Mars"');
      this.sync();
    } else if (!this.listening) {
      // Heard just before a suspend took effect (e.g. the tail of Mars's own voice).
    } else if (msg.type === 'wake') {
      console.log('[wake] heard "Hey Mars"');
      this.onWake();
    } else if (msg.type === 'answer') {
      console.log(`[wake] heard "${msg.yes ? 'yes' : 'no'}"`);
      this.onAnswer(!!msg.yes);
    } else if (msg.type === 'partial') {
      console.log(`[wake] ${msg.text}`);
    } else if (msg.type === 'error') {
      console.warn(`[wake] ${msg.message}`);
    }
  }
}
