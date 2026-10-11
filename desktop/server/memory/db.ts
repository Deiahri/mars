// Screen memory's database, on Tiger Data (Tiger Cloud: Postgres + TimescaleDB + pgvector + BM25).
// Screenshots stay on local disk; only their path, captions, embeddings and the action log go here.
//
// - frames, events: hypertables on time (memory is a time series: what was on screen when).
// - frames.embedding: pgvector, HNSW cosine index. frames.text: BM25 (pg_textsearch), or Postgres'
//   built-in full-text search where pg_textsearch isn't available. Search fuses both in one query.
// - activity_15m, events_15m: continuous aggregates (screen time per app, actions per 15 minutes)
//   for "how long was I on …" questions.
//
// Times go in and out as ms epochs, like the rest of the code.

import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import pg from 'pg';
import { TIGER_URL } from './config.ts';

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
export type Usage = {
  by_app: { app: string; minutes: number; screens: number }[];
  by_hour: { hour: number; clicks: number; dictations: number; orion: number }[];
};

/** Embedding size: embeddinggemma and nomic-embed-text are both 768. */
const DIMS = 768;
/** Reciprocal rank fusion constant: score = Σ 1 / (RRF_K + rank). */
const RRF_K = 60;
/** Candidates each ranking contributes before fusing. */
const POOL = 50;

/**
 * A new Tiger Cloud service first presents a certificate from Tiger's own CA (ca.timescale.com),
 * which Node doesn't trust; later it switches to a public one (Google Trust Services). psql's
 * sslmode=require doesn't check the CA at all. We trust the usual public roots plus Tiger's CA, so
 * the connection is verified either way. (Tiger's CA was saved from a server's chain; valid until Apr 2027.)
 */
function poolConfig(url: string): pg.PoolConfig {
  const u = new URL(url);
  if (!u.hostname.endsWith('.tsdb.cloud.timescale.com')) return { connectionString: url };
  // node-postgres lets sslmode in the URL override the ssl option, so it goes.
  u.searchParams.delete('sslmode');
  const ca = [...rootCertificates, readFileSync(new URL('./tiger-ca.pem', import.meta.url), 'utf8')];
  return { connectionString: u.toString(), ssl: { ca, servername: u.hostname } };
}

const ms = (col: string) => `(extract(epoch from ${col}) * 1000)::float8`;
const vec = (v: Float32Array) => `[${Array.from(v).join(',')}]`;

export class Store {
  private pool: pg.Pool | null;
  private s: string;
  /** Resolves once the schema exists. */
  readonly ready: Promise<void>;
  /** Which keyword search the database has. */
  keyword: 'bm25' | 'fts' = 'fts';

  constructor(url = TIGER_URL, schema = 'screen_memory') {
    this.s = schema;
    this.pool = url ? new pg.Pool({ ...poolConfig(url), max: 4, idleTimeoutMillis: 30_000 }) : null;
    this.pool?.on('error', (e) => console.warn('[memory] database:', e.message));
    this.ready = this.pool ? this.ensureSchema() : Promise.reject(new Error('needs TIGER_DATABASE_URL in .env'));
    this.ready.catch(() => {}); // callers see the error when they await
  }

  private get cols(): string {
    return `id::int as id, ${ms('ts')} as ts, ${ms('last_seen')} as last_seen, path, win_title, win_class, px, py, status, caption, text, error`;
  }

