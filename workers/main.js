'use strict'

// P2P worker composition root. All engine/module state lives on the shared
// `ctx` object; connections, handlers, and helpers are split into sibling
// modules (connections.js, handlers.js, helpers.js, ipc.js, config.js,
// storage.js).

const goodbye = require('graceful-goodbye')
const Hyperswarm = require('hyperswarm')
const PearRuntime = require('pear-runtime')
const path = require('bare-path')
const fsp = require('bare-fs/promises')
const { createEvent } = require('../src/shared/protocol.js')

const { TrustManager } = require('./engine/TrustManager.js')
const MetricsCollector = require('./engine/MetricsCollector.js')
const TopicRegistry = require('./engine/TopicRegistry.js')
const NotificationStore = require('./engine/NotificationStore.js')
const ReplicationScope = require('./engine/ReplicationScope.js')
const LanDiscovery = require('./engine/LanDiscovery.js')
const { loadOrCreateNoiseKeypair } = require('./engine/noiseKeypair.js')
const { TransferEngine } = require('./engine/TransferEngine.js')

const { createIpc, createMessageRouter } = require('./ipc.js')
const { createConfig } = require('./config.js')
const { createStorage } = require('./storage.js')
const helpers = require('./helpers.js')
const { createConnections } = require('./connections.js')
const { registerHandlers } = require('./handlers.js')

