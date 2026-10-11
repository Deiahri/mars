// Checks the pointer pipeline with fake time, no phone and no xdotool: npm run test:pointer

import assert from 'node:assert/strict';
import { BRAIN, PointerBrain, type PointerOut } from '../server/pointer/brain.ts';
import { DWELL, Dwell } from '../server/pointer/dwell.ts';
import { OneEuro } from '../server/pointer/filter.ts';
import { MOTION, Motion, Spring } from '../server/pointer/motion.ts';
import { Snapper, snapPoint, type Target } from '../server/pointer/snap.ts';
import { buildMenu, menuAt, wheelLayout } from '../server/pointer/wheel.ts';
import { toReal, zoomLayout } from '../server/pointer/zoom.ts';
import { mergeTargets, toTargets } from '../server/vision-targets.ts';

const PPD = 36; // px per degree: phone 1.5 screen widths from a 1366 px screen
const W = 1366;
const H = 768;
let seed = 1;
/** Deterministic noise in [-1, 1]. */
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test('One Euro: kills jitter at rest', () => {
  const f = new OneEuro();
  const raw: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < 300; i++) {
    const v = 10 + 0.3 * noise(); // ±0.3° tremor
    raw.push(v);
    out.push(f.filter(v, 0.016));
  }
  const cut = 1 - sd(out.slice(100)) / sd(raw.slice(100));
  assert.ok(cut > 0.8, `jitter cut ${(cut * 100).toFixed(0)}%`);
});

test('One Euro: little lag when moving at 30°/s', () => {
  const f = new OneEuro();
  let lag = 0;
  for (let i = 0; i < 120; i++) {
    const v = 30 * i * 0.01;
    lag = v - f.filter(v, 0.01);
  }
  assert.ok(lag < 2, `lag ${lag.toFixed(2)}°`);
});

test('I-VT: locks during tremor, so the aim does not move', () => {
  const m = new Motion(W, H, PPD);
  const aims: number[] = [];
  for (let t = 0; t <= 1000; t += 10) {
    m.sample(600 + 0.3 * PPD * noise(), 400 + 0.3 * PPD * noise(), t);
    const o = m.tick(t)!;
    if (t > 400) {
      assert.ok(o.anchor, `not fixating at ${t} ms`);
      aims.push(o.aim.x);
    }
  }
  // Tremor must not creep the anchor: at most a few hundredths of a degree.
  assert.ok(sd(aims) < 0.03 * PPD, `aim wobbles ${(sd(aims) / PPD).toFixed(3)}°`);
});

test('I-VT: a slow 0.5° correction while locked arrives (no getting stuck just short)', () => {
  const m = new Motion(W, H, PPD);
  let o = m.tick(0);
  for (let t = 0; t <= 400; t += 10) m.sample(600 + 0.2 * PPD * noise(), 400 + 0.2 * PPD * noise(), t), (o = m.tick(t));
  assert.ok(o?.anchor, 'not fixating');
  const fix = o!.fixId;
  // Nudge 0.5° right over 200 ms (2.5°/s: too slow and too small to release the lock), then hold.
  const goal = 600 + 0.5 * PPD;
  let arrived: number | null = null;
  for (let t = 410; t <= 1100; t += 10) {
    const x = t < 600 ? 600 + 0.5 * PPD * ((t - 400) / 200) : goal;
    m.sample(x + 0.2 * PPD * noise(), 400 + 0.2 * PPD * noise(), t);
    o = m.tick(t);
    if (arrived === null && Math.abs(o!.aim.x - goal) < 0.1 * PPD) arrived = t;
  }
  assert.ok(o!.anchor, 'the correction released the lock');
  assert.equal(o!.fixId, fix, 'the correction started a new fixation');
  assert.ok(arrived !== null && arrived - 600 <= 600, `aim within 0.1° ${arrived === null ? 'never' : `${arrived - 600} ms after the nudge ended`}`);
  assert.ok(Math.abs(o!.aim.x - goal) < 0.1 * PPD, `ended ${((o!.aim.x - goal) / PPD).toFixed(2)}° off`);
});

