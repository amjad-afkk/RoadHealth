class RoadHealthAPI {
    constructor() {
        this.config = {
            baseUrl: window.location.origin ? `${window.location.origin}/api/v1` : 'http://localhost:8000/api/v1',
            timeoutMs: 10000
        };

        if (window.location.protocol === 'file:') {
            this.config.baseUrl = 'http://localhost:8000/api/v1';
        }
    }

    configure(newConfig) {
        this.config = { ...this.config, ...newConfig };
        console.log(`[RoadHealth API] Base URL: ${this.config.baseUrl}`);
    }

    async _backendFetch(path, options = {}) {
        try {
            const url = `${this.config.baseUrl}${path}`;
            const res = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                },
                signal: AbortSignal.timeout(this.config.timeoutMs)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.warn(`[RoadHealth API] Backend fetch failed (${path}):`, err.message);
            return null;
        }
    }

    async geocodeAddress(query) {
        if (!query || query.trim().length < 2) return [];

        const cleanQuery = query.trim();

        try {
            const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery)}&lat=17.4435&lon=78.3772&limit=6&lang=en`;
            const res = await fetch(photonUrl, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const data = await res.json();
                if (data && data.features && data.features.length > 0) {
                    return data.features.map(f => {
                        const props = f.properties || {};
                        const coords = f.geometry?.coordinates || [78.3772, 17.4435];
                        const nameParts = [props.name, props.district, props.city, props.state].filter(Boolean);
                        return {
                            displayName: nameParts.join(', '),
                            shortName: props.name || nameParts[0] || cleanQuery,
                            lat: coords[1],
                            lng: coords[0],
                            type: props.type || 'place'
                        };
                    });
                }
            }
        } catch (photonErr) {
            console.warn('[RoadHealth API] Photon search timeout, falling back to Nominatim:', photonErr.message);
        }

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&countrycodes=in&limit=6&addressdetails=1`;
            const res = await fetch(url, { headers: { 'Accept-Language': 'en' }, signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                if (data && data.length > 0) {
                    return data.map(item => ({
                        displayName: item.display_name,
                        shortName: item.name || item.display_name.split(',')[0],
                        lat: parseFloat(item.lat),
                        lng: parseFloat(item.lon),
                        type: item.type
                    }));
                }
            }
        } catch (err) {
            console.error('[RoadHealth API] Geocoding error:', err.message);
        }

        return [];
    }

    async calculateMultipleRoutesBetween(origin, dest, originName = 'Origin', destName = 'Destination') {
        const routesList = [];

        try {
            const directUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&alternatives=true&steps=true`;
            const directRes = await fetch(directUrl, { signal: AbortSignal.timeout(8000) });
            
            if (directRes.ok) {
                const directData = await directRes.json();
                if (directData.routes && directData.routes.length > 0) {
                    directData.routes.forEach((osrmRoute, rIdx) => {
                        const parsed = this._parseOSRMRouteToHealthSegments(
                            osrmRoute, 
                            originName, 
                            destName, 
                            'good', 
                            rIdx === 0 ? 'via Primary Highway' : `via Alternative Arterial ${rIdx}`
                        );
                        parsed.isPrimary = (rIdx === 0);
                        routesList.push(parsed);
                    });
                }
            }

            if (routesList.length < 2) {
                const midLat = (origin.lat + dest.lat) / 2;
                const midLng = (origin.lng + dest.lng) / 2;
                const dLat = dest.lat - origin.lat;
                const dLng = dest.lng - origin.lng;

                const offset1 = { lat: midLat + (-dLng * 0.25), lng: midLng + (dLat * 0.25) };

                try {
                    const altUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${offset1.lng},${offset1.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
                    const altRes = await fetch(altUrl, { signal: AbortSignal.timeout(6000) });
                    if (altRes.ok) {
                        const altData = await altRes.json();
                        if (altData.routes && altData.routes[0]) {
                            const parsed = this._parseOSRMRouteToHealthSegments(altData.routes[0], originName, destName, 'good', 'via Ring Road Bypass');
                            parsed.isPrimary = false;
                            routesList.push(parsed);
                        }
                    }
                } catch (e) { }
            }

            return routesList;
        } catch (err) {
            console.error('[RoadHealth API] Route calculation failed:', err);
            return [];
        }
    }

    _parseOSRMRouteToHealthSegments(osrmRoute, originName, destName, baselineHealth = 'good', nameHint = '') {
        const fullCoords = (osrmRoute.geometry && osrmRoute.geometry.coordinates)
            ? osrmRoute.geometry.coordinates.map(c => [c[1], c[0]])
            : [];

        const distanceKm = +(osrmRoute.distance / 1000).toFixed(1);
        const durationMin = Math.round(osrmRoute.duration / 60);

        const segments = [];
        const stepSize = Math.max(4, Math.floor(fullCoords.length / 16));

        for (let i = 0; i < fullCoords.length; i += stepSize) {
            const chunk = fullCoords.slice(i, i + stepSize + 1);
            if (chunk.length >= 2) {
                segments.push({
                    roadName: `${nameHint} • Section ${Math.floor(i / stepSize) + 1}`,
                    coords: chunk,
                    health: 'good',
                    iri: 1.1,
                    potholeCount: 0,
                    vibrationAvg: 0.3
                });
            }
        }

        return {
            id: `route-${Math.random().toString(36).substr(2, 6)}`,
            name: `${originName.split(',')[0]} → ${destName.split(',')[0]} (${nameHint})`,
            baseDistanceKm: distanceKm,
            totalDistanceKm: distanceKm,
            baseDurationMin: durationMin,
            etaFormatted: `${durationMin} min`,
            compositeScore: 95,
            ratios: { green: 100, yellow: 0, red: 0 },
            lengths: { goodKm: distanceKm, moderateKm: 0, badKm: 0 },
            totalPotholes: 0,
            origin: { name: originName, lat: fullCoords[0]?.[0] || 17.4435, lng: fullCoords[0]?.[1] || 78.3772 },
            destination: { name: destName, lat: fullCoords[fullCoords.length - 1]?.[0] || 17.2403, lng: fullCoords[fullCoords.length - 1]?.[1] || 78.4294 },
            segments: segments.length > 0 ? segments : [{
                roadName: nameHint || 'Direct Corridor',
                coords: fullCoords,
                health: baselineHealth,
                iri: 1.2,
                potholeCount: 0,
                vibrationAvg: 0.3
            }]
        };
    }

    async getPotholeTelemetry() {
        const res = await this._backendFetch('/potholes?limit=500');
        return res?.potholes || [];
    }

    async getHeatmapPoints() {
        const res = await this._backendFetch('/potholes/heatmap');
        return res?.points || [];
    }

    async updatePotholeStatus(id, status, contractor = null) {
        return await this._backendFetch(`/potholes/${id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status, contractor })
        });
    }

    async flagFalsePositive(id) {
        return await this._backendFetch(`/potholes/${id}`, {
            method: 'DELETE'
        });
    }

    async simulatePatrolBike(routeCoords = null) {
        return await this._backendFetch('/telemetry/simulate', {
            method: 'POST',
            body: JSON.stringify({ routeCoords })
        });
    }

    async getESP32Fleet() {
        const res = await this._backendFetch('/devices');
        return res?.devices || [];
    }

    async clearPotholes() {
        return await this._backendFetch('/potholes/clear', { method: 'POST' });
    }

    async syncPostGIS() {
        const res = await this._backendFetch('/routes/stats');
        return {
            spatialIndexStatus: res?.engine || 'PostGIS Spatial Engine',
            postgisVersion: res?.engine || 'PostGIS 3.3',
            recordsSynced: res?.stats?.totalTelemetryRecords || 0,
            potholesCount: res?.stats?.totalPotholes || 0,
            activeNodes: res?.stats?.activeDevices || 0
        };
    }
}

window.roadHealthAPI = new RoadHealthAPI();
