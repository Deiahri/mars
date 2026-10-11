// AI snap targets: Gemini looks at a screenshot and lists what can be clicked, for the apps that
// don't show an accessibility tree to server/targets.py (Chrome without the flag, Electron, games).
// The pointer snaps to these boxes like to the AT-SPI ones, which are exact and win where both
// exist (mergeTargets).
//
// A scan costs a few cents and seconds, so it only runs when the screen really changed:
//   - every WATCH_MS a 96×54 grayscale thumbnail is compared with the one the current boxes came
//     from, ignoring our own overlay (the halo and the glow on the snapped target);
//   - on a change the boxes are dropped at once (stale boxes would pull the pointer to wrong
//     places), and once the screen has been still for SETTLE_MS it is scanned;
//   - the last CACHE_SIZE screens keep their boxes, so going back to a window or tab is free;
//   - one scan at a time, MIN_GAP_MS apart, at most MAX_PER_MIN a minute, and only while
//     someone is pointing and can use them (phone moving, not paused, snapping on, no wheel or zoom open).

import { Desktop } from './computer.ts';
import { GEMINI, generateJson, hasGemini } from './gemini.ts';
import type { Pt } from './pointer/motion.ts';
import type { Target } from './pointer/snap.ts';

export const VISION = {
  /** $ per token, for the running cost on the control page. */
  USD_IN: GEMINI.USD_IN,
  USD_OUT: GEMINI.USD_OUT,
  WATCH_MS: 500,
  THUMB_W: 96,
  THUMB_H: 54,
  /** A thumbnail pixel counts as changed when it differs by more than this (0–255). */
  PIX_DIFF: 12,
  /** The screen counts as changed when more than this fraction of the (unmasked) pixels did. */
  CHANGED_FRAC: 0.015,
  /** ms the screen must stay still before it's scanned (let menus finish opening). */
  SETTLE_MS: 400,
  MIN_GAP_MS: 3000,
  /** A cap for screens that never stop changing: ≈ $0.20 a minute at most. */
  MAX_PER_MIN: 6,
  CACHE_SIZE: 20,
  ERROR_BACKOFF_MS: 10_000,
  /** px. Boxes smaller than this are noise. */
  MIN_BOX_PX: 6,
  /** px around the pointer that the halo and dwell ring may cover, ignored when comparing screens. */
  CURSOR_MASK_PX: 60,
  /** px around the snapped target that its glow may cover. */
  GLOW_MASK_PX: 16,
};

type Rect = { x: number; y: number; w: number; h: number };
type Shot = { thumb: Uint8Array; mask: Rect[] };
export type Box = { label: string; x0: number; y0: number; x1: number; y1: number };

export type VisionState = 'off' | 'waiting' | 'scanning' | 'ready' | 'error';
export type VisionStatus = {
  state: VisionState;
  /** AI targets in use now. */
  count: number;
  scans: number;
  cacheHits: number;
  /** Duration of the last scan, ms. */
  lastMs: number | null;
  costUsd: number;
  error: string | null;
};

export type VisionHooks = {
  /** Whether someone is pointing and can use targets right now. */
  useful: () => boolean;
  /** Where our overlay is drawn: the pointer and the snapped target. Ignored when comparing screens. */
  overlay: () => { cursor: Pt | null; glow: Rect | null };
  onTargets: (targets: Target[]) => void;
  /** The state changed (for RemoteState). */
  onState: () => void;
};

const SYSTEM = `You find the interactive elements in desktop screenshots, so an eye-gaze style pointer can snap onto them.

List every element a person could click or type into: buttons, links, tabs, menu and toolbar items, icon buttons, text fields, checkboxes, radio buttons, dropdowns, sliders, list or table rows that open something, window controls.
- Give each a tight box_2d: [ymin, xmin, ymax, xmax], normalized to 0-1000 across the screenshot.
- Each element once, at the size of its clickable area (a whole toolbar button, not only its icon).
- Be exhaustive, including icon-only buttons: app launchers in docks and taskbars, sidebar and activity-bar icons, toolbar and title-bar icons, system tray icons, links inside text. Go through the screen edge by edge as well as the middle; a busy screen has 50–150 elements.
- Leave out plain text, headings, images and empty space that do nothing.
- Leave out our own overlay: any soft translucent circle or glow around the pointer, and small dark rounded hint chips next to it ("Next: double click", "Scroll · Left ▲ …").
- label: a few words saying what it is ("Send button", "Search field", "Settings tab").`;

const SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          // Gemini's native box format: [ymin, xmin, ymax, xmax], each 0-1000 across the image.
          box_2d: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
        },
        required: ['label', 'box_2d'],
      },
    },
  },
  required: ['elements'],
};

