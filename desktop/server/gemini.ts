// Gemini, over REST (no SDK): every model call in gymote-desktop goes through here.
//
//   interact()       the Interactions API: Orion's agent loop (computer use on the desktop + our
//                    own functions). The server keeps the conversation: pass previous_interaction_id.
//   generateJson()   one structured-output call (an image + a prompt → JSON matching a schema):
//                    screen-memory captions and AI snap targets.
//
// Key: GEMINI_API_KEY (vite.config.ts / the scripts load .env).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI = {
  /** Orion, captions and snap targets: the recommended computer-use model. */
  MODEL: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  /** $ per token (gemini-3.8-flash, standard tier, through 2026; thinking is billed as output). */
  USD_IN: 0.75 / 1e6,
  USD_OUT: 3.75 / 1e6,
};

export const hasGemini = () => !!process.env.GEMINI_API_KEY;

/** A part of an input or a function result. */
export type Part = { type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string };

export type FunctionTool = { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };
export type Tool = { type: 'computer_use'; environment: 'desktop' | 'browser'; excluded_predefined_functions?: string[] } | FunctionTool;

export type Step =
  | { type: 'thought'; signature?: string; summary?: unknown }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'model_output'; content?: { type: string; text?: string }[] }
  | { type: string; [k: string]: unknown };

export type Interaction = {
  id: string;
  status: 'completed' | 'requires_action' | 'in_progress' | 'failed' | string;
  steps: Step[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_cached_tokens?: number };
};

export type InteractInput = Part | { type: 'function_result'; name: string; call_id: string; result: Part[] };

export type InteractBody = {
  model?: string;
  system_instruction?: string;
  input: InteractInput[];
  tools?: Tool[];
  previous_interaction_id?: string;
  /** thinking_level: 'low' keeps a desktop step at ~5 s (default thinking took ~45 s). */
  generation_config?: { thinking_level?: 'low' | 'medium' | 'high'; temperature?: number };
};

function key(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('no GEMINI_API_KEY in .env');
  return k;
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json();
}

export function interact(body: InteractBody, signal?: AbortSignal): Promise<Interaction> {
  return post('/interactions', { model: GEMINI.MODEL, ...body }, signal);
}

/** The text the model said in this interaction. */
export function outputText(i: Interaction): string {
  return i.steps
    .filter((s): s is Extract<Step, { type: 'model_output' }> => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .flatMap((c) => (c.type === 'text' && c.text ? [c.text] : []))
    .join(' ')
    .trim();
}

export function functionCalls(i: Interaction): Extract<Step, { type: 'function_call' }>[] {
  return i.steps.filter((s): s is Extract<Step, { type: 'function_call' }> => s.type === 'function_call');
}

/** A tool in our neutral format → a Gemini function declaration (drops JSON-schema keys Gemini rejects). */
export function fnTool(t: { name: string; description: string; parameters: Record<string, unknown> }): FunctionTool {
  const clean = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(clean);
    if (!s || typeof s !== 'object') return s;
    return Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, clean(v)]));
  };
  return { type: 'function', name: t.name, description: t.description, parameters: clean(t.parameters) as Record<string, unknown> };
}

/**
 * One call that must answer with JSON matching `schema` (generateContent with a response schema).
 * `image` is base64. Returns the parsed object and token counts.
 */
export async function generateJson<T>(opts: {
  system: string;
  prompt: string;
  image?: { data: string; mime_type: string };
  schema: Record<string, unknown>;
  thinking?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}): Promise<{ data: T; input: number; output: number }> {
  const parts: unknown[] = [];
  if (opts.image) parts.push({ inlineData: { mimeType: opts.image.mime_type, data: opts.image.data } });
  parts.push({ text: opts.prompt });
  const r = await post(
    `/models/${GEMINI.MODEL}:generateContent`,
    {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: opts.schema,
        thinkingConfig: { thinkingLevel: opts.thinking ?? 'low' },
      },
    },
    opts.signal,
  );
  const cand = r.candidates?.[0];
  if (!cand) throw new Error(`gemini: no answer (${JSON.stringify(r.promptFeedback ?? {}).slice(0, 120)})`);
  if (cand.finishReason && cand.finishReason !== 'STOP') throw new Error(`gemini stopped: ${cand.finishReason}`);
  const text = (cand.content?.parts ?? []).map((p: { text?: string; thought?: boolean }) => (p.thought ? '' : p.text ?? '')).join('');
  const u = r.usageMetadata ?? {};
  return {
    data: JSON.parse(text) as T,
    input: u.promptTokenCount ?? 0,
    output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}
