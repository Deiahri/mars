// The read side of screen memory: search(), timeline(), usage(), getFrame(), image(). Mars's agent
// reaches these through server/memory/tools.ts. Ported from screen-memory/src/memory.ts; the search
// itself now runs in Tiger (server/memory/db.ts `hybrid`).

import { readFileSync } from 'node:fs';
import { DATA_DIR, localTime } from './config.ts';
import { type Frame, type MemEvent, Store, type Usage } from './db.ts';
import { embedOne } from './embed.ts';
import { crop, screenSize } from './screen.ts';

export type Hit = {
  id: number;
  from: string;
  to: string;
  window: string;
  app: string;
  activity: string;
  pointer_on?: string;
  key_text: string[];
  score: number;
};

/** Something the person did, in timelines and search results. */
export type Did = { at: string; did: string };

export type SearchOpts = { k?: number; since?: number; until?: number; app?: string };

export function words(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^\p{L}\p{N}_.\-/]+/u).filter((w) => w.length >= 3))];
}

export function summarize(f: Frame, score = 0): Hit {
  return {
    id: f.id,
    from: localTime(f.ts),
    to: localTime(f.last_seen),
    window: f.win_title,
    app: f.caption?.app ?? f.win_class,
    activity: f.caption?.activity ?? (f.status === 'pending' ? '(not captioned yet)' : `(caption failed: ${f.error})`),
    ...(f.caption?.pointer_on ? { pointer_on: f.caption.pointer_on } : {}),
    key_text: f.caption?.key_text ?? [],
    score: Math.round(score * 10000) / 10000,
  };
}

export function describeEvent(e: MemEvent): Did {
  const did =
    e.kind === 'click' ? `clicked at (${e.x}, ${e.y})${e.text ? ` (${e.text})` : ''}` : e.kind === 'dictation' ? `dictated "${e.text}"` : `Mars: ${e.text}`;
  return { at: localTime(e.ts), did };
}

export class Memory {
  store: Store;

  constructor(store = new Store()) {
    this.store = store;
  }

  async search(query: string, opts: SearchOpts = {}): Promise<{ frames: Hit[]; did: Did[] }> {
    const q = await embedOne(query, 'query');
    const ranked = await this.store.hybrid(query, q, { since: opts.since, until: opts.until, app: opts.app, k: opts.k ?? 8 });
    const frames = (await Promise.all(ranked.map(async (r) => [await this.store.get(r.id), r.score] as const)))
      .filter((x): x is readonly [Frame, number] => !!x[0])
      .map(([f, score]) => summarize(f, score));
    // What was said (dictation, Mars commands) is matched by keyword only; it's short and exact.
    const did = (await this.store.findEvents(words(query), opts.since ?? 0, opts.until ?? Date.now() + 1000, 5)).map(describeEvent);
    return { frames, did };
  }

  /** What was on screen between two times, oldest first, evenly thinned to at most `limit` frames, plus what the person did. */
  async timeline(since: number, until: number, limit = 40): Promise<{ frames: Hit[]; total: number; did: Did[] }> {
    const all = await this.store.range(since, until);
    const step = Math.max(1, all.length / limit);
    const picked: Frame[] = [];
    for (let i = 0; i < all.length && picked.length < limit; i += step) picked.push(all[Math.floor(i)]);
    const events = await this.store.events(since, until);
    // Clicks can be many; keep the most recent ones.
    const clicks = new Set(events.filter((e) => e.kind === 'click').slice(-60));
    const did = events.filter((e) => e.kind !== 'click' || clicks.has(e)).map(describeEvent);
    return { frames: picked.map((f) => summarize(f)), total: all.length, did };
  }

  /** Screen time per app and actions per hour (Tiger continuous aggregates). */
  usage(since: number, until: number): Promise<Usage> {
    return this.store.usage(since, until);
  }

  getFrame(id: number): Promise<Frame | undefined> {
    return this.store.get(id);
  }

  /** The stored screenshot, or a region of it ([x0, y0, x1, y1] in its pixels), enlarged to screen size. */
  async image(id: number, region?: number[]): Promise<{ data: Buffer; media_type: 'image/jpeg' | 'image/png' }> {
    const f = await this.store.get(id);
    if (!f) throw new Error(`no frame ${id}`);
    const path = `${DATA_DIR}/${f.path}`;
    if (!region) return { data: readFileSync(path), media_type: 'image/jpeg' };
    return { data: await crop(path, region, await screenSize()), media_type: 'image/png' };
  }
}
