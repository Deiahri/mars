# MARS: desktop app

The laptop side of [MARS](../README.md): the gaze-ready pointer, the accessibility wheel, dictation, voice keys and Mars. It's built to be driven by the eyes, but the [eye cams](../eyecam/) aren't wired in yet, so **today the phone remote is how you use it**. A phone stands in for the eyes through [Gymote](https://github.com/dulnan/gymote): aim the phone at the laptop like a TV remote and the **real desktop pointer** follows. The phone is only a remote: the laptop does all the work.

The phone has three big buttons, like the two or three switches a gaze user would have. Each button's label always says what it does right now.

| Phone button | Does |
|---|---|
| **Click** (left) | Left mouse button: hold it to drag. If a click type is picked from the wheel, it does that instead |
| **Right click** | Right mouse button. If a click type is picked, it cancels it |
| **Menu** | Opens the [accessibility wheel](#the-wheel) on the laptop screen, around the pointer |
| **Center** (small, top) | Makes where you're aiming the middle of the screen. Press it whenever the pointer drifts |
| **Scroll speed** (slider, right edge) | Notches per second while scrolling, 1–30. Remembered on the phone |

While Mars listens, **Left = OK** and **Right = Cancel** (Yes / No when it asks; **Stop** while it works). While dictating, **Left = Type it** and **Right = Cancel**.

A pill at the bottom of the screen (an always-on-top window that never takes focus) shows what's happening: Mars listening, working and done, and each key that's pressed.

While the phone drives, the normal arrow is hidden and a soft halo shows where you're pointing.

## Run it

```bash
npm install
npm run setup:keys           # once: Python venv + vosk + the 40 MB English model (keystroke mode)
cp .env.example .env         # GEMINI_API_KEY + ELEVENLABS_API_KEY, for Mars
npm run dev                  # 127.0.0.1:5176
npm run app                  # second terminal: the control page in a Chrome window that keeps running when covered
ngrok http 127.0.0.1:5176    # third terminal: phones only give motion data over https
```

1. The control page shows a QR code once ngrok is up. It includes a pairing code, so the bare ngrok URL is useless to anyone else.
2. Best on the **same Wi-Fi**: the pointer data goes phone → laptop directly. Campus Wi-Fi often blocks that, and then the link falls back to relaying through the dev server and ngrok. The status says "connected via relay", and it adds the ngrok round trip. Use the phone's hotspot for the direct link.
3. Scan the code and tap **Tap to start** (on iPhone, also tap **Allow**). Hold the phone upright and aim at the screen. It centers itself when it connects.
4. Switch to any app. The control page can sit behind it. Covering it is fine; minimising it is not.

It needs Linux on an **X11** session (xdotool). On GNOME Wayland, log out and pick "Ubuntu on Xorg".

## Pointer

The phone stands in for eye gaze, so the pointer follows gaze-UX practice: calm, forgiving, and nothing gets clicked just because you looked at it. All of it lives in `server/pointer/`, fed by the phone's raw aim. Real gaze can feed the same pipeline later.

**Smoothing without lag** (`filter.ts`, `motion.ts`):
- A One Euro filter smooths hard when you're still, which removes jitter, and barely at all when you move fast.
- I-VT (velocity threshold) tells holding still from moving. After 100 ms below 20 °/s, the pointer **locks** onto the average of where you aimed, so tremor doesn't move it at all. Moving more than 0.8° lets go.
- **Creep:** a small, slow correction (nudging onto a button a few px away) is too slow and too short to release the lock. Tremor averages out around the lock point, but a correction doesn't. So when the last 150 ms of input sits more than 0.15° (about 5 px) off, the lock point glides there. It's the same fixation, so a dwell in progress keeps going. Corrections of 9–27 px land within 0.1° in 130–220 ms.
- A quick flick (over 60 °/s) skips the filter, so the pointer goes there at once.
- A critically damped spring moves the real pointer. It slows into place and never overshoots. A jump is 90% done in about 70–80 ms.

**The cursor:** the arrow is hidden (XFixes) and a small translucent halo is drawn instead (`server/halo.py`, a click-through overlay). A pointer exactly where you look pulls your eye to it, and then it chases your eye. On a snapped target there's no halo at all, only a soft glow around the target. The arrow comes back when the phone mouse is off, when paused, while Mars drives, and when the server stops.

**Snapping** (`snap.ts`, `server/targets.py`):
- The pointer jumps to the nearest button, link, menu item or field within 1.5°. This works as a bubble cursor.
- It only lets go when you aim 2.5° away, or when another target is clearly closer, so neighbouring buttons don't flicker.
- Targets come from the accessibility tree (AT-SPI) of the active window, rescanned every 500 ms and just after each click or scroll.
- Snapping only works in apps that show their accessibility tree. GTK apps do already. Turn the rest on once:
  ```bash
  gsettings set org.gnome.desktop.interface toolkit-accessibility true   # Firefox and others; log out and back in
  google-chrome --force-renderer-accessibility                          # Chrome / Electron: start it with this flag
  ```
  Without it, the accessibility tree has nothing there (the page shows "0 targets"), and only the AI targets below apply.
- **Off by default**: zoom is the main precision tool. Turn it on from the wheel (More › Settings › Snap) or **Snap to buttons** on the control page.

**AI targets** (`server/vision-targets.ts`): Gemini (`gemini-3.8-flash`, its native `box_2d` detection) looks at a screenshot and lists what can be clicked, for apps that hide their accessibility tree (VS Code, Chrome without the flag, games).
- Accessibility targets are exact, so they win. An AI box is used only where no accessibility target overlaps it.
- A look takes about 8–16 s and costs about $0.02–0.03 (a busy screen has 40–80 boxes). It only looks again when the screen really changes:
  - A tiny thumbnail is compared every 500 ms, ignoring the halo and the glow.
  - On a change, the old boxes are dropped at once and the screen is looked at once it has been still for 400 ms.
  - The last 20 screens keep their boxes, so going back to a window or tab costs nothing.
- Limits: one look at a time, 3 s apart, at most 6 a minute (worst case about $11 an hour on a screen that never stops changing). Looks only happen while someone is pointing: phone input in the last 30 s, not paused, snap on, no wheel or zoom open.
- AI boxes don't train the drift correction, since they're approximate.
- **AI targets** on the control page turns it on or off and shows the state, box count, looks, reuses and cost so far. `AI_SNAP=0` in `.env` starts with it off. It needs `GEMINI_API_KEY`. A look takes ~20–30 s (it runs in the background) and ~$0.02.
- `npm run look` does one look at the current screen. It prints the boxes and writes the screenshot with them drawn on it to `/tmp/sightline-look.png`.

### The wheel

**Menu** opens a wheel around the pointer (`wheel.ts`). Four tiles around a center tile; point at one and press **Left** (or dwell on it, with dwell on). **Right** goes back a level, **Menu** closes it. The center tile is **Close**, or **Back** in a submenu. The wheel is drawn by the overlay, so pressing there never clicks the app underneath, and the real pointer stays put while it's open (a drag in progress doesn't move).

| Level | Top | Right | Bottom | Left |
|---|---|---|---|---|
| **Wheel** | **Zoom** | Click › | **Scroll** | More › |
| Click › | Double click | Drag & drop | Triple click | Middle click |
| More › | **Dictate** | Mars | Settings › | Pause |
| More › Settings › | Dwell on/off | Snap: off → on → on + AI | Voice › | Zoom 2× / 3× / 4× |
| … Settings › Voice › | Hey Mars on/off | Mars speaks on/off | Keys on/off | |

**Zoom-click** (`zoom.ts`): a frozen snapshot of the area around the pointer pops up 3× bigger (about two-thirds of the screen). Pointing inside it is 3× finer, and the real pointer follows underneath. **Left** or **Right** clicks the real spot under the halo and the panel closes; **Menu** cancels. After the click the pointer stays on the clicked spot until you move, so it doesn't jump to where the phone points. While a button is held, the real pointer moves in steps of at most 12 px and none are dropped: apps need a stream of small motions to carry a drag (see "Drag & drop: why small steps" below). The snapshot is frozen on purpose: nothing moves under your eye, as in eye-gaze zoom tools. It works with the click types too: pick Drag & drop, zoom, click to grab; zoom again, click to drop.

Snap and AI targets are one step in the wheel: Settings › Snap cycles off → on → on + AI targets (AI only matters with snapping on). The control page still has separate toggles.

**Click types** are one-shot: pick Double click and the next **Left** double-clicks, then it's back to normal. **Drag & drop:** the next Left grabs (button down), the one after drops. **Right** cancels a pending one (or drops). A chip under the pointer says what's pending.

**Scroll:** **Left** scrolls up and **Right** scrolls down. A press is one notch; holding repeats after 250 ms at the phone's slider speed (8 /s by default). The pointer still moves, so you can pick which pane scrolls. **Menu** ends scrolling.

**Pause:** the pointer stops and nothing is clicked (the real arrow comes back), so you can rest or use the real mouse. **Menu** resumes.

**Dwell** (`dwell.ts`), off by default (phone or control page):
- Hold still on something and a thin ring fills. When it's full, it clicks (or does the pending click type, or picks the wheel tile).
- Look away and it drains smoothly instead of vanishing, so a brief wobble picks up where it left off.
- After a selection, the same thing can't be selected again until you've moved off it.
- Base time is 800 ms (500–1500 ms, −/+ on the control page). It adapts: a little shorter after each selection where you move on, longer after a quick retry on the same spot, or Pause right after one. It stays within 0.6× to 1.6× of the base. **reset** returns it to the base.
- Wheel tiles need at least 700 ms.

**Drift correction:** each selection on a small snapped target counts as the truth for where you meant to point. It nudges a small offset (up to 3°) toward that target's center, so slow drift corrects itself. **Center** resets it. The control page shows it.

**Tracking lost** (phone link gone or silent): the pointer freezes, the dwell is cancelled, and the halo turns grey and dashed with a small "tracking lost" chip. After 5 s the arrow comes back. When the phone returns, the pointer glides from where it froze instead of jumping.

Tuning numbers are at the top of each file in `server/pointer/` (`MOTION`, `SNAP`, `DWELL`, `BRAIN`, `ONE_EURO`).

**Drag & drop: why small steps.** Measured with a GTK test window and xdotool: after the button goes down, GTK starts the drag on the first motion. It only finds the drop target if more motion events follow. One 100 px jump started the drag and lost it every time; steps of 50 px or less dropped every time. Zoom-click used to pin the pointer on the grabbed spot and then glide to where the phone pointed, which can be 100+ px in a few coalesced moves. Now moves are split into ≤ 12 px steps while a button is held, and the xdotool queue keeps every one (a run of them goes in one call).

**Dwell after a button press:** pressing a button holds the dwell until you move 2° away, so holding still after a click (or after a grab) doesn't click (or drop) again.

## Dictation

Speak, and the laptop types it into whatever has focus. Click into the field first, then **Menu › More › Dictate**, speak, and press **Type it** (Left). **Cancel** (Right) throws it away.
- ElevenLabs Scribe hears the whole recording, so the text comes back punctuated and capitalised, about a second after you press Type it. It's typed with `xdotool type` (`server/dictation.ts`).
- Back-to-back dictations get a space between them.
- While dictating, the pointer still moves, but the phone's buttons belong to dictation: nothing gets clicked until you finish.
- It shares the mic with keystroke mode (paused meanwhile) and Mars (only one at a time).
- A recording left for 2 minutes is thrown away, never typed.
- It needs `ELEVENLABS_API_KEY` (same as Mars), and costs about a hundredth of a cent per sentence.

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

Turning keys off, starting Mars, or stopping the server lets go of anything held, and drops taps still waiting for their gap. Keystroke mode pauses while Mars listens or works, so your spoken command isn't typed as keys. To add a key, add a row to `KEYMAP` in `server/keys.ts` (the word must be in Vosk's English vocabulary).

