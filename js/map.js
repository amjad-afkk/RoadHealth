class RoadHealthMap {
    constructor(containerId = 'map') {
        this.containerId = containerId;
        this.map = null;
        this.allRoutes = [];
        this.selectedIndex = 0;
        this.selectedRoute = null;
        this.currentBasemapType = 'google-satellite';

        this.tileLayers = {
            'google-satellite': null,
            'esri-satellite': null,
            'street': null,
            'dark': null
        };

        this.layers = {
            altRoutesGroup: L.layerGroup(),
            casingGroup: L.layerGroup(),
            routeGroup: L.layerGroup(),
            crackOverlayGroup: L.layerGroup(),
            potholeMarkerGroup: L.layerGroup(),
            heatmapLayer: null,
            poiMarkerGroup: L.layerGroup(),
            vehicleGroup: L.layerGroup()
        };

        this.activeRedSegments = [];
        this.isCrackLayerActive = false;
        this.isHeatmapActive = false;
        this.vehicleMarker = null;

        this.initMap();
    }

    initMap() {
        this.map = L.map(this.containerId, {
            center: [17.4435, 78.3772],
            zoom: 13,
            zoomControl: false,
            attributionControl: false
        });

        this.tileLayers['google-satellite'] = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            subdomains: ['0', '1', '2', '3'],
            maxZoom: 22,
            maxNativeZoom: 19,
            attribution: '&copy; Google Maps Satellite'
        });

        this.tileLayers['esri-satellite'] = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 22,
            maxNativeZoom: 18,
            attribution: '&copy; Esri World Imagery'
        });

        this.tileLayers['street'] = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 22,
            maxNativeZoom: 19,
            attribution: '&copy; CartoDB Positron'
        });

        this.tileLayers['dark'] = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 22,
            maxNativeZoom: 19,
            attribution: '&copy; CartoDB Dark Matter'
        });

        this.tileLayers['google-satellite'].addTo(this.map);

        L.control.attribution({ position: 'bottomright', prefix: false })
            .addAttribution('RoadHealth &bull; PostGIS Spatial Engine')
            .addTo(this.map);

        this.layers.altRoutesGroup.addTo(this.map);
        this.layers.casingGroup.addTo(this.map);
        this.layers.routeGroup.addTo(this.map);
        this.layers.crackOverlayGroup.addTo(this.map);
        this.layers.potholeMarkerGroup.addTo(this.map);
        this.layers.poiMarkerGroup.addTo(this.map);
        this.layers.vehicleGroup.addTo(this.map);

        this.map.on('zoomend', () => this.handleZoomChange());
        this.map.on('moveend', () => {
            if (this.map.getZoom() >= 16) {
                this.updateCrackOverlays();
            }
        });

        this.map.on('click', (e) => {
            if (e.originalEvent) {
                const target = e.originalEvent.target;
                if (target && (target.closest('.leaflet-popup') || target.closest('.custom-pothole-hazard-pin') || target.closest('.leaflet-marker-icon') || target.closest('.popup-action-btn'))) {
                    return;
                }
            }
            const lat = e.latlng.lat;
            const lng = e.latlng.lng;
            const popupContent = `
                <div style="font-size: 0.82rem; padding: 4px; min-width: 170px;">
                    <div style="font-weight: 700; margin-bottom: 4px; color: #1E293B;">📍 Point on Map</div>
                    <div style="font-size: 0.72rem; color: #64748B; margin-bottom: 8px;">${lat.toFixed(5)}°N, ${lng.toFixed(5)}°E</div>
                    <div style="display: flex; gap: 6px;">
                        <button class="popup-action-btn" style="background: #10B981; color: white; flex: 1; padding: 4px 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.74rem;" onclick="setMapPointAs('origin', ${lat}, ${lng})">Start Here</button>
                        <button class="popup-action-btn" style="background: #007AFF; color: white; flex: 1; padding: 4px 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.74rem;" onclick="setMapPointAs('dest', ${lat}, ${lng})">End Here</button>
                    </div>
                </div>
            `;
            L.popup({ className: 'map-point-picker-popup' }).setLatLng(e.latlng).setContent(popupContent).openOn(this.map);
        });

        console.log('[RoadHealth Map] Initialized with Multi-Basemaps & PostGIS.');
    }

    setBasemap(type) {
        if (!this.tileLayers[type]) type = 'google-satellite';
        this.currentBasemapType = type;

        Object.keys(this.tileLayers).forEach(key => {
            const layer = this.tileLayers[key];
            if (layer && this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });

        this.tileLayers[type].addTo(this.map);
        console.log(`[RoadHealth Map] Basemap switched to: ${type}`);
    }

    renderHeatmap(points, isVisible = true) {
        this.isHeatmapActive = isVisible;

        if (this.layers.heatmapLayer && this.map.hasLayer(this.layers.heatmapLayer)) {
            this.map.removeLayer(this.layers.heatmapLayer);
            this.layers.heatmapLayer = null;
        }

        if (!isVisible || !points || points.length === 0) return;

        if (typeof L.heatLayer === 'function') {
            this.layers.heatmapLayer = L.heatLayer(points, {
                radius: 28,
                blur: 18,
                maxZoom: 17,
                max: 1.0,
                gradient: {
                    0.2: '#10B981',
                    0.5: '#F59E0B',
                    0.8: '#EF4444',
                    1.0: '#991B1B'
                }
            });
            this.layers.heatmapLayer.addTo(this.map);
        }
    }

    renderMultipleRoutes(routesList, selectedIndex = 0) {
        this.allRoutes = routesList;
        this.selectedIndex = selectedIndex;
        this.selectedRoute = routesList[selectedIndex] || routesList[0];
        this.activeRedSegments = [];

        this.layers.altRoutesGroup.clearLayers();
        this.layers.casingGroup.clearLayers();
        this.layers.routeGroup.clearLayers();
        this.layers.crackOverlayGroup.clearLayers();

        if (!routesList || routesList.length === 0) return;

        routesList.forEach((route, idx) => {
            if (idx === selectedIndex) return;

            const fullPolyline = [];
            (route.segments || []).forEach(seg => {
                if (seg.coords && seg.coords.length > 0) {
                    fullPolyline.push(...seg.coords);
                }
            });

            if (fullPolyline.length >= 2) {
                const altLine = L.polyline(fullPolyline, {
                    color: '#94A3B8',
                    weight: 6,
                    opacity: 0.55,
                    lineCap: 'round',
                    lineJoin: 'round'
                });

                altLine.on('click', () => {
                    if (typeof window.selectAlternativeRoute === 'function') {
                        window.selectAlternativeRoute(idx);
                    }
                });

                altLine.bindTooltip(`<strong>Option ${idx + 1}</strong> (${route.name})<br>${route.totalDistanceKm} km &bull; ${route.compositeScore}% Health`, {
                    sticky: true,
                    className: 'route-alt-tooltip'
                });

                this.layers.altRoutesGroup.addLayer(altLine);
            }
        });

        const primaryRoute = this.selectedRoute;
        if (!primaryRoute || !primaryRoute.segments) return;

        const allSelectedCoords = [];

        primaryRoute.segments.forEach((seg, sIdx) => {
            if (!seg.coords || seg.coords.length < 2) return;
            allSelectedCoords.push(...seg.coords);

            const color = seg.health === 'bad' ? '#EF4444' : (seg.health === 'moderate' ? '#F59E0B' : '#10B981');
            const isRed = seg.health === 'bad';

            if (isRed) {
                this.activeRedSegments.push(seg);
            }

            const casing = L.polyline(seg.coords, {
                color: '#FFFFFF',
                weight: 10,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round'
            });
            this.layers.casingGroup.addLayer(casing);

            const coreLine = L.polyline(seg.coords, {
                color: color,
                weight: 6,
                opacity: 1.0,
                lineCap: 'round',
                lineJoin: 'round'
            });

            coreLine.on('click', () => {
                if (typeof window.onSegmentClick === 'function') {
                    window.onSegmentClick(seg);
                }
            });

            coreLine.bindTooltip(`
                <div class="segment-tooltip-content">
                    <strong>${seg.roadName || 'Road Segment'}</strong>
                    <div style="color: ${color}; font-weight: 700; margin-top: 2px;">
                        ${seg.health === 'bad' ? '⚠️ Degraded / Critical' : (seg.health === 'moderate' ? '⚡ Moderate Roughness' : '✅ Smooth Asphalt')}
                    </div>
                    <div style="font-size: 0.72rem; color: #64748B; margin-top: 2px;">
                        IRI: ${seg.iri || '--'} m/km &bull; Potholes: ${seg.potholeCount || 0}
                    </div>
                </div>
            `, { sticky: true });

            this.layers.routeGroup.addLayer(coreLine);
        });

        this.renderOriginDestMarkers(primaryRoute);

        if (allSelectedCoords.length > 0) {
            this.map.fitBounds(L.latLngBounds(allSelectedCoords), {
                padding: [80, 80],
                maxZoom: 16,
                animate: true,
                duration: 0.8
            });
        }

        this.handleZoomChange();
    }

    renderOriginDestMarkers(route) {
        this.layers.poiMarkerGroup.clearLayers();
        if (!route || !route.origin || !route.destination) return;

        const originIcon = L.divIcon({
            className: 'custom-poi-pin origin-pin',
            html: `<div class="pin-pulse"></div><div class="pin-core green"></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        const destIcon = L.divIcon({
            className: 'custom-poi-pin dest-pin',
            html: `<div class="pin-pulse"></div><div class="pin-core red"><i data-lucide="flag" style="width:10px;height:10px;color:#fff;"></i></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        const originMarker = L.marker([route.origin.lat, route.origin.lng], { icon: originIcon })
            .bindPopup(`<strong>Origin</strong><br>${route.origin.name || 'Start Point'}`);

        const destMarker = L.marker([route.destination.lat, route.destination.lng], { icon: destIcon })
            .bindPopup(`<strong>Destination</strong><br>${route.destination.name || 'End Point'}`);

        this.layers.poiMarkerGroup.addLayer(originMarker);
        this.layers.poiMarkerGroup.addLayer(destMarker);
    }

    renderPotholes(potholesList, isVisible = true) {
        this.layers.potholeMarkerGroup.clearLayers();
        if (!isVisible || !potholesList || potholesList.length === 0) return;

        potholesList.forEach(p => {
            const isCrit = p.severity === 'critical';
            const isRepaired = p.status === 'repaired';

            const markerClass = isRepaired ? 'pothole-repaired' : (isCrit ? 'pothole-crit' : 'pothole-mod');
            const color = isRepaired ? '#10B981' : (isCrit ? '#EF4444' : '#F59E0B');

            const icon = L.divIcon({
                className: 'custom-pothole-hazard-pin',
                html: `
                    <div class="pothole-pin-wrap ${markerClass}">
                        <div class="pothole-pulse" style="border-color: ${color};"></div>
                        <div class="pothole-core" style="background: ${color};">
                            <span class="pothole-depth-label">${Math.round(p.depthCm || 5)}cm</span>
                        </div>
                    </div>
                `,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });

            const confidencePct = Math.round((p.confidence !== undefined ? p.confidence : 1.0) * 100);
            const elapsed = p.elapsedDays !== undefined ? p.elapsedDays : 0;
            const confidenceColor = confidencePct >= 70 ? '#10B981' : (confidencePct >= 40 ? '#F59E0B' : '#EF4444');

            const statusBadge = isRepaired
                ? '<span style="background: #ECFDF5; color: #059669; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 700;">✅ Repaired</span>'
                : `<span style="background: ${isCrit ? '#FEF2F2' : '#FFFBEB'}; color: ${isCrit ? '#DC2626' : '#D97706'}; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 700;">${p.status.toUpperCase()}</span>`;

            const popupContent = `
                <div class="pothole-popup-card">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 0.78rem; color: #64748B; font-weight: 600;">ID: ${p.id}</span>
                        ${statusBadge}
                    </div>
                    <div style="font-weight: 700; font-size: 0.95rem; color: #1E293B;">
                        ${isCrit ? '🚨 Severe Pothole Impact' : '⚠️ Surface Degradation'}
                    </div>
                    <div class="pothole-stats-row" style="margin: 8px 0; font-size: 0.8rem; display: flex; flex-wrap: wrap; gap: 10px;">
                        <div>IRI: <strong>${p.iri ? p.iri.toFixed(1) : '--'} m/km</strong></div>
                        <div>Est. Depth: <strong>${p.depthCm || 5} cm</strong></div>
                        <div>Cluster: <strong>${p.clusterSize || 1} passes</strong></div>
                        <div>Confidence: <strong style="color: ${confidenceColor};">${confidencePct}%</strong> (${elapsed > 0 ? elapsed + 'd ago' : 'Recent'})</div>
                    </div>
                    <div style="font-size: 0.72rem; color: #94A3B8; margin-bottom: 10px;">
                        Lat: ${p.lat.toFixed(5)}°N, Lng: ${p.lng.toFixed(5)}°E
                    </div>
                    <div style="display: flex; gap: 6px;">
                        ${!isRepaired ? `
                            <button class="popup-action-btn btn-repair" onclick="markPotholeRepaired('${p.id}')">
                                Mark Repaired
                            </button>
                        ` : ''}
                        <button class="popup-action-btn btn-delete" onclick="flagPotholeFalsePositive('${p.id}')">
                            Dismiss
                        </button>
                    </div>
                </div>
            `;

            const marker = L.marker([p.lat, p.lng], { icon: icon });
            marker.bindPopup(popupContent, {
                autoClose: true,
                closeOnClick: false,
                className: 'pothole-interactive-popup',
                offset: [0, -10]
            });
            marker.on('click', (e) => {
                if (e && e.originalEvent) {
                    e.originalEvent.stopPropagation();
                }
            });
            this.layers.potholeMarkerGroup.addLayer(marker);
        });
    }

    updateVehiclePosition(lat, lng) {
        if (!lat || !lng) return;

        if (!this.vehicleMarker) {
            const bikeIcon = L.divIcon({
                className: 'custom-bike-vehicle-marker',
                html: `
                    <div class="bike-radar-ring"></div>
                    <div class="bike-pin-head">🏍️</div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            });

            this.vehicleMarker = L.marker([lat, lng], { icon: bikeIcon, zIndexOffset: 1000 });
            this.layers.vehicleGroup.addLayer(this.vehicleMarker);
        } else {
            this.vehicleMarker.setLatLng([lat, lng]);
        }
    }

    handleZoomChange() {
        const zoom = this.map.getZoom();
        if (zoom >= 16) {
            this.updateCrackOverlays();
        } else {
            this.layers.crackOverlayGroup.clearLayers();
            this.isCrackLayerActive = false;
        }
    }

    updateCrackOverlays() {
        this.layers.crackOverlayGroup.clearLayers();
        if (!this.activeRedSegments || this.activeRedSegments.length === 0) return;

        this.activeRedSegments.forEach(seg => {
            if (!seg.coords || seg.coords.length < 2) return;

            for (let i = 0; i < seg.coords.length - 1; i++) {
                const p1 = seg.coords[i];
                const p2 = seg.coords[i + 1];

                const crackPolyline = this.generateZigzagCoordinates(p1, p2, 6);

                const crackLine = L.polyline(crackPolyline, {
                    color: '#7F1D1D',
                    weight: 2.5,
                    dashArray: '3, 4',
                    opacity: 0.9
                });

                this.layers.crackOverlayGroup.addLayer(crackLine);
            }
        });

        this.isCrackLayerActive = true;
    }

    generateZigzagCoordinates(pt1, pt2, steps = 6) {
        const coords = [pt1];
        const dLat = (pt2[0] - pt1[0]) / steps;
        const dLng = (pt2[1] - pt1[1]) / steps;

        for (let j = 1; j < steps; j++) {
            const baseLat = pt1[0] + dLat * j;
            const baseLng = pt1[1] + dLng * j;
            const perpOffset = (j % 2 === 0 ? 1 : -1) * 0.00008;

            coords.push([baseLat + perpOffset, baseLng - perpOffset]);
        }

        coords.push(pt2);
        return coords;
    }

    focusOnDistressZone() {
        if (this.activeRedSegments && this.activeRedSegments.length > 0) {
            const firstRed = this.activeRedSegments[0];
            if (firstRed.coords && firstRed.coords.length > 0) {
                this.map.setView(firstRed.coords[0], 17, { animate: true });
            }
        }
    }
}

window.RoadHealthMap = RoadHealthMap;
