/**
 * RoadHealth — Devices API Routes
 * Register and manage real ESP32 fleet nodes
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

/**
 * GET /api/v1/devices
 * List all registered ESP32 fleet devices
 */
router.get('/', (req, res) => {
    const db = getDb();

    const devices = db.prepare('SELECT * FROM devices ORDER BY bike_plate').all();

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
});

/**
 * POST /api/v1/devices
 * Register a new real ESP32 fleet node
 */
router.post('/', (req, res) => {
    const { id, bikePlate, bikeModel, riderName, location, firmware, gpsSensor, networkInfo } = req.body;

    if (!id || !bikePlate) {
        return res.status(400).json({ success: false, error: 'id (MAC/NodeID) and bikePlate are required' });
    }

    const db = getDb();

    try {
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

        res.json({ success: true, message: 'ESP32 Device registered successfully', deviceId: id });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/v1/devices/:id
 * Get a single device's details
 */
router.get('/:id', (req, res) => {
    const db = getDb();
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);

    if (!device) {
        return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const latestTelemetry = db.prepare(
        'SELECT * FROM telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1'
    ).get(req.params.id);

    const potholeCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM potholes WHERE source_device = ? AND false_positive = 0'
    ).get(req.params.id);

    res.json({
        success: true,
        device: {
            ...device,
            latestTelemetry: latestTelemetry || null,
            potholesDetected: potholeCount.cnt
        }
    });
});

/**
 * PUT /api/v1/devices/:id
 * Update device configuration
 */
router.put('/:id', (req, res) => {
    const db = getDb();
    const { location, battery_pct, battery_voltage, battery_status, firmware, status } = req.body;

    const updates = [];
    const params = { id: req.params.id };

    if (location !== undefined) { updates.push('location = @location'); params.location = location; }
    if (battery_pct !== undefined) { updates.push('battery_pct = @battery_pct'); params.battery_pct = battery_pct; }
    if (battery_voltage !== undefined) { updates.push('battery_voltage = @battery_voltage'); params.battery_voltage = battery_voltage; }
    if (battery_status !== undefined) { updates.push('battery_status = @battery_status'); params.battery_status = battery_status; }
    if (firmware !== undefined) { updates.push('firmware = @firmware'); params.firmware = firmware; }
    if (status !== undefined) { updates.push('status = @status'); params.status = status; }

    if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updates.push("last_seen_at = datetime('now')");

    db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE id = @id`).run(params);

    res.json({ success: true, message: 'Device updated' });
});

module.exports = router;