test('I-VT: a 5° move releases the lock and the aim follows', () => {
  const m = new Motion(W, H, PPD);
  for (let t = 0; t <= 400; t += 10) m.sample(600, 400, t), m.tick(t);
  let o = m.tick(400)!;
  assert.ok(o.anchor);
  for (let t = 410; t <= 500; t += 10) {
    m.sample(600 + 5 * PPD * ((t - 400) / 100), 400, t);
    o = m.tick(t)!;
  }
  assert.equal(o.anchor, null, 'still locked while moving');
  for (let t = 510; t <= 900; t += 10) o = m.tick(t)!;
  assert.ok(o.anchor && Math.abs(o.aim.x - (600 + 5 * PPD)) < 3, `aim ${o.aim.x}`);
});

test('Spring: no overshoot, 90% of a jump in ≤ 80 ms', () => {
  const s = new Spring();
  s.jump({ x: 0, y: 0 });
  let t90: number | null = null;
  for (let t = 10; t <= 500; t += 10) {
    const p = s.step({ x: 400, y: 0 }, 0.01);
    assert.ok(p.x <= 400.0001, `overshoot ${p.x}`);
    if (t90 === null && p.x >= 360) t90 = t;
  }
  assert.ok(t90 !== null && t90 <= 80, `90% at ${t90} ms`);
});

test('Saccade: a sudden 10° jump in the raw input is 90% done within 80 ms', () => {
  const m = new Motion(W, H, PPD);
  const s = new Spring();
  let t = 0;
  for (; t <= 500; t += 10) m.sample(400, 400, t), s.step(m.tick(t)!.aim, 0.01);
  const t0 = t;
  m.sample(400 + 10 * PPD, 400, t);
  let t90: number | null = null;
  for (; t <= t0 + 300; t += 10) {
    const p = s.step(m.tick(t)!.aim, 0.01);
    if (t90 === null && p.x >= 400 + 9 * PPD) t90 = t - t0;
  }
  assert.ok(t90 !== null && t90 <= 80, `90% at ${t90} ms`);
});

test('Saccade: one noisy sample is smoothed, not jumped to', () => {
  const m = new Motion(W, H, PPD);
  let t = 0;
  for (; t <= 500; t += 10) m.sample(400, 400, t), m.tick(t);
  m.sample(400 + 4 * PPD, 400, t);
  const o = m.tick(t)!;
  assert.ok(o.filtered.x < 400 + PPD, `jumped to ${o.filtered.x}`);
});

test('Spring: the result does not depend on the step size', () => {
  const a = new Spring();
  const b = new Spring();
  a.jump({ x: 0, y: 0 });
  b.jump({ x: 0, y: 0 });
  for (let i = 0; i < 10; i++) a.step({ x: 100, y: 50 }, 0.005);
  b.step({ x: 100, y: 50 }, 0.05);
  assert.ok(Math.abs(a.pos!.x - b.pos!.x) < 1e-6);
});

test('Snap: captures within 1.5°, keeps until 2.5°, switches only when clearly closer', () => {
  const s = new Snapper();
  const a: Target = { id: 'a', x: 100, y: 100, w: 40, h: 30 };
  const b: Target = { id: 'b', x: 300, y: 100, w: 40, h: 30 };
  assert.equal(s.pick({ x: 100 + 40 + 1.4 * PPD, y: 115 }, [a, b], PPD)?.id, 'a');
  assert.equal(s.pick({ x: 140 + 2.4 * PPD, y: 115 }, [a], PPD)?.id, 'a', 'released too early');
  assert.equal(s.pick({ x: 140 + 2.6 * PPD, y: 115 }, [a], PPD), null);
  s.pick({ x: 120, y: 115 }, [a, b], PPD);
  // Between a (ends 140) and b (starts 300): closer to b, but not by 0.7°, and within 2.5° of a.
  assert.equal(s.pick({ x: 225, y: 115 }, [a, b], PPD)?.id, 'a');
  assert.equal(s.pick({ x: 290, y: 115 }, [a, b], PPD)?.id, 'b');
});

