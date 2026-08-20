/**
 * RoadHealth — Pothole & Crack Detection Engine
 * 
 * Analyzes raw accelerometer telemetry from ESP32 MPU6050 sensors
 * to detect potholes, cracks, and road surface anomalies.
 * 
 * Detection Methods:
 * 1. Z-axis spike detection (sudden vertical acceleration = pothole impact)
 * 2. IRI estimation from running RMS of vibration data
 * 3. Spatial deduplication to cluster nearby detections
 */

const { getDb } = require('../db/database');

// Detection thresholds (tunable via Admin Dashboard)
const CONFIG = {
    // Z-axis acceleration spike threshold in G-force
    // Normal riding: ~1G (9.81 m/s²), Pothole impact: 3-8G spike
    Z_SPIKE_THRESHOLD_G: 4.2,

    // IRI threshold for "critical" classification (m/km)
    IRI_CRITICAL_THRESHOLD: 4.5,

    // IRI threshold for "moderate" classification (m/km)
    IRI_MODERATE_THRESHOLD: 2.5,

    // Spatial deduplication radius in meters
    // Detections within this radius of an existing pothole update it instead of creating new
    DEDUP_RADIUS_M: 10,

    // Gravity constant (m/s²)
    GRAVITY: 9.81,

    // RMS window size for IRI estimation (number of samples)
    RMS_WINDOW: 50,

    // Empirical multiplier: RMS vibration → IRI estimate
    RMS_TO_IRI_FACTOR: 2.8
};

/**
 * Process a single telemetry reading and detect anomalies
 * 
 * @param {Object} telemetryRow - The telemetry record just inserted
 * @returns {Object|null} - Detected pothole or null if road is normal
 */
