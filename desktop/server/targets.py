"""Clickable things on screen, from the accessibility tree (AT-SPI), for the pointer's snapping.

Every SCAN_MS (and right after "rescan" on stdin) it walks the active window's tree and prints the
buttons, links, menu items, fields... that are showing, with their screen rectangles:
  {"targets": [["path", x, y, w, h], ...], "app": "Firefox", "ms": 41}
"path" is the child-index path from the window, so the same button keeps its id between scans.

stdin, one word per line: "rescan" (something was clicked or scrolled), "on" / "off" (snapping
toggled; off = stop scanning). Apps only expose their tree when accessibility is on: see the README.
System Python with python3-gi (AT-SPI comes with GNOME).
"""

import json
import sys
import threading
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

SCAN_MS = 500
MAX_NODES = 1500
BUDGET_S = 0.25
MIN_PX = 6

ROLE_NAMES = """PUSH_BUTTON TOGGLE_BUTTON CHECK_BOX RADIO_BUTTON LINK MENU_ITEM CHECK_MENU_ITEM
RADIO_MENU_ITEM MENU PAGE_TAB COMBO_BOX ENTRY PASSWORD_TEXT SPIN_BUTTON SLIDER LIST_ITEM TREE_ITEM
ICON PUSH_BUTTON_MENU""".split()
CLICKABLE = {getattr(Atspi.Role, n) for n in ROLE_NAMES if hasattr(Atspi.Role, n)}
S = Atspi.StateType
# Not the window you're using: GNOME draws X11 title bars in mutter-x11-frames, whose frame window
# is "active" too (with frame-local 0,0 coordinates), and gnome-shell is the desktop itself.
SKIP_APPS = {"mutter-x11-frames", "gnome-shell"}

wake = threading.Event()
enabled = True


def read_stdin():
    global enabled
    for line in sys.stdin:
        cmd = line.strip()
        if cmd == "off":
            enabled = False
        elif cmd == "on":
            enabled = True
        wake.set()
    sys.exit(0)


def active_window():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            if app.get_name() in SKIP_APPS:
                continue
            for j in range(app.get_child_count()):
                win = app.get_child_at_index(j)
                if win is not None and win.get_state_set().contains(S.ACTIVE):
                    return app, win
        except Exception:  # an app that hangs or quits mid-walk
            continue
    return None, None


def scan(win, sw, sh):
    out = []
    queue = [(win, "w")]
    seen = 0
    deadline = time.monotonic() + BUDGET_S
    while queue and seen < MAX_NODES and time.monotonic() < deadline:
        node, path = queue.pop(0)
        seen += 1
        try:
            states = node.get_state_set()
            if not states.contains(S.SHOWING):
                continue  # hidden: so are its children
            role = node.get_role()
            if role in CLICKABLE or (path != "w" and "Action" in (node.get_interfaces() or [])):
                r = node.get_extents(Atspi.CoordType.SCREEN)
                if MIN_PX <= r.width <= sw / 2 and MIN_PX <= r.height <= sh / 2 and r.x < sw and r.y < sh and r.x + r.width > 0 and r.y + r.height > 0:
                    out.append([path, r.x, r.y, r.width, r.height])
            for i in range(node.get_child_count()):
                child = node.get_child_at_index(i)
                if child is not None:
                    queue.append((child, f"{path}.{i}"))
        except Exception:
            continue
    return out


def main():
    sw, sh = int(sys.argv[1]), int(sys.argv[2])
    Atspi.set_timeout(200, 2000)  # a hung app mustn't stall us for D-Bus's default 25 s
    threading.Thread(target=read_stdin, daemon=True).start()
    last = None
    while True:
        wake.wait(SCAN_MS / 1000)
        wake.clear()
        if not enabled:
            continue
        t0 = time.monotonic()
        try:
            app, win = active_window()
            targets = scan(win, sw, sh) if win else []
            name = (app.get_name() if app else "") or ""
        except Exception as e:
            print(f"[targets] scan failed: {e}", file=sys.stderr)
            continue
        msg = {"targets": targets, "app": name}
        key = json.dumps(msg)
        if key != last:
            last = key
            msg["ms"] = round((time.monotonic() - t0) * 1000)
            print(json.dumps(msg), flush=True)


main()
