// The accessibility wheel: the phone's Menu button opens it around the pointer. Four tiles per
// level (top, right, bottom, left) around a center tile that closes it (or goes back from a
// submenu). Point at a tile and press Left, or dwell on it. Big, few, and far apart, so it works
// with gaze and two or three switches. Pure: the brain (brain.ts) does the opening and acting.

import type { Pt } from './motion.ts';
import type { Target } from './snap.ts';

export type MenuItem = { id: string; label: string; sub?: MenuItem[] };

/** What the labels show. */
export type MenuState = {
  dwell: boolean;
  snap: boolean;
  ai: 'n/a' | 'on' | 'off';
  keys: 'n/a' | 'on' | 'off' | '…';
  /** The "Hey Orion" listener (server/wake.ts). */
  wake: 'n/a' | 'on' | 'off' | '…';
  /** Orion's spoken answers (server/voice.ts). */
  tts: 'n/a' | 'on' | 'off';
  /** Orion can run (API keys there). */
  orion: boolean;
  /** Dictation can run (ElevenLabs key there). */
  dictate: boolean;
  zoomK: number;
};

export type WheelTile = Target & { label: string; kind: 'action' | 'sub' | 'back' };

const onOff = (b: boolean) => (b ? 'on' : 'off');

/** The menu, top-level first. Each list is in tile order: top, right, bottom, left. */
export function buildMenu(s: MenuState): MenuItem[] {
  return [
    { id: 'zoom', label: 'Zoom' },
    {
      id: 'click',
      label: 'Click',
      sub: [
        { id: 'double', label: 'Double click' },
        { id: 'drag', label: 'Drag & drop' },
        { id: 'triple', label: 'Triple click' },
        { id: 'middle', label: 'Middle click' },
      ],
    },
    { id: 'scroll', label: 'Scroll' },
    {
      id: 'more',
      label: 'More',
      sub: [
        { id: 'dictate', label: s.dictate ? 'Dictate' : 'Dictate (off)' },
        { id: 'orion', label: s.orion ? 'Orion' : 'Orion (off)' },
        {
          id: 'settings',
          label: 'Settings',
          sub: [
            { id: 'dwell', label: `Dwell: ${onOff(s.dwell)}` },
            // One step for both: AI targets only matter with snapping on. off → on → on + AI.
            { id: 'snap', label: `Snap: ${!s.snap ? 'off' : s.ai === 'on' ? 'on + AI' : 'on'}` },
            {
              id: 'voice',
              label: 'Voice',
              sub: [
                { id: 'wake', label: `Hey Orion: ${s.wake}` },
                { id: 'tts', label: `Orion speaks: ${s.tts}` },
                { id: 'keys', label: `Keys: ${s.keys}` },
              ],
            },
            { id: 'zoomk', label: `Zoom: ${s.zoomK}×` },
          ],
        },
        { id: 'pause', label: 'Pause' },
      ],
    },
  ];
}

/** The items shown after opening the submenus in `path` (ids), or null if the path is gone. */
export function menuAt(menu: MenuItem[], path: string[]): MenuItem[] | null {
  let items = menu;
  for (const id of path) {
    const sub = items.find((i) => i.id === id)?.sub;
    if (!sub) return null;
    items = sub;
  }
  return items;
}

/**
 * Tiles around `at`, moved in as needed so the whole wheel is on screen. Tile ids are
 * `wheel:<item id>`, and `wheel:back` for the center.
 */
export function wheelLayout(at: Pt, items: MenuItem[], centerLabel: string, w: number, h: number): { center: Pt; tiles: WheelTile[] } {
  const th = Math.min(96, Math.max(56, Math.round(h * 0.09)));
  const tw = Math.round(th * 1.9);
  const gap = Math.round(th * 0.4);
  const reachX = th / 2 + gap + tw;
  const reachY = th / 2 + gap + th;
  const m = 8;
  const cx = Math.round(Math.min(w - m - reachX, Math.max(m + reachX, at.x)));
  const cy = Math.round(Math.min(h - m - reachY, Math.max(m + reachY, at.y)));
  const slots = [
    { x: cx - tw / 2, y: cy - th / 2 - gap - th }, // top
    { x: cx + th / 2 + gap, y: cy - th / 2 }, // right
    { x: cx - tw / 2, y: cy + th / 2 + gap }, // bottom
    { x: cx - th / 2 - gap - tw, y: cy - th / 2 }, // left
  ];
  const tiles: WheelTile[] = items.slice(0, 4).map((item, i) => ({
    id: `wheel:${item.id}`,
    label: item.label,
    kind: item.sub ? 'sub' : 'action',
    x: Math.round(slots[i].x),
    y: Math.round(slots[i].y),
    w: tw,
    h: th,
  }));
  tiles.push({ id: 'wheel:back', label: centerLabel, kind: 'back', x: Math.round(cx - th / 2), y: Math.round(cy - th / 2), w: th, h: th });
  return { center: { x: cx, y: cy }, tiles };
}
