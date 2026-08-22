/**
 * RoadHealth — Real-Time Event & GIS Controller
 * PostGIS Data Synchronization, Voice Proximity Alerts, Heatmap & Surface Visualizers.
 */

const AppState = {
    alternativeRoutes: [],
    selectedRouteIndex: 0,
    selectedAnalyzedRoute: null,
    originPoint: { name: 'Hitec City, Hyderabad', lat: 17.4435, lng: 78.3772 },
    destPoint: { name: 'Rajiv Gandhi Airport (RGIA), Shamshabad', lat: 17.2403, lng: 78.4294 },
    showHazards: true,
    showHeatmap: false,
    voiceAlertsEnabled: true,
    activeBasemap: 'google-satellite',
    waveformHistory: [],
    lastSpokenPotholeTime: 0
};

const TELANGANA_PRESETS = {
    hyd_airport: {
        origin: { name: 'Hitec City, Hyderabad', lat: 17.4435, lng: 78.3772 },
        dest: { name: 'Rajiv Gandhi Airport (RGIA), Shamshabad', lat: 17.2403, lng: 78.4294 }
    },
    gachi_tankbund: {
        origin: { name: 'Gachibowli Financial District', lat: 17.4401, lng: 78.3489 },
        dest: { name: 'Tank Bund / Hussain Sagar', lat: 17.4239, lng: 78.4738 }
    },
    sec_warangal: {
        origin: { name: 'Secunderabad Junction', lat: 17.4399, lng: 78.4983 },
        dest: { name: 'Warangal Fort City', lat: 17.9554, lng: 79.6039 }
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[RoadHealth App] Initializing PostGIS IoT Road Intelligence Engine...');

    if (window.lucide) {
        lucide.createIcons();
    }

    window.roadHealthMap = new RoadHealthMap('map');

    initWaveformCanvas();
    setupAutocompleteListeners();

    await connectLiveBackend();
    await renderESP32FleetGrid();
    await loadPresetRoute('hyd_airport');

    setupEventListeners();
    startWaveformAnimation();
    connectWebSocket();
});

/**
 * Load Pre-Configured Telangana Route
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
 * Handle Search button click
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
 * Calculate and render routes with PostGIS corridor analysis
 */
async function calculateAndRenderLiveRoutes(origin, dest) {
    const rawRoutesList = await window.roadHealthAPI.calculateMultipleRoutesBetween(origin, dest, origin.name, dest.name);

    if (!rawRoutesList || rawRoutesList.length === 0) {
        console.warn('[RoadHealth] No routes returned by OSRM.');
        return;
    }

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
            analyzedList.push(r);
        }
    }

    // Sort routes by Health Score (safest route first)
    analyzedList.sort((a, b) => b.compositeScore - a.compositeScore);

    AppState.alternativeRoutes = analyzedList;
    AppState.selectedRouteIndex = 0;
    AppState.selectedAnalyzedRoute = AppState.alternativeRoutes[0];

    window.roadHealthMap.renderMultipleRoutes(AppState.alternativeRoutes, 0);
    renderAlternativeRouteCards(AppState.alternativeRoutes, 0);
    updateFloatingSummaryCard(AppState.selectedAnalyzedRoute);

    await toggleHazardPins(true);
    drawRouteProfileChart(AppState.selectedAnalyzedRoute);
}

/**
 * Switch Selected Alternative Route
 */
function selectAlternativeRoute(index) {
    if (index < 0 || index >= AppState.alternativeRoutes.length) return;

    AppState.selectedRouteIndex = index;
    AppState.selectedAnalyzedRoute = AppState.alternativeRoutes[index];

    window.roadHealthMap.renderMultipleRoutes(AppState.alternativeRoutes, index);
    renderAlternativeRouteCards(AppState.alternativeRoutes, index);
    updateFloatingSummaryCard(AppState.selectedAnalyzedRoute);
    drawRouteProfileChart(AppState.selectedAnalyzedRoute);
}
window.selectAlternativeRoute = selectAlternativeRoute;

/**
 * Render Route Cards
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
                    <span style="font-size: 0.72rem; color: var(--apple-blue); font-weight: 700; display: block;">Route Option ${idx + 1} ${idx === 0 ? '• Recommended (Best Surface)' : ''}</span>
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
 * Update Top-Right Floating Summary Card
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
        potholeEl.innerText = `${analyzed.totalPotholes} Potholes in PostGIS`;
    }

    const barGreen = document.getElementById('barSegGreen');
    const barYellow = document.getElementById('barSegYellow');
    const barRed = document.getElementById('barSegRed');

    if (barGreen) barGreen.style.width = `${analyzed.ratios.green}%`;
    if (barYellow) barYellow.style.width = `${analyzed.ratios.yellow}%`;
    if (barRed) barRed.style.width = `${analyzed.ratios.red}%`;

    const legGreen = document.getElementById('legendGreenLabel');
    const legYellow = document.getElementById('legendYellowLabel');
    const legRed = document.getElementById('legendRedLabel');
    if (legGreen) legGreen.innerText = `Good: ${analyzed.ratios.green}%`;
    if (legYellow) legYellow.innerText = `Moderate: ${analyzed.ratios.yellow}%`;
    if (legRed) legRed.innerText = `Potholes: ${analyzed.ratios.red}%`;
}

/**
 * Voice Proximity Hazard Alerts using Web Speech API
 */
