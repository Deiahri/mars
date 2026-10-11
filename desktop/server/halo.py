"""Pointer overlay: a soft halo instead of the arrow, a glow on the snapped target, the dwell ring,
the accessibility wheel, the zoom-click panel, and a quiet hint chip ("tracking lost", "Next:
double click"). Drawn over everything, and it can't be clicked.

Why not just the arrow: a cursor exactly where you look pulls your eye to it, and the cursor then
chases your eye. A small translucent halo (or, on a snapped target, only a glow around the target)
avoids that loop. The OS arrow is hidden with XFixes while this pointer drives; X shows it again by
itself if this process dies.

The window is override-redirect (never focused: Orion and keystroke mode type into whatever has
focus) and has an empty input shape, so every click goes through to the app underneath.

stdin, one JSON object per line (from server/pointer/brain.ts):
  {"zoomImage": base64 PNG}    the zoom snapshot, before the frame that shows it
  {"arrow": bool, "cursor": {x,y}|null, "style": "halo"|"lost"|"scroll", "glow": rect|null,
   "ring": {x,y,p,kind}|null, "wheel": {"tiles": [rect + id, label, kind], "hover": id|null}|null,
   "zoom": {"from": rect, "to": rect, "k": n}|null, "chip": str|null, "scroll": "up"|"down"|null}
Coordinates are X screen pixels. GTK3 + cairo from the system Python (python3-gi).
"""

import base64
import ctypes
import io
import json
import math
import os
import signal
import sys
import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
import cairo  # noqa: E402
from gi.repository import GLib, Gtk  # noqa: E402

HALO_R = 18
RING_R = 24
GLOW_OUTSET = 4
# Calm palette: soft, low contrast, nothing pure white.
HALO = (0.70, 0.82, 1.00)
GLOW = (0.55, 0.78, 1.00)
RING = {"dwell": (0.55, 0.88, 0.72), "drag": (1.00, 0.78, 0.40)}
PANEL_BG = (0.09, 0.10, 0.12)
TEXT = (0.86, 0.89, 0.93)


class CursorHider:
    """XFixesHideCursor on our own X connection. X undoes it when the connection closes."""

    def __init__(self):
        self.dpy = None
        self.hidden = False
        try:
            x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
            xf = ctypes.cdll.LoadLibrary("libXfixes.so.3")
            x11.XOpenDisplay.restype = ctypes.c_void_p
            x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
            x11.XDefaultRootWindow.restype = ctypes.c_ulong
            x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
            x11.XFlush.argtypes = [ctypes.c_void_p]
            for fn in (xf.XFixesHideCursor, xf.XFixesShowCursor):
                fn.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            self.x11, self.xf = x11, xf
            self.dpy = x11.XOpenDisplay(None)
            self.root = x11.XDefaultRootWindow(self.dpy) if self.dpy else 0
        except OSError as e:
            print(f"[halo] can't hide the arrow ({e}); drawing the halo next to it", file=sys.stderr)

    def set_hidden(self, hide: bool):
        if not self.dpy or hide == self.hidden or os.environ.get("GM_DRY_RUN"):
            return  # GM_DRY_RUN: the pointer doesn't really move, so keep the real arrow
        (self.xf.XFixesHideCursor if hide else self.xf.XFixesShowCursor)(self.dpy, self.root)
        self.x11.XFlush(self.dpy)
        self.hidden = hide


hider = CursorHider()
frame: dict = {}
zoom_img = None  # cairo.ImageSurface of the current zoom snapshot

win = Gtk.Window(type=Gtk.WindowType.POPUP)
screen = win.get_screen()
visual = screen.get_rgba_visual()
if visual is None or not screen.is_composited():
    print("[halo] no compositor: the overlay would cover the screen, so it stays off", file=sys.stderr)
    hider.set_hidden(False)
    sys.exit(0)
win.set_visual(visual)
win.set_app_paintable(True)
win.set_accept_focus(False)
win.set_keep_above(True)
root_win = screen.get_root_window()  # the whole X screen (all monitors), in GTK's logical px
SW, SH = root_win.get_width(), root_win.get_height()
win.move(0, 0)
win.resize(SW, SH)


