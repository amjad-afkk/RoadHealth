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
    if (window.lucide) {
        lucide.createIcons();
    }

    window.roadHealthMap = new RoadHealthMap('map');

    initWaveformCanvas();
    setupAutocompleteListeners();

    await connectLiveBackend();
    await loadPresetRoute('hyd_airport');

    setupEventListeners();
    startWaveformAnimation();
    connectWebSocket();
});

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

async function handleCustomRouteSearch() {
    const inOriginEl = document.getElementById('inputOrigin');
    const inDestEl = document.getElementById('inputDest');
    const inOrigin = inOriginEl?.value?.trim() || '';
    const inDest = inDestEl?.value?.trim() || '';

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
            if (geocoded && geocoded.length > 0) {
                originPt = { name: geocoded[0].shortName || inOrigin, lat: geocoded[0].lat, lng: geocoded[0].lng };
                AppState.originPoint = originPt;
                if (inOriginEl) inOriginEl.value = originPt.name;
            }
        }

        let destPt = AppState.destPoint;
        if (!destPt || destPt.name !== inDest) {
            const geocoded = await window.roadHealthAPI.geocodeAddress(inDest);
            if (geocoded && geocoded.length > 0) {
                destPt = { name: geocoded[0].shortName || inDest, lat: geocoded[0].lat, lng: geocoded[0].lng };
                AppState.destPoint = destPt;
                if (inDestEl) inDestEl.value = destPt.name;
            }
        }

        if (!originPt || !originPt.lat) {
            alert(`Could not locate origin: "${inOrigin}". Please select from suggestions or click the map.`);
            return;
        }

        if (!destPt || !destPt.lat) {
            alert(`Could not locate destination: "${inDest}". Please select from suggestions or click the map.`);
            return;
        }

        await calculateAndRenderLiveRoutes(originPt, destPt);
    } catch (err) {
        console.error('[RoadHealth] Route calculation failed:', err);
        alert('Failed to calculate route: ' + err.message);
    } finally {
        if (btnText) btnText.innerText = 'Find Safest Routes';
    }
}

function setMapPointAs(type, lat, lng) {
    if (type === 'origin') {
        const inOrigin = document.getElementById('inputOrigin');
        const name = `Point (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        if (inOrigin) inOrigin.value = name;
        AppState.originPoint = { name, lat, lng };
    } else if (type === 'dest') {
        const inDest = document.getElementById('inputDest');
        const name = `Point (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        if (inDest) inDest.value = name;
        AppState.destPoint = { name, lat, lng };
    }

    if (window.roadHealthMap && window.roadHealthMap.map) {
        window.roadHealthMap.map.closePopup();
    }

    if (AppState.originPoint && AppState.destPoint) {
        handleCustomRouteSearch();
    }
}
window.setMapPointAs = setMapPointAs;

async function calculateAndRenderLiveRoutes(origin, dest) {
    const rawRoutesList = await window.roadHealthAPI.calculateMultipleRoutesBetween(origin, dest, origin.name, dest.name);

    if (!rawRoutesList || rawRoutesList.length === 0) {
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
                    <span style="font-size: 0.72rem; color: var(--apple-blue); font-weight: 700; display: block;">Route Option ${idx + 1} ${idx === 0 ? '• Recommended (Smoothest Surface)' : ''}</span>
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

function updateFloatingSummaryCard(analyzed) {
    if (!analyzed) return;

    const etaTimeEl = document.getElementById('summaryEtaTime');
    const distEl = document.getElementById('summaryDistance');
    if (etaTimeEl) etaTimeEl.innerText = analyzed.etaFormatted || `${analyzed.baseDurationMin} min`;
    if (distEl) distEl.innerText = `(${analyzed.totalDistanceKm} km)`;

    const scorePill = document.getElementById('summaryScorePill');
    const potholeEl = document.getElementById('summaryPotholeCount');
    if (scorePill) {
        scorePill.innerText = `${analyzed.compositeScore}% Health`;
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

function speakHazardWarning(text) {
    if (!AppState.voiceAlertsEnabled || !('speechSynthesis' in window)) return;

    const now = Date.now();
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

    const critY = h * 0.35;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, critY);
    ctx.lineTo(w, critY);
    ctx.stroke();
    ctx.setLineDash([]);

    const segs = route.segments;
    const segWidth = w / (segs.length || 1);

    segs.forEach((seg, i) => {
        const iri = seg.iri || 1.2;
        const normalizedH = Math.min(h - 10, (iri / 8.0) * (h - 20) + 10);
        const x = i * segWidth;
        const y = h - normalizedH;

        const color = seg.health === 'bad' ? '#EF4444' : (seg.health === 'moderate' ? '#F59E0B' : '#10B981');

        const grad = ctx.createLinearGradient(0, y, 0, h);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(15, 23, 42, 0.8)');

        ctx.fillStyle = grad;
        ctx.fillRect(x + 2, y, segWidth - 4, normalizedH);

        ctx.fillStyle = color;
        ctx.fillRect(x + 2, y, segWidth - 4, 3);
    });
}

async function markPotholeRepaired(id) {
    const res = await window.roadHealthAPI.updatePotholeStatus(id, 'repaired', 'GHMC Road Maintenance Unit');
    if (res && res.success) {
        await toggleHazardPins(true);
        if (AppState.showHeatmap) await toggleHeatmapLayer();
        speakHazardWarning('Pothole repaired. Road surface restored.');
        if (AppState.originPoint && AppState.destPoint) {
            await calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
        }
    }
}
window.markPotholeRepaired = markPotholeRepaired;

async function flagPotholeFalsePositive(id) {
    const res = await window.roadHealthAPI.flagFalsePositive(id);
    if (res && res.success) {
        await toggleHazardPins(true);
        if (AppState.showHeatmap) await toggleHeatmapLayer();
        if (AppState.originPoint && AppState.destPoint) {
            await calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
        }
    }
}
window.flagPotholeFalsePositive = flagPotholeFalsePositive;

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
        speakHazardWarning('Simulating ESP32 patrol bike ride.');
        const container = document.getElementById('settingsMenuContainer');
        if (container) container.classList.remove('open');
    }
}

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

async function openAdminModal() {
    document.getElementById('settingsMenuContainer')?.classList.remove('open');
    const modal = document.getElementById('adminModalOverlay');
    if (modal) modal.classList.add('active');
    await refreshAdminFleet();
}
window.openAdminModal = openAdminModal;

function closeAdminModal() {
    document.getElementById('adminModalOverlay')?.classList.remove('active');
}
window.closeAdminModal = closeAdminModal;

function closeAdminModalOnBackdrop(e) {
    if (e.target.id === 'adminModalOverlay') closeAdminModal();
}
window.closeAdminModalOnBackdrop = closeAdminModalOnBackdrop;

async function refreshAdminFleet() {
    const fleet = await window.roadHealthAPI.getESP32Fleet();
    renderAdminFleetList(fleet);
}
window.refreshAdminFleet = refreshAdminFleet;

function renderAdminFleetList(devices) {
    const grid = document.getElementById('adminFleetGrid');
    const badge = document.getElementById('adminFleetCountBadge');
    if (!grid) return;

    if (!devices || devices.length === 0) {
        if (badge) {
            badge.innerText = '0 Active Nodes';
            badge.style.background = 'rgba(100, 116, 139, 0.12)';
            badge.style.color = '#64748B';
        }
        grid.innerHTML = `
            <div style="background: #F8FAFC; border: 1px dashed #CBD5E1; border-radius: 12px; padding: 24px 16px; text-align: center; color: var(--text-secondary); font-size: 0.84rem;">
                <i data-lucide="radio" style="width: 24px; height: 24px; color: #94A3B8; margin-bottom: 8px; display: inline-block;"></i>
                <div style="font-weight: 700; color: var(--text-primary); margin-bottom: 4px;">No Active Hardware Nodes Connected</div>
                <div>Power on ESP32 patrol nodes or stream live telemetry to dynamically register devices.</div>
            </div>
        `;
        if (window.lucide) lucide.createIcons();
        return;
    }

    if (badge) {
        badge.innerText = `${devices.length} Active Nodes`;
        badge.style.background = 'rgba(16, 185, 129, 0.12)';
        badge.style.color = '#10B981';
    }

    grid.innerHTML = '';

    devices.forEach(d => {
        const card = document.createElement('div');
        card.className = 'esp32-node-card';

        const isOnline = d.sensors?.status === 'Active';
        const statusColor = isOnline ? '#10B981' : '#F59E0B';

        card.innerHTML = `
            <div class="device-card-header">
                <div class="device-node-title">
                    <span style="width: 8px; height: 8px; border-radius: 50%; background: ${statusColor};"></span>
                    <span>${d.nodeId}</span>
                </div>
                <span class="device-plate-pill">${d.bikePlate}</span>
            </div>

            <div class="device-info-grid">
                <div class="device-info-item">
                    <span class="device-info-label">Live GPS Position</span>
                    <span class="device-info-val">${d.location}</span>
                </div>
                <div class="device-info-item">
                    <span class="device-info-label">Live Surface IRI</span>
                    <span class="device-info-val" style="color: ${d.telemetry?.iri >= 4.5 ? '#EF4444' : '#10B981'};">${d.telemetry?.iri ? d.telemetry.iri.toFixed(1) + ' m/km' : '1.1 m/km'}</span>
                </div>
                <div class="device-info-item">
                    <span class="device-info-label">Telemetry Status</span>
                    <span class="device-info-val">${d.lastAnomaly}</span>
                </div>
                <div class="device-info-item">
                    <span class="device-info-label">Battery Voltage</span>
                    <span class="device-info-val" style="color: #10B981;">${d.batteryPct}% (${d.batteryVoltage}V)</span>
                </div>
            </div>

            <div class="device-sensor-tags">
                <span class="sensor-tag"><i data-lucide="activity" style="width: 11px; height: 11px; color: #007AFF;"></i>MPU6500 200Hz (FreeRTOS Core 1)</span>
                <span class="sensor-tag"><i data-lucide="navigation" style="width: 11px; height: 11px; color: #10B981;"></i>NEO-6M GPS (TinyGPS++)</span>
                <span class="sensor-tag"><i data-lucide="wifi" style="width: 11px; height: 11px; color: #8B5CF6;"></i>WiFi (vivo v29)</span>
                <span class="sensor-tag"><i data-lucide="clock" style="width: 11px; height: 11px;"></i>500ms (2 Hz FreeRTOS Core 0)</span>
            </div>
        `;

        grid.appendChild(card);
    });

    if (window.lucide) lucide.createIcons();
}

async function adminClearPotholes() {
    if (!confirm('Are you sure you want to clear all potholes from the database? This will restore all road corridors to 100% clean condition.')) {
        return;
    }

    const res = await window.roadHealthAPI.clearPotholes();
    if (res && res.success) {
        await toggleHazardPins(true);
        if (AppState.showHeatmap) await toggleHeatmapLayer();
        if (AppState.originPoint && AppState.destPoint) {
            await calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
        }
        speakHazardWarning('Pothole database cleared. Roads restored.');
        alert('Potholes database cleared successfully.');
    }
}
window.adminClearPotholes = adminClearPotholes;

async function adminTriggerDecaySweep() {
    const res = await window.roadHealthAPI._backendFetch('/potholes/decay/run', { method: 'POST' });
    if (res && res.success) {
        await toggleHazardPins(true);
        if (AppState.originPoint && AppState.destPoint) {
            await calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
        }
        alert(`Decay sweep completed:\n\nActive Updated: ${res.activeUpdated}\nAuto-Expired Aged Defects: ${res.autoExpired}`);
    }
}
window.adminTriggerDecaySweep = adminTriggerDecaySweep;

let wsConnection = null;

function connectWebSocket() {
    const wsUrl = (window.location.hostname === 'roadhealth.onrender.com' || window.location.protocol === 'https:')
        ? 'wss://roadhealth.onrender.com'
        : 'ws://localhost:8000';

    try {
        wsConnection = new WebSocket(wsUrl);

        wsConnection.onopen = () => {
            const statusEl = document.getElementById('telemetry-node-status');
            if (statusEl) statusEl.textContent = 'ESP32 Live Stream Active';
        };

        wsConnection.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWebSocketMessage(msg);
            } catch (err) {
            }
        };

        wsConnection.onclose = () => {
            setTimeout(connectWebSocket, 5000);
        };
    } catch (err) {
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
                if (msg.data.potholeTrigger) {
                    toggleHazardPins(true);
                }
            }
            break;

        case 'pothole:detected':
            if (msg.data) {
                toggleHazardPins(true);
                if (window.roadHealthAPI && window.roadHealthMap) {
                    window.roadHealthAPI.getPotholeTelemetry().then(potholes => {
                        window.roadHealthMap.renderPotholes(potholes, true);
                    });
                }
                speakHazardWarning(`Warning: Pothole detected ahead with IRI ${msg.data.iri ? parseFloat(msg.data.iri).toFixed(1) : '6.0'}`);
                if (AppState.originPoint && AppState.destPoint) {
                    calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
                }
            }
            break;

        case 'pothole:repaired':
            toggleHazardPins(true);
            if (AppState.originPoint && AppState.destPoint) {
                calculateAndRenderLiveRoutes(AppState.originPoint, AppState.destPoint);
            }
            break;
    }
}

