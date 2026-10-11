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

import { ICE_SERVERS, postJson, waitForIceGathering } from './rtc';

export type EventMsg =
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'distance'; px: number }
  | { type: 'center' }
  | { type: 'centered' }
  // phone → laptop
  | { type: 'button'; button: 'left' | 'right'; down: boolean }
  | { type: 'toggle'; what: 'mouse' | 'keys' | 'dwell' }
  | { type: 'orion'; action: 'start' | 'ok' | 'cancel' }
  // laptop → phone (the server is the source of truth; the phone only shows it)
  | { type: 'state'; state: RemoteState }
  | { type: 'heard'; text: string };

export type OrionState = 'idle' | 'listening' | 'transcribing' | 'working' | 'confirm';
export type KeysStatus = 'unavailable' | 'off' | 'loading' | 'on';
export type PointerMode = 'left' | 'right' | 'double' | 'drag' | 'scroll';
export type RemoteState = {
  mouse: boolean;
  keys: KeysStatus;
  orion: OrionState;
  orionText: string;
  orionMissing: string | null;
  /** Dwell clicking on (server/pointer/dwell.ts). */
  dwell: boolean;
  /** Snapping to accessible buttons on. */
  snap: boolean;
  /** What a selection does: the action strip's sticky mode. */
  mode: PointerMode;
  /** Pointer paused from the strip: it doesn't move or click until Resume. */
  paused: boolean;
};

export type LinkStatus = 'starting' | 'waiting' | 'connecting' | 'connected' | 'lost';

const POLL_MS = 400;
const PING_MS = 1000;

// ---------------------------------------------------------------- screen (laptop) side

export type Host = {
  status: () => LinkStatus;
  /** Round-trip time to the phone in ms, or null before the first pong. */
  rttMs: () => number | null;
  /** performance.now() of the last pong. Gymote sends nothing while the phone is still, so this is the liveness signal. */
  lastPongAt: () => number;
  send: (msg: EventMsg) => void;
  onEvent: (fn: (msg: EventMsg) => void) => void;
  /** Called each time the events channel opens (first connect and every reconnect). */
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
    ev.onopen = () => openListeners.forEach((fn) => fn());
    ev.onmessage = (e) => {
      const msg = JSON.parse(e.data) as EventMsg;
      if (msg.type === 'pong') {
        lastPong = performance.now();
        rtt = lastPong - msg.t;
      } else listeners.forEach((fn) => fn(msg));
    };

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

  setInterval(() => {
    if (events?.readyState === 'open') events.send(JSON.stringify({ type: 'ping', t: performance.now() }));
  }, PING_MS);

  offer().catch(() => (status = 'lost'));

  return {
    status: () => status,
    rttMs: () => rtt,
    lastPongAt: () => lastPong,
    send: (msg) => {
      if (events?.readyState === 'open') events.send(JSON.stringify(msg));
    },
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
          if (msg.type === 'ping') channel.send(JSON.stringify({ type: 'pong', t: msg.t }));
          else listeners.forEach((fn) => fn(msg));
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
    status: () => status,
    sendPointer: (buf) => {
      // send() copies the bytes, so Gymote reusing its buffer for the next frame is fine.
      if (pointer?.readyState === 'open') pointer.send(buf);
    },
    send: (msg) => {
      if (events?.readyState === 'open') events.send(JSON.stringify(msg));
    },
    onEvent: (fn) => listeners.push(fn),
  };
}
