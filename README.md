# 🗺️ RoadHealth — Real-Time IoT Road Intelligence & Satellite Navigation

A real-time IoT, GIS, and telemetry intelligence system engineered to identify, classify, map, and navigate around road defects (potholes, cracks, surface degradation) using motorcycle patrol fleets.

---

## 🏗️ System Architecture

* **Hardware Layer**: ESP32 DevKit V1 + MPU6050 6-DoF Motion Tracker (I2C) + NEO-6M GPS Module (UART).
* **Ingestion & Detection Engine**: Node.js/Express server receiving 1 Hz telemetry batches, running $G$-force spike detection ($\ge 4.2G$), IRI estimation ($\text{RMS} \times 2.8$), and spatial deduplication within a 10m radius.
* **Database Layer**: SQLite (WAL mode) storing devices, raw time-series telemetry, pothole clusters, and road segment caches.
* **Real-Time Layer**: WebSocket server broadcasting `telemetry:live`, `pothole:detected`, and `device:status` events.
* **GIS Presentation Layer**: Leaflet.js dashboard with Google Hybrid Satellite imagery, OSRM multi-route navigation, dynamic zoom-dependent ($\ge 16$) SVG crack overlays, and live Canvas Z-axis waveform visualizer.

---

## 📁 Repository Structure

```
.
├── index.html                           ← Dashboard Frontend Shell
├── css/
│   └── styles.css                       ← Apple Maps Glassmorphism CSS System
├── js/
│   ├── api.js                           ← REST API Client
│   ├── healthEngine.js                  ← GIS Road Health Index Math Engine
│   ├── map.js                           ← Leaflet GIS & Satellite Map Engine
│   └── app.js                           ← Real-Time Event Controller
│
├── server/                              ← Express REST & WebSocket Server
│   ├── package.json                     ← Node dependencies
│   ├── server.js                        ← Express & WebSocket entry point
│   ├── db/                              ← Relational database schema & pool
│   ├── routes/                          ← REST API Endpoints (devices, telemetry, potholes)
│   ├── services/                        ← Detection Engine & Health Scorer
│   └── ws/realtimeHub.js                ← Real-Time WebSocket Broadcaster
│
└── firmware/                            ← Microcontroller Firmware
    └── roadhealth_esp32/
        └── roadhealth_esp32.ino         ← ESP32 Arduino Sketch (MPU6050 + NEO-6M)
```

---

## 🚀 Quick Start Guide

### 1. Install & Run Server
```bash
cd server
npm install
npm start
```
Server runs at `http://localhost:8000`.

### 2. Open Dashboard
Open `http://localhost:8000/index.html` in your browser.

---

## 📡 REST API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/health` | Server health & uptime check |
| `GET` | `/api/v1/devices` | List registered ESP32 fleet devices |
| `POST` | `/api/v1/devices` | Register a new ESP32 hardware node |
| `POST` | `/api/v1/telemetry` | Ingest sensor data (runs detection engine) |
| `GET` | `/api/v1/potholes` | List detected road defects |
| `GET` | `/api/v1/potholes/near` | Spatial proximity search |
| `POST` | `/api/v1/routes/analyze` | Analyze polyline 30m corridor health |
| `GET` | `/api/v1/routes/stats` | System & database summary statistics |

---

## 🔌 Hardware Setup

1. **Connect Sensors**:
   * MPU6050 $\rightarrow$ ESP32 I2C (`SDA` Pin 21, `SCL` Pin 22)
   * NEO-6M GPS $\rightarrow$ ESP32 Hardware Serial 2 (`RX` Pin 16, `TX` Pin 17)
2. **Flash Firmware**:
   * Open `firmware/roadhealth_esp32/roadhealth_esp32.ino` in Arduino IDE.
   * Set WiFi credentials (`WIFI_SSID`, `WIFI_PASSWORD`) and `SERVER_URL`.
   * Flash to ESP32.