## Mars

ElevenLabs Scribe turns your speech into text, then **Gemini computer use** (`gemini-3.8-flash`, the Interactions API's `computer_use` tool with `environment: "desktop"`) drives the desktop with xdotool and ffmpeg (`server/agent.ts`, `server/gemini.ts`; Gemini's 0–999 coordinates are mapped in `computer.ts` `geminiAction`). Thinking is set to `low` (`GEMINI_THINKING`): a step takes ~5 s, against ~45 s at the default. Gemini keeps the conversation on its side (`previous_interaction_id`). Its own safety checks (`require_confirmation`) come to you as Yes / No.
- While Mars works, the phone's pointer and buttons are paused so they don't fight Gemini.
- The recording only goes to Gemini when you press **OK**. If you never press it, the recording is thrown away after 60 s.
- With `SAFE_MODE=1` in `.env`, Mars asks before risky actions. Answer on the phone: **Yes** is the OK button, **No** is Cancel.
- With [screen memory](#screen-memory) on, Mars can also answer questions about earlier ("what was the error in my terminal earlier?") and find things to go back to ("reopen the page I was reading before lunch").
- **"Hey Mars".** Say it, wait for the soft two-note chime, say what you want, then press **OK** on the phone (same as Menu › More › Mars). It's heard offline by Vosk (`server/wake.py` + `wake.ts`, the same engine as keystroke mode), with a tiny grammar plus sound-alike decoys ("hey Mark", "hey mom", "Mars bar", "now"…) so near-misses don't trigger it; nothing leaves the laptop until you press OK. Pause briefly after "Hey Mars": the recorder starts ~0.3 s after it. On at start (`WAKE=0` turns it off); toggles on the control page and in Settings › Voice ›. It pauses while Mars or dictation records and while Mars is talking, so it never hears itself. Needs `npm run setup:keys`.
- **A conversation, not just commands.** Ask a question and Mars answers in a sentence or three. When there's an obvious next step ("Your essay is due Friday. Want me to open it?") it offers it: **Yes / No** on the phone, or just say "yes" / "no". Yes and it does it right away. Anything you say within 3 minutes of its last answer continues the same conversation, so "what's it about?" or "open it" knows what "it" is.
- **Mars talks back.** Answers, yes/no questions and errors are read aloud with ElevenLabs text-to-speech (`server/voice.ts`), streamed into `ffplay` on the laptop. It stops when Mars or dictation starts listening, so it never talks over the mic. Set `ELEVENLABS_VOICE_ID` to change the voice (default: George), or `TTS=0` to keep it silent.

## Mars remembers you (Backboard)

Screen memory remembers what was on the screen. **Backboard** (`server/backboard.ts`) remembers *the person*, across restarts: people they mention, preferences, routines, and what they asked before.

- Before each command, the most relevant memories are looked up (Backboard's semantic memory search) and handed to Gemini ("What you know about this person"). That's how "message my sister" can work.
- Mars has two tools: `remember_about_person` (it saves things like "their sister is Ana" or "they like zoom at 4×", and anything you ask it to remember) and `recall_about_person`.
- Every finished request is saved as a memory too ("Sat 9:14 AM: asked Mars “…” → …"), so the next session knows what you did before.
- One Backboard assistant holds them all. Its id is kept in `data/backboard.json`. The control page shows how many memories there are.
- Needs `BACKBOARD_API_KEY` in `.env` (app.backboard.io; new accounts get $5 of credit). Without it, Mars works as before.

## Screen memory

Mars remembers what was on the screen, so you can ask about it later. It lives in `server/memory/`, with its database on **Tiger Data** (Tiger Cloud: Postgres + TimescaleDB + pgvector + BM25).

- **Recording.** Every 10 s, plus about a second after each click, the screen is grabbed. It's kept only if it changed. The halo moving around doesn't count as a change, and neither do the wheel or the zoom panel. Kept frames are captioned by Gemini (`gemini-3.8-flash`) (app, activity, what the pointer was on, verbatim text) and embedded locally with Ollama (`embeddinggemma`). The cost is about $0.002 a frame, and an idle screen keeps nothing.
- **Stored in Tiger.** Screenshots stay on this laptop (`data/memory/shots/`). Their captions, embeddings and the action log go to Tiger Cloud:
  - `frames` and `events` are **hypertables** on time.
  - Captions are embedded with **pgvector** (HNSW, cosine) and indexed with **BM25** (`pg_textsearch`; plain Postgres full-text search if that extension isn't there).
  - `search_memory` is one SQL query that ranks by meaning and by exact words, then fuses the two rankings (reciprocal rank fusion). So "TS2345" finds the exact error, and "something to cook" finds the recipe.
  - Two **continuous aggregates** (`activity_15m`, `events_15m`) keep screen time per app and clicks/dictations/Mars requests per 15 minutes up to date. They answer "how long was I on YouTube today?" or "when did I click the most?", which is also something a therapist could track over weeks.
- **Asking.** Menu › More › Mars, then ask out loud. Mars gets four extra tools: `search_memory` (meaning + keywords), `memory_timeline` (what happened between two times), `memory_usage` (screen time and activity from the continuous aggregates) and `view_memory_screenshot` (re-opens the real screenshot, zoomed if needed, before quoting exact text). Your clicks, dictation and earlier Mars commands are logged too, so "what did I dictate into that email?" works. For a question about the past it answers from memory without touching the desktop.
- **Off at start.** Use the control page's **Screen memory** button, or `MEMORY=1` in `.env` to start recording with the server. **Stop everything** turns it off too.
- **Privacy.**
  - Kept frames are sent to Google (Gemini) to be captioned. Captions, embeddings and the action log are stored in your Tiger Cloud service; screenshots never leave the laptop.
  - Windows whose title matches `MEMORY_PRIVATE_TITLES` are never saved. By default that covers password managers, private browsing, "bank", chat apps (Discord, Slack, Signal, WhatsApp, Messenger, Telegram), and editors showing `.env`, secrets, credentials or API keys.
  - `touch data/memory/PAUSE` pauses recording; `rm` it to resume.
  - To forget everything: delete `data/memory/` and run `drop schema screen_memory cascade` on the Tiger service.
- **Needs** `TIGER_DATABASE_URL` (a Tiger Cloud service's connection string; the free Shared tier works and has BM25). A new Tiger service first uses Tiger's own CA, then a public certificate, so both the public roots and `server/memory/tiger-ca.pem` are trusted (verified either way), Ollama running with `ollama pull embeddinggemma`, and `GEMINI_API_KEY`. The schema is created on first start. Without Ollama, frames are still kept but captions fail; run `npm run memory:caption` later to catch up.
- **From the terminal:** `npm run memory:ask -- "what was I doing at 3?"` asks the same memory with read-only tools. `npm run test:memory` runs the tests (the database ones in a throwaway schema on Tiger).

Why not stream video to a model? Sending 10 s MP4 batches is the obvious design. Change-gated stills cost less, need no Python or Chroma, and keep a real screenshot that Mars can zoom into when a caption isn't enough.

## Stopping things

- **Phone:** Menu › More › Pause, or Right (Cancel / Stop) during Mars or dictation.
- **Control page:** **Stop everything** or <kbd>Esc</kbd> turns off the phone mouse, keys and screen memory, and cancels Mars. With the mouse off, the phone's **Menu** button (labelled "Mouse on") or the page's Phone mouse button turns it back on.
- **`MAX_STEPS`** (default 30) caps Gemini's turns per command.

## How it works

```
phone (remote.html via ngrok)  ── WebRTC, LAN ──►  control page (index.html, Chrome app window)
  "pointer": Gymote's 8-byte packets                raw x, y (already desktop px) → gm:raw
  "events": Left / Right / Menu, speed  ◄── state + button labels ── relays both ways
                                                    ── Vite dev websocket (local page only) ──►
server/pointer/    brain.ts every 10 ms: One Euro → I-VT lock → snap → spring → dwell; wheel, zoom, scroll
server/plugin.ts   xdotool mousemove / mousedown / click (newest move wins, buttons never dropped)
server/halo.py     the halo, target glow, dwell ring, wheel and zoom panel (click-through, hides the arrow; animated)
server/theme.py    the overlays' look: a night sky (navy glass, starlight blue, one warm accent), easing, glass/shadow/Pango helpers
server/wake.py     "Hey Mars" + spoken yes/no, offline (Vosk), driven by server/wake.ts
server/targets.py  AT-SPI: clickable rectangles in the active window, for snapping
server/keys.ts     server/keys.py: arecord → Vosk (word list) → hold/tap/stop → xdotool key/keydown/keyup
server/speech.ts   arecord + ElevenLabs Scribe, shared by:
server/mars.ts       speech → server/agent.ts (Gemini computer use) → server/computer.ts
server/gemini.ts   the Gemini REST client: interact() (Interactions API) and generateJson() (structured output)
server/dictation.ts  speech → xdotool type
server/memory/     screen memory: recorder.ts (x11grab → change gate → caption.ts Gemini → embed.ts Ollama → db.ts Tiger Cloud),
                   memory.ts + tools.ts (hybrid search / timeline / usage / re-look, given to agent.ts)
server/backboard.ts  Mars's long-term memory of the person (Backboard), recalled into each command
server/voice.ts    Mars's answers out loud: ElevenLabs TTS → ffplay
server/overlay.py  the status pill: GTK + cairo, slides/fades in, resizes smoothly, an icon per state (level bars, spinner, check, ?…)
```

- **Why a page in the middle.** Node has no WebRTC. The page only relays; the server does all mic capture and every action, so the page needs no permissions.
- **Desktop coordinates.** The page tells the phone the desktop's size (from xdotool), not its own, so Gymote's x, y are already screen pixels. Sensitivity is the "phone distance" (−/+ on the page, remembered). At 1.5 × the screen width, you turn about 37° to cross the screen.
- **Who can control it.**
  - Vite binds to `127.0.0.1`, so nothing is exposed on the LAN.
  - The dev websocket also serves the phone page (through ngrok). The server only takes commands from sockets that come from loopback *without* ngrok's `X-Forwarded-For` header.
  - WebRTC signaling (`/api/link/*`) and the fallback relay (`link:relay` on the dev websocket) need the pairing code, which only the local page gets.
- **Gymote bugs.** Two phone-side workarounds for Gymote (`src/remote/main.ts`): the Android gyroscope start, and retries for a reading of exactly 0. The laptop side doesn't use `GymoteScreen` any more (its fixed easing needed a re-feed hack); the raw packet goes straight to `server/pointer/`.
- **Python helpers and VS Code.** Started from VS Code's snap terminal, the environment points GTK at the snap's libraries and the system Python crashes. `server/env.ts` strips those for the helpers.
- **Ported from our earlier hackathon prototypes** (not in this repo):
  - gymote-playground: `src/net/*`, `src/gymote.d.ts`, `server/signaling.ts` (+ token), and the phone's start flow.
  - gaze-desktop: Pointer coalescing, `overlay.py`, `chrome.sh`.
  - os-control-spike: `agent.ts`, `safety.ts`, and `desktop.ts` (now `computer.ts`).
  - screen-memory: `server/memory/*` (its `capture.ts` became `recorder.ts`, and its `askMemory` loop became Mars's tools).

## Testing without a phone or mic

```bash
npm run test:keys                                   # word → key logic
npm run test:pointer                                # filter, lock + creep, spring, snap, dwell, wheel, zoom, scroll, click types, recal, AI merge (fake time)
npm run look                                        # one AI-targets look at the screen, boxes drawn to /tmp/sightline-look.png (one Gemini call)
GM_DEBUG_POINTER=1 npm run dev                      # log fixations, snaps, target scans and each jump's time to 90%
GM_DRY_RUN=1 npm run dev                            # log pointer xdotool calls instead of running them
GM_KEYS_SOURCE="cat clip.pcm" npm run dev           # feed keystroke mode 16 kHz mono s16le PCM instead of the mic
GM_MIC_SOURCE="cat clip.pcm" npm run dev            # the same for Mars and dictation
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
  - Keys on/off, and Mars start then Cancel, update both the phone and the page.
- The trust gate: a websocket with `X-Forwarded-For` gets no token and can't move the pointer, and `/api/link/*` without the code returns 403.
- Vosk on a spoken clip ("left, left, hold up, stop up, jump, hold down, stop") heard all 11 words in order.
- Latency (replaying "left left left" through the server): each word was pressed 50–70 ms *before* the spoken word ended, with decoding 0 ms behind. arecord now uses 10 ms periods. The default delivered audio in 125 ms blocks, the first ~250 ms after start.

**Drag fix and dictation (2026-10-11):**
- **Drag & drop through zoom picked nothing up.** A GTK test window driven by xdotool, with the dev server's overlay up, reproduced it:
  - one big move after the press started a drag but it never reached the target;
  - steps of 50 px or less always dropped.
- After the fix, a real (not dry-run) server dropped onto the target:
  - the drive was Menu › Click › Drag & drop, Menu › Zoom, Left on the source in the panel, move, Left;
  - the grab landed 1 px from the source's center;
  - drag-begin was followed by 14 drag-motion events over the target, then the drop.
- `npm run test:pointer` passes 34 cases. The new ones:
  - a zoom grab with dwell on survives 2 s of holding still;
  - real moves while dragging are ≤ 12 px apart;
  - a button click with dwell on isn't followed by a dwell click on the same spot.
- **Dictation**, on a dry-run server with `GM_MIC_SOURCE` playing an ElevenLabs TTS clip:
  - Menu › More › Dictate gave Type it / Cancel labels;
  - Type it gave `xdotool type --clearmodifiers --delay 12 -- "Hello world, this is a dictation test"`;
  - Cancel typed nothing.
  - Keys pausing during dictation wasn't checked (keys were off); it reuses Mars's path.

**Three buttons, wheel, zoom-click, button scrolling (2026-10-11):**
- `npm run test:pointer` passes 32 cases. The new ones cover:
  - the wheel's layout, which stays on screen even in a corner, with tiles at least 2.4° from the center;
  - submenus, Back and Close with no app click and no pointer move;
  - dwell on a tile, and server items going to the server;
  - Double, Drag and cancel click types;
  - scroll taps and holding (8–10 notches per held second at 8/s);
  - zoom: the snapshot region, the mapping back to real px, the click, the pin, and cancel;
  - Pause from the wheel.
- A dry-run server driven by a script pressing Left/Right/Menu like the phone:
  - Menu › Click › Double then Left gave `click --repeat 2`.
  - Scroll with Left held for 1 s gave 7 notches of `click 4`.
  - Zoom then a 60 px aim offset clicked 20 px off the real point (705,396 vs 703,394 expected, with the script's 0–3 px jitter).
  - The phone labels followed each state.
- Screenshots of the real overlay:
  - The wheel, its submenu and the scroll chip render as designed.
  - The zoom snapshot doesn't capture the wheel.
- The phone layout, checked at Pixel 7 size.

**Creep and AI targets (2026-10-11):**
- `npm run test:pointer` passes 26 cases. The new ones:
  - A 0.5° correction while locked arrives without starting a new fixation, and tremor still doesn't creep.
  - The AT-SPI/AI merge works.
  - Box cleanup scales, clamps, and drops tiny boxes (and the old strip, since removed).
  - AI targets don't train the offset.
- `npm run look` on a VS Code screen with "0 targets" from AT-SPI found 74 boxes in 15.7 s for $0.032. They sat tightly on menus, tabs, the dock, window controls and status-bar items. A few activity-bar and tray icons were missed.
- Dry-run server with a script pointing for 45 s, then going quiet for 40 s:
  - The first look was thrown away because the screen changed during it; the second went live with 41 boxes.
  - A brief change came back from the cache 0.4 s later.
  - There were no looks once the input stopped.
  - Total: $0.04.

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

**Rename to Mars and the new wake word (2026-10-11):**
- `npm run build`, `npm run test:pointer` (34) and `npm run test:keys` pass, and `npm run test:memory` passes 8 of 8 on Tiger with the `mars` event kind.
- `wake.py` on ElevenLabs TTS clips, two voices: "Hey Mars", "Hey Mars, open my email" and "Hey, Mars!" woke it 6 of 6 times. 26 sound-alike clips ("Hey Mark", "Hey mom", "Hey Marcus", "It's March already", "I ate a Mars bar", "Hey Orion"…) woke it 0 times. Spoken yes / yeah / no / nope still answer.
- One-word decoys weren't enough: "hey" then "mark" lost to the single phrase "hey mars", so "Hey Mark" woke it. The decoys are whole phrases now ("hey mark").

**Not covered by the automated runs above:** a real phone in hand, the new pointer with a real phone, keystroke mode on the live mic, and a Mars command end to end from the phone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pointer freezes when another window covers the page | Use `npm run app`, not a normal tab, and don't minimise it |
| QR says no ngrok tunnel | Run `ngrok http 127.0.0.1:5176` (not `localhost`, which may resolve to IPv6) |
| Phone says "Open this page from the QR code", or never connects after a restart | The link is missing its `?k=` pairing code, or it's stale. Restarting `npm run dev` makes a new code: the control page reloads itself with it, but the phone has to rescan. Edits to server files keep the code |
| "connected via relay" / higher round trip | Wi-Fi blocks phone↔laptop traffic, so the link goes through ngrok. It works, but use the phone's hotspot for the direct link |
| Phone stuck on "connecting…" | Neither path works. Check that the phone page came from the QR code (ngrok), and see whether a Docker network shares the Wi-Fi subnet: `ip route get <phone ip>` must name the Wi-Fi interface |
| Pointer drifts sideways over time | Compass heading drift. Press **Center** |
| Keys button says n/a | Run `npm run setup:keys` and restart `npm run dev` |
| Keys mishears in a noisy room | Speak the words crisply. Raise `STABLE_CHUNKS` in `server/keys.py` (fewer flips, +50 ms each) |
| Mars says "no … key" | Put `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` in `.env` and restart |
| Clicks land in the wrong place | Center first, then aim. The click lands where the pointer visibly is |
| No halo or wheel, and the arrow stays | `halo.py` needs a compositor (GNOME has one) and system `python3-gi`. Check the server log for "halo.py exited" |
| "0 targets" on the control page | That app hides its accessibility tree. See [Pointer → Snapping](#pointer) |
| The pointer locks too soon or feels sticky | Raise `MOTION.LOCK_DEG` or lower `MOTION.FIX_VEL` in `server/pointer/motion.ts` |
| Dwell clicks things you didn't mean | Turn Dwell off and use the phone's Click, or raise the base time. It also lengthens itself after quick retries |
