// The real desktop, driven through xdotool (input) and ffmpeg x11grab (screenshots).
//
// Only works on an X11 session: on GNOME Wayland, xdotool reaches XWayland windows only and
// x11grab sees a black/partial screen. checkSession() reports which one we're on.
//
// Mars's actions come from Gemini's computer-use tool (geminiAction): coordinates are 0-999 across
// the screen, mapped here onto the same xdotool helpers. Screenshots are downscaled only when the
// screen is big (1366x768 needs none); `scale` maps screenshot px back to screen px.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Point = [number, number];
export type ActionResult = { text: string } | { png: Buffer };

// Same budget as the computer-use docs' scaling example: long edge ≤1568, ≤1.15 MP. Keeps each
// screenshot around 1.5k tokens, and under the 2000 px rule that kicks in after 20 images.
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
// Give the UI a moment to react before the next action or screenshot.
const SETTLE_MS = 350;

// Key names models use that xdotool spells differently. xdotool already understands
// ctrl/alt/shift/super and every X keysym (Return, Tab, Page_Down, F5...).
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'BackSpace',
  del: 'Delete',
  delete: 'Delete',
  space: 'space',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  page_up: 'Page_Up',
  page_down: 'Page_Down',
  home: 'Home',
  end: 'End',
  cmd: 'super',
  command: 'super',
  win: 'super',
  windows: 'super',
  meta: 'super',
  control: 'ctrl',
  option: 'alt',
};

export function xkey(combo: string): string {
  return combo
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => KEY_ALIASES[k.toLowerCase()] ?? k)
    .join('+');
}

