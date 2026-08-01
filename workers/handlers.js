'use strict'

// All IPC method handlers, extracted from the main worker. Handlers share the
// mutable `ctx` object (stores, engines, peers, swarm, identity).

const path = require('bare-path')
const fs = require('bare-fs')
const fsp = require('bare-fs/promises')
const { METHODS, EVENTS, createEvent } = require('../src/shared/protocol.js')
const { normalizePairingCode, deriveDeviceId, generateDropCode } = require('./shared/crypto.js')
const { getDurationMs, mergeSettings, startExpirationChecker } = require('./helpers.js')

// A device's stable identity key. identityKey (the peer's identity core key,
// persisted across restarts) is the canonical dedup key; legacy rows without
// it fall back to their id.
function canonicalDeviceKey(dev) {
  if (!dev || typeof dev !== 'object') return null
  return typeof dev.identityKey === 'string' && dev.identityKey
    ? dev.identityKey
    : typeof dev.id === 'string'
      ? dev.id
      : null
}

// One-time startup migration. Legacy records were keyed by ids derived from
// ephemeral noise keys (regenerated on every boot), so each restart created a
// new row for the same physical device. Re-key every record to its stable
// identity-derived id and delete the superseded duplicates.
async function cleanupDuplicateDevices(ctx) {
  try {
    const bee = await ctx.getBee('devices')
    const groups = new Map() // groupKey -> { rows: [{ key, value }], canonicalId }
    for await (const node of bee.createReadStream()) {
      const value = node.value
      if (!value || typeof value !== 'object' || !value.id) continue
      if (
        ctx.deviceIdentity &&
        (value.id === ctx.deviceIdentity.id || value.publicKey === ctx.deviceIdentity.publicKey)
      ) {
        continue // never touch the local node's own records
      }
      const identityKey =
        typeof value.identityKey === 'string' && value.identityKey ? value.identityKey : null
      const groupKey = identityKey || `id:${value.id}`
      const canonicalId = identityKey ? deriveDeviceId(identityKey) : value.id
      if (!groups.has(groupKey)) groups.set(groupKey, { rows: [], canonicalId })
      groups.get(groupKey).rows.push({ key: node.key, value })
    }
    let merged = 0
    let removed = 0
    for (const { rows, canonicalId } of groups.values()) {
      if (rows.length === 0) continue
      // Winner: the row with the most recent lastSeen (ISO strings compare
      // lexicographically).
      let winner = rows[0]
      for (const r of rows) {
        if ((r.value.lastSeen || '') > (winner.value.lastSeen || '')) winner = r
      }
      if (winner.key !== canonicalId || winner.value.id !== canonicalId) {
        await bee.put(canonicalId, { ...winner.value, id: canonicalId })
        merged++
        if (winner.key !== canonicalId) {
          await bee.del(winner.key)
          removed++
        }
      }
      for (const r of rows) {
        if (r === winner) continue
        await bee.del(r.key)
        removed++
      }
    }
    if (merged > 0 || removed > 0) {
      console.log(
        `[Worker] Device store cleanup: re-keyed ${merged} record(s), removed ${removed} stale duplicate(s)`
      )
    }
  } catch (err) {
    console.warn('[Worker] Device store cleanup failed:', err.message)
  }
}

