#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <TinyGPS++.h>
#include <esp_wifi.h>

const char* WIFI_SSID     = "vivo v29";
const char* WIFI_PASSWORD = "2909072006";
const char* SERVER_URL    = "https://roadhealth.onrender.com/api/v1/telemetry";
const char* DEVICE_ID     = "ESP32-NODE-TS09-EA-4412";

#define MPU6500_ADDR          0x68
#define GPS_BAUD              9600
#define GPS_RX_PIN            16
#define GPS_TX_PIN            17
#define I2C_SDA               21
#define I2C_SCL               22

#define SAMPLE_RATE_HZ        200
#define SAMPLE_DELAY_MS       (1000 / SAMPLE_RATE_HZ)
#define Z_SPIKE_THRESHOLD_G   1.5
#define IRI_POTHOLE_THRESHOLD 4.0
#define BASELINE_ALPHA        0.02
#define GRAVITY_MS2           9.81

TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
WiFiClientSecure secureClient;

struct TelemetryData {
  double lat;
  double lng;
  float speed;
  float ax, ay, az;
  float gx, gy;
  float iri;
  float vibration;
  bool pothole;
};

QueueHandle_t telemetryQueue;

float accelOffsetX = 0, accelOffsetY = 0, accelOffsetZ = 0;
float gyroOffsetX = 0, gyroOffsetY = 0, gyroOffsetZ = 0;
float sumAccelX = 0, sumAccelY = 0, sumAccelZ = 0;
float sumGyroX = 0, sumGyroY = 0;
float vibrationEnergy = 0, maxGForce = 0;
float dynamicBaseline = GRAVITY_MS2;
bool baselineReady = false;
int sampleCount = 0;

double currentLat = 17.443500, currentLng = 78.377200;
float currentSpeed = 0;
bool gpsFixed = false;
unsigned long lastSampleTime = 0;
unsigned long lastSendTime = 0;

void writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU6500_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission(true);
}

uint8_t readRegister(uint8_t reg) {
  Wire.beginTransmission(MPU6500_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  Wire.requestFrom((uint8_t)MPU6500_ADDR, (uint8_t)1, (uint8_t)true);
  return Wire.available() ? Wire.read() : 0;
}

bool readMPU6500Raw(int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU6500_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU6500_ADDR, (uint8_t)14, (uint8_t)true) < 14) return false;
  ax = (Wire.read() << 8) | Wire.read();
  ay = (Wire.read() << 8) | Wire.read();
  az = (Wire.read() << 8) | Wire.read();
  Wire.read(); Wire.read();
  gx = (Wire.read() << 8) | Wire.read();
  gy = (Wire.read() << 8) | Wire.read();
  gz = (Wire.read() << 8) | Wire.read();
  return true;
}

bool initMPU6500() {
  uint8_t whoami = readRegister(0x75);
  if (whoami != 0x70 && whoami != 0x71 && whoami != 0x68 && whoami != 0x98) return false;
  writeRegister(0x6B, 0x00);
  writeRegister(0x1C, 0x10);
  writeRegister(0x1B, 0x08);
  writeRegister(0x1A, 0x03);
  return true;
}

void calibrateMPU6500() {
  const int samples = 200;
  double sumAx = 0, sumAy = 0, sumAz = 0, sumGx = 0, sumGy = 0, sumGz = 0;
  int count = 0;
  for (int i = 0; i < samples; i++) {
    int16_t rax, ray, raz, rgx, rgy, rgz;
    if (readMPU6500Raw(rax, ray, raz, rgx, rgy, rgz)) {
      sumAx += rax / 4096.0; sumAy += ray / 4096.0; sumAz += raz / 4096.0;
      sumGx += rgx / 65.5;   sumGy += rgy / 65.5;   sumGz += rgz / 65.5;
      count++;
    }
    delay(2);
  }
  if (count > 50) {
    accelOffsetX = sumAx / count;
    accelOffsetY = sumAy / count;
    accelOffsetZ = (sumAz / count) - 1.0;
    gyroOffsetX  = sumGx / count;
    gyroOffsetY  = sumGy / count;
    gyroOffsetZ  = sumGz / count;
  }
}

