'use strict'

// TrustManager owns the pairing-code lifecycle and the challenge-response
// handshake. Trust is granted ONLY after a peer proves knowledge of the code
// (keyed BLAKE2b MAC over our random nonce). Nothing here fabricates trust.

const {
  randomBytes,
  generatePairingCode,
  normalizePairingCode,
  mac,
  codeId
} = require('../shared/crypto.js')

const PAIRING_TTL = 15 * 60 * 1000 // pairing code lifetime (15 minutes)
// Watchdog for the challenge-response phase. It is armed ONLY when a
// PAIRING_CHALLENGE is actually sent or received (_armPairingTimeout), never
// on raw connection open — so a user typing a pairing code is not racing a
// timer that started when the connection formed. It is cleared on successful
// verification (handleResponse) so a verified connection is never killed by
// a leftover timer while the HANDSHAKE is still in flight.
const PAIRING_TIMEOUT = 30 * 1000 // max time between challenge activity and verification

class TrustManager {
  constructor({
    getBee,
    computeTopicHash,
    swarm,
    topicRegistry,
    getPeers,
    sendHandshake,
    onTrustGranted
  }) {
    this.getBee = getBee
    this.computeTopicHash = computeTopicHash
    this.swarm = swarm
    this.topicRegistry = topicRegistry
    this.getPeers = getPeers // () => Map<peerId, peerObj>
    this.sendHandshake = sendHandshake // (peerId) => void
    this.onTrustGranted = onTrustGranted || (() => {}) // (peerId, code) => void
    this.pairingSecrets = new Map() // codeId -> { code, role, createdAt, expiresAt, codeId }
    this.trustedPeerKeys = new Set() // hex noise public keys currently trusted
    this.pairingCodePromise = null // single-flight guard for concurrent code fetches
  }

  async loadTrustedPeerKeys() {
    try {
      const bee = await this.getBee('devices')
      for await (const node of bee.createReadStream()) {
        const dev = node.value
        if (
          dev &&
          dev.isTrusted === true &&
          dev.trustedAt &&
          dev.publicKey &&
          dev.publicKey.length === 64
        ) {
          this.trustedPeerKeys.add(dev.publicKey)
        }
      }
      console.log(`[Worker] Loaded ${this.trustedPeerKeys.size} trusted peer key(s)`)
      if (this.trustedPeerKeys.size > 0) {
        console.log(
          `[Worker] Trusted keys: ${Array.from(this.trustedPeerKeys)
            .map((k) => k.slice(0, 12))
            .join(', ')}`
        )
      }
    } catch (err) {
      console.warn('[Worker] loadTrustedPeerKeys failed:', err.message)
    }
  }

  isTrustedPublicKey(pubKeyHex) {
    return (
      typeof pubKeyHex === 'string' &&
      pubKeyHex.length === 64 &&
      this.trustedPeerKeys.has(pubKeyHex)
    )
  }

  addTrustedKey(pubKeyHex) {
    if (typeof pubKeyHex === 'string') this.trustedPeerKeys.add(pubKeyHex)
  }

  removeTrustedKey(pubKeyHex) {
    this.trustedPeerKeys.delete(pubKeyHex)
  }

  // Reuse an unexpired in-memory host code (e.g. the QR modal reopened)
  getActiveHostCode() {
    const now = Date.now()
    for (const [, secret] of this.pairingSecrets.entries()) {
      if (secret.role === 'host' && secret.expiresAt > 0 && now < secret.expiresAt) {
        return secret.code
      }
    }
    return null
  }

  async getOrCreatePairingCode() {
    const active = this.getActiveHostCode()
    if (active) return active
    // Single-flight: concurrent callers (the boot-time DEVICES_GET_IDENTITY
    // fetches from both React mounts plus DEVICES_GET_CODE from the pairing
    // modal) must all see the SAME code. Without this each call generated its
    // own code, so the dashboard and the modal could show different codes and
    // every extra secret was orphaned.
    if (this.pairingCodePromise) return this.pairingCodePromise
    this.pairingCodePromise = this._generatePairingCode().finally(() => {
      this.pairingCodePromise = null
    })
    return this.pairingCodePromise
  }

