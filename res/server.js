// =================================================================
// Sync-Player Server â€” Modular Architecture
// =================================================================
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// ==================== Extracted Modules ====================
const {
  colors, config, ROOT_DIR, MEMORY_DIR, TRACKS_DIR, TRACKS_MANIFEST_DIR,
  MEDIA_DIR, THUMBNAIL_DIR,
  PORT, SKIP_SECONDS, VOLUME_STEP, JOIN_MODE, BSL_S2_MODE,
  VIDEO_AUTOPLAY, BSL_ADVANCED_MATCH, BSL_ADVANCED_MATCH_THRESHOLD,
  SKIP_INTRO_SECONDS, CLIENT_CONTROLS_DISABLED, CLIENT_SYNC_DISABLED,
  CHAT_ENABLED, SERVER_MODE, DATA_HYDRATION, MAX_VOLUME,
  SUBTITLE_RENDERER, SUBTITLE_FIT, ADMIN_FINGERPRINT_LOCK,
  FFMPEG_DISABLE_BAN
} = require('./lib/config');

const {
  bannedIpHashes, hashValue, isIpBanned,
  getOrCreateCsrfToken, CSRF_TOKEN_EXPIRY, csrfProtection
} = require('./lib/security');

const memory = require('./lib/memory');
const {
  getAdminFingerprint, setAdminFingerprint,
  getClientNames, setClientName,
  getBslMatches, setBslMatch
} = memory;

const {
  rooms, socketRoomMap, roomLogger,
  createRoom, getRoom, deleteRoom, getPublicRooms,
  _getTrackSelections
} = require('./lib/rooms');

const { resolveContext } = require('./lib/context');
const { registerFFmpegRoutes } = require('./lib/ffmpeg-jobs');

const {
  Demuxer, getVideoDuration,
  generateAudioCoverArt, generateThumbnailNodeAv, generateThumbnailFfmpeg,
  extractFonts, detectEncoders
} = require('./lib/ffmpeg-media');

