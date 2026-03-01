const socket = io();
let playlist = [];
let allMediaFiles = []; // Full media file list (persists across playlist launches)
let mainVideoIndex = -1;
let skipSeconds = 5;
let skipIntroSeconds = 90;
const thumbnailCache = {}; // Cache for loaded thumbnails

// DOM Cache for performance
const dom = {
  logs: null,
  playlist: null,
  fileBrowser: null,
  remotePlaylist: null,
  bslBody: null,
  connectionDot: null,
  connectionText: null,
  currentTime: null
};

function initDomCache() {
  dom.logs = document.getElementById('logs-container');
  dom.playlist = document.getElementById('playlist-container');
  dom.fileBrowser = document.getElementById('file-browser');
  dom.remotePlaylist = document.getElementById('remote-playlist-list');
  dom.bslBody = document.getElementById('bsl-modal-body');
  dom.connectionDot = document.getElementById('connection-dot');
  dom.connectionText = document.getElementById('connection-text');
  dom.currentTime = document.getElementById('current-time-display');
}

// Client-side escape utility
function escapeHTML(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// CSRF Token Management
let csrfToken = window.CSRF_TOKEN || '';

// Helper for authenticated fetch requests (includes CSRF token)
async function authenticatedFetch(url, options = {}) {
  const headers = {
    ...options.headers,
    'X-CSRF-Token': csrfToken
  };

  const response = await fetch(url, { ...options, headers });

  // If token expired (403), try to refresh it
  if (response.status === 403) {
    try {
      const tokenRes = await fetch('/api/csrf-token');
      if (tokenRes.ok) {
        const data = await tokenRes.json();
        csrfToken = data.token;
        // Retry the request with new token
        headers['X-CSRF-Token'] = csrfToken;
        return fetch(url, { ...options, headers });
      }
    } catch (e) {
      console.error('Failed to refresh CSRF token:', e);
    }
  }

  return response;
}

// Refresh CSRF token periodically (every 12 hours)
setInterval(async () => {
  try {
    const res = await fetch('/api/csrf-token');
    if (res.ok) {
      const data = await res.json();
      csrfToken = data.token;
    }
  } catch (e) {
    console.error('CSRF token refresh failed:', e);
  }
}, 12 * 60 * 60 * 1000);

document.addEventListener('DOMContentLoaded', initDomCache);

// Throttle helper for high-frequency socket events
function throttle(func, limit) {
  let inThrottle;
  return function () {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  }
}

// Platform Themes (Colors & Icons)
// Platform Themes (Colors & Icons)
const PLATFORM_THEMES = {
  'youtube': { color: '#C62828', icon: '🔴', textColor: '#FFFFFF' }, // Red (Darker)
  'vimeo': { color: '#0277BD', icon: '🔵', textColor: '#FFFFFF' },   // Blue (Darker)
  'dailymotion': { color: '#1565C0', icon: '⚫', textColor: '#FFFFFF' }, // Dark Blue
  'twitch': { color: '#673AB7', icon: '💜', textColor: '#FFFFFF' },  // Purple (Darker)
  'soundcloud': { color: '#E65100', icon: '🟠', textColor: '#FFFFFF' }, // Orange (Darker)
  'streamable': { color: '#0288D1', icon: '📺', textColor: '#FFFFFF' }, // Light Blue (Darker)
  'gdrive': { color: '#2E7D32', icon: '📁', textColor: '#FFFFFF' },  // Green (Darker)
  'kick': { color: '#388E3C', icon: '🟩', textColor: '#FFFFFF' },    // Forest Green (Instead of Neon)
  'directUrl': { color: '#455A64', icon: '🔗', textColor: '#FFFFFF' }, // Blue Grey (Darker)
  'local': { color: '#1565C0', icon: '🎬', textColor: '#FFFFFF' },   // Default Blue (Darker)
  'audio': { color: '#EF6C00', icon: '🎵', textColor: '#FFFFFF' },   // Deep Orange
  'image': { color: '#2E7D32', icon: '🖼️', textColor: '#FFFFFF' }   // Green (Darker)
};

// Helper to get platform key from video object
function getPlatformKey(video) {
  if (video.isYouTube) return 'youtube';

  // Check file extensions first
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  if (imageExtensions.some(ext => video.filename.toLowerCase().endsWith(ext))) return 'image';

  const audioExtensions = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'];
  if (audioExtensions.some(ext => video.filename.toLowerCase().endsWith(ext))) return 'audio';

  // Use platform property if available (from external content)
  if (video.platform) return video.platform;

  // Fallback based on badge/name if platform prop missing
  if (video.platformName) {
    const name = video.platformName.toLowerCase().replace(/\s/g, '');
    if (PLATFORM_THEMES[name]) return name;
    if (name.includes('google')) return 'gdrive';
    if (name.includes('url')) return 'directUrl';
  }

  return 'local';
}

// Apply platform theme to a thumbnail background element
function applyPlatformTheme(element, video, isDark = false) {
  const key = getPlatformKey(video);
  const theme = PLATFORM_THEMES[key] || PLATFORM_THEMES['local'];

  // Set background color 
  element.style.backgroundColor = theme.color;
  if (isDark) {
    // Create a darker gradient
    element.style.backgroundImage = `linear-gradient(135deg, rgba(0,0,0,0.4), rgba(0,0,0,0.6)), linear-gradient(135deg, ${theme.color}aa, ${theme.color}44)`;
  } else {
    element.style.backgroundImage = `linear-gradient(135deg, ${theme.color}dd, ${theme.color}66)`;
  }

  // Add themed class for visibility
  element.classList.add('themed');

  // Return theme info
  return {
    icon: theme.icon,
    textColor: theme.textColor || '#FFFFFF',
    platformName: video.platformName || (key.charAt(0).toUpperCase() + key.slice(1))
  };
}

// Generate fingerprint for device identification (MUST match landing page!)
// Uses origin-specific key so localhost, LAN IP, HTTP, and HTTPS all get separate fingerprints
function generateFingerprint() {
  const storageKey = 'sync-player-fingerprint-' + window.location.origin;
  const stored = localStorage.getItem(storageKey);
  if (stored) return stored;

  const fp = 'fp_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  localStorage.setItem(storageKey, fp);
  return fp;
}

// Legacy admin fingerprint - for non-server mode
function generateAdminFingerprint() {
  const components = [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    navigator.hardwareConcurrency || 'unknown',
    navigator.deviceMemory || 'unknown',
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    (() => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('Admin fingerprint', 2, 2);
        return canvas.toDataURL().slice(-50);
      } catch (e) {
        return 'no-canvas';
      }
    })()
  ];

  const str = components.join('|');

  // Generate a "full" 64-char deterministic hash from components
  // 1. FNV-1a hash the components string to get a seed
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  // 2. Use the hash to seed a simple PRNG to generate a long stable fingerprint
  let s = h >>> 0;
  const nextRaw = () => {
    s = Math.imul(s ^ s >>> 7, 0x5F356375); // Xorshift-like mix
    s = Math.imul(s ^ s << 13, 0xB6718429);
    return (s >>> 0);
  };
  const nextHex = () => nextRaw().toString(16).padStart(8, '0');

  // Generate 8 32-bit blocks = 64 hex chars
  return 'admin-' + nextHex() + nextHex() + nextHex() + nextHex() +
    nextHex() + nextHex() + nextHex() + nextHex();
}

// Get or store admin fingerprint
function getAdminFingerprint() {
  // For server mode rooms, use the same fingerprint as landing page
  const roomPathMatch = window.location.pathname.match(/^\/admin\/([A-Z0-9]{6})$/i);
  if (roomPathMatch) {
    // Server mode - use sync-player-fingerprint for consistency with landing page
    return generateFingerprint();
  }

  // Legacy mode - use admin-fingerprint with origin-specific key
  const storageKey = 'admin-fingerprint-' + window.location.origin;
  let stored = localStorage.getItem(storageKey);
  if (stored) {
    return stored;
  }
  const fp = generateAdminFingerprint();
  localStorage.setItem(storageKey, fp);
  return fp;
}

const adminFingerprint = getAdminFingerprint();
console.log('Admin fingerprint:', adminFingerprint);

// Server mode room state
let currentRoomCode = null;
let currentRoomName = null;
let isServerMode = false;

// Check if we're in a room (server mode URL: /admin/:roomCode)
const roomPathMatch = window.location.pathname.match(/^\/admin\/([A-Z0-9]{6})$/i);
if (roomPathMatch) {
  currentRoomCode = roomPathMatch[1].toUpperCase();
  console.log('Room code from URL:', currentRoomCode);
}

// Config display
socket.on('config', (cfg) => {
  // Update global config variables
  skipSeconds = cfg.skipSeconds || 5;
  skipIntroSeconds = cfg.skipIntroSeconds || 90;

  // Update DOM elements
  if (cfg.port) document.getElementById('cfg-port').textContent = cfg.port;
  if (cfg.skipSeconds) document.getElementById('cfg-skip').textContent = cfg.skipSeconds + 's';
  if (cfg.volumeStep) document.getElementById('cfg-volume').textContent = Math.round(cfg.volumeStep * 100) + '%';
  document.getElementById('cfg-max-volume').textContent = (cfg.maxVolume || 100) + '%';
  document.getElementById('cfg-autoplay').textContent = cfg.videoAutoplay ? 'On' : 'Off';
  document.getElementById('cfg-join-mode').textContent = cfg.joinMode || 'sync';
  document.getElementById('cfg-https').textContent = cfg.useHttps ? 'On' : 'Off';
  document.getElementById('cfg-chat').textContent = cfg.chatEnabled !== false ? 'On' : 'Off';
  document.getElementById('cfg-server-mode').textContent = cfg.serverMode ? 'On' : 'Off';
  document.getElementById('cfg-client-controls').textContent = cfg.clientControlsDisabled ? 'Disabled' : 'Enabled';
  document.getElementById('cfg-bsl-mode').textContent = cfg.bslS2Mode || 'any';
  document.getElementById('cfg-bsl-adv').textContent = cfg.bslAdvancedMatch ? 'On' : 'Off';
  document.getElementById('cfg-bsl-threshold').textContent = cfg.bslAdvancedMatchThreshold || '1';
  document.getElementById('cfg-admin-lock').textContent = cfg.adminFingerprintLock ? 'On' : 'Off';
  document.getElementById('cfg-subtitle-renderer').textContent = cfg.subtitleRenderer || 'wsr';

  document.getElementById('skip-intro-text').textContent = skipIntroSeconds + 's';

  // Update skip buttons text
  const skipBackText = document.getElementById('skip-back-text');
  const skipFwdText = document.getElementById('skip-forward-text');
  if (skipBackText) skipBackText.textContent = `${skipSeconds}s`;
  if (skipFwdText) skipFwdText.textContent = `${skipSeconds}s`;

  // Server mode room info
  if (cfg.serverMode) {
    isServerMode = true;
    if (cfg.roomName) {
      currentRoomName = cfg.roomName;
      document.title = `Admin: ${cfg.roomName} - Sync-Player`;
    }
    // Show server mode room controls
    const serverModeControls = document.getElementById('server-mode-controls');
    if (serverModeControls && currentRoomCode) {
      serverModeControls.style.display = 'block';
      document.getElementById('room-code-display').textContent = currentRoomCode;
    }
  }
});

