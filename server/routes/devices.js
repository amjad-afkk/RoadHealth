const express = require('express');
const router = express.Router();
const { isPostGIS, getPool, getDb } = require('../db/database');

router.get('/', async (req, res) => {
    try {
        let devices = [];
        if (isPostGIS()) {
            const pool = getPool();
            const result = await pool.query(`
                SELECT d.*, 
                       t.lat as live_lat, 
                       t.lng as live_lng, 
                       t.speed_kmh as live_speed,
                       t.accel_z as live_az,
                       t.iri_estimate as live_iri,
                       t.vibration_mag as live_vib,
                       t.pothole_trigger as live_trigger,
                       t.timestamp as live_timestamp
                FROM devices d
                LEFT JOIN LATERAL (
                    SELECT * FROM telemetry 
                    WHERE device_id = d.id 
                    ORDER BY id DESC 
                    LIMIT 1
                ) t ON true
                ORDER BY d.id
            `);
            devices = result.rows;
        } else {
            const db = getDb();
            devices = db.prepare('SELECT * FROM devices ORDER BY id').all();
        }

        const formatted = devices.map(d => ({
            nodeId: d.id,
            bikePlate: d.bike_plate || 'TS 09 EA 4412',
            bikeModel: d.bike_model || 'ESP32 Patrol Node',
            riderName: d.rider_name || 'Hardware Patrol Unit',
            location: d.live_lat ? `${parseFloat(d.live_lat).toFixed(4)}°N, ${parseFloat(d.live_lng).toFixed(4)}°E (Speed: ${parseFloat(d.live_speed || 0).toFixed(1)} km/h)` : (d.location || 'Awaiting GPS Fix (TinyGPS++)'),
            batteryPct: d.battery_pct || 98,
            batteryVoltage: d.battery_voltage || 4.15,
            firmware: d.firmware || 'v2.4.2-Release',
            sensors: {
                accel: 'MPU6500 6-DoF (100 Hz)',
                gps: 'NEO-6M (TinyGPS++)',
                network: 'WiFi (vivo v29)',
                sampling: '100 Hz (10ms)',
                interval: '1000 ms (1 Hz)',
                status: d.status || 'Active'
            },
            telemetry: {
                lat: d.live_lat ? parseFloat(d.live_lat) : null,
                lng: d.live_lng ? parseFloat(d.live_lng) : null,
                speedKmh: d.live_speed ? parseFloat(d.live_speed) : 0,
                accelZ: d.live_az ? parseFloat(d.live_az) : 9.81,
                iri: d.live_iri ? parseFloat(d.live_iri) : 1.1,
                vibration: d.live_vib ? parseFloat(d.live_vib) : 0.2,
                potholeTrigger: d.live_trigger === 1,
                lastPacketAt: d.live_timestamp || d.last_seen_at
            },
            lastAnomaly: d.live_trigger === 1 ? '🚨 Pothole Impact (Z-Spike > 2.2G)' : (d.last_anomaly || 'Nominal (G-Force < 2.2G)'),
            lastSeenAt: d.live_timestamp || d.last_seen_at
        }));

        res.json({ success: true, devices: formatted, count: formatted.length });
    } catch (err) {
        console.error('[Devices] GET error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

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
