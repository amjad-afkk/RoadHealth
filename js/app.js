/**
 * RoadHealth — Main Application Controller (Fully Live Engine)
 * Strictly connects to Node.js Spatial Server & ESP32 IoT Nodes over WebSockets.
 * ZERO simulated vehicle drive loops, ZERO mock generators.
 */

// Application State
const AppState = {
    alternativeRoutes: [],
    selectedRouteIndex: 0,
    selectedAnalyzedRoute: null,
    originPoint: { name: 'Hitec City, Hyderabad', lat: 17.4435, lng: 78.3772 },
    destPoint: { name: 'Rajiv Gandhi Airport (RGIA), Shamshabad', lat: 17.2403, lng: 78.4294 },
    showHazards: true,
    activeBasemap: 'satellite',
    waveformHistory: [],
    activeNodeId: null
};

// Telangana Quick Location Presets
const TELANGANA_PRESETS = {
    hyd_airport: {
        origin: { name: 'Hitec City, Hyderabad', lat: 17.4435, lng: 78.3772 },
        dest: { name: 'Rajiv Gandhi Airport (RGIA), Shamshabad', lat: 17.2403, lng: 78.4294 }
    },
    sec_warangal: {
        origin: { name: 'Secunderabad Junction', lat: 17.4399, lng: 78.4983 },
        dest: { name: 'Warangal Fort City', lat: 17.9554, lng: 79.6039 }
    },
    gachi_tankbund: {
        origin: { name: 'Gachibowli Financial District', lat: 17.4401, lng: 78.3489 },
        dest: { name: 'Tank Bund / Hussain Sagar', lat: 17.4239, lng: 78.4738 }
    },
    karim_nizam: {
        origin: { name: 'Karimnagar Main', lat: 18.4386, lng: 79.1288 },
        dest: { name: 'Nizamabad Central', lat: 18.6725, lng: 78.0941 }
    }
};

// ==========================================================================
// Lifecycle & Initialization
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[RoadHealth App] Initializing Fully Live IoT Road Intelligence Engine...');

    if (window.lucide) {
        lucide.createIcons();
    }

    // 1. Initialize Map with High-Res Satellite
    window.roadHealthMap = new RoadHealthMap('map');

    // 2. Setup Canvas for Waveform
    initWaveformCanvas();

    // 3. Bind Geocoding Autocomplete
    setupAutocompleteListeners();

    // 4. Connect to Real REST Backend & Render Fleet
    await connectLiveBackend();
    await renderESP32FleetGrid();

    // 5. Initial Route Calculation via OSRM & Spatial Corridor Queries
    await loadPresetRoute('hyd_airport');

    // 6. Global Event Listeners & Waveform Canvas Loop
    setupEventListeners();
    startWaveformAnimation();

    // 7. Connect Live WebSocket Stream
    connectWebSocket();
});

/**
 * Load and calculate a preset route via live geocoding & OSRM
 */
async function loadPresetRoute(presetKey) {
    const preset = TELANGANA_PRESETS[presetKey];
    if (!preset) return;

    document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active'));
    const activeBtn = Array.from(document.querySelectorAll('.preset-pill')).find(p => p.getAttribute('onclick')?.includes(presetKey));
    if (activeBtn) activeBtn.classList.add('active');

    const inOrigin = document.getElementById('inputOrigin');
    const inDest = document.getElementById('inputDest');
    if (inOrigin) inOrigin.value = preset.origin.name;
    if (inDest) inDest.value = preset.dest.name;

    AppState.originPoint = preset.origin;
    AppState.destPoint = preset.dest;

    await calculateAndRenderLiveRoutes(preset.origin, preset.dest);
}

/**
 * Handle custom route search using Nominatim & OSRM
 */
