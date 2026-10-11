// Screen memory settings (ported from screen-memory/src/config.ts). Read when first imported, which
// is before vite.config.ts copies anything, so `.env` is loaded here (real env vars win).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

export const DATA_DIR = fileURLToPath(new URL('../../data/memory', import.meta.url));
/** Tiger Cloud service (Postgres + TimescaleDB + pgvector): captions, embeddings and the action log. Screenshots stay in DATA_DIR. */
export const TIGER_URL = env.TIGER_DATABASE_URL || undefined;
/** `touch data/memory/PAUSE` pauses recording even while it's switched on; delete it to resume. */
export const PAUSE_FILE = `${DATA_DIR}/PAUSE`;

export const INTERVAL_S = Number(env.MEMORY_INTERVAL_S ?? 10);
/** Mean per-pixel change (0-255) on the 32×18 grayscale thumbnail before a frame counts as new. */
export const DIFF_THRESHOLD = Number(env.MEMORY_DIFF_THRESHOLD ?? 4);
/** Window titles matching this (case-insensitive) are never saved or sent anywhere. Chat apps too: their messages are someone else's. */
export const PRIVATE_TITLES = new RegExp(
  env.MEMORY_PRIVATE_TITLES ??
    'password|bitwarden|1password|keepass|incognito|private browsing|bank|discord|slack|signal|whatsapp|messenger|telegram|\\.env\\b|secret|credential|api key',
  'i',
);

export const CAPTION_MODEL = env.MEMORY_CAPTION_MODEL ?? 'claude-haiku-5-5';
export const EMBED_MODEL = env.EMBED_MODEL ?? 'embeddinggemma';
export const OLLAMA_URL = env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

// $/MTok for the running cost (Haiku 5.5, prompts under 100K).
export const CAPTION_PRICE = { input: 0.1, output: 0.5 };

/** Local "YYYY-MM-DD HH:MM:SS"; Date.parse reads it back as local time. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
