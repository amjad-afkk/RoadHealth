/**
 * RoadHealth — Telemetry API Routes (PostGIS & Live Simulation Engine)
 * Ingest sensor data from ESP32 devices and simulate virtual patrol rides
 */

const express = require('express');
const router = express.Router();
const { isPostGIS, getPool, getDb } = require('../db/database');
const { analyzeTelemetry } = require('../services/detectionEngine');
const { broadcastTelemetry, broadcastPotholeDetection, broadcastDeviceStatus } = require('../ws/realtimeHub');

/**
 * POST /api/v1/telemetry
 * Ingest endpoint — ESP32 hardware nodes POST sensor data here
 */
router.post('/', async (req, res) => {
    try {
        const body = req.body;

        // Validate required fields
        if (!body.deviceId || body.lat === undefined || body.lng === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: deviceId, lat, lng'
            });
        }

        const lat = parseFloat(body.lat);
        const lng = parseFloat(body.lng);
        const speedKmh = parseFloat(body.speed ?? 0);
        const accelX = parseFloat(body.accel?.x ?? 0);
        const accelY = parseFloat(body.accel?.y ?? 0);
        const accelZ = parseFloat(body.accel?.z ?? 9.81);
        const gyroPitch = parseFloat(body.gyro?.pitch ?? 0);
        const gyroRoll = parseFloat(body.gyro?.roll ?? 0);

        // Calculate vibration magnitude if not provided
        const vibrationMag = body.vibrationMagnitude !== undefined
            ? parseFloat(body.vibrationMagnitude)
            : Math.sqrt(accelX * accelX + accelY * accelY + (accelZ - 9.81) * (accelZ - 9.81));

        // Calculate IRI estimate if not provided
        const iriEstimate = body.iriEstimate !== undefined
            ? parseFloat(body.iriEstimate)
            : +(vibrationMag * 2.8).toFixed(2);

        // Determine pothole trigger
        const potholeTrigger = body.potholeTrigger
            ? 1
            : (Math.abs(accelZ - 9.81) > 3.2 ? 1 : 0);

        let insertedId = null;

        if (isPostGIS()) {
            const pool = getPool();

            // Auto-register device if not existing
            const devCheck = await pool.query('SELECT id FROM devices WHERE id = $1', [body.deviceId]);
            if (devCheck.rows.length === 0) {
                const parts = body.deviceId.split('-');
                const plate = parts.length >= 4 ? `${parts[2]} ${parts[3]}` : body.deviceId;
                await pool.query(`
                    INSERT INTO devices (id, bike_plate, bike_model, rider_name, location, battery_pct, status)
                    VALUES ($1, $2, 'ESP32 Patrol Node', 'Active Hardware Unit', 'Live GPS Field Data', 100, 'Active')
                    ON CONFLICT (id) DO NOTHING
                `, [body.deviceId, plate]);
                console.log(`[Telemetry] Auto-registered new PostGIS ESP32 node: ${body.deviceId} (Plate: ${plate})`);
            }

            // Insert telemetry with native PostGIS Point Geometry
            const insertRes = await pool.query(`
                INSERT INTO telemetry (
                    device_id, lat, lng, geom, speed_kmh, 
                    accel_x, accel_y, accel_z, gyro_pitch, gyro_roll, 
                    iri_estimate, vibration_mag, pothole_trigger, raw_json
                )
                VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            `, [
                body.deviceId, lat, lng, speedKmh,
                accelX, accelY, accelZ, gyroPitch, gyroRoll,
                iriEstimate, vibrationMag, potholeTrigger, JSON.stringify(body)
            ]);

            insertedId = insertRes.rows[0]?.id;

            // Update device status
            await pool.query(`
                UPDATE devices 
                SET last_seen_at = NOW(), 
                    location = $1 
                WHERE id = $2
            `, [`${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E (Speed: ${speedKmh} km/h)`, body.deviceId]);

        } else {
            // SQLite fallback
            const db = getDb();
            let device = db.prepare('SELECT id FROM devices WHERE id = ?').get(body.deviceId);
            if (!device) {
                const parts = body.deviceId.split('-');
                const plate = parts.length >= 4 ? `${parts[2]} ${parts[3]}` : body.deviceId;
                db.prepare(`
                    INSERT INTO devices (id, bike_plate, bike_model, rider_name, location, battery_pct, status)
                    VALUES (@id, @bike_plate, 'ESP32 Patrol Node', 'Active Hardware Unit', 'Live GPS Field Data', 100, 'Active')
                `).run({ id: body.deviceId, bike_plate: plate });
            }

            const result = db.prepare(`
                INSERT INTO telemetry (device_id, lat, lng, speed_kmh, accel_x, accel_y, accel_z, gyro_pitch, gyro_roll, iri_estimate, vibration_mag, pothole_trigger, raw_json)
                VALUES (@device_id, @lat, @lng, @speed_kmh, @accel_x, @accel_y, @accel_z, @gyro_pitch, @gyro_roll, @iri_estimate, @vibration_mag, @pothole_trigger, @raw_json)
            `).run({
                device_id: body.deviceId,
                lat, lng, speed_kmh: speedKmh,
                accel_x: accelX, accel_y: accelY, accel_z: accelZ,
                gyro_pitch: gyroPitch, gyro_roll: gyroRoll,
                iri_estimate: iriEstimate,
                vibration_mag: vibrationMag,
                pothole_trigger: potholeTrigger,
                raw_json: JSON.stringify(body)
            });

            insertedId = result.lastInsertRowid;

            db.prepare("UPDATE devices SET last_seen_at = datetime('now'), location = @location WHERE id = @id").run({
                id: body.deviceId,
                location: `${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E (Speed: ${speedKmh} km/h)`
            });
        }

        // Run detection engine on this reading
        const telemetryRow = {
            id: insertedId,
            device_id: body.deviceId,
            lat,
            lng,
            accel_z: accelZ,
            iri_estimate: iriEstimate,
            vibration_mag: vibrationMag
        };

        const detection = await analyzeTelemetry(telemetryRow);

        // Broadcast live telemetry to WebSocket clients
        broadcastTelemetry({
            telemetryId: insertedId,
            deviceId: body.deviceId,
            lat,
            lng,
            speedKmh,
            accel: { x: accelX, y: accelY, z: accelZ },
            gyro: { pitch: gyroPitch, roll: gyroRoll },
            iriEstimate,
            vibrationMagnitude: vibrationMag,
            potholeTrigger: potholeTrigger === 1
        });

        // Broadcast pothole alert if detected
        if (detection) {
            broadcastPotholeDetection(detection);
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
 * POST /api/v1/telemetry/simulate
 * Virtual Patrol Bike Stream along given coordinates (or default Hyderabad corridor)
 */
let activeSimulationInterval = null;

router.post('/simulate', (req, res) => {
    const { routeCoords, durationSec = 30, deviceId = 'ESP32-NODE-SIM-VIRTUAL' } = req.body;

    if (activeSimulationInterval) {
        clearInterval(activeSimulationInterval);
        activeSimulationInterval = null;
    }

    // Default route: Hitec City to Gachibowli Outer Ring Road
    const defaultCoords = [
        [17.4435, 78.3772],
        [17.4410, 78.3740],
        [17.4380, 78.3690],
        [17.4350, 78.3620],
        [17.4320, 78.3580],
        [17.4300, 78.3540],
        [17.4280, 78.3500],
        [17.4250, 78.3450]
    ];

    const coords = (routeCoords && routeCoords.length >= 2) ? routeCoords : defaultCoords;
    let step = 0;
    const totalSteps = coords.length;

    console.log(`[Simulator] Starting virtual patrol bike ride (${totalSteps} waypoints) on ${deviceId}...`);

    activeSimulationInterval = setInterval(async () => {
        if (step >= totalSteps) {
            clearInterval(activeSimulationInterval);
            activeSimulationInterval = null;
            console.log('[Simulator] Simulation ride completed.');
            return;
        }

        const [lat, lng] = coords[step];
        const isBumpy = step === 2 || step === 5; // Introduce periodic pothole impacts

        const accelZ = isBumpy ? (14.5 + Math.random() * 5.0) : (9.81 + (Math.random() - 0.5) * 0.8);
        const vibMag = isBumpy ? (3.5 + Math.random() * 2.0) : (0.3 + Math.random() * 0.4);
        const iri = +(vibMag * 2.8).toFixed(2);
        const speed = Math.round(38 + Math.random() * 12);

        const packet = {
            deviceId,
            lat,
            lng,
            speed,
            accel: {
                x: +((Math.random() - 0.5) * 0.3).toFixed(3),
                y: +((Math.random() - 0.5) * 0.3).toFixed(3),
                z: +accelZ.toFixed(3)
            },
            gyro: {
                pitch: +((Math.random() - 0.5) * 0.8).toFixed(3),
                roll: +((Math.random() - 0.5) * 0.8).toFixed(3)
            },
            iriEstimate: iri,
            vibrationMagnitude: +vibMag.toFixed(3),
            potholeTrigger: isBumpy
        };

        try {
            // Process via internal detection pipeline
            const telemetryRow = {
                id: Date.now(),
                device_id: deviceId,
                lat,
                lng,
                accel_z: accelZ,
                iri_estimate: iri,
                vibration_mag: vibMag
            };

            const detection = await analyzeTelemetry(telemetryRow);

            broadcastTelemetry({
                telemetryId: telemetryRow.id,
                deviceId,
                lat,
                lng,
                speedKmh: speed,
                accel: packet.accel,
                gyro: packet.gyro,
                iriEstimate: iri,
                vibrationMagnitude: +vibMag.toFixed(3),
                potholeTrigger: isBumpy
            });

            if (detection) {
                broadcastPotholeDetection(detection);
            }
        } catch (simErr) {
            console.warn('[Simulator] Error in step:', simErr.message);
        }

        step++;
    }, 1200);

    res.json({
        success: true,
        message: `Simulation started for ${deviceId} with ${totalSteps} waypoints.`,
        waypoints: totalSteps
    });
});

/**
 * GET /api/v1/telemetry/history
 */
router.get('/history', async (req, res) => {
    try {
        let rows = [];
        let total = 0;
        const { limit = 200 } = req.query;

        if (isPostGIS()) {
            const pool = getPool();
            const qRes = await pool.query('SELECT * FROM telemetry ORDER BY id DESC LIMIT $1', [parseInt(limit)]);
            const cRes = await pool.query('SELECT COUNT(*) as total FROM telemetry');
            rows = qRes.rows;
            total = parseInt(cRes.rows[0]?.total || 0);
        } else {
            const db = getDb();
            rows = db.prepare(`SELECT * FROM telemetry ORDER BY id DESC LIMIT ${parseInt(limit)}`).all();
            total = db.prepare('SELECT COUNT(*) as total FROM telemetry').get().total;
        }

        res.json({
            success: true,
            data: rows,
            count: rows.length,
            totalRecords: total,
            syncedAt: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
