"""Status overlay: an animated pill near the bottom of the screen, in the night-sky theme.

The control page sits behind the app you're controlling, so it can't show anything. This window
can, and it must never take keyboard focus (Mars and keystroke mode type into whatever has focus):
it's override-redirect (unmanaged, never focused, above normal windows) with an empty input shape
(clicks go through). A transparent strip across the bottom of the screen; the pill is drawn in it,
so it can grow, shrink, slide and fade without the window moving.

stdin, one JSON object per line (from server/plugin.ts):
  {"state": "listening", "level": 0..1, "text"?: "..."}  Mars or dictation is recording
  {"state": "transcribing"}
  {"state": "working", "text": "..."}    Mars's progress; stays up
  {"state": "confirm", "text": "...", "hint"?: "..."}   Mars asks yes / no; stays up
  {"state": "done", "text": "..."}       Mars's answer; fades after a time that grows with its length
  {"state": "error", "text": "..."}
  {"state": "info", "text": "..."}       a key that was pressed, mouse on/off...; fades quickly
  {"state": "hidden"}
GTK3 + cairo + Pango from the system Python (python3-gi). Look: server/theme.py.
"""

import json
import math
import re
import signal
import sys
import threading
import time

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import GLib, Gtk, Pango  # noqa: E402

import theme as T  # noqa: E402

ACCENT = {
    "listening": T.MINT,
    "transcribing": T.STAR,
    "working": T.INDIGO,
    "confirm": T.AMBER,
    "done": T.MINT,
    "error": T.ROSE,
    "info": T.STAR,
}
DEFAULT_TEXT = {"listening": "Listening…", "transcribing": "Transcribing…", "working": "Working…", "error": "Something went wrong"}
# ms on screen before fading; done/error grow with the text (~60 ms a character, up to 25 s).
HOLD_MS = {"done": 6000, "error": 3500, "info": 1400}
BOTTOM_GAP = 84  # px between the pill and the screen's bottom edge, clear of a dock
STRIP_H = 320  # the window's height: room for a long answer plus the shadow
MAX_TEXT_PX = 680
PAD_X, PAD_Y = 22, 15
ICON = 26  # icon box, px
GAP = 14  # icon ↔ text
FONT_PX = 13.5
# Messages still start with the text-only era's symbols ("●  Listening", "⌨  left"); the pill draws
# its own icon, so a leading symbol + spaces is dropped.
LEADING_SYMBOL = re.compile(r"^[^\w“\"'(\[]+\s+")

win = Gtk.Window(type=Gtk.WindowType.POPUP)
screen = win.get_screen()
visual = screen.get_rgba_visual()
if visual is None or not screen.is_composited():
    print("[overlay] no compositor: the status pill stays off", file=sys.stderr)
    sys.exit(0)
win.set_visual(visual)
win.set_app_paintable(True)
win.set_accept_focus(False)
win.set_keep_above(True)
root_win = screen.get_root_window()
SW, SH = root_win.get_width(), root_win.get_height()
win.move(0, SH - STRIP_H)
win.resize(SW, STRIP_H)


class Pill:
    """What's shown, and the animated values that draw it."""

    def __init__(self):
        self.state = "hidden"
        self.text = ""
        self.hint = ""
        self.level = 0.0  # mic level, smoothed
        self.target_level = 0.0
        self.shown = False
        self.vis = 0.0  # 0 hidden → 1 fully in (slide + fade + scale)
        self.w = 0.0  # animated pill size
        self.h = 0.0
        self.text_in = 1.0  # 0 → 1 after the text changes (fade-in)
        self.accent = T.STAR  # animated accent color
        self.state_at = time.monotonic()
        self.hide_job = None

    def set(self, m: dict):
        state = m.get("state", "hidden")
        if state == "hidden":
            self.shown = False
            return
        text = LEADING_SYMBOL.sub("", str(m.get("text") or DEFAULT_TEXT.get(state, "")))
        if state == "listening":
            self.target_level = float(m.get("level", 0) or 0)
        if text != self.text or state != self.state:
            self.text_in = 0.0 if self.shown else 1.0
            if state != self.state:
                self.state_at = time.monotonic()
        self.state, self.text, self.hint = state, text, str(m.get("hint") or "")
        if not self.shown:
            self.w = self.h = 0.0  # grow from the target size on first show (set in draw)
        self.shown = True
        if self.hide_job:
            GLib.source_remove(self.hide_job)
            self.hide_job = None
        if state in HOLD_MS:
            hold = HOLD_MS[state] if state == "info" else max(HOLD_MS[state], 60 * len(text))
            self.hide_job = GLib.timeout_add(min(hold, 25000), self.timeout)

    def timeout(self):
        self.hide_job = None
        self.shown = False
        kick()
        return False


