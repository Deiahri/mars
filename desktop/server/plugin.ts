// The real desktop, driven by the phone. gaze-desktop's server with the gaze swapped for Gymote:
// the laptop page relays the phone (WebRTC needs a browser), and everything that touches the
// computer happens here. The pointer itself (smoothing, snapping, dwell, the wheel, zoom-click,
// scrolling) is server/pointer/brain.ts.
//
//   page → server   gm:raw {x,y}                     the phone's raw aim, screen px
//                   gm:tracking {ok}                 the phone is there (false: link lost / silent)
//                   gm:recentered                    the phone was re-centered
//                   gm:pointer-cfg {pxPerDeg?, dwellMs?}
//                   gm:pointer-reset {what: offset|adaptive}
//                   gm:button {button, down}         the phone's Left / Right / Menu (left|right|wheel)
//                   gm:scroll-speed {perS}           the phone's scroll speed slider
//                   gm:toggle {what: mouse|keys|wake|tts|dwell|snap|ai}
//                   gm:orion {action: start|ok|cancel}
//                   gm:dictate {action: start|ok|cancel}
//                   gm:keys-gap {ms}                 minimum time between keystroke-mode taps
//                   gm:memory {on}                   screen memory recording (server/memory/)
//                   gm:stop                          the page's Stop / Esc: everything off
//   server → page   gm:hello {w, h, session, warning?, token}
//                   gm:memory MemoryStatus           5×/s with gm:pointer
//                   gm:backboard {on, count}         Orion's long-term memory of the person (server/backboard.ts)
//                   gm:state RemoteState             mouse / keys / Orion / pointer ui / button labels, forwarded to the phone
//                   gm:pointer PointerStatus + {ai}  5×/s, for the page's readouts (ai: VisionStatus)
//                   gm:heard {text}                  a keystroke-mode word that was acted on
//
// Only the laptop's own page may send these. Vite's dev websocket also serves the phone page
// (through ngrok), so a socket counts only if it comes from loopback without ngrok's forwarding
// header. The pairing token (server/signaling.ts) only goes to those sockets.
//
// X11 only (xdotool): on GNOME Wayland it reaches XWayland windows only.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Plugin, ViteDevServer, WebSocketAlias as WebSocket } from 'vite';
import type { PhoneButton, RemoteState } from '../src/net/link.ts';
import type { AgentOpts } from './agent.ts';
import { Backboard } from './backboard.ts';
import { Desktop } from './computer.ts';
import { Dictation } from './dictation.ts';
import { hostEnv } from './env.ts';
import { KeyMode } from './keys.ts';
import { ScreenMemory } from './memory/recorder.ts';
import { Voice, type VoiceOpts } from './voice.ts';
import { WakeWord } from './wake.ts';
import { Orion, type OverlayMsg, type SttOpts } from './orion.ts';
import { PointerBrain } from './pointer/brain.ts';
import type { Target } from './pointer/snap.ts';
import { startTargets } from './targets.ts';
import { mergeTargets, VisionTargets } from './vision-targets.ts';

const run = promisify(execFile);

export type DesktopOpts = {
  agent: AgentOpts;
  stt: SttOpts;
  /** Orion's spoken answers (ElevenLabs TTS). */
  voice: VoiceOpts;
  /** "Hey Orion" listening on at start (server/wake.ts). */
  wake: boolean;
  /** Backboard: Orion's long-term memory of the person. Off without a key. */
  backboardKey?: string;
  /** GEMINI_API_KEY is set: Orion, screen memory captions and AI snap targets all use Gemini. */
  hasGemini: boolean;
  /** AI snap targets (server/vision-targets.ts) on at start. Needs hasGemini. */
  aiSnap: boolean;
  /** Screen memory recording on at start (server/memory/). Needs hasGemini. */
  memory: boolean;
};

const BUTTON = { left: 1, middle: 2, right: 3 } as const;
type Button = keyof typeof BUTTON;

// Survives Vite re-running the plugin, so the phone doesn't have to rescan after a server edit.
const g = globalThis as { __gymoteToken?: string } & Record<`__gymote${string}`, ChildProcess | undefined>;
export const token = (g.__gymoteToken ??= randomBytes(12).toString('hex'));