  private async q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
    await this.ready;
    return (await this.pool!.query(sql, args)).rows as T[];
  }

  private async ensureSchema(): Promise<void> {
    const S = this.s;
    const run = (sql: string) => this.pool!.query(sql);
    await run('create extension if not exists timescaledb');
    await run('create extension if not exists vector');
    try {
      await run('create extension if not exists pg_textsearch');
      this.keyword = 'bm25';
    } catch {
      this.keyword = 'fts';
    }
    await run(`create schema if not exists ${S}`);
    await run(`
      create table if not exists ${S}.frames (
        id bigint generated always as identity,
        ts timestamptz not null,
        last_seen timestamptz not null,
        path text not null,
        win_title text not null default '',
        win_class text not null default '',
        px integer,
        py integer,
        thumb bytea,
        status text not null default 'pending',
        caption jsonb,
        text text,
        embedding vector(${DIMS}),
        error text,
        in_tokens integer,
        out_tokens integer,
        primary key (id, ts)
      )`);
    await run(`select create_hypertable('${S}.frames', by_range('ts', interval '1 day'), if_not_exists => true)`);
    await run(`create index if not exists frames_id on ${S}.frames (id)`);
    await run(`create index if not exists frames_embedding on ${S}.frames using hnsw (embedding vector_cosine_ops)`);
    if (this.keyword === 'bm25') {
      try {
        await run(`create index if not exists frames_bm25 on ${S}.frames using bm25 (text) with (text_config = 'english')`);
      } catch (e) {
        console.warn('[memory] BM25 index failed, using built-in full-text search:', (e as Error).message);
        this.keyword = 'fts';
      }
    }
    if (this.keyword === 'fts') await run(`create index if not exists frames_fts on ${S}.frames using gin (to_tsvector('english', coalesce(text, '')))`);

    await run(`
      create table if not exists ${S}.events (
        id bigint generated always as identity,
        ts timestamptz not null,
        kind text not null,
        x integer,
        y integer,
        text text not null default ''
      )`);
    await run(`select create_hypertable('${S}.events', by_range('ts', interval '1 day'), if_not_exists => true)`);

    // Screen time per app and actions per 15 minutes, kept up to date by TimescaleDB. Real-time
    // (materialized_only = false), so the newest minutes are included too.
    await run(`
      create materialized view if not exists ${S}.activity_15m
      with (timescaledb.continuous, timescaledb.materialized_only = false) as
      select time_bucket('15 minutes', ts) as bucket,
             coalesce(nullif(caption->>'app', ''), nullif(win_class, ''), 'unknown') as app,
             count(*) as screens,
             sum(extract(epoch from (last_seen - ts))) as seconds
      from ${S}.frames group by 1, 2 with no data`);
    await run(`
      create materialized view if not exists ${S}.events_15m
      with (timescaledb.continuous, timescaledb.materialized_only = false) as
      select time_bucket('15 minutes', ts) as bucket, kind, count(*) as n
      from ${S}.events group by 1, 2 with no data`);
    for (const view of ['activity_15m', 'events_15m']) {
      await run(
        `select add_continuous_aggregate_policy('${S}.${view}', start_offset => interval '30 days', end_offset => interval '15 minutes', schedule_interval => interval '5 minutes', if_not_exists => true)`,
      );
    }
  }

  async insert(f: { ts: number; path: string; win_title: string; win_class: string; px: number | null; py: number | null; thumb: Uint8Array }): Promise<number> {
    const [r] = await this.q<{ id: number }>(
      `insert into ${this.s}.frames (ts, last_seen, path, win_title, win_class, px, py, thumb) values ($1, $1, $2, $3, $4, $5, $6, $7) returning id::int as id`,
      [new Date(f.ts), f.path, f.win_title, f.win_class, f.px, f.py, Buffer.from(f.thumb)],
    );
    return r.id;
  }

  async touch(id: number, ts: number): Promise<void> {
    await this.q(`update ${this.s}.frames set last_seen = $2 where id = $1`, [id, new Date(ts)]);
  }

  /** The newest frame's change-gate data; px/py is where the pointer (and its halo) was in that thumbnail. */
  async last(): Promise<{ id: number; win_title: string; thumb: Uint8Array; px: number | null; py: number | null } | undefined> {
    const [r] = await this.q<{ id: number; win_title: string; thumb: Buffer; px: number | null; py: number | null }>(
      `select id::int as id, win_title, thumb, px, py from ${this.s}.frames order by ts desc limit 1`,
    );
    return r;
  }

  async done(id: number, caption: Caption, text: string, embedding: Float32Array, usage: { input: number; output: number }): Promise<void> {
    await this.q(
      `update ${this.s}.frames set status = 'done', caption = $2, text = $3, embedding = $4, error = null, in_tokens = $5, out_tokens = $6 where id = $1`,
      [id, JSON.stringify(caption), text, vec(embedding), usage.input, usage.output],
    );
  }

  async fail(id: number, message: string): Promise<void> {
    await this.q(`update ${this.s}.frames set status = 'error', error = $2 where id = $1`, [id, message]);
  }

  async get(id: number): Promise<Frame | undefined> {
    const [r] = await this.q<Frame>(`select ${this.cols} from ${this.s}.frames where id = $1`, [id]);
    return r;
  }

  /** Frames overlapping [since, until], oldest first. */
  async range(since: number, until: number): Promise<Frame[]> {
    return this.q<Frame>(`select ${this.cols} from ${this.s}.frames where last_seen >= $1 and ts <= $2 order by ts`, [new Date(since), new Date(until)]);
  }

  async todo(): Promise<number[]> {
    return (await this.q<{ id: number }>(`select id::int as id from ${this.s}.frames where status in ('pending', 'error') order by ts`)).map((r) => r.id);
  }

  async count(): Promise<number> {
    const [r] = await this.q<{ n: number }>(`select count(*)::int as n from ${this.s}.frames`);
    return r.n;
  }

  /**
   * Hybrid search in one query: frames ranked by embedding distance and by keyword relevance
   * (BM25 or full-text), fused with reciprocal rank fusion. Best first.
   */
  async hybrid(query: string, qvec: Float32Array, opts: { since?: number; until?: number; app?: string; k: number }): Promise<{ id: number; score: number }[]> {
    const args: unknown[] = [vec(qvec), query, opts.k];
    const where = [`status = 'done'`];
    if (opts.since !== undefined) where.push(`last_seen >= $${args.push(new Date(opts.since))}`);
    if (opts.until !== undefined) where.push(`ts <= $${args.push(new Date(opts.until))}`);
    if (opts.app) where.push(`(win_title || ' ' || win_class || ' ' || coalesce(caption->>'app', '')) ilike $${args.push(`%${opts.app}%`)}`);
    const w = where.join(' and ');
    const S = this.s;
    // BM25 scores from <@> are negative (lower = better); non-matching rows score 0.
    const keyword =
      this.keyword === 'bm25'
        ? `select id, row_number() over (order by text <@> to_bm25query($2, '${S}.frames_bm25')) as r
           from ${S}.frames where ${w} and text <@> to_bm25query($2, '${S}.frames_bm25') < 0
           order by text <@> to_bm25query($2, '${S}.frames_bm25') limit ${POOL}`
        : `select id, row_number() over (order by ts_rank_cd(to_tsvector('english', coalesce(text, '')), q) desc) as r
           from ${S}.frames, to_tsquery('english', array_to_string(tsvector_to_array(to_tsvector('english', $2)), ' | ')) q
           where ${w} and to_tsvector('english', coalesce(text, '')) @@ q
           order by ts_rank_cd(to_tsvector('english', coalesce(text, '')), q) desc limit ${POOL}`;
    return this.q<{ id: number; score: number }>(
      `with v as (
         select id, row_number() over (order by embedding <=> $1::vector) as r
         from ${S}.frames where ${w} order by embedding <=> $1::vector limit ${POOL}
       ), k as (${keyword})
       select id::int as id, sum(1.0 / (${RRF_K} + r))::float8 as score
       from (select * from v union all select * from k) u
       group by id order by score desc limit $3`,
      args,
    );
  }

  /** Screen time per app and actions per hour between two times (from the continuous aggregates). */
  async usage(since: number, until: number): Promise<Usage> {
    const range = [new Date(since), new Date(until)];
    const by_app = await this.q<{ app: string; minutes: number; screens: number }>(
      `select app, round((sum(seconds) / 60)::numeric, 1)::float8 as minutes, sum(screens)::int as screens
       from ${this.s}.activity_15m where bucket >= time_bucket('15 minutes', $1::timestamptz) and bucket < $2
       group by app order by minutes desc, screens desc limit 20`,
      range,
    );
    const by_hour = await this.q<{ hour: number; clicks: number; dictations: number; orion: number }>(
      `select ${ms("time_bucket('1 hour', bucket)")} as hour,
              coalesce(sum(n) filter (where kind = 'click'), 0)::int as clicks,
              coalesce(sum(n) filter (where kind = 'dictation'), 0)::int as dictations,
              coalesce(sum(n) filter (where kind = 'orion'), 0)::int as orion
       from ${this.s}.events_15m where bucket >= time_bucket('15 minutes', $1::timestamptz) and bucket < $2
       group by 1 order by 1`,
      range,
    );
    return { by_app, by_hour };
  }

  async event(e: { ts: number; kind: EventKind; x?: number | null; y?: number | null; text?: string }): Promise<void> {
    await this.q(`insert into ${this.s}.events (ts, kind, x, y, text) values ($1, $2, $3, $4, $5)`, [new Date(e.ts), e.kind, e.x ?? null, e.y ?? null, e.text ?? '']);
  }

  /** Events in [since, until], oldest first. */
  async events(since: number, until: number): Promise<MemEvent[]> {
    return this.q<MemEvent>(
      `select id::int as id, ${ms('ts')} as ts, kind, x, y, text from ${this.s}.events where ts >= $1 and ts <= $2 order by ts`,
      [new Date(since), new Date(until)],
    );
  }

  /** Text events (dictation, Orion) whose text contains any of `terms`, newest first. */
  async findEvents(terms: string[], since: number, until: number, limit: number): Promise<MemEvent[]> {
    if (!terms.length) return [];
    return this.q<MemEvent>(
      `select id::int as id, ${ms('ts')} as ts, kind, x, y, text from ${this.s}.events
       where kind != 'click' and ts >= $1 and ts <= $2 and text ilike any($3) order by ts desc limit $4`,
      [new Date(since), new Date(until), terms.map((t) => `%${t}%`), limit],
    );
  }

  /** Drops this store's schema (tests only). */
  async dropSchema(): Promise<void> {
    await this.q(`drop schema if exists ${this.s} cascade`);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
