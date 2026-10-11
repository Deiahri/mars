// Local embeddings through Ollama. Anthropic has no embeddings endpoint, and this keeps the
// index free and on-device. Each model wants its own query/document prompt prefixes.

import { EMBED_MODEL, OLLAMA_URL } from './config.ts';

type Kind = 'query' | 'doc';

function prefix(text: string, kind: Kind): string {
  if (EMBED_MODEL.startsWith('embeddinggemma')) {
    return kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  }
  if (EMBED_MODEL.startsWith('nomic-embed-text')) {
    return kind === 'query' ? `search_query: ${text}` : `search_document: ${text}`;
  }
  return text;
}

export async function embed(texts: string[], kind: Kind): Promise<Float32Array[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => prefix(t, kind)) }),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
  const { embeddings } = (await res.json()) as { embeddings: number[][] };
  return embeddings.map((e) => {
    const v = Float32Array.from(e);
    const n = Math.hypot(...v) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  });
}

export async function embedOne(text: string, kind: Kind): Promise<Float32Array> {
  return (await embed([text], kind))[0];
}
