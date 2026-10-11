// The screen ↔ remote link over a WebRTC peer connection. From gymote-playground (adapted from
// my-virtual-fpv's link.ts).
//
// The screen (laptop) makes the offer and owns two data channels:
//   - "pointer": unordered, no retransmits. Carries Gymote's own 8-byte packet untouched
//     (Int16 [x, y, clicking, touchY]). A late pointer packet is worthless, so it is dropped.
//   - "events": reliable and ordered JSON. Gymote leaves the screen → remote direction to you:
//     the remote must be told the viewport size and distance, or it projects onto 1280×900.
//     The phone's buttons go here too (not Gymote's click bit): a lost click is not OK.
// The remote (phone) answers. Signaling goes through the dev server's /api/link relay, and every
// call carries the pairing token from the QR code (server/signaling.ts).
//
// Fallback: when the peer-to-peer link isn't open (Wi-Fi that isolates clients), both sides send the
// same pointer packets and events through the dev server instead, as `link:relay` messages on Vite's
// HMR websocket (server/signaling.ts). Slower (the phone's leg goes through ngrok) but it works on
// any network. The direct channel takes over once pings get through it both ways (an open channel
// alone proves nothing: on isolating Wi-Fi the phone can report "connected" while nothing arrives),
// so the link upgrades by itself. Relay messages carry the pairing token too.

import { ICE_SERVERS, postJson, waitForIceGathering } from './rtc';

export type EventMsg =
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'distance'; px: number }
  | { type: 'center' }
  | { type: 'centered' }
  // phone → laptop
  | { type: 'button'; button: PhoneButton; down: boolean }
  | { type: 'scroll-speed'; perS: number }
  // laptop → phone (the server is the source of truth; the phone only shows it)
  | { type: 'state'; state: RemoteState }
  | { type: 'heard'; text: string };

export type MarsState = 'idle' | 'listening' | 'transcribing' | 'working' | 'confirm';
export type KeysStatus = 'unavailable' | 'off' | 'loading' | 'on';
/** The phone's three buttons, like the two or three switches a gaze user would have. */
export type PhoneButton = 'left' | 'right' | 'wheel';
/** What the pointer is doing: plain pointing, the menu wheel, the zoom panel, or scrolling. */
export type PointerUi = 'normal' | 'wheel' | 'zoom' | 'scroll';
/** A one-shot click type picked from the wheel: the next Left press does it. */
export type Pending = 'double' | 'triple' | 'middle' | 'drag';
export type RemoteState = {
  mouse: boolean;
  keys: KeysStatus;
  /** The "Hey Mars" listener (server/wake.ts). */
  wake: KeysStatus;
  /** Mars says its answers out loud (server/voice.ts). */
  tts: boolean;
  mars: MarsState;
  marsText: string;
  marsMissing: string | null;
  /** Dictation (server/dictation.ts): speech typed into the focused field. */
  dictation: 'unavailable' | 'idle' | 'listening' | 'transcribing';
  /** The last text typed, or what went wrong. */
  dictationText: string;
  /** Dwell clicking on (server/pointer/dwell.ts). */
  dwell: boolean;
  /** Snapping to accessible buttons on. */
  snap: boolean;
  /** AI snap targets (server/vision-targets.ts): off, or what they're doing. */
  ai: 'unavailable' | 'off' | 'waiting' | 'scanning' | 'ready' | 'error';
  ui: PointerUi;
  pending: Pending | null;
  /** Zoom-click magnification. */
  zoomK: number;
  /** Pointer paused from the wheel: it doesn't move or click until the Menu button resumes it. */
  paused: boolean;
  /** What each phone button does right now (the server decides; the phone shows these). */
  labels: { left: string; right: string; wheel: string };
};

/** `relayed`: up, but through the dev server instead of peer-to-peer. */
export type LinkStatus = 'starting' | 'waiting' | 'connecting' | 'connected' | 'relayed' | 'lost';

/** Whether pointer data and events get through (directly or relayed). */
export const isUp = (s: LinkStatus) => s === 'connected' || s === 'relayed';

const POLL_MS = 400;
const PING_MS = 1000;
/** A path counts as working while pings/pongs arrive over it at least this often (they come every second). */
const ALIVE_MS = 2500;
const fresh = (t: number) => performance.now() - t < ALIVE_MS;

type RelayKind = 'hello' | 'pointer' | 'event';
type RelayMsg = { from: 'screen' | 'remote'; kind: RelayKind; data?: unknown; k?: string };

/**
 * This side's end of the dev-server relay, or null without the Vite dev server (a built bundle).
 * `onMessage` gets only the other side's messages.
 */