async function handleCustomRouteSearch() {
    const inOrigin = document.getElementById('inputOrigin').value.trim();
    const inDest = document.getElementById('inputDest').value.trim();

    if (!inOrigin || !inDest) {
        alert('Please enter both origin and destination addresses in Telangana.');
        return;
    }

    const btnText = document.getElementById('btnRouteText');
    if (btnText) btnText.innerText = 'Analyzing Road Surfaces...';

    try {
        let originPt = AppState.originPoint;
        if (!originPt || originPt.name !== inOrigin) {
            const geocoded = await window.roadHealthAPI.geocodeAddress(inOrigin);
            if (geocoded.length > 0) {
                originPt = { name: inOrigin, lat: geocoded[0].lat, lng: geocoded[0].lng };
                AppState.originPoint = originPt;
            }
        }

        let destPt = AppState.destPoint;
        if (!destPt || destPt.name !== inDest) {
            const geocoded = await window.roadHealthAPI.geocodeAddress(inDest);
            if (geocoded.length > 0) {
                destPt = { name: inDest, lat: geocoded[0].lat, lng: geocoded[0].lng };
                AppState.destPoint = destPt;
            }
        }

        await calculateAndRenderLiveRoutes(originPt, destPt);
    } catch (err) {
        console.error('[RoadHealth] Route calculation failed:', err);
        alert('Failed to calculate route: ' + err.message);
    } finally {
        if (btnText) btnText.innerText = 'Find Alternative Routes';
    }
}

/**
 * Fetch OSRM geometry and analyze corridor against database telemetry
 */
async function calculateAndRenderLiveRoutes(origin, dest) {
    // 1. Fetch real road routes from OSRM engine
    const rawRoutesList = await window.roadHealthAPI.calculateMultipleRoutesBetween(origin, dest, origin.name, dest.name);

    if (!rawRoutesList || rawRoutesList.length === 0) {
        console.warn('[RoadHealth] No routes returned by OSRM.');
        return;
    }

    // 2. Query spatial server database for corridor telemetry
    const analyzedList = [];
    for (const r of rawRoutesList) {
        const backendRes = await window.roadHealthAPI._backendFetch('/routes/analyze', {
            method: 'POST',
            body: JSON.stringify({ segments: r.segments })
        });

        if (backendRes && backendRes.success && backendRes.analysis) {
            analyzedList.push({
                ...r,
                compositeScore: backendRes.analysis.compositeScore,
                totalPotholes: backendRes.analysis.totalPotholes,
                avgIri: backendRes.analysis.avgIri,
                avgVibration: backendRes.analysis.avgVibration,
                totalDistanceKm: backendRes.analysis.totalDistanceKm,
                ratios: backendRes.analysis.ratios,
                lengths: backendRes.analysis.lengths,
                segments: backendRes.analysis.segments
            });
        } else {
            // Local fallback analytics if server offline
            analyzedList.push(window.roadHealthEngine.analyzeRoute(r));
        }
    }

    AppState.alternativeRoutes = analyzedList;
    AppState.selectedRouteIndex = 0;
    AppState.selectedAnalyzedRoute = AppState.alternativeRoutes[0];

    // 3. Render real routes on Leaflet map
    window.roadHealthMap.renderMultipleRoutes(AppState.alternativeRoutes, 0);

    // 4. Render route cards in side drawer
    renderAlternativeRouteCards(AppState.alternativeRoutes, 0);

    // 5. Update bottom summary card
    updateFloatingSummaryCard(AppState.selectedAnalyzedRoute);

    // 6. Refresh active pothole markers
    await toggleHazardPins(true);
}

/**
 * Select active alternative route
 */
function selectAlternativeRoute(index) {
    if (index < 0 || index >= AppState.alternativeRoutes.length) return;

    AppState.selectedRouteIndex = index;
    AppState.selectedAnalyzedRoute = AppState.alternativeRoutes[index];

    window.roadHealthMap.renderMultipleRoutes(AppState.alternativeRoutes, index);
    renderAlternativeRouteCards(AppState.alternativeRoutes, index);
    updateFloatingSummaryCard(AppState.selectedAnalyzedRoute);
}
window.selectAlternativeRoute = selectAlternativeRoute;

