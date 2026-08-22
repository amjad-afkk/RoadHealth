/**
 * RoadHealth — Pothole & Crack Detection Engine (PostGIS & Spatial Optimized)
 * 
 * Analyzes raw accelerometer telemetry from ESP32 MPU6050 sensors
 * to detect potholes, cracks, and road surface anomalies.
 * 
 * Detection Methods:
 * 1. Z-axis spike detection (sudden vertical acceleration = pothole impact)
 * 2. IRI estimation from running RMS of vibration data
 * 3. Spatial deduplication (native PostGIS ST_DWithin or Haversine fallback)
 */

const { isPostGIS, getPool, getDb } = require('../db/database');

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
 * @returns {Promise<Object|null>} - Detected pothole or null if road is normal
 */
async function analyzeTelemetry(telemetryRow) {
    const { id, device_id, lat, lng, accel_z, iri_estimate, vibration_mag } = telemetryRow;

    // Calculate G-force deviation from gravity
    const zDeviation = Math.abs((accel_z || CONFIG.GRAVITY) - CONFIG.GRAVITY);
    const gForce = zDeviation / CONFIG.GRAVITY;

    // Method 1: Z-axis spike detection
    const isSpikeDetected = gForce >= (CONFIG.Z_SPIKE_THRESHOLD_G - 1);

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
        estimatedDepth = Math.round(gForce * 2.0 * 10) / 10;
    } else {
        estimatedDepth = Math.round(gForce * 1.2 * 10) / 10;
    }

    // Method 3: Spatial deduplication — check for nearby existing potholes
    const existing = await findNearbyPothole(lat, lng, CONFIG.DEDUP_RADIUS_M);

    if (isPostGIS()) {
        const pool = getPool();
        if (existing) {
            await pool.query(`
                UPDATE potholes 
                SET cluster_size = cluster_size + 1,
                    iri = GREATEST(iri, $1),
                    depth_cm = GREATEST(depth_cm, $2),
                    severity = CASE WHEN $3 = 'critical' THEN 'critical' ELSE severity END,
                    updated_at = NOW()
                WHERE id = $4
            `, [iriValue, estimatedDepth, severity, existing.id]);

            await pool.query(`
                UPDATE devices 
                SET last_anomaly = $1, last_seen_at = NOW() 
                WHERE id = $2
            `, [`Pothole cluster update (${severity}, IRI ${iriValue.toFixed(1)}) at ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`, device_id]);

            return {
                type: 'pothole_cluster_update',
                potholeId: existing.id,
                lat, lng, severity, iri: iriValue, depth_cm: estimatedDepth,
                cluster_size: existing.cluster_size + 1,
                device_id
            };
        } else {
            const insertRes = await pool.query(`
                INSERT INTO potholes (lat, lng, geom, severity, iri, depth_cm, cluster_size, source_device, telemetry_id, status)
                VALUES ($1, $2, ST_SetSRID(ST_MakePoint($2, $1), 4326), $3, $4, $5, 1, $6, $7, 'reported')
                RETURNING id
            `, [lat, lng, severity, iriValue, estimatedDepth, device_id, id]);

            const newId = insertRes.rows[0]?.id;

            await pool.query(`
                UPDATE devices 
                SET last_anomaly = $1, last_seen_at = NOW() 
                WHERE id = $2
            `, [`New ${severity} pothole (IRI ${iriValue.toFixed(1)}, ${estimatedDepth}cm) at ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E`, device_id]);

            return {
                type: 'pothole_new',
                potholeId: newId,
                lat, lng, severity, iri: iriValue, depth_cm: estimatedDepth,
                cluster_size: 1,
                device_id
            };
        }
    } else {
        // SQLite fallback
        const db = getDb();
        if (existing) {
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
            const result = db.prepare(`
                INSERT INTO potholes (lat, lng, severity, iri, depth_cm, cluster_size, source_device, telemetry_id, status)
                VALUES (@lat, @lng, @severity, @iri, @depth_cm, 1, @source_device, @telemetry_id, 'reported')
            `).run({
                lat, lng, severity,
                iri: iriValue,
                depth_cm: estimatedDepth,
                source_device: device_id,
                telemetry_id: id
            });

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
}

/**
 * Estimate IRI from vibration magnitude
 */
function estimateIRI(vibrationMag) {
    if (!vibrationMag || vibrationMag <= 0) return 0;
    return +(vibrationMag * CONFIG.RMS_TO_IRI_FACTOR).toFixed(2);
}

/**
 * Find an existing pothole within the deduplication radius
 * In PostGIS: Uses native ST_DWithin with GiST index
 * In SQLite: Uses bounding box + Haversine fallback
 */
async function findNearbyPothole(lat, lng, radiusM) {
    if (isPostGIS()) {
        const pool = getPool();
        const res = await pool.query(`
            SELECT id, cluster_size, iri, depth_cm, severity, lat, lng
            FROM potholes
            WHERE false_positive = 0
              AND ST_DWithin(
                  geom::geography,
                  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                  $3
              )
            ORDER BY detected_at DESC
            LIMIT 1
        `, [lng, lat, radiusM]);

        return res.rows[0] || null;
    } else {
        const db = getDb();
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

        for (const candidate of candidates) {
            const distance = haversineDistance(lat, lng, candidate.lat, candidate.lng);
            if (distance <= radiusM) {
                return candidate;
            }
        }

        return null;
    }
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
 * Update detection thresholds
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
