// Shared WebRTC bits for the game ↔ controller link. Copied from the AR plane identifier's cast code.

/** Public STUN so peers can discover their addresses. No TURN (no relay): the link is direct or nothing. */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Non-trickle ICE: wait for candidate gathering so one SDP has everything. Phone and laptop share a
 * Wi-Fi network, so the local candidates (ready in a few ms) are the ones that connect. Gathering
 * often never reports "complete" because the STUN query hangs, so stop once candidates have gone
 * quiet for `settleMs`, and never wait longer than `timeoutMs` (the AR project waited a flat 3 s).
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 1000, settleMs = 250): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settle = 0;
    const done = () => {
      clearTimeout(cap);
      clearTimeout(settle);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const onCandidate = () => {
      clearTimeout(settle);
      settle = window.setTimeout(done, settleMs);
    };
    const cap = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

export async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
