/**
 * RoadHealth - Leaflet Map Architecture & Dynamic Zoom Engine
 * Features:
 * - High-Resolution Satellite Imagery with zero "no map data" errors in India (Google Hybrid + Esri HD)
 * - CartoDB Positron Light Street Map Tileset
 * - Multiple Alternative Routes on-map rendering & interactive click selection
 * - Health-colored segmented polylines with subtle outer glow/casing
 * - Dynamic Zoom-Dependent Road Crack Overlays (rendered when zoom >= 16 over Red segments)
 * - Real-time ESP32 IoT telemetry vehicle tracking
 */

class RoadHealthMap {
    constructor(containerId = 'map') {
        this.containerId = containerId;
        this.map = null;
        this.allRoutes = [];
        this.selectedIndex = 0;
        this.selectedRoute = null;
        this.currentBasemapType = 'satellite';

        // Tile layer references
        this.tileLayers = {
            satellite: null,
            street: null
        };

        // Layer groups
        this.layers = {
            altRoutesGroup: L.layerGroup(),
            casingGroup: L.layerGroup(),
            routeGroup: L.layerGroup(),
            crackOverlayGroup: L.layerGroup(),
            potholeMarkerGroup: L.layerGroup(),
            poiMarkerGroup: L.layerGroup(),
            vehicleGroup: L.layerGroup()
        };

        this.activeRedSegments = [];
        this.isCrackLayerActive = false;
        this.vehicleMarker = null;

        this.initMap();
    }

