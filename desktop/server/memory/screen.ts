// X11 plumbing for screen memory (from screen-memory/src/screen.ts): which window is active, and
// one ffmpeg x11grab call that writes the full JPEG and returns a tiny grayscale thumbnail for
// change detection.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const THUMB_W = 32;
export const THUMB_H = 18;

const display = process.env.DISPLAY ?? ':0';

export async function screenSize(): Promise<[number, number]> {
  const { stdout } = await run('xdotool', ['getdisplaygeometry']);
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  return [w, h];
}

/** Title and WM_CLASS of the focused window; empty strings when nothing is focused (bare desktop). */
export async function activeWindow(): Promise<{ title: string; cls: string }> {
  try {
    const id = (await run('xdotool', ['getactivewindow'])).stdout.trim();
    const [name, cls] = await Promise.all([
      run('xdotool', ['getwindowname', id]).then((r) => r.stdout.trim()),
      run('xprop', ['-id', id, 'WM_CLASS']).then((r) => [...r.stdout.matchAll(/"([^"]*)"/g)].map((m) => m[1]).pop() ?? ''),
    ]);
    return { title: name, cls };
  } catch {
    return { title: '', cls: '' };
  }
}

/** Writes the screen to `jpgPath` and returns its THUMB_W×THUMB_H 8-bit grayscale thumbnail. */
export async function grab(jpgPath: string, size: [number, number]): Promise<Buffer> {
  const args = [
    '-loglevel', 'error', '-y',
    '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${size[0]}x${size[1]}`, '-i', `${display}+0,0`,
    '-filter_complex', `[0:v]split=2[full][s];[s]scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray[thumb]`,
    '-map', '[full]', '-frames:v', '1', '-q:v', '4', jpgPath,
    '-map', '[thumb]', '-frames:v', '1', '-f', 'rawvideo', '-',
  ];
  const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  if (stdout.length !== THUMB_W * THUMB_H) throw new Error(`thumbnail is ${stdout.length} bytes, expected ${THUMB_W * THUMB_H}`);
  return stdout;
}

/** Thumbnail cells within `radius` px of `at` on a `size` screen: our halo lives there, so it doesn't count as a change. */
export function pointerMask(at: { x: number; y: number } | null, radius: number, size: [number, number]): Set<number> {
  const cells = new Set<number>();
  if (!at) return cells;
  const cw = size[0] / THUMB_W;
  const ch = size[1] / THUMB_H;
  const x0 = Math.max(0, Math.floor((at.x - radius) / cw));
  const x1 = Math.min(THUMB_W - 1, Math.floor((at.x + radius) / cw));
  const y0 = Math.max(0, Math.floor((at.y - radius) / ch));
  const y1 = Math.min(THUMB_H - 1, Math.floor((at.y + radius) / ch));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.add(y * THUMB_W + x);
  return cells;
}

/** Mean absolute per-pixel difference, 0-255, over the cells not in `mask`. */
export function thumbDiff(a: Uint8Array, b: Uint8Array, mask: Set<number> = new Set()): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask.has(i)) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n ? sum / n : 0;
}

/** A region of a stored screenshot ([x0, y0, x1, y1] in its pixels), blown up to `fit` as PNG. */
export async function crop(jpgPath: string, region: number[], fit: [number, number]): Promise<Buffer> {
  const [x0, y0, x1, y1] = region.map(Math.round);
  const x = Math.max(0, Math.min(x0, x1));
  const y = Math.max(0, Math.min(y0, y1));
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (w < 8 || h < 8) throw new Error(`region too small: ${JSON.stringify(region)}`);
  const vf = `crop=min(${w}\\,iw-${x}):min(${h}\\,ih-${y}):${x}:${y},scale=${fit[0]}:${fit[1]}:force_original_aspect_ratio=decrease:flags=lanczos`;
  const args = ['-loglevel', 'error', '-i', jpgPath, '-vf', vf, '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-'];
  const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