test('Snap: the smaller of nested targets wins; wide targets keep the aim', () => {
  const s = new Snapper();
  const row: Target = { id: 'row', x: 0, y: 0, w: 800, h: 40 };
  const btn: Target = { id: 'btn', x: 700, y: 5, w: 30, h: 30 };
  assert.equal(s.pick({ x: 710, y: 20 }, [row, btn], PPD)?.id, 'btn');
  assert.deepEqual(snapPoint({ x: 300, y: 3 }, row), { x: 300, y: 12 });
  assert.deepEqual(snapPoint({ x: 701, y: 6 }, btn), { x: 712, y: 17 });
});

test('Dwell: fires at the set time, drains smoothly, no repeat until left', () => {
  const d = new Dwell();
  let fired = 0;
  for (let t = 0; t < DWELL.BASE_MS - 10; t += 10) fired += +d.update('a', 10, 800);
  assert.equal(fired, 0);
  // Look away for 100 ms: drains 2× (−25%), then come back and resume.
  for (let t = 0; t < 100; t += 10) d.update(null, 10, 800);
  assert.ok(Math.abs(d.progress - (0.9875 - 0.25)) < 0.02, `progress ${d.progress}`);
  for (let t = 0; t < 230; t += 10) fired += +d.update('a', 10, 800);
  assert.equal(fired, 1);
  for (let t = 0; t < 3000; t += 10) fired += +d.update('a', 10, 800);
  assert.equal(fired, 1, 'repeated while staring');
  d.update('b', 10, 800);
  for (let t = 0; t < 800; t += 10) fired += +d.update('a', 10, 800);
  assert.equal(fired, 2, 'not re-armed after leaving');
});

test('Dwell: adaptive time shrinks on success, grows on retry, stays in bounds', () => {
  const d = new Dwell();
  for (let i = 0; i < 50; i++) {
    d.selected({ x: 0, y: 0 }, i * 3000, PPD);
    d.settled({ x: 10 * PPD, y: 0 }, i * 3000 + 500, PPD);
  }
  assert.equal(d.ms, Math.round(DWELL.BASE_MS * DWELL.MIN_K));
  for (let i = 0; i < 50; i++) d.selected({ x: 0, y: 0 }, 200000 + i * 500, PPD);
  assert.equal(d.ms, Math.round(DWELL.BASE_MS * DWELL.MAX_K));
});

// ------------------------------------------------------------------ the brain, end to end

type Call = string;
test('AI targets: AT-SPI wins where both exist; AI fills the gaps', () => {
  const a11y: Target[] = [{ id: 'a', x: 100, y: 100, w: 80, h: 30 }];
  const ai: Target[] = [
    { id: 'ai:0:same button', x: 104, y: 98, w: 78, h: 34 }, // the same button, slightly off
    { id: 'ai:1:icon inside', x: 150, y: 105, w: 20, h: 20 }, // center inside the AT-SPI one
    { id: 'ai:2:elsewhere', x: 400, y: 100, w: 40, h: 40 },
  ];
  assert.deepEqual(mergeTargets(a11y, ai).map((t) => t.id), ['a', 'ai:2:elsewhere']);
  assert.equal(mergeTargets([], ai).length, 3);
});

test('AI targets: boxes are scaled to screen px, clamped, and junk dropped', () => {
  const out = toTargets(
    [
      { label: 'Send  button', x0: 50, y0: 20, x1: 10, y1: 40 }, // corners swapped
      { label: 'tiny', x0: 5, y0: 5, x1: 7, y1: 7 }, // 4 px on screen
      { label: 'off the edge', x0: -20, y0: 300, x1: 30, y1: 330 },
      { label: 'NaN', x0: NaN, y0: 0, x1: 10, y1: 10 },
    ],
    0.5,
    W,
    H,
  );
  assert.deepEqual(out, [
    { id: 'ai:0:Send button', x: 20, y: 40, w: 80, h: 40 },
    { id: 'ai:2:off the edge', x: 0, y: 600, w: 60, h: 60 },
  ]);
});

