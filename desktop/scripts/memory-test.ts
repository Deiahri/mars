// Checks screen memory's offline parts (no screen, no API, no Ollama): npm run test:memory

import assert from 'node:assert/strict';
import { Store } from '../server/memory/db.ts';
import { Memory } from '../server/memory/memory.ts';
import { pointerMask, THUMB_H, THUMB_W, thumbDiff } from '../server/memory/screen.ts';
import { runMemoryTool } from '../server/memory/tools.ts';

const SIZE: [number, number] = [1366, 768];
const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** A flat gray thumbnail with a bright blob (the halo) around screen point `at`. */
function thumb(at: { x: number; y: number } | null): Uint8Array {
  const t = new Uint8Array(THUMB_W * THUMB_H).fill(80);
  if (at) for (const i of pointerMask(at, 60, SIZE)) t[i] = 255;
  return t;
}

test('thumbDiff: the halo moving alone is no change once masked', () => {
  const a = thumb({ x: 200, y: 200 });
  const b = thumb({ x: 900, y: 500 });
  const raw = thumbDiff(b, a);
  assert.ok(raw > 4, `unmasked diff ${raw} should pass the threshold`);
  // Masked around both the old and the new pointer, as the recorder sees it (old one is in the stored thumb).
  const mask = new Set([...pointerMask({ x: 200, y: 200 }, 70, SIZE), ...pointerMask({ x: 900, y: 500 }, 70, SIZE)]);
  assert.equal(thumbDiff(b, a, mask), 0);
});

test('thumbDiff: a real change outside the mask still counts', () => {
  const a = thumb(null);
  const b = thumb(null);
  for (let i = 0; i < b.length / 2; i++) b[i] = 160; // top half changed (a new window)
  assert.ok(thumbDiff(b, a, pointerMask({ x: 683, y: 700 }, 70, SIZE)) > 4);
});

test('pointerMask: stays inside the thumbnail at the edges', () => {
  for (const p of [{ x: 0, y: 0 }, { x: 1365, y: 767 }, { x: -50, y: 900 }]) {
    for (const i of pointerMask(p, 70, SIZE)) assert.ok(i >= 0 && i < THUMB_W * THUMB_H);
  }
  assert.equal(pointerMask(null, 70, SIZE).size, 0);
});

test('timeline: frames and what was done, in order', () => {
  const store = new Store(':memory:');
  const mem = new Memory(store);
  const t0 = Date.parse('2026-10-11 14:00:00');
  const id = store.insert({ ts: t0, path: 'x.jpg', win_title: 'Terminal', win_class: 'gnome-terminal', px: 10, py: 20, thumb: thumb(null) });
  store.touch(id, t0 + 30_000);
  store.event({ ts: t0 + 5_000, kind: 'click', x: 10, y: 20 });
  store.event({ ts: t0 + 9_000, kind: 'dictation', text: 'npm run build' });
  store.event({ ts: t0 + 99_000, kind: 'orion', text: 'asked “open firefox”' }); // outside the range
  const tl = mem.timeline(t0, t0 + 60_000);
  assert.equal(tl.total, 1);
  assert.equal(tl.frames[0].activity, '(not captioned yet)');
  assert.deepEqual(
    tl.did.map((d) => d.did),
    ['clicked at (10, 20)', 'dictated "npm run build"'],
  );
});

test('timeline: keeps only the most recent 60 clicks', () => {
  const store = new Store(':memory:');
  const t0 = Date.parse('2026-10-11 14:00:00');
  for (let i = 0; i < 100; i++) store.event({ ts: t0 + i * 100, kind: 'click', x: i, y: 0 });
  store.event({ ts: t0 + 50, kind: 'dictation', text: 'hello' });
  const did = new Memory(store).timeline(t0, t0 + 20_000).did;
  assert.equal(did.length, 61);
  assert.equal(did.at(-1)!.did, 'clicked at (99, 0)');
  assert.ok(did.some((d) => d.did === 'dictated "hello"'));
});

test('findEvents: keyword match on what was said, not clicks', () => {
  const store = new Store(':memory:');
  const t0 = Date.now() - 60_000;
  store.event({ ts: t0, kind: 'dictation', text: 'Meeting notes for Friday' });
  store.event({ ts: t0 + 1, kind: 'orion', text: 'asked “open the budget sheet”' });
  store.event({ ts: t0 + 2, kind: 'click', x: 1, y: 1, text: 'right button' });
  assert.deepEqual(store.findEvents(['budget'], 0, Date.now(), 5).map((e) => e.kind), ['orion']);
  assert.deepEqual(store.findEvents(['friday', 'right'], 0, Date.now(), 5).map((e) => e.kind), ['dictation']);
});

test('tools: memory_timeline output, and bad input is an error', async () => {
  const store = new Store(':memory:');
  const mem = new Memory(store);
  const out = await runMemoryTool(mem, 'memory_timeline', { since: '2026-10-11 13:00:00', until: '2026-10-11 13:05:00' });
  assert.equal(out[0].type === 'text' && out[0].text, 'Nothing recorded in that range.');
  await assert.rejects(runMemoryTool(mem, 'memory_timeline', { since: 'yesterday-ish', until: '' }), /can't parse time/);
  await assert.rejects(runMemoryTool(mem, 'view_memory_screenshot', { id: 99 }), /no frame 99/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${(e as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
