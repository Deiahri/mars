// One AI-targets look at the current screen, to judge the boxes: npm run look [-- out.png]
// Prints what Gemini found and how long it took, and writes the screenshot with the boxes drawn on
// it (default /tmp/sightline-look.png). Costs one Gemini call, a fraction of a cent.

import '../server/memory/config.ts'; // loads .env (GEMINI_API_KEY)
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Desktop } from '../server/computer.ts';
import { findElements, toTargets, VISION } from '../server/vision-targets.ts';

const out = process.argv[2] ?? '/tmp/sightline-look.png';

const desktop = new Desktop();
await desktop.init();
const png = await desktop.screenshot();
const t0 = Date.now();
const { boxes, usage } = await findElements(png, desktop.shotSize);
const ms = Date.now() - t0;
const targets = toTargets(boxes, desktop.scale, desktop.width, desktop.height);
for (const t of targets) console.log(`${String(t.x).padStart(5)} ${String(t.y).padStart(4)}  ${String(t.w).padStart(4)}×${String(t.h).padEnd(4)} ${t.id.split(':').slice(2).join(':')}`);
const cost = usage.input_tokens * VISION.USD_IN + usage.output_tokens * VISION.USD_OUT;
console.log(`\n${targets.length} targets (${boxes.length} boxes) in ${(ms / 1000).toFixed(1)} s, ${usage.input_tokens} in / ${usage.output_tokens} out, ≈ $${cost.toFixed(3)}`);

// Boxes in screenshot px, drawn onto the screenshot.
const shot = '/tmp/sightline-look-src.png';
writeFileSync(shot, png);
const s = desktop.scale;
const draw = targets.map((t) => `drawbox=x=${Math.round(t.x * s)}:y=${Math.round(t.y * s)}:w=${Math.round(t.w * s)}:h=${Math.round(t.h * s)}:color=red@0.9:t=2`);
await promisify(execFile)('ffmpeg', ['-loglevel', 'error', '-y', '-i', shot, '-vf', draw.join(',') || 'null', out]);
console.log(`boxes drawn on ${out}`);
