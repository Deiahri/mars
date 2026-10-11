// Eye cam: AI-Thinker ESP32-CAM serves an MJPEG stream over plain HTTP.
// The laptop pulls it (host/eyecam.py) instead of the ESP32 pushing to a server.
//
//   http://<ip>/          status (name, frame size, heap)
//   http://<ip>/capture   one JPEG
//   http://<ip>:81/stream MJPEG stream (one viewer at a time)
//
// Why not ../esp32.cpp's approach: HTTPS needs ~40 KB of contiguous heap that the
// camera + WiFi have already eaten ("out of memory for SSL"), and base64-in-JSON
// allocates a 4/3-size String per frame. Here the frame buffer goes straight to
// the socket, no copies.

#include <WiFi.h>
#include <ESPmDNS.h>
#include "esp_camera.h"
#include "esp_http_server.h"

// --- Edit these ---
// ESP32 is 2.4 GHz only. Guest/university WiFi (UHGuest) isolates clients, so the
// laptop can't reach the cam there: use a phone/laptop hotspot both devices join.
#define WIFI_SSID   "your-hotspot"
#define WIFI_PASS   "your-password"
#define DEVICE_NAME "eyecam-left"  // "eyecam-right" on the second board -> http://eyecam-left.local
#define GRAYSCALE   1              // pupil tracking only needs luma; grey JPEGs are smaller = more fps

// --- Camera Pins (AI Thinker Model) ---
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define FLASH_LED_GPIO     4

static volatile uint32_t framesSent = 0;

static void halt(const char* why) {
  Serial.println(why);
  while (true) delay(1000);
}

static bool setupCamera() {
  // Zero-init: newer esp32-camera reads fb_location/grab_mode/sccb_i2c_port,
  // which are garbage in an uninitialised local.
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  // LATEST drops stale frames so a slow viewer sees lag, not a growing backlog.
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_QVGA;  // 320x240: plenty for a close-up eye
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size = FRAMESIZE_QQVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;  // LATEST needs 2 buffers
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (GRAYSCALE) s->set_special_effect(s, 2);
  return true;
}

// ---------- HTTP ----------

#define PART_BOUNDARY "eyecamframe"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t streamHandler(httpd_req_t* req) {
  httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  Serial.println("stream client connected");

  char part[64];
  esp_err_t res = ESP_OK;
  // Loops until the client disconnects (send fails). This blocks this server's
  // only task, which is why /stream lives on its own port.
  while (res == ESP_OK) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("frame grab failed");
      res = ESP_FAIL;
      break;
    }
    size_t hlen = snprintf(part, sizeof(part), STREAM_PART, (unsigned)fb->len);
    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, part, hlen);
    if (res == ESP_OK) res = httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len);
    esp_camera_fb_return(fb);
    if (res == ESP_OK) framesSent++;
  }
  Serial.println("stream client gone");
  return res;
}

static esp_err_t captureHandler(httpd_req_t* req) {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t statusHandler(httpd_req_t* req) {
  sensor_t* s = esp_camera_sensor_get();
  char body[256];
  snprintf(body, sizeof(body),
           "%s ip=%s framesize=%d psram=%s heap=%u minheap=%u\nstream: http://%s:81/stream\n",
           DEVICE_NAME, WiFi.localIP().toString().c_str(), s->status.framesize,
           psramFound() ? "yes" : "no", (unsigned)ESP.getFreeHeap(),
           (unsigned)ESP.getMinFreeHeap(), WiFi.localIP().toString().c_str());
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, body, HTTPD_RESP_USE_STRLEN);
}

static void startServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  httpd_handle_t mainServer = NULL;
  httpd_handle_t streamServer = NULL;

  httpd_uri_t statusUri = {"/", HTTP_GET, statusHandler, NULL};
  httpd_uri_t captureUri = {"/capture", HTTP_GET, captureHandler, NULL};
  httpd_uri_t streamUri = {"/stream", HTTP_GET, streamHandler, NULL};

  config.server_port = 80;
  if (httpd_start(&mainServer, &config) != ESP_OK) halt("http server on :80 failed");
  httpd_register_uri_handler(mainServer, &statusUri);
  httpd_register_uri_handler(mainServer, &captureUri);

  config.server_port = 81;
  config.ctrl_port += 1;  // each httpd instance needs its own control port
  if (httpd_start(&streamServer, &config) != ESP_OK) halt("http server on :81 failed");
  httpd_register_uri_handler(streamServer, &streamUri);
}

// ---------- main ----------

void setup() {
  Serial.begin(115200);
  Serial.println();

  // The flash LED is blinding and sits next to an eye: force it off.
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);

  // Camera before WiFi so its buffers get memory before the WiFi stack fragments it.
  if (!setupCamera()) halt("camera init failed: check ribbon cable / power, then reset");
  Serial.println("camera ok");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep adds 100ms+ latency spikes
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("connecting to %s", WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > 30000) {
      Serial.println("\nno WiFi after 30s (wrong SSID/password, or a 5 GHz-only hotspot?) - restarting");
      ESP.restart();
    }
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected, ip=%s\n", WiFi.localIP().toString().c_str());

  if (MDNS.begin(DEVICE_NAME)) MDNS.addService("http", "tcp", 80);

  startServers();
  Serial.printf("stream: http://%s:81/stream  (or http://%s.local:81/stream)\n",
                WiFi.localIP().toString().c_str(), DEVICE_NAME);
}

void loop() {
  // Health line: fps that actually left the board, and heap (minheap dropping
  // over time = leak).
  static uint32_t lastFrames = 0;
  delay(5000);
  uint32_t n = framesSent;
  Serial.printf("fps=%.1f heap=%u minheap=%u rssi=%d\n", (n - lastFrames) / 5.0f,
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(), WiFi.RSSI());
  lastFrames = n;
}