  async _generatePairingCode() {
    const now = Date.now()

    // Reuse a persisted unexpired host code across restarts. The code lives in
    // its OWN bee ('pairingCodes'): the legacy identity bee holds a corrupt
    // 'pairing' block that fails every read AND write with DECODING_ERROR, so
    // the code was never persisted and every boot minted a fresh one.
    try {
      const bee = await this.getBee('pairingCodes')
      const entry = await bee.get('active')
      if (
        entry &&
        entry.value &&
        entry.value.code &&
        entry.value.expiresAt > 0 &&
        now < entry.value.expiresAt
      ) {
        const p = entry.value
        this.pairingSecrets.set(p.codeId, {
          code: p.code,
          role: 'host',
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
          codeId: p.codeId
        })
        this._joinPairingTopic(p.code)
        console.log(`[Worker] Restored pairing code: ${p.code}`)
        return p.code
      }
    } catch (err) {
      console.warn(
        '[Worker] Persisted pairing code unavailable; generating a fresh code:',
        err.message
      )
    }

    // Generate a fresh random 80-bit code
    const code = generatePairingCode()
    const secret = {
      code,
      role: 'host',
      createdAt: now,
      expiresAt: now + PAIRING_TTL,
      codeId: codeId(code)
    }
    this.pairingSecrets.set(secret.codeId, secret)
    try {
      const bee = await this.getBee('pairingCodes')
      await bee.put('active', {
        code,
        codeId: secret.codeId,
        createdAt: secret.createdAt,
        expiresAt: secret.expiresAt
      })
    } catch (err) {
      console.warn('[Worker] Failed to persist pairing code:', err.message)
    }
    try {
      this._joinPairingTopic(code)
      this.syncToPeers()
    } catch (err) {
      // Never let topic join/sync break code delivery: the UI must always
      // receive a code (an empty pairingCode blanks the dashboard).
      console.warn('[Worker] Pairing topic join failed:', err.message)
    }
    console.log(`[Worker] New pairing code generated: ${code} (expires in ${PAIRING_TTL / 60000}m)`)
    return code
  }

  // Register a code the user is pairing with (joiner side) and join its topic.
  // Returns the canonical code, or null if the format is invalid.
  registerJoinerCode(rawCode) {
    const cleanCode = normalizePairingCode(rawCode)
    if (!cleanCode) return null
    const now = Date.now()
    this.pairingSecrets.set(codeId(cleanCode), {
      code: cleanCode,
      role: 'joiner',
      createdAt: now,
      expiresAt: now + PAIRING_TTL,
      codeId: codeId(cleanCode)
    })
    // Snapshot peers that were already trusted BEFORE this registration:
    // syncToPeers may complete a fresh pairing for an untrusted peer (which
    // emits its own events), so only pre-existing trusted peers need probing.
    const trustedIds = new Set()
    for (const [pId, peerObj] of this.getPeers().entries()) {
      if (peerObj.pairing && peerObj.pairing.trusted) trustedIds.add(pId)
    }
    this._joinPairingTopic(cleanCode)
    this.syncToPeers()
    // Untrusted peers were just challenged by syncToPeers. Trusted peers are
    // skipped there, but the code's host may already be connected and trusted
    // (LAN auto-trust, or a pairing completed before the code was entered) —
    // probe them so the host can identify itself without a fresh handshake.
    this._probeTrustedPeers(cleanCode, codeId(cleanCode), trustedIds)
    return cleanCode
  }

  // Ask already-connected trusted peers whether they hold the freshly
  // registered code. Only the real host can answer (keyed MAC over the nonce),
  // which lets the UI complete the pairing instantly instead of waiting for a
  // handshake that will never come on an already-established connection.
  _probeTrustedPeers(code, codeId, trustedIds) {
    for (const pId of trustedIds) {
      const peerObj = this.getPeers().get(pId)
      if (!peerObj || !peerObj.signaling || !peerObj.pairing || !peerObj.pairing.trusted) continue
      if (peerObj.pairing.outstanding.some((o) => o.codeId === codeId)) continue
      const nonce = randomBytes(16)
      peerObj.pairing.outstanding.push({ nonce, code, codeId })
      try {
        peerObj.signaling.send({
          type: 'PAIRING_CHALLENGE',
          codeId,
          nonce: nonce.toString('hex')
        })
      } catch (err) {
        console.error('[Worker] Failed to probe trusted peer:', err.message)
      }
    }
  }

  _joinPairingTopic(code) {
    const label = `p2p-pair-${code}`
    if (this.topicRegistry) this.topicRegistry.ensure(label, { client: true, server: true })
    else {
      const topicHash = this.computeTopicHash(label)
      this.swarm.join(topicHash, { client: true, server: true })
      this.swarm.flush().catch(() => {})
    }
  }

