/**
 * RoadHealth - Health & Intelligence Analytics Engine
 * Provides GIS mathematical calculations, composite Road Health Index (RHI),
 * segment ratio weighting, ETA penalty adjustments, and anomaly classification.
 */

class RoadHealthEngine {
    constructor() {
        // Calibration weights (can be tuned via Admin Dashboard)
        this.weights = {
            iri: 0.45,           // Weight of International Roughness Index
            potholeDensity: 0.35,// Weight of pothole frequency per km
            vibration: 0.20      // Weight of IoT accelerometer variance
        };

        // Speed reduction factors based on road degradation
        this.speedModifiers = {
            good: 1.0,           // 100% nominal speed
            moderate: 0.85,      // 15% speed reduction
            bad: 0.60            // 40% speed reduction due to severe distress/potholes
        };
    }

    /**
     * Update engine calibration weights (from Admin Settings)
     */
    updateWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
    }

    /**
     * Compute distance between two lat/lng coordinates in meters (Haversine formula)
     */
    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Earth radius in meters
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                  Math.cos(φ1) * Math.cos(φ2) *
                  Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c;
    }

    /**
     * Calculate total length of a polyline coordinate array in meters
     */
    calculatePolylineLengthMeters(coords) {
        let total = 0;
        for (let i = 0; i < coords.length - 1; i++) {
            total += this.haversineDistance(
                coords[i][0], coords[i][1],
                coords[i+1][0], coords[i+1][1]
            );
        }
        return total;
    }

    /**
     * Calculate comprehensive analytics for a given route
     */
    analyzeRoute(route) {
        if (!route || !route.segments || route.segments.length === 0) {
            return null;
        }

        let totalLengthM = 0;
        let greenLengthM = 0;
        let yellowLengthM = 0;
        let redLengthM = 0;

        let totalPotholes = 0;
        let weightedIriSum = 0;
        let weightedVibrationSum = 0;
        let adjustedDurationSeconds = 0;

        const analyzedSegments = route.segments.map(seg => {
            const segLengthM = this.calculatePolylineLengthMeters(seg.coords);
            totalLengthM += segLengthM;

            const health = seg.health || 'good';
            if (health === 'good') greenLengthM += segLengthM;
            else if (health === 'moderate') yellowLengthM += segLengthM;
            else if (health === 'bad') redLengthM += segLengthM;

            const potholes = seg.potholeCount || 0;
            totalPotholes += potholes;

            const segIri = seg.iri || (health === 'good' ? 1.2 : health === 'moderate' ? 2.6 : 5.5);
            const segVib = seg.vibrationAvg || (health === 'good' ? 0.3 : health === 'moderate' ? 1.8 : 4.5);

            weightedIriSum += segIri * segLengthM;
            weightedVibrationSum += segVib * segLengthM;

            // Compute speed-adjusted travel time for this segment
            const nominalSpeedKmh = 60; // baseline nominal 60 km/h
            const speedMod = this.speedModifiers[health] || 1.0;
            const actualSpeedMs = (nominalSpeedKmh * speedMod) / 3.6;
            const segDurationSec = actualSpeedMs > 0 ? (segLengthM / actualSpeedMs) : 60;
            adjustedDurationSeconds += segDurationSec;

            return {
                ...seg,
                lengthM: Math.round(segLengthM),
                lengthKm: +(segLengthM / 1000).toFixed(2),
                health,
                iri: segIri,
                vibrationAvg: segVib,
                potholeCount: potholes,
                color: this.getHealthColor(health)
            };
        });

        // Calculate exact length-weighted ratios
        const validTotal = totalLengthM > 0 ? totalLengthM : 1;
        let greenRatio = Math.round((greenLengthM / validTotal) * 100);
        let yellowRatio = Math.round((yellowLengthM / validTotal) * 100);
        let redRatio = Math.round((redLengthM / validTotal) * 100);

        // Normalize sum to 100%
        const sum = greenRatio + yellowRatio + redRatio;
        if (sum !== 100 && sum > 0) {
            const diff = 100 - sum;
            if (greenRatio >= yellowRatio && greenRatio >= redRatio) greenRatio += diff;
            else if (yellowRatio >= redRatio) yellowRatio += diff;
            else redRatio += diff;
        }

        const avgIri = +(weightedIriSum / validTotal).toFixed(2);
        const avgVibration = +(weightedVibrationSum / validTotal).toFixed(2);

        // Calculate Composite Road Health Score (0 - 100, where 100 is pristine)
        // High IRI and high potholes penalize the score
        const iriPenalty = Math.min(45, (avgIri / 7.0) * 45);
        const potholeDensityPerKm = (totalPotholes / (validTotal / 1000));
        const potholePenalty = Math.min(35, (potholeDensityPerKm / 2.0) * 35);
        const vibrationPenalty = Math.min(20, (avgVibration / 5.0) * 20);

        const compositeScore = Math.max(10, Math.min(99, Math.round(100 - (iriPenalty + potholePenalty + vibrationPenalty))));

        // Format ETA
        const totalDurationMin = Math.max(1, Math.round(adjustedDurationSeconds / 60));
        const etaHours = Math.floor(totalDurationMin / 60);
        const etaMinutes = totalDurationMin % 60;
        const etaFormatted = etaHours > 0 
            ? `${etaHours} hr ${etaMinutes} min` 
            : `${etaMinutes} min`;

        return {
            routeId: route.id,
            name: route.name,
            summary: route.summary,
            totalDistanceKm: +(totalLengthM / 1000).toFixed(1),
            etaFormatted,
            durationMin: totalDurationMin,
            compositeScore,
            totalPotholes,
            avgIri,
            avgVibration,
            ratios: {
                green: greenRatio,
                yellow: yellowRatio,
                red: redRatio
            },
            lengths: {
                goodKm: +(greenLengthM / 1000).toFixed(1),
                moderateKm: +(yellowLengthM / 1000).toFixed(1),
                badKm: +(redLengthM / 1000).toFixed(1)
            },
            segments: analyzedSegments
        };
    }

    /**
     * Get hex color code for health status
     */
    getHealthColor(health) {
        switch (health) {
            case 'good':
                return '#10B981'; // Apple Emerald Green
            case 'moderate':
                return '#F59E0B'; // Apple Warm Amber
            case 'bad':
                return '#EF4444'; // Apple Crimson Red
            default:
                return '#3B82F6'; // Fallback Apple Blue
        }
    }

    /**
     * Health label and badge representation
     */
    getHealthBadge(health) {
        switch (health) {
            case 'good':
                return { label: 'Good Condition', class: 'badge-good', icon: 'check-circle' };
            case 'moderate':
                return { label: 'Moderate Wear', class: 'badge-moderate', icon: 'alert-triangle' };
            case 'bad':
                return { label: 'Critical Distress', class: 'badge-bad', icon: 'alert-octagon' };
            default:
                return { label: 'Standard', class: 'badge-default', icon: 'info' };
        }
    }
}

// Global singleton instance
window.roadHealthEngine = new RoadHealthEngine();
