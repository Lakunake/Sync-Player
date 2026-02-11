const video = document.getElementById('video');
const preloadVideo = document.getElementById('preload-video');
const imageDisplay = document.getElementById('image-display');
const waitingMessage = document.getElementById('waiting-message');
const statusEl = document.getElementById('status');
const currentTrackInfoEl = document.getElementById('current-track-info');
const mediaPlaceholder = document.getElementById('media-placeholder');
const subtitleOverlay = document.getElementById('subtitle-overlay');

// Initialize Subtitle Renderer (Declared here, initialized after class def)
let subtitleRenderer;
let jassubInstance = null; // JASSUB instance for ASS rendering (when SUBTITLE_RENDERER=jassub)
let canvasSupervisor = null; // MutationObserver to enforce canvas styles
let subtitleRendererMode = 'wsr'; // 'wsr' (built-in) or 'jassub' (libass)

// Helper to check if a file is an image
const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
function isImageFile(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return imageExtensions.includes(ext);
}

// Helper to check if a file is audio
const audioExtensions = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav'];
function isAudioFile(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return audioExtensions.includes(ext);
}

// Track if current media is an image
let currentMediaIsImage = false;

// YouTube Player state
const youtubeContainer = document.getElementById('youtube-container');
const youtubeClickOverlay = document.getElementById('youtube-click-overlay');
let ytPlayer = null;
let ytVideoHasPlayed = false;

// External Player state
let vimeoPlayer = null;
let twitchPlayer = null;
let dmPlayer = null;
let scWidget = null;
let currentPlatform = 'local'; // local, youtube, vimeo, twitch, etc.

// Helper to hide all player containers
function hideAllPlayers() {
  const containers = document.querySelectorAll('.player-container');
  containers.forEach(el => el.classList.remove('visible'));
  youtubeContainer.classList.remove('visible');
  video.style.opacity = '0.001';
  imageDisplay.style.display = 'none';
  if (mediaPlaceholder) mediaPlaceholder.style.display = 'none';

  // Disable subtitles
  if (subtitleRenderer) subtitleRenderer.disable();

  // Stop/Pause existing players if possible
  if (vimeoPlayer) vimeoPlayer.pause().catch(() => { });
  if (dmPlayer) dmPlayer.pause();
  if (twitchPlayer) {
    try {
      const player = twitchPlayer.getPlayer ? twitchPlayer.getPlayer() : twitchPlayer;
      if (player && player.pause) player.pause();
    } catch (e) { }
  }

  // Clear generic iframe source to stop playback
  const iframe = document.getElementById('generic-iframe');
  if (iframe) iframe.src = '';
}

// Generic handler for external video ending
function handleVideoEnded() {
  console.log('External video ended');
  if (currentPlaylist.videos.length > 0) {
    const nextIndex = (currentPlaylist.currentIndex + 1) % currentPlaylist.videos.length;
    socket.emit('playlist-next', nextIndex);
  }
}

// Load external content (Vimeo, Twitch, etc.)
function loadExternalContent(platform, id, url, startTime = 0) {
  currentPlatform = platform;
  hideAllPlayers();

  if (platform === 'youtube') {
    youtubeContainer.classList.add('visible');
    currentMediaIsYouTube = true;
    // YouTube specific logic is handled by onYouTubeIframeAPIReady and socket play event
    // But we might need to trigger load if it's already ready
    if (ytPlayer && ytPlayerReady && id) {
      ytPlayer.loadVideoById(id, startTime);
    }
    return;
  }

  currentMediaIsYouTube = false;

  try {
    switch (platform) {
      case 'vimeo':
        document.getElementById('vimeo-container').classList.add('visible');
        if (!vimeoPlayer && window.Vimeo) {
          vimeoPlayer = new Vimeo.Player('vimeo-container', {
            id: id,
            autoplay: true,
            responsive: true,
            width: '100%',
            height: '100%'
          });
          vimeoPlayer.on('ended', handleVideoEnded);
          vimeoPlayer.on('loaded', () => {
            if (startTime > 0) vimeoPlayer.setCurrentTime(startTime);
          });
        } else if (vimeoPlayer) {
          vimeoPlayer.loadVideo(id).then(() => {
            if (startTime > 0) vimeoPlayer.setCurrentTime(startTime);
            vimeoPlayer.play();
          }).catch(e => console.error('Vimeo play error:', e));
        }
        break;

      case 'twitch':
        document.getElementById('twitch-container').classList.add('visible');
        document.getElementById('twitch-container').innerHTML = ''; // Clear previous
        if (window.Twitch) {
          const twitchOptions = {
            width: '100%',
            height: '100%',
            layout: 'video',
            autoplay: true,
            // Twitch embed doesn't support start time easily in options for VODs in this way
          };
          // Determine if ID is channel or video
          if (id.match(/^\d+$/)) {
            twitchOptions.video = id;
            if (startTime > 0) twitchOptions.time = timeToTwitchFormat(startTime);
          } else {
            twitchOptions.channel = id;
          }
          twitchPlayer = new Twitch.Embed('twitch-container', twitchOptions);
          twitchPlayer.addEventListener(Twitch.Embed.VIDEO_READY, () => {
            const player = twitchPlayer.getPlayer();
            if (player) {
              player.addEventListener('ended', handleVideoEnded);
              if (startTime > 0 && player.seek) player.seek(startTime);
            }
          });
        }
        break;

      case 'dailymotion':
        document.getElementById('dailymotion-container').classList.add('visible');
        if (!dmPlayer && window.DM) {
          dmPlayer = DM.player(document.getElementById('dailymotion-container'), {
            video: id,
            width: '100%',
            height: '100%',
            params: { autoplay: true, mute: false, start: startTime, events: { video_end: handleVideoEnded } }
          });
          // DM API events usually bound via params for 'video_end' or addEventListener 'end'
          dmPlayer.addEventListener('end', handleVideoEnded);
        } else if (dmPlayer) {
          dmPlayer.load(id, { start: startTime });
        }
        break;

      case 'soundcloud':
        document.getElementById('soundcloud-container').classList.add('visible');
        const scContainer = document.getElementById('soundcloud-container');
        // SoundCloud widget API is limited for start time on load, would need to event bind
        scContainer.innerHTML = `<iframe id="sc-widget" width="100%" height="100%" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true&visual=true"></iframe>`;
        if (window.SC) {
          const widget = SC.Widget('sc-widget');
          widget.bind(SC.Widget.Events.FINISH, handleVideoEnded);
          widget.bind(SC.Widget.Events.READY, () => {
            if (startTime > 0) widget.seekTo(startTime * 1000);
          });
        }
        break;

      case 'streamable':
      case 'gdrive':
      case 'kick':
      case 'rumble':
      case 'iframe':
        const iframeContainer = document.getElementById('iframe-container');
        iframeContainer.classList.add('visible');
        const iframe = document.getElementById('generic-iframe');

        if (platform === 'streamable') iframe.src = `https://streamable.com/e/${id}?autoplay=1&t=${startTime}`;
        else if (platform === 'gdrive') iframe.src = `https://drive.google.com/file/d/${id}/preview?t=${startTime}`; // GDrive might not support t parameter same way
        else if (platform === 'kick') iframe.src = `https://player.kick.com/${id}?autoplay=true&time=${startTime}`; // Guesswork on Kick API
        else if (platform === 'rumble') iframe.src = `https://rumble.com/embed/${id}/?autoplay=1`;
        else iframe.src = url; // Generic iframe
        break;

      case 'directUrl':
        // Use main video player
        video.style.opacity = '1';
        video.src = url;

        video.onloadedmetadata = function () {
          if (startTime > 0) video.currentTime = startTime;
          video.play().catch(e => console.error(e));
        };
        // Fallback if metadata already loaded or race condition
        setTimeout(() => {
          if (startTime > 0 && video.currentTime < 0.1) video.currentTime = startTime;
          video.play().catch(e => console.error(e));
        }, 100);
        break;
    }
  } catch (err) {
    console.error('Error loading external content:', err);
    showTemporaryMessage('Error loading external content', 3000);
  }
}
let currentMediaIsYouTube = false;
let ytApiLoaded = false;

const socket = io();

// Debug Configuration
const DEBUG_MODE = false;
function debugLog(...args) {
  if (DEBUG_MODE) console.log(...args);
}

let currentPlaylist = {
  videos: [],
  currentIndex: -1,
  mainVideoIndex: -1,
};
let currentVideoInfo = null;
let mainVideoStartTime = 0;
let currentServerRate = 1.0;
let speedReloadTimeout = null;
let videoLoadAttempts = 0;
const maxVideoLoadAttempts = 3;
let lastAppliedAudioTrack = null;
let lastAppliedSubtitleTrack = null;
let currentAudioTrack = null;
let currentSubtitleTrack = null;

// These will be updated from server config
let skipSeconds = 5;
let volumeStep = 0.05;
let clientControlsDisabled = false; // When true, client controls are view-only
let chatEnabled = true; // When false, chat widget is hidden
let maxVolume = 100; // Maximum volume cap (100-1000%)

// Web Audio API for volume amplification above 100%
let audioContext = null;
let gainNode = null;
let audioSource = null;
let currentVolume = 100; // Track current volume as percentage (0-maxVolume)

// Initialize Web Audio API for volume boost
function initAudioContext() {
  if (audioContext) return; // Already initialized
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioSource = audioContext.createMediaElementSource(video);
    gainNode = audioContext.createGain();
    audioSource.connect(gainNode);
    gainNode.connect(audioContext.destination);
    console.log('Web Audio API initialized for volume amplification');
  } catch (e) {
    console.error('Failed to initialize Web Audio API:', e);
  }
}

// Set volume with amplification support
function setVolume(percent) {
  currentVolume = Math.max(0, Math.min(maxVolume, percent));

  if (currentVolume <= 100) {
    // Normal volume range (0-100%)
    video.volume = currentVolume / 100;
    if (gainNode) gainNode.gain.value = 1;
  } else {
    // Amplified volume (>100%)
    // Initialize audio context on first amplification (requires user interaction)
    if (!audioContext) initAudioContext();
    video.volume = 1; // Max browser volume
    if (gainNode) {
      // Gain value: 1.0 = 100%, 2.0 = 200%, etc.
      gainNode.gain.value = currentVolume / 100;
    }
  }
  return currentVolume;
}

