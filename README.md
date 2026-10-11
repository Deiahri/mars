# Sightline

**Hands-free desktop control. Your eyes point; a switch or your voice does the rest.**

Sightline is an open eye-tracking setup you build yourself, for people who can talk but can't use their hands well: spinal cord injury, muscular dystrophy, ALS, MS, stroke, severe arthritis. Two ESP32 cameras on a head mount watch the eyes. A pointer built around how gaze really behaves moves the real mouse. Voice handles the rest: dictation, game keys, and **Orion**, an assistant that operates the computer for you.

Built at **CodeRED Orion 2026** (University of Houston, Oct 10–11).

## Why

- **Voice control types well but points badly.** Windows Voice Access, Voice Control and Dragon are free or cheap and great for dictation. Pointing by voice means number grids: "show grid, seven, three, click".
- **Eye trackers fix pointing, but they're expensive and closed.** A Tobii Dynavox PCEye 5 is about [$1,249](https://montech.ruralinstitute.umt.edu/mtdb/item_view.asp?ID=8366).
- **Every body is different.** An open build can be refit to one person. A closed device can't.

We're not trying to out-build a medical-grade tracker. We're making something cheap and open that anyone can build, adapt to someone they care about, and improve.

## What it does

### A pointer made for eyes

Raw gaze makes a bad mouse: it jitters, drifts and lands a little off. The pointer layer ([`desktop/server/pointer/`](desktop/server/pointer/)) is designed around that:

- **Smoothing without lag.** A One Euro filter smooths hard when you're still and barely at all when you move.
- **Fixation lock.** Hold still for 100 ms and the pointer locks, so tremor doesn't move it at all.
- **Creep.** A small, slow correction toward a nearby button still gets through the lock.
- **No overshoot.** A critically damped spring moves the real pointer: a jump is 90% done in about 70–80 ms.
- **A halo, not an arrow.** The OS arrow is hidden and a soft halo shows where you're pointing, so the cursor doesn't pull your eye after it.
- **Nothing is clicked just because you looked at it.** Clicks come from a switch. Dwell-to-click is there, but off by default.

### Everything from three switches

Many switch users have two or three switches. Sightline needs three: **Left**, **Right** and **Menu**. Menu opens an on-screen wheel around the pointer:

- **Zoom-click:** a frozen 3× snapshot around the pointer, for hitting small targets. Nothing moves under your eye.
- **Click types:** double, triple, middle, and drag & drop.
- **Scroll**, **Pause**, **Dictate**, **Orion**, and **Settings** (dwell, snap-to-buttons, AI targets, voice).
- **Snap to buttons** (optional): uses the accessibility tree, plus Gemini to find buttons in apps that hide theirs.

### Voice

- **Dictation.** Speak, and ElevenLabs Scribe types it into whatever has focus, punctuated and capitalised.
- **Voice keys for games.** Say "left left up", "jump" or "hold up". Offline Vosk listens only for these words, so a key fires about 0.2 s after you say it.
- **"Hey Orion".** An offline wake word, with sound-alike decoys ("hey Ryan", "Oreo") so near-misses don't wake it.

### Orion: an assistant that uses the computer for you

- **Ask in plain words:** "reply to Sam that I'm running late", "open the recipe I had up this morning". Gemini computer use (`gemini-3.8-flash`) sees the screen and drives the real desktop.
- **It talks back** with ElevenLabs text-to-speech, and offers the obvious next step ("Your essay is due Friday. Want me to open it?"). You answer yes or no.
- **You stay in control.** Nothing is sent until you press OK. Gemini's own safety checks come to you as Yes / No, and Stop works at any moment.

### Memory

- **Screen memory, on Tiger Data.** Orion remembers what was on the screen, so you can ask "what was that error in my terminal earlier?" or "how long was I on YouTube today?".
  - Changed frames are captioned by Gemini and embedded locally (Ollama).
  - They're stored in Tiger Cloud, and search combines meaning with exact words.
  - Screenshots never leave the laptop.
- **It remembers you, on Backboard.** Say "remember that my sister is Ana" once, and next week "message my sister" just works.

### Eye cams and head mount

