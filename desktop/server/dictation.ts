// Dictation: speak, and what you said is typed into whatever has focus. Menu › More › Dictate starts
// recording the laptop mic; Left (Type it) sends it to ElevenLabs Scribe and types the text with
// xdotool; Right (Cancel) throws it away. Click into the field first.
//
// Scribe hears the whole sentence at once, so it comes back punctuated and capitalised, about a
// second after you finish. A recording left running past MAX_MS is thrown away, never typed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OverlayMsg } from './mars.ts';
import { pcmMs, Recorder, transcribe, wav, type SttOpts } from './speech.ts';

const run = promisify(execFile);
const MAX_MS = 120_000;
/** Below this much audio, there's nothing to type. */
const MIN_MS = 300;
const LISTENING = '🎙 Dictating… press Type it on the phone when done';

export type DictationState = 'idle' | 'listening' | 'transcribing';

// Vite re-runs the plugin when a server file changes: stop the old run's recording.
const g = globalThis as { __gymoteDictation?: Dictation };

export class Dictation {
  state: DictationState = 'idle';
  /** The last thing typed, or what went wrong. */
  text = '';
  private rec = new Recorder();
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last text typed, so the next one can start with a space. */
  private lastTyped = '';
  private stt: SttOpts;
  private onChange: () => void;
  private overlay: (m: OverlayMsg) => void;
  private onTyped: (text: string) => void;

  constructor(stt: SttOpts, onChange: () => void, overlay: (m: OverlayMsg) => void, onTyped: (text: string) => void = () => {}) {
    g.__gymoteDictation?.dispose();
    g.__gymoteDictation = this;
    this.stt = stt;
    this.onChange = onChange;
    this.overlay = overlay;
    this.onTyped = onTyped;
  }

  /** Why dictation can't run, or null. */
  get missing(): string | null {
    return this.stt.elevenKey ? null : 'no ELEVENLABS_API_KEY in .env';
  }

  start() {
    if (this.state !== 'idle') return;
    if (this.missing) return this.set('idle', `Dictation is off: ${this.missing}`, { state: 'error' });
    this.rec.start(
      (level) => this.overlay({ state: 'listening', level, text: LISTENING }),
      (e) => {
        console.warn('[dictation] arecord failed:', e.message);
        this.discard();
        this.set('idle', `Mic failed: ${e.message}`, { state: 'error' });
      },
    );
    this.capTimer = setTimeout(() => {
      this.discard();
      this.set('idle', 'Dictation timed out, nothing typed.', { state: 'info', text: 'Dictation: timed out (2 min), nothing typed' });
    }, MAX_MS);
    this.set('listening', 'Speak, then press Type it.', { state: 'listening', level: 0, text: LISTENING });
  }

  /** Type it: transcribe what was said and type it. */
  async done() {
    if (this.state !== 'listening') return;
    const pcm = this.rec.stop();
    this.discard();
    if (pcmMs(pcm) < MIN_MS) return this.set('idle', 'Didn’t hear anything.', { state: 'error' });
    this.set('transcribing', 'Transcribing…', { state: 'transcribing' });
    let said: string;
    try {
      said = await transcribe(wav(pcm), this.stt);
    } catch (e) {
      console.warn('[dictation] stt failed:', (e as Error).message);
      return this.set('idle', `Transcription failed: ${(e as Error).message.slice(0, 80)}`, { state: 'error' });
    }
    // Cancel may have come in while Scribe was working (TS can't see that `set` changed state).
    if ((this.state as DictationState) !== 'transcribing') return;
    if (!said) return this.set('idle', 'Didn’t catch that.', { state: 'error' });
    // Sentences chain: a space between this one and the last, unless that ended a line.
    const text = this.lastTyped && !/\s$/.test(this.lastTyped) ? ` ${said}` : said;
    try {
      await typeText(text);
    } catch (e) {
      return this.set('idle', `Typing failed: ${(e as Error).message.slice(0, 80)}`, { state: 'error' });
    }
    this.lastTyped = text;
    console.log(`[dictation] typed ${JSON.stringify(text)}`);
    this.onTyped(said);
    this.set('idle', `Typed: ${said}`, { state: 'done', text: `⌨  ${said}` });
  }

  cancel() {
    if (this.state === 'idle') return;
    this.discard();
    this.set('idle', 'Cancelled.', { state: 'info', text: 'Dictation cancelled' });
  }

  dispose() {
    this.discard();
  }

  private discard() {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    this.rec.stop();
  }

  private set(state: DictationState, text: string, overlay: OverlayMsg) {
    this.state = state;
    this.text = text;
    this.overlay({ text, ...overlay });
    this.onChange();
  }
}

/** Types text into the focused window. --clearmodifiers: a held Ctrl mustn't turn letters into shortcuts. */
async function typeText(text: string) {
  const args = ['type', '--clearmodifiers', '--delay', '12', '--', text];
  if (process.env.GM_DRY_RUN) return void console.log(`[dry] xdotool ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  await run('xdotool', args);
}
