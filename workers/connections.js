'use strict'

// Peer connection, pairing, signaling, and swarm lifecycle. Extracted from the
// main worker. Mutable state (peers, swarm, engines, identity) lives on the
// shared `ctx` object; this module only defines behavior around it.

const Protomux = require('protomux')
const c = require('compact-encoding')
const path = require('bare-path')
const fsp = require('bare-fs/promises')
const os = require('bare-os')
const { EVENTS, createEvent } = require('../src/shared/protocol.js')
const { deriveDeviceId } = require('./shared/crypto.js')
const { getTransferMethod } = require('./helpers.js')

// PING/PONG latency probing over the p2p-signal-v1 channel.
const PING_INTERVAL_MS = 5000 // how often to ping each authenticated peer
const PING_TIMEOUT = 3000 // a ping without a PONG inside this window counts as lost
const PING_WINDOW = 20 // rolling outcomes / RTT samples kept per peer

// Best-effort per-connection relay detection. hyperdht computes `relayed`
// internally (lib/connect.js stores it on the connect session) but does not
// expose it on the stream it hands to hyperswarm, so we derive it here from
// the signals the library does give us:
//   1. peerInfo.forceRelaying — hyperswarm sets this when a direct punch
//      failed and the connection was retried through a DHT relay. It persists
//      for the discovery entry, so treat it as "relay was used for this peer".
//   2. Routing-table match — a relayed connection's socket talks to the DHT
//      relay node we dialed by key, which is a node in our routing table.
//      Direct peer connections talk to the peer, not a routing-table node.
//      Relays are always public DHT nodes, so private/LAN remotes are
//      excluded (a private address means a direct LAN connection).
function isRelayedConnection(peerInfo, connection, dht) {
  if (peerInfo && peerInfo.forceRelaying) return true
  try {
    const remote =
      (connection &&
        (connection.remoteAddress ||
          (connection.rawStream && connection.rawStream.remoteAddress) ||
          (connection._socket && connection._socket.remoteAddress))) ||
      ''
    if (remote && dht && dht.nodes) {
      const host = remote.split(':')[0]
      // Relays are public DHT nodes; a private-range remote is a direct LAN
      // connection, never a relay.
      if (
        /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|127\.|::1|::ffff:127\.)/.test(
          host
        )
      ) {
        return false
      }
      for (let node = dht.nodes.latest; node; node = node.prev) {
        if (!node.host || !node.port) continue
        if (remote === node.host || remote === node.host + ':' + node.port) return true
      }
    }
  } catch {}
  return false
}

