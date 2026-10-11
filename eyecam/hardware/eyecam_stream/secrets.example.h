// Copy to secrets.h (gitignored) and fill in. hardware/flash.sh does the copy for you.
// ESP32 is 2.4 GHz only. Guest/university WiFi (UHGuest) isolates clients, so the
// laptop can't reach the cam there: use a phone/laptop hotspot both devices join.
#define WIFI_SSID   "your-hotspot"
#define WIFI_PASS   "your-password"
#define DEVICE_NAME "eyecam-left"  // "eyecam-right" on the second board -> http://eyecam-left.local