// Get current volume percentage
function getVolume() {
  return currentVolume;
}

let lastUpdate = Date.now();
let hasInitialSync = false; // Prevent new clients from broadcasting until synced
let loadingVideo = false;

function showTemporaryMessage(message, duration = 2000) {
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  if (duration > 0) {
    setTimeout(() => statusEl.classList.remove('visible'), duration);
  }
}

function showTrackInfo(message, duration = 3000) {
  currentTrackInfoEl.textContent = message;
  currentTrackInfoEl.classList.add('visible');
  setTimeout(() => currentTrackInfoEl.classList.remove('visible'), duration);
}

// Send control event to server
function sendControlEvent() {
  if (clientControlsDisabled) return;
  if (loadingVideo) return;


  socket.emit('control', {
    isPlaying: !video.paused,
    currentTime: video.currentTime,
    duration: video.duration,
    volume: video.volume,
    currentVideoIndex: currentPlaylist.currentIndex,
  });
}

// Generate a client fingerprint for identification
function getClientFingerprint() {
  let stored = localStorage.getItem('client-fingerprint');
  if (stored) return stored;

  const components = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    Math.random().toString(36).slice(2, 8)
  ];
  const str = components.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  const fp = 'client-' + Math.abs(hash).toString(36);
  localStorage.setItem('client-fingerprint', fp);
  return fp;
}

const clientFingerprint = getClientFingerprint();

socket.on('connect', () => {
  console.log('Connected to server');
  showTemporaryMessage('Connected', 1000);

  // Check if we're in a room (server mode URL: /watch/:roomCode)
  const pathMatch = window.location.pathname.match(/^\/watch\/([A-Z0-9]{6})$/i);
  if (pathMatch) {
    const roomCode = pathMatch[1].toUpperCase();
    const displayName = sessionStorage.getItem('sync-player-name') || 'Guest';
    console.log('Joining room:', roomCode);

    socket.emit('join-room', {
      roomCode,
      name: displayName,
      fingerprint: clientFingerprint
    }, (response) => {
      if (response && response.success) {
        console.log('Joined room:', response.roomName);
        showTemporaryMessage(`Joined: ${response.roomName}`, 2000);
      } else {
        console.error('Failed to join room:', response?.error);
        showTemporaryMessage('Room not found', 3000);
        setTimeout(() => window.location.href = '/', 2000);
      }
    });
  } else {
    // Legacy mode - direct connection
    socket.emit('request-initial-state');
    socket.emit('client-register', { fingerprint: clientFingerprint });
  }
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  showTemporaryMessage('Disconnected', 0);
  hasInitialSync = false; // Reset on disconnect
});

// Handle room deleted event (server mode)
socket.on('room-deleted', () => {
  showTemporaryMessage('Room was closed by admin', 3000);
  setTimeout(() => window.location.href = '/', 2000);
});

// Handle viewer count updates (server mode)
socket.on('viewer-count', (count) => {
  console.log('Viewers in room:', count);
});

// Handle config from server
socket.on('config', (config) => {
  skipSeconds = config.skipSeconds || 5;
  volumeStep = config.volumeStep || 0.05;
  clientControlsDisabled = config.clientControlsDisabled || false;
  chatEnabled = config.chatEnabled !== false; // Default to true
  maxVolume = config.maxVolume || 100; // Default to 100%

  // Subtitle renderer mode from config
  if (config.subtitleRenderer && ['wsr', 'jassub'].includes(config.subtitleRenderer)) {
    subtitleRendererMode = config.subtitleRenderer;
    console.log(`[Subtitle] Renderer mode: ${subtitleRendererMode}`);
  }

  // Update title with room info if in server mode
  if (config.serverMode && config.roomName) {
    document.title = `${config.roomName} - Sync-Player`;
  }

  // Hide chat widget if disabled
  if (!chatEnabled) {
    const chatWidget = document.getElementById('chat-widget');
    if (chatWidget) {
      chatWidget.classList.remove('visible');
      chatWidget.style.display = 'none';
    }
  }

  console.log(`Config received: skipSeconds=${skipSeconds}, volumeStep=${volumeStep}, clientControlsDisabled=${clientControlsDisabled}, chatEnabled=${chatEnabled}, maxVolume=${maxVolume}, subtitleRenderer=${subtitleRendererMode}`);
  if (clientControlsDisabled) {
    showTemporaryMessage('View-only mode (controls disabled)', 3000);
  }
});

// ==================== Chat Widget ====================
let chatMinimized = true;
let unreadCount = 0;
const myDisplayName = sessionStorage.getItem('sync-player-name') || 'Guest';

// Legacy chat initialization removed


// escapeHtml function moved to common utility or kept if needed elsewhere? 
// It is used by legacy chat, but we can keep it if other things use it.
// Searching... only chat seemed to use it.
// I will remove the entire chat block.

// Escape HTML to prevent XSS (Keeping as util)
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Handle initial state from server
socket.on('initial-state', (state) => {
  debugLog('Received initial state:', state);
  currentPlaylist = state.playlist;
  mainVideoStartTime = state.mainVideoStartTime || 0;

  if (currentPlaylist.videos.length > 0) {
    const videoToPreload = (currentPlaylist.mainVideoIndex >= 0 && currentPlaylist.videos.length > currentPlaylist.mainVideoIndex)
      ? currentPlaylist.videos[currentPlaylist.mainVideoIndex]
      : currentPlaylist.videos[0];
    preloadVideo.src = `/media/${videoToPreload.filename}`;
    preloadVideo.load();
  }

  if (currentPlaylist.videos.length > 0 && currentPlaylist.currentIndex >= 0) {
    waitingMessage.style.display = 'none';
    video.style.opacity = '1';

    // Use server state to sync immediately
    if (state.videoState) {
      // Only set hasInitialSync if we are actually syncing
      hasInitialSync = true;
      loadCurrentVideo(state.videoState.currentTime);

      // Ensure playback state matches server
      if (state.videoState.isPlaying) {
        video.play().catch(e => console.log('Auto-play failed:', e));
      } else {
        video.pause();
      }
    } else {
      hasInitialSync = true;
      loadCurrentVideo();
    }
  } else {
    hideAllPlayers();
    waitingMessage.style.display = 'block';
    currentPlatform = 'local';
  }
});

socket.on('playlist-position', (index) => {
  currentPlaylist.currentIndex = index;
  if (currentPlaylist.videos.length > 0 && index >= 0) {
    waitingMessage.style.display = 'none';
    video.style.opacity = '1';
    hasInitialSync = true;
    loadCurrentVideo();
  } else {
    hideAllPlayers();
    waitingMessage.style.display = 'block';
    currentPlatform = 'local';
  }
});

socket.on('playlist-update', (playlist) => {
  debugLog('Received playlist update:', playlist);
  currentPlaylist = playlist;

  const vCount = currentPlaylist.videos ? currentPlaylist.videos.length : 0;
  showTemporaryMessage(`Received playlist: ${vCount} videos`, 3000);

  if (currentPlaylist.videos.length > 0 && currentPlaylist.currentIndex >= 0) {
    waitingMessage.style.display = 'none';
    video.style.opacity = '1';
    hasInitialSync = true;
    loadCurrentVideo();
  } else {
    hideAllPlayers();
    waitingMessage.style.display = 'block';
    currentPlatform = 'local';
  }
});

socket.on('track-change', (data) => {
  if (currentPlaylist.videos.length > 0 && data.videoIndex < currentPlaylist.videos.length) {
    const videoItem = currentPlaylist.videos[data.videoIndex];

    if (data.type === 'audio') {
      videoItem.selectedAudioTrack = data.trackIndex;
    } else if (data.type === 'subtitle') {
      videoItem.selectedSubtitleTrack = data.trackIndex;
    }

    if (data.videoIndex === currentPlaylist.currentIndex) {
      currentVideoInfo = videoItem;
      applyTrackSelectionsDelayed();

      const trackInfo = data.type === 'audio'
        ? (videoItem.tracks && videoItem.tracks.audio && videoItem.tracks.audio[data.trackIndex]
          ? `${videoItem.tracks.audio[data.trackIndex].language} - ${videoItem.tracks.audio[data.trackIndex].title || `Track ${data.trackIndex}`}`
          : `Audio Track ${data.trackIndex}`)
        : (data.trackIndex >= 0 && videoItem.tracks && videoItem.tracks.subtitles && videoItem.tracks.subtitles[data.trackIndex]
          ? `${videoItem.tracks.subtitles[data.trackIndex].language} - ${videoItem.tracks.subtitles[data.trackIndex].title || `Track ${data.trackIndex}`}`
          : 'Subtitles Off');

      showTrackInfo(`${data.type === 'audio' ? 'Audio' : 'Subtitles'}: ${trackInfo}`);
    }
  }
});

video.addEventListener('ended', () => {
  if (currentPlaylist.videos.length > 0) {
    const nextIndex = (currentPlaylist.currentIndex + 1) % currentPlaylist.videos.length;
    socket.emit('playlist-next', nextIndex);
  }
});