function checkSession(): { type: string; warning?: string } {
  const type = process.env.XDG_SESSION_TYPE ?? 'unknown';
  if (type === 'x11') return { type };
  return {
    type,
    warning:
      type === 'wayland'
        ? 'Wayland session: xdotool can’t move the real pointer. Log out and pick “Ubuntu on Xorg”.'
        : `Session type “${type}”: expected x11.`,
  };
}

/** The laptop itself, not the phone through ngrok (ngrok connects from loopback but adds X-Forwarded-For). */
function isLocal(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'] && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '');
}

/**
 * Runs xdotool for the newest pointer target only (from gaze-desktop): moves arrive up to 100×/s,
 * and if one call is slow, stale targets are dropped instead of queueing up as lag. Buttons, clicks
 * and scrolls queue behind the pending move, so they land where the pointer is, and are never dropped.
 *
 * While a button is held, every move goes out: a drag needs a stream of small motions (GTK abandons
 * one that gets a single big jump). Moves queued back to back go in one xdotool call.
 */
class Pointer {
  private queue: string[][] = [];
  private move: string[] | null = null;
  private busy = false;
  private pressed = new Set<Button>();
  /** Where the real pointer was last sent (screen px). */
  private at: { x: number; y: number } | null = null;

  /** `onClick`: a click or a button let go, at the real pointer (for screen memory's log). */
  constructor(private onClick: (b: Button, at: { x: number; y: number } | null) => void = () => {}) {}

  moveTo(x: number, y: number) {
    this.at = { x, y };
    const args = ['mousemove', String(x), String(y)];
    if (this.pressed.size) return this.push(args);
    this.move = args;
    void this.pump();
  }

  button(b: Button, down: boolean) {
    if (down === this.pressed.has(b)) return;
    if (down) this.pressed.add(b);
    else this.pressed.delete(b);
    this.push([down ? 'mousedown' : 'mouseup', String(BUTTON[b])]);
    if (!down) this.onClick(b, this.at);
  }

  click(b: Button, repeat = 1) {
    this.onClick(b, this.at);
    this.push(['click', ...(repeat > 1 ? ['--repeat', String(repeat), '--delay', '80'] : []), String(BUTTON[b])]);
  }

  scroll(dir: 'up' | 'down') {
    this.push(['click', dir === 'up' ? '4' : '5']);
  }

  private push(args: string[]) {
    if (this.move) this.queue.push(this.move);
    this.move = null;
    this.queue.push(args);
    void this.pump();
  }

  /** Lets go of any button the phone is holding (mouse turned off, Orion taking over). */
  releaseAll() {
    for (const b of [...this.pressed]) this.button(b, false);
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    for (;;) {
      let args = this.queue.shift() ?? this.move;
      if (!args) break;
      if (args === this.move) this.move = null;
      // A run of queued moves (a drag): one call, a few ms apart so each is its own motion event.
      while (args[0] === 'mousemove' && this.queue[0]?.[0] === 'mousemove' && args.length < 200) {
        args = [...args, 'sleep', '0.004', ...this.queue.shift()!];
      }
      try {
        // GM_DRY_RUN=1: log instead of moving/clicking, for testing the whole path without touching the desktop.
        if (process.env.GM_DRY_RUN) console.log(`[dry] xdotool ${args.join(' ')}`);
        else await run('xdotool', args);
      } catch (e) {
        console.warn('[gymote-desktop] xdotool failed:', (e as Error).message);
      }
    }
    this.busy = false;
  }
}

/**
 * An always-on-top Python window fed JSON lines: overlay.py (the status pill, so you see what's
 * happening over any app) or halo.py (the pointer's halo, ring, wheel and zoom panel).
 */
function startOverlay<M extends object = object>(server: ViteDevServer, file = 'overlay.py', lost = 'no on-screen status'): (m: M) => void {
  const slot = `__gymote_${file}` as const;
  g[slot]?.kill();
  const child = spawn('python3', ['-u', fileURLToPath(new URL(`./${file}`, import.meta.url))], {
    stdio: ['pipe', 'ignore', 'inherit'],
    env: hostEnv(),
  });
  g[slot] = child;
  let alive = true;
  let closing = false;
  child.on('exit', (code) => {
    alive = false;
    if (!closing && g[slot] === child) console.warn(`[gymote-desktop] ${file} exited (${code}); ${lost}`);
  });
  // On a Vite restart the old server closes after the new one started: kill only our own overlay.
  server.httpServer?.on('close', () => {
    closing = true;
    child.kill();
  });
  child.stdin.on('error', () => {}); // a dead overlay must not crash the dev server
  return (m) => {
    if (alive) child.stdin.write(`${JSON.stringify(m)}\n`);
  };
}