test('Brain: selecting an AI-found target does not teach the drift offset', () => {
  const r = rig({ snap: true });
  r.brain.setTargets([{ id: 'ai:0:button', x: 640, y: 390, w: 20, h: 20 }], 'test'); // as in the test below
  for (let i = 0; i < 10; i++) {
    r.hold(630, 400, 200);
    r.brain.phoneButton('left', true);
    r.brain.phoneButton('left', false);
  }
  assert.ok(r.clicks().includes('left down'), 'never clicked');
  assert.deepEqual(r.brain.status().offset, { x: 0, y: 0 });
});

function rig(opts: { live?: boolean; snap?: boolean } = {}) {
  let t = 0;
  const calls: Call[] = [];
  const frames: any[] = [];
  const shots: any[] = [];
  const actions: string[] = [];
  const out: PointerOut = {
    moveTo: (x, y) => calls.push(`move ${x} ${y}`),
    button: (b, d) => calls.push(`${b} ${d ? 'down' : 'up'}`),
    click: (b, n = 1) => calls.push(`click ${b}${n > 1 ? ` ×${n}` : ''}`),
    scroll: (dir) => calls.push(`scroll ${dir}`),
    releaseAll: () => calls.push('release'),
  };
  const brain = new PointerBrain(W, H, {
    out,
    halo: (m) => frames.push(m),
    onState: () => {},
    rescan: () => {},
    info: () => {},
    live: () => opts.live ?? true,
    menuAction: (id) => actions.push(id),
    menuState: () => ({ ai: 'n/a', keys: 'off', wake: 'on', tts: 'on', orion: true, dictate: true }),
    zoomShot: async (r) => (shots.push(r), 'PNG'),
    now: () => t,
    timer: false,
  });
  brain.setPxPerDeg(PPD);
  if (opts.snap) brain.snapOn = true;
  /** Hold the input at (x, y) for ms, ticking every 10 ms. */
  const hold = (x: number, y: number, ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      t += 10;
      brain.raw(x, y);
      brain.tick(t);
    }
  };
  const clicks = () => calls.filter((c) => !c.startsWith('move'));
  const press = (b: 'left' | 'right' | 'wheel') => (brain.phoneButton(b, true), brain.phoneButton(b, false));
  /** The open wheel's tile for an item id. */
  const tile = (id: string) => {
    const tiles = frames.findLast((f) => 'wheel' in f && f.wheel)?.wheel.tiles ?? [];
    const found = tiles.find((x: any) => x.id === `wheel:${id}`);
    assert.ok(found, `no wheel tile ${id} in ${tiles.map((x: any) => x.id).join(', ')}`);
    return found;
  };
  /** Point at a wheel tile and press Left. */
  const pick = (id: string) => {
    const tl = tile(id);
    hold(tl.x + tl.w / 2, tl.y + tl.h / 2, 300);
    press('left');
    hold(tl.x + tl.w / 2, tl.y + tl.h / 2, 20);
  };
  return { brain, calls, frames, shots, actions, hold, clicks, press, tile, pick, frame: () => frames[frames.length - 1], advance: (ms: number) => (t += ms) };
}

test('Brain: still input settles with no more moves; the OS arrow hides', () => {
  const r = rig();
  r.hold(600, 400, 1000);
  const n = r.calls.length;
  r.hold(600, 400, 500);
  assert.equal(r.calls.length, n, 'kept moving while still');
  assert.equal(r.frame().arrow, false);
  assert.deepEqual(r.frame().cursor, { x: 600, y: 400 });
});

test('Brain: dwell clicks once in Click mode', () => {
  const r = rig();
  r.brain.toggleDwell();
  r.hold(600, 400, 2000);
  assert.deepEqual(r.clicks(), ['click left']);
});

