const WebSocket = require('ws');

let wss = null;
const clients = new Set();

function init(httpServer) {
    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws, req) => {
        clients.add(ws);
        const clientIp = req.socket.remoteAddress;
        console.log(`[WS] Client connected (${clients.size} total) from ${clientIp}`);

        ws.send(JSON.stringify({
            event: 'connected',
            message: 'RoadHealth WebSocket connected',
            timestamp: new Date().toISOString()
        }));

        ws.on('close', () => {
            clients.delete(ws);
            console.log(`[WS] Client disconnected (${clients.size} remaining)`);
        });

        ws.on('error', (err) => {
            console.error('[WS] Client error:', err.message);
            clients.delete(ws);
        });
    });

    console.log('[WS] WebSocket hub initialized on HTTP server.');
}

function broadcast(event, data) {
    if (!wss) return;

    const message = JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString()
    });

    let sentCount = 0;
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sentCount++;
        }
    }

    if (sentCount > 0) {
        if (event !== 'telemetry:live') {
            console.log(`[WS] Broadcast '${event}' to ${sentCount} client(s)`);
        }
    }
}

function broadcastTelemetry(telemetryData) {
    broadcast('telemetry:live', telemetryData);
}

function broadcastPotholeDetection(potholeData) {
    broadcast('pothole:detected', potholeData);
}

function broadcastDeviceStatus(deviceData) {
    broadcast('device:status', deviceData);
}

function getClientCount() {
    return clients.size;
}

module.exports = {
    init,
    broadcast,
    broadcastTelemetry,
    broadcastPotholeDetection,
    broadcastDeviceStatus,
    getClientCount
};
