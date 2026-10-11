# Eye cam: ESP32-CAM → laptop stream

Instead of the ESP32 pushing frames to a server, it now serves an MJPEG stream and the laptop pulls it.

## Why `hardware/esp32.cpp` crashed

That sketch fails with "Connection failed! Still out of memory for SSL." Five causes:

1. **HTTPS.** `WiFiClientSecure` needs ~40 KB of contiguous heap, and the camera and Wi-Fi have already used it. HTTPS to a LAN IP doesn't buy anything.
2. **Uninitialized `camera_config_t`.** Newer esp32-camera versions read `fb_location`, `grab_mode` and `sccb_i2c_port`, which were garbage. The sketch also kept running after a failed camera init.
3. **Base64 inside a JSON `String`.** Each frame allocates a buffer ~4/3 the size of the JPEG, which fragments the heap.
4. **One POST every 5 s.** That isn't a stream.
5. **`UHGuest`.** Guest Wi-Fi isolates clients, so the ESP32 can't reach the laptop even with everything else fixed.

## What's here

- **Firmware**, `hardware/eyecam_stream/eyecam_stream.ino`:
  - Plain HTTP.
  - The frame buffer goes straight to the socket, with no copies.
  - The camera starts before Wi-Fi.
  - The flash LED is forced off, because it sits next to an eye.
- **Laptop**, `host/eyecam.py`:
  - Pulls one or more streams and keeps only the newest frame, so latency stays flat.
  - Finds the pupil as the darkest round blob.
  - Shows a live view and prints JSON lines.

## Run it

1. **Hotspot.** Turn on a phone hotspot on **2.4 GHz** (the ESP32 can't see 5 GHz; on iPhone, turn on "Maximize Compatibility"). Connect the laptop to it too.
2. **Flash.**
   - **Credentials.** Copy `hardware/eyecam_stream/secrets.example.h` to `secrets.h` (gitignored) and fill in `WIFI_SSID`, `WIFI_PASS` and `DEVICE_NAME`.
   - **Toolchain, one time.** The Arduino IDE works too (board **AI Thinker ESP32-CAM**), but the script below uses arduino-cli:

     ```sh
     curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=~/.local/bin sh
     arduino-cli config init
     arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
     arduino-cli core update-index && arduino-cli core install esp32:esp32
     ```

   - **Wire the FTDI / USB-TTL adapter.** Set the adapter to 5 V if it has a jumper. On 3.3 V the camera browns out.

     | Adapter | ESP32-CAM |
     |---|---|
     | GND | GND |
     | 5V | 5V |
     | TX | U0R |
     | RX | U0T |

     For flash mode, also jumper **IO0 → GND**.
   - **Run** `hardware/flash.sh`. It compiles, waits while you press RST (with IO0 on GND), uploads, waits while you pull the jumper and press RST, then opens Serial.
     - If the upload fails with "Failed to connect" or "wrong boot mode", check that IO0 is on GND and press RST again. Long jumper wires can garble the upload: retry with `SLOW=1 hardware/flash.sh`.
     - `hardware/flash.sh --monitor` only opens Serial.
3. **Check Serial (115200).** You should see `camera ok`, then `WiFi connected, ip=…`, then a line every 5 s:

   ```
   fps=… heap=… minheap=… rssi=…
   ```

   If `minheap` keeps dropping, there's a leak.
4. **Browser check.** Open `http://<ip>:81/stream`. You should see live video. Also:
   - `http://<ip>/` shows status.
   - `http://<ip>/capture` returns one JPEG.
   - Only one viewer can watch the stream at a time.
5. **Laptop.**

   ```sh
   cd host
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   .venv/bin/python eyecam.py <ip>                     # or two cams: eyecam.py <ip-left> <ip-right>
   ```

   - The overlay shows fps, frame age and the threshold.
   - `[` / `]` tighten or loosen the pupil threshold.
   - `q` quits.
   - Each processed frame prints a line to stdout:

     ```
     {"cam":"cam0","t":…,"px":0.51,"py":0.47,"ok":true}
     ```

     `px`/`py` run 0–1 across the image.

## Status

- **`eyecam.py`: tested** against a fake ESP32 that serves the same chunked MJPEG framing as the firmware, with a synthetic eye:
  - 24 fps, the full rate served.
  - Pupil found in 138 of 138 frames.
  - Median error 0.6 px.
  - Reconnects automatically after the stream drops.
- **Firmware:** compiles cleanly with arduino-cli 1.5.1 and esp32 core 3.3.12 (33% flash, 18% RAM). **Not flashed to a board yet.**
- **Not done:**
  - **IR.** Pupil detection under normal room light will be shaky, so the next step is IR LEDs plus a lens without an IR filter. EyeTrackVR does this; follow its IR safety notes.
  - **Calibration** from pupil position to a point on the screen.