void networkTask(void *pvParameters) {
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_15dBm);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  secureClient.setInsecure();

  TelemetryData data;
  HTTPClient http;
  http.setReuse(true);

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.reconnect();
      vTaskDelay(3000 / portTICK_PERIOD_MS);
      continue;
    }

    if (xQueueReceive(telemetryQueue, &data, portMAX_DELAY) == pdTRUE) {
      String payload;
      payload.reserve(256);
      payload += "{\"deviceId\":\"" + String(DEVICE_ID) + "\",";
      payload += "\"lat\":" + String(data.lat, 6) + ",\"lng\":" + String(data.lng, 6) + ",";
      payload += "\"speed\":" + String(data.speed, 1) + ",";
      payload += "\"accel\":{\"x\":" + String(data.ax, 2) + ",\"y\":" + String(data.ay, 2) + ",\"z\":" + String(data.az, 2) + "},";
      payload += "\"gyro\":{\"pitch\":" + String(data.gx, 2) + ",\"roll\":" + String(data.gy, 2) + "},";
      payload += "\"iriEstimate\":" + String(data.iri, 2) + ",";
      payload += "\"vibrationMagnitude\":" + String(data.vibration, 2) + ",";
      payload += "\"potholeTrigger\":" + String(data.pothole ? "true" : "false") + "}";

      http.begin(secureClient, SERVER_URL);
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(3000);
      int code = http.POST(payload);
      if (code > 0) {
        Serial.printf("[TX] HTTP %d | Spd: %.1f | IRI: %.1f | Pothole: %d\n", code, data.speed, data.iri, data.pothole);
      }
      http.end();
    }
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  Wire.setTimeOut(50);

  initMPU6500();
  calibrateMPU6500();

  gpsSerial.setRxBufferSize(512);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  telemetryQueue = xQueueCreate(5, sizeof(TelemetryData));

  xTaskCreatePinnedToCore(networkTask, "NetTask", 8192, NULL, 1, NULL, 0);
}

void loop() {
  unsigned long now = millis();

  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  if (gps.location.isValid()) {
    currentLat = gps.location.lat();
    currentLng = gps.location.lng();
    currentSpeed = gps.speed.kmph();
    gpsFixed = true;
  }

  if (now - lastSampleTime >= SAMPLE_DELAY_MS) {
    lastSampleTime = now;
    int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
    if (readMPU6500Raw(rawAx, rawAy, rawAz, rawGx, rawGy, rawGz)) {
      float ax = ((rawAx / 4096.0) - accelOffsetX) * GRAVITY_MS2;
      float ay = ((rawAy / 4096.0) - accelOffsetY) * GRAVITY_MS2;
      float az = ((rawAz / 4096.0) - accelOffsetZ) * GRAVITY_MS2;
      float gx = (rawGx / 65.5) - gyroOffsetX;
      float gy = (rawGy / 65.5) - gyroOffsetY;

      sumAccelX += ax; sumAccelY += ay; sumAccelZ += az;
      sumGyroX += gx;  sumGyroY += gy;

      float accelMagnitude = sqrt(ax * ax + ay * ay + az * az);
      if (!baselineReady) {
        dynamicBaseline = accelMagnitude;
        baselineReady = true;
      }
      dynamicBaseline += BASELINE_ALPHA * (accelMagnitude - dynamicBaseline);
      float dynamicAccel = accelMagnitude - dynamicBaseline;
      float currentG = fabs(dynamicAccel) / GRAVITY_MS2;
      if (currentG > maxGForce) maxGForce = currentG;

      vibrationEnergy += dynamicAccel * dynamicAccel;
      sampleCount++;
    }
  }

  if (now - lastSendTime >= 500) {
    lastSendTime = now;
    if (sampleCount > 0) {
      TelemetryData item;
      item.lat = gpsFixed ? currentLat : 17.443500;
      item.lng = gpsFixed ? currentLng : 78.377200;
      item.speed = gpsFixed ? currentSpeed : 0.0;
      item.ax = sumAccelX / sampleCount;
      item.ay = sumAccelY / sampleCount;
      item.az = sumAccelZ / sampleCount;
      item.gx = sumGyroX / sampleCount;
      item.gy = sumGyroY / sampleCount;

      item.vibration = sqrt(vibrationEnergy / sampleCount);
      item.iri = item.vibration * 2.8;
      item.pothole = (maxGForce >= Z_SPIKE_THRESHOLD_G) || (item.iri >= IRI_POTHOLE_THRESHOLD);

      xQueueSend(telemetryQueue, &item, 0);
    }
    sumAccelX = sumAccelY = sumAccelZ = 0;
    sumGyroX = sumGyroY = 0;
    vibrationEnergy = 0;
    maxGForce = 0;
    sampleCount = 0;
  }

  vTaskDelay(1 / portTICK_PERIOD_MS);
}