function relayChannel(from: 'screen' | 'remote', token: string, onMessage: (kind: RelayKind, data: unknown) => void) {
  const hot = import.meta.hot;
  if (!hot) return null;
  hot.on('link:relay', (msg: RelayMsg) => {
    if (msg?.from && msg.from !== from) onMessage(msg.kind, msg.data);
  });
  return (kind: RelayKind, data?: unknown) => hot.send('link:relay', { from, kind, data, k: token } satisfies RelayMsg);
}

/** Gymote's packet (Int16 [x, y, clicking, touchY]) as JSON for the relay, and back. */
const packetToJson = (buf: ArrayBuffer) => Array.from(new Int16Array(buf));
const packetFromJson = (data: unknown): ArrayBuffer | null =>
  Array.isArray(data) && data.length === 4 && data.every(Number.isFinite) ? Int16Array.from(data).buffer : null;

// ---------------------------------------------------------------- screen (laptop) side

export type Host = {
  status: () => LinkStatus;
  /** Round-trip time to the phone in ms, or null before the first pong. */
  rttMs: () => number | null;
  /** performance.now() of the last pong. Gymote sends nothing while the phone is still, so this is the liveness signal. */
  lastPongAt: () => number;
  send: (msg: EventMsg) => void;
  onEvent: (fn: (msg: EventMsg) => void) => void;
  /** Called each time a phone page connects (first connect, every reload, and every reconnect). */
  onOpen: (fn: () => void) => void;
  onPointer: (fn: (buf: ArrayBuffer) => void) => void;
};

