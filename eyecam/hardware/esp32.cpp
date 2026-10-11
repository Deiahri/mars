#include <WiFi.h>
#include <HTTPClient.h>
#include "esp_camera.h"
#include <base64.h> // Ensure you have a base64 library installed

// --- WiFi Configuration ---
const char* ssid = "UHGuest";
const char* password = "";

// --- Server Configuration ---
const char* serverHost = "192.168.1.50"; 
const char* serverPath = "/upload"; // Ensure this starts with a slash
const int serverPort = 443; // 443 is the standard port for HTTPS

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

const int BATCH_SIZE = 1; // Number of images per JSON payload

void setupCamera() {
  camera_config_t config;
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
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  
  // Use lower resolution for batching in JSON to avoid running out of memory
  if(psramFound()){
    config.frame_size = FRAMESIZE_QVGA; 
    config.jpeg_quality = 12;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QQVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }
}

void sendImageBatch() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi Disconnected");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure(); // Bypasses SSL certificate verification

  Serial.println("Connecting to HTTPS server...");
  if (!client.connect(serverHost, serverPort)) {
    Serial.println("Connection failed! Still out of memory for SSL.");
    return;
  }

  // 1. Capture all frames in the batch and store their pointers
  camera_fb_t* fbs[BATCH_SIZE];
  size_t total_b64_size = 0;

  Serial.println("Capturing batch...");
  for (int i = 0; i < BATCH_SIZE; i++) {
    fbs[i] = esp_camera_fb_get();
    if (fbs[i]) {
      // Base64 encoding predictably increases size by 4/3
      total_b64_size += 4 * ((fbs[i]->len + 2) / 3); 
    }
    delay(200);
  }

  // 2. Prepare the JSON structure
  String jsonStart = "{\"device_id\":\"esp32_cam_01\",\"timestamp\":" + String(millis()) + ",\"images\":[\"";
  String jsonSeparator = "\",\"";
  String jsonEnd = "\"]}";

  // 3. Calculate the exact total length of the payload
  size_t content_length = jsonStart.length() + jsonEnd.length() + total_b64_size;
  if (BATCH_SIZE > 1) {
    content_length += (BATCH_SIZE - 1) * jsonSeparator.length();
  }

  // 4. Send standard HTTP Headers
  Serial.println("Sending headers...");
  client.print(String("POST ") + serverPath + " HTTP/1.1\r\n");
  client.print(String("Host: ") + serverHost + "\r\n");
  client.print("Content-Type: application/json\r\n");
  client.print("Content-Length: " + String(content_length) + "\r\n");
  client.print("Connection: close\r\n\r\n");

  // 5. Stream the JSON payload in chunks
  Serial.println("Streaming data chunks...");
  client.print(jsonStart);

  for (int i = 0; i < BATCH_SIZE; i++) {
    if (fbs[i]) {
      // Encode and send one image at a time to save RAM
      String base64Img = base64::encode((uint8_t *)fbs[i]->buf, fbs[i]->len);
      client.print(base64Img); 
      
      // Return the buffer immediately to free up PSRAM
      esp_camera_fb_return(fbs[i]); 
      
      if (i < BATCH_SIZE - 1) {
        client.print(jsonSeparator);
      }
    }
  }
  
  client.print(jsonEnd);

  // 6. Read the server's response
  Serial.println("Waiting for response...");
  while (client.connected()) {
    String line = client.readStringUntil('\n');
    if (line == "\r") { // End of headers
      break; 
    }
  }
  
  // Print the first line of the actual response body
  String response = client.readStringUntil('\n');
  Serial.println("Response: " + response);
  
  client.stop();
}

void setup() {
  Serial.begin(115200);
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  setupCamera();
}

void loop() {
  sendImageBatch();
  delay(5000); // Wait 10 seconds before sending the next batch
}