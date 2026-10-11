// Downloads the small English Vosk model (~40 MB) into models/ for keystroke mode.
// Run by `npm run setup:keys` after it installs the vosk Python package into .venv.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'vosk-model-small-en-us-0.15';
const URL_ = `https://alphacephei.com/vosk/models/${NAME}.zip`;
const dir = fileURLToPath(new URL('../models/', import.meta.url));
const zip = `${dir}${NAME}.zip`;

if (existsSync(`${dir}${NAME}`)) {
  console.log(`[fetch-vosk] models/${NAME} already there`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
console.log(`[fetch-vosk] downloading ${URL_}`);
const res = await fetch(URL_);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// Python's zipfile, so `unzip` doesn't need to be installed.
execFileSync('python3', ['-m', 'zipfile', '-e', zip, dir], { stdio: 'inherit' });
rmSync(zip);
console.log(`[fetch-vosk] models/${NAME} ready`);