// Request config on load
socket.on('connect', () => {
  // Update connection status UI
  const dot = document.getElementById('connection-dot');
  const text = document.getElementById('connection-text');
  if (dot && text) {
    dot.classList.remove('offline');
    text.textContent = 'Connected';
  }

  console.log('Connected to server, registering admin...');

  // Extract room code if in server mode URL (redundant check but safe)
  const roomPathMatch = window.location.pathname.match(/^\/admin\/([A-Z0-9]{6})$/i);
  const roomCode = roomPathMatch ? roomPathMatch[1] : null;

  // Register as admin for BSL
  socket.emit('bsl-admin-register', {
    fingerprint: adminFingerprint,
    roomCode: currentRoomCode || roomCode
  });

  // Check for VPN/proxy software
  fetch('/api/vpn-check')
    .then(res => res.json())
    .then(data => {
      if (data.detected && data.detected.length > 0) {
        const vpnWarning = document.getElementById('vpn-warning');
        document.getElementById('vpn-warning-list').textContent = data.detected.join(', ');
        vpnWarning.classList.add('visible');
        addLog(`VPN/Proxy detected: ${data.detected.join(', ')}`, 'warning');
        setTimeout(() => {
          vpnWarning.classList.add('fade-out');
          setTimeout(() => {
            vpnWarning.classList.remove('visible', 'fade-out');
          }, 500);
        }, 3000);
      }
    })
    .catch(err => console.error('Error checking VPN:', err));

  // Join logic
  if (currentRoomCode) {
    console.log('Joining room as admin:', currentRoomCode);
    socket.emit('join-room', {
      roomCode: currentRoomCode,
      name: 'Admin',
      fingerprint: adminFingerprint
    }, (response) => {
      if (response && response.success) {
        console.log('Joined room as admin:', response);
        currentRoomName = response.roomName;
        if (response.isAdmin) {
          const authScreen = document.getElementById('auth-screen');
          const adminUI = document.getElementById('admin-ui');
          if (authScreen) authScreen.classList.add('hidden');
          if (adminUI) adminUI.classList.add('authenticated');
          console.log('Admin authenticated for room:', currentRoomCode);
          initNavIndicator();
        } else {
          alert('You are not the admin of this room. Redirecting...');
          window.location.href = `/watch/${currentRoomCode}`;
        }
      } else {
        console.error('Failed to join room:', response?.error);
        alert('Room not found or access denied');
        window.location.href = '/';
      }
    });
  } else {
    // Legacy/Single mode
    socket.emit('get-config');
  }
});
if (socket.connected) {
  if (currentRoomCode) {
    socket.emit('join-room', {
      roomCode: currentRoomCode,
      name: 'Admin',
      fingerprint: adminFingerprint
    });
  } else {
    socket.emit('get-config');
  }
}

// Handle room deleted (if another admin deleted it)
socket.on('room-deleted', () => {
  alert('This room has been deleted.');
  window.location.href = '/';
});

// Delete room function (for server mode)
function deleteCurrentRoom() {
  if (!currentRoomCode || !isServerMode) return;

  if (confirm('Are you sure you want to delete this room? All viewers will be disconnected.')) {
    socket.emit('delete-room', {
      roomCode: currentRoomCode,
      fingerprint: adminFingerprint
    }, (response) => {
      if (response && response.success) {
        window.location.href = '/';
      } else {
        alert('Failed to delete room: ' + (response?.error || 'Unknown error'));
      }
    });
  }
}

// Live server playlist and index for remote controls
let serverPlaylist = null;
let preventRemoteRedirect = false;
let currentServerIndex = -1;

// View order for nav indicator tracking
const viewOrder = ['dashboard', 'media', 'remote', 'ffmpeg'];
let currentViewName = 'dashboard';

// View switching with scroll-like animation
function switchView(viewName) {
  const oldIndex = viewOrder.indexOf(currentViewName);
  const newIndex = viewOrder.indexOf(viewName);
  const goingDown = newIndex > oldIndex;

  // Update nav active states
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active', 'scroll-up', 'scroll-down');
  });

  const targetView = document.getElementById(`${viewName}-view`);

  // Apply direction class for animation
  if (goingDown) {
    targetView.classList.add('scroll-up'); // Content scrolls up (comes from bottom)
  } else {
    targetView.classList.add('scroll-down'); // Content scrolls down (comes from top)
  }

  targetView.classList.add('active');
  currentViewName = viewName;

  const activeNavItem = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  activeNavItem.classList.add('active');

  // Move the indicator to the active nav item
  const indicator = document.getElementById('nav-indicator');
  if (indicator && activeNavItem) {
    const navTop = activeNavItem.offsetTop + (activeNavItem.offsetHeight / 2) - 15;
    indicator.style.top = navTop + 'px';
  }

  // Check HEVC warning visibility on tab switch
  updateHevcWarning();

  // Auto-refresh track tools when switching to FFmpeg tab
  if (viewName === 'ffmpeg' && typeof refreshSubtitleToolLists === 'function') {
    refreshSubtitleToolLists();
  }

  // Hide VPN warning on tab switch (media or remote)
  if (viewName !== 'dashboard') {
    const vpnWarning = document.getElementById('vpn-warning');
    if (vpnWarning && vpnWarning.classList.contains('visible')) {
      vpnWarning.classList.add('fade-out');
      setTimeout(() => {
        vpnWarning.classList.remove('visible', 'fade-out');
      }, 500);
    }
  }
}

// Initialize indicator position on load
function initNavIndicator() {
  requestAnimationFrame(() => {
    const activeNavItem = document.querySelector('.nav-item.active');
    const indicator = document.getElementById('nav-indicator');
    if (indicator && activeNavItem) {
      // Disable transition for initial positioning
      indicator.style.transition = 'none';
      const navTop = activeNavItem.offsetTop + (activeNavItem.offsetHeight / 2) - 15;
      indicator.style.top = navTop + 'px';
      // Re-enable transition after a frame
      requestAnimationFrame(() => {
        indicator.style.transition = 'top 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      });
    }
  });
}

// Fetch available files from server
async function loadFiles() {
  // Check for hydrated data from server (saves a round-trip)
  if (window.INITIAL_DATA && window.INITIAL_DATA.files) {
    displayFiles(window.INITIAL_DATA.files);
    // Also hydrate playlist if available
    if (window.INITIAL_DATA.playlist) {
      playlist = window.INITIAL_DATA.playlist;
      mainVideoIndex = window.INITIAL_DATA.currentVideoIndex ?? -1;
      updatePlaylistDisplay();
      updateDashboardStats();
      if (typeof refreshFfmpegFileList === 'function') refreshFfmpegFileList();
    }
    // Important: clear it so we don't re-use stale data if we manually refresh parts
    // and delete it to save memory
    // delete window.INITIAL_DATA; 
    return;
  }

  try {
    const response = await fetch('/api/files');
    const files = await response.json();
    displayFiles(files);
  } catch (error) {
    console.error('Error loading files:', error);
    document.getElementById('file-browser').innerHTML =
      '<div class="empty-message">Error loading files. Check server connection.</div>';
  }
}

// Display files in the file browser
function displayFiles(files) {
  // Store the full file list for use in track tools and other dropdowns
  allMediaFiles = files;
  const fileBrowser = dom.fileBrowser || document.getElementById('file-browser');

  // Trigger FFmpeg and Track Tool dropdown refreshes
  if (typeof refreshFfmpegFileList === 'function') {
    refreshFfmpegFileList();
  }

  if (files.length === 0) {
    fileBrowser.innerHTML = '<div class="empty-message">No media files found in videos folder</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  files.forEach((file) => {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.innerHTML = `<span class="file-icon">🎬</span> ${file.escapedFilename || escapeHTML(file.filename)}`;

    if (file.filename.endsWith('.mkv')) {
      fileName.innerHTML += ' <span style="color: #FF9800;">⚠️</span>';
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = '+ Add';
    addBtn.onclick = () => addToPlaylist(file);

    fileItem.appendChild(fileName);
    fileItem.appendChild(addBtn);
    fragment.appendChild(fileItem);
  });

  fileBrowser.innerHTML = '';
  fileBrowser.appendChild(fragment);
}

// Add a file to the playlist
async function addToPlaylist(file) {
  if (!playlist.some(item => item.filename === file.filename)) {
    const fileCopy = { ...file };

    if (fileCopy.filename.endsWith('.mkv') || fileCopy.filename.endsWith('.mp4')) {
      try {
        const response = await fetch(`/api/tracks/${encodeURIComponent(fileCopy.filename)}`);
        if (response.ok) {
          const tracks = await response.json();
          fileCopy.tracks = {
            audio: tracks.audio || [],
            subtitles: tracks.subtitles || []
          };
        } else {
          fileCopy.tracks = { audio: [], subtitles: [] };
        }
      } catch (error) {
        fileCopy.tracks = { audio: [], subtitles: [] };
      }
    } else {
      fileCopy.tracks = { audio: [], subtitles: [] };
    }

    if (fileCopy.filename.endsWith('.mkv')) {
      fileCopy.usesHEVC = true;
    }

    fileCopy.isNew = true; // Flag for slide-in animation
    playlist.push(fileCopy);
    updatePlaylistDisplay();
    updateHevcWarning();
    updateDashboardStats();
    if (typeof refreshFfmpegFileList === 'function') refreshFfmpegFileList();
    // Clear the isNew flag after animation
    setTimeout(() => { fileCopy.isNew = false; }, 300);
  }
}

// Remove a file from the playlist
function removeFromPlaylist(index) {
  const container = document.getElementById('playlist-container');
  const item = container.children[index];

  if (item) {
    // Add slide-out animation
    item.classList.add('slide-out');

    // Wait for animation then remove
    setTimeout(() => {
      playlist.splice(index, 1);
      if (mainVideoIndex === index) {
        mainVideoIndex = -1;
      } else if (mainVideoIndex > index) {
        mainVideoIndex--;
      }
      updatePlaylistDisplay();
      updateHevcWarning();
      updateDashboardStats();
      if (typeof refreshFfmpegFileList === 'function') refreshFfmpegFileList();
    }, 400);
  } else {
    // Fallback if no element found
    playlist.splice(index, 1);
    if (mainVideoIndex === index) {
      mainVideoIndex = -1;
    } else if (mainVideoIndex > index) {
      mainVideoIndex--;
    }
    updatePlaylistDisplay();
    updateHevcWarning();
    updateDashboardStats();
    if (typeof refreshFfmpegFileList === 'function') refreshFfmpegFileList();
  }
}

// Move playlist item
function movePlaylistItem(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= playlist.length) return;

  [playlist[index], playlist[newIndex]] = [playlist[newIndex], playlist[index]];

  if (mainVideoIndex === index) {
    mainVideoIndex = newIndex;
  } else if (mainVideoIndex === newIndex) {
    mainVideoIndex = index;
  }

  updatePlaylistDisplay();
}

// Set as main video
function setAsMain(index) {
  const container = document.getElementById('playlist-container');
  const items = container.querySelectorAll('.playlist-item');

  // Update classes on existing elements (enables CSS transitions)
  items.forEach((item, i) => {
    const thumbnailBg = item.querySelector('.thumbnail-bg');

    if (i === mainVideoIndex) {
      // Old main - remove main class and blur the thumbnail
      item.classList.remove('main');
      if (thumbnailBg) thumbnailBg.classList.remove('cleared');

      // Add back the Set Main button
      const existingBtn = item.querySelector('.btn-secondary');
      if (!existingBtn) {
        const setMainBtn = document.createElement('button');
        setMainBtn.className = 'btn btn-sm btn-secondary';
        setMainBtn.textContent = 'Set Main';
        setMainBtn.onclick = () => setAsMain(i);
        item.insertBefore(setMainBtn, item.querySelector('.btn-danger'));
      }

      // Remove Main badge
      const badge = item.querySelector('.badge-main');
      if (badge) badge.remove();
    }

    if (i === index) {
      // New main - add main class and clear the thumbnail blur
      item.classList.add('main');
      if (thumbnailBg) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            thumbnailBg.classList.add('cleared');
          });
        });
      }

      // Remove Set Main button for this item
      const setMainBtn = item.querySelector('.btn-secondary');
      if (setMainBtn && setMainBtn.textContent === 'Set Main') {
        setMainBtn.remove();
      }

      // Add Main badge
      const badges = item.querySelector('.playlist-badges');
      if (badges && !badges.querySelector('.badge-main')) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-main';
        badge.textContent = 'Main';
        badges.appendChild(badge);
      }
    }
  });

  mainVideoIndex = index;
}