pill = Pill()
last_tick = time.monotonic()
ticking = False


def kick():
    """Start the 60 fps animation clock (it stops by itself once everything has settled)."""
    global ticking, last_tick
    if not ticking:
        ticking = True
        last_tick = time.monotonic()
        GLib.timeout_add(16, tick)


def tick():
    global ticking, last_tick
    now = time.monotonic()
    dt = min(0.05, now - last_tick)
    last_tick = now
    p = pill
    p.vis = T.approach(p.vis, 1.0 if p.shown else 0.0, dt, 0.07 if p.shown else 0.06)
    p.text_in = T.approach(p.text_in, 1.0, dt, 0.06)
    p.level = T.approach(p.level, p.target_level, dt, 0.05)
    p.accent = tuple(T.approach(a, b, dt, 0.08) for a, b in zip(p.accent, ACCENT.get(p.state, T.STAR)))
    win.queue_draw()
    settled = not p.shown and p.vis < 0.01
    if settled:
        p.vis = 0.0
        ticking = False
        win.queue_draw()
        return False
    return True


# ------------------------------------------------------------------ icons (centered at cx, cy)

def icon(cr, state, cx, cy, rgb, t):
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    if state == "listening":
        # Five bars that follow the mic level, each a little out of phase.
        for i in range(5):
            wob = 0.5 + 0.5 * math.sin(t * 9 + i * 1.3)
            hgt = 5 + (6 + 12 * pill.level) * (0.45 + 0.55 * wob) * (1 - abs(i - 2) * 0.16)
            x = cx - 10 + i * 5
            cr.move_to(x, cy - hgt / 2)
            cr.line_to(x, cy + hgt / 2)
        cr.set_source_rgba(*rgb, 0.95)
        cr.set_line_width(3)
        cr.stroke()
    elif state in ("transcribing", "working"):
        cr.arc(cx, cy, 9, 0, 2 * math.pi)
        cr.set_source_rgba(*rgb, 0.18)
        cr.set_line_width(2.6)
        cr.stroke()
        a = t * 5.2
        sweep = 1.2 + 0.9 * math.sin(t * 2.6)
        cr.arc(cx, cy, 9, a, a + sweep + 0.6)
        cr.set_source_rgba(*rgb, 0.95)
        cr.stroke()
    elif state == "done":
        cr.move_to(cx - 7, cy + 0.5)
        cr.line_to(cx - 2, cy + 5.5)
        cr.line_to(cx + 8, cy - 5.5)
        cr.set_source_rgba(*rgb, 0.95)
        cr.set_line_width(2.8)
        cr.stroke()
    elif state == "error":
        for s in (1, -1):
            cr.move_to(cx - 6, cy - 6 * s)
            cr.line_to(cx + 6, cy + 6 * s)
        cr.set_source_rgba(*rgb, 0.95)
        cr.set_line_width(2.8)
        cr.stroke()
    elif state == "confirm":
        breathe = 0.5 + 0.5 * math.sin(t * 3)
        cr.arc(cx, cy, 10, 0, 2 * math.pi)
        cr.set_source_rgba(*rgb, 0.16 + 0.12 * breathe)
        cr.fill()
        lay = T.layout(cr, "?", 13, weight=Pango.Weight.BOLD)
        w, h = T.size_of(lay)
        T.show(cr, lay, cx - w / 2, cy - h / 2, rgb, 1)
    else:  # info: a four-point star with concave sides
        r = 8.5
        pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
        cr.move_to(*pts[0])
        for i in range(4):
            (px, py), (nx, ny) = pts[i], pts[(i + 1) % 4]
            cr.curve_to(cx + (px - cx) * 0.18, cy + (py - cy) * 0.18, cx + (nx - cx) * 0.18, cy + (ny - cy) * 0.18, nx, ny)
        cr.close_path()
        cr.set_source_rgba(*rgb, 0.95)
        cr.fill()