test('Brain: Click keeps press-and-hold drag on the phone', () => {
  const r = rig();
  r.hold(400, 400, 300);
  r.brain.phoneButton('left', true);
  r.hold(500, 400, 300);
  r.brain.phoneButton('left', false);
  assert.deepEqual(r.clicks(), ['left down', 'left up']);
});

test('Wheel: layout has 4 tiles + center, all on screen even in a corner', () => {
  const items = menuAt(buildMenu({ dwell: false, snap: false, ai: 'n/a', keys: 'off', wake: 'on', tts: 'on', orion: true, dictate: true, zoomK: 3 }), [])!;
  assert.deepEqual(items.map((i) => i.id), ['zoom', 'click', 'scroll', 'more']);
  for (const at of [{ x: 683, y: 384 }, { x: 0, y: 0 }, { x: W, y: H }]) {
    const { tiles } = wheelLayout(at, items, 'Close', W, H);
    assert.equal(tiles.length, 5);
    for (const t of tiles) assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H, `${t.id} off screen at ${JSON.stringify(at)}`);
    // Far enough apart for gaze: tile centers at least 2.5° from the center tile's.
    const c = tiles[4];
    for (const t of tiles.slice(0, 4)) assert.ok(Math.hypot(t.x + t.w / 2 - c.x - c.w / 2, t.y + t.h / 2 - c.y - c.h / 2) > 2.4 * PPD);
  }
});

test('Wheel: opens at the cursor; submenus, Back and Close; the app never sees a click', () => {
  const r = rig();
  r.hold(600, 400, 400);
  r.press('wheel');
  assert.equal(r.brain.ui, 'wheel');
  r.hold(600, 400, 20);
  assert.equal(r.tile('back').label, 'Close');
  assert.deepEqual(r.brain.labels(), { left: 'Select', right: 'Close', wheel: 'Close' });
  const moves = r.calls.length;
  r.pick('click');
  assert.equal(r.tile('double').label, 'Double click');
  assert.equal(r.tile('back').label, 'Back');
  r.press('right'); // back
  r.hold(600, 400, 20);
  assert.ok(r.tile('zoom'));
  r.pick('more');
  r.pick('settings');
  assert.equal(r.tile('snap').label, 'Snap: off');
  r.pick('back');
  assert.ok(r.tile('dictate'), 'Back from Settings should show More');
  r.press('wheel');
  assert.equal(r.brain.ui, 'normal');
  const n = r.calls.length;
  r.hold(600, 400, 20);
  assert.equal(r.frame().wheel, null);
  assert.equal(n, moves, `the real pointer moved or clicked: ${r.calls.slice(moves).join(', ')}`);
});

test('Wheel: dwell picks a tile', () => {
  const r = rig();
  r.brain.toggleDwell();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  const s = r.tile('scroll');
  r.hold(s.x + s.w / 2, s.y + s.h / 2, BRAIN.WHEEL_MIN_MS + 400);
  assert.equal(r.brain.ui, 'scroll');
  assert.deepEqual(r.clicks(), []);
});

test('Wheel: Dictate / Orion / Snap / Voice › Hey Orion, Orion speaks, Keys go to the server', () => {
  const r = rig();
  const voice = ['more', 'settings', 'voice'];
  for (const [path, id] of [[['more'], 'dictate'], [['more'], 'orion'], [['more', 'settings'], 'snap'], [voice, 'wake'], [voice, 'tts'], [voice, 'keys']] as const) {
    r.hold(600, 400, 300);
    r.press('wheel');
    r.hold(600, 400, 20);
    for (const p of path) r.pick(p);
    r.pick(id);
    assert.equal(r.brain.ui, 'normal');
  }
  assert.deepEqual(r.actions, ['dictate', 'orion', 'snap', 'wake', 'tts', 'keys']);
});

