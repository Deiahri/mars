// Orion from the phone: Orion starts recording the laptop mic, OK sends what you said to Claude
// (os-control-spike's computer-use agent), Cancel throws it away. While Claude works, Cancel stops it.
// With SAFE_MODE=1 Claude may ask a yes/no question first: OK = yes, Cancel = no.
//
// Recording only ever goes to Claude on OK; after MAX_MS without one it's thrown away.
//
// The mic is read here with arecord (not in the page), so nothing needs a browser permission and
// recording keeps working while the page is buried under other windows.

import { spawn, type ChildProcess } from 'node:child_process';
import { Agent, type AgentEvent, type AgentOpts } from './agent.ts';
import { Desktop } from './computer.ts';

const RATE = 16_000;
const MAX_MS = 60_000;
/** Below this much audio, OK has nothing to send. */
const MIN_MS = 300;

export type OrionState = 'idle' | 'listening' | 'transcribing' | 'working' | 'confirm';
export type SttOpts = { elevenKey?: string; model: string; language: string };
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
  private rec: ChildProcess | null = null;
  private pcm: Buffer[] = [];
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
    const child = spawn('arecord', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    this.rec = child;
    this.pcm = [];
    let lastLevel = 0;
    child.stdout.on('data', (b: Buffer) => {
      this.pcm.push(b);
      const now = Date.now();
      if (now - lastLevel < 66) return;
      lastLevel = now;
      this.overlay({ state: 'listening', level: Math.min(1, rms(b) / 0.08) });
    });
    child.on('error', (e) => {
      console.warn('[orion] arecord failed:', e.message);
      this.discard();
      this.set('idle', `Mic failed: ${e.message}`, { state: 'error' });
    });
    // Never send on its own: Claude only acts on an explicit OK. A forgotten recording is dropped.
    this.capTimer = setTimeout(() => {
      this.discard();
      this.set('idle', 'Listening timed out, nothing sent.', { state: 'info', text: 'Orion: listening timed out (60 s), nothing sent' });
    }, MAX_MS);
    this.set('listening', 'Say the command, then press OK.', { state: 'listening', level: 0 });
  }

  async ok() {
    if (this.state === 'confirm') return void this.agent.confirm(true);
    if (this.state !== 'listening') return;
    const pcm = Buffer.concat(this.pcm);
    this.discard();
    if ((pcm.length / 2 / RATE) * 1000 < MIN_MS) return this.set('idle', 'Didn’t hear anything.', { state: 'error' });
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
    this.rec?.kill();
    this.rec = null;
    this.pcm = [];
  }

  private onAgent(e: AgentEvent) {
    if (e.type === 'shot') return;
    console.log('[orion]', JSON.stringify(e).slice(0, 300));
    switch (e.type) {
      case 'progress':
        return this.set('working', e.text, { state: 'working' });
      case 'action':
        return this.set('working', `${e.name}${e.ok ? '' : ' (failed)'}`, { state: 'working' });
      case 'confirm':
        return this.set('confirm', e.question, { state: 'working', text: `${e.question}  (OK = yes, Cancel = no)` });
      case 'confirmed':
        return this.set('working', e.ok ? 'Going ahead.' : 'Not doing that.', { state: 'working' });
      case 'done':
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

function rms(b: Buffer): number {
  let sum = 0;
  const n = Math.floor(b.length / 2);
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** 16-bit mono PCM → a WAV file. */
function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Speech → text (ElevenLabs Scribe, same call as gaze-desktop). */
async function transcribe(audio: Buffer, opts: SttOpts): Promise<string> {
  const form = new FormData();
  form.append('model_id', opts.model);
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'command.wav');
  form.append('language_code', opts.language);
  form.append('tag_audio_events', 'false');
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': opts.elevenKey! },
    body: form,
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return ((await r.json()) as { text?: string }).text?.trim() ?? '';
}
