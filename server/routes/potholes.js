/**
 * RoadHealth — Potholes API Routes
 * Query, report, and manage detected pothole locations
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { haversineDistance } = require('../services/detectionEngine');

/**
 * GET /api/v1/potholes
 * List all detected potholes with optional filtering
 * 
 * Query params:
 *   severity (optional): 'moderate' | 'critical'
 *   confirmed (optional): 0 | 1
 *   minLat, maxLat, minLng, maxLng (optional bounding box)
 *   limit (default 200)
 */
router.get('/', (req, res) => {
    const db = getDb();

    let query = 'SELECT * FROM potholes WHERE false_positive = 0';
    const params = {};

    if (req.query.severity) {
        query += ' AND severity = @severity';
        params.severity = req.query.severity;
    }

    if (req.query.confirmed !== undefined) {
        query += ' AND confirmed = @confirmed';
        params.confirmed = parseInt(req.query.confirmed);
    }

    if (req.query.minLat && req.query.maxLat && req.query.minLng && req.query.maxLng) {
        query += ' AND lat BETWEEN @minLat AND @maxLat AND lng BETWEEN @minLng AND @maxLng';
        params.minLat = parseFloat(req.query.minLat);
        params.maxLat = parseFloat(req.query.maxLat);
        params.minLng = parseFloat(req.query.minLng);
        params.maxLng = parseFloat(req.query.maxLng);
    }

    const limit = parseInt(req.query.limit) || 200;
    query += ` ORDER BY detected_at DESC LIMIT ${limit}`;

    const potholes = db.prepare(query).all(params);

    // Transform to match frontend expected format
    const formatted = potholes.map(p => ({
        id: `p-${p.id}`,
        lat: p.lat,
        lng: p.lng,
        severity: p.severity,
        iri: p.iri,
        depthCm: p.depth_cm,
        clusterSize: p.cluster_size,
        sourceDevice: p.source_device,
        confirmed: p.confirmed === 1,
        detectedAt: p.detected_at
    }));

    res.json({ success: true, potholes: formatted, count: formatted.length });
});

/**
 * GET /api/v1/potholes/near
 * Find potholes near a specific location
 * 
 * Query params:
 *   lat (required), lng (required), radius (meters, default 500)
 */
router.get('/near', (req, res) => {
    const { lat, lng, radius } = req.query;

    if (!lat || !lng) {
        return res.status(400).json({ success: false, error: 'lat and lng are required' });
    }

    const centerLat = parseFloat(lat);
    const centerLng = parseFloat(lng);
    const radiusM = parseFloat(radius) || 500;

    const db = getDb();

    // Bounding box approximation
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

    // Refine with actual distance and add distance field
    const results = candidates
        .map(p => {
            const dist = haversineDistance(centerLat, centerLng, p.lat, p.lng);
            return { ...p, distanceM: Math.round(dist) };
        })
        .filter(p => p.distanceM <= radiusM)
        .sort((a, b) => a.distanceM - b.distanceM);

    const formatted = results.map(p => ({
        id: `p-${p.id}`,
        lat: p.lat,
        lng: p.lng,
        severity: p.severity,
        iri: p.iri,
        depthCm: p.depth_cm,
        clusterSize: p.cluster_size,
        distanceM: p.distanceM,
        detectedAt: p.detected_at
    }));

    res.json({ success: true, potholes: formatted, count: formatted.length });
});

/**
 * POST /api/v1/potholes
 * Manually report a pothole (e.g., from user report or admin injection)
 */
router.post('/', (req, res) => {
    const { lat, lng, severity, iri, depthCm, sourceDevice } = req.body;

    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ success: false, error: 'lat and lng are required' });
    }

    const db = getDb();

    const result = db.prepare(`
        INSERT INTO potholes (lat, lng, severity, iri, depth_cm, cluster_size, source_device, confirmed)
        VALUES (@lat, @lng, @severity, @iri, @depth_cm, 1, @source_device, 1)
    `).run({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        severity: severity || 'moderate',
        iri: parseFloat(iri) || 3.0,
        depth_cm: parseFloat(depthCm) || 5.0,
        source_device: sourceDevice || 'manual-report'
    });

    res.json({
        success: true,
        id: `p-${result.lastInsertRowid}`,
        message: 'Pothole reported successfully'
    });
});

/**
 * DELETE /api/v1/potholes/:id
 * Mark a pothole as false positive (soft delete)
 */
router.delete('/:id', (req, res) => {
    const db = getDb();
    const numericId = req.params.id.replace('p-', '');

    const result = db.prepare(
        "UPDATE potholes SET false_positive = 1, updated_at = datetime('now') WHERE id = ?"
    ).run(numericId);

    if (result.changes === 0) {
        return res.status(404).json({ success: false, error: 'Pothole not found' });
    }

    res.json({ success: true, message: 'Pothole marked as false positive' });
});

module.exports = router;
