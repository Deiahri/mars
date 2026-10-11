// Checks screen memory: npm run test:memory
//
// The change-gate tests need nothing. The database tests need TIGER_DATABASE_URL in .env; they run in
// a throwaway schema (dropped at the end) and use fake embeddings, so no Ollama or API calls.

import assert from 'node:assert/strict';
import { TIGER_URL } from '../server/memory/config.ts';
import { type Caption, Store } from '../server/memory/db.ts';
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
  // Masked around both the old and the new pointer, as the recorder does.
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

// ---------------------------------------------------------------- Tiger

/** A unit vector pointing mostly along axis `i` (fake embeddings: similar topics share an axis). */
function axis(i: number, wobble = 0): Float32Array {
  const v = new Float32Array(768);
  v[i] = 1;
  v[(i + 1) % 768] = wobble;
  const n = Math.hypot(1, wobble);
  return v.map((x) => x / n);
}

const caption = (app: string, activity: string, key_text: string[]): Caption => ({ app, activity, details: '', pointer_on: '', key_text, tags: [] });

let store: Store | null = null;
const T0 = Date.parse('2026-10-10 09:00:00'); // yesterday: everything must be in the past

if (TIGER_URL) {
  store = new Store(TIGER_URL, `screen_memory_test_${process.pid}`);

  test('Tiger: schema, insert, touch, done', async () => {
    await store!.ready;
    const a = await store!.insert({ ts: T0, path: 'a.jpg', win_title: 'Terminal', win_class: 'gnome-terminal', px: 10, py: 20, thumb: thumb(null) });
    await store!.touch(a, T0 + 600_000); // 10 minutes on this screen
    const textA = 'Terminal: npm run build failed with error TS2345 in plugin.ts';
    await store!.done(a, caption('Terminal', 'Running a build that fails', ['TS2345', 'plugin.ts']), textA, axis(1), { input: 1, output: 1 });
    const b = await store!.insert({ ts: T0 + 600_000, path: 'b.jpg', win_title: 'Recipes - Firefox', win_class: 'firefox', px: null, py: null, thumb: thumb(null) });
    await store!.touch(b, T0 + 900_000); // 5 minutes
    await store!.done(b, caption('Firefox', 'Reading a lasagna recipe', ['Classic Lasagna']), 'Firefox: reading a classic lasagna recipe with ricotta', axis(2), { input: 1, output: 1 });
    const c = await store!.insert({ ts: T0 + 900_000, path: 'c.jpg', win_title: 'x', win_class: 'x', px: null, py: null, thumb: thumb(null) });
    await store!.fail(c, 'caption refused');

    const last = await store!.last();
    assert.equal(last?.id, c);
    assert.equal((await store!.get(a))?.caption?.key_text[0], 'TS2345');
    assert.equal((await store!.get(a))?.last_seen, T0 + 600_000);
    assert.deepEqual(await store!.todo(), [c]);
    assert.equal(await store!.count(), 3);
  });

  test(`Tiger: hybrid search ranks the right frame first (keyword + vector)`, async () => {
    // Keyword only: the query vector points elsewhere, the exact error code decides.
    const byWord = await store!.hybrid('TS2345', axis(7), { k: 5 });
    assert.equal((await store!.get(byWord[0].id))?.win_class, 'gnome-terminal');
    // Vector only: no shared words, the embedding decides.
    const byMeaning = await store!.hybrid('something to cook for dinner', axis(2, 0.1), { k: 5 });
    assert.equal((await store!.get(byMeaning[0].id))?.win_class, 'firefox');
    // Filters.
    assert.equal((await store!.hybrid('TS2345', axis(1), { k: 5, app: 'firefox' })).every((r) => r.id !== byWord[0].id), true);
    assert.equal((await store!.hybrid('TS2345', axis(1), { k: 5, since: T0 + 700_000 })).some((r) => r.id === byWord[0].id), false);
  });

  test('Tiger: events, timeline and keyword match on what was said', async () => {
    await store!.event({ ts: T0 + 5_000, kind: 'click', x: 10, y: 20 });
    await store!.event({ ts: T0 + 9_000, kind: 'dictation', text: 'npm run build' });
    await store!.event({ ts: T0 + 3_600_000, kind: 'orion', text: 'asked “open the budget sheet”' });
    const tl = await new Memory(store!).timeline(T0, T0 + 60_000);
    assert.equal(tl.total, 1);
    assert.deepEqual(
      tl.did.map((d) => d.did),
      ['clicked at (10, 20)', 'dictated "npm run build"'],
    );
    const found = await store!.findEvents(['budget'], 0, Date.now(), 5);
    assert.deepEqual(found.map((e) => e.kind), ['orion']);
  });

  test('Tiger: usage from the continuous aggregates', async () => {
    const u = await store!.usage(T0, T0 + 2 * 3600_000);
    const term = u.by_app.find((a) => a.app === 'Terminal');
    const fox = u.by_app.find((a) => a.app === 'Firefox');
    assert.equal(term?.minutes, 10);
    assert.equal(fox?.minutes, 5);
    assert.equal(u.by_hour.reduce((s, h) => s + h.clicks, 0), 1);
    assert.equal(u.by_hour.reduce((s, h) => s + h.orion, 0), 1);
  });

  test('Tiger: tools give text, and bad input is an error', async () => {
    const mem = new Memory(store!);
    const out = await runMemoryTool(mem, 'memory_timeline', { since: '2026-10-11 13:00:00', until: '2026-10-11 13:05:00' });
    assert.equal(out[0].type === 'text' && out[0].text, 'Nothing recorded in that range.');
    const usage = await runMemoryTool(mem, 'memory_usage', { since: '2026-10-10 08:00:00', until: '2026-10-10 12:00:00' });
    assert.ok(usage[0].type === 'text' && usage[0].text.includes('Terminal'));
    await assert.rejects(runMemoryTool(mem, 'memory_timeline', { since: 'yesterday-ish', until: '' }), /can't parse time/);
    await assert.rejects(runMemoryTool(mem, 'view_memory_screenshot', { id: 99999 }), /no frame 99999/);
  });
} else {
  console.log('(no TIGER_DATABASE_URL in .env: skipping the database tests)');
}

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
if (store) {
  await store.dropSchema().catch((e) => console.warn('drop schema failed:', e.message));
  await store.close();
}
console.log(`\n${tests.length - failed}/${tests.length} passed${store ? ` (Tiger, ${store.keyword === 'bm25' ? 'BM25' : 'full-text'} keyword search)` : ''}`);
process.exit(failed ? 1 : 0);