// =================================================================
// Startup Validation - Check if server is run from expected location
// =================================================================
function validateStartupLocation() {
  const configPath = path.join(ROOT_DIR, 'config.env');
  const resFolder = path.basename(__dirname);

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

validateStartupLocation();

// Ensure directories exist
[MEMORY_DIR, TRACKS_DIR, TRACKS_MANIFEST_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
const CERT_DIR = path.join(ROOT_DIR, 'cert');
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

// =================================================================
// Stale Track Cleanup - Delete tracks for media files missing > 7 days
// =================================================================
async function cleanupStaleTracks() {
  const STALE_DAYS = 7;
  const NOW = Date.now();
  const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

  try {
    await fs.promises.access(TRACKS_MANIFEST_DIR);
  } catch {
    return; // Directory doesn't exist
  }

  try {
    const files = await fs.promises.readdir(TRACKS_MANIFEST_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    let cleaned = 0;

    const existsAsync = async (p) => fs.promises.access(p).then(() => true).catch(() => false);

    for (const jsonFile of jsonFiles) {
      const videoFilename = jsonFile.replace('.json', '');
      const mediaPath = path.join(ROOT_DIR, 'media', videoFilename);
      const jsonPath = path.join(TRACKS_MANIFEST_DIR, jsonFile);

      try {
        const rawData = await fs.promises.readFile(jsonPath, 'utf8');
        const trackData = JSON.parse(rawData);
        const mediaExists = await existsAsync(mediaPath);

        if (mediaExists) {
          trackData.lastSeen = NOW;
          await fs.promises.writeFile(jsonPath, JSON.stringify(trackData, null, 2));
        } else {
          const lastSeen = trackData.lastSeen || NOW;

          if (NOW - lastSeen > STALE_MS) {
            if (trackData.externalTracks) {
              for (const track of trackData.externalTracks) {
                const trackPath = path.join(TRACKS_DIR, track.path);
                if (await existsAsync(trackPath)) {
                  await fs.promises.unlink(trackPath);
                  console.log(`[Cleanup] Deleted stale track: ${track.path}`);
                }
              }
            }
            await fs.promises.unlink(jsonPath);
            console.log(`[Cleanup] Deleted stale metadata: ${jsonFile}`);

            if (await existsAsync(THUMBNAIL_DIR)) {
              const baseVideoName = videoFilename.replace(/\.[^.]+$/, '');
              try {
                const thumbs = await fs.promises.readdir(THUMBNAIL_DIR);
                const matchingThumbs = thumbs.filter(f => f.startsWith(baseVideoName));
                for (const thumb of matchingThumbs) {
                  await fs.promises.unlink(path.join(THUMBNAIL_DIR, thumb));
                  console.log(`[Cleanup] Deleted stale thumbnail: ${thumb}`);
                }
              } catch (err) {
                console.error(`[Cleanup] Error clearing thumbnails for ${baseVideoName}:`, err.message);
              }
            }

            cleaned++;
          } else if (!trackData.lastSeen) {
            trackData.lastSeen = NOW;
            await fs.promises.writeFile(jsonPath, JSON.stringify(trackData, null, 2));
          }
        }
      } catch (err) { /* Silently ignore corrupt files */ }
    }

    if (cleaned > 0) {
      console.log(`[Cleanup] Removed ${cleaned} stale track entries`);
    }
  } catch (err) {
    console.error('[Cleanup] Error during stale tracks cleanup:', err.message);
  }
}

// Fire and forget
cleanupStaleTracks().catch(e => console.error(e));

// ==================== Utility Helpers ====================
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

// Filename validation for defense-in-depth
function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return { valid: false, error: 'Filename must be a non-empty string' };
  }
  if (filename.length > 255) {
    return { valid: false, error: 'Filename too long (max 255 characters)' };
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'Path traversal characters not allowed' };
  }
  const shellMetachars = /[;&|$`<>\n\r]/;
  if (shellMetachars.test(filename)) {
    return { valid: false, error: 'Filename contains disallowed shell metacharacters' };
  }
  const safePattern = /^[\w\s\-.()\[\]]+$/;
  if (!safePattern.test(filename)) {
    return { valid: false, error: 'Filename contains disallowed characters' };
  }
  return { valid: true, sanitized: path.basename(filename) };
}

// ==================== Express / SSL Setup ====================
const app = express();
let server;

if (config.use_https === 'true') {
  try {
    const findCertPath = (configuredPath, defaultName) => {
      if (configuredPath && configuredPath !== defaultName) {
        const directPath = path.resolve(ROOT_DIR, configuredPath);
        if (fs.existsSync(directPath)) return directPath;
      }
      const certDirPath = path.join(ROOT_DIR, 'cert', defaultName);
      if (fs.existsSync(certDirPath)) return certDirPath;
      const resCertPath = path.join(ROOT_DIR, 'res', 'cert', defaultName);
      if (fs.existsSync(resCertPath)) return resCertPath;
      const resPath = path.join(ROOT_DIR, 'res', defaultName);
      if (fs.existsSync(resPath)) return resPath;
      const rootPath = path.join(ROOT_DIR, defaultName);
      if (fs.existsSync(rootPath)) return rootPath;
      return path.join(ROOT_DIR, configuredPath || defaultName);
    };

    const keyPath = findCertPath(config.ssl_key_file, 'key.pem');
    const certPath = findCertPath(config.ssl_cert_file, 'cert.pem');

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
    } else {
      console.error(`${colors.red}[SSL] Certificates not found!${colors.reset}`);
      if (!fs.existsSync(keyPath)) console.error(`  Missing Key: ${keyPath}`);
      if (!fs.existsSync(certPath)) console.error(`  Missing Cert: ${certPath}`);
      console.error(`${colors.yellow}[SSL] Falling back to HTTP.${colors.reset}`);
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

// Register FFmpeg HTTP routes from module
registerFFmpegRoutes(app);

// Admin Fingerprint Lock (uses memory module)
let registeredAdminFingerprint = ADMIN_FINGERPRINT_LOCK ? getAdminFingerprint() : null;

// ==================== Legacy Single-Room State (Non-Server Mode) ====================
let PLAYLIST = {
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

let adminSocketId = null;
const verifiedAdminSockets = new Set();
const connectedClients = new Map();
const clientBslStatus = new Map();
const clientDriftValues = new Map();
let clientDisplayNames = getClientNames();
let persistentBslMatches = getBslMatches();

// Legacy state bundle for resolveContext
const legacyState = {
  get PLAYLIST() { return PLAYLIST; },
  get videoState() { return videoState; },
  get clientBslStatus() { return clientBslStatus; },
  get clientDriftValues() { return clientDriftValues; },
  get adminSocketId() { return adminSocketId; },
  connectedClients,
  verifiedAdminSockets
};


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


// Static file serving â€” ONLY expose specific safe directories (never the project root)
app.use('/media', express.static(path.join(ROOT_DIR, 'media')));
app.use('/tracks', express.static(TRACKS_DIR));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/font', express.static(path.join(__dirname, 'font')));
app.use('/img', express.static(path.join(__dirname, 'img')));



// API to list available fonts (with optional extraction)
app.get('/api/fonts', async (req, res) => {
  const fontDir = path.join(__dirname, 'font');

  // If video query param provided, try to extract fonts first
  if (req.query.video) {
    const start = Date.now();
    await extractFonts(req.query.video);
  }

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
// JASSUB library
app.use('/jassub', express.static(path.join(__dirname, 'node_modules/jassub/dist')));
app.use('/rvfc-polyfill', express.static(path.join(__dirname, 'node_modules/rvfc-polyfill')));
app.use('/abslink', express.static(path.join(__dirname, 'node_modules/abslink')));

// Legacy track selection wrapper
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
            // Internal subtitles disabled â€” use extracted sidecars instead
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

// API to get orphan tracks (files in TRACKS_DIR not in any manifest)
// Note: Protected implicitly by the admin panel's FFmpeg password gate (UI-level)
app.get('/api/tracks/orphans', (req, res) => {
  // 1. Get all track files in TRACKS_DIR (subtitles + audio)
  const trackExtensions = ['.vtt', '.srt', '.ass', '.aac', '.mp3', '.m4a', '.ogg', '.wav', '.flac'];
  let allTracks = [];
  try {
    if (fs.existsSync(TRACKS_DIR)) {
      allTracks = fs.readdirSync(TRACKS_DIR).filter(f => trackExtensions.includes(path.extname(f).toLowerCase()));
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

// Thumbnail directory (imported from config)

// Ensure thumbnail directory exists
if (!fs.existsSync(THUMBNAIL_DIR)) {
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// Serve thumbnails from the new directory
// Note: we already added a blanket /img route in the security fix, 
// but we keep /thumbnails explicitly to prevent breaking existing client caches
app.use('/thumbnails', express.static(THUMBNAIL_DIR));


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
  // Honeypot: banned IPs get a live socket with NO event handlers
  // The socket stays alive (no flicker), but nothing works
  const socketIp = socket.handshake.address;
  if (isIpBanned(socketIp)) {
    // Swallow all incoming events silently
    socket.onAny(() => { /* black hole */ });
    return;
  }

  console.log(`${colors.cyan}A user connected: ${socket.id}${colors.reset}`);
  socket.joinTime = Date.now(); // Track connection time for grace period

  // Periodic ban recheck â€” catches IPs banned mid-session (e.g. spoofed credentials)
  const banCheckInterval = setInterval(() => {
    if (isIpBanned(socket.handshake.address)) {
      // Silently convert to black hole: remove all listeners, swallow future events
      socket.removeAllListeners();
      socket.onAny(() => { /* black hole */ });
      clearInterval(banCheckInterval);
    }
  }, 10000); // Every 10 seconds

  // Clean up interval on disconnect
  socket.on('disconnect', () => {
    clearInterval(banCheckInterval);
    // If persistent bans are disabled, unban the IP when the socket drops (e.g. page refresh)
    if (FFMPEG_DISABLE_BAN) {
      bannedIpHashes.delete(hashValue(socket.handshake.address));
    }
  });

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
    'bsl-reset',
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
        subtitleRenderer: SUBTITLE_RENDERER,
        subtitleFit: SUBTITLE_FIT
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


    // Server mode: don't run legacy initialization, but continue to register event handlers below
  }

  // Unified chat message handler (works in both server and legacy mode)
  socket.on('chat-message', (data) => {
    if (!CHAT_ENABLED) return;

    const ctx = resolveContext(socket.id, legacyState, io);
    if (!ctx) return;

    const message = data.message?.trim() || '';

    // Handle /rename command
    if (message.toLowerCase().startsWith('/rename ')) {
      const newName = message.substring(8).trim().substring(0, 32);
      if (newName) {
        const clientInfo = connectedClients.get(socket.id);
        if (clientInfo && clientInfo.fingerprint) {
          const oldName = clientDisplayNames[clientInfo.fingerprint] || data.sender || 'Guest';
          setClientName(clientInfo.fingerprint, newName);
          socket.emit('name-updated', { newName });
          ctx.emit('chat-message', {
            sender: 'System',
            message: `${escapeHTML(oldName)} is now known as ${escapeHTML(newName)}`,
            timestamp: Date.now(),
            isSystem: true
          });
        }
      }
      return;
    }

    // Broadcast message (properly escaped)
    ctx.emit('chat-message', {
      sender: escapeHTML(data.sender || 'Guest'),
      message: escapeHTML(message.substring(0, 500)),
      timestamp: Date.now()
    });
  });


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
      subtitleRenderer: SUBTITLE_RENDERER,
      subtitleFit: SUBTITLE_FIT
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
          // Validate rate: must be a finite number in [0.1, 5.0]
          if (typeof data.rate !== 'number' || !isFinite(data.rate) || data.rate < 0.1 || data.rate > 5.0) {
            console.log(`[Rate Control] Invalid rate value: ${data.rate}`);
            return;
          }
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
        // Validate rate: must be a finite number in [0.1, 5.0]
        if (typeof data.rate !== 'number' || !isFinite(data.rate) || data.rate < 0.1 || data.rate > 5.0) {
          console.log(`[Rate Control Legacy] Invalid rate value: ${data.rate}`);
          return;
        }
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

  // Shared Subtitle Helpers
  // Read source manifest and resolve a track by its index (handles the 1000+ offset)
  // Needed because node-av handles local file extraction but track lists are UI managed

  // NOTE: Track Tools (Rebind, Share, Convert Orphan) have been migrated to the unified
  // HTTP FFmpeg Job Queue (see /api/ffmpeg/run-preset and runFfmpegJob).


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
    targetVideoState.playbackRate = 1.0;

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
      subtitleRenderer: SUBTITLE_RENDERER,
      subtitleFit: SUBTITLE_FIT
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
    targetVideoState.playbackRate = 1.0;

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
    targetVideoState.playbackRate = 1.0;

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
    targetVideoState.playbackRate = 1.0;

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

  // BSL-SÂ² (Both Side Local Sync Stream) handlers

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
    console.log(`${colors.green}Admin registered for BSL-SÂ²: ${socket.id}${hashedFp ? ` (fingerprint: ${hashedFp}...)` : ''}${colors.reset}`);
    socket.emit('admin-auth-result', { success: true });
  });

  // Admin requests BSL-SÂ² check on all clients
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

    console.log(`${colors.cyan}BSL-SÂ² check requested by admin (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

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

    console.log(`${colors.cyan}BSL-SÂ² check sent to ${promptedCount} clients${colors.reset}`);
    socket.emit('bsl-check-started', { clientCount: promptedCount });
  });

  // Admin requests stored BSL-SÂ² status (without triggering check)
  socket.on('bsl-get-status', () => {
    if (SERVER_MODE) {
      const roomCode = socketRoomMap.get(socket.id);
      if (roomCode) sendBslStatusToAdmin(roomCode);
    } else {
      sendBslStatusToAdmin();
    }
  });

  // Admin resets all in-session BSL status for all clients
  socket.on('bsl-reset', () => {
    let targetRoomCode, targetClientBslStatus;

    if (SERVER_MODE) {
      targetRoomCode = socketRoomMap.get(socket.id);
      if (!targetRoomCode) return;
      const room = getRoom(targetRoomCode);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;
      targetClientBslStatus = room.clientBslStatus;
    } else {
      targetClientBslStatus = clientBslStatus;
    }

    targetClientBslStatus.clear();
    console.log(`${colors.yellow}BSL-Sï¿½ status reset by admin (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // Push empty status update so admin UI reflects the reset
    if (SERVER_MODE) {
      sendBslStatusToAdmin(targetRoomCode);
    } else {
      sendBslStatusToAdmin();
    }
  });

  // Client reports their local folder files
  socket.on('bsl-folder-selected', async (data) => {
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

    // Null-safety: data.files may be missing/null when the client sends skipped:true
    const clientFiles = Array.isArray(data.files) ? data.files : [];
    console.log(`${colors.cyan}Client ${clientId} (${socket.id}) reported ${clientFiles.length} files (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

    // Store client file list and match results
    const matchedVideos = {};

    // Get this client's persistent matches (manually confirmed in a prior session)
    const clientMatches = persistentBslMatches[clientId] || {};

    // Auto-match by filename + apply persistent matches.
    // Uses for-loops (not forEach) so that 'continue' can properly skip to the
    // next iteration -- forEach's 'return' only exits the callback, not the outer loop.
    if (targetPlaylist.videos.length > 0) {
      // Track which client files have already been consumed to prevent 1-file -> N-slots
      const matchedClientFiles = new Set();

      for (const clientFile of clientFiles) {
        for (let index = 0; index < targetPlaylist.videos.length; index++) {
          const playlistVideo = targetPlaylist.videos[index];

          // Skip playlist slots already claimed by another client file
          if (matchedVideos[index] !== undefined) continue;

          // Skip client files that already matched a playlist slot
          if (matchedClientFiles.has(clientFile.name.toLowerCase())) continue;

          // 1. Persistent match: previously manually confirmed by admin
          if (clientMatches[clientFile.name.toLowerCase()] === playlistVideo.filename.toLowerCase()) {
            matchedVideos[index] = clientFile.name;
            matchedClientFiles.add(clientFile.name.toLowerCase());
            console.log(`${colors.cyan}  Persistent match applied: ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            continue; // Consume this file, move on to next playlist slot
          }

          // 2. Advanced matching (configurable score-based)
          if (BSL_ADVANCED_MATCH) {
            let matchScore = 0;
            const SIZE_TOLERANCE = 1.5 * 1024 * 1024; // 1.5 MB in bytes

            // Criterion A: Filename match (case-insensitive, full basename)
            const clientBasename = clientFile.name.toLowerCase();
            const serverBasename = playlistVideo.filename.toLowerCase();
            if (clientBasename === serverBasename) {
              matchScore++;
            }

            // Criterion B: Extension match (case-insensitive)
            const clientExt = clientFile.name.substring(clientFile.name.lastIndexOf('.')).toLowerCase();
            const serverExt = playlistVideo.filename.substring(playlistVideo.filename.lastIndexOf('.')).toLowerCase();
            if (clientExt === serverExt) {
              matchScore++;
            }

            // Criterion C: Size match (within +-1.5 MB tolerance)
            if (clientFile.size !== undefined) {
              try {
                const serverFilePath = path.join(ROOT_DIR, 'media', playlistVideo.filename);
                const serverStats = await fs.promises.stat(serverFilePath);
                const sizeDiff = Math.abs(clientFile.size - serverStats.size);
                if (sizeDiff <= SIZE_TOLERANCE) {
                  matchScore++;
                }
              } catch (err) {
                // Cannot stat server file -- skip this criterion
                console.log(`${colors.yellow}  Could not stat server file: ${playlistVideo.filename}${colors.reset}`);
              }
            }

            // Criterion D: MIME type match (exact only)
            // The old code used startsWith(category) which awarded a point to any two
            // video files regardless of format (e.g. video/avi matching video/mp4).
            if (clientFile.type && clientFile.type.length > 0) {
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
              // Exact match only -- a broad startsWith check (e.g. 'video/') would
              // award a point to any two video files regardless of format.
              if (expectedMime && clientFile.type === expectedMime) {
                matchScore++;
              }
            }

            // Apply match if enough criteria pass
            if (matchScore >= BSL_ADVANCED_MATCH_THRESHOLD) {
              matchedVideos[index] = clientFile.name;
              matchedClientFiles.add(clientFile.name.toLowerCase());
              console.log(`${colors.green}  Advanced match (${matchScore}/4, threshold: ${BSL_ADVANCED_MATCH_THRESHOLD}): ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            }
          } else {
            // Simple filename-only matching (original behavior, BSL_ADVANCED_MATCH=false)
            if (clientFile.name.toLowerCase() === playlistVideo.filename.toLowerCase()) {
              matchedVideos[index] = clientFile.name;
              matchedClientFiles.add(clientFile.name.toLowerCase());
              console.log(`${colors.green}  Auto-matched: ${clientFile.name} -> playlist[${index}]${colors.reset}`);
            }
          }
        }
      }
    }

    targetClientBslStatus.set(socket.id, {
      clientId: clientId, // Store clientId for manual match persistence
      clientName: data.clientName || clientId.slice(-6), // Display name
      folderSelected: true,
      files: clientFiles,
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
    console.log(`${colors.yellow}Manual BSL-SÂ² match: ${clientFileName} -> playlist[${playlistIndex}] (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

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
    console.log(`${colors.yellow}BSL-SÂ² drift set: ${clientFingerprint} video[${playlistIndex}] = ${clampedDrift}s (Room: ${targetRoomCode || 'Legacy'})${colors.reset}`);

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

  // Helper: Send BSL-SÂ² status to admin
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

    // Calculate overall BSL-SÂ² status per video
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

      // Determine if BSL-SÂ² is active based on mode
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
        room.videoState.currentTime += elapsed * (room.videoState.playbackRate || 1.0);
        room.videoState.lastUpdate = now;
      }
    });
  } else {
    // Legacy Mode sync
    if (videoState.isPlaying) {
      const now = Date.now();
      const elapsed = (now - videoState.lastUpdate) / 1000;
      videoState.currentTime += elapsed * (videoState.playbackRate || 1.0);
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
        console.log(`${colors.yellow}âš ï¸  Active VPN/Proxy Connections Detected:${colors.reset}`);
        detectedItems.forEach(app => {
          console.log(`${colors.yellow}   â€¢ ${app}${colors.reset}`);
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

server.listen(PORT, () => {
  const protocol = (config.use_https === 'true' || PORT === 443 || PORT === 8443) ? 'https' : 'http';
  console.log(`${colors.blue}Server running at ${protocol}://${LOCAL_IP}:${PORT}${colors.reset}`);
  console.log(`${colors.blue}Admin panel available at ${protocol}://${LOCAL_IP}:${PORT}/admin${colors.reset}`);

  // Check for VPN/proxy software after server starts
  checkForVpnProxy();
  detectEncoders();
});
