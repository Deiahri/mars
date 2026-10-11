// Kept frames, plus a small log of what the person did (clicks, dictation, Orion commands).
// node:sqlite (built in, no FTS5) in WAL mode, so `npm run memory:ask` can read while the dev
// server writes. Ported from screen-memory/src/db.ts.

import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.ts';

export type Caption = {
  app: string;
  activity: string;
  details: string;
  /** What the pointer was on when the screenshot was taken. */
  pointer_on: string;
  key_text: string[];
  tags: string[];
};

export type Frame = {
  id: number;
  /** ms epoch when this screen first appeared. */
  ts: number;
  /** ms epoch of the last capture that looked the same. */
  last_seen: number;
  /** Relative to DATA_DIR. */
  path: string;
  win_title: string;
  win_class: string;
  /** Pointer position when captured (screen px), if known. */
  px: number | null;
  py: number | null;
  status: 'pending' | 'done' | 'error';
  caption: Caption | null;
  text: string | null;
  error: string | null;
};

export type EventKind = 'click' | 'dictation' | 'orion';
export type MemEvent = { id: number; ts: number; kind: EventKind; x: number | null; y: number | null; text: string };

type Row = Omit<Frame, 'caption'> & { caption_json: string | null };

const COLS = 'id, ts, last_seen, path, win_title, win_class, px, py, status, caption_json, text, error';

function toFrame(r: Row): Frame {
  const { caption_json, ...rest } = r;
  return { ...rest, caption: caption_json ? (JSON.parse(caption_json) as Caption) : null };
}

export class Store {
  db: DatabaseSync;

  constructor(path = DB_PATH) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma busy_timeout = 5000;
      create table if not exists frames (
        id integer primary key,
        ts integer not null,
        last_seen integer not null,
        path text not null,
        win_title text not null default '',
        win_class text not null default '',
        px integer,
        py integer,
        thumb blob,
        status text not null default 'pending',
        caption_json text,
        text text,
        embedding blob,
        error text,
        in_tokens integer,
        out_tokens integer
      );
      create index if not exists frames_ts on frames(ts);
      create table if not exists events (
        id integer primary key,
        ts integer not null,
        kind text not null,
        x integer,
        y integer,
        text text not null default ''
      );
      create index if not exists events_ts on events(ts);
    `);
  }

  insert(f: { ts: number; path: string; win_title: string; win_class: string; px: number | null; py: number | null; thumb: Uint8Array }): number {
    const r = this.db
      .prepare('insert into frames (ts, last_seen, path, win_title, win_class, px, py, thumb) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.ts, f.ts, f.path, f.win_title, f.win_class, f.px, f.py, f.thumb);
    return Number(r.lastInsertRowid);
  }

  touch(id: number, ts: number): void {
    this.db.prepare('update frames set last_seen = ? where id = ?').run(ts, id);
  }

  /** The newest frame's change-gate data; px/py is where the pointer (and its halo) was in that thumbnail. */
  last(): { id: number; win_title: string; thumb: Uint8Array; px: number | null; py: number | null } | undefined {
    return this.db.prepare('select id, win_title, thumb, px, py from frames order by id desc limit 1').get() as
      | { id: number; win_title: string; thumb: Uint8Array; px: number | null; py: number | null }
      | undefined;
  }

  done(id: number, caption: Caption, text: string, embedding: Float32Array, usage: { input: number; output: number }): void {
    this.db
      .prepare("update frames set status = 'done', caption_json = ?, text = ?, embedding = ?, error = null, in_tokens = ?, out_tokens = ? where id = ?")
      .run(JSON.stringify(caption), text, new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength), usage.input, usage.output, id);
  }

  fail(id: number, message: string): void {
    this.db.prepare("update frames set status = 'error', error = ? where id = ?").run(message, id);
  }

  get(id: number): Frame | undefined {
    const r = this.db.prepare(`select ${COLS} from frames where id = ?`).get(id) as Row | undefined;
    return r && toFrame(r);
  }

  /** Frames overlapping [since, until], oldest first. */
  range(since: number, until: number): Frame[] {
    const rows = this.db.prepare(`select ${COLS} from frames where last_seen >= ? and ts <= ? order by ts`).all(since, until) as Row[];
    return rows.map(toFrame);
  }

  todo(): number[] {
    return (this.db.prepare("select id from frames where status in ('pending', 'error') order by id").all() as { id: number }[]).map((r) => r.id);
  }

  doneIds(): number[] {
    return (this.db.prepare("select id from frames where status = 'done'").all() as { id: number }[]).map((r) => r.id);
  }

  embedding(id: number): Float32Array | undefined {
    const r = this.db.prepare('select embedding from frames where id = ?').get(id) as { embedding: Uint8Array | null } | undefined;
    if (!r?.embedding) return undefined;
    const b = r.embedding;
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }

  event(e: { ts: number; kind: EventKind; x?: number | null; y?: number | null; text?: string }): void {
    this.db.prepare('insert into events (ts, kind, x, y, text) values (?, ?, ?, ?, ?)').run(e.ts, e.kind, e.x ?? null, e.y ?? null, e.text ?? '');
  }

  /** Events in [since, until], oldest first. */
  events(since: number, until: number): MemEvent[] {
    return this.db.prepare('select id, ts, kind, x, y, text from events where ts >= ? and ts <= ? order by ts').all(since, until) as MemEvent[];
  }

  /** Text events (dictation, Orion) whose text contains any of `terms`, newest first. */
  findEvents(terms: string[], since: number, until: number, limit: number): MemEvent[] {
    if (!terms.length) return [];
    const like = terms.map(() => 'lower(text) like ?').join(' or ');
    return this.db
      .prepare(`select id, ts, kind, x, y, text from events where kind != 'click' and ts >= ? and ts <= ? and (${like}) order by ts desc limit ?`)
      .all(since, until, ...terms.map((t) => `%${t}%`), limit) as MemEvent[];
  }
}
