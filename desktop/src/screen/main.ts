// The laptop page: a relay. It holds the WebRTC link to the phone (Node has no WebRTC), passes the
// phone's raw aim and buttons to the server, which does everything else: smoothing, snapping,
// dwell and every action (server/pointer/brain.ts, server/plugin.ts). State flows back the other way.
//
// Timers, not requestAnimationFrame: rAF stops while the window is covered, and this window lives
// behind whatever you're controlling. Open it with `npm run app` so Chrome doesn't throttle it.

import './screen.css';
import QRCode from 'qrcode';
import { isUp, startHost, type Host, type LinkStatus, type RemoteState } from '../net/link';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const hot = import.meta.hot;

/** If a phone answered but the link hasn't opened after this long, Wi-Fi is probably blocking it. */
const STUCK_CONNECTING_MS = 8000;
/** No pong for this long while "connected" means the phone is gone (screen locked, Wi-Fi drop). */
const SILENT_MS = 2500;

const LINK_TEXT: Record<LinkStatus, string> = {
  starting: 'phone: starting…',
  waiting: 'phone: scan the QR code',
  connecting: 'phone: connecting…',
  connected: 'phone: connected',
  relayed: 'phone: connected via relay',
  lost: 'phone: link lost',
};

let host: Host | null = null;
let token: string | null = null;
/** The real screen, from xdotool. The phone projects onto it directly, so Gymote's x,y are desktop px. */
let desk = { w: 0, h: 0 };
let state: RemoteState | null = null;

/** Phone distance as a multiple of the screen width (Gymote wants pixels). Bigger = less turning. */
let distanceK = Number(safeGet('gm:distanceK')) || 1.5;
/** Keystroke mode: minimum ms between taps (server/keys.ts KeyPresser). */
let keysGap = Number(safeGet('gm:keysGap')) || 0;
/** Dwell time before adapting (server/pointer/dwell.ts). */
let dwellMs = Number(safeGet('gm:dwellMs')) || 800;

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

// ------------------------------------------------------------------ server link

if (!hot) $('warn').textContent = 'This page needs the Vite dev server (npm run dev): it talks to it over the dev websocket.';

hot?.on('gm:hello', (msg: { w: number; h: number; session: string; warning?: string; token: string }) => {
  // A restarted server has a new pairing token; the old link can't signal any more.
  if (token && msg.token !== token) return location.reload();
  desk = { w: msg.w, h: msg.h };
  $('screen').textContent = msg.w ? `${msg.w}×${msg.h} (${msg.session})` : 'xdotool not available';
  $('warn').textContent = msg.warning ?? '';
  if (!host) {
    token = msg.token;
    host = startHost(token);
    wire(host);
    void refreshUrl();
  }
  sendGeometry();
  hot?.send('gm:keys-gap', { ms: keysGap });
  hot?.send('gm:pointer-cfg', { dwellMs });
});
hot?.send('gm:hello');

hot?.on('gm:state', (s: RemoteState) => {
  const prev = state;
  state = s;
  host?.send({ type: 'state', state: s });
  render();
  if (s.orionText && (s.orionText !== prev?.orionText || s.orion !== prev?.orion)) log(s.orionText);
  if (s.dictationText && s.dictationText !== prev?.dictationText) log(`Dictation: ${s.dictationText}`);
});

