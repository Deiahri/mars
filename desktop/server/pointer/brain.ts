// The pointer's brain. Raw pointing in (the phone today, eye gaze later); the real pointer, clicks
// and the on-screen overlay (server/halo.py) out. Every TICK_MS:
//
//   raw + recalibration offset ─► Motion (One Euro + I-VT fixation lock)
//     ─► Snapper (bubble cursor over the wheel's tiles, or accessible targets when Snap is on)
//     ─► Spring (critically damped) ─► xdotool mousemove
//     ─► Dwell (ring, adaptive time) ─► a click
//
// Three buttons, like the two or three switches a gaze user has: Left, Right and Menu (`wheel`).
// What they do depends on `ui`:
//   normal  Left clicks (hold to drag), Right right-clicks, Menu opens the wheel.
//   wheel   the accessibility wheel (wheel.ts) around the pointer. Left picks the tile under the
//           pointer, Right goes back, Menu closes. The real pointer stays where it was.
//   zoom    zoom-click (zoom.ts): a frozen k× snapshot; Left / Right click the real point under
//           the cursor, then it closes. Menu cancels.
//   scroll  Left scrolls up and Right down, repeating while held; Menu ends it.
// A click type picked from the wheel (double, triple, middle, drag) is one-shot: the next Left.
// The overlay can't be clicked, so presses meant for the wheel never reach the app underneath.

import type { Pending, PhoneButton, PointerUi } from '../../src/net/link.ts';
import { Dwell } from './dwell.ts';
import { Motion, MOTION, Spring, dist, type MotionOut, type Pt } from './motion.ts';
import { SNAP, Snapper, snapPoint, type Target } from './snap.ts';
import { buildMenu, menuAt, wheelLayout, type MenuState, type WheelTile } from './wheel.ts';
import { ZOOM, clampToPanel, toReal, zoomLayout, type Rect, type ZoomView } from './zoom.ts';

export type Btn = 'left' | 'right' | 'middle';

export const PENDING_LABEL: Record<Pending, string> = {
  double: 'Double click',
  triple: 'Triple click',
  middle: 'Middle click',
  drag: 'Grab',
};

export const BRAIN = {
  TICK_MS: 10,
  /** Wheel tiles need at least this long a dwell, however short the adaptive time gets. */
  WHEEL_MIN_MS: 700,
  /** Each selection on a small target moves the offset this fraction of the way to its center. */
  RECAL_GAIN: 0.2,
  RECAL_MAX_DEG: 3,
  /** Scroll mode: wheel notches per second while Left / Right is held (the phone's slider). */
  SCROLL_PER_S: 8,
  SCROLL_MIN_PER_S: 1,
  SCROLL_MAX_PER_S: 30,
  /** A press scrolls one notch at once; holding repeats after this long, like a key. */
  SCROLL_REPEAT_MS: 250,
  /**
   * px. While a button is held, real moves are split into steps no longer than this: an app needs a
   * stream of small motions to start and steer a drag (GTK abandons a drag that gets one big jump;
   * measured: steps of 50 px still drop, a single 100 px jump never does).
   */
  DRAG_STEP_PX: 12,
  /** After a zoom click the cursor stays on the clicked point until the aim moves this far. */
  PIN_RELEASE_DEG: 1.5,
  /** After a dwell selection, moving this far from it lets the same thing be selected again. */
  UNSPEND_DEG: 2,
  /** After tracking is lost this long, the OS arrow comes back (someone may want the real mouse). */
  LOST_ARROW_MS: 5000,
  /** Someone is pointing if raw input came this recently (a phone lying still sends nothing). */
  ACTIVE_MS: 30_000,
};

export interface PointerOut {
  moveTo(x: number, y: number): void;
  button(b: 'left' | 'right', down: boolean): void;
  click(b: Btn, repeat?: number): void;
  scroll(dir: 'up' | 'down'): void;
  releaseAll(): void;
}