test('One-shot: Double click once, then plain clicks; Right cancels a pending one', () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('click');
  r.pick('double');
  assert.equal(r.brain.pending, 'double');
  assert.deepEqual(r.brain.labels(), { left: 'Double click', right: 'Cancel', wheel: 'Menu' });
  r.hold(400, 400, 300);
  r.press('left');
  r.press('left');
  assert.deepEqual(r.clicks(), ['click left ×2', 'left down', 'left up']);
  r.press('wheel');
  r.hold(400, 400, 20);
  r.pick('click');
  r.pick('middle');
  r.press('right');
  assert.equal(r.brain.pending, null);
  assert.ok(!r.clicks().includes('click middle') && !r.clicks().includes('right down'), r.clicks().join(', '));
});

test('One-shot: Drag grabs on one Left and drops on the next', () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('click');
  r.pick('drag');
  r.hold(300, 300, 300);
  r.press('left');
  assert.equal(r.brain.dragging, true);
  assert.equal(r.brain.labels().left, 'Drop');
  r.hold(500, 500, 300);
  r.press('left');
  assert.deepEqual(r.clicks(), ['left down', 'left up']);
  assert.equal(r.brain.pending, null);
});

test('Scroll: a tap is one notch; holding repeats at the set speed; Menu ends it', () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('scroll');
  assert.deepEqual(r.brain.labels(), { left: '▲ Up', right: '▼ Down', wheel: 'Done' });
  r.brain.phoneButton('left', true);
  r.hold(600, 400, 100);
  r.brain.phoneButton('left', false);
  assert.deepEqual(r.clicks(), ['scroll up']);
  r.brain.setScrollSpeed(8);
  r.brain.phoneButton('right', true);
  r.hold(600, 400, 1000 + BRAIN.SCROLL_REPEAT_MS);
  r.brain.phoneButton('right', false);
  const downs = r.clicks().filter((c) => c === 'scroll down').length;
  assert.ok(downs >= 8 && downs <= 10, `${downs} notches in 1 s at 8/s`);
  const n = r.clicks().length;
  r.hold(600, 400, 500);
  assert.equal(r.clicks().length, n, 'kept scrolling after release');
  r.press('wheel');
  assert.equal(r.brain.ui, 'normal');
});

test('Zoom: snapshot of the area, finer pointing, one click at the real point, then the cursor waits', async () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('zoom');
  assert.equal(r.brain.ui, 'zoom');
  await new Promise((res) => setTimeout(res, 0));
  const view = zoomLayout({ x: 600, y: 400 }, 3, W, H);
  assert.deepEqual(r.shots, [view.from]);
  assert.ok(r.frames.some((f) => f.zoomImage === 'PNG'), 'no image for the overlay');
  // 30 px right of where the panel shows (600,400) is 10 real px right.
  const at = { x: 600 + 30, y: 400 };
  r.hold(at.x, at.y, 400);
  assert.deepEqual(r.frame().zoom, view);
  const real = toReal(view, at);
  assert.deepEqual(real, { x: 610, y: 400 });
  assert.equal(r.calls.filter((c) => c.startsWith('move')).at(-1), `move ${real.x} ${real.y}`);
  r.press('left');
  assert.deepEqual(r.clicks(), ['click left']);
  assert.equal(r.brain.ui, 'normal');
  // The cursor stays on the clicked point while the phone stays put…
  r.hold(at.x, at.y, 300);
  assert.equal(r.calls.filter((c) => c.startsWith('move')).at(-1), `move ${real.x} ${real.y}`);
  // …and follows again once it moves.
  r.hold(800, 300, 400);
  assert.deepEqual(r.frame().cursor, { x: 800, y: 300 });
});