  // Arm (or re-arm) the pairing watchdog for a peer. The timer is tied to
  // challenge activity, not connection open, and only runs while the peer is
  // still in an unverified pairing state. On fire it destroys the connection
  // so an abandoned pairing never lingers forever.
  _armPairingTimeout(peerId) {
    const peerObj = this.getPeers().get(peerId)
    if (!peerObj || !peerObj.pairing) return
    if (peerObj.pairing.trusted || peerObj.pairing.complete) return
    if (peerObj.pairing.timeout) clearTimeout(peerObj.pairing.timeout)
    peerObj.pairing.timeout = setTimeout(() => {
      peerObj.pairing.timeout = null
      const p = this.getPeers().get(peerId)
      if (!p || !p.pairing) return
      if (p.pairing.trusted || p.pairing.complete) return
      console.warn(
        `[Worker] Pairing timed out for ${peerId.slice(0, 12)}... (challenge never verified)`
      )
      try {
        p.connection.destroy()
      } catch {}
    }, PAIRING_TIMEOUT)
    if (peerObj.pairing.timeout.unref) peerObj.pairing.timeout.unref()
  }

  // Clear the watchdog for a peer (called on successful verification and on
  // failure paths where the connection is being torn down anyway).
  _clearPairingTimeout(peerId) {
    const peerObj = this.getPeers().get(peerId)
    if (!peerObj || !peerObj.pairing) return
    if (peerObj.pairing.timeout) {
      clearTimeout(peerObj.pairing.timeout)
      peerObj.pairing.timeout = null
    }
  }

  // Send a pairing challenge for every active pairing secret, one outstanding
  // challenge per (peer, secret) so MACs tie to a single nonce.
  sendChallenges(peerId) {
    const peerObj = this.getPeers().get(peerId)
    if (!peerObj || !peerObj.signaling || !peerObj.pairing) return
    if (peerObj.pairing.mode !== 'pairing' || peerObj.pairing.trusted) return
    const sentCodeIds = new Set(peerObj.pairing.outstanding.map((o) => o.codeId))
    let sentAny = false
    for (const [, secret] of this.pairingSecrets.entries()) {
      if (sentCodeIds.has(secret.codeId)) continue
      if (secret.expiresAt > 0 && Date.now() >= secret.expiresAt) continue
      const nonce = randomBytes(16)
      peerObj.pairing.outstanding.push({ nonce, code: secret.code, codeId: secret.codeId })
      try {
        peerObj.signaling.send({
          type: 'PAIRING_CHALLENGE',
          codeId: secret.codeId,
          nonce: nonce.toString('hex')
        })
        sentAny = true
      } catch (err) {
        console.error('[Worker] Failed to send PAIRING_CHALLENGE:', err.message)
      }
    }
    // A challenge went out: start the watchdog from actual pairing activity.
    if (sentAny) this._armPairingTimeout(peerId)
  }

  // Respond to a peer's challenge using the secret matching its codeId.
  // Trust is NEVER granted here; we only prove knowledge of the code. We answer
  // even if the peer is already trusted, otherwise a peer whose challenge
  // arrives after we verified its response could never verify ours (deadlock).
  handleChallenge(peerId, msg) {
    const peerObj = this.getPeers().get(peerId)
    if (!peerObj || !peerObj.pairing) {
      return
    }
    if (typeof msg.codeId !== 'string' || typeof msg.nonce !== 'string') return

    // Receiving a challenge means pairing activity is underway: start (or
    // reset) the watchdog now, not at connection open. No-op for trusted peers
    // (the watchdog guard below) and harmless for direct-mode ones.
    this._armPairingTimeout(peerId)

    const secret = this.pairingSecrets.get(msg.codeId)
    if (!secret || (secret.expiresAt > 0 && Date.now() >= secret.expiresAt)) {
      // We don't know this code (yet). Remember it so we can answer once a
      // matching secret is registered (e.g. code entered after connection).
      // This applies to TRUSTED peers too: if the challenger's stored trust
      // for us is stale (noise key changed before persistence), answering its
      // challenge once the code is entered is the only way it can verify us
      // and complete its side — dropping the challenge here deadlocks it in
      // a one-way trust state (it keeps challenging, we keep not answering).
      if (!peerObj.pairing.pendingChallenges) peerObj.pairing.pendingChallenges = []
      peerObj.pairing.pendingChallenges.push({ codeId: msg.codeId, nonce: msg.nonce })
      if (peerObj.pairing.pendingChallenges.length > 16) peerObj.pairing.pendingChallenges.shift()
      return
    }

    const nonceBuf = Buffer.from(msg.nonce, 'hex')
    if (nonceBuf.length !== 16) return
    const signature = mac(secret.code, nonceBuf)
    try {
      peerObj.signaling.send({
        type: 'PAIRING_RESP',
        nonce: msg.nonce,
        mac: signature.toString('hex')
      })
    } catch (err) {
      console.error('[Worker] Failed to send PAIRING_RESP:', err.message)
    }
  }

