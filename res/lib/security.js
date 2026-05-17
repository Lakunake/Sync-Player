// security.js — Ban system (honeypot), encryption, and CSRF token management
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  colors, BAN_FILE, BAN_CREDS_FILE, MEMORY_DIR,
  FFMPEG_TOOLS_PASSWORD, FFMPEG_DISABLE_BAN, FFMPEG_DISABLE_CONSEQUENCES
} = require('./config');

// ==================== Ban System (Honeypot) ====================
const bannedIpHashes = new Set();

function hashValue(val) {
  return crypto.createHash('sha256').update(String(val)).digest('hex');
}

function loadBans() {
  try {
    if (fs.existsSync(BAN_FILE)) {
      const data = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
      if (data.bans && Array.isArray(data.bans)) {
        data.bans.forEach(b => bannedIpHashes.add(b.h));
      }
    }
  } catch (e) { /* silent */ }
}

function saveBans() {
  try {
    const bans = [];
    // Read existing file to preserve full entries
    if (fs.existsSync(BAN_FILE)) {
      const data = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
      if (data.bans) bans.push(...data.bans);
    }
    fs.writeFileSync(BAN_FILE, JSON.stringify({ bans }, null, 2));
  } catch (e) { /* silent */ }
}

function banIp(ip, userAgent) {
  const hIp = hashValue(ip);
  if (bannedIpHashes.has(hIp)) return; // Already banned
  bannedIpHashes.add(hIp);
  // Append hashed entry to ban.json ONLY if persistent bans are enabled
  if (!FFMPEG_DISABLE_BAN) {
    try {
      let bans = [];
      if (fs.existsSync(BAN_FILE)) {
        const data = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
        if (data.bans) bans = data.bans;
      }
      bans.push({
        h: hIp,
        u: hashValue(userAgent || 'unknown'),
        t: new Date().toISOString(),
        r: 'ffmpeg_auth_fail'
      });
      fs.writeFileSync(BAN_FILE, JSON.stringify({ bans }, null, 2));
    } catch (e) { /* silent */ }
  }

  // Append plaintext credentials to ban-creds.json (WRITE-ONLY — server never reads this)
  try {
    let creds = [];
    if (fs.existsSync(BAN_CREDS_FILE)) {
      creds = JSON.parse(fs.readFileSync(BAN_CREDS_FILE, 'utf8'));
    }
    creds.push({
      ip: ip,
      userAgent: userAgent || 'unknown',
      timestamp: new Date().toISOString(),
      reason: 'ffmpeg_auth_fail'
    });
    fs.writeFileSync(BAN_CREDS_FILE, JSON.stringify(creds, null, 2));
  } catch (e) { /* silent */ }
}

function isIpBanned(ip) {
  return bannedIpHashes.has(hashValue(ip));
}

// Flash terminal taskbar icon orange (Windows) to alert the host
function flashTaskbar() {
  // OSC 9;4;3;100 BEL sets taskbar state to Error (Red/Orange) in Windows Terminal and ConEmu
  process.stdout.write('\x1b]9;4;3;100\x07');

  // Standard Terminal bell (BEL) — cross-platform system beep + flash
  process.stdout.write('\x07\x07\x07');

  // Reset taskbar state after 5 seconds so it doesn't stay permanently red
  setTimeout(() => {
    process.stdout.write('\x1b]9;4;0;0\x07');
  }, 5000);
}

// Load bans at startup
loadBans();

// ==================== Encryption ====================
const KEY_FILE = path.join(MEMORY_DIR, '.key');

// Get or generate encryption key (32 bytes for AES-256)
function getEncryptionKey() {
  // First, check environment variable
  if (process.env.SYNC_PLAYER_KEY) {
    // Hash the env key to ensure it's exactly 32 bytes
    return crypto.createHash('sha256').update(process.env.SYNC_PLAYER_KEY).digest();
  }

  // Check for existing key file
  if (fs.existsSync(KEY_FILE)) {
    const keyHex = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return Buffer.from(keyHex, 'hex');
  }

  // Generate new key and save it
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
  console.log(`${colors.green}Generated new encryption key for memory storage${colors.reset}`);
  return newKey;
}

const ENCRYPTION_KEY = getEncryptionKey();

