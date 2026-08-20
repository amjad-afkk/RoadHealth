/**
 * ============================================================
 * RoadHealth — ESP32 IoT Firmware
 * ============================================================
 * 
 * Hardware:
 *   - ESP32 DevKit V1 (any variant with WiFi)
 *   - MPU6050 6-DoF Accelerometer/Gyroscope (I2C: SDA=21, SCL=22)
 *   - NEO-6M GPS Module (Serial2: RX=16, TX=17)
 * 
 * Firmware Flow:
 *   1. Connect to WiFi
 *   2. Initialize MPU6050 via I2C, calibrate zero-offset
 *   3. Initialize NEO-6M GPS via Serial2
 *   4. Main loop:
 *      a. Read accelerometer X/Y/Z + gyroscope pitch/roll
 *      b. Read GPS lat/lng/speed/satellites
 *      c. Every SEND_INTERVAL_MS: bundle into JSON payload
 *      d. HTTP POST to server /api/v1/telemetry
 *      e. If Z-spike detected locally: flag pothole_trigger=true
 * 
 * Dependencies (install via Arduino Library Manager):
 *   - Wire.h (built-in)
 *   - WiFi.h (built-in ESP32)
 *   - HTTPClient.h (built-in ESP32)
 *   - TinyGPS++ (by Mikal Hart)
 *   - MPU6050_light (by rfetick) OR Adafruit_MPU6050
 * 
 * ============================================================
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <TinyGPS++.h>

// ===================== CONFIGURATION =====================

// WiFi Credentials
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Backend Server URL
const char* SERVER_URL = "http://YOUR_SERVER_IP:8000/api/v1/telemetry";

// Device Identity (must match a device ID in the server database)
const char* DEVICE_ID = "ESP32-NODE-TS09-EA-4412";

// Sensor Configuration
#define MPU6050_ADDR     0x68    // I2C address of MPU6050
#define GPS_BAUD         9600    // NEO-6M default baud rate
#define GPS_RX_PIN       16      // ESP32 RX2 pin connected to GPS TX
#define GPS_TX_PIN       17      // ESP32 TX2 pin connected to GPS RX
#define I2C_SDA          21      // ESP32 default SDA
#define I2C_SCL          22      // ESP32 default SCL

// Timing
#define SEND_INTERVAL_MS 1000    // Send data to server every 1 second
#define SAMPLE_RATE_HZ   100     // MPU6050 sampling rate
#define SAMPLE_DELAY_MS  (1000 / SAMPLE_RATE_HZ)

// Detection Thresholds (local pre-filtering)
#define Z_SPIKE_THRESHOLD_G  4.2  // G-force spike to flag as pothole
#define GRAVITY_MS2          9.81

// ===================== GLOBAL OBJECTS =====================

TinyGPSPlus gps;
HardwareSerial gpsSerial(2);  // Use Serial2 for GPS

// MPU6050 calibration offsets (computed during setup)
float accelOffsetX = 0, accelOffsetY = 0, accelOffsetZ = 0;
float gyroOffsetX = 0, gyroOffsetY = 0, gyroOffsetZ = 0;

// Accumulator for averaging samples between sends
float sumAccelX = 0, sumAccelY = 0, sumAccelZ = 0;
float sumGyroX = 0, sumGyroY = 0;
float maxAccelZ = 0;  // Track peak Z for spike detection
int sampleCount = 0;

// GPS state
double currentLat = 0, currentLng = 0;
float currentSpeed = 0;
int satellites = 0;
bool gpsFixed = false;

// Timing
unsigned long lastSendTime = 0;
unsigned long lastSampleTime = 0;

// ===================== SETUP =====================

void setup() {
    Serial.begin(115200);
    Serial.println("\n[RoadHealth ESP32] Initializing...");

    // Initialize I2C
    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.setClock(400000); // 400kHz fast mode

    // Initialize MPU6050
    initMPU6050();
    
    // Calibrate MPU6050 (device must be stationary!)
    calibrateMPU6050();

    // Initialize GPS
    gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    Serial.println("[GPS] NEO-6M initialized on Serial2");

    // Connect to WiFi
    connectWiFi();

    Serial.println("[RoadHealth ESP32] Ready! Sending data to server...\n");
}

// ===================== MAIN LOOP =====================

void loop() {
    unsigned long now = millis();

    // Read GPS data (non-blocking)
    while (gpsSerial.available() > 0) {
        gps.encode(gpsSerial.read());
    }

    // Update GPS state
    if (gps.location.isValid()) {
        currentLat = gps.location.lat();
        currentLng = gps.location.lng();
        currentSpeed = gps.speed.kmph();
        satellites = gps.satellites.value();
        gpsFixed = true;
    }

    // Sample MPU6050 at SAMPLE_RATE_HZ
    if (now - lastSampleTime >= SAMPLE_DELAY_MS) {
        lastSampleTime = now;
        sampleMPU6050();
    }

    // Send data to server every SEND_INTERVAL_MS
    if (now - lastSendTime >= SEND_INTERVAL_MS) {
        lastSendTime = now;
        
        if (gpsFixed && WiFi.status() == WL_CONNECTED) {
            sendTelemetry();
        } else {
            if (!gpsFixed) Serial.println("[WARN] Waiting for GPS fix...");
            if (WiFi.status() != WL_CONNECTED) {
                Serial.println("[WARN] WiFi disconnected. Reconnecting...");
                connectWiFi();
            }
        }
    }
}

// ===================== MPU6050 FUNCTIONS =====================

void initMPU6050() {
    // Wake up MPU6050
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(0x6B); // PWR_MGMT_1 register
    Wire.write(0x00); // Wake up
    Wire.endTransmission(true);

    // Set accelerometer range to ±8G (for pothole detection)
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(0x1C); // ACCEL_CONFIG register
    Wire.write(0x10); // ±8G range
    Wire.endTransmission(true);

    // Set gyroscope range to ±500°/s
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(0x1B); // GYRO_CONFIG register
    Wire.write(0x08); // ±500°/s range
    Wire.endTransmission(true);

    // Set DLPF (Digital Low Pass Filter) to 44Hz
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(0x1A); // CONFIG register
    Wire.write(0x03); // DLPF 44Hz
    Wire.endTransmission(true);

    Serial.println("[MPU6050] Initialized (±8G, ±500°/s, DLPF 44Hz)");
}

void calibrateMPU6050() {
    Serial.println("[MPU6050] Calibrating... Keep device STATIONARY!");
    
    float sumAx = 0, sumAy = 0, sumAz = 0;
    float sumGx = 0, sumGy = 0, sumGz = 0;
    const int samples = 200;

    for (int i = 0; i < samples; i++) {
        int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
        readMPU6050Raw(rawAx, rawAy, rawAz, rawGx, rawGy, rawGz);
        
        // Convert to physical units (±8G range: 4096 LSB/G)
        sumAx += rawAx / 4096.0;
        sumAy += rawAy / 4096.0;
        sumAz += rawAz / 4096.0;
        sumGx += rawGx / 65.5;  // ±500°/s: 65.5 LSB/°/s
        sumGy += rawGy / 65.5;
        
        delay(5);
    }

    accelOffsetX = sumAx / samples;
    accelOffsetY = sumAy / samples;
    accelOffsetZ = (sumAz / samples) - 1.0; // Subtract 1G (gravity)
    gyroOffsetX = sumGx / samples;
    gyroOffsetY = sumGy / samples;

    Serial.printf("[MPU6050] Calibration done. Offsets: AX=%.3f AY=%.3f AZ=%.3f\n",
                  accelOffsetX, accelOffsetY, accelOffsetZ);
}

void readMPU6050Raw(int16_t &ax, int16_t &ay, int16_t &az, 
                     int16_t &gx, int16_t &gy, int16_t &gz) {
    Wire.beginTransmission(MPU6050_ADDR);
    Wire.write(0x3B); // Starting register for accel data
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)MPU6050_ADDR, (uint8_t)14, (uint8_t)true);

    ax = (Wire.read() << 8) | Wire.read();
    ay = (Wire.read() << 8) | Wire.read();
    az = (Wire.read() << 8) | Wire.read();
    Wire.read(); Wire.read(); // Skip temperature
    gx = (Wire.read() << 8) | Wire.read();
    gy = (Wire.read() << 8) | Wire.read();
    gz = (Wire.read() << 8) | Wire.read();
}

void sampleMPU6050() {
    int16_t rawAx, rawAy, rawAz, rawGx, rawGy, rawGz;
    readMPU6050Raw(rawAx, rawAy, rawAz, rawGx, rawGy, rawGz);

    // Convert to m/s² (±8G range, 4096 LSB/G, multiply by 9.81 for m/s²)
    float ax = ((rawAx / 4096.0) - accelOffsetX) * GRAVITY_MS2;
    float ay = ((rawAy / 4096.0) - accelOffsetY) * GRAVITY_MS2;
    float az = ((rawAz / 4096.0) - accelOffsetZ) * GRAVITY_MS2;

    // Convert gyroscope to degrees/second (±500°/s, 65.5 LSB/°/s)
    float gx = (rawGx / 65.5) - gyroOffsetX;
    float gy = (rawGy / 65.5) - gyroOffsetY;

    // Accumulate for averaging
    sumAccelX += ax;
    sumAccelY += ay;
    sumAccelZ += az;
    sumGyroX += gx;
    sumGyroY += gy;
    sampleCount++;

    // Track peak Z-acceleration for spike detection
    if (fabs(az) > fabs(maxAccelZ)) {
        maxAccelZ = az;
    }
}

// ===================== NETWORK FUNCTIONS =====================

void connectWiFi() {
    Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
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
        Serial.println("\n[WiFi] Connection failed! Will retry...");
    }
}

void sendTelemetry() {
    if (sampleCount == 0) return;

    // Compute averages from accumulated samples
    float avgAx = sumAccelX / sampleCount;
    float avgAy = sumAccelY / sampleCount;
    float avgAz = sumAccelZ / sampleCount;
    float avgGx = sumGyroX / sampleCount;
    float avgGy = sumGyroY / sampleCount;

    // Compute vibration magnitude
    float vibration = sqrt(avgAx * avgAx + avgAy * avgAy + 
                           (avgAz - GRAVITY_MS2) * (avgAz - GRAVITY_MS2));

    // Compute IRI estimate (empirical: vibration × 2.8)
    float iriEstimate = vibration * 2.8;

    // Detect pothole spike
    float peakGForce = fabs(maxAccelZ - GRAVITY_MS2) / GRAVITY_MS2;
    bool potholeTrigger = (peakGForce >= Z_SPIKE_THRESHOLD_G);

    // Build JSON payload
    String payload = "{";
    payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
    payload += "\"lat\":" + String(currentLat, 6) + ",";
    payload += "\"lng\":" + String(currentLng, 6) + ",";
    payload += "\"speed\":" + String(currentSpeed, 1) + ",";
    payload += "\"accel\":{";
    payload += "\"x\":" + String(avgAx, 3) + ",";
    payload += "\"y\":" + String(avgAy, 3) + ",";
    payload += "\"z\":" + String(avgAz, 3) + "},";
    payload += "\"gyro\":{";
    payload += "\"pitch\":" + String(avgGx, 3) + ",";
    payload += "\"roll\":" + String(avgGy, 3) + "},";
    payload += "\"iriEstimate\":" + String(iriEstimate, 3) + ",";
    payload += "\"vibrationMagnitude\":" + String(vibration, 3) + ",";
    payload += "\"potholeTrigger\":" + String(potholeTrigger ? "true" : "false");
    payload += "}";

    // Send HTTP POST
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    
    int httpCode = http.POST(payload);
    
    if (httpCode > 0) {
        if (httpCode == 200) {
            String response = http.getString();
            // Print summary
            Serial.printf("[TX] OK | GPS: %.4f,%.4f | Speed: %.0f km/h | Z: %.2f m/s² | IRI: %.1f | Pothole: %s\n",
                          currentLat, currentLng, currentSpeed, avgAz, iriEstimate,
                          potholeTrigger ? "YES!" : "no");
        } else {
            Serial.printf("[TX] Server returned HTTP %d\n", httpCode);
        }
    } else {
        Serial.printf("[TX] HTTP POST failed: %s\n", http.errorToString(httpCode).c_str());
    }
    
    http.end();

    // Reset accumulators
    sumAccelX = 0; sumAccelY = 0; sumAccelZ = 0;
    sumGyroX = 0; sumGyroY = 0;
    maxAccelZ = 0;
    sampleCount = 0;
}