// Update playlist display
function updatePlaylistDisplay() {
  const container = dom.playlist || document.getElementById('playlist-container');
  if (!container) return;

  if (playlist.length === 0) {
    container.innerHTML = '<div class="empty-message">No files in playlist yet</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  playlist.forEach((item, index) => {
    const playlistItem = document.createElement('div');
    playlistItem.className = `playlist-item ${index === mainVideoIndex ? 'main' : ''} ${item.isNew ? 'slide-in' : ''}`;

    const thumbnailBg = document.createElement('div');
    thumbnailBg.className = 'thumbnail-bg';
    playlistItem.appendChild(thumbnailBg);

    const themeInfo = applyPlatformTheme(thumbnailBg, item);
    playlistItem.style.color = themeInfo.textColor;

    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].some(ext => item.filename.toLowerCase().endsWith(ext));

    if (isImage) {
      thumbnailBg.style.backgroundImage = `url('/media/${encodeURIComponent(item.filename)}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      playlistItem.style.color = '';
      if (index === mainVideoIndex) {
        requestAnimationFrame(() => requestAnimationFrame(() => thumbnailBg.classList.add('cleared')));
      }
    }
    else if (item.thumbnail && typeof item.thumbnail === 'string') {
      thumbnailBg.style.backgroundImage = `url('${item.thumbnail}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      playlistItem.style.color = '';
      if (index === mainVideoIndex) {
        requestAnimationFrame(() => requestAnimationFrame(() => thumbnailBg.classList.add('cleared')));
      }
    }
    else if (thumbnailCache[item.filename]) {
      thumbnailBg.style.backgroundImage = `url('${thumbnailCache[item.filename]}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      playlistItem.style.color = '';
      if (index === mainVideoIndex) {
        requestAnimationFrame(() => requestAnimationFrame(() => thumbnailBg.classList.add('cleared')));
      }
    } else if (!item.isYouTube && !item.isExternal) {
      // Fetch master thumbnail (default 720p) instead of 240p
      fetch(`/api/thumbnail/${encodeURIComponent(item.filename)}`)
        .then(response => response.json())
        .then(data => {
          if (data.thumbnail) {
            thumbnailCache[item.filename] = data.thumbnail;
            thumbnailBg.style.backgroundImage = `url('${data.thumbnail}')`;
            thumbnailBg.classList.remove('themed');
            playlistItem.style.color = '';
            const img = new Image();
            img.onload = () => {
              thumbnailBg.classList.add('loaded');
              if (index === mainVideoIndex) thumbnailBg.classList.add('cleared');
            };
            img.src = data.thumbnail;
          }
        })
        .catch(() => { });
    }

    const number = document.createElement('span');
    number.className = 'playlist-number';
    number.textContent = index + 1;
    playlistItem.appendChild(number);

    const name = document.createElement('span');
    name.className = 'playlist-name';
    name.textContent = item.filename;
    name.title = item.filename;
    playlistItem.appendChild(name);

    const badges = document.createElement('div');
    badges.className = 'playlist-badges';

    if (item.isExternal || item.isYouTube) {
      const platformBadge = document.createElement('span');
      platformBadge.className = `badge ${item.badge || 'badge-youtube'}`;
      platformBadge.textContent = `${item.syncLevel === 'full' ? '' : item.syncLevel === 'limited' ? '⚠️ ' : '📺 '}${item.platformName || 'YouTube'}`;
      badges.appendChild(platformBadge);
    }

    if (isImage) {
      const imgBadge = document.createElement('span');
      imgBadge.className = 'badge badge-image';
      imgBadge.textContent = 'Image';
      badges.appendChild(imgBadge);
    }

    const isAudio = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'].some(ext => item.filename.toLowerCase().endsWith(ext));
    if (isAudio) {
      const audioBadge = document.createElement('span');
      audioBadge.className = 'badge badge-audio';
      audioBadge.textContent = 'Audio';
      badges.appendChild(audioBadge);
    }

    if (index === mainVideoIndex) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-main';
      badge.textContent = 'Main';
      badges.appendChild(badge);
    }
    playlistItem.appendChild(badges);

    const moveDiv = document.createElement('div');
    moveDiv.className = 'move-buttons';

    const upBtn = document.createElement('button');
    upBtn.className = 'btn-move';
    upBtn.textContent = '▲';
    upBtn.disabled = index === 0;
    upBtn.onclick = (e) => { e.stopPropagation(); movePlaylistItem(index, -1); };
    moveDiv.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.className = 'btn-move';
    downBtn.textContent = '▼';
    downBtn.disabled = index === playlist.length - 1;
    downBtn.onclick = (e) => { e.stopPropagation(); movePlaylistItem(index, 1); };
    moveDiv.appendChild(downBtn);
    playlistItem.appendChild(moveDiv);

    if (index !== mainVideoIndex) {
      const setMainBtn = document.createElement('button');
      setMainBtn.className = 'btn btn-sm btn-secondary';
      setMainBtn.textContent = 'Set Main';
      setMainBtn.onclick = (e) => { e.stopPropagation(); setAsMain(index); };
      playlistItem.appendChild(setMainBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-sm btn-danger';
    removeBtn.textContent = '✕';
    removeBtn.onclick = (e) => { e.stopPropagation(); removeFromPlaylist(index); };
    playlistItem.appendChild(removeBtn);

    fragment.appendChild(playlistItem);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

// Update HEVC warning
function updateHevcWarning() {
  const hasMKV = playlist.some(item => item.filename.endsWith('.mkv'));
  const warning = document.getElementById('hevc-warning');

  // Only show if we have MKV files AND we are in the media view
  if (hasMKV && currentViewName === 'media') {
    if (!warning.classList.contains('visible')) {
      warning.classList.remove('fade-out');
      warning.classList.add('visible');
    }
  } else {
    if (warning.classList.contains('visible') && !warning.classList.contains('fade-out')) {
      warning.classList.add('fade-out');
      setTimeout(() => {
        // Check again if it should still be hidden (avoid race conditions)
        const stillNotNeeded = !playlist.some(item => item.filename.endsWith('.mkv')) || currentViewName !== 'media';
        if (stillNotNeeded && warning.classList.contains('fade-out')) {
          warning.classList.remove('visible', 'fade-out');
        }
      }, 300);
    }
  }
}

// Update dashboard stats
function updateDashboardStats() {
  document.getElementById('playlist-count').textContent = playlist.length;
}

// Launch playlist
function launchPlaylist() {
  if (playlist.length === 0) {
    showStatus('Playlist is empty!', 'error');
    return;
  }

  if (mainVideoIndex === -1) {
    mainVideoIndex = 0;
    updatePlaylistDisplay();
  }

  const startTime = document.getElementById('start-time').value || 0;

  const playlistWithTracks = playlist.map((item, index) => ({ ...item }));

  showStatus('Setting up playlist...', 'info');

  socket.emit('set-playlist', {
    playlist: playlistWithTracks,
    mainVideoIndex: parseInt(mainVideoIndex),
    startTime: parseFloat(startTime)
  });

  // Rename button to Relaunch after first launch
  document.getElementById('launch-btn').innerHTML = '🔄 Relaunch Playlist';
}

function showStatus(message, type, duration = 5000) {
  const statusEl = document.getElementById('status-message');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `status-message visible status-${type}`;
  // Keep inline flex styles
  statusEl.style.flex = '1';
  statusEl.style.margin = '0';
  statusEl.style.padding = '8px 16px';

  setTimeout(() => {
    statusEl.classList.remove('visible');
  }, duration);
}

function showToast(message, duration = 3000, isError = false) {
  const type = isError ? 'error' : 'success';
  showStatus(message, type, duration);
}

// Logging functions
function addLog(message, type = 'info') {
  const container = dom.logs || document.getElementById('logs-container');
  if (!container) return;

  // Remove "Waiting for events..." message if present
  const waitingMsg = container.querySelector('.log-entry');
  if (waitingMsg && waitingMsg.textContent === 'Waiting for events...') {
    waitingMsg.remove();
  }

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const colors = {
    info: '#2196F3',
    success: '#4CAF50',
    warning: '#FF9800',
    error: '#f44336',
    client: '#9C27B0'
  };

  entry.style.color = colors[type] || '#e0e0e0';
  entry.innerHTML = `<span style="color:#666">[${time}]</span> ${message}`;

  container.appendChild(entry);

  // Batch scroll update with next frame
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });

  // Limit to 50 entries
  while (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
}

function clearLogs() {
  const container = document.getElementById('logs-container');
  if (container) {
    container.innerHTML = '<div class="log-entry" style="color: #888;">Logs cleared</div>';
  }
}

// Remote control functions
function playVideo() {
  socket.emit('control', { action: 'playpause', state: true });
  document.getElementById('playback-status').textContent = 'Playing';
}

function pauseVideo() {
  socket.emit('control', { action: 'playpause', state: false });
  document.getElementById('playback-status').textContent = 'Paused';
}

function skipBack() {
  socket.emit('control', { action: 'skip', direction: 'back', seconds: skipSeconds });
}

function skipForward() {
  socket.emit('control', { action: 'skip', direction: 'forward', seconds: skipSeconds });
}

function seekTo() {
  const time = document.getElementById('seek-time').value;
  if (time) {
    socket.emit('control', { action: 'seek', time: parseFloat(time) });
  }
}

// Move playlist item in remote (sends to server)
function movePlaylistItemRemote(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= serverPlaylist.videos.length) return;
  socket.emit('playlist-reorder', { fromIndex: index, toIndex: newIndex });
}

// Fetch and display video thumbnail
// Fetch and display video thumbnail
let currentThumbnailFilename = null;
async function fetchThumbnail(filename, width = 720) {
  const thumbnailEl = document.querySelector('.video-thumbnail');
  const thumbnailIcon = document.querySelector('.video-thumbnail-icon');

  if (!thumbnailEl) return;

  // Check cache first (key by filename + width to be safe, though mainly one usage)
  const cacheKey = `${filename}:${width}`;
  if (thumbnailCache[cacheKey]) {
    thumbnailEl.style.backgroundImage = `url('${thumbnailCache[cacheKey]}')`;
    thumbnailEl.style.backgroundSize = 'cover';
    thumbnailEl.style.backgroundPosition = 'center';
    if (thumbnailIcon) thumbnailIcon.style.display = 'none';
    currentThumbnailFilename = cacheKey;
    return;
  }

  // Avoid refetching same thumbnail
  if (currentThumbnailFilename === cacheKey) return;
  currentThumbnailFilename = cacheKey;

  try {
    const response = await fetch(`/api/thumbnail/${encodeURIComponent(filename)}?width=${width}`);
    if (response.ok) {
      const data = await response.json();
      if (data.thumbnail) {
        // Update cache
        thumbnailCache[cacheKey] = data.thumbnail;

        thumbnailEl.style.backgroundImage = `url('${data.thumbnail}')`;
        thumbnailEl.style.backgroundSize = 'cover';
        thumbnailEl.style.backgroundPosition = 'center';
        if (thumbnailIcon) thumbnailIcon.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    // Keep showing the icon on error
    if (thumbnailIcon) thumbnailIcon.style.display = '';
  }
}

// Render remote playlist sidebar
function renderRemotePlaylistSidebar() {
  const container = dom.remotePlaylist || document.getElementById('remote-playlist-list');
  if (!container) return;

  if (!serverPlaylist || !serverPlaylist.videos || serverPlaylist.videos.length === 0) {
    container.innerHTML = '<div class="empty-message">No playlist active</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  serverPlaylist.videos.forEach((video, index) => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.style.cursor = 'pointer';
    if (index === currentServerIndex) item.classList.add('current');
    if (index === serverPlaylist.mainVideoIndex) item.classList.add('main');

    item.onclick = () => {
      socket.emit('playlist-jump', index);
      showStatus(`Jumping to video ${index + 1}...`, 'info');
    };

    const number = document.createElement('span');
    number.className = 'playlist-number';
    number.textContent = index + 1;
    item.appendChild(number);

    const name = document.createElement('span');
    name.className = 'playlist-name';
    name.title = video.filename;
    const nameText = document.createElement('span');
    nameText.textContent = video.filename + '          ' + video.filename;
    name.appendChild(nameText);
    item.appendChild(name);

    const badges = document.createElement('div');
    badges.className = 'playlist-badges';

    if (video.isExternal || video.isYouTube) {
      const platformBadge = document.createElement('span');
      platformBadge.className = `badge ${video.badge || 'badge-youtube'}`;
      const syncIcon = video.syncLevel === 'full' ? '✅' : video.syncLevel === 'limited' ? '⚠️' : '📺';
      platformBadge.textContent = `${syncIcon} ${video.platformName || 'YouTube'}`;
      badges.appendChild(platformBadge);
    }

    const thumbnailBg = document.createElement('div');
    thumbnailBg.className = 'thumbnail-bg';
    item.appendChild(thumbnailBg);

    const platformIcon = applyPlatformTheme(thumbnailBg, video);

    const iconFallback = document.createElement('div');
    iconFallback.className = 'thumbnail-icon-fallback';
    iconFallback.textContent = platformIcon;
    iconFallback.style.cssText = 'position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); font-size:24px; z-index:1;';
    thumbnailBg.appendChild(iconFallback);

    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].some(ext => video.filename.toLowerCase().endsWith(ext));

    if (isImage) {
      thumbnailBg.style.backgroundImage = `url('/media/${encodeURIComponent(video.filename)}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      item.style.color = '';
    }
    else if (video.thumbnail && typeof video.thumbnail === 'string') {
      thumbnailBg.style.backgroundImage = `url('${video.thumbnail}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      item.style.color = '';
    }
    else if (thumbnailCache[video.filename]) {
      thumbnailBg.style.backgroundImage = `url('${thumbnailCache[video.filename]}')`;
      thumbnailBg.classList.add('cached', 'loaded');
      thumbnailBg.classList.remove('themed');
      item.style.color = '';
    }
    else if (!video.isYouTube && !video.isExternal) {
      fetch(`/api/thumbnail/${encodeURIComponent(video.filename)}?width=240`)
        .then(res => res.json())
        .then(data => {
          if (data.thumbnail && typeof data.thumbnail === 'string') {
            thumbnailCache[video.filename] = data.thumbnail;
            thumbnailBg.style.backgroundImage = `url('${data.thumbnail}')`;
            thumbnailBg.classList.add('loaded');
            thumbnailBg.classList.remove('themed');
            item.style.color = '';
          }
        })
        .catch(() => { });
    }

    if (isImage) {
      const imgBadge = document.createElement('span');
      imgBadge.className = 'badge badge-image';
      imgBadge.textContent = '🖼️ Image';
      badges.appendChild(imgBadge);
    }

    const isAudio = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'].some(ext => video.filename.toLowerCase().endsWith(ext));
    if (isAudio) {
      const audioBadge = document.createElement('span');
      audioBadge.className = 'badge badge-audio';
      audioBadge.textContent = '🎵 Audio';
      badges.appendChild(audioBadge);
    }

    if (index === serverPlaylist.mainVideoIndex) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-main';
      badge.textContent = 'Main';
      badges.appendChild(badge);
    }
    if (index === currentServerIndex) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-playing';
      badge.textContent = '▶ Playing';
      badges.appendChild(badge);
    }
    item.appendChild(badges);

    const moveDiv = document.createElement('div');
    moveDiv.className = 'move-buttons';

    const upBtn = document.createElement('button');
    upBtn.className = 'btn-move';
    upBtn.textContent = '▲';
    upBtn.disabled = index === 0;
    upBtn.onclick = (e) => { e.stopPropagation(); movePlaylistItemRemote(index, -1); };
    moveDiv.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.className = 'btn-move';
    downBtn.textContent = '▼';
    downBtn.disabled = index === serverPlaylist.videos.length - 1;
    downBtn.onclick = (e) => { e.stopPropagation(); movePlaylistItemRemote(index, 1); };
    moveDiv.appendChild(downBtn);
    item.appendChild(moveDiv);

    fragment.appendChild(item);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}

// Render remote track controls
function renderRemoteTrackControls() {
  const audioSelect = document.getElementById('remote-audio-track');
  const subtitleSelect = document.getElementById('remote-subtitle-track');
  const thumbnailEl = document.querySelector('.video-thumbnail');
  const thumbnailIcon = document.querySelector('.video-thumbnail-icon');

  if (!serverPlaylist || !serverPlaylist.videos || serverPlaylist.videos.length === 0 || currentServerIndex < 0) {
    document.getElementById('current-video-name').textContent = 'No video playing';
    document.getElementById('current-video-status').textContent = 'Waiting for playlist...';
    audioSelect.innerHTML = '<option>No tracks available</option>';
    audioSelect.disabled = true;
    subtitleSelect.innerHTML = '<option>No tracks available</option>';
    subtitleSelect.disabled = true;
    // Reset thumbnail
    if (thumbnailEl) {
      thumbnailEl.style.backgroundImage = '';
      if (thumbnailIcon) {
        thumbnailIcon.style.display = 'none'; // Default hidden
        thumbnailIcon.textContent = '';
      }
    }
    return;
  }

  const videoInfo = serverPlaylist.videos[currentServerIndex];
  document.getElementById('current-video-name').textContent = videoInfo.filename;
  document.getElementById('current-video-status').textContent = `Video ${currentServerIndex + 1} of ${serverPlaylist.videos.length}`;

  // Apply platform theme
  const platformInfo = applyPlatformTheme(thumbnailEl, videoInfo);
  // Removed icon as per user request
  if (thumbnailIcon) {
    thumbnailIcon.style.display = 'none';
  }

  // Check if this is an image file
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  const isImage = imageExtensions.some(ext => videoInfo.filename.toLowerCase().endsWith(ext));

  if (isImage) {
    // Image files are their own thumbnails
    thumbnailEl.style.backgroundImage = `url('/media/${encodeURIComponent(videoInfo.filename)}')`;
    thumbnailEl.style.backgroundSize = 'cover';
    thumbnailEl.style.backgroundPosition = 'center';
    thumbnailEl.classList.remove('themed');
    if (thumbnailIcon) thumbnailIcon.style.display = 'none';
    currentThumbnailFilename = videoInfo.filename; // Prevent refetch
  }
  // Handle any video with a thumbnail (YouTube, Twitch, Vimeo, etc.)
  else if (videoInfo.thumbnail && typeof videoInfo.thumbnail === 'string') {
    thumbnailEl.style.backgroundImage = `url('${videoInfo.thumbnail}')`;
    thumbnailEl.style.backgroundSize = 'cover';
    thumbnailEl.style.backgroundPosition = 'center';
    thumbnailEl.classList.remove('themed');
    if (thumbnailIcon) thumbnailIcon.style.display = 'none';

    // Use a unique ID or filename for cache key
    const cacheKey = videoInfo.isYouTube ? videoInfo.youtubeId : videoInfo.filename;
    currentThumbnailFilename = cacheKey;
  } else if (!videoInfo.isExternal && !videoInfo.isYouTube) {
    // Local video - fetch thumbnail from server
    fetchThumbnail(videoInfo.filename);
  } else {
    // External content without valid thumbnail - use platform fallback
    applyPlatformTheme(thumbnailEl, videoInfo, true); // Use dark mode
    if (thumbnailIcon) {
      thumbnailIcon.textContent = platformInfo.platformName;
      thumbnailIcon.style.display = 'block';
      thumbnailIcon.style.fontSize = '24px';
      thumbnailIcon.style.fontWeight = 'bold';
    }
  }

  // Audio tracks
  const audioTracks = (videoInfo.tracks && videoInfo.tracks.audio) ? videoInfo.tracks.audio : [];
  audioSelect.innerHTML = '';
  if (audioTracks.length === 0) {
    audioSelect.innerHTML = '<option value="0">Default Audio</option>';
    audioSelect.disabled = true;
  } else {
    audioTracks.forEach((track, idx) => {
      const opt = document.createElement('option');
      // Use idx (Array Index) for consistency with client-side array access
      const trackId = idx;
      opt.value = trackId;

      const displayTitle = track.title || 'Track ' + trackId;
      const lang = track.language || 'und';

      let formatLabel = '';
      if (track.filename) {
        const ext = track.filename.split('.').pop().toLowerCase();
        const displayExt = ext === 'm4a' ? 'AAC' : ext.toUpperCase();
        formatLabel = `[${displayExt}] `;
      }

      opt.textContent = `${formatLabel}${lang} - ${displayTitle}`;
      audioSelect.appendChild(opt);
    });
    audioSelect.disabled = false;
  }

  // Subtitle tracks
  const subtitleTracks = (videoInfo.tracks && videoInfo.tracks.subtitles) ? videoInfo.tracks.subtitles : [];
  subtitleSelect.innerHTML = '<option value="-1">None</option>';
  subtitleTracks.forEach((track, idx) => {
    const opt = document.createElement('option');
    const trackId = idx;
    opt.value = trackId;

    // Log filename to console as requested
    if (track.filename) {
      console.log(`[Subtitle Track ${idx}]`, track.filename);
    }

    // Clean display name - remove filename
    const displayTitle = track.title || `Track ${idx + 1}`;
    // const fileNameInfo = track.filename ? ` (${track.filename})` : ''; // Hidden

    const lang = track.language || 'und';

    // Extract format
    let formatLabel = '';
    if (track.filename) {
      const ext = track.filename.split('.').pop().toLowerCase();
      if (ext === 'ass' || ext === 'ssa') formatLabel = '[ASS] ';
      else if (ext === 'vtt') formatLabel = '[VTT] ';
      else formatLabel = `[${ext.toUpperCase()}] `;
    }

    opt.textContent = `${formatLabel}${lang} - ${displayTitle}`;
    subtitleSelect.appendChild(opt);
  });
  subtitleSelect.appendChild(document.createElement('option')).textContent = "---"; // Separator just in caseVisual
  subtitleSelect.disabled = false;
  subtitleSelect.disabled = false;

  // Set selected values
  if (videoInfo.selectedAudioTrack !== undefined) {
    audioSelect.value = videoInfo.selectedAudioTrack;
  }
  if (videoInfo.selectedSubtitleTrack !== undefined) {
    subtitleSelect.value = videoInfo.selectedSubtitleTrack;
  }

  // Initialize/Update custom dropdowns
  setupCustomDropdown(audioSelect);
  setupCustomDropdown(subtitleSelect);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadFiles();
  initNavIndicator();

  document.getElementById('launch-btn').addEventListener('click', launchPlaylist);
  document.getElementById('play-btn').addEventListener('click', playVideo);
  document.getElementById('pause-btn').addEventListener('click', pauseVideo);
  document.getElementById('skip-back-btn').addEventListener('click', skipBack);
  document.getElementById('skip-forward-btn').addEventListener('click', skipForward);
  document.getElementById('skip-media-btn').addEventListener('click', () => {
    socket.emit('skip-to-next-video');
    showStatus('Skipping to next media...', 'info');
  });
  document.getElementById('skip-intro-btn').addEventListener('click', () => {
    socket.emit('control', { action: 'skip', direction: 'forward', seconds: skipIntroSeconds });
    showStatus(`Skipping intro (${skipIntroSeconds}s)...`, 'info');
  });
  document.getElementById('seek-btn').addEventListener('click', seekTo);

  // Get current time button
  document.getElementById('get-time-btn').addEventListener('click', () => {
    socket.emit('request-sync');
  });

  // Relaunch button - relaunches the current playlist
  document.getElementById('relaunch-btn').addEventListener('click', () => {
    if (playlist.length === 0 && serverPlaylist && serverPlaylist.videos.length > 0) {
      // Use server playlist if local is empty
      socket.emit('set-playlist', {
        playlist: serverPlaylist.videos,
        mainVideoIndex: serverPlaylist.mainVideoIndex,
        startTime: 0
      });
      showStatus('Relaunching playlist...', 'info');
    } else if (playlist.length > 0) {
      // Use local playlist
      if (mainVideoIndex === -1) mainVideoIndex = 0;
      socket.emit('set-playlist', {
        playlist: playlist,
        mainVideoIndex: mainVideoIndex,
        startTime: 0
      });
      showStatus('Relaunching playlist...', 'info');
    }
  });

  // Track selection handlers
  document.getElementById('remote-audio-track').addEventListener('change', (e) => {
    socket.emit('track-change', {
      videoIndex: currentServerIndex,
      type: 'audio',
      trackIndex: parseInt(e.target.value)
    });
  });

  document.getElementById('remote-subtitle-track').addEventListener('change', (e) => {
    socket.emit('track-change', {
      videoIndex: currentServerIndex,
      type: 'subtitle',
      trackIndex: parseInt(e.target.value)
    });
  });

  // BSL buttons
  // Trigger new BSL check (prompts clients who haven't selected folder)
  const triggerBslCheck = () => {
    socket.emit('bsl-check-request');
    const modal = document.getElementById('bsl-modal');
    modal.classList.add('visible');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        modal.classList.add('animate');
      });
    });
    document.getElementById('bsl-modal-body').innerHTML =
      '<div class="empty-message">Waiting for clients to select their local folders...</div>';
  };

  // View stored BSL status (no new prompts)
  const viewBslStatus = () => {
    socket.emit('bsl-get-status');
    const modal = document.getElementById('bsl-modal');
    modal.classList.add('visible');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        modal.classList.add('animate');
      });
    });
  };

  document.getElementById('bsl-check-btn').addEventListener('click', triggerBslCheck);
  document.getElementById('dashboard-bsl-btn').addEventListener('click', triggerBslCheck);
  document.getElementById('remote-bsl-btn').addEventListener('click', viewBslStatus);
  document.getElementById('bsl-modal-close').addEventListener('click', () => {
    const modal = document.getElementById('bsl-modal');
    modal.classList.remove('animate');
    setTimeout(() => modal.classList.remove('visible'), 300);
  });

  // Clients modal close
  document.getElementById('clients-modal-close').addEventListener('click', () => {
    const modal = document.getElementById('clients-modal');
    modal.classList.remove('animate');
    setTimeout(() => modal.classList.remove('visible'), 300);
  });

  socket.emit('get-config');
  socket.emit('request-sync');  // Get current speed state immediately

  // Init static dropdowns (FFmpeg tools, etc.)
  document.querySelectorAll('select').forEach(sel => setupCustomDropdown(sel));
});

// Open Clients Modal
function openClientsModal() {
  const modal = document.getElementById('clients-modal');
  modal.classList.add('visible');
  // Trigger animation after display change
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      modal.classList.add('animate');
    });
  });
  document.getElementById('clients-modal-body').innerHTML = '<div class="empty-message">Loading clients...</div>';
  socket.emit('get-client-list');
}

// Render connected clients in modal
function renderClientsModal(clients) {
  const body = document.getElementById('clients-modal-body');

  if (!clients || clients.length === 0) {
    body.innerHTML = '<div class="empty-message">No clients connected</div>';
    return;
  }

  let html = '';
  clients.forEach(client => {
    const safeDisplayName = escapeHTML(client.displayName || 'Unnamed');
    const safeSocketId = escapeHTML(client.socketId?.slice(-8) || '');
    const safeFingerprint = escapeHTML(client.fingerprint || 'Unknown');
    const safeDisplayValue = escapeHTML(client.displayName || '');
    const safeFingerprintData = escapeHTML(client.fingerprint || '');

    html += `
          <div class="bsl-client-card">
            <div class="bsl-client-header">
              <strong style="color: #2196F3;">${safeDisplayName}</strong>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12px; font-family: monospace;">
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #888;">Socket ID:</span>
                <span style="color: #9C27B0;">${safeSocketId}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #888;">Fingerprint:</span>
                <span style="color: #FF9800;">${safeFingerprint}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
                <label style="color: #888;">Display Name:</label>
                <input type="text" value="${safeDisplayValue}" 
                  data-fingerprint="${safeFingerprintData}"
                  placeholder="Enter name..."
                  onchange="updateClientName(this)"
                  style="flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #e0e0e0; font-size: 12px;">
              </div>
            </div>
          </div>
        `;
  });

  body.innerHTML = html;
}

// Update client display name
function updateClientName(inputEl) {
  const fingerprint = inputEl.dataset.fingerprint;
  const displayName = inputEl.value.trim();
  if (fingerprint) {
    socket.emit('set-client-display-name', { fingerprint, displayName });
    addLog(`Set client name: ${displayName}`, 'info');
  }
}

// Handle client list response
socket.on('client-list', (clients) => {
  renderClientsModal(clients);
});

// Update remote control availability based on sync level
function updateControlAvailability() {
  if (!serverPlaylist || !serverPlaylist.videos || currentServerIndex < 0) return;

  const video = serverPlaylist.videos[currentServerIndex];
  const syncLevel = video.syncLevel || 'full'; // Default to full for legacy/youtube/local

  const playBtn = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const skipBackBtn = document.getElementById('skip-back-btn');
  const skipForwardBtn = document.getElementById('skip-forward-btn');
  const seekBtn = document.getElementById('seek-btn');
  const seekInput = document.getElementById('seek-time');

  // Controls to manage
  const controls = [playBtn, pauseBtn, skipBackBtn, skipForwardBtn, seekBtn, seekInput];

  // Reset all to enabled
  controls.forEach(el => {
    if (el) {
      el.disabled = false;
      el.style.opacity = '1';
      el.style.cursor = 'pointer';
      el.title = '';
    }
  });

  if (syncLevel === 'limited') {
    // Limited: No seeking or skip seconds
    [seekBtn, seekInput, skipBackBtn, skipForwardBtn].forEach(el => {
      if (el) {
        el.disabled = true;
        el.style.opacity = '0.5';
        el.style.cursor = 'not-allowed';
        el.title = 'Not available for this platform';
      }
    });
  } else if (syncLevel === 'autoplay') {
    // Autoplay: No controls except playlist navigation
    controls.forEach(el => {
      if (el) {
        el.disabled = true;
        el.style.opacity = '0.5';
        el.style.cursor = 'not-allowed';
        el.title = 'Autoplay only - controls disabled';
      }
    });
  }
}

// Socket handlers
// Config handler merged into top config listener

socket.on('playlist-update', (playlistObj) => {
  serverPlaylist = playlistObj;
  currentServerIndex = playlistObj.currentIndex;
  renderRemotePlaylistSidebar();
  renderRemoteTrackControls();
  updateControlAvailability();

  // Sync server playlist to media tab if we have videos
  if (playlistObj.videos && playlistObj.videos.length > 0) {
    playlist = [...playlistObj.videos];
    mainVideoIndex = playlistObj.mainVideoIndex >= 0 ? playlistObj.mainVideoIndex : 0;
    updatePlaylistDisplay();
    updateHevcWarning();
    updateDashboardStats();
    // Refresh FFmpeg Tools dropdowns
    if (typeof refreshFfmpegFileList === 'function') {
      refreshFfmpegFileList();
    }
    // Change Launch button to Relaunch since playlist is already active
    document.getElementById('launch-btn').innerHTML = '🔄 Relaunch Playlist';
  }
});

socket.on('playlist-position', (index) => {
  addLog(`Jumped to video ${index + 1}`, 'info');
  currentServerIndex = index;
  renderRemotePlaylistSidebar();
  renderRemoteTrackControls();
  updateControlAvailability();
});

socket.on('track-change', (data) => {
  if (!serverPlaylist || !serverPlaylist.videos) return;
  const vid = serverPlaylist.videos[data.videoIndex];
  if (!vid) return;
  if (data.type === 'audio') {
    vid.selectedAudioTrack = data.trackIndex;
  } else if (data.type === 'subtitle') {
    vid.selectedSubtitleTrack = data.trackIndex;
  }
  if (data.videoIndex === currentServerIndex) {
    renderRemoteTrackControls();
  }
});

// Client count update handler
socket.on('client-count', (count) => {
  const prevCount = parseInt(document.getElementById('client-count').textContent) || 0;
  document.getElementById('client-count').textContent = count;
  if (count > prevCount) {
    addLog(`Client connected (total: ${count})`, 'client');
  } else if (count < prevCount) {
    addLog(`Client disconnected (total: ${count})`, 'warning');
  }
});

// Log playlist events
socket.on('playlist-set', (data) => {
  if (data.success) {
    addLog('Playlist launched successfully', 'success');
    showStatus(data.message || 'Playlist launched!', 'success');
    document.getElementById('playback-status').textContent = 'Playing';
    if (preventRemoteRedirect) {
      preventRemoteRedirect = false;
    } else {
      setTimeout(() => switchView('remote'), 1500);
    }
  } else {
    addLog('Failed to launch playlist: ' + (data.message || 'Unknown error'), 'error');
    showStatus(data.message || 'Failed to launch!', 'error');
  }
});

// Log sync events and update time display
const throttledSyncHandler = throttle((state) => {
  if (state.isPlaying !== undefined) {
    addLog(`Playback: ${state.isPlaying ? 'Playing' : 'Paused'}`, 'info');
  }
  // Update time display
  if (state.currentTime !== undefined) {
    // Clamp to 0 to prevent negative values from rewind
    const totalSecs = Math.max(0, Math.floor(state.currentTime));
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    const timeStr = hours > 0
      ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
      : `${mins}:${secs.toString().padStart(2, '0')}`;
    const displayEl = dom.currentTime || document.getElementById('current-time-display');
    if (displayEl) displayEl.textContent = `Current: ${timeStr} (${totalSecs}s)`;
  }

  // Update playback speed if changed
  if (state.playbackRate !== undefined && state.playbackRate !== currentSpeed) {
    currentSpeed = state.playbackRate;
    updateSpeedDisplay();
  }
}, 1000); // Only update UI once per second

socket.on('sync', throttledSyncHandler);

// Connection merged above

socket.on('disconnect', () => {
  // Update connection status UI
  const dot = document.getElementById('connection-dot');
  const text = document.getElementById('connection-text');
  if (dot && text) {
    dot.classList.add('offline');
    text.textContent = 'Disconnected';
  }
});

socket.on('connect_error', () => {
  const dot = document.getElementById('connection-dot');
  const text = document.getElementById('connection-text');
  if (dot && text) {
    dot.classList.add('offline');
    text.textContent = 'Offline';
  }
});

if (socket.connected) {
  socket.emit('bsl-admin-register', { fingerprint: adminFingerprint });
}

// Speed Control Logic
let currentSpeed = 1.0;
const speedStep = 0.25;
const minSpeed = 0.25;
const maxSpeed = 3.0;

function handleSpeed(change) {
  let newSpeed = currentSpeed + change;
  // Precision rounding
  newSpeed = Math.round(newSpeed * 100) / 100;

  if (newSpeed >= minSpeed && newSpeed <= maxSpeed) {
    currentSpeed = newSpeed;
    updateSpeedDisplay();

    // Send control event
    socket.emit('control', {
      action: 'rate',
      rate: currentSpeed
    });

    addLog(`Set speed to ${currentSpeed}x`, 'info');
  }
}

function updateSpeedDisplay() {
  const display = document.getElementById('speed-display');
  if (display) {
    display.textContent = currentSpeed + 'x';
  }
}

// Set initial listeners
document.getElementById('speed-down-btn').addEventListener('click', () => handleSpeed(-speedStep));
document.getElementById('speed-up-btn').addEventListener('click', () => handleSpeed(speedStep));

// Kill Playlist Logic
// Kill Playlist Logic
const killBtn = document.getElementById('kill-playlist-btn');
let killTimeout;
let killState = 'initial';

if (killBtn) {
  killBtn.addEventListener('click', () => {
    if (killState === 'initial') {
      killState = 'confirming';
      killBtn.textContent = 'Are you sure?';
      // Visual feedback for warning state (Orange)
      killBtn.style.background = '#ef6c00';

      if (killTimeout) clearTimeout(killTimeout);
      killTimeout = setTimeout(() => {
        killState = 'initial';
        killBtn.textContent = 'Kill Playlist';
        // Revert to original Red
        killBtn.style.background = '#c62828';
      }, 5000);
    } else {
      // Action Confirmed
      if (killTimeout) clearTimeout(killTimeout);
      killState = 'initial';
      killBtn.textContent = 'Kill Playlist';
      killBtn.style.background = '#c62828';

      // Set flag to prevent redirect to remote view
      preventRemoteRedirect = true;

      // Emit clear playlist command
      socket.emit('set-playlist', {
        playlist: [],
        mainVideoIndex: -1,
        startTime: 0
      });

      addLog('Playlist killed by admin', 'warning');

      // Redirect to media tab
      switchView('media');
    }
  });
}

// Handle sync event to update speed
// Sync handler merged into throttledSyncHandler

// Handle admin auth result
socket.on('admin-auth-result', (result) => {
  const authScreen = document.getElementById('auth-screen');
  const authContent = document.getElementById('auth-content');
  const adminUI = document.getElementById('admin-ui');

  if (result.success) {
    // Hide auth screen and show admin UI
    authScreen.classList.add('hidden');
    adminUI.classList.add('authenticated');
    // Initialize nav indicator now that UI is visible
    initNavIndicator();
  } else {
    // Show access denied message in auth screen (escape the reason to prevent XSS)
    const safeReason = escapeHTML(result.reason || 'Access denied');
    authContent.innerHTML = `
          <div class="auth-denied">
            <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
            <h1 style="color: #f44336; margin-bottom: 15px;">Access Denied</h1>
            <p style="color: #ccc; margin-bottom: 20px;">${safeReason}</p>
            <p style="color: #888; font-size: 14px;">
              If you need to reset admin access, delete the file:<br>
              <code style="background: rgba(255,255,255,0.1); padding: 5px 10px; border-radius: 4px;">memory.json</code>
            </p>
          </div>
        `;
  }
});

let bslStatus = null;

socket.on('bsl-check-started', (data) => {
  addLog(`BSL-S² check started (${data.clientCount} clients)`, 'info');
  if (data.clientCount === 0) {
    document.getElementById('bsl-modal-body').innerHTML =
      '<div class="empty-message">No clients connected yet.</div>';
  }
});

socket.on('bsl-status-update', (data) => {
  bslStatus = data;
  renderBslModal(data);
  // Log BSL status summary
  if (data.clients && data.clients.length > 0) {
    const totalMatches = data.clients.reduce((sum, c) => sum + Object.keys(c.matchedVideos).length, 0);
    addLog(`BSL-S² update: ${data.clients.length} clients, ${totalMatches} total matches`, 'success');
  }
});

function renderBslModal(data) {
  const modalBody = dom.bslBody || document.getElementById('bsl-modal-body');
  if (!modalBody) return;

  if (!data.clients || data.clients.length === 0) {
    modalBody.innerHTML = '<div class="empty-message">No clients have selected folders yet</div>';
    return;
  }

  let html = `<p style="color:#888;margin-bottom:15px;">Mode: <strong>${data.mode === 'all' ? 'All clients must have file' : 'Any client with file'}</strong></p>`;

  data.clients.forEach((client, clientIdx) => {
    const matchCount = Object.keys(client.matchedVideos).length;
    const displayName = escapeHTML(client.clientName || `Client ${clientIdx + 1}`);
    const safeClientId = escapeHTML(client.clientId || '');
    const fingerprintShort = escapeHTML((client.clientId || '').slice(-4));
    const safeSocketId = escapeHTML(client.socketId || '');
    const driftValues = client.driftValues || {};

    html += `
      <div class="bsl-client-card">
        <div class="bsl-client-header">
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="text" 
                   class="client-name-input" 
                   value="${displayName}" 
                   data-client-id="${safeClientId}"
                   title="Fingerprint: ${safeClientId}"
                   style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); 
                          border-radius: 4px; padding: 4px 8px; color: white; width: 150px; font-size: 13px;"
                   onchange="setClientName(this)"
                   onkeypress="if(event.key==='Enter') this.blur()">
            <span style="color: #666; font-size: 11px;">(${fingerprintShort})</span>
          </div>
          <span class="bsl-badge ${matchCount > 0 ? 'bsl-positive' : 'bsl-negative'}">
            ${matchCount}/${playlist.length} matched
          </span>
        </div>
        <div class="bsl-file-list">
    `;

    if (client.files.length === 0) {
      html += '<div class="empty-message">No video files found</div>';
    } else {
      client.files.forEach(file => {
        const safeFileName = escapeHTML(file.name || '');
        const matchedIdx = Object.entries(client.matchedVideos)
          .find(([idx, name]) => name === file.name)?.[0];

        const currentDrift = matchedIdx !== undefined ? (driftValues[matchedIdx] || 0) : 0;

        html += `
          <div class="bsl-file-item">
            <span style="flex: 1; overflow: hidden; text-overflow: ellipsis;">${safeFileName}</span>
            <div style="display: flex; align-items: center; gap: 8px;">
              ${matchedIdx !== undefined ? `
                <div style="display: flex; align-items: center; gap: 4px;" title="Drift: offset client playback time (±60s)">
                  <span style="color: #888; font-size: 10px;">Drift:</span>
                  <input type="number" 
                         class="bsl-drift-input"
                         value="${currentDrift}"
                         min="-60" max="60" step="1"
                         data-client-fingerprint="${safeClientId}"
                         data-playlist-index="${matchedIdx}"
                         onchange="handleDriftChange(this)"
                         style="width: 50px; padding: 2px 4px; background: rgba(255,255,255,0.05); 
                                border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; 
                                color: #e0e0e0; font-size: 11px; text-align: center;">
                  <span style="color: #888; font-size: 10px;">s</span>
                </div>
              ` : ''}
              <select class="bsl-match-select" 
                      data-client-id="${safeSocketId}" 
                      data-file-name="${safeFileName}"
                      onchange="handleManualMatch(this)">
                <option value="-1" ${!matchedIdx ? 'selected' : ''}>Not matched</option>
                ${playlist.map((v, i) => `
                  <option value="${i}" ${matchedIdx == i ? 'selected' : ''}>${escapeHTML(v.filename)}</option>
                `).join('')}
              </select>
            </div>
          </div>
        `;
      });
    }

    html += '</div></div>';
  });

  modalBody.innerHTML = html;
}

function handleDriftChange(inputEl) {
  const clientFingerprint = inputEl.dataset.clientFingerprint;
  const playlistIndex = parseInt(inputEl.dataset.playlistIndex);
  const driftSeconds = parseInt(inputEl.value) || 0;

  socket.emit('bsl-set-drift', {
    clientFingerprint,
    playlistIndex,
    driftSeconds
  });
}

function handleManualMatch(selectEl) {
  const clientSocketId = selectEl.dataset.clientId;
  const clientFileName = selectEl.dataset.fileName;
  const playlistIndex = parseInt(selectEl.value);

  if (playlistIndex >= 0) {
    socket.emit('bsl-manual-match', {
      clientSocketId,
      clientFileName,
      playlistIndex
    });
  }
}

function setClientName(inputEl) {
  const clientId = inputEl.dataset.clientId;
  const displayName = inputEl.value.trim();
  if (clientId && displayName) {
    socket.emit('set-client-name', { clientId, displayName });
  }
}

window.handleManualMatch = handleManualMatch;
window.setClientName = setClientName;

// ==================== External Content Modal Functions ====================

let currentExternalData = null;

// Platform detection patterns
const PLATFORM_PATTERNS = {
  youtube: {
    patterns: [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
      /^([a-zA-Z0-9_-]{11})$/
    ],
    name: 'YouTube',
    badge: 'badge-youtube',
    syncLevel: 'full'
  },
  vimeo: {
    patterns: [/vimeo\.com\/(\d+)/],
    name: 'Vimeo',
    badge: 'badge-vimeo',
    syncLevel: 'full'
  },
  dailymotion: {
    patterns: [/dailymotion\.com\/video\/([a-zA-Z0-9]+)/],
    name: 'Dailymotion',
    badge: 'badge-dailymotion',
    syncLevel: 'full'
  },
  twitch: {
    patterns: [
      /clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/,
      /twitch\.tv\/videos\/(\d+)/,
      /twitch\.tv\/([a-zA-Z0-9_]+)$/
    ],
    name: 'Twitch',
    badge: 'badge-twitch',
    syncLevel: 'limited'
  },
  soundcloud: {
    patterns: [/soundcloud\.com\/([^\/]+\/[^\/]+)/],
    name: 'SoundCloud',
    badge: 'badge-soundcloud',
    syncLevel: 'limited'
  },
  streamable: {
    patterns: [/streamable\.com\/([a-zA-Z0-9]+)/],
    name: 'Streamable',
    badge: 'badge-streamable',
    syncLevel: 'autoplay'
  },
  gdrive: {
    patterns: [/drive\.google\.com.*\/d\/([^\/]+)/],
    name: 'Google Drive',
    badge: 'badge-gdrive',
    syncLevel: 'autoplay'
  },
  kick: {
    patterns: [/kick\.com\/([a-zA-Z0-9_]+)/],
    name: 'Kick',
    badge: 'badge-kick',
    syncLevel: 'autoplay'
  },
  directUrl: {
    patterns: [/\.(mp4|webm|m3u8|ogg)(\?.*)?$/i],
    name: 'Direct URL',
    badge: 'badge-url',
    syncLevel: 'full'
  },
  rumble: {
    patterns: [
      /rumble\.com\/embed\/([a-zA-Z0-9]+)/,
      /rumble\.com\/([a-zA-Z0-9-]+)\.html/
    ],
    name: 'Rumble',
    badge: 'badge-rumble',
    syncLevel: 'autoplay'
  }
};

// Detect platform from URL
function detectPlatform(url) {
  for (const [platform, config] of Object.entries(PLATFORM_PATTERNS)) {
    for (const pattern of config.patterns) {
      const match = url.match(pattern);
      if (match) {
        return { platform, id: match[1], config };
      }
    }
  }
  return null;
}

// Fetch content info via oEmbed or other methods
async function fetchExternalInfo(platform, id, url) {
  let oembedUrl = null;
  let thumbnail = null;
  let title = 'External Content';
  let author = platform;

  try {
    switch (platform) {
      case 'youtube':
        oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
        thumbnail = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        break;
      case 'vimeo':
        oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`;
        break;
      case 'dailymotion':
        oembedUrl = `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(`https://www.dailymotion.com/video/${id}`)}&format=json`;
        break;
      case 'soundcloud':
        oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        break;
      case 'streamable':
        oembedUrl = `https://api.streamable.com/oembed.json?url=${encodeURIComponent(`https://streamable.com/${id}`)}`;
        break;
      case 'twitch':
        title = `Twitch: ${id}`;
        thumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${id}-320x180.jpg`;
        return { title, author: 'Twitch', thumbnail };
      case 'gdrive':
        title = `Google Drive Video`;
        thumbnail = `https://drive.google.com/thumbnail?id=${id}&sz=w320`;
        return { title, author: 'Google Drive', thumbnail };
      case 'kick':
        title = `Kick: ${id}`;
        return { title, author: 'Kick', thumbnail: null };
      case 'directUrl':
        title = url.split('/').pop().split('?')[0] || 'Video';
        return { title, author: 'Direct URL', thumbnail: null };
      case 'rumble':
        oembedUrl = `https://rumble.com/api/Media/oembed.json?url=${encodeURIComponent(url)}`;
        break;
    }

    if (oembedUrl) {
      const response = await fetch(oembedUrl);
      if (response.ok) {
        const data = await response.json();
        title = data.title || title;
        author = data.author_name || data.provider_name || author;
        thumbnail = data.thumbnail_url || thumbnail;

        // For Rumble, we need to extract the REAL embed ID from the html field if possible
        // The public ID in the URL often differs from the embed ID
        if (platform === 'rumble' && data.html) {
          const embedMatch = data.html.match(/src="https:\/\/rumble\.com\/embed\/([a-zA-Z0-9]+)\/?"/);
          if (embedMatch && embedMatch[1]) {
            // Return the extracted embed ID as the 'id' effectively overriding the regex one
            return { title, author, thumbnail, id: embedMatch[1] };
          }
        }
      }
    }
  } catch (error) {
    console.log('Could not fetch oEmbed:', error);
  }

  return { title, author, thumbnail };
}

