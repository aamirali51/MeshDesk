'use strict'

// Worker storage: the private metadata Corestore, the exchange (file-only)
// Corestore, Hyperbee factories, topic hashing, and identity management.

const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const path = require('bare-path')
const { deriveDeviceId } = require('./shared/crypto.js')

function createStorage({ STORAGE_DIR, getDeviceName }) {
  // Private metadata store (identity, devices, history, settings). NEVER
  // replicated. Only the exchange store is exposed to authenticated peers.
  const store = new Corestore(path.join(STORAGE_DIR, 'corestore'))
  const exchangeStore = new Corestore(path.join(STORAGE_DIR, 'exchange'))

  // Cache Hyperbee instances — one per named bee, not one per call
  const beeCache = new Map()

  async function getBee(name) {
    if (beeCache.has(name)) return beeCache.get(name)
    const core = store.get({ name })
    await core.ready()
    const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    beeCache.set(name, bee)
    return bee
  }

  // Compute a 32-byte DHT topic hash for a given label string
  function computeTopicHash(label) {
    let cryptoModule
    try {
      cryptoModule = require('hypercore-crypto')
    } catch {
      try {
        cryptoModule = require('crypto')
      } catch {
        cryptoModule = null
      }
    }
    if (cryptoModule && typeof cryptoModule.data === 'function') {
      return cryptoModule.data(Buffer.from(label))
    } else if (cryptoModule && typeof cryptoModule.createHash === 'function') {
      return cryptoModule.createHash('sha256').update(label).digest()
    } else {
      const buf = Buffer.alloc(32)
      buf.write(label)
      return buf
    }
  }

  let deviceIdentity = null

  async function initIdentity() {
    // Reuse the cached 'identity' bee. A second Hyperbee instance over the
    // same core (as done before) corrupted the store: two instances append
    // their own operations and reads fail with DECODING_ERROR.
    const identityCore = store.get({ name: 'identity' })
    await identityCore.ready() // .key is only populated once the core is ready
    const bee = await getBee('identity')

    const derivedId = deriveDeviceId(identityCore.key.toString('hex'))
    let identity = await bee.get('device')
    const info = getDeviceName()
    if (!identity) {
      identity = {
        id: derivedId,
        publicKey: identityCore.key.toString('hex'),
        name: info.name,
        os: info.os,
        createdAt: Date.now()
      }
      await bee.put('device', identity)
    } else {
      // Keep device name updated with current instance label
      identity = identity.value || identity
      // Migrate legacy id (identity core key slice) to the non-derivable derived id
      if (identity.id !== derivedId) {
        identity.id = derivedId
        await bee.put('device', identity)
      }
      if (info.name && identity.name !== info.name) {
        identity.name = info.name
        await bee.put('device', identity)
      }
    }

    deviceIdentity = identity.value || identity

    // Note: pairing codes are now generated on demand (DEVICES_GET_CODE /
    // DEVICES_GET_IDENTITY) and joined only when a code is actively shown.
    return deviceIdentity
  }

  async function storeReady() {
    await store.ready()
    await exchangeStore.ready()
  }

  return {
    store,
    exchangeStore,
    getBee,
    computeTopicHash,
    initIdentity,
    getDeviceIdentity: () => deviceIdentity,
    setDeviceIdentity: (v) => {
      deviceIdentity = v
    },
    storeReady
  }
}

module.exports = { createStorage }
