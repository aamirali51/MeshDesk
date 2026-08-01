'use strict'

// Single source of truth for the MeshDesk IPC protocol.
// Consumed by: Electron main (electron/main.js), the Bare P2P worker
// (workers/main.js), and the renderer (via renderer/src/types/protocol.ts).

const PROTOCOL_VERSION = '1.0'

const METHODS = {
  DEVICES_LIST: 'devices.list',
  DEVICES_PAIR: 'devices.pair',
  DEVICES_PAIR_CODE: 'devices.pairCode',
  DEVICES_GET_CODE: 'devices.getCode',
  DEVICES_RENAME: 'devices.rename',
  DEVICES_REMOVE: 'devices.remove',
  DEVICES_FAVORITE: 'devices.favorite',
  DEVICES_TRUST: 'devices.trust',
  DEVICES_GET_IDENTITY: 'devices.getIdentity',
  DEVICES_SPEED_TEST: 'devices.speedTest',
  PRESENCE_SET: 'presence.set',
  PRESENCE_GET: 'presence.get',
  DIAGNOSTICS_GET: 'diagnostics.get',
  NOTIFICATIONS_LIST: 'notifications.list',
  NOTIFICATIONS_CLEAR: 'notifications.clear',
  NOTIFICATIONS_MARK_READ: 'notifications.markRead',
  HISTORY_LIST: 'history.list',
  HISTORY_CLEAR: 'history.clear',
  CONNECTION_STATUS: 'connection.status',
  SETTINGS_GET: 'settings.get',
  SETTINGS_UPDATE: 'settings.update',
  STORAGE_STATS: 'storage.stats',
  STORAGE_CLEAR: 'storage.clear',
  FILES_CREATE_CODE: 'files.createCode',
  FILES_CLAIM_CODE: 'files.claimCode',
  FILES_LIST_PENDING: 'files.listPending',
  FILES_EXTEND_EXPIRATION: 'files.extendExpiration',
  FILES_CANCEL_CODE: 'files.cancelCode',
  FILES_DELETE_PENDING: 'files.deletePending',
  TRANSFERS_START: 'transfers.start',
  TRANSFERS_ACCEPT: 'transfers.accept',
  TRANSFERS_DECLINE: 'transfers.decline',
  TRANSFERS_PAUSE: 'transfers.pause',
  TRANSFERS_RESUME: 'transfers.resume',
  TRANSFERS_CANCEL: 'transfers.cancel',
  TRANSFERS_RETRY: 'transfers.retry',
  TRANSFERS_LIST: 'transfers.list',
  TRANSFERS_CLEAR: 'transfers.clear',
  TRANSFERS_BROADCAST: 'transfers.broadcast',
  SHARED_LIST: 'shared.list',
  SHARED_REMOVE: 'shared.remove',
  SHARED_FAVORITE: 'shared.favorite',
  DRIVE_GET_STATUS: 'drive.getStatus',
  DRIVE_MOUNT: 'drive.mount',
  DRIVE_UNMOUNT: 'drive.unmount',
  DRIVE_UPDATE_PERMISSIONS: 'drive.updatePermissions',
  DRIVE_BROADCAST_FILE: 'drive.broadcastFile',
  DRIVE_SHARE_INVITE: 'drive.shareInvite',
  DRIVE_SHARE_ACCEPT: 'drive.shareAccept',
  DRIVE_SHARE_DECLINE: 'drive.shareDecline',
  CHECK_FOR_UPDATES: 'system.checkForUpdates',
  CLIPBOARD_SEND: 'clipboard.send',
  LAN_DISCOVERY_PEER: 'lan.discoveryPeer'
}

const EVENTS = {
  DEVICE_ONLINE: 'device.online',
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_DISCOVERED: 'device.discovered',
  DEVICE_PAIRED: 'device.paired',
  DEVICE_UPDATED: 'device.updated',
  PRESENCE_CHANGED: 'presence.changed',
  PEER_CONNECTED: 'peer.connected',
  PEER_DISCONNECTED: 'peer.disconnected',
  WORKER_READY: 'worker.ready',
  CONNECTION_CHANGED: 'connection.changed',
  STORAGE_CHANGED: 'storage.changed',
  NOTIFICATION_RECEIVED: 'notification.received',
  TRANSFER_OFFER_RECEIVED: 'transfer.offer_received',
  TRANSFER_STARTED: 'transfer.started',
  TRANSFER_PROGRESS: 'transfer.progress',
  TRANSFER_COMPLETED: 'transfer.completed',
  TRANSFER_FAILED: 'transfer.failed',
  TRANSFER_PAUSED: 'transfer.paused',
  TRANSFER_RESUMED: 'transfer.resumed',
  TRANSFER_CANCELLED: 'transfer.cancelled',
  TRANSFER_QUEUED: 'transfer.queued',
  PENDING_SHARE_UPDATED: 'pending_share.updated',
  PENDING_SHARE_EXPIRED: 'pending_share.expired',
  PENDING_SHARE_CLAIMED: 'pending_share.claimed',
  PENDING_SHARE_CLAIM_FAILED: 'pending_share.claimFailed',
  CLIPBOARD_RECEIVED: 'clipboard.received',
  DRIVE_INVITE_RECEIVED: 'drive.inviteReceived',
  DRIVE_AUTO_MOUNT: 'drive.autoMount',
  UPDATING: 'updating',
  UPDATED: 'updated',
  SETTINGS_UPDATED: 'settings.updated',
  SPEEDTEST_PROGRESS: 'speedtest.progress',
  LAN_DISCOVERY_KEY: 'lan.discoveryKey'
}

// A message is compatible when it is unversioned (legacy v1) or exactly matches
// the current protocol version. Unknown future versions are rejected.
function isProtocolCompatible(msg) {
  if (!msg || typeof msg !== 'object') return false
  if (msg.v === undefined || msg.v === null) return true // legacy unversioned
  return msg.v === PROTOCOL_VERSION
}

let nextId = 1
function generateId() {
  return (nextId++).toString(36)
}

function createRequest(method, params) {
  return JSON.stringify({
    type: 'request',
    v: PROTOCOL_VERSION,
    id: generateId(),
    method,
    params
  })
}

function createResponse(id, result, error) {
  return JSON.stringify({
    type: 'response',
    v: PROTOCOL_VERSION,
    id,
    result,
    error
  })
}

function createEvent(event, data) {
  return JSON.stringify({
    type: 'event',
    v: PROTOCOL_VERSION,
    event,
    data
  })
}

function parseMessage(buffer) {
  try {
    return JSON.parse(buffer.toString())
  } catch {
    return null
  }
}

module.exports = {
  PROTOCOL_VERSION,
  METHODS,
  EVENTS,
  isProtocolCompatible,
  generateId,
  createRequest,
  createResponse,
  createEvent,
  parseMessage
}