// Open External modal
function openExternalModal() {
  const modal = document.getElementById('external-modal');
  modal.classList.add('visible');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      modal.classList.add('animate');
    });
  });

  // Reset modal state
  document.getElementById('external-url-input').value = '';
  document.getElementById('external-preview').classList.remove('visible');
  document.getElementById('external-error').classList.remove('visible');
  document.getElementById('external-add-btn').disabled = true;
  currentExternalData = null;

  setTimeout(() => document.getElementById('external-url-input').focus(), 100);
}

// Close External modal
function closeExternalModal() {
  const modal = document.getElementById('external-modal');
  modal.classList.remove('animate');
  setTimeout(() => modal.classList.remove('visible'), 300);
}

// Handle URL input
async function handleExternalUrlInput(url) {
  const preview = document.getElementById('external-preview');
  const errorDiv = document.getElementById('external-error');
  const addBtn = document.getElementById('external-add-btn');

  preview.classList.remove('visible');
  errorDiv.classList.remove('visible');
  addBtn.disabled = true;
  currentExternalData = null;

  if (!url.trim()) return;

  const detected = detectPlatform(url.trim());
  if (!detected) {
    errorDiv.textContent = 'Unsupported URL. See supported platforms below.';
    errorDiv.classList.add('visible');
    return;
  }

  try {
    const info = await fetchExternalInfo(detected.platform, detected.id, url.trim());
    currentExternalData = {
      platform: detected.platform,
      platformName: detected.config.name,
      id: detected.id,
      url: url.trim(),
      syncLevel: detected.config.syncLevel,
      badge: detected.config.badge,
      ...info
    };

    // If fetchExternalInfo returned a specific ID (like for Rumble), use it
    if (info.id) {
      currentExternalData.id = info.id;
    }

    // Update preview
    const thumbEl = document.getElementById('external-thumb');
    if (info.thumbnail) {
      thumbEl.src = info.thumbnail;
      thumbEl.style.display = '';
    } else {
      thumbEl.style.display = 'none';
    }
    document.getElementById('external-title').textContent = info.title;
    document.getElementById('external-platform').textContent = `${detected.config.name} • ${detected.config.syncLevel === 'full' ? '✅ Full Sync' : detected.config.syncLevel === 'limited' ? '⚠️ Limited Sync' : '📺 Autoplay Only'}`;
    preview.classList.add('visible');
    addBtn.disabled = false;
  } catch (error) {
    errorDiv.textContent = error.message;
    errorDiv.classList.add('visible');
  }
}

