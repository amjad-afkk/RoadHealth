

class RoadHealthAPI {
    constructor() {
        this.config = {
            mode: 'nodejs',
            baseUrl: 'https://roadhealth.onrender.com/api/v1',
            timeoutMs: 8000
        };
    }

    configure(newConfig) {
        this.config = { ...this.config, ...newConfig };
        console.log(`[RoadHealth API] Mode: ${this.config.mode.toUpperCase()} (Base: ${this.config.baseUrl})`);
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

        try {
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=in&limit=6&addressdetails=1`;
            const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
            if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
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

            const broadUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`;
            const broadRes = await fetch(broadUrl);
            const broadData = await broadRes.json();
            return broadData.map(item => ({
                displayName: item.display_name,
                shortName: item.name || item.display_name.split(',')[0],
                lat: parseFloat(item.lat),
                lng: parseFloat(item.lon),
                type: item.type
            }));
        } catch (err) {
            console.error('[RoadHealth API] Geocoding error:', err.message);
            return [];
        }
    }

    
    async calculateMultipleRoutesBetween(origin, dest, originName = 'Origin', destName = 'Destination') {
        const routesList = [];

        try {
            const directUrl = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&alternatives=true&steps=true`;
            const directRes = await fetch(directUrl);
            if (directRes.ok) {
                const directData = await directRes.json();
                if (directData.routes && directData.routes.length > 0) {
                    directData.routes.forEach((osrmRoute, rIdx) => {
                        const parsed = this._parseOSRMRouteToHealthSegments(osrmRoute, originName, destName, rIdx === 0 ? 'good' : 'moderate', rIdx === 0 ? 'via Primary Highway' : 'via City Arterial');
                        parsed.isPrimary = (rIdx === 0);
                        routesList.push(parsed);
                    });
                }
            }

            if (routesList.length < 3) {
                const midLat = (origin.lat + dest.lat) / 2;
                const midLng = (origin.lng + dest.lng) / 2;
                const dLat = dest.lat - origin.lat;
                const dLng = dest.lng - origin.lng;

                const offset1 = { lat: midLat + (-dLng * 0.28), lng: midLng + (dLat * 0.28) };
                const offset2 = { lat: midLat + (dLng * 0.25), lng: midLng + (-dLat * 0.25) };

                const [snap1, snap2] = await Promise.all([
                    this._snapToNearestRoad(offset1.lat, offset1.lng),
                    this._snapToNearestRoad(offset2.lat, offset2.lng)
                ]);

                if (snap1 && routesList.length < 2) {
                    const viaUrl1 = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${snap1.lng},${snap1.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`;
                    const viaRes1 = await fetch(viaUrl1);
                    if (viaRes1.ok) {
                        const viaData1 = await viaRes1.json();
                        if (viaData1.routes && viaData1.routes.length > 0) {
                            const parsed1 = this._parseOSRMRouteToHealthSegments(viaData1.routes[0], originName, destName, 'moderate', 'via Secondary Arterial Corridor');
                            parsed1.isPrimary = false;
                            routesList.push(parsed1);
                        }
                    }
                }

                if (snap2 && routesList.length < 3) {
                    const viaUrl2 = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${snap2.lng},${snap2.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true`;
                    const viaRes2 = await fetch(viaUrl2);
                    if (viaRes2.ok) {
                        const viaData2 = await viaRes2.json();
                        if (viaData2.routes && viaData2.routes.length > 0) {
                            const parsed2 = this._parseOSRMRouteToHealthSegments(viaData2.routes[0], originName, destName, 'moderate', 'via Urban Bypass Corridor');
                            parsed2.isPrimary = false;
                            routesList.push(parsed2);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[RoadHealth API] OSRM routing fetch error:', err.message);
        }

        return routesList;
    }

    
    async _snapToNearestRoad(lat, lng) {
        try {
            const url = `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.waypoints && data.waypoints.length > 0) {
                return {
                    lat: data.waypoints[0].location[1],
                    lng: data.waypoints[0].location[0],
                    name: data.waypoints[0].name
                };
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    
    _parseOSRMRouteToHealthSegments(osrmRoute, originName, destName, defaultHealth = 'good', nameSuffix = 'via Highway') {
        const coords = osrmRoute.geometry.coordinates.map(c => [c[1], c[0]]);
        const distanceKm = +(osrmRoute.distance / 1000).toFixed(1);
        const durationMin = Math.max(1, Math.round(osrmRoute.duration / 60));

        const streetNames = [];
        if (osrmRoute.legs) {
            osrmRoute.legs.forEach(leg => {
                if (leg.steps) {
                    leg.steps.forEach(st => {
                        if (st.name && st.name.trim().length > 0 && !streetNames.includes(st.name)) {
                            streetNames.push(st.name);
                        }
                    });
                }
            });
        }

        const numSegments = Math.min(5, Math.max(3, Math.floor(coords.length / 12) || 3));
        const chunkSize = Math.ceil(coords.length / numSegments);
        const segments = [];

        for (let i = 0; i < numSegments; i++) {
            const startIdx = i * chunkSize;
            const endIdx = Math.min(coords.length, (i + 1) * chunkSize + 1);
            const segCoords = coords.slice(startIdx, endIdx);

            if (segCoords.length >= 2) {
                let roadLabel = streetNames[i] || `${originName} to ${destName} Section ${i + 1}`;
                if (i === 0 && streetNames.length > 0) roadLabel = `${streetNames[0]} (Origin Sector)`;
                else if (i === numSegments - 1 && streetNames.length > 1) roadLabel = `${streetNames[streetNames.length - 1]} (Approach)`;

                segments.push({
                    id: `seg-${i + 1}-${Math.random().toString(36).substr(2, 4)}`,
                    roadName: roadLabel,
                    health: 'good',
                    iri: 1.0,
                    potholeCount: 0,
                    vibrationAvg: 0.2,
                    coords: segCoords
                });
            }
        }

        const summaryText = streetNames.length > 0 ? streetNames.slice(0, 3).join(', ') : `${distanceKm} km Real Road Network`;

        return {
            id: `route-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            name: `${originName} to ${destName} (${nameSuffix})`,
            summary: summaryText,
            distanceKm: distanceKm,
            baseDurationMin: durationMin,
            originName: originName,
            destName: destName,
            originCoords: coords[0],
            destCoords: coords[coords.length - 1],
            segments: segments
        };
    }

    
    async getESP32Fleet() {
        const data = await this._backendFetch('/devices');
        if (data && data.success) {
            return data.devices;
        }
        return [];
    }

    
    async registerDevice(deviceInfo) {
        return await this._backendFetch('/devices', {
            method: 'POST',
            body: JSON.stringify(deviceInfo)
        });
    }

    
    async getPotholeTelemetry() {
        const data = await this._backendFetch('/potholes');
        if (data && data.success) {
            return data.potholes;
        }
        return [];
    }

    
    async getLatestIoTPayload(deviceId) {
        if (!deviceId) return null;
        const data = await this._backendFetch(`/telemetry/latest/${deviceId}`);
        if (data && data.success && data.data) {
            return data.data;
        }
        return null;
    }

    
    async reportAnomaly(anomaly) {
        return await this._backendFetch('/potholes', {
            method: 'POST',
            body: JSON.stringify({
                lat: anomaly.lat,
                lng: anomaly.lng,
                severity: anomaly.severity || 'critical',
                iri: anomaly.iri || 4.5,
                depthCm: anomaly.depthCm || 5.0,
                sourceDevice: anomaly.sourceDevice || 'user-report'
            })
        });
    }

    
    async syncPostGIS() {
        const data = await this._backendFetch('/routes/stats');
        if (data && data.success) {
            return {
                syncedAt: data.syncedAt,
                postgisVersion: data.version,
                recordsSynced: data.stats.totalTelemetryRecords,
                spatialIndexStatus: `${data.stats.totalPotholes} Potholes | ${data.stats.activeDevices} Active Devices`,
                status: 'success'
            };
        }
        return {
            syncedAt: new Date().toISOString(),
            postgisVersion: 'RoadHealth DB (Offline)',
            recordsSynced: 0,
            spatialIndexStatus: 'Disconnected',
            status: 'error'
        };
    }
}

window.roadHealthAPI = new RoadHealthAPI();
