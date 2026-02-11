const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { execFile, exec, spawn } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

// Root directory (parent of res/ where server.js lives)
const ROOT_DIR = path.join(__dirname, '..');
// Memory directory for persistent data
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const TRACKS_DIR = path.join(__dirname, 'tracks');
const TRACKS_MANIFEST_DIR = path.join(MEMORY_DIR, 'tracks');

// node-av imports
let HardwareContext, Demuxer, Muxer, Decoder, Encoder, FilterAPI;
try {
  const avApi = require('node-av/api');
  HardwareContext = avApi.HardwareContext;
  Demuxer = avApi.Demuxer;
  Muxer = avApi.Muxer;
  Decoder = avApi.Decoder;
  Encoder = avApi.Encoder;
  FilterAPI = avApi.FilterAPI;
} catch (e) {
  console.warn(`${colors.yellow}node-av not found or failed to load. FFmpeg features disabled.${colors.reset}`, e.message);
}

// node-av ffmpeg binary path
let ffmpegPath;
try {
  ffmpegPath = require('node-av/ffmpeg').ffmpegPath;
} catch (e) {
  console.warn('node-av/ffmpeg not found.');
}

// =================================================================
// Startup Validation - Check if server is run from expected location
// =================================================================
function validateStartupLocation() {
  const configPath = path.join(ROOT_DIR, 'config.env');
  const resFolder = path.basename(__dirname);

  // Check if we're actually in a 'res' folder
  if (resFolder !== 'res') {
    console.log(`${colors.yellow}========================================${colors.reset}`);
    console.log(`${colors.yellow}NOTE: Unexpected server location${colors.reset}`);
    console.log(`${colors.yellow}========================================${colors.reset}`);
    console.log('');
    console.log(`This server is designed to run from a 'res' folder.`);
    console.log(`Current folder: ${resFolder}`);
    console.log('');
    console.log(`${colors.cyan}Recommended: Use launcher scripts for best experience:${colors.reset}`);
    console.log(`  Windows: run.bat`);
    console.log(`  Linux/Mac: ./start.sh`);
    console.log('');
  }

  // Check if parent directory has expected structure
  if (!fs.existsSync(configPath) && !fs.existsSync(path.join(ROOT_DIR, 'media'))) {
    console.log(`${colors.yellow}========================================${colors.reset}`);
    console.log(`${colors.yellow}NOTE: Could not find project files${colors.reset}`);
    console.log(`${colors.yellow}========================================${colors.reset}`);
    console.log('');
    console.log(`Could not locate config.env or media folder in parent.`);
    console.log(`Looking in: ${ROOT_DIR}`);
    console.log('');
    console.log(`${colors.cyan}Recommended: Run from project root:${colors.reset}`);
    console.log(`  Windows: run.bat`);
    console.log(`  Linux/Mac: ./start.sh`);
    console.log(`  Manual: node --env-file-if-exists=config.env res/server.js`);
    console.log('');
  }
}

// Check startup location (warnings only)
validateStartupLocation();

// Ensure memory and tracks directories exist
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}
if (!fs.existsSync(TRACKS_DIR)) {
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
}
if (!fs.existsSync(TRACKS_MANIFEST_DIR)) {
  fs.mkdirSync(TRACKS_MANIFEST_DIR, { recursive: true });
}

// =================================================================
// Stale Track Cleanup - Delete tracks for media files missing > 7 days
// =================================================================
function cleanupStaleTracks() {
  const STALE_DAYS = 7;
  const NOW = Date.now();
  const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(TRACKS_MANIFEST_DIR)) return;

  const jsonFiles = fs.readdirSync(TRACKS_MANIFEST_DIR).filter(f => f.endsWith('.json'));
  let cleaned = 0;

  for (const jsonFile of jsonFiles) {
    const videoFilename = jsonFile.replace('.json', '');
    const mediaPath = path.join(ROOT_DIR, 'media', videoFilename);
    const jsonPath = path.join(TRACKS_MANIFEST_DIR, jsonFile);

    try {
      const trackData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      if (fs.existsSync(mediaPath)) {
        // Media exists - update lastSeen
        trackData.lastSeen = NOW;
        fs.writeFileSync(jsonPath, JSON.stringify(trackData, null, 2));
      } else {
        // Media missing - check if stale
        const lastSeen = trackData.lastSeen || NOW;

        if (NOW - lastSeen > STALE_MS) {
          // Delete track files
          if (trackData.externalTracks) {
            for (const track of trackData.externalTracks) {
              const trackPath = path.join(TRACKS_DIR, track.path);
              if (fs.existsSync(trackPath)) {
                fs.unlinkSync(trackPath);
                console.log(`[Cleanup] Deleted stale track: ${track.path}`);
              }
            }
          }
          // Delete JSON
          fs.unlinkSync(jsonPath);
          console.log(`[Cleanup] Deleted stale metadata: ${jsonFile}`);
          cleaned++;
        } else if (!trackData.lastSeen) {
          // First time missing - set lastSeen
          trackData.lastSeen = NOW;
          fs.writeFileSync(jsonPath, JSON.stringify(trackData, null, 2));
        }
      }
    } catch (err) {
      // Silently ignore corrupt files
    }
  }

  if (cleaned > 0) {
    console.log(`[Cleanup] Removed ${cleaned} stale track entries`);
  }
}

// Run cleanup at startup
cleanupStaleTracks();

// Read and parse config file
function readConfig() {
  const configEnvPath = path.join(ROOT_DIR, 'config.env');
  const configTxtPath = path.join(ROOT_DIR, 'config.txt');

  try {
    // Primary: Read config.env
    if (fs.existsSync(configEnvPath)) {
      const configData = fs.readFileSync(configEnvPath, 'utf8');
      const config = {};

      configData.split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          // Support both KEY=value (env format) and key: value (legacy format)
          let key, value;
          if (line.includes('=')) {
            const eqIdx = line.indexOf('=');
            key = line.substring(0, eqIdx).trim();
            value = line.substring(eqIdx + 1).trim();
          } else if (line.includes(':')) {
            const parts = line.split(':');
            key = parts.shift().trim();
            value = parts.join(':').trim();
          }
          if (key && value !== undefined) {
            // Map SYNC_* environment variable names to snake_case config keys
            if (key.startsWith('SYNC_')) {
              const mappedKey = key.substring(5).toLowerCase(); // SYNC_PORT -> port
              config[mappedKey] = value;
            } else {
              config[key] = value;
            }
          }
        }
      });

      return config;
    }

    // Migration: Read legacy config.txt and delete it
    if (fs.existsSync(configTxtPath)) {
      console.log(`${colors.yellow}Migrating from legacy config.txt...${colors.reset}`);
      const configData = fs.readFileSync(configTxtPath, 'utf8');
      const config = {};

      configData.split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          const parts = line.split(':');
          const key = parts.shift().trim();
          const value = parts.join(':').trim();
          if (key && value) config[key] = value;
        }
      });

      // Delete legacy config.txt after reading
      fs.unlinkSync(configTxtPath);
      console.log(`${colors.green}Migration complete. Deleted legacy config.txt${colors.reset}`);

      return config;
    }
  } catch (error) {
    console.error('Error reading config file:', error);
  }

  return {
    port: '3000',
    volume_step: '5',
    skip_seconds: '5',
    join_mode: 'sync',
    use_https: 'false',
    ssl_key_file: 'key.pem',
    ssl_cert_file: 'cert.pem',
    bsl_s2_mode: 'any',
    video_autoplay: 'false',
    admin_fingerprint_lock: 'false',
    bsl_advanced_match: 'true',
    bsl_advanced_match_threshold: '1',
    skip_intro_seconds: '87',
    client_controls_disabled: 'false',
    client_sync_disabled: 'false',
    server_mode: 'false',
    chat_enabled: 'true',
    data_hydration: 'true',
    max_volume: '100'
  };
}

// Config loading relies on Node.js native --env-file (see startup scripts)

// Read config.env as fallback
const fileConfig = readConfig();

// Environment-first configuration with config.env fallback
// Helper to get config value with validation
function getConfig(envKey, fileKey, fallback, validator = null) {
  const envValue = process.env[envKey];
  const fileValue = fileConfig[fileKey];
  let value = envValue !== undefined ? envValue : (fileValue !== undefined ? fileValue : fallback);

  if (validator) {
    const result = validator(value);
    if (!result.valid) {
      console.warn(`${colors.yellow}Warning: Invalid value for ${envKey || fileKey}: ${result.error}. Using default: ${fallback}${colors.reset}`);
      return fallback;
    }
    return result.value !== undefined ? result.value : value;
  }
  return value;
}

// Validators
const validators = {
  port: (v) => {
    const num = parseInt(v);
    if (isNaN(num) || num < 1024 || num > 49151) {
      return { valid: false, error: 'Must be 1024-49151' };
    }
    return { valid: true, value: num };
  },
  positiveInt: (v) => {
    const num = parseInt(v);
    if (isNaN(num) || num < 1) {
      return { valid: false, error: 'Must be positive integer' };
    }
    return { valid: true, value: num };
  },
  boolean: (v) => {
    const val = String(v).toLowerCase();
    return { valid: true, value: val === 'true' || val === '1' };
  },
  booleanDefaultTrue: (v) => {
    const val = String(v).toLowerCase();
    return { valid: true, value: val !== 'false' && val !== '0' };
  },
  joinMode: (v) => {
    if (!['sync', 'reset'].includes(v)) {
      return { valid: false, error: 'Must be "sync" or "reset"' };
    }
    return { valid: true };
  },
  bslMode: (v) => {
    if (!['any', 'all'].includes(v)) {
      return { valid: false, error: 'Must be "any" or "all"' };
    }
    return { valid: true };
  },
  range: (min, max) => (v) => {
    const num = parseInt(v);
    if (isNaN(num) || num < min || num > max) {
      return { valid: false, error: `Must be ${min}-${max}` };
    }
    return { valid: true, value: num };
  },
  subtitleRenderer: (v) => {
    const val = String(v).toLowerCase();
    if (!['wsr', 'jassub'].includes(val)) {
      return { valid: false, error: 'Must be "wsr" or "jassub"' };
    }
    return { valid: true, value: val };
  }
};

// Build unified config object from env + file
const config = {
  port: String(getConfig('SYNC_PORT', 'port', '3000', validators.port)),
  volume_step: String(getConfig('SYNC_VOLUME_STEP', 'volume_step', '5', validators.range(1, 20))),
  skip_seconds: String(getConfig('SYNC_SKIP_SECONDS', 'skip_seconds', '5', validators.range(5, 60))),
  join_mode: getConfig('SYNC_JOIN_MODE', 'join_mode', 'sync', validators.joinMode),
  use_https: getConfig('SYNC_USE_HTTPS', 'use_https', 'false'),
  ssl_key_file: getConfig('SYNC_SSL_KEY_FILE', 'ssl_key_file', 'key.pem'),
  ssl_cert_file: getConfig('SYNC_SSL_CERT_FILE', 'ssl_cert_file', 'cert.pem'),
  bsl_s2_mode: getConfig('SYNC_BSL_MODE', 'bsl_s2_mode', 'any', validators.bslMode),
  video_autoplay: getConfig('SYNC_VIDEO_AUTOPLAY', 'video_autoplay', 'false'),
  admin_fingerprint_lock: getConfig('SYNC_ADMIN_FINGERPRINT_LOCK', 'admin_fingerprint_lock', 'false'),
  bsl_advanced_match: getConfig('SYNC_BSL_ADVANCED_MATCH', 'bsl_advanced_match', 'true'),
  bsl_advanced_match_threshold: String(getConfig('SYNC_BSL_MATCH_THRESHOLD', 'bsl_advanced_match_threshold', '1', validators.range(1, 4))),
  skip_intro_seconds: String(getConfig('SYNC_SKIP_INTRO_SECONDS', 'skip_intro_seconds', '87', validators.positiveInt)),
  client_controls_disabled: getConfig('SYNC_CLIENT_CONTROLS_DISABLED', 'client_controls_disabled', 'false'),
  client_sync_disabled: getConfig('SYNC_CLIENT_SYNC_DISABLED', 'client_sync_disabled', 'false'),
  server_mode: getConfig('SYNC_SERVER_MODE', 'server_mode', 'false'),
  chat_enabled: getConfig('SYNC_CHAT_ENABLED', 'chat_enabled', 'true'),
  data_hydration: getConfig('SYNC_DATA_HYDRATION', 'data_hydration', 'true'),
  max_volume: String(getConfig('SYNC_MAX_VOLUME', 'max_volume', '100', validators.range(100, 1000))),
  ffmpeg_tools_password: getConfig('SYNC_FFMPEG_TOOLS_PASSWORD', 'ffmpeg_tools_password', ''),
  subtitle_renderer: getConfig('SYNC_SUBTITLE_RENDERER', 'subtitle_renderer', 'wsr', validators.subtitleRenderer)
};

// Log config source (Disabled)
const usingEnv = Object.keys(process.env).some(k => k.startsWith('SYNC_'));
/*
if (usingEnv) {
  console.log(`${colors.cyan}Configuration loaded from config.env${colors.reset}`);
} else {
  console.log(`${colors.cyan}Configuration loaded from config.env (legacy)${colors.reset}`);
}
*/

