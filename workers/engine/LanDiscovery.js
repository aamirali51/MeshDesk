'use strict'

// LanDiscovery owns the peer-discovery STATE of the P2P engine. The Bare
// worker has no UDP stack, so Electron main owns the socket advertiser
// (electron/lan-discovery.js) and feeds announcements back here through the
// LAN_DISCOVERY_PEER protocol method. This module validates that only a real
// swarm (noise) public key ever reaches swarm.joinPeer — never a corestore
// identity key.

const PEER_KEY_HEX_LEN = 64 // 32-byte noise public key, hex-encoded
const MAX_PEERS = 128
const PRUNE_MS = 30 * 1000

class LanDiscovery {
  constructor({ swarm, getDeviceIdentity, onPeerKey, now = Date.now }) {
    this.swarm = swarm
    this.getDeviceIdentity = getDeviceIdentity || (() => null)
    this.onPeerKey = onPeerKey || (() => {})
    this.now = now
    this.known = new Map() // peerKeyHex -> { key, id, name, os, seenAt }
    this.started = false
  }

  // The only key we may advertise or connect with: the swarm DHT keypair
  // public key (the peer identity used by secret-stream / joinPeer).
  getPublicKey() {
    const keyPair = this.swarm && this.swarm.keyPair
    if (!keyPair || !keyPair.publicKey) return null
    return Buffer.from(keyPair.publicKey).toString('hex')
  }

  getSelfAnnouncement() {
    const identity = this.getDeviceIdentity() || {}
    return {
      v: 1,
      key: this.getPublicKey(),
      id: identity.id || '',
      name: identity.name || '',
      os: identity.os || ''
    }
  }

  start() {
    this.started = true
    return this.getPublicKey()
  }

  stop() {
    this.started = false
  }

  // Handle a LAN announcement (a raw key string or a decoded object). Returns
  // true when the peer is new and was handed to joinPeer, false when ignored.
  handleAnnouncement(announcement) {
    if (!this.started) return false
    const key =
      typeof announcement === 'string'
        ? announcement
        : announcement && typeof announcement.key === 'string'
          ? announcement.key
          : null
    if (typeof key !== 'string' || key.length !== PEER_KEY_HEX_LEN) return false

    const selfKey = this.getPublicKey()
    if (selfKey && key === selfKey) return false

    const existing = this.known.get(key)
    if (existing) {
      existing.seenAt = this.now()
      return false
    }

    this.prune()
    this.known.set(key, {
      key,
      id: announcement && announcement.id,
      name: announcement && announcement.name,
      os: announcement && announcement.os,
      seenAt: this.now()
    })
    this.onPeerKey(key, {
      id: announcement && announcement.id,
      name: announcement && announcement.name
    })
    return true
  }

  // Drop stale entries so a churning network cannot grow this map unboundedly.
  prune() {
    const cutoff = this.now() - PRUNE_MS
    for (const [key, entry] of this.known.entries()) {
      if (entry.seenAt < cutoff) this.known.delete(key)
    }
    if (this.known.size > MAX_PEERS) {
      const sorted = Array.from(this.known.entries()).sort((a, b) => a[1].seenAt - b[1].seenAt)
      const excess = this.known.size - MAX_PEERS
      for (let i = 0; i < excess; i++) this.known.delete(sorted[i][0])
    }
  }

  // Whether a peer noise key was (recently) discovered on the local network.
  // Used by onConnection to auto-trust LAN-discovered peers when the
  // autoTrustLAN setting is enabled — an explicit signal that beats IP-based
  // heuristics (same-machine sockets, NATs, port suffixes, etc.).
  has(key) {
    return typeof key === 'string' && this.known.has(key)
  }

  knownPeers() {
    return Array.from(this.known.values())
  }
}

module.exports = LanDiscovery