export function desktop(opts: DesktopOpts): Plugin {
  return {
    name: 'gymote-desktop',
    apply: 'serve',
    async configureServer(server: ViteDevServer) {
      const session = checkSession();
      if (session.warning) console.warn(`[gymote-desktop] ${session.warning}`);
      let w = 0;
      let h = 0;
      try {
        [w, h] = (await run('xdotool', ['getdisplaygeometry'])).stdout.trim().split(/\s+/).map(Number);
      } catch (e) {
        console.warn('[gymote-desktop] xdotool getdisplaygeometry failed:', (e as Error).message);
      }

      // ------------------------------------------------------------ trusted clients only
      const trusted = new WeakSet<WebSocket>();
      const toPage = (event: string, data: unknown) => {
        for (const c of server.ws.clients) if (trusted.has(c.socket)) c.send(event, data);
      };
      /** Registers a handler that ignores anything not from the laptop's own page. */
      const on = <T>(event: string, fn: (data: T) => void) =>
        server.ws.on(event, (data: T, client: { socket: WebSocket }) => {
          if (trusted.has(client.socket)) fn(data);
        });

      // ------------------------------------------------------------ state
      const overlay = startOverlay<OverlayMsg>(server);
      const pointer = new Pointer((b, at) => screenMemory.event('click', { x: at?.x, y: at?.y, text: b === 'left' ? '' : `${b} button` }));
      let mouse = true;
      /** The phone's pointer is idle while Orion drives (it would fight Gemini for the mouse). */
      const pointerLive = () => mouse && w > 0 && (orion.state === 'idle' || orion.state === 'listening');
      // Zoom-click snapshots (the overlay is cleared first; give the compositor a frame to show that).
      const desk = new Desktop();
      const deskReady = desk.init().catch((e) => console.warn('[gymote-desktop] no zoom snapshots:', (e as Error).message));

      const brain = new PointerBrain(w || 1, h || 1, {
        out: pointer,
        halo: startOverlay(server, 'halo.py', 'no halo, dwell ring, wheel or zoom'),
        onState: () => pushState(),
        rescan: () => targets.rescan(),
        info: (text) => overlay({ state: 'info', text }),
        live: pointerLive,
        menuAction: (id) => {
          if (id === 'dictate') startVoice('dictate');
          else if (id === 'orion') startVoice('orion');
          else if (id === 'snap') cycleSnap();
          else if (id === 'keys' || id === 'ai' || id === 'wake' || id === 'tts') toggle(id);
        },
        menuState: () => ({
          ai: !vision.available ? 'n/a' : vision.enabled ? 'on' : 'off',
          keys: keys.status === 'unavailable' ? 'n/a' : keys.status === 'loading' ? '…' : keys.status,
          wake: wake.status === 'unavailable' ? 'n/a' : wake.status === 'loading' ? '…' : wake.status,
          tts: !voice.on && voice.enabled ? 'n/a' : voice.enabled ? 'on' : 'off',
          orion: !orion.missing,
          dictate: !dictation.missing,
        }),
        zoomShot: async (r) => {
          await deskReady;
          await new Promise((res) => setTimeout(res, 80));
          return (await desk.region(r.x, r.y, r.w, r.h)).toString('base64');
        },
      });
      // Snap targets: the accessibility tree (exact), plus Gemini's boxes where it has nothing.
      let a11y: Target[] = [];
      let a11yApp = '';
      let aiTargets: Target[] = [];
      const pushTargets = () => brain.setTargets(mergeTargets(a11y, aiTargets), a11yApp);
      const targets = startTargets(server, w, h, (list, app) => {
        a11y = list;
        a11yApp = app;
        pushTargets();
      });
      targets.setEnabled(brain.snapOn); // off at start: zoom is the main precision tool
      const vision = new VisionTargets(
        {
          // Only while someone is pointing: a video or a scrolling log would otherwise keep paying for looks.
          useful: () => pointerLive() && brain.active && !brain.paused && brain.snapOn && (brain.ui === 'normal' || brain.ui === 'scroll'),
          overlay: () => {
            const p = brain.status();
            return { cursor: p.x === null ? null : { x: p.x, y: p.y! }, glow: brain.snapped };
          },
          onTargets: (list) => {
            aiTargets = list;
            pushTargets();
          },
          onState: () => pushState(),
        },
        { enabled: opts.aiSnap },
      );

      // Screen memory: what was on screen, for Orion to search and re-look at later.
      const screenMemory = new ScreenMemory(
        [w, h],
        {
          pointer: () => {
            const p = brain.status();
            return p.x === null ? null : { x: p.x, y: p.y! };
          },
          // The wheel and the zoom panel cover the screen: nothing to remember there.
          busy: () => brain.ui === 'wheel' || brain.ui === 'zoom',
        },
        { hasGemini: opts.hasGemini, session: session.type },
      );
      const setMemory = async (on: boolean) => {
        await screenMemory.setEnabled(on);
        const s = screenMemory.status();
        if (on && s.state === 'unavailable') overlay({ state: 'error', text: `Screen memory ${s.note}` });
        else overlay({ state: 'info', text: on ? `◉  Screen memory on${s.note ? `: ${s.note}` : ''}` : '◉  Screen memory off' });
      };
      if (opts.memory) void setMemory(true);

      const state = (): RemoteState => ({
        mouse,
        keys: keys.status,
        wake: wake.status,
        tts: voice.on,
        orion: orion.state,
        orionText: orion.text,
        orionMissing: orion.missing,
        dictation: dictation.missing ? 'unavailable' : dictation.state,
        dictationText: dictation.text,
        dwell: brain.dwellOn,
        snap: brain.snapOn,
        ai: vision.available ? vision.status().state : 'unavailable',
        ui: brain.ui,
        pending: brain.pending,
        zoomK: brain.zoomK,
        paused: brain.paused,
        labels: labels(),
      });
      /** What the phone's buttons do now: Orion's or dictation's answers while busy, else the pointer's. */
      const labels = (): RemoteState['labels'] => {
        if (dictation.state === 'listening') return { left: 'Type it', right: 'Cancel', wheel: '' };
        if (dictation.state === 'transcribing') return { left: '', right: 'Cancel', wheel: '' };
        if (orion.state === 'listening') return { left: 'OK', right: 'Cancel', wheel: '' };
        if (orion.state === 'confirm') return { left: 'Yes', right: 'No', wheel: '' };
        if (orion.state === 'transcribing') return { left: '', right: 'Cancel', wheel: '' };
        if (orion.state === 'working') return { left: '', right: 'Stop', wheel: '' };
        if (!mouse) return { left: '', right: '', wheel: 'Mouse on' };
        return brain.labels();
      };
      const pushState = () => toPage('gm:state', state());

      const keys = new KeyMode(
        (a) => {
          toPage('gm:heard', { text: a.said });
          overlay({ state: 'info', text: `⌨  ${a.said}` });
        },
        () => pushState(),
      );
      /** Keystroke mode pauses while Orion or dictation has the mic. */
      const micBusy = () => orion.state !== 'idle' || dictation.state !== 'idle';
      const person = new Backboard(opts.backboardKey);
      if (person.on) person.refreshCount().catch((e) => console.warn('[backboard]', (e as Error).message));
      const agentOpts = { ...opts.agent, memory: () => (screenMemory.hasFrames ? screenMemory.memory : null), person };
      const voice = new Voice(opts.voice);
      const orion = new Orion(agentOpts, opts.stt, opts.hasGemini, () => {
        // Orion owns the mic and the mouse while it listens and works.
        keys.suspend(micBusy());
        updateWake();
        if (orion.state !== 'idle') {
          brain.stopActions();
          pointer.releaseAll();
        }
        pushState();
      }, overlay, (text) => screenMemory.event('orion', { text }), voice);
      // Dictation only takes the mic; the pointer keeps moving, its clicks wait (the router below).
      const dictation = new Dictation(opts.stt, () => {
        keys.suspend(micBusy());
        updateWake();
        pushState();
      }, overlay, (text) => screenMemory.event('dictation', { text }));
      // "Hey Orion" (offline): starts Orion listening, like the wheel's Orion; the phone's OK still
      // sends. While Orion asks a yes/no question, a spoken "yes" / "no" answers it.
      const wake = new WakeWord(
        () => {
          if (orion.state !== 'idle' || dictation.state !== 'idle') return;
          voice.chime();
          startVoice('orion');
        },
        (yes) => {
          if (orion.state !== 'confirm') return;
          if (yes) void orion.ok();
          else orion.cancel();
        },
        () => {
          orion.voiceAnswers = wake.status === 'on';
          pushState();
        },
      );
      /** Orion's voice and the recorders would otherwise be heard as "Hey Orion" / "yes". */
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const updateWake = () => {
        const busy = orion.state === 'listening' || orion.state === 'transcribing' || dictation.state !== 'idle';
        if (busy || voice.speaking) {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = null;
          return wake.suspend(true);
        }
        // The room's echo of Orion's last word: wait a moment before listening again.
        quietTimer ??= setTimeout(() => {
          quietTimer = null;
          wake.suspend(false);
        }, 300);
      };
      voice.onSpeaking = () => updateWake();
      if (opts.wake) wake.set(true);
      /** One voice thing at a time: they share the mic and the phone's buttons. */
      const startVoice = (what: 'orion' | 'dictate') => {
        if (micBusy()) return overlay({ state: 'info', text: `Busy: finish ${orion.state !== 'idle' ? 'Orion' : 'dictation'} first` });
        brain.stopActions();
        voice.stop();
        if (what === 'orion') orion.start();
        else dictation.start();
      };
      /** The wheel's Snap: off → on → on + AI targets (when there's a Gemini key) → off. */
      const cycleSnap = () => {
        if (brain.snapOn && vision.available && !vision.enabled) return toggle('ai');
        if (vision.enabled) vision.setEnabled(false);
        toggle('snap');
      };
      const statusTimer = setInterval(() => {
        toPage('gm:pointer', { ...brain.status(), ai: vision.status() });
        toPage('gm:memory', screenMemory.status());
        toPage('gm:backboard', { on: person.on, count: person.count });
      }, 200);
      server.httpServer?.on('close', () => {
        clearInterval(statusTimer);
        vision.dispose();
        brain.dispose();
        keys.dispose();
        orion.dispose();
        dictation.dispose();
        screenMemory.dispose();
        voice.stop();
        wake.dispose();
        if (quietTimer) clearTimeout(quietTimer);
      });

      // ------------------------------------------------------------ handlers
      const hello = () => ({ w, h, session: session.type, warning: session.warning, token });
      server.ws.on('connection', (socket: WebSocket, req: IncomingMessage) => {
        if (!isLocal(req)) return;
        trusted.add(socket);
        socket.send(JSON.stringify({ type: 'custom', event: 'gm:hello', data: hello() }));
        socket.send(JSON.stringify({ type: 'custom', event: 'gm:state', data: state() }));
      });
      on('gm:hello', () => {
        toPage('gm:hello', hello());
        pushState();
      });

      const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
      on<{ x: number; y: number }>('gm:raw', (p) => {
        if (finite(p?.x) && finite(p?.y)) brain.raw(p.x, p.y);
      });
      on<{ ok: boolean }>('gm:tracking', ({ ok }) => brain.setTracking(!!ok));
      on('gm:recentered', () => brain.recentered());
      on<{ pxPerDeg?: number; dwellMs?: number }>('gm:pointer-cfg', ({ pxPerDeg, dwellMs }) => {
        if (finite(pxPerDeg)) brain.setPxPerDeg(pxPerDeg);
        if (finite(dwellMs)) brain.dwell.setBase(dwellMs);
      });
      on<{ what: 'offset' | 'adaptive' }>('gm:pointer-reset', ({ what }) => {
        if (what === 'offset') brain.resetOffset();
        if (what === 'adaptive') brain.dwell.resetAdaptive();
      });
      on<{ button: PhoneButton; down: boolean }>('gm:button', ({ button, down }) => {
        if (button !== 'left' && button !== 'right' && button !== 'wheel') return;
        if (process.env.GM_DEBUG) console.log(`[gymote-desktop] ${button} ${down ? 'down' : 'up'}`);
        // While dictating, Left types it and Right cancels.
        if (dictation.state !== 'idle') {
          if (!down) return brain.phoneButton(button, false);
          if (button === 'left' && dictation.state === 'listening') void dictation.done();
          else if (button === 'right') dictation.cancel();
          return;
        }
        // While Orion listens or works, Left / Right answer it (OK, Yes / Cancel, No, Stop).
        if (orion.state !== 'idle') {
          if (!down) return brain.phoneButton(button, false);
          if (button === 'left' && (orion.state === 'listening' || orion.state === 'confirm')) void orion.ok();
          else if (button === 'right') orion.cancel();
          return;
        }
        if (!mouse) {
          if (down && button === 'wheel') toggle('mouse');
          return;
        }
        brain.phoneButton(button, !!down);
      });
      on<{ perS: number }>('gm:scroll-speed', ({ perS }) => {
        if (finite(perS)) brain.setScrollSpeed(perS);
      });
      const toggle = (what: 'mouse' | 'keys' | 'wake' | 'tts' | 'dwell' | 'snap' | 'ai') => {
        if (what === 'mouse') {
          mouse = !mouse;
          if (!mouse) pointer.releaseAll();
          overlay({ state: 'info', text: mouse ? '🖱  Phone mouse on' : '🖱  Phone mouse off: the mouse is yours' });
          pushState();
        } else if (what === 'keys') {
          if (keys.status === 'unavailable') {
            overlay({ state: 'error', text: 'Keystroke mode needs `npm run setup:keys`' });
            return;
          }
          keys.set(!keys.on);
          overlay({ state: 'info', text: keys.on ? '⌨  Keys on: say left, hold up, stop up…' : '⌨  Keys off' });
        } else if (what === 'wake') {
          if (wake.status === 'unavailable') {
            overlay({ state: 'error', text: '“Hey Orion” needs `npm run setup:keys`' });
            return;
          }
          wake.set(!wake.on);
          overlay({ state: 'info', text: wake.on ? '✦  Listening for “Hey Orion” (offline)' : '✦  “Hey Orion” off' });
        } else if (what === 'tts') {
          voice.setEnabled(!voice.enabled);
          overlay({ state: 'info', text: voice.enabled ? 'Orion speaks its answers' : 'Orion stays quiet' });
          pushState();
        } else if (what === 'dwell') {
          brain.toggleDwell();
        } else if (what === 'snap') {
          brain.toggleSnap();
          targets.setEnabled(brain.snapOn);
        } else if (what === 'ai') {
          if (!vision.available) {
            overlay({ state: 'error', text: 'AI targets need GEMINI_API_KEY in .env' });
            return;
          }
          vision.setEnabled(!vision.enabled);
          overlay({ state: 'info', text: vision.enabled ? '✦  AI targets on: Gemini finds the buttons on screen' : '✦  AI targets off' });
          pushState();
        }
      };
      on<{ what: 'mouse' | 'keys' | 'wake' | 'tts' | 'dwell' | 'snap' | 'ai' }>('gm:toggle', ({ what }) => toggle(what));
      on<{ action: 'start' | 'ok' | 'cancel' }>('gm:orion', ({ action }) => {
        if (action === 'start') startVoice('orion');
        else if (action === 'ok') void orion.ok();
        else if (action === 'cancel') orion.cancel();
      });
      on<{ action: 'start' | 'ok' | 'cancel' }>('gm:dictate', ({ action }) => {
        if (action === 'start') startVoice('dictate');
        else if (action === 'ok') void dictation.done();
        else if (action === 'cancel') dictation.cancel();
      });
      on<{ ms: number }>('gm:keys-gap', ({ ms }) => {
        if (finite(ms)) keys.setGap(ms);
      });
      on<{ on: boolean }>('gm:memory', ({ on }) => void setMemory(!!on));
      on('gm:stop', () => {
        mouse = false;
        brain.stop();
        pointer.releaseAll();
        keys.set(false);
        wake.set(false);
        orion.cancel();
        dictation.cancel();
        void screenMemory.setEnabled(false);
        overlay({ state: 'info', text: 'Stopped: phone mouse, keys, “Hey Orion”, Orion, dictation and screen memory are off' });
        pushState();
      });

      console.log(
        `[gymote-desktop] screen ${w}×${h} (${session.type}); keys ${keys.status}; Orion ${orion.missing ?? 'ready'}; dictation ${dictation.missing ?? 'ready'}; voice ${voice.on ? 'on' : 'off'}; Hey Orion ${wake.status}; Backboard ${person.on ? 'on' : 'needs BACKBOARD_API_KEY'}; AI targets ${vision.available ? (vision.enabled ? 'on' : 'off') : 'need GEMINI_API_KEY'}; screen memory ${screenMemory.missing ?? (opts.memory ? 'on' : 'off')}`,
      );
    },
  };
}