// Encrypt data using AES-256-GCM
function encryptData(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

// Decrypt data using AES-256-GCM
function decryptData(encryptedData) {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// Check if data is encrypted (starts with hex IV pattern)
function isEncrypted(data) {
  // Encrypted format: 24 hex chars (IV) + ':' + 32 hex chars (authTag) + ':' + ciphertext
  return /^[a-f0-9]{24}:[a-f0-9]{32}:/.test(data);
}

// ==================== CSRF Token Management ====================
const csrfTokens = new Map(); // sessionId -> { token, expires }
const CSRF_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getOrCreateCsrfToken(sessionId) {
  const existing = csrfTokens.get(sessionId);
  if (existing && existing.expires > Date.now()) {
    return existing.token;
  }

  const token = generateCsrfToken();
  csrfTokens.set(sessionId, { token, expires: Date.now() + CSRF_TOKEN_EXPIRY });

  // Cleanup old tokens periodically
  if (csrfTokens.size > 1000) {
    const now = Date.now();
    for (const [key, val] of csrfTokens) {
      if (val.expires < now) csrfTokens.delete(key);
    }
  }

  return token;
}

function validateCsrfToken(sessionId, token) {
  const stored = csrfTokens.get(sessionId);
  if (!stored || stored.expires < Date.now()) return false;
  return stored.token === token;
}

// CSRF validation middleware for state-changing operations
function csrfProtection(req, res, next) {
  // Skip for GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const sessionId = req.cookies.sync_session;
  const token = req.headers['x-csrf-token'] || req.body?._csrf;

  if (!sessionId || !token || !validateCsrfToken(sessionId, token)) {
    console.log(`${colors.red}CSRF validation failed${colors.reset}`);
    return res.status(403).json({ error: 'CSRF token validation failed' });
  }

  next();
}

// ==================== FFmpeg Auth ====================

// Hash the password immediately on startup if it exists
let FFMPEG_TOOLS_PASSWORD_HASH = null;
if (FFMPEG_TOOLS_PASSWORD) {
  FFMPEG_TOOLS_PASSWORD_HASH = crypto.createHash('sha256').update(FFMPEG_TOOLS_PASSWORD).digest('hex');
}

// Auth middleware for FFmpeg endpoints
function verifyFfmpegAuth(req, res, next) {
  if (!FFMPEG_TOOLS_PASSWORD_HASH) {
    return res.status(403).json({ error: 'FFmpeg tools are disabled (no password set)' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(401).json({ error: 'Password required' });
  }

  const inputHash = crypto.createHash('sha256').update(password).digest('hex');
  if (inputHash !== FFMPEG_TOOLS_PASSWORD_HASH) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  next();
}

// Honeypot auth handler — returns the Express route handler function
function createFfmpegAuthHandler() {
  return (req, res) => {
    if (!FFMPEG_TOOLS_PASSWORD_HASH) {
      return res.status(403).json({ error: 'FFmpeg tools are disabled' });
    }

    const ip = req.ip || req.connection.remoteAddress;
    const ua = req.headers['user-agent'] || 'unknown';

    // If already banned, return fake success (socket stays alive but inert)
    if (isIpBanned(ip)) {
      res.json({ success: true });
      return;
    }

    const { password } = req.body;
    const inputHash = crypto.createHash('sha256').update(password || '').digest('hex');

    if (inputHash === FFMPEG_TOOLS_PASSWORD_HASH) {
      // Correct password — genuine access
      res.json({ success: true });
    } else {
      // [NEW] If consequences are disabled, abort immediately with 401
      if (FFMPEG_DISABLE_CONSEQUENCES) {
        return res.status(401).json({ success: false, error: 'Invalid password' });
      }

      // ═══════════════════════════════════════════════════════════════
      // HONEYPOT — Wrong password: ban, fake success, silent disconnect
      // ═══════════════════════════════════════════════════════════════
      // Terminal bell (BEL) — audible alert to host
      process.stdout.write('\x07\x07\x07');
      flashTaskbar();
      console.error(`\x1b[41m\x1b[37m\x1b[1m ⚠  SECURITY ALERT: FAILED FFMPEG AUTH  ⚠ \x1b[0m`);
      console.error(`\x1b[31m   IP:         ${ip}\x1b[0m`);
      console.error(`\x1b[31m   User-Agent: ${ua}\x1b[0m`);
      console.error(`\x1b[31m   Time:       ${new Date().toISOString()}\x1b[0m`);
      console.error(`\x1b[31m   Action:     BANNED + HONEYPOT ACTIVATED\x1b[0m`);
      console.error(`\x1b[41m\x1b[37m\x1b[1m ════════════════════════════════════════ \x1b[0m`);

      // Ban the IP
      banIp(ip, ua);

      // Return fake success — the attacker thinks they're in
      res.json({ success: true });
    }
  };
}

module.exports = {
  bannedIpHashes,
  hashValue,
  loadBans,
  saveBans,
  banIp,
  isIpBanned,
  flashTaskbar,
  // Encryption
  encryptData,
  decryptData,
  isEncrypted,
  // CSRF
  CSRF_TOKEN_EXPIRY,
  getOrCreateCsrfToken,
  validateCsrfToken,
  csrfProtection,
  // FFmpeg Auth
  FFMPEG_TOOLS_PASSWORD_HASH,
  verifyFfmpegAuth,
  createFfmpegAuthHandler
};