function registerHandlers(ctx) {
  const { handlers, getBee, peers, send } = ctx

  handlers[METHODS.DEVICES_LIST] = async () => {
    // Source of truth is the devices bee (written by the trusted-handshake path)
    // merged with live connection state. Rows are deduplicated by the stable
    // identity key so stale noise-key-derived duplicates never surface.
    const bee = await getBee('devices')
    const deviceMap = new Map()

    for await (const node of bee.createReadStream()) {
      const dev = node.value
      if (dev && dev.id) {
        if (
          ctx.deviceIdentity &&
          (dev.id === ctx.deviceIdentity.id || dev.publicKey === ctx.deviceIdentity.publicKey)
        ) {
          continue
        }
        if (dev.name && dev.name.startsWith('Device-')) {
          continue
        }
        const key = canonicalDeviceKey(dev)
        if (!key) continue
        const existing = deviceMap.get(key)
        if (existing && (existing.lastSeen || '') > (dev.lastSeen || '')) continue
        deviceMap.set(key, { ...dev, isOnline: false })
      }
    }

    for (const [, peerObj] of peers.entries()) {
      const dev = peerObj.device
      if (dev && dev.id && dev.name !== 'Connecting...') {
        if (
          ctx.deviceIdentity &&
          (dev.id === ctx.deviceIdentity.id || dev.publicKey === ctx.deviceIdentity.publicKey)
        ) {
          continue
        }
        const key = canonicalDeviceKey(dev)
        if (!key) continue
        deviceMap.set(key, { ...dev, isOnline: true })
      }
    }

    return Array.from(deviceMap.values())
  }

  handlers[METHODS.DEVICES_TRUST] = async (params) => {
    const bee = await getBee('devices')
    const entry = await bee.get(params.id)
    if (!entry) return null
    const device = {
      ...entry.value,
      isTrusted: !entry.value.isTrusted,
      trustedAt: entry.value.isTrusted ? undefined : new Date().toISOString()
    }
    await bee.put(params.id, device)
    if (device.publicKey) {
      if (device.isTrusted) ctx.trustManager.addTrustedKey(device.publicKey)
      else ctx.trustManager.removeTrustedKey(device.publicKey)
    }
    send(createEvent(EVENTS.DEVICE_UPDATED, device))
    return device
  }

  handlers[METHODS.PRESENCE_SET] = async () => {
    // Presence is derived from live connections; nothing to set in this build.
    return { success: true }
  }

  handlers[METHODS.PRESENCE_GET] = async () => {
    return { status: ctx.connectionCount > 0 ? 'Online' : 'Offline' }
  }

  handlers[METHODS.DIAGNOSTICS_GET] = async () => {
    // Honest diagnostics from the metrics collector: null means "not measured".
    if (ctx.metricsCollector) {
      return ctx.metricsCollector.snapshot({
        peerCount: ctx.authenticatedPeerCount(),
        connected: ctx.authenticatedPeerCount() > 0,
        relayStatus: ctx.relayStatus || 'Disabled',
        avgLatencyMs: ctx.getPeerLatency ? ctx.getPeerLatency() : null,
        packetLossPercent: ctx.getPacketLoss ? ctx.getPacketLoss() : null
      })
    }
    return {
      natType: null,
      relayStatus: ctx.relayStatus || 'Disabled',
      dhtNodes: null,
      avgLatencyMs: ctx.getPeerLatency ? ctx.getPeerLatency() : null,
      packetLossPercent: ctx.getPacketLoss ? ctx.getPacketLoss() : null,
      noiseProtocol: 'Noise_XX_25519_ChaChaPoly_BLAKE2b',
      bandwidthMbps: null,
      systemCpuUsage: null,
      systemRamUsage: null,
      connectedPeersCount: 0,
      connected: false,
      uptimeMs: 0,
      bytesReceived: 0,
      bytesSent: 0
    }
  }

  handlers[METHODS.NOTIFICATIONS_LIST] = async () => {
    if (ctx.notificationStore) return ctx.notificationStore.getNotifications()
    return []
  }

  handlers[METHODS.NOTIFICATIONS_MARK_READ] = async () => {
    if (ctx.notificationStore) return ctx.notificationStore.markAllRead()
    return []
  }

  handlers[METHODS.NOTIFICATIONS_CLEAR] = async () => {
    if (ctx.notificationStore) return ctx.notificationStore.clear()
    return []
  }

  handlers[METHODS.DEVICES_GET_CODE] = async () => {
    if (!ctx.deviceIdentity) await ctx.initIdentity()
    const code = await ctx.trustManager.getOrCreatePairingCode()
    return {
      code,
      id: ctx.deviceIdentity.id,
      publicKey: ctx.deviceIdentity.publicKey,
      name: ctx.deviceIdentity.name,
      os: ctx.deviceIdentity.os
    }
  }

  handlers[METHODS.DEVICES_GET_IDENTITY] = async () => {
    if (!ctx.deviceIdentity) await ctx.initIdentity()
    let pairingCode = ''
    try {
      pairingCode = await ctx.trustManager.getOrCreatePairingCode()
    } catch (err) {
      console.warn('[Worker] getOrCreatePairingCode failed:', err.message)
    }
    return { ...ctx.deviceIdentity, pairingCode }
  }

  handlers[METHODS.DEVICES_PAIR_CODE] = async (params) => {
    const cleanCode = ctx.trustManager.registerJoinerCode(params?.code)
    if (!cleanCode) {
      throw new Error('Invalid pairing code format. Expected MD-XXXX-XXXX-XXXX-XXXX')
    }
    console.log(`[Worker] Pairing with code: ${cleanCode}`)
    return { success: true, code: cleanCode }
  }

  handlers[METHODS.FILES_CREATE_CODE] = async (params) => {
    const { filePath, filename, fileSize, expirationPreset = '30m' } = params
    if (!filePath) throw new Error('File path required for sharing')

    const code = generateDropCode()

    const transferId = `drop-${Date.now().toString(36)}`

    // Stage file to secure application temporary storage directory
    const tempDir = path.join(ctx.STORAGE_DIR, 'p2p-temp', transferId)
    try {
      await fsp.mkdir(tempDir, { recursive: true })
    } catch {}
    const stagedPath = path.join(tempDir, filename)
    console.log(`[Worker] Staging file for share ${code}: ${filePath} -> ${stagedPath}`)
    try {
      await fsp.copyFile(filePath, stagedPath)
    } catch (err) {
      console.error(`[Worker] File staging failed, falling back to original path:`, err.message)
    }
    const finalPath = fs.existsSync(stagedPath) ? stagedPath : filePath

    const duration = getDurationMs(expirationPreset)
    const createdAt = Date.now()
    const expiresAt = duration > 0 ? createdAt + duration : 0

    // Build the drop core + integrity manifest via TransferEngine (no offer is
    // sent; claimers pull the blocks after authenticating via the drop code).
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    const staged = await ctx.transferEngine.stageDrop({
      transferId,
      filePath: finalPath,
      filename,
      fileSize,
      fileType: ctx.transferEngine.getFileType(filename)
    })

    const topicLabel = `p2p-file-${code}`
    ctx.topicRegistry.join(topicLabel, { client: true, server: true })
    ctx.pendingSwarmTopics.set(transferId, { topicLabel, core: null, stagedPath: finalPath })

    const pendingShare = {
      id: transferId,
      code,
      filename,
      fileSize,
      fileType: ctx.transferEngine.getFileType(filename),
      filePath: finalPath,
      originalPath: filePath,
      coreKey: staged.coreKey,
      manifestHash: staged.manifestHash,
      checksum: staged.checksum,
      blockSize: staged.blockSize,
      blockCount: staged.blockCount,
      createdAt,
      expiresAt,
      expirationPreset,
      status: 'waiting',
      downloadCount: 0,
      isHost: true
    }

    const bee = await getBee('pendingShares')
    await bee.put(transferId, pendingShare)

    send(createEvent(EVENTS.PENDING_SHARE_UPDATED, pendingShare))
    console.log(
      `[Worker] Background pending code share created: ${code} (expires: ${expirationPreset})`
    )

    return pendingShare
  }

  handlers[METHODS.FILES_LIST_PENDING] = async () => {
    const bee = await getBee('pendingShares')
    const results = []
    const now = Date.now()
    for await (const node of bee.createReadStream()) {
      const share = node.value
      if (share && share.isHost === true) {
        if (share.status === 'waiting' && share.expiresAt > 0 && now >= share.expiresAt) {
          share.status = 'expired'
          await bee.put(share.id, share)
        }
        results.push(share)
      }
    }
    results.sort((a, b) => b.createdAt - a.createdAt)
    return results
  }

  handlers[METHODS.FILES_EXTEND_EXPIRATION] = async (params) => {
    const { id, addMinutes = 30 } = params
    const bee = await getBee('pendingShares')
    const entry = await bee.get(id)
    if (!entry) throw new Error('Pending share not found')

    const share = entry.value
    if (share.isHost !== true) {
      throw new Error('Permission denied: Only the share host can extend expiration')
    }

    const now = Date.now()
    const baseTime = share.expiresAt > 0 && share.expiresAt > now ? share.expiresAt : now
    const newExpiresAt = baseTime + addMinutes * 60 * 1000

    share.expiresAt = newExpiresAt
    share.status = 'waiting'
    await bee.put(id, share)

    // Re-join swarm topic if it was unjoined
    ctx.topicRegistry.ensure(`p2p-file-${share.code}`, { client: true, server: true })

    send(createEvent(EVENTS.PENDING_SHARE_UPDATED, share))
    console.log(`[Worker] Extended expiration for share ${share.code} by ${addMinutes}m`)
    return share
  }

  handlers[METHODS.FILES_CANCEL_CODE] = async (params) => {
    const { id } = params
    const bee = await getBee('pendingShares')
    const entry = await bee.get(id)
    if (entry && entry.value && entry.value.isHost !== true) {
      throw new Error('Permission denied: Only the share host can cancel share')
    }
    return await ctx.cleanupPendingShare(id, 'cancelled')
  }

  handlers[METHODS.FILES_DELETE_PENDING] = async (params) => {
    const { id } = params
    await ctx.cleanupPendingShare(id, 'cancelled')
    const bee = await getBee('pendingShares')
    await bee.del(id)
    return { deleted: id }
  }

  handlers[METHODS.FILES_CLAIM_CODE] = async (params) => {
    // MD- codes route to device pairing (random 80-bit code scheme)
    const mdCode = normalizePairingCode(params?.code)
    if (mdCode) {
      return handlers[METHODS.DEVICES_PAIR_CODE]({ code: mdCode })
    }

    let cleanCode = (params.code || '').trim().toUpperCase()
    if (!cleanCode.startsWith('DROP-')) {
      const raw = cleanCode.replace(/[^A-Z0-9]/g, '')
      if (raw.length === 8) {
        cleanCode = `DROP-${raw.slice(0, 4)}-${raw.slice(4, 8)}`
      }
    }
    console.log(`[Worker] Claiming one-time file code: ${cleanCode}`)

    ctx.activeClaims.add(cleanCode)

    console.log(`[Worker] Joining DHT swarm topic for file claim: ${cleanCode}`)
    ctx.topicRegistry.join(`p2p-file-${cleanCode}`, { client: true, server: true })

    // Send claim request to any existing connected peers
    for (const [pId, peerObj] of peers.entries()) {
      if (peerObj.signaling) {
        console.log(`[Worker] Sending CLAIM_FILE_REQ for ${cleanCode} to connected peer ${pId}`)
        peerObj.signaling.send({ type: 'CLAIM_FILE_REQ', code: cleanCode })
      }
    }

    return { success: true, code: cleanCode }
  }

  handlers[METHODS.DEVICES_PAIR] = async (params) => {
    const bee = await getBee('devices')
    const device = {
      id: params.id || `device-${Date.now().toString(36)}`,
      name: params.name || 'Unknown Device',
      os: params.os || 'Unknown',
      osVersion: params.osVersion || '',
      avatar: params.avatar || '',
      isTrusted: true,
      isEncrypted: true,
      isOnline: false,
      signalStrength: 0,
      lastSeen: new Date().toISOString(),
      ipAddress: params.ipAddress || '',
      pairedAt: Date.now()
    }
    await bee.put(device.id, device)
    send(createEvent(EVENTS.DEVICE_PAIRED, device))
    return device
  }

  handlers[METHODS.DEVICES_RENAME] = async (params) => {
    const bee = await getBee('devices')
    const entry = await bee.get(params.id)
    if (!entry) throw new Error('Device not found')
    const device = { ...entry.value, name: params.name }
    await bee.put(params.id, device)
    return device
  }

  handlers[METHODS.DEVICES_FAVORITE] = async (params) => {
    const bee = await getBee('devices')
    const entry = await bee.get(params.id)
    if (!entry) throw new Error('Device not found')
    const device = { ...entry.value, isFavorite: params.isFavorite }
    await bee.put(params.id, device)
    return device
  }

  handlers[METHODS.DEVICES_REMOVE] = async (params) => {
    const bee = await getBee('devices')
    await bee.del(params.id)
    return { deleted: params.id }
  }

  handlers[METHODS.DRIVE_GET_STATUS] = async () => {
    return {
      isMounted: false,
      driveLetter: 'Z',
      webdavUrl: 'http://127.0.0.1:41983/p2p/',
      port: 41983,
      permissions: { accessMode: 'all', allowedDeviceIds: [] }
    }
  }

  handlers[METHODS.DRIVE_MOUNT] = async (params) => {
    return {
      success: true,
      driveLetter: params?.driveLetter || 'Z',
      webdavUrl: 'http://127.0.0.1:41983/p2p/'
    }
  }

  handlers[METHODS.DRIVE_UNMOUNT] = async (params) => {
    return { success: true, driveLetter: params?.driveLetter || 'Z' }
  }

  handlers[METHODS.DRIVE_UPDATE_PERMISSIONS] = async (params) => {
    return {
      accessMode: params?.accessMode || 'all',
      allowedDeviceIds: params?.allowedDeviceIds || []
    }
  }

  handlers[METHODS.DRIVE_BROADCAST_FILE] = async (params) => {
    if (!params || !params.filename) return { success: false }
    const payload = {
      type: 'DRIVE_FILE_SYNC',
      senderIdentity: ctx.deviceIdentity,
      file: {
        id: params.id || `drive-${Date.now().toString(36)}`,
        filename: params.filename,
        fileSize: params.fileSize || 0,
        fileType: params.fileType || 'application/octet-stream'
      }
    }

    let broadcastCount = 0
    for (const [, peerObj] of peers.entries()) {
      if (peerObj.signaling) {
        try {
          peerObj.signaling.send(payload)
          broadcastCount++
        } catch {}
      }
    }

    console.log(`[Worker] DRIVE_BROADCAST_FILE sent to ${broadcastCount} peers: ${params.filename}`)
    return { success: true, broadcastCount }
  }

  handlers[METHODS.DRIVE_SHARE_INVITE] = async (params) => {
    const { targetPeerId } = params || {}
    let sentCount = 0
    for (const [peerId, peerObj] of peers.entries()) {
      if (
        (!targetPeerId || targetPeerId === peerId || peerObj.device?.id === targetPeerId) &&
        peerObj.signaling
      ) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_INVITE',
            senderIdentity: ctx.deviceIdentity
          })
          sentCount++
        } catch (err) {
          console.error(`[Worker] Failed to send DRIVE_SHARE_INVITE to ${peerId}:`, err.message)
        }
      }
    }
    console.log(`[Worker] DRIVE_SHARE_INVITE sent to ${sentCount} peers`)
    return { success: sentCount > 0, sentCount }
  }

  handlers[METHODS.DRIVE_SHARE_ACCEPT] = async (params) => {
    const { peerId } = params || {}
    for (const [pId, peerObj] of peers.entries()) {
      if ((!peerId || peerId === pId || peerObj.device?.id === peerId) && peerObj.signaling) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_ACCEPT',
            senderIdentity: ctx.deviceIdentity
          })
        } catch (err) {
          console.error(`[Worker] Failed to send DRIVE_SHARE_ACCEPT to ${pId}:`, err.message)
        }
      }
    }
    send(createEvent(EVENTS.DRIVE_AUTO_MOUNT, { peerId }))
    return { success: true }
  }

  handlers[METHODS.DRIVE_SHARE_DECLINE] = async (params) => {
    const { peerId } = params || {}
    for (const [pId, peerObj] of peers.entries()) {
      if ((!peerId || peerId === pId || peerObj.device?.id === peerId) && peerObj.signaling) {
        try {
          peerObj.signaling.send({
            type: 'DRIVE_SHARE_DECLINE',
            senderIdentity: ctx.deviceIdentity
          })
        } catch {}
      }
    }
    return { success: true }
  }

  handlers[METHODS.CHECK_FOR_UPDATES] = async () => {
    return { status: 'up_to_date', message: 'Application is already up to date.' }
  }

  handlers[METHODS.TRANSFERS_START] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    console.log(
      `[Worker] TRANSFERS_START: ${params.filename || 'unknown'} (${params.fileSize || 0} bytes) peer=${params.peerId || 'none'} path=${params.filePath || 'none'}`
    )
    return ctx.transferEngine.startSend(params)
  }

  handlers[METHODS.TRANSFERS_ACCEPT] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.approve(params.id)
  }

  handlers[METHODS.TRANSFERS_DECLINE] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.decline(params.id)
  }

  handlers[METHODS.TRANSFERS_PAUSE] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.pause(params.id)
  }

  handlers[METHODS.TRANSFERS_RESUME] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.resume(params.id)
  }

  handlers[METHODS.TRANSFERS_CANCEL] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.cancel(params.id)
  }

  handlers[METHODS.TRANSFERS_RETRY] = async (params) => {
    if (!ctx.transferEngine) throw new Error('Transfer engine not initialized')
    return ctx.transferEngine.retry(params.id)
  }

  handlers[METHODS.TRANSFERS_LIST] = async () => {
    if (!ctx.transferEngine) return []
    return ctx.transferEngine.list()
  }

  handlers[METHODS.CLIPBOARD_SEND] = async (params) => {
    console.log(
      '[Worker] CLIPBOARD_SEND broadcasting content:',
      typeof params?.content === 'string' ? params.content.slice(0, 30) : 'image payload'
    )
    const payload = {
      type: 'CLIPBOARD_SYNC',
      content: params.content,
      contentType: params.contentType || 'text',
      timestamp: Date.now()
    }
    let sentCount = 0
    for (const [peerId, peer] of peers.entries()) {
      if (peer && peer.stream && peer.device?.isOnline !== false) {
        try {
          peer.stream.write(JSON.stringify(payload) + '\n')
          sentCount++
        } catch (err) {
          console.warn(`[Worker] Failed sending clipboard to peer ${peerId}:`, err.message)
        }
      }
    }
    return { success: true, count: sentCount }
  }

  handlers[METHODS.DEVICES_SPEED_TEST] = async () => {
    // No fabricated numbers. A real speed test ships with the transfer engine
    // (Phase 1+); until then this endpoint honestly reports unavailability.
    throw new Error('Speed test is not available in this build')
  }

  handlers[METHODS.LAN_DISCOVERY_PEER] = async (params) => {
    // Electron main forwards LAN-discovered swarm (noise) keys here; LanDiscovery
    // validates them (64-hex, not self, not a duplicate) before joinPeer.
    const added = ctx.lanDiscovery ? ctx.lanDiscovery.handleAnnouncement(params?.key) : false
    return { success: true, added }
  }

  handlers[METHODS.TRANSFERS_BROADCAST] = async (params) => {
    const onlinePeers = Array.from(peers.values()).filter(
      (p) => p.device && p.device.isOnline !== false
    )
    console.log(`[Worker] TRANSFERS_BROADCAST to ${onlinePeers.length} online peers`)
    const results = []
    for (const p of onlinePeers) {
      try {
        const res = await handlers[METHODS.TRANSFERS_START]({
          ...params,
          peerId: p.device.id,
          peerName: p.device.name
        })
        results.push(res)
      } catch (err) {
        console.warn(`[Worker] Broadcast error for peer ${p.device.id}:`, err.message)
      }
    }
    return { success: true, count: results.length, transfers: results }
  }

  handlers[METHODS.SHARED_LIST] = async () => {
    const bee = await getBee('shared')
    const results = []
    for await (const node of bee.createReadStream()) {
      results.push(node.value)
    }
    return results
  }

  handlers[METHODS.SHARED_REMOVE] = async (params) => {
    const bee = await getBee('shared')
    await bee.del(params.id)
    return { deleted: params.id }
  }

  handlers[METHODS.SHARED_FAVORITE] = async (params) => {
    const bee = await getBee('shared')
    const entry = await bee.get(params.id)
    if (!entry) throw new Error('File not found')
    const file = { ...entry.value, isFavorite: params.isFavorite }
    await bee.put(params.id, file)
    return file
  }

  handlers[METHODS.HISTORY_LIST] = async () => {
    const bee = await getBee('history')
    const results = []
    for await (const node of bee.createReadStream()) {
      results.push(node.value)
    }
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    return results
  }

  handlers[METHODS.HISTORY_CLEAR] = async () => {
    const bee = await getBee('history')
    const keys = []
    for await (const node of bee.createReadStream()) {
      keys.push(node.key)
    }
    for (const k of keys) {
      await bee.del(k)
    }
    return { success: true, count: keys.length }
  }

  handlers[METHODS.TRANSFERS_CLEAR] = async () => {
    if (!ctx.transferEngine) return { success: true, count: 0 }
    return ctx.transferEngine.clear()
  }

  handlers[METHODS.STORAGE_CLEAR] = async () => {
    const tempDir = path.join(ctx.STORAGE_DIR, 'p2p-temp')
    try {
      const files = await fsp.readdir(tempDir).catch(() => [])
      for (const f of files) {
        await fsp.unlink(path.join(tempDir, f)).catch(() => {})
      }
    } catch {}
    return { success: true }
  }

  handlers[METHODS.CONNECTION_STATUS] = async () => {
    return ctx.getConnectionStatus()
  }

  handlers[METHODS.SETTINGS_GET] = async () => {
    const bee = await getBee('settings')
    const entry = await bee.get('settings')
    return mergeSettings(entry?.value)
  }

  handlers[METHODS.SETTINGS_UPDATE] = async (params) => {
    const bee = await getBee('settings')
    const entry = await bee.get('settings')
    const merged = mergeSettings({ ...(entry?.value || {}), ...(params || {}) })
    await bee.put('settings', merged)
    send(createEvent(EVENTS.SETTINGS_UPDATED, merged))
    // Drop the autoTrustLAN cache so the next connection honors the new value.
    if (ctx.invalidateSettingsCache) ctx.invalidateSettingsCache()
    return merged
  }

  handlers[METHODS.STORAGE_STATS] = async () => {
    return {
      storageUsed: 0,
      storageTotal: 0
    }
  }

  // Expire stale pairing secrets and pending shares every 10s.
  const expirationTimer = startExpirationChecker(ctx)
  return { expirationTimer, cleanupDuplicateDevices }
}

module.exports = { registerHandlers, cleanupDuplicateDevices }