function updateTelemetryDashboard(payload) {
    const speedEl = document.getElementById('metric-speed');
    const iriEl = document.getElementById('metric-iri');
    const zaccEl = document.getElementById('metric-zacc');
    const vibEl = document.getElementById('metric-vib');
    const subAccelEl = document.getElementById('submetric-accel-xy');
    const subGyroEl = document.getElementById('submetric-gyro');
    const bannerEl = document.getElementById('potholeAlertBanner');
    const bannerText = document.getElementById('alertBannerText');
    const bannerIcon = document.getElementById('alertBannerIcon');

    const ax = payload.accel?.x ?? 0;
    const ay = payload.accel?.y ?? 0;
    const az = payload.accel?.z ?? 9.81;
    const totalMag = Math.sqrt(ax * ax + ay * ay + az * az);
    const dynamicG = Math.abs(totalMag - 9.81) / 9.81;
    const speed = payload.speedKmh ?? (payload.speed ?? 0);
    const isStationary = speed < 3.0;

    const displayIri = isStationary ? Math.min(payload.iriEstimate || 1.1, 1.2) : (payload.iriEstimate || 1.1);
    const displayVib = isStationary ? Math.min(payload.vibrationMagnitude || 0.2, 0.25) : (payload.vibrationMagnitude || 0.2);

    if (speedEl) speedEl.innerText = `${speed.toFixed(1)} km/h`;
    if (iriEl) {
        iriEl.innerText = `${displayIri.toFixed(2)} m/km`;
        iriEl.style.color = displayIri >= 4.5 ? '#EF4444' : (displayIri >= 2.5 ? '#F59E0B' : '#10B981');
    }
    if (zaccEl) zaccEl.innerText = `${az.toFixed(2)} m/s²`;
    if (vibEl) vibEl.innerText = `${displayVib.toFixed(2)}`;

    if (payload.accel && subAccelEl) {
        subAccelEl.innerText = `${ax.toFixed(2)} / ${ay.toFixed(2)} m/s²`;
    }

    if (payload.gyro && subGyroEl) {
        subGyroEl.innerText = `${payload.gyro.pitch?.toFixed(1) || '0.0'}° / ${payload.gyro.roll?.toFixed(1) || '0.0'}°`;
    }

    const isSpike = !isStationary && (payload.potholeTrigger === true || dynamicG >= 2.2);

    if (bannerEl && bannerText && bannerIcon) {
        if (isSpike) {
            bannerEl.className = 'pothole-alert-banner alert-active';
            bannerText.innerText = '🚨 POTHOLE IMPACT DETECTED (G-Spike > 2.2G)';
            bannerIcon.setAttribute('data-lucide', 'alert-triangle');
            bannerIcon.style.color = '#EF4444';
        } else {
            bannerEl.className = 'pothole-alert-banner';
            bannerText.innerText = isStationary ? 'Stationary Node / Zero Road Motion' : 'Road Surface Nominal (G-Force < 2.2G)';
            bannerIcon.setAttribute('data-lucide', isStationary ? 'pause-circle' : 'shield-check');
            bannerIcon.style.color = '#10B981';
        }
        if (window.lucide) lucide.createIcons();
    }

    const waveformVal = isStationary ? (totalMag - 9.81) : (az - 9.81);
    AppState.waveformHistory.push(waveformVal);
    if (AppState.waveformHistory.length > 50) {
        AppState.waveformHistory.shift();
    }
}

