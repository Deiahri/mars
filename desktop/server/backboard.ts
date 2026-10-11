// Orion's long-term memory of the person, on Backboard (app.backboard.io): who they are, people they
// mention, preferences and routines, and what they asked Orion before. Screen memory (server/memory/)
// remembers what was on the screen; this remembers the person, across restarts.
//
// Backboard keeps memories per assistant. We make one assistant for Orion and keep its id in
// data/backboard.json. REST only: create assistant, add memory, search memories, list (for the count).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://app.backboard.io/api';
const ID_FILE = fileURLToPath(new URL('../data/backboard.json', import.meta.url));
const TIMEOUT_MS = 8000;

export class Backboard {
  /** Memories stored, as of the last check (null until known). */
  count: number | null = null;
  private key: string | undefined;
  private assistant: Promise<string> | null = null;

  constructor(key: string | undefined) {
    this.key = key;
  }

  get on(): boolean {
    return !!this.key;
  }

  /** Stores one memory. */
  async remember(content: string, metadata: Record<string, string> = {}): Promise<void> {
    const id = await this.assistantId();
    await this.call('POST', `/assistants/${id}/memories`, { content, metadata });
    if (this.count !== null) this.count++;
  }

  /** The memories most relevant to `query`, best first. */
  async recall(query: string, limit = 5): Promise<string[]> {
    const id = await this.assistantId();
    const r = (await this.call('POST', `/assistants/${id}/memories/search`, { query, limit })) as { memories?: { content: string }[] };
    return (r.memories ?? []).map((m) => m.content);
  }

  /** Refreshes `count`. */
  async refreshCount(): Promise<void> {
    const id = await this.assistantId();
    const r = (await this.call('GET', `/assistants/${id}/memories?page=1&page_size=1`)) as { total_count?: number };
    this.count = r.total_count ?? 0;
  }

  private assistantId(): Promise<string> {
    this.assistant ??= (async () => {
      if (existsSync(ID_FILE)) return (JSON.parse(readFileSync(ID_FILE, 'utf8')) as { assistant_id: string }).assistant_id;
      const r = (await this.call('POST', '/assistants', {
        name: 'Orion: memory of the person',
        system_prompt:
          'Long-term memory for Orion, a voice assistant that drives the computer for a person with limited hand movement. Keep facts about the person: people they mention, preferences, routines, accounts and sites they use, and what they asked for before.',
      })) as { assistant_id: string };
      mkdirSync(fileURLToPath(new URL('../data', import.meta.url)), { recursive: true });
      writeFileSync(ID_FILE, JSON.stringify({ assistant_id: r.assistant_id }, null, 2));
      console.log(`[backboard] created assistant ${r.assistant_id}`);
      return r.assistant_id;
    })();
    // A failed create must not stick: try again next time.
    this.assistant.catch(() => (this.assistant = null));
    return this.assistant;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!this.key) throw new Error('no BACKBOARD_API_KEY in .env');
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'X-API-Key': this.key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`backboard ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
  }
}
