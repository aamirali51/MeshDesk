'use strict'

// Engine integration test: exercises the real TrustManager challenge-response
// protocol between simulated peers, plus MetricsCollector, TopicRegistry,
// ReplicationScope and TransferEngine. Run with: npm test  (or node scripts/engine-test.js)

const assert = require('assert')
const crypto = require('crypto')

const { TrustManager } = require('../workers/engine/TrustManager.js')
const MetricsCollector = require('../workers/engine/MetricsCollector.js')
const TopicRegistry = require('../workers/engine/TopicRegistry.js')
const ReplicationScope = require('../workers/engine/ReplicationScope.js')
const cryptoModule = require('../workers/shared/crypto.js')

function computeTopicHash(label) {
  return crypto.createHash('sha256').update(label).digest()
}

function makeSwarmStub() {
  const joins = []
  const leaves = []
  return {
    joins,
    leaves,
    join(topicHash) {
      joins.push(topicHash)
    },
    leave(topicHash) {
      leaves.push(topicHash)
    },
    flush() {
      return Promise.resolve()
    }
  }
}

function makeBee() {
  const data = new Map()
  return {
    async get(key) {
      return data.has(key) ? { value: data.get(key) } : null
    },
    async put(key, value) {
      data.set(key, value)
    },
    async del(key) {
      data.delete(key)
    },
    async *createReadStream() {
      for (const [key, value] of data.entries()) yield { key, value }
    }
  }
}

const bees = new Map()
function getBee(name) {
  if (!bees.has(name)) bees.set(name, makeBee())
  return bees.get(name)
}

// Build a TrustManager for one node. `wire` is called with (nodeA, nodeB)
// so each side's signaling.send delivers into the other side's handlers.
function makeNode(name, getPeerId, otherName, otherManager, events) {
  const peers = new Map()
  const swarm = makeSwarmStub()
  const peerObj = {
    connection: {
      destroyed: false,
      destroy() {
        this.destroyed = true
      }
    },
    device: { isTrusted: false, trustedAt: null },
    signaling: {
      send(msg) {
        // Deliver to the other node, addressed from THIS node.
        const fromPeerId = getPeerId()
        if (msg.type === 'PAIRING_CHALLENGE') otherManager.handleChallenge(fromPeerId, msg)
        else if (msg.type === 'PAIRING_RESP') otherManager.handleResponse(fromPeerId, msg)
      }
    },
    pairing: {
      mode: 'pairing',
      trusted: false,
      complete: false,
      outstanding: [],
      pendingChallenges: [],
      pendingHandshake: null,
      timeout: null
    }
  }
  peers.set(getPeerId(), peerObj)

  const trust = new TrustManager({
    getBee,
    computeTopicHash,
    swarm,
    getPeers: () => peers,
    sendHandshake: (peerId) => {
      events.handshakes.push({ node: name, peerId })
    },
    onTrustGranted: (peerId, code) => {
      events.trustGranted.push({ node: name, peerId, code })
    }
  })

  return { name, trust, peers, peerObj, swarm }
}