function speakHazardWarning(text) {
    if (!AppState.voiceAlertsEnabled || !('speechSynthesis' in window)) return;

    const now = Date.now();
    // Throttle voice callouts to once every 5 seconds
    if (now - AppState.lastSpokenPotholeTime < 5000) return;
    AppState.lastSpokenPotholeTime = now;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
}

function toggleVoiceAlerts() {
    AppState.voiceAlertsEnabled = !AppState.voiceAlertsEnabled;
    const btn = document.getElementById('tab-voice');
    const icon = document.getElementById('voiceIcon');
    const label = document.getElementById('voiceLabel');

    if (AppState.voiceAlertsEnabled) {
        btn?.classList.add('active');
        if (icon) icon.style.color = '#10B981';
        if (label) label.innerText = 'Voice: ON';
        speakHazardWarning('Voice hazard warnings enabled.');
    } else {
        btn?.classList.remove('active');
        if (icon) icon.style.color = '#94A3B8';
        if (label) label.innerText = 'Voice: OFF';
        window.speechSynthesis?.cancel();
    }
}

/**
 * Toggle Road Damage Heatmap Layer
 */
async function toggleHeatmapLayer() {
    AppState.showHeatmap = !AppState.showHeatmap;
    const btn = document.getElementById('tab-heatmap');
    btn?.classList.toggle('active', AppState.showHeatmap);

    if (AppState.showHeatmap) {
        const points = await window.roadHealthAPI.getHeatmapPoints();
        window.roadHealthMap.renderHeatmap(points, true);
    } else {
        window.roadHealthMap.renderHeatmap([], false);
    }
}

/**
 * Toggle Route Roughness Profile Drawer & Draw Chart
 */
function toggleRoughnessProfileDrawer() {
    const drawer = document.getElementById('roughnessProfileDrawer');
    if (!drawer) return;
    const isHidden = drawer.classList.toggle('hidden');
    if (!isHidden && AppState.selectedAnalyzedRoute) {
        drawRouteProfileChart(AppState.selectedAnalyzedRoute);
    }
}

function drawRouteProfileChart(route) {
    if (!route || !route.segments) return;

    const canvas = document.getElementById('routeProfileCanvas');
    if (!canvas) return;

    const nameEl = document.getElementById('profileRouteName');
    const avgIriEl = document.getElementById('profileAvgIri');
    const pCountEl = document.getElementById('profilePotholeCount');

    if (nameEl) nameEl.innerText = route.name || 'Selected Route';
    if (avgIriEl) avgIriEl.innerText = `${route.avgIri || 1.2} m/km`;
    if (pCountEl) pCountEl.innerText = `${route.totalPotholes || 0}`;

    const rect = canvas.getBoundingClientRect();
    canvas.width = (rect.width || 600) * window.devicePixelRatio;
    canvas.height = (rect.height || 100) * window.devicePixelRatio;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, w, h);

    // Draw baseline threshold line (IRI 4.5 critical)
    const critY = h * 0.35;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, critY);
    ctx.lineTo(w, critY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw segment roughness cross-section bars
    const segs = route.segments;
    const segWidth = w / (segs.length || 1);

    segs.forEach((seg, i) => {
        const iri = seg.iri || 1.2;
        const normalizedH = Math.min(h - 10, (iri / 8.0) * (h - 20) + 10);
        const x = i * segWidth;
        const y = h - normalizedH;

        const color = seg.health === 'bad' ? '#EF4444' : (seg.health === 'moderate' ? '#F59E0B' : '#10B981');

        // Gradient bar
        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(15, 23, 42, 0.8)');

        ctx.fillStyle = grad;
        ctx.fillRect(x + 2, y, segWidth - 4, normalizedH);

        // Top line
        ctx.fillStyle = color;
        ctx.fillRect(x + 2, y, segWidth - 4, 3);
    });
}

/**
 * Pothole Status Actions
 */