// Add external content to playlist
function addExternalToPlaylist() {
  if (!currentExternalData) return;

  const entry = {
    filename: currentExternalData.title,
    isExternal: true,
    platform: currentExternalData.platform,
    platformName: currentExternalData.platformName,
    externalId: currentExternalData.id,
    externalUrl: currentExternalData.url,
    syncLevel: currentExternalData.syncLevel,
    badge: currentExternalData.badge,
    title: currentExternalData.title,
    thumbnail: currentExternalData.thumbnail,
    author: currentExternalData.author,
    // Keep backward compatibility with YouTube
    isYouTube: currentExternalData.platform === 'youtube',
    youtubeId: currentExternalData.platform === 'youtube' ? currentExternalData.id : null,
    tracks: { audio: [], subtitles: [] },
    isNew: true
  };

  // Check if already in playlist
  const isDuplicate = playlist.some(item =>
    item.isExternal && item.platform === entry.platform && item.externalId === entry.externalId
  );

  if (!isDuplicate) {
    playlist.push(entry);
    updatePlaylistDisplay();
    updateDashboardStats();
    setTimeout(() => { entry.isNew = false; }, 300);
    closeExternalModal();
    addLog(`${currentExternalData.platformName} content added: ${currentExternalData.title}`, 'success');
  } else {
    document.getElementById('external-error').textContent = 'This content is already in the playlist.';
    document.getElementById('external-error').classList.add('visible');
  }
}

