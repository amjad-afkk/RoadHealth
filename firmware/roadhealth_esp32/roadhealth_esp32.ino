#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <TinyGPS++.h>

const char* WIFI_SSID     = "vivo v29";
const char* WIFI_PASSWORD = "2909072006";
const char* SERVER_URL    = "https://roadhealth.onrender.com/api/v1/telemetry";
const char* DEVICE_ID     = "ESP32-NODE-TS09-EA-4412";

#define MPU6500_ADDR     0x68
#define GPS_BAUD         9600
#define GPS_RX_PIN       16
#define GPS_TX_PIN       17
#define I2C_SDA          21
#define I2C_SCL          22

#define SEND_INTERVAL_MS 1000
#define SAMPLE_RATE_HZ   100
#define SAMPLE_DELAY_MS  (1000 / SAMPLE_RATE_HZ)

#define Z_SPIKE_THRESHOLD_G   2.2
#define IRI_POTHOLE_THRESHOLD 6.0
#define BASELINE_ALPHA        0.02
#define GRAVITY_MS2           9.81

TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
WiFiClientSecure secureClient;

float accelOffsetX = 0, accelOffsetY = 0, accelOffsetZ = 0;
float gyroOffsetX = 0, gyroOffsetY = 0, gyroOffsetZ = 0;

float sumAccelX = 0, sumAccelY = 0, sumAccelZ = 0;
float sumGyroX = 0, sumGyroY = 0;

float vibrationEnergy = 0;
float maxGForce = 0;
float dynamicBaseline = GRAVITY_MS2;
float calibrationNoise = 0;
bool baselineReady = false;
int sampleCount = 0;

double currentLat = 0, currentLng = 0;
float currentSpeed = 0;
int satellites = 0;
bool gpsFixed = false;

unsigned long lastSendTime = 0;
unsigned long lastSampleTime = 0;
unsigned long lastStatusTime = 0;

void setup() {
    Serial.begin(115200);
    delay(1500); 
    Serial.println("\n=================================");
    Serial.println(" RoadHealth ESP32 Booting...");
    Serial.println("=================================");

    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.setClock(400000);
    Wire.setTimeOut(200); 
    Serial.println("[SYS] I2C Initialized");

    if (!initMPU6500()) {
        Serial.println("[ERROR] MPU6500 not found! Check wiring (SDA/SCL). Halting.");
        while(1) { delay(1000); } 
    }
    
    calibrateMPU6500();

    gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    Serial.println("[SYS] GPS Initialized on Serial2");

    secureClient.setInsecure(); 

    connectWiFi();
    
    Serial.println("[SYS] Setup Complete. Entering Main Loop.\n");
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
        satellites = gps.satellites.value();
        gpsFixed = true;
    }

    if (now - lastSampleTime >= SAMPLE_DELAY_MS) {
        lastSampleTime = now;
        sampleMPU6500();
    }

    if (now - lastStatusTime >= 3000) {
        lastStatusTime = now;
        if (!gpsFixed) {
            Serial.printf("[INFO] Waiting for GPS Fix... Satellites tracked: %d\n", gps.satellites.value());
        }
    }

    if (now - lastSendTime >= SEND_INTERVAL_MS) {
        lastSendTime = now;
        
        if (gpsFixed && WiFi.status() == WL_CONNECTED) {
            sendTelemetry();
        } else if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[WARN] WiFi lost. Reconnecting...");
            connectWiFi();
        }
    }
}

bool initMPU6500() {
    uint8_t whoami = readRegister(0x75);
    Serial.printf("[MPU] WHO_AM_I register: 0x%02X\n", whoami);
    
    if (whoami != 0x70 && whoami != 0x71 && whoami != 0x68 && whoami != 0x98) {
        return false; 
    }

    writeRegister(0x6B, 0x00); 
    writeRegister(0x1C, 0x10); 
    writeRegister(0x1B, 0x08); 
    writeRegister(0x1A, 0x03); 
    Serial.println("[MPU] Configuration Successful");
    return true;
}

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
    if (Wire.available()) return Wire.read();
    return 0;
}

