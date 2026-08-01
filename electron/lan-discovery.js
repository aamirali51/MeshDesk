'use strict'

// LanDiscovery (main-process side): UDP advertiser for noise-key LAN
// discovery. Electron main owns this socket because the Bare worker has no
// UDP stack. The worker reports its swarm public key via the
// LAN_DISCOVERY_KEY event; main advertises it on the local network and
// forwards discovered keys back to the worker through LAN_DISCOVERY_PEER.
//
// Defaults target multicast (239.255.255.250); tests pass explicit unicast
// loopback targets and `multicast: false` so no OS multicast support is
// required.

const dgram = require('dgram')
const os = require('os')

const DEFAULT_PORT = 39001
const DEFAULT_GROUP = '239.255.255.250'
const ANNOUNCE_INTERVAL_MS = 5000
const MAX_MESSAGE_SIZE = 512

class LanDiscovery {
  constructor({
    port = DEFAULT_PORT,
    announcePort = port,
    group = DEFAULT_GROUP,
    bindAddress = '0.0.0.0',
    targets,
    multicast = true,
    announceIntervalMs = ANNOUNCE_INTERVAL_MS,
    maxMessageSize = MAX_MESSAGE_SIZE,
    socket = null,
    getInterfaces = os.networkInterfaces,
    log = () => {}
  }) {
    this.port = port
    this.announcePort = announcePort
    this.group = group
    this.bindAddress = bindAddress
    this.targets = targets || [group]
    this.multicast = multicast
    this.announceIntervalMs = announceIntervalMs
    this.maxMessageSize = maxMessageSize
    this.socket = socket
    this.getInterfaces = getInterfaces
    this.log = log
    this.self = null // { v, key, id, name, os }
    this.onPeer = null
    this.known = new Map() // peerKeyHex -> lastSeenAt
    this.timer = null
    this.started = false
  }

  // Advertise a key (from the worker). Only 64-hex swarm public keys are
  // accepted; anything else is ignored so identity core keys cannot leak.
  setSelf(announcement) {
    if (!announcement || typeof announcement.key !== 'string' || announcement.key.length !== 64) {
      return false
    }
    this.self = { v: 1, ...announcement }
    this.log(`[LanDiscovery] advertising ${this.self.key.slice(0, 12)}...`)
    return true
  }

  start(onPeer) {
    if (this.started) return this
    this.onPeer = onPeer || this.onPeer
    if (!this.socket) this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (msg, rinfo) => this._handleMessage(msg, rinfo))
    this.socket.on('error', (err) => this.log(`[LanDiscovery] socket error: ${err.message}`))
    this.socket.bind(this.port, this.bindAddress, () => {
      this._joinGroup()
      this.started = true
      this._announce()
      this.timer = setInterval(() => this._announce(), this.announceIntervalMs)
      if (this.timer.unref) this.timer.unref()
    })
    return this
  }

  _joinGroup() {
    if (!this.multicast) return
    try {
      this.socket.addMembership(this.group, this._interfaceAddress())
    } catch (err) {
      this.log(`[LanDiscovery] multicast join failed: ${err.message}`)
    }
    try {
      this.socket.setBroadcast(true)
    } catch {}
    try {
      this.socket.setMulticastTTL(64)
    } catch {}
  }

  _interfaceAddress() {
    const ifaces = this.getInterfaces()
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address
      }
    }
    return '0.0.0.0'
  }

  _announce() {
    if (!this.self || !this.socket || !this.started) return
    const buf = Buffer.from(JSON.stringify(this.self))
    for (const target of this.targets) {
      try {
        this.socket.send(buf, 0, buf.length, this.announcePort, target)
      } catch (err) {
        this.log(`[LanDiscovery] send to ${target} failed: ${err.message}`)
      }
    }
  }

  _handleMessage(msg) {
    if (msg.length > this.maxMessageSize) return
    let ann
    try {
      ann = JSON.parse(msg.toString())
    } catch {
      return
    }
    if (!ann || typeof ann.key !== 'string' || ann.key.length !== 64) return
    if (this.self && ann.key === this.self.key) return
    if (this.known.has(ann.key)) return
    this.known.set(ann.key, Date.now())
    if (!this.onPeer) return
    this.log(`[LanDiscovery] peer found: ${ann.key.slice(0, 12)}... (${ann.name || '?'})`)
    try {
      this.onPeer(ann)
    } catch (err) {
      this.log(`[LanDiscovery] onPeer failed: ${err.message}`)
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.started = false
    if (this.socket) {
      try {
        this.socket.close()
      } catch {}
      this.socket = null
    }
  }
}

module.exports = LanDiscovery
