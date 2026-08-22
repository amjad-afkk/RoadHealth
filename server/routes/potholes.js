const express = require('express');
const router = express.Router();
const { isPostGIS, getPool, getDb } = require('../db/database');
const { haversineDistance } = require('../services/detectionEngine');
const { broadcast } = require('../ws/realtimeHub');
const { calculateDecayedConfidence, runDecaySweep } = require('../services/decayEngine');

router.get('/', async (req, res) => {
    try {
        let potholes = [];
        const { severity, status, confirmed, includeExpired, limit = 500 } = req.query;

        if (isPostGIS()) {
            const pool = getPool();
            let query = 'SELECT * FROM potholes WHERE false_positive = 0';
            const params = [];

            if (!includeExpired) {
                query += " AND status != 'decayed_expired'";
            }

            if (severity) {
                params.push(severity);
                query += ` AND severity = $${params.length}`;
            }
            if (status) {
                params.push(status);
                query += ` AND status = $${params.length}`;
            }
            if (confirmed !== undefined) {
                params.push(parseInt(confirmed));
                query += ` AND confirmed = $${params.length}`;
            }

            params.push(parseInt(limit));
            query += ` ORDER BY detected_at DESC LIMIT $${params.length}`;

            const result = await pool.query(query, params);
            potholes = result.rows;
        } else {
            const db = getDb();
            let query = 'SELECT * FROM potholes WHERE false_positive = 0';
            const params = {};

            if (!includeExpired) {
                query += " AND status != 'decayed_expired'";
            }

            if (severity) {
                query += ' AND severity = @severity';
                params.severity = severity;
            }
            if (status) {
                query += ' AND status = @status';
                params.status = status;
            }
            if (confirmed !== undefined) {
                query += ' AND confirmed = @confirmed';
                params.confirmed = parseInt(confirmed);
            }

            query += ` ORDER BY detected_at DESC LIMIT ${parseInt(limit)}`;
            potholes = db.prepare(query).all(params);
        }

        const formatted = potholes.map(p => {
            const decay = calculateDecayedConfidence(p);
            return {
                id: `p-${p.id}`,
                numericId: p.id,
                lat: parseFloat(p.lat),
                lng: parseFloat(p.lng),
                severity: p.severity,
                iri: parseFloat(p.iri || 0),
                depthCm: parseFloat(p.depth_cm || 0),
                clusterSize: parseInt(p.cluster_size || 1),
                confidence: decay.currentConfidence,
                elapsedDays: decay.elapsedDays,
                halfLifeDays: decay.halfLifeDays,
                isExpired: decay.isExpired,
                sourceDevice: p.source_device,
                status: p.status || 'reported',
                assignedContractor: p.assigned_contractor || null,
                confirmed: p.confirmed === 1,
                lastHitAt: p.last_hit_at || p.detected_at,
                detectedAt: p.detected_at,
                updatedAt: p.updated_at
            };
        });

        res.json({ success: true, potholes: formatted, count: formatted.length });
    } catch (err) {
        console.error('[Potholes] GET error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/decay/run', async (req, res) => {
    try {
        const sweepResult = await runDecaySweep();
        res.json(sweepResult);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/clear', async (req, res) => {
    try {
        if (isPostGIS()) {
            const pool = getPool();
            await pool.query('TRUNCATE TABLE potholes RESTART IDENTITY CASCADE;');
        } else {
            const db = getDb();
            db.prepare('DELETE FROM potholes;').run();
        }

        broadcast('pothole:repaired', { cleared: true });

        res.json({ success: true, message: 'All potholes cleared from database.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/heatmap', async (req, res) => {
    try {
        let points = [];

        if (isPostGIS()) {
            const pool = getPool();
            const result = await pool.query(`
                SELECT lat, lng, severity, iri, cluster_size, confidence, last_hit_at, half_life_days 
                FROM potholes 
                WHERE false_positive = 0 AND status != 'repaired' AND status != 'decayed_expired'
                ORDER BY detected_at DESC LIMIT 1000
            `);
            points = result.rows;
        } else {
            const db = getDb();
            points = db.prepare(`
                SELECT lat, lng, severity, iri, cluster_size, confidence, last_hit_at, half_life_days 
                FROM potholes 
                WHERE false_positive = 0 AND status != 'repaired' AND status != 'decayed_expired'
                ORDER BY detected_at DESC LIMIT 1000
            `).all();
        }

        const heatmapData = points.map(p => {
            let weight = 0.4;
            if (p.severity === 'critical' || p.iri >= 4.5) weight = 0.95;
            else if (p.iri >= 2.5) weight = 0.65;

            if (p.cluster_size > 1) {
                weight = Math.min(1.0, weight + (p.cluster_size * 0.05));
            }

            return [parseFloat(p.lat), parseFloat(p.lng), weight];
        });

        res.json({
            success: true,
            points: heatmapData,
            count: heatmapData.length
        });
    } catch (err) {
        console.error('[Heatmap] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/export', async (req, res) => {
    try {
        const format = (req.query.format || 'geojson').toLowerCase();
        let potholes = [];

        if (isPostGIS()) {
            const pool = getPool();
            const result = await pool.query(`
                SELECT id, lat, lng, severity, iri, depth_cm, cluster_size, source_device, status, assigned_contractor, detected_at, updated_at
                FROM potholes
                WHERE false_positive = 0
                ORDER BY detected_at DESC
            `);
            potholes = result.rows;
        } else {
            const db = getDb();
            potholes = db.prepare(`
                SELECT id, lat, lng, severity, iri, depth_cm, cluster_size, source_device, status, assigned_contractor, detected_at, updated_at
                FROM potholes
                WHERE false_positive = 0
                ORDER BY detected_at DESC
            `).all();
        }

        if (format === 'csv') {
            const headers = 'ID,Latitude,Longitude,Severity,IRI_m_per_km,Depth_cm,Cluster_Size,Status,Contractor,Source_Device,Detected_At\n';
            const rows = potholes.map(p => 
                `"P-${p.id}",${p.lat},${p.lng},"${p.severity}",${p.iri || 0},${p.depth_cm || 0},${p.cluster_size || 1},"${p.status || 'reported'}","${p.assigned_contractor || 'Unassigned'}","${p.source_device || ''}","${p.detected_at}"`
            ).join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="telangana_road_defects.csv"');
            return res.send(headers + rows);
        }

        const geojson = {
            type: 'FeatureCollection',
            name: 'Telangana_RoadHealth_Defects',
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
            features: potholes.map(p => ({
                type: 'Feature',
                id: p.id,
                geometry: {
                    type: 'Point',
                    coordinates: [parseFloat(p.lng), parseFloat(p.lat)]
                },
                properties: {
                    potholeId: `P-${p.id}`,
                    severity: p.severity,
                    iriEstimate: parseFloat(p.iri || 0),
                    estimatedDepthCm: parseFloat(p.depth_cm || 0),
                    clusterCount: parseInt(p.cluster_size || 1),
                    status: p.status || 'reported',
                    assignedContractor: p.assigned_contractor,
                    sourceDevice: p.source_device,
                    detectedAt: p.detected_at,
                    updatedAt: p.updated_at
                }
            }))
        };

        res.setHeader('Content-Type', 'application/geo+json');
        res.setHeader('Content-Disposition', 'attachment; filename="telangana_road_defects.geojson"');
        res.json(geojson);

    } catch (err) {
        console.error('[Export] Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.patch('/:id/status', async (req, res) => {
    try {
        const { status, contractor } = req.body;
        const validStatuses = ['reported', 'verified', 'in_progress', 'repaired'];
        
        if (!status || !validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const numericId = parseInt(String(req.params.id).replace(/^p-/i, ''));
        if (isNaN(numericId)) {
            return res.status(400).json({ success: false, error: 'Invalid pothole ID' });
        }

        if (isPostGIS()) {
            const pool = getPool();
            await pool.query(`
                UPDATE potholes 
                SET status = $1, 
                    assigned_contractor = COALESCE($2, assigned_contractor),
                    updated_at = NOW()
                WHERE id = $3
            `, [status, contractor || null, numericId]);
        } else {
            const db = getDb();
            db.prepare(`
                UPDATE potholes 
                SET status = @status, 
                    assigned_contractor = COALESCE(@contractor, assigned_contractor),
                    updated_at = datetime('now')
                WHERE id = @id
            `).run({ status, contractor: contractor || null, id: numericId });
        }

        broadcast('pothole:repaired', {
            id: `p-${numericId}`,
            numericId,
            status
        });

        res.json({ success: true, message: `Pothole P-${numericId} status updated to '${status}'` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/near', async (req, res) => {
    try {
        const { lat, lng, radius } = req.query;
        if (!lat || !lng) {
            return res.status(400).json({ success: false, error: 'lat and lng are required' });
        }

        const centerLat = parseFloat(lat);
        const centerLng = parseFloat(lng);
        const radiusM = parseFloat(radius) || 500;

        let results = [];

        if (isPostGIS()) {
            const pool = getPool();
            const qRes = await pool.query(`
                SELECT id, lat, lng, severity, iri, depth_cm, cluster_size, status, detected_at,
                       ROUND(ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric, 1) as distance_m
                FROM potholes
                WHERE false_positive = 0
                  AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
                ORDER BY distance_m ASC
            `, [centerLng, centerLat, radiusM]);

            results = qRes.rows.map(p => ({
                id: `p-${p.id}`,
                lat: parseFloat(p.lat),
                lng: parseFloat(p.lng),
                severity: p.severity,
                iri: parseFloat(p.iri || 0),
                depthCm: parseFloat(p.depth_cm || 0),
                clusterSize: parseInt(p.cluster_size || 1),
                status: p.status || 'reported',
                distanceM: parseFloat(p.distance_m || 0),
                detectedAt: p.detected_at
            }));
        } else {
            const db = getDb();
            const latDelta = radiusM / 111320;
            const lngDelta = radiusM / (111320 * Math.cos(centerLat * Math.PI / 180));

            const candidates = db.prepare(`
                SELECT * FROM potholes
                WHERE lat BETWEEN @minLat AND @maxLat
                  AND lng BETWEEN @minLng AND @maxLng
                  AND false_positive = 0
                ORDER BY detected_at DESC
            `).all({
                minLat: centerLat - latDelta,
                maxLat: centerLat + latDelta,
                minLng: centerLng - lngDelta,
                maxLng: centerLng + lngDelta
            });

            results = candidates
                .map(p => {
                    const dist = haversineDistance(centerLat, centerLng, p.lat, p.lng);
                    return { ...p, distanceM: Math.round(dist) };
                })
                .filter(p => p.distanceM <= radiusM)
                .sort((a, b) => a.distanceM - b.distanceM)
                .map(p => ({
                    id: `p-${p.id}`,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    severity: p.severity,
                    iri: parseFloat(p.iri || 0),
                    depthCm: parseFloat(p.depth_cm || 0),
                    clusterSize: parseInt(p.cluster_size || 1),
                    status: p.status || 'reported',
                    distanceM: p.distanceM,
                    detectedAt: p.detected_at
                }));
        }

        res.json({ success: true, potholes: results, count: results.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { lat, lng, severity, iri, depthCm, sourceDevice } = req.body;
        if (lat === undefined || lng === undefined) {
            return res.status(400).json({ success: false, error: 'lat and lng are required' });
        }

        const latitude = parseFloat(lat);
        const longitude = parseFloat(lng);
        const sev = severity || 'moderate';
        const iriVal = parseFloat(iri) || 3.0;
        const depth = parseFloat(depthCm) || 5.0;
        const dev = sourceDevice || 'ESP32-NODE-TS09-EA-4412';

        let newId = null;

        if (isPostGIS()) {
            const pool = getPool();
            const insertRes = await pool.query(`
                INSERT INTO potholes (lat, lng, geom, severity, iri, depth_cm, cluster_size, source_device, status, confirmed)
                VALUES ($1, $2, ST_SetSRID(ST_MakePoint($2, $1), 4326), $3, $4, $5, 1, $6, 'verified', 1)
                RETURNING id
            `, [latitude, longitude, sev, iriVal, depth, dev]);
            newId = insertRes.rows[0]?.id;
        } else {
            const db = getDb();
            const result = db.prepare(`
                INSERT INTO potholes (lat, lng, severity, iri, depth_cm, cluster_size, source_device, status, confirmed)
                VALUES (@lat, @lng, @severity, @iri, @depth_cm, 1, @source_device, 'verified', 1)
            `).run({
                lat: latitude,
                lng: longitude,
                severity: sev,
                iri: iriVal,
                depth_cm: depth,
                source_device: dev
            });
            newId = result.lastInsertRowid;
        }

        res.json({
            success: true,
            id: `p-${newId}`,
            message: 'Pothole reported successfully'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const numericId = parseInt(String(req.params.id).replace(/^p-/i, ''));
        if (isNaN(numericId)) {
            return res.status(400).json({ success: false, error: 'Invalid pothole ID' });
        }

        if (isPostGIS()) {
            const pool = getPool();
            const result = await pool.query(
                "UPDATE potholes SET false_positive = 1, updated_at = NOW() WHERE id = $1",
                [numericId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Pothole not found' });
            }
        } else {
            const db = getDb();
            const result = db.prepare(
                "UPDATE potholes SET false_positive = 1, updated_at = datetime('now') WHERE id = ?"
            ).run(numericId);
            if (result.changes === 0) {
                return res.status(404).json({ success: false, error: 'Pothole not found' });
            }
        }

        broadcast('pothole:repaired', {
            id: `p-${numericId}`,
            numericId,
            status: 'deleted'
        });

        res.json({ success: true, message: 'Pothole marked as false positive' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
