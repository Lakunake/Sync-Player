// rooms.js — Room class, CRUD functions, RoomLogger, and socket-room mapping
// Extracted from server.js to eliminate the monolith.

const fs = require('fs');
const path = require('path');
const { colors, MEMORY_DIR, SERVER_MODE } = require('./config');

// ==================== Room Logger System ====================
class RoomLogger {
  constructor() {
    this.generalLogFile = path.join(MEMORY_DIR, 'general.json');
    this.adminsFile = path.join(MEMORY_DIR, 'room_admins.json');
    this.adminsCache = null;
    this.writeQueue = new Map(); // Ensures sequential async writes per file
    this.ensureGeneralLog();
    this.loadAdminsSync();
  }

  // Helper to ensure file operations don't data-race each other
  queuedUpdate(filePath, updateFn) {
    if (!this.writeQueue.has(filePath)) {
      this.writeQueue.set(filePath, Promise.resolve());
    }

    const task = this.writeQueue.get(filePath).then(async () => {
      let data = null;
      try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        data = JSON.parse(raw);
      } catch (e) {}

      data = updateFn(data);

      if (data) {
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
      }
    }).catch(e => console.error('Error in write queue:', e));

    this.writeQueue.set(filePath, task);
  }

  ensureGeneralLog() {
    if (!fs.existsSync(this.generalLogFile)) {
      fs.writeFileSync(this.generalLogFile, JSON.stringify({ logs: [] }, null, 2));
    }
  }

  logGeneral(event, details = {}) {
    this.queuedUpdate(this.generalLogFile, (logData) => {
      if (!logData || !logData.logs) logData = { logs: [] };
      logData.logs.push({
        timestamp: new Date().toISOString(),
        event,
        ...details
      });
      if (logData.logs.length > 1000) {
        logData.logs = logData.logs.slice(-1000);
      }
      return logData;
    });
  }

  logRoom(roomCode, event, details = {}) {
    const roomLogFile = path.join(MEMORY_DIR, `${roomCode}.json`);
    this.queuedUpdate(roomLogFile, (logData) => {
      if (!logData || !logData.logs) logData = { roomCode, logs: [] };
      if (!logData.roomCode) logData.roomCode = roomCode;

      logData.logs.push({
        timestamp: new Date().toISOString(),
        event,
        ...details
      });

      if (logData.logs.length > 500) {
        logData.logs = logData.logs.slice(-500);
      }
      return logData;
    });
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
    fs.writeFile(roomLogFile, JSON.stringify(logData, null, 2), () => {});
  }

  deleteRoomLog(roomCode) {
    const roomLogFile = path.join(MEMORY_DIR, `${roomCode}.json`);
    fs.unlink(roomLogFile, (err) => {
      if (err && err.code !== 'ENOENT') console.error('Error deleting room log:', err);
    });
  }

  // ==================== Admin Fingerprint Persistence ====================
  loadAdminsSync() {
    try {
      if (fs.existsSync(this.adminsFile)) {
        this.adminsCache = JSON.parse(fs.readFileSync(this.adminsFile, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading room admins:', error);
    }
    if (!this.adminsCache) this.adminsCache = {};
  }

  saveAdminsAsync() {
    fs.writeFile(this.adminsFile, JSON.stringify(this.adminsCache, null, 2), (err) => {
      if (err) console.error('Error saving room admins:', err);
    });
  }

  saveAdminFingerprint(roomCode, fingerprint) {
    this.adminsCache[roomCode] = {
      fingerprint,
      savedAt: new Date().toISOString()
    };
    this.saveAdminsAsync();
    console.log(`Admin fingerprint saved for room ${roomCode}`);
  }

  getAdminFingerprint(roomCode) {
    return this.adminsCache[roomCode]?.fingerprint || null;
  }

  deleteAdminFingerprint(roomCode) {
    if (this.adminsCache[roomCode]) {
      delete this.adminsCache[roomCode];
      this.saveAdminsAsync();
      console.log(`Admin fingerprint deleted for room ${roomCode}`);
    }
  }
}

const roomLogger = SERVER_MODE ? new RoomLogger() : null;

// ==================== Room Class ====================
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

module.exports = {
  Room,
  RoomLogger,
  roomLogger,
  rooms,
  socketRoomMap,
  generateRoomCode,
  createRoom,
  getRoom,
  deleteRoom,
  getPublicRooms,
  _getTrackSelections
};
