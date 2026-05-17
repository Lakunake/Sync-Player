// memory.js — Unified persistent storage (admin fingerprint, client names, BSL matches)
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { colors, ROOT_DIR, MEMORY_DIR } = require('./config');
const { encryptData, decryptData, isEncrypted } = require('./security');

// ==================== Unified Memory Storage ====================
// Admin fingerprint is encrypted, clientNames and bslMatches are plain JSON
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

// Load unified memory
// Format: { encrypted: "iv:authTag:ciphertext", clientNames: {}, bslMatches: {} }
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const rawData = fs.readFileSync(MEMORY_FILE, 'utf8');

      // Check if old fully-encrypted format (migration)
      if (isEncrypted(rawData)) {
        console.log(`${colors.yellow}Migrating from old encrypted format...${colors.reset}`);
        const decrypted = decryptData(rawData);
        const oldData = JSON.parse(decrypted);
        // Migrate to new format
        const newFormat = {
          encrypted: oldData.adminFingerprint ? encryptData(oldData.adminFingerprint) : null,
          clientNames: oldData.clientNames || {},
          bslMatches: oldData.bslMatches || {}
        };
        saveMemory(newFormat);
        console.log(`${colors.green}Migration complete${colors.reset}`);
        return newFormat;
      }

      // New JSON format
      const data = JSON.parse(rawData);
      return {
        encrypted: data.encrypted || null,
        clientNames: data.clientNames || {},
        bslMatches: data.bslMatches || {}
      };
    }

    // Check for legacy admin fingerprint file and migrate
    let encryptedFp = null;
    if (fs.existsSync(path.join(ROOT_DIR, 'admin_fingerprint.txt'))) {
      const adminFp = fs.readFileSync(path.join(ROOT_DIR, 'admin_fingerprint.txt'), 'utf8').trim();
      encryptedFp = encryptData(adminFp);
      console.log(`${colors.green}Migrated legacy admin fingerprint${colors.reset}`);
    }

    return { encrypted: encryptedFp, clientNames: {}, bslMatches: {} };
  } catch (error) {
    console.error('Error loading memory:', error);
  }
  return { encrypted: null, clientNames: {}, bslMatches: {} };
}

// Save unified memory - encrypted field for admin fp, plain for rest
function saveMemory(mem) {
  try {
    const toSave = {
      encrypted: mem.encrypted || null,
      clientNames: mem.clientNames || {},
      bslMatches: mem.bslMatches || {}
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(toSave, null, 2));
  } catch (error) {
    console.error('Error saving memory:', error);
  }
}

// Load memory at startup
let memory = loadMemory();

// Admin fingerprint accessors (encrypted)
function getAdminFingerprint() {
  if (!memory.encrypted) return null;
  try {
    return decryptData(memory.encrypted);
  } catch {
    return null;
  }
}

function setAdminFingerprint(fp) {
  memory.encrypted = encryptData(fp);
  saveMemory(memory);
  // Log hashed fingerprint for security (don't expose raw fingerprint)
  const hashedFp = crypto.createHash('sha256').update(fp).digest('hex').substring(0, 6);
  console.log(`${colors.green}Admin fingerprint registered: ${hashedFp}...${colors.reset}`);
}

// Client names accessors (plain, persisted)
let clientDisplayNames = memory.clientNames || {};

function getClientNames() {
  return clientDisplayNames;
}

function setClientName(clientId, name) {
  clientDisplayNames[clientId] = name;
  memory.clientNames = clientDisplayNames;
  saveMemory(memory);
}

// BSL matches accessors (plain, persisted)
let persistentBslMatches = memory.bslMatches || {};

function getBslMatches() {
  return persistentBslMatches;
}

function setBslMatch(clientId, clientFileName, playlistFileName) {
  if (!persistentBslMatches[clientId]) persistentBslMatches[clientId] = {};
  persistentBslMatches[clientId][clientFileName] = playlistFileName;
  memory.bslMatches = persistentBslMatches;
  saveMemory(memory);
}

// Re-expose mutable references so server.js can refresh its local copies
function refreshClientDisplayNames() {
  clientDisplayNames = memory.clientNames || {};
  return clientDisplayNames;
}

function refreshPersistentBslMatches() {
  persistentBslMatches = memory.bslMatches || {};
  return persistentBslMatches;
}

module.exports = {
  loadMemory,
  saveMemory,
  getAdminFingerprint,
  setAdminFingerprint,
  getClientNames,
  setClientName,
  getBslMatches,
  setBslMatch,
  get clientDisplayNames() { return clientDisplayNames; },
  set clientDisplayNames(v) { clientDisplayNames = v; },
  get persistentBslMatches() { return persistentBslMatches; },
  set persistentBslMatches(v) { persistentBslMatches = v; },
  refreshClientDisplayNames,
  refreshPersistentBslMatches
};
