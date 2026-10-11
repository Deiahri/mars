// Checks the pointer pipeline with fake time, no phone and no xdotool: npm run test:pointer

import assert from 'node:assert/strict';
import { BRAIN, PointerBrain, stripLayout, type PointerOut } from '../server/pointer/brain.ts';
import { DWELL, Dwell } from '../server/pointer/dwell.ts';
import { OneEuro } from '../server/pointer/filter.ts';
import { MOTION, Motion, Spring } from '../server/pointer/motion.ts';
import { Snapper, snapPoint, type Target } from '../server/pointer/snap.ts';

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

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

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
  assert.ok(sd(aims) < 1e-9, `aim wobbles ${sd(aims)}`);
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
function rig(opts: { live?: boolean } = {}) {
  let t = 0;
  const calls: Call[] = [];
  const frames: any[] = [];
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
    now: () => t,
    timer: false,
  });
  brain.setPxPerDeg(PPD);
  /** Hold the input at (x, y) for ms, ticking every 10 ms. */
  const hold = (x: number, y: number, ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      t += 10;
      brain.raw(x, y);
      brain.tick(t);
    }
  };
  const clicks = () => calls.filter((c) => !c.startsWith('move'));
  return { brain, calls, frames, hold, clicks, frame: () => frames[frames.length - 1] };
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

test('Brain: dwell on the strip changes mode, never clicks the app', () => {
  const r = rig();
  r.brain.toggleDwell();
  const right = stripLayout(W, H).buttons.find((b) => b.id === 'strip:right')!;
  r.hold(right.x + 5, right.y + 5, 1500);
  assert.equal(r.brain.mode, 'right');
  assert.deepEqual(r.clicks(), []);
  assert.equal(r.frame().strip.hover, 'strip:right');
  assert.ok(r.frame().glow, 'no glow on the snapped button');
});

test('Brain: phone Click over the strip selects it; elsewhere it uses the mode', () => {
  const r = rig();
  const dbl = stripLayout(W, H).buttons.find((b) => b.id === 'strip:double')!;
  r.hold(dbl.x + 10, dbl.y + 10, 300);
  r.brain.phoneButton('left', true);
  r.brain.phoneButton('left', false);
  assert.equal(r.brain.mode, 'double');
  r.hold(400, 400, 300);
  r.brain.phoneButton('left', true);
  r.brain.phoneButton('left', false);
  assert.deepEqual(r.clicks(), ['click left ×2']);
});

test('Brain: Click mode keeps press-and-hold drag on the phone', () => {
  const r = rig();
  r.hold(400, 400, 300);
  r.brain.phoneButton('left', true);
  r.hold(500, 400, 300);
  r.brain.phoneButton('left', false);
  assert.deepEqual(r.clicks(), ['left down', 'left up']);
});

test('Brain: pause stops pointer and clicks; dwelling on Resume resumes', () => {
  const r = rig();
  r.brain.toggleDwell();
  const pause = stripLayout(W, H).buttons[0];
  r.hold(pause.x + 10, pause.y + 10, BRAIN.PAUSE_MS + 300);
  assert.equal(r.brain.paused, true);
  const n = r.calls.length;
  r.hold(400, 400, 2000);
  assert.equal(r.calls.length, n, 'moved or clicked while paused');
  r.hold(pause.x + 10, pause.y + 10, BRAIN.PAUSE_MS + 300);
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
  const r = rig();
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

test('Brain: scroll mode scrolls while looking below the anchor', () => {
  const r = rig();
  r.brain.setMode('scroll');
  r.hold(600, 400, 300);
  r.brain.phoneButton('left', true);
  r.brain.phoneButton('left', false);
  r.hold(600, 400 + 4 * PPD, 1000);
  assert.ok(r.clicks().filter((c) => c === 'scroll down').length >= 5, r.clicks().join(', '));
  r.brain.phoneButton('left', true);
  const n = r.clicks().length;
  r.hold(600, 400 + 4 * PPD, 500);
  assert.equal(r.clicks().length, n, 'still scrolling after stopping');
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
    fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed (FIX_VEL ${MOTION.FIX_VEL}°/s, spring ω ${MOTION.SPRING_W})`);
process.exit(failed ? 1 : 0);