<img src="mount/preview.png" alt="The 3D-printed face mount" width="360" align="right">

- **The mount:** a 3D-printed, glasses-style frame that rests on the nose and ears. It's about an hour to print in PLA, and the Blender source is included so it can be refit to one person's face.
- **On the head:** ESP32-CAM firmware streams MJPEG over plain HTTP (the first HTTPS/base64 attempt ran out of memory).
- **On the laptop:** a reader keeps only the newest frame, so latency stays flat, and finds the pupil as the darkest round blob.

<br clear="right">

## Status

| Part | State |
|---|---|
| Pointer, wheel, zoom-click, click types, scroll, dwell | Working. 34 automated pointer tests pass |
| Dictation, voice keys, "Hey Orion" | Working |
| Orion (Gemini computer use) with spoken replies | Working |
| Screen memory (Tiger Cloud), person memory (Backboard) | Working |
| Eye-cam firmware | Compiles (arduino-cli, esp32 core 3.3.12) |
| Laptop pupil reader | Tested against a simulated ESP32 stream: 24 fps, pupil found in 138 of 138 frames |
| Eye cams → pointer | **Next:** IR LEDs, and calibrating pupil position to a point on the screen |

**Right now a phone stands in for the eyes.** The pointer only takes raw aim. It doesn't care where the aim comes from. While the eye cams were being built, we drove it with a phone held like a TV remote ([Gymote](https://github.com/dulnan/gymote): the gyroscope gives a point on the screen). The phone's three buttons are the three switches. Like gaze, phone aim is jittery and drifts, which made it a good stand-in for tuning the pointer. The eye cams will plug in at the same point.

## How it works

```mermaid
flowchart LR
  eyes["Eye cams<br/>2× ESP32-CAM"] -. next .-> brain
  phone["Phone remote<br/>(stand-in for gaze)"] -- "aim + 3 switches" --> brain
  mic["Microphone"] --> voice

  subgraph laptop["Laptop (Linux, X11)"]
    brain["Pointer brain<br/>filter → lock → snap → spring → dwell<br/>wheel · zoom · scroll"]
    voice["Voice<br/>Vosk keys + wake word<br/>ElevenLabs Scribe"]
    orion["Orion<br/>Gemini computer use"]
    overlay["Overlays<br/>halo · wheel · zoom · status pill"]
    memory["Screen memory<br/>Gemini captions + local embeddings"]
  end

  brain --> xdo["xdotool<br/>real pointer, clicks, keys"]
  brain --> overlay
  voice --> xdo
  voice --> orion
  orion --> xdo
  orion <--> memory
  memory <--> tiger[("Tiger Cloud")]
  orion <--> bb[("Backboard")]
  orion --> tts["ElevenLabs TTS"]
```