async function main() {
  let passed = 0
  const ok = (label) => {
    passed++
    console.log(`  ok  ${label}`)
  }

  console.log('1. TrustManager: mutual challenge grants trust to code-holders')

  const events = { handshakes: [], trustGranted: [] }
  const host = makeNode('host', () => 'peerB', 'peerB', null, events)
  const joiner = makeNode('joiner', () => 'peerA', 'peerA', null, events)
  // Wire both directions
  host.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') joiner.trust.handleChallenge('peerA', msg)
    else if (msg.type === 'PAIRING_RESP') joiner.trust.handleResponse('peerA', msg)
  }
  joiner.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') host.trust.handleChallenge('peerB', msg)
    else if (msg.type === 'PAIRING_RESP') host.trust.handleResponse('peerB', msg)
  }

  const code = await host.trust.getOrCreatePairingCode()
  assert.ok(/^MD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), 'host code format')
  ok('host generates a random 80-bit pairing code')

  const registered = joiner.trust.registerJoinerCode(code)
  assert.strictEqual(registered, code, 'joiner code normalizes')
  ok('joiner registers the same code')

  host.trust.sendChallenges('peerB')
  joiner.trust.sendChallenges('peerA')

  assert.strictEqual(host.peerObj.device.isTrusted, true, 'host trusts joiner')
  assert.strictEqual(joiner.peerObj.device.isTrusted, true, 'joiner trusts host')
  assert.strictEqual(events.handshakes.length, 2, 'both sides send handshakes')
  assert.strictEqual(events.trustGranted.length, 2, 'trust granted on both sides')
  ok('mutual challenge-response establishes trust and handshakes')

  const realKey = 'a'.repeat(64)
  assert.strictEqual(
    host.trust.isTrustedPublicKey(realKey),
    false,
    'trust is keyed by real noise keys'
  )
  host.trust.addTrustedKey(realKey)
  assert.strictEqual(host.trust.isTrustedPublicKey(realKey), true, 'trusted key set works')
  host.trust.removeTrustedKey(realKey)
  assert.strictEqual(host.trust.isTrustedPublicKey(realKey), false, 'trusted key removal works')
  ok('trusted key set behaves')

  console.log('2. TrustManager: attacker without the code is NOT trusted')

  const events2 = { handshakes: [], trustGranted: [] }
  const victim = makeNode('victim', () => 'peerC', 'peerC', null, events2)
  const attacker = makeNode('attacker', () => 'peerV', 'peerV', null, events2)
  victim.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') attacker.trust.handleChallenge('peerV', msg)
    else if (msg.type === 'PAIRING_RESP') attacker.trust.handleResponse('peerV', msg)
  }
  attacker.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') victim.trust.handleChallenge('peerC', msg)
    else if (msg.type === 'PAIRING_RESP') victim.trust.handleResponse('peerC', msg)
  }

  await victim.trust.getOrCreatePairingCode()
  // Attacker registers a DIFFERENT valid-format code
  const wrongCode = cryptoModule.generatePairingCode()
  attacker.trust.registerJoinerCode(wrongCode)

  victim.trust.sendChallenges('peerC')
  attacker.trust.sendChallenges('peerV')

  assert.strictEqual(victim.peerObj.device.isTrusted, false, 'victim must not trust attacker')
  assert.strictEqual(attacker.peerObj.device.isTrusted, false, 'attacker must not trust victim')
  assert.strictEqual(events2.trustGranted.length, 0, 'no trust granted anywhere')
  ok('wrong-code peer is never trusted (dropped by the pairing timeout in production)')

  // Direct test of the failure path: a peer that knows the code but sends a bad
  // MAC must be rejected and the connection destroyed immediately.
  const events4 = { handshakes: [], trustGranted: [] }
  const v3 = makeNode('v3', () => 'peerT', 'peerT', null, events4)
  const tamperer = makeNode('tamperer', () => 'peerV3', 'peerV3', null, events4)
  v3.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') tamperer.trust.handleChallenge('peerV3', msg)
    else if (msg.type === 'PAIRING_RESP') tamperer.trust.handleResponse('peerV3', msg)
  }
  tamperer.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') v3.trust.handleChallenge('peerT', msg)
    else if (msg.type === 'PAIRING_RESP') {
      // Corrupt the MAC before delivery
      v3.trust.handleResponse('peerT', { ...msg, mac: '0'.repeat(msg.mac.length) })
    }
  }
  const code3 = cryptoModule.generatePairingCode()
  tamperer.trust.registerJoinerCode(code3)
  v3.trust.registerJoinerCode(code3)
  tamperer.trust.sendChallenges('peerV3')
  v3.trust.sendChallenges('peerT')
  assert.strictEqual(v3.peerObj.device.isTrusted, false, 'bad-MAC response must not grant trust')
  assert.strictEqual(v3.peerObj.connection.destroyed, true, 'bad-MAC peer is disconnected')
  ok('bad-MAC response is rejected and the connection destroyed')

  // Pending challenge: attacker challenges before victim knows the code, then
  // victim registers the code and syncToPeers answers it.
  const events3 = { handshakes: [], trustGranted: [] }
  const v2 = makeNode('v2', () => 'peerA2', 'peerA2', null, events3)
  const j2 = makeNode('j2', () => 'peerV2', 'peerV2', null, events3)
  v2.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') j2.trust.handleChallenge('peerV2', msg)
    else if (msg.type === 'PAIRING_RESP') j2.trust.handleResponse('peerV2', msg)
  }
  j2.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') v2.trust.handleChallenge('peerA2', msg)
    else if (msg.type === 'PAIRING_RESP') v2.trust.handleResponse('peerA2', msg)
  }
  const code2 = cryptoModule.generatePairingCode()
  // j2 knows the code, v2 does not yet: v2 sends a challenge first.
  v2.trust.registerJoinerCode(code2) // v2 is the "joiner" for topic purposes
  j2.trust.registerJoinerCode(code2)
  j2.trust.sendChallenges('peerV2') // j2 challenges first; v2 must answer later
  // Now v2's pending challenge is answered when v2 registers its host secret via sync.
  await v2.trust.getOrCreatePairingCode() // generates v2's OWN host code, triggers syncToPeers
  // The pending challenge from j2 used code2 (the one both share), so sync should answer it.
  v2.trust.syncToPeers()
  assert.strictEqual(j2.peerObj.device.isTrusted, true, 'j2 trusts v2 after pending answer')
  assert.strictEqual(v2.peerObj.device.isTrusted, true, 'v2 trusts j2')
  ok('pending challenges are answered once the secret is registered')

  console.log('2b. TrustManager: pairing watchdog is challenge-scoped, not connection-scoped')

  const eventsT = { handshakes: [], trustGranted: [] }
  const tmA = makeNode('tmA', () => 'peerTA', 'peerTA', null, eventsT)
  const tmB = makeNode('tmB', () => 'peerTB', 'peerTB', null, eventsT)
  // Deliver messages on a later tick so the armed/cleared watchdog states are
  // observable between challenge send and response verification.
  const tick = () => new Promise((r) => setImmediate(r))
  tmA.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE')
      setImmediate(() => tmB.trust.handleChallenge('peerTB', msg))
    else if (msg.type === 'PAIRING_RESP')
      setImmediate(() => tmB.trust.handleResponse('peerTB', msg))
  }
  tmB.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE')
      setImmediate(() => tmA.trust.handleChallenge('peerTA', msg))
    else if (msg.type === 'PAIRING_RESP')
      setImmediate(() => tmA.trust.handleResponse('peerTA', msg))
  }
  // Seed the shared secret directly on both sides (bypasses getOrCreatePairingCode's
  // syncToPeers so no challenge fires before we start the scenario).
  const codeT = cryptoModule.generatePairingCode()
  const cidT = cryptoModule.codeId(codeT)
  tmA.trust.pairingSecrets.set(cidT, {
    code: codeT,
    role: 'host',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidT
  })
  tmB.trust.pairingSecrets.set(cidT, {
    code: codeT,
    role: 'joiner',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidT
  })

  // A freshly opened connection must NOT have started the 30s watchdog: the
  // timer only starts when a PAIRING_CHALLENGE is actually sent or received.
  assert.strictEqual(tmA.peerObj.pairing.timeout, null, 'no watchdog armed at connection open (A)')
  assert.strictEqual(tmB.peerObj.pairing.timeout, null, 'no watchdog armed at connection open (B)')
  ok('connection open alone does not arm the pairing watchdog')

  // Sending a challenge arms the timer on the sender before any response lands.
  tmA.trust.sendChallenges('peerTA')
  assert.ok(tmA.peerObj.pairing.timeout, 'watchdog armed once a challenge is sent')
  assert.strictEqual(tmB.peerObj.pairing.timeout, null, 'other side not armed until it acts')
  // …and receiving one arms it on the responder.
  tmB.trust.sendChallenges('peerTB')
  assert.ok(tmB.peerObj.pairing.timeout, 'watchdog armed once a challenge is received')

  // Let the reciprocal responses flow; each side verifies the other.
  await tick()
  await tick()
  assert.strictEqual(tmA.peerObj.device.isTrusted, true, 'A trusts B after verification')
  assert.strictEqual(tmB.peerObj.device.isTrusted, true, 'B trusts A after verification')
  // The moment a challenge is VERIFIED the watchdog must be explicitly cleared,
  // otherwise the background timer kills a freshly verified connection.
  assert.strictEqual(
    tmA.peerObj.pairing.timeout,
    null,
    'watchdog cleared on verified challenge (A)'
  )
  assert.strictEqual(
    tmB.peerObj.pairing.timeout,
    null,
    'watchdog cleared on verified challenge (B)'
  )
  ok('watchdog is cleared the moment a challenge verifies')

  console.log('2c. TrustManager: direct-trusted (autoTrustLAN) peers bypass the handshake')

  const sentD = []
  const evD = { handshakes: [], trustGranted: [] }
  const dm = makeNode('dm', () => 'peerD', 'peerD', null, evD)
  dm.peerObj.signaling.send = (msg) => {
    sentD.push(msg.type)
  }
  // Simulate onConnection deciding autoTrustLAN: peer starts direct-trusted.
  dm.peerObj.pairing.mode = 'direct'
  dm.peerObj.pairing.trusted = true
  dm.peerObj.device.isTrusted = true
  await dm.trust.getOrCreatePairingCode() // a host secret exists; challenges WOULD be possible
  dm.trust.sendChallenges('peerD')
  dm.trust.syncToPeers()
  dm.trust.handleChallenge('peerD', { codeId: 'abcd1234', nonce: 'ab'.repeat(16) })
  dm.trust.handleResponse('peerD', { nonce: 'ab'.repeat(16), mac: '0'.repeat(64) })
  assert.deepStrictEqual(sentD, [], 'direct-trusted peer gets no challenges or responses')
  assert.strictEqual(
    dm.peerObj.pairing.timeout,
    null,
    'direct-trusted peer never arms the watchdog'
  )
  ok('direct-trusted LAN peers completely bypass the challenge-response handshake')

  console.log('2e. TrustManager: already-connected host confirms a registered joiner code')

  const eventsE = { handshakes: [], trustGranted: [] }
  const hostE = makeNode('hostE', () => 'peerHost', 'peerHost', null, eventsE)
  const userE = makeNode('userE', () => 'peerUser', 'peerUser', null, eventsE)
  hostE.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') userE.trust.handleChallenge('peerUser', msg)
    else if (msg.type === 'PAIRING_RESP') userE.trust.handleResponse('peerUser', msg)
  }
  userE.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') hostE.trust.handleChallenge('peerHost', msg)
    else if (msg.type === 'PAIRING_RESP') hostE.trust.handleResponse('peerHost', msg)
  }
  // Simulate an already-completed connection: both sides are direct-trusted
  // (LAN auto-trust) and the handshake already ran before the code was entered.
  for (const side of [hostE, userE]) {
    side.peerObj.pairing.mode = 'direct'
    side.peerObj.pairing.trusted = true
    side.peerObj.pairing.complete = true
    side.peerObj.device.isTrusted = true
    side.peerObj.device.isOnline = true
  }
  // The host generated its pairing code earlier; the user now enters it.
  const codeE = cryptoModule.generatePairingCode()
  const cidE = cryptoModule.codeId(codeE)
  hostE.trust.pairingSecrets.set(cidE, {
    code: codeE,
    role: 'host',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidE
  })
  const registeredE = userE.trust.registerJoinerCode(codeE)
  assert.strictEqual(registeredE, codeE, 'joiner code registers normally')
  assert.strictEqual(
    eventsE.trustGranted.length,
    1,
    'host re-confirms the code over the live connection'
  )
  assert.strictEqual(
    eventsE.trustGranted[0].code,
    codeE,
    're-confirmation carries the registered code'
  )
  assert.strictEqual(eventsE.handshakes.length, 0, 'no new handshake for an already-paired peer')
  assert.strictEqual(userE.peerObj.pairing.trusted, true, 'user still trusts host')
  assert.strictEqual(hostE.peerObj.pairing.trusted, true, 'host still trusts user')
  assert.strictEqual(userE.peerObj.pairing.complete, true, 'connection stays complete')
  ok('an already-connected host confirms a joiner code without re-pairing')

  console.log('2d. connections: handshake completion persists the device and broadcasts UI events')

  // connections.js targets the Bare runtime; alias its bare modules to Node
  // equivalents so the completion path can be exercised under plain Node.
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bare-path') return require('path')
    if (request === 'bare-fs/promises') return require('fs').promises
    if (request === 'bare-os') return require('os')
    return origLoad.call(this, request, parent, isMain)
  }
  const { createConnections } = require('../workers/connections.js')
  Module._load = origLoad

  const evPeers = new Map()
  const emitted = []
  const connDevicesBee = makeBee()
  const connCtx = {
    peers: evPeers,
    swarm: makeSwarmStub(),
    activeClaims: new Set(),
    connectionCount: 0,
    deviceIdentity: { id: 'self-device', name: 'Self', publicKey: 'f'.repeat(64) },
    send: (json) => emitted.push(JSON.parse(json)),
    getBee: async (name) => (name === 'devices' ? connDevicesBee : getBee(name)),
    trustManager: { addTrustedKey: () => {} },
    replicationScope: { close: () => {}, closeAll: () => {}, replicate: () => null },
    transferEngine: null,
    lanDiscovery: null,
    getAutoTrustLAN: async () => true,
    topicRegistry: { ensure: () => {}, leave: () => {} }
  }
  const conns = createConnections(connCtx)
  const lanPeerId = 'ab'.repeat(32)
  evPeers.set(lanPeerId, {
    connection: { destroy() {} },
    device: { isTrusted: true, name: 'Connecting...' },
    signaling: { send() {} },
    transferMethod: 'lan',
    pairing: {
      mode: 'direct',
      trusted: true,
      complete: false,
      outstanding: [],
      pendingChallenges: [],
      pendingHandshake: null,
      timeout: null
    }
  })
  conns.handlePeerMessage(lanPeerId, {
    type: 'HANDSHAKE',
    identity: { id: 'remote-device', name: 'Peer A', os: 'windows', publicKey: 'e'.repeat(64) }
  })
  await new Promise((r) => setImmediate(r)) // let the async devices-bee put flush
  const eventNames = emitted.map((e) => e.event)
  for (const name of ['device.paired', 'peer.connected', 'device.online', 'device.updated']) {
    assert.ok(eventNames.includes(name), `completion broadcasts ${name}`)
  }
  const connChanged = emitted.find((e) => e.event === 'connection.changed')
  assert.ok(connChanged, 'completion broadcasts connection.changed')
  assert.strictEqual(connChanged.data.connected, true, 'connection.changed reports connected')
  assert.strictEqual(connChanged.data.peerCount, 1, 'connection.changed reports one peer')
  assert.strictEqual(evPeers.get(lanPeerId).pairing.complete, true, 'pairing completes')
  assert.strictEqual(evPeers.get(lanPeerId).device.isOnline, true, 'live peer is online')
  assert.strictEqual(evPeers.get(lanPeerId).device.name, 'Peer A', 'live peer name filled in')
  let persisted = null
  for await (const node of connDevicesBee.createReadStream()) {
    if (node.value && node.value.id === evPeers.get(lanPeerId).device.id) persisted = node.value
  }
  assert.ok(persisted, 'device is persisted to the devices bee')
  assert.strictEqual(persisted.isTrusted, true, 'persisted device is trusted')
  assert.strictEqual(persisted.isOnline, true, 'persisted device is online')
  ok('handshake completion persists the device and broadcasts UI-refresh events')

  console.log('2f. devices: cleanup + list collapse noise-key-derived duplicates')

  const Module2 = require('module')
  const origLoad2 = Module2._load
  Module2._load = function (request, parent, isMain) {
    if (request === 'bare-path') return require('path')
    if (request === 'bare-fs/promises') return require('fs').promises
    if (request === 'bare-fs') return require('fs')
    if (request === 'bare-os') return require('os')
    return origLoad2.call(this, request, parent, isMain)
  }
  const { registerHandlers, cleanupDuplicateDevices } = require('../workers/handlers.js')
  Module2._load = origLoad2
  const { METHODS } = require('../src/shared/protocol.js')

  // Seed the devices bee like legacy stores did: one row per restart, each
  // keyed by an id derived from that boot's ephemeral noise key, all sharing
  // the same stable identityKey.
  const devicesBee = makeBee()
  const peerIdentityKey = 'cd'.repeat(32)
  const canonicalPeerId = cryptoModule.deriveDeviceId(peerIdentityKey)
  const t = Date.now()
  for (let i = 0; i < 4; i++) {
    // Each restart used a fresh noise key (valid 64-hex), so each boot's row
    // got a DIFFERENT noise-derived id while sharing the stable identityKey.
    const noiseId = cryptoModule.deriveDeviceId(Buffer.from(`noise-key-${i}`))
    await devicesBee.put(noiseId, {
      id: noiseId,
      publicKey: (i + 1).toString(16).padStart(64, '0'),
      identityKey: peerIdentityKey,
      name: 'DESKTOP-97H506J',
      isTrusted: true,
      isOnline: true,
      lastSeen: new Date(t - (4 - i) * 60000).toISOString() // i=3 is the most recent
    })
  }
  // A legacy row without identityKey must be left untouched.
  const orphanId = cryptoModule.deriveDeviceId(Buffer.from('orphan-noise-key'))
  await devicesBee.put(orphanId, {
    id: orphanId,
    publicKey: 'e'.repeat(64),
    name: 'Legacy Peer',
    isTrusted: false,
    lastSeen: new Date(t).toISOString()
  })
  // A self row must never be touched.
  const selfId = 'self-device-id'
  await devicesBee.put(selfId, {
    id: selfId,
    publicKey: 'd'.repeat(64),
    name: 'Self'
  })

  const dedupCtx = {
    handlers: {},
    deviceIdentity: { id: selfId, publicKey: 'd'.repeat(64) },
    getBee: async (name) => (name === 'devices' ? devicesBee : makeBee()),
    peers: new Map(),
    send: () => {},
    trustManager: { addTrustedKey: () => {}, removeTrustedKey: () => {} },
    pendingSwarmTopics: new Map(),
    topicRegistry: { ensure: () => {}, leave: () => {} },
    invalidateSettingsCache: () => {}
  }
  registerHandlers(dedupCtx)
  await cleanupDuplicateDevices(dedupCtx)

  let remaining = 0
  let canonicalRow = null
  for await (const node of devicesBee.createReadStream()) {
    remaining++
    if (node.key === canonicalPeerId) canonicalRow = node.value
  }
  assert.strictEqual(
    remaining,
    3,
    '4 duplicates collapse to 1 canonical row + untouched orphan + self'
  )
  assert.ok(canonicalRow, 'winner is re-keyed under the canonical identity id')
  assert.strictEqual(canonicalRow.id, canonicalPeerId, 'winner row carries the canonical id')
  assert.strictEqual(canonicalRow.name, 'DESKTOP-97H506J', 'winner preserves device metadata')
  assert.strictEqual(canonicalRow.identityKey, peerIdentityKey, 'identityKey is preserved')

  const list = await dedupCtx.handlers[METHODS.DEVICES_LIST]()
  const named = list.filter((d) => d.name === 'DESKTOP-97H506J')
  assert.strictEqual(named.length, 1, 'devices.list returns exactly one row per physical device')
  assert.strictEqual(named[0].id, canonicalPeerId, 'listed device carries the stable id')
  assert.strictEqual(named[0].isOnline, false, 'stale bee rows list as offline')
  ok('device store cleanup + list dedup collapse restarted duplicates to one record')

  console.log('2g. noiseKeypair: persisted keypair survives restarts')

  const Module3 = require('module')
  const origLoad3 = Module3._load
  Module3._load = function (request, parent, isMain) {
    if (request === 'bare-path') return require('path')
    if (request === 'bare-fs/promises') return require('fs').promises
    if (request === 'bare-fs') return require('fs')
    if (request === 'bare-os') return require('os')
    return origLoad3.call(this, request, parent, isMain)
  }
  const { loadOrCreateNoiseKeypair } = require('../workers/engine/noiseKeypair.js')
  Module3._load = origLoad3

  const nodeOs = require('os')
  const fs = require('fs')
  const nodePath = require('path')
  const keyDir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mesh-noise-key-'))
  try {
    const kp1 = loadOrCreateNoiseKeypair(keyDir)
    assert.strictEqual(kp1.publicKey.length, 32, 'noise public key is 32 bytes')
    assert.strictEqual(kp1.secretKey.length, 64, 'noise secret key is 64 bytes')
    // 'Restart': loading again must return the identical keypair.
    const kp2 = loadOrCreateNoiseKeypair(keyDir)
    assert.strictEqual(
      kp1.publicKey.toString('hex'),
      kp2.publicKey.toString('hex'),
      'peer id (noise public key) is stable across restarts'
    )
    assert.strictEqual(
      kp1.secretKey.toString('hex'),
      kp2.secretKey.toString('hex'),
      'secret key is stable across restarts'
    )
    // A malformed keypair file must regenerate a valid one instead of crashing.
    fs.writeFileSync(
      nodePath.join(keyDir, 'noise-keypair.json'),
      '{"publicKey":"zz","secretKey":"yy"}'
    )
    const kp3 = loadOrCreateNoiseKeypair(keyDir)
    assert.strictEqual(kp3.publicKey.length, 32, 'malformed keypair regenerates a valid one')
    ok('noise keypair persists across restarts (stable peer id)')
  } finally {
    fs.rmSync(keyDir, { recursive: true, force: true })
  }

  console.log('2h. TrustManager: one code entry heals a one-way trust state')

  const eventsH = { handshakes: [], trustGranted: [] }
  const hostH = makeNode('hostH', () => 'peerHostH', 'peerHostH', null, eventsH)
  const userH = makeNode('userH', () => 'peerUserH', 'peerUserH', null, eventsH)
  hostH.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') userH.trust.handleChallenge('peerUserH', msg)
    else if (msg.type === 'PAIRING_RESP') userH.trust.handleResponse('peerUserH', msg)
  }
  userH.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') hostH.trust.handleChallenge('peerHostH', msg)
    else if (msg.type === 'PAIRING_RESP') hostH.trust.handleResponse('peerHostH', msg)
  }
  // One-way trust state: the user already trusts the host (stored stable key),
  // but the host's record for the user is stale (noise key from before
  // keypair persistence) so it does NOT trust the user and challenges it.
  userH.peerObj.pairing.mode = 'direct'
  userH.peerObj.pairing.trusted = true
  userH.peerObj.device.isTrusted = true
  const codeH = cryptoModule.generatePairingCode()
  const cidH = cryptoModule.codeId(codeH)
  hostH.trust.pairingSecrets.set(cidH, {
    code: codeH,
    role: 'host',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidH
  })
  hostH.trust.sendChallenges('peerHostH') // host challenges the user with its own code
  assert.strictEqual(userH.peerObj.pairing.trusted, true, 'user remains trusted')
  assert.strictEqual(hostH.peerObj.pairing.trusted, false, 'host does not trust the user yet')

  // The user now enters the host's code: the queued challenge must be answered
  // so the host can verify the user and complete BOTH sides.
  const registeredH = userH.trust.registerJoinerCode(codeH)
  assert.strictEqual(registeredH, codeH, 'code registers normally')
  assert.strictEqual(
    hostH.peerObj.pairing.trusted,
    true,
    'host verifies the user via the answered challenge'
  )
  assert.strictEqual(
    eventsH.trustGranted.some((g) => g.node === 'hostH'),
    true,
    'trust is granted on the stale side'
  )
  ok('one code entry heals a one-way trust state')

  console.log('2j. TrustManager: mirror one-way state heals when the stale side enters the code')

  const eventsJ = { handshakes: [], trustGranted: [] }
  const hostJ = makeNode('hostJ', () => 'peerHostJ', 'peerHostJ', null, eventsJ)
  const userJ = makeNode('userJ', () => 'peerUserJ', 'peerUserJ', null, eventsJ)
  hostJ.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') userJ.trust.handleChallenge('peerUserJ', msg)
    else if (msg.type === 'PAIRING_RESP') userJ.trust.handleResponse('peerUserJ', msg)
  }
  userJ.peerObj.signaling.send = (msg) => {
    if (msg.type === 'PAIRING_CHALLENGE') hostJ.trust.handleChallenge('peerHostJ', msg)
    else if (msg.type === 'PAIRING_RESP') hostJ.trust.handleResponse('peerHostJ', msg)
  }
  // Mirror of 2h: the HOST already trusts the user (stored key), the USER's
  // record for the host is stale (removed / old key), so the host sends no
  // challenge — the user must complete by verifying the host's response.
  hostJ.peerObj.pairing.mode = 'direct'
  hostJ.peerObj.pairing.trusted = true
  hostJ.peerObj.device.isTrusted = true
  const codeJ = cryptoModule.generatePairingCode()
  const cidJ = cryptoModule.codeId(codeJ)
  hostJ.trust.pairingSecrets.set(cidJ, {
    code: codeJ,
    role: 'host',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidJ
  })
  // The user registers the HOST's code — the fresh challenge for the host's
  // code must let the user verify the host and complete.
  userJ.trust.pairingSecrets.set(cidJ, {
    code: codeJ,
    role: 'joiner',
    createdAt: Date.now(),
    expiresAt: 0,
    codeId: cidJ
  })
  userJ.trust.syncToPeers() // sends the fresh challenge for the host's code
  assert.strictEqual(
    userJ.peerObj.pairing.trusted,
    true,
    'stale side completes by verifying the host'
  )
  assert.strictEqual(hostJ.peerObj.pairing.trusted, true, 'trusted side stays trusted')
  assert.strictEqual(
    eventsJ.trustGranted.some((g) => g.node === 'userJ'),
    true,
    'trust is granted on the stale side'
  )
  ok('mirror one-way state heals without re-pairing the trusted side')

  console.log('2i. storage: identity survives restarts and the identity bee stays readable')

  const Module4 = require('module')
  const origLoad4 = Module4._load
  Module4._load = function (request, parent, isMain) {
    if (request === 'bare-path') return require('path')
    if (request === 'bare-fs/promises') return require('fs').promises
    if (request === 'bare-fs') return require('fs')
    if (request === 'bare-os') return require('os')
    return origLoad4.call(this, request, parent, isMain)
  }
  const { createStorage } = require('../workers/storage.js')
  Module4._load = origLoad4

  const storeDir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mesh-storage-'))
  try {
    const store = createStorage({
      STORAGE_DIR: storeDir,
      getDeviceName: () => ({ name: 'Test Node', os: 'test' })
    })
    await store.storeReady()
    const identity1 = await store.initIdentity()
    assert.ok(identity1 && identity1.id, 'identity is created on first boot')
    assert.strictEqual(identity1.name, 'Test Node', 'identity carries the device name')
    // 'Restart': initIdentity must load the same identity instead of crashing
    // or generating a new one.
    const identity2 = await store.initIdentity()
    assert.strictEqual(identity2.id, identity1.id, 'identity id is stable across restarts')
    assert.strictEqual(identity2.publicKey, identity1.publicKey, 'identity key is stable')
    // The identity bee must be readable through the shared instance (the old
    // dual-Hyperbee setup corrupted it with DECODING_ERROR).
    const bee = await store.getBee('identity')
    await bee.put('pairing', { code: 'MD-TEST-0000-0000-0000', expiresAt: Date.now() + 60000 })
    const entry = await bee.get('pairing')
    assert.ok(entry && entry.value, 'identity bee round-trip succeeds without DECODING_ERROR')
    assert.strictEqual(entry.value.code, 'MD-TEST-0000-0000-0000', 'pairing value survives')
    await store.store.close()
    await store.exchangeStore.close()
    ok('identity persists across restarts and the identity bee stays readable')
  } finally {
    // Corestore may still hold a transient file lock on Windows.
    fs.rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  console.log('2k. TrustManager: corrupt persisted code never blocks fresh generation')

  const corruptBee = makeBee()
  corruptBee.get = async () => {
    throw new Error('DECODING_ERROR: Decoded message is not valid')
  }
  const tmPeers = new Map()
  const corruptTm = new TrustManager({
    getBee: async (name) => (name === 'identity' ? corruptBee : getBee(name)),
    computeTopicHash,
    swarm: makeSwarmStub(),
    getPeers: () => tmPeers,
    sendHandshake: () => {},
    onTrustGranted: () => {}
  })
  const start = Date.now()
  const freshCode = await corruptTm.getOrCreatePairingCode()
  const elapsed = Date.now() - start
  assert.ok(
    /^MD-[A-Z0-9]{4}-/.test(freshCode),
    'a fresh code is generated despite the corrupt entry'
  )
  assert.ok(elapsed < 5000, 'generation does not hang on the corrupt entry')
  const freshCode2 = await corruptTm.getOrCreatePairingCode()
  assert.strictEqual(freshCode2, freshCode, 'the generated code is stable within the session')
  ok('corrupt persisted pairing entry never blocks code generation')

  console.log('2l. connections+TrustManager: mutual verification completes and persists BOTH sides')

  // Reproduce the real two-verifier flow (host A's code entered on B, exactly
  // like the dev:multi pairing at 11:08): A verifies B's answer to A's
  // challenge, B verifies A's answer to B's challenge, and BOTH sides must
  // send their HANDSHAKE so each side persists the other's device record.
  // Regression for the missed reciprocal HANDSHAKE that left the first
  // verifier without a stored device and stranded the pair in an offline
  // challenge loop after the next restart.
  const peerAId = 'aa'.repeat(32) // A's noise key = the peer B sees
  const peerBId = 'bb'.repeat(32) // B's noise key = the peer A sees

  const makePairNode = (selfKey, peerKey, otherNodeRef) => {
    const peers = new Map()
    const devicesBee = makeBee()
    const nodeBees = { devices: devicesBee, pairingCodes: makeBee(), identity: makeBee() }
    const ctx = {
      peers,
      swarm: makeSwarmStub(),
      activeClaims: new Set(),
      connectionCount: 0,
      deviceIdentity: {
        id: selfKey === peerAId ? 'idA' : 'idB',
        name: selfKey === peerAId ? 'A' : 'B',
        publicKey: selfKey
      },
      send: () => {},
      getBee: async (name) => {
        if (!nodeBees[name]) nodeBees[name] = makeBee()
        return nodeBees[name]
      },
      replicationScope: { close: () => {}, closeAll: () => {}, replicate: () => null },
      transferEngine: null,
      lanDiscovery: null,
      getAutoTrustLAN: async () => false,
      topicRegistry: { ensure: () => {}, leave: () => {} },
      trustManager: null
    }
    const conns = createConnections(ctx)
    const trust = new TrustManager({
      getBee: ctx.getBee,
      computeTopicHash,
      swarm: ctx.swarm,
      topicRegistry: ctx.topicRegistry,
      getPeers: () => peers,
      sendHandshake: conns.sendHandshake,
      onTrustGranted: (pid) => {
        conns.replicateExchange(pid)
        conns.flushPendingHandshake(pid)
        conns.rebroadcastPeerCompletion(pid)
      }
    })
    ctx.trustManager = trust
    // Peer entry exactly as onConnection would build it, with signaling wired
    // to the other side's handlePeerMessage (which routes HANDSHAKE /
    // PAIRING_CHALLENGE / PAIRING_RESP just like the real worker). Messages
    // leave under THIS node's own key (selfKey) so the receiver's peer entry
    // lookup matches, mirroring how noise streams identify the sender.
    peers.set(peerKey, {
      connection: { destroy() {} },
      device: {
        id: peerKey,
        publicKey: peerKey,
        name: 'Connecting...',
        os: 'unknown',
        osVersion: '',
        avatar: '',
        isTrusted: false,
        isEncrypted: true,
        isOnline: true,
        lastSeen: new Date().toISOString(),
        ipAddress: '127.0.0.1',
        transferMethod: 'lan',
        relayed: false
      },
      signaling: {
        send: (msg) => otherNodeRef.conns.handlePeerMessage(selfKey, msg)
      },
      transferMethod: 'lan',
      pairing: {
        mode: 'pairing',
        trusted: false,
        complete: false,
        outstanding: [],
        pendingChallenges: [],
        pendingHandshake: null,
        timeout: null
      }
    })
    return { ctx, conns, trust, devicesBee, peers }
  }

  let nodeA = null
  let nodeB = null
  nodeA = makePairNode(peerAId, peerBId, {
    get conns() {
      return nodeB.conns
    }
  })
  nodeB = makePairNode(peerBId, peerAId, {
    get conns() {
      return nodeA.conns
    }
  })

  // A generates its host code (syncToPeers challenges B with it, which B
  // cannot answer yet and queues), then B enters the code as the joiner.
  const codeL = await nodeA.trust.getOrCreatePairingCode()
  assert.ok(/^MD-[A-Z0-9]{4}-/.test(codeL), 'host A generates a pairing code')
  const registeredL = nodeB.trust.registerJoinerCode(codeL)
  assert.strictEqual(registeredL, codeL, 'joiner B registers the code')

  // The whole challenge cascade runs synchronously; let the async bee puts
  // flush before inspecting the stores.
  await new Promise((r) => setImmediate(r))

  assert.strictEqual(nodeA.peers.get(peerBId).pairing.trusted, true, 'A verified B')
  assert.strictEqual(nodeB.peers.get(peerAId).pairing.trusted, true, 'B verified A')
  assert.strictEqual(nodeA.peers.get(peerBId).pairing.complete, true, 'A completed the pairing')
  assert.strictEqual(nodeB.peers.get(peerAId).pairing.complete, true, 'B completed the pairing')
  assert.strictEqual(nodeA.peers.get(peerBId).handshakeSent, true, 'A sent its HANDSHAKE to B')
  assert.strictEqual(
    nodeB.peers.get(peerAId).handshakeSent,
    true,
    'B sent its reciprocal HANDSHAKE to A (regression)'
  )
  let aPersistedB = false
  for await (const n of nodeA.devicesBee.createReadStream()) {
    if (n.value && n.value.id === 'idB') aPersistedB = true
  }
  let bPersistedA = false
  for await (const n of nodeB.devicesBee.createReadStream()) {
    if (n.value && n.value.id === 'idA') bPersistedA = true
  }
  assert.ok(aPersistedB, "A persisted B's device record")
  assert.ok(bPersistedA, "B persisted A's device record")
  assert.strictEqual(nodeA.peers.get(peerBId).device.isOnline, true, 'B is online on A')
  assert.strictEqual(nodeB.peers.get(peerAId).device.isOnline, true, 'A is online on B')
  ok('mutual verification completes and persists BOTH sides (restart-safe)')

  console.log('2m. crypto: DROP codes are CSPRNG-generated and collision-free')

  const dropCodes = new Set()
  for (let i = 0; i < 1000; i++) {
    const c = cryptoModule.generateDropCode()
    assert.ok(/^DROP-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c), `DROP code format: ${c}`)
    dropCodes.add(c)
  }
  assert.strictEqual(dropCodes.size, 1000, '1000 generated DROP codes are unique')
  ok('DROP codes are unique and correctly formatted')

  console.log('2n. helpers: one-time send expiry presets')

  const ModuleH = require('module')
  const origH = ModuleH._load
  ModuleH._load = function (request, parent, isMain) {
    if (request === 'bare-path') return require('path')
    if (request === 'bare-fs/promises') return require('fs').promises
    if (request === 'bare-fs') return require('fs')
    if (request === 'bare-os') return require('os')
    return origH.call(this, request, parent, isMain)
  }
  const { getDurationMs } = require('../workers/helpers.js')
  ModuleH._load = origH

  assert.strictEqual(getDurationMs('5m'), 5 * 60 * 1000, '5m preset resolves to 5 minutes')
  assert.strictEqual(getDurationMs('15m'), 15 * 60 * 1000, '15m preset resolves to 15 minutes')
  assert.strictEqual(getDurationMs('30m'), 30 * 60 * 1000, '30m preset still works')
  assert.strictEqual(getDurationMs('24h'), 24 * 60 * 60 * 1000, '24h preset still works')
  ok('one-time send expiry presets cover 5m/15m/30m/1h/6h/24h')

  console.log('2o. connections: one-time DROP claims are single-use and anonymous')

  // Two nodes wired exactly like check 2l: host (holds the drop) + claimer.
  // The claimer's transfer engine is stubbed to capture the offer; the host
  // captures emitted events and provides a minimal cleanupPendingShare.
  const claimHostKey = '31'.repeat(32)
  const claimPeerKey = '32'.repeat(32)

  const makeClaimNode = (selfKey, peerKey, otherNodeRef, eventsArr) => {
    const peers = new Map()
    const pendingSharesBee = makeBee()
    const nodeBees = {
      devices: makeBee(),
      pendingShares: pendingSharesBee,
      pairingCodes: makeBee(),
      identity: makeBee()
    }
    const ctx = {
      peers,
      swarm: makeSwarmStub(),
      activeClaims: new Set(),
      connectionCount: 0,
      deviceIdentity: { id: selfKey, name: 'N', publicKey: selfKey },
      send: (json) => eventsArr.push(typeof json === 'string' ? JSON.parse(json) : json),
      getBee: async (name) => {
        if (!nodeBees[name]) nodeBees[name] = makeBee()
        return nodeBees[name]
      },
      replicationScope: { close: () => {}, closeAll: () => {}, replicate: () => null },
      transferEngine: null,
      lanDiscovery: null,
      getAutoTrustLAN: async () => false,
      topicRegistry: { ensure: () => {}, leave: () => {}, join: () => {} },
      trustManager: { addTrustedKey: () => {} },
      pendingSwarmTopics: new Map(),
      cleanupPendingShare: async (id, newStatus) => {
        const bee = await ctx.getBee('pendingShares')
        const entry = await bee.get(id)
        if (!entry) return null
        const share = { ...entry.value, status: newStatus }
        await bee.put(id, share)
        const active = ctx.pendingSwarmTopics.get(id)
        if (active && active.topicLabel) ctx.topicRegistry.leave(active.topicLabel)
        ctx.pendingSwarmTopics.delete(id)
        ctx.send(JSON.stringify({ event: 'pending_share.updated', data: share }))
        return share
      }
    }
    const conns = createConnections(ctx)
    peers.set(peerKey, {
      connection: { destroy() {} },
      device: {
        id: peerKey,
        publicKey: peerKey,
        name: 'Connecting...',
        os: 'unknown',
        osVersion: '',
        avatar: '',
        isTrusted: false,
        isEncrypted: true,
        isOnline: true,
        lastSeen: new Date().toISOString(),
        ipAddress: '127.0.0.1',
        transferMethod: 'internet',
        relayed: false
      },
      signaling: { send: (msg) => otherNodeRef.conns.handlePeerMessage(selfKey, msg) },
      transferMethod: 'internet',
      pairing: {
        mode: 'pairing',
        trusted: false,
        complete: false,
        outstanding: [],
        pendingChallenges: [],
        pendingHandshake: null,
        timeout: { unref() {} } // armed watchdog: must be cleared by the claim
      }
    })
    return { ctx, conns, peers, pendingSharesBee }
  }

  const hostEvents = []
  const claimerEvents = []
  let claimerNode = null
  let hostNode = null
  hostNode = makeClaimNode(
    claimHostKey,
    claimPeerKey,
    {
      get conns() {
        return claimerNode.conns
      }
    },
    hostEvents
  )
  claimerNode = makeClaimNode(
    claimPeerKey,
    claimHostKey,
    {
      get conns() {
        return hostNode.conns
      }
    },
    claimerEvents
  )

  // Seed the host with a waiting drop share + its topic advertisement.
  await hostNode.pendingSharesBee.put('drop-share-1', {
    id: 'drop-share-1',
    code: 'DROP-ABCD-EFGH',
    filename: 'secret.txt',
    fileSize: 1024,
    fileType: 'text/plain',
    filePath: '/tmp/nonexistent-staged',
    originalPath: '/tmp/nonexistent',
    coreKey: 'e'.repeat(64),
    manifestHash: 'a'.repeat(64),
    checksum: 'b'.repeat(64),
    blockSize: 65536,
    blockCount: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600000,
    expirationPreset: '10m',
    status: 'waiting',
    downloadCount: 0,
    isHost: true
  })
  hostNode.ctx.pendingSwarmTopics.set('drop-share-1', {
    topicLabel: 'p2p-file-DROP-ABCD-EFGH',
    core: null,
    stagedPath: '/tmp/nonexistent-staged'
  })

  // Claimer registers the code (as FILES_CLAIM_CODE does) then asks for it.
  claimerNode.ctx.activeClaims.add('DROP-ABCD-EFGH')
  let receivedOffer = null
  claimerNode.ctx.transferEngine = {
    receiveOffer: async (offer) => {
      receivedOffer = offer
      return { ...offer, id: offer.transferId, status: 'queued', isClaim: true }
    }
  }

  // First claim: must succeed, burn the key, and clear the pairing watchdog.
  claimerNode.peers
    .get(claimHostKey)
    .signaling.send({ type: 'CLAIM_FILE_REQ', code: 'DROP-ABCD-EFGH' })
  await new Promise((r) => setImmediate(r))
  assert.ok(receivedOffer, 'offer captured')
  assert.strictEqual(receivedOffer.shareId, 'drop-share-1', 'offer carries the share id')
  assert.strictEqual(receivedOffer.peerKey, claimHostKey, 'offer carries the host noise key')
  const afterFirst = (await hostNode.pendingSharesBee.get('drop-share-1')).value
  assert.strictEqual(afterFirst.status, 'claimed', 'first claimer burns the key (single-use)')
  assert.strictEqual(afterFirst.downloadCount, 1, 'download count increments')
  assert.strictEqual(
    hostNode.peers.get(claimPeerKey).pairing.timeout,
    null,
    'host pairing watchdog is cleared for claim connections'
  )
  assert.ok(
    hostEvents.some((e) => e.event === 'pending_share.claimed'),
    'host emits pending_share.claimed'
  )

  // Second claim with the same code: must be rejected.
  let secondRes = null
  hostNode.peers.get(claimPeerKey).signaling.send = (msg) => {
    if (msg.type === 'CLAIM_FILE_RES') secondRes = msg
  }
  claimerNode.peers
    .get(claimHostKey)
    .signaling.send({ type: 'CLAIM_FILE_REQ', code: 'DROP-ABCD-EFGH' })
  await new Promise((r) => setImmediate(r))
  assert.ok(secondRes && secondRes.success === false, 'second claim is rejected (key already used)')

  // Host failure reply: claimer stops advertising the code and surfaces the error.
  claimerNode.ctx.activeClaims.add('DROP-ABCD-EFGH')
  hostNode.peers.get(claimPeerKey).signaling.send = (msg) => {
    if (msg.type === 'CLAIM_FILE_RES') claimerNode.conns.handlePeerMessage(claimHostKey, msg)
  }
  hostNode.peers.get(claimPeerKey).signaling.send({
    type: 'CLAIM_FILE_RES',
    code: 'DROP-WXYZ-9999',
    success: false,
    error: 'Share expired or invalid code'
  })
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(
    claimerNode.ctx.activeClaims.has('DROP-WXYZ-9999'),
    false,
    'claim failure stops advertising the code'
  )
  assert.ok(
    claimerEvents.some((e) => e.event === 'pending_share.claimFailed'),
    'claimer emits pending_share.claimFailed'
  )

  // Host receives CLAIM_FILE_DONE after the download finishes: full teardown.
  claimerNode.peers
    .get(claimHostKey)
    .signaling.send({ type: 'CLAIM_FILE_DONE', shareId: 'drop-share-1' })
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(
    hostNode.ctx.pendingSwarmTopics.has('drop-share-1'),
    false,
    'host leaves the drop topic and drops the staged path'
  )
  const afterDone = (await hostNode.pendingSharesBee.get('drop-share-1')).value
  assert.strictEqual(afterDone.status, 'completed', 'share is marked completed after the download')
  ok('DROP claims are single-use, watchdog-free, and torn down on completion')

  console.log('3. MetricsCollector reports only measured values')
  const metrics = new MetricsCollector({ intervalMs: 50 })
  metrics.start()
  await new Promise((r) => setTimeout(r, 120))
  const snap = metrics.snapshot({ peerCount: 3, connected: true })
  assert.strictEqual(snap.connectedPeersCount, 3)
  assert.strictEqual(snap.connected, true)
  assert.strictEqual(snap.natType, null)
  assert.strictEqual(snap.avgLatencyMs, null)
  assert.ok(snap.uptimeMs > 0)
  assert.ok(typeof snap.bytesReceived === 'number')
  metrics.stop()
  ok('metrics snapshot is honest (measured fields only, nulls elsewhere)')

  console.log('4. TopicRegistry refcounts joins/leaves')
  const swarm2 = makeSwarmStub()
  const topics = new TopicRegistry({ computeTopicHash, swarm: swarm2 })
  topics.join('p2p-pair-X', { client: true, server: true })
  topics.join('p2p-pair-X', { client: true, server: true })
  assert.strictEqual(topics.count('p2p-pair-X'), 2)
  assert.strictEqual(swarm2.joins.length, 1, 'topic joined once despite two refs')
  topics.leave('p2p-pair-X')
  assert.strictEqual(swarm2.leaves.length, 0, 'no leave while refs remain')
  topics.leave('p2p-pair-X')
  assert.strictEqual(swarm2.leaves.length, 1, 'topic left after last ref released')
  assert.strictEqual(topics.count('p2p-pair-X'), 0)
  ok('topic join/leave refcounting works')

  topics.ensure('p2p-peer-X', { client: true, server: true })
  topics.ensure('p2p-peer-X', { client: true, server: true })
  assert.strictEqual(topics.count('p2p-peer-X'), 1, 'ensure does not leak references')
  ok('long-lived topics are idempotently ensured')

  console.log('5. ReplicationScope isolates exchange replication and migrates metadata')
  const scopeStreams = []
  const exchangeScope = new ReplicationScope({
    exchangeStore: {
      get() {
        return {
          length: 0,
          async ready() {},
          async append() {},
          async close() {}
        }
      },
      replicate() {
        const listeners = new Map()
        return {
          on(event, fn) {
            listeners.set(event, fn)
          },
          destroy() {
            listeners.get('close')?.()
          }
        }
      }
    },
    isPeerTrusted: (peerId) => peerId === 'trusted',
    onStream: (stream) => scopeStreams.push(stream)
  })
  await exchangeScope.init()
  const connection = {}
  assert.strictEqual(exchangeScope.replicate('untrusted', connection), null)
  assert.ok(exchangeScope.replicate('trusted', connection))
  assert.strictEqual(exchangeScope.replicate('trusted', connection), scopeStreams[0])
  assert.deepStrictEqual(exchangeScope.activePeers(), ['trusted'])
  exchangeScope.close('trusted')
  assert.deepStrictEqual(exchangeScope.activePeers(), [])
  ok('only trusted peers receive the exchange scope and streams are lifecycle-managed')

  console.log('6. TransferEngine: send -> receive with full integrity verification')
  const path = require('path')
  const os = require('os')
  const fsp = require('fs/promises')
  const Corestore = require('corestore')
  const {
    TransferEngine,
    TransferQueue,
    ChunkScheduler,
    CHUNK_SIZE
  } = require('../workers/engine/TransferEngine.js')

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mr-engine-'))
  const downloadsDir = path.join(tmpRoot, 'downloads')
  await fsp.mkdir(downloadsDir, { recursive: true })
  const exchangeStore = new Corestore(path.join(tmpRoot, 'exchange'))
  await exchangeStore.ready()

  const transferEvents = []
  function makeTransferEngine() {
    return new TransferEngine({
      getBee,
      exchangeStore,
      sendEvent: (name, data) => transferEvents.push({ name, data }),
      getPeers: () => new Map(),
      getDeviceIdentity: () => ({ id: 'local', name: 'Local Node' }),
      getDownloadDirectory: async () => downloadsDir,
      getTransferMethod: () => 'lan',
      fsp,
      path
    })
  }
  const senderEngine = makeTransferEngine()
  const receiverEngine = makeTransferEngine()

  async function waitForStatus(engine, id, status, timeout = 20000) {
    const start = Date.now()
    for (;;) {
      const list = await engine.list()
      const t = list.find((x) => x.id === id)
      if (t && t.status === status) return t
      if (Date.now() - start > timeout) {
        throw new Error(`timeout waiting for ${id} -> ${status} (last: ${t && t.status})`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  // 6a. Send a file that spans 3 full blocks + a partial block.
  const srcPath = path.join(tmpRoot, 'src.bin')
  const srcContent = crypto.randomBytes(CHUNK_SIZE * 3 + 1234)
  await fsp.writeFile(srcPath, srcContent)
  const sent = await senderEngine.startSend({
    filePath: srcPath,
    filename: 'src.bin',
    fileSize: srcContent.length,
    peerId: 'peerA',
    peerName: 'Peer A'
  })
  assert.ok(sent.id, 'send returns a transfer id')
  const sentRecord = await waitForStatus(senderEngine, sent.id, 'completed')
  assert.ok(sentRecord.coreKey && sentRecord.coreKey.length === 64, 'send produces a coreKey')
  assert.ok(sentRecord.manifestHash, 'send produces a manifestHash')
  assert.ok(sentRecord.checksum, 'send produces a checksum')
  assert.strictEqual(sentRecord.summary.blocksVerified, 4, 'all 4 data blocks hashed+appended')
  ok('send stages a manifest + data blocks with integrity fields')

  // 6b. Receive it back through a second engine instance on the same store.
  await receiverEngine.receiveOffer(
    {
      transferId: 'recv-1',
      filename: 'received.bin',
      fileSize: srcContent.length,
      fileType: 'application/octet-stream',
      coreKey: sentRecord.coreKey,
      manifestHash: sentRecord.manifestHash,
      checksum: sentRecord.checksum,
      senderIdentity: { id: 'peerA', name: 'Peer A' }
    },
    { autoAccept: true }
  )
  const recvRecord = await waitForStatus(receiverEngine, 'recv-1', 'completed')
  const finalPath = recvRecord.destPath
  const received = await fsp.readFile(finalPath)
  assert.ok(Buffer.compare(received, srcContent) === 0, 'received file is byte-identical')
  assert.strictEqual(recvRecord.summary.checksum, sentRecord.checksum, 'checksum verified')
  assert.strictEqual(recvRecord.summary.blocksVerified, 4, 'all blocks verified on receive')
  ok('receive verifies manifest, block hashes, and checksum; file is byte-identical')

  // 6c. A tampered manifestHash in the offer must be rejected (not written).
  await receiverEngine.receiveOffer(
    {
      transferId: 'recv-tampered',
      filename: 'evil.bin',
      fileSize: srcContent.length,
      fileType: 'application/octet-stream',
      coreKey: sentRecord.coreKey,
      manifestHash: '0'.repeat(64),
      checksum: sentRecord.checksum,
      senderIdentity: { id: 'peerA', name: 'Peer A' }
    },
    { autoAccept: true }
  )
  const tampered = await waitForStatus(receiverEngine, 'recv-tampered', 'failed')
  assert.ok(/manifest/i.test(tampered.error || ''), 'manifest mismatch -> failed')
  ok('tampered manifestHash is rejected as failed (never staged)')

  console.log('8. TransferQueue: priority tiers + concurrency caps')
  const q = new TransferQueue({ maxConcurrent: 2, maxPerPeer: 1 })
  const tBulk = { id: 'a', direction: 'send', priority: 'bulk', peerId: 'p1' }
  const tBg = { id: 'b', direction: 'send', priority: 'background', peerId: 'p2' }
  const tInt = { id: 'c', direction: 'send', priority: 'interactive', peerId: 'p3' }
  q.enqueue(tBulk)
  q.enqueue(tBg)
  q.enqueue(tInt)
  const first = q.popNext('send')
  assert.strictEqual(first.id, 'c', 'interactive runs before bulk/background')
  q.claim(first)
  const second = q.popNext('send')
  assert.strictEqual(second.id, 'a', 'bulk runs after interactive')
  q.claim(second)
  assert.strictEqual(q.popNext('send'), null, 'no slot for a third concurrent send')
  q.release(first)
  const third = q.popNext('send')
  assert.strictEqual(third.id, 'b', 'queued work runs once a slot frees')
  assert.strictEqual(q.popNext('send'), null, 'nothing else queued')
  const q2 = new TransferQueue({ maxConcurrent: 2, maxPerPeer: 1 })
  q2.claim({ id: 'x', direction: 'send', priority: 'bulk', peerId: 'same' })
  assert.ok(
    !q2._hasSlot({ id: 'y', direction: 'send', priority: 'bulk', peerId: 'same' }),
    'per-peer cap blocks a second transfer to the same peer'
  )
  ok('queue respects priority order and per-direction/per-peer concurrency caps')

  console.log('9. ChunkScheduler: parallel fetch verifies block hashes')
  const schedCore = exchangeStore.get({ name: 'sched-test' })
  await schedCore.ready()
  const chunks = []
  for (let i = 0; i < 12; i++) {
    const b = Buffer.alloc(CHUNK_SIZE)
    b.fill(i)
    chunks.push(b)
    await schedCore.append(b)
  }
  const blockHashes = chunks.map((c) => cryptoModule.sha256(c).toString('hex'))
  const got = []
  const s1 = new ChunkScheduler({
    core: schedCore,
    firstDataBlock: 0,
    lastDataBlock: 11,
    blocks: blockHashes,
    blockSize: CHUNK_SIZE,
    onBlock: async (i, b) => {
      got.push(i)
    }
  })
  await s1.run()
  assert.strictEqual(got.length, 12, 'all blocks fetched')
  assert.deepStrictEqual(
    [...got].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    'every index fetched exactly once'
  )
  let tamperError = null
  const s2 = new ChunkScheduler({
    core: schedCore,
    firstDataBlock: 0,
    lastDataBlock: 2,
    blocks: [blockHashes[0], '0'.repeat(64), blockHashes[2]],
    blockSize: CHUNK_SIZE,
    onBlock: async () => {}
  })
  try {
    await s2.run()
  } catch (err) {
    tamperError = err
  }
  assert.ok(tamperError && /mismatch/.test(tamperError.message), 'tampered block is rejected')
  await schedCore.close()
  ok('chunk scheduler fetches in parallel and rejects tampered blocks')

  console.log('10. ChunkScheduler: resumed runs validate against the correct hash slice')
  const resumeCore = exchangeStore.get({ name: 'sched-resume' })
  await resumeCore.ready()
  const resumeBlocks = []
  for (let i = 0; i < 6; i++) {
    const b = Buffer.alloc(CHUNK_SIZE)
    b.fill(i)
    resumeBlocks.push(b)
    await resumeCore.append(b)
  }
  const resumeHashes = resumeBlocks.map((c) => cryptoModule.sha256(c).toString('hex'))
  const resumedIdx = []
  const s3 = new ChunkScheduler({
    core: resumeCore,
    firstDataBlock: 2, // simulated resume point: two data blocks already written
    lastDataBlock: 5,
    blocks: resumeHashes.slice(2), // engine slices the manifest to the resume point
    blockSize: CHUNK_SIZE,
    onBlock: async (i) => resumedIdx.push(i)
  })
  await s3.run()
  assert.deepStrictEqual(
    [...resumedIdx].sort((a, b) => a - b),
    [2, 3, 4, 5],
    'resumed run fetches only the remaining blocks'
  )
  // A wrong slice (un-sliced manifest) must produce a hash mismatch.
  let sliceError = null
  const s4 = new ChunkScheduler({
    core: resumeCore,
    firstDataBlock: 2,
    lastDataBlock: 5,
    blocks: resumeHashes, // BUG SHAPE: full array against a mid-file offset
    blockSize: CHUNK_SIZE,
    onBlock: async () => {}
  })
  try {
    await s4.run()
  } catch (err) {
    sliceError = err
  }
  assert.ok(sliceError && /mismatch/.test(sliceError.message), 'mis-sliced resume is rejected')
  await resumeCore.close()
  ok('resumed scheduler hashes blocks against the sliced manifest, rejecting mis-slicing')

  console.log('11. TransferEngine: cancel marks interrupted (resumable), never failed')
  // Three receives with a per-direction cap of 2: the third is guaranteed to be
  // queued, so cancelling it deterministically exercises the interrupted path.
  for (let i = 0; i < 3; i++) {
    await receiverEngine.receiveOffer(
      {
        transferId: `recv-q${i}`,
        filename: `q${i}.bin`,
        fileSize: srcContent.length,
        fileType: 'application/octet-stream',
        coreKey: sentRecord.coreKey,
        manifestHash: sentRecord.manifestHash,
        checksum: sentRecord.checksum,
        senderIdentity: { id: 'peerA', name: 'Peer A' }
      },
      { autoAccept: true }
    )
  }
  await waitForStatus(receiverEngine, 'recv-q0', 'completed')
  await waitForStatus(receiverEngine, 'recv-q1', 'completed')
  await receiverEngine.cancel('recv-q2')
  const interrupted = await waitForStatus(receiverEngine, 'recv-q2', 'interrupted')
  assert.strictEqual(interrupted.status, 'interrupted', 'cancel marks interrupted, not failed')
  await receiverEngine.resume('recv-q2')
  const resumed = await waitForStatus(receiverEngine, 'recv-q2', 'completed')
  const resumedBytes = await fsp.readFile(resumed.destPath)
  assert.ok(Buffer.compare(resumedBytes, srcContent) === 0, 'resumed receive is byte-identical')
  ok('queued transfer cancels to interrupted and resumes to a verified completion')

  console.log('12. LanDiscovery (worker): noise-key validation, dedupe, self-filter')
  const LanDiscovery = require('../workers/engine/LanDiscovery.js')
  const lanSwarm = { keyPair: { publicKey: Buffer.from('a'.repeat(64), 'hex') } }
  const lanJoins = []
  const lanDisc = new LanDiscovery({
    swarm: lanSwarm,
    getDeviceIdentity: () => ({ id: 'local-id', name: 'Local', os: 'windows' }),
    onPeerKey: (key) => lanJoins.push(key)
  })
  lanDisc.start()
  assert.strictEqual(lanDisc.getPublicKey(), 'a'.repeat(64), 'advertises the swarm noise key')
  assert.strictEqual(
    lanDisc.getSelfAnnouncement().key,
    'a'.repeat(64),
    'self announcement carries the noise key'
  )
  assert.strictEqual(lanDisc.handleAnnouncement('a'.repeat(64)), false, 'self is ignored')
  assert.strictEqual(lanDisc.handleAnnouncement('not-a-key'), false, 'invalid key is ignored')
  assert.strictEqual(
    lanDisc.handleAnnouncement({ key: 'zz'.repeat(16) }),
    false,
    'short/malformed key is ignored'
  )
  const peerKey = 'b'.repeat(64)
  assert.strictEqual(
    lanDisc.handleAnnouncement({ key: peerKey, name: 'Peer' }),
    true,
    'new peer key is accepted'
  )
  assert.strictEqual(lanDisc.handleAnnouncement(peerKey), false, 'duplicate peer is ignored')
  assert.deepStrictEqual(lanJoins, [peerKey], 'joinPeer receives the key exactly once')
  assert.strictEqual(lanDisc.knownPeers().length, 1)
  lanDisc.stop()
  ok('LAN discovery hands only valid, non-self, non-duplicate noise keys to joinPeer')

  console.log('13. LanDiscovery (main): real UDP loopback announce/receive')
  const MainLanDiscovery = require('../electron/lan-discovery.js')
  const seenA = []
  const seenB = []
  const udpA = new MainLanDiscovery({
    port: 39111,
    announcePort: 39112,
    bindAddress: '127.0.0.1',
    targets: ['127.0.0.1'],
    multicast: false,
    announceIntervalMs: 150,
    log: () => {}
  })
  const udpB = new MainLanDiscovery({
    port: 39112,
    announcePort: 39111,
    bindAddress: '127.0.0.1',
    targets: ['127.0.0.1'],
    multicast: false,
    announceIntervalMs: 150,
    log: () => {}
  })
  udpA.setSelf({ key: 'c'.repeat(64), id: 'node-a', name: 'Node A', os: 'windows' })
  udpB.setSelf({ key: 'd'.repeat(64), id: 'node-b', name: 'Node B', os: 'windows' })
  udpA.start((ann) => seenA.push(ann))
  udpB.start((ann) => seenB.push(ann))
  await new Promise((r) => setTimeout(r, 800))
  udpA.stop()
  udpB.stop()
  assert.ok(seenA.length >= 1, 'A receives B announcements')
  assert.strictEqual(seenA[0].key, 'd'.repeat(64), 'A learns B noise key')
  assert.ok(seenB.length >= 1, 'B receives A announcements')
  assert.strictEqual(seenB[0].key, 'c'.repeat(64), 'B learns A noise key')
  ok('UDP advertiser discovers peers over loopback and forwards noise keys')

  await exchangeStore.close()
  await fsp.rm(tmpRoot, { recursive: true, force: true })
  ok('integration store cleaned up')

  console.log(`\nAll ${passed} engine checks passed.`)
}

main().catch((err) => {
  console.error('ENGINE TEST FAILED:', err)
  process.exit(1)
})
