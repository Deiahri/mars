// What Mars and dictation share: recording the laptop mic, and speech → text with ElevenLabs Scribe.
//
// The mic is read here with arecord (not in the page), so nothing needs a browser permission and
// recording keeps working while the page is buried under other windows.
// GM_MIC_SOURCE="cat clip.pcm" replaces the mic with 16 kHz mono s16le PCM from that command, for tests.

import { spawn, type ChildProcess } from 'node:child_process';

export const RATE = 16_000;

export type SttOpts = { elevenKey?: string; model: string; language: string };

export class Recorder {
  private child: ChildProcess | null = null;
  private pcm: Buffer[] = [];
  private bytes = 0;

  get active(): boolean {
    return !!this.child;
  }

  /** Starts recording. `onLevel` gets the loudness (0..1) about 15×/s. */
  start(onLevel: (level: number) => void, onError: (e: Error) => void) {
    this.stop();
    const source = process.env.GM_MIC_SOURCE;
    const child = source
      ? spawn('sh', ['-c', source], { stdio: ['ignore', 'pipe', 'inherit'] })
      : spawn('arecord', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw'], { stdio: ['ignore', 'pipe', 'inherit'] });
    this.child = child;
    let lastLevel = 0;
    child.stdout!.on('data', (b: Buffer) => {
      if (this.child !== child) return;
      this.pcm.push(b);
      this.bytes += b.length;
      const now = Date.now();
      if (now - lastLevel < 66) return;
      lastLevel = now;
      onLevel(Math.min(1, rms(b) / 0.08));
    });
    child.on('error', (e) => {
      if (this.child === child) onError(e);
    });
  }

  /** Stops and returns what was heard (16 kHz mono s16le). */
  stop(): Buffer {
    this.child?.kill();
    this.child = null;
    const pcm = Buffer.concat(this.pcm);
    this.pcm = [];
    this.bytes = 0;
    return pcm;
  }

  /** ms of audio so far. */
  get ms(): number {
    return (this.bytes / 2 / RATE) * 1000;
  }
}

export const pcmMs = (pcm: Buffer) => (pcm.length / 2 / RATE) * 1000;

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
export function wav(pcm: Buffer): Buffer {
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
export async function transcribe(audio: Buffer, opts: SttOpts): Promise<string> {
  const form = new FormData();
  form.append('model_id', opts.model);
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'speech.wav');
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
