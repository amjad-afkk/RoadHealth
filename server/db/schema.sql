CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    bike_plate      TEXT NOT NULL,
    bike_model      TEXT NOT NULL,
    rider_name      TEXT NOT NULL,
    location        TEXT DEFAULT '',
    battery_pct     INTEGER DEFAULT 100,
    battery_voltage REAL DEFAULT 4.2,
    battery_status  TEXT DEFAULT 'Good',
    firmware        TEXT DEFAULT 'v2.4.2-Release',
    status          TEXT DEFAULT 'Active',
    accel_sensor    TEXT DEFAULT 'MPU6050 6-DoF (100 Hz)',
    gps_sensor      TEXT DEFAULT 'NEO-6M GPS',
    network_info    TEXT DEFAULT '4G LTE SIM7600',
    sd_storage      TEXT DEFAULT 'SanDisk 32GB',
    last_anomaly    TEXT DEFAULT '',
    last_seen_at    TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id),
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    speed_kmh       REAL DEFAULT 0,
    accel_x         REAL DEFAULT 0,
    accel_y         REAL DEFAULT 0,
    accel_z         REAL DEFAULT 9.81,
    gyro_pitch      REAL DEFAULT 0,
    gyro_roll       REAL DEFAULT 0,
    iri_estimate    REAL DEFAULT 0,
    vibration_mag   REAL DEFAULT 0,
    pothole_trigger INTEGER DEFAULT 0,
    raw_json        TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS potholes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lat             REAL NOT NULL,
    lng             REAL NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'moderate',
    iri             REAL DEFAULT 0,
    depth_cm        REAL DEFAULT 0,
    cluster_size    INTEGER DEFAULT 1,
    confidence      REAL DEFAULT 1.0,
    last_hit_at     TEXT DEFAULT (datetime('now')),
    half_life_days  REAL DEFAULT 14.0,
    source_device   TEXT DEFAULT NULL REFERENCES devices(id),
    telemetry_id    INTEGER DEFAULT NULL REFERENCES telemetry(id),
    status          TEXT DEFAULT 'reported',
    assigned_contractor TEXT DEFAULT NULL,
    confirmed       INTEGER DEFAULT 0,
    false_positive  INTEGER DEFAULT 0,
    detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS road_segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id        TEXT NOT NULL,
    segment_index   INTEGER NOT NULL,
    road_name       TEXT DEFAULT '',
    health          TEXT DEFAULT 'good',
    avg_iri         REAL DEFAULT 0,
    pothole_count   INTEGER DEFAULT 0,
    avg_vibration   REAL DEFAULT 0,
    length_m        REAL DEFAULT 0,
    coords_json     TEXT DEFAULT '[]',
    analyzed_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device    ON telemetry(device_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_location  ON telemetry(lat, lng);
CREATE INDEX IF NOT EXISTS idx_potholes_location   ON potholes(lat, lng);
CREATE INDEX IF NOT EXISTS idx_potholes_severity   ON potholes(severity);
CREATE INDEX IF NOT EXISTS idx_potholes_status     ON potholes(status);
CREATE INDEX IF NOT EXISTS idx_segments_route      ON road_segments(route_id);
