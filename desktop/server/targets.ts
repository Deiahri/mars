// Runs server/targets.py (AT-SPI) and hands its clickable rectangles to the pointer's snapping.

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { hostEnv } from './env.ts';
import type { Target } from './pointer/snap.ts';

const g = globalThis as { __gymoteTargets?: ChildProcess };
/** Rescans asked for closer together than this are merged (a scroll asks many times a second). */
const RESCAN_GAP_MS = 150;
/** A click's effect (a menu opening) takes a moment to show up in the tree. */
const RESCAN_DELAY_MS = 100;

export type Targets = { rescan: () => void; setEnabled: (on: boolean) => void };

export function startTargets(server: ViteDevServer, w: number, h: number, onTargets: (t: Target[], app: string) => void): Targets {
  g.__gymoteTargets?.kill();
  const child = spawn('python3', ['-u', fileURLToPath(new URL('./targets.py', import.meta.url)), String(w), String(h)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: hostEnv(),
  });
  g.__gymoteTargets = child;
  let alive = true;
  let closing = false;
  let warnedEmpty = false;
  child.on('exit', (code) => {
    alive = false;
    if (!closing && g.__gymoteTargets === child) console.warn(`[sightline] targets exited (${code}); no snapping to buttons`);
  });
  server.httpServer?.on('close', () => {
    closing = true;
    child.kill();
  });
  child.stdin.on('error', () => {});

  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line) as { targets: Array<[string, number, number, number, number]>; app: string; ms: number };
        const list = m.targets.map(([id, x, y, tw, th]) => ({ id, x, y, w: tw, h: th }));
        if (process.env.GM_DEBUG_POINTER) console.log(`[targets] ${m.app || '?'}: ${list.length} in ${m.ms} ms`);
        if (!list.length && m.app && !warnedEmpty) {
          warnedEmpty = true;
          console.warn(`[sightline] ${m.app} shows no clickable targets: turn accessibility on to snap (README, "Snapping")`);
        }
        onTargets(list, m.app);
      } catch {}
    }
  });
  // Sandboxed (snap) apps refuse AT-SPI calls and libatspi prints a long warning each time.
  child.stderr.on('data', (d: Buffer) => {
    const s = d.toString();
    if (!/dbind-WARNING|AppArmor/.test(s)) process.stderr.write(s);
  });

  const send = (cmd: string) => {
    if (alive) child.stdin.write(`${cmd}\n`);
  };
  let lastRescan = 0;
  let queued: ReturnType<typeof setTimeout> | null = null;
  return {
    rescan() {
      if (queued) return;
      const wait = Math.max(RESCAN_DELAY_MS, lastRescan + RESCAN_GAP_MS - Date.now());
      queued = setTimeout(() => {
        queued = null;
        lastRescan = Date.now();
        send('rescan');
      }, wait);
    },
    setEnabled: (on) => send(on ? 'on' : 'off'),
  };
}
