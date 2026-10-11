"""Keystroke mode's ears: the laptop mic → Vosk, limited to a few words, printed as soon as heard.

Run by server/keys.ts with the venv's python (npm run setup:keys installs vosk and the model):
  python keys.py <model dir> <word> <word> ...

The word list is a Vosk grammar, so the recognizer can only ever hear those words (anything else
comes out as [unk] and is dropped). That's what makes lone short words like "up" reliable, and
partial results arrive every 50 ms chunk instead of after a pause.

stdin, one command per line:  on | off       (start/stop listening; the model stays loaded)
GM_KEYS_SOURCE replaces arecord with any command that writes 16 kHz mono s16le PCM, for testing
without a mic, e.g. GM_KEYS_SOURCE="cat clip.pcm".
GM_KEYS_RECORD=<file> also saves the mic audio there (raw PCM, same format), to replay a bad run.
GM_DEBUG_KEYS=1 also prints every change of the raw partial result ({"type": "partial", ...}).

stdout, one JSON per line:
  {"type": "ready"}                 model loaded
  {"type": "word", "w": "left", "src": "partial"|"final", "at": 3.10, "behind": 12}
                                    a new word, as soon as it's stable in the partial result.
                                    at = seconds of audio heard so far; behind = ms of audio
                                    waiting to be decoded (Vosk falling behind if it grows)
  {"type": "end"}                   the utterance is over (a pause, or "off")
  {"type": "error", "message": "..."}
"""

import json
import os
import shlex
import subprocess
import sys
import threading
import time

from vosk import KaldiRecognizer, Model, SetLogLevel

RATE = 16000
CHUNK = 1600  # bytes: 800 samples = 50 ms
# arecord's default hands over audio in 125 ms blocks (first one ~250 ms in). 10 ms periods cut that
# to 10 ms (first at ~50 ms), measured on this laptop.
ARECORD = ["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw",
           "--buffer-time=40000", "--period-time=10000"]
RECORD = os.environ.get("GM_KEYS_RECORD")
DEBUG = bool(os.environ.get("GM_DEBUG_KEYS"))
# A word at the end of a partial result can still flip ("up" → "jump") while it's being spoken.
# It counts once it's been the same for this many chunks in a row (50 ms each).
STABLE_CHUNKS = 2

out_lock = threading.Lock()


def emit(**msg):
    with out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


SetLogLevel(-1)
model = Model(sys.argv[1])
words = sys.argv[2:]
grammar = json.dumps(words + ["[unk]"])
emit(type="ready")


def heard(text: str) -> list[str]:
    return [w for w in text.split() if w in words]


class Listener:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None

    def on(self):
        if self.proc:
            return
        try:
            self.proc = subprocess.Popen(
                shlex.split(os.environ.get("GM_KEYS_SOURCE", "")) or ARECORD,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            emit(type="error", message=f"arecord: {e}")
            return
        self.thread = threading.Thread(target=self.run, args=(self.proc,), daemon=True)
        self.thread.start()

    def off(self):
        proc, self.proc = self.proc, None
        if proc:
            proc.terminate()
        if self.thread:
            self.thread.join(timeout=1)
            self.thread = None

    def run(self, proc: subprocess.Popen):
        rec = KaldiRecognizer(model, RATE, grammar)
        sent = 0  # words of this utterance already printed
        last, same = None, 0  # (length, trailing word) of the partial, and for how many chunks
        raw_partial = None
        audio = 0  # bytes heard since "on"
        t0 = None  # wall clock when the first chunk arrived
        rec_file = open(RECORD, "ab") if RECORD else None

        def word(w: str, src: str):
            at = audio / (RATE * 2)
            # Audio arrives in real time, so wall time since the first chunk minus audio time is
            # how far decoding lags behind the mic.
            behind = round(((time.monotonic() - t0) - (at - CHUNK / (RATE * 2))) * 1000)
            emit(type="word", w=w, src=src, at=round(at, 2), behind=behind)

        while True:
            data = proc.stdout.read(CHUNK)
            if not data:
                break
            if t0 is None:
                t0 = time.monotonic()
            audio += len(data)
            if rec_file:
                rec_file.write(data)
            if rec.AcceptWaveform(data):
                # Utterance over: print whatever the final result has beyond what we already sent.
                text = json.loads(rec.Result()).get("text", "")
                final = heard(text)
                if DEBUG:
                    emit(type="partial", text=f"(final) {text}", at=round(audio / (RATE * 2), 2))
                for w in final[sent:]:
                    word(w, "final")
                if final or sent:
                    emit(type="end")
                sent, last, same, raw_partial = 0, None, 0, None
                continue
            raw = json.loads(rec.PartialResult()).get("partial", "")
            if DEBUG and raw != raw_partial:
                emit(type="partial", text=raw, at=round(audio / (RATE * 2), 2))
            raw_partial = raw
            partial = heard(raw)
            if not partial:
                continue
            # Every word but the last is settled; the last one has to hold still for a moment.
            # Keyed on the length too, so a repeat ("up up") waits like any new word.
            tail = (len(partial), partial[-1])
            same = same + 1 if tail == last else 1
            last = tail
            ready = len(partial) if same >= STABLE_CHUNKS else len(partial) - 1
            for w in partial[sent:ready]:
                word(w, "partial")
            sent = max(sent, ready)
        if rec_file:
            rec_file.close()
        if proc.returncode not in (None, 0, -15):
            emit(type="error", message=f"arecord exited ({proc.returncode})")
        if sent:
            emit(type="end")


listener = Listener()
for line in sys.stdin:
    cmd = line.strip()
    if cmd == "on":
        listener.on()
    elif cmd == "off":
        listener.off()
listener.off()