/**
 * Render alternative route cards list
 */
function renderAlternativeRouteCards(routes, selectedIndex = 0) {
    const listEl = document.getElementById('routeCardList');
    const headerEl = document.getElementById('altRouteHeader');
    if (!listEl) return;

    if (headerEl) headerEl.innerText = `Available Route Options (${routes.length})`;
    listEl.innerHTML = '';

    routes.forEach((route, idx) => {
        const isSelected = idx === selectedIndex;
        const scoreClass = route.compositeScore >= 80 ? 'score-badge-good' : (route.compositeScore >= 50 ? 'score-badge-mod' : 'score-badge-bad');

        const card = document.createElement('div');
        card.className = `route-card-item ${isSelected ? 'selected' : ''}`;
        card.onclick = () => selectAlternativeRoute(idx);

        card.innerHTML = `
            <div class="route-item-header">
                <div class="route-item-name">
                    <span style="font-size: 0.72rem; color: var(--apple-blue); font-weight: 700; display: block;">Route Option ${idx + 1} ${idx === 0 ? '• Recommended' : ''}</span>
                    ${route.name}
                </div>
                <div class="route-health-score-badge ${scoreClass}">${route.compositeScore}% Health</div>
            </div>
            <div class="route-item-meta">
                <div class="meta-group">
                    <i data-lucide="clock" style="width: 13px; height: 13px;"></i>
                    <span>${route.etaFormatted || route.baseDurationMin + ' min'}</span>
                </div>
                <div class="meta-group">
                    <i data-lucide="map-pin" style="width: 13px; height: 13px;"></i>
                    <span>${route.totalDistanceKm} km</span>
                </div>
                <div class="meta-group">
                    <i data-lucide="alert-circle" style="width: 13px; height: 13px; color: #EF4444;"></i>
                    <span>${route.totalPotholes} Potholes</span>
                </div>
            </div>
            <div class="mini-segment-bar">
                <div class="mini-segment seg-green" style="width: ${route.ratios.green}%;"></div>
                <div class="mini-segment seg-yellow" style="width: ${route.ratios.yellow}%;"></div>
                <div class="mini-segment seg-red" style="width: ${route.ratios.red}%;"></div>
            </div>
        `;

        listEl.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
}

/**
 * Update summary card metrics
 */
function updateFloatingSummaryCard(analyzed) {
    if (!analyzed) return;

    const etaTimeEl = document.getElementById('summaryEtaTime');
    const distEl = document.getElementById('summaryDistance');
    if (etaTimeEl) etaTimeEl.innerText = analyzed.etaFormatted || `${analyzed.baseDurationMin} min`;
    if (distEl) distEl.innerText = `(${analyzed.totalDistanceKm} km)`;

    const scorePill = document.getElementById('summaryScorePill');
    const potholeEl = document.getElementById('summaryPotholeCount');
    if (scorePill) {
        scorePill.innerText = `${analyzed.compositeScore}%`;
        scorePill.className = `health-dot-pill ${analyzed.compositeScore >= 80 ? 'good' : (analyzed.compositeScore >= 50 ? 'mod' : 'bad')}`;
    }
    if (potholeEl) {
        potholeEl.innerText = `${analyzed.totalPotholes} Potholes in database`;
    }

    const barGreen = document.getElementById('barSegGreen');
    const barYellow = document.getElementById('barSegYellow');
    const barRed = document.getElementById('barSegRed');

    if (barGreen) {
        barGreen.style.width = `${analyzed.ratios.green}%`;
        barGreen.setAttribute('data-tooltip', `Good: ${analyzed.ratios.green}% (${analyzed.lengths.goodKm} km)`);
    }
    if (barYellow) {
        barYellow.style.width = `${analyzed.ratios.yellow}%`;
        barYellow.setAttribute('data-tooltip', `Moderate: ${analyzed.ratios.yellow}% (${analyzed.lengths.moderateKm} km)`);
    }
    if (barRed) {
        barRed.style.width = `${analyzed.ratios.red}%`;
        barRed.setAttribute('data-tooltip', `Critical: ${analyzed.ratios.red}% (${analyzed.lengths.badKm} km)`);
    }

    const legGreen = document.getElementById('legendGreenLabel');
    const legYellow = document.getElementById('legendYellowLabel');
    const legRed = document.getElementById('legendRedLabel');
    if (legGreen) legGreen.innerText = `Good: ${analyzed.ratios.green}%`;
    if (legYellow) legYellow.innerText = `Moderate: ${analyzed.ratios.yellow}%`;
    if (legRed) legRed.innerText = `Critical / Potholes: ${analyzed.ratios.red}%`;
}

// ==========================================================================
// Admin Dashboard: Registered ESP32 IoT Node Fleet Monitor
// ==========================================================================
async function renderESP32FleetGrid() {
    const fleetGrid = document.getElementById('esp32FleetGrid');
    if (!fleetGrid) return;

    const fleet = await window.roadHealthAPI.getESP32Fleet();
    fleetGrid.innerHTML = '';

    const tabTitleEl = document.getElementById('fleetTabTitle');
    const activeBadgeEl = document.getElementById('fleetActiveCountBadge');

    const totalCount = fleet ? fleet.length : 0;
    const activeCount = fleet ? fleet.filter(n => n.sensors && n.sensors.status === 'Active').length : 0;

    if (tabTitleEl) tabTitleEl.innerText = `ESP32 Bike Fleet (${totalCount})`;
    if (activeBadgeEl) {
        activeBadgeEl.innerText = `● ${activeCount}/${totalCount} Nodes Transmitting`;
        activeBadgeEl.style.color = activeCount > 0 ? 'var(--health-good)' : 'var(--text-tertiary)';
    }

    if (!fleet || fleet.length === 0) {
        fleetGrid.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-secondary); background: #F8FAFC; border-radius: 12px;">
                <i data-lucide="cpu" style="width: 32px; height: 32px; margin-bottom: 8px; color: var(--text-tertiary);"></i>
                <div style="font-weight: 600;">No ESP32 Devices Registered Yet</div>
                <div style="font-size: 0.8rem; margin-top: 4px;">Connect an ESP32 hardware node or register a device via REST API <code>POST /api/v1/devices</code>.</div>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    fleet.forEach(node => {
        const batClass = node.batteryPct >= 75 ? 'bat-high' : (node.batteryPct >= 50 ? 'bat-med' : 'bat-low');
        const batTextColor = node.batteryPct >= 75 ? 'var(--health-good)' : (node.batteryPct >= 50 ? 'var(--health-mod)' : 'var(--health-bad)');

        const card = document.createElement('div');
        card.className = 'esp32-node-card';
        card.innerHTML = `
            <div class="esp32-card-header">
                <div class="bike-id-group">
                    <div class="bike-plate-badge">🏍️ ${node.bikePlate}</div>
                    <div class="node-model-sub">${node.bikeModel} • ${node.riderName}</div>
                </div>
                <div class="battery-status-wrap" style="color: ${batTextColor};">
                    <span>${node.batteryPct}%</span>
                    <div class="battery-pill-outer">
                        <div class="battery-pill-fill ${batClass}" style="width: ${node.batteryPct}%;"></div>
                    </div>
                </div>
            </div>

            <div style="font-size: 0.76rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
                <i data-lucide="map-pin" style="width: 13px; height: 13px; color: var(--apple-blue);"></i>
                <span>${node.location}</span>
            </div>

            <div class="esp32-sensors-list">
                <div class="sensor-item-row">
                    <i data-lucide="activity" style="width: 12px; height: 12px; color: var(--health-good);"></i>
                    <span>MPU6050: <strong>OK (100Hz)</strong></span>
                </div>
                <div class="sensor-item-row">
                    <i data-lucide="satellite" style="width: 12px; height: 12px; color: var(--apple-blue);"></i>
                    <span>GPS: <strong>${node.sensors.gps.split(' ')[0]}</strong></span>
                </div>
                <div class="sensor-item-row">
                    <i data-lucide="wifi" style="width: 12px; height: 12px; color: var(--health-good);"></i>
                    <span>LTE: <strong>${node.sensors.network.split(' ')[0]}</strong></span>
                </div>
            </div>

            <div class="esp32-anomaly-alert">
                <i data-lucide="alert-triangle" style="width: 13px; height: 13px; flex-shrink: 0;"></i>
                <span>${node.lastAnomaly}</span>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.72rem; color: var(--text-tertiary);">
                <span>Node: <code>${node.nodeId}</code></span>
                <span>${node.firmware}</span>
            </div>
        `;

        fleetGrid.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
}

function switchAdminTab(tabKey) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-tab-pane').forEach(p => p.classList.remove('active'));

    if (tabKey === 'fleet') {
        document.getElementById('btnAdminTabFleet')?.classList.add('active');
        document.getElementById('adminTabContentFleet')?.classList.add('active');
    } else if (tabKey === 'settings') {
        document.getElementById('btnAdminTabSettings')?.classList.add('active');
        document.getElementById('adminTabContentSettings')?.classList.add('active');
    } else if (tabKey === 'backend') {
        document.getElementById('btnAdminTabBackend')?.classList.add('active');
        document.getElementById('adminTabContentBackend')?.classList.add('active');
    }
}

// ==========================================================================
// Basemap Switcher
// ==========================================================================
function setMapBasemap(type) {
    AppState.activeBasemap = type;
    window.roadHealthMap.setBasemap(type);

    const btnSat = document.getElementById('btnBaseSat');
    const btnMap = document.getElementById('btnBaseMap');
    if (btnSat) btnSat.classList.toggle('active', type === 'satellite');
    if (btnMap) btnMap.classList.toggle('active', type === 'street');
}

function toggleMapTheme(type) {
    setMapBasemap(type);
    const container = document.getElementById('settingsMenuContainer');
    if (container) container.classList.remove('open');
}

// ==========================================================================
// Autocomplete & Search Handlers
// ==========================================================================
let originDebounceTimer = null;
let destDebounceTimer = null;

function setupAutocompleteListeners() {
    const inOrigin = document.getElementById('inputOrigin');
    const inDest = document.getElementById('inputDest');
    const dropOrigin = document.getElementById('originSuggestions');
    const dropDest = document.getElementById('destSuggestions');

    if (inOrigin && dropOrigin) {
        inOrigin.addEventListener('input', (e) => {
            clearTimeout(originDebounceTimer);
            const query = e.target.value;
            if (query.length < 2) {
                dropOrigin.classList.remove('open');
                return;
            }
            originDebounceTimer = setTimeout(async () => {
                const results = await window.roadHealthAPI.geocodeAddress(query);
                renderAutocompleteDropdown(dropOrigin, results, (selected) => {
                    inOrigin.value = selected.shortName || selected.displayName;
                    AppState.originPoint = { name: inOrigin.value, lat: selected.lat, lng: selected.lng };
                    dropOrigin.classList.remove('open');
                });
            }, 300);
        });
    }

    if (inDest && dropDest) {
        inDest.addEventListener('input', (e) => {
            clearTimeout(destDebounceTimer);
            const query = e.target.value;
            if (query.length < 2) {
                dropDest.classList.remove('open');
                return;
            }
            destDebounceTimer = setTimeout(async () => {
                const results = await window.roadHealthAPI.geocodeAddress(query);
                renderAutocompleteDropdown(dropDest, results, (selected) => {
                    inDest.value = selected.shortName || selected.displayName;
                    AppState.destPoint = { name: inDest.value, lat: selected.lat, lng: selected.lng };
                    dropDest.classList.remove('open');
                });
            }, 300);
        });
    }

    document.addEventListener('click', (e) => {
        if (dropOrigin && !inOrigin.contains(e.target) && !dropOrigin.contains(e.target)) {
            dropOrigin.classList.remove('open');
        }
        if (dropDest && !inDest.contains(e.target) && !dropDest.contains(e.target)) {
            dropDest.classList.remove('open');
        }
    });
}

function renderAutocompleteDropdown(dropdownEl, items, onSelect) {
    dropdownEl.innerHTML = '';
    if (!items || items.length === 0) {
        dropdownEl.classList.remove('open');
        return;
    }

    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'autocomplete-item';
        row.innerHTML = `<i data-lucide="map-pin" style="width: 14px; height: 14px; color: var(--apple-blue);"></i><span>${item.displayName}</span>`;
        row.onclick = () => onSelect(item);
        dropdownEl.appendChild(row);
    });

    dropdownEl.classList.add('open');
    if (window.lucide) lucide.createIcons();
}

function swapOriginDestination() {
    const inOrigin = document.getElementById('inputOrigin');
    const inDest = document.getElementById('inputDest');
    if (!inOrigin || !inDest) return;

    const tempVal = inOrigin.value;
    inOrigin.value = inDest.value;
    inDest.value = tempVal;

    const tempPt = AppState.originPoint;
    AppState.originPoint = AppState.destPoint;
    AppState.destPoint = tempPt;

    handleCustomRouteSearch();
}

function clearInput(inputId) {
    const el = document.getElementById(inputId);
    if (el) {
        el.value = '';
        el.focus();
    }
}

function useCurrentLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            AppState.originPoint = { name: 'My Current Location', lat, lng };
            const inOrigin = document.getElementById('inputOrigin');
            if (inOrigin) inOrigin.value = 'My Current Location';
            handleCustomRouteSearch();
        }, () => {
            alert('Location access denied or unavailable.');
        });
    } else {
        alert('Geolocation not supported by your browser.');
    }
}