function analyzeTelemetry(telemetryRow) {
    const { id, device_id, lat, lng, accel_z, iri_estimate, vibration_mag } = telemetryRow;

    // Calculate G-force deviation from gravity
    const zDeviation = Math.abs(accel_z - CONFIG.GRAVITY);
    const gForce = zDeviation / CONFIG.GRAVITY;

    // Method 1: Z-axis spike detection
    const isSpikeDetected = gForce >= (CONFIG.Z_SPIKE_THRESHOLD_G - 1); // Spike relative to 1G baseline

    // Method 2: IRI-based classification
    const iriValue = iri_estimate || estimateIRI(vibration_mag);
    const isHighIRI = iriValue >= CONFIG.IRI_MODERATE_THRESHOLD;

    // Combined trigger: spike OR high IRI with significant vibration
    if (!isSpikeDetected && !isHighIRI) {
        return null; // Road surface is normal
    }

    // Classify severity
    let severity = 'moderate';
    let estimatedDepth = 0;

    if (gForce >= (CONFIG.Z_SPIKE_THRESHOLD_G - 1) || iriValue >= CONFIG.IRI_CRITICAL_THRESHOLD) {
        severity = 'critical';
        // Rough depth estimation from G-force (empirical: 1G ≈ 2cm depth)
        estimatedDepth = Math.round(gForce * 2.0 * 10) / 10;
    } else {
        estimatedDepth = Math.round(gForce * 1.2 * 10) / 10;
    }

    // Method 3: Spatial deduplication — check for nearby existing potholes
    const existing = findNearbyPothole(lat, lng, CONFIG.DEDUP_RADIUS_M);

    const db = getDb();

    if (existing) {
        // Update existing pothole cluster
        db.prepare(`
            UPDATE potholes 
            SET cluster_size = cluster_size + 1,
                iri = MAX(iri, @iri),
                depth_cm = MAX(depth_cm, @depth_cm),
                severity = CASE WHEN @severity = 'critical' THEN 'critical' ELSE severity END,
                updated_at = datetime('now')
            WHERE id = @id
        `).run({
            id: existing.id,
            iri: iriValue,
            depth_cm: estimatedDepth,
            severity: severity
        });

        // Update device's last anomaly
        db.prepare(`
            UPDATE devices SET last_anomaly = @anomaly, last_seen_at = datetime('now') WHERE id = @device_id
        `).run({
            device_id: device_id,
            anomaly: `Pothole cluster update (${severity}, IRI ${iriValue.toFixed(1)}) at ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
        });

        return {
            type: 'pothole_cluster_update',
            potholeId: existing.id,
            lat, lng, severity, iri: iriValue, depth_cm: estimatedDepth,
            cluster_size: existing.cluster_size + 1,
            device_id
        };
    } else {
        // Create new pothole record
        const result = db.prepare(`
            INSERT INTO potholes (lat, lng, severity, iri, depth_cm, cluster_size, source_device, telemetry_id)
            VALUES (@lat, @lng, @severity, @iri, @depth_cm, 1, @source_device, @telemetry_id)
        `).run({
            lat, lng, severity,
            iri: iriValue,
            depth_cm: estimatedDepth,
            source_device: device_id,
            telemetry_id: id
        });

        // Update device's last anomaly
        db.prepare(`
            UPDATE devices SET last_anomaly = @anomaly, last_seen_at = datetime('now') WHERE id = @device_id
        `).run({
            device_id: device_id,
            anomaly: `New ${severity} pothole (IRI ${iriValue.toFixed(1)}, ${estimatedDepth}cm) at ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`
        });

        return {
            type: 'pothole_new',
            potholeId: result.lastInsertRowid,
            lat, lng, severity, iri: iriValue, depth_cm: estimatedDepth,
            cluster_size: 1,
            device_id
        };
    }
}

/**
 * Estimate IRI from vibration magnitude using empirical calibration curve
 * IRI ≈ RMS_vibration × 2.8
 */
function estimateIRI(vibrationMag) {
    if (!vibrationMag || vibrationMag <= 0) return 0;
    return +(vibrationMag * CONFIG.RMS_TO_IRI_FACTOR).toFixed(2);
}

/**
 * Find an existing pothole within the deduplication radius
 * Uses a bounding box approximation for SQLite (no PostGIS spatial functions)
 * Then refines with Haversine distance
 */
function findNearbyPothole(lat, lng, radiusM) {
    const db = getDb();

    // Approximate bounding box: 1 degree latitude ≈ 111,320 meters
    const latDelta = radiusM / 111320;
    const lngDelta = radiusM / (111320 * Math.cos(lat * Math.PI / 180));

    const candidates = db.prepare(`
        SELECT * FROM potholes
        WHERE lat BETWEEN @minLat AND @maxLat
          AND lng BETWEEN @minLng AND @maxLng
          AND false_positive = 0
        ORDER BY detected_at DESC
        LIMIT 10
    `).all({
        minLat: lat - latDelta,
        maxLat: lat + latDelta,
        minLng: lng - lngDelta,
        maxLng: lng + lngDelta
    });

    // Refine with actual Haversine distance
    for (const candidate of candidates) {
        const distance = haversineDistance(lat, lng, candidate.lat, candidate.lng);
        if (distance <= radiusM) {
            return candidate;
        }
    }

    return null;
}

/**
 * Haversine distance between two coordinates in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Update detection thresholds (from Admin Dashboard)
 */
function updateThresholds(newConfig) {
    if (newConfig.zSpikeThreshold !== undefined) {
        CONFIG.Z_SPIKE_THRESHOLD_G = newConfig.zSpikeThreshold;
    }
    if (newConfig.iriCriticalThreshold !== undefined) {
        CONFIG.IRI_CRITICAL_THRESHOLD = newConfig.iriCriticalThreshold;
    }
    if (newConfig.iriModerateThreshold !== undefined) {
        CONFIG.IRI_MODERATE_THRESHOLD = newConfig.iriModerateThreshold;
    }
    if (newConfig.dedupRadiusM !== undefined) {
        CONFIG.DEDUP_RADIUS_M = newConfig.dedupRadiusM;
    }
    console.log('[DetectionEngine] Thresholds updated:', CONFIG);
}

/**
 * Get current detection configuration
 */
function getConfig() {
    return { ...CONFIG };
}

module.exports = {
    analyzeTelemetry,
    estimateIRI,
    findNearbyPothole,
    haversineDistance,
    updateThresholds,
    getConfig
};
