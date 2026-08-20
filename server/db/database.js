/**
 * RoadHealth — SQLite Database Manager (Clean Production Setup)
 * Handles schema initialization and clean pool configuration.
 * NO automatic mock device or fake pothole seeding.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;

/**
 * Initialize the database connection and run schema
 */
function init(dbPath) {
    const resolvedPath = path.resolve(dbPath || './db/roadhealth.db');
    const dbDir = path.dirname(resolvedPath);

    // Ensure the directory exists
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(resolvedPath);

    // Enable WAL mode for high-performance concurrent writes
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Run schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    console.log(`[DB] Clean SQLite database initialized at ${resolvedPath}`);

    return db;
}

/**
 * Get the active database instance
 */
function getDb() {
    if (!db) throw new Error('[DB] Database not initialized. Call init() first.');
    return db;
}

module.exports = { init, getDb };
