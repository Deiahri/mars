// Checks keystroke mode's word → key logic without a mic or xdotool: npm run test:keys

import assert from 'node:assert/strict';
import { KeyParser, KeyPresser, TAP_HOLD_MS, xdotoolArgs, type KeyAction } from '../server/keys.ts';

const TAP = `sleep ${TAP_HOLD_MS / 1000}`;
/** xdotool args, with a held tap ("keydown X sleep 0.04 keyup X") shortened to "key X". */
const show = (a: KeyAction) => xdotoolArgs(a).join(' ').replace(new RegExp(`^keydown (\\S+) ${TAP} keyup \\1$`), 'key $1');

/** Feeds utterances (arrays of words; each ends with a pause) and returns the xdotool calls. */
function say(p: KeyParser, ...utterances: string[][]): string[] {
  const out: string[] = [];
  for (const words of utterances) {
    for (const w of words) out.push(...p.word(w).map(show));
    out.push(...p.end().map(show));
  }
  return out;
}

const cases: [string, string[][], string[]][] = [
  ['tap', [['left']], ['key Left']],
  ['several taps in one breath', [['left', 'left', 'up', 'jump']], ['key Left', 'key Left', 'key Up', 'key space']],
  ['hold then stop', [['hold', 'up'], ['stop', 'up']], ['keydown Up', 'keyup Up']],
  ['release = stop', [['hold', 'down'], ['release', 'down']], ['keydown Down', 'keyup Down']],
  ['hold twice is one keydown', [['hold', 'up'], ['hold', 'up']], ['keydown Up']],
  ['lone stop releases everything', [['hold', 'up'], ['hold', 'right'], ['stop']], ['keydown Up', 'keydown Right', 'keyup Up Right']],
  ['lone stop with nothing held does nothing', [['stop']], []],
  ['stop then hold', [['hold', 'up', 'stop', 'hold', 'left']], ['keydown Up', 'keyup Up', 'keydown Left']],
  ['dangling hold is dropped', [['hold'], ['left']], ['key Left']],
  ['tap of a held key un-holds it', [['hold', 'up', 'up'], ['stop']], ['keydown Up', 'key Up']],
  ['enter / escape', [['enter', 'escape']], ['key Return', 'key Escape']],
];

let failed = 0;
for (const [name, utterances, want] of cases) {
  try {
    assert.deepEqual(say(new KeyParser(), ...utterances), want);
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n${(e as Error).message}`);
  }
}

const p = new KeyParser();
say(p, ['hold', 'up'], ['hold', 'left']);
assert.deepEqual(p.releaseAll().map(show), ['keyup Up Left']);
console.log('ok    releaseAll (keys off / Orion) lets go of everything');

assert.deepEqual(xdotoolArgs({ kind: 'tap', key: 'Right', said: 'right' }), ['keydown', 'Right', 'sleep', '0.04', 'keyup', 'Right']);
console.log(`ok    a tap holds the key ${TAP_HOLD_MS} ms (one xdotool call)`);

// Pacing, with a fake xdotool that records when each call starts.
const tap = (key: string): KeyAction => ({ kind: 'tap', key, said: key });
async function timeline(gap: number, actions: KeyAction[], cancelAfterMs?: number) {
  const t0 = performance.now();
  const calls: [string, number][] = [];
  const presser = new KeyPresser(async (args) => void calls.push([args.join(' '), performance.now() - t0]));
  presser.gapMs = gap;
  const done = Promise.all(actions.map((a) => presser.press(a)));
  if (cancelAfterMs !== undefined) setTimeout(() => presser.cancel(), cancelAfterMs);
  await done;
  return calls;
}
{
  const calls = await timeline(300, [tap('Right'), tap('Right'), tap('Right')]);
  const starts = calls.map(([, t]) => t);
  assert.equal(calls.length, 3);
  assert.ok(starts[1] - starts[0] >= 295 && starts[2] - starts[1] >= 295, `gaps ${starts.map(Math.round)}`);
  console.log(`ok    gap 300: three taps start at ${starts.map((t) => Math.round(t)).join(', ')} ms`);
}
{
  const calls = await timeline(0, [tap('Right'), tap('Right'), tap('Right')]);
  assert.ok(calls.at(-1)![1] < 50, `no gap took ${calls.at(-1)![1]} ms`);
  console.log('ok    gap 0: taps go straight through');
}
{
  const hold: KeyAction = { kind: 'down', key: 'Up', said: 'hold up' };
  const calls = await timeline(300, [tap('Right'), hold, tap('Left')]);
  assert.ok(calls[1][1] < 50, `hold waited ${calls[1][1]} ms`);
  assert.ok(calls[2][1] >= 295, 'second tap kept its gap');
  console.log('ok    holds are not delayed by the gap; the next tap still is');
}
{
  const calls = await timeline(300, [tap('Right'), tap('Right'), tap('Right')], 100);
  assert.equal(calls.length, 1, `cancel left ${calls.length} taps`);
  console.log('ok    cancel (keys off) drops queued taps');
}

if (failed) process.exit(1);
