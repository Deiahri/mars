#include <Arduino.h>

void setup() {
    pinMode(33, OUTPUT);
    Serial.begin(115200);
}

void loop() {
    Serial.println("ON");
    digitalWrite(33, HIGH);
    delay(1000);

    Serial.println("OFF");
    digitalWrite(33, LOW);
    delay(1000);
}