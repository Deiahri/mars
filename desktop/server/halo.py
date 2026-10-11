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
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
import cairo  # noqa: E402
from gi.repository import GLib, Gtk  # noqa: E402

import theme as T  # noqa: E402

HALO_R = 18
RING_R = 24
GLOW_OUTSET = 4
# Calm palette (server/theme.py, Orion night sky): soft, low contrast, nothing pure white.
HALO = T.STAR
GLOW = T.STAR
RING = {"dwell": T.MINT, "drag": T.AMBER}
PANEL_BG = T.NAVY
TEXT = T.INK
# Animation lengths, seconds.
WHEEL_IN, WHEEL_STAGGER, WHEEL_OUT = 0.22, 0.03, 0.14
ZOOM_IN, ZOOM_OUT = 0.22, 0.14
GLOW_IN, CHIP_IN = 0.14, 0.16


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


rounded = T.rounded


class Anim:
    """When things appeared or went away, so they can ease in and out (timestamps, seconds)."""

    def __init__(self):
        self.now = time.monotonic()
        self.last_draw = self.now
        self.wheel = None  # the wheel being drawn (kept a moment after it closes, to fade out)
        self.wheel_sig = None
        self.wheel_at = 0.0
        self.wheel_gone = None  # when it closed
        self.hover = {}  # tile id → 0..1, eased
        self.zoom = None
        self.zoom_sig = None
        self.zoom_at = 0.0
        self.zoom_gone = None
        self.glow = None
        self.glow_sig = None
        self.glow_at = 0.0
        self.glow_gone = None
        self.chip = None
        self.chip_at = 0.0

    def update(self, f: dict):
        """A new frame from brain.ts: stamp what opened, changed or closed."""
        now = time.monotonic()
        wh = f.get("wheel")
        if wh and wh.get("tiles"):
            sig = tuple(t["id"] for t in wh["tiles"]) + tuple(round(t["x"]) for t in wh["tiles"][-1:])
            if sig != self.wheel_sig:
                self.wheel_sig, self.wheel_at = sig, now
                self.hover = {}
            self.wheel, self.wheel_gone = wh, None
        elif self.wheel is not None and self.wheel_gone is None:
            self.wheel_gone, self.wheel_sig = now, None
        z = f.get("zoom")
        if z:
            sig = (tuple(z["to"].values()), z["k"])
            if sig != self.zoom_sig:
                self.zoom_sig, self.zoom_at = sig, now
            self.zoom, self.zoom_gone = z, None
        elif self.zoom is not None and self.zoom_gone is None:
            self.zoom_gone, self.zoom_sig = now, None
        g = f.get("glow")
        if g:
            sig = (g["x"], g["y"], g["w"], g["h"])
            if sig != self.glow_sig:
                self.glow_sig, self.glow_at = sig, now
            self.glow, self.glow_gone = g, None
        elif self.glow is not None and self.glow_gone is None:
            self.glow_gone, self.glow_sig = now, None
        chip = f.get("chip")
        if chip != self.chip:
            self.chip, self.chip_at = chip, now

    def busy(self) -> bool:
        """Something is still moving (keep the 60 fps clock running)."""
        now = time.monotonic()
        if self.wheel is not None and (now - self.wheel_at < WHEEL_IN + 6 * WHEEL_STAGGER or self.wheel_gone is not None):
            return True
        if any(0.01 < v < 0.99 for v in self.hover.values()) or (self.wheel and self.wheel.get("hover") and self.hover.get(self.wheel["hover"], 0) < 0.99):
            return True
        if self.zoom is not None and (now - self.zoom_at < ZOOM_IN or self.zoom_gone is not None):
            return True
        if self.glow is not None:
            return True  # it breathes
        return self.chip is not None and now - self.chip_at < CHIP_IN


anim = Anim()


def label(cr, s, x, y, w, h, size, alpha):
    """Centered, up to two lines (Pango wraps and ellipsizes)."""
    lay = T.layout(cr, s, size, w - 16, max_lines=2, align=T.Pango.Alignment.CENTER)
    lw, lh = T.size_of(lay)
    T.show(cr, lay, x + 8, y + (h - lh) / 2, TEXT, alpha)


