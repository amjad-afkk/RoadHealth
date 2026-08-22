/**
 * RoadHealth — Devices API Routes (PostGIS & SQLite Compatible)
 * Register and manage real ESP32 fleet nodes
 */

const express = require('express');
const router = express.Router();
const { isPostGIS, getPool, getDb } = require('../db/database');

/**
 * GET /api/v1/devices
 * List all registered ESP32 fleet devices
 */
router.get('/', async (req, res) => {
    try {
        let devices = [];
        if (isPostGIS()) {
            const pool = getPool();
            const result = await pool.query('SELECT * FROM devices ORDER BY bike_plate');
            devices = result.rows;
        } else {
            const db = getDb();
            devices = db.prepare('SELECT * FROM devices ORDER BY bike_plate').all();
        }

        const formatted = devices.map(d => ({
            nodeId: d.id,
            bikePlate: d.bike_plate,
            bikeModel: d.bike_model,
            riderName: d.rider_name,
            location: d.location || 'Not active yet',
            batteryPct: d.battery_pct,
            batteryVoltage: d.battery_voltage,
            batteryStatus: d.battery_status,
            firmware: d.firmware,
            sensors: {
                accel: d.accel_sensor,
                accelHealth: 'Calibrated',
                gps: d.gps_sensor,
                network: d.network_info,
                sdStorage: d.sd_storage,
                status: d.status
            },
            lastAnomaly: d.last_anomaly || 'None',
            lastSeenAt: d.last_seen_at
        }));

        res.json({ success: true, devices: formatted, count: formatted.length });
    } catch (err) {
        console.error('[Devices] GET error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/v1/devices
 * Register a new real ESP32 fleet node
 */
router.post('/', async (req, res) => {
    const { id, bikePlate, bikeModel, riderName, location, firmware, gpsSensor, networkInfo } = req.body;

    if (!id || !bikePlate) {
        return res.status(400).json({ success: false, error: 'id (MAC/NodeID) and bikePlate are required' });
    }

    try {
        if (isPostGIS()) {
            const pool = getPool();
            await pool.query(`
                INSERT INTO devices (id, bike_plate, bike_model, rider_name, location, firmware, gps_sensor, network_info)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT(id) DO UPDATE SET
                    bike_plate = EXCLUDED.bike_plate,
                    bike_model = EXCLUDED.bike_model,
                    rider_name = EXCLUDED.rider_name,
                    location = EXCLUDED.location,
                    firmware = EXCLUDED.firmware,
                    last_seen_at = NOW()
            `, [
                id,
                bikePlate || 'TS 09 UNKNOWN',
                bikeModel || 'Patrol Bike',
                riderName || 'Unassigned Patrol',
                location || 'Registered Node',
                firmware || 'v2.4.2-Release',
                gpsSensor || 'NEO-6M GPS',
                networkInfo || '4G LTE SIM7600'
            ]);
        } else {
            const db = getDb();
            db.prepare(`
                INSERT INTO devices (id, bike_plate, bike_model, rider_name, location, firmware, gps_sensor, network_info)
                VALUES (@id, @bikePlate, @bikeModel, @riderName, @location, @firmware, @gpsSensor, @networkInfo)
                ON CONFLICT(id) DO UPDATE SET
                    bike_plate = excluded.bike_plate,
                    bike_model = excluded.bike_model,
                    rider_name = excluded.rider_name,
                    location = excluded.location,
                    firmware = excluded.firmware,
                    last_seen_at = datetime('now')
            `).run({
                id,
                bikePlate: bikePlate || 'TS 09 UNKNOWN',
                bikeModel: bikeModel || 'Patrol Bike',
                riderName: riderName || 'Unassigned Patrol',
                location: location || 'Registered Node',
                firmware: firmware || 'v2.4.2-Release',
                gpsSensor: gpsSensor || 'NEO-6M GPS',
                networkInfo: networkInfo || '4G LTE SIM7600'
            });
        }

        res.json({ success: true, message: 'ESP32 Device registered successfully', deviceId: id });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/v1/devices/:id
 */
router.get('/:id', async (req, res) => {
    try {
        let device = null;
        let latestTelemetry = null;
        let potholeCount = 0;

        if (isPostGIS()) {
            const pool = getPool();
            const devRes = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
            device = devRes.rows[0];

            if (device) {
                const telRes = await pool.query('SELECT * FROM telemetry WHERE device_id = $1 ORDER BY id DESC LIMIT 1', [req.params.id]);
                latestTelemetry = telRes.rows[0] || null;

                const pCountRes = await pool.query('SELECT COUNT(*) as cnt FROM potholes WHERE source_device = $1 AND false_positive = 0', [req.params.id]);
                potholeCount = parseInt(pCountRes.rows[0]?.cnt || 0);
            }
        } else {
            const db = getDb();
            device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
            if (device) {
                latestTelemetry = db.prepare('SELECT * FROM telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(req.params.id);
                const countRow = db.prepare('SELECT COUNT(*) as cnt FROM potholes WHERE source_device = ? AND false_positive = 0').get(req.params.id);
                potholeCount = countRow?.cnt || 0;
            }
        }

        if (!device) {
            return res.status(404).json({ success: false, error: 'Device not found' });
        }

        res.json({
            success: true,
            device: {
                ...device,
                latestTelemetry,
                potholesDetected: potholeCount
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