// Initialize External modal event listeners
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('external-modal-close').addEventListener('click', closeExternalModal);

  let externalInputTimeout;
  document.getElementById('external-url-input').addEventListener('input', (e) => {
    clearTimeout(externalInputTimeout);
    externalInputTimeout = setTimeout(() => handleExternalUrlInput(e.target.value), 500);
  });

  document.getElementById('external-url-input').addEventListener('paste', (e) => {
    setTimeout(() => handleExternalUrlInput(e.target.value), 50);
  });

  document.getElementById('external-add-btn').addEventListener('click', addExternalToPlaylist);
});

// ==========================================
// FFmpeg Tools Logic
// ==========================================

let ffmpegAuthenticated = false;

async function authenticateFfmpeg(autoLoginPassword = null) {
  const passwordInput = document.getElementById('ffmpeg-password-input');
  const password = typeof autoLoginPassword === 'string' ? autoLoginPassword : passwordInput.value;

  try {
    const response = await fetch('/api/ffmpeg/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await response.json();

    if (data.success) {
      ffmpegAuthenticated = true;
      document.getElementById('ffmpeg-auth-overlay').style.display = 'none';
      document.getElementById('ffmpeg-content').style.display = 'block';
      sessionStorage.setItem('ffmpeg_password', password);

      scanEncoders();
      refreshFfmpegJobs();
      // Auto-refresh jobs every 2 seconds
      if (window.ffmpegJobInterval) clearInterval(window.ffmpegJobInterval);
      window.ffmpegJobInterval = setInterval(refreshFfmpegJobs, 2000);
    } else {
      showToast('Invalid password', 3000, true);
      passwordInput.value = '';
      passwordInput.focus();
    }
  } catch (error) {
    console.error('Auth error:', error);
    showToast('Authentication failed', 3000, true);
  }
}

async function scanEncoders() {
  try {
    const response = await fetch('/api/ffmpeg/encoders');
    const data = await response.json();

    const badgeContainer = document.getElementById('encoder-list');
    badgeContainer.innerHTML = '';

    if (data.encoders && data.encoders.length > 0) {
      data.encoders.forEach(enc => {
        const span = document.createElement('span');
        span.className = 'encoder-badge active';
        span.textContent = enc.toUpperCase();
        badgeContainer.appendChild(span);

        // Add to dropdown if not exists (libx264/cpu are default)
        const dropdown = document.getElementById('reencode-encoder');
        // Check if option exists
        if (![...dropdown.options].some(o => o.value === enc)) {
          const opt = document.createElement('option');
          opt.value = enc;
          opt.textContent = enc.toUpperCase() + ' (Hardware)';
          dropdown.appendChild(opt);
        }
      });
    } else {
      badgeContainer.innerHTML = '<span class="encoder-badge">None found (CPU only)</span>';
    }

    // Refresh the custom dropdown UI for the encoder select
    const dropdown = document.getElementById('reencode-encoder');
    setupCustomDropdown(dropdown);

  } catch (e) {
    console.error('Scan encoders error:', e);
  }
}

// Refresh file lists for dropdowns
function refreshFfmpegFileList() {
  const inputs = ['remux-file-input', 'reencode-file-input', 'extract-file-input'];
  inputs.forEach(id => {
    const select = document.getElementById(id);
    const currentVal = select.value;
    select.innerHTML = '<option value="">Select source file...</option>';

    // Use all media files instead of just the playlist
    const videoFiles = allMediaFiles.length > 0 ? allMediaFiles : (typeof playlist !== 'undefined' ? playlist : []);

    if (videoFiles.length > 0) {
      videoFiles.forEach(file => {
        const opt = document.createElement('option');
        opt.value = file.filename;
        opt.textContent = file.filename;
        select.appendChild(opt);
      });
    }

    if (currentVal) select.value = currentVal;
    // Refresh custom UI
    setupCustomDropdown(select);
  });

  // Refresh Track Tool lists as well
  if (typeof refreshSubtitleToolLists === 'function') {
    refreshSubtitleToolLists();
  }
}

// Mock job queue refresh for now
async function refreshFfmpegJobs() {
  try {
    const response = await fetch('/api/ffmpeg/jobs');
    const data = await response.json();
    const queue = document.getElementById('ffmpeg-queue');
    queue.innerHTML = '';

    if (data.jobs && data.jobs.length > 0) {
      data.jobs.forEach(job => {
        const div = document.createElement('div');
        div.className = 'job-card';
        // Simple styling for job card
        div.style.padding = '10px';
        div.style.backgroundColor = 'rgba(255,255,255,0.05)';
        div.style.borderRadius = '5px';
        div.style.marginBottom = '8px';
        div.style.borderLeft = `3px solid ${job.status === 'completed' ? '#00e676' : job.status === 'failed' ? '#ff1744' : job.status === 'running' ? '#2979ff' : '#888'}`;

        let labelText = job.filename;
        let subText = `(${job.preset || ''})`;

        if (job.type === 'track-tool' && job.options) {
          labelText = `${job.options.action.toUpperCase()} ➔ ${job.options.targetVideo}`;
          subText = '';
        }

        div.innerHTML = `
                  <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                     <span style="font-weight:bold; color:#fff;">${job.type.toUpperCase()} <small style="opacity:0.7">#${job.id}</small></span>
                     <span style="font-size:12px; opacity:0.8">${job.status.toUpperCase()}</span>
                  </div>
                  <div style="font-size:12px; color:#aaa; margin-bottom:5px;">
                     ${labelText} <span style="opacity:0.5">${subText}</span>
                  </div>
                  ${job.error ? `<div style="color:#ff1744; font-size:11px;">Error: ${job.error}</div>` : ''}
                  ${job.status === 'running' && job.type !== 'track-tool' ? `
                    <div style="background:rgba(255,255,255,0.1); height:4px; border-radius:2px; margin-top:5px; overflow:hidden;">
                       <div style="background:#2979ff; width:${job.progress}%; height:100%;"></div>
                    </div>` : ''}
                  ${job.status === 'running' && job.type === 'track-tool' ? `
                    <div style="background:rgba(255,255,255,0.1); height:4px; border-radius:2px; margin-top:5px; overflow:hidden;">
                       <div style="background:#00e676; width:100%; height:100%; animation: pulse 1s infinite;"></div>
                    </div>` : ''}
                  ${job.status === 'completed' && job.duration ? `
                    <div style="text-align:right; font-size:10px; color:#aaa; margin-top:4px;">
                       Took ${job.duration.toFixed(1)}s
                    </div>` : ''}
                `;
        queue.appendChild(div);
      });
    } else {
      queue.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">No active jobs</div>';
    }
  } catch (e) {
    console.error("Job refresh error:", e);
  }
}

async function runFfmpegPreset(type) {
  let filename, preset, options = {};

  if (type === 'remux') {
    filename = document.getElementById('remux-file-input').value;
    preset = document.getElementById('remux-preset').value;
  } else if (type === 'reencode') {
    filename = document.getElementById('reencode-file-input').value;
    preset = document.getElementById('reencode-quality').value; // Using quality as simplified preset key for now
    options.encoder = document.getElementById('reencode-encoder').value;
    options.resolution = document.getElementById('reencode-resolution').value;
  } else if (type === 'extract') {
    filename = document.getElementById('extract-file-input').value;
    preset = document.getElementById('extract-format').value;
    options.trackType = document.getElementById('extract-type').value;
  }

  if (!filename) {
    showToast('Please select a file first', 2000, true);
    return;
  }

  const password = sessionStorage.getItem('ffmpeg_password');

  try {
    const response = await fetch('/api/ffmpeg/run-preset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        password,
        type,
        filename,
        preset,
        options
      })
    });

    const data = await response.json();
    if (data.success) {
      showToast('Job started successfully!', 2000);
      refreshFfmpegJobs();
      startJobPolling();
    } else {
      showToast(data.error || 'Failed to start job', 3000, true);
    }
  } catch (e) {
    console.error(e);
    showToast('Request failed', 3000, true);
  }
}

