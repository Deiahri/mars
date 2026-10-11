"""Pull MJPEG streams from ESP32 eye cams, show them, and find the pupil.

    python eyecam.py 192.168.43.20                 # bare IP -> http://IP:81/stream
    python eyecam.py http://eyecam-left.local:81/stream http://eyecam-right.local:81/stream

Prints one JSON line per processed frame: {"cam", "t", "px", "py", "ok"}
(px/py are the pupil centre in 0..1 image coordinates).
Keys: q quit, [ / ] tighter / looser pupil threshold.
"""

import argparse
import json
import sys
import threading
import time
import urllib.request

import cv2
import numpy as np

SOI = b"\xff\xd8"  # JPEG start
EOI = b"\xff\xd9"  # JPEG end


class CamReader(threading.Thread):
    """Reads one MJPEG stream and keeps only the newest JPEG.

    cv2.VideoCapture on an MJPEG URL buffers internally, so a slow consumer falls
    further and further behind. Dropping everything but the newest frame keeps
    latency flat.
    """

    def __init__(self, name, url):
        super().__init__(daemon=True)
        self.name, self.url = name, url
        self.lock = threading.Lock()
        self.jpg = None
        self.recv_t = 0.0
        self.seq = 0
        self.status = "connecting"
        self.stop = False

    def latest(self):
        with self.lock:
            return self.jpg, self.recv_t, self.seq

    def run(self):
        while not self.stop:
            try:
                with urllib.request.urlopen(self.url, timeout=5) as r:
                    self.status = "ok"
                    buf = b""
                    while not self.stop:
                        # read1 returns whatever has arrived (and undoes the ESP32's
                        # chunked encoding). A fixed-size read would hold each frame
                        # back until enough of the next one arrived.
                        chunk = r.read1(65536)
                        if not chunk:
                            raise ConnectionError("stream ended")
                        buf += chunk
                        # Entropy-coded JPEG data escapes 0xFF as 0xFF00, so SOI/EOI
                        # markers only appear at frame boundaries.
                        while True:
                            a = buf.find(SOI)
                            b = buf.find(EOI, a + 2) if a >= 0 else -1
                            if b < 0:
                                break
                            jpg, buf = buf[a : b + 2], buf[b + 2 :]
                            with self.lock:
                                self.jpg, self.recv_t = jpg, time.time()
                                self.seq += 1
                        if len(buf) > 1_000_000:  # garbage with no markers: resync
                            buf = b""
            except Exception as e:
                self.status = f"reconnecting ({type(e).__name__})"
                time.sleep(1)


def find_pupil(gray, offset):
    """Dark-pupil detection: the pupil is the darkest roughly-round blob.

    Threshold = darkest pixel + offset, so it doesn't depend on how much of the
    frame the pupil fills (a percentile threshold bleeds into the iris).
    Returns ((cx, cy), (w, h), angle) from cv2.fitEllipse, or None.
    """
    g = cv2.GaussianBlur(gray, (7, 7), 0)
    mask = (g <= int(g.min()) + offset).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    h, w = gray.shape
    best, best_score = None, 0.0
    for c in contours:
        area = cv2.contourArea(c)
        if area < 0.002 * w * h or len(c) < 5:
            continue
        perim = cv2.arcLength(c, True)
        circularity = 4 * np.pi * area / (perim * perim)  # 1.0 = circle
        if circularity < 0.5:  # eyelashes, eyelid shadow, hair
            continue
        score = area * circularity
        if score > best_score:
            best, best_score = c, score
    return cv2.fitEllipse(best) if best is not None else None


def to_url(arg):
    """Accept a full URL, "host:port", or a bare host (-> the firmware's :81/stream)."""
    if arg.startswith("http"):
        return arg
    return f"http://{arg}/stream" if ":" in arg else f"http://{arg}:81/stream"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cams", nargs="+", help="stream URL, host:port, or bare IP, one per eye cam")
    ap.add_argument("--offset", type=int, default=25, help="pupil = pixels within OFFSET of the darkest (default 25)")
    ap.add_argument("--no-window", action="store_true", help="headless: JSON lines only")
    args = ap.parse_args()

    readers = [CamReader(f"cam{i}", to_url(u)) for i, u in enumerate(args.cams)]
    for r in readers:
        r.start()
        print(f"{r.name}: {r.url}", file=sys.stderr)

    offset = args.offset
    last_seq = {r.name: 0 for r in readers}
    fps = {r.name: 0.0 for r in readers}
    last_t = {r.name: time.time() for r in readers}
    last_warn = 0.0

    try:
        while True:
            for r in readers:
                jpg, recv_t, seq = r.latest()
                if jpg is None or seq == last_seq[r.name]:
                    continue
                now = time.time()
                # EMA of the rate we actually process frames at (skipped frames don't count).
                fps[r.name] = 0.9 * fps[r.name] + 0.1 / max(now - last_t[r.name], 1e-3)
                last_t[r.name], last_seq[r.name] = now, seq

                frame = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                pupil = find_pupil(gray, offset)
                h, w = gray.shape

                out = {"cam": r.name, "t": round(now, 3), "ok": pupil is not None}
                if pupil:
                    (cx, cy), _, _ = pupil
                    out["px"], out["py"] = round(cx / w, 4), round(cy / h, 4)
                print(json.dumps(out), flush=True)

                if not args.no_window:
                    if pupil:
                        cv2.ellipse(frame, pupil, (0, 255, 0), 2)
                        cv2.circle(frame, (int(pupil[0][0]), int(pupil[0][1])), 2, (0, 0, 255), -1)
                    age_ms = (time.time() - recv_t) * 1000
                    label = f"{fps[r.name]:.0f} fps  {age_ms:.0f} ms  thr=+{offset}  {w}x{h}"
                    cv2.putText(frame, label, (5, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
                    cv2.imshow(r.name, frame)

            if not args.no_window:
                k = cv2.waitKey(1) & 0xFF
                if k == ord("q"):
                    break
                if k == ord("["):
                    offset = max(2, offset - 2)
                if k == ord("]"):
                    offset = min(120, offset + 2)
            else:
                time.sleep(0.002)
            # Surface connection problems every few seconds, not every loop.
            if time.time() - last_warn > 3:
                last_warn = time.time()
                for r in readers:
                    if r.status != "ok":
                        print(f"{r.name}: {r.status}", file=sys.stderr)
    except KeyboardInterrupt:
        pass
    finally:
        for r in readers:
            r.stop = True
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
