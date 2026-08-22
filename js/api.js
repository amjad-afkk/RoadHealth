class RoadHealthAPI {
    constructor() {
        this.config = {
            baseUrl: (typeof window !== 'undefined' && window.location && window.location.origin && window.location.protocol !== 'file:')
                ? `${window.location.origin}/api/v1`
                : 'http://localhost:8000/api/v1',
            timeoutMs: 10000
        };
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
        const norm = cleanQuery.toLowerCase();

        const KNOWN_LANDMARKS = [
            { keys: ['rgia', 'airport', 'rajiv gandhi', 'shamshabad airport', 'international airport'], name: 'Rajiv Gandhi International Airport (RGIA)', shortName: 'RGIA Airport', lat: 17.2403, lng: 78.4294 },
            { keys: ['hitec', 'hitec city', 'cyber towers', 'cyber gateway', 'mindspace'], name: 'HITEC City, Cyber Towers, Madhapur', shortName: 'HITEC City', lat: 17.4486, lng: 78.3807 },
            { keys: ['gachibowli', 'dlf', 'dlf cyber city', 'iiit', 'gachibowli stadium'], name: 'Gachibowli Junction & Financial District Road', shortName: 'Gachibowli', lat: 17.4401, lng: 78.3489 },
            { keys: ['madhapur', 'inorbit', 'durgam cheruvu metro'], name: 'Madhapur Main Road & Metro Station', shortName: 'Madhapur', lat: 17.4408, lng: 78.3916 },
            { keys: ['jubilee hills', 'road no 36', 'road no 45', 'checkpost'], name: 'Jubilee Hills Check Post, Road No 36', shortName: 'Jubilee Hills', lat: 17.4319, lng: 78.4073 },
            { keys: ['banjara hills', 'road no 1', 'road no 12', 'gvk one', 'care hospital'], name: 'Banjara Hills, Road No 12, Hyderabad', shortName: 'Banjara Hills', lat: 17.4156, lng: 78.4357 },
            { keys: ['secunderabad', 'secunderabad station', 'railway station'], name: 'Secunderabad Junction Railway Station', shortName: 'Secunderabad Station', lat: 17.4344, lng: 78.5017 },
            { keys: ['tank bund', 'hussain sagar', 'necklace road', 'secretariat', 'buddha statue'], name: 'Tank Bund Road & Hussain Sagar, Hyderabad', shortName: 'Tank Bund', lat: 17.4239, lng: 78.4738 },
            { keys: ['charminar', 'old city', 'laad bazaar', 'makkah masjid'], name: 'Charminar Historical Landmark, Old City', shortName: 'Charminar', lat: 17.3616, lng: 78.4747 },
            { keys: ['kukatpally', 'kphb', 'jntu', 'forum mall', 'nexus mall'], name: 'Kukatpally Housing Board (KPHB Colony)', shortName: 'Kukatpally KPHB', lat: 17.4849, lng: 78.4138 },
            { keys: ['miyapur', 'miyapur metro', 'allwyn'], name: 'Miyapur Metro Terminal, NH 65', shortName: 'Miyapur', lat: 17.4968, lng: 78.3614 },
            { keys: ['kondapur', 'botanical garden', 'kothaguda'], name: 'Kondapur, Botanical Garden Road', shortName: 'Kondapur', lat: 17.4699, lng: 78.3578 },
            { keys: ['financial district', 'nanakramguda', 'wipro circle', 'wave rock'], name: 'Financial District, Nanakramguda, Gachibowli', shortName: 'Financial District', lat: 17.4156, lng: 78.3428 },
            { keys: ['begumpet', 'begumpet airport', 'lifestyle', 'prakash nagar'], name: 'Begumpet Airport & Main Arterial Road', shortName: 'Begumpet', lat: 17.4531, lng: 78.4676 },
            { keys: ['ameerpet', 'ameerpet metro', 'sr nagar'], name: 'Ameerpet Metro Interchange, Hyderabad', shortName: 'Ameerpet', lat: 17.4375, lng: 78.4482 },
            { keys: ['mehdipatnam', 'pvnr expressway', 'gudimalkapur'], name: 'Mehdipatnam & PVNR Elevated Expressway Start', shortName: 'Mehdipatnam', lat: 17.3916, lng: 78.4417 },
            { keys: ['lb nagar', 'kothapet', 'nagole'], name: 'LB Nagar Ring Road Junction, Hyderabad', shortName: 'LB Nagar', lat: 17.3503, lng: 78.5524 },
            { keys: ['uppal', 'uppal stadium', 'habsiguda'], name: 'Uppal Ring Road & Rajiv Gandhi Cricket Stadium', shortName: 'Uppal', lat: 17.4056, lng: 78.5591 },
            { keys: ['kompally', 'medchal highway', 'suchitra'], name: 'Kompally, NH 44 Medchal Highway', shortName: 'Kompally', lat: 17.5348, lng: 78.4877 },
            { keys: ['warangal', 'kazipet', 'hanamkonda'], name: 'Warangal Tri-Cities Main Corridor', shortName: 'Warangal', lat: 17.9689, lng: 79.5941 }
        ];

        const localMatches = KNOWN_LANDMARKS
            .filter(lm => lm.keys.some(k => norm.includes(k) || k.includes(norm)))
            .map(lm => ({
                displayName: lm.name,
                shortName: lm.shortName,
                lat: lm.lat,
                lng: lm.lng,
                type: 'landmark'
            }));

        let onlineResults = [];
        try {
            const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleanQuery)}&lat=17.4435&lon=78.3772&limit=8&lang=en`;
            const res = await fetch(photonUrl, { signal: AbortSignal.timeout(3500) });
            if (res.ok) {
                const data = await res.json();
                if (data && data.features && data.features.length > 0) {
                    onlineResults = data.features.map(f => {
                        const props = f.properties || {};
                        const coords = f.geometry?.coordinates || [78.3772, 17.4435];
                        const rawParts = [
                            props.name,
                            props.street,
                            props.district || props.suburb || props.county,
                            props.city || props.town || props.village,
                            props.state,
                            props.country
                        ].filter(Boolean);

                        const uniqueParts = [...new Set(rawParts)];
                        return {
                            displayName: uniqueParts.join(', '),
                            shortName: props.name || uniqueParts[0] || cleanQuery,
                            lat: coords[1],
                            lng: coords[0],
                            type: props.type || 'place'
                        };
                    });
                }
            }
        } catch (e) {}

        const combined = [...localMatches, ...onlineResults];
        const unique = [];
        const seen = new Set();

        for (const item of combined) {
            const key = `${item.lat.toFixed(3)},${item.lng.toFixed(3)}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(item);
            }
        }

        return unique.slice(0, 6);
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
