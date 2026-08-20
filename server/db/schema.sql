-- ============================================================
-- RoadHealth Database Schema
-- SQLite (portable to PostgreSQL + PostGIS)
-- ============================================================

-- ESP32 IoT Fleet Devices
CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,                        -- e.g. 'ESP32-NODE-TS09-EA-4412'
    bike_plate      TEXT NOT NULL,                           -- e.g. 'TS 09 EA 4412'
    bike_model      TEXT NOT NULL,                           -- e.g. 'Royal Enfield Hunter 350'
    rider_name      TEXT NOT NULL,                           -- e.g. 'Patrol Unit 1 (R. Naresh)'
    location        TEXT DEFAULT '',                         -- Last known area description
    battery_pct     INTEGER DEFAULT 100,                    -- 0-100
    battery_voltage REAL DEFAULT 4.2,                       -- Volts
    battery_status  TEXT DEFAULT 'Good',                     -- Good | Moderate | Low | Critical
    firmware        TEXT DEFAULT 'v2.4.2-Release',
    status          TEXT DEFAULT 'Active',                   -- Active | Offline | Charging
    accel_sensor    TEXT DEFAULT 'MPU6050 6-DoF (100 Hz)',
    gps_sensor      TEXT DEFAULT 'NEO-6M GPS',
    network_info    TEXT DEFAULT '4G LTE SIM7600',
    sd_storage      TEXT DEFAULT 'SanDisk 32GB',
    last_anomaly    TEXT DEFAULT '',
    last_seen_at    TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Raw Telemetry Readings (high-frequency inserts from ESP32 devices)
CREATE TABLE IF NOT EXISTS telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id),
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    speed_kmh       REAL DEFAULT 0,
    accel_x         REAL DEFAULT 0,                         -- m/s² 
    accel_y         REAL DEFAULT 0,
    accel_z         REAL DEFAULT 9.81,                      -- Gravity baseline
    gyro_pitch      REAL DEFAULT 0,
    gyro_roll       REAL DEFAULT 0,
    iri_estimate    REAL DEFAULT 0,                          -- International Roughness Index (m/km)
    vibration_mag   REAL DEFAULT 0,                          -- Vibration magnitude
    pothole_trigger INTEGER DEFAULT 0,                       -- 1 if Z-spike exceeded threshold
    raw_json        TEXT DEFAULT NULL                         -- Full raw payload for debugging
);

-- Detected Potholes / Road Anomalies
CREATE TABLE IF NOT EXISTS potholes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'moderate',         -- moderate | critical
    iri             REAL DEFAULT 0,
    depth_cm        REAL DEFAULT 0,
    cluster_size    INTEGER DEFAULT 1,                        -- Number of detections at this location
    source_device   TEXT DEFAULT NULL REFERENCES devices(id),
    telemetry_id    INTEGER DEFAULT NULL REFERENCES telemetry(id),
    confirmed       INTEGER DEFAULT 0,                        -- 0 = auto-detected, 1 = manually confirmed
    false_positive  INTEGER DEFAULT 0,                        -- 1 = marked as false positive
    detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Road Segment Health Analysis Cache
CREATE TABLE IF NOT EXISTS road_segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id        TEXT NOT NULL,                            -- Association to a route
    segment_index   INTEGER NOT NULL,
    road_name       TEXT DEFAULT '',
    health          TEXT DEFAULT 'good',                      -- good | moderate | bad
    avg_iri         REAL DEFAULT 0,
    pothole_count   INTEGER DEFAULT 0,
    avg_vibration   REAL DEFAULT 0,
    length_m        REAL DEFAULT 0,
    coords_json     TEXT DEFAULT '[]',                        -- JSON array of [lat, lng] pairs
    analyzed_at     TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast spatial and temporal queries
CREATE INDEX IF NOT EXISTS idx_telemetry_device    ON telemetry(device_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_location  ON telemetry(lat, lng);
CREATE INDEX IF NOT EXISTS idx_potholes_location   ON potholes(lat, lng);
CREATE INDEX IF NOT EXISTS idx_potholes_severity   ON potholes(severity);
CREATE INDEX IF NOT EXISTS idx_segments_route      ON road_segments(route_id);
