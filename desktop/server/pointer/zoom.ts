// Zoom-click geometry. A snapshot of a small region (`from`) is shown k× bigger in a panel (`to`)
// over the same place; pointing inside the panel is k× finer, and toReal() maps a panel point back
// to the real screen point under it. One click there, and the panel closes. The snapshot is frozen,
// so nothing moves under the eye (the usual eye-gaze zoom). Pure: brain.ts does the rest.

import type { Pt } from './motion.ts';

export type Rect = { x: number; y: number; w: number; h: number };
export type ZoomView = { from: Rect; to: Rect; k: number };

export const ZOOM = {
  /** Magnifications Pointer ▸ Zoom cycles through. */
  LEVELS: [2, 3, 4],
  DEFAULT_K: 3,
  /** The panel's size as a fraction of the screen. */
  PANEL_FRAC: 0.66,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The region around `at` and the panel showing it, both kept on screen. */
export function zoomLayout(at: Pt, k: number, w: number, h: number): ZoomView {
  const fw = Math.round((w * ZOOM.PANEL_FRAC) / k);
  const fh = Math.round((h * ZOOM.PANEL_FRAC) / k);
  const from = { x: Math.round(clamp(at.x - fw / 2, 0, w - fw)), y: Math.round(clamp(at.y - fh / 2, 0, h - fh)), w: fw, h: fh };
  const tw = fw * k;
  const th = fh * k;
  const cx = from.x + fw / 2;
  const cy = from.y + fh / 2;
  const to = { x: Math.round(clamp(cx - tw / 2, 0, w - tw)), y: Math.round(clamp(cy - th / 2, 0, h - th)), w: tw, h: th };
  return { from, to, k };
}

/** A point kept inside the panel. */
export function clampToPanel(z: ZoomView, p: Pt): Pt {
  return { x: clamp(p.x, z.to.x, z.to.x + z.to.w - 1), y: clamp(p.y, z.to.y, z.to.y + z.to.h - 1) };
}

/** The real screen point under a panel point. */
export function toReal(z: ZoomView, p: Pt): Pt {
  const q = clampToPanel(z, p);
  return { x: Math.round(z.from.x + (q.x - z.to.x) / z.k), y: Math.round(z.from.y + (q.y - z.to.y) / z.k) };
}