void calibrateMPU6500() {
    Serial.println("[MPU] Calibrating... Keep device STILL!");
    
    const int samples = 500;
    bool completed = false;

    for (int attempt = 0; attempt < 3 && !completed; attempt++) {
        double sumAx = 0, sumAy = 0, sumAz = 0;
        double sumGx = 0, sumGy = 0, sumGz = 0;
        double sumSqAx = 0, sumSqAy = 0, sumSqAz = 0;
        double sumSqGx = 0, sumSqGy = 0, sumSqGz = 0;
        int count = 0;

        for (int i = 0; i < samples; i++) {
            int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
            
            if (readMPU6500Raw(rawAx, rawAy, rawAz, rawGx, rawGy, rawGz)) {
                float ax = rawAx / 4096.0;
                float ay = rawAy / 4096.0;
                float az = rawAz / 4096.0;
                float gx = rawGx / 65.5;
                float gy = rawGy / 65.5;
                float gz = rawGz / 65.5;

                sumAx += ax;
                sumAy += ay;
                sumAz += az;
                sumGx += gx;
                sumGy += gy;
                sumGz += gz;

                sumSqAx += ax * ax;
                sumSqAy += ay * ay;
                sumSqAz += az * az;
                sumSqGx += gx * gx;
                sumSqGy += gy * gy;
                sumSqGz += gz * gz;

                count++;
            }

            delay(2);
        }

        if (count > 100) {
            float meanAx = sumAx / count;
            float meanAy = sumAy / count;
            float meanAz = sumAz / count;
            float meanGx = sumGx / count;
            float meanGy = sumGy / count;
            float meanGz = sumGz / count;

            float varAx = (sumSqAx / count) - (meanAx * meanAx);
            float varAy = (sumSqAy / count) - (meanAy * meanAy);
            float varAz = (sumSqAz / count) - (meanAz * meanAz);
            float varGx = (sumSqGx / count) - (meanGx * meanGx);
            float varGy = (sumSqGy / count) - (meanGy * meanGy);
            float varGz = (sumSqGz / count) - (meanGz * meanGz);

            if (varAx < 0) varAx = 0;
            if (varAy < 0) varAy = 0;
            if (varAz < 0) varAz = 0;
            if (varGx < 0) varGx = 0;
            if (varGy < 0) varGy = 0;
            if (varGz < 0) varGz = 0;

            float accelStability = sqrt(varAx) + sqrt(varAy) + sqrt(varAz);
            float gyroStability = sqrt(varGx) + sqrt(varGy) + sqrt(varGz);

            if ((accelStability < 0.30 && gyroStability < 30.0) || attempt == 2) {
                accelOffsetX = meanAx;
                accelOffsetY = meanAy;
                accelOffsetZ = meanAz - 1.0;

                gyroOffsetX = meanGx;
                gyroOffsetY = meanGy;
                gyroOffsetZ = meanGz;

                calibrationNoise = sqrt(varAx + varAy + varAz);
                completed = true;
            }
        }

        delay(100);
    }

    if (!completed) {
        accelOffsetX = 0;
        accelOffsetY = 0;
        accelOffsetZ = 0;
        gyroOffsetX = 0;
        gyroOffsetY = 0;
        gyroOffsetZ = 0;
        calibrationNoise = 0.05;
    }

    Serial.println("[MPU] Calibration Complete.");
}

bool readMPU6500Raw(int16_t &ax, int16_t &ay, int16_t &az, int16_t &gx, int16_t &gy, int16_t &gz) {
    Wire.beginTransmission(MPU6500_ADDR);
    Wire.write(0x3B);
    
    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    uint8_t received = Wire.requestFrom((uint8_t)MPU6500_ADDR, (uint8_t)14, (uint8_t)true);
    
    if (received < 14) {
        return false;
    }

    ax = (Wire.read() << 8) | Wire.read();
    ay = (Wire.read() << 8) | Wire.read();
    az = (Wire.read() << 8) | Wire.read();
    Wire.read();
    Wire.read();
    gx = (Wire.read() << 8) | Wire.read();
    gy = (Wire.read() << 8) | Wire.read();
    gz = (Wire.read() << 8) | Wire.read();

    return true;
}