async function markPotholeRepaired(id) {
    const res = await window.roadHealthAPI.updatePotholeStatus(id, 'repaired', 'GHMC Road Maintenance Unit');
    if (res && res.success) {
        toggleHazardPins(true);
        if (AppState.showHeatmap) toggleHeatmapLayer();
        speakHazardWarning('Pothole marked as repaired in PostGIS.');
    }
}
window.markPotholeRepaired = markPotholeRepaired;

async function flagPotholeFalsePositive(id) {
    const res = await window.roadHealthAPI.flagFalsePositive(id);
    if (res && res.success) {
        toggleHazardPins(true);
    }
}
window.flagPotholeFalsePositive = flagPotholeFalsePositive;

/**
 * Virtual Patrol Bike Simulation Trigger
 */
async function startVirtualBikeSimulation() {
    const route = AppState.selectedAnalyzedRoute;
    let coords = null;

    if (route && route.segments) {
        coords = [];
        route.segments.forEach(s => {
            if (s.coords) coords.push(...s.coords);
        });
    }

    const res = await window.roadHealthAPI.simulatePatrolBike(coords);
    if (res && res.success) {
        speakHazardWarning('Starting virtual patrol bike simulation ride.');
        const container = document.getElementById('settingsMenuContainer');
        if (container) container.classList.remove('open');
    }
}

/**
 * Municipal Report Export Modal Handlers
 */
function openExportModal() {
    const container = document.getElementById('settingsMenuContainer');
    if (container) container.classList.remove('open');
    document.getElementById('exportModalOverlay')?.classList.add('active');
}

function closeExportModal() {
    document.getElementById('exportModalOverlay')?.classList.remove('active');
}

function closeExportModalOnBackdrop(e) {
    if (e.target.id === 'exportModalOverlay') closeExportModal();
}

function downloadExport(format) {
    const url = `${window.roadHealthAPI.config.baseUrl}/potholes/export?format=${format}`;
    window.open(url, '_blank');
    closeExportModal();
}

/**
 * WebSocket Connection & Live Event Stream
 */
let wsConnection = null;

function connectWebSocket() {
    const wsUrl = window.location.protocol === 'https:'
        ? `wss://${window.location.host}`
        : (window.location.hostname === 'localhost' ? 'ws://localhost:8000' : `wss://${window.location.host}`);

    console.log(`[WS] Connecting to ${wsUrl}...`);

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            console.log('[WS] WebSocket Live Stream Active');
            const statusEl = document.getElementById('telemetry-node-status');
            if (statusEl) statusEl.textContent = 'PostGIS Live Stream Active';
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
    } catch (err) {
        console.warn('[WS] Failed to establish WebSocket:', err.message);
        setTimeout(connectWebSocket, 5000);
    }
}

function handleWebSocketMessage(msg) {
    switch (msg.event) {
        case 'telemetry:live':
            if (msg.data) {
                updateTelemetryDashboard(msg.data);
                if (msg.data.lat && msg.data.lng) {
                    window.roadHealthMap.updateVehiclePosition(msg.data.lat, msg.data.lng);
                }
            }
            break;

        case 'pothole:detected':
            if (msg.data) {
                console.log(`[WS] Live Pothole Alert: ${msg.data.severity} at ${msg.data.lat}, ${msg.data.lng}`);
                toggleHazardPins(true);
                speakHazardWarning(`Warning: Severe pothole detected with IRI ${msg.data.iri?.toFixed(1) || '6.0'}`);
            }
            break;

        case 'device:status':
            renderESP32FleetGrid();
            break;
    }
}

function updateTelemetryDashboard(payload) {
    const speedEl = document.getElementById('metric-speed');
    const iriEl = document.getElementById('metric-iri');
    const zaccEl = document.getElementById('metric-zacc');
    const vibEl = document.getElementById('metric-vib');

    if (speedEl) speedEl.innerText = `${payload.speedKmh || 0} km/h`;
    if (iriEl) {
        iriEl.innerText = `${payload.iriEstimate ? payload.iriEstimate.toFixed(2) : '--'} m/km`;
        iriEl.style.color = payload.iriEstimate > 4.5 ? '#EF4444' : (payload.iriEstimate > 2.5 ? '#F59E0B' : '#10B981');
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

let canvasCtx = null;
function initWaveformCanvas() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    canvas.width = (canvas.clientWidth || 280) * window.devicePixelRatio;
    canvas.height = (canvas.clientHeight || 50) * window.devicePixelRatio;
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

/**
 * Autocomplete Listeners with Photon Fast Search
 */
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
            }, 180); // Fast 180ms debounce with Photon
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
            }, 180);
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

/**
 * Swapping & UI Utility Functions
 */
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

function toggleSettingsDropdown(e) {
    if (e) e.stopPropagation();
    document.getElementById('settingsMenuContainer')?.classList.toggle('open');
}