def rounded(cr, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def text(cr, s, cx, cy, size, rgba):
    cr.select_font_face("Ubuntu", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(size)
    ext = cr.text_extents(s)
    cr.move_to(cx - ext.width / 2 - ext.x_bearing, cy - ext.height / 2 - ext.y_bearing)
    cr.set_source_rgba(*rgba)
    cr.show_text(s)


def draw_wheel(cr, wh):
    tiles = wh.get("tiles") or []
    if not tiles:
        return
    hover = wh.get("hover")
    center = next((t for t in tiles if t["kind"] == "back"), tiles[-1])
    cx, cy = center["x"] + center["w"] / 2, center["y"] + center["h"] / 2
    reach = max(math.hypot(px - cx, py - cy) for t in tiles for px in (t["x"], t["x"] + t["w"]) for py in (t["y"], t["y"] + t["h"]))
    # A dim disc behind, so the tiles read over any page.
    grad = cairo.RadialGradient(cx, cy, 0, cx, cy, reach + 24)
    grad.add_color_stop_rgba(0, *PANEL_BG, 0.62)
    grad.add_color_stop_rgba(0.85, *PANEL_BG, 0.5)
    grad.add_color_stop_rgba(1, *PANEL_BG, 0.0)
    cr.arc(cx, cy, reach + 24, 0, 2 * math.pi)
    cr.set_source(grad)
    cr.fill()
    for t in tiles:
        x, y, w, h = t["x"], t["y"], t["w"], t["h"]
        on = t["id"] == hover
        r = h / 2 if t["kind"] == "back" else 14
        rounded(cr, x, y, w, h, r)
        cr.set_source_rgba(*(GLOW + (0.32,) if on else PANEL_BG + (0.85,)))
        cr.fill()
        rounded(cr, x, y, w, h, r)
        cr.set_source_rgba(*(GLOW + (0.95,) if on else (1, 1, 1, 0.16)))
        cr.set_line_width(2.5 if on else 1)
        cr.stroke()
        label = t["label"] + (" ›" if t["kind"] == "sub" else "")
        size = max(11, h * (0.2 if t["kind"] == "back" else 0.24))
        lines = wrap(cr, label, w - 12, size)
        for i, line in enumerate(lines):
            dy = (i - (len(lines) - 1) / 2) * size * 1.2
            text(cr, line, x + w / 2, y + h / 2 + dy, size, (*TEXT, 1.0 if on else 0.85))


def wrap(cr, s, width, size):
    """Up to two lines that fit `width`."""
    cr.select_font_face("Ubuntu", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(size)
    if cr.text_extents(s).width <= width or " " not in s:
        return [s]
    words = s.split(" ")
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        wid = max(cr.text_extents(a).width, cr.text_extents(b).width)
        if best is None or wid < best[0]:
            best = (wid, [a, b])
    return best[1]


def draw_zoom(cr, z):
    if zoom_img is None:
        return
    to, k = z["to"], z["k"]
    x, y, w, h = to["x"], to["y"], to["w"], to["h"]
    # A soft shadow, the magnified snapshot, then a clear edge.
    for grow, alpha in ((14, 0.10), (8, 0.16), (3, 0.25)):
        rounded(cr, x - grow, y - grow, w + 2 * grow, h + 2 * grow, 14 + grow)
        cr.set_source_rgba(0, 0, 0, alpha)
        cr.fill()
    cr.save()
    rounded(cr, x, y, w, h, 14)
    cr.clip()
    cr.translate(x, y)
    cr.scale(k, k)
    cr.set_source_surface(zoom_img, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_GOOD)
    cr.paint()
    cr.restore()
    rounded(cr, x, y, w, h, 14)
    cr.set_source_rgba(*GLOW, 0.9)
    cr.set_line_width(2.5)
    cr.stroke()
    note = f"Zoom {k}× · Left / Right click here · Menu cancels"
    cr.select_font_face("Ubuntu", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(13)
    nw = cr.text_extents(note).width + 22
    rounded(cr, x + 10, y + 10, nw, 26, 13)
    cr.set_source_rgba(*PANEL_BG, 0.8)
    cr.fill()
    text(cr, note, x + 10 + nw / 2, y + 23, 13, (*TEXT, 0.9))


def draw_glow(cr, g):
    x, y, w, h = g["x"] - GLOW_OUTSET, g["y"] - GLOW_OUTSET, g["w"] + 2 * GLOW_OUTSET, g["h"] + 2 * GLOW_OUTSET
    # A soft outer bloom, then a thin clear edge: reads as the target "lifting" slightly.
    for width, alpha in ((10, 0.08), (6, 0.14)):
        rounded(cr, x, y, w, h, 10)
        cr.set_source_rgba(*GLOW, alpha)
        cr.set_line_width(width)
        cr.stroke()
    rounded(cr, x, y, w, h, 10)
    cr.set_source_rgba(*GLOW, 0.75)
    cr.set_line_width(2)
    cr.stroke()
    rounded(cr, x, y, w, h, 10)
    cr.set_source_rgba(*GLOW, 0.06)
    cr.fill()


def draw_cursor(cr, c, style, scroll):
    x, y = c["x"], c["y"]
    if style == "lost":
        cr.set_dash([4, 4])
        cr.arc(x, y, HALO_R, 0, 2 * math.pi)
        cr.set_source_rgba(0.7, 0.7, 0.72, 0.55)
        cr.set_line_width(1.5)
        cr.stroke()
        cr.set_dash([])
        return
    grad = cairo.RadialGradient(x, y, 0, x, y, HALO_R)
    grad.add_color_stop_rgba(0, *HALO, 0.30)
    grad.add_color_stop_rgba(0.7, *HALO, 0.18)
    grad.add_color_stop_rgba(1, *HALO, 0.0)
    cr.arc(x, y, HALO_R, 0, 2 * math.pi)
    cr.set_source(grad)
    cr.fill()
    cr.arc(x, y, HALO_R - 4, 0, 2 * math.pi)
    cr.set_source_rgba(0, 0, 0, 0.14)  # faint edge for light pages
    cr.set_line_width(2)
    cr.stroke()
    cr.arc(x, y, HALO_R - 4, 0, 2 * math.pi)
    cr.set_source_rgba(*HALO, 0.40)
    cr.set_line_width(1)
    cr.stroke()
    if style == "scroll":
        # Two soft chevrons; the one you're scrolling toward is brighter.
        for d, sign in (("up", -1), ("down", 1)):
            cy = y + sign * (HALO_R + 12)
            cr.move_to(x - 9, cy - sign * 4)
            cr.line_to(x, cy + sign * 4)
            cr.line_to(x + 9, cy - sign * 4)
            cr.set_source_rgba(*HALO, 0.9 if scroll == d else 0.35)
            cr.set_line_width(3)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.stroke()


def draw_ring(cr, r):
    x, y, p = r["x"], r["y"], max(0.0, min(1.0, r["p"]))
    # A faint dark under-stroke so the ring reads on light pages too, then the track.
    cr.arc(x, y, RING_R, 0, 2 * math.pi)
    cr.set_source_rgba(0, 0, 0, 0.18)
    cr.set_line_width(5)
    cr.stroke()
    cr.arc(x, y, RING_R, 0, 2 * math.pi)
    cr.set_source_rgba(1, 1, 1, 0.14)
    cr.set_line_width(3)
    cr.stroke()
    start = -math.pi / 2
    cr.arc(x, y, RING_R, start, start + p * 2 * math.pi)
    cr.set_source_rgba(*RING.get(r.get("kind"), RING["dwell"]), 0.85)
    cr.set_line_width(3)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.stroke()


def draw_chip(cr, s, c):
    cr.select_font_face("Ubuntu", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(12)
    ext = cr.text_extents(s)
    w, h = ext.width + 20, 24
    x = min(max(8, c["x"] - w / 2), SW - w - 8) if c else (SW - w) / 2
    y = (c["y"] + HALO_R + 10) if c else 40
    rounded(cr, x, y, w, h, 12)
    cr.set_source_rgba(*PANEL_BG, 0.75)
    cr.fill()
    text(cr, s, x + w / 2, y + h / 2, 12, (*TEXT, 0.8))


def on_draw(_w, cr):
    cr.set_operator(cairo.OPERATOR_SOURCE)
    cr.set_source_rgba(0, 0, 0, 0)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    scale = win.get_scale_factor()
    if scale != 1:
        cr.scale(1 / scale, 1 / scale)
    f = frame
    if f.get("zoom"):
        draw_zoom(cr, f["zoom"])
    if f.get("wheel"):
        draw_wheel(cr, f["wheel"])
    if f.get("glow"):
        draw_glow(cr, f["glow"])
    if f.get("cursor"):
        draw_cursor(cr, f["cursor"], f.get("style"), f.get("scroll"))
    if f.get("ring"):
        draw_ring(cr, f["ring"])
    if f.get("chip"):
        draw_chip(cr, f["chip"], f.get("cursor"))
    return True


def handle(m: dict):
    global frame, zoom_img
    if "zoomImage" in m:
        try:
            zoom_img = cairo.ImageSurface.create_from_png(io.BytesIO(base64.b64decode(m["zoomImage"])))
        except Exception as e:  # noqa: BLE001
            print(f"[halo] bad zoom image: {e}", file=sys.stderr)
            zoom_img = None
    else:
        frame = m
        hider.set_hidden(not m.get("arrow", True))
    win.queue_draw()
    return False


def read_stdin():
    for line in sys.stdin:
        try:
            GLib.idle_add(handle, json.loads(line))
        except ValueError:
            pass
    GLib.idle_add(quit_)  # server gone


def quit_(*_):
    hider.set_hidden(False)
    Gtk.main_quit()
    return False


def keep_on_top():
    # Override-redirect windows aren't restacked by the window manager; a newer one could cover us.
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
