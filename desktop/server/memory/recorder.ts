// The recorder: a screenshot every INTERVAL_S (and one shortly after each click), kept only when the
// screen changed or the focused window did. Kept frames are captioned + embedded in the background,
// so a slow API call never delays a capture. Ported from screen-memory/src/capture.ts.
//
// Off until switched on (control page, or MEMORY=1): kept frames go to Anthropic for captioning.
// Private windows (PRIVATE_TITLES) are never saved, and data/memory/PAUSE pauses it.

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { processFrame } from './caption.ts';
import { DATA_DIR, DIFF_THRESHOLD, INTERVAL_S, OLLAMA_URL, EMBED_MODEL, PAUSE_FILE, PRIVATE_TITLES, localTime } from './config.ts';
import { type EventKind, Store } from './db.ts';
import { Memory } from './memory.ts';
import { activeWindow, grab, pointerMask, thumbDiff } from './screen.ts';

/** A click usually changes the screen: look again this long after one... */
const CLICK_DELAY_MS = 1200;
/** ...but not more often than this. */
const CLICK_MIN_GAP_MS = 3000;
/** px around the pointer that the halo and dwell ring may cover, ignored when comparing screens. */
const POINTER_MASK_PX = 70;
/** Captions waiting beyond this stay `pending` (npm run memory:caption picks them up later). */
const MAX_QUEUE = 20;

export type MemoryState = 'unavailable' | 'off' | 'paused' | 'recording';
export type MemoryStatus = {
  state: MemoryState;
  /** Why it can't record, or the last error. */
  note: string | null;
  kept: number;
  same: number;
  skipped: number;
  captioned: number;
  failed: number;
  queued: number;
  costUsd: number;
  /** Frames in the database (all sessions). */
  total: number;
};

export type MemoryHooks = {
  /** Where the pointer is (screen px), for the caption and the change mask. */
  pointer: () => { x: number; y: number } | null;
  /** Our own UI covers the screen (the wheel, the zoom panel): skip this look. */
  busy: () => boolean;
};

// Vite re-runs the plugin when a server file changes: stop the old run's recorder.
const g = globalThis as { __gymoteMemory?: ScreenMemory };

