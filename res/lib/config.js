// config.js — Configuration parsing, validators, and derived constants
// Extracted from server.js to eliminate the monolith.

const path = require('path');
const fs = require('fs');

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
const ROOT_DIR = path.join(__dirname, '..', '..');
// Memory directory for persistent data
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
const TRACKS_MANIFEST_DIR = path.join(MEMORY_DIR, 'tracks');
const BAN_FILE = path.join(MEMORY_DIR, 'ban.json');
const BAN_CREDS_FILE = path.join(MEMORY_DIR, 'ban-creds.json'); // Write-only — never read by server
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
const THUMBNAIL_DIR = path.join(__dirname, '..', 'img', 'thumbnails');

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
  },
  subtitleFit: (v) => {
    const val = String(v).toLowerCase();
    if (!['stretch', 'bottom'].includes(val)) {
      return { valid: false, error: 'Must be "stretch" or "bottom"' };
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
  subtitle_renderer: getConfig('SYNC_SUBTITLE_RENDERER', 'subtitle_renderer', 'wsr', validators.subtitleRenderer),
  subtitle_fit: getConfig('SYNC_SUBTITLE_FIT', 'subtitle_fit', 'stretch', validators.subtitleFit)
};

// Derived constants
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

const SUBTITLE_FIT = config.subtitle_fit || 'stretch';

if (SUBTITLE_RENDERER_CONFIG === 'jassub' && SUBTITLE_RENDERER === 'wsr') {
  console.log(`${colors.yellow}JASSUB requires HTTPS. Using WSR (built-in) renderer instead.${colors.reset}`);
  console.log(`${colors.yellow}Run generate-ssl.ps1 to enable HTTPS and JASSUB.${colors.reset}`);
}

// FFmpeg Tools Configuration
const FFMPEG_TOOLS_PASSWORD = getConfig('SYNC_FFMPEG_TOOLS_PASSWORD', 'ffmpeg_tools_password', '');
const FFMPEG_DISABLE_BAN = String(getConfig('SYNC_FFMPEG_DISABLE_BAN', 'ffmpeg_disable_ban', 'false')).toLowerCase() === 'true';
const FFMPEG_DISABLE_CONSEQUENCES = String(getConfig('SYNC_FFMPEG_DISABLE_CONSEQUENCES', 'ffmpeg_disable_consequences', 'false')).toLowerCase() === 'true';

// Admin Fingerprint Lock Configuration
const ADMIN_FINGERPRINT_LOCK = config.admin_fingerprint_lock === 'true';

// Server mode - disable console logs and enable room-based architecture
if (SERVER_MODE) {
  console.log(`${colors.cyan}Server mode activated, Logs are disabled!${colors.reset}`);
  console.log(`${colors.cyan}Multi-room system enabled. Join mode forced to 'sync'.${colors.reset}`);
  // Override console.log to suppress output (keep console.error for critical errors)
  console.log = () => { };
}

module.exports = {
  colors,
  config,
  getConfig,
  validators,
  // Directories
  ROOT_DIR,
  MEMORY_DIR,
  TRACKS_DIR,
  TRACKS_MANIFEST_DIR,
  BAN_FILE,
  BAN_CREDS_FILE,
  MEDIA_DIR,
  THUMBNAIL_DIR,
  // Constants
  PORT,
  SKIP_SECONDS,
  VOLUME_STEP,
  JOIN_MODE,
  BSL_S2_MODE,
  VIDEO_AUTOPLAY,
  BSL_ADVANCED_MATCH,
  BSL_ADVANCED_MATCH_THRESHOLD,
  SKIP_INTRO_SECONDS,
  CLIENT_CONTROLS_DISABLED,
  CLIENT_SYNC_DISABLED,
  CHAT_ENABLED,
  SERVER_MODE,
  DATA_HYDRATION,
  MAX_VOLUME,
  SUBTITLE_RENDERER,
  SUBTITLE_FIT,
  FFMPEG_TOOLS_PASSWORD,
  FFMPEG_DISABLE_BAN,
  FFMPEG_DISABLE_CONSEQUENCES,
  ADMIN_FINGERPRINT_LOCK
};
