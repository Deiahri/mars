// Raw pointing samples → a calm aim point, then a spring that moves the cursor there.
//
//   raw (px) ─► One Euro (adaptive smoothing; skipped during a saccade) ─► I-VT: fixation or movement? ─► aim
//   aim (or a snapped target) ─► critically damped spring ─► cursor
//
// I-VT (velocity-threshold identification): while the input is slower than FIX_VEL for FIX_MIN_MS
// it's a fixation, and the aim locks to one anchor (the mean of the raw input over that time) so
// tremor and microsaccades don't move the cursor at all. Moving more than LOCK_DEG from the
// anchor, or speeding up, releases it.
// Pure (no timers, no I/O) so scripts/pointer-test.ts can drive it with fake time.

import { OneEuro } from './filter.ts';

export type Pt = { x: number; y: number };

export const MOTION = {
  /** °/s. Slower than this is a fixation. Eye trackers usually use 30; a hand aiming a phone is slower. */
  FIX_VEL: 20,
  /**
   * °/s. Faster than this for SACCADE_TICKS ticks is a saccade (a flick of the phone): the filter
   * jumps to the raw point so the cursor goes there at once, and the spring alone smooths the move.
   * Two ticks, so one noisy sample can't trigger it.
   */
  SACCADE_VEL: 60,
  SACCADE_TICKS: 2,
  /** ms the input must stay slow before the aim locks. */
  FIX_MIN_MS: 100,
  /** ° the filtered point may wander from the anchor before the lock lets go. */
  LOCK_DEG: 0.8,
  /** ms of raw input the speed is measured over (long enough to ignore one noisy sample). */
  VEL_WINDOW_MS: 50,
  /** rad/s. Spring stiffness: 90% of a jump in 3.9/ω s (≈65 ms), lag while tracking 2/ω (≈33 ms). */
  SPRING_W: 60,
  /** Raw samples are clamped to the screen ± this fraction, so an uncentered phone can't wind the filter up. */
  EDGE: 0.1,
};

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export type MotionOut = {
  /** Smoothed input, before the fixation lock. */
  filtered: Pt;
  /** Where the cursor should go: the anchor during a fixation, else the filtered point. */
  aim: Pt;
  /** The fixation anchor, or null while moving. */
  anchor: Pt | null;
  /** Increments with every new fixation, so callers can tell fixations apart. */
  fixId: number;
  velocityDegS: number;
};

export class Motion {
  pxPerDeg: number;
  private w: number;
  private h: number;
  private fx = new OneEuro();
  private fy = new OneEuro();
  /** Recent raw samples (ms timestamps). The input only sends on change, so the last one is "still true now". */
  private hist: Array<Pt & { t: number }> = [];
  private lastTick: number | null = null;
  private filtered: Pt | null = null;
  private slowSince: number | null = null;
  private anchor: Pt | null = null;
  private fixId = 0;
  private fastTicks = 0;

  constructor(w: number, h: number, pxPerDeg: number) {
    this.w = w;
    this.h = h;
    this.pxPerDeg = pxPerDeg;
  }

  sample(x: number, y: number, t: number) {
    const mx = this.w * MOTION.EDGE;
    const my = this.h * MOTION.EDGE;
    x = Math.min(this.w + mx, Math.max(-mx, x));
    y = Math.min(this.h + my, Math.max(-my, y));
    this.hist.push({ x, y, t });
    // Keep a few windows' worth, but always the newest.
    while (this.hist.length > 2 && this.hist[1].t < t - 4 * MOTION.VEL_WINDOW_MS) this.hist.shift();
  }

  /** Forget the filter and any fixation (re-centered, or tracking came back). The next sample starts fresh. */
  reset() {
    this.fx.reset();
    this.fy.reset();
    this.hist = [];
    this.lastTick = null;
    this.filtered = null;
    this.slowSince = null;
    this.anchor = null;
    this.fastTicks = 0;
  }

  /** The raw input as it stood at time t (the last sample at or before t). */
  private rawAt(t: number): Pt {
    let p = this.hist[0];
    for (const s of this.hist) {
      if (s.t > t) break;
      p = s;
    }
    return p;
  }

  /**
   * The fixation's position: the mean of the raw input since `since`. Better than the filtered
   * point, which is still easing in when the lock engages and would lock a little short.
   */
  private centroid(since: number): Pt {
    const pts = [this.rawAt(since), ...this.hist.filter((s) => s.t > since)];
    return {
      x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
      y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    };
  }

  tick(t: number): MotionOut | null {
    if (!this.hist.length) return null;
    const now = this.hist[this.hist.length - 1];
    const dt = this.lastTick === null ? 0 : (t - this.lastTick) / 1000;
    this.lastTick = t;
    const ppd = this.pxPerDeg;
    const velocityDegS = dist(now, this.rawAt(t - MOTION.VEL_WINDOW_MS)) / ppd / (MOTION.VEL_WINDOW_MS / 1000);
    this.fastTicks = velocityDegS > MOTION.SACCADE_VEL ? this.fastTicks + 1 : 0;
    if (this.fastTicks >= MOTION.SACCADE_TICKS) {
      this.fx.reset();
      this.fy.reset();
    }
    this.filtered = { x: this.fx.filter(now.x / ppd, dt) * ppd, y: this.fy.filter(now.y / ppd, dt) * ppd };
    const slow = velocityDegS < MOTION.FIX_VEL;
    if (!slow) this.slowSince = null;
    else this.slowSince ??= t;

    if (this.anchor && (!slow || dist(this.filtered, this.anchor) > MOTION.LOCK_DEG * ppd)) {
      this.anchor = null;
      // A slow drift out of the lock: follow it for a moment before locking again, instead of stepping.
      this.slowSince = slow ? t : null;
    }
    if (!this.anchor && this.slowSince !== null && t - this.slowSince >= MOTION.FIX_MIN_MS) {
      this.anchor = this.centroid(this.slowSince);
      this.fixId++;
    }
    return {
      filtered: this.filtered,
      aim: this.anchor ?? this.filtered,
      anchor: this.anchor,
      fixId: this.fixId,
      velocityDegS,
    };
  }
}

/**
 * A critically damped spring: the fastest motion to a target that never overshoots, and it
 * decelerates into place, which is what reads as calm. Solved exactly per step, so any dt is stable.
 */
export class Spring {
  w: number;
  pos: Pt | null = null;
  private v: Pt = { x: 0, y: 0 };

  constructor(w = MOTION.SPRING_W) {
    this.w = w;
  }

  /** Puts the cursor somewhere without animating (first sample). */
  jump(p: Pt) {
    this.pos = { ...p };
    this.v = { x: 0, y: 0 };
  }

  /** Advances dt seconds toward target. */
  step(target: Pt, dt: number): Pt {
    if (!this.pos) {
      this.jump(target);
      return this.pos!;
    }
    const w = this.w;
    const decay = Math.exp(-w * dt);
    const axis = (p: number, v: number, goal: number): [number, number] => {
      const e = p - goal;
      const c = v + w * e;
      return [goal + (e + c * dt) * decay, (v - w * c * dt) * decay];
    };
    const [x, vx] = axis(this.pos.x, this.v.x, target.x);
    const [y, vy] = axis(this.pos.y, this.v.y, target.y);
    this.pos = { x, y };
    this.v = { x: vx, y: vy };
    return this.pos;
  }
}