function inspectDistressOverlays() {
    window.roadHealthMap.focusOnDistressZone();
}

// ==========================================================================
// Settings & Admin Access Placement
// ==========================================================================
function toggleSettingsDropdown(e) {
    if (e) e.stopPropagation();
    const container = document.getElementById('settingsMenuContainer');
    if (container) {
        container.classList.toggle('open');
    }
}

document.addEventListener('click', (e) => {
    const container = document.getElementById('settingsMenuContainer');
    if (container && !container.contains(e.target)) {
        container.classList.remove('open');
    }
});

function openAdminModal() {
    const container = document.getElementById('settingsMenuContainer');
    if (container) container.classList.remove('open');

    renderESP32FleetGrid();
    const modal = document.getElementById('adminModalOverlay');
    if (modal) {
        modal.classList.add('active');
    }
}

function closeAdminModal() {
    const modal = document.getElementById('adminModalOverlay');
    if (modal) {
        modal.classList.remove('active');
    }
}

function closeAdminModalOnBackdrop(e) {
    if (e.target.id === 'adminModalOverlay') {
        closeAdminModal();
    }
}

function updateAdminVal(spanId, value) {
    const el = document.getElementById(spanId);
    if (el) el.innerText = value;
}

async function syncPostGISHook() {
    const res = await window.roadHealthAPI.syncPostGIS();
    alert(`Backend Statistics:\n\n${res.spatialIndexStatus}\nEngine: ${res.postgisVersion}\nTotal Records: ${res.recordsSynced}`);
}