The phone links to the laptop over WebRTC. The server does all mic capture and every action. Details are in [`desktop/README.md`](desktop/README.md#how-it-works).

## Sponsor tech

- **Gemini API.**
  - Orion runs on Gemini computer use: the Interactions API's `computer_use` tool with `environment: "desktop"`, plus our own function tools.
  - Gemini also captions screen-memory frames, and finds clickable boxes (`box_2d`) in apps that hide their accessibility tree.
  - Code: [`gemini.ts`](desktop/server/gemini.ts), [`agent.ts`](desktop/server/agent.ts), [`vision-targets.ts`](desktop/server/vision-targets.ts), [`memory/caption.ts`](desktop/server/memory/caption.ts).
- **ElevenLabs.**
  - Scribe turns speech into text for dictation and Orion commands.
  - Text-to-speech gives Orion its voice.
  - Code: [`speech.ts`](desktop/server/speech.ts), [`dictation.ts`](desktop/server/dictation.ts), [`voice.ts`](desktop/server/voice.ts).
- **Tiger Data.** Screen memory lives in Tiger Cloud:
  - `frames` and `events` are hypertables.
  - Search is one SQL query: pgvector (HNSW) and BM25 (`pg_textsearch`) rankings, fused by reciprocal rank fusion.
  - The continuous aggregates `activity_15m` and `events_15m` answer screen-time questions. A therapist could follow the same numbers over weeks.
  - Code: [`memory/db.ts`](desktop/server/memory/db.ts).
- **Backboard.** Long-term memory of the person: people, preferences and past requests. It's recalled into each Orion request, and Orion has tools to save and look things up. Code: [`backboard.ts`](desktop/server/backboard.ts).

Also built with: Vosk, Ollama (`embeddinggemma`), AT-SPI, GTK + cairo, Gymote, Vite + TypeScript, the ESP32 Arduino core, and OpenCV.

## Repo layout

| Folder | What's in it |
|---|---|
| [`desktop/`](desktop/) | The laptop app: pointer, wheel, overlays, dictation, voice keys, Orion, memory. Full guide in [`desktop/README.md`](desktop/README.md) |
| [`eyecam/`](eyecam/) | ESP32-CAM firmware, flash script and laptop pupil reader. Wiring and flashing in [`eyecam/README.md`](eyecam/README.md) |
| [`mount/`](mount/) | The 3D-printed head mount: STL files, the Blender source, and print settings in [`mount/README.md`](mount/README.md) |

## Run it

**Desktop app.** It needs Linux on an **X11** session; on GNOME, pick "Ubuntu on Xorg" at login.

```bash
sudo apt install xdotool x11-utils ffmpeg alsa-utils python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-atspi-2.0
cd desktop
npm install
npm run setup:keys          # once: offline Vosk model for voice keys and "Hey Orion"
cp .env.example .env        # GEMINI_API_KEY, ELEVENLABS_API_KEY; optional BACKBOARD_API_KEY, TIGER_DATABASE_URL
npm run dev                 # server on 127.0.0.1:5176
npm run app                 # second terminal: the control page in its own Chrome window
ngrok http 127.0.0.1:5176   # third terminal: phones need https for motion data
```

Scan the QR code on the control page with the phone and tap **Tap to start**. Screen memory also needs Ollama (`ollama pull embeddinggemma`).

**Eye cams.** Copy `eyecam/hardware/eyecam_stream/secrets.example.h` to `secrets.h`, then flash with `eyecam/hardware/flash.sh` (FTDI adapter at 5 V, IO0 to GND). Then run:

```bash
cd eyecam/host
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python eyecam.py <esp32-ip>
```

**Testing without a phone or mic:**

```bash
cd desktop
npm run test:pointer        # 34 pointer cases, with fake time
npm run test:keys           # voice word → key logic
GM_DRY_RUN=1 npm run dev    # log pointer actions instead of moving the mouse
```

## Safety and privacy

- **Orion asks first.** It does nothing with a recording until you press OK. With `SAFE_MODE=1` it asks before risky actions. While it works, Right on the phone stops it.
- **Screen memory is off until you turn it on.**
  - Screenshots stay on the laptop.
  - Windows that look private are never saved: password managers, private browsing, banking, chat apps, and editors showing `.env` files or keys.
- **Nobody else can drive it.** The server listens only on loopback, and the phone needs the pairing code from the QR.
- **IR needs a check first.** The eye-cam firmware forces the board's flash LED off, since it sits next to an eye. IR illumination needs an eye-safety check before anyone wears it; follow [EyeTrackVR](https://github.com/eyetrackvr/eyetrackvr)'s IR notes.

## What's next

- **Eye cams.** Calibrate pupil position to the screen, add IR, and swap the phone for the eye cams.
- **Head pose.** Use the webcam to fine-tune the aim after a coarse gaze jump.
- **Real users.** Test with occupational therapists and the people this is for. We haven't yet.
- **Weaker voices.** Speech can be affected too: ventilator users, quieter voices with Parkinson's, later-stage ALS. The switch-and-wheel path works without speaking, but it's slower.
- **Mount slip.** The mount can shift on the face and need recalibration.

## Team

- Junda Yin ([@Deiahri](https://github.com/Deiahri))
- Jonah Phillips ([@jonahp-coding](https://github.com/jonahp-coding))
- Gabriel Eisenberg ([@eisenbergabe](https://github.com/eisenbergabe))

## License

[MIT](LICENSE). Build it, change it, fit it to someone, and share what you improve.