  // Verify the peer's response to OUR challenge. Only here do we grant trust.
  // On failure the connection is destroyed (untrusted peers only).
  handleResponse(peerId, msg) {
    const peerObj = this.getPeers().get(peerId)
    if (!peerObj || !peerObj.pairing) {
      return
    }
    const alreadyTrusted = peerObj.pairing.trusted
    if (!alreadyTrusted && peerObj.pairing.mode !== 'pairing') {
      return
    }
    if (typeof msg.nonce !== 'string' || typeof msg.mac !== 'string') return

    const idx = peerObj.pairing.outstanding.findIndex((o) => o.nonce.toString('hex') === msg.nonce)
    if (idx === -1) {
      if (alreadyTrusted) return // stale/duplicate response — never kill a live peer
      console.warn(`[Worker] Pairing response nonce mismatch from ${peerId}, disconnecting`)
      this._clearPairingTimeout(peerId)
      try {
        peerObj.connection.destroy()
      } catch {}
      return
    }
    const outstanding = peerObj.pairing.outstanding[idx]
    const expected = mac(outstanding.code, outstanding.nonce).toString('hex')
    if (msg.mac !== expected) {
      if (alreadyTrusted) return // probe mismatch — ignore rather than kill a live peer
      console.warn(`[Worker] Pairing challenge FAILED from ${peerId}, disconnecting`)
      this._clearPairingTimeout(peerId)
      try {
        peerObj.connection.destroy()
      } catch {}
      return
    }

    peerObj.pairing.outstanding.splice(idx, 1)
    if (alreadyTrusted) {
      // The peer proved knowledge of a registered code over an already-trusted
      // connection: it is the code's host (LAN auto-trust, or a pairing that
      // completed before the code was entered). Re-confirm so the UI gets a
      // fresh completion signal without re-running the handshake.
      console.log(`[Worker] Pairing re-confirmed for ${peerId} (${outstanding.code})`)
      this._clearPairingTimeout(peerId)
      this.onTrustGranted(peerId, outstanding.code)
      return
    }

    peerObj.pairing.trusted = true
    peerObj.device.isTrusted = true
    peerObj.device.trustedAt = peerObj.device.trustedAt || new Date().toISOString()
    // Challenge VERIFIED: drop the watchdog so the connection is never killed
    // while the reciprocal HANDSHAKE is still in flight.
    this._clearPairingTimeout(peerId)
    console.log(`[Worker] Pairing challenge VERIFIED for ${peerId} (${outstanding.code})`)
    this.getPeers().set(peerId, peerObj)
    this.onTrustGranted(peerId, outstanding.code)
    this.sendHandshake(peerId)
  }

  // Called whenever a new pairing secret is registered: answer any previously
  // unanswered challenges and send fresh challenges to still-untrusted peers.
  syncToPeers() {
    for (const [pId, peerObj] of this.getPeers().entries()) {
      if (!peerObj.pairing) continue
      // Answer challenges we could not answer before — for ANY peer, including
      // trusted ones: a challenger whose stored trust for us is stale can only
      // complete its side if we answer its challenge once the code is entered.
      if (Array.isArray(peerObj.pairing.pendingChallenges)) {
        const still = []
        for (const pc of peerObj.pairing.pendingChallenges) {
          const secret = this.pairingSecrets.get(pc.codeId)
          if (secret && (secret.expiresAt === 0 || Date.now() < secret.expiresAt)) {
            const signature = mac(secret.code, Buffer.from(pc.nonce, 'hex'))
            try {
              peerObj.signaling.send({
                type: 'PAIRING_RESP',
                nonce: pc.nonce,
                mac: signature.toString('hex')
              })
            } catch {}
          } else {
            still.push(pc)
          }
        }
        peerObj.pairing.pendingChallenges = still
      }
      // Fresh challenges only go to untrusted peers still in the pairing phase.
      if (peerObj.pairing.mode !== 'pairing' || peerObj.pairing.trusted) continue
      this.sendChallenges(pId)
    }
  }

  // Drop expired pairing secrets so stale codes cannot be used indefinitely.
  expireSecrets() {
    const now = Date.now()
    for (const [cid, secret] of this.pairingSecrets.entries()) {
      if (secret.expiresAt > 0 && now >= secret.expiresAt) {
        this.pairingSecrets.delete(cid)
        if (this.topicRegistry) this.topicRegistry.leave(`p2p-pair-${secret.code}`)
      }
    }
  }
}

module.exports = { TrustManager, PAIRING_TTL, PAIRING_TIMEOUT }
