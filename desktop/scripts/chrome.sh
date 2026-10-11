#!/bin/sh
# Opens the page in its own Chrome app window that keeps running while other windows cover it.
# Normal Chrome may throttle a covered window (timers, video frames), and then the pointer freezes.
# A separate profile so the flags apply even if Chrome is already open (and the webcam permission
# is remembered between runs).
dir="$(cd "$(dirname "$0")/.." && pwd)"
exec google-chrome \
  --user-data-dir="$dir/.chrome-profile" \
  --no-first-run --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --app=http://127.0.0.1:5176 "$@"