export class ScreenMemory {
  enabled = false;
  readonly store: Store;
  /** The read side, for Orion's memory tools. */
  readonly memory: Memory;
  private stats = { kept: 0, same: 0, skipped: 0, captioned: 0, failed: 0, costUsd: 0 };
  private note: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clickTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = 0;
  private ticking = false;
  private queue: number[] = [];
  private draining: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private size: [number, number],
    private hooks: MemoryHooks,
    private opts: { hasClaude: boolean; session: string },
  ) {
    g.__gymoteMemory?.dispose();
    g.__gymoteMemory = this;
    this.store = new Store();
    this.memory = new Memory(this.store);
  }

  /** Why it can't record at all, or null. */
  get missing(): string | null {
    if (!this.opts.hasClaude) return 'needs ANTHROPIC_API_KEY in .env';
    if (this.opts.session !== 'x11') return 'needs an X11 session';
    if (!this.size[0]) return 'no screen size (xdotool)';
    return null;
  }

  /** Whether there is anything to remember (Orion gets the memory tools then). */
  get hasFrames(): boolean {
    return !!this.store.last();
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on && this.missing) return void (this.note = this.missing);
    this.enabled = on;
    this.note = null;
    if (on) {
      this.note = await ollamaProblem();
      this.schedule(0);
      console.log(`[memory] recording every ${INTERVAL_S}s → ${DATA_DIR}${this.note ? ` (${this.note})` : ''}`);
    } else {
      this.cancelTimers();
      console.log('[memory] recording off');
    }
  }

  /** Something the person did. Only logged while recording, like the screen itself. */
  event(kind: EventKind, e: { x?: number | null; y?: number | null; text?: string } = {}) {
    if (!this.recording) return;
    this.store.event({ ts: Date.now(), kind, ...e });
    if (kind === 'click') this.afterClick();
  }

  status(): MemoryStatus {
    const s = this.stats;
    return {
      state: this.missing ? 'unavailable' : !this.enabled ? 'off' : existsSync(PAUSE_FILE) ? 'paused' : 'recording',
      note: this.missing ?? this.note,
      kept: s.kept,
      same: s.same,
      skipped: s.skipped,
      captioned: s.captioned,
      failed: s.failed,
      queued: this.queue.length,
      costUsd: s.costUsd,
      total: (this.store.db.prepare('select count(*) as n from frames').get() as { n: number }).n,
    };
  }

  dispose() {
    this.disposed = true;
    this.enabled = false;
    this.cancelTimers();
    this.queue = [];
  }

  private get recording(): boolean {
    return this.enabled && !this.disposed && !existsSync(PAUSE_FILE);
  }

  private cancelTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.timer = this.clickTimer = null;
  }

  /** Ticks land on a fixed grid so they don't drift; a slow tick skips missed slots instead of bursting. */
  private schedule(delay = INTERVAL_S * 1000 - (Date.now() % (INTERVAL_S * 1000))) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.look();
      if (this.enabled && !this.disposed) this.schedule();
    }, delay);
  }

  private afterClick() {
    if (this.clickTimer) return;
    const wait = Math.max(CLICK_DELAY_MS, this.lastTick + CLICK_MIN_GAP_MS - Date.now());
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      void this.look();
    }, wait);
  }

  private async look() {
    if (this.ticking || !this.recording) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (e) {
      this.note = `capture failed: ${(e as Error).message.slice(0, 120)}`;
      console.warn(`[memory] ${this.note}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tick() {
    const now = Date.now();
    this.lastTick = now;
    if (this.hooks.busy()) return void this.stats.skipped++;
    const win = await activeWindow();
    if (PRIVATE_TITLES.test(win.title)) return void this.stats.skipped++;

    const day = localTime(now).slice(0, 10);
    const rel = `shots/${day}/${localTime(now).slice(11).replaceAll(':', '')}-${now % 1000}.jpg`;
    mkdirSync(`${DATA_DIR}/shots/${day}`, { recursive: true });
    const p = this.hooks.pointer();
    const thumb = await grab(`${DATA_DIR}/${rel}`, this.size);

    const prev = this.store.last();
    // The halo is drawn around the pointer in both thumbnails: neither spot counts.
    const mask = pointerMask(p, POINTER_MASK_PX, this.size);
    if (prev?.px != null && prev.py != null) for (const i of pointerMask({ x: prev.px, y: prev.py }, POINTER_MASK_PX, this.size)) mask.add(i);
    const diff = prev ? thumbDiff(thumb, prev.thumb, mask) : Infinity;
    if (prev && diff < DIFF_THRESHOLD && win.title === prev.win_title) {
      unlinkSync(`${DATA_DIR}/${rel}`);
      this.store.touch(prev.id, now);
      this.stats.same++;
      return;
    }

    const id = this.store.insert({ ts: now, path: rel, win_title: win.title, win_class: win.cls, px: p?.x ?? null, py: p?.y ?? null, thumb });
    this.stats.kept++;
    console.log(`[memory] kept #${id} (diff ${Number.isFinite(diff) ? diff.toFixed(1) : 'first'}) ${win.cls || '?'}: ${win.title}`);
    if (this.queue.length < MAX_QUEUE) this.enqueue(id);
  }

  /** Background caption queue, one at a time. */
  private enqueue(id: number) {
    this.queue.push(id);
    this.draining ??= (async () => {
      for (let id; (id = this.queue.shift()) !== undefined; ) {
        const r = await processFrame(this.store, id);
        if (this.disposed) break;
        if ('error' in r) {
          this.stats.failed++;
          this.note = `caption failed: ${r.error.slice(0, 120)}`;
          console.warn(`[memory] #${id} ${this.note}`);
        } else {
          this.stats.captioned++;
          this.stats.costUsd += r.cost;
          this.note = null;
          console.log(`[memory] #${id} ${r.caption.app}: ${r.caption.activity}  (${(r.ms / 1000).toFixed(1)}s, $${r.cost.toFixed(5)})`);
        }
      }
      this.draining = null;
    })();
  }
}

/** Captions are embedded with Ollama; say so up front if it isn't there instead of failing every frame. */
async function ollamaProblem(): Promise<string | null> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const { models } = (await r.json()) as { models: { name: string }[] };
    if (!models.some((m) => m.name.split(':')[0] === EMBED_MODEL.split(':')[0])) return `run: ollama pull ${EMBED_MODEL}`;
    return null;
  } catch {
    return `Ollama not running at ${OLLAMA_URL} (captions will fail)`;
  }
}
