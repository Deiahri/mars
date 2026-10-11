// The phone remote: GymoteRemote does the gyroscope → screen-pixel math; the buttons go to the laptop
// over the reliable events channel. The phone only asks: the laptop's server decides and sends back
// the state (mouse / keys / Orion), which is what the buttons show.
//
// The startup and Gymote bug workarounds are from gymote-playground (see its README).

import './remote.css';
import Gymote, { type GymoteRemote } from 'gymote';
import { startRemote, type LinkStatus, type PointerMode, type RemoteState } from '../net/link';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATUS_TEXT: Record<LinkStatus, string> = {
  starting: 'starting…',
  waiting: 'waiting for the laptop…',
  connecting: 'connecting…',
  connected: 'connected',
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

function run(remote: GymoteRemote, token: string) {
  const link = startRemote(token);
  let state: RemoteState | null = null;
  let heardTimer = 0;

  remote._onDataChange = (buf) => link.sendPointer(buf);

  link.onEvent((msg) => {
    if (msg.type === 'viewport') remote.updateScreenViewport({ width: msg.width, height: msg.height });
    if (msg.type === 'distance') remote.updateScreenDistance(msg.px);
    if (msg.type === 'center') center();
    if (msg.type === 'state') {
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

  holdButton($('left'), (down) => link.send({ type: 'button', button: 'left', down }));
  holdButton($('right'), (down) => link.send({ type: 'button', button: 'right', down }));
  tap($('mouse'), () => link.send({ type: 'toggle', what: 'mouse' }));
  tap($('keys'), () => link.send({ type: 'toggle', what: 'keys' }));
  tap($('dwell'), () => link.send({ type: 'toggle', what: 'dwell' }));
  tap($('orion'), () => link.send({ type: 'orion', action: 'start' }));
  tap($('ok'), () => link.send({ type: 'orion', action: 'ok' }));
  tap($('cancel'), () => link.send({ type: 'orion', action: 'cancel' }));

  remote.start();

  let lastStatus: LinkStatus | null = null;
  setInterval(() => {
    const status = link.status();
    if (status !== lastStatus) {
      if (status === 'connected') navigator.vibrate?.(30);
      lastStatus = status;
    }
    $('status').textContent = status === 'connected' && state?.paused ? 'connected · paused' : STATUS_TEXT[status];
    $('dot').className = `dot ${status === 'connected' ? 'ok' : status === 'lost' ? 'bad' : ''}`;
  }, 200);
}

const ORION_HINT: Partial<Record<RemoteState['orion'], string>> = {
  listening: 'Listening… say what to do, then OK.',
  transcribing: 'Transcribing…',
};

/** Shown under Click when it does something other than a plain click (picked on the screen's strip). */
const MODE_HINT: Record<PointerMode, string> = {
  left: '',
  right: 'right click',
  double: 'double click',
  drag: 'drag / drop',
  scroll: 'scroll',
};

function render(s: RemoteState) {
  const pointerLive = s.mouse && (s.orion === 'idle' || s.orion === 'listening');
  $('mode-label').textContent = s.paused ? 'paused' : MODE_HINT[s.mode];
  $('dwell').classList.toggle('on', s.dwell);
  $('dwell-state').textContent = s.dwell ? 'on' : 'off';
  $<HTMLButtonElement>('left').disabled = !pointerLive;
  $<HTMLButtonElement>('right').disabled = !pointerLive;
  $('mouse').classList.toggle('on', s.mouse);
  $('mouse-state').textContent = s.mouse ? 'on' : 'off';
  $('keys').classList.toggle('on', s.keys === 'on');
  $('keys-state').textContent = s.keys === 'unavailable' ? 'n/a' : s.keys === 'loading' ? '…' : s.keys;
  $<HTMLButtonElement>('keys').disabled = s.keys === 'unavailable';

  // Orion: one big button when idle; OK + Cancel while listening or asking; Cancel (= stop) while busy.
  const idle = s.orion === 'idle';
  $('orion').hidden = !idle;
  $('choice').hidden = idle;
  $('ok').hidden = s.orion !== 'listening' && s.orion !== 'confirm';
  $('ok').textContent = s.orion === 'confirm' ? 'Yes' : 'OK';
  $('cancel').textContent = s.orion === 'working' ? 'Stop' : s.orion === 'confirm' ? 'No' : 'Cancel';
  $('orion-text').textContent = s.orionMissing ? `Orion is off: ${s.orionMissing}` : (ORION_HINT[s.orion] ?? s.orionText);
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

/** Fires on press, not on click: a click waits for the finger to lift and can be eaten by a tiny drag. */
function tap(el: HTMLElement, fn: () => void) {
  el.addEventListener('pointerdown', () => {
    if ((el as HTMLButtonElement).disabled) return;
    navigator.vibrate?.(15);
    fn();
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