function modifiers(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  return xkey(text).split('+');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function xdo(args: string[]): Promise<string> {
  const { stdout } = await run('xdotool', args);
  return stdout;
}

export function checkSession(): { type: string; ok: boolean; warning?: string } {
  const type = process.env.XDG_SESSION_TYPE ?? 'unknown';
  if (type === 'x11') return { type, ok: true };
  return {
    type,
    ok: false,
    warning:
      type === 'wayland'
        ? 'Wayland session: xdotool only reaches XWayland windows and screenshots come out black. Log out and pick "Ubuntu on Xorg".'
        : `Session type "${type}": expected x11.`,
  };
}

export class Desktop {
  display = process.env.DISPLAY ?? ':0';
  width = 0;
  height = 0;
  /** Screenshot px = screen px × scale. */
  scale = 1;

  async init(): Promise<void> {
    const [w, h] = (await xdo(['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
    this.width = w;
    this.height = h;
    this.scale = Math.min(1, MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  }

  /** Size of the screenshots the model sees. */
  get shotSize(): Point {
    return [Math.round(this.width * this.scale), Math.round(this.height * this.scale)];
  }

  private async grab(filter?: string): Promise<Buffer> {
    const args = ['-loglevel', 'error', '-f', 'x11grab', '-video_size', `${this.width}x${this.height}`, '-i', `${this.display}+0,0`, '-frames:v', '1'];
    if (filter) args.push('-vf', filter);
    args.push('-c:v', 'png', '-f', 'image2pipe', '-');
    const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  screenshot(): Promise<Buffer> {
    const [w, h] = this.shotSize;
    return this.grab(this.scale < 1 ? `scale=${w}:${h}` : undefined);
  }

  /** A tiny grayscale copy of the screen (w×h bytes, row by row), for noticing when it changes. */
  async thumb(w: number, h: number): Promise<Uint8Array> {
    const args = ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${this.width}x${this.height}`, '-i', `${this.display}+0,0`, '-frames:v', '1'];
    args.push('-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-');
    const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 1024 * 1024 });
    return new Uint8Array(stdout);
  }

  /** A region of the screen (screen px) as a PNG at full resolution, without the arrow (zoom-click). */
  async region(x: number, y: number, w: number, h: number): Promise<Buffer> {
    const args = ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${w}x${h}`, '-i', `${this.display}+${x},${y}`, '-frames:v', '1'];
    args.push('-c:v', 'png', '-f', 'image2pipe', '-');
    const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }

  /** A region (screenshot coords) at full resolution, blown up to fit the usual screenshot size. */
  zoom(region: number[]): Promise<Buffer> {
    const [x0, y0, x1, y1] = region.map((v) => Math.round(v / this.scale));
    const x = Math.max(0, Math.min(x0, x1));
    const y = Math.max(0, Math.min(y0, y1));
    const w = Math.min(this.width - x, Math.abs(x1 - x0));
    const h = Math.min(this.height - y, Math.abs(y1 - y0));
    if (w < 4 || h < 4) throw new Error(`zoom region too small: ${JSON.stringify(region)}`);
    const [sw, sh] = this.shotSize;
    return this.grab(`crop=${w}:${h}:${x}:${y},scale=${sw}:${sh}:force_original_aspect_ratio=decrease:flags=lanczos`);
  }

  /** Cursor in screen pixels. */
  async cursor(): Promise<Point> {
    const out = await xdo(['getmouselocation', '--shell']);
    const x = Number(/X=(\d+)/.exec(out)?.[1]);
    const y = Number(/Y=(\d+)/.exec(out)?.[1]);
    return [x, y];
  }

  /** Screenshot coords → screen pixels, rejecting anything off-screen. */
  private toScreen(c: unknown, field = 'coordinate'): Point {
    if (!Array.isArray(c) || c.length !== 2 || !c.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`${field} must be [x, y]`);
    }
    const [w, h] = this.shotSize;
    if (c[0] < 0 || c[1] < 0 || c[0] >= w || c[1] >= h) throw new Error(`${field} ${JSON.stringify(c)} is outside the ${w}x${h} screen`);
    return [Math.round(c[0] / this.scale), Math.round(c[1] / this.scale)];
  }

  /** xdotool args that move to `coordinate` if given (else act at the cursor). */
  private moveArgs(input: Record<string, unknown>): string[] {
    if (input.coordinate === undefined || input.coordinate === null) return [];
    const [x, y] = this.toScreen(input.coordinate);
    return ['mousemove', String(x), String(y)];
  }

  /** Wraps xdotool commands so `mods` are held only for them. */
  private withMods(mods: string[], args: string[]): string[] {
    const down = mods.flatMap((m) => ['keydown', m]);
    const up = [...mods].reverse().flatMap((m) => ['keyup', m]);
    return [...down, ...args, ...up];
  }

  private async click(input: Record<string, unknown>, button: number, repeat: number): Promise<void> {
    const click = ['click', ...(repeat > 1 ? ['--repeat', String(repeat), '--delay', '80'] : []), String(button)];
    await xdo([...this.moveArgs(input), ...this.withMods(modifiers(input.text), click)]);
  }

  /**
   * Runs one of Gemini's computer-use actions (environment "desktop"). x/y are 0-999 across the
   * screen. Mapped onto execute() below, so clicks, drags and keys behave the same as before.
   */
  async geminiAction(name: string, a: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    const [w, h] = this.shotSize;
    const pt = (x: unknown, y: unknown, what = 'x, y'): Point => {
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${what} must be numbers 0-999`);
      const c = (v: number) => Math.min(999, Math.max(0, v)) / 1000;
      return [Math.round(c(x) * w), Math.round(c(y) * h)];
    };
    const at = () => ({ coordinate: pt(a.x, a.y) });
    switch (name) {
      case 'click':
        return this.execute('left_click', at(), signal);
      case 'double_click':
      case 'triple_click':
      case 'middle_click':
      case 'right_click':
        return this.execute(name, at(), signal);
      case 'move':
        return this.execute('mouse_move', at(), signal);
      case 'mouse_down':
        if (a.x !== undefined) await this.execute('mouse_move', at(), signal);
        return this.execute('left_mouse_down', {}, signal);
      case 'mouse_up':
        if (a.x !== undefined) await this.execute('mouse_move', at(), signal);
        return this.execute('left_mouse_up', {}, signal);
      case 'drag_and_drop':
        return this.execute('left_click_drag', { start_coordinate: pt(a.start_x, a.start_y, 'start_x, start_y'), coordinate: pt(a.end_x, a.end_y, 'end_x, end_y') }, signal);
      case 'type': {
        const r = await this.execute('type', { text: a.text }, signal);
        return a.press_enter ? this.execute('key', { text: 'Return' }, signal) : r;
      }
      case 'press_key':
        return this.execute('key', { text: String(a.key ?? '') }, signal);
      case 'hotkey': {
        const keys = Array.isArray(a.keys) ? a.keys.map(String) : String(a.keys ?? '').split(/[+ ]/);
        return this.execute('key', { text: keys.filter(Boolean).join('+') }, signal);
      }
      case 'key_down':
      case 'key_up': {
        const k = xkey(String(a.key ?? ''));
        if (!k) throw new Error('key must name a key');
        await xdo([name === 'key_down' ? 'keydown' : 'keyup', ...k.split('+')]);
        await sleep(SETTLE_MS);
        return { text: 'OK' };
      }
      case 'scroll': {
        // Wheel notches: magnitude_in_wheel_clicks if given (Gemini on the desktop uses it), else
        // magnitude_in_pixels (default 300) at ~100 px a notch.
        const notches = a.magnitude_in_wheel_clicks !== undefined ? Number(a.magnitude_in_wheel_clicks) : Number(a.magnitude_in_pixels ?? 300) / 100;
        const n = Math.max(1, Math.min(30, Math.round(notches) || 3));
        const where = a.x !== undefined && a.y !== undefined ? at() : {};
        return this.execute('scroll', { ...where, scroll_direction: a.direction, scroll_amount: n }, signal);
      }
      case 'wait':
        return this.execute('wait', { duration: Number(a.seconds ?? 1) }, signal);
      case 'take_screenshot':
        return this.execute('screenshot', {}, signal);
      default:
        throw new Error(`"${name}" is not supported on this desktop`);
    }
  }

  /**
   * Runs one computer-toolset member. Throws on bad input or a failed command; the agent turns
   * that into an is_error result. `signal` lets STOP cut a long wait/hold short.
   */
  async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
    const ok = async () => {
      await sleep(SETTLE_MS);
      return { text: 'OK' };
    };

    switch (name) {
      case 'screenshot':
        return { png: await this.screenshot() };

      case 'zoom': {
        if (!Array.isArray(input.region) || input.region.length !== 4) throw new Error('region must be [x0, y0, x1, y1]');
        return { png: await this.zoom(input.region as number[]) };
      }

      case 'left_click':
        await this.click(input, 1, 1);
        return ok();
      case 'right_click':
        await this.click(input, 3, 1);
        return ok();
      case 'middle_click':
        await this.click(input, 2, 1);
        return ok();
      case 'double_click':
        await this.click(input, 1, 2);
        return ok();
      case 'triple_click':
        await this.click(input, 1, 3);
        return ok();

      case 'left_click_drag': {
        const [sx, sy] = this.toScreen(input.start_coordinate, 'start_coordinate');
        const [x, y] = this.toScreen(input.coordinate);
        // Pauses + an intermediate move: many toolkits ignore a drag that jumps in one event.
        const drag = ['mousemove', String(sx), String(sy), 'mousedown', '1', 'sleep', '0.1',
          'mousemove', String(Math.round((sx + x) / 2)), String(Math.round((sy + y) / 2)), 'sleep', '0.1',
          'mousemove', String(x), String(y), 'sleep', '0.1', 'mouseup', '1'];
        await xdo(this.withMods(modifiers(input.text), drag));
        return ok();
      }

      case 'mouse_move': {
        const [x, y] = this.toScreen(input.coordinate);
        await xdo(['mousemove', String(x), String(y)]);
        return ok();
      }
      case 'left_mouse_down':
        await xdo(['mousedown', '1']);
        return ok();
      case 'left_mouse_up':
        await xdo(['mouseup', '1']);
        return ok();

      case 'cursor_position': {
        const [x, y] = await this.cursor();
        return { text: `X=${Math.round(x * this.scale)}, Y=${Math.round(y * this.scale)}` };
      }

      case 'scroll': {
        const dir = input.scroll_direction;
        const button = { up: 4, down: 5, left: 6, right: 7 }[String(dir)];
        if (!button) throw new Error(`scroll_direction must be up/down/left/right, got ${JSON.stringify(dir)}`);
        const n = Math.max(1, Math.min(30, Math.round(Number(input.scroll_amount ?? 3))));
        const scroll = ['click', '--repeat', String(n), '--delay', '40', String(button)];
        await xdo([...this.moveArgs(input), ...this.withMods(modifiers(input.text), scroll)]);
        return ok();
      }

      case 'type': {
        if (typeof input.text !== 'string') throw new Error('text must be a string');
        await xdo(['type', '--delay', '12', '--', input.text]);
        return ok();
      }

      case 'key': {
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text must name a key');
        const repeat = Math.max(1, Math.min(100, Math.round(Number(input.repeat ?? 1))));
        // One combo per space-separated chunk ("ctrl+a Delete" happens).
        const combos = input.text.trim().split(/\s+/).map(xkey);
        await xdo(['key', '--delay', '60', ...(repeat > 1 ? ['--repeat', String(repeat)] : []), '--', ...combos]);
        return ok();
      }

      case 'hold_key': {
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text must name a key');
        const keys = xkey(input.text).split('+');
        const ms = Math.max(0, Math.min(30, Number(input.duration ?? 1))) * 1000;
        await xdo(keys.flatMap((k) => ['keydown', k]));
        try {
          await abortableSleep(ms, signal);
        } finally {
          await xdo([...keys].reverse().flatMap((k) => ['keyup', k]));
        }
        return ok();
      }

      case 'wait': {
        const ms = Math.max(0, Math.min(30, Number(input.duration ?? 1))) * 1000;
        await abortableSleep(ms, signal);
        return { text: 'OK' };
      }

      default:
        throw new Error(`"${name}" is not supported on this desktop`);
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
