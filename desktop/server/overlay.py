"""Status overlay: a small always-on-top pill at the bottom of the screen.

The control page sits behind the app you're controlling, so it can't show anything. This window
can, and it must never take keyboard focus (Orion and keystroke mode type into whatever has focus).
An override-redirect window is unmanaged by the window manager: it's never focused and stays above
normal windows. (From gaze-desktop, with Orion and keystroke states instead of dictation.)

stdin, one JSON object per line (from server/plugin.ts):
  {"state": "listening", "level": 0..1, "text"?: "..."}  Orion or dictation is recording
  {"state": "transcribing"}
  {"state": "working", "text": "..."}    Orion's progress; stays up
  {"state": "done", "text": "..."}       Orion's summary; fades after HOLD_MS
  {"state": "error", "text": "..."}
  {"state": "info", "text": "..."}       a key that was pressed, mouse on/off...; fades quickly
  {"state": "hidden"}
Only the standard library (tkinter).
"""

import json
import queue
import sys
import threading
import tkinter as tk

BG = "#16191e"
FG = "#e8ebf0"
MUTED = "#8b93a1"
COLORS = {
    "listening": "#3ddc97",
    "transcribing": "#ffd34e",
    "working": "#4ea1ff",
    "done": "#3ddc97",
    "error": "#ff6b6b",
    "info": "#c792ea",
}
HOLD_MS = {"done": 6000, "error": 3500, "info": 1200}
BOTTOM_GAP = 90  # px above the screen's bottom edge, clear of a dock/taskbar
MAX_TEXT_PX = 700

msgs: "queue.Queue[dict | None]" = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        try:
            msgs.put(json.loads(line))
        except ValueError:
            pass
    msgs.put(None)  # server gone: quit


root = tk.Tk()
root.withdraw()
root.overrideredirect(True)
root.attributes("-topmost", True)
try:
    root.attributes("-alpha", 0.94)  # needs a compositor; harmless without one
except tk.TclError:
    pass
root.configure(bg=BG, highlightthickness=2, highlightbackground=COLORS["listening"])

row = tk.Frame(root, bg=BG, padx=14, pady=10)
row.pack()
dot = tk.Canvas(row, width=14, height=14, bg=BG, highlightthickness=0)
dot_id = dot.create_oval(2, 2, 12, 12, fill=COLORS["listening"], outline="")
dot.pack(side="left", padx=(0, 10))
col = tk.Frame(row, bg=BG)
col.pack(side="left")
label = tk.Label(col, text="", bg=BG, fg=FG, font=("Ubuntu", 13), wraplength=MAX_TEXT_PX, justify="left")
label.pack(anchor="w")
meter = tk.Canvas(col, width=220, height=4, bg="#2a2f37", highlightthickness=0)
meter_id = meter.create_rectangle(0, 0, 0, 4, fill=COLORS["listening"], outline="")

hide_job = None
level = 0.0


def place():
    root.update_idletasks()
    w, h = root.winfo_reqwidth(), root.winfo_reqheight()
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"+{(sw - w) // 2}+{sh - h - BOTTOM_GAP}")


def show(state: str, text: str, color: str, with_meter: bool):
    global hide_job
    if hide_job:
        root.after_cancel(hide_job)
        hide_job = None
    label.configure(text=text, fg=FG if state != "transcribing" else MUTED)
    dot.itemconfigure(dot_id, fill=color)
    meter.itemconfigure(meter_id, fill=color)
    root.configure(highlightbackground=color)
    if with_meter:
        meter.pack(anchor="w", pady=(6, 0))
    else:
        meter.pack_forget()
    place()
    root.deiconify()
    root.lift()
    if state in HOLD_MS:
        # Long texts (an answer from screen memory) stay up long enough to read: ~60 ms a character.
        hold = HOLD_MS[state] if state == "info" else max(HOLD_MS[state], 60 * len(text))
        hide_job = root.after(min(hold, 25000), root.withdraw)


def handle(m: dict):
    global level
    state = m.get("state")
    if state == "hidden":
        root.withdraw()
    elif state == "listening":
        # Smooth the level a little so the bar doesn't flicker.
        level = level * 0.5 + float(m.get("level", 0)) * 0.5
        meter.coords(meter_id, 0, 0, int(220 * min(1.0, level)), 4)
        want = str(m.get("text") or LISTENING)
        if not root.winfo_viewable() or label.cget("text") != want:
            show("listening", want, COLORS["listening"], True)
    elif state == "transcribing":
        show("transcribing", "Transcribing…", COLORS["transcribing"], False)
    elif state in COLORS:
        show(state, str(m.get("text", "")), COLORS[state], False)


LISTENING = "● Orion is listening… press OK on the phone"


def pump():
    try:
        while True:
            m = msgs.get_nowait()
            if m is None:
                root.destroy()
                return
            handle(m)
    except queue.Empty:
        pass
    root.after(30, pump)


threading.Thread(target=read_stdin, daemon=True).start()
root.after(30, pump)
root.mainloop()
