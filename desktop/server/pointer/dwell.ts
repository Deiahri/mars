// Dwell selection: hold the pointer on something and it's selected, with a ring that fills meanwhile.
// It answers the "Midas touch" problem (not everything looked at gets clicked):
//   - Looking away drains the ring at DRAIN× speed instead of zeroing it, so it cancels smoothly and
//     a brief wobble that comes straight back resumes where it was.
//   - After a selection the same thing can't be selected again until you've left it.
//   - Adaptive: the time shrinks a little after each selection that looks right and grows after
//     one that looks wrong (a quick retry on the same spot, or Pause / a mode change right after).
// Pure, like motion.ts: the caller says what's being held each tick.

import { dist, type Pt } from './motion.ts';

export const DWELL = {
  BASE_MS: 800,
  MIN_BASE_MS: 500,
  MAX_BASE_MS: 1500,
  /** Looking away drains the ring this many times faster than it fills. */
  DRAIN: 2,
  /** Each selection that looks right multiplies the time by FASTER; each that looks wrong by SLOWER. */
  FASTER: 0.96,
  SLOWER: 1.12,
  /** The adaptive factor stays within [MIN_K, MAX_K] × the base time. */
  MIN_K: 0.6,
  MAX_K: 1.6,
  /** Right: within SUCCESS_MS you settle on something more than LEAVE_DEG away, with no retry. */
  SUCCESS_MS: 2000,
  LEAVE_DEG: 3,
  /** Wrong: another selection within RETRY_MS and RETRY_DEG (the first one missed). */
  RETRY_MS: 1500,
  RETRY_DEG: 1,
};

export class Dwell {
  base = DWELL.BASE_MS;
  k = 1;
  /** 0..1, how full the ring is. */
  progress = 0;
  /** What the ring is filling for. */
  key: string | null = null;
  /** What was just selected; it can't fill again until something else is held. */
  private spent: string | null = null;
  private last: { at: Pt; t: number } | null = null;
  private judged = true;

  /** The current dwell time for an ordinary target, ms. */
  get ms() {
    return Math.round(this.base * this.k);
  }

  setBase(ms: number) {
    this.base = Math.min(DWELL.MAX_BASE_MS, Math.max(DWELL.MIN_BASE_MS, Math.round(ms)));
  }

  resetAdaptive() {
    this.k = 1;
  }

  /** Clears the ring (tracking lost, paused, turned off). */
  cancel() {
    this.progress = 0;
    this.key = null;
  }

  /** Lets the spent target fill again (the caller saw the pointer move well away from it). */
  unspend() {
    this.spent = null;
  }

  /**
   * One tick. key = what's held now (null = moving, nothing); needMs = dwell time for it.
   * Returns true when it fires.
   */
  update(key: string | null, dtMs: number, needMs: number): boolean {
    if (key !== null && key !== this.spent) this.spent = null;
    if (key !== null && key === this.spent) {
      this.cancel();
      return false;
    }
    if (key !== null && key === this.key) {
      this.progress += dtMs / needMs;
      if (this.progress >= 1 - 1e-9) {
        this.spent = key;
        this.cancel();
        return true;
      }
    } else if (key !== null) {
      // Something new: start it straight away (an old ring is abandoned, not drained).
      this.key = key;
      this.progress = dtMs / needMs;
    } else {
      this.progress = Math.max(0, this.progress - (DWELL.DRAIN * dtMs) / needMs);
      if (this.progress === 0) this.key = null;
    }
    return false;
  }

  /** A dwell selection happened at `at`: maybe judge the previous one as a miss. */
  selected(at: Pt, t: number, pxPerDeg: number) {
    if (this.last && !this.judged && t - this.last.t < DWELL.RETRY_MS && dist(at, this.last.at) < DWELL.RETRY_DEG * pxPerDeg) {
      this.slower();
    }
    this.last = { at, t };
    this.judged = false;
  }

  /** Pause or a mode change: right after a selection, that one was probably unwanted. */
  regret(t: number) {
    if (this.last && !this.judged && t - this.last.t < DWELL.RETRY_MS) this.slower();
  }

  /** Each new fixation: settling well away soon after a selection means it was right. */
  settled(at: Pt, t: number, pxPerDeg: number) {
    if (!this.last || this.judged) return;
    if (t - this.last.t > DWELL.SUCCESS_MS) this.judged = true;
    else if (dist(at, this.last.at) > DWELL.LEAVE_DEG * pxPerDeg) {
      this.judged = true;
      this.k = Math.max(DWELL.MIN_K, this.k * DWELL.FASTER);
    }
  }

  private slower() {
    this.judged = true;
    this.k = Math.min(DWELL.MAX_K, this.k * DWELL.SLOWER);
  }
}