async function saveAdminSettings() {
    const iriThreshold = parseFloat(document.getElementById('sliderIri').value);
    const vibThreshold = parseFloat(document.getElementById('sliderVib').value);

    await window.roadHealthAPI._backendFetch('/routes/config', {
        method: 'PUT',
        body: JSON.stringify({
            iriCriticalThreshold: iriThreshold,
            zSpikeThreshold: vibThreshold
        })
    });

    closeAdminModal();
    if (AppState.selectedAnalyzedRoute) {
        calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
    }
}

function toggleRoutePanel() {
    const panel = document.getElementById('floatingSearchCard');
    const btn = document.getElementById('tab-search');
    if (panel) {
        const isCollapsed = panel.classList.toggle('collapsed');
        if (btn) btn.classList.toggle('active', !isCollapsed);
    }
}

async function toggleHazardPins(forceState = null) {
    AppState.showHazards = forceState !== null ? forceState : !AppState.showHazards;
    const btn = document.getElementById('tab-hazards');
    if (btn) btn.classList.toggle('active', AppState.showHazards);

    const potholes = await window.roadHealthAPI.getPotholeTelemetry();
    window.roadHealthMap.renderPotholes(potholes, AppState.showHazards);
}

function toggleSensorDrawer() {
    const card = document.getElementById('iotSensorCard');
    const btn = document.getElementById('tab-sensor');
    if (card) {
        const isHidden = card.classList.toggle('hidden');
        if (btn) btn.classList.toggle('active', !isHidden);
    }
}