type PointerStatus = {
  x: number | null;
  y: number | null;
  offset: { x: number; y: number };
  dwellMs: number;
  dwellBase: number;
  targets: number;
  app: string;
  snapped: string | null;
  fixating: boolean;
  /** server/vision-targets.ts VisionStatus. */
  ai: { state: string; count: number; scans: number; cacheHits: number; lastMs: number | null; costUsd: number; error: string | null };
};
const AI_TEXT: Record<string, string> = { waiting: 'watching the screen', scanning: 'looking…', ready: 'ready', error: 'error', off: '' };
hot?.on('gm:pointer', (p: PointerStatus) => {
  $('pos').textContent = p.x === null ? '—' : `${p.x}, ${p.y}`;
  $('ptr-state').textContent = p.snapped ? `on ${p.snapped.startsWith('wheel:') ? `wheel ${p.snapped.slice(6)}` : 'a button'}` : p.fixating ? 'holding still' : '';
  $('dwell-now').textContent = String(p.dwellMs);
  $('offset').textContent = `${p.offset.x}, ${p.offset.y}`;
  $('targets').textContent = state?.snap ? `${p.targets} targets${p.app ? ` in ${p.app}` : ''}` : '';
  const ai = p.ai;
  $('ai-status').textContent =
    !ai || ai.state === 'off'
      ? ''
      : [
          ai.state === 'error' && ai.error ? ai.error : AI_TEXT[ai.state] ?? ai.state,
          ai.count ? `${ai.count} boxes` : '',
          ai.scans ? `${ai.scans} looks${ai.lastMs ? `, last ${(ai.lastMs / 1000).toFixed(1)} s` : ''}` : '',
          ai.cacheHits ? `${ai.cacheHits} reused` : '',
          ai.costUsd ? `≈ $${ai.costUsd.toFixed(2)}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
});

/** server/memory/recorder.ts MemoryStatus. */
type MemoryStatus = {
  state: 'unavailable' | 'off' | 'paused' | 'recording';
  note: string | null;
  kept: number;
  same: number;
  skipped: number;
  captioned: number;
  failed: number;
  queued: number;
  costUsd: number;
  total: number;
};
let memory: MemoryStatus | null = null;
hot?.on('gm:memory', (m: MemoryStatus) => {
  memory = m;
  const text = m.state === 'unavailable' ? 'unavailable' : m.state === 'paused' ? 'paused (data/memory/PAUSE)' : m.state;
  pill('memory', text, m.state === 'recording' ? 'on' : m.state === 'unavailable' ? 'unavailable' : 'off');
  $('memory-toggle').textContent = m.state === 'off' || m.state === 'unavailable' ? 'turn on' : 'turn off';
  $('memory-status').textContent = [
    m.note ?? '',
    m.state !== 'off' && m.state !== 'unavailable' ? `${m.kept} kept, ${m.same} unchanged` : '',
    m.captioned ? `${m.captioned} captioned${m.queued ? `, ${m.queued} waiting` : ''}` : '',
    m.failed ? `${m.failed} failed` : '',
    m.costUsd ? `≈ $${m.costUsd.toFixed(3)}` : '',
    `${m.total} in memory`,
  ]
    .filter(Boolean)
    .join(' · ');
});

hot?.on('gm:heard', ({ text }: { text: string }) => {
  host?.send({ type: 'heard', text });
  $('heard').textContent = `heard: ${text}`;
});

// ------------------------------------------------------------------ phone link

function sendGeometry() {
  if (!desk.w) return;
  // Pixels per degree of phone turn near the screen's center: the server's thresholds are in degrees.
  hot?.send('gm:pointer-cfg', { pxPerDeg: distanceK * desk.w * Math.tan(Math.PI / 180) });
  if (!host) return;
  host.send({ type: 'viewport', width: desk.w, height: desk.h });
  host.send({ type: 'distance', px: Math.round(distanceK * desk.w) });
}

function wire(h: Host) {
  h.onOpen(() => {
    sendGeometry();
    // Gymote's x comes from the compass heading, so until centered the pointer is somewhere off-screen.
    h.send({ type: 'center' });
    if (state) h.send({ type: 'state', state });
  });

  // Gymote's packet is Int16 [x, y, clicking, touchY], already in desktop px (we sent it our
  // viewport). The raw aim goes straight to the server; GymoteScreen's own smoothing isn't used.
  h.onPointer((buf) => {
    if (buf.byteLength < 4) return;
    const a = new Int16Array(buf, 0, 2);
    hot?.send('gm:raw', { x: a[0], y: a[1] });
  });

  h.onEvent((msg) => {
    if (msg.type === 'button') hot?.send('gm:button', { button: msg.button, down: msg.down });
    else if (msg.type === 'scroll-speed') hot?.send('gm:scroll-speed', { perS: msg.perS });
    else if (msg.type === 'centered') {
      hot?.send('gm:recentered');
      log('Phone centered.');
    }
  });
}

// ------------------------------------------------------------------ page controls

const centerPhone = () => host?.send({ type: 'center' });
const stopAll = () => hot?.send('gm:stop');
$('center').addEventListener('click', centerPhone);
$('stop').addEventListener('click', stopAll);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') stopAll();
  if (e.key === 'c' || e.key === 'C') centerPhone();
});

for (const [id, d] of [['dist-down', -0.1], ['dist-up', 0.1]] as const) {
  $(id).addEventListener('click', () => {
    distanceK = Math.round(Math.min(4, Math.max(0.4, distanceK + d)) * 10) / 10;
    safeSet('gm:distanceK', String(distanceK));
    sendGeometry();
    render();
  });
}
for (const [id, d] of [['dwell-down', -100], ['dwell-up', 100]] as const) {
  $(id).addEventListener('click', () => {
    dwellMs = Math.min(1500, Math.max(500, dwellMs + d));
    safeSet('gm:dwellMs', String(dwellMs));
    hot?.send('gm:pointer-cfg', { dwellMs });
    render();
  });
}
$('mouse-toggle').addEventListener('click', () => hot?.send('gm:toggle', { what: 'mouse' }));
$('dwell').addEventListener('click', () => hot?.send('gm:toggle', { what: 'dwell' }));
$('snap').addEventListener('click', () => hot?.send('gm:toggle', { what: 'snap' }));
$('ai').addEventListener('click', () => hot?.send('gm:toggle', { what: 'ai' }));
$('memory-toggle').addEventListener('click', () => hot?.send('gm:memory', { on: !memory || memory.state === 'off' || memory.state === 'unavailable' }));
$('dwell-reset').addEventListener('click', () => hot?.send('gm:pointer-reset', { what: 'adaptive' }));
$('offset-reset').addEventListener('click', () => hot?.send('gm:pointer-reset', { what: 'offset' }));
for (const [id, d] of [['gap-down', -50], ['gap-up', 50]] as const) {
  $(id).addEventListener('click', () => {
    keysGap = Math.min(600, Math.max(0, keysGap + d));
    safeSet('gm:keysGap', String(keysGap));
    hot?.send('gm:keys-gap', { ms: keysGap });
    render();
  });
}

// ------------------------------------------------------------------ render

const ORION_TEXT: Record<RemoteState['orion'], string> = {
  idle: 'ready',
  listening: 'listening',
  transcribing: 'transcribing',
  working: 'working',
  confirm: 'asking',
};

/** What the pointer is doing, for the "Doing" pill. */
function doingText(s: RemoteState): string {
  if (s.paused) return 'paused';
  if (s.ui === 'wheel') return 'wheel open';
  if (s.ui === 'zoom') return `zoom ${s.zoomK}×`;
  if (s.ui === 'scroll') return 'scrolling';
  if (s.pending) return `next: ${s.pending} click`.replace('drag click', 'drag');
  return 'pointing';
}

function render() {
  $('dist').textContent = distanceK.toFixed(1);
  $('gap').textContent = String(keysGap);
  $('dwell-base').textContent = String(dwellMs);
  // Turning this far sweeps the screen width at the projected distance.
  $('angle').textContent = `${Math.round((2 * Math.atan(1 / (2 * distanceK)) * 180) / Math.PI)}°`;
  if (!state) return;
  pill('mouse', state.mouse ? 'on' : 'off', state.mouse ? 'on' : 'off');
  $('mouse-toggle').textContent = state.mouse ? 'turn off' : 'turn on';
  pill('keys', state.keys === 'unavailable' ? 'run npm run setup:keys' : state.keys, state.keys);
  pill('orion', state.orionMissing ? state.orionMissing : ORION_TEXT[state.orion], state.orionMissing ? 'unavailable' : state.orion);
  $('orion-text').textContent = state.orion === 'idle' ? '' : state.orionText;
  pill('dictation', state.dictation === 'unavailable' ? 'needs ELEVENLABS_API_KEY' : state.dictation === 'idle' ? 'ready' : state.dictation, state.dictation === 'unavailable' ? 'unavailable' : state.dictation);
  $('dictation-text').textContent = state.dictationText;
  pill('mode', doingText(state), state.paused ? 'listening' : 'on');
  toggleButton('dwell', state.dwell);
  toggleButton('snap', state.snap);
  toggleButton('ai', state.ai !== 'off' && state.ai !== 'unavailable');
  if (state.ai === 'unavailable') $('ai').textContent = 'needs ANTHROPIC_API_KEY';
}

function toggleButton(id: string, on: boolean) {
  $(id).textContent = on ? 'on' : 'off';
  $(id).classList.toggle('on', on);
}

function pill(id: string, text: string, cls: string) {
  $(id).textContent = text;
  $(id).className = `pill ${cls}`;
}

function log(text: string) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').prepend(li);
  while ($('log').children.length > 30) $('log').lastElementChild?.remove();
}

render();

// ------------------------------------------------------------------ status + QR

let connectingSince: number | null = null;
let tracking: boolean | null = null;
let qrUrl: string | null = null;

/** Ask the dev server for the ngrok URL (with the pairing token); re-check until a tunnel shows up. */
async function refreshUrl() {
  try {
    const res = await fetch(`/api/link/public-url?k=${token}`);
    const { url } = (await res.json()) as { url: string | null };
    if (url && url !== qrUrl) {
      qrUrl = url;
      await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 200, margin: 1 });
      $('url').textContent = url;
    }
    $('connect-warn').textContent = url ? '' : 'No ngrok tunnel yet. Run "ngrok http 127.0.0.1:5176" and this code appears by itself.';
    if (!url) setTimeout(refreshUrl, 3000);
  } catch {
    $('connect-warn').textContent = 'Can’t reach the dev server for the phone link.';
    setTimeout(refreshUrl, 3000);
  }
}

setInterval(() => {
  if (!host) return;
  const now = performance.now();
  const status = host.status();
  connectingSince = status === 'connecting' ? (connectingSince ?? now) : null;
  const silent = isUp(status) && host.lastPongAt() > 0 && now - host.lastPongAt() > SILENT_MS;
  // The phone is there or not: the server freezes the pointer while it isn't.
  const ok = isUp(status) && !silent;
  if (ok !== tracking) {
    tracking = ok;
    hot?.send('gm:tracking', { ok });
  }
  const rtt = host.rttMs();
  $('link').textContent = silent
    ? 'phone: no signal'
    : LINK_TEXT[status] + (isUp(status) && rtt !== null ? ` · ${rtt.toFixed(0)} ms` : '');
  $('link-dot').className = `dot ${silent || status === 'lost' ? 'bad' : isUp(status) ? 'ok' : ''}`;
  $('connect').classList.toggle('small', isUp(status) && !silent);
  if (connectingSince !== null && now - connectingSince > STUCK_CONNECTING_MS) {
    $('connect-warn').textContent =
      'The phone found this page but can’t reach it directly. This Wi-Fi probably blocks devices from talking to each other: turn on the phone’s hotspot, join this laptop to it, and reload both pages.';
  }
}, 200);
