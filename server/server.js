require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { init: initDb } = require('./db/database');
const { init: initWS } = require('./ws/realtimeHub');

const devicesRouter = require('./routes/devices');
const telemetryRouter = require('./routes/telemetry');
const potholesRouter = require('./routes/potholes');
const routesRouter = require('./routes/routes');

const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || './db/roadhealth_live.db';

const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));

app.use(express.static(path.join(__dirname, '..')));

app.use('/api/v1/devices', devicesRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/api/v1/potholes', potholesRouter);
app.use('/api/v1/routes', routesRouter);

app.get('/api/v1/health', (req, res) => {
    const { getClientCount } = require('./ws/realtimeHub');
    const { getEngineInfo } = require('./db/database');
    const engine = getEngineInfo();

    res.json({
        status: 'ok',
        server: 'RoadHealth IoT Backend',
        version: '2.0.0 (PostGIS & Spatial Engine)',
        engine: engine.version,
        databaseType: engine.type,
        uptime: process.uptime(),
        websocketClients: getClientCount(),
        timestamp: new Date().toISOString()
    });
});

const server = http.createServer(app);

async function startServer() {
    try {
        console.log('[Server] Connecting & initializing database...');
        const dbInfo = await initDb(DB_PATH);
        console.log(`[Server] Active Database: ${dbInfo.type.toUpperCase()} (${dbInfo.version})`);

        initWS(server);

        server.listen(PORT, () => {
            console.log('');
            console.log('  ╔══════════════════════════════════════════════════╗');
            console.log('  ║                                                  ║');
            console.log('  ║   🛣️  RoadHealth IoT & PostGIS Spatial Backend    ║');
            console.log('  ║                                                  ║');
            console.log(`  ║   HTTP API:    http://localhost:${PORT}              ║`);
            console.log(`  ║   WebSocket:   ws://localhost:${PORT}               ║`);
            console.log(`  ║   Frontend:    http://localhost:${PORT}/index.html   ║`);
            console.log(`  ║   Engine:      ${(dbInfo.version).padEnd(34)}║`);
            console.log('  ║                                                  ║');
            console.log('  ║   API Routes:                                    ║');
            console.log('  ║     GET   /api/v1/devices                        ║');
            console.log('  ║     POST  /api/v1/telemetry                      ║');
            console.log('  ║     POST  /api/v1/telemetry/simulate             ║');
            console.log('  ║     GET   /api/v1/potholes                       ║');
            console.log('  ║     GET   /api/v1/potholes/heatmap               ║');
            console.log('  ║     GET   /api/v1/potholes/export                ║');
            console.log('  ║     POST  /api/v1/routes/analyze                 ║');
            console.log('  ║     GET   /api/v1/health                         ║');
            console.log('  ║                                                  ║');
            console.log('  ╚══════════════════════════════════════════════════╝');
            console.log('');
        });
    } catch (err) {
        console.error('[Server] Critical startup error:', err);
        process.exit(1);
    }
}

startServer();