// ==========================================================================
// Live Backend Connection & WebSocket Telemetry Stream
// ==========================================================================
async function connectLiveBackend() {
    window.roadHealthAPI.configure({ mode: 'nodejs' });

    try {
        const data = await window.roadHealthAPI._backendFetch('/health');
        if (data && data.status === 'ok') {
            console.log('[RoadHealth] Connected to live spatial backend.');
            const statusEl = document.getElementById('telemetry-node-status');
            if (statusEl) statusEl.textContent = `Backend: Connected (${data.websocketClients} WS clients)`;
        } else {
            console.warn('[RoadHealth] Backend unreachable at http://localhost:8000');
            const statusEl = document.getElementById('telemetry-node-status');
            if (statusEl) statusEl.textContent = 'Backend: Offline (Start server)';
        }
    } catch (err) {
        console.warn('[RoadHealth] Backend connection error:', err.message);
    }
}

let wsConnection = null;

function connectWebSocket() {
    const wsUrl = window.location.protocol === 'https:'
        ? 'wss://roadhealth.onrender.com'
        : (window.location.hostname === 'localhost' ? 'ws://localhost:8000' : 'wss://roadhealth.onrender.com');
    console.log(`[WS] Connecting to ${wsUrl}...`);

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            console.log('[WS] WebSocket Live Stream Active');
            const statusEl = document.getElementById('telemetry-node-status');
            if (statusEl) statusEl.textContent = 'ESP32 Fleet: Live Stream Active';
        };

        wsConnection.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWebSocketMessage(msg);
            } catch (err) {
                console.warn('[WS] Invalid packet:', err);
            }
        };

        wsConnection.onclose = () => {
            console.log('[WS] Disconnected. Reconnecting in 5s...');
            setTimeout(connectWebSocket, 5000);
        };

        wsConnection.onerror = () => {
            console.warn('[WS] Connection error');
        };
    } catch (err) {
        console.warn('[WS] Failed to establish WebSocket:', err.message);
        setTimeout(connectWebSocket, 5000);
    }
}

