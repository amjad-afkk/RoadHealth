/**
 * RoadHealth — Routes Analysis API
 * Analyze road health for route segments using stored telemetry data
 */

const express = require('express');
const router = express.Router();
const { analyzeRouteHealth, getDatabaseStats } = require('../services/healthScorer');
const { getConfig, updateThresholds } = require('../services/detectionEngine');

/**
 * POST /api/v1/routes/analyze
 * Analyze a route's segments against stored telemetry and pothole data
 * 
 * Body: { segments: [ { coords: [[lat, lng], ...], roadName: "..." }, ... ] }
 * Returns: health analysis with real data overlay
 */
router.post('/analyze', (req, res) => {
    try {
        const { segments } = req.body;

        if (!segments || !Array.isArray(segments) || segments.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body must include segments array with coords'
            });
        }

        const analysis = analyzeRouteHealth(segments);

        res.json({
            success: true,
            analysis
        });

    } catch (err) {
        console.error('[Routes] Analysis error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/v1/routes/stats
 * Get database-wide statistics (replaces the mock "PostGIS sync" response)
 */
router.get('/stats', (req, res) => {
    try {
        const stats = getDatabaseStats();
        const config = getConfig();

        res.json({
            success: true,
            syncedAt: new Date().toISOString(),
            engine: 'SQLite WAL Mode (PostGIS-ready schema)',
            version: 'RoadHealth DB v1.0',
            stats,
            detectionConfig: config
        });

    } catch (err) {
        console.error('[Routes] Stats error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * PUT /api/v1/routes/config
 * Update detection engine thresholds
 */
router.put('/config', (req, res) => {
    try {
        const { zSpikeThreshold, iriCriticalThreshold, iriModerateThreshold, dedupRadiusM } = req.body;

        updateThresholds({
            zSpikeThreshold,
            iriCriticalThreshold,
            iriModerateThreshold,
            dedupRadiusM
        });

        const config = getConfig();

        res.json({
            success: true,
            message: 'Detection thresholds updated',
            config
        });

    } catch (err) {
        console.error('[Routes] Config update error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
