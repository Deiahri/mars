// The pointer's brain. Raw pointing in (the phone today, eye gaze later); the real pointer, clicks
// and the on-screen overlay (server/halo.py) out. Every TICK_MS:
//
//   raw + recalibration offset ─► Motion (One Euro + I-VT fixation lock)
//     ─► Snapper (bubble cursor over the strip + accessible targets, with hysteresis)
//     ─► Spring (critically damped) ─► xdotool mousemove
//     ─► Dwell (ring, adaptive time) ─► the current mode's action
//
// The action strip on the right edge (Pause, then the modes) is part of the overlay, which can't be
// clicked, so selections over it are caught here and never reach the app underneath.

import type { PointerMode } from '../../src/net/link.ts';
import { Dwell } from './dwell.ts';
import { Motion, MOTION, Spring, dist, type MotionOut, type Pt } from './motion.ts';
import { SNAP, Snapper, snapPoint, type Target } from './snap.ts';

export type Mode = PointerMode;
export type Btn = 'left' | 'right';

export const MODE_LABEL: Record<Mode, string> = {
  left: 'Click',
  right: 'Right click',
  double: 'Double click',
  drag: 'Drag',
  scroll: 'Scroll',
};

export const BRAIN = {
  TICK_MS: 10,
  /** Strip buttons need at least this long a dwell, however short the adaptive time gets. */
  STRIP_MIN_MS: 700,
  /** Pause / resume always takes this long a dwell. */
  PAUSE_MS: 1000,
  /** Each selection on a small target moves the offset this fraction of the way to its center. */
  RECAL_GAIN: 0.2,
  RECAL_MAX_DEG: 3,
  /** Scroll mode: looking within this many ° above/below the anchor doesn't scroll. */
  SCROLL_DEADZONE_DEG: 1.5,
  /** Scroll mode ends when you look this far to the side. */
  SCROLL_EXIT_DEG: 6,
  /** Wheel clicks per second per ° past the dead zone, and the cap. */
  SCROLL_RATE: 4,
  SCROLL_MAX_PER_S: 20,
  /** After a dwell selection, moving this far from it lets the same thing be selected again. */
  UNSPEND_DEG: 2,
  /** After tracking is lost this long, the OS arrow comes back (someone may want the real mouse). */
  LOST_ARROW_MS: 5000,
  /** The strip brightens when the pointer is this close. */
  STRIP_NEAR_PX: 140,
};

export interface PointerOut {
  moveTo(x: number, y: number): void;
  button(b: Btn, down: boolean): void;
  click(b: Btn, repeat?: number): void;
  scroll(dir: 'up' | 'down'): void;
  releaseAll(): void;
}

export type BrainHooks = {
  out: PointerOut;
  /** One message for server/halo.py. */
  halo: (m: object) => void;
  /** Mode, dwell, snap or pause changed. */
  onState: () => void;
  /** Something was clicked or scrolled: the accessible targets may have moved. */
  rescan: () => void;
  /** A short note for the status pill. */
  info: (text: string) => void;
  /** Mouse on and Orion not driving. */
  live: () => boolean;
  now?: () => number;
  /** false: no internal timer (tests call tick() themselves). */
  timer?: boolean;
};

export type StripButton = Target & { label: string };

export type HaloFrame = {
  arrow: boolean;
  cursor: Pt | null;
  style: 'halo' | 'lost' | 'scroll';
  glow: { x: number; y: number; w: number; h: number } | null;
  ring: { x: number; y: number; p: number; kind: 'dwell' | 'drag' | 'pause' } | null;
  strip: { show: boolean; near: boolean; mode: Mode; paused: boolean; hover: string | null; dragging: boolean };
  chip: string | null;
  scroll: 'up' | 'down' | null;
};

export type PointerStatus = {
  x: number | null;
  y: number | null;
  offset: Pt;
  dwellMs: number;
  dwellBase: number;
  targets: number;
  app: string;
  snapped: string | null;
  fixating: boolean;
};

const debug = !!process.env.GM_DEBUG_POINTER;
const r1 = (v: number) => Math.round(v);
const isStrip = (t: Target | null) => !!t && t.id.startsWith('strip:');