let canvasCtx = null;
function initWaveformCanvas() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    canvas.width = (canvas.clientWidth || 300) * window.devicePixelRatio;
    canvas.height = (canvas.clientHeight || 52) * window.devicePixelRatio;
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
                const y = (h / 2) - (val * 7);
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
            }, 180);
        });

        inOrigin.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                dropOrigin.classList.remove('open');
                handleCustomRouteSearch();
            }
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

        inDest.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                dropDest.classList.remove('open');
                handleCustomRouteSearch();
            }
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

function toggleSettingsDropdown(e) {
    if (e) e.stopPropagation();
    document.getElementById('settingsMenuContainer')?.classList.toggle('open');
}

function toggleMapTheme(type) {
    AppState.activeBasemap = type;
    window.roadHealthMap.setBasemap(type);
    document.getElementById('settingsMenuContainer')?.classList.remove('open');
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

async function syncPostGISHook() {
    const res = await window.roadHealthAPI.syncPostGIS();
    alert(`PostGIS Spatial Database Diagnostics:\n\nEngine: ${res.spatialIndexStatus}\nTotal Telemetry Records: ${res.recordsSynced}\nPotholes Cataloged: ${res.potholesCount}\nActive IoT Nodes: ${res.activeNodes}`);
    document.getElementById('settingsMenuContainer')?.classList.remove('open');
}

async function connectLiveBackend() {
    try {
        const data = await window.roadHealthAPI._backendFetch('/health');
        if (data && data.status === 'ok') {
            const statusEl = document.getElementById('telemetry-node-status');
            const badgeEl = document.getElementById('backendBadge');
            if (statusEl) statusEl.textContent = 'ESP32 Live Stream Active';
            if (badgeEl) badgeEl.textContent = data.databaseType === 'postgis' ? 'PostGIS 3.3' : 'SQLite WAL';
        }
    } catch (err) {
    }
}

function setupEventListeners() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
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
