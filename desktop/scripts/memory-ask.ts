// Ask screen memory a question from the terminal, without the phone or Orion (which would also be
// able to act on the desktop). Same tools Orion gets, read-only. From screen-memory/src/agent.ts.
//
//   npm run memory:ask -- "what was the error in my terminal earlier?"

import Anthropic from '@anthropic-ai/sdk';
import { localTime } from '../server/memory/config.ts';
import { Memory } from '../server/memory/memory.ts';
import { MEMORY_PROMPT, MEMORY_TOOLS, runMemoryTool } from '../server/memory/tools.ts';

type Beta = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;

const MAX_STEPS = 12;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

const SYSTEM = `You answer questions about what the person has been doing on their computer. You cannot act on the computer here; only read memory.

${MEMORY_PROMPT}

Answer briefly and concretely. Cite the frame ids and times you relied on, e.g. (#42, 14:03).`;

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: npm run memory:ask -- "your question"');
  process.exit(1);
}

const client = new Anthropic();
const mem = new Memory();
const messages: Beta[] = [{ role: 'user', content: `Current local time: ${localTime(Date.now())}\n\n${question}` }];

for (let step = 1; step <= MAX_STEPS; step++) {
  const t = Date.now();
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01', 'thinking-display-updates-2026-08-18'],
    fallbacks: 'default',
    thinking: { type: 'adaptive', display: 'updates' },
    output_config: { effort: 'medium' },
    cache_control: { type: 'ephemeral' },
    system: SYSTEM,
    tools: MEMORY_TOOLS,
    messages,
  });
  console.log(`  [turn ${step}: ${((Date.now() - t) / 1000).toFixed(1)}s, in ${msg.usage.input_tokens} + cache ${msg.usage.cache_read_input_tokens ?? 0}, out ${msg.usage.output_tokens}]`);
  messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
  for (const b of msg.content) if (b.type === 'thinking' && b.thinking.trim()) console.log(`  … ${b.thinking.trim()}`);

  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined (${msg.stop_details?.category ?? 'no category'})`);
  if (msg.stop_reason === 'pause_turn') continue;
  if (msg.stop_reason !== 'tool_use') {
    console.log(`\n${msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim() || '(no answer)'}`);
    process.exit(0);
  }

  const uses = msg.content.filter((b): b is ToolUse => b.type === 'tool_use');
  const results: ToolResult[] = await Promise.all(
    uses.map(async (use): Promise<ToolResult> => {
      try {
        const content = await runMemoryTool(mem, use.name, (use.input ?? {}) as Record<string, unknown>);
        console.log(`  → ${use.name} ${JSON.stringify(use.input)}`);
        return { type: 'tool_result', tool_use_id: use.id, content };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.log(`  ✗ ${use.name} ${JSON.stringify(use.input)}: ${detail}`);
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: detail };
      }
    }),
  );
  messages.push({ role: 'user', content: results });
}
console.log(`(stopped after ${MAX_STEPS} steps without an answer)`);
