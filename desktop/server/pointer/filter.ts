// One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose cutoff rises with
// speed. Holding still → low cutoff, heavy smoothing, no jitter. Moving fast → high cutoff, almost
// no lag. Values are in degrees of visual angle (px ÷ pxPerDeg), so the same numbers suit a phone
// and an eye tracker.

export type OneEuroOpts = {
  /** Hz. The cutoff at rest: lower = steadier when still, but slower to start moving. */
  minCutoff: number;
  /** Hz per °/s. How fast the cutoff rises with speed: higher = less lag when moving. */
  beta: number;
  /** Hz. Smoothing of the speed estimate itself. */
  dCutoff: number;
};

// Tuned in scripts/pointer-test.ts: cuts >80% of jitter at rest, ~0.8° (~27 ms) behind at 30 °/s.
// The fixation lock (motion.ts) removes what's left when holding still.
export const ONE_EURO: OneEuroOpts = { minCutoff: 0.3, beta: 0.05, dCutoff: 0.5 };

/** Exponential smoothing factor for a cutoff frequency at time step dt (s). */
const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private readonly o: OneEuroOpts;

  constructor(o: OneEuroOpts = ONE_EURO) {
    this.o = o;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  /** v: the new raw value; dt: seconds since the last call. */
  filter(v: number, dt: number): number {
    if (this.x === null) return (this.x = v);
    if (dt <= 0) return this.x;
    this.dx += alpha(this.o.dCutoff, dt) * ((v - this.x) / dt - this.dx);
    this.x += alpha(this.o.minCutoff + this.o.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
}
