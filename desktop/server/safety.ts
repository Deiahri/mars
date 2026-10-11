// Kill switches for an agent that moves the real mouse.
//
// - Takeover: if the cursor ends up somewhere the agent didn't put it, a human grabbed the mouse.
//   Stop immediately (this also cancels an in-flight Claude request).
// - Corner: shoving the cursor into the top-left corner always stops (pyautogui's failsafe).
// - Risky backstop: Claude is told to call ask_user before anything irreversible; this catches
//   the case where it forgets, by pausing a submit-like action when its own narration says it's
//   about to send/buy/delete something.

import type { Desktop, Point } from './computer.ts';

const TAKEOVER_PX = 40;
const CORNER_PX = 5;
const POLL_MS = 200;

export class MouseWatch {
  private expected: Point | null = null;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private desktop: Desktop;

  constructor(desktop: Desktop) {
    this.desktop = desktop;
  }

  /** Polls the cursor until stop(); calls onTrip once with the reason. */
  start(onTrip: (reason: string) => void): void {
    this.stop();
    this.expected = null;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      const reason = await this.check().catch(() => null);
      if (reason && this.timer) {
        this.stop();
        onTrip(reason);
      }
    }, POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wrap every agent action: the cursor moving during it is expected, and where it ends is the new baseline. */
  async during<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.expected = await this.desktop.cursor().catch(() => this.expected);
      this.busy = false;
    }
  }

  /** null = fine, else why to stop. */
  async check(): Promise<string | null> {
    const [x, y] = await this.desktop.cursor();
    if (x < CORNER_PX && y < CORNER_PX) return 'cursor pushed into the top-left corner';
    if (!this.expected) {
      this.expected = [x, y];
      return null;
    }
    const moved = Math.hypot(x - this.expected[0], y - this.expected[1]);
    return moved > TAKEOVER_PX ? 'you moved the mouse' : null;
  }
}

const RISKY = /\b(send|sending|buy|buying|purchase|pay|paying|checkout|order|delete|deleting|remove|removing|erase|post|posting|publish|submit|submitting|transfer|uninstall|format|shut ?down|log ?out)\b/i;

/** Actions that commit something: Enter, or a click. */
function isCommit(name: string, input: Record<string, unknown>): boolean {
  if (name === 'key') return /\b(Return|KP_Enter|enter)\b/i.test(String(input.text ?? ''));
  return name === 'left_click' || name === 'double_click';
}

/**
 * Asks before a commit-like action when Claude's latest narration sounds irreversible and the
 * user hasn't already approved something in the last few actions.
 */
export function needsConfirm(name: string, input: Record<string, unknown>, narration: string, approvedRecently: boolean): string | null {
  if (approvedRecently || !isCommit(name, input)) return null;
  const m = RISKY.exec(narration);
  if (!m) return null;
  const what = narration.trim().replace(/\s+/g, ' ').slice(0, 160);
  return `This looks like it will ${m[0].toLowerCase()} something: "${what}". Go ahead?`;
}
