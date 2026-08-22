const { isPostGIS, getPool, getDb } = require('../db/database');
const { broadcast } = require('../ws/realtimeHub');

const DECAY_CONFIG = {
    DEFAULT_HALF_LIFE_DAYS: 14.0,
    EXPIRATION_CONFIDENCE_THRESHOLD: 0.30,
    HIGH_CONFIDENCE_THRESHOLD: 0.70
};

function calculateDecayedConfidence(pothole) {
    const clusterSize = parseInt(pothole.cluster_size || 1);
    const initialConfidence = Math.min(1.0, 0.5 + 0.15 * clusterSize);
    const halfLifeDays = parseFloat(pothole.half_life_days || DECAY_CONFIG.DEFAULT_HALF_LIFE_DAYS);

    const lastHitTime = new Date(pothole.last_hit_at || pothole.detected_at || Date.now()).getTime();
    const elapsedDays = Math.max(0, (Date.now() - lastHitTime) / (1000 * 60 * 60 * 24));

    const decayConstant = Math.log(2) / halfLifeDays;
    const currentConfidence = initialConfidence * Math.exp(-decayConstant * elapsedDays);

    return {
        initialConfidence: +initialConfidence.toFixed(3),
        currentConfidence: +Math.max(0, Math.min(1.0, currentConfidence)).toFixed(3),
        elapsedDays: +elapsedDays.toFixed(1),
        halfLifeDays,
        isExpired: currentConfidence < DECAY_CONFIG.EXPIRATION_CONFIDENCE_THRESHOLD
    };
}

async function runDecaySweep() {
    let updatedCount = 0;
    let expiredCount = 0;

    if (isPostGIS()) {
        const pool = getPool();
        const res = await pool.query(`
            SELECT id, cluster_size, detected_at, last_hit_at, half_life_days, status
            FROM potholes
            WHERE false_positive = 0 AND status != 'repaired' AND status != 'decayed_expired'
        `);

        for (const row of res.rows) {
            const decay = calculateDecayedConfidence(row);
            if (decay.isExpired) {
                await pool.query(`
                    UPDATE potholes
                    SET status = 'decayed_expired',
                        confidence = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [decay.currentConfidence, row.id]);
                expiredCount++;
            } else {
                await pool.query(`
                    UPDATE potholes
                    SET confidence = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [decay.currentConfidence, row.id]);
                updatedCount++;
            }
        }
    } else {
        const db = getDb();
        const rows = db.prepare(`
            SELECT id, cluster_size, detected_at, last_hit_at, half_life_days, status
            FROM potholes
            WHERE false_positive = 0 AND status != 'repaired' AND status != 'decayed_expired'
        `).all();

        for (const row of rows) {
            const decay = calculateDecayedConfidence(row);
            if (decay.isExpired) {
                db.prepare(`
                    UPDATE potholes
                    SET status = 'decayed_expired',
                        confidence = @confidence,
                        updated_at = datetime('now')
                    WHERE id = @id
                `).run({ confidence: decay.currentConfidence, id: row.id });
                expiredCount++;
            } else {
                db.prepare(`
                    UPDATE potholes
                    SET confidence = @confidence,
                        updated_at = datetime('now')
                    WHERE id = @id
                `).run({ confidence: decay.currentConfidence, id: row.id });
                updatedCount++;
            }
        }
    }

    if (expiredCount > 0) {
        broadcast('pothole:repaired', {
            event: 'temporal_decay_sweep',
            expiredCount
        });
    }

    return {
        success: true,
        swept: updatedCount + expiredCount,
        activeUpdated: updatedCount,
        autoExpired: expiredCount,
        timestamp: new Date().toISOString()
    };
}

module.exports = {
    DECAY_CONFIG,
    calculateDecayedConfidence,
    runDecaySweep
};