let pollingInterval;
function startJobPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(refreshFfmpegJobs, 2000);
}

// Auto-login check if session matches
const savedFfmpegPassword = sessionStorage.getItem('ffmpeg_password');
if (savedFfmpegPassword) {
  // Ideally verify, but for UX immediately try to show content if we trust session
  authenticateFfmpeg(savedFfmpegPassword);
}

window.openExternalModal = openExternalModal;

// ==================== Custom Dropdown Logic ====================
function setupCustomDropdown(select) {
  if (!select) return;

  // Check if already customized
  let wrapper = select.nextElementSibling;
  if (!wrapper || !wrapper.classList.contains('custom-select-wrapper')) {
    // Create wrapper
    wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';

    // Drop Up Mode for specific elements or via flag
    if (select.id === 'remote-audio-track' || select.id === 'remote-subtitle-track' || select.dataset.dropUp === 'true') {
      wrapper.classList.add('drop-up');
    }

    // Create trigger
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    trigger.innerHTML = '<span>Select...</span>'; // Will be updated
    wrapper.appendChild(trigger);

    // Create options container
    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'custom-options';
    wrapper.appendChild(optionsDiv);

    // Insert after select and hide select
    select.parentNode.insertBefore(wrapper, select.nextSibling);

    // Copy margin-bottom from original select if it has one (important for stacking)
    if (select.style.marginBottom) {
      wrapper.style.marginBottom = select.style.marginBottom;
    }

    select.style.display = 'none'; // Hide native select

    // Toggle logic
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close others
      document.querySelectorAll('.custom-select-wrapper.open').forEach(el => {
        if (el !== wrapper) el.classList.remove('open');
      });
      wrapper.classList.toggle('open');
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) {
        wrapper.classList.remove('open');
      }
    });
  }

  // REFRESH OPTIONS (Run every time to sync with native select)
  const optionsDiv = wrapper.querySelector('.custom-options');
  const trigger = wrapper.querySelector('.custom-select-trigger');
  optionsDiv.innerHTML = '';

  // Update trigger text based on current native value
  const selectedOption = select.options[select.selectedIndex];
  if (selectedOption) {
    if (selectedOption.dataset.hint) {
      trigger.innerHTML = '';
      const ts = document.createElement('span');
      ts.textContent = selectedOption.textContent;
      trigger.appendChild(ts);
      const hs = document.createElement('span');
      hs.textContent = selectedOption.dataset.hint;
      hs.style.cssText = 'margin-left: auto; color: #666; font-size: 11px;';
      trigger.appendChild(hs);
      trigger.style.display = 'flex';
      trigger.style.justifyContent = 'space-between';
    } else {
      trigger.style.display = '';
      const span = trigger.querySelector('span');
      if (span) span.textContent = selectedOption.textContent;
      else trigger.textContent = selectedOption.textContent;
    }
  }

  // Re-build custom options
  Array.from(select.options).forEach(opt => {
    if (opt.style.display === 'none') return; // Skip hidden options

    const div = document.createElement('div');
    div.className = 'custom-option';
    if (opt.selected) div.classList.add('selected');
    if (opt.disabled) div.classList.add('disabled');
    div.dataset.value = opt.value;

    // Support data-hint for right-aligned gray text (e.g. "(has tracks)")
    if (opt.dataset.hint) {
      const textSpan = document.createElement('span');
      textSpan.textContent = opt.textContent;
      div.appendChild(textSpan);
      const hintSpan = document.createElement('span');
      hintSpan.textContent = opt.dataset.hint;
      hintSpan.style.cssText = 'margin-left: auto; color: #666; font-size: 11px;';
      div.appendChild(hintSpan);
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
    } else {
      div.textContent = opt.textContent;
    }

    // Tooltip support: if the original <option> has a title, show it on hover
    if (opt.title) {
      div.style.position = 'relative';
      const tooltip = document.createElement('span');
      tooltip.className = 'custom-option-tooltip';
      tooltip.textContent = opt.title;
      div.appendChild(tooltip);
    }

    if (!opt.disabled) {
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        // Update native select
        select.value = opt.value;
        // Trigger change event manually
        select.dispatchEvent(new Event('change'));

        // Update UI — show hint in trigger too if present
        if (opt.dataset.hint) {
          trigger.innerHTML = '';
          const ts = document.createElement('span');
          ts.textContent = opt.textContent;
          trigger.appendChild(ts);
        } else {
          trigger.textContent = opt.textContent;
        }
        wrapper.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
        div.classList.add('selected');
        wrapper.classList.remove('open');
      });
    }

    optionsDiv.appendChild(div);
  });
}

