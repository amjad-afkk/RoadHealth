/**
 * RoadHealth — Express + WebSocket Server Entry Point
 * 
 * Starts HTTP API server and WebSocket hub for real-time telemetry.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { init: initDb } = require('./db/database');
const { init: initWS } = require('./ws/realtimeHub');

// Route modules
const devicesRouter = require('./routes/devices');
const telemetryRouter = require('./routes/telemetry');
const potholesRouter = require('./routes/potholes');
const routesRouter = require('./routes/routes');

const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || './db/roadhealth_live.db';

// Initialize Express app
const app = express();

// Middleware
app.use(cors({
    origin: '*',  // Allow all origins for development (file://, localhost, etc.)
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));

// Serve frontend static files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// API Routes
app.use('/api/v1/devices', devicesRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/api/v1/potholes', potholesRouter);
app.use('/api/v1/routes', routesRouter);

// Health check
app.get('/api/v1/health', (req, res) => {
    const { getClientCount } = require('./ws/realtimeHub');
    res.json({
        status: 'ok',
        server: 'RoadHealth IoT Backend',
        version: '1.0.0',
        uptime: process.uptime(),
        websocketClients: getClientCount(),
        timestamp: new Date().toISOString()
    });
});

// Create HTTP server and attach WebSocket
const server = http.createServer(app);

// Initialize database
console.log('[Server] Initializing database...');
initDb(DB_PATH);

// Initialize WebSocket hub
initWS(server);

// Start listening
server.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║                                                  ║');
    console.log('  ║   🛣️  RoadHealth IoT Backend                     ║');
    console.log('  ║                                                  ║');
    console.log(`  ║   HTTP API:    http://localhost:${PORT}              ║`);
    console.log(`  ║   WebSocket:   ws://localhost:${PORT}               ║`);
    console.log(`  ║   Frontend:    http://localhost:${PORT}/index.html   ║`);
    console.log('  ║                                                  ║');
    console.log('  ║   API Routes:                                    ║');
    console.log('  ║     GET  /api/v1/devices                         ║');
    console.log('  ║     POST /api/v1/telemetry                       ║');
    console.log('  ║     GET  /api/v1/potholes                        ║');
    console.log('  ║     POST /api/v1/routes/analyze                  ║');
    console.log('  ║     GET  /api/v1/health                          ║');
    console.log('  ║                                                  ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
});
