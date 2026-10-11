// Ask screen memory a question from the terminal, without the phone or Orion (which would also be
// able to act on the desktop). Same tools Orion gets, read-only, on Gemini. From screen-memory/src/agent.ts.
//
//   npm run memory:ask -- "what was the error in my terminal earlier?"

import '../server/memory/config.ts'; // loads .env
import { fnTool, functionCalls, interact, type InteractInput, outputText } from '../server/gemini.ts';
import { localTime } from '../server/memory/config.ts';
import { Memory } from '../server/memory/memory.ts';
import { MEMORY_PROMPT, MEMORY_TOOLS, runMemoryTool } from '../server/memory/tools.ts';

const MAX_STEPS = 12;

const SYSTEM = `You answer questions about what the person has been doing on their computer. You cannot act on the computer here; only read memory.

${MEMORY_PROMPT}

Answer briefly and concretely. Cite the frame ids and times you relied on, e.g. (#42, 14:03).`;

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: npm run memory:ask -- "your question"');
  process.exit(1);
}

const mem = new Memory();
const tools = MEMORY_TOOLS.map(fnTool);
let input: InteractInput[] = [{ type: 'text', text: `Current local time: ${localTime(Date.now())}\n\n${question}` }];
let previous: string | undefined;

for (let step = 1; step <= MAX_STEPS; step++) {
  const t = Date.now();
  const i = await interact({
    system_instruction: SYSTEM,
    generation_config: { thinking_level: 'low' },
    tools,
    input,
    ...(previous ? { previous_interaction_id: previous } : {}),
  });
  previous = i.id;
  const u = i.usage ?? {};
  console.log(`  [turn ${step}: ${((Date.now() - t) / 1000).toFixed(1)}s, in ${u.total_input_tokens ?? 0}, out ${(u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0)}]`);

  const calls = functionCalls(i);
  if (!calls.length) {
    console.log(`\n${outputText(i) || '(no answer)'}`);
    await mem.store.close();
    process.exit(0);
  }
  input = await Promise.all(
    calls.map(async (call): Promise<InteractInput> => {
      try {
        const result = await runMemoryTool(mem, call.name, call.arguments ?? {});
        console.log(`  → ${call.name} ${JSON.stringify(call.arguments)}`);
        return { type: 'function_result', name: call.name, call_id: call.id, result };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.log(`  ✗ ${call.name} ${JSON.stringify(call.arguments)}: ${detail}`);
        return { type: 'function_result', name: call.name, call_id: call.id, result: [{ type: 'text', text: `Error: ${detail}` }] };
      }
    }),
  );
}
console.log(`(stopped after ${MAX_STEPS} steps without an answer)`);
await mem.store.close();
