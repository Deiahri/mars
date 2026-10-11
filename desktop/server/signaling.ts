// Vite dev-server plugin: a tiny WebRTC signaling relay between the screen (laptop) and the
// remote (phone). From gymote-playground (via my-virtual-fpv and the AR plane identifier's cast relay).
//
// Here the phone drives the real mouse, and the ngrok URL is public, so every call needs the pairing
// token (?k=): the server makes it at startup and only hands it to the laptop page (server/plugin.ts),
// which puts it in the QR code. Knowing the ngrok URL alone gets you nothing.
//
// Only the SDP offer/answer goes through here (and through ngrok for the phone); the stick data
// itself flows peer-to-peer over Wi-Fi. ICE is non-trickle: each side waits for candidate
// gathering to finish and sends one complete SDP, so one offer + one answer is all that's exchanged.
//
//   screen (laptop, /)                   remote (phone, /remote.html)
//   POST /api/link/offer {sdp} ──► store ◄── GET /api/link/offer?after=<id>  (polls)
//   GET  /api/link/answer?id=  ──► store ◄── POST /api/link/answer {id, sdp}
//
// Only the most recent offer is kept: reloading the game replaces it and the phone picks it up.
// An offer is handed out once. A phone that asks after it's been answered (a reloaded or second
// phone) gets nothing, but flags the session for renewal; the game sees `{renew: true}` on its
// next answer poll and posts a fresh offer, which the phone picks up on its next poll.
//
// Also: GET /api/link/public-url → the URL the phone should open (the ngrok https tunnel, with the
// token), for the QR code on the laptop page. Phones only give motion data over https.
//
// Relay fallback: Wi-Fi that isolates clients (campus guest networks) blocks the peer-to-peer link
// entirely. Then both pages send their link traffic as `link:relay` over Vite's own HMR websocket
// (the phone's comes through the ngrok tunnel), and this server forwards screen ↔ remote. Those
// messages need the token too.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer, WebSocketClient } from 'vite';

type Session = { id: number; offer: string; answer: string | null; renew: boolean };

let latest: Session | null = null;
let nextId = 1;

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  if (body === undefined) return res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** The https URL of a running ngrok tunnel that points at `port`, via ngrok's local inspection API. */
async function ngrokUrl(port: string): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(800) });
    const { tunnels } = (await res.json()) as { tunnels: { public_url: string; config?: { addr?: string } }[] };
    const https = tunnels.filter((t) => t.public_url.startsWith('https://'));
    const match = https.find((t) => t.config?.addr?.endsWith(`:${port}`)) ?? null;
    return match?.public_url ?? null;
  } catch {
    return null;
  }
}

type RelayMsg = { from: 'screen' | 'remote'; kind: string; data?: unknown; k?: string };

/** Forwards `link:relay` messages from each side to every client of the other side. */
function relay(server: ViteDevServer, token: string) {
  const sides = { screen: new Set<WebSocketClient>(), remote: new Set<WebSocketClient>() };
  server.ws.on('link:relay', (msg: RelayMsg, client: WebSocketClient) => {
    if (msg?.k !== token) return;
    if (msg.from !== 'screen' && msg.from !== 'remote') return;
    const own = sides[msg.from];
    if (!own.has(client)) {
      own.add(client);
      client.socket.on('close', () => own.delete(client));
    }
    const out = { from: msg.from, kind: msg.kind, data: msg.data };
    for (const c of msg.from === 'screen' ? sides.remote : sides.screen) {
      if (c.socket.readyState === 1) c.send('link:relay', out);
    }
  });
}

export function signaling(token: string): Plugin {
  return {
    name: 'link-signaling',
    configureServer(server) {
      relay(server, token);
      // Mounted at /api/link; connect strips the prefix, so req.url is e.g. "/offer?after=3".
      server.middlewares.use('/api/link', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        if (url.searchParams.get('k') !== token) return send(res, 403, { error: 'pairing token required: scan the QR code' });
        try {
          if (url.pathname === '/offer' && req.method === 'POST') {
            const { sdp } = await readJson(req);
            if (typeof sdp !== 'string') return send(res, 400, { error: 'sdp required' });
            latest = { id: nextId++, offer: sdp, answer: null, renew: false };
            return send(res, 200, { id: latest.id });
          }
          if (url.pathname === '/offer' && req.method === 'GET') {
            const after = Number(url.searchParams.get('after') ?? 0);
            if (!latest || latest.id <= after) return send(res, 204);
            if (latest.answer === null) return send(res, 200, { id: latest.id, sdp: latest.offer });
            latest.renew = true; // taken by an earlier phone: ask the game for a new one
            return send(res, 204);
          }
          if (url.pathname === '/answer' && req.method === 'POST') {
            const { id, sdp } = await readJson(req);
            if (!latest || latest.id !== id || latest.answer !== null) {
              return send(res, 409, { error: 'offer is no longer current' });
            }
            latest.answer = sdp;
            return send(res, 200, { ok: true });
          }
          if (url.pathname === '/answer' && req.method === 'GET') {
            const id = Number(url.searchParams.get('id'));
            if (!latest || latest.id !== id) return send(res, 204);
            if (latest.renew) return send(res, 200, { renew: true });
            if (latest.answer) return send(res, 200, { sdp: latest.answer });
            return send(res, 204);
          }
          if (url.pathname === '/public-url' && req.method === 'GET') {
            const port = String(server.config.server.port ?? 5176);
            const tunnel = await ngrokUrl(port);
            return send(res, 200, { url: tunnel ? `${tunnel}/remote.html?k=${token}` : null });
          }
        } catch (e) {
          return send(res, 400, { error: String(e) });
        }
        next();
      });
    },
  };
}