def draw_wheel(cr, wh, now, dt):
    tiles = wh.get("tiles") or []
    if not tiles:
        return
    out = 1.0
    if anim.wheel_gone is not None:
        out = 1 - T.clamp01((now - anim.wheel_gone) / WHEEL_OUT)
        if out <= 0:
            anim.wheel = None
            return
    hover = wh.get("hover") if anim.wheel_gone is None else None
    center = next((t for t in tiles if t["kind"] == "back"), tiles[-1])
    cx, cy = center["x"] + center["w"] / 2, center["y"] + center["h"] / 2
    reach = max(math.hypot(px - cx, py - cy) for t in tiles for px in (t["x"], t["x"] + t["w"]) for py in (t["y"], t["y"] + t["h"]))
    since = now - anim.wheel_at
    disc = T.ease_out_cubic(since / WHEEL_IN) * out
    # A dim navy disc behind, so the tiles read over any page; it swells in with the tiles.
    rad = (reach + 30) * (0.8 + 0.2 * disc)
    grad = cairo.RadialGradient(cx, cy, 0, cx, cy, rad)
    grad.add_color_stop_rgba(0, *PANEL_BG, 0.66 * disc)
    grad.add_color_stop_rgba(0.8, *PANEL_BG, 0.5 * disc)
    grad.add_color_stop_rgba(1, *PANEL_BG, 0.0)
    cr.arc(cx, cy, rad, 0, 2 * math.pi)
    cr.set_source(grad)
    cr.fill()
    # The center tile first, then the four around it, a beat apart.
    order = [center] + [t for t in tiles if t is not center]
    for i, t in enumerate(order):
        x, y, w, h = t["x"], t["y"], t["w"], t["h"]
        hv = anim.hover.get(t["id"], 0.0)
        hv = T.approach(hv, 1.0 if t["id"] == hover else 0.0, dt, 0.05)
        anim.hover[t["id"]] = hv
        pop = T.clamp01((since - i * WHEEL_STAGGER) / WHEEL_IN)
        scale = (0.86 + 0.14 * T.ease_out_back(pop)) * (1 + 0.045 * hv)
        alpha = T.ease_out_cubic(pop) * out
        if alpha <= 0.01:
            continue
        tx, ty = x + w / 2, y + h / 2
        # Each tile also drifts out from the center as it pops in.
        drift = (1 - T.ease_out_cubic(pop)) * 0.25
        cr.save()
        cr.translate(tx + (cx - tx) * drift, ty + (cy - ty) * drift)
        cr.scale(scale, scale)
        cr.translate(-tx, -ty)
        r = h / 2 if t["kind"] == "back" else 16
        T.shadow(cr, x, y, w, h, r, alpha=alpha * 0.8, spread=10, dy=4)
        T.glass(cr, x, y, w, h, r, alpha=alpha, border=GLOW, border_alpha=0.22 + 0.7 * hv)
        if hv > 0.01:
            rounded(cr, x, y, w, h, r)
            cr.set_source_rgba(*GLOW, 0.22 * hv * alpha)
            cr.fill()
            rounded(cr, x - 1, y - 1, w + 2, h + 2, r + 1)
            cr.set_source_rgba(*GLOW, 0.9 * hv * alpha)
            cr.set_line_width(2.2)
            cr.stroke()
        text = t["label"] + ("  ›" if t["kind"] == "sub" else "")
        size = max(10.5, h * (0.17 if t["kind"] == "back" else 0.2))
        label(cr, text, x, y, w, h, size, (0.86 + 0.14 * hv) * alpha)
        cr.restore()


def draw_zoom(cr, z, now):
    if zoom_img is None:
        return
    out = 1.0
    if anim.zoom_gone is not None:
        out = 1 - T.clamp01((now - anim.zoom_gone) / ZOOM_OUT)
        if out <= 0:
            anim.zoom = None
            return
    grow = T.ease_out_cubic((now - anim.zoom_at) / ZOOM_IN)
    to, k = z["to"], z["k"]
    fr = z.get("from") or to
    # The panel grows out of the spot it magnifies.
    x = fr["x"] + (to["x"] - fr["x"]) * grow
    y = fr["y"] + (to["y"] - fr["y"]) * grow
    w = fr["w"] + (to["w"] - fr["w"]) * grow
    h = fr["h"] + (to["h"] - fr["h"]) * grow
    alpha = (0.3 + 0.7 * grow) * out
    T.shadow(cr, x, y, w, h, 16, alpha=alpha, spread=16, dy=6)
    cr.save()
    rounded(cr, x, y, w, h, 16)
    cr.clip()
    cr.translate(x, y)
    cr.scale(k * w / to["w"], k * h / to["h"])
    cr.set_source_surface(zoom_img, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_GOOD)
    cr.paint_with_alpha(alpha)
    cr.restore()
    rounded(cr, x, y, w, h, 16)
    cr.set_source_rgba(*GLOW, 0.85 * alpha)
    cr.set_line_width(2.5)
    cr.stroke()
    if grow > 0.6:
        note = f"Zoom {k}×  ·  Left / Right click here  ·  Menu cancels"
        lay = T.layout(cr, note, 11.5)
        nw, nh = T.size_of(lay)
        a = alpha * T.clamp01((grow - 0.6) / 0.4)
        T.glass(cr, x + 12, y + 12, nw + 24, nh + 10, (nh + 10) / 2, alpha=a)
        T.show(cr, lay, x + 24, y + 17, TEXT, 0.92 * a)


