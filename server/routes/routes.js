/**
 * RoadHealth — Routes Analysis API (PostGIS & Spatial Intelligence)
 * Analyze road health for route segments using stored telemetry and PostGIS
 */

const express = require('express');
const router = express.Router();
const { analyzeRouteHealth, getDatabaseStats } = require('../services/healthScorer');
const { getConfig, updateThresholds } = require('../services/detectionEngine');
const { getEngineInfo } = require('../db/database');

/**
 * POST /api/v1/routes/analyze
 * Analyze a route's segments against stored telemetry and pothole data
 */
router.post('/analyze', async (req, res) => {
    try {
        const { segments } = req.body;

        if (!segments || !Array.isArray(segments) || segments.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body must include segments array with coords'
            });
        }

        const analysis = await analyzeRouteHealth(segments);

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
 * Get database-wide statistics and PostGIS engine information
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await getDatabaseStats();
        const config = getConfig();
        const engineInfo = getEngineInfo();

        res.json({
            success: true,
            syncedAt: new Date().toISOString(),
            engine: engineInfo.version,
            databaseType: engineInfo.type,
            isSpatialPostGIS: engineInfo.isSpatial,
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