void sampleMPU6500() {
    int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
    
    if (!readMPU6500Raw(rawAx, rawAy, rawAz, rawGx, rawGy, rawGz)) {
        return;
    }

    float ax = ((rawAx / 4096.0) - accelOffsetX) * GRAVITY_MS2;
    float ay = ((rawAy / 4096.0) - accelOffsetY) * GRAVITY_MS2;
    float az = ((rawAz / 4096.0) - accelOffsetZ) * GRAVITY_MS2;

    float gx = (rawGx / 65.5) - gyroOffsetX;
    float gy = (rawGy / 65.5) - gyroOffsetY;

    sumAccelX += ax;
    sumAccelY += ay;
    sumAccelZ += az;
    sumGyroX += gx;
    sumGyroY += gy;

    float accelMagnitude = sqrt(ax * ax + ay * ay + az * az);

    if (!baselineReady) {
        dynamicBaseline = accelMagnitude;
        baselineReady = true;
    }

    dynamicBaseline += BASELINE_ALPHA * (accelMagnitude - dynamicBaseline);

    float dynamicAcceleration = accelMagnitude - dynamicBaseline;
    float currentGForce = fabs(dynamicAcceleration) / GRAVITY_MS2;

    if (currentGForce > maxGForce) {
        maxGForce = currentGForce;
    }

    vibrationEnergy += dynamicAcceleration * dynamicAcceleration;
    sampleCount++;
}

void connectWiFi() {
    Serial.printf("[WiFi] Connecting to %s ", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\n[WiFi] Connection Failed! Will retry later.");
    }
}

void sendTelemetry() {
    if (sampleCount == 0) return;

    float avgAx = sumAccelX / sampleCount;
    float avgAy = sumAccelY / sampleCount;
    float avgAz = sumAccelZ / sampleCount;
    float avgGx = sumGyroX / sampleCount;
    float avgGy = sumGyroY / sampleCount;

    float rmsVibration = sqrt(vibrationEnergy / sampleCount);
    float avgVibration = sqrt(avgAx * avgAx + avgAy * avgAy + (avgAz - GRAVITY_MS2) * (avgAz - GRAVITY_MS2));
    
    float vibration = rmsVibration;
    if (avgVibration > vibration) {
        vibration = avgVibration;
    }

    float iriEstimate = vibration * 2.8;

    float spikeThreshold = Z_SPIKE_THRESHOLD_G;
    if (calibrationNoise > 0.01) {
        float noiseThreshold = calibrationNoise * 14.0;
        if (noiseThreshold > spikeThreshold) {
            spikeThreshold = noiseThreshold;
        }
        if (spikeThreshold > 4.5) {
            spikeThreshold = 4.5;
        }
    }

    bool spikeTrigger = maxGForce >= spikeThreshold;
    bool roughnessTrigger = iriEstimate >= IRI_POTHOLE_THRESHOLD;
    bool potholeTrigger = spikeTrigger || roughnessTrigger;

    String payload;
    payload.reserve(300);
    payload += "{";
    payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
    payload += "\"lat\":" + String(currentLat, 6) + ",";
    payload += "\"lng\":" + String(currentLng, 6) + ",";
    payload += "\"speed\":" + String(currentSpeed, 1) + ",";
    payload += "\"accel\":{\"x\":" + String(avgAx, 3) + ",\"y\":" + String(avgAy, 3) + ",\"z\":" + String(avgAz, 3) + "},";
    payload += "\"gyro\":{\"pitch\":" + String(avgGx, 3) + ",\"roll\":" + String(avgGy, 3) + "},";
    payload += "\"iriEstimate\":" + String(iriEstimate, 3) + ",";
    payload += "\"vibrationMagnitude\":" + String(vibration, 3) + ",";
    payload += "\"potholeTrigger\":" + String(potholeTrigger ? "true" : "false") + "}";

    HTTPClient http;
    http.begin(secureClient, SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    
    http.setConnectTimeout(15000);
    http.setTimeout(20000); 
    
    int httpCode = http.POST(payload);
    
    if (httpCode > 0) {
        if (httpCode == 200 || httpCode == 201) {
            Serial.printf("[TX] OK | Lat: %.4f, Lng: %.4f | Spd: %.0f | IRI: %.1f | Pothole: %s\n", 
                          currentLat, currentLng, currentSpeed, iriEstimate, potholeTrigger ? "YES" : "NO");
        } else {
            Serial.printf("[TX] Server responded with HTTP %d\n", httpCode);
        }
    } else {
        Serial.printf("[TX] HTTP Error: %s\n", http.errorToString(httpCode).c_str());
    }
    
    http.end();

    sumAccelX = 0;
    sumAccelY = 0;
    sumAccelZ = 0;
    sumGyroX = 0;
    sumGyroY = 0;
    vibrationEnergy = 0;
    maxGForce = 0;
    sampleCount = 0;
}