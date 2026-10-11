// The read side of screen memory: search(), timeline(), getFrame(), image(). Orion's agent reaches
// these through server/memory/tools.ts. Ported from screen-memory/src/memory.ts.
//
// Search is brute-force cosine over every embedding (cached in memory; 50k × 768 floats is a few
// ms) plus a keyword boost, since node:sqlite has no FTS5 and exact strings like filenames or
// error codes are what people often search for.

import { readFileSync } from 'node:fs';
import { DATA_DIR, localTime } from './config.ts';
import { type Frame, type MemEvent, Store } from './db.ts';
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

const KEYWORD_WEIGHT = 0.15;

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
    score: Math.round(score * 1000) / 1000,
  };
}

export function describeEvent(e: MemEvent): Did {
  const did =
    e.kind === 'click' ? `clicked at (${e.x}, ${e.y})${e.text ? ` (${e.text})` : ''}` : e.kind === 'dictation' ? `dictated "${e.text}"` : `Orion: ${e.text}`;
  return { at: localTime(e.ts), did };
}

type Entry = { vec: Float32Array; text: string; ts: number; last_seen: number; who: string };

export class Memory {
  store: Store;
  private cache = new Map<number, Entry>();

  constructor(store = new Store()) {
    this.store = store;
  }

  /** Pull in rows captioned since the last call (including backfilled old ones). */
  private refresh(): void {
    for (const id of this.store.doneIds()) {
      if (this.cache.has(id)) continue;
      const f = this.store.get(id);
      const vec = this.store.embedding(id);
      if (!f || !vec) continue;
      this.cache.set(id, {
        vec,
        text: (f.text ?? '').toLowerCase(),
        ts: f.ts,
        last_seen: f.last_seen,
        who: `${f.win_title} ${f.win_class} ${f.caption?.app ?? ''}`.toLowerCase(),
      });
    }
  }

  async search(query: string, opts: SearchOpts = {}): Promise<{ frames: Hit[]; did: Did[] }> {
    this.refresh();
    const q = await embedOne(query, 'query');
    const terms = words(query);
    const since = opts.since ?? -Infinity;
    const until = opts.until ?? Infinity;
    const app = opts.app?.toLowerCase();

    const scored: { id: number; score: number }[] = [];
    for (const [id, e] of this.cache) {
      if (e.last_seen < since || e.ts > until) continue;
      if (app && !e.who.includes(app)) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * e.vec[i];
      const kw = terms.length ? terms.filter((t) => e.text.includes(t)).length / terms.length : 0;
      scored.push({ id, score: dot + KEYWORD_WEIGHT * kw });
    }
    scored.sort((a, b) => b.score - a.score);
    const frames = scored.slice(0, opts.k ?? 8).map((s) => summarize(this.store.get(s.id)!, s.score));
    // What was said (dictation, Orion commands) is matched by keyword only; it's short and exact.
    const did = this.store
      .findEvents(terms, Number.isFinite(since) ? since : 0, Number.isFinite(until) ? until : Date.now() + 1, 5)
      .map(describeEvent);
    return { frames, did };
  }

  /** What was on screen between two times, oldest first, evenly thinned to at most `limit` frames, plus what the person did. */
  timeline(since: number, until: number, limit = 40): { frames: Hit[]; total: number; did: Did[] } {
    const all = this.store.range(since, until);
    const step = Math.max(1, all.length / limit);
    const picked: Frame[] = [];
    for (let i = 0; i < all.length && picked.length < limit; i += step) picked.push(all[Math.floor(i)]);
    const events = this.store.events(since, until);
    // Clicks can be many; keep the most recent ones.
    const clicks = new Set(events.filter((e) => e.kind === 'click').slice(-60));
    const did = events.filter((e) => e.kind !== 'click' || clicks.has(e)).map(describeEvent);
    return { frames: picked.map((f) => summarize(f)), total: all.length, did };
  }

  getFrame(id: number): Frame | undefined {
    return this.store.get(id);
  }

  /** The stored screenshot, or a region of it ([x0, y0, x1, y1] in its pixels), enlarged to screen size. */
  async image(id: number, region?: number[]): Promise<{ data: Buffer; media_type: 'image/jpeg' | 'image/png' }> {
    const f = this.store.get(id);
    if (!f) throw new Error(`no frame ${id}`);
    const path = `${DATA_DIR}/${f.path}`;
    if (!region) return { data: readFileSync(path), media_type: 'image/jpeg' };
    return { data: await crop(path, region, await screenSize()), media_type: 'image/png' };
  }
}
