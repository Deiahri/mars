#!/usr/bin/env bash
# Compile + flash eyecam_stream to an AI-Thinker ESP32-CAM over an FTDI/USB-TTL
# adapter, then open the serial monitor.
#
#   hardware/flash.sh                 auto-detect port
#   hardware/flash.sh /dev/ttyUSB0    explicit port
#   SLOW=1 hardware/flash.sh          upload at 115200 (flaky jumper wires)
#   hardware/flash.sh --monitor       skip flashing, just watch Serial
#
# One-time setup: see eyecam/README.md ("Flash").
set -euo pipefail

FQBN="esp32:esp32:esp32cam"
SKETCH="$(cd "$(dirname "$0")" && pwd)/eyecam_stream"
CLI="$(command -v arduino-cli || echo "$HOME/.local/bin/arduino-cli")"
[ -x "$CLI" ] || { echo "arduino-cli not found: see eyecam/README.md"; exit 1; }

MONITOR_ONLY=0
PORT=""
for a in "$@"; do
  case "$a" in
    --monitor) MONITOR_ONLY=1 ;;
    *) PORT="$a" ;;
  esac
done

if [ -z "$PORT" ]; then
  ports=(/dev/ttyUSB* /dev/ttyACM*)
  ports=($(ls "${ports[@]}" 2>/dev/null || true))
  case ${#ports[@]} in
    0) echo "No /dev/ttyUSB* or /dev/ttyACM*: is the adapter plugged in? (check: dmesg | tail)"; exit 1 ;;
    1) PORT="${ports[0]}" ;;
    *) echo "Several serial ports (${ports[*]}): pass one, e.g. $0 ${ports[0]}"; exit 1 ;;
  esac
fi
echo "port: $PORT"

monitor() {
  echo "Serial monitor at 115200 (Ctrl+C to quit)"
  # FTDI DTR/RTS aren't wired to EN/IO0 here, but keep them low so a
  # wired-up adapter doesn't hold the board in reset.
  exec "$CLI" monitor -p "$PORT" -c baudrate=115200,dtr=off,rts=off
}
[ "$MONITOR_ONLY" = 1 ] && monitor

if [ ! -f "$SKETCH/secrets.h" ]; then
  cp "$SKETCH/secrets.example.h" "$SKETCH/secrets.h"
  echo "Created $SKETCH/secrets.h: put your hotspot SSID/password in it, then rerun."
  exit 1
fi
if grep -q '"your-hotspot"' "$SKETCH/secrets.h"; then
  echo "warning: secrets.h still has the placeholder SSID; the board won't join WiFi."
fi

"$CLI" compile --fqbn "$FQBN" "$SKETCH"

cat <<'EOF'

Put the board in flash mode:
  1. IO0 jumpered to GND
  2. Press RST on the ESP32-CAM (the tiny button underneath)
EOF
read -rp "Press Enter to upload... "

upload_opts=()
[ "${SLOW:-0}" = 1 ] && upload_opts=(--upload-property upload.speed=115200)  # default 460800
"$CLI" upload -p "$PORT" --fqbn "$FQBN" "${upload_opts[@]}" "$SKETCH"

cat <<'EOF'

Flashed. Now run it:
  1. Remove the IO0-GND jumper
  2. Press RST
EOF
read -rp "Press Enter to open the serial monitor... "
monitor