def draw_glow(cr, g, now):
    out = 1.0
    if anim.glow_gone is not None:
        out = 1 - T.clamp01((now - anim.glow_gone) / GLOW_IN)
        if out <= 0:
            anim.glow = None
            return
    fade = T.ease_out_cubic((now - anim.glow_at) / GLOW_IN) * out
    breathe = 0.85 + 0.15 * math.sin(now * 2.4)
    x, y, w, h = g["x"] - GLOW_OUTSET, g["y"] - GLOW_OUTSET, g["w"] + 2 * GLOW_OUTSET, g["h"] + 2 * GLOW_OUTSET
    # A soft outer bloom, then a thin clear edge: reads as the target "lifting" slightly.
    for width, alpha in ((12, 0.07), (7, 0.13)):
        rounded(cr, x, y, w, h, 10)
        cr.set_source_rgba(*GLOW, alpha * fade * breathe)
        cr.set_line_width(width)
        cr.stroke()
    rounded(cr, x, y, w, h, 10)
    cr.set_source_rgba(*GLOW, 0.78 * fade)
    cr.set_line_width(2)
    cr.stroke()
    rounded(cr, x, y, w, h, 10)
    cr.set_source_rgba(*GLOW, 0.07 * fade)
    cr.fill()


def draw_cursor(cr, c, style, scroll):
    x, y = c["x"], c["y"]
    if style == "lost":
        cr.set_dash([4, 4])
        cr.arc(x, y, HALO_R, 0, 2 * math.pi)
        cr.set_source_rgba(*T.MUTED, 0.6)
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
    cr.set_source_rgba(0, 0.01, 0.06, 0.16)  # faint edge for light pages
    cr.set_line_width(2)
    cr.stroke()
    cr.arc(x, y, HALO_R - 4, 0, 2 * math.pi)
    cr.set_source_rgba(*HALO, 0.45)
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
    cr.set_source_rgba(0, 0.01, 0.06, 0.2)
    cr.set_line_width(5)
    cr.stroke()
    cr.arc(x, y, RING_R, 0, 2 * math.pi)
    cr.set_source_rgba(*T.INK, 0.14)
    cr.set_line_width(3)
    cr.stroke()
    start = -math.pi / 2
    rgb = RING.get(r.get("kind"), RING["dwell"])
    cr.arc(x, y, RING_R, start, start + p * 2 * math.pi)
    cr.set_source_rgba(*rgb, 0.9)
    cr.set_line_width(3)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.stroke()
    # A small bright bead on the leading end.
    a = start + p * 2 * math.pi
    T.glow(cr, x + RING_R * math.cos(a), y + RING_R * math.sin(a), 6, rgb, 0.8 * p)


def draw_chip(cr, s, c, now):
    fade = T.ease_out_cubic((now - anim.chip_at) / CHIP_IN)
    lay = T.layout(cr, s, 11)
    tw, th = T.size_of(lay)
    w, h = tw + 24, th + 10
    x = min(max(8, c["x"] - w / 2), SW - w - 8) if c else (SW - w) / 2
    y = ((c["y"] + HALO_R + 10) if c else 40) + (1 - fade) * 6
    T.glass(cr, x, y, w, h, h / 2, alpha=0.9 * fade)
    T.show(cr, lay, x + 12, y + 5, TEXT, 0.88 * fade)


def on_draw(_w, cr):
    cr.set_operator(cairo.OPERATOR_SOURCE)
    cr.set_source_rgba(0, 0, 0, 0)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    scale = win.get_scale_factor()
    if scale != 1:
        cr.scale(1 / scale, 1 / scale)
    f = frame
    now = time.monotonic()
    dt = min(0.05, now - anim.last_draw)
    anim.last_draw = now
    if anim.zoom is not None:
        draw_zoom(cr, anim.zoom, now)
    if anim.wheel is not None:
        draw_wheel(cr, anim.wheel, now, dt)
    if anim.glow is not None:
        draw_glow(cr, anim.glow, now)
    if f.get("cursor"):
        draw_cursor(cr, f["cursor"], f.get("style"), f.get("scroll"))
    if f.get("ring"):
        draw_ring(cr, f["ring"])
    if f.get("chip"):
        draw_chip(cr, f["chip"], f.get("cursor"), now)
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
        anim.update(m)
        hider.set_hidden(not m.get("arrow", True))
    win.queue_draw()
    kick()
    return False


ticking = False


def kick():
    """Run a 60 fps redraw clock while something animates (frames from brain.ts redraw anyway)."""
    global ticking
    if not ticking and anim.busy():
        ticking = True
        GLib.timeout_add(16, tick)


def tick():
    global ticking
    win.queue_draw()
    if anim.busy():
        return True
    ticking = False
    win.queue_draw()  # one last frame, so a fade ends fully gone
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