// ==================== Extract Tracks Filtering ====================
function initExtractTracksFiltering() {
  const typeSelect = document.getElementById('extract-type');
  const formatSelect = document.getElementById('extract-format');

  if (!typeSelect || !formatSelect) return;

  function updateFormats() {
    const type = typeSelect.value;
    const options = Array.from(formatSelect.options);

    let firstVisible = null;

    options.forEach(opt => {
      // Audio formats: aac, mp3
      // Subtitle formats: webvtt, ass
      const val = opt.value;
      let visible = false;

      if (type === 'audio') {
        if (['aac', 'mp3', 'flac'].includes(val)) visible = true;
      } else if (type === 'subtitle') {
        if (['webvtt', 'ass'].includes(val)) visible = true;
      }

      opt.style.display = visible ? '' : 'none';
      if (visible && !firstVisible) firstVisible = opt;
    });

    // Update selection if current is invalid
    const currentVal = formatSelect.value;
    const currentOpt = options.find(o => o.value === currentVal);

    // If current selection is hidden/invalid, switch to first visible
    if (!currentOpt || currentOpt.style.display === 'none') {
      if (firstVisible) {
        formatSelect.value = firstVisible.value;
      }
    }

    // Refresh custom dropdown UI
    setupCustomDropdown(formatSelect);
  }

  typeSelect.addEventListener('change', updateFormats);

  // Initial run
  updateFormats();
}

// Run init
document.addEventListener('DOMContentLoaded', initExtractTracksFiltering);

// ==================== Track Tools Logic ======================================

function initSubtitleTools() {
  const sourceSelect = document.getElementById('subtool-source-input');
  const targetSelect = document.getElementById('subtool-target-input');
  const trackSelect = document.getElementById('subtool-track-input');

  if (!sourceSelect || !targetSelect) return;

  // Listen for source change to populate tracks (including orphans)
  sourceSelect.addEventListener('change', async () => {
    const filename = sourceSelect.value;
    await updateSubtitleTracksList(filename);
  });

  // Listen for track selection to toggle action buttons (regular vs orphan)
  if (trackSelect) {
    trackSelect.addEventListener('change', () => {
      const val = trackSelect.value;
      const isOrphan = val && val.startsWith('orphan:');
      const standardActions = document.getElementById('subtool-actions-standard');
      const orphanActions = document.getElementById('subtool-actions-orphan');
      if (standardActions) standardActions.style.display = isOrphan ? 'none' : 'flex';
      if (orphanActions) orphanActions.style.display = isOrphan ? 'block' : 'none';
    });
  }

  // Custom dropdown setup (no initial population — done on first tab switch)
  setupCustomDropdown(sourceSelect);
  setupCustomDropdown(targetSelect);
  setupCustomDropdown(trackSelect);
}


function refreshSubtitleToolLists() {
  const sourceSelect = document.getElementById('subtool-source-input');
  const targetSelect = document.getElementById('subtool-target-input');

  if (!sourceSelect || !targetSelect) return;

  // Populate Target (always needed)
  const currentTarget = targetSelect.value;
  targetSelect.innerHTML = '<option value="">Select target video to assign track to...</option>';

  // Use all media files instead of just the playlist
  const videoFiles = allMediaFiles.length > 0 ? allMediaFiles : (typeof playlist !== 'undefined' ? playlist : []);
  if (videoFiles.length > 0) {
    console.log(`[TrackTools] Populating target list with ${videoFiles.length} media files.`);
    videoFiles.forEach(file => {
      const opt = document.createElement('option');
      opt.value = file.filename;
      opt.textContent = file.filename;
      targetSelect.appendChild(opt);
    });
  } else {
    console.warn('[TrackTools] No media files available during refresh.');
  }
  if (currentTarget) targetSelect.value = currentTarget;
  setupCustomDropdown(targetSelect);

  // Populate Source with all media files
  const currentSource = sourceSelect.value;
  sourceSelect.innerHTML = '<option value="" data-hint="(has tracks)">Select source video...</option>';
  if (videoFiles.length > 0) {
    videoFiles.forEach(file => {
      const opt = document.createElement('option');
      opt.value = file.filename;
      opt.textContent = file.filename;
      sourceSelect.appendChild(opt);
    });
  }
  if (currentSource) sourceSelect.value = currentSource;
  setupCustomDropdown(sourceSelect);

  // Always populate tracks (orphans show even without a source selected)
  // Use a microtask to avoid double-call when setupCustomDropdown triggers a change event
  Promise.resolve().then(() => updateSubtitleTracksList(currentSource || null));
}

async function updateSubtitleTracksList(filename) {
  const trackSelect = document.getElementById('subtool-track-input');
  trackSelect.innerHTML = '<option value="">Loading...</option>';
  trackSelect.disabled = true;
  setupCustomDropdown(trackSelect);

  // Reset action buttons to standard
  const standardActions = document.getElementById('subtool-actions-standard');
  const orphanActions = document.getElementById('subtool-actions-orphan');
  if (standardActions) standardActions.style.display = 'flex';
  if (orphanActions) orphanActions.style.display = 'none';

  trackSelect.innerHTML = '<option value="">Select a track...</option>';
  let hasAny = false;

  // Fetch tracks for the selected source video (if one is selected)
  if (filename) {
    try {
      const response = await fetch(`/api/tracks/${encodeURIComponent(filename)}`);
      const data = await response.json();

      // Show external subtitle tracks
      if (data.subtitles && data.subtitles.length > 0) {
        data.subtitles.forEach((track) => {
          if (track.isExternal) {
            hasAny = true;
            const opt = document.createElement('option');
            opt.value = track.index;
            const fName = track.filename ? track.filename.split(/[/\\]/).pop() : 'External';
            opt.textContent = `[SUB] [${track.language || 'und'}] ${track.title || 'Subtitle'} (${fName})`;
            trackSelect.appendChild(opt);
          }
        });
      }

      // Show external audio tracks
      if (data.audio && data.audio.length > 0) {
        data.audio.forEach((track) => {
          if (track.isExternal) {
            hasAny = true;
            const opt = document.createElement('option');
            opt.value = track.index;
            const fName = track.filename ? track.filename.split(/[/\\]/).pop() : 'External';
            opt.textContent = `[AUD] [${track.language || 'und'}] ${track.title || 'Audio'} (${fName})`;
            trackSelect.appendChild(opt);
          }
        });
      }
    } catch (e) {
      console.error('Error loading source tracks:', e);
    }
  }

  // Always fetch and append orphan tracks
  try {
    const orphanRes = await fetch('/api/tracks/orphans');
    const orphanData = await orphanRes.json();

    if (orphanData.orphans && orphanData.orphans.length > 0) {
      // Add separator
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.value = '';
      sep.textContent = '── Orphan Tracks ──';
      trackSelect.appendChild(sep);

      const audioExts = ['aac', 'mp3', 'm4a', 'ogg', 'wav', 'flac'];
      orphanData.orphans.forEach(o => {
        hasAny = true;
        const opt = document.createElement('option');
        opt.value = `orphan:${o.filename}`;
        const typeTag = audioExts.includes(o.type) ? 'AUD' : 'SUB';
        opt.textContent = `(orphan) [${typeTag}] ${o.filename}`;
        trackSelect.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('Failed to fetch orphans:', e);
  }

  if (!hasAny) {
    const opt = document.createElement('option');
    opt.textContent = "No tracks found";
    opt.disabled = true;
    trackSelect.appendChild(opt);
  } else {
    trackSelect.disabled = false;
  }

  setupCustomDropdown(trackSelect);
}

async function runSubtitleTool(action) {
  const sourceSelect = document.getElementById('subtool-source-input');
  const targetSelect = document.getElementById('subtool-target-input');
  const trackSelect = document.getElementById('subtool-track-input');

  const target = targetSelect.value;
  const trackValue = trackSelect ? trackSelect.value : null;

  // Detect orphan selection
  if (action === 'bind-orphan' || (trackValue && trackValue.startsWith('orphan:'))) {
    const orphanFile = trackValue ? trackValue.replace('orphan:', '') : null;
    if (!orphanFile || !target) {
      showToast('Please select an orphan track and a target video.', 3000, true);
      return;
    }
    if (!confirm('Are you sure you want to BIND (Assign) this orphan track?')) return;

    submitTrackToolJob({
      action: 'bind-orphan',
      targetVideo: target,
      orphanFile: orphanFile
    });
    return;
  }

  // Standard rebind/share
  const source = sourceSelect ? sourceSelect.value : null;
  const trackIndex = trackValue;

  if (!source || !target || !trackIndex) {
    showToast('Please select source, target, and track.', 3000, true);
    return;
  }
  if (source === target) {
    showToast('Source and Target cannot be the same.', 3000, true);
    return;
  }

  const actionMap = {
    'rebind': 'REBIND (Move)',
    'share': 'SHARE (Link)'
  };

  if (!confirm(`Are you sure you want to ${actionMap[action]} this track?`)) return;

  submitTrackToolJob({
    action: action,
    sourceVideo: source,
    targetVideo: target,
    trackIndex: parseInt(trackIndex)
  });
}

// Helper to submit the Track Tool job to the FFmpeg Queue
async function submitTrackToolJob(options) {
  const password = sessionStorage.getItem('ffmpeg_password');
  try {
    const response = await fetch('/api/ffmpeg/run-preset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        password,
        type: 'track-tool',
        filename: options.targetVideo, // Just to satisfy the endpoint's generic requirement
        preset: 'none',
        options
      })
    });

    const data = await response.json();
    if (data.success) {
      showToast('Track tool job started successfully!', 2000);
      refreshFfmpegJobs();
      startJobPolling();

      // Auto-refresh the source list to show changes
      const sourceSelect = document.getElementById('subtool-source-input');
      if (sourceSelect && sourceSelect.value && options.action !== 'bind-orphan') updateSubtitleTracksList(sourceSelect.value);
    } else {
      showToast(data.error || 'Failed to start job', 3000, true);
    }
  } catch (e) {
    console.error('Track tool job error:', e);
    showToast('Network error starting job', 3000, true);
  }
}

// Init tools
document.addEventListener('DOMContentLoaded', initSubtitleTools);

window.runSubtitleTool = runSubtitleTool;

