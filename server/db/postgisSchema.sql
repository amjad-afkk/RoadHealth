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
    confidence          REAL DEFAULT 1.0,
    last_hit_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    half_life_days      REAL DEFAULT 14.0,
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