export type BrainHooks = {
  out: PointerOut;
  /** One message for server/halo.py. */
  halo: (m: object) => void;
  /** ui, pending, pause, dwell or snap changed (the phone's button labels follow). */
  onState: () => void;
  /** Something was clicked or scrolled: the accessible targets may have moved. */
  rescan: () => void;
  /** A short note for the status pill. */
  info: (text: string) => void;
  /** Mouse on and Orion not driving. */
  live: () => boolean;
  /** The wheel items the server owns: Dictate, Orion, Keys, Snap (+ AI targets). */
  menuAction: (id: string) => void;
  /** What their labels show. */
  menuState: () => Pick<MenuState, 'ai' | 'keys' | 'wake' | 'tts' | 'orion' | 'dictate'>;
  /** A PNG (base64) of this screen region, taken with our overlay hidden; null if it failed. */
  zoomShot: (r: Rect) => Promise<string | null>;
  now?: () => number;
  /** false: no internal timer (tests call tick() themselves). */
  timer?: boolean;
};

export type HaloFrame = {
  arrow: boolean;
  cursor: Pt | null;
  style: 'halo' | 'lost' | 'scroll';
  glow: Rect | null;
  ring: { x: number; y: number; p: number; kind: 'dwell' | 'drag' } | null;
  wheel: { tiles: WheelTile[]; hover: string | null } | null;
  zoom: ZoomView | null;
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
const isTile = (t: Target | null) => !!t && t.id.startsWith('wheel:');

export class PointerBrain {
  ui: PointerUi = 'normal';
  pending: Pending | null = null;
  dragging = false;
  dwellOn = false;
  /** Off by default: zoom is the main precision tool, snapping is opt-in from the wheel. */
  snapOn = false;
  paused = false;
  zoomK = ZOOM.DEFAULT_K;
  scrollPerS = BRAIN.SCROLL_PER_S;
  readonly dwell = new Dwell();

  private readonly w: number;
  private readonly h: number;
  private readonly hooks: BrainHooks;
  private readonly now: () => number;
  private readonly motion: Motion;
  private readonly spring = new Spring();
  private readonly snapper = new Snapper();
  private targets: Target[] = [];
  private app = '';
  private offset: Pt = { x: 0, y: 0 };
  private tracking = true;
  /** now() of the last raw sample. */
  private rawAt = -Infinity;
  private lostAt = 0;
  private wasLive = false;
  /** The open wheel: where it was opened, which submenus are open, its tiles. */
  private wheel: { at: Pt; path: string[]; tiles: WheelTile[] } | null = null;
  /** The zoom panel once its snapshot is in (null while it's being taken). */
  private zoom: ZoomView | null = null;
  /** Bumped whenever zoom opens or closes, so a late snapshot for a cancelled zoom is ignored. */
  private zoomSeq = 0;
  /** After a zoom click: the cursor stays on the clicked point until the aim moves away. */
  private pin: { at: Pt; aim: Pt } | null = null;
  private scrollHeld: { btn: 'left' | 'right'; dir: 'up' | 'down'; t0: number; acc: number } | null = null;
  /** Phone buttons whose press went through to the desktop (so their release must too). */
  private phoneHeld = new Set<'left' | 'right'>();
  private last: MotionOut | null = null;
  private lastTick: number | null = null;
  private lastMoved: Pt | null = null;
  private lastFixId = 0;
  private dwellFix: { id: string; at: Pt } | null = null;
  private lastFired: Pt | null = null;
  /** After a button press, dwell waits until the aim moves UNSPEND_DEG away (it would click again). */
  private dwellHeld = false;
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

  setScrollSpeed(perS: number) {
    if (Number.isFinite(perS)) this.scrollPerS = Math.min(BRAIN.SCROLL_MAX_PER_S, Math.max(BRAIN.SCROLL_MIN_PER_S, perS));
  }

  raw(x: number, y: number) {
    if (!this.tracking) return;
    const p = { x: x + this.offset.x, y: y + this.offset.y };
    const t = this.now();
    this.rawAt = t;
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
    this.pin = null;
  }

  /** Someone is pointing right now: tracking, with input in the last ACTIVE_MS. */
  get active(): boolean {
    return this.tracking && this.now() - this.rawAt < BRAIN.ACTIVE_MS;
  }

  /** The target the pointer is snapped to (the overlay glows around it), if any. */
  get snapped(): Target | null {
    return this.snapper.current;
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
    this.hooks.info(this.dwellOn ? `◎  Dwell on: hold still ${this.dwell.ms} ms to click` : '◎  Dwell off');
    this.hooks.onState();
  }

  toggleSnap() {
    this.snapOn = !this.snapOn;
    this.snapper.clear();
    this.hooks.info(this.snapOn ? '✦  Snap to buttons on' : '✦  Snap off');
    this.hooks.onState();
  }

  togglePause() {
    const paused = !this.paused;
    this.stopActions();
    this.paused = paused;
    if (paused) this.dwell.regret(this.now());
    this.hooks.info(paused ? '⏸  Paused: point anywhere freely. Press Menu to carry on' : '▶  Resumed');
    this.hooks.onState();
  }

  /** Lets go of everything held and closes the wheel, zoom and scrolling (pause, mouse off, Orion, Stop). */
  stopActions() {
    if (this.dragging) this.hooks.out.button('left', false);
    this.dragging = false;
    this.pending = null;
    this.scrollHeld = null;
    this.wheel = null;
    this.zoom = null;
    this.zoomSeq++;
    this.pin = null;
    this.ui = 'normal';
    for (const b of this.phoneHeld) this.hooks.out.button(b, false);
    this.phoneHeld.clear();
    this.dwell.cancel();
    this.hooks.onState();
  }

  /** Stop everything (the control page's Stop): also leaves pause. */
  stop() {
    this.stopActions();
    this.paused = false;
    this.hooks.onState();
  }

  /** The phone's Left, Right and Menu buttons. */
  phoneButton(b: PhoneButton, down: boolean) {
    if (!down) {
      if (b === 'wheel') return;
      if (this.scrollHeld?.btn === b) this.scrollHeld = null;
      if (this.phoneHeld.delete(b)) this.hooks.out.button(b, false);
      return;
    }
    if (!this.hooks.live() || !this.tracking) return;
    this.holdDwell();
    if (this.paused) {
      if (b === 'wheel') this.togglePause();
      return;
    }
    if (this.ui === 'wheel') return this.wheelButton(b);
    if (this.ui === 'zoom') return this.zoomButton(b);
    if (this.ui === 'scroll') {
      if (b === 'wheel') return this.setUi('normal', '↕  Scrolling done');
      const dir = b === 'left' ? 'up' : 'down';
      this.scrollHeld = { btn: b, dir, t0: this.now(), acc: 0 };
      this.hooks.out.scroll(dir);
      this.hooks.rescan();
      return;
    }
    if (b === 'wheel') return this.openWheel();
    const tgt = this.snapper.current;
    if (b === 'right' && (this.pending || this.dragging)) return this.cancelPending();
    if (b === 'left' && this.pending) return this.select(tgt, false);
    // A plain press: held as long as the phone button is, so holding Left drags.
    this.recalibrate(tgt);
    this.phoneHeld.add(b);
    this.hooks.out.button(b, true);
    this.hooks.rescan();
  }

  /** What each phone button does right now (Orion and mouse-off are the server's, in plugin.ts). */
  labels(): { left: string; right: string; wheel: string } {
    if (this.paused) return { left: '', right: '', wheel: 'Resume' };
    if (this.ui === 'wheel') return { left: 'Select', right: this.wheel?.path.length ? 'Back' : 'Close', wheel: 'Close' };
    const left = this.dragging ? 'Drop' : this.pending ? PENDING_LABEL[this.pending] : 'Click';
    if (this.ui === 'zoom') return { left, right: 'Right click', wheel: 'Cancel zoom' };
    if (this.ui === 'scroll') return { left: '▲ Up', right: '▼ Down', wheel: 'Done' };
    return { left, right: this.dragging ? 'Drop' : this.pending ? 'Cancel' : 'Right click', wheel: 'Menu' };
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
        chip: lost ? 'tracking lost' : this.chip(),
      });
    }
    this.last = m;
    const ppd = this.pxPerDeg;

    if (m.fixId !== this.lastFixId) {
      this.lastFixId = m.fixId;
      if (m.anchor) this.dwell.settled(m.anchor, t, ppd);
    }

    const ui = this.ui;
    const zoom = ui === 'zoom' ? this.zoom : null;
    // The snapshot is being taken: show nothing (it would be in the picture), move nothing.
    if (ui === 'zoom' && !zoom) return this.send({ ...this.hiddenFrame(), arrow: false });

    // What can capture the pointer: the wheel's tiles while it's open, else the targets if Snap is on.
    const candidates = this.paused ? [] : ui === 'wheel' ? this.wheel!.tiles : ui === 'normal' && this.snapOn ? this.targets : [];
    const tgt = candidates.length ? this.snapper.pick(m.aim, candidates, ppd) : (this.snapper.clear(), null);

    if (this.pin && dist(m.aim, this.pin.aim) > BRAIN.PIN_RELEASE_DEG * ppd) this.pin = null;
    let cursor = this.spring.pos ?? m.aim;
    if (!this.paused) {
      const goal = zoom ? clampToPanel(zoom, m.aim) : this.pin ? this.pin.at : tgt ? snapPoint(m.aim, tgt) : m.aim;
      cursor = this.spring.step(goal, dtMs / 1000);
      // The real pointer: under the zoom panel it's the real point beneath the cursor; while the
      // wheel is open it stays put (a drag in progress mustn't move).
      if (ui !== 'wheel') this.moveReal(zoom ? toReal(zoom, cursor) : cursor);
    }
    // The aim, not the cursor: while paused the cursor stays put but you still have to look away.
    if (this.lastFired && dist(m.aim, this.lastFired) > BRAIN.UNSPEND_DEG * ppd) {
      this.lastFired = null;
      this.dwellHeld = false;
      this.dwell.unspend();
    }
    if (this.scrollHeld) this.scrollTick(t, dtMs);

    if (this.dwellOn && !this.paused && ui !== 'scroll') {
      let key: string | null = null;
      let need = this.dwell.ms;
      if (ui === 'wheel') {
        key = tgt?.id ?? null;
        need = Math.max(need, BRAIN.WHEEL_MIN_MS);
      } else if (tgt) key = tgt.id;
      else if (m.anchor) key = this.fixKey(m);
      if (this.dwellHeld) key = null;
      if (this.dwell.update(key, dtMs, need)) {
        this.lastFired = { ...m.aim };
        if (ui === 'wheel') this.wheelPick(tgt!.id.slice('wheel:'.length));
        else if (ui === 'zoom') this.zoomClick('left', true);
        else this.select(tgt, true);
      }
    }

    this.debugTick(t, m, tgt);
    this.send({
      arrow: this.paused,
      cursor: this.paused || tgt ? null : this.round(cursor),
      style: this.ui === 'scroll' ? 'scroll' : 'halo',
      glow: tgt && !isTile(tgt) ? { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h } : null,
      ring:
        this.dwellOn && this.dwell.progress > 0 && !this.paused
          ? { ...this.round(cursor), p: Math.round(this.dwell.progress * 100) / 100, kind: this.dragging ? 'drag' : 'dwell' }
          : null,
      wheel: this.ui === 'wheel' && this.wheel ? { tiles: this.wheel.tiles, hover: isTile(tgt) ? tgt!.id : null } : null,
      zoom: this.ui === 'zoom' ? this.zoom : null,
      chip: this.chip(),
      scroll: this.scrollHeld?.dir ?? null,
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

  // ---------------------------------------------------------------- clicks

  /** A selection: dwell, or Left while a click type is pending. */
  private select(tgt: Target | null, byDwell: boolean) {
    const at = this.spring.pos ?? this.last?.aim;
    if (!at) return;
    this.recalibrate(tgt);
    this.clickNow('left');
    if (byDwell) this.dwell.selected(at, this.now(), this.pxPerDeg);
  }

  /** One click where the real pointer is: the pending click type for Left (then it's used up). */
  private clickNow(b: 'left' | 'right') {
    const out = this.hooks.out;
    const p = b === 'left' ? this.pending : null;
    if (b === 'right') out.click('right');
    else if (p === 'drag') {
      this.dragging = !this.dragging;
      out.button('left', this.dragging);
      this.hooks.info(this.dragging ? '✊  Dragging: press Left to drop' : '✋  Dropped');
    } else if (p === 'double') out.click('left', 2);
    else if (p === 'triple') out.click('left', 3);
    else if (p === 'middle') out.click('middle');
    else out.click('left');
    if (p) {
      if (!this.dragging) this.pending = null;
      this.hooks.onState();
    }
    this.hooks.rescan();
  }

  private setPending(p: Pending) {
    this.pending = p;
    this.hooks.info(`🖱  Next click: ${PENDING_LABEL[p].toLowerCase()}${p === 'drag' ? ' (Left grabs, Left again drops)' : ''}`);
    this.hooks.onState();
  }

  /** Right while a click type is pending: forget it (and drop anything being dragged). */
  private cancelPending() {
    if (this.dragging) this.hooks.out.button('left', false);
    this.hooks.info(this.dragging ? '✋  Dropped' : '🖱  Cancelled');
    this.dragging = false;
    this.pending = null;
    this.hooks.onState();
  }

  private scrollTick(t: number, dtMs: number) {
    const s = this.scrollHeld!;
    if (t - s.t0 < BRAIN.SCROLL_REPEAT_MS) return;
    s.acc += (this.scrollPerS * dtMs) / 1000;
    if (s.acc >= 1) this.hooks.rescan();
    for (; s.acc >= 1; s.acc--) this.hooks.out.scroll(s.dir);
  }

  // ---------------------------------------------------------------- the wheel

  private setUi(ui: PointerUi, note?: string) {
    this.ui = ui;
    this.snapper.clear();
    this.dwell.cancel();
    if (note) this.hooks.info(note);
    this.hooks.onState();
  }

  private menuState(): MenuState {
    return { dwell: this.dwellOn, snap: this.snapOn, zoomK: this.zoomK, ...this.hooks.menuState() };
  }

  private openWheel() {
    const at = this.spring.pos ?? this.last?.aim;
    if (!at) return;
    this.wheel = { at: this.round(at), path: [], tiles: [] };
    this.layoutWheel();
    this.setUi('wheel');
  }

  private layoutWheel() {
    const wh = this.wheel!;
    const items = menuAt(buildMenu(this.menuState()), wh.path) ?? [];
    wh.tiles = wheelLayout(wh.at, items, wh.path.length ? 'Back' : 'Close', this.w, this.h).tiles;
  }

  private closeWheel() {
    this.wheel = null;
    this.setUi('normal');
  }

  private wheelButton(b: PhoneButton) {
    if (b === 'wheel') return this.closeWheel();
    if (b === 'right') return this.wheelPick('back');
    const tgt = this.snapper.current;
    if (isTile(tgt)) this.wheelPick(tgt!.id.slice('wheel:'.length));
  }

  private wheelPick(id: string) {
    const wh = this.wheel;
    if (!wh) return;
    if (id === 'back') {
      if (!wh.path.length) return this.closeWheel();
      wh.path.pop();
      this.layoutWheel();
      return this.setUi('wheel');
    }
    const item = (menuAt(buildMenu(this.menuState()), wh.path) ?? []).find((i) => i.id === id);
    if (!item) return;
    if (item.sub) {
      wh.path.push(id);
      this.layoutWheel();
      return this.setUi('wheel');
    }
    const at = wh.at;
    this.closeWheel();
    this.menuAction(id, at);
  }

  private menuAction(id: string, at: Pt) {
    switch (id) {
      case 'zoom':
        return void this.openZoom(at);
      case 'scroll':
        return this.setUi('scroll', '↕  Scrolling: Left scrolls up, Right down. Menu when done');
      case 'double':
      case 'triple':
      case 'middle':
      case 'drag':
        return this.setPending(id);
      case 'pause':
        return this.togglePause();
      case 'dwell':
        return this.toggleDwell();
      case 'zoomk': {
        const levels = ZOOM.LEVELS;
        this.zoomK = levels[(levels.indexOf(this.zoomK) + 1) % levels.length];
        this.hooks.info(`🔍  Zoom ${this.zoomK}×`);
        return this.hooks.onState();
      }
      default:
        return this.hooks.menuAction(id); // dictate, orion, keys, wake, tts, snap
    }
  }

  // ---------------------------------------------------------------- zoom-click

  private async openZoom(at: Pt) {
    const view = zoomLayout(at, this.zoomK, this.w, this.h);
    const seq = ++this.zoomSeq;
    this.zoom = null;
    this.setUi('zoom');
    // Clear the overlay now: the snapshot mustn't have the wheel or the halo in it.
    this.send({ ...this.hiddenFrame(), arrow: false });
    const png = await this.hooks.zoomShot(view.from).catch(() => null);
    if (seq !== this.zoomSeq || this.ui !== 'zoom') return; // cancelled meanwhile
    if (!png) return this.setUi('normal', '🔍  Zoom failed: no screenshot');
    this.hooks.halo({ zoomImage: png });
    this.zoom = view;
    this.hooks.onState();
  }

  private closeZoom(note?: string) {
    this.zoom = null;
    this.zoomSeq++;
    this.setUi('normal', note);
  }

  private zoomButton(b: PhoneButton) {
    if (b === 'wheel') return this.closeZoom('🔍  Zoom cancelled');
    if (this.zoom) this.zoomClick(b, false);
  }

  /** A click at the real point under the cursor; the panel closes and the cursor waits there. */
  private zoomClick(b: 'left' | 'right', byDwell: boolean) {
    const z = this.zoom;
    const cur = this.spring.pos;
    if (!z || !cur) return;
    const real = toReal(z, cur);
    this.moveReal(real, true);
    this.clickNow(b);
    if (byDwell) this.dwell.selected(real, this.now(), this.pxPerDeg);
    this.closeZoom();
    this.spring.jump(real);
    this.pin = { at: real, aim: { ...(this.last?.aim ?? cur) } };
  }

  // ---------------------------------------------------------------- helpers

  /** A button was pressed: dwell mustn't select the same spot again (a second click, or the drop right after a grab). */
  private holdDwell() {
    const at = this.last?.aim ?? this.spring.pos;
    if (!at) return;
    this.dwell.cancel();
    this.dwellHeld = true;
    this.lastFired = { ...at };
  }

  private moveReal(p: Pt, force = false) {
    const q = { x: Math.min(this.w - 1, Math.max(0, r1(p.x))), y: Math.min(this.h - 1, Math.max(0, r1(p.y))) };
    const from = this.lastMoved;
    if (!force && from && q.x === from.x && q.y === from.y) return;
    if (from && (this.dragging || this.phoneHeld.size)) {
      const n = Math.ceil(dist(from, q) / BRAIN.DRAG_STEP_PX);
      for (let i = 1; i < n; i++) this.hooks.out.moveTo(r1(from.x + ((q.x - from.x) * i) / n), r1(from.y + ((q.y - from.y) * i) / n));
    }
    this.lastMoved = q;
    this.hooks.out.moveTo(q.x, q.y);
  }

  /**
   * Implicit recalibration: a selection on a small target is taken as ground truth for where the
   * user was pointing, and the offset is nudged toward it, so drift gets corrected without
   * re-centering. Only for small targets: on a big one, any point inside is plausible.
   */
  private recalibrate(tgt: Target | null) {
    const m = this.last;
    // AI-found boxes (server/vision-targets.ts) are approximate: they mustn't teach the offset.
    if (!tgt || isTile(tgt) || tgt.id.startsWith('ai:') || !m) return;
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

  /** A reminder under the pointer of what the buttons do now. */
  private chip(): string | null {
    if (this.paused) return 'Paused · Menu resumes';
    if (this.ui === 'scroll') return 'Scroll · Left = up · Right = down · Menu: done';
    if (this.ui !== 'normal') return null;
    if (this.dragging) return 'Dragging · Left drops';
    if (this.pending) return `Next: ${PENDING_LABEL[this.pending].toLowerCase()} · Right cancels`;
    return null;
  }

  private hiddenFrame(): HaloFrame {
    return { arrow: true, cursor: null, style: 'halo', glow: null, ring: null, wheel: null, zoom: null, chip: null, scroll: null };
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