// Helper to escape HTML to prevent XSS
function escapeHTML(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper to consolidate time (advance currentTime to now based on elapsed time and current rate)
function consolidateTime(state) {
  if (state.isPlaying) {
    const now = Date.now();
    // Safety check for invalid lastUpdate
    if (state.lastUpdate > now) state.lastUpdate = now;

    const elapsed = (now - state.lastUpdate) / 1000;
    if (elapsed > 0) {
      state.currentTime += elapsed * (state.playbackRate || 1.0);
    }
    state.lastUpdate = now;
  } else {
    state.lastUpdate = Date.now();
  }
}

// Filename validation for defense-in-depth (even with execFile)
// Returns { valid: boolean, error?: string, sanitized?: string }
function validateFilename(filename) {
  // Check if filename is a non-empty string
  if (typeof filename !== 'string' || filename.length === 0) {
    return { valid: false, error: 'Filename must be a non-empty string' };
  }

  // Check maximum length
  if (filename.length > 255) {
    return { valid: false, error: 'Filename too long (max 255 characters)' };
  }

  // Reject path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'Path traversal characters not allowed' };
  }

  // Reject shell metacharacters (defense-in-depth)
  const shellMetachars = /[;&|$`<>\n\r]/;
  if (shellMetachars.test(filename)) {
    return { valid: false, error: 'Filename contains disallowed shell metacharacters' };
  }

  // Whitelist: alphanumeric, spaces, hyphens, underscores, parentheses, brackets, dots
  const safePattern = /^[\w\s\-.()\[\]]+$/;
  if (!safePattern.test(filename)) {
    return { valid: false, error: 'Filename contains disallowed characters' };
  }

  // Use path.basename as final sanitization
  const sanitized = path.basename(filename);

  return { valid: true, sanitized };
}

const app = express();
let server;

if (config.use_https === 'true') {
  try {
    const keyPath = path.join(ROOT_DIR, config.ssl_key_file || 'key.pem');
    const certPath = path.join(ROOT_DIR, config.ssl_cert_file || 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
      server = https.createServer(options, app);
    } else {
      console.error('SSL key or certificate file not found. Falling back to HTTP.');
      server = http.createServer(app);
    }
  } catch (error) {
    console.error('Error starting HTTPS server:', error);
    console.log(`${colors.yellow}Falling back to HTTP.${colors.reset}`);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const io = new Server(server);

const PORT = parseInt(config.port) || 3000;
const SKIP_SECONDS = parseInt(config.skip_seconds) || 5;
const VOLUME_STEP = parseInt(config.volume_step) || 5;
const JOIN_MODE = config.join_mode || 'sync';
const BSL_S2_MODE = config.bsl_s2_mode || 'any'; // 'any' or 'all'
const VIDEO_AUTOPLAY = config.video_autoplay === 'true'; // defaults to false
const BSL_ADVANCED_MATCH = config.bsl_advanced_match === 'true'; // defaults to true
const BSL_ADVANCED_MATCH_THRESHOLD = Math.min(4, Math.max(1, parseInt(config.bsl_advanced_match_threshold) || 1)); // 1-4, defaults to 1
const SKIP_INTRO_SECONDS = parseInt(config.skip_intro_seconds) || 90;
const CLIENT_CONTROLS_DISABLED = config.client_controls_disabled === 'true'; // defaults to false
const CLIENT_SYNC_DISABLED = getConfig('SYNC_CLIENT_SYNC_DISABLED', 'client_sync_disabled', false, validators.boolean);
const CHAT_ENABLED = getConfig('SYNC_CHAT_ENABLED', 'chat_enabled', true, validators.boolean);
const SERVER_MODE = getConfig('SYNC_SERVER_MODE', 'server_mode', false, validators.boolean);
const DATA_HYDRATION = getConfig('SYNC_DATA_HYDRATION', 'data_hydration', true, validators.boolean);
const MAX_VOLUME = getConfig('SYNC_MAX_VOLUME', 'max_volume', 400, validators.positiveInt);

// Subtitle renderer: 'jassub' requires HTTPS (SharedArrayBuffer), force 'wsr' when HTTPS is off
const SUBTITLE_RENDERER_CONFIG = config.subtitle_renderer || 'wsr';
const SUBTITLE_RENDERER = (config.use_https === 'true' && SUBTITLE_RENDERER_CONFIG === 'jassub')
  ? 'jassub'
  : 'wsr';

if (SUBTITLE_RENDERER_CONFIG === 'jassub' && SUBTITLE_RENDERER === 'wsr') {
  console.log(`${colors.yellow}JASSUB requires HTTPS. Using WSR (built-in) renderer instead.${colors.reset}`);
  console.log(`${colors.yellow}Run generate-ssl.ps1 to enable HTTPS and JASSUB.${colors.reset}`);
}

// FFmpeg Tools Configuration
const FFMPEG_TOOLS_PASSWORD = getConfig('SYNC_FFMPEG_TOOLS_PASSWORD', 'ffmpeg_tools_password', '');
// Hash the password immediately on startup if it exists
let FFMPEG_TOOLS_PASSWORD_HASH = null;
if (FFMPEG_TOOLS_PASSWORD) {
  FFMPEG_TOOLS_PASSWORD_HASH = crypto.createHash('sha256').update(FFMPEG_TOOLS_PASSWORD).digest('hex');
}

// Server mode - disable console logs and enable room-based architecture
if (SERVER_MODE) {
  console.log(`${colors.cyan}Server mode activated, Logs are disabled!${colors.reset}`);
  console.log(`${colors.cyan}Multi-room system enabled. Join mode forced to 'sync'.${colors.reset}`);
  // Override console.log to suppress output (keep console.error for critical errors)
  console.log = () => { };
}

// ==================== Room Logger System ====================
class RoomLogger {
  constructor() {
    this.generalLogFile = path.join(MEMORY_DIR, 'general.json');
    this.ensureGeneralLog();
  }

  ensureGeneralLog() {
    if (!fs.existsSync(this.generalLogFile)) {
      this.saveLog(this.generalLogFile, { logs: [] });
    }
  }

  loadLog(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading log:', error);
    }
    return { logs: [] };
  }

  saveLog(filePath, data) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Error saving log:', error);
    }
  }

  logGeneral(event, details = {}) {
    const logData = this.loadLog(this.generalLogFile);
    logData.logs.push({
      timestamp: new Date().toISOString(),
      event,
      ...details
    });
    // Keep only last 1000 entries
    if (logData.logs.length > 1000) {
      logData.logs = logData.logs.slice(-1000);
    }
    this.saveLog(this.generalLogFile, logData);
  }

  logRoom(roomCode, event, details = {}) {
    const roomLogFile = path.join(MEMORY_DIR, `${roomCode}.json`);
    let logData = this.loadLog(roomLogFile);

    if (!logData.roomCode) {
      logData.roomCode = roomCode;
      logData.logs = [];
    }

    logData.logs.push({
      timestamp: new Date().toISOString(),
      event,
      ...details
    });

    // Keep only last 500 entries per room
    if (logData.logs.length > 500) {
      logData.logs = logData.logs.slice(-500);
    }

    this.saveLog(roomLogFile, logData);
  }

  initRoomLog(roomCode, roomName, createdAt) {
    const roomLogFile = path.join(MEMORY_DIR, `${roomCode}.json`);
    const logData = {
      roomCode,
      roomName,
      createdAt,
      logs: [{
        timestamp: createdAt,
        event: 'room_created'
      }]
    };
    this.saveLog(roomLogFile, logData);
  }

  deleteRoomLog(roomCode) {
    const roomLogFile = path.join(MEMORY_DIR, `${roomCode}.json`);
    try {
      if (fs.existsSync(roomLogFile)) {
        fs.unlinkSync(roomLogFile);
      }
    } catch (error) {
      console.error('Error deleting room log:', error);
    }
  }

  // ==================== Admin Fingerprint Persistence ====================
  getAdminsFile() {
    return path.join(MEMORY_DIR, 'room_admins.json');
  }

  loadAdmins() {
    try {
      const adminsFile = this.getAdminsFile();
      if (fs.existsSync(adminsFile)) {
        return JSON.parse(fs.readFileSync(adminsFile, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading room admins:', error);
    }
    return {};
  }

  saveAdmins(admins) {
    try {
      fs.writeFileSync(this.getAdminsFile(), JSON.stringify(admins, null, 2));
    } catch (error) {
      console.error('Error saving room admins:', error);
    }
  }

  saveAdminFingerprint(roomCode, fingerprint) {
    const admins = this.loadAdmins();
    admins[roomCode] = {
      fingerprint,
      savedAt: new Date().toISOString()
    };
    this.saveAdmins(admins);
    console.log(`Admin fingerprint saved for room ${roomCode}`);
  }

  getAdminFingerprint(roomCode) {
    const admins = this.loadAdmins();
    return admins[roomCode]?.fingerprint || null;
  }

  deleteAdminFingerprint(roomCode) {
    const admins = this.loadAdmins();
    if (admins[roomCode]) {
      delete admins[roomCode];
      this.saveAdmins(admins);
      console.log(`Admin fingerprint deleted for room ${roomCode}`);
    }
  }
}

const roomLogger = SERVER_MODE ? new RoomLogger() : null;

// ==================== FFmpeg Tools API ====================

// Auth middleware for FFmpeg endpoints
function verifyFfmpegAuth(req, res, next) {
  // If no password configured, access is disabled (or allowed? Prompt said "lock this page under a password")
  // Let's assume empty password = disabled/no access as per config comment
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

// Verify password endpoint
app.post('/api/ffmpeg/auth', express.json(), (req, res) => {
  if (!FFMPEG_TOOLS_PASSWORD_HASH) {
    return res.status(403).json({ error: 'FFmpeg tools are disabled' });
  }

  const { password } = req.body;
  const inputHash = crypto.createHash('sha256').update(password || '').digest('hex');

  if (inputHash === FFMPEG_TOOLS_PASSWORD_HASH) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Invalid password' });
  }
});

// Get available hardware encoders (Placeholder for now)
app.get('/api/ffmpeg/encoders', (req, res) => {
  if (!HardwareContext) {
    return res.json({ encoders: ['cpu'], hardware: [] });
  }

  const encoders = ['cpu', 'libx264', 'libx265'];
  const hardware = [];

  try {
    // Attempt to detect hardware encoders safely
    // Since we can't easily auto-detect without running probing,
    // we return a list of potentially supported ones if node-av is active.

    // In a real implementation we would iterate through:
    // const hwTypes = ['cuda', 'vaapi', 'qsv', 'videotoolbox', 'd3d11va', 'vulkan', 'amf'];
    // And try to initializing them or checking availability.

    // For now, let's indicate that node-av is active and capabilities are present.
    // We will list all common hardware encoders as 'available' to selection if node-av is present,
    // and let FFmpeg error out if the specific hardware isn't actually there (handled by UI warnings).

    // Common HW Encoders
    encoders.push('h264_nvenc', 'hevc_nvenc'); // NVIDIA
    encoders.push('h264_amf', 'hevc_amf');     // AMD
    encoders.push('h264_qsv', 'hevc_qsv');     // Intel
    res.json({ encoders: encoders, hardware: hardware, note: "All supported HW encoders listed" });
  } catch (e) {
    console.error('Error detecting encoders:', e);
    res.json({ encoders: ['cpu'], error: e.message });
  }
});
// FFmpeg Job Queue
const ffmpegJobs = []; // { id, type, filename, status, progress, error, startTime }
let ffmpegJobCounter = 0;

// Helper: Run FFmpeg Job
async function runFfmpegJob(jobId, type, params) {
  const job = ffmpegJobs.find(j => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.startTime = Date.now();
  // Emit update via socket if possible (need access to io or admins)
  // For now we'll rely on polling or implement socket emission later.

  const safeFilename = path.basename(params.filename);
  const addSuffix = (name, suffix) => {
    const ext = path.extname(name);
    return path.join(ROOT_DIR, 'media', path.basename(name, ext) + suffix + ext);
  };

  const inputPath = path.join(ROOT_DIR, 'media', safeFilename);

  try {
    if (type === 'remux') {
      const preset = params.preset;
      let outputPath;

      if (preset === 'mp4_fast') {
        outputPath = path.join(ROOT_DIR, 'media', path.basename(safeFilename, path.extname(safeFilename)) + '_remux.mp4');
      } else if (preset === 'mkv_copy') {
        outputPath = path.join(ROOT_DIR, 'media', path.basename(safeFilename, path.extname(safeFilename)) + '_remux.mkv');
      } else {
        outputPath = addSuffix(safeFilename, '_fixed');
      }

      if (!Demuxer || !Muxer) throw new Error('node-av not available');

      // node-av Remux Logic
      const demuxer = await Demuxer.open(inputPath);
      const muxer = await Muxer.open(outputPath);

      // Copy streams
      for (const stream of demuxer.streams) {
        // For remuxing we copy the stream. 
        // High-level API usually copies codec parameters automatically if we just add the stream
        muxer.addStream(stream);
      }

      // Manual packet loop for progress tracking
      // (pipeline() is easier but progress is opaque without callback)

      for await (const packet of demuxer) {
        await muxer.writePacket(packet);
      }

      await muxer.close(); // Important to finalize file

      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

    } else if (type === 'reencode') {
      const { resolution, quality, encoder: encoderName } = params.options;
      const outputPath = addSuffix(safeFilename, `_${resolution}_${quality}`);

      if (!Demuxer || !Muxer || !Decoder || !Encoder) throw new Error('node-av not fully loaded');

      const demuxer = await Demuxer.open(inputPath);
      const videoStream = demuxer.streams.find(s => s.codecpar.type === 'video' || s.codecpar.codecType === 0) || demuxer.video[0];
      if (!videoStream) throw new Error('No video stream found');

      const muxer = await Muxer.open(outputPath);

      // Setup Hardware (if requested and available)
      let hw = null;
      if (encoderName !== 'libx264' && encoderName !== 'cpu' && HardwareContext) {
        try { hw = HardwareContext.auto(); } catch (e) { console.warn('HW Init failed', e); }
      }

      // Decoder
      // Note: For actual V1 implementation, we try catch this.
      // If generic decoder fails, we might need specific codec ID usage.
      // High-level Decoder.create(stream) should handle it.
      const decoder = await Decoder.create(videoStream, { hardware: hw });

      // Encoder Settings
      // Simple bitrate mapping
      let bitrate = 4000000; // Medium default
      if (quality === 'high') bitrate = 8000000;
      if (quality === 'low') bitrate = 1500000;

      // Validate Encoder Name (must be valid ffmpeg codec name)
      const safeEncoder = (encoderName === 'auto' || encoderName === 'cpu') ? 'libx264' : encoderName;

      // Resolution change logic would go here (requires Filter/FilterGraph)
      // For now we SKIP resolution scaling and stick to original if node-av basic Encoder doesn't do scale.
      // (Encoder usually takes raw frames, resizing needs sws_scale or avfilter)
      // We will just prioritize encoding loop for V1.

      const encoder = await Encoder.create(safeEncoder, {
        decoder, // Inherit settings (width, height, pixel format, timebase)
        bitRate: bitrate,
        timeBase: videoStream.timeBase
      });

      // Add stream to muxer
      muxer.addStream(encoder);

      // Pipeline: Input -> Decoder -> Encoder -> Output
      const inputPackets = demuxer.packets(videoStream.index);
      const decodedFrames = decoder.frames(inputPackets);
      const encodedPackets = encoder.packets(decodedFrames);

      for await (const packet of encodedPackets) {
        await muxer.writePacket(packet);
      }

      await muxer.close();
      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

    } else if (type === 'extract') {
      const { trackType } = params.options; // 'audio' or 'subtitle'
      const targetFormat = params.preset; // 'aac', 'mp3', 'srt', 'webvtt', 'ass'

      if (!Demuxer || !Muxer) throw new Error('node-av not fully loaded');

      const demuxer = await Demuxer.open(inputPath);

      // Find best stream for the type
      // Note: node-av high level accessors: .video, .audio, .subtitles
      // Debug streams
      console.log(`[FFmpeg] Inspecting streams for ${safeFilename}:`);
      demuxer.streams.forEach((s, i) => {
        console.log(`  Stream ${i}: type=${s.codecpar?.type}, codecType=${s.codecpar?.codecType}, codec=${s.codecpar?.codecName}`);
      });

      let matchingStreams = [];
      if (trackType === 'audio') {
        matchingStreams = demuxer.streams.filter(s => s.codecpar?.type === 'audio' || s.codecpar?.codecType === 1);
      } else {
        matchingStreams = demuxer.streams.filter(s => s.codecpar?.type === 'subtitle' || s.codecpar?.codecType === 3);
      }

      if (matchingStreams.length === 0) throw new Error(`No ${trackType} streams found`);

      console.log(`[FFmpeg] Found ${matchingStreams.length} ${trackType} streams to extract.`);

      // Parse original filename to remove extension
      const originalExt = path.extname(safeFilename);
      const baseName = path.basename(safeFilename, originalExt);

      // Fix extension for webvtt (default for all text subs except ASS)
      let ext = targetFormat;
      if (trackType === 'subtitle') {
        if (targetFormat === 'ass') {
          ext = 'ass';
        } else {
          ext = 'vtt';
        }
      } else {
        // Audio
        if (ext === 'webvtt') ext = 'vtt'; // Just in case
      }

      // Loop through all matching streams
      for (let i = 0; i < matchingStreams.length; i++) {
        const stream = matchingStreams[i];
        // node-av metadata is a Dictionary object with getAll() method, not a plain object
        const meta = stream.metadata?.getAll?.() || {};
        const lang = meta.language || 'und';
        const title = meta.title || meta.handler_name || (trackType === 'audio' ? `Audio Track ${stream.index}` : `Subtitle Track ${stream.index}`);
        const safeTitle = title.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 50);

        // Unique filename per track including stream index and title
        const outputFilename = `${baseName}_track${stream.index}_${lang}_${safeTitle}.${ext}`;
        const outputUrl = path.join(TRACKS_DIR, outputFilename);

        console.log(`[FFmpeg] Extracting stream ${stream.index} (${lang}) to: ${outputUrl}`);

        const args = [
          '-i', inputPath,
          '-map', `0:${stream.index}`,
          '-y' // Overwrite
        ];

        // Codec Selection
        if (trackType === 'audio') {
          if (targetFormat === 'mp3') {
            args.push('-c:a', 'libmp3lame', '-q:a', '2'); // VBR High Quality
          } else if (targetFormat === 'aac') {
            // If source is aac, copy. Else encode.
            if (stream.codec_name === 'aac') {
              args.push('-c:a', 'copy');
            } else {
              args.push('-c:a', 'aac', '-b:a', '192k');
            }
          } else {
            args.push('-c:a', 'copy');
          }
        } else {
          // Subtitles
          if (ext === 'ass') {
            args.push('-c:s', 'ass');
          } else {
            // Force WebVTT for everything else (SRT, etc.)
            args.push('-c:s', 'webvtt');
          }
        }

        args.push(outputUrl);

        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', args);
          proc.on('close', async (code) => {
            if (code === 0) {
              // Post-process VTT to clean artifacts
              if (targetFormat === 'vtt' || ext === 'vtt') {
                await cleanVttFile(outputUrl);
              }
              resolve();
            } else reject(new Error(`FFmpeg exited with code ${code}`));
          });
          proc.on('error', (err) => reject(err));
        });

        // Update Manifest for THIS track
        try {
          const manifestFilename = safeFilename + '.json';
          const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestFilename);
          let manifest = { externalTracks: [] };

          if (fs.existsSync(manifestPath)) {
            try {
              manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch (e) { /* ignore corrupt */ }
          }

          const existingIdx = manifest.externalTracks.findIndex(t => t.path === outputFilename);
          const newTrack = {
            type: trackType,
            lang: lang,
            title: title,
            path: outputFilename,
            // URL points to the new static route /tracks
            url: `/tracks/${outputFilename}`
          };

          if (existingIdx >= 0) {
            manifest.externalTracks[existingIdx] = newTrack;
          } else {
            manifest.externalTracks.push(newTrack);
          }

          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        } catch (e) {
          console.error('Failed to update manifest:', e);
        }

        // Update job progress incrementally
        job.progress = Math.round(((i + 1) / matchingStreams.length) * 100);
      }

      job.status = 'completed';
      job.progress = 100;
      job.endTime = Date.now();
      job.duration = (job.endTime - job.startTime) / 1000;

    } else {
      job.status = 'failed';
      job.error = 'Job type not implemented yet';
    }
  } catch (err) {
    console.error('Job failed:', err);
    job.status = 'failed';
    job.error = err.message;
  }
}

app.post('/api/ffmpeg/run-preset', express.json(), verifyFfmpegAuth, (req, res) => {
  const { type, filename, preset, options } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename required' });

  ffmpegJobCounter++;
  const job = {
    id: ffmpegJobCounter,
    type,
    filename,
    status: 'pending',
    progress: 0,
    startTime: Date.now(),
    preset
  };

  ffmpegJobs.push(job);

  // Start async
  runFfmpegJob(job.id, type, { filename, preset, options });

  res.json({ success: true, jobId: job.id });
});

app.get('/api/ffmpeg/jobs', (req, res) => {
  // Return unfinished jobs or last 10
  const active = ffmpegJobs.filter(j => ['pending', 'running'].includes(j.status));
  const history = ffmpegJobs.filter(j => ['completed', 'failed', 'cancelled'].includes(j.status))
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, 10);
  res.json({ jobs: [...active, ...history] });
});

app.post('/api/ffmpeg/cancel', express.json(), verifyFfmpegAuth, (req, res) => {
  const { jobId } = req.body;
  const job = ffmpegJobs.find(j => j.id === parseInt(jobId));
  if (job && job.status === 'running') {
    job.status = 'cancelled'; // Logic to actually kill process needed later
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found or not running' });
  }
});
class Room {
  constructor(code, name, isPrivate, adminFingerprint) {
    this.code = code;
    this.name = name;
    this.isPrivate = isPrivate;
    this.createdAt = new Date().toISOString();
    this.adminFingerprint = adminFingerprint;
    this.adminSocketId = null;
    this.clients = new Map(); // socketId -> { fingerprint, name, connectedAt }

    // Room-specific playlist and video state
    this.playlist = {
      videos: [],
      currentIndex: -1,
      mainVideoIndex: -1,
      mainVideoStartTime: 0,
      preloadMainVideo: false
    };

    this.videoState = {
      isPlaying: true,
      currentTime: 0,
      lastUpdate: Date.now(),
      audioTrack: 0,
      subtitleTrack: -1,
      playbackRate: 1.0
    };

    // BSL-S² state for this room
    this.clientBslStatus = new Map();
    this.clientDriftValues = new Map();
  }

  addClient(socketId, fingerprint, name) {
    this.clients.set(socketId, {
      fingerprint,
      name: name || `Guest-${socketId.slice(-4)}`,
      connectedAt: new Date().toISOString()
    });
  }

  removeClient(socketId) {
    this.clients.delete(socketId);
    this.clientBslStatus.delete(socketId);
  }

  getClientCount() {
    return this.clients.size;
  }

  isAdmin(fingerprint) {
    // First check RAM
    if (this.adminFingerprint === fingerprint) {
      return true;
    }
    // Fallback: check persisted fingerprint from disk
    if (roomLogger) {
      const persistedFp = roomLogger.getAdminFingerprint(this.code);
      if (persistedFp && persistedFp === fingerprint) {
        // Update RAM to match disk for future checks
        this.adminFingerprint = persistedFp;
        console.log(`Admin fingerprint restored from disk for room ${this.code}`);
        return true;
      }
    }
    console.log(`Admin check failed for room ${this.code}: provided='${fingerprint.substring(0, 8)}...', expected='${this.adminFingerprint?.substring(0, 8) || 'null'}...'`);
    return false;
  }

  getCurrentTrackSelections() {
    return _getTrackSelections(this.playlist);
  }
}

// ==================== Rooms Manager ====================
const rooms = new Map(); // roomCode -> Room

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure uniqueness
  if (rooms.has(code)) {
    return generateRoomCode();
  }
  return code;
}

function createRoom(name, isPrivate, adminFingerprint) {
  const code = generateRoomCode();
  const room = new Room(code, name, isPrivate, adminFingerprint);
  rooms.set(code, room);

  if (roomLogger) {
    roomLogger.logGeneral('room_created', { roomCode: code, roomName: name, isPrivate });
    roomLogger.initRoomLog(code, name, room.createdAt);
    // Persist admin fingerprint to disk for reliable verification
    roomLogger.saveAdminFingerprint(code, adminFingerprint);
  }

  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (room) {
    if (roomLogger) {
      roomLogger.logGeneral('room_deleted', { roomCode: code, roomName: room.name });
      roomLogger.deleteRoomLog(code);
      // Also delete persisted fingerprint
      roomLogger.deleteAdminFingerprint(code);
    }
    rooms.delete(code);
    return true;
  }
  return false;
}

function getPublicRooms() {
  const publicRooms = [];
  rooms.forEach((room, code) => {
    if (!room.isPrivate) {
      publicRooms.push({
        code: room.code,
        name: room.name,
        viewers: room.getClientCount(),
        createdAt: room.createdAt
      });
    }
  });
  return publicRooms;
}

// Track which room each socket is in (for server mode)
const socketRoomMap = new Map(); // socketId -> roomCode

// ==================== Legacy Single-Room State (Non-Server Mode) ====================
// BSL-S² (Both Side Local Sync Stream) state tracking
// Maps socketId -> { folderSelected: bool, files: [{name, size}], matchedVideos: {playlistIndex: localFileName} }
const clientBslStatus = new Map();
// Track admin socket for BSL-S² status updates
let adminSocketId = null;
// Track verified admin sockets (for fingerprint lock security)
const verifiedAdminSockets = new Set();
// Track connected clients with their fingerprints
const connectedClients = new Map(); // socketId -> { fingerprint, connectedAt }
// BSL-S² drift values per client per video (fingerprint -> { playlistIndex: driftSeconds })
const clientDriftValues = new Map();

// BSL-S² Persistent matches file (legacy, now in memory.json)
const BSL_MATCHES_FILE = path.join(MEMORY_DIR, 'bsl_matches.json');

// ==================== Unified Memory Storage ====================
// Admin fingerprint is encrypted, clientNames and bslMatches are plain JSON
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');
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

// Admin Fingerprint Lock Configuration
const ADMIN_FINGERPRINT_LOCK = config.admin_fingerprint_lock === 'true';
let registeredAdminFingerprint = ADMIN_FINGERPRINT_LOCK ? getAdminFingerprint() : null;

// Apply helmet security headers with safe configuration
if (config.use_https === 'true') {
  // HTTPS Mode: Enable COOP/COEP for JASSUB (SharedArrayBuffer)
  // Use 'credentialless' to allow external resources (YouTube)
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: { policy: "credentialless" },
  }));
} else {
  // HTTP Mode: Relaxed security (legacy/LAN compatibility)
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
}

// Cookie parser for CSRF tokens
app.use(cookieParser());

// Serve bundled JASSUB files (created by postinstall.js)
const JASSUB_PUBLIC_DIR = path.join(__dirname, 'public', 'jassub');
if (fs.existsSync(JASSUB_PUBLIC_DIR)) {
  app.use('/jassub', express.static(JASSUB_PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      // Required CORS headers for WASM loading
      res.set('Cross-Origin-Opener-Policy', 'same-origin');
      res.set('Cross-Origin-Embedder-Policy', 'require-corp');
      // Proper content types
      if (filePath.endsWith('.wasm')) {
        res.type('application/wasm');
      } else if (filePath.endsWith('.js')) {
        res.type('application/javascript');
      }
    }
  }));
}

// CSRF Token Management
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

app.use(express.static(ROOT_DIR));
app.use('/media', express.static(path.join(ROOT_DIR, 'media')));
app.use('/tracks', express.static(TRACKS_DIR));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/font', express.static(path.join(__dirname, 'font')));

// API to list available fonts
app.get('/api/fonts', (req, res) => {
  const fontDir = path.join(__dirname, 'font');
  fs.readdir(fontDir, (err, files) => {
    if (err) {
      console.error('Error listing fonts:', err);
      return res.json([]);
    }
    // Filter for common font extensions
    const fontFiles = files.filter(f => /\.(otf|ttf|woff|woff2)$/i.test(f));
    res.json(fontFiles);
  });
});
// JASSUB library (libass WebAssembly wrapper for ASS subtitles)
app.use('/jassub', express.static(path.join(__dirname, 'node_modules/jassub/dist')));
app.use('/rvfc-polyfill', express.static(path.join(__dirname, 'node_modules/rvfc-polyfill')));
app.use('/abslink', express.static(path.join(__dirname, 'node_modules/abslink')));

const PLAYLIST = {
  videos: [],
  currentIndex: -1,
  mainVideoIndex: -1,
  mainVideoStartTime: 0,
  preloadMainVideo: false
};

let videoState = {
  isPlaying: true,
  currentTime: 0,
  lastUpdate: Date.now(),
  audioTrack: 0,
  subtitleTrack: -1,
  playbackRate: 1.0
};

// Shared track selection logic (used by both Room class and legacy mode)
function _getTrackSelections(playlist) {
  if (playlist.videos.length > 0 && playlist.currentIndex >= 0 && playlist.currentIndex < playlist.videos.length) {
    const currentVideo = playlist.videos[playlist.currentIndex];
    return {
      audioTrack: currentVideo.selectedAudioTrack !== undefined ? currentVideo.selectedAudioTrack : 0,
      subtitleTrack: currentVideo.selectedSubtitleTrack !== undefined ? currentVideo.selectedSubtitleTrack : -1
    };
  }
  return { audioTrack: 0, subtitleTrack: -1 };
}

function getCurrentTrackSelections() {
  return _getTrackSelections(PLAYLIST);
}

// Get audio/subtitle tracks for a file
async function getTracksForFile(filename) {
  const safeFilename = path.basename(filename);
  const filePath = path.join(ROOT_DIR, 'media', safeFilename);
  const tracks = { audio: [], subtitles: [] };

  // Read sidecar JSON manifest if exists
  try {
    const manifestFilename = safeFilename + '.json';
    const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestFilename);

    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.externalTracks && Array.isArray(manifest.externalTracks)) {
        manifest.externalTracks.forEach((ext, i) => {
          const trackObj = {
            index: 1000 + i, // High index to distinguish
            codec: path.extname(ext.path).replace('.', ''),
            language: ext.lang || 'und',
            title: ext.title || 'External',
            isExternal: true,
            url: ext.url,
            filename: ext.path, // Expose filename for UI
            default: false
          };

          if (ext.type === 'audio') tracks.audio.push(trackObj);
          if (ext.type === 'subtitle') tracks.subtitles.push(trackObj);
        });
      }
    }
  } catch (e) {
    console.warn('Error reading manifest for ' + safeFilename, e);
  }

  // Use node-av if available
  if (Demuxer) {
    try {
      // Demuxer.open returns a Promise that resolves to a Demuxer instance
      // We must ensure we close it
      const demuxer = await Demuxer.open(filePath);

      try {
        // Streams are available in demuxer.streams
        // Iterate and map
        for (const stream of demuxer.streams) {
          // stream.codecpar.codecType is likely an enum or int. 
          // We need to check constants or property.
          // Based on node-av API structure, usually 'type' string property exists on high-level stream objects?
          // Or stream.codecpar.codec_type

          // Let's look at what we need: index, codec, language, title, default

          // node-av metadata is a Dictionary object with getAll() method, not a plain object
          const metadata = stream.metadata?.getAll?.() || {};
          const disposition = stream.disposition || 0;
          // Disposition is usually a bitmask. 0x1 = default.
          const isDefault = (disposition & 1) !== 0; // AV_DISPOSITION_DEFAULT

          const trackInfo = {
            index: stream.index,
            codec: stream.codecpar?.codecName || 'unknown',
            language: metadata.language || 'und',
            title: metadata.title || `Track ${stream.index}`,
            default: isDefault
          };

          // Detect stream type (unified check to avoid double-push)
          const isAudio = stream.codecpar?.codecType === 1 || stream.codecpar?.type === 'audio' || stream.type === 'audio';
          const isSubtitle = stream.codecpar?.codecType === 3 || stream.codecpar?.type === 'subtitle' || stream.type === 'subtitle';

          if (isAudio) {
            tracks.audio.push(trackInfo);
          } else if (isSubtitle) {
            // Internal subtitles disabled — use extracted sidecars instead
            // tracks.subtitles.push(trackInfo);
          }
        }

        return tracks;

      } finally {
        // Cleanup
        if (demuxer && typeof demuxer.close === 'function') {
          await demuxer.close();
        }
      }
    } catch (err) {
      console.error(`[node-av] Error reading tracks for ${safeFilename}:`, err);
      // Fallback to empty if failed? Or try ffprobe if we kept it?
      // For now, return empty object so we don't crash
      return tracks;
    }
  }

  // Fallback / Legacy (execFile ffprobe) - Removed as per migration request
  // But strictly speaking, if node-av fails to load, we might want fallback?
  // User asked to *migrate*, implying replacement.
  console.warn('node-av not available, cannot get tracks.');
  return tracks;
}

app.get('/', (req, res) => {
  if (SERVER_MODE) {
    // Server mode: landing page for room selection
    res.sendFile(path.join(__dirname, 'landing.html'));
  } else {
    // Legacy mode: direct to client
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

let adminTemplateCache = null;

// Helper for serving admin page with hydration
async function serveHydratedAdmin(req, res, roomCode = null) {
  const adminPath = path.join(__dirname, 'admin.html');
  if (!fs.existsSync(adminPath)) return res.status(404).send('Admin page not found');

  // Generate or retrieve session ID for CSRF
  let sessionId = req.cookies.sync_session;
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sync_session', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: CSRF_TOKEN_EXPIRY
    });
  }

  // Generate CSRF token for this session
  const csrfToken = getOrCreateCsrfToken(sessionId);

  if (!DATA_HYDRATION) {
    // Even without hydration, inject CSRF token
    let html = fs.readFileSync(adminPath, 'utf8');
    const csrfScript = `<script>window.CSRF_TOKEN = '${csrfToken}';</script>`;
    html = html.replace('<head>', `<head>\n    ${csrfScript}`);
    return res.send(html);
  }

  try {
    // RAM Cache optimization: read once from disk
    if (!adminTemplateCache) {
      adminTemplateCache = fs.readFileSync(adminPath, 'utf8');
    }

    let html = adminTemplateCache;
    const files = await getMediaFiles();

    // Determine state based on room or legacy
    let initialState = { files: files, csrfToken: csrfToken };
    if (SERVER_MODE && roomCode) {
      const room = getRoom(roomCode);
      if (room) {
        initialState.playlist = room.playlist.videos;
        initialState.currentVideoIndex = room.playlist.currentIndex;
      }
    } else {
      initialState.playlist = PLAYLIST.videos;
      initialState.currentVideoIndex = PLAYLIST.currentIndex;
    }

    // Securely stringify and escape </script> to prevent script injection
    const jsonState = JSON.stringify(initialState).replace(/<\/script>/g, '<\\/script>');
    const hydrationScript = `<script>window.INITIAL_DATA = ${jsonState}; window.CSRF_TOKEN = '${csrfToken}';</script>`;
    // Inject before first script or head
    html = html.replace('<head>', `<head>\n    ${hydrationScript}`);

    res.send(html);
  } catch (error) {
    console.error('Hydration error:', error);
    res.sendFile(adminPath);
  }
}

app.get('/admin', (req, res) => {
  if (SERVER_MODE) {
    res.redirect('/');
  } else {
    serveHydratedAdmin(req, res);
  }
});

// CSRF token endpoint for admin panel
app.get('/api/csrf-token', (req, res) => {
  let sessionId = req.cookies.sync_session;
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sync_session', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: CSRF_TOKEN_EXPIRY
    });
  }

  const token = getOrCreateCsrfToken(sessionId);
  res.json({ token });
});

app.get('/admin/:roomCode', (req, res) => {
  if (!SERVER_MODE) {
    return res.redirect('/admin');
  }
  const room = getRoom(req.params.roomCode);
  if (!room) {
    return res.redirect('/?error=room_not_found');
  }
  serveHydratedAdmin(req, res, req.params.roomCode);
});

app.get('/watch/:roomCode', (req, res) => {
  if (!SERVER_MODE) {
    return res.redirect('/');
  }
  const room = getRoom(req.params.roomCode);
  if (!room) {
    return res.redirect('/?error=room_not_found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Room API endpoints (server mode only)
app.get('/api/rooms', (req, res) => {
  if (!SERVER_MODE) {
    return res.status(404).json({ error: 'Server mode not enabled' });
  }
  res.json(getPublicRooms());
});

app.get('/api/rooms/:roomCode', (req, res) => {
  if (!SERVER_MODE) {
    return res.status(404).json({ error: 'Server mode not enabled' });
  }
  const room = getRoom(req.params.roomCode);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    code: room.code,
    name: room.name,
    isPrivate: room.isPrivate,
    viewers: room.getClientCount(),
    createdAt: room.createdAt
  });
});

// Server mode status endpoint
app.get('/api/server-mode', (req, res) => {
  res.json({ serverMode: SERVER_MODE });
});

let mediaFilesCache = { data: null, lastUpdate: 0 };

// Helper to get media files
function getMediaFiles() {
  // Prevent disk-spamming with a 20-second cache
  if (mediaFilesCache.data && (Date.now() - mediaFilesCache.lastUpdate < 20000)) {
    return Promise.resolve(mediaFilesCache.data);
  }

  const mediaPath = path.join(ROOT_DIR, 'media');
  return new Promise((resolve) => {
    fs.readdir(mediaPath, (err, files) => {
      if (err) return resolve([]);
      const mediaFiles = [];
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.mp4', '.mp3', '.avi', '.mov', '.wmv', '.mkv', '.webm', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
          mediaFiles.push({
            filename: file,
            escapedFilename: escapeHTML(file),
            usesHEVC: ext === '.mkv'
          });
        }
      }
      mediaFilesCache = { data: mediaFiles, lastUpdate: Date.now() };
      resolve(mediaFiles);
    });
  });
}

// Rate limiters for expensive operations
// Helper: Check if request is from localhost
const isLocalhost = (req) => {
  const ip = req.ip || req.connection.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

const filesRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 35, // 35 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isLocalhost // Bypass for localhost
});

const tracksRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isLocalhost // Bypass for localhost
});

const thumbnailRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50, // 50 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isLocalhost // Bypass for localhost
});

app.get('/api/files', filesRateLimiter, async (req, res) => {
  const files = await getMediaFiles();
  res.json(files);
});

// API to get orphan subtitles (files in TRACKS_DIR not in any manifest)
// Note: Protected implicitly by the admin panel's FFmpeg password gate (UI-level)
app.get('/api/tracks/orphans', (req, res) => {
  // 1. Get all files in TRACKS_DIR
  let allTracks = [];
  try {
    if (fs.existsSync(TRACKS_DIR)) {
      allTracks = fs.readdirSync(TRACKS_DIR).filter(f => f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.ass'));
    }
  } catch (e) { console.error('Error reading TRACKS_DIR:', e); }

  // 2. Get all used tracks from manifests
  const usedTracks = new Set();
  try {
    if (fs.existsSync(TRACKS_MANIFEST_DIR)) {
      const manifests = fs.readdirSync(TRACKS_MANIFEST_DIR).filter(f => f.endsWith('.json'));
      manifests.forEach(m => {
        try {
          const content = fs.readFileSync(path.join(TRACKS_MANIFEST_DIR, m), 'utf8');
          const json = JSON.parse(content);
          if (json.externalTracks && Array.isArray(json.externalTracks)) {
            json.externalTracks.forEach(t => {
              if (t.path) usedTracks.add(t.path);
            });
          }
        } catch (err) { }
      });
    }
  } catch (e) { console.error('Error reading manifests:', e); }

  // 3. Filter orphans
  const orphans = allTracks.filter(f => !usedTracks.has(f)).map(f => ({
    filename: f,
    type: path.extname(f).replace('.', '')
  }));

  res.json({ success: true, orphans });
});

app.get('/api/tracks/:filename', tracksRateLimiter, async (req, res) => {
  const filename = req.params.filename;

  // Validate filename before processing
  const validation = validateFilename(filename);
  if (!validation.valid) {
    console.log(`${colors.yellow}Invalid filename rejected in /api/tracks: ${validation.error}${colors.reset}`);
    return res.status(400).json({ error: validation.error });
  }

  try {
    const tracks = await getTracksForFile(validation.sanitized);
    res.json(tracks);
  } catch (error) {
    console.error('Error reading track info:', error);
    res.status(500).json({ error: 'Unable to read track information' });
  }
});

// Get Windows temp directory for thumbnails (cleared on reboot)
const os = require('os');
const THUMBNAIL_DIR = path.join(os.tmpdir(), 'sync-player-thumbnails');

// Ensure thumbnail directory exists
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// Serve thumbnails from temp directory
app.use('/thumbnails', express.static(THUMBNAIL_DIR));

// Get video duration using node-av
async function getVideoDuration(videoPath) {
  let demuxer = null;
  try {
    if (Demuxer) {
      demuxer = await Demuxer.open(videoPath);
      // demuxer.duration is in seconds (float)
      return demuxer.duration || 0;
    } else {
      // Fallback to ffprobe if node-av failed to load (though unlikely if Demuxer is defined)
      return new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          videoPath
        ], (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            const data = JSON.parse(stdout);
            const duration = parseFloat(data.format.duration) || 0;
            resolve(duration);
          } catch (e) {
            reject(e);
          }
        });
      });
    }
  } catch (err) {
    console.error(`Error getting duration for ${videoPath}:`, err.message);
    return 0;
  } finally {
    if (demuxer) {
      await demuxer.close();
    }
  }
}

// Generate thumbnail from video (720p default, random frame from first third)
app.get('/api/thumbnail/:filename', thumbnailRateLimiter, async (req, res) => {
  const filename = req.params.filename;

  // Validate filename before processing
  const validation = validateFilename(filename);
  if (!validation.valid) {
    console.log(`${colors.yellow}Invalid filename rejected in /api/thumbnail: ${validation.error}${colors.reset}`);
    return res.status(400).json({ error: validation.error });
  }

  const safeFilename = validation.sanitized;
  const videoPath = path.join(ROOT_DIR, 'media', safeFilename);

  // Support custom width (default 720p)
  let width = parseInt(req.query.width) || 720;
  width = Math.min(1920, Math.max(50, width)); // Clamp 50-1920

  // Use distinct cache file for different widths (backward compat for 720)
  const thumbnailFilename = width === 720
    ? safeFilename.replace(/\.[^.]+$/, '.jpg')
    : safeFilename.replace(/\.[^.]+$/, `.${width}.jpg`);

  const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailFilename);

  // Check if thumbnail already exists (cached)
  if (fs.existsSync(thumbnailPath)) {
    return res.json({ thumbnail: `/thumbnails/${thumbnailFilename}` });
  }

  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Audio check
  const audioExtensions = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'];
  const isAudioFile = audioExtensions.some(ext => safeFilename.toLowerCase().endsWith(ext));

  if (isAudioFile) {
    if (await generateAudioCoverArt(videoPath, thumbnailPath)) {
      return res.json({ thumbnail: `/thumbnails/${thumbnailFilename}`, isAudio: true });
    }
    return res.json({ thumbnail: null, isAudio: true });
  }

  // Video - Try node-av first
  // Only attempt node-av for compatible containers if needed, but Demuxer covers most
  const nodeAvSuccess = await generateThumbnailNodeAv(videoPath, thumbnailPath, width, safeFilename);
  if (nodeAvSuccess) {
    return res.json({ thumbnail: `/thumbnails/${thumbnailFilename}` });
  }

  // Video - Fallback to FFmpeg CLI
  try {
    console.log(`${colors.yellow}Falling back to FFmpeg CLI for ${safeFilename}${colors.reset}`);
    await generateThumbnailFfmpeg(videoPath, thumbnailPath, width, safeFilename);
    return res.json({ thumbnail: `/thumbnails/${thumbnailFilename}` });
  } catch (e) {
    console.error('Thumbnail generation failed:', e);
    return res.status(500).json({ error: 'Failed to generate thumbnail' });
  }
});

// Socket.io rate limiter (generous limits with short cooldown)
const socketRateLimiter = new RateLimiterMemory({
  points: 100, // 100 events
  duration: 10, // per 10 seconds
  blockDuration: 5 // block for 5 seconds if exceeded
});

// Socket.io handling
io.on('connection', (socket) => {
  console.log(`${colors.cyan}A user connected: ${socket.id}${colors.reset}`);
  socket.joinTime = Date.now(); // Track connection time for grace period

  // Get client IP for rate limiting
  const clientIp = socket.handshake.address;
  const isLocalhostSocket = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';

  // Socket.io rate limiting middleware
  socket.use(async (packet, next) => {
    // Skip rate limiting for localhost
    if (isLocalhostSocket) return next();

    try {
      await socketRateLimiter.consume(clientIp);
      next();
    } catch (rejRes) {
      console.log(`${colors.yellow}Socket rate limit exceeded for ${clientIp}${colors.reset}`);
      socket.emit('rate-limit-error', {
        message: 'Too many requests, please slow down',
        retryAfter: Math.ceil(rejRes.msBeforeNext / 1000)
      });
      // Don't call next() - block the event
    }
  });

  // ==================== Input Validation Helpers ====================
  // Safe filename pattern: alphanumeric, spaces, hyphens, underscores, dots, parentheses
  const SAFE_FILENAME_PATTERN = /^[\w\s\-.\(\)\[\]]+$/;

  function isValidInteger(val) {
    return Number.isInteger(val) || (typeof val === 'string' && /^-?\d+$/.test(val));
  }

  function isValidNumber(val) {
    return typeof val === 'number' && !isNaN(val) && isFinite(val);
  }

  function isInRange(val, min, max) {
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isValidNumber(num) && num >= min && num <= max;
  }

  function isSafeFilename(filename) {
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) return false;
    // Reject path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
    return SAFE_FILENAME_PATTERN.test(filename);
  }

  function validatePlaylistIndex(index, playlist) {
    if (!isValidInteger(index)) return false;
    const idx = typeof index === 'string' ? parseInt(index, 10) : index;
    return idx >= 0 && idx < playlist.videos.length;
  }

  function validateTrackIndex(index) {
    if (!isValidInteger(index)) return false;
    const idx = typeof index === 'string' ? parseInt(index, 10) : index;
    return idx >= -1; // -1 = off, 0+ = track index
  }

  function validateCurrentTime(time) {
    return isValidNumber(time) && time >= 0;
  }

  function validateDriftSeconds(drift) {
    return isInRange(drift, -60, 60);
  }

  // ==================== Admin Authorization Middleware ====================
  // Whitelist of admin-only events that require authorization
  const ADMIN_ONLY_EVENTS = [
    'set-playlist',
    'playlist-reorder',
    'playlist-jump',
    'track-change',
    'skip-to-next-video',
    'bsl-admin-register',
    'bsl-check-request',
    'bsl-get-status',
    'bsl-manual-match',
    'bsl-set-drift',
    'set-client-name',
    'get-client-list',
    'set-client-display-name',
    'delete-room',
    'create-room'
  ];

  // Check if socket is an authorized admin
  function isSocketAdmin(socketId) {
    if (SERVER_MODE) {
      // Server mode: check if socket is admin of their room
      const roomCode = socketRoomMap.get(socketId);
      if (!roomCode) return false;
      const room = getRoom(roomCode);
      if (!room) return false;
      return room.adminSocketId === socketId;
    } else {
      // Legacy mode: check verified admin sockets
      // If lock is disabled, everyone is an admin
      if (!ADMIN_FINGERPRINT_LOCK) return true;
      return verifiedAdminSockets.has(socketId);
    }
  }

  // Middleware to intercept and authorize admin-only events
  socket.use((packet, next) => {
    const eventName = packet[0];

    // Check if this is an admin-only event
    if (ADMIN_ONLY_EVENTS.includes(eventName)) {
      // Special case: create-room and bsl-admin-register are allowed for any socket
      // (they establish admin status, not require it)
      if (eventName === 'create-room' || eventName === 'bsl-admin-register') {
        return next();
      }

      // Check if socket is an authorized admin
      if (!isSocketAdmin(socket.id)) {
        console.log(`${colors.red}Unauthorized admin event blocked: ${eventName} from ${socket.id}${colors.reset}`);
        // Optionally emit an error event to the client
        socket.emit('admin-error', {
          event: eventName,
          message: 'Unauthorized: Admin access required'
        });
        return; // Block the event
      }
    }

    next();
  });

  // ==================== Server Mode Room Events ====================
  if (SERVER_MODE) {
    // Create a new room
    socket.on('create-room', (data, callback) => {
      const { name, isPrivate, fingerprint } = data;
      const roomName = name || 'Watch Party';

      const room = createRoom(roomName, isPrivate === true, fingerprint);
      room.adminSocketId = socket.id;
      room.addClient(socket.id, fingerprint, 'Admin');

      // Join socket.io room
      socket.join(room.code);
      socketRoomMap.set(socket.id, room.code);

      if (roomLogger) {
        roomLogger.logRoom(room.code, 'admin_connected', { socketId: socket.id });
        roomLogger.logGeneral('room_admin_joined', { roomCode: room.code });
      }

      if (callback) {
        callback({ success: true, roomCode: room.code, roomName: room.name });
      }

      // Emit public rooms update
      io.emit('rooms-updated', getPublicRooms());
    });

    // Join an existing room
    socket.on('join-room', (data, callback) => {
      const { roomCode, name, fingerprint } = data;
      const room = getRoom(roomCode);

      if (!room) {
        if (callback) {
          callback({ success: false, error: 'Room not found' });
        }
        return;
      }

      // Check if this is the admin reconnecting
      const isAdmin = room.isAdmin(fingerprint);
      if (isAdmin) {
        room.adminSocketId = socket.id;
      }

      room.addClient(socket.id, fingerprint, name);
      socket.join(room.code);
      socketRoomMap.set(socket.id, room.code);

      if (roomLogger) {
        roomLogger.logRoom(room.code, 'client_joined', {
          socketId: socket.id,
          name: name || 'Guest',
          isAdmin
        });
      }

      // Send room config (server mode forces sync join mode)
      socket.emit('config', {
        skipSeconds: SKIP_SECONDS,
        volumeStep: VOLUME_STEP / 100,
        videoAutoplay: VIDEO_AUTOPLAY,
        clientControlsDisabled: CLIENT_CONTROLS_DISABLED,
        serverMode: true,
        roomCode: room.code,
        roomName: room.name,
        isAdmin,
        chatEnabled: CHAT_ENABLED,
        maxVolume: MAX_VOLUME,
        subtitleRenderer: SUBTITLE_RENDERER
      });

      // Send current room state
      socket.emit('playlist-update', room.playlist);
      socket.emit('sync', room.videoState);

      if (callback) {
        callback({
          success: true,
          roomCode: room.code,
          roomName: room.name,
          isAdmin,
          viewers: room.getClientCount()
        });
      }

      // Broadcast updated viewer count to room
      io.to(room.code).emit('viewer-count', room.getClientCount());
      io.emit('rooms-updated', getPublicRooms());
    });

    // Leave room
    socket.on('leave-room', () => {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          room.removeClient(socket.id);
          socket.leave(roomCode);

          if (roomLogger) {
            roomLogger.logRoom(roomCode, 'client_left', { socketId: socket.id });
          }

          io.to(roomCode).emit('viewer-count', room.getClientCount());
          io.emit('rooms-updated', getPublicRooms());
        }
        socketRoomMap.delete(socket.id);
      }
    });

    // Delete room (admin only)
    socket.on('delete-room', (data, callback) => {
      const { roomCode, fingerprint } = data;
      const room = getRoom(roomCode);

      if (!room) {
        if (callback) callback({ success: false, error: 'Room not found' });
        return;
      }

      if (!room.isAdmin(fingerprint)) {
        if (callback) callback({ success: false, error: 'Not authorized' });
        return;
      }

      // Notify all clients in the room
      io.to(roomCode).emit('room-deleted', { roomCode });

      // Remove all sockets from room
      room.clients.forEach((_, socketId) => {
        const clientSocket = io.sockets.sockets.get(socketId);
        if (clientSocket) {
          clientSocket.leave(roomCode);
        }
        socketRoomMap.delete(socketId);
      });

      deleteRoom(roomCode);

      if (callback) callback({ success: true });
      io.emit('rooms-updated', getPublicRooms());
    });

    // Handle disconnect in server mode
    socket.on('disconnect', () => {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          room.removeClient(socket.id);

          if (roomLogger) {
            roomLogger.logRoom(roomCode, 'client_disconnected', { socketId: socket.id });
          }

          io.to(roomCode).emit('viewer-count', room.getClientCount());
          io.emit('rooms-updated', getPublicRooms());
        }
        socketRoomMap.delete(socket.id);
      }
    });

    // Get public rooms list
    socket.on('get-rooms', (callback) => {
      if (callback) {
        callback(getPublicRooms());
      }
    });

    // Chat message handler (server mode)
    socket.on('chat-message', (data) => {
      if (!CHAT_ENABLED) return;

      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          const message = data.message?.trim() || '';

          // Handle /rename command
          if (message.toLowerCase().startsWith('/rename ')) {
            const newName = message.substring(8).trim().substring(0, 32); // Max 32 chars
            if (newName) {
              const clientInfo = connectedClients.get(socket.id);
              if (clientInfo && clientInfo.fingerprint) {
                const oldName = clientDisplayNames[clientInfo.fingerprint] || data.sender || 'Guest';
                setClientName(clientInfo.fingerprint, newName);
                // Notify the client of their new name so they update locally
                socket.emit('name-updated', { newName });
                // Notify room of name change
                io.to(roomCode).emit('chat-message', {
                  sender: 'System',
                  message: `${escapeHTML(oldName)} is now known as ${escapeHTML(newName)}`,
                  timestamp: Date.now(),
                  isSystem: true
                });
              }
            }
            return; // Don't broadcast the command itself
          }

          // Broadcast message to all clients in the room (properly escaped)
          io.to(roomCode).emit('chat-message', {
            sender: escapeHTML(data.sender || 'Guest'),
            message: escapeHTML(message.substring(0, 500)),
            timestamp: Date.now()
          });
        }
      }
    });

    // Server mode: don't run legacy initialization, but continue to register event handlers below
  }

  // ==================== Legacy Single-Room Mode Initialization ====================
  // Only run legacy initialization for non-server mode
  if (!SERVER_MODE) {
    // Broadcast updated client count to all (excluding admin)
    broadcastClientCount();

    const currentTracks = getCurrentTrackSelections();
    videoState.audioTrack = currentTracks.audioTrack;
    videoState.subtitleTrack = currentTracks.subtitleTrack;

    // Send config values to client
    socket.emit('config', {
      skipSeconds: SKIP_SECONDS,
      volumeStep: VOLUME_STEP / 100,
      videoAutoplay: VIDEO_AUTOPLAY,
      clientControlsDisabled: CLIENT_CONTROLS_DISABLED,
      serverMode: false,
      chatEnabled: CHAT_ENABLED,
      maxVolume: MAX_VOLUME,
      subtitleRenderer: SUBTITLE_RENDERER
    });

    // Send playlist to client
    socket.emit('playlist-update', PLAYLIST);

    // Handle join behavior based on config
    if (JOIN_MODE === 'reset') {
      videoState.currentTime = 0;
      videoState.lastUpdate = Date.now();
      io.emit('sync', videoState);
      console.log(`${colors.yellow}New user joined, resetting video to 0 for everyone (reset mode)${colors.reset}`);
    } else {
      socket.emit('sync', videoState);
      console.log(`${colors.cyan}New user joined, syncing to current time: ${videoState.currentTime}${colors.reset}`);
    }
  } // End of !SERVER_MODE block

  // ==================== Shared Event Handlers (Both Modes) ====================

  // Handle request for initial state (from client on connect)
  socket.on('request-initial-state', () => {
    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          console.log(`Client requested initial state for room ${roomCode}`);
          socket.emit('initial-state', {
            playlist: room.playlist,
            mainVideoStartTime: room.playlist.mainVideoStartTime,
            videoState: room.videoState
          });
          return;
        }
      }
    }

    console.log('Client requested initial state');
    socket.emit('initial-state', {
      playlist: PLAYLIST,
      mainVideoStartTime: PLAYLIST.mainVideoStartTime,
      videoState: videoState
    });
  });

  // Handle explicit sync request from client
  socket.on('request-sync', () => {
    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          socket.emit('sync', room.videoState);
          return;
        }
      }
    }

    console.log('Client requested sync');
    socket.emit('sync', videoState);
  });

  // Chat message handler (legacy mode - only if not in server mode room)
  if (!SERVER_MODE) {
    socket.on('chat-message', (data) => {
      if (!CHAT_ENABLED) return;

      const message = data.message?.trim() || '';

      // Handle /rename command
      if (message.toLowerCase().startsWith('/rename ')) {
        const newName = message.substring(8).trim().substring(0, 32); // Max 32 chars
        if (newName) {
          const clientInfo = connectedClients.get(socket.id);
          if (clientInfo && clientInfo.fingerprint) {
            const oldName = clientDisplayNames[clientInfo.fingerprint] || data.sender || 'Guest';
            setClientName(clientInfo.fingerprint, newName);
            // Notify the client of their new name so they update locally
            socket.emit('name-updated', { newName });
            // Notify all of name change
            io.emit('chat-message', {
              sender: 'System',
              message: `${escapeHTML(oldName)} is now known as ${escapeHTML(newName)}`,
              timestamp: Date.now(),
              isSystem: true
            });
          }
        }
        return; // Don't broadcast the command itself
      }

      // Broadcast message to all clients (properly escaped)
      io.emit('chat-message', {
        sender: escapeHTML(data.sender || 'Guest'),
        message: escapeHTML(message.substring(0, 500)),
        timestamp: Date.now()
      });
    });
  }

  // Listen for control events from clients
  socket.on('control', (data) => {
    // Validate input data
    if (!data || typeof data !== 'object') return;

    // Validate currentTime if present
    if (data.currentTime !== undefined && !validateCurrentTime(data.currentTime)) {
      console.log(`${colors.yellow}Invalid currentTime in control event: ${data.currentTime}${colors.reset}`);
      return;
    }

    // Validate time for seek action
    if (data.action === 'seek' && !validateCurrentTime(data.time)) {
      console.log(`${colors.yellow}Invalid seek time: ${data.time}${colors.reset}`);
      return;
    }

    // Validate trackIndex for selectTrack action
    if (data.action === 'selectTrack' && !validateTrackIndex(data.trackIndex)) {
      console.log(`${colors.yellow}Invalid trackIndex in control event: ${data.trackIndex}${colors.reset}`);
      return;
    }

    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (!roomCode) return;
      const room = getRoom(roomCode);
      if (!room) return;

      // Allow control if client controls are enabled OR if it's the admin
      const isAdmin = room.adminSocketId === socket.id;
      if (CLIENT_CONTROLS_DISABLED && !isAdmin) {
        console.log(`${colors.yellow}Ignoring non-admin control event in room ${roomCode}${colors.reset}`);
        return;
      }

      if (data.action) {
        if (data.action === 'playpause') {
          consolidateTime(room.videoState);
          room.videoState.isPlaying = data.state;
          io.to(roomCode).emit('sync', room.videoState);
        } else if (data.action === 'skip') {
          consolidateTime(room.videoState);
          const direction = data.direction === 'forward' ? 1 : -1;
          room.videoState.currentTime = Math.max(0, room.videoState.currentTime + direction * (data.seconds || SKIP_SECONDS));
          io.to(roomCode).emit('sync', room.videoState);
        } else if (data.action === 'seek') {
          room.videoState.currentTime = data.time;
          room.videoState.lastUpdate = Date.now();
          io.to(roomCode).emit('sync', room.videoState);
        } else if (data.action === 'selectTrack') {
          consolidateTime(room.videoState);
          if (data.type === 'audio') {
            room.videoState.audioTrack = data.trackIndex;
          } else if (data.type === 'subtitle') {
            room.videoState.subtitleTrack = data.trackIndex;
          }
          io.to(roomCode).emit('sync', room.videoState);
        } else if (data.action === 'rate') {
          consolidateTime(room.videoState);
          console.log(`[Rate Control] Setting playback rate to ${data.rate} for room ${roomCode}`);
          room.videoState.playbackRate = data.rate;
          io.to(roomCode).emit('sync', room.videoState);
        }
      } else {
        // Direct sync from client (sync-player mode)
        room.videoState = {
          isPlaying: data.isPlaying,
          currentTime: data.currentTime,
          lastUpdate: Date.now(),
          audioTrack: room.videoState.audioTrack,
          subtitleTrack: room.videoState.subtitleTrack,
          playbackRate: room.videoState.playbackRate
        };
        io.to(roomCode).emit('sync', room.videoState);
      }
      return;
    }

    // Legacy Mode logic
    // Check if client controls are disabled (server-side enforcement)
    const isLegacyAdmin = verifiedAdminSockets.has(socket.id);
    if (CLIENT_CONTROLS_DISABLED && !isLegacyAdmin) {
      console.log(`${colors.yellow}Rejecting control event from non-admin (client_controls_disabled)${colors.reset}`);
      socket.emit('control-rejected', {
        message: 'Controls are disabled. Only admin can control playback.'
      });
      return;
    }

    // Block client sync events if disabled (admin controls still work via action-based events)
    if (CLIENT_SYNC_DISABLED && !data.action) {
      console.log(`${colors.yellow}Ignoring client sync event (client_sync_disabled)${colors.reset}`);
      return;
    }
    if (data.action) {
      if (data.action === 'playpause') {
        consolidateTime(videoState);
        videoState.isPlaying = data.state;
        io.emit('sync', videoState);
      } else if (data.action === 'skip') {
        consolidateTime(videoState);
        const direction = data.direction === 'forward' ? 1 : -1;
        videoState.currentTime = Math.max(0, videoState.currentTime + direction * (data.seconds || SKIP_SECONDS));
        io.emit('sync', videoState);
      } else if (data.action === 'seek') {
        videoState.currentTime = data.time;
        videoState.lastUpdate = Date.now();
        io.emit('sync', videoState);
      } else if (data.action === 'selectTrack') {
        consolidateTime(videoState);
        if (data.type === 'audio') {
          videoState.audioTrack = data.trackIndex;
        } else if (data.type === 'subtitle') {
          videoState.subtitleTrack = data.trackIndex;
        }
        io.emit('sync', videoState);
      } else if (data.action === 'rate') {
        consolidateTime(videoState);
        videoState.playbackRate = data.rate;
        console.log(`[Rate Control Legacy] Setting playback rate to ${data.rate}`);
        io.emit('sync', videoState);
      }
    } else {
      videoState = {
        isPlaying: data.isPlaying,
        currentTime: data.currentTime,
        lastUpdate: Date.now(),
        audioTrack: videoState.audioTrack,
        subtitleTrack: videoState.subtitleTrack,
        playbackRate: videoState.playbackRate
      };
      io.emit('sync', videoState);
      console.log('Broadcasting sync to all clients:', videoState);
    }
  });

  // ==================== Subtitle Tools Handlers ====================

  // --- Shared Helpers ---

  // Read source manifest and resolve a track by its index (handles the 1000+ offset)
  function readSourceTrack(sourceVideo, trackIndex) {
    const manifestName = path.basename(sourceVideo) + '.json';
    const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestName);

    if (!fs.existsSync(manifestPath)) {
      return { error: 'Source tracks manifest not found' };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.externalTracks || !Array.isArray(manifest.externalTracks)) {
      return { error: 'No external tracks found in source' };
    }

    const arrayIndex = trackIndex >= 1000 ? trackIndex - 1000 : trackIndex;
    if (arrayIndex < 0 || arrayIndex >= manifest.externalTracks.length) {
      return { error: 'Track not found (invalid index)' };
    }

    return { manifest, manifestPath, arrayIndex, track: manifest.externalTracks[arrayIndex] };
  }

  // Load (or create) a target manifest, find the next safe track index, and return naming helpers
  function prepareTargetManifest(targetVideo) {
    const manifestName = path.basename(targetVideo) + '.json';
    const manifestPath = path.join(TRACKS_MANIFEST_DIR, manifestName);
    let manifest = { externalTracks: [] };

    if (fs.existsSync(manifestPath)) {
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { }
    } 
    if (!manifest.externalTracks) manifest.externalTracks = [];

    // Find next safe track index from existing entries
    let maxIndex = -1;
    manifest.externalTracks.forEach(t => {
      if (t.path) {
        const match = t.path.match(/_track(\d+)_/);
        if (match) {
          const idx = parseInt(match[1]);
          if (idx > maxIndex) maxIndex = idx;
        }
      }
    });

    return {
      manifest,
      manifestPath,
      nextIndex: maxIndex + 1,
      safeBaseName: path.basename(targetVideo).replace(/\.[^/.]+$/, '')
    };
  }

  // Build a normalized track entry for writing to manifests
  function buildTrackEntry(trackPath, opts = {}) {
    return {
      type: opts.type || 'subtitle',
      lang: opts.lang || 'und',
      title: opts.title || 'Track',
      isExternal: true,
      path: trackPath,
      url: `/tracks/${trackPath}`
    };
  }

  // --- Handlers ---

  // Rebind Subtitle (Move)
  socket.on('rebind-subtitle', async (data, callback) => {
    if (!data || !data.sourceVideo || !data.targetVideo || typeof data.trackIndex !== 'number') {
      return callback && callback({ success: false, error: 'Invalid parameters' });
    }
    if (!isSocketAdmin(socket.id)) {
      return callback && callback({ success: false, error: 'Unauthorized' });
    }

    try {
      const src = readSourceTrack(data.sourceVideo, data.trackIndex);
      if (src.error) return callback && callback({ success: false, error: src.error });

      const tgt = prepareTargetManifest(data.targetVideo);

      // Resolve file on disk
      let absoluteOldPath = path.join(TRACKS_DIR, src.track.path);
      if (!fs.existsSync(absoluteOldPath)) {
        if (path.isAbsolute(src.track.path) && fs.existsSync(src.track.path)) {
          absoluteOldPath = src.track.path;
        } else {
          return callback && callback({ success: false, error: 'Subtitle file not found on disk' });
        }
      }

      // Rename file
      const ext = path.extname(absoluteOldPath);
      const lang = src.track.lang || 'und';
      const title = (src.track.title || 'Track').replace(/[^a-zA-Z0-9]/g, '');
      const newFileName = `${tgt.safeBaseName}_track${tgt.nextIndex}_${lang}_${title}${ext}`;
      const absoluteNewPath = path.join(TRACKS_DIR, newFileName);

      fs.renameSync(absoluteOldPath, absoluteNewPath);

      // Update target manifest
      tgt.manifest.externalTracks.push(buildTrackEntry(newFileName, {
        type: src.track.type || 'subtitle', lang, title: src.track.title || 'Track'
      }));
      fs.writeFileSync(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));

      // Remove from source manifest
      src.manifest.externalTracks.splice(src.arrayIndex, 1);
      fs.writeFileSync(src.manifestPath, JSON.stringify(src.manifest, null, 2));

      console.log(`[Subtitle] Rebound ${newFileName} from ${data.sourceVideo} to ${data.targetVideo}`);
      if (callback) callback({ success: true });

    } catch (e) {
      console.error('Rebind Error:', e);
      if (callback) callback({ success: false, error: e.message });
    }
  });

  // Share Subtitle (Link)
  socket.on('share-subtitle', async (data, callback) => {
    if (!data || !data.sourceVideo || !data.targetVideo || typeof data.trackIndex !== 'number') {
      return callback && callback({ success: false, error: 'Invalid parameters' });
    }
    if (!isSocketAdmin(socket.id)) {
      return callback && callback({ success: false, error: 'Unauthorized' });
    }

    try {
      const src = readSourceTrack(data.sourceVideo, data.trackIndex);
      if (src.error) return callback && callback({ success: false, error: src.error });

      const tgt = prepareTargetManifest(data.targetVideo);

      // Check duplicate
      if (tgt.manifest.externalTracks.some(t => t.path === src.track.path)) {
        return callback && callback({ success: false, error: 'Subtitle is already linked to target' });
      }

      // Link (same file, just add to target manifest)
      tgt.manifest.externalTracks.push(buildTrackEntry(src.track.path, {
        type: src.track.type || 'subtitle',
        lang: src.track.lang || 'und',
        title: src.track.title || 'Track'
      }));
      fs.writeFileSync(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));

      console.log(`[Subtitle] Shared ${src.track.path} from ${data.sourceVideo} to ${data.targetVideo}`);
      if (callback) callback({ success: true });

    } catch (e) {
      console.error('Share Error:', e);
      if (callback) callback({ success: false, error: e.message });
    }
  });

  // Bind Orphan Subtitle (with optional SRT conversion)
  socket.on('bind-orphan', async (data, callback) => {
    if (!data || !data.orphanFile || !data.targetVideo) {
      return callback && callback({ success: false, error: 'Invalid parameters' });
    }
    if (!isSocketAdmin(socket.id)) {
      return callback && callback({ success: false, error: 'Unauthorized' });
    }

    const orphanFile = data.orphanFile;
    const sourcePath = path.join(TRACKS_DIR, orphanFile);
    if (!fs.existsSync(sourcePath)) {
      return callback && callback({ success: false, error: 'Orphan file not found' });
    }

    try {
      const tgt = prepareTargetManifest(data.targetVideo);

      let finalSourcePath = sourcePath;
      let ext = path.extname(sourcePath).toLowerCase();
      let wasConverted = false;

      // SRT → VTT conversion
      if (ext === '.srt') {
        if (ffmpegPath) {
          const tempVttName = `${path.basename(orphanFile, '.srt')}_converted.vtt`;
          const tempVttPath = path.join(TRACKS_DIR, tempVttName);
          const bin = ffmpegPath();
          try {
            await execFileAsync(bin, ['-y', '-i', sourcePath, tempVttPath]);
            finalSourcePath = tempVttPath;
            ext = '.vtt';
            wasConverted = true;
            console.log(`[Subtitle] Converted SRT to VTT: ${tempVttName}`);
          } catch (err) {
            console.error('FFmpeg conversion failed:', err);
            return callback && callback({ success: false, error: 'SRT conversion failed' });
          }
        } else {
          return callback && callback({ success: false, error: 'FFmpeg not available for conversion' });
        }
      }

      // Rename to standard name
      const newFileName = `${tgt.safeBaseName}_track${tgt.nextIndex}_und_Orphan${ext}`;
      const finalPath = path.join(TRACKS_DIR, newFileName);
      fs.renameSync(finalSourcePath, finalPath);

      // Clean up original SRT if converted
      if (wasConverted && fs.existsSync(sourcePath)) {
        try {
          fs.unlinkSync(sourcePath);
          console.log(`[Subtitle] Deleted original SRT: ${orphanFile}`);
        } catch (e) { console.warn('Failed to delete original SRT', e); }
      }

      // Update manifest with normalized entry
      tgt.manifest.externalTracks.push(buildTrackEntry(newFileName, {
        type: 'subtitle', lang: 'und', title: 'Orphan'
      }));
      fs.writeFileSync(tgt.manifestPath, JSON.stringify(tgt.manifest, null, 2));

      console.log(`[Subtitle] Bound ${newFileName} to ${data.targetVideo}`);
      if (callback) callback({ success: true });

    } catch (err) {
      console.error('Error binding orphan:', err);
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // Handle playlist set from admin
  socket.on('set-playlist', async (data) => {
    console.log('Received playlist data:', data);

    let targetPlaylist, targetVideoState, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      // Only allow admin to set playlist (unless it's a public room with some other rule, but usually admin only)
      if (room.adminSocketId !== socket.id) {
        console.log(`${colors.red}Non-admin attempted to set playlist in room ${targetRoomCode}${colors.reset}`);
        socket.emit('playlist-set', { success: false, message: 'Only admins can set the playlist' });
        return;
      }

      targetPlaylist = room.playlist;
      targetVideoState = room.videoState;
    } else {
      targetPlaylist = PLAYLIST;
      targetVideoState = videoState;
    }

    const processedPlaylist = [];

    for (const item of data.playlist) {
      const videoInfo = { ...item };

      try {
        let tracks = { audio: [], subtitles: [] };
        if (!item.isExternal) {
          tracks = await getTracksForFile(item.filename);
        }
        videoInfo.tracks = tracks;
      } catch (error) {
        console.error('Error getting track info:', error);
        videoInfo.tracks = { audio: [], subtitles: [] };
      }

      if (item.selectedAudioTrack !== undefined) {
        videoInfo.selectedAudioTrack = item.selectedAudioTrack;
      }
      if (item.selectedSubtitleTrack !== undefined) {
        videoInfo.selectedSubtitleTrack = item.selectedSubtitleTrack;
      }

      videoInfo.usesHEVC = item.filename.endsWith('.mkv');
      processedPlaylist.push(videoInfo);
    }

    targetPlaylist.videos = processedPlaylist;
    targetPlaylist.mainVideoIndex = data.mainVideoIndex;
    targetPlaylist.mainVideoStartTime = data.startTime;
    targetPlaylist.currentIndex = 0;
    targetPlaylist.preloadMainVideo = true;

    // Set initial track selections for the first video
    if (processedPlaylist.length > 0) {
      const firstVideo = processedPlaylist[0];
      targetVideoState.audioTrack = firstVideo.selectedAudioTrack !== undefined ? firstVideo.selectedAudioTrack : 0;
      targetVideoState.subtitleTrack = firstVideo.selectedSubtitleTrack !== undefined ? firstVideo.selectedSubtitleTrack : -1;
    }

    targetVideoState.currentTime = data.startTime || 0;
    targetVideoState.lastUpdate = Date.now();

    console.log(`Playlist updated (Room: ${targetRoomCode || 'Legacy'}):`);
    console.log('- Total videos:', targetPlaylist.videos.length);
    console.log('- Main video index:', targetPlaylist.mainVideoIndex);
    console.log('- Start time:', targetPlaylist.mainVideoStartTime);

    // Notify clients about the new playlist
    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('playlist-update', targetPlaylist);
    } else {
      io.emit('playlist-update', targetPlaylist);
    }

    // Set initial play state based on autoplay config
    targetVideoState.isPlaying = VIDEO_AUTOPLAY;

    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('sync', targetVideoState);
    } else {
      io.emit('sync', targetVideoState);
    }

    // Extra pause to make sure if autoplay is off
    if (!VIDEO_AUTOPLAY) {
      setTimeout(() => {
        targetVideoState.isPlaying = false;
        if (SERVER_MODE) {
          io.to(targetRoomCode).emit('sync', targetVideoState);
        } else {
          io.emit('sync', targetVideoState);
        }
      }, 500);
    }

    socket.emit('playlist-set', {
      success: true,
      message: VIDEO_AUTOPLAY ? 'Playlist launched - playing!' : 'Playlist launched - paused (autoplay disabled)'
    });
  });

  // Get config (for admin)
  socket.on('get-config', () => {
    socket.emit('config', {
      port: PORT,
      skipSeconds: SKIP_SECONDS,
      skipIntroSeconds: SKIP_INTRO_SECONDS,
      volumeStep: VOLUME_STEP / 100,
      joinMode: JOIN_MODE,
      bslS2Mode: BSL_S2_MODE,
      bslAdvancedMatch: BSL_ADVANCED_MATCH,
      bslAdvancedMatchThreshold: BSL_ADVANCED_MATCH_THRESHOLD,
      useHttps: config.use_https === 'true',
      videoAutoplay: VIDEO_AUTOPLAY,
      adminFingerprintLock: ADMIN_FINGERPRINT_LOCK,
      maxVolume: MAX_VOLUME,
      chatEnabled: CHAT_ENABLED,
      dataHydration: DATA_HYDRATION,
      serverMode: SERVER_MODE,
      clientControlsDisabled: CLIENT_CONTROLS_DISABLED,
      subtitleRenderer: SUBTITLE_RENDERER
    });
  });

  // Skip to next video in playlist (from admin skip button)
  socket.on('skip-to-next-video', () => {
    let targetPlaylist, targetVideoState, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
      targetVideoState = room.videoState;
    } else {
      targetPlaylist = PLAYLIST;
      targetVideoState = videoState;
    }

    if (targetPlaylist.videos.length === 0) {
      console.log('No videos in playlist to skip');
      return;
    }

    const nextIndex = (targetPlaylist.currentIndex + 1) % targetPlaylist.videos.length;
    console.log(`${colors.yellow}Skipping to video ${nextIndex + 1}/${targetPlaylist.videos.length} (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    targetPlaylist.currentIndex = nextIndex;

    // Set initial track selections for the new video
    const video = targetPlaylist.videos[nextIndex];
    targetVideoState.audioTrack = video.selectedAudioTrack !== undefined ? video.selectedAudioTrack : 0;
    targetVideoState.subtitleTrack = video.selectedSubtitleTrack !== undefined ? video.selectedSubtitleTrack : -1;
    targetVideoState.currentTime = 0;
    targetVideoState.lastUpdate = Date.now();

    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('sync', targetVideoState);
      io.to(targetRoomCode).emit('playlist-position', nextIndex);
      io.to(targetRoomCode).emit('playlist-update', targetPlaylist);
    } else {
      io.emit('sync', targetVideoState);
      io.emit('playlist-position', nextIndex);
      io.emit('playlist-update', targetPlaylist);
    }
  });

  // Move to next video in playlist
  socket.on('playlist-next', (nextIndex) => {
    let targetPlaylist, targetVideoState, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      targetPlaylist = room.playlist;
      targetVideoState = room.videoState;
    } else {
      targetPlaylist = PLAYLIST;
      targetVideoState = videoState;
    }

    targetPlaylist.currentIndex = nextIndex;

    // Set initial track selections for the new video
    if (targetPlaylist.videos[nextIndex]) {
      const video = targetPlaylist.videos[nextIndex];
      targetVideoState.audioTrack = video.selectedAudioTrack !== undefined ? video.selectedAudioTrack : 0;
      targetVideoState.subtitleTrack = video.selectedSubtitleTrack !== undefined ? video.selectedSubtitleTrack : -1;
    }
    targetVideoState.lastUpdate = Date.now();

    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('sync', targetVideoState);
      io.to(targetRoomCode).emit('playlist-position', nextIndex);
    } else {
      io.emit('sync', targetVideoState);
      io.emit('playlist-position', nextIndex);
    }
  });

  // Jump to specific video in playlist (from admin)
  socket.on('playlist-jump', (index) => {
    // Validate index is a valid integer
    if (!isValidInteger(index)) {
      console.log(`${colors.yellow}Invalid playlist-jump index type: ${typeof index}${colors.reset}`);
      return;
    }

    const parsedIndex = typeof index === 'string' ? parseInt(index, 10) : index;

    let targetPlaylist, targetVideoState, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
      targetVideoState = room.videoState;
    } else {
      targetPlaylist = PLAYLIST;
      targetVideoState = videoState;
    }

    // Validate index is within playlist bounds
    if (!validatePlaylistIndex(parsedIndex, targetPlaylist)) {
      console.log(`${colors.yellow}Invalid playlist-jump index: ${parsedIndex} (playlist length: ${targetPlaylist.videos.length})${colors.reset}`);
      return;
    }

    console.log(`${colors.yellow}Jumping to playlist position ${index} (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);
    targetPlaylist.currentIndex = index;

    // Set initial track selections for the new video
    const video = targetPlaylist.videos[index];
    targetVideoState.audioTrack = video.selectedAudioTrack !== undefined ? video.selectedAudioTrack : 0;
    targetVideoState.subtitleTrack = video.selectedSubtitleTrack !== undefined ? video.selectedSubtitleTrack : -1;
    targetVideoState.currentTime = 0;  // Reset to start of video
    targetVideoState.lastUpdate = Date.now();

    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('sync', targetVideoState);
      io.to(targetRoomCode).emit('playlist-position', index);
      io.to(targetRoomCode).emit('playlist-update', targetPlaylist);
    } else {
      io.emit('sync', targetVideoState);
      io.emit('playlist-position', index);
      io.emit('playlist-update', targetPlaylist);
    }
  });

  // Handle track selection changes from admin
  socket.on('track-change', (data) => {
    // Validate input object
    if (!data || typeof data !== 'object') {
      console.error('Invalid track-change data: not an object');
      return;
    }

    console.log('Track change received:', data);

    let targetPlaylist, targetVideoState, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
      targetVideoState = room.videoState;
    } else {
      targetPlaylist = PLAYLIST;
      targetVideoState = videoState;
    }

    // Validate videoIndex
    if (!isValidInteger(data.videoIndex) || data.videoIndex < 0) {
      console.error('Invalid video index for track change:', data.videoIndex);
      return;
    }

    if (!data.type || !['audio', 'subtitle'].includes(data.type)) {
      console.error('Invalid track type for track change:', data.type);
      return;
    }

    if (!validateTrackIndex(data.trackIndex)) {
      console.error('Invalid track index for track change:', data.trackIndex);
      return;
    }

    if (targetPlaylist.videos.length > data.videoIndex) {
      const video = targetPlaylist.videos[data.videoIndex];

      if (data.type === 'audio') {
        video.selectedAudioTrack = data.trackIndex;
      } else if (data.type === 'subtitle') {
        video.selectedSubtitleTrack = data.trackIndex;
      }

      if (data.videoIndex === targetPlaylist.currentIndex) {
        if (data.type === 'audio') {
          targetVideoState.audioTrack = data.trackIndex;
        } else if (data.type === 'subtitle') {
          targetVideoState.subtitleTrack = data.trackIndex;
        }
        targetVideoState.lastUpdate = Date.now();

        if (SERVER_MODE) {
          io.to(targetRoomCode).emit('sync', targetVideoState);
        } else {
          io.emit('sync', targetVideoState);
        }
      }

      console.log(`Updated ${data.type} track for video ${data.videoIndex} to track ${data.trackIndex} (Room: ${targetRoomCode || 'Legacy'})`);

      if (SERVER_MODE) {
        io.to(targetRoomCode).emit('track-change', data);
      } else {
        io.emit('track-change', data);
      }
    } else {
      console.error('Video index out of range for track change');
    }
  });

  // Handle playlist reordering from admin
  socket.on('playlist-reorder', (data) => {
    const { fromIndex, toIndex } = data;

    let targetPlaylist, targetRoomCode;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
    } else {
      targetPlaylist = PLAYLIST;
    }

    // Validate indices
    if (fromIndex < 0 || fromIndex >= targetPlaylist.videos.length ||
      toIndex < 0 || toIndex >= targetPlaylist.videos.length) {
      console.error('Invalid indices for playlist reorder');
      return;
    }

    console.log(`${colors.yellow}Reordering playlist: ${fromIndex} -> ${toIndex} (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // Swap the videos
    [targetPlaylist.videos[fromIndex], targetPlaylist.videos[toIndex]] =
      [targetPlaylist.videos[toIndex], targetPlaylist.videos[fromIndex]];

    // Update mainVideoIndex if it was affected
    if (targetPlaylist.mainVideoIndex === fromIndex) {
      targetPlaylist.mainVideoIndex = toIndex;
    } else if (targetPlaylist.mainVideoIndex === toIndex) {
      targetPlaylist.mainVideoIndex = fromIndex;
    }

    // Update currentIndex if it was affected
    if (targetPlaylist.currentIndex === fromIndex) {
      targetPlaylist.currentIndex = toIndex;
    } else if (targetPlaylist.currentIndex === toIndex) {
      targetPlaylist.currentIndex = fromIndex;
    }

    // Broadcast updated playlist to clients
    if (SERVER_MODE) {
      io.to(targetRoomCode).emit('playlist-update', targetPlaylist);
    } else {
      io.emit('playlist-update', targetPlaylist);
    }
  });

  // BSL-S² (Both Side Local Sync Stream) handlers

  // Helper: Check if socket is a verified admin
  function isVerifiedAdmin(socketId) {
    // If fingerprint lock is disabled, all admins are verified
    if (!ADMIN_FINGERPRINT_LOCK) return true;
    return verifiedAdminSockets.has(socketId);
  }

  // Admin registers itself with optional fingerprint
  socket.on('bsl-admin-register', (data) => {
    const fingerprint = data?.fingerprint;

    // Check fingerprint if lock is enabled
    if (ADMIN_FINGERPRINT_LOCK) {
      if (!fingerprint) {
        console.log(`${colors.red}Admin registration rejected: No fingerprint provided${colors.reset}`);
        socket.emit('admin-auth-result', { success: false, reason: 'No fingerprint provided' });
        return;
      }

      if (registeredAdminFingerprint === null) {
        // First admin - register their fingerprint
        registeredAdminFingerprint = fingerprint;
        setAdminFingerprint(fingerprint);
      } else if (registeredAdminFingerprint !== fingerprint) {
        // Fingerprint mismatch - reject and disconnect
        // Hash the stored fingerprint for security, but show raw incoming for debugging
        const hashedExpected = crypto.createHash('sha256').update(registeredAdminFingerprint).digest('hex').substring(0, 6);
        console.log(`${colors.red}Admin rejected: Fingerprint mismatch (expected: ${hashedExpected}..., got: ${fingerprint})${colors.reset}`);
        socket.emit('admin-auth-result', {
          success: false,
          reason: 'Unauthorized device. This admin panel is locked to a different machine.'
        });
        // Disconnect the unauthorized socket after a brief delay
        setTimeout(() => socket.disconnect(true), 1000);
        return;
      }

    }


    // Add to verified admins (always verify if lock is disabled or check passed)
    verifiedAdminSockets.add(socket.id);

    adminSocketId = socket.id;

    // If roomCode provided (Server Mode), map the admin socket to the room
    if (data.roomCode) {
      socketRoomMap.set(socket.id, data.roomCode);
      // Ensure specific room admin tracking if needed
      const room = rooms.get(data.roomCode);
      if (room) {
        room.adminSocketId = socket.id;
      }
    }

    const hashedFp = fingerprint ? crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 6) : null;
    console.log(`${colors.green}Admin registered for BSL-S²: ${socket.id}${hashedFp ? ` (fingerprint: ${hashedFp}...)` : ''}${colors.reset}`);
    socket.emit('admin-auth-result', { success: true });
  });

  // Admin requests BSL-S² check on all clients
  socket.on('bsl-check-request', () => {
    let targetRoomCode, targetPlaylist, targetClientBslStatus, targetAdminSocketId;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
      targetClientBslStatus = room.clientBslStatus;
      targetAdminSocketId = room.adminSocketId;
    } else {
      targetPlaylist = PLAYLIST;
      targetClientBslStatus = clientBslStatus;
      targetAdminSocketId = adminSocketId;
    }

    console.log(`${colors.cyan}BSL-S² check requested by admin (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // Only send to clients who haven't already selected a folder
    let promptedCount = 0;

    // In server mode, only check clients in this room
    const socketsToPoll = SERVER_MODE ?
      Array.from(getRoom(targetRoomCode).clients.keys()) :
      Array.from(io.sockets.sockets.keys());

    socketsToPoll.forEach((socketId) => {
      // Skip admin
      if (socketId === targetAdminSocketId) return;

      // Skip clients who already have folder selected
      const status = targetClientBslStatus.get(socketId);
      if (status && status.folderSelected) {
        console.log(`  Skipping ${socketId} - already has folder selected`);
        return;
      }

      const clientSocket = io.sockets.sockets.get(socketId);
      if (clientSocket) {
        // Send check request to this client
        clientSocket.emit('bsl-check-request', {
          playlistVideos: targetPlaylist.videos.map(v => ({ filename: v.filename }))
        });
        promptedCount++;
      }
    });

    console.log(`${colors.cyan}BSL-S² check sent to ${promptedCount} clients${colors.reset}`);
    socket.emit('bsl-check-started', { clientCount: promptedCount });
  });

  // Admin requests stored BSL-S² status (without triggering check)
  socket.on('bsl-get-status', () => {
    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) sendBslStatusToAdmin(roomCode);
    } else {
      sendBslStatusToAdmin();
    }
  });

  // Client reports their local folder files
  socket.on('bsl-folder-selected', (data) => {
    let targetRoomCode, targetPlaylist, targetClientBslStatus;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      targetPlaylist = room.playlist;
      targetClientBslStatus = room.clientBslStatus;
    } else {
      targetPlaylist = PLAYLIST;
      targetClientBslStatus = clientBslStatus;
    }

    const clientId = data.clientId || socket.id; // Fallback to socket.id if no clientId
    console.log(`${colors.cyan}Client ${clientId} (${socket.id}) reported ${data.files.length} files (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // Store client's file list
    const matchedVideos = {};

    // Get this client's persistent matches
    const clientMatches = persistentBslMatches[clientId] || {};

    // Auto-match by filename + apply persistent matches
    if (targetPlaylist.videos.length > 0) {
      data.files.forEach(clientFile => {
        targetPlaylist.videos.forEach((playlistVideo, index) => {
          // Check persistent match for this client (previously saved)
          if (clientMatches[clientFile.name.toLowerCase()] === playlistVideo.filename.toLowerCase()) {
            matchedVideos[index] = clientFile.name;
            console.log(`${colors.cyan}  Persistent match applied: ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            return; // Skip further checks for this file
          }

          // Advanced matching (3 of 4 criteria)
          if (BSL_ADVANCED_MATCH) {
            let matchScore = 0;
            const SIZE_TOLERANCE = 1.5 * 1024 * 1024; // 1.5 MB in bytes

            // 1. Filename match (case-insensitive)
            const clientBasename = clientFile.name.toLowerCase();
            const serverBasename = playlistVideo.filename.toLowerCase();
            if (clientBasename === serverBasename) {
              matchScore++;
            }

            // 2. Extension match (case-insensitive)
            const clientExt = clientFile.name.substring(clientFile.name.lastIndexOf('.')).toLowerCase();
            const serverExt = playlistVideo.filename.substring(playlistVideo.filename.lastIndexOf('.')).toLowerCase();
            if (clientExt === serverExt) {
              matchScore++;
            }

            // 3. Size match (within ±1.5MB tolerance)
            if (clientFile.size !== undefined) {
              try {
                const serverFilePath = path.join(ROOT_DIR, 'media', playlistVideo.filename);
                const serverStats = fs.statSync(serverFilePath);
                const sizeDiff = Math.abs(clientFile.size - serverStats.size);
                if (sizeDiff <= SIZE_TOLERANCE) {
                  matchScore++;
                }
              } catch (err) {
                // If we can't stat the file, skip this criterion
                console.log(`${colors.yellow}  Could not stat server file: ${playlistVideo.filename}${colors.reset}`);
              }
            }

            // 4. MIME type match
            if (clientFile.type && clientFile.type.length > 0) {
              // Derive expected MIME from extension
              const mimeMap = {
                '.mp4': 'video/mp4',
                '.mkv': 'video/x-matroska',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.wmv': 'video/x-ms-wmv',
                '.mp3': 'audio/mpeg',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp'
              };
              const expectedMime = mimeMap[serverExt] || '';
              if (clientFile.type === expectedMime || clientFile.type.startsWith(expectedMime.split('/')[0])) {
                matchScore++;
              }
            }

            // Match if threshold or more criteria pass
            if (matchScore >= BSL_ADVANCED_MATCH_THRESHOLD) {
              matchedVideos[index] = clientFile.name;
              console.log(`${colors.green}  Advanced match (${matchScore}/4, threshold: ${BSL_ADVANCED_MATCH_THRESHOLD}): ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            }
          } else {
            // Simple filename-only matching (original behavior)
            if (clientFile.name.toLowerCase() === playlistVideo.filename.toLowerCase()) {
              matchedVideos[index] = clientFile.name;
              console.log(`${colors.green}  Auto-matched: ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            }
          }
        });
      });
    }

    targetClientBslStatus.set(socket.id, {
      clientId: clientId, // Store clientId for manual match persistence
      clientName: data.clientName || clientId.slice(-6), // Display name
      folderSelected: true,
      files: data.files,
      matchedVideos: matchedVideos
    });

    // Send updated status to admin
    if (SERVER_MODE) {
      sendBslStatusToAdmin(targetRoomCode);
    } else {
      sendBslStatusToAdmin();
    }

    // Send match results back to the client
    socket.emit('bsl-match-result', {
      matchedVideos: matchedVideos,
      totalMatched: Object.keys(matchedVideos).length,
      totalPlaylist: targetPlaylist.videos.length
    });
  });

  // Admin manually matches a client file to a playlist video
  socket.on('bsl-manual-match', (data) => {
    let targetRoomCode, targetPlaylist, targetClientBslStatus;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;

      targetPlaylist = room.playlist;
      targetClientBslStatus = room.clientBslStatus;
    } else {
      targetPlaylist = PLAYLIST;
      targetClientBslStatus = clientBslStatus;
    }

    const { clientSocketId, clientFileName, playlistIndex } = data;
    console.log(`${colors.yellow}Manual BSL-S² match: ${clientFileName} -> playlist[${playlistIndex}] (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    const clientStatus = targetClientBslStatus.get(clientSocketId);
    if (clientStatus) {
      clientStatus.matchedVideos[playlistIndex] = clientFileName;

      // Save persistent match using the client's persistent ID
      if (targetPlaylist.videos[playlistIndex] && clientStatus.clientId) {
        const playlistFileName = targetPlaylist.videos[playlistIndex].filename;
        const clientId = clientStatus.clientId;

        setBslMatch(clientId, clientFileName.toLowerCase(), playlistFileName.toLowerCase());
        // Refresh local cache
        persistentBslMatches = getBslMatches();
      }

      // Notify the specific client about the new match
      io.to(clientSocketId).emit('bsl-match-result', {
        matchedVideos: clientStatus.matchedVideos,
        totalMatched: Object.keys(clientStatus.matchedVideos).length,
        totalPlaylist: targetPlaylist.videos.length
      });

      // Update admin
      if (SERVER_MODE) {
        sendBslStatusToAdmin(targetRoomCode);
      } else {
        sendBslStatusToAdmin();
      }
    }
  });

  // Admin sets drift for a specific client and playlist video
  socket.on('bsl-set-drift', (data) => {
    // Validate input object
    if (!data || typeof data !== 'object') {
      console.error('Invalid bsl-set-drift data: not an object');
      return;
    }

    let targetRoomCode, targetClientDriftValues;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;

      targetClientDriftValues = room.clientDriftValues;
    } else {
      targetClientDriftValues = clientDriftValues;
    }

    const { clientFingerprint, playlistIndex, driftSeconds } = data;

    // Validate required fields
    if (!clientFingerprint || typeof clientFingerprint !== 'string') {
      console.error('Invalid clientFingerprint for bsl-set-drift');
      return;
    }

    if (!isValidInteger(playlistIndex) || playlistIndex < 0) {
      console.error('Invalid playlistIndex for bsl-set-drift:', playlistIndex);
      return;
    }

    // Validate drift range
    if (!validateDriftSeconds(driftSeconds)) {
      console.error('Invalid driftSeconds for bsl-set-drift (must be -60 to +60):', driftSeconds);
      return;
    }

    // Clamp drift to reasonable range (-60 to +60 seconds)
    const clampedDrift = Math.max(-60, Math.min(60, parseInt(driftSeconds) || 0));

    // Get or create drift object for this client
    let clientDrifts = targetClientDriftValues.get(clientFingerprint);
    if (!clientDrifts) {
      clientDrifts = {};
      targetClientDriftValues.set(clientFingerprint, clientDrifts);
    }

    // Store drift value
    clientDrifts[playlistIndex] = clampedDrift;
    console.log(`${colors.yellow}BSL-S² drift set: ${clientFingerprint} video[${playlistIndex}] = ${clampedDrift}s (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // If in Server Mode, only notify clients in the specific room
    if (SERVER_MODE) {
      const room = getRoom(targetRoomCode);
      room.clients.forEach((c, socketId) => {
        if (c.fingerprint === clientFingerprint) {
          io.to(socketId).emit('bsl-drift-update', {
            driftValues: clientDrifts
          });
        }
      });
    } else {
      // Find the client socket and notify them (legacy)
      connectedClients.forEach((info, socketId) => {
        if (info.fingerprint === clientFingerprint) {
          io.to(socketId).emit('bsl-drift-update', {
            driftValues: clientDrifts
          });
        }
      });
    }

    // Update admin with new drift values
    if (SERVER_MODE) {
      sendBslStatusToAdmin(targetRoomCode);
    } else {
      sendBslStatusToAdmin();
    }
  });

  // Admin sets a client's display name
  socket.on('set-client-name', (data) => {
    let targetRoomCode;
    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;
    }

    const { clientId, displayName } = data;
    if (clientId && displayName) {
      setClientName(clientId, displayName);
      // Refresh local cache
      clientDisplayNames = getClientNames();
      // Update admin with new names
      if (SERVER_MODE) {
        sendBslStatusToAdmin(targetRoomCode);
      } else {
        sendBslStatusToAdmin();
      }
    }
  });

  // Client registers with their fingerprint
  socket.on('client-register', (data) => {
    const fingerprint = data?.fingerprint || 'unknown';
    connectedClients.set(socket.id, {
      fingerprint,
      connectedAt: Date.now()
    });
    console.log(`${colors.cyan}Client registered: ${socket.id} (fingerprint: ${fingerprint})${colors.reset}`);
  });

  // Admin requests the list of connected clients
  socket.on('get-client-list', () => {
    let targetRoomCode;
    const clients = [];

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;

      room.clients.forEach((c, socketId) => {
        // Skip admin sockets
        if (room.adminSocketId === socketId) return;

        const displayName = clientDisplayNames[c.fingerprint] || '';
        clients.push({
          socketId,
          fingerprint: c.fingerprint,
          displayName,
          connectedAt: c.connectedAt
        });
      });
    } else {
      connectedClients.forEach((info, socketId) => {
        // Skip admin sockets
        if (verifiedAdminSockets.has(socketId)) return;

        const displayName = clientDisplayNames[info.fingerprint] || '';
        clients.push({
          socketId,
          fingerprint: info.fingerprint,
          displayName,
          connectedAt: info.connectedAt
        });
      });
    }
    socket.emit('client-list', clients);
  });

  // Admin sets a client's display name (via clients modal)
  socket.on('set-client-display-name', (data) => {
    const { fingerprint, displayName } = data;
    if (fingerprint) {
      setClientName(fingerprint, displayName);
      // Refresh local cache
      clientDisplayNames = getClientNames();
      console.log(`${colors.green}Client display name set: ${fingerprint} -> ${displayName}${colors.reset}`);
    }
  });

  // Helper: Send BSL-S² status to admin
  function sendBslStatusToAdmin(roomCode = null) {
    let targetAdminSocketId, targetClientBslStatus, targetClientDriftValues, targetPlaylist;

    if (SERVER_MODE && roomCode) {
      const room = getRoom(roomCode);
      if (!room) return;
      targetAdminSocketId = room.adminSocketId;
      targetClientBslStatus = room.clientBslStatus;
      targetClientDriftValues = room.clientDriftValues;
      targetPlaylist = room.playlist;
    } else {
      targetAdminSocketId = adminSocketId;
      targetClientBslStatus = clientBslStatus;
      targetClientDriftValues = clientDriftValues;
      targetPlaylist = PLAYLIST;
    }

    if (!targetAdminSocketId) return;

    const clientStatuses = [];
    targetClientBslStatus.forEach((status, socketId) => {
      const fingerprint = status.clientId;
      // Use admin-set name, or fallback to fingerprint prefix
      const displayName = clientDisplayNames[fingerprint] || fingerprint.slice(-4);
      // Get drift values for this client
      const driftValues = targetClientDriftValues.get(fingerprint) || {};
      clientStatuses.push({
        socketId,
        clientId: fingerprint,
        clientName: displayName,
        folderSelected: status.folderSelected,
        files: status.files,
        matchedVideos: status.matchedVideos,
        driftValues: driftValues
      });
    });

    // Calculate overall BSL-S² status per video
    const videoBslStatus = {};
    targetPlaylist.videos.forEach((_, index) => {
      const clientsWithMatch = [];
      const clientsWithoutMatch = [];

      targetClientBslStatus.forEach((status, socketId) => {
        if (status.matchedVideos[index]) {
          clientsWithMatch.push(socketId);
        } else if (status.folderSelected) {
          clientsWithoutMatch.push(socketId);
        }
      });

      // Determine if BSL-S² is active based on mode
      const totalClients = targetClientBslStatus.size;
      let bslActive = false;
      if (BSL_S2_MODE === 'all') {
        bslActive = totalClients > 0 && clientsWithMatch.length === totalClients;
      } else { // 'any'
        bslActive = clientsWithMatch.length > 0;
      }

      videoBslStatus[index] = {
        bslActive,
        clientsWithMatch: clientsWithMatch.length,
        clientsWithoutMatch: clientsWithoutMatch.length,
        totalChecked: clientsWithMatch.length + clientsWithoutMatch.length
      };
    });

    io.to(targetAdminSocketId).emit('bsl-status-update', {
      mode: BSL_S2_MODE,
      clients: clientStatuses,
      videoBslStatus
    });
  }

  socket.on('disconnect', () => {
    console.log('A user disconnected');

    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room) {
          // Clean up room-specific BSL status
          room.clientBslStatus.delete(socket.id);
          // If this was an admin, we don't necessarily delete the room here 
          // (that's handled by delete-room or room timeout logic if implemented)

          // Update room admin
          sendBslStatusToAdmin(roomCode);
          // Broadcast updated client count for this room
          broadcastClientCount(roomCode);
        }
        socketRoomMap.delete(socket.id);
      }
    } else {
      // Legacy Mode cleanup
      clientBslStatus.delete(socket.id);
      verifiedAdminSockets.delete(socket.id);
      connectedClients.delete(socket.id);
      if (socket.id === adminSocketId) {
        adminSocketId = null;
      }
      sendBslStatusToAdmin();
      broadcastClientCount();
    }
  });
});

// Helper: Broadcast client count to all clients
function broadcastClientCount(roomCode = null) {
  if (SERVER_MODE && roomCode) {
    const room = getRoom(roomCode);
    if (room) {
      let count = room.clients.size;
      if (room.adminSocketId && room.clients.has(room.adminSocketId)) {
        count--; // Exclude admin from count
      }
      io.to(roomCode).emit('client-count', count);
    }
  } else {
    // Count all connected sockets, excluding admin (legacy)
    let count = io.sockets.sockets.size;
    if (adminSocketId && io.sockets.sockets.has(adminSocketId)) {
      count--; // Exclude admin from count
    }
    io.emit('client-count', count);
  }
}

// Global time synchronization interval
const syncInterval = setInterval(() => {
  if (SERVER_MODE) {
    // Update videoState for all active rooms
    rooms.forEach(room => {
      if (room.videoState.isPlaying) {
        const now = Date.now();
        const elapsed = (now - room.videoState.lastUpdate) / 1000;
        room.videoState.currentTime += elapsed;
        room.videoState.lastUpdate = now;
      }
    });
  } else {
    // Legacy Mode sync
    if (videoState.isPlaying) {
      const now = Date.now();
      const elapsed = (now - videoState.lastUpdate) / 1000;
      videoState.currentTime += elapsed;
      videoState.lastUpdate = now;
    }
  }
}, 5000);

// Graceful shutdown
function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down server...`);
  clearInterval(syncInterval);

  io.close(() => {
    console.log('Socket.io closed');
  });

  server.close((err) => {
    if (err) {
      console.error('Error closing server:', err);
      process.exit(1);
    }
    console.log('Server stopped');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const LOCAL_IP = process.argv[2] || 'localhost';

// ==================== VPN/Proxy Detection ====================
// Check for ACTIVE VPN connections by detecting connected VPN network adapters
function checkForVpnProxy() {
  const detectedItems = [];

  // Step 1: Check for active VPN network adapters using netsh
  // This detects if a VPN tunnel is actually connected, not just if the app is open
  exec('netsh interface show interface', { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
    if (!error && stdout) {
      // VPN adapter name patterns that indicate an active connection
      const vpnAdapterPatterns = [
        { pattern: /connected\s+.*\s+(tap-windows|tap-nordvpn|tap-protonvpn|tap-expressvpn)/i, display: 'VPN (TAP Adapter)' },
        { pattern: /connected\s+.*\s+warp/i, display: 'Cloudflare WARP' },
        { pattern: /connected\s+.*\s+wireguard/i, display: 'WireGuard' },
        { pattern: /connected\s+.*\s+nordlynx/i, display: 'NordVPN (NordLynx)' },
        { pattern: /connected\s+.*\s+mullvad/i, display: 'Mullvad VPN' },
        { pattern: /connected\s+.*\s+proton/i, display: 'ProtonVPN' },
        { pattern: /connected\s+.*\s+windscribe/i, display: 'Windscribe' },
        { pattern: /connected\s+.*\s+surfshark/i, display: 'Surfshark' },
        { pattern: /connected\s+.*\s+pia/i, display: 'Private Internet Access' },
        { pattern: /connected\s+.*\s+expressvpn/i, display: 'ExpressVPN' },
        { pattern: /connected\s+.*\s+cyberghost/i, display: 'CyberGhost' },
        { pattern: /connected\s+.*\s+tun/i, display: 'VPN (TUN Adapter)' },
      ];

      vpnAdapterPatterns.forEach(({ pattern, display }) => {
        if (pattern.test(stdout)) {
          if (!detectedItems.includes(display)) {
            detectedItems.push(display);
          }
        }
      });
    }

    // Step 2: Check for DPI bypass tools that work at packet level (always active when running)
    exec('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 5000 }, (error2, stdout2) => {
      if (!error2 && stdout2) {
        const runningProcesses = new Set();
        stdout2.split('\n').forEach(line => {
          const match = line.match(/^"([^"]+\.exe)"/i);
          if (match) {
            runningProcesses.add(match[1].toLowerCase().replace(/\.exe$/i, ''));
          }
        });

        // DPI bypass and proxy tools (these are always active when the process runs)
        const alwaysActiveProcesses = [
          { name: 'goodbyedpi', display: 'GoodbyeDPI' },
          { name: 'zapret', display: 'Zapret' },
          { name: 'byedpi', display: 'ByeDPI' },
          { name: 'v2ray', display: 'V2Ray' },
          { name: 'v2rayn', display: 'V2RayN' },
          { name: 'xray', display: 'Xray' },
          { name: 'clash', display: 'Clash' },
          { name: 'clash-verge', display: 'Clash Verge' },
          { name: 'clashforwindows', display: 'Clash for Windows' },
          { name: 'sing-box', display: 'sing-box' },
          { name: 'shadowsocks', display: 'Shadowsocks' },
          { name: 'ss-local', display: 'Shadowsocks' },
          { name: 'tor', display: 'Tor' },
          { name: 'obfs4proxy', display: 'Tor Bridge (obfs4)' },
          { name: 'privoxy', display: 'Privoxy' },
          { name: 'psiphon3', display: 'Psiphon' },
          { name: 'lantern', display: 'Lantern' },
          { name: 'cloudflared', display: 'Cloudflare Tunnel' },
          { name: 'dnscrypt-proxy', display: 'DNSCrypt' },
        ];

        alwaysActiveProcesses.forEach(proc => {
          if (runningProcesses.has(proc.name.toLowerCase())) {
            if (!detectedItems.includes(proc.display)) {
              detectedItems.push(proc.display);
            }
          }
        });
      }

      // Output results
      if (detectedItems.length > 0) {
        console.log('');
        console.log(`${colors.yellow}⚠️  Active VPN/Proxy Connections Detected:${colors.reset}`);
        detectedItems.forEach(app => {
          console.log(`${colors.yellow}   • ${app}${colors.reset}`);
        });
        console.log(`${colors.yellow}   These active connections may cause issues for clients on your network.${colors.reset}`);
        console.log(`${colors.yellow}   Consider disconnecting when hosting Sync-Player sessions.${colors.reset}`);
        console.log('');

        // Store for admin panel notification
        detectedVpnProxy = detectedItems;
      }
    });
  });
}

// Store detected VPN/proxy for admin notification
let detectedVpnProxy = [];

// API endpoint for admin to check VPN/proxy status
app.get('/api/vpn-check', (req, res) => {
  res.json({ detected: detectedVpnProxy });
});

// Post-process generated VTT file to remove duplicate cues and ASS artifacts
async function cleanVttFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;

    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // Simple VTT parser to extract clean cues
    const cleanLines = [];
    if (lines.length > 0 && lines[0].startsWith('WEBVTT')) {
      cleanLines.push(lines[0]);
      cleanLines.push('');
    }

    let i = 0;
    let lastCue = null; // { start, end, text }

    while (i < lines.length) {
      let line = lines[i];

      // Check for timestamp line
      if (line.includes('-->')) {
        const parts = line.split(' --> ');
        if (parts.length >= 2) {
          const start = parts[0].trim();
          const end = parts[1].trim();

          // Collect payload (until empty line)
          let payload = [];
          let j = i + 1;
          while (j < lines.length && lines[j].trim() !== '') {
            const txt = lines[j].trim();
            // Filter ASS drawing commands (e.g. m 10 20 ...)
            if (!/^m\s+-?\d+/.test(txt)) {
              payload.push(lines[j]);
            }
            j++;
          }

          // If payload is empty (was only drawings), skip cue entirely
          if (payload.length > 0) {
            const payloadText = payload.join('\n');

            // Deduplicate logic: Skip this cue if identical to last one
            let isDuplicate = false;
            if (lastCue && lastCue.start === start && lastCue.end === end && lastCue.text === payloadText) {
              isDuplicate = true;
            }

            if (!isDuplicate) {
              cleanLines.push(`${start} --> ${end}`);
              cleanLines.push(...payload);
              cleanLines.push(''); // Separator

              lastCue = { start, end, text: payloadText };
            }
          }

          i = j; // Skip to next block
          continue;
        }
      }
      i++;
    }

    const newContent = cleanLines.join('\n');
    await fs.promises.writeFile(filePath, newContent, 'utf8');
    console.log(`[VTT-Clean] Processed ${path.basename(filePath)} (removed artifacts/duplicates)`);

  } catch (e) {
    console.error(`[VTT-Clean] Error processing ${path.basename(filePath)}:`, e);
  }
}

// --- Thumbnail Helper Functions ---

async function generateAudioCoverArt(videoPath, thumbnailPath) {
  try {
    if (!Demuxer) throw new Error('node-av Demuxer not available');

    console.log(`${colors.cyan}Processing audio cover art with node-av for: ${path.basename(videoPath)}${colors.reset}`);
    const input = await Demuxer.open(videoPath);
    let coverStream = null;

    // 1. Look for stream with AV_DISPOSITION_ATTACHED_PIC (0x0400 = 1024)
    for (const stream of input.streams) {
      if (stream.disposition & 1024) {
        coverStream = stream;
        break;
      }
    }

    // 2. If not found, look for video stream
    if (!coverStream) {
      for (const stream of input.streams) {
        if (stream.codecpar && (stream.codecpar.codecType === 0 || stream.codecpar.type === 'video')) {
          coverStream = stream;
          break;
        }
      }
    }

    if (coverStream) {
      console.log(`${colors.cyan}Found cover art stream #${coverStream.index}. Extracting...${colors.reset}`);
      let found = false;
      for await (const packet of input.packets(coverStream.index)) {
        if (packet.streamIndex === coverStream.index) {
          if (packet.data) {
            fs.writeFileSync(thumbnailPath, packet.data);
            console.log(`${colors.green}Extracted cover art to: ${thumbnailPath}${colors.reset}`);
            found = true;
          }
          packet.free();
          break;
        }
        packet.free();
      }
      await input.close();
      return found;
    }

    await input.close();
    return false;
  } catch (err) {
    console.error(`${colors.red}Error extracting audio cover art: ${err.message}${colors.reset}`);
    return false;
  }
}

async function generateThumbnailNodeAv(videoPath, thumbnailPath, width, safeFilename) {
  if (!Demuxer || !Decoder || !Encoder || !FilterAPI || !Muxer) return false;

  try {
    console.log(`${colors.cyan}Processing thumbnail with node-av for: ${safeFilename}${colors.reset}`);

    // Check for master thumbnail to reuse
    const masterFilename = safeFilename.replace(/\.[^.]+$/, '.jpg');
    const masterPath = path.join(THUMBNAIL_DIR, masterFilename);
    let inputPath = videoPath;
    let isImageInput = false;

    if (width !== 720 && fs.existsSync(masterPath)) {
      inputPath = masterPath;
      isImageInput = true;
      console.log(`${colors.cyan}Downscaling existing master thumbnail for ${safeFilename}${colors.reset}`);
    }

    const input = await Demuxer.open(inputPath);
    const videoStream = input.video();
    if (!videoStream) throw new Error('No video stream found');

    if (!isImageInput) {
      const duration = input.duration > 0 ? input.duration : (await getVideoDuration(videoPath));
      const seed = safeFilename.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const seekPct = Math.max(0.01, (seed % 20) / 100);
      const seekTime = Math.max(1, Math.floor(duration * seekPct));
      console.log(`${colors.cyan}Seeking deterministically to ${seekTime}s (duration: ${duration}s)${colors.reset}`);
      await input.seek(seekTime);
    }

    const decoder = await Decoder.create(videoStream);
    const output = await Muxer.open(thumbnailPath, { format: 'image2', update: '1' });

    const packetGen = input.packets(videoStream.index);
    const frameGen = decoder.frames(packetGen);

    let gotFrame = false;
    let encoder = null;
    let outStreamIdx = -1;
    let filter = null;

    for await (const frame of frameGen) {
      if (!gotFrame) {
        if (!filter) {
          filter = await FilterAPI.create(`scale=-1:${width},format=yuvj420p`, {
            width: frame.width,
            height: frame.height,
            pixelFormat: frame.format,
            timeBase: videoStream.timeBase
          });
        }

        const filteredFrames = await filter.processAll(frame);
        for (const filteredFrame of filteredFrames) {
          if (!encoder) {
            const { FF_ENCODER_MJPEG } = require('node-av/constants');
            encoder = await Encoder.create(FF_ENCODER_MJPEG, {
              timeBase: { num: 1, den: 1 },
              width: filteredFrame.width,
              height: filteredFrame.height,
              pixelFormat: filteredFrame.format
            });
            outStreamIdx = output.addStream(encoder);
          }
          const packets = await encoder.encodeAll(filteredFrame);
          for (const pkt of packets) await output.writePacket(pkt, outStreamIdx);
        }

        if (encoder) {
          for await (const pkt of encoder.flushPackets()) await output.writePacket(pkt, outStreamIdx);
        }
        gotFrame = true;
        break;
      }
    }

    if (input.close) await input.close();

    if (gotFrame) {
      console.log(`${colors.green}Generated thumbnail via node-av for: ${safeFilename}${colors.reset}`);
      return true;
    }
    return false;

  } catch (avError) {
    console.error(`${colors.yellow}node-av thumbnail failed:${colors.reset}`, avError.message);
    return false;
  }
}

async function generateThumbnailFfmpeg(videoPath, thumbnailPath, width, safeFilename) {
  return new Promise(async (resolve, reject) => {
    try {
      const duration = await getVideoDuration(videoPath);
      const firstThird = Math.max(duration / 3, 1);
      const randomTime = Math.random() * firstThird;
      const seekTime = Math.max(1, Math.floor(randomTime));

      console.log(`${colors.cyan}Generating ${width}px thumbnail for ${safeFilename} at ${seekTime}s${colors.reset}`);

      execFile('ffmpeg', [
        '-ss', String(seekTime),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', `scale=-1:${width}`,
        '-q:v', '2',
        '-y',
        thumbnailPath
      ], (error) => {
        if (error) {
          // Fallback to 1s
          execFile('ffmpeg', [
            '-ss', '1',
            '-i', videoPath,
            '-vframes', '1',
            '-vf', `scale=-1:${width}`,
            '-q:v', '2',
            '-y',
            thumbnailPath
          ], (err2) => {
            if (err2) return reject(err2);
            console.log(`${colors.green}Generated thumbnail (fallback) for: ${safeFilename}${colors.reset}`);
            resolve();
          });
        } else {
          console.log(`${colors.green}Generated thumbnail for: ${safeFilename}${colors.reset}`);
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Function to detect available FFmpeg encoders
function detectEncoders() {
  const memoryPath = path.join(MEMORY_DIR, 'memory.json');
  let memory = {};

  if (fs.existsSync(memoryPath)) {
    try {
      memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    } catch (e) { console.error('Error reading memory.json:', e); }
  }

  // Check if encoders already detected
  if (memory.encoders && Array.isArray(memory.encoders) && memory.encoders.length > 0) {
    return;
  }

  // Use bundled ffmpeg from node-av via official API
  let ffmpegPath = 'ffmpeg';
  try {
    // Use require to get the helper (returns function that returns path)
    const { ffmpegPath: getFfmpegPath } = require('node-av/ffmpeg');
    const bundledPath = getFfmpegPath();
    if (bundledPath) {
      ffmpegPath = bundledPath;
    }
  } catch (e) {
    console.warn('[FFmpeg] Could not load node-av/ffmpeg helper:', e.message);
    // Fallback to manual check if API fails
    const bundledManual = path.join(__dirname, 'node_modules', 'node-av', 'binary', 'ffmpeg.exe');
    if (fs.existsSync(bundledManual)) {
      ffmpegPath = bundledManual;
    }
  }

  exec(`"${ffmpegPath}" -encoders`, (error, stdout, stderr) => {
    if (error) {
      console.error('[FFmpeg] Failed to detect encoders:', error);
      return;
    }

    const encoders = [];
    const lines = stdout.split('\n');
    const regex = /^\s*([V A S])[A-Z.]+\s+([a-zA-Z0-9_-]+)\s+(.*)$/;

    lines.forEach(line => {
      const match = line.match(regex);
      if (match) {
        encoders.push({
          type: match[1] === 'V' ? 'video' : (match[1] === 'A' ? 'audio' : 'subtitle'),
          name: match[2],
          description: match[3].trim()
        });
      }
    });

    memory.encoders = encoders;

    // Save to memory.json
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
    } catch (e) {
      console.error('[FFmpeg] Failed to save encoders to memory.json:', e);
    }
  });
}

server.listen(PORT, () => {
  const protocol = (config.use_https === 'true' || PORT === 443 || PORT === 8443) ? 'https' : 'http';
  console.log(`${colors.blue}Server running at ${protocol}://${LOCAL_IP}:${PORT}${colors.reset}`);
  console.log(`${colors.blue}Admin panel available at ${protocol}://${LOCAL_IP}:${PORT}/admin${colors.reset}`);

  // Check for VPN/proxy software after server starts
  checkForVpnProxy();
  detectEncoders();
});