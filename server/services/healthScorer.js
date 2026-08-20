/**
 * RoadHealth — Road Health Scorer Service (Strict Live Mode)
 * 
 * Given a route polyline, cross-references stored telemetry and pothole data
 * to compute real health scores per segment. Zero random numbers or mock jitter.
 */

const { getDb } = require('../db/database');
const { haversineDistance } = require('./detectionEngine');

// Buffer distance around route to query telemetry (meters)
const CORRIDOR_BUFFER_M = 30;

/**
 * Analyze a route's road health using stored telemetry and pothole data
 * 
 * @param {Array} segments - Array of route segments, each with coords: [[lat, lng], ...]
 * @returns {Object} - Analyzed route with real data
 */
function analyzeRouteHealth(segments) {
    const db = getDb();
    const analyzedSegments = [];

    let totalLengthM = 0;
    let totalPotholes = 0;
    let greenLengthM = 0, yellowLengthM = 0, redLengthM = 0;
    let weightedIriSum = 0, weightedVibSum = 0;

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const coords = seg.coords || [];

        if (coords.length < 2) {
            analyzedSegments.push({ ...seg, health: 'good', iri: 1.0, potholeCount: 0, vibrationAvg: 0.2 });
            continue;
        }

        // Calculate segment length
        let segLengthM = 0;
        for (let j = 0; j < coords.length - 1; j++) {
            segLengthM += haversineDistance(coords[j][0], coords[j][1], coords[j + 1][0], coords[j + 1][1]);
        }
        totalLengthM += segLengthM;

        // Get bounding box of this segment
        const lats = coords.map(c => c[0]);
        const lngs = coords.map(c => c[1]);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);

        // Expand bounding box by corridor buffer
        const latBuffer = CORRIDOR_BUFFER_M / 111320;
        const lngBuffer = CORRIDOR_BUFFER_M / (111320 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));

        // Query telemetry within this segment's corridor
        const telemetryData = db.prepare(`
            SELECT AVG(iri_estimate) as avg_iri, 
                   AVG(vibration_mag) as avg_vib,
                   COUNT(*) as reading_count,
                   SUM(pothole_trigger) as trigger_count
            FROM telemetry
            WHERE lat BETWEEN @minLat AND @maxLat
              AND lng BETWEEN @minLng AND @maxLng
        `).get({
            minLat: minLat - latBuffer,
            maxLat: maxLat + latBuffer,
            minLng: minLng - lngBuffer,
            maxLng: maxLng + lngBuffer
        });

        // Query potholes within this segment's corridor
        const potholeData = db.prepare(`
            SELECT COUNT(*) as pothole_count,
                   MAX(iri) as max_iri,
                   SUM(cluster_size) as total_detections
            FROM potholes
            WHERE lat BETWEEN @minLat AND @maxLat
              AND lng BETWEEN @minLng AND @maxLng
              AND false_positive = 0
        `).get({
            minLat: minLat - latBuffer,
            maxLat: maxLat + latBuffer,
            minLng: minLng - lngBuffer,
            maxLng: maxLng + lngBuffer
        });

        // Determine health from real stored data
        const avgIri = telemetryData ? (telemetryData.avg_iri || 0) : 0;
        const avgVib = telemetryData ? (telemetryData.avg_vib || 0) : 0;
        const potholeCount = potholeData ? (potholeData.pothole_count || 0) : 0;
        const segLengthKm = segLengthM / 1000;
        const potholeDensity = segLengthKm > 0 ? potholeCount / segLengthKm : 0;

        let health = 'good';
        let finalIri = avgIri;

        if (telemetryData && telemetryData.reading_count > 0) {
            // Real telemetry data exists for this segment
            if (avgIri >= 4.5 || potholeDensity >= 1.5) {
                health = 'bad';
            } else if (avgIri >= 2.5 || potholeDensity >= 0.5) {
                health = 'moderate';
            }
        } else if (potholeCount > 0) {
            // Potholes logged, no raw telemetry
            health = potholeCount >= 3 ? 'bad' : 'moderate';
            finalIri = potholeData.max_iri || 3.0;
        } else {
            // Unscanned segment — baseline nominal (1.0 m/km, 0 potholes)
            finalIri = 1.0;
            health = 'good';
        }

        // Accumulate for ratio calculation
        if (health === 'good') greenLengthM += segLengthM;
        else if (health === 'moderate') yellowLengthM += segLengthM;
        else redLengthM += segLengthM;

        totalPotholes += potholeCount;
        weightedIriSum += finalIri * segLengthM;
        weightedVibSum += avgVib * segLengthM;

        analyzedSegments.push({
            ...seg,
            health,
            iri: +finalIri.toFixed(2),
            potholeCount,
            vibrationAvg: +avgVib.toFixed(2),
            lengthM: Math.round(segLengthM),
            lengthKm: +(segLengthM / 1000).toFixed(2),
            readingCount: telemetryData ? telemetryData.reading_count : 0,
            color: health === 'good' ? '#10B981' : (health === 'moderate' ? '#F59E0B' : '#EF4444')
        });
    }

    // Calculate exact length-weighted ratios
    const validTotal = totalLengthM > 0 ? totalLengthM : 1;
    let greenRatio = Math.round((greenLengthM / validTotal) * 100);
    let yellowRatio = Math.round((yellowLengthM / validTotal) * 100);
    let redRatio = Math.round((redLengthM / validTotal) * 100);

    // Normalize to 100%
    const sum = greenRatio + yellowRatio + redRatio;
    if (sum !== 100 && sum > 0) {
        const diff = 100 - sum;
        if (greenRatio >= yellowRatio && greenRatio >= redRatio) greenRatio += diff;
        else if (yellowRatio >= redRatio) yellowRatio += diff;
        else redRatio += diff;
    }

    // Composite Road Health Score
    const avgIriOverall = weightedIriSum / validTotal;
    const avgVibOverall = weightedVibSum / validTotal;
    const iriPenalty = Math.min(45, (avgIriOverall / 7.0) * 45);
    const potholePenalty = Math.min(35, ((totalPotholes / (validTotal / 1000)) / 2.0) * 35);
    const vibPenalty = Math.min(20, (avgVibOverall / 5.0) * 20);
    const compositeScore = Math.max(10, Math.min(99, Math.round(100 - (iriPenalty + potholePenalty + vibPenalty))));

    return {
        compositeScore,
        totalPotholes,
        avgIri: +avgIriOverall.toFixed(2),
        avgVibration: +avgVibOverall.toFixed(2),
        totalDistanceKm: +(totalLengthM / 1000).toFixed(1),
        ratios: { green: greenRatio, yellow: yellowRatio, red: redRatio },
        lengths: {
            goodKm: +(greenLengthM / 1000).toFixed(1),
            moderateKm: +(yellowLengthM / 1000).toFixed(1),
            badKm: +(redLengthM / 1000).toFixed(1)
        },
        segments: analyzedSegments
    };
}

/**
 * Get summary statistics for the telemetry database
 */
function getDatabaseStats() {
    const db = getDb();

    const stats = {
        totalTelemetryRecords: db.prepare('SELECT COUNT(*) as cnt FROM telemetry').get().cnt,
        totalPotholes: db.prepare('SELECT COUNT(*) as cnt FROM potholes WHERE false_positive = 0').get().cnt,
        criticalPotholes: db.prepare("SELECT COUNT(*) as cnt FROM potholes WHERE severity = 'critical' AND false_positive = 0").get().cnt,
        activeDevices: db.prepare("SELECT COUNT(*) as cnt FROM devices WHERE status = 'Active'").get().cnt,
        totalDevices: db.prepare('SELECT COUNT(*) as cnt FROM devices').get().cnt,
        latestTelemetry: db.prepare('SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1').get()?.timestamp || 'None'
    };

    return stats;
}

module.exports = { analyzeRouteHealth, getDatabaseStats };
