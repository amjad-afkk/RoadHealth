CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS devices (
    id                  VARCHAR(100) PRIMARY KEY,
    bike_plate          VARCHAR(50) NOT NULL,
    bike_model          VARCHAR(100) NOT NULL,
    rider_name          VARCHAR(100) NOT NULL,
    location            VARCHAR(255) DEFAULT '',
    battery_pct         INTEGER DEFAULT 100,
    battery_voltage     REAL DEFAULT 4.2,
    battery_status      VARCHAR(30) DEFAULT 'Good',
    firmware            VARCHAR(50) DEFAULT 'v2.4.2-Release',
    status              VARCHAR(30) DEFAULT 'Active',
    accel_sensor        VARCHAR(100) DEFAULT 'MPU6050 6-DoF (100 Hz)',
    gps_sensor          VARCHAR(100) DEFAULT 'NEO-6M GPS',
    network_info        VARCHAR(100) DEFAULT '4G LTE SIM7600',
    sd_storage          VARCHAR(50) DEFAULT 'SanDisk 32GB',
    last_anomaly        TEXT DEFAULT '',
    last_seen_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telemetry (
    id                  SERIAL PRIMARY KEY,
    device_id           VARCHAR(100) NOT NULL REFERENCES devices(id),
    timestamp           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    geom                GEOMETRY(Point, 4326),
    speed_kmh           REAL DEFAULT 0,
    accel_x             REAL DEFAULT 0,
    accel_y             REAL DEFAULT 0,
    accel_z             REAL DEFAULT 9.81,
    gyro_pitch          REAL DEFAULT 0,
    gyro_roll           REAL DEFAULT 0,
    iri_estimate        REAL DEFAULT 0,
    vibration_mag       REAL DEFAULT 0,
    pothole_trigger     INTEGER DEFAULT 0,
    raw_json            TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS potholes (
    id                  SERIAL PRIMARY KEY,
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    geom                GEOMETRY(Point, 4326),
    severity            VARCHAR(20) NOT NULL DEFAULT 'moderate',
    iri                 REAL DEFAULT 0,
    depth_cm            REAL DEFAULT 0,
    cluster_size        INTEGER DEFAULT 1,
    source_device       VARCHAR(100) REFERENCES devices(id),
    telemetry_id        INTEGER,
    status              VARCHAR(30) DEFAULT 'reported',
    assigned_contractor VARCHAR(100) DEFAULT NULL,
    confirmed           INTEGER DEFAULT 0,
    false_positive      INTEGER DEFAULT 0,
    detected_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS road_segments (
    id                  SERIAL PRIMARY KEY,
    route_id            VARCHAR(100) NOT NULL,
    segment_index       INTEGER NOT NULL,
    road_name           VARCHAR(200) DEFAULT '',
    health              VARCHAR(20) DEFAULT 'good',
    avg_iri             REAL DEFAULT 0,
    pothole_count       INTEGER DEFAULT 0,
    avg_vibration       REAL DEFAULT 0,
    length_m            REAL DEFAULT 0,
    coords_json         TEXT DEFAULT '[]',
    geom                GEOMETRY(LineString, 4326) DEFAULT NULL,
    analyzed_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telemetry_geom      ON telemetry USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_potholes_geom       ON potholes USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_telemetry_device    ON telemetry(device_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_potholes_severity   ON potholes(severity);
CREATE INDEX IF NOT EXISTS idx_potholes_status     ON potholes(status);
CREATE INDEX IF NOT EXISTS idx_segments_route      ON road_segments(route_id);

INSERT INTO devices (id, bike_plate, bike_model, rider_name, location, battery_pct, battery_voltage, battery_status, firmware, status, accel_sensor, gps_sensor, network_info, sd_storage, last_anomaly)
VALUES 
    ('ESP32-NODE-TS09-EA-4412', 'TS 09 EA 4412', 'Royal Enfield Hunter 350', 'Patrol Unit 1 (R. Naresh)', 'Hitec City - Madhapur Sector', 94, 4.18, 'Good', 'v2.4.2-Release', 'Active', 'MPU6050 6-DoF (100 Hz)', 'NEO-6M GPS (3D Fix)', '4G LTE SIM7600', 'SanDisk 32GB', 'Nominal (No Hazards Detected)'),
    ('ESP32-NODE-TS07-FA-8821', 'TS 07 FA 8821', 'Bajaj Pulsar N250', 'Patrol Unit 2 (K. Suresh)', 'Gachibowli Outer Ring Road', 88, 4.05, 'Good', 'v2.4.2-Release', 'Active', 'MPU6050 6-DoF (100 Hz)', 'NEO-6M GPS (3D Fix)', '4G LTE SIM7600', 'SanDisk 32GB', 'Severe Pothole Cluster (IRI 6.8 m/km)'),
    ('ESP32-NODE-TS10-UB-9943', 'TS 10 UB 9943', 'TVS Apache RTR 200', 'Patrol Unit 3 (M. Vikram)', 'Kukatpally - Miyapur Corridor', 76, 3.92, 'Good', 'v2.4.2-Release', 'Active', 'MPU6050 6-DoF (100 Hz)', 'NEO-6M GPS (3D Fix)', '4G LTE SIM7600', 'SanDisk 32GB', 'Moderate Rutting (IRI 3.4 m/km)'),
    ('ESP32-NODE-TS11-GH-3310', 'TS 11 GH 3310', 'Hero Xpulse 200 4V', 'Patrol Unit 4 (S. Arul)', 'Secunderabad - Begumpet', 91, 4.12, 'Good', 'v2.4.2-Release', 'Active', 'MPU6050 6-DoF (100 Hz)', 'NEO-6M GPS (3D Fix)', '4G LTE SIM7600', 'SanDisk 32GB', 'Nominal (Fresh Asphalt Layer)'),
    ('ESP32-NODE-TS08-MN-7762', 'TS 08 MN 7762', 'Yamaha FZ-S V4', 'Patrol Unit 5 (D. Rahul)', 'Shamshabad Airport Expressway', 82, 3.98, 'Good', 'v2.4.2-Release', 'Active', 'MPU6050 6-DoF (100 Hz)', 'NEO-6M GPS (3D Fix)', '4G LTE SIM7600', 'SanDisk 32GB', 'Surface Crack Detected (Z-Spike 3.8G)')
ON CONFLICT (id) DO NOTHING;