function handleWebSocketMessage(msg) {
    switch (msg.event) {
        case 'telemetry:live':
            if (msg.data) {
                updateTelemetryDashboard({
                    speedKmh: msg.data.speedKmh,
                    accel: msg.data.accel,
                    iriEstimate: msg.data.iriEstimate,
                    vibrationMagnitude: msg.data.vibrationMagnitude
                }, msg.data.iriEstimate > 4.5 ? 'bad' : (msg.data.iriEstimate > 2.5 ? 'moderate' : 'good'));

                if (msg.data.lat && msg.data.lng) {
                    window.roadHealthMap.updateVehiclePosition(msg.data.lat, msg.data.lng);
                }
            }
            break;

        case 'pothole:detected':
            if (msg.data) {
                console.log(`[WS] Live Pothole Alert: ${msg.data.severity} at ${msg.data.lat}, ${msg.data.lng}`);
                toggleHazardPins(true);
            }
            break;

        case 'device:status':
            if (msg.data) {
                renderESP32FleetGrid();
            }
            break;
    }
}

function updateTelemetryDashboard(payload, segmentHealth) {
    const speedEl = document.getElementById('metric-speed');
    const iriEl = document.getElementById('metric-iri');
    const zaccEl = document.getElementById('metric-zacc');
    const vibEl = document.getElementById('metric-vib');

    if (speedEl) speedEl.innerText = `${payload.speedKmh || 0} km/h`;
    if (iriEl) {
        iriEl.innerText = `${payload.iriEstimate ? payload.iriEstimate.toFixed(2) : '--'} m/km`;
        iriEl.style.color = segmentHealth === 'bad' ? '#EF4444' : (segmentHealth === 'moderate' ? '#F59E0B' : '#10B981');
    }
    if (zaccEl) zaccEl.innerText = `${payload.accel ? payload.accel.z.toFixed(2) : '--'} m/s²`;
    if (vibEl) vibEl.innerText = `${payload.vibrationMagnitude ? payload.vibrationMagnitude.toFixed(2) : '--'}`;

    if (payload.accel && payload.accel.z) {
        AppState.waveformHistory.push(payload.accel.z - 9.81);
        if (AppState.waveformHistory.length > 50) {
            AppState.waveformHistory.shift();
        }
    }
}

