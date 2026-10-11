// Orion's voice: ElevenLabs text-to-speech (same call as os-control-spike's /api/tts), streamed into
// ffplay on the laptop. The server plays it itself, like it records the mic itself (server/speech.ts),
// so it works while the control page is buried under other windows.

import { spawn, type ChildProcess } from 'node:child_process';

export type VoiceOpts = {
  elevenKey?: string;
  /** ElevenLabs voice id. Default "George", a premade voice every account has. */
  voiceId: string;
  model: string;
  /** TTS=0 in .env: Orion stays silent. */
  enabled: boolean;
};

// Vite re-runs the plugin when a server file changes: silence the old run's voice.
const g = globalThis as { __gymoteVoice?: Voice };

export class Voice {
  private player: ChildProcess | null = null;
  private abort: AbortController | null = null;
  private opts: VoiceOpts;
  /** Talking now (from the request until playback ends): the "Hey Orion" listener pauses meanwhile. */
  speaking = false;
  onSpeaking: (speaking: boolean) => void = () => {};

  constructor(opts: VoiceOpts) {
    this.opts = opts;
    g.__gymoteVoice?.stop();
    g.__gymoteVoice = this;
  }

  get on(): boolean {
    return this.opts.enabled && !!this.opts.elevenKey;
  }

  /** Says `text`, cutting off anything still playing. Never throws: a failed voice only logs. */
  async speak(text: string): Promise<void> {
    this.stop();
    if (!this.on || !text.trim()) return;
    if (process.env.GM_DRY_RUN) return void console.log(`[dry] say ${JSON.stringify(text)}`);
    const abort = new AbortController();
    this.abort = abort;
    this.setSpeaking(true);
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.opts.voiceId}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': this.opts.elevenKey! },
        body: JSON.stringify({ text, model_id: this.opts.model }),
        signal: abort.signal,
      });
      if (!r.ok || !r.body) throw new Error(`elevenlabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
      const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', '-i', '-'], { stdio: ['pipe', 'ignore', 'inherit'] });
      this.player = player;
      player.on('exit', () => {
        if (this.player === player) {
          this.player = null;
          this.setSpeaking(false);
        }
      });
      player.stdin!.on('error', () => {}); // stopped mid-sentence
      for await (const chunk of r.body) {
        if (this.player !== player) break;
        player.stdin!.write(chunk);
      }
      player.stdin!.end();
    } catch (e) {
      if (!abort.signal.aborted) console.warn('[voice] tts failed:', (e as Error).message);
      if (this.abort === abort) this.setSpeaking(false);
    }
  }

  /** Switches the voice on or off (the wheel's Voice › Orion speaks). */
  setEnabled(on: boolean) {
    this.opts.enabled = on;
    if (!on) this.stop();
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** A soft rising two-note chime: "I heard you, listening now" (the wake word). */
  chime() {
    if (process.env.GM_DRY_RUN) return void console.log('[dry] chime');
    const tone = "aevalsrc='0.22*sin(2*PI*(660+330*gt(t,0.09))*t)*exp(-5*t)':d=0.32";
    spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', '-f', 'lavfi', '-i', tone], { stdio: 'ignore' }).on('error', () => {});
  }

  /** Stops talking (the mic is about to listen, or the task was cancelled). */
  stop() {
    this.abort?.abort();
    this.abort = null;
    this.player?.kill();
    this.player = null;
    this.setSpeaking(false);
  }

  private setSpeaking(s: boolean) {
    if (s === this.speaking) return;
    this.speaking = s;
    this.onSpeaking(s);
  }
}