test('Drag through zoom: grab, hold still with dwell on (no instant drop), small real steps, drop', async () => {
  const r = rig();
  r.brain.toggleDwell();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('click');
  r.pick('drag');
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('zoom');
  await new Promise((res) => setTimeout(res, 0));
  r.hold(630, 400, 300);
  r.press('left');
  assert.equal(r.brain.dragging, true, 'not grabbed');
  r.hold(630, 400, 2000); // still, on the grabbed spot: dwell must not drop it
  assert.equal(r.brain.dragging, true, `dropped by dwell: ${r.clicks().join(', ')}`);
  const from = r.calls.length;
  r.hold(900, 600, 600);
  const moves = r.calls.slice(from).filter((c) => c.startsWith('move')).map((c) => c.split(' ').slice(1).map(Number));
  assert.ok(moves.length > 10, `${moves.length} moves`);
  for (let i = 1; i < moves.length; i++) {
    const d = Math.hypot(moves[i][0] - moves[i - 1][0], moves[i][1] - moves[i - 1][1]);
    assert.ok(d <= BRAIN.DRAG_STEP_PX + 1, `a ${d.toFixed(0)} px jump while dragging`);
  }
  r.press('left');
  assert.equal(r.brain.dragging, false);
  assert.deepEqual(r.clicks(), ['left down', 'left up']);
});

test('Dwell on: a button click is not followed by a dwell click on the same spot', () => {
  const r = rig();
  r.brain.toggleDwell();
  r.hold(600, 400, 300);
  r.press('left');
  r.hold(600, 400, 2500);
  assert.deepEqual(r.clicks(), ['left down', 'left up']);
  r.hold(600 + 3 * PPD, 400, 2000); // moved away and settled: dwell works again
  assert.deepEqual(r.clicks(), ['left down', 'left up', 'click left']);
});

test('Zoom: Menu cancels without clicking', async () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('zoom');
  await new Promise((res) => setTimeout(res, 0));
  r.hold(620, 410, 200);
  r.press('wheel');
  assert.equal(r.brain.ui, 'normal');
  r.hold(620, 410, 20);
  assert.deepEqual(r.clicks(), []);
  assert.equal(r.frame().zoom, null);
});

test('Pause from the wheel stops everything; Menu resumes', () => {
  const r = rig();
  r.hold(600, 400, 300);
  r.press('wheel');
  r.hold(600, 400, 20);
  r.pick('more');
  r.pick('pause');
  assert.equal(r.brain.paused, true);
  assert.deepEqual(r.brain.labels(), { left: '', right: '', wheel: 'Resume' });
  const n = r.calls.length;
  r.hold(400, 400, 1000);
  r.press('left');
  assert.equal(r.calls.length, n, 'moved or clicked while paused');
  assert.equal(r.frame().arrow, true);
  r.press('wheel');
  assert.equal(r.brain.paused, false);
});

test('Brain: tracking lost freezes the pointer and cancels the dwell', () => {
  const r = rig();
  r.brain.toggleDwell();
  r.hold(600, 400, 500);
  r.brain.setTracking(false);
  const n = r.calls.length;
  r.hold(100, 100, 1000);
  assert.equal(r.calls.length, n);
  assert.equal(r.frame().style, 'lost');
  assert.equal(r.brain.dwell.progress, 0);
});

test('Brain: selections on small targets pull the offset toward them, clamped', () => {
  const r = rig({ snap: true });
  const t: Target = { id: 'x', x: 640, y: 390, w: 20, h: 20 }; // center 650,400
  r.brain.setTargets([t], 'test');
  for (let i = 0; i < 40; i++) {
    r.hold(630, 400, 200); // 20 px left of center, inside the snap radius
    r.brain.phoneButton('left', true);
    r.brain.phoneButton('left', false);
  }
  const off = r.brain.status().offset;
  assert.ok(off.x > 15 && off.x <= 3 * PPD, `offset ${off.x}`);
  r.brain.recentered();
  assert.deepEqual(r.brain.status().offset, { x: 0, y: 0 });
});

test('Brain: nothing happens while not live (mouse off / Orion)', () => {
  const r = rig({ live: false });
  r.brain.toggleDwell();
  r.hold(600, 400, 2000);
  r.brain.phoneButton('left', true);
  assert.deepEqual(r.calls, []);
  assert.equal(r.frame().arrow, true);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed (FIX_VEL ${MOTION.FIX_VEL}°/s, spring ω ${MOTION.SPRING_W})`);
process.exit(failed ? 1 : 0);
