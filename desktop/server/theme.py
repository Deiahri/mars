"""The overlays' look: a night sky. Deep navy glass, starlight-blue glow, one warm accent.

Shared by overlay.py (the status pill) and halo.py (halo, wheel, zoom). Colors are (r, g, b) in
0..1; pass alpha separately. Also easing and the drawing helpers both use.
"""

import math

import cairo
import gi

gi.require_version("Pango", "1.0")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Pango, PangoCairo  # noqa: E402


def hex_rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


NAVY = hex_rgb("#0b1230")       # glass panels
NAVY_HI = hex_rgb("#18225a")    # top of the panel gradient
INK = hex_rgb("#eef2ff")        # text
MUTED = hex_rgb("#9aa6c8")      # secondary text
STAR = hex_rgb("#9cc4ff")       # starlight: the halo, focus, hover
INDIGO = hex_rgb("#6c7cff")     # working
AMBER = hex_rgb("#ffc46b")      # the one warm accent: questions, drag
MINT = hex_rgb("#7be0b0")       # listening, done, dwell
ROSE = hex_rgb("#ff7a85")       # errors

FONT = "Ubuntu Sans"
GLASS_ALPHA = 0.95


# ------------------------------------------------------------------ motion

def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def ease_out_cubic(t: float) -> float:
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_out_back(t: float, s: float = 1.4) -> float:
    """Overshoots a touch, then settles: for things popping in."""
    t = clamp01(t) - 1
    return t * t * ((s + 1) * t + s) + 1


def approach(cur: float, target: float, dt: float, tau: float) -> float:
    """Exponential smoothing toward `target` (frame-rate independent; τ in seconds)."""
    if tau <= 0:
        return target
    return target + (cur - target) * math.exp(-dt / tau)


# ------------------------------------------------------------------ drawing

def rounded(cr, x, y, w, h, r):
    r = max(0.0, min(r, w / 2, h / 2))
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def shadow(cr, x, y, w, h, r, alpha=1.0, spread=14, dy=6):
    """A soft drop shadow: stacked, growing, fading rounded rects (cairo has no blur)."""
    steps = 7
    for i in range(steps, 0, -1):
        g = spread * i / steps
        rounded(cr, x - g, y - g + dy, w + 2 * g, h + 2 * g, r + g)
        cr.set_source_rgba(0.0, 0.01, 0.06, 0.055 * alpha)
        cr.fill()


def glass(cr, x, y, w, h, r, alpha=1.0, border=STAR, border_alpha=0.22):
    """A night-sky glass panel: navy gradient, starlight hairline border, a highlight along the top."""
    grad = cairo.LinearGradient(0, y, 0, y + h)
    grad.add_color_stop_rgba(0, *NAVY_HI, GLASS_ALPHA * alpha)
    grad.add_color_stop_rgba(1, *NAVY, GLASS_ALPHA * alpha)
    rounded(cr, x, y, w, h, r)
    cr.set_source(grad)
    cr.fill()
    rounded(cr, x + 0.5, y + 0.5, w - 1, h - 1, r)
    cr.set_source_rgba(*border, border_alpha * alpha)
    cr.set_line_width(1)
    cr.stroke()
    # The top highlight: a thin bright line that fades out toward the sides.
    hl = cairo.LinearGradient(x, 0, x + w, 0)
    hl.add_color_stop_rgba(0, 1, 1, 1, 0)
    hl.add_color_stop_rgba(0.5, 1, 1, 1, 0.16 * alpha)
    hl.add_color_stop_rgba(1, 1, 1, 1, 0)
    cr.move_to(x + r, y + 1.5)
    cr.line_to(x + w - r, y + 1.5)
    cr.set_source(hl)
    cr.set_line_width(1)
    cr.stroke()


def glow(cr, cx, cy, radius, rgb, alpha):
    """A soft radial glow (behind icons, around the halo)."""
    g = cairo.RadialGradient(cx, cy, 0, cx, cy, radius)
    g.add_color_stop_rgba(0, *rgb, alpha)
    g.add_color_stop_rgba(1, *rgb, 0)
    cr.arc(cx, cy, radius, 0, 2 * math.pi)
    cr.set_source(g)
    cr.fill()


def layout(cr, text: str, size: float, width: float | None = None, weight=Pango.Weight.NORMAL, max_lines=0, align=Pango.Alignment.LEFT):
    """A Pango layout for `text` (wraps at `width` px; ellipsizes after `max_lines` if > 0)."""
    lay = PangoCairo.create_layout(cr)
    desc = Pango.FontDescription(f"{FONT} {size}")
    desc.set_weight(weight)
    lay.set_font_description(desc)
    lay.set_text(text, -1)
    lay.set_alignment(align)
    if width:
        lay.set_width(int(width * Pango.SCALE))
        lay.set_wrap(Pango.WrapMode.WORD_CHAR)
    if max_lines:
        lay.set_height(-max_lines)
        lay.set_ellipsize(Pango.EllipsizeMode.END)
    return lay


def size_of(lay) -> tuple[float, float]:
    w, h = lay.get_pixel_size()
    return float(w), float(h)


def show(cr, lay, x, y, rgb, alpha=1.0):
    cr.move_to(x, y)
    cr.set_source_rgba(*rgb, alpha)
    PangoCairo.show_layout(cr, lay)