function loadCurrentVideo(startTime = 0) {
  loadingVideo = true; // Block control events during load

  if (currentPlaylist.videos.length === 0 || currentPlaylist.currentIndex < 0) {
    waitingMessage.style.display = 'block';
    video.style.opacity = '0.001';
    imageDisplay.style.display = 'none';
    currentMediaIsImage = false;
    loadingVideo = false;
    return;
  }

  const currentVideo = currentPlaylist.videos[currentPlaylist.currentIndex];
  currentVideoInfo = currentVideo;

  // Check if this is external content
  if (currentVideo.isExternal || currentVideo.isYouTube) {
    currentMediaIsImage = false;
    waitingMessage.style.display = 'none';

    // Use the unified loader
    const platform = currentVideo.platform || (currentVideo.isYouTube ? 'youtube' : 'local');
    const id = currentVideo.externalId || currentVideo.youtubeId;
    const url = currentVideo.externalUrl;

    mediaPlaceholder.style.display = 'none'; // Ensure placeholder hidden for external content

    // Set a timeout fallback for loading flag
    setTimeout(() => { loadingVideo = false; }, 2000);

    loadExternalContent(platform, id, url, startTime);

    showTemporaryMessage(`${currentVideo.platformName || 'External'} content loaded`, 2000);
    return;
  }

  // Hide all external player containers when switching to local content
  hideAllPlayers();
  currentPlatform = 'local';

  // Check if this is an image file
  if (isImageFile(currentVideo.filename)) {
    currentMediaIsImage = true;

    // Hide video, show image
    video.style.opacity = '0.001';
    video.pause();

    // Check for BSL-S² local playback
    const localUrl = getBslLocalUrl(currentVideo.filename);
    let imageSrc;

    if (localUrl) {
      imageSrc = localUrl;
      console.log('BSL-S²: Loading IMAGE from LOCAL file');
      showTemporaryMessage('Displaying local image (BSL-S²)', 2000);
    } else {
      imageSrc = `/media/${currentVideo.filename}`;
      console.log('Loading image from server:', imageSrc);
    }

    imageDisplay.src = imageSrc;
    imageDisplay.style.display = 'block';
    waitingMessage.style.display = 'none';

    showTemporaryMessage('Image - tap edges to skip', 3000);
    loadingVideo = false;
    return;
  }

  // It's a video or audio file
  currentMediaIsImage = false;

  // Check if it's an audio file and handle display
  if (isAudioFile(currentVideo.filename)) {
    imageDisplay.style.display = 'block';
    // Use the thumbnail API which extracts embedded cover art
    imageDisplay.src = `/api/thumbnail/${encodeURIComponent(currentVideo.filename)}`;

    // Hide broken image if no cover art found
    imageDisplay.onerror = function () {
      this.style.display = 'none';
      mediaPlaceholder.style.display = 'flex';
      showTemporaryMessage('🎵 Playing Audio', 3000);
    };

    video.style.opacity = '0.001';
  } else {
    imageDisplay.style.display = 'none';
    mediaPlaceholder.style.display = 'none';
    video.style.opacity = '1';
  }

  // Check for BSL-S² local playback
  const localUrl = getBslLocalUrl(currentVideo.filename);
  let videoSrc;

  if (localUrl) {
    videoSrc = localUrl;
    console.log('BSL-S²: Loading from LOCAL file');
    const msg = isAudioFile(currentVideo.filename) ? 'Playing local audio (BSL-S²)' : 'Playing local video (BSL-S²)';
    showTemporaryMessage(msg, 2000);
  } else {
    videoSrc = `/media/${currentVideo.filename}`;
    console.log('Loading media from server:', videoSrc);
  }

  video.src = videoSrc;

  // Request sync from server to get the current time (fallback/confirmation)
  socket.emit('request-sync');

  clearVideoTracks();
  video.load();

  video.onloadeddata = function () {
    videoLoadAttempts = 0;
    applyTrackSelections();

    if (startTime > 0) {
      console.log(`[VideoLoad] Syncing to initial time: ${startTime}`);
      video.currentTime = startTime;
    }

    if (!video.paused) {
      video.play().catch(e => {
        console.log('Playback error:', e);
        handlePlaybackError(e);
      });
    }

    // Clear loading flag after a delay to allow interactions to settle
    setTimeout(() => {
      loadingVideo = false;
      console.log('[VideoLoad] Ready');
    }, 500);
  };


  video.onloadedmetadata = function () {
    applyTrackSelections();
  };

  video.onerror = function () {
    console.log('Error loading video:', currentVideo.filename);
    videoLoadAttempts++;

    if (videoLoadAttempts < maxVideoLoadAttempts) {
      setTimeout(() => {
        console.log('Retrying video load, attempt:', videoLoadAttempts);
        loadCurrentVideo();
      }, 1000);
    } else {
      waitingMessage.style.display = 'block';
      video.style.opacity = '0.001';
      showTemporaryMessage('Failed to load video. Please check file format.', 5000);
    }
  };
}

function handlePlaybackError(error) {
  console.log('Playback error:', error);
  waitingMessage.style.display = 'block';
  video.style.opacity = '0.001';
  showTemporaryMessage('Playback failed. Please check file format.', 3000);
}

function clearVideoTracks() {
  const audioTracks = video.audioTracks;
  const textTracks = video.textTracks;

  if (audioTracks) {
    for (let i = 0; i < audioTracks.length; i++) {
      audioTracks[i].enabled = false;
    }
  }

  if (textTracks) {
    for (let i = 0; i < textTracks.length; i++) {
      textTracks[i].mode = 'disabled';
    }
  }
}

function applyTrackSelections() {
  if (!currentVideoInfo) return;
  tryDirectTrackManipulation();
  tryVideoAttributes();
}

function tryDirectTrackManipulation() {
  if (typeof video.audioTracks !== 'undefined' && currentVideoInfo.selectedAudioTrack !== undefined) {
    const targetIndex = Math.max(0, Math.min(currentVideoInfo.selectedAudioTrack, video.audioTracks.length - 1));
    if (lastAppliedAudioTrack !== targetIndex) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = (i === targetIndex);
      }
      lastAppliedAudioTrack = targetIndex;
    }
  }

  if (typeof video.textTracks !== 'undefined' && currentVideoInfo.selectedSubtitleTrack !== undefined) {
    const targetSubIndex = currentVideoInfo.selectedSubtitleTrack;

    if (lastAppliedSubtitleTrack !== targetSubIndex) {
      console.log(`[Subtitle] Switching to track index: ${targetSubIndex}`);

      // 1. Disable all native DOM tracks (we use overlay)
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = 'disabled';
      }

      // 2. Load via SubtitleRenderer or JASSUB
      // Check if disabled (convention: -1 or undefined, but here we only act if defined)
      if (targetSubIndex === -1) {
        // Destroy JASSUB if active
        if (jassubInstance) {
          jassubInstance.destroy();
          jassubInstance = null;
        }
        subtitleRenderer.disable();
      }
      else if (currentVideoInfo.tracks && currentVideoInfo.tracks.subtitles) {
        const track = currentVideoInfo.tracks.subtitles[targetSubIndex];
        if (track) {
          // Construct URL: Use explicit URL if present, else standard tracks path
          let trackUrl = track.url;
          if (!trackUrl && track.filename) {
            trackUrl = `/tracks/${track.filename}`;
          }

          if (trackUrl) {
            const ext = trackUrl.split('.').pop().toLowerCase();
            // Default to vtt if unknown, but 'ass' needs specific handling
            const format = (ext === 'ass' || ext === 'ssa') ? 'ass' : 'vtt';
            console.log(`[Subtitle] Requesting overlay load: ${trackUrl} (${format})`);
            showTemporaryMessage(`Loading subtitles: ${track.language || 'Unknown'}`, 2000);

            // Use JASSUB for ASS files if configured, otherwise use built-in renderer
            if (format === 'ass' && subtitleRendererMode === 'jassub') {
              // Destroy previous JASSUB instance
              if (jassubInstance) {
                jassubInstance.destroy();
                jassubInstance = null;
              }
              // Also disable built-in renderer overlay
              subtitleRenderer.disable();

              // Dynamically import and create JASSUB instance
              loadJASSUB(trackUrl);
            } else {
              // Use built-in SubtitleRenderer for VTT or when JASSUB not configured
              // Destroy JASSUB if switching away from it
              if (jassubInstance) {
                jassubInstance.destroy();
                jassubInstance = null;
              }
              subtitleRenderer.loadTrack(trackUrl, format);
            }
          } else {
            console.warn('[Subtitle] Track selected but no URL/Filename found:', track);
            // Fallback: If it's a native track that wasn't extracted, we can't render it on overlay easily
            // without extraction. User is expected to extract tracks via admin.
            if (jassubInstance) {
              jassubInstance.destroy();
              jassubInstance = null;
            }
            subtitleRenderer.disable();
          }
        }
      }

      lastAppliedSubtitleTrack = targetSubIndex;
    }
  }
}