def keycap(cr, x, y, label, rgb, alpha):
    lay = T.layout(cr, label, 10.5, weight=Pango.Weight.BOLD)
    w, h = T.size_of(lay)
    T.rounded(cr, x, y, w + 14, h + 6, (h + 6) / 2)
    cr.set_source_rgba(*rgb, 0.16 * alpha)
    cr.fill_preserve()
    cr.set_source_rgba(*rgb, 0.55 * alpha)
    cr.set_line_width(1)
    cr.stroke()
    T.show(cr, lay, x + 7, y + 3, rgb, alpha)
    return w + 14


# ------------------------------------------------------------------ draw

def on_draw(_w, cr):
    cr.set_operator(cairo.OPERATOR_SOURCE)
    cr.set_source_rgba(0, 0, 0, 0)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    p = pill
    if p.vis <= 0.001 or not p.text:
        return True
    t = time.monotonic()
    vis = T.ease_out_cubic(p.vis)

    lay = T.layout(cr, p.text, FONT_PX, MAX_TEXT_PX, max_lines=7)
    tw, th = T.size_of(lay)
    hint_lay = T.layout(cr, p.hint, 10.5, MAX_TEXT_PX) if p.hint else None
    hw, hh = T.size_of(hint_lay) if hint_lay else (0, 0)
    caps_w = 0
    if p.state == "confirm":
        caps_w = 2 * 44 + 8 + (10 if hint_lay else 0)
    body_w = max(tw, hw + caps_w)
    body_h = th + ((max(hh, 20) + 8) if (hint_lay or p.state == "confirm") else 0)
    tgt_w = PAD_X * 2 + ICON + GAP + body_w
    tgt_h = max(52, PAD_Y * 2 + body_h)
    if p.w <= 0:
        p.w, p.h = tgt_w, tgt_h
    # Size follows the content smoothly (the clock is running while visible).
    p.w = T.approach(p.w, tgt_w, 1 / 60, 0.07)
    p.h = T.approach(p.h, tgt_h, 1 / 60, 0.07)

    scale = 0.94 + 0.06 * vis
    w, h = p.w, p.h
    x = (SW - w) / 2
    y = STRIP_H - BOTTOM_GAP - h + (1 - vis) * 22
    cx, cy = x + w / 2, y + h / 2
    cr.save()
    cr.translate(cx, cy)
    cr.scale(scale, scale)
    cr.translate(-cx, -cy)
    r = min(h / 2, 26)

    T.shadow(cr, x, y, w, h, r, alpha=vis)
    T.glass(cr, x, y, w, h, r, alpha=vis, border=p.accent, border_alpha=0.32)
    # The accent glows softly behind the icon; listening and questions breathe.
    breathe = 0.5 + 0.5 * math.sin(t * 3.2) if p.state in ("listening", "confirm") else 0.6
    # The icon sits beside the first line of text (centered when there's only one line).
    ix = x + PAD_X + ICON / 2
    iy = y + h / 2 if (body_h <= 24) else y + (h - body_h) / 2 + 10
    cr.save()
    T.rounded(cr, x, y, w, h, r)
    cr.clip()
    T.glow(cr, ix, iy, 46, p.accent, (0.16 + 0.10 * breathe) * vis)
    cr.restore()
    icon(cr, p.state, ix, iy, p.accent, t)

    tx = x + PAD_X + ICON + GAP
    ty = y + (h - body_h) / 2
    T.show(cr, lay, tx, ty, T.INK, vis * (0.35 + 0.65 * T.ease_out_cubic(p.text_in)))
    if p.state == "confirm" or hint_lay:
        hy = ty + th + 8
        hx = tx
        if p.state == "confirm":
            hx += keycap(cr, hx, hy, "Yes", T.MINT, vis) + 8
            hx += keycap(cr, hx, hy, "No", T.MUTED, vis) + 10
        if hint_lay:
            T.show(cr, hint_lay, hx, hy + 3, T.MUTED, vis * 0.9)
    cr.restore()
    return True


# ------------------------------------------------------------------ plumbing

def handle(m: dict):
    pill.set(m)
    kick()
    return False


def read_stdin():
    for line in sys.stdin:
        try:
            GLib.idle_add(handle, json.loads(line))
        except ValueError:
            pass
    GLib.idle_add(quit_)  # server gone


def quit_(*_):
    Gtk.main_quit()
    return False


def keep_on_top():
    gw = win.get_window()
    if gw:
        gw.raise_()
    return True


win.connect("draw", on_draw)
win.show_all()
win.input_shape_combine_region(cairo.Region())  # empty: clicks go through
GLib.timeout_add(1000, keep_on_top)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, quit_)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, quit_)
threading.Thread(target=read_stdin, daemon=True).start()
Gtk.main()
