// The real desktop, driven by the phone. gaze-desktop's server with the gaze swapped for Gymote:
// the laptop page relays the phone (WebRTC needs a browser), and everything that touches the
// computer happens here. The pointer itself (smoothing, snapping, dwell, the action strip) is
// server/pointer/brain.ts.
//
//   page → server   gm:raw {x,y}                     the phone's raw aim, screen px
//                   gm:tracking {ok}                 the phone is there (false: link lost / silent)
//                   gm:recentered                    the phone was re-centered
//                   gm:pointer-cfg {pxPerDeg?, dwellMs?}
//                   gm:pointer-reset {what: offset|adaptive}
//                   gm:button {button, down}         the phone's Click / Right click
//                   gm:toggle {what: mouse|keys|dwell|snap}
//                   gm:orion {action: start|ok|cancel}
//                   gm:keys-gap {ms}                 minimum time between keystroke-mode taps
//                   gm:stop                          the page's Stop / Esc: everything off
//   server → page   gm:hello {w, h, session, warning?, token}
//                   gm:state RemoteState             mouse / keys / Orion / dwell / mode, forwarded to the phone
//                   gm:pointer PointerStatus         5×/s, for the page's readouts
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
import type { RemoteState } from '../src/net/link.ts';
import type { AgentOpts } from './agent.ts';
import { hostEnv } from './env.ts';
import { KeyMode } from './keys.ts';
import { Orion, type OverlayMsg, type SttOpts } from './orion.ts';
import { PointerBrain } from './pointer/brain.ts';
import { startTargets } from './targets.ts';

const run = promisify(execFile);

export type DesktopOpts = { agent: AgentOpts; stt: SttOpts; hasClaude: boolean };

const BUTTON = { left: 1, right: 3 } as const;
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
 */
class Pointer {
  private queue: string[][] = [];
  private move: string[] | null = null;
  private busy = false;
  private pressed = new Set<Button>();

  moveTo(x: number, y: number) {
    this.move = ['mousemove', String(x), String(y)];
    void this.pump();
  }

  button(b: Button, down: boolean) {
    if (down === this.pressed.has(b)) return;
    if (down) this.pressed.add(b);
    else this.pressed.delete(b);
    this.push([down ? 'mousedown' : 'mouseup', String(BUTTON[b])]);
  }

  click(b: Button, repeat = 1) {
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
      const args = this.queue.shift() ?? this.move;
      if (!args) break;
      if (args === this.move) this.move = null;
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
 * happening over any app) or halo.py (the pointer's halo, ring and strip).
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
      const pointer = new Pointer();
      let mouse = true;
      /** The phone's pointer is idle while Orion drives (it would fight Claude for the mouse). */
      const pointerLive = () => mouse && w > 0 && (orion.state === 'idle' || orion.state === 'listening');

      const brain = new PointerBrain(w || 1, h || 1, {
        out: pointer,
        halo: startOverlay(server, 'halo.py', 'no halo, dwell ring or action strip'),
        onState: () => pushState(),
        rescan: () => targets.rescan(),
        info: (text) => overlay({ state: 'info', text }),
        live: pointerLive,
      });
      const targets = startTargets(server, w, h, (list, app) => brain.setTargets(list, app));

      const state = (): RemoteState => ({
        mouse,
        keys: keys.status,
        orion: orion.state,
        orionText: orion.text,
        orionMissing: orion.missing,
        dwell: brain.dwellOn,
        snap: brain.snapOn,
        mode: brain.mode,
        paused: brain.paused,
      });
      const pushState = () => toPage('gm:state', state());

      const keys = new KeyMode(
        (a) => {
          toPage('gm:heard', { text: a.said });
          overlay({ state: 'info', text: `⌨  ${a.said}` });
        },
        () => pushState(),
      );
      const orion = new Orion(opts.agent, opts.stt, opts.hasClaude, () => {
        // Orion owns the mic and the mouse while it listens and works.
        keys.suspend(orion.state !== 'idle');
        if (orion.state !== 'idle') {
          brain.stopActions();
          pointer.releaseAll();
        }
        pushState();
      }, overlay);
      const statusTimer = setInterval(() => toPage('gm:pointer', brain.status()), 200);
      server.httpServer?.on('close', () => {
        clearInterval(statusTimer);
        brain.dispose();
        keys.dispose();
        orion.dispose();
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
      on<{ button: Button; down: boolean }>('gm:button', ({ button, down }) => {
        if (!(button in BUTTON)) return;
        if (process.env.GM_DEBUG) console.log(`[gymote-desktop] ${button} ${down ? 'down' : 'up'}`);
        brain.phoneButton(button, !!down);
      });
      on<{ what: 'mouse' | 'keys' | 'dwell' | 'snap' }>('gm:toggle', ({ what }) => {
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
        } else if (what === 'dwell') {
          brain.toggleDwell();
        } else if (what === 'snap') {
          brain.toggleSnap();
          targets.setEnabled(brain.snapOn);
        }
      });
      on<{ action: 'start' | 'ok' | 'cancel' }>('gm:orion', ({ action }) => {
        if (action === 'start') orion.start();
        else if (action === 'ok') void orion.ok();
        else if (action === 'cancel') orion.cancel();
      });
      on<{ ms: number }>('gm:keys-gap', ({ ms }) => {
        if (finite(ms)) keys.setGap(ms);
      });
      on('gm:stop', () => {
        mouse = false;
        brain.stop();
        pointer.releaseAll();
        keys.set(false);
        orion.cancel();
        overlay({ state: 'info', text: 'Stopped: phone mouse, keys and Orion are off' });
        pushState();
      });

      console.log(
        `[gymote-desktop] screen ${w}×${h} (${session.type}); keys ${keys.status}; Orion ${orion.missing ?? 'ready'}`,
      );
    },
  };
}