/** The strip: Pause on top, then the modes, centered on the right edge. Sizes scale with the screen. */
export function stripLayout(w: number, h: number): { box: Target; buttons: StripButton[] } {
  const size = Math.min(72, Math.max(48, Math.round(h * 0.075)));
  const gap = Math.round(size * 0.14);
  const items: Array<[string, string]> = [['pause', 'Pause'], ...(Object.keys(MODE_LABEL) as Mode[]).map((m): [string, string] => [m, MODE_LABEL[m]])];
  const bw = size + 2 * gap;
  const bh = items.length * size + (items.length - 1) * gap + 2 * gap;
  const box = { id: 'strip', x: w - bw - 6, y: Math.round((h - bh) / 2), w: bw, h: bh };
  const buttons = items.map(([id, label], i) => ({
    id: `strip:${id}`,
    label,
    x: box.x + gap,
    y: box.y + gap + i * (size + gap),
    w: size,
    h: size,
  }));
  return { box, buttons };
}

export class PointerBrain {
  mode: Mode = 'left';
  dwellOn = false;
  snapOn = true;
  paused = false;
  readonly dwell = new Dwell();

  private readonly w: number;
  private readonly h: number;
  private readonly hooks: BrainHooks;
  private readonly now: () => number;
  private readonly motion: Motion;
  private readonly spring = new Spring();
  private readonly snapper = new Snapper();
  private readonly strip: { box: Target; buttons: StripButton[] };
  private targets: Target[] = [];
  private app = '';
  private offset: Pt = { x: 0, y: 0 };
  private tracking = true;
  private lostAt = 0;
  private wasLive = false;
  private dragging = false;
  private scrolling: { anchor: Pt; acc: number; moved: boolean; dir: 'up' | 'down' | null } | null = null;
  /** Phone buttons whose press went through to the desktop (so their release must too). */
  private phoneHeld = new Set<Btn>();
  private last: MotionOut | null = null;
  private lastTick: number | null = null;
  private lastMoved: Pt | null = null;
  private lastFixId = 0;
  private dwellFix: { id: string; at: Pt } | null = null;
  private lastFired: Pt | null = null;
  private lastFrame = '';
  private lastDebug = '';
  private step: { t0: number; to: Pt; d0: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(w: number, h: number, hooks: BrainHooks) {
    this.w = w;
    this.h = h;
    this.hooks = hooks;
    this.now = hooks.now ?? (() => performance.now());
    // Until the page says otherwise: the phone 1.5 screen widths away.
    this.motion = new Motion(w, h, 1.5 * w * Math.tan(Math.PI / 180));
    this.strip = stripLayout(w, h);
    hooks.halo({ layout: { box: this.strip.box, buttons: this.strip.buttons } });
    if (hooks.timer !== false) this.timer = setInterval(() => this.tick(this.now()), BRAIN.TICK_MS);
  }

  get pxPerDeg() {
    return this.motion.pxPerDeg;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.hooks.halo({ ...this.hiddenFrame(), arrow: true });
  }

  // ---------------------------------------------------------------- inputs

  setPxPerDeg(ppd: number) {
    if (Number.isFinite(ppd) && ppd > 1) this.motion.pxPerDeg = ppd;
  }

  raw(x: number, y: number) {
    if (!this.tracking) return;
    const p = { x: x + this.offset.x, y: y + this.offset.y };
    const t = this.now();
    if (debug && !this.step && this.spring.pos) {
      const d0 = dist(p, this.spring.pos);
      if (d0 > 2 * this.pxPerDeg) this.step = { t0: t, to: p, d0 };
    }
    this.motion.sample(p.x, p.y, t);
  }

  /** The input source is there (true) or gone (false: phone link lost; later, no face). */
  setTracking(ok: boolean) {
    if (ok === this.tracking) return;
    this.tracking = ok;
    if (ok) {
      // Start the filter fresh from the next sample; the spring glides there from where it froze.
      this.motion.reset();
      this.hooks.info('🖱  Tracking back');
    } else {
      this.lostAt = this.now();
      this.stopActions();
      this.hooks.info('🖱  Tracking lost: the pointer is frozen');
    }
  }

  /** The input was re-centered: old smoothing and the learned offset no longer apply. */
  recentered() {
    this.motion.reset();
    this.offset = { x: 0, y: 0 };
    this.snapper.clear();
    this.dwell.cancel();
  }

  setTargets(targets: Target[], app: string) {
    this.targets = targets;
    this.app = app;
  }

  resetOffset() {
    this.offset = { x: 0, y: 0 };
  }

  toggleDwell() {
    this.dwellOn = !this.dwellOn;
    this.dwell.cancel();
    this.hooks.info(this.dwellOn ? `◎  Dwell on: hold still ${this.dwell.ms} ms to ${MODE_LABEL[this.mode].toLowerCase()}` : '◎  Dwell off');
    this.hooks.onState();
  }

  toggleSnap() {
    this.snapOn = !this.snapOn;
    this.snapper.clear();
    this.hooks.info(this.snapOn ? '✦  Snap to buttons on' : '✦  Snap off');
    this.hooks.onState();
  }

  setMode(mode: Mode) {
    if (mode === this.mode || !(mode in MODE_LABEL)) return;
    this.stopActions();
    this.mode = mode;
    this.dwell.regret(this.now());
    this.hooks.info(`🖱  Mode: ${MODE_LABEL[mode]}`);
    this.hooks.onState();
  }

  togglePause() {
    this.paused = !this.paused;
    this.stopActions();
    if (this.paused) this.dwell.regret(this.now());
    this.hooks.info(this.paused ? '⏸  Paused: look around freely. Look at Resume to carry on' : '▶  Resumed');
    this.hooks.onState();
  }

  /** Lets go of a drag and ends scrolling (mode change, pause, mouse off, Stop). */
  stopActions() {
    if (this.dragging) this.hooks.out.button('left', false);
    this.dragging = false;
    this.scrolling = null;
    for (const b of this.phoneHeld) this.hooks.out.button(b, false);
    this.phoneHeld.clear();
    this.dwell.cancel();
  }

  /** Stop everything (the control page's Stop): also leaves pause. */
  stop() {
    this.stopActions();
    if (this.paused) {
      this.paused = false;
      this.hooks.onState();
    }
  }

  /** The phone's Click / Right click. Click does the current mode; in Click mode, holding it drags. */
  phoneButton(b: Btn, down: boolean) {
    if (!down) {
      if (this.phoneHeld.delete(b)) this.hooks.out.button(b, false);
      return;
    }
    if (!this.hooks.live() || !this.tracking) return;
    const tgt = this.snapper.current;
    if (isStrip(tgt)) {
      if (b === 'left') this.stripAction(tgt!.id);
      return;
    }
    if (this.paused) return;
    if (b === 'right' || this.mode === 'left') {
      if (this.scrolling) return this.endScroll();
      this.recalibrate(tgt);
      this.phoneHeld.add(b);
      this.hooks.out.button(b, true);
      this.hooks.rescan();
      return;
    }
    this.select(tgt, false);
  }

  // ---------------------------------------------------------------- the tick

  tick(t: number) {
    const dtMs = this.lastTick === null ? BRAIN.TICK_MS : Math.min(100, t - this.lastTick);
    this.lastTick = t;
    const live = this.hooks.live();
    if (!live) {
      if (this.wasLive) this.stopActions();
      this.wasLive = false;
      return this.send(this.hiddenFrame());
    }
    this.wasLive = true;

    const m = this.tracking ? this.motion.tick(t) : null;
    if (!m) {
      if (!this.spring.pos) return this.send(this.hiddenFrame()); // nothing has pointed yet
      // Tracking lost: freeze where it was and quietly say so. (Tracking but no sample since a
      // reset: the phone is held still; stay put until it moves.)
      const lost = !this.tracking;
      return this.send({
        ...this.hiddenFrame(),
        arrow: lost && t - this.lostAt > BRAIN.LOST_ARROW_MS,
        cursor: this.round(this.spring.pos),
        style: lost ? 'lost' : 'halo',
        strip: this.stripState(this.spring.pos, null),
        chip: lost ? 'tracking lost' : null,
      });
    }
    this.last = m;
    const ppd = this.pxPerDeg;

    if (m.fixId !== this.lastFixId) {
      this.lastFixId = m.fixId;
      if (m.anchor) this.dwell.settled(m.anchor, t, ppd);
    }

    // What can capture the pointer: only Resume while paused, only the strip while scrolling.
    const pause = this.strip.buttons[0];
    const candidates = this.paused ? [pause] : this.scrolling || !this.snapOn ? this.strip.buttons : [...this.strip.buttons, ...this.targets];
    const tgt = this.snapper.pick(m.aim, candidates, ppd);

    let cursor = this.spring.pos ?? m.aim;
    if (!this.paused) {
      const goal = this.scrolling ? this.scrolling.anchor : tgt ? snapPoint(m.aim, tgt) : m.aim;
      cursor = this.spring.step(goal, dtMs / 1000);
      const p = this.round(cursor);
      if (!this.lastMoved || p.x !== this.lastMoved.x || p.y !== this.lastMoved.y) {
        this.lastMoved = p;
        this.hooks.out.moveTo(Math.min(this.w - 1, Math.max(0, p.x)), Math.min(this.h - 1, Math.max(0, p.y)));
      }
    }
    // The aim, not the cursor: while paused the cursor stays put but you still have to look away.
    if (this.lastFired && dist(m.aim, this.lastFired) > BRAIN.UNSPEND_DEG * ppd) {
      this.lastFired = null;
      this.dwell.unspend();
    }
    if (this.scrolling) this.scrollTick(m, dtMs);

    if (this.dwellOn) {
      let key: string | null = null;
      let need = this.dwell.ms;
      if (tgt) {
        key = tgt.id;
        if (tgt === pause) need = BRAIN.PAUSE_MS;
        else if (isStrip(tgt)) need = Math.max(need, BRAIN.STRIP_MIN_MS);
      } else if (this.scrolling) {
        // Settling back on the anchor ends scrolling, once you've scrolled at all.
        key = this.scrolling.moved && !this.scrolling.dir ? 'scroll:end' : null;
      } else if (!this.paused && m.anchor) {
        key = this.fixKey(m);
      }
      if (this.dwell.update(key, dtMs, need)) {
        this.lastFired = { ...m.aim };
        this.select(tgt, true);
      }
    }

    this.debugTick(t, m, tgt);
    const ringAt = this.paused ? { x: pause.x + pause.w / 2, y: pause.y + pause.h / 2 } : cursor;
    this.send({
      arrow: this.paused,
      cursor: this.paused || tgt ? null : this.round(cursor),
      style: this.scrolling ? 'scroll' : 'halo',
      glow: tgt ? { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h } : null,
      ring:
        this.dwellOn && this.dwell.progress > 0
          ? {
              ...this.round(ringAt),
              p: Math.round(this.dwell.progress * 100) / 100,
              kind: this.dwell.key === pause.id ? 'pause' : this.dragging ? 'drag' : 'dwell',
            }
          : null,
      strip: this.stripState(cursor, tgt),
      chip: null,
      scroll: this.scrolling?.dir ?? null,
    });
  }

  status(): PointerStatus {
    const p = this.spring.pos;
    return {
      x: p ? r1(p.x) : null,
      y: p ? r1(p.y) : null,
      offset: this.round(this.offset),
      dwellMs: this.dwell.ms,
      dwellBase: this.dwell.base,
      targets: this.targets.length,
      app: this.app,
      snapped: this.snapper.current?.id ?? null,
      fixating: !!this.last?.anchor,
    };
  }

  // ---------------------------------------------------------------- actions

  /** A selection (dwell, or the phone's Click outside Click mode). */
  private select(tgt: Target | null, byDwell: boolean) {
    if (isStrip(tgt)) return this.stripAction(tgt!.id);
    if (this.paused) return;
    if (this.scrolling) return this.endScroll();
    const t = this.now();
    const at = this.spring.pos ?? this.last?.aim;
    if (!at) return;
    this.recalibrate(tgt);
    const out = this.hooks.out;
    if (this.mode === 'left') out.click('left');
    else if (this.mode === 'right') out.click('right');
    else if (this.mode === 'double') out.click('left', 2);
    else if (this.mode === 'drag') {
      this.dragging = !this.dragging;
      out.button('left', this.dragging);
      this.hooks.info(this.dragging ? '✊  Dragging: select again to drop' : '✋  Dropped');
    } else if (this.mode === 'scroll') {
      this.scrolling = { anchor: { ...at }, acc: 0, moved: false, dir: null };
      this.hooks.info('↕  Scrolling: look above or below to scroll, look back here to stop');
    }
    if (byDwell) this.dwell.selected(at, t, this.pxPerDeg);
    this.hooks.rescan();
  }

  private stripAction(id: string) {
    if (id === 'strip:pause') this.togglePause();
    else if (!this.paused) this.setMode(id.slice('strip:'.length) as Mode);
  }

  private endScroll() {
    this.scrolling = null;
    this.hooks.info('↕  Scrolling stopped');
  }

  private scrollTick(m: MotionOut, dtMs: number) {
    const s = this.scrolling!;
    const ppd = this.pxPerDeg;
    const dx = (m.filtered.x - s.anchor.x) / ppd;
    const dy = (m.filtered.y - s.anchor.y) / ppd;
    if (Math.abs(dx) > BRAIN.SCROLL_EXIT_DEG) return this.endScroll();
    const past = Math.abs(dy) - BRAIN.SCROLL_DEADZONE_DEG;
    if (past <= 0) {
      s.dir = null;
      s.acc = 0;
      return;
    }
    s.moved = true;
    s.dir = dy < 0 ? 'up' : 'down';
    s.acc += (Math.min(BRAIN.SCROLL_MAX_PER_S, past * BRAIN.SCROLL_RATE) * dtMs) / 1000;
    if (s.acc >= 1) this.hooks.rescan();
    for (; s.acc >= 1; s.acc--) this.hooks.out.scroll(s.dir);
  }

  /**
   * Implicit recalibration: a selection on a small target is taken as ground truth for where the
   * user was pointing, and the offset is nudged toward it, so drift gets corrected without
   * re-centering. Only for small targets: on a big one, any point inside is plausible.
   */
  private recalibrate(tgt: Target | null) {
    const m = this.last;
    if (!tgt || isStrip(tgt) || !m) return;
    const ppd = this.pxPerDeg;
    const small = 2 * SNAP.SNAP_DEG * ppd;
    if (tgt.w > small || tgt.h > small) return;
    const max = BRAIN.RECAL_MAX_DEG * ppd;
    const clamp = (v: number) => Math.min(max, Math.max(-max, v));
    this.offset = {
      x: clamp(this.offset.x + BRAIN.RECAL_GAIN * (tgt.x + tgt.w / 2 - m.filtered.x)),
      y: clamp(this.offset.y + BRAIN.RECAL_GAIN * (tgt.y + tgt.h / 2 - m.filtered.y)),
    };
  }

  /** One dwell key per place: a new fixation close to the last one keeps its key (and its ring). */
  private fixKey(m: MotionOut): string {
    const anchor = m.anchor!;
    if (!this.dwellFix || dist(anchor, this.dwellFix.at) > MOTION.LOCK_DEG * this.pxPerDeg) {
      this.dwellFix = { id: `fix:${m.fixId}`, at: { ...anchor } };
    }
    return this.dwellFix.id;
  }

  // ---------------------------------------------------------------- overlay

  private stripState(cursor: Pt, tgt: Target | null): HaloFrame['strip'] {
    const b = this.strip.box;
    const near =
      cursor.x > b.x - BRAIN.STRIP_NEAR_PX && cursor.y > b.y - BRAIN.STRIP_NEAR_PX && cursor.y < b.y + b.h + BRAIN.STRIP_NEAR_PX;
    return { show: true, near, mode: this.mode, paused: this.paused, hover: isStrip(tgt) ? tgt!.id : null, dragging: this.dragging };
  }

  private hiddenFrame(): HaloFrame {
    return {
      arrow: true,
      cursor: null,
      style: 'halo',
      glow: null,
      ring: null,
      strip: { show: false, near: false, mode: this.mode, paused: this.paused, hover: null, dragging: false },
      chip: null,
      scroll: null,
    };
  }

  private send(f: HaloFrame) {
    const s = JSON.stringify(f);
    if (s === this.lastFrame) return;
    this.lastFrame = s;
    this.hooks.halo(f);
  }

  private round(p: Pt): Pt {
    return { x: r1(p.x), y: r1(p.y) };
  }

  private debugTick(t: number, m: MotionOut, tgt: Target | null) {
    if (!debug) return;
    const s = `${m.anchor ? `fixation ${m.fixId}` : 'moving'}${tgt ? `, snapped ${tgt.id}` : ''}`;
    if (s !== this.lastDebug) {
      this.lastDebug = s;
      console.log(`[pointer] ${s}`);
    }
    const step = this.step;
    if (step && this.spring.pos) {
      if (dist(this.spring.pos, step.to) < 0.1 * step.d0) {
        console.log(`[pointer] ${r1(step.d0)} px jump → 90% there in ${r1(t - step.t0)} ms`);
        this.step = null;
      } else if (t - step.t0 > 1000) this.step = null; // locked or snapped elsewhere
    }
  }
}
