"""The "Hey Orion" listener: the laptop mic → Vosk, offline, limited to "hey orion", "yes" and "no".

Run by server/wake.ts with the venv's python (npm run setup:keys installs vosk and the model):
  python wake.py <model dir>

Like keystroke mode (keys.py), the grammar is tiny, so the recognizer can only ever hear those
phrases; everything else comes out as [unk]. Nothing leaves the laptop: Orion's own recorder only
starts after the wake phrase.

stdin, one command per line:  on | off       (start/stop listening; the model stays loaded)
GM_WAKE_SOURCE replaces arecord with any command that writes 16 kHz mono s16le PCM, for testing,
e.g. GM_WAKE_SOURCE="cat clip.pcm". GM_DEBUG_WAKE=1 also prints partial results.

stdout, one JSON per line:
  {"type": "ready"}                       model loaded
  {"type": "wake", "at": 3.1}            "hey orion" heard (partial result, held steady STABLE_CHUNKS)
  {"type": "answer", "yes": true}         a "yes"/"yeah"/"yep" or "no"/"nope" (final result)
  {"type": "error", "message": "..."}
"""

import json
import os
import shlex
import subprocess
import sys
import threading

from vosk import KaldiRecognizer, Model, SetLogLevel

RATE = 16000
CHUNK = 1600  # bytes: 800 samples = 50 ms
ARECORD = ["arecord", "-q", "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw",
           "--buffer-time=40000", "--period-time=10000"]
DEBUG = bool(os.environ.get("GM_DEBUG_WAKE"))
WAKE = "hey orion"
# The partial result can still change while the phrase is being said; it counts once it has held
# for this many 50 ms chunks.
STABLE_CHUNKS = 3
YES = ("yes", "yeah", "yep")
NO = ("no", "nope")
# A grammar this small forces any speech onto the nearest phrase: "hey Ryan" came out as "hey orion",
# "right now" as "no". Sound-alikes as decoys soak those up, so only the real phrase matches.
DECOYS = ["hey", "hi", "ryan", "brian", "oreo", "orient", "origin", "onion", "oregon", "orange", "o", "oh",
          "ian", "iron", "arena", "aaron", "now", "know", "say", "okay"]

out_lock = threading.Lock()


def emit(**msg):
    with out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


SetLogLevel(-1)
model = Model(sys.argv[1])
grammar = json.dumps([WAKE, *YES, *NO, *DECOYS, "[unk]"])
emit(type="ready")


class Listener:
    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None

    def on(self):
        if self.proc:
            return
        try:
            self.proc = subprocess.Popen(
                shlex.split(os.environ.get("GM_WAKE_SOURCE", "")) or ARECORD,
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

    @staticmethod
    def final(result: dict, fired: int, at: float):
        """An utterance is over (a pause)."""
        text = result.get("text", "")
        if DEBUG:
            emit(type="partial", text=f"(final) {text}", at=at)
        # A wake phrase that only showed up in the final result (said quickly, then silence).
        if text.count(WAKE) > fired:
            emit(type="wake", at=at)
        # A yes / no (Vosk's confidences are meaningless in a grammar this small: a "no" heard in
        # "right now" scored 1.0. The decoys do the filtering).
        words = [w["word"] for w in result.get("result", []) if w.get("word") in YES + NO]
        if words and WAKE not in text:
            emit(type="answer", yes=words[0] in YES)

    def run(self, proc: subprocess.Popen):
        rec = KaldiRecognizer(model, RATE, grammar)
        rec.SetWords(True)
        fired = 0  # wake phrases of this utterance already reported
        last, same = None, 0  # the partial's wake count, and for how many chunks it held
        raw_partial = None
        audio = 0
        while True:
            data = proc.stdout.read(CHUNK)
            if not data:
                break
            audio += len(data)
            at = round(audio / (RATE * 2), 2)
            if rec.AcceptWaveform(data):
                self.final(json.loads(rec.Result()), fired, at)
                fired, last, same, raw_partial = 0, None, 0, None
                continue
            raw = json.loads(rec.PartialResult()).get("partial", "")
            if DEBUG and raw != raw_partial:
                emit(type="partial", text=raw, at=at)
            raw_partial = raw
            n = raw.count(WAKE)
            same = same + 1 if n == last else 1
            last = n
            if n > fired and same >= STABLE_CHUNKS:
                fired = n
                emit(type="wake", at=at)
        # The source ended mid-utterance (a test clip): finish it.
        self.final(json.loads(rec.FinalResult()), fired, round(audio / (RATE * 2), 2))
        if proc.returncode not in (None, 0, -15):
            emit(type="error", message=f"arecord exited ({proc.returncode})")


listener = Listener()
for line in sys.stdin:
    cmd = line.strip()
    if cmd == "on":
        listener.on()
    elif cmd == "off":
        listener.off()
listener.off()