const area = (r: Rect) => r.w * r.h;
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const inside = (p: Pt, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * AT-SPI targets are exact, so they stay; an AI box is added only where none of them is: it must
 * not overlap one by more than 30% (intersection over union), nor have its center inside one.
 */
export function mergeTargets(a11y: Target[], ai: Target[]): Target[] {
  const extra = ai.filter((b) => {
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    return !a11y.some((t) => {
      const i = overlap(b, t);
      return inside(c, t) || i / (area(b) + area(t) - i) > 0.3;
    });
  });
  return extra.length ? [...a11y, ...extra] : a11y;
}

/** Boxes from the model (screenshot px) → snap targets (screen px), dropping junk. */
export function toTargets(boxes: Box[], scale: number, w: number, h: number): Target[] {
  const out: Target[] = [];
  boxes.forEach((b, i) => {
    const v = [b.x0, b.y0, b.x1, b.y1].map((n) => n / scale);
    if (!v.every(Number.isFinite)) return;
    const x0 = Math.max(0, Math.min(v[0], v[2]));
    const y0 = Math.max(0, Math.min(v[1], v[3]));
    const x1 = Math.min(w, Math.max(v[0], v[2]));
    const y1 = Math.min(h, Math.max(v[1], v[3]));
    const r = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
    if (r.w < VISION.MIN_BOX_PX || r.h < VISION.MIN_BOX_PX) return;
    const label = String(b.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    out.push({ id: `ai:${i}:${label}`, ...r });
  });
  return out;
}

/** One look: the interactive elements in a screenshot, as boxes in its own pixel coordinates. */
export async function findElements(
  png: Buffer,
  [sw, sh]: [number, number],
  signal?: AbortSignal,
): Promise<{ boxes: Box[]; usage: { input_tokens: number; output_tokens: number } }> {
  const r = await generateJson<{ elements: { label: string; box_2d: number[] }[] }>({
    system: SYSTEM,
    prompt: 'List the interactive elements in this screenshot.',
    image: { data: png.toString('base64'), mime_type: 'image/png' },
    schema: SCHEMA,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
  });
  const boxes: Box[] = (r.data.elements ?? [])
    .filter((e) => Array.isArray(e.box_2d) && e.box_2d.length === 4)
    .map((e) => {
      const [ymin, xmin, ymax, xmax] = e.box_2d;
      return { label: e.label, x0: (xmin / 1000) * sw, y0: (ymin / 1000) * sh, x1: (xmax / 1000) * sw, y1: (ymax / 1000) * sh };
    });
  return { boxes, usage: { input_tokens: r.input, output_tokens: r.output } };
}

export class VisionTargets {
  enabled: boolean;
  private desktop = new Desktop();
  private ready = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watching = false;
  private scanning: AbortController | null = null;
  /** The screen the current targets describe, or null when none apply. */
  private shown: Shot | null = null;
  private cache: Array<Shot & { targets: Target[] }> = [];
  /** The previous thumbnail, and since when the screen has looked like it. */
  private prev: Shot | null = null;
  private stillSince = 0;
  private scanTimes: number[] = [];
  private backoffUntil = 0;
  private st: VisionStatus = { state: 'off', count: 0, scans: 0, cacheHits: 0, lastMs: null, costUsd: 0, error: null };

  private hooks: VisionHooks;

  constructor(hooks: VisionHooks, opts: { enabled: boolean }) {
    this.hooks = hooks;
    this.enabled = opts.enabled && hasGemini();
    this.st.state = this.enabled ? 'waiting' : 'off';
    this.desktop
      .init()
      .then(() => {
        this.ready = true;
        this.timer = setInterval(() => void this.watch(), VISION.WATCH_MS);
      })
      .catch((e) => this.fail(`no screenshots: ${(e as Error).message}`));
  }

  get available(): boolean {
    return hasGemini();
  }

  status(): VisionStatus {
    return { ...this.st };
  }

  setEnabled(on: boolean) {
    this.enabled = on && hasGemini();
    if (!this.enabled) {
      this.scanning?.abort();
      this.use(null);
    }
    this.setState(this.enabled ? 'waiting' : 'off');
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.scanning?.abort();
  }

  // ---------------------------------------------------------------- watching the screen

  private async watch() {
    if (!this.ready || !this.enabled || this.watching || !this.hooks.useful()) return;
    this.watching = true;
    try {
      const shot = await this.grab();
      const now = Date.now();
      if (!this.prev || this.changed(shot, this.prev)) this.stillSince = now;
      this.prev = shot;
      if (this.shown && !this.changed(shot, this.shown)) return;
      // The targets no longer describe the screen.
      if (this.shown) this.use(null);
      const hit = this.cache.find((c) => !this.changed(shot, c));
      if (hit) {
        this.st.cacheHits++;
        this.use(hit);
        return;
      }
      if (!this.scanning && now - this.stillSince >= VISION.SETTLE_MS && this.mayScan(now)) void this.scan(shot);
    } catch (e) {
      this.fail(`screen grab failed: ${(e as Error).message}`);
    } finally {
      this.watching = false;
    }
  }

  private async grab(): Promise<Shot> {
    const { cursor, glow } = this.hooks.overlay();
    const mask: Rect[] = [];
    const c = VISION.CURSOR_MASK_PX;
    if (cursor) mask.push({ x: cursor.x - c, y: cursor.y - c, w: 2 * c, h: 2 * c });
    const g = VISION.GLOW_MASK_PX;
    if (glow) mask.push({ x: glow.x - g, y: glow.y - g, w: glow.w + 2 * g, h: glow.h + 2 * g });
    return { thumb: await this.desktop.thumb(VISION.THUMB_W, VISION.THUMB_H), mask };
  }

  /** Whether two screens differ, outside the overlay as drawn in either. */
  private changed(a: Shot, b: Shot): boolean {
    const W = VISION.THUMB_W;
    const H = VISION.THUMB_H;
    if (a.thumb.length !== W * H || b.thumb.length !== W * H) return true;
    const sx = W / this.desktop.width;
    const sy = H / this.desktop.height;
    const skip = new Uint8Array(W * H);
    for (const r of [...a.mask, ...b.mask]) {
      const x0 = Math.max(0, Math.floor(r.x * sx));
      const x1 = Math.min(W - 1, Math.ceil((r.x + r.w) * sx));
      const y0 = Math.max(0, Math.floor(r.y * sy));
      const y1 = Math.min(H - 1, Math.ceil((r.y + r.h) * sy));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) skip[y * W + x] = 1;
    }
    let n = 0;
    let diff = 0;
    for (let i = 0; i < W * H; i++) {
      if (skip[i]) continue;
      n++;
      if (Math.abs(a.thumb[i] - b.thumb[i]) > VISION.PIX_DIFF) diff++;
    }
    return diff > VISION.CHANGED_FRAC * n;
  }

  private mayScan(now: number): boolean {
    if (now < this.backoffUntil) return false;
    this.scanTimes = this.scanTimes.filter((t) => now - t < 60_000);
    const last = this.scanTimes[this.scanTimes.length - 1] ?? 0;
    return now - last >= VISION.MIN_GAP_MS && this.scanTimes.length < VISION.MAX_PER_MIN;
  }

  private use(entry: (Shot & { targets: Target[] }) | null) {
    this.shown = entry;
    this.st.count = entry?.targets.length ?? 0;
    this.hooks.onTargets(entry?.targets ?? []);
    if (entry) this.setState('ready');
    else if (!this.scanning) this.setState(this.enabled ? 'waiting' : 'off');
  }

  // ---------------------------------------------------------------- asking Gemini

  private async scan(shot: Shot) {
    const ctl = new AbortController();
    this.scanning = ctl;
    this.scanTimes.push(Date.now());
    this.setState('scanning');
    const t0 = Date.now();
    try {
      const png = await this.desktop.screenshot();
      const { boxes, usage } = await findElements(png, this.desktop.shotSize, ctl.signal);
      this.st.costUsd += usage.input_tokens * VISION.USD_IN + usage.output_tokens * VISION.USD_OUT;
      const targets = toTargets(boxes, this.desktop.scale, this.desktop.width, this.desktop.height);
      this.st.scans++;
      this.st.lastMs = Date.now() - t0;
      this.st.error = null;
      if (process.env.GM_DEBUG_POINTER) {
        console.log(`[vision] ${targets.length} targets in ${this.st.lastMs} ms (${usage.input_tokens} in / ${usage.output_tokens} out, $${this.st.costUsd.toFixed(3)} so far)`);
      }
      const entry = { ...shot, targets };
      this.cache = [entry, ...this.cache.filter((c) => this.changed(shot, c))].slice(0, VISION.CACHE_SIZE);
      this.scanning = null;
      // Only if the screen still looks the same: the watcher checks on its next tick.
      if (this.enabled && (!this.prev || !this.changed(this.prev, shot))) this.use(entry);
      else this.setState(this.enabled ? 'waiting' : 'off');
    } catch (e) {
      this.scanning = null;
      if (ctl.signal.aborted) return;
      this.backoffUntil = Date.now() + VISION.ERROR_BACKOFF_MS;
      this.fail((e as Error).message);
    }
  }

  private fail(error: string) {
    if (error !== this.st.error) console.warn(`[gymote-desktop] AI targets: ${error}`);
    this.st.error = error;
    this.setState('error');
  }

  private setState(state: VisionState) {
    if (state === this.st.state) return;
    this.st.state = state;
    this.hooks.onState();
  }
}