// Load JASSUB dynamically for ASS subtitle rendering
// Helper to fetch worker script as Blob (bypass cross-origin worker restriction)
async function fetchWorkerBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch worker: ${response.status}`);
  const text = await response.text();
  const blob = new Blob([text], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

// Load JASSUB dynamically for ASS subtitle rendering
async function loadJASSUB(trackUrl) {
  // Check if SharedArrayBuffer is available (required for JASSUB)
  // It's only available on localhost or HTTPS origins
  if (typeof SharedArrayBuffer === 'undefined') {
    console.warn('[Subtitle] SharedArrayBuffer not available - JASSUB requires localhost or HTTPS');
    console.log('[Subtitle] Falling back to built-in renderer');
    showTemporaryMessage('Using fallback subtitle renderer', 2000);
    subtitleRenderer.loadTrack(trackUrl, 'ass');
    return;
  }

  // Use JASSUB v1.8.8 - v2.x uses abslink which causes DataCloneError with _getLocalFont
  // v1.8.8 uses Comlink which handles Worker communication properly
  const CDN_BASE = 'https://cdn.jsdelivr.net/npm/jassub@1.8.8/dist';

  // Helper: fetch worker script and create blob URL (bypass cross-origin)
  const fetchWorkerBlob = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch worker: ${response.status}`);
    const text = await response.text();
    const blob = new Blob([text], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  };

  // Helper: wrap promise with timeout
  const withTimeout = (promise, ms, message) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
  };

  try {
    console.log('[Subtitle] Loading JASSUB v1.8.8 from CDN...');

    // Import JASSUB v1.8.8 (uses Comlink, not abslink)
    const { default: JASSUB } = await withTimeout(
      import('https://esm.run/jassub@1.8.8'),
      10000,
      'CDN import timeout'
    );

    if (!JASSUB) {
      throw new Error('JASSUB not found after loading from CDN');
    }

    // Fetch worker and create blob URL to bypass cross-origin restriction
    console.log('[Subtitle] Creating blob worker...');
    const workerBlobUrl = await withTimeout(
      fetchWorkerBlob(`${CDN_BASE}/jassub-worker.js`),
      10000,
      'Worker fetch timeout'
    );

    console.log('[Subtitle] Creating JASSUB instance...');
    // Convert to absolute URL since blob worker can't resolve relative paths
    const absoluteTrackUrl = new URL(trackUrl, location.origin).href;

    // Fetch track content in main thread to avoid worker fetch issues/CORS
    let trackContent = null;
    try {
      console.log('[Subtitle] Fetching track content:', absoluteTrackUrl);
      const trackRes = await fetch(absoluteTrackUrl);
      if (!trackRes.ok) throw new Error(`Track fetch failed: ${trackRes.status}`);
      trackContent = await trackRes.text();
      console.log('[Subtitle] Track content loaded, length:', trackContent.length);
    } catch (e) {
      console.error('[Subtitle] Failed to load track content:', e);
      throw e;
    }

    // Verify and fetch fonts (Main Thread)
    // Dynamic loading: Fetch list of available fonts from server
    let fontFiles = [];
    try {
      const listRes = await fetch('/api/fonts');
      if (listRes.ok) {
        fontFiles = await listRes.json();
        console.log('[Subtitle] Discovered fonts:', fontFiles);
      } else {
        console.warn('[Subtitle] Failed to list fonts, using fallback defaults');
        fontFiles = ['GandhiSans-Regular.otf', 'GandhiSans-Bold.otf', 'GandhiSans-Italic.otf', 'GandhiSans-BoldItalic.otf'];
      }
    } catch (e) {
      console.warn('[Subtitle] Error fetching font list:', e);
      fontFiles = ['GandhiSans-Regular.otf', 'GandhiSans-Bold.otf', 'GandhiSans-Italic.otf', 'GandhiSans-BoldItalic.otf'];
    }

    const fontBlobUrls = [];
    console.log('[Subtitle] fetching fonts in main thread...');

    // Helper to fetch font and create blob URL
    const fetchFont = async (filename) => {
      try {
        const url = `${location.origin}/font/${filename}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        return URL.createObjectURL(blob);
      } catch (e) {
        console.warn(`[Subtitle] Failed to load font ${filename}:`, e);
        return null;
      }
    };

    // Fetch all fonts in parallel
    const loadedFonts = await Promise.all(fontFiles.map(f => fetchFont(f)));
    const validFontUrls = loadedFonts.filter(url => url !== null);
    console.log(`[Subtitle] Loaded ${validFontUrls.length}/${fontFiles.length} fonts`);

    // Cleanup existing instance and supervisor to prevent leaks
    if (canvasSupervisor) {
      canvasSupervisor.disconnect();
      canvasSupervisor = null;
    }
    if (jassubInstance) {
      try {
        jassubInstance.destroy();
      } catch (e) {
        console.warn('[Subtitle] Error destroying previous JASSUB instance:', e);
      }
      jassubInstance = null;
    }

    jassubInstance = new JASSUB({
      video: video,
      subContent: trackContent, // Use content instead of URL
      workerUrl: workerBlobUrl,
      wasmUrl: `${CDN_BASE}/jassub-worker.wasm`,
      useLocalFonts: false,
      debug: true,
      // Pre-load all fonts using Blob URLs (safe from worker fetch issues)
      fonts: validFontUrls,
      fallbackFont: 'Gandhi Sans'
    });

    console.log('[Subtitle] Waiting for JASSUB ready...');

    // Persistent Canvas Supervisor
    // Watches for JASSUB creating/replacing the canvas and enforces visibility
    canvasSupervisor = new MutationObserver((mutations) => {
      const canvas = video.parentNode.querySelector('canvas');
      if (canvas) {
        // Enforce styles if they drift
        if (canvas.style.zIndex !== '100' || canvas.style.opacity !== '1') {
          console.log('[Subtitle] Enforcing canvas styles!');
          canvas.style.zIndex = '100';
          canvas.style.position = 'absolute';
          canvas.style.top = '0';
          canvas.style.left = '0';
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.pointerEvents = 'none';
          canvas.style.opacity = '1';
          canvas.style.visibility = 'visible';
          canvas.classList.add('jassub-canvas-forced');
        }
      }
    });

    // Start supervising the video container
    canvasSupervisor.observe(video.parentNode, { childList: true, subtree: true });

    // Initial enforcement
    setTimeout(() => {
      const canvas = video.parentNode.querySelector('canvas');
      if (canvas) {
        canvas.style.zIndex = '100';
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.pointerEvents = 'none';
        canvas.style.opacity = '1';
        canvas.style.visibility = 'visible';
        canvas.classList.add('jassub-canvas-forced');
        console.log('[Subtitle] Initial style enforcement applied');
      }
    }, 100);

    await withTimeout(jassubInstance.ready, 30000, 'Initialization timeout');

    setTimeout(() => {
      console.log('[Subtitle] JASSUB initialized successfully');
      // Force initial resize check
      ensureJassubSize();
    }, 500);

    // Debug: Check if JASSUB created a canvas element
    const allCanvases = document.querySelectorAll('canvas');
    console.log('[Subtitle] All canvas elements after JASSUB init:', allCanvases.length);
    allCanvases.forEach((canvas, i) => {
      const style = getComputedStyle(canvas);
      console.log(`[Subtitle] Canvas ${i}:`, {
        id: canvas.id,
        className: canvas.className,
        width: canvas.width,
        height: canvas.height,
        position: style.position,
        zIndex: style.zIndex,
        visibility: style.visibility,
        display: style.display,
        parentElement: canvas.parentElement?.tagName
      });
    });

    // Debug: Check JASSUB instance properties
    console.log('[Subtitle] JASSUB instance:', jassubInstance);
    if (jassubInstance.canvas) {
      console.log('[Subtitle] JASSUB canvas element:', jassubInstance.canvas);
    }

    // JASSUB's ResizeObserver doesn't work well when video starts with display:none
    // Instead of calling resize() directly (which triggers a buggy render path),
    // we'll re-attach to the video when it becomes visible
    const ensureJassubSize = () => {
      if (!jassubInstance) return;
      const rect = video.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        console.log('[Subtitle] Video now visible, JASSUB should auto-resize via ResizeObserver');
        // Force ResizeObserver to re-check by triggering its callback
        if (jassubInstance._boundResize) {
          jassubInstance._boundResize();
        }
      }
    };

    // Listen for video visibility changes
    const videoObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
          const isVisible = video.style.opacity !== '0' && video.offsetWidth > 0;
          if (isVisible) {
            console.log('[Subtitle] Video became visible, updating JASSUB');
            ensureJassubSize();
          }
        }
      }
    });
    videoObserver.observe(video, { attributes: true, attributeFilter: ['style', 'class'] });

    // Also trigger on window resize and fullscreen change
    window.addEventListener('resize', ensureJassubSize);
    document.addEventListener('fullscreenchange', () => {
      setTimeout(ensureJassubSize, 100); // Small delay for fullscreen transition
    });

    // Initial check in case video is already visible
    setTimeout(ensureJassubSize, 100);

    return;
  } catch (error) {
    console.warn('[Subtitle] Failed to load JASSUB:', error.message);
    if (jassubInstance) {
      try { jassubInstance.destroy(); } catch (e) { }
      jassubInstance = null;
    }
  }
  console.error('[Subtitle] JASSUB failed, falling back to built-in renderer');
  showTemporaryMessage('JASSUB unavailable, using fallback renderer', 3000);
  subtitleRenderer.loadTrack(trackUrl, 'ass');
}

function tryVideoAttributes() {
  if (currentVideoInfo.selectedAudioTrack !== undefined) {
    video.setAttribute('data-audio-track', currentVideoInfo.selectedAudioTrack);
  }
  if (currentVideoInfo.selectedSubtitleTrack !== undefined) {
    video.setAttribute('data-subtitle-track', currentVideoInfo.selectedSubtitleTrack);
  }
}

function applyTrackSelectionsDelayed() {
  setTimeout(() => applyTrackSelections(), 500);
}

// Handle sync for external players
function handleExternalSync(state) {
  if (currentPlatform === 'youtube') {
    if (ytPlayer && ytPlayerReady) {
      const playerState = ytPlayer.getPlayerState();
      if (state.isPlaying && playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) ytPlayer.playVideo();
      else if (!state.isPlaying && playerState === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();

      const ytTime = ytPlayer.getCurrentTime();
      if (Math.abs(ytTime - state.currentTime) > 2) {
        ytPlayer.seekTo(state.currentTime, true);
      }

      // Sync playback rate
      if (state.playbackRate && typeof ytPlayer.setPlaybackRate === 'function') {
        const currentRate = ytPlayer.getPlaybackRate();
        if (currentRate !== state.playbackRate) {
          ytPlayer.setPlaybackRate(state.playbackRate);
        }
      }
    }
  } else if (currentPlatform === 'vimeo' && vimeoPlayer) {
    vimeoPlayer.getPaused().then(paused => {
      if (state.isPlaying && paused) vimeoPlayer.play().catch(e => { });
      else if (!state.isPlaying && !paused) vimeoPlayer.pause().catch(e => { });
    });
    vimeoPlayer.getCurrentTime().then(t => {
      if (Math.abs(t - state.currentTime) > 2) vimeoPlayer.setCurrentTime(state.currentTime).catch(e => { });
    });
  } else if (currentPlatform === 'twitch' && twitchPlayer) {
    try {
      const player = twitchPlayer.getPlayer ? twitchPlayer.getPlayer() : twitchPlayer;
      if (player) {
        const isPaused = player.isPaused ? player.isPaused() : false;
        if (state.isPlaying && isPaused && player.play) player.play();
        else if (!state.isPlaying && !isPaused && player.pause) player.pause();
      }
    } catch (e) { }
  } else if (currentPlatform === 'dailymotion' && dmPlayer) {
    if (state.isPlaying && dmPlayer.paused) dmPlayer.play();
    else if (!state.isPlaying && !dmPlayer.paused) dmPlayer.pause();
    if (Math.abs(dmPlayer.currentTime - state.currentTime) > 2) dmPlayer.seek(state.currentTime);
  }
}

// Handle server sync events
socket.on('sync', (state) => {
  console.log(`[Sync] Received state: Rate=${state.playbackRate}, Time=${state.currentTime}`);
  const now = Date.now();
  if (now - lastUpdate < 100) return;
  lastUpdate = now;

  // Handle YouTube sync
  if (currentMediaIsYouTube) {
    // If we receive a sync and have an active playlist, hide waiting message
    if (currentPlaylist.videos.length > 0 && currentPlaylist.currentIndex >= 0) {
      if (waitingMessage.style.display !== 'none') {
        console.log('Hiding waiting message - active playlist detected');
        waitingMessage.style.display = 'none';
        youtubeContainer.classList.add('visible');
        hasInitialSync = true;
      }
    }
    syncYouTubePlayer(state);
    return;
  }

  // Handle other external players (Vimeo, Twitch, etc.)
  if (currentPlatform && currentPlatform !== 'local' && currentPlatform !== 'directUrl') {
    handleExternalSync(state);
    return;
  }

  // If we receive a sync and have an active playlist, hide waiting message
  if (currentPlaylist.videos.length > 0 && currentPlaylist.currentIndex >= 0) {
    if (waitingMessage.style.display !== 'none') {
      console.log('Hiding waiting message - active playlist detected');
      waitingMessage.style.display = 'none';
      video.style.display = 'block';
      hasInitialSync = true;
    }
  }

  if (state.isPlaying !== !video.paused) {
    if (state.isPlaying) {
      video.play().catch(e => {
        console.log('Playback error:', e);
        handlePlaybackError(e);
      });
    } else {
      video.pause();
      showTemporaryMessage("Paused", 0);
    }
  }

  // Apply BSL-S² drift if set for current video
  const playlistIdx = currentPlaylist.currentIndex;
  const drift = bslDriftValues[playlistIdx] || 0;
  const targetTime = state.currentTime + drift;  // Positive drift = client ahead, negative = client behind

  if (Math.abs(video.currentTime - targetTime) > 0.5) {
    video.currentTime = Math.max(0, targetTime);  // Don't go negative
  }

  const syncedRate = state.playbackRate || 1.0;
  currentServerRate = syncedRate;

  // If speed changed significantly, force a reload/re-sync as requested by user
  if (Math.abs(video.playbackRate - syncedRate) > 0.01) {
    console.log(`[Sync] Speed changed to ${syncedRate}x. Scheduling reload...`);
    showTemporaryMessage(`Speed: ${syncedRate}x`);

    // Clear existing timeout to debounce rapid changes
    if (speedReloadTimeout) clearTimeout(speedReloadTimeout);

    // Wait 800ms before reloading to allow for multiple clicks
    speedReloadTimeout = setTimeout(() => {
      console.log('[Debounce] Executing reload for speed change...');
      video.playbackRate = syncedRate;
      loadCurrentVideo();
    }, 800);
  }

  if (state.audioTrack !== undefined && state.audioTrack !== currentAudioTrack) {
    currentAudioTrack = state.audioTrack;
    if (currentVideoInfo && currentVideoInfo.tracks && currentVideoInfo.tracks.audio) {
      const audioTrack = currentVideoInfo.tracks.audio[currentAudioTrack];
      if (audioTrack) {
        showTrackInfo(`Audio: ${audioTrack.language}${audioTrack.title ? ` - ${audioTrack.title}` : ''}`);
      }
    }
  }

  if (state.subtitleTrack !== undefined && state.subtitleTrack !== currentSubtitleTrack) {
    currentSubtitleTrack = state.subtitleTrack;
    if (currentSubtitleTrack >= 0 && currentVideoInfo && currentVideoInfo.tracks && currentVideoInfo.tracks.subtitles) {
      const subtitleTrack = currentVideoInfo.tracks.subtitles[currentSubtitleTrack];
      if (subtitleTrack) {
        showTrackInfo(`Subtitles: ${subtitleTrack.language}${subtitleTrack.title ? ` - ${subtitleTrack.title}` : ''}`);
      }
    } else if (currentSubtitleTrack < 0) {
      showTrackInfo("Subtitles: Off");
    }
  }
});

// Event listeners - send control events to sync with server
video.addEventListener('play', () => {
  statusEl.classList.remove('visible');
  sendControlEvent();
});

video.addEventListener('pause', () => {
  showTemporaryMessage("Paused", 0);
  sendControlEvent();
});

video.addEventListener('seeked', sendControlEvent);

// Control zones (click on screen)
document.addEventListener('click', (e) => {
  // Always allow BSL overlay interactions (folder selection)
  if (bslOverlay.contains(e.target)) return;

  // Skip if controls are disabled by admin
  if (clientControlsDisabled) return;

  // Skip if YouTube is playing - it has its own click handler
  if (currentMediaIsYouTube) return;

  const w = window.innerWidth;
  const x = e.clientX;
  const center = w / 2;
  const edgeZone = 87;
  const pauseZone = 75;

  if (x <= edgeZone) {
    // If viewing an image, go to previous media
    if (currentMediaIsImage) {
      if (currentPlaylist.currentIndex > 0) {
        const prevIndex = currentPlaylist.currentIndex - 1;
        socket.emit('playlist-jump', prevIndex);
        showTemporaryMessage(`⏮ Previous media`);
      } else {
        showTemporaryMessage(`Already at first item`);
      }
    } else {
      video.currentTime = Math.max(0, video.currentTime - skipSeconds);
      showTemporaryMessage(`↩ Rewind ${skipSeconds}s`);
      sendControlEvent();
    }
  } else if (x >= w - edgeZone) {
    // If viewing an image, go to next media
    if (currentMediaIsImage) {
      if (currentPlaylist.currentIndex < currentPlaylist.videos.length - 1) {
        const nextIndex = currentPlaylist.currentIndex + 1;
        socket.emit('playlist-jump', nextIndex);
        showTemporaryMessage(`⏭ Next media`);
      } else {
        showTemporaryMessage(`Already at last item`);
      }
    } else {
      video.currentTime = Math.min(video.duration, video.currentTime + skipSeconds);
      showTemporaryMessage(`↪ Skip ${skipSeconds}s`);
      sendControlEvent();
    }
  } else if (x >= center - pauseZone && x <= center + pauseZone) {
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  } else if (x < center) {
    const newVol = setVolume(getVolume() - (volumeStep * 100));
    showTemporaryMessage(`Volume: ${Math.round(newVol)}%`);
  } else {
    const newVol = setVolume(getVolume() + (volumeStep * 100));
    showTemporaryMessage(`Volume: ${Math.round(newVol)}%`);
  }
});

// Auto-reconnect
setInterval(() => {
  if (!socket.connected) {
    socket.connect();
    showTemporaryMessage("Reconnecting...");
  }
}, 5000);

// ==================== BSL-S² (Both Side Local Sync Stream) ====================

// Generate machine fingerprint based on hardware/browser characteristics
function generateMachineFingerprint() {
  const components = [
    navigator.userAgent,
    navigator.language,
    navigator.platform,
    navigator.hardwareConcurrency || 'unknown',
    navigator.deviceMemory || 'unknown',
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    // Canvas fingerprint for additional uniqueness
    (() => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('BSL-S² fingerprint', 2, 2);
        return canvas.toDataURL().slice(-50);
      } catch (e) {
        return 'no-canvas';
      }
    })()
  ];

  // Simple hash function
  const str = components.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'machine-' + Math.abs(hash).toString(36);
}

// Get or generate client fingerprint and display name
function getClientIdentity() {
  // Generate fingerprint (may change slightly across browsers but stable within same browser)
  const fingerprint = generateMachineFingerprint();

  // Get stored fingerprint - use it if exists, otherwise use new one
  let storedFingerprint = localStorage.getItem('bsl-machine-fingerprint');
  let clientId;

  if (storedFingerprint) {
    // Use stored fingerprint for consistency
    clientId = storedFingerprint;
    console.log('BSL-S²: Using stored machine fingerprint:', clientId);
  } else {
    // Store the new fingerprint
    clientId = fingerprint;
    localStorage.setItem('bsl-machine-fingerprint', clientId);
    console.log('BSL-S²: Generated new machine fingerprint:', clientId);
  }

  // Get or set default display name
  let displayName = localStorage.getItem('bsl-client-name');
  if (!displayName) {
    displayName = 'Client-' + clientId.slice(-6);
    localStorage.setItem('bsl-client-name', displayName);
  }

  return { clientId, displayName };
}

const bslIdentity = getClientIdentity();
const bslClientId = bslIdentity.clientId;
let bslClientName = bslIdentity.displayName;

// Allow updating client name
function setBslClientName(newName) {
  bslClientName = newName;
  localStorage.setItem('bsl-client-name', newName);
  console.log('BSL-S²: Client name updated to:', newName);
}

// BSL-S² state
const bslLocalFiles = new Map(); // filename -> File object
const bslBlobUrls = new Map();   // filename -> blob URL
let bslMatchedVideos = {};       // playlistIndex -> localFileName
let bslDriftValues = {};         // playlistIndex -> drift seconds (offset for sync)

const bslOverlay = document.getElementById('bsl-overlay');
const bslFolderInput = document.getElementById('bsl-folder-input');
const bslSelectBtn = document.getElementById('bsl-select-btn');
const bslUsePreviousBtn = document.getElementById('bsl-use-previous-btn');
const bslResultDiv = document.getElementById('bsl-result');

// Get cached BSL folder data from localStorage
function getCachedBslFiles() {
  try {
    const cached = localStorage.getItem('bsl-cached-files');
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {
    console.error('Error reading cached BSL files:', e);
  }
  return null;
}

// Save BSL files to localStorage
function cacheBslFiles(files) {
  try {
    localStorage.setItem('bsl-cached-files', JSON.stringify(files));
    console.log('BSL-S²: Cached file list for future sessions');
  } catch (e) {
    console.error('Error caching BSL files:', e);
  }
}

// Handle admin BSL-S² check request
socket.on('bsl-check-request', (data) => {
  console.log('BSL-S² check requested by admin', data);
  showTemporaryMessage('Admin is checking for local videos...', 3000);

  // Check if we have cached files from previous session
  const cachedFiles = getCachedBslFiles();
  if (cachedFiles && cachedFiles.length > 0) {
    bslUsePreviousBtn.style.display = 'inline-block';
    bslUsePreviousBtn.textContent = `Use Previous (${cachedFiles.length} files)`;
  } else {
    bslUsePreviousBtn.style.display = 'none';
  }

  // Show the folder selection overlay
  bslOverlay.classList.add('visible');
  bslResultDiv.style.display = 'none';
});

// Handle Use Previous Folder button
bslUsePreviousBtn.addEventListener('click', () => {
  const cachedFiles = getCachedBslFiles();
  if (cachedFiles && cachedFiles.length > 0) {
    console.log(`BSL-S²: Using ${cachedFiles.length} cached files from previous session`);

    // Send cached file list to server
    socket.emit('bsl-folder-selected', {
      clientId: bslClientId,
      clientName: bslClientName,
      files: cachedFiles,
      fromCache: true
    });

    // Update UI
    bslSelectBtn.textContent = `${cachedFiles.length} videos (cached)`;
    bslSelectBtn.disabled = true;
    bslUsePreviousBtn.style.display = 'none';
    showTemporaryMessage(`Using ${cachedFiles.length} cached files`, 2000);
  }
});

// Handle folder selection button click
bslSelectBtn.addEventListener('click', () => {
  bslFolderInput.click();
});

// Handle skip button click
const bslSkipBtn = document.getElementById('bsl-skip-btn');
bslSkipBtn.addEventListener('click', () => {
  console.log('BSL-S²: User skipped folder selection');
  bslOverlay.classList.remove('visible');
  showTemporaryMessage('BSL-S²: Skipped - streaming from server', 2000);

  // Notify server that this client declined
  socket.emit('bsl-folder-selected', {
    clientId: bslClientId,
    clientName: bslClientName,
    files: [],
    skipped: true
  });
});

// Handle folder selection
bslFolderInput.addEventListener('change', (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  console.log(`BSL-S²: Selected folder with ${files.length} files`);

  // Clear previous data
  bslLocalFiles.clear();

  // Filter for video files and store them
  const videoExtensions = ['.mp4', '.mp3', '.avi', '.mov', '.wmv', '.mkv', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
  const videoFiles = [];

  for (const file of files) {
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (videoExtensions.includes(ext)) {
      bslLocalFiles.set(file.name.toLowerCase(), file);
      videoFiles.push({
        name: file.name,
        size: file.size,
        type: file.type
      });
    }
  }

  console.log(`BSL-S²: Found ${videoFiles.length} video files`);

  // Send file list to server with client ID and name
  socket.emit('bsl-folder-selected', {
    clientId: bslClientId,
    clientName: bslClientName,
    files: videoFiles
  });

  // Cache file list for future sessions
  cacheBslFiles(videoFiles);

  // Update UI
  bslSelectBtn.textContent = `${videoFiles.length} videos found`;
  bslSelectBtn.disabled = true;
  bslUsePreviousBtn.style.display = 'none';
});

// Handle match results from server
socket.on('bsl-match-result', (data) => {
  console.log('BSL-S² match results:', data);
  bslMatchedVideos = data.matchedVideos;

  // Create blob URLs for matched files
  Object.entries(bslMatchedVideos).forEach(([playlistIdx, localFileName]) => {
    const file = bslLocalFiles.get(localFileName.toLowerCase());
    if (file && !bslBlobUrls.has(localFileName.toLowerCase())) {
      const blobUrl = URL.createObjectURL(file);
      bslBlobUrls.set(localFileName.toLowerCase(), blobUrl);
      console.log(`BSL-S²: Created blob URL for ${localFileName}`);
    }
  });

  // Update UI with results
  bslResultDiv.style.display = 'block';
  if (data.totalMatched === data.totalPlaylist) {
    bslResultDiv.className = 'bsl-result success';
    bslResultDiv.textContent = `✓ All ${data.totalMatched} videos matched! Local playback enabled.`;
  } else if (data.totalMatched > 0) {
    bslResultDiv.className = 'bsl-result partial';
    bslResultDiv.textContent = `${data.totalMatched}/${data.totalPlaylist} videos matched locally.`;
  } else {
    bslResultDiv.className = 'bsl-result';
    bslResultDiv.textContent = `No matching videos found. Streaming from server.`;
  }

  // Auto-hide overlay after a delay
  setTimeout(() => {
    bslOverlay.classList.remove('visible');
    showTemporaryMessage(`BSL-S²: ${data.totalMatched} videos will play locally`, 3000);
  }, 2000);
});

// Handle drift updates from server
socket.on('bsl-drift-update', (data) => {
  console.log('BSL-S² drift update:', data);
  bslDriftValues = data.driftValues || {};
  showTemporaryMessage('Drift settings updated', 2000);
});

// Helper: Check if current video should use local playback
function getBslLocalUrl(filename) {
  // Find if this video is matched
  const playlistIdx = currentPlaylist.currentIndex;
  const matchedFileName = bslMatchedVideos[playlistIdx];

  if (matchedFileName) {
    const blobUrl = bslBlobUrls.get(matchedFileName.toLowerCase());
    if (blobUrl) {
      console.log(`BSL-S²: Using local file for ${filename}`);
      return blobUrl;
    }
  }
  return null;
}

// [Consolidated loadCurrentVideo]
// Legacy override removed.


// ==================== YouTube IFrame API Integration ====================

// Load YouTube IFrame API
function loadYouTubeAPI() {
  if (ytApiLoaded) return Promise.resolve();

  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      ytApiLoaded = true;
      resolve();
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      ytApiLoaded = true;
      resolve();
    };
  });
}

// Initialize YouTube player with a video ID
function initYouTubePlayer(videoId) {
  return new Promise((resolve) => {
    // Destroy existing player if any
    if (ytPlayer) {
      try {
        ytPlayer.destroy();
      } catch (e) {
        console.log('Error destroying previous player:', e);
      }
      ytPlayer = null;
      ytPlayerReady = false;
    }

    // Reset the "has played" flag for the new video
    ytVideoHasPlayed = false;

    ytPlayer = new YT.Player('youtube-player', {
      videoId: videoId,
      playerVars: {
        'controls': 0,           // Hide YouTube controls (this works)
        'disablekb': 1,          // Disable keyboard controls
        'rel': 0,                // Don't show related videos at end
        'fs': 0,                 // Disable fullscreen button
        'iv_load_policy': 3,     // Hide annotations
        'playsinline': 1,        // Play inline on mobile
        'cc_load_policy': 0,     // Don't show captions by default
        'autoplay': 1,           // Auto-play when ready
        'origin': window.location.origin
        // NOTE: 'modestbranding' was deprecated Aug 2023
        // NOTE: 'showinfo' was deprecated Sep 2018
      },
      events: {
        'onReady': (event) => {
          ytPlayerReady = true;
          console.log('YouTube player ready');

          // Auto-play if this is not the first video in playlist
          // (first video follows server sync, subsequent videos should auto-continue)
          if (currentPlaylist.currentIndex > 0) {
            event.target.playVideo();
          }

          resolve(event.target);
        },
        'onStateChange': (event) => {
          handleYouTubeStateChange(event);
        },
        'onError': (event) => {
          console.error('YouTube player error:', event.data);
          showTemporaryMessage('YouTube playback error', 3000);
        }
      }
    });
  });
}

// Track if YouTube video has actually started playing (to prevent false ENDED states)
// ytVideoHasPlayed is defined at the top of the script
// let ytVideoHasPlayed = false;

// Handle YouTube player state changes
function handleYouTubeStateChange(event) {
  if (!ytPlayerReady) return;

  // YT.PlayerState: UNSTARTED=-1, ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
  switch (event.data) {
    case YT.PlayerState.PLAYING:
      ytVideoHasPlayed = true; // Video has started playing at least once
      statusEl.classList.remove('visible');
      sendYouTubeControlEvent();
      break;
    case YT.PlayerState.PAUSED:
      showTemporaryMessage("Paused", 0);
      sendYouTubeControlEvent();
      break;
    case YT.PlayerState.BUFFERING:
      showTemporaryMessage("Loading...", 0);
      break;
    case YT.PlayerState.ENDED:
      // Only move to next if the video actually played first
      // This prevents skipping when video is still loading
      if (ytVideoHasPlayed && currentPlaylist.videos.length > 0) {
        const nextIndex = (currentPlaylist.currentIndex + 1) % currentPlaylist.videos.length;
        socket.emit('playlist-next', nextIndex);
        ytVideoHasPlayed = false; // Reset for next video
      }
      break;
  }
}

// Send control event for YouTube
function sendYouTubeControlEvent() {
  if (clientControlsDisabled) return;

  if (!hasInitialSync || !ytPlayer || !ytPlayerReady) return;

  try {
    const playerState = ytPlayer.getPlayerState();
    const isPlaying = playerState === YT.PlayerState.PLAYING;
    const currentTime = ytPlayer.getCurrentTime() || 0;

    socket.emit('control', {
      isPlaying: isPlaying,
      currentTime: currentTime,
      duration: ytPlayer.getDuration() || 0,
      volume: ytPlayer.getVolume() / 100,
      currentVideoIndex: currentPlaylist.currentIndex,
    });
  } catch (e) {
    console.log('Error sending YouTube control event:', e);
  }
}

// Apply sync state to YouTube player
function syncYouTubePlayer(state) {
  if (!ytPlayer || !ytPlayerReady) return;

  try {
    const playerState = ytPlayer.getPlayerState();
    const isCurrentlyPlaying = playerState === YT.PlayerState.PLAYING;

    // Sync play/pause
    if (state.isPlaying && !isCurrentlyPlaying) {
      ytPlayer.playVideo();
    } else if (!state.isPlaying && isCurrentlyPlaying) {
      ytPlayer.pauseVideo();
      showTemporaryMessage("Paused", 0);
    }

    // Sync time (with 1 second tolerance)
    const currentTime = ytPlayer.getCurrentTime() || 0;
    if (Math.abs(currentTime - state.currentTime) > 1) {
      ytPlayer.seekTo(state.currentTime, true);
    }
  } catch (e) {
    console.log('Error syncing YouTube player:', e);
  }
}

// Override the loadCurrentVideo to handle YouTube
const originalLoadWithBsl = loadCurrentVideo;
loadCurrentVideo = async function () {
  // Disable sync broadcast while loading new video
  hasInitialSync = false;

  if (currentPlaylist.videos.length === 0 || currentPlaylist.currentIndex < 0) {
    hideAllPlayers();
    waitingMessage.style.display = 'block';
    currentMediaIsImage = false;
    currentMediaIsYouTube = false;
    currentPlatform = 'local';
    return;
  }

  const currentVideo = currentPlaylist.videos[currentPlaylist.currentIndex];
  currentVideoInfo = currentVideo;

  // Check if this is a YouTube video
  if (currentVideo.isYouTube && currentVideo.youtubeId) {
    currentMediaIsYouTube = true;
    currentMediaIsImage = false;
    currentPlatform = 'youtube';

    // Hide all other players (including other external platforms)
    hideAllPlayers();

    // Show YouTube container
    youtubeContainer.classList.add('visible');
    waitingMessage.style.display = 'none';

    debugLog('Loading YouTube video:', currentVideo.youtubeId);
    showTemporaryMessage('📺 Loading YouTube video...', 2000);

    // Load YouTube API if needed, then initialize player
    await loadYouTubeAPI();
    await initYouTubePlayer(currentVideo.youtubeId);

    // Request sync from server
    socket.emit('request-sync');

    showTemporaryMessage('📺 YouTube - tap to control', 3000);
    return;
  }

  // Not YouTube - hide YouTube container
  currentMediaIsYouTube = false;
  youtubeContainer.classList.remove('visible');

  // Destroy YouTube player if exists
  if (ytPlayer) {
    try {
      ytPlayer.destroy();
    } catch (e) { }
    ytPlayer = null;
    ytPlayerReady = false;
  }

  // Call the original function for local videos/images
  originalLoadWithBsl.call(this);
};

// Click handler for YouTube overlay (use sync-player controls)
youtubeClickOverlay.addEventListener('click', (e) => {
  // Skip if controls are disabled by admin
  if (clientControlsDisabled) return;

  if (!currentMediaIsYouTube || !ytPlayer || !ytPlayerReady) return;

  const w = window.innerWidth;
  const x = e.clientX;
  const center = w / 2;
  const edgeZone = 87;
  const pauseZone = 75;

  try {
    if (x <= edgeZone) {
      // Rewind
      const currentTime = ytPlayer.getCurrentTime() || 0;
      ytPlayer.seekTo(Math.max(0, currentTime - skipSeconds), true);
      showTemporaryMessage(`↩ Rewind ${skipSeconds}s`);
      sendYouTubeControlEvent();
    } else if (x >= w - edgeZone) {
      // Skip forward
      const currentTime = ytPlayer.getCurrentTime() || 0;
      const duration = ytPlayer.getDuration() || 0;
      ytPlayer.seekTo(Math.min(duration, currentTime + skipSeconds), true);
      showTemporaryMessage(`↪ Skip ${skipSeconds}s`);
      sendYouTubeControlEvent();
    } else if (x >= center - pauseZone && x <= center + pauseZone) {
      // Play/Pause
      const playerState = ytPlayer.getPlayerState();
      if (playerState === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
      } else {
        ytPlayer.playVideo();
      }
    } else if (x < center) {
      // Volume down (left side between edge and center)
      const currentVol = ytPlayer.getVolume() || 0;
      const newVol = Math.max(0, currentVol - (volumeStep * 100));
      ytPlayer.setVolume(newVol);
      showTemporaryMessage(`Volume: ${Math.round(newVol)}%`);
    } else {
      // Volume up (right side between edge and center)
      const currentVol = ytPlayer.getVolume() || 0;
      const newVol = Math.min(100, currentVol + (volumeStep * 100));
      ytPlayer.setVolume(newVol);
      showTemporaryMessage(`Volume: ${Math.round(newVol)}%`);
    }
  } catch (e) {
    console.log('Error handling YouTube click:', e);
  }
});

// ==================== Mobile Landscape Prompt ====================

// Detect if user is on mobile
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (window.innerWidth <= 768 && 'ontouchstart' in window);
}

// Check if user already dismissed the prompt
function hasSeenMobilPrompt() {
  return localStorage.getItem('mobile-prompt-dismissed') === 'true';
}

// Show mobile landscape prompt
function showMobileLandscapePrompt() {
  const overlay = document.getElementById('mobile-landscape-overlay');
  if (overlay) {
    overlay.classList.add('visible');
  }
}

// Hide mobile landscape prompt
function hideMobileLandscapePrompt() {
  const overlay = document.getElementById('mobile-landscape-overlay');
  if (overlay) {
    overlay.classList.remove('visible');
  }
}

// Request fullscreen and landscape orientation
async function requestFullscreenLandscape() {
  const docEl = document.documentElement;

  try {
    // Request fullscreen
    if (docEl.requestFullscreen) {
      await docEl.requestFullscreen();
    } else if (docEl.webkitRequestFullscreen) {
      await docEl.webkitRequestFullscreen();
    } else if (docEl.mozRequestFullScreen) {
      await docEl.mozRequestFullScreen();
    } else if (docEl.msRequestFullscreen) {
      await docEl.msRequestFullscreen();
    }

    // Try to lock to landscape orientation
    if (screen.orientation && screen.orientation.lock) {
      try {
        await screen.orientation.lock('landscape');
      } catch (e) {
        console.log('Orientation lock not supported:', e);
      }
    }

    showTemporaryMessage('Fullscreen enabled!', 2000);
  } catch (e) {
    console.log('Fullscreen request failed:', e);
    showTemporaryMessage('Fullscreen not available', 2000);
  }

  hideMobileLandscapePrompt();
}

// Initialize mobile prompt
function initMobilePrompt() {
  if (!isMobileDevice()) {
    return;
  }

  const fullscreenBtn = document.getElementById('mobile-fullscreen-btn');
  const skipBtn = document.getElementById('mobile-skip-btn');

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
      requestFullscreenLandscape();
      localStorage.setItem('mobile-prompt-dismissed', 'true');
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      hideMobileLandscapePrompt();
      localStorage.setItem('mobile-prompt-dismissed', 'true');
    });
  }

  // Show prompt after a short delay to let page load
  setTimeout(showMobileLandscapePrompt, 500);
}

// Initialize on page load
initMobilePrompt();



// ==========================================
// Subtitle Renderer
// ==========================================
// Subtitle Renderer is now imported from /js/subtitles.js

// Initialize Subtitle Renderer
if (typeof SubtitleRenderer !== 'undefined') {
  subtitleRenderer = new SubtitleRenderer(video, subtitleOverlay);

  // Use RAF loop for smooth 60fps subtitle updates (fixes VTT freezing/lag)
  const subtitleLoop = () => {
    if (subtitleRenderer && subtitleRenderer.isEnabled) {
      subtitleRenderer.update();
    }
    requestAnimationFrame(subtitleLoop);
  };
  requestAnimationFrame(subtitleLoop);
  window.addEventListener('resize', () => subtitleRenderer.resize());
}

// ==================== Chat Widget Logic ====================

// Generate/Get Fingerprint (Ported from landing.html)
// Uses origin-specific key so localhost, LAN IP, HTTP, and HTTPS all get separate fingerprints
function generateFingerprint() {
  const storageKey = 'sync-player-fingerprint-' + window.location.origin;
  const stored = localStorage.getItem(storageKey);
  if (stored) return stored;

  const fp = 'fp_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  localStorage.setItem(storageKey, fp);
  return fp;
}

// Legacy fingerprint - for non-server mode (Ported from admin.html)
function generateLegacyFingerprint() {
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
        ctx.fillText('Sync fingerprint', 2, 2); // Changed text slightly to generic
        return canvas.toDataURL().slice(-50);
      } catch (e) {
        return 'no-canvas';
      }
    })()
  ];

  const str = components.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'legacy-' + Math.abs(hash).toString(36);
}

// Determine fingerprint based on mode
function getAppFingerprint() {
  // Check if running in server mode (URL typically not file:// and has standard ports/paths)
  // Or simply checking if we have a room code could be enough?
  // admin.html checks roomPathMatch. index.html always runs as "client".
  // Simple heuristic: If file:// protocol, definitely use legacy.
  // If http/https, try standard first.

  const isFileProtocol = window.location.protocol === 'file:';

  if (isFileProtocol) {
    // Legacy mode
    let stored = localStorage.getItem('legacy-fingerprint');
    if (!stored) {
      stored = generateLegacyFingerprint();
      localStorage.setItem('legacy-fingerprint', stored);
    }
    return stored;
  } else {
    // Standard Server Mode
    return generateFingerprint();
  }
}

const userFingerprint = getAppFingerprint();
let chatUsername = localStorage.getItem('chat-username');
const activeMessages = []; // Track active message elements for count-based fading
const usernameColorCache = new Map(); // Cache colors for usernames

// Generate a consistent RGB color from username string
// Constrained to not be too bright or too dark for readability over video
function getUsernameColor(username) {
  if (!username) return '#888888';

  // Check cache first
  if (usernameColorCache.has(username)) {
    return usernameColorCache.get(username);
  }

  // Generate hash from username
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    const char = username.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Use hash to generate HSL color with constrained saturation and lightness
  // Hue: 0-360 (full range for variety)
  // Saturation: 50-80% (vibrant but not neon)
  // Lightness: 45-65% (readable over dark and light backgrounds)
  const hue = Math.abs(hash) % 360;
  const saturation = 50 + (Math.abs(hash >> 8) % 30); // 50-80%
  const lightness = 45 + (Math.abs(hash >> 16) % 20); // 45-65%

  const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  usernameColorCache.set(username, color);
  return color;
}

// Add a local-only chat message (for system messages like /help)
function addLocalChatMessage(text, isSystem = false) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message system';

  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.style.color = '#aaa';
  textEl.style.fontStyle = 'italic';
  textEl.innerHTML = text;

  msgEl.appendChild(textEl);
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Track for fading
  activeMessages.push(msgEl);

  // Fade after 8 seconds for system messages (longer than normal)
  setTimeout(() => {
    if (!msgEl.classList.contains('fading-fast')) {
      msgEl.classList.add('fading-slow');
      setTimeout(() => {
        if (msgEl.parentNode) msgEl.remove();
        const index = activeMessages.indexOf(msgEl);
        if (index > -1) activeMessages.splice(index, 1);
      }, 2100);
    }
  }, 8000);
}

// Initialize chat widget
function initChatWidget() {
  const chatWidget = document.getElementById('chat-widget');
  const chatToggleBtn = document.getElementById('chat-toggle-btn');
  const chatHeader = document.getElementById('chat-header'); // Needed for hiding
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send');
  const chatMessages = document.getElementById('chat-messages');

  if (!chatWidget || !chatToggleBtn) return;

  // Only show chat widget if chat is enabled
  if (!chatEnabled) {
    chatWidget.style.display = 'none';
    return;
  }

  // Make widget visible
  chatWidget.classList.add('visible');

  // Horizontal Collapse Logic
  const isCollapsed = localStorage.getItem('chat-collapsed') === 'true';
  if (isCollapsed) {
    chatWidget.classList.add('collapsed');
    chatToggleBtn.textContent = '<';
  } else {
    chatToggleBtn.textContent = '>';
  }

  chatToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chatWidget.classList.toggle('collapsed');
    const collapsed = chatWidget.classList.contains('collapsed');
    chatToggleBtn.textContent = collapsed ? '<' : '>'; // Correct logic: < when collapsed (offscreen)
    localStorage.setItem('chat-collapsed', collapsed.toString());

    // Reset idle timer on toggle
    resetIdleTimer();
  });

  // Auto-Hide Logic for Toggle Button, Chat Elements, and Mouse Cursor
  let idleTimer;

  function resetIdleTimer() {
    // Always show first - remove idle class from body
    document.body.classList.remove('idle');
    chatHeader.classList.remove('idle-hidden');

    clearTimeout(idleTimer);

    // Hide if:
    // 1. Playlist is active (videos > 0)
    // 2. User is idle for 3 seconds
    // Works whether chat is collapsed OR expanded

    const hasPlaylist = typeof currentPlaylist !== 'undefined' && currentPlaylist.videos && currentPlaylist.videos.length > 0;

    if (hasPlaylist) {
      idleTimer = setTimeout(() => {
        // Re-check conditions just in case they changed during wait
        const stillHasPlaylist = typeof currentPlaylist !== 'undefined' && currentPlaylist.videos && currentPlaylist.videos.length > 0;

        if (stillHasPlaylist) {
          // Add idle class to body - CSS will hide cursor and chat elements
          document.body.classList.add('idle');
          chatHeader.classList.add('idle-hidden');
        }
      }, 3000);
    }
  }

  // Listen for mouse movement to reset timer
  document.addEventListener('mousemove', resetIdleTimer);
  document.addEventListener('click', resetIdleTimer);
  document.addEventListener('keydown', resetIdleTimer);
  document.addEventListener('touchstart', resetIdleTimer);

  // Initialize timer
  resetIdleTimer();

  // Username / Message Logic
  // Check for Server Mode name (higher priority)
  const serverName = sessionStorage.getItem('sync-player-name');

  if (serverName) {
    // Server Mode: Use the name from landing page/session
    chatUsername = serverName;
    chatInput.placeholder = "Type /help for commands list";
  } else {
    // Legacy Mode: Check local storage or ask user
    const localName = localStorage.getItem('chat-username');
    if (localName) {
      chatUsername = localName;
      chatInput.placeholder = "Type /help for commands list";
    } else {
      chatInput.placeholder = "Enter your name...";
    }
  }

  function handleInput(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Command processing
    const lowerCmd = trimmed.toLowerCase();

    if (lowerCmd === '/help') {
      addLocalChatMessage('<b>Available Commands:</b><br>' +
        '/help - Show this help message<br>' +
        '/fullscreen - Toggle fullscreen mode<br>' +
        '/rename [name] - Change your display name');
      chatInput.value = '';
      return;
    }

    if (lowerCmd === '/fullscreen') {
      if (typeof requestFullscreenLandscape === 'function') {
        requestFullscreenLandscape();
      }
      chatInput.value = '';
      return;
    }

    if (lowerCmd.startsWith('/rename ')) {
      const newName = trimmed.substring(8).trim().substring(0, 20);
      if (newName) {
        // Store the old name for local reference
        const oldName = chatUsername || 'Guest';
        // Update local storage immediately for responsiveness
        chatUsername = newName;
        sessionStorage.setItem('sync-player-name', newName);
        localStorage.setItem('chat-username', newName);
        // Send to server - server will broadcast "X is now known as Y" to all clients
        if (typeof socket !== 'undefined') {
          socket.emit('chat-message', {
            fingerprint: userFingerprint,
            sender: oldName,
            message: `/rename ${newName}`
          });
        }
      } else {
        addLocalChatMessage('Usage: /rename [new name]');
      }
      chatInput.value = '';
      return;
    }

    if (!chatUsername) {
      // First input is username (Legacy Mode only)
      chatUsername = text.trim().substring(0, 20); // Limit length

      // Only save to local storage if we are NOT in server mode (i.e. no serverName from session)
      if (!sessionStorage.getItem('sync-player-name')) {
        localStorage.setItem('chat-username', chatUsername);
      }

      chatInput.placeholder = "Type /help for commands list";

      // Optionally send a "joined" message or just set local state
      // For now, we just set the name and reset input
      chatInput.value = '';
      return;
    }

    if (!chatUsername) {
      console.warn('Chat username missing, defaulting to Guest for send');
      chatUsername = 'Guest';
    }

    console.log('Sending chat:', { fingerprint: userFingerprint, username: chatUsername, message: text });

    if (typeof socket !== 'undefined') {
      socket.emit('chat-message', {
        fingerprint: userFingerprint,
        sender: chatUsername, // Updated from username to sender to match server protocol
        message: text
      });
    }

    // Clear input after sending
    chatInput.value = '';
  }

  // Handle Enter key
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleInput(chatInput.value);
    }
  });

  chatSendBtn.addEventListener('click', () => {
    handleInput(chatInput.value);
  });
}

// Add message to UI with Fading Logic
function addChatMessage(data) {
  debugLog('Received chat message:', data);
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages || !data) return;

  // Filter out duplicate/bad data if needed, or just display.
  // Check data.sender (default) or legacy data.username
  const safeUsername = data.sender || data.username || 'Guest';

  // Check if message content is valid
  if (!data.message) return;

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message';
  if (data.fingerprint === userFingerprint) msgEl.classList.add('own');

  const senderEl = document.createElement('span');
  senderEl.className = 'sender';
  senderEl.style.color = getUsernameColor(safeUsername);
  senderEl.innerHTML = safeUsername + ':';

  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.innerHTML = data.message;

  msgEl.appendChild(senderEl);
  msgEl.appendChild(textEl);

  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight; // Auto scroll to bottom

  // Track active message
  activeMessages.push(msgEl);

  // 1. Time-based fading (5 seconds -> 2s fade)
  setTimeout(() => {
    if (!msgEl.classList.contains('fading-fast')) {
      msgEl.classList.add('fading-slow');
      // Remove from DOM after fade (2s + buffer)
      setTimeout(() => {
        if (msgEl.parentNode) msgEl.remove();
        const index = activeMessages.indexOf(msgEl);
        if (index > -1) activeMessages.splice(index, 1);
      }, 2100);
    }
  }, 5000);

  // 2. Count-based fading (>5 messages -> 0.5s fade on oldest)
  if (activeMessages.length > 5) {
    // Get the oldest message that isn't already effectively gone/fast-fading
    // The array is ordered by time. Index 0 is oldest.
    // We need to fade out activeMessages[0] ... activeMessages[length - 6]

    while (activeMessages.length > 5) {
      const oldestMsg = activeMessages.shift(); // Remove from tracking
      if (oldestMsg && !oldestMsg.classList.contains('fading-slow') && !oldestMsg.classList.contains('fading-fast')) {
        oldestMsg.classList.add('fading-fast');
        // Remove after 0.5s
        setTimeout(() => {
          if (oldestMsg.parentNode) oldestMsg.remove();
        }, 600);
      }
    }
  }
}

// Initialize chat
initChatWidget();

// Listen for incoming messages
if (typeof socket !== 'undefined') {
  socket.on('chat-message', (data) => {
    addChatMessage(data);
  });

  // Listen for name updates (when user uses /rename command)
  socket.on('name-updated', (data) => {
    if (data && data.newName) {
      chatUsername = data.newName;
      // Update storage so name persists
      sessionStorage.setItem('sync-player-name', data.newName);
      localStorage.setItem('chat-username', data.newName);
      console.log('Name updated to:', data.newName);
    }
  });
}

// Initialize Subtitle Renderer when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (typeof SubtitleRenderer !== 'undefined') {
    const vid = document.getElementById('video');
    const overlay = document.getElementById('subtitle-overlay');
    if (vid && overlay) {
      subtitleRenderer = new SubtitleRenderer(vid, overlay);
      console.log('SubtitleRenderer initialized');
    } else {
      console.error('Video or Overlay element not found for SubtitleRenderer');
    }
  } else {
    console.error('SubtitleRenderer class is not defined. Check script loading order.');
  }
});