// ─── Worker Process Safety & Error Guards ────────────────────────────────────
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('uncaughtException', (err) => {
    console.error('[Worker Uncaught Exception]:', err?.stack || err?.message || err)
  })
  Bare.on('unhandledRejection', (reason) => {
    console.error('[Worker Unhandled Rejection]:', reason?.stack || reason?.message || reason)
  })
} else if (typeof process !== 'undefined' && process.on) {
  process.on('uncaughtException', (err) => {
    console.error('[Worker Uncaught Exception]:', err?.stack || err?.message || err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[Worker Unhandled Rejection]:', reason?.stack || reason?.message || reason)
  })
}

// ─── Configuration & Storage ─────────────────────────────────────────────────
const config = createConfig()
const ipc = createIpc()
const storage = createStorage({
  STORAGE_DIR: config.STORAGE_DIR,
  getDeviceName: config.getDeviceName
})

// ─── Swarm ──────────────────────────────────────────────────────────────────

// DHT relay fallback: on restrictive networks (symmetric NAT, TCP-only VPNs)
// direct UDP hole-punching fails. hyperswarm then reconnects the peer through
// a DHT relay node, which tunnels the noise stream over TCP. We pick a relay
// from the local routing table and prefer it only when the DHT reports we are
// behind a random/symmetric NAT (randomized) or a direct punch already failed
// (force), so direct connections stay preferred whenever they work.
function pickRelayNode(dht) {
  try {
    const nodes = dht && dht.nodes
    if (!nodes || nodes.length === 0) return null
    for (let node = nodes.latest; node; node = node.prev) {
      if (node.id && node.host && node.port) return node.id
    }
  } catch {}
  return null
}

// The swarm noise keypair is this node's peer identity and MUST persist across
// restarts: trust, device records, and direct reconnects all key on it. A
// fresh keypair per boot would orphan every previously paired device.
const noiseKeyPair = loadOrCreateNoiseKeypair(config.STORAGE_DIR)
console.log(
  `[Worker] Noise key (stable): ${noiseKeyPair.publicKey.toString('hex').slice(0, 12)}...`
)

const swarm = new Hyperswarm({
  keyPair: noiseKeyPair,
  relayThrough: (force, s) => {
    if (!force && !s.dht.randomized) return null
    return pickRelayNode(s.dht)
  }
})
const peers = new Map() // peerId -> { connection, stream, device, signaling, transferMethod, pairing }
const activeClaims = new Set() // Set of cleanCode strings currently being claimed by local instance
const pendingSwarmTopics = new Map() // transferId -> { topicLabel, core, stagedPath }

// ─── Shared Context ──────────────────────────────────────────────────────────
// Mutable module state behind getters so handlers/connections always see the
// current value (engine instances are created later in bootstrap).
let notificationStore = null
let transferEngine = null
let replicationScope = null
let trustManager = null
let metricsCollector = null
let topicRegistry = null
let lanDiscovery = null

const ctx = {
  ...config,
  ...ipc,
  ...storage,
  handlers: {},
  swarm,
  peers,
  activeClaims,
  pendingSwarmTopics,
  connectionCount: 0,
  relayStatus: 'Enabled', // DHT relay fallback is configured (see swarm opts)
  get deviceIdentity() {
    return storage.getDeviceIdentity()
  },
  get notificationStore() {
    return notificationStore
  },
  get transferEngine() {
    return transferEngine
  },
  get replicationScope() {
    return replicationScope
  },
  get trustManager() {
    return trustManager
  },
  get metricsCollector() {
    return metricsCollector
  },
  get topicRegistry() {
    return topicRegistry
  },
  get lanDiscovery() {
    return lanDiscovery
  },
  getDurationMs: helpers.getDurationMs,
  getTransferMethod: helpers.getTransferMethod,
  mergeSettings: helpers.mergeSettings,
  getDownloadDirectory: () => helpers.getDownloadDirectory(ctx),
  getAutoTrustLAN: () => helpers.getAutoTrustLAN(ctx),
  invalidateSettingsCache: () => {
    ctx.autoTrustLANCache = undefined
  },
  cleanupPendingShare: (id, newStatus) => helpers.cleanupPendingShare(ctx, id, newStatus),
  checkPendingExpirations: () => helpers.checkPendingExpirations(ctx)
}

const connections = createConnections(ctx)
ctx.getConnectionStatus = connections.getConnectionStatus
ctx.authenticatedPeerCount = connections.authenticatedPeerCount
ctx.sendHandshake = connections.sendHandshake
ctx.replicateExchange = connections.replicateExchange
ctx.getPeerLatency = connections.getPeerLatency
ctx.getPacketLoss = connections.getPacketLoss

// ─── Engine Instances ───────────────────────────────────────────────────────

function initEngine() {
  metricsCollector = new MetricsCollector({ swarm })
  metricsCollector.start()
  topicRegistry = new TopicRegistry({ computeTopicHash: ctx.computeTopicHash, swarm })
  replicationScope = new ReplicationScope({
    exchangeStore: ctx.exchangeStore,
    isPeerTrusted: (peerId) => peers.get(peerId)?.pairing?.trusted === true,
    onStream: (stream) => metricsCollector?.trackStream(stream)
  })
  trustManager = new TrustManager({
    getBee: ctx.getBee,
    computeTopicHash: ctx.computeTopicHash,
    swarm,
    topicRegistry,
    getPeers: () => peers,
    sendHandshake: connections.sendHandshake,
    onTrustGranted: (peerId) => {
      connections.replicateExchange(peerId)
      // A HANDSHAKE that arrived while the challenge was still outstanding is
      // applied now that trust is granted, so the connection always completes.
      connections.flushPendingHandshake(peerId)
      // If the handshake already completed earlier (LAN auto-trust / prior
      // pairing), re-broadcast the completion events so the pairing modal gets
      // a fresh success signal when the host re-confirms the entered code.
      connections.rebroadcastPeerCompletion(peerId)
    }
  })
  notificationStore = new NotificationStore({ sendEvent: ctx.sendEvent })
  transferEngine = new TransferEngine({
    getBee: ctx.getBee,
    exchangeStore: replicationScope,
    sendEvent: ctx.sendEvent,
    getPeers: () => peers,
    getDeviceIdentity: () => storage.getDeviceIdentity(),
    getDownloadDirectory: ctx.getDownloadDirectory,
    getTransferMethod: helpers.getTransferMethod,
    fsp,
    path
  })
  lanDiscovery = new LanDiscovery({
    swarm,
    getDeviceIdentity: () => storage.getDeviceIdentity(),
    onPeerKey: (key) => {
      try {
        const peerKey = Buffer.from(key, 'hex')
        if (peerKey.length === 32) {
          console.log(`[Worker] LAN discovery -> joinPeer(${key.slice(0, 12)}...)`)
          swarm.joinPeer(peerKey)
          // The connection may already exist (e.g. via the DHT identity topic)
          // before this announcement lands: promote it to direct trust now so
          // autoTrustLAN still bypasses the pairing handshake.
          connections.maybeAutoTrustLanPeer(key).catch(() => {})
        }
      } catch (err) {
        console.warn('[Worker] LAN discovery joinPeer failed:', err.message)
      }
    }
  })
}

// ─── Handlers & Router ───────────────────────────────────────────────────────
const { expirationTimer, cleanupDuplicateDevices } = registerHandlers(ctx)
const handleMessage = createMessageRouter({ send: ctx.send, handlers: ctx.handlers })

// ─── Pear Runtime ─────────────────────────────────────────────────────────
const pear = new PearRuntime({ ...config.updaterConfig, swarm, store: ctx.store })

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap() {
  console.log('P2P worker starting...')
  ipc.pipe.on('data', handleMessage)

  // Engines MUST exist before the first IPC message can be handled: the
  // renderer flushes its request queue ~1s after the worker starts (fallback
  // timer in renderer/src/lib/ipc.ts) and the main process forwards messages
  // immediately, so a handler can run while bootstrap's awaits are still in
  // flight. initEngine is synchronous, so constructing the engines before any
  // await guarantees trustManager/transferEngine/... are never null when a
  // handler runs (previously devices.getIdentity raced this and returned an
  // empty pairingCode, blanking the dashboard's device address).
  initEngine()

  await ctx.storeReady()
  await replicationScope.init()
  await transferEngine.init()

  const identity = await ctx.initIdentity()
  console.log('Device identity:', identity.name, identity.id)

  await trustManager.loadTrustedPeerKeys()
  // Re-key legacy noise-key-derived device rows so restarts never leave
  // duplicate records for the same physical device.
  await cleanupDuplicateDevices(ctx)
  await connections.initSwarm()
  console.log('Swarm joined, listening for peers')

  await connections.reconnectKnownPeers()

  ctx.send(createEvent('worker.ready', { identity }))

  console.log('P2P worker ready')
}

bootstrap().catch((err) => {
  console.error('Worker bootstrap failed:', err)
})

// ─── Cleanup ────────────────────────────────────────────────────────────────

goodbye(async () => {
  if (expirationTimer) clearInterval(expirationTimer)
  if (metricsCollector) metricsCollector.stop()
  if (lanDiscovery) lanDiscovery.stop()
  if (transferEngine) await transferEngine.shutdown()
  if (replicationScope) replicationScope.closeAll()
  if (topicRegistry) topicRegistry.leaveAll()
  await swarm.destroy()
  await pear.close()
  await ctx.store.close()
  await ctx.exchangeStore.close().catch(() => {})
})
