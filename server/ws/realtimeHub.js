/**
 * RoadHealth — Real-Time WebSocket Hub
 * 
 * Broadcasts live telemetry, pothole detections, and device status
 * to all connected dashboard clients.
 */

const WebSocket = require('ws');

let wss = null;
const clients = new Set();

/**
 * Initialize WebSocket server on an existing HTTP server
 */
function init(httpServer) {
    wss = new WebSocket.Server({ server: httpServer });

    wss.on('connection', (ws, req) => {
        clients.add(ws);
        const clientIp = req.socket.remoteAddress;
        console.log(`[WS] Client connected (${clients.size} total) from ${clientIp}`);

        // Send welcome message
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

/**
 * Broadcast an event to all connected clients
 * 
 * @param {string} event - Event name (e.g., 'telemetry:live', 'pothole:detected')
 * @param {Object} data - Event payload
 */
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
        // Only log pothole detections to avoid flooding console with telemetry
        if (event !== 'telemetry:live') {
            console.log(`[WS] Broadcast '${event}' to ${sentCount} client(s)`);
        }
    }
}

/**
 * Send live telemetry update to all dashboard clients
 */
function broadcastTelemetry(telemetryData) {
    broadcast('telemetry:live', telemetryData);
}

/**
 * Send pothole detection alert to all dashboard clients
 */
function broadcastPotholeDetection(potholeData) {
    broadcast('pothole:detected', potholeData);
}

/**
 * Send device status update to all dashboard clients
 */
function broadcastDeviceStatus(deviceData) {
    broadcast('device:status', deviceData);
}

/**
 * Get current client count
 */
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
