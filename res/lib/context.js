// context.js — Dual-mode context resolution helper
// Eliminates the ~8-line SERVER_MODE boilerplate from 15+ socket handlers.

const { SERVER_MODE } = require('./config');
const { socketRoomMap, getRoom } = require('./rooms');

/**
 * Resolves the correct playlist/videoState/roomCode for any socket event.
 * Returns null if the socket is not in a valid room (SERVER_MODE only).
 *
 * @param {string} socketId - The socket.id of the requesting client
 * @param {object} legacyState - Object containing legacy mode globals:
 *   { PLAYLIST, videoState, clientBslStatus, clientDriftValues, adminSocketId, connectedClients, verifiedAdminSockets }
 * @param {object} io - The socket.io Server instance (for emit helpers)
 * @returns {object|null} Context object or null if invalid
 */
function resolveContext(socketId, legacyState, io) {
  if (SERVER_MODE) {
    const roomCode = socketRoomMap.get(socketId);
    const room = roomCode ? getRoom(roomCode) : null;
    if (!room) return null;
    return {
      playlist: room.playlist,
      videoState: room.videoState,
      roomCode,
      room,
      bslStatus: room.clientBslStatus,
      driftValues: room.clientDriftValues,
      adminSocketId: room.adminSocketId,
      isAdmin: room.adminSocketId === socketId,
      emit: (event, data) => io.to(roomCode).emit(event, data)
    };
  }
  return {
    playlist: legacyState.PLAYLIST,
    videoState: legacyState.videoState,
    roomCode: null,
    room: null,
    bslStatus: legacyState.clientBslStatus,
    driftValues: legacyState.clientDriftValues,
    adminSocketId: legacyState.adminSocketId,
    isAdmin: legacyState.verifiedAdminSockets
      ? legacyState.verifiedAdminSockets.has(socketId)
      : true,
    emit: (event, data) => io.emit(event, data)
  };
}

module.exports = { resolveContext };