function createConnections(ctx) {
  const { peers, swarm, activeClaims } = ctx

  // Count only peers whose handshake completed: pairing.complete is set
  // exclusively by the verified challenge-response path.
  function authenticatedPeerCount() {
    let n = 0
    for (const p of peers.values()) {
      if (p.pairing && p.pairing.complete && p.device && p.device.isOnline) n++
    }
    return n
  }

  function getConnectionStatus() {
    let relayedPeerCount = 0
    for (const p of peers.values()) {
      if (p.pairing && p.pairing.complete && p.device && p.device.isOnline && p.device.relayed) {
        relayedPeerCount++
      }
    }
    const authenticated = authenticatedPeerCount()
    return {
      connected: authenticated > 0,
      peerCount: authenticated,
      relayedPeerCount,
      directPeerCount: authenticated - relayedPeerCount,
      storageUsed: 0,
      storageTotal: 0
    }
  }

  function emitConnectionChanged() {
    ctx.send(createEvent(EVENTS.CONNECTION_CHANGED, getConnectionStatus()))
  }

  function setupPeerSignaling(connection, peerId, { directTrusted = false } = {}) {
    const mux = Protomux.isProtomux(connection) ? connection : Protomux.from(connection)
    const pendingQueue = []
    let signalMessage = null

    const channel = mux.createChannel({
      protocol: 'p2p-signal-v1',
      id: null,
      async onopen() {
        console.log(`[Worker] Signaling channel opened with ${peerId}`)
        const peerObj = peers.get(peerId)
        if (peerObj && peerObj.pairing) {
          if (peerObj.pairing.trusted) {
            sendHandshake(peerId)
          } else {
            sendPairingChallenges(peerId)
          }
        }
        if (activeClaims.size > 0) {
          for (const code of activeClaims) {
            console.log(`[Worker] Sending queued CLAIM_FILE_REQ for code ${code} to ${peerId}`)
            try {
              if (signalMessage) {
                signalMessage.send(JSON.stringify({ type: 'CLAIM_FILE_REQ', code }))
              }
            } catch (err) {
              console.error('[Worker] Failed to send queued CLAIM_FILE_REQ:', err)
            }
          }
        }
        while (pendingQueue.length > 0) {
          const item = pendingQueue.shift()
          try {
            console.log(`[Worker] Flushing queued signaling message for ${peerId}:`, item?.type)
            if (signalMessage) signalMessage.send(JSON.stringify(item))
          } catch (err) {
            console.error('[Worker] Failed to send queued signal message:', err)
          }
        }
      },
      onclose() {
        console.log(`[Worker] Signaling channel closed with ${peerId}`)
      }
    })

    signalMessage = channel.addMessage({
      encoding: c.string,
      onmessage(raw) {
        try {
          const msg = JSON.parse(raw)
          handlePeerMessage(peerId, msg)
        } catch (err) {
          console.error('[Worker] Error parsing peer signal message:', err)
        }
      }
    })

    channel.open()

    // Retry sending handshake/challenges after open tick to handle async channel ready states
    setTimeout(() => {
      const peerObj = peers.get(peerId)
      if (!peerObj || !peerObj.pairing) return
      if (peerObj.pairing.trusted) sendHandshake(peerId)
      else sendPairingChallenges(peerId)
    }, 150)
    setTimeout(() => {
      const peerObj = peers.get(peerId)
      if (!peerObj || !peerObj.pairing) return
      if (peerObj.pairing.trusted) sendHandshake(peerId)
      else sendPairingChallenges(peerId)
    }, 600)

    return {
      send(obj) {
        if (channel.opened && signalMessage) {
          try {
            signalMessage.send(JSON.stringify(obj))
          } catch (err) {
            console.error('[Worker] Failed to send signal message:', err)
          }
        } else {
          console.log(`[Worker] Queueing signal message for ${peerId} (channel opening)`)
          pendingQueue.push(obj)
        }
      }
    }
  }

  // Send our identity to a peer we already trust. Never called for untrusted peers.
  function sendHandshake(peerId) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.signaling || peerObj.handshakeSent) return
    if (!ctx.deviceIdentity || !peerObj.pairing || !peerObj.pairing.trusted) return
    peerObj.handshakeSent = true
    try {
      peerObj.signaling.send({
        type: 'HANDSHAKE',
        identity: { ...ctx.deviceIdentity, noisePublicKey: peerId }
      })
    } catch (err) {
      console.error('[Worker] Failed to send HANDSHAKE:', err.message)
    }
  }

  // Open exchange-store replication for a peer on its connection. Only called
  // after the peer has been authenticated (trusted pairing, verified handshake,
  // or a valid one-time-share claim). The private metadata store is never exposed.
  function replicateExchange(peerId) {
    const peerObj = peers.get(peerId)
    if (!peerObj || peerObj.replStream) return
    try {
      peerObj.replStream = ctx.replicationScope.replicate(peerId, peerObj.connection)
      if (!peerObj.replStream) return
      console.log(`[Worker] Exchange replication opened with ${peerId}`)
    } catch (err) {
      console.warn(`[Worker] Failed to replicate exchange store with ${peerId}:`, err.message)
    }
  }

  // Send a pairing challenge for every active pairing secret this device knows,
  // one outstanding challenge per (peer, secret) to keep MACs unambiguously tied
  // to a single nonce.
  function sendPairingChallenges(peerId) {
    if (ctx.trustManager) ctx.trustManager.sendChallenges(peerId)
  }

  // Respond to a peer's challenge using the pairing secret matching its codeId.
  // Trust is NEVER granted here; we only prove our own knowledge of the code.
  function handlePairingChallenge(peerId, msg) {
    if (ctx.trustManager) ctx.trustManager.handleChallenge(peerId, msg)
  }

  // Verify the peer's response to OUR challenge. Only here do we grant trust.
  // On failure the connection is destroyed.
  function handlePairingResponse(peerId, msg) {
    if (ctx.trustManager) ctx.trustManager.handleResponse(peerId, msg)
  }

  // ─── PING/PONG latency probe ───────────────────────────────────────────
  // A light measurement protocol over the existing signaling channel. Every
  // PING_INTERVAL_MS we send a timestamped PING to each authenticated peer;
  // the peer echoes it back as a PONG. RTT feeds a rolling per-peer average
  // (avgLatencyMs), and pings without a PONG feed a rolling success rate
  // (packet-loss proxy).
  function ensurePingState(peerObj) {
    if (peerObj.pings) return
    peerObj.pings = {
      nextId: 0,
      outstanding: new Map(), // id -> { sentAt, timer }
      rttSamples: [], // rolling RTT values (ms)
      window: [] // rolling ping outcomes: { ok: boolean }
    }
  }

  function pushPingResult(peerObj, ok, rtt) {
    const p = peerObj.pings
    if (ok && rtt >= 0) {
      p.rttSamples.push(rtt)
      if (p.rttSamples.length > PING_WINDOW) p.rttSamples.shift()
    }
    p.window.push({ ok })
    if (p.window.length > PING_WINDOW) p.window.shift()
  }

  function sendPings() {
    for (const [peerId, peerObj] of peers.entries()) {
      if (
        !peerObj.pairing ||
        !peerObj.pairing.complete ||
        !peerObj.device ||
        !peerObj.device.isOnline ||
        !peerObj.signaling
      ) {
        continue
      }
      ensurePingState(peerObj)
      // Never stack more than one outstanding ping per peer at a time.
      if (peerObj.pings.outstanding.size > 0) continue
      const id = ++peerObj.pings.nextId
      const sentAt = Date.now()
      const timer = setTimeout(() => {
        peerObj.pings.outstanding.delete(id)
        pushPingResult(peerObj, false, null)
      }, PING_TIMEOUT)
      if (timer.unref) timer.unref()
      peerObj.pings.outstanding.set(id, { sentAt, timer })
      try {
        peerObj.signaling.send({ type: 'PING', id, sentAt })
      } catch (err) {
        const entry = peerObj.pings.outstanding.get(id)
        if (entry) {
          clearTimeout(entry.timer)
          peerObj.pings.outstanding.delete(id)
        }
      }
    }
  }

  function handlePing(peerId, msg) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.signaling) return
    if (!msg || typeof msg.id !== 'number' || typeof msg.sentAt !== 'number') return
    try {
      peerObj.signaling.send({ type: 'PONG', id: msg.id, sentAt: msg.sentAt })
    } catch {}
  }

  function handlePong(peerId, msg) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.pings) return
    if (!msg || typeof msg.id !== 'number' || typeof msg.sentAt !== 'number') return
    const entry = peerObj.pings.outstanding.get(msg.id)
    if (!entry) return
    peerObj.pings.outstanding.delete(msg.id)
    clearTimeout(entry.timer)
    pushPingResult(peerObj, true, Date.now() - msg.sentAt)
  }

  // Rolling-average RTT across authenticated peers; null until measured.
  function getPeerLatency() {
    let total = 0
    let count = 0
    for (const p of peers.values()) {
      if (!p.pairing || !p.pairing.complete || !p.device || !p.device.isOnline) continue
      const samples = p.pings && p.pings.rttSamples
      if (!samples || samples.length === 0) continue
      total += samples.reduce((a, b) => a + b, 0) / samples.length
      count++
    }
    return count > 0 ? Math.round(total / count) : null
  }

  // Packet-loss proxy from ping outcomes; null until enough samples exist.
  function getPacketLoss() {
    let failed = 0
    let total = 0
    for (const p of peers.values()) {
      if (!p.pairing || !p.pairing.complete || !p.device || !p.device.isOnline) continue
      const window = p.pings && p.pings.window
      if (!window) continue
      for (const r of window) {
        total++
        if (!r.ok) failed++
      }
    }
    return total >= 5 ? Math.round((failed / total) * 100) : null
  }

  function handlePeerMessage(peerId, msg) {
    console.log(`[Worker] handlePeerMessage from ${peerId}:`, msg.type)
    if (msg.type === 'HANDSHAKE') {
      const peerObj = peers.get(peerId)
      if (!peerObj || !peerObj.pairing) {
        console.warn(`[Worker] Ignoring HANDSHAKE from unknown peer ${peerId}`)
        return
      }
      if (!peerObj.pairing.trusted) {
        // The peer may have verified OUR pairing response before we verified
        // theirs, so its HANDSHAKE can arrive while our challenge is still
        // outstanding. Buffer it instead of dropping it: the handshake is
        // applied the moment our verification grants trust
        // (flushPendingHandshake), so a successful code pairing always
        // completes on BOTH sides instead of leaving one side stuck on
        // "Connecting...".
        peerObj.pairing.pendingHandshake = msg
        console.log(
          `[Worker] Buffering HANDSHAKE from ${peerId.slice(0, 12)}... until pairing verifies`
        )
        return
      }
      applyHandshake(peerId, msg)
    } else if (msg.type === 'PAIRING_CHALLENGE') {
      handlePairingChallenge(peerId, msg)
    } else if (msg.type === 'PAIRING_RESP') {
      handlePairingResponse(peerId, msg)
    } else if (msg.type === 'TRANSFER_OFFER') {
      const peerObj = peers.get(peerId)
      // Only accept file offers from authenticated (trusted) peers. One-time
      // shares go through the CLAIM_FILE_REQ flow instead, which requires
      // knowledge of the drop code.
      if (!peerObj || !peerObj.pairing || !peerObj.pairing.trusted) {
        console.warn(`[Worker] Ignoring TRANSFER_OFFER from unauthenticated peer ${peerId}`)
        return
      }
      const transferMethod =
        msg.transferMethod ||
        peerObj?.transferMethod ||
        getTransferMethod(msg.senderIdentity?.ipAddress || peerObj?.device?.ipAddress || '')
      if (ctx.transferEngine) {
        ctx.transferEngine
          .receiveOffer({ ...msg, transferMethod, senderPeerId: peerId }, { autoAccept: false })
          .catch((err) => {
            console.error('[Worker] receiveOffer failed:', err)
          })
      }
    } else if (msg.type === 'CLAIM_FILE_REQ') {
      handleClaimFileReq(peerId, msg).catch((err) => {
        console.error('[Worker] handleClaimFileReq failed:', err)
      })
    } else if (msg.type === 'CLAIM_FILE_RES') {
      handleClaimFileRes(peerId, msg).catch((err) => {
        console.error('[Worker] handleClaimFileRes failed:', err)
      })
    } else if (msg.type === 'CLAIM_FILE_DONE') {
      handleClaimDone(peerId, msg).catch((err) => {
        console.error('[Worker] handleClaimDone failed:', err)
      })
    } else if (msg.type === 'DRIVE_FILE_SYNC') {
      handleDriveFileSync(peerId, msg).catch((err) => {
        console.error('[Worker] handleDriveFileSync failed:', err)
      })
    } else if (msg.type === 'DRIVE_SHARE_INVITE') {
      handleDriveShareInvite(peerId, msg).catch((err) => {
        console.error('[Worker] handleDriveShareInvite failed:', err)
      })
    } else if (msg.type === 'DRIVE_SHARE_ACCEPT') {
      handleDriveShareAccept(peerId, msg).catch((err) => {
        console.error('[Worker] handleDriveShareAccept failed:', err)
      })
    } else if (msg.type === 'DRIVE_SHARE_DECLINE') {
      console.log(`[Worker] Peer ${peerId} declined drive share invitation`)
    } else if (msg.type === 'CLIPBOARD_SYNC') {
      const peerObj = peers.get(peerId)
      const senderName = msg.senderName || peerObj?.device?.name || 'Paired Device'
      console.log(`[Worker] Received CLIPBOARD_SYNC from ${senderName}`)
      ctx.send(
        createEvent(EVENTS.CLIPBOARD_RECEIVED, {
          content: msg.content,
          contentType: msg.contentType || 'text',
          senderPeerId: peerId,
          senderName,
          timestamp: msg.timestamp || Date.now()
        })
      )
    } else if (msg.type === 'PING') {
      handlePing(peerId, msg)
    } else if (msg.type === 'PONG') {
      handlePong(peerId, msg)
    }
  }

  // Apply a verified peer's identity handshake: fill in device metadata, mark
  // the pairing complete, persist the device, and broadcast paired/online
  // events. Only ever called once the peer's pairing is trusted (directly on
  // receipt, or deferred from the buffer once our challenge verifies).
  function applyHandshake(peerId, msg) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.pairing || !peerObj.pairing.trusted) return
    if (!msg.identity) return

    // Do not list self as a remote peer
    if (
      ctx.deviceIdentity &&
      (msg.identity.id === ctx.deviceIdentity.id ||
        msg.identity.publicKey === ctx.deviceIdentity.publicKey)
    ) {
      console.log(`[Worker] Ignoring self-handshake from ${msg.identity.name}`)
      return
    }

    // Device identity comes from the peer's stable identity (persisted across
    // restarts), NOT the ephemeral noise key: the noise keypair is regenerated
    // on every boot, so a noise-derived id would create a new database record
    // per restart. `publicKey` stays the current noise key (joinPeer + trust),
    // `identityKey` the stable identity core key (topic discovery).
    const deviceId =
      msg.identity.id || deriveDeviceId(msg.identity.publicKey) || deriveDeviceId(peerId)
    peerObj.device.id = deviceId
    peerObj.device.publicKey = peerId // noise public key: used for joinPeer + trust
    peerObj.device.identityKey = msg.identity.publicKey || '' // identity core key: used for topic discovery
    peerObj.device.name = msg.identity.name || peerObj.device.name
    peerObj.device.os = msg.identity.os || peerObj.device.os
    peerObj.device.isTrusted = true
    peerObj.device.isOnline = true
    peerObj.device.trustedAt = peerObj.device.trustedAt || new Date().toISOString()
    peerObj.device.lastSeen = new Date().toISOString()
    peerObj.pairing.complete = true
    // Belt-and-suspenders: TrustManager clears its watchdog on challenge
    // verification; also drop any stale timer now that the handshake has
    // completed so the connection can never be killed by a leftover one.
    if (peerObj.pairing.timeout) {
      clearTimeout(peerObj.pairing.timeout)
      peerObj.pairing.timeout = null
    }
    peers.set(peerId, peerObj)

    // Send reciprocal handshake if not sent yet. sendHandshake sets the
    // handshakeSent flag itself; setting it here first made the call a no-op
    // and left the peer that verified FIRST without our identity — it could
    // never persist our device and lost the record on the next restart.
    if (!peerObj.handshakeSent && peerObj.signaling) {
      sendHandshake(peerId)
    }

    // Persist / update online device in Hyperbee, keyed by the peer's stable
    // identity id so restarts update the same record instead of duplicating it.
    // `relayed` is a live connection property, not a device attribute, so it
    // is stripped before persisting (devices.list merges live peers in).
    ctx.getBee('devices').then((bee) => {
      const { relayed: _relayed, ...deviceToPersist } = peerObj.device
      bee.put(deviceId, deviceToPersist).catch((err) => {
        console.error('[Worker] Failed to save device to bee:', err)
      })
    })
    ctx.trustManager.addTrustedKey(peerId)

    ctx.send(createEvent(EVENTS.DEVICE_PAIRED, peerObj.device))
    ctx.send(createEvent(EVENTS.PEER_CONNECTED, peerObj.device))
    ctx.send(createEvent(EVENTS.DEVICE_DISCOVERED, peerObj.device))
    ctx.send(createEvent(EVENTS.DEVICE_ONLINE, peerObj.device))
    // The renderer refreshes its Devices list on DEVICE_UPDATED and its
    // diagnostics on CONNECTION_CHANGED; neither fires on the LAN auto-trust
    // bypass (or on code-pairing completion) today. Push both now that the peer
    // is live so the Devices tab immediately reflects an Online device.
    ctx.send(createEvent(EVENTS.DEVICE_UPDATED, peerObj.device))
    emitConnectionChanged()
  }

  // Process a HANDSHAKE that arrived before our side of the challenge-response
  // verified. Runs from onTrustGranted, i.e. strictly after pairing.trusted
  // became true, so the buffered handshake is never applied to an untrusted
  // peer.
  function flushPendingHandshake(peerId) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.pairing || !peerObj.pairing.trusted) return
    if (!peerObj.pairing.pendingHandshake) return
    const msg = peerObj.pairing.pendingHandshake
    peerObj.pairing.pendingHandshake = null
    applyHandshake(peerId, msg)
  }

  // Re-broadcast completion events for a peer whose handshake already finished
  // earlier (e.g. the code's host was auto-trusted before the user entered the
  // code). TrustManager re-confirms such peers when they prove knowledge of a
  // freshly registered code; this gives the pairing modal a fresh success
  // signal without re-running the handshake.
  function rebroadcastPeerCompletion(peerId) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.pairing || !peerObj.pairing.complete) return
    if (!peerObj.device || !peerObj.device.name || peerObj.device.name === 'Connecting...') return
    ctx.send(createEvent(EVENTS.DEVICE_PAIRED, peerObj.device))
    ctx.send(createEvent(EVENTS.PEER_CONNECTED, peerObj.device))
    ctx.send(createEvent(EVENTS.DEVICE_ONLINE, peerObj.device))
    ctx.send(createEvent(EVENTS.DEVICE_UPDATED, peerObj.device))
    emitConnectionChanged()
  }

  // A LAN announcement can land AFTER the connection formed (discovery is
  // asynchronous and the connection may have come via the DHT identity topic).
  // onConnection can therefore not be the only place autoTrustLAN is honored:
  // promote a still-pairing peer to direct trust the moment it is discovered
  // on the local network, bypassing the challenge-response handshake entirely.
  async function maybeAutoTrustLanPeer(peerId) {
    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.pairing || peerObj.pairing.trusted) return
    if (peerObj.pairing.mode !== 'pairing') return
    if (!(await ctx.getAutoTrustLAN())) return
    peerObj.pairing.mode = 'direct'
    peerObj.pairing.trusted = true
    peerObj.device.isTrusted = true
    peerObj.device.trustedAt = peerObj.device.trustedAt || new Date().toISOString()
    // Drop any watchdog the challenge phase armed; a direct peer needs none.
    if (peerObj.pairing.timeout) {
      clearTimeout(peerObj.pairing.timeout)
      peerObj.pairing.timeout = null
    }
    peers.set(peerId, peerObj)
    console.log(
      `[Worker] Auto-trusting LAN peer ${peerId.slice(0, 12)}... (late LAN discovery, autoTrustLAN enabled)`
    )
    sendHandshake(peerId)
    replicateExchange(peerId)
    // The peer may already have sent its HANDSHAKE while we were still pairing.
    flushPendingHandshake(peerId)
  }

  async function handleDriveShareInvite(peerId, msg) {
    const peerObj = peers.get(peerId)
    const senderIdentity = msg.senderIdentity ||
      peerObj?.device || { id: peerId, name: 'Remote Peer' }
    console.log(`[Worker] Drive share invitation received from ${senderIdentity.name}`)
    ctx.send(
      createEvent(EVENTS.DRIVE_INVITE_RECEIVED, {
        inviteId: `invite-${Date.now().toString(36)}`,
        peerId,
        senderIdentity
      })
    )
  }

  async function handleDriveShareAccept(peerId, msg) {
    const peerObj = peers.get(peerId)
    const peerName = msg.senderIdentity?.name || peerObj?.device?.name || 'Remote Peer'
    console.log(
      `[Worker] Drive share accepted by ${peerName}! Triggering auto-mount and full two-way sync...`
    )
    ctx.send(createEvent(EVENTS.DRIVE_AUTO_MOUNT, { peerId, peerName }))
  }

  async function handleDriveFileSync(peerId, msg) {
    if (!msg.file || !msg.file.filename) return
    const peerObj = peers.get(peerId)
    const peerName = msg.senderIdentity?.name || peerObj?.device?.name || 'Remote Peer'

    const sharedBee = await ctx.getBee('shared')
    const syncDir = path.join(os.homedir(), 'P2PDrive')
    try {
      await fsp.mkdir(syncDir, { recursive: true })
    } catch {}

    const destPath = path.join(syncDir, msg.file.filename)

    const sharedItem = {
      id: msg.file.id || `drive-${Date.now().toString(36)}`,
      name: msg.file.filename,
      filename: msg.file.filename,
      size: msg.file.fileSize || 0,
      fileSize: msg.file.fileSize || 0,
      type: msg.file.fileType || 'application/octet-stream',
      modifiedAt: new Date().toISOString(),
      path: destPath,
      filePath: destPath,
      peerId,
      peerName
    }

    await sharedBee.put(sharedItem.id, sharedItem)
    ctx.send(createEvent(EVENTS.SHARED_ADD_COMPLETED, sharedItem))
    console.log(`[Worker] Received DRIVE_FILE_SYNC from ${peerName}: ${msg.file.filename}`)
  }

  async function handleClaimFileReq(peerId, msg) {
    const code = (msg.code || '').trim().toUpperCase()
    console.log(`[Worker] Received CLAIM_FILE_REQ for code ${code} from ${peerId}`)

    const bee = await ctx.getBee('pendingShares')
    let foundShare = null
    const now = Date.now()

    for await (const node of bee.createReadStream()) {
      const s = node.value
      if (s && s.code === code && s.isHost === true && s.status === 'waiting') {
        if (s.expiresAt === 0 || now < s.expiresAt) {
          foundShare = s
          break
        }
      }
    }

    const peerObj = peers.get(peerId)
    if (!peerObj || !peerObj.signaling) return

    if (!foundShare) {
      console.log(`[Worker] CLAIM_FILE_REQ for ${code} not found or expired`)
      peerObj.signaling.send({
        type: 'CLAIM_FILE_RES',
        code,
        success: false,
        error: 'Share expired or invalid code'
      })
      return
    }

    // Single-use: the first accepted claimer burns the key immediately so a
    // second claimer can never pull the same file concurrently.
    foundShare.downloadCount = (foundShare.downloadCount || 0) + 1
    foundShare.status = 'claimed'
    await bee.put(foundShare.id, foundShare)
    ctx.send(createEvent(EVENTS.PENDING_SHARE_UPDATED, foundShare))
    ctx.send(
      createEvent(EVENTS.PENDING_SHARE_CLAIMED, {
        id: foundShare.id,
        code: foundShare.code,
        filename: foundShare.filename,
        downloadCount: foundShare.downloadCount
      })
    )

    // A claim connection never verifies a pairing challenge: drop the
    // watchdog so long downloads are not killed mid-transfer.
    if (peerObj.pairing && peerObj.pairing.timeout) {
      clearTimeout(peerObj.pairing.timeout)
      peerObj.pairing.timeout = null
    }

    console.log(
      `[Worker] Sending CLAIM_FILE_RES offer for ${foundShare.filename} to ${peerId} (downloadCount: ${foundShare.downloadCount})`
    )
    // Serve the drop core to this claimer: open exchange replication for them.
    replicateExchange(peerId)
    peerObj.signaling.send({
      type: 'CLAIM_FILE_RES',
      code,
      success: true,
      offer: {
        transferId: `claim-${foundShare.id}-${Date.now().toString(36)}`,
        filename: foundShare.filename,
        fileSize: foundShare.fileSize,
        fileType: foundShare.fileType,
        coreKey: foundShare.coreKey,
        manifestHash: foundShare.manifestHash || '',
        checksum: foundShare.checksum || '',
        senderIdentity: ctx.deviceIdentity,
        transferMethod: 'internet',
        shareId: foundShare.id
      }
    })
  }

  async function handleClaimFileRes(peerId, msg) {
    const code = (msg.code || '').trim().toUpperCase()
    console.log(`[Worker] Received CLAIM_FILE_RES for ${code}: success=${msg.success}`)

    if (msg.success && msg.offer) {
      activeClaims.delete(code)
      try {
        ctx.topicRegistry.leave(`p2p-file-${code}`)
      } catch {}

      // A claim connection never verifies a pairing challenge: drop the
      // watchdog so long downloads are not killed mid-transfer.
      const peerObj = peers.get(peerId)
      if (peerObj && peerObj.pairing && peerObj.pairing.timeout) {
        clearTimeout(peerObj.pairing.timeout)
        peerObj.pairing.timeout = null
      }

      // Auto-accept and start downloading under Active Direct Transfers
      console.log(
        `[Worker] Auto-accepting claimed transfer ${msg.offer.filename} (${msg.offer.fileSize} bytes)`
      )
      // The claimer must also open exchange replication with the host to pull blocks.
      replicateExchange(peerId)
      if (ctx.transferEngine) {
        await ctx.transferEngine.receiveOffer(
          { ...msg.offer, transferMethod: 'internet', isClaim: true, peerKey: peerId },
          { autoAccept: true, isClaim: true }
        )
      }
    } else {
      // The host rejected the claim (expired / already used): stop advertising
      // the code so it is not re-sent on every future connection, and tell the
      // UI the key was invalid.
      activeClaims.delete(code)
      try {
        ctx.topicRegistry.leave(`p2p-file-${code}`)
      } catch {}
      ctx.send(
        createEvent(EVENTS.PENDING_SHARE_CLAIM_FAILED, {
          code,
          error: msg.error || 'Share expired or invalid code'
        })
      )
    }
  }

  // The claimer finished (or abandoned) a one-time download: tear the drop
  // down — leave the topic, unlink the staged file, close the drop core —
  // and mark the key permanently invalid.
  async function handleClaimDone(peerId, msg) {
    if (!msg || !msg.shareId) return
    const bee = await ctx.getBee('pendingShares')
    const entry = await bee.get(msg.shareId)
    if (!entry || !entry.value || entry.value.isHost !== true) return
    console.log(`[Worker] Claimed share ${entry.value.code} download finished; cleaning up`)
    await ctx.cleanupPendingShare(msg.shareId, 'completed')
  }

  async function onConnection(connection, peerInfo) {
    ctx.connectionCount++
    const peerId = peerInfo?.publicKey?.toString('hex') || `peer-${ctx.connectionCount}`
    emitConnectionChanged()

    // Register cleanup handlers first so a connection that closes while the
    // (async) settings read below is in flight can never leak from the map.
    connection.on('close', () => {
      ctx.connectionCount--
      const peerObj = peers.get(peerId)
      const devId = peerObj?.device?.id || peerId
      peers.delete(peerId)
      ctx.replicationScope.close(peerId)
      emitConnectionChanged()
      ctx.send(createEvent(EVENTS.PEER_DISCONNECTED, { id: devId }))
      ctx.send(createEvent(EVENTS.DEVICE_OFFLINE, { id: devId }))
    })
    connection.on('error', () => {})

    const remoteIp =
      peerInfo?.host ||
      connection.remoteAddress ||
      connection.rawStream?.remoteAddress ||
      connection._socket?.remoteAddress ||
      ''
    const transferMethod = getTransferMethod(remoteIp)
    const relayed = isRelayedConnection(peerInfo, connection, ctx.swarm && ctx.swarm.dht)

    // Trust is earned: a previously verified trusted key always wins. Otherwise
    // honor the autoTrustLAN preference: peers discovered on the local network
    // (explicit LAN-discovery signal, or a private-range remote address) are
    // trusted immediately without any challenge-response handshake.
    const lanDiscovered =
      ctx.lanDiscovery && typeof ctx.lanDiscovery.has === 'function' && ctx.lanDiscovery.has(peerId)
    let directTrusted = ctx.trustManager.isTrustedPublicKey(peerId)
    if (
      !directTrusted &&
      (await ctx.getAutoTrustLAN()) &&
      (transferMethod === 'lan' || lanDiscovered)
    ) {
      directTrusted = true
      console.log(
        `[Worker] Auto-trusting LAN peer ${peerId.slice(0, 12)}... (autoTrustLAN enabled)`
      )
    }

    const signaling = setupPeerSignaling(connection, peerId, { directTrusted })
    // NOTE: the private metadata store is NEVER replicated here. The exchange
    // store (file cores only) is replicated once the peer is authenticated.

    const peer = {
      id: peerId,
      publicKey: peerId,
      name: `Connecting...`,
      os: 'Unknown',
      osVersion: '',
      avatar: '',
      isTrusted: directTrusted,
      isEncrypted: true,
      isOnline: true,
      lastSeen: new Date().toISOString(),
      ipAddress: remoteIp,
      transferMethod,
      relayed
    }

    // Trust is earned: only a known trusted noise public key (direct), a
    // successful pairing challenge (pairing), or the autoTrustLAN preference
    // for LAN peers ever sets isTrusted = true.
    // `timeout` is owned by TrustManager's watchdog: it is armed only when a
    // PAIRING_CHALLENGE is sent/received and cleared on verification — it
    // must NOT start at connection open, otherwise a slow code typist loses
    // the race to the timer.
    const pairing = {
      mode: directTrusted ? 'direct' : 'pairing',
      trusted: directTrusted,
      complete: false,
      outstanding: [], // { nonce, code, codeId }
      pendingChallenges: [], // { codeId, nonce } received but not yet answerable
      pendingHandshake: null, // HANDSHAKE received before our challenge verified
      timeout: null
    }

    peers.set(peerId, { connection, device: peer, signaling, transferMethod, pairing })

    if (directTrusted) {
      replicateExchange(peerId)
    }
  }

  function announceLanSelf() {
    if (!ctx.lanDiscovery) return
    const announcement = ctx.lanDiscovery.getSelfAnnouncement()
    if (announcement && announcement.key) {
      ctx.send(createEvent(EVENTS.LAN_DISCOVERY_KEY, announcement))
    }
  }

  async function initSwarm() {
    swarm.on('connection', onConnection)

    try {
      await swarm.dht.ready()
    } catch (err) {
      console.error('DHT ready failed:', err.message)
    }

    if (!ctx.deviceIdentity) await ctx.initIdentity()
    if (ctx.deviceIdentity && ctx.deviceIdentity.publicKey) {
      console.log(
        `[Worker] Listening on self identity DHT topic for VPN/relay discovery: ${ctx.deviceIdentity.publicKey.slice(0, 12)}...`
      )
      ctx.topicRegistry.ensure(`p2p-peer-${ctx.deviceIdentity.publicKey}`, {
        client: true,
        server: true
      })

      await swarm.listen()
      // LAN discovery: tell Electron main which swarm (noise) key to advertise.
      if (ctx.lanDiscovery) {
        ctx.lanDiscovery.start()
        announceLanSelf()
      }
      swarm.flush().catch(() => {})
    }

    // Automatically reconnect to all stored paired peers on startup and interval
    await reconnectKnownPeers()
    setInterval(reconnectKnownPeers, 15000).unref()
    // PING/PONG latency probe
    setInterval(sendPings, PING_INTERVAL_MS).unref()
  }

  async function reconnectKnownPeers() {
    try {
      const bee = await ctx.getBee('devices')
      for await (const node of bee.createReadStream()) {
        const dev = node.value
        // Only reconnect peers whose trust was established under the new scheme
        // (trustedAt is set exclusively by the challenge/verified-handshake path).
        if (
          dev &&
          dev.isTrusted === true &&
          dev.trustedAt &&
          dev.publicKey &&
          dev.publicKey.length === 64
        ) {
          try {
            const peerKey = Buffer.from(dev.publicKey, 'hex')
            // The identity core key (identityKey) is what the peer listens on in
            // initSwarm; the noise public key is what joinPeer needs to connect.
            const peerTopicLabel = `p2p-peer-${dev.identityKey || dev.publicKey}`
            // Join the peer DHT topic AND attempt direct connection to the peer key
            ctx.topicRegistry.ensure(peerTopicLabel, { client: true, server: true })
            swarm.joinPeer(peerKey)
            swarm.flush().catch(() => {})
          } catch (err) {
            console.error(`[Worker] Failed to reconnect to peer ${dev.id}:`, err.message)
          }
        }
      }
    } catch (err) {
      console.error('[Worker] reconnectKnownPeers failed:', err.message)
    }
  }

  return {
    setupPeerSignaling,
    sendHandshake,
    replicateExchange,
    sendPairingChallenges,
    handlePeerMessage,
    onConnection,
    initSwarm,
    reconnectKnownPeers,
    authenticatedPeerCount,
    getConnectionStatus,
    getPeerLatency,
    getPacketLoss,
    emitConnectionChanged,
    announceLanSelf,
    flushPendingHandshake,
    rebroadcastPeerCompletion,
    maybeAutoTrustLanPeer
  }
}

module.exports = { createConnections }