function toggleMapTheme(type) {
    AppState.activeBasemap = type;
    window.roadHealthMap.setBasemap(type);
    document.getElementById('settingsMenuContainer')?.classList.remove('open');

    // Update active badge
    document.querySelectorAll('.dropdown-item .item-badge').forEach(b => b.remove());
}

function toggleRoutePanel() {
    const panel = document.getElementById('floatingSearchCard');
    const btn = document.getElementById('tab-search');
    if (panel) {
        const isCollapsed = panel.classList.toggle('collapsed');
        btn?.classList.toggle('active', !isCollapsed);
    }
}

async function toggleHazardPins(forceState = null) {
    AppState.showHazards = forceState !== null ? forceState : !AppState.showHazards;
    const btn = document.getElementById('tab-hazards');
    btn?.classList.toggle('active', AppState.showHazards);

    const potholes = await window.roadHealthAPI.getPotholeTelemetry();
    window.roadHealthMap.renderPotholes(potholes, AppState.showHazards);
}

function toggleSensorDrawer() {
    const card = document.getElementById('iotSensorCard');
    const btn = document.getElementById('tab-sensor');
    if (card) {
        const isHidden = card.classList.toggle('hidden');
        btn?.classList.toggle('active', !isHidden);
    }
}

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
        activeBadgeEl.innerText = `● ${activeCount}/${totalCount} Nodes Connected to PostGIS`;
    }

    if (!fleet || fleet.length === 0) {
        fleetGrid.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-secondary); background: #F8FAFC; border-radius: 12px;">
                <i data-lucide="cpu" style="width: 32px; height: 32px; margin-bottom: 8px; color: var(--text-tertiary);"></i>
                <div style="font-weight: 600;">No ESP32 Devices Registered in PostGIS</div>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    fleet.forEach(node => {
        const card = document.createElement('div');
        card.className = 'esp32-node-card';
        card.innerHTML = `
            <div class="esp32-card-header">
                <div class="bike-id-group">
                    <div class="bike-plate-badge">🏍️ ${node.bikePlate}</div>
                    <div class="node-model-sub">${node.bikeModel} • ${node.riderName}</div>
                </div>
                <div class="battery-status-wrap" style="color: var(--health-good);">
                    <span>${node.batteryPct}%</span>
                </div>
            </div>
            <div style="font-size: 0.76rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
                <i data-lucide="map-pin" style="width: 13px; height: 13px; color: var(--apple-blue);"></i>
                <span>${node.location}</span>
            </div>
            <div class="esp32-anomaly-alert">
                <i data-lucide="alert-triangle" style="width: 13px; height: 13px; flex-shrink: 0;"></i>
                <span>${node.lastAnomaly}</span>
            </div>
        `;
        fleetGrid.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
}

function openAdminModal() {
    document.getElementById('settingsMenuContainer')?.classList.remove('open');
    renderESP32FleetGrid();
    document.getElementById('adminModalOverlay')?.classList.add('active');
}

function closeAdminModal() {
    document.getElementById('adminModalOverlay')?.classList.remove('active');
}

function closeAdminModalOnBackdrop(e) {
    if (e.target.id === 'adminModalOverlay') closeAdminModal();
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

function updateAdminVal(spanId, value) {
    const el = document.getElementById(spanId);
    if (el) el.innerText = value;
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

async function syncPostGISHook() {
    const res = await window.roadHealthAPI.syncPostGIS();
    alert(`PostGIS Spatial Database Diagnostics:\n\nEngine: ${res.spatialIndexStatus}\nTotal Telemetry Records: ${res.recordsSynced}\nPotholes Cataloged: ${res.potholesCount}\nActive IoT Nodes: ${res.activeNodes}`);
}

async function connectLiveBackend() {
    try {
        const data = await window.roadHealthAPI._backendFetch('/health');
        if (data && data.status === 'ok') {
            console.log('[RoadHealth] Connected to backend:', data.engine);
            const statusEl = document.getElementById('telemetry-node-status');
            const badgeEl = document.getElementById('backendBadge');
            if (statusEl) statusEl.textContent = `${data.engine} Connected`;
            if (badgeEl) badgeEl.textContent = data.databaseType === 'postgis' ? 'PostGIS 3.3' : 'SQLite WAL';
        }
    } catch (err) {
        console.warn('[RoadHealth] Backend connection error:', err.message);
    }
}

function setupEventListeners() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAdminModal();
            closeExportModal();
            document.getElementById('settingsMenuContainer')?.classList.remove('open');
        }
    });

    document.addEventListener('click', (e) => {
        const container = document.getElementById('settingsMenuContainer');
        if (container && !container.contains(e.target)) {
            container.classList.remove('open');
        }
    });
}