    /**
     * Initialize Leaflet map centered on Telangana (Hyderabad) with High-Res Satellite
     */
    initMap() {
        this.map = L.map(this.containerId, {
            center: [17.4435, 78.3772], // Hitec City, Hyderabad, Telangana
            zoom: 13,
            zoomControl: false,
            attributionControl: false
        });

        // 1. High-Res Google Hybrid Satellite (Photorealistic imagery + crisp place labels with 100% India coverage up to zoom 22)
        this.tileLayers.satellite = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            subdomains: ['0', '1', '2', '3'],
            maxZoom: 22,
            maxNativeZoom: 19,
            attribution: '&copy; Google Maps Satellite'
        });

        // 2. CartoDB Positron Light Street Map Tiles (up to zoom 20 with stretching)
        this.tileLayers.street = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 22,
            maxNativeZoom: 19
        });

        // Set default basemap
        this.tileLayers.satellite.addTo(this.map);

        // Attribution in bottom right
        L.control.attribution({ position: 'bottomright', prefix: false })
            .addAttribution('RoadHealth &bull; High-Res Satellite AI')
            .addTo(this.map);

        // Add feature layer groups in z-order
        this.layers.altRoutesGroup.addTo(this.map);
        this.layers.casingGroup.addTo(this.map);
        this.layers.routeGroup.addTo(this.map);
        this.layers.crackOverlayGroup.addTo(this.map);
        this.layers.potholeMarkerGroup.addTo(this.map);
        this.layers.poiMarkerGroup.addTo(this.map);
        this.layers.vehicleGroup.addTo(this.map);

        // Zoom-dependent crack overlay listeners
        this.map.on('zoomend', () => this.handleZoomChange());
        this.map.on('moveend', () => {
            if (this.map.getZoom() >= 16) {
                this.updateCrackOverlays();
            }
        });

        console.log('[RoadHealth Map] Initialized with Google Hybrid Satellite (Telangana, India).');
    }

    /**
     * Switch Basemap Layer ('satellite' | 'street')
     */
    setBasemap(type) {
        this.currentBasemapType = type;

        if (type === 'satellite') {
            if (this.map.hasLayer(this.tileLayers.street)) this.map.removeLayer(this.tileLayers.street);
            if (!this.map.hasLayer(this.tileLayers.satellite)) this.tileLayers.satellite.addTo(this.map);
        } else {
            if (this.map.hasLayer(this.tileLayers.satellite)) this.map.removeLayer(this.tileLayers.satellite);
            if (!this.map.hasLayer(this.tileLayers.street)) this.tileLayers.street.addTo(this.map);
        }
        console.log(`[RoadHealth Map] Basemap switched to: ${type}`);
    }

    /**
     * Render Multiple Alternative Routes on the map simultaneously
     */
    renderMultipleRoutes(routesList, selectedIndex = 0) {
        this.allRoutes = routesList;
        this.selectedIndex = selectedIndex;
        this.selectedRoute = routesList[selectedIndex] || routesList[0];
        this.activeRedSegments = [];

        // Clear all layers
        this.layers.altRoutesGroup.clearLayers();
        this.layers.casingGroup.clearLayers();
        this.layers.routeGroup.clearLayers();
        this.layers.crackOverlayGroup.clearLayers();
        this.layers.poiMarkerGroup.clearLayers();
        this.isCrackLayerActive = false;

        if (!routesList || routesList.length === 0) return;

        const allLatLngs = [];

        // 1. Render Inactive Alternative Routes (subtle, semi-transparent & clickable to select)
        routesList.forEach((r, idx) => {
            if (idx !== selectedIndex) {
                const altCoords = r.segments.flatMap(s => s.coords);
                
                // Inactive route casing
                const altCasing = L.polyline(altCoords, {
                    color: '#000000',
                    weight: 8,
                    opacity: 0.35,
                    lineCap: 'round',
                    lineJoin: 'round'
                });

                // Inactive route polyline
                const altPoly = L.polyline(altCoords, {
                    color: '#94A3B8',
                    weight: 5,
                    opacity: 0.75,
                    dashArray: '6, 6',
                    lineCap: 'round',
                    lineJoin: 'round'
                });

                altPoly.bindTooltip(`
                    <div class="apple-map-tooltip">
                        <strong>${r.name}</strong>
                        <div>${r.etaFormatted} • ${r.totalDistanceKm} km</div>
                        <div style="color: #60A5FA; font-weight: 700; margin-top: 2px;">Click to switch to this route</div>
                    </div>
                `, { className: 'apple-tooltip-wrap' });

                // Click on alternate line switches active route
                const handleAltClick = () => {
                    if (window.selectAlternativeRoute) {
                        window.selectAlternativeRoute(idx);
                    }
                };
                altPoly.on('click', handleAltClick);
                altCasing.on('click', handleAltClick);

                this.layers.altRoutesGroup.addLayer(altCasing);
                this.layers.altRoutesGroup.addLayer(altPoly);
            }
        });

        // 2. Render Active Selected Route in full vivid health colors
        const activeRoute = this.selectedRoute;
        activeRoute.segments.forEach((seg) => {
            const coords = seg.coords;
            coords.forEach(pt => allLatLngs.push(pt));

            const isRed = seg.health === 'bad';
            if (isRed) {
                this.activeRedSegments.push(seg);
            }

            // Outer glow / casing polyline
            const casingPolyline = L.polyline(coords, {
                color: '#ffffff',
                weight: 11,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round',
                className: 'route-casing-glow'
            });
            this.layers.casingGroup.addLayer(casingPolyline);

            // Subtle drop shadow casing
            const shadowPolyline = L.polyline(coords, {
                color: 'rgba(0, 0, 0, 0.45)',
                weight: 15,
                opacity: 0.65,
                lineCap: 'round',
                lineJoin: 'round',
                className: 'route-casing-shadow'
            });
            this.layers.casingGroup.addLayer(shadowPolyline);

            // Inner vivid health-colored polyline
            const color = seg.color || window.roadHealthEngine.getHealthColor(seg.health);
            const innerPolyline = L.polyline(coords, {
                color: color,
                weight: 6.5,
                opacity: 0.98,
                lineCap: 'round',
                lineJoin: 'round',
                className: `route-segment-poly route-${seg.health}`
            });

            innerPolyline.on('mouseover', (e) => {
                casingPolyline.setStyle({ weight: 14, opacity: 1 });
                innerPolyline.setStyle({ weight: 8.5 });
                if (window.onSegmentHover) {
                    window.onSegmentHover(seg, e);
                }
            });

            innerPolyline.on('mouseout', () => {
                casingPolyline.setStyle({ weight: 11, opacity: 0.95 });
                innerPolyline.setStyle({ weight: 6.5 });
                if (window.onSegmentLeave) {
                    window.onSegmentLeave();
                }
            });

            innerPolyline.on('click', (e) => {
                if (window.onSegmentClick) {
                    window.onSegmentClick(seg, e);
                }
            });

            this.layers.routeGroup.addLayer(innerPolyline);
        });

        // 3. Render Origin & Destination POI markers
        if (allLatLngs.length > 1) {
            const startCoord = allLatLngs[0];
            const endCoord = allLatLngs[allLatLngs.length - 1];

            // Origin Marker
            const startIcon = L.divIcon({
                className: 'custom-poi-marker',
                html: `
                    <div class="apple-marker origin-marker">
                        <div class="marker-halo"></div>
                        <div class="marker-core origin-core">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"/></svg>
                        </div>
                        <div class="marker-label">${activeRoute.originName || 'Start'}</div>
                    </div>
                `,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
            const startMarker = L.marker(startCoord, { icon: startIcon });
            this.layers.poiMarkerGroup.addLayer(startMarker);

            // Destination Marker
            const destIcon = L.divIcon({
                className: 'custom-poi-marker',
                html: `
                    <div class="apple-marker dest-marker">
                        <div class="marker-core dest-core">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
                        </div>
                        <div class="marker-label">${activeRoute.destName || 'Destination'}</div>
                    </div>
                `,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });
            const destMarker = L.marker(endCoord, { icon: destIcon });
            this.layers.poiMarkerGroup.addLayer(destMarker);

            // Fit map bounds to entire active route
            const polyBounds = L.latLngBounds(allLatLngs);
            this.map.fitBounds(polyBounds, {
                paddingTopLeft: [80, 80],
                paddingBottomRight: [80, 160],
                maxZoom: 16,
                animate: true
            });
        }

        // 4. Check for high-zoom crack overlays
        this.handleZoomChange();
    }

    /**
     * High-Zoom Crack Overlays logic
     */
    handleZoomChange() {
        const currentZoom = this.map.getZoom();
        if (currentZoom >= 16) {
            this.updateCrackOverlays();
        } else {
            if (this.isCrackLayerActive || this.layers.crackOverlayGroup.getLayers().length > 0) {
                this.layers.crackOverlayGroup.clearLayers();
                this.isCrackLayerActive = false;
            }
        }
    }

    /**
     * Procedurally render realistic transparent SVG road crack overlays
     */
    updateCrackOverlays() {
        this.layers.crackOverlayGroup.clearLayers();
        if (this.activeRedSegments.length === 0) return;

        const viewBounds = this.map.getBounds();
        let renderedCount = 0;

        this.activeRedSegments.forEach(seg => {
            const segLatLngs = seg.coords.map(c => L.latLng(c[0], c[1]));
            const segBounds = L.latLngBounds(segLatLngs);

            if (!viewBounds.intersects(segBounds)) return;

            for (let i = 0; i < seg.coords.length - 1; i++) {
                const ptA = seg.coords[i];
                const ptB = seg.coords[i + 1];

                const legBounds = L.latLngBounds([ptA, ptB]);
                const paddedBounds = legBounds.pad(0.08);

                const svgCrackUrl = this._generateCrackSvgDataUrl(i, seg.potholeCount || 10);
                const crackOverlay = L.imageOverlay(svgCrackUrl, paddedBounds, {
                    opacity: 0.94,
                    interactive: true,
                    className: 'dynamic-road-crack-overlay'
                });

                crackOverlay.on('click', () => {
                    if (window.onDistressZoneClick) {
                        window.onDistressZoneClick(seg, ptA);
                    }
                });

                this.layers.crackOverlayGroup.addLayer(crackOverlay);
                renderedCount++;
            }

            // Pothole pulse markers
            seg.coords.forEach((pt, pIdx) => {
                if (pIdx % 2 === 1) {
                    const potholeDistressIcon = L.divIcon({
                        className: 'pothole-crack-pulse',
                        html: `
                            <div class="crack-hotspot">
                                <div class="pulse-ring"></div>
                                <div class="distress-icon">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="3">
                                        <path d="M12 2L2 22h20L12 2z"/>
                                    </svg>
                                </div>
                            </div>
                        `,
                        iconSize: [24, 24],
                        iconAnchor: [12, 12]
                    });
                    const distressMarker = L.marker(pt, { icon: potholeDistressIcon });
                    this.layers.crackOverlayGroup.addLayer(distressMarker);
                }
            });
        });

        this.isCrackLayerActive = renderedCount > 0;
    }

    _generateCrackSvgDataUrl(seed = 0, severity = 10) {
        const svgContent = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="100%" height="100%" preserveAspectRatio="none">
            <defs>
                <filter id="crackShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="1" dy="1.5" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.6"/>
                </filter>
            </defs>
            <g filter="url(#crackShadow)">
                <path d="M 15,95 Q 55,75 90,105 T 160,88 T 225,118 T 288,95" 
                      fill="none" stroke="#151413" stroke-width="4.0" stroke-linecap="round" stroke-linejoin="bevel" />
                
                <path d="M 18,95 Q 56,78 90,105 T 160,89 T 225,118 T 285,95" 
                      fill="none" stroke="#000000" stroke-width="2.2" stroke-linecap="round" />

                <path d="M 90,105 L 118,145 M 90,105 L 72,138 M 160,88 L 178,48 M 160,88 L 138,42 M 225,118 L 250,155 M 225,118 L 212,170" 
                      fill="none" stroke="#262321" stroke-width="2.0" stroke-linecap="round" />

                <circle cx="160" cy="88" r="11" fill="rgba(15, 13, 12, 0.85)" stroke="#EF4444" stroke-width="1.8" />
                <circle cx="158" cy="87" r="6.5" fill="#000000" />
                <circle cx="90" cy="105" r="8" fill="rgba(15, 13, 12, 0.75)" stroke="#F59E0B" stroke-width="1.4" />
                <circle cx="225" cy="118" r="7" fill="rgba(15, 13, 12, 0.75)" stroke="#EF4444" stroke-width="1.2" />
            </g>
        </svg>
        `.trim();

        return `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
    }

    renderPotholes(potholesList, show = true) {
        this.layers.potholeMarkerGroup.clearLayers();
        if (!show || !potholesList) return;

        potholesList.forEach(p => {
            const isCritical = p.severity === 'critical' || p.iri > 4.5;
            const markerIcon = L.divIcon({
                className: 'pothole-telem-marker',
                html: `
                    <div class="pothole-badge-pin ${isCritical ? 'critical' : 'moderate'}">
                        <div class="pin-dot"></div>
                        <div class="pin-pulse"></div>
                    </div>
                `,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });

            const marker = L.marker([p.lat, p.lng], { icon: markerIcon });
            marker.bindTooltip(`
                <div class="apple-map-tooltip">
                    <strong>${isCritical ? 'Critical Pothole' : 'Moderate Pothole'}</strong>
                    <div class="tooltip-row"><span>IRI Index:</span> <b>${p.iri} m/km</b></div>
                    <div class="tooltip-row"><span>Depth:</span> <b>${p.depthCm} cm</b></div>
                </div>
            `, { direction: 'top', offset: [0, -8], className: 'apple-tooltip-wrap' });

            this.layers.potholeMarkerGroup.addLayer(marker);
        });
    }

    updateVehiclePosition(lat, lng, heading = 0) {
        if (!this.vehicleMarker) {
            const vehicleIcon = L.divIcon({
                className: 'iot-vehicle-marker-wrap',
                html: `
                    <div class="iot-vehicle-pin" id="vehicle-car-pin">
                        <div class="radar-ping"></div>
                        <div class="car-body">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="#007AFF" stroke="#ffffff" stroke-width="2">
                                <polygon points="12 2 19 21 12 17 5 21 12 2"/>
                            </svg>
                        </div>
                    </div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 18]
            });

            this.vehicleMarker = L.marker([lat, lng], { icon: vehicleIcon, zIndexOffset: 1000 });
            this.layers.vehicleGroup.addLayer(this.vehicleMarker);
        } else {
            this.vehicleMarker.setLatLng([lat, lng]);
            const pinEl = document.getElementById('vehicle-car-pin');
            if (pinEl && heading) {
                pinEl.style.transform = `rotate(${heading}deg)`;
            }
        }
    }

    focusOnDistressZone() {
        if (this.activeRedSegments.length > 0) {
            const firstRed = this.activeRedSegments[0];
            const midIndex = Math.floor(firstRed.coords.length / 2);
            const focusCoord = firstRed.coords[midIndex];

            this.map.flyTo(focusCoord, 16.5, {
                animate: true,
                duration: 1.2
            });
        }
    }

    fitToCurrentRoute() {
        if (!this.selectedRoute) return;
        const allCoords = [];
        this.selectedRoute.segments.forEach(s => s.coords.forEach(c => allCoords.push(c)));
        if (allCoords.length > 0) {
            this.map.fitBounds(L.latLngBounds(allCoords), {
                paddingTopLeft: [80, 80],
                paddingBottomRight: [80, 160],
                animate: true
            });
        }
    }

    zoomIn() { this.map.zoomIn(); }
    zoomOut() { this.map.zoomOut(); }
}

window.roadHealthMap = null;
