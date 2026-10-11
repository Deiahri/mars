// Caption + embed every screen memory frame that is still pending or failed (the queue overflowed,
// Ollama was down, out of credits). From screen-memory/scripts/backfill.ts.
//
//   npm run memory:caption

import { processFrame } from '../server/memory/caption.ts';
import { Store } from '../server/memory/db.ts';

const store = new Store();
const ids = store.todo();
console.log(`${ids.length} frame(s) to caption`);
let cost = 0;
let failed = 0;
for (const id of ids) {
  const r = await processFrame(store, id);
  if ('error' in r) {
    failed++;
    console.log(`#${id} failed: ${r.error}`);
  } else {
    cost += r.cost;
    console.log(`#${id} ${r.caption.app}: ${r.caption.activity}  ($${r.cost.toFixed(5)})`);
  }
}
console.log(`done: ${ids.length - failed} ok, ${failed} failed, $${cost.toFixed(4)}`);
