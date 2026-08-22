const { isPostGIS, getPool, getDb } = require('../db/database');
const { haversineDistance } = require('./detectionEngine');
const { runDecaySweep } = require('./decayEngine');

const CORRIDOR_BUFFER_M = 12;

async function analyzeRouteHealth(segments) {
    try {
        await runDecaySweep();
    } catch (e) {}

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

        let segLengthM = 0;
        for (let j = 0; j < coords.length - 1; j++) {
            segLengthM += haversineDistance(coords[j][0], coords[j][1], coords[j + 1][0], coords[j + 1][1]);
        }
        totalLengthM += segLengthM;

        const lats = coords.map(c => c[0]);
        const lngs = coords.map(c => c[1]);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);

        const latBuffer = CORRIDOR_BUFFER_M / 111320;
        const lngBuffer = CORRIDOR_BUFFER_M / (111320 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180));

        let telemetryData = null;
        let potholeData = null;

        if (isPostGIS()) {
            const pool = getPool();
            const geojsonLine = JSON.stringify({
                type: 'LineString',
                coordinates: coords.map(c => [c[1], c[0]])
            });

            const tRes = await pool.query(`
                SELECT AVG(iri_estimate) as avg_iri, 
                       AVG(vibration_mag) as avg_vib,
                       COUNT(*) as reading_count,
                       SUM(pothole_trigger) as trigger_count
                FROM telemetry
                WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
            `, [geojsonLine, CORRIDOR_BUFFER_M]);
            telemetryData = tRes.rows[0];

            const pRes = await pool.query(`
                SELECT COUNT(*) as pothole_count,
                       MAX(iri) as max_iri,
                       SUM(cluster_size) as total_detections
                FROM potholes
                WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)
                  AND false_positive = 0
                  AND status != 'repaired'
                  AND status != 'decayed_expired'
            `, [geojsonLine, CORRIDOR_BUFFER_M]);
            potholeData = pRes.rows[0];
        } else {
            const db = getDb();
            telemetryData = db.prepare(`
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

            potholeData = db.prepare(`
                SELECT COUNT(*) as pothole_count,
                       MAX(iri) as max_iri,
                       SUM(cluster_size) as total_detections
                FROM potholes
                WHERE lat BETWEEN @minLat AND @maxLat
                  AND lng BETWEEN @minLng AND @maxLng
                  AND false_positive = 0
                  AND status != 'repaired'
                  AND status != 'decayed_expired'
            `).get({
                minLat: minLat - latBuffer,
                maxLat: maxLat + latBuffer,
                minLng: minLng - lngBuffer,
                maxLng: maxLng + lngBuffer
            });
        }

        const avgIri = telemetryData ? (parseFloat(telemetryData.avg_iri) || 0) : 0;
        const avgVib = telemetryData ? (parseFloat(telemetryData.avg_vib) || 0) : 0;
        const potholeCount = potholeData ? (parseInt(potholeData.pothole_count) || 0) : 0;
        const readingCount = telemetryData ? (parseInt(telemetryData.reading_count) || 0) : 0;
        const segLengthKm = segLengthM / 1000;
        const potholeDensity = segLengthKm > 0 ? potholeCount / segLengthKm : 0;

        let health = 'good';
        let finalIri = 1.1;

        if (potholeCount > 0) {
            if (potholeCount >= 3 || potholeDensity >= 1.5) {
                health = 'bad';
            } else {
                health = 'moderate';
            }
            finalIri = parseFloat(potholeData.max_iri) || 3.0;
        } else if (readingCount >= 5 && avgIri >= 4.5) {
            health = 'moderate';
            finalIri = avgIri;
        } else {
            health = 'good';
            finalIri = 1.1;
        }

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
            readingCount,
            color: health === 'good' ? '#10B981' : (health === 'moderate' ? '#F59E0B' : '#EF4444')
        });
    }

    const validTotal = totalLengthM > 0 ? totalLengthM : 1;
    let greenRatio = Math.round((greenLengthM / validTotal) * 100);
    let yellowRatio = Math.round((yellowLengthM / validTotal) * 100);
    let redRatio = Math.round((redLengthM / validTotal) * 100);

    const sum = greenRatio + yellowRatio + redRatio;
    if (sum !== 100 && sum > 0) {
        const diff = 100 - sum;
        if (greenRatio >= yellowRatio && greenRatio >= redRatio) greenRatio += diff;
        else if (yellowRatio >= redRatio) yellowRatio += diff;
        else redRatio += diff;
    }

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

async function getDatabaseStats() {
    if (isPostGIS()) {
        const pool = getPool();
        const tCount = await pool.query('SELECT COUNT(*) as cnt FROM telemetry');
        const pCount = await pool.query('SELECT COUNT(*) as cnt FROM potholes WHERE false_positive = 0');
        const critCount = await pool.query("SELECT COUNT(*) as cnt FROM potholes WHERE severity = 'critical' AND false_positive = 0");
        const actDev = await pool.query("SELECT COUNT(*) as cnt FROM devices WHERE status = 'Active'");
        const totDev = await pool.query('SELECT COUNT(*) as cnt FROM devices');
        const latestT = await pool.query('SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1');

        return {
            totalTelemetryRecords: parseInt(tCount.rows[0]?.cnt || 0),
            totalPotholes: parseInt(pCount.rows[0]?.cnt || 0),
            criticalPotholes: parseInt(critCount.rows[0]?.cnt || 0),
            activeDevices: parseInt(actDev.rows[0]?.cnt || 0),
            totalDevices: parseInt(totDev.rows[0]?.cnt || 0),
            latestTelemetry: latestT.rows[0]?.timestamp || 'None'
        };
    } else {
        const db = getDb();
        return {
            totalTelemetryRecords: db.prepare('SELECT COUNT(*) as cnt FROM telemetry').get().cnt,
            totalPotholes: db.prepare('SELECT COUNT(*) as cnt FROM potholes WHERE false_positive = 0').get().cnt,
            criticalPotholes: db.prepare("SELECT COUNT(*) as cnt FROM potholes WHERE severity = 'critical' AND false_positive = 0").get().cnt,
            activeDevices: db.prepare("SELECT COUNT(*) as cnt FROM devices WHERE status = 'Active'").get().cnt,
            totalDevices: db.prepare('SELECT COUNT(*) as cnt FROM devices').get().cnt,
            latestTelemetry: db.prepare('SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1').get()?.timestamp || 'None'
        };
    }
}

module.exports = { analyzeRouteHealth, getDatabaseStats };
