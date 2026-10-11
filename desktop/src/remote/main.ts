// The phone remote: GymoteRemote does the gyroscope → screen-pixel math; the buttons go to the laptop
// over the reliable events channel. Three buttons, like the two or three switches a gaze user has:
// Left, Right and Menu (the accessibility wheel, drawn on the laptop's screen). The phone only asks:
// the laptop's server decides what each button means right now and sends the labels back.
//
// The startup and Gymote bug workarounds are from gymote-playground (see its README).

import './remote.css';
import Gymote, { type GymoteRemote } from 'gymote';
import { isUp, startRemote, type LinkStatus, type RemoteState } from '../net/link';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATUS_TEXT: Record<LinkStatus, string> = {
  starting: 'starting…',
  waiting: 'waiting for the laptop…',
  connecting: 'connecting…',
  connected: 'connected',
  relayed: 'connected (relay)',
  lost: 'link lost, reconnecting…',
};

/** The pairing token from the QR code. Without it the laptop won't talk to us. */
const token = new URLSearchParams(location.search).get('k');

if (!token) {
  $('start-note').textContent = 'Open this page from the QR code on the laptop: the link carries the pairing code.';
} else if (!window.isSecureContext) {
  $('start-note').textContent =
    'This page needs https for motion sensors. Open it from the QR code (ngrok link), not the plain http address.';
}

const remote = new Gymote.GymoteRemote();

$('go').addEventListener('click', async () => {
  if (!token) return;
  // Must be the first await inside the tap, or iOS refuses the prompt. Gymote's README checks
  // deviceHasGyroscope() first, but that only resolves after this, so the README order hangs.
  const granted = await remote.requestGyroscopePermission().catch(() => false);
  if (!granted) {
    $('start-note').textContent =
      'Motion access was denied. On iPhone: close this tab, open it again from the QR code, and tap Allow.';
    return;
  }
  // Gymote bug: it only starts the gyroscope after an iOS permission prompt, so on Android
  // (no prompt) nothing ever moves and deviceHasGyroscope() never resolves. Start it ourselves.
  if (!remote.gyroscope.needsPermission()) remote.gyroscope.initGyroNorm();

  // gyronorm treats any reading of exactly 0 as "no sensor" and Gymote never retries, so give
  // an unlucky first reading a few more chances.
  let hasGyro = false;
  for (let attempt = 0; attempt < 3 && !hasGyro; attempt++) {
    if (attempt > 0) {
      remote.gyroscope._hasGyroscope = null;
      remote.gyroscope.initGyroNorm();
    }
    hasGyro = await Promise.race([
      remote.deviceHasGyroscope(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
  }
  if (!hasGyro) {
    $('start-note').textContent = 'No gyroscope readings. Is this a phone, on the https link?';
    return;
  }

  await keepAwake();
  $('start').hidden = true;
  $('pad').hidden = false;
  run(remote, token);
});

/** Best effort: keep the screen awake (a locked screen stops the sensor and the link). */
async function keepAwake() {
  try {
    await (navigator as any).wakeLock?.request('screen');
  } catch {}
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') (navigator as any).wakeLock?.request('screen').catch(() => {});
  });
}

const SPEED_KEY = 'gm:scrollPerS';

function run(remote: GymoteRemote, token: string) {
  const link = startRemote(token);
  let state: RemoteState | null = null;
  let heardTimer = 0;

  // Scroll speed: kept on the phone, sent on every change and whenever the laptop's state arrives
  // (a restarted server has forgotten it).
  const speed = $<HTMLInputElement>('speed');
  speed.value = safeGet(SPEED_KEY) ?? speed.value;
  const sendSpeed = () => link.send({ type: 'scroll-speed', perS: Number(speed.value) });
  speed.addEventListener('input', () => {
    $('speed-val').textContent = speed.value;
    safeSet(SPEED_KEY, speed.value);
    sendSpeed();
  });
  $('speed-val').textContent = speed.value;

  remote._onDataChange = (buf) => link.sendPointer(buf);

  link.onEvent((msg) => {
    if (msg.type === 'viewport') remote.updateScreenViewport({ width: msg.width, height: msg.height });
    if (msg.type === 'distance') remote.updateScreenDistance(msg.px);
    if (msg.type === 'center') center();
    if (msg.type === 'state') {
      if (!state) sendSpeed();
      state = msg.state;
      render(state);
    }
    if (msg.type === 'heard') {
      $('heard').textContent = msg.text;
      clearTimeout(heardTimer);
      heardTimer = window.setTimeout(() => ($('heard').textContent = ''), 1500);
    }
  });

  const center = () => {
    remote.calibrate();
    link.send({ type: 'centered' });
    navigator.vibrate?.(20);
  };
  $('center').addEventListener('click', center);

  for (const b of ['left', 'right', 'wheel'] as const) holdButton($(b), (down) => link.send({ type: 'button', button: b, down }));

  remote.start();

  let lastStatus: LinkStatus | null = null;
  setInterval(() => {
    const status = link.status();
    if (status !== lastStatus) {
      if (isUp(status) && !(lastStatus && isUp(lastStatus))) navigator.vibrate?.(30);
      lastStatus = status;
    }
    $('status').textContent = isUp(status) && state?.paused ? `${STATUS_TEXT[status]} · paused` : STATUS_TEXT[status];
    $('dot').className = `dot ${isUp(status) ? 'ok' : status === 'lost' ? 'bad' : ''}`;
  }, 200);
}

const ORION_HINT: Partial<Record<RemoteState['orion'], string>> = {
  listening: 'Listening… say what to do, then OK.',
  transcribing: 'Transcribing…',
};
const DICTATION_HINT: Partial<Record<RemoteState['dictation'], string>> = {
  listening: 'Dictating… speak, then Type it.',
  transcribing: 'Transcribing…',
};

let prev: RemoteState | null = null;
/** The text line shows whichever of Orion and dictation spoke last. */
let voiceLine = '';

function render(s: RemoteState) {
  const voice = s.orion !== 'idle' || s.dictation === 'listening' || s.dictation === 'transcribing';
  for (const b of ['left', 'right', 'wheel'] as const) {
    const label = s.labels[b];
    const el = $<HTMLButtonElement>(b);
    el.textContent = label || '—';
    el.disabled = !label;
    // Answers in colour: OK / Yes / Type it on the left, Cancel / No / Stop on the right.
    el.classList.toggle('ok', voice && b === 'left');
    el.classList.toggle('cancel', voice && b === 'right');
  }
  $('speed-box').classList.toggle('live', s.ui === 'scroll');
  if (s.orion !== prev?.orion || s.orionText !== prev?.orionText) voiceLine = ORION_HINT[s.orion] ?? s.orionText;
  if (s.dictation !== prev?.dictation || s.dictationText !== prev?.dictationText) voiceLine = DICTATION_HINT[s.dictation] ?? s.dictationText;
  $('orion-text').textContent = voiceLine;
  prev = s;
}

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

/** A button that reports press and release (not click), so holding Click drags. */
function holdButton(el: HTMLElement, onChange: (down: boolean) => void) {
  let down = false;
  const set = (d: boolean) => {
    if (d === down) return;
    down = d;
    el.classList.toggle('active', d);
    onChange(d);
  };
  el.addEventListener('pointerdown', (e) => {
    if ((el as HTMLButtonElement).disabled) return;
    el.setPointerCapture(e.pointerId);
    set(true);
    navigator.vibrate?.(10);
  });
  el.addEventListener('pointerup', () => set(false));
  el.addEventListener('pointercancel', () => set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
