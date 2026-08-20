/**
 * RoadHealth — Telemetry API Routes
 * Ingest sensor data from ESP32 devices and query historical readings
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { analyzeTelemetry } = require('../services/detectionEngine');
const { broadcastTelemetry, broadcastPotholeDetection, broadcastDeviceStatus } = require('../ws/realtimeHub');

/**
 * POST /api/v1/telemetry
 * Ingest endpoint — ESP32 devices POST sensor data here
 * 
 * Expected body:
 * {
 *   deviceId: "ESP32-NODE-TS09-EA-4412",
 *   lat: 17.4435,
 *   lng: 78.3772,
 *   speed: 48,
 *   accel: { x: 0.1, y: -0.05, z: 14.2 },
 *   gyro: { pitch: 0.3, roll: -0.1 },
 *   iriEstimate: 5.2,          // optional: pre-computed on ESP32
 *   vibrationMagnitude: 4.8,   // optional: pre-computed on ESP32
 *   potholeTrigger: true        // optional: pre-flagged on ESP32
 * }
 */
router.post('/', (req, res) => {
    try {
        const body = req.body;

        // Validate required fields
        if (!body.deviceId || body.lat === undefined || body.lng === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: deviceId, lat, lng'
            });
        }

        const db = getDb();

        // Check if device exists
        const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(body.deviceId);
        if (!device) {
            return res.status(404).json({
                success: false,
                error: `Unknown device: ${body.deviceId}`
            });
        }

        // Extract accelerometer and gyroscope values
        const accelX = body.accel?.x ?? 0;
        const accelY = body.accel?.y ?? 0;
        const accelZ = body.accel?.z ?? 9.81;
        const gyroPitch = body.gyro?.pitch ?? 0;
        const gyroRoll = body.gyro?.roll ?? 0;

        // Calculate vibration magnitude if not provided
        const vibrationMag = body.vibrationMagnitude ??
            Math.sqrt(accelX * accelX + accelY * accelY + (accelZ - 9.81) * (accelZ - 9.81));

        // Calculate IRI estimate if not provided
        const iriEstimate = body.iriEstimate ?? (vibrationMag * 2.8);

        // Determine pothole trigger
        const potholeTrigger = body.potholeTrigger ? 1 :
            (Math.abs(accelZ - 9.81) > 3.2 ? 1 : 0);

        // Insert telemetry record
        const result = db.prepare(`
            INSERT INTO telemetry (device_id, lat, lng, speed_kmh, accel_x, accel_y, accel_z, gyro_pitch, gyro_roll, iri_estimate, vibration_mag, pothole_trigger, raw_json)
            VALUES (@device_id, @lat, @lng, @speed_kmh, @accel_x, @accel_y, @accel_z, @gyro_pitch, @gyro_roll, @iri_estimate, @vibration_mag, @pothole_trigger, @raw_json)
        `).run({
            device_id: body.deviceId,
            lat: body.lat,
            lng: body.lng,
            speed_kmh: body.speed ?? 0,
            accel_x: accelX,
            accel_y: accelY,
            accel_z: accelZ,
            gyro_pitch: gyroPitch,
            gyro_roll: gyroRoll,
            iri_estimate: iriEstimate,
            vibration_mag: vibrationMag,
            pothole_trigger: potholeTrigger,
            raw_json: JSON.stringify(body)
        });

        const insertedId = result.lastInsertRowid;

        // Update device last_seen
        db.prepare("UPDATE devices SET last_seen_at = datetime('now'), location = @location WHERE id = @id").run({
            id: body.deviceId,
            location: `${body.lat.toFixed(4)}°N, ${body.lng.toFixed(4)}°E (Speed: ${body.speed ?? 0} km/h)`
        });

        // Run detection engine on this reading
        const telemetryRow = {
            id: insertedId,
            device_id: body.deviceId,
            lat: body.lat,
            lng: body.lng,
            accel_z: accelZ,
            iri_estimate: iriEstimate,
            vibration_mag: vibrationMag
        };

        const detection = analyzeTelemetry(telemetryRow);

        // Broadcast live telemetry to WebSocket clients
        broadcastTelemetry({
            telemetryId: insertedId,
            deviceId: body.deviceId,
            lat: body.lat,
            lng: body.lng,
            speedKmh: body.speed ?? 0,
            accel: { x: accelX, y: accelY, z: accelZ },
            gyro: { pitch: gyroPitch, roll: gyroRoll },
            iriEstimate: iriEstimate,
            vibrationMagnitude: vibrationMag,
            potholeTrigger: potholeTrigger === 1
        });

        // If pothole was detected, broadcast that too
        if (detection) {
            broadcastPotholeDetection(detection);
        }

        // Broadcast device status update
        const updatedDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(body.deviceId);
        if (updatedDevice) {
            broadcastDeviceStatus({
                deviceId: updatedDevice.id,
                batteryPct: updatedDevice.battery_pct,
                status: updatedDevice.status,
                lastSeenAt: updatedDevice.last_seen_at,
                location: updatedDevice.location
            });
        }

        res.json({
            success: true,
            telemetryId: insertedId,
            detection: detection || null,
            message: detection
                ? `Telemetry recorded. ${detection.type === 'pothole_new' ? 'NEW pothole detected!' : 'Pothole cluster updated.'}`
                : 'Telemetry recorded. Road surface normal.'
        });

    } catch (err) {
        console.error('[Telemetry] Ingestion error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/v1/telemetry/latest/:deviceId
 * Get the most recent telemetry reading from a specific device
 */
router.get('/latest/:deviceId', (req, res) => {
    const db = getDb();

    const latest = db.prepare(`
        SELECT * FROM telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1
    `).get(req.params.deviceId);

    if (!latest) {
        return res.json({ success: true, data: null, message: 'No telemetry data for this device' });
    }

    res.json({
        success: true,
        data: {
            timestamp: latest.timestamp,
            vehicleId: latest.device_id,
            speedKmh: latest.speed_kmh,
            accel: { x: latest.accel_x, y: latest.accel_y, z: latest.accel_z },
            gyro: { pitch: latest.gyro_pitch, roll: latest.gyro_roll },
            iriEstimate: latest.iri_estimate,
            vibrationMagnitude: latest.vibration_mag,
            potholeTrigger: latest.pothole_trigger === 1
        }
    });
});

/**
 * GET /api/v1/telemetry/history
 * Query telemetry by device, time range, and bounding box
 * 
 * Query params:
 *   deviceId (optional), from (ISO date), to (ISO date),
 *   minLat, maxLat, minLng, maxLng (optional bounding box),
 *   limit (default 500)
 */
router.get('/history', (req, res) => {
    const db = getDb();

    let query = 'SELECT * FROM telemetry WHERE 1=1';
    const params = {};

    if (req.query.deviceId) {
        query += ' AND device_id = @deviceId';
        params.deviceId = req.query.deviceId;
    }

    if (req.query.from) {
        query += ' AND timestamp >= @from';
        params.from = req.query.from;
    }

    if (req.query.to) {
        query += ' AND timestamp <= @to';
        params.to = req.query.to;
    }

    if (req.query.minLat && req.query.maxLat && req.query.minLng && req.query.maxLng) {
        query += ' AND lat BETWEEN @minLat AND @maxLat AND lng BETWEEN @minLng AND @maxLng';
        params.minLat = parseFloat(req.query.minLat);
        params.maxLat = parseFloat(req.query.maxLat);
        params.minLng = parseFloat(req.query.minLng);
        params.maxLng = parseFloat(req.query.maxLng);
    }

    const limit = parseInt(req.query.limit) || 500;
    query += ` ORDER BY id DESC LIMIT ${limit}`;

    const rows = db.prepare(query).all(params);

    // Also get summary stats
    const stats = db.prepare('SELECT COUNT(*) as total FROM telemetry').get();

    res.json({
        success: true,
        data: rows,
        count: rows.length,
        totalRecords: stats.total,
        syncedAt: new Date().toISOString()
    });
});

module.exports = router;