export function startHost(token: string): Host {
  let status: LinkStatus = 'starting';
  let pc: RTCPeerConnection | null = null;
  let events: RTCDataChannel | null = null;
  let rtt: number | null = null;
  let lastPong = 0;
  const listeners: Array<(msg: EventMsg) => void> = [];
  const openListeners: Array<() => void> = [];
  const pointerListeners: Array<(buf: ArrayBuffer) => void> = [];

  /** performance.now() of the last pong over each path. */
  let directAt = -Infinity;
  let relayAt = -Infinity;
  /** The phone page on the relay (a random id per page load), so a reloaded phone gets set up again. */
  let relayPhone: unknown = null;
  /** performance.now() of the last hello (the phone sends one every second while the relay works). */
  let helloAt = -Infinity;
  const directOpen = () => events?.readyState === 'open';
  const useDirect = () => directOpen() && (fresh(directAt) || !relay || !fresh(relayAt));

  function handleEvent(msg: EventMsg, direct: boolean) {
    if (msg.type !== 'pong') return listeners.forEach((fn) => fn(msg));
    const now = performance.now();
    if (direct) directAt = now;
    else relayAt = now;
    // Show the round trip of the path in use (both get pinged).
    if (direct === useDirect()) {
      lastPong = now;
      rtt = now - msg.t;
    }
  }

  const relay = relayChannel('screen', token, (kind, data) => {
    if (kind === 'pointer') {
      const buf = packetFromJson(data);
      if (buf) pointerListeners.forEach((fn) => fn(buf));
    } else if (kind === 'event') handleEvent(data as EventMsg, false);
    else if (kind === 'hello') {
      helloAt = performance.now();
      if (data === relayPhone) return;
      // A new phone page: set it up, whichever path it ends up on.
      relayPhone = data;
      openListeners.forEach((fn) => fn());
    }
  });

  function send(msg: EventMsg) {
    if (useDirect()) events!.send(JSON.stringify(msg));
    else relay?.('event', msg);
  }

  async function offer() {
    pc?.close();
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = conn;
    status = 'starting';

    const pointer = conn.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 });
    pointer.binaryType = 'arraybuffer';
    pointer.onmessage = (e) => pointerListeners.forEach((fn) => fn(e.data as ArrayBuffer));

    const ev = conn.createDataChannel('events');
    events = ev;
    // Phones that reach the relay were set up by their hello: opening the direct path must not
    // re-center them.
    ev.onopen = () => !fresh(helloAt) && openListeners.forEach((fn) => fn());
    ev.onmessage = (e) => handleEvent(JSON.parse(e.data) as EventMsg, true);

    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      if (conn.connectionState === 'connected') status = 'connected';
      if (conn.connectionState === 'failed' || conn.connectionState === 'closed') {
        status = 'lost';
        setTimeout(() => pc === conn && offer(), 500);
      }
    };

    await conn.setLocalDescription(await conn.createOffer());
    await waitForIceGathering(conn);
    const { id } = await postJson<{ id: number }>(`/api/link/offer?k=${token}`, { sdp: conn.localDescription!.sdp });
    status = 'waiting';
    watchAnswers(conn, id);
  }

  /** Polls for the phone's answer; `{renew: true}` means a new or reloaded phone wants in. */
  async function watchAnswers(conn: RTCPeerConnection, id: number) {
    let applied = false;
    while (pc === conn) {
      try {
        const res = await fetch(`/api/link/answer?id=${id}&k=${token}`);
        if (res.status === 200) {
          const body = (await res.json()) as { sdp?: string; renew?: boolean };
          if (body.renew) {
            offer();
            return;
          }
          if (!applied && body.sdp) {
            applied = true;
            status = 'connecting';
            await conn.setRemoteDescription({ type: 'answer', sdp: body.sdp });
          }
        }
      } catch {
        // Dev server restarting; keep trying.
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  // Ping both paths: the direct one has to prove itself before it's used, and the relay stays
  // ready (and this page stays registered with it) in case the direct one dies.
  setInterval(() => {
    const ping: EventMsg = { type: 'ping', t: performance.now() };
    if (directOpen()) events!.send(JSON.stringify(ping));
    relay?.('event', ping);
  }, PING_MS);

  offer().catch(() => (status = 'lost'));

  return {
    status: () => (!useDirect() && fresh(relayAt) ? 'relayed' : status),
    rttMs: () => rtt,
    lastPongAt: () => lastPong,
    send,
    onEvent: (fn) => listeners.push(fn),
    onOpen: (fn) => openListeners.push(fn),
    onPointer: (fn) => pointerListeners.push(fn),
  };
}

// ---------------------------------------------------------------- remote (phone) side

export type Remote = {
  status: () => LinkStatus;
  /** Sends a Gymote packet if the link is open. Pass it straight from GymoteRemote's _onDataChange. */
  sendPointer: (buf: ArrayBuffer) => void;
  send: (msg: EventMsg) => void;
  onEvent: (fn: (msg: EventMsg) => void) => void;
};

export function startRemote(token: string): Remote {
  let status: LinkStatus = 'waiting';
  let pc: RTCPeerConnection | null = null;
  let pointer: RTCDataChannel | null = null;
  let events: RTCDataChannel | null = null;
  let lastOfferId = 0;
  const listeners: Array<(msg: EventMsg) => void> = [];

  /** performance.now() of the last ping over each path. */
  let directAt = -Infinity;
  let relayAt = -Infinity;
  const directOpen = () => events?.readyState === 'open';
  const useDirect = () => directOpen() && (fresh(directAt) || !relay || !fresh(relayAt));

  const relay = relayChannel('remote', token, (kind, data) => {
    if (kind !== 'event') return;
    const msg = data as EventMsg;
    // Pings go back the way they came.
    if (msg.type === 'ping') {
      relayAt = performance.now();
      relay!('event', { type: 'pong', t: msg.t });
    } else listeners.forEach((fn) => fn(msg));
  });
  // Registers this page with the relay and tells the screen it's here (a new id = a reloaded page).
  const pageId = Math.random().toString(36).slice(2);
  const hello = () => relay?.('hello', pageId);
  hello();
  setInterval(hello, PING_MS);

  async function answer(id: number, sdp: string) {
    pc?.close();
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = conn;
    status = 'connecting';
    conn.ondatachannel = ({ channel }) => {
      if (channel.label === 'pointer') pointer = channel;
      if (channel.label === 'events') {
        events = channel;
        channel.onmessage = (e) => {
          const msg = JSON.parse(e.data) as EventMsg;
          // Echo pings straight back so the screen can measure round-trip time.
          if (msg.type === 'ping') {
            directAt = performance.now();
            channel.send(JSON.stringify({ type: 'pong', t: msg.t }));
          } else listeners.forEach((fn) => fn(msg));
        };
      }
    };
    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      if (conn.connectionState === 'connected') status = 'connected';
      if (conn.connectionState === 'failed' || conn.connectionState === 'disconnected') status = 'lost';
    };
    await conn.setRemoteDescription({ type: 'offer', sdp });
    await conn.setLocalDescription(await conn.createAnswer());
    await waitForIceGathering(conn);
    await postJson(`/api/link/answer?k=${token}`, { id, sdp: conn.localDescription!.sdp });
  }

  async function poll() {
    try {
      const res = await fetch(`/api/link/offer?after=${lastOfferId}&k=${token}`);
      if (res.status === 200) {
        const { id, sdp } = (await res.json()) as { id: number; sdp: string };
        lastOfferId = id;
        await answer(id, sdp);
      }
    } catch {
      // Network blip; the next poll retries.
    }
    setTimeout(poll, POLL_MS);
  }
  poll();

  return {
    status: () => (!useDirect() && fresh(relayAt) ? 'relayed' : status),
    sendPointer: (buf) => {
      // send() copies the bytes, so Gymote reusing its buffer for the next frame is fine.
      if (useDirect() && pointer?.readyState === 'open') pointer.send(buf);
      else relay?.('pointer', packetToJson(buf));
    },
    send: (msg) => {
      if (useDirect()) events!.send(JSON.stringify(msg));
      else relay?.('event', msg);
    },
    onEvent: (fn) => listeners.push(fn),
  };
}
