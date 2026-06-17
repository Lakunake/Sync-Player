// memory.js — Unified persistent storage (admin fingerprint, client names, BSL matches)
// Migrated to node:sqlite database persistence for high concurrency.

const crypto = require('crypto');
const { colors } = require('./config');
const { encryptData, decryptData } = require('./security');
const db = require('./db');

// Admin fingerprint accessors (encrypted in KV store)
function getAdminFingerprint() {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'admin_fingerprint'").get();
    if (!row) return null;
    return decryptData(row.value);
  } catch (e) {
    return null;
  }
}

function setAdminFingerprint(fp) {
  const encrypted = encryptData(fp);
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('admin_fingerprint', ?)").run(encrypted);
  const hashedFp = crypto.createHash('sha256').update(fp).digest('hex').substring(0, 6);
  console.log(`${colors.green}Admin fingerprint registered: ${hashedFp}...${colors.reset}`);
}

// Client names accessors
function getClientNames() {
  const names = {};
  const rows = db.prepare("SELECT client_id, name FROM client_names").all();
  for (const row of rows) {
    names[row.client_id] = row.name;
  }
  return names;
}

function setClientName(clientId, name) {
  db.prepare("INSERT OR REPLACE INTO client_names (client_id, name) VALUES (?, ?)").run(clientId, name);
}

// BSL matches accessors
function getBslMatches() {
  const matches = {};
  const rows = db.prepare("SELECT client_id, client_file, playlist_file FROM bsl_matches").all();
  for (const row of rows) {
    if (!matches[row.client_id]) matches[row.client_id] = {};
    matches[row.client_id][row.client_file] = row.playlist_file;
  }
  return matches;
}

function setBslMatch(clientId, clientFileName, playlistFileName) {
  db.prepare("INSERT OR REPLACE INTO bsl_matches (client_id, client_file, playlist_file) VALUES (?, ?, ?)")
    .run(clientId, clientFileName, playlistFileName);
}

// Encoders accessors
function getEncoders() {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = 'encoders'").get();
    if (!row) return [];
    return JSON.parse(row.value);
  } catch {
    return [];
  }
}

function setEncoders(encoders) {
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('encoders', ?)").run(JSON.stringify(encoders));
}

// Re-expose mutable references so server.js can refresh its local copies
// SQLite handles state, but server.js caches these.
let clientDisplayNames = getClientNames();
let persistentBslMatches = getBslMatches();

function refreshClientDisplayNames() {
  clientDisplayNames = getClientNames();
  return clientDisplayNames;
}

function refreshPersistentBslMatches() {
  persistentBslMatches = getBslMatches();
  return persistentBslMatches;
}

module.exports = {
  getAdminFingerprint,
  setAdminFingerprint,
  getClientNames,
  setClientName,
  getBslMatches,
  setBslMatch,
  getEncoders,
  setEncoders,
  get clientDisplayNames() { return clientDisplayNames; },
  set clientDisplayNames(v) { clientDisplayNames = v; },
  get persistentBslMatches() { return persistentBslMatches; },
  set persistentBslMatches(v) { persistentBslMatches = v; },
  refreshClientDisplayNames,
  refreshPersistentBslMatches
};
