// db.js — SQLite connection and database initialization
// Uses Node 22.5+ native node:sqlite for zero-dependency high-performance persistence

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { colors, MEMORY_DIR } = require('./config');

const DB_PATH = path.join(MEMORY_DIR, 'sync-player.db');
const isNewDb = !fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high concurrency
db.exec('PRAGMA journal_mode = WAL;');
// Foreign keys enforcement
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS client_names (
    client_id TEXT PRIMARY KEY,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS bsl_matches (
    client_id TEXT,
    client_file TEXT,
    playlist_file TEXT,
    PRIMARY KEY (client_id, client_file)
  );

  CREATE TABLE IF NOT EXISTS bans (
    ip_hash TEXT PRIMARY KEY,
    ua_hash TEXT,
    time TEXT,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS ban_creds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    user_agent TEXT,
    timestamp TEXT,
    reason TEXT
  );
`);

// Migration logic
if (isNewDb) {
  console.log(`${colors.cyan}Initializing native SQLite database...${colors.reset}`);
  
  // 1. Migrate memory.json
  const memoryFile = path.join(MEMORY_DIR, 'memory.json');
  if (fs.existsSync(memoryFile)) {
    try {
      const rawData = fs.readFileSync(memoryFile, 'utf8');
      
      // If encrypted legacy admin_fingerprint check fails, ignore here. 
      // It's mostly modern memory.json format we migrate.
      if (!rawData.includes(':')) {
        const data = JSON.parse(rawData);
        
        const insertKv = db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?)');
        if (data.encrypted) insertKv.run('admin_fingerprint', data.encrypted);
        if (data.encoders && Array.isArray(data.encoders) && data.encoders.length > 0) {
          insertKv.run('encoders', JSON.stringify(data.encoders));
        }
        
        const insertClient = db.prepare('INSERT INTO client_names (client_id, name) VALUES (?, ?)');
        for (const [clientId, name] of Object.entries(data.clientNames || {})) {
          insertClient.run(clientId, name);
        }
        
        const insertBsl = db.prepare('INSERT INTO bsl_matches (client_id, client_file, playlist_file) VALUES (?, ?, ?)');
        for (const [clientId, matches] of Object.entries(data.bslMatches || {})) {
          for (const [clientFile, playlistFile] of Object.entries(matches)) {
            insertBsl.run(clientId, clientFile, playlistFile);
          }
        }
      }
      
      fs.renameSync(memoryFile, memoryFile + '.bak');
      console.log(`${colors.green}Migrated memory.json to SQLite${colors.reset}`);
    } catch (e) {
      console.error('Failed to migrate memory.json:', e);
    }
  }

  // 2. Migrate ban.json
  const banFile = path.join(MEMORY_DIR, 'ban.json');
  if (fs.existsSync(banFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(banFile, 'utf8'));
      const insertBan = db.prepare('INSERT OR IGNORE INTO bans (ip_hash, ua_hash, time, reason) VALUES (?, ?, ?, ?)');
      for (const b of (data.bans || [])) {
        insertBan.run(b.h, b.u || 'unknown', b.t || new Date().toISOString(), b.r || 'migrated');
      }
      fs.renameSync(banFile, banFile + '.bak');
      console.log(`${colors.green}Migrated ban.json to SQLite${colors.reset}`);
    } catch (e) {
      console.error('Failed to migrate ban.json:', e);
    }
  }

  // 3. Migrate ban-creds.json
  const banCredsFile = path.join(MEMORY_DIR, 'ban-creds.json');
  if (fs.existsSync(banCredsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(banCredsFile, 'utf8'));
      const insertCred = db.prepare('INSERT INTO ban_creds (ip, user_agent, timestamp, reason) VALUES (?, ?, ?, ?)');
      for (const c of data) {
        insertCred.run(c.ip, c.userAgent || 'unknown', c.timestamp || new Date().toISOString(), c.reason || 'migrated');
      }
      fs.renameSync(banCredsFile, banCredsFile + '.bak');
      console.log(`${colors.green}Migrated ban-creds.json to SQLite${colors.reset}`);
    } catch (e) {
      console.error('Failed to migrate ban-creds.json:', e);
    }
  }
}

module.exports = db;
