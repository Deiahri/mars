# Gymote Desktop

gaze-desktop with the eye tracking swapped out for a phone, as a stand-in until the gaze hardware works. Aim the phone at the laptop like a TV remote and the **real desktop pointer** follows. The phone is only a remote: the laptop does all the work.

| Phone button | Does |
|---|---|
| **Center** | Makes where you're aiming the middle of the screen. Press it whenever the pointer drifts |
| **Click** | Does the current action (see [Pointer](#pointer)). In plain Click mode, it's the left button: hold it to drag. Over the on-screen strip, it picks that button |
| **Right click** | Right mouse button |
| **Mouse on/off** | Off: the phone stops moving the pointer and the real mouse is yours |
| **Keys on/off** | Keystroke mode: say keys and the laptop presses them (see below) |
| **Dwell on/off** | Dwell clicking: hold the pointer still on something and it's selected, no button needed |
| **Orion** | Starts listening on the laptop mic. Say a command, then press **OK** and Claude does it on the desktop, or **Cancel** to throw it away. While Claude works, **Stop** ends it |

A pill at the bottom of the screen (an always-on-top window that never takes focus) shows what's happening: Orion listening, working and done, and each key that's pressed.

While the phone drives, the normal arrow is hidden and a soft halo shows where you're pointing. A slim strip on the right edge holds **Pause** and the actions.

## Run it

```bash
npm install
npm run setup:keys           # once: Python venv + vosk + the 40 MB English model (keystroke mode)
cp .env.example .env         # ANTHROPIC_API_KEY + ELEVENLABS_API_KEY, for Orion
npm run dev                  # 127.0.0.1:5176
npm run app                  # second terminal: the control page in a Chrome window that keeps running when covered
ngrok http 127.0.0.1:5176    # third terminal: phones only give motion data over https
```

1. The control page shows a QR code once ngrok is up. It includes a pairing code, so the bare ngrok URL is useless to anyone else.
2. Phone and laptop must be on the **same Wi-Fi**. The pointer data goes phone → laptop directly, not through ngrok. Campus Wi-Fi often blocks this; use the phone's hotspot instead.
3. Scan the code and tap **Tap to start** (on iPhone, also tap **Allow**). Hold the phone upright and aim at the screen. It centers itself when it connects.
4. Switch to any app. The control page can sit behind it. Covering it is fine; minimising it is not.

It needs Linux on an **X11** session (xdotool). On GNOME Wayland, log out and pick "Ubuntu on Xorg".

## Pointer

The phone stands in for eye gaze, so the pointer follows gaze-UX practice: calm, forgiving, and nothing gets clicked just because you looked at it. All of it lives in `server/pointer/`, fed by the phone's raw aim. Real gaze can feed the same pipeline later.

**Smoothing without lag** (`filter.ts`, `motion.ts`):
- A One Euro filter smooths hard when you're still, which removes jitter, and barely at all when you move fast.
- I-VT (velocity threshold) tells holding still from moving. After 100 ms below 20 °/s, the pointer **locks** onto the average of where you aimed, so tremor doesn't move it at all. Moving more than 0.8° lets go.
- A quick flick (over 60 °/s) skips the filter, so the pointer goes there at once.
- A critically damped spring moves the real pointer. It slows into place and never overshoots. A jump is 90% done in about 70–80 ms.

**The cursor:** the arrow is hidden (XFixes) and a small translucent halo is drawn instead (`server/halo.py`, a click-through overlay). A pointer exactly where you look pulls your eye to it, and then it chases your eye. On a snapped target there's no halo at all, only a soft glow around the target. The arrow comes back when the phone mouse is off, when paused, while Orion drives, and when the server stops.

**Snapping** (`snap.ts`, `server/targets.py`):
- The pointer jumps to the nearest button, link, menu item or field within 1.5°. This works as a bubble cursor.
- It only lets go when you aim 2.5° away, or when another target is clearly closer, so neighbouring buttons don't flicker.
- Targets come from the accessibility tree (AT-SPI) of the active window, rescanned every 500 ms and just after each click or scroll.
- Snapping only works in apps that show their accessibility tree. GTK apps do already. Turn the rest on once:
  ```bash
  gsettings set org.gnome.desktop.interface toolkit-accessibility true   # Firefox and others; log out and back in
  google-chrome --force-renderer-accessibility                          # Chrome / Electron: start it with this flag
  ```
  Without it, snapping just doesn't happen there (the page shows "0 targets"); the fixation lock still steadies the pointer. Toggle it with **Snap to buttons** on the control page.

**The action strip** (right edge): **Pause**, then **Click**, **Right click**, **Double click**, **Drag**, **Scroll**.
- Pick one by dwelling on it or pressing the phone's Click while on it. It stays picked (sticky) until you choose another.
- The strip is part of the overlay, so a selection there never clicks the app underneath.
- **Drag:** the first selection presses the button and the next one drops it.
- **Scroll:** the first selection parks the pointer. Look above or below it to scroll, faster the further you look. Look back at it (dwell), press Click, or look well to the side to stop.
- **Pause:** the pointer stops moving and nothing is clicked, so you can rest, talk or look around. Only **Resume**, in the same spot, reacts.

**Dwell** (`dwell.ts`), off by default (phone or control page):
- Hold still on something and a thin ring fills. When it's full, the current action happens.
- Look away and it drains smoothly instead of vanishing, so a brief wobble picks up where it left off.
- After a selection, the same thing can't be selected again until you've moved off it.
- Base time is 800 ms (500–1500 ms, −/+ on the control page). It adapts: a little shorter after each selection where you move on, longer after a quick retry on the same spot, or Pause or a mode change right after one. It stays within 0.6× to 1.6× of the base. **reset** returns it to the base.
- Strip buttons need at least 700 ms, and Pause/Resume always 1 s.

**Drift correction:** each selection on a small snapped target counts as the truth for where you meant to point. It nudges a small offset (up to 3°) toward that target's center, so slow drift corrects itself. **Center** resets it. The control page shows it.

**Tracking lost** (phone link gone or silent): the pointer freezes, the dwell is cancelled, and the halo turns grey and dashed with a small "tracking lost" chip. After 5 s the arrow comes back. When the phone returns, the pointer glides from where it froze instead of jumping.

Tuning numbers are at the top of each file in `server/pointer/` (`MOTION`, `SNAP`, `DWELL`, `BRAIN`, `ONE_EURO`).

## Keystroke mode

No AI, so it's fast. [Vosk](https://alphacephei.com/vosk/) runs offline and only listens for these words, so short words like "up" are reliable. Each word acts as soon as it's heard, about 0.2 s after you say it (measured: −60 to +190 ms after the word ends).

| Say | Does |
|---|---|
| `left` `right` `up` `down` | Tap that arrow key. Words can run together: "left left up" |
| `space` / `jump`, `enter`, `escape` | Tap that key |
| `hold up` | Press Up and keep it down |
| `stop up` (or `release up`) | Let go of Up |
| `stop` on its own | Let go of everything held |

**Fast repeats in games.** Some games ignore keys while a move is still animating. In Bloxorz the block takes a moment to roll, so "right right right" said quickly would lose presses. Set **Gap between keys** on the control page (about 300 ms for Bloxorz): taps then queue and go out at least that far apart instead of being dropped by the game. Hold and stop are never delayed. Each tap holds the key for 40 ms (`TAP_HOLD_MS`), because xdotool's own ~6 ms tap is shorter than a frame and games that check keys once per frame miss it.

Turning keys off, starting Orion, or stopping the server lets go of anything held, and drops taps still waiting for their gap. Keystroke mode pauses while Orion listens or works, so your spoken command isn't typed as keys. To add a key, add a row to `KEYMAP` in `server/keys.ts` (the word must be in Vosk's English vocabulary).

## Orion

This is os-control-spike's agent: ElevenLabs Scribe turns your speech into text, then Claude computer use drives the desktop with xdotool and ffmpeg.
- While Orion works, the phone's pointer and buttons are paused so they don't fight Claude.
- The recording only goes to Claude when you press **OK**. If you never press it, the recording is thrown away after 60 s.
- With `SAFE_MODE=1` in `.env`, Claude asks before risky actions. Answer on the phone: **Yes** is the OK button, **No** is Cancel.

## Stopping things

- **Phone:** Mouse off, or Cancel/Stop during Orion.
- **Control page:** **Stop everything** or <kbd>Esc</kbd> turns off the phone mouse and keys and cancels Orion.
- **`MAX_STEPS`** (default 30) caps Claude's turns per command.

## How it works

```
phone (remote.html via ngrok)  ── WebRTC, LAN ──►  control page (index.html, Chrome app window)
  "pointer": Gymote's 8-byte packets                raw x, y (already desktop px) → gm:raw
  "events": buttons / toggles / Orion  ◄── state ── relays both ways
                                                    ── Vite dev websocket (local page only) ──►
server/pointer/    brain.ts every 10 ms: One Euro → I-VT lock → snap → spring → dwell / strip
server/plugin.ts   xdotool mousemove / mousedown / click (newest move wins, buttons never dropped)
server/halo.py     the halo, target glow, dwell ring and strip (click-through, hides the arrow)
server/targets.py  AT-SPI: clickable rectangles in the active window, for snapping
server/keys.ts     server/keys.py: arecord → Vosk (word list) → hold/tap/stop → xdotool key/keydown/keyup
server/orion.ts    arecord → WAV → Scribe → server/agent.ts (Claude) → server/computer.ts
server/overlay.py  the status pill
```

- **Why a page in the middle.** Node has no WebRTC. The page only relays; the server does all mic capture and every action, so the page needs no permissions.
- **Desktop coordinates.** The page tells the phone the desktop's size (from xdotool), not its own, so Gymote's x, y are already screen pixels. Sensitivity is the "phone distance" (−/+ on the page, remembered). At 1.5 × the screen width, you turn about 37° to cross the screen.
- **Who can control it.**
  - Vite binds to `127.0.0.1`, so nothing is exposed on the LAN.
  - The dev websocket also serves the phone page (through ngrok). The server only takes commands from sockets that come from loopback *without* ngrok's `X-Forwarded-For` header.
  - WebRTC signaling (`/api/link/*`) needs the pairing code, which only the local page gets.
- **Gymote bugs.** The same phone-side workarounds as gymote-playground (see its README): the Android gyroscope start, and retries for a reading of exactly 0. The laptop side doesn't use `GymoteScreen` any more (its fixed easing needed a re-feed hack); the raw packet goes straight to `server/pointer/`.
- **Python helpers and VS Code.** Started from VS Code's snap terminal, the environment points GTK at the snap's libraries and the system Python crashes. `server/env.ts` strips those for the helpers.
- **Copied from:**
  - gymote-playground: `src/net/*`, `src/gymote.d.ts`, `server/signaling.ts` (+ token), and the phone's start flow.
  - gaze-desktop: Pointer coalescing, `overlay.py`, `chrome.sh`.
  - os-control-spike: `agent.ts`, `safety.ts`, and `desktop.ts` (now `computer.ts`).

## Testing without a phone or mic

```bash
npm run test:keys                                   # word → key logic
npm run test:pointer                                # filter, fixation lock, spring, snap, dwell, strip, recal (fake time)
GM_DEBUG_POINTER=1 npm run dev                      # log fixations, snaps, target scans and each jump's time to 90%
GM_DRY_RUN=1 npm run dev                            # log pointer xdotool calls instead of running them
GM_KEYS_SOURCE="cat clip.pcm" npm run dev           # feed keystroke mode 16 kHz mono s16le PCM instead of the mic
GM_DEBUG=1 GM_DEBUG_KEYS=1 npm run dev              # log buttons, Vosk's raw partials, and each key with timings
GM_KEYS_RECORD=/tmp/keys.pcm npm run dev            # also save what keystroke mode heard, to replay a bad run
```

A `GM_DEBUG_KEYS` line reads like this. Audio time is how much mic audio had been heard, *behind* is how far decoding lagged the mic (it should stay near 0), and *done* is from recognition to the key being pressed:

```
[keys] 19:23:04.512 heard "right" (partial @3.10s, 0 ms behind) → keydown Right sleep 0.04 keyup Right, done +46 ms
```

**Verified (2026-10-10):**
- `npm run build` and `npm run test:keys` (12 cases) pass.
- An end-to-end test in headless Chrome: the control page and the phone page each in their own window, linked over real WebRTC, with a faked gyroscope and the server in dry-run mode. It confirmed:
  - Centering puts the pointer at 683,382 on 1366×768.
  - A 10° turn moves it 359 px left (geometry: 361), and a 10° tilt moves it up.
  - Click and Right click give mousedown/up 1 and 3.
  - Mouse off blocks moves and clicks.
  - Keys on/off, and Orion start then Cancel, update both the phone and the page.
- The trust gate: a websocket with `X-Forwarded-For` gets no token and can't move the pointer, and `/api/link/*` without the code returns 403.
- Vosk on a spoken clip ("left, left, hold up, stop up, jump, hold down, stop") heard all 11 words in order.
- Latency (replaying "left left left" through the server): each word was pressed 50–70 ms *before* the spoken word ended, with decoding 0 ms behind. arecord now uses 10 ms periods. The default delivered audio in 125 ms blocks, the first ~250 ms after start.

**Pointer (2026-10-10):**
- `npm run test:pointer` passes 22 cases with fake time:
  - The filter cuts more than 80% of jitter at rest and is under 2° behind at 30 °/s.
  - The fixation lock doesn't move during ±0.3° tremor.
  - A 10° jump is 90% done in 80 ms or less, with no overshoot.
  - Snap hysteresis and nested targets work.
  - Dwell timing, its smooth cancel, no repeats, and the adaptive bounds all behave.
  - The strip catches selections.
  - Pause/Resume, freezing when tracking is lost, recalibration, and scroll mode all work.
- An end-to-end dry run (`GM_DRY_RUN=1` server, with a script standing in for the control page) confirmed:
  - 0 moves during 800 ms of tremor after the lock.
  - A 10° turn landed exactly, with no overshoot, 90% there in 69–78 ms.
  - Phone Click on the strip changed the mode with no app click.
  - Double mode gave `click --repeat 2`.
  - There were no moves while tracking was lost.
  - A dwell fired once, at 962 ms, and never repeated.
- `targets.py` on a GTK test window: the scanned rectangles matched the real buttons exactly, scanned in 57 ms.
- `halo.py`: the halo, ring, glow and strip render as designed (screenshot).
- **Not yet checked:** that the arrow really hides on this GNOME, and snapping in Firefox/Chrome with accessibility turned on.

**Not yet tried:** a real phone in hand, the new pointer with a real phone, keystroke mode on the live mic, and an Orion command end to end from the phone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pointer freezes when another window covers the page | Use `npm run app`, not a normal tab, and don't minimise it |
| QR says no ngrok tunnel | Run `ngrok http 127.0.0.1:5176` (not `localhost`, which may resolve to IPv6) |
| Phone says "Open this page from the QR code", or never connects after a restart | The link is missing its `?k=` pairing code, or it's stale. Restarting `npm run dev` makes a new code: the control page reloads itself with it, but the phone has to rescan. Edits to server files keep the code |
| Phone stuck on "connecting…" | Wi-Fi blocks phone↔laptop traffic. Use the phone's hotspot |
| Pointer drifts sideways over time | Compass heading drift. Press **Center** |
| Keys button says n/a | Run `npm run setup:keys` and restart `npm run dev` |
| Keys mishears in a noisy room | Speak the words crisply. Raise `STABLE_CHUNKS` in `server/keys.py` (fewer flips, +50 ms each) |
| Orion says "no … key" | Put `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` in `.env` and restart |
| Clicks land in the wrong place | Center first, then aim. The click lands where the pointer visibly is |
| No halo or strip, and the arrow stays | `halo.py` needs a compositor (GNOME has one) and system `python3-gi`. Check the server log for "halo.py exited" |
| "0 targets" on the control page | That app hides its accessibility tree. See [Pointer → Snapping](#pointer) |
| The pointer locks too soon or feels sticky | Raise `MOTION.LOCK_DEG` or lower `MOTION.FIX_VEL` in `server/pointer/motion.ts` |
| Dwell clicks things you didn't mean | Turn Dwell off and use the phone's Click, or raise the base time. It also lengthens itself after quick retries |
