/**
 * RoadHealth — Unified Database Manager (PostgreSQL + PostGIS & SQLite Fallback)
 * 
 * Automatically connects to Supabase / PostgreSQL with PostGIS when DATABASE_URL is set,
 * and seamlessly provides SQLite WAL mode fallback if no PostgreSQL is configured.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Database = require('better-sqlite3');

let pgPool = null;
let sqliteDb = null;
let dbType = 'sqlite'; // 'postgis' | 'sqlite'
let postgisVersion = null;

/**
 * Initialize database connection
 */
async function init(dbPath) {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl && databaseUrl.trim().length > 0) {
        console.log('[DB] Connecting to PostgreSQL / Supabase PostGIS...');
        try {
            pgPool = new Pool({
                connectionString: databaseUrl,
                ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
                max: 15,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000
            });

            // Test connection
            const client = await pgPool.connect();
            try {
                // Check PostGIS
                await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
                const extCheck = await client.query('SELECT postgis_version();');
                postgisVersion = extCheck.rows[0]?.postgis_version || 'PostGIS Active';
                console.log(`[DB] ✅ Connected to Supabase PostgreSQL with PostGIS (${postgisVersion})`);

                // Run PostGIS schema
                const schemaPath = path.join(__dirname, 'postgisSchema.sql');
                if (fs.existsSync(schemaPath)) {
                    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
                    await client.query(schemaSql);
                    console.log('[DB] ✅ PostGIS schema & spatial GiST indexes initialized successfully.');
                }

                dbType = 'postgis';
            } finally {
                client.release();
            }

            return { type: 'postgis', version: postgisVersion };
        } catch (err) {
            console.error('[DB] ⚠️ PostgreSQL connection failed, falling back to SQLite WAL mode:', err.message);
            pgPool = null;
        }
    }

    // Fallback to SQLite
    initSQLite(dbPath);
    return { type: 'sqlite', version: 'SQLite WAL Mode' };
}

/**
 * Initialize local SQLite fallback
 */
function initSQLite(dbPath) {
    const resolvedPath = path.resolve(dbPath || './db/roadhealth.db');
    const dbDir = path.dirname(resolvedPath);

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    sqliteDb = new Database(resolvedPath);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');

    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        sqliteDb.exec(schema);
    }

    dbType = 'sqlite';
    console.log(`[DB] ✅ SQLite WAL database active at ${resolvedPath}`);
    return sqliteDb;
}

/**
 * Check if PostGIS is the active database engine
 */
function isPostGIS() {
    return dbType === 'postgis';
}

/**
 * Get PostGIS version string or engine status
 */
function getEngineInfo() {
    return {
        type: dbType,
        version: postgisVersion || (dbType === 'postgis' ? 'PostGIS 3.4' : 'SQLite WAL'),
        isSpatial: dbType === 'postgis'
    };
}

/**
 * Execute a SQL query across either PostgreSQL or SQLite
 */
async function query(sql, params = []) {
    if (dbType === 'postgis' && pgPool) {
        // Convert named parameters or $1, $2 for Postgres
        const res = await pgPool.query(sql, params);
        return res.rows;
    } else {
        if (!sqliteDb) throw new Error('[DB] SQLite database not initialized.');
        // SQLite query
        const stmt = sqliteDb.prepare(sql);
        if (sql.trim().toUpperCase().startsWith('SELECT')) {
            return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
        } else {
            const info = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
            return [{ id: info.lastInsertRowid, changes: info.changes }];
        }
    }
}

/**
 * Synchronous SQLite handle for backward-compatibility if needed
 */
function getDb() {
    if (sqliteDb) return sqliteDb;
    // If running in PostGIS mode without sqliteDb, return a simulated interface or throw
    return {
        isPostGIS: true,
        prepare: () => {
            throw new Error('Using PostGIS mode. Please use async service methods.');
        }
    };
}

/**
 * Get raw PostgreSQL pool
 */
function getPool() {
    return pgPool;
}

module.exports = {
    init,
    getDb,
    getPool,
    query,
    isPostGIS,
    getEngineInfo
};