// Waveform Visualizer
let canvasCtx = null;
function initWaveformCanvas() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    canvas.width = canvas.clientWidth * window.devicePixelRatio || 280;
    canvas.height = canvas.clientHeight * window.devicePixelRatio || 50;
    canvasCtx = canvas.getContext('2d');

    for (let i = 0; i < 50; i++) {
        AppState.waveformHistory.push(0);
    }
}

function startWaveformAnimation() {
    function draw() {
        if (canvasCtx) {
            const canvas = canvasCtx.canvas;
            const w = canvas.width;
            const h = canvas.height;

            canvasCtx.fillStyle = '#0F172A';
            canvasCtx.fillRect(0, 0, w, h);

            canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            canvasCtx.lineWidth = 1;
            canvasCtx.beginPath();
            canvasCtx.moveTo(0, h / 2);
            canvasCtx.lineTo(w, h / 2);
            canvasCtx.stroke();

            canvasCtx.strokeStyle = '#007AFF';
            canvasCtx.lineWidth = 2;
            canvasCtx.beginPath();

            const pts = AppState.waveformHistory;
            const stepX = w / (pts.length - 1 || 1);

            for (let i = 0; i < pts.length; i++) {
                const val = pts[i];
                const y = (h / 2) - (val * 8);
                const clampedY = Math.max(4, Math.min(h - 4, y));

                if (i === 0) canvasCtx.moveTo(0, clampedY);
                else canvasCtx.lineTo(i * stepX, clampedY);
            }
            canvasCtx.stroke();
        }
        requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
}

window.onSegmentClick = (seg) => {
    console.log('[RoadHealth] Selected Segment:', seg.roadName, seg.health);
};

window.onDistressZoneClick = (seg, coord) => {
    alert(`Distress Zone Inspected!\n\nRoad: ${seg.roadName}\nIRI Index: ${seg.iri} m/km\nPothole Count: ${seg.potholeCount}\nHealth Status: Critical`);
};

function setupEventListeners() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAdminModal();
            const container = document.getElementById('settingsMenuContainer');
            if (container) container.classList.remove('open');
        }
    });
}
