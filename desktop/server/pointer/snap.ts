// Target magnetism. A bubble cursor: the nearest clickable thing within SNAP_DEG gets the pointer,
// so a 1–4° pointing error still lands on the button. Hysteresis keeps it there until the aim
// clearly leaves (RELEASE_DEG) or another target is clearly closer (SWITCH_DEG), so two buttons
// side by side don't flicker. Pure, like motion.ts.

import type { Pt } from './motion.ts';

export type Target = { id: string; x: number; y: number; w: number; h: number };

export const SNAP = {
  /** ° from a target's edge within which it captures the pointer. */
  SNAP_DEG: 1.5,
  /** ° the aim must move off the captured target before it lets go. */
  RELEASE_DEG: 2.5,
  /** ° closer another target must be to steal the capture. */
  SWITCH_DEG: 0.7,
  /** px. The snapped point stays this far inside a target's edges (small targets: their center). */
  INSET_PX: 12,
};

/** Distance from a point to a rectangle's edge; 0 inside. */
export function rectDist(p: Pt, r: Target): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Where the pointer goes on a target: the aim clamped inside it, so wide rows don't yank it sideways. */
export function snapPoint(p: Pt, r: Target): Pt {
  const ix = Math.min(r.w / 2, SNAP.INSET_PX);
  const iy = Math.min(r.h / 2, SNAP.INSET_PX);
  return {
    x: Math.min(r.x + r.w - ix, Math.max(r.x + ix, p.x)),
    y: Math.min(r.y + r.h - iy, Math.max(r.y + iy, p.y)),
  };
}

export class Snapper {
  current: Target | null = null;

  clear() {
    this.current = null;
  }

  pick(p: Pt, targets: Target[], pxPerDeg: number): Target | null {
    let best: Target | null = null;
    let bestD = Infinity;
    for (const t of targets) {
      const d = rectDist(p, t);
      // Inside nested targets (a button in a list row), the smaller one wins.
      if (d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && best && t.w * t.h < best.w * best.h)) {
        best = t;
        bestD = d;
      }
    }
    if (this.current) {
      // The same target, possibly with a fresher rect from the latest scan.
      const id = this.current.id;
      const cur = targets.find((t) => t.id === id);
      if (cur) {
        const d = rectDist(p, cur);
        const stolen = best && best.id !== cur.id && bestD + SNAP.SWITCH_DEG * pxPerDeg < d;
        if (d <= SNAP.RELEASE_DEG * pxPerDeg && !stolen) return (this.current = cur);
      }
    }
    this.current = best && bestD <= SNAP.SNAP_DEG * pxPerDeg ? best : null;
    return this.current;
  }
}
