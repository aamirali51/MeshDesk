'use strict'

// TransferEngine replaces the inline transfer loops that used to live in
// workers/main.js. It owns:
//   - TransferQueue  : persistent, priority-ordered scheduler
//   - ChunkScheduler : parallel block fetch with adaptive window
//   - IntegrityLayer : SHA-256 block manifest + whole-file checksum
//   - Resume         : same core, stored (coreKey, byteOffset)
//   - Cancel         : marks `interrupted` (resumable), never `failed`
//   - Collision      : per-transfer staging dir + atomic rename on verify
//
// fs/path are injected so the module runs in the Bare worker (bare-fs) and in
// the plain-Node integration test (node:fs). Nothing here fabricates data:
// every status/progress/checksum reflects real bytes read or written.

const { sha256 } = require('../shared/crypto.js')
const { EVENTS } = require('../../src/shared/protocol.js')

const CHUNK_SIZE = 64 * 1024 // block size used for the integrity manifest
const MANIFEST_V = 1
const MIN_WINDOW = 8
const MAX_WINDOW = 64
const DEFAULT_PRIORITY = 'bulk'
const MAX_CONCURRENT = 2 // max active transfers per direction (global)
const MAX_PER_PEER = 1 // max active transfers per direction per peer
const MAX_TRANSFER_SIZE = 500 * 1024 * 1024 * 1024 // 500 GB hard cap

const STATUS = {
  QUEUED: 'queued',
  ACTIVE: 'active',
  PAUSED: 'paused',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  PENDING_APPROVAL: 'pending_approval'
}

const SCHEMA_VERSION = 'transfer.2'
const SCHEMA_KEY = '__meta__'

const TERMINAL = new Set([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, STATUS.INTERRUPTED])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getFileType(filename) {
  const ext = String(filename || '')
    .split('.')
    .pop()
    .toLowerCase()
  const mime = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    txt: 'text/plain',
    json: 'application/json',
    js: 'application/javascript',
    html: 'text/html',
    css: 'text/css',
    md: 'text/markdown'
  }
  return mime[ext] || 'application/octet-stream'
}

function safeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
}

// ─── IntegrityLayer ────────────────────────────────────────────────────────

// Build the canonical manifest block (block 0 of a transfer core) by streaming
// the file once: every CHUNK_SIZE block gets a SHA-256 hash, and the whole-file
// checksum is the SHA-256 of the concatenated block hashes.
async function buildManifest({ filePath, fsp, filename, fileSize, fileType, transferId }) {
  const blocks = []
  const blockSize = CHUNK_SIZE
  const fd = await fsp.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(blockSize)
    let offset = 0
    while (offset < fileSize) {
      const { bytesRead } = await fd.read(buf, 0, blockSize, offset)
      if (bytesRead === 0) break
      blocks.push(sha256(buf.subarray(0, bytesRead)).toString('hex'))
      offset += bytesRead
    }
  } finally {
    await fd.close()
  }

  const manifest = {
    v: MANIFEST_V,
    type: 'file-transfer',
    transferId,
    filename,
    fileSize,
    fileType: fileType || getFileType(filename),
    blockSize,
    blockCount: blocks.length,
    blocks,
    checksum: sha256(Buffer.concat(blocks.map((h) => Buffer.from(h, 'hex')))).toString('hex'),
    createdAt: Date.now()
  }
  const manifestHash = sha256(JSON.stringify(manifest)).toString('hex')
  return { manifest, manifestHash }
}

function parseManifest(raw) {
  try {
    const manifest = JSON.parse(raw)
    if (
      !manifest ||
      manifest.v !== MANIFEST_V ||
      typeof manifest.blockSize !== 'number' ||
      !Array.isArray(manifest.blocks)
    ) {
      return null
    }
    return manifest
  } catch {
    return null
  }
}

// ─── TransferQueue ─────────────────────────────────────────────────────────

class TransferQueue {
  constructor({ maxConcurrent = MAX_CONCURRENT, maxPerPeer = MAX_PER_PEER } = {}) {
    this.maxConcurrent = maxConcurrent
    this.maxPerPeer = maxPerPeer
    this.queued = { interactive: [], bulk: [], background: [] } // priority tier -> [transfer]
    this.active = { send: 0, receive: 0 } // running count per direction
    this.activeByPeer = new Map() // peerId -> { send: 0, receive: 0 }
  }

  enqueue(transfer) {
    const tier = this.queued[transfer.priority] || this.queued[DEFAULT_PRIORITY]
    transfer.queuedAt = transfer.queuedAt || Date.now()
    tier.push(transfer)
  }

  // Highest-priority queued transfer whose slots are free, or null.
  popNext(direction) {
    for (const tier of [this.queued.interactive, this.queued.bulk, this.queued.background]) {
      for (let i = 0; i < tier.length; i++) {
        const t = tier[i]
        if (t.direction !== direction) continue
        if (this._hasSlot(t)) {
          tier.splice(i, 1)
          return t
        }
      }
    }
    return null
  }

  size() {
    return this.queued.interactive.length + this.queued.bulk.length + this.queued.background.length
  }

  claim(transfer) {
    const dir = transfer.direction
    this.active[dir]++
    const key = transfer.peerId || 'anon'
    const entry = this.activeByPeer.get(key) || { send: 0, receive: 0 }
    entry[dir]++
    this.activeByPeer.set(key, entry)
  }

  release(transfer) {
    const dir = transfer.direction
    this.active[dir] = Math.max(0, this.active[dir] - 1)
    const key = transfer.peerId || 'anon'
    const entry = this.activeByPeer.get(key)
    if (entry) {
      entry[dir] = Math.max(0, entry[dir] - 1)
      if (entry.send === 0 && entry.receive === 0) this.activeByPeer.delete(key)
    }
  }

  _hasSlot(transfer) {
    const dir = transfer.direction
    if (this.active[dir] >= this.maxConcurrent) return false
    const key = transfer.peerId || 'anon'
    const entry = this.activeByPeer.get(key)
    return !entry || entry[dir] < this.maxPerPeer
  }
}

// ─── ChunkScheduler ────────────────────────────────────────────────────────

// Parallel, adaptive block fetcher. Starts with an 8-wide window and grows up
// to 64 on clean runs, shrinking on timeout/errors. Blocks hash-verify as they
// land; offsets are written positionally so order of completion does not matter.
// Errors (timeouts, checksum mismatches, cancellation) are thrown and must be
// handled by the caller.
class ChunkScheduler {
  constructor({ core, firstDataBlock, lastDataBlock, blocks, blockSize, onBlock }) {
    this.core = core
    this.first = firstDataBlock
    this.last = lastDataBlock
    this.blocks = blocks // manifest.blocks[0] corresponds to core block firstDataBlock
    this.blockSize = blockSize
    this.onBlock = onBlock // async (coreIndex, block) => void (write + hash)
    this.window = MIN_WINDOW
    this.cancelled = false
    this.paused = false
  }

  cancel() {
    this.cancelled = true
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
  }

  async fetchBlock(coreIndex) {
    let attempts = 0
    for (;;) {
      if (this.cancelled) return null
      try {
        const block = await this.core.get(coreIndex, { wait: true, timeout: 15000 })
        if (!block) throw new Error('empty block')
        return block
      } catch (err) {
        attempts++
        if (this.cancelled || attempts >= 5) throw err
        try {
          await this.core.update({ wait: false })
        } catch {}
        await sleep(50 * attempts)
      }
    }
  }

  async run() {
    let next = this.first
    let failures = 0
    const inflight = new Map() // coreIndex -> settled promise

    while (next <= this.last || inflight.size > 0) {
      while (this.inflightFree(inflight) && next <= this.last) {
        if (this.cancelled) break
        const coreIndex = next++
        inflight.set(
          coreIndex,
          this.fetchBlock(coreIndex).then(
            (block) => ({ coreIndex, block, err: null }),
            (err) => ({ coreIndex, block: null, err })
          )
        )
      }

      const settled = await Promise.race(Array.from(inflight.values()))
      inflight.delete(settled.coreIndex)

      if (settled.err) {
        if (this.cancelled) break
        failures++
        this.window = Math.max(MIN_WINDOW, Math.floor(this.window / 2))
        if (next > settled.coreIndex) next = settled.coreIndex // re-queue this block
        continue
      }
      if (this.cancelled) break

      failures = Math.max(0, failures - 1)
      if (failures === 0 && this.window < MAX_WINDOW) this.window++

      const dataIndex = settled.coreIndex - this.first
      const expected = this.blocks[dataIndex]
      const actual = sha256(settled.block).toString('hex')
      if (expected && actual !== expected) {
        throw new Error(`Block ${settled.coreIndex} checksum mismatch`)
      }
      try {
        await this.onBlock(settled.coreIndex, settled.block)
      } catch (err) {
        throw err
      }
    }

    if (this.cancelled) throw new Error('interrupted')
  }

  inflightFree(inflight) {
    if (this.paused) return false
    return inflight.size < this.window
  }
}

// ─── TransferEngine ────────────────────────────────────────────────────────

class TransferEngine {
  constructor({
    getBee,
    exchangeStore,
    sendEvent,
    getPeers,
    getDeviceIdentity,
    getDownloadDirectory,
    getTransferMethod,
    fsp,
    path
  }) {
    this.getBee = getBee
    this.exchangeStore = exchangeStore
    this.sendEvent = sendEvent // (eventName, data) => void
    this.getPeers = getPeers // () => Map<peerId, peerObj>
    this.getDeviceIdentity = getDeviceIdentity
    this.getDownloadDirectory = getDownloadDirectory
    this.getTransferMethod = getTransferMethod
    this.fsp = fsp
    this.path = path

    this.queue = new TransferQueue()
    this.runs = new Map() // transferId -> { direction, fd, core, flags, scheduler }
    this.pendingOffers = new Map() // transferId -> { offer, autoAccept }
  }

  getFileType(filename) {
    return getFileType(filename)
  }

  // Re-queue persisted transfers that were interrupted by a restart.
  async init() {
    try {
      const bee = await this.getBee('transfers')
      // Schema migration: v1 records (pre-TransferEngine) carried no manifest
      // or checksum and cannot be resumed under the integrity scheme, so we
      // reset the transfer log on upgrade rather than trusting stale offsets.
      const meta = await bee.get(SCHEMA_KEY)
      if (!meta || meta.value?.schema !== SCHEMA_VERSION) {
        const toDelete = []
        for await (const node of bee.createReadStream()) {
          if (node.key !== SCHEMA_KEY) toDelete.push(node.key)
        }
        for (const k of toDelete) await bee.del(k)
        await bee.put(SCHEMA_KEY, { schema: SCHEMA_VERSION })
        console.log(`[TransferEngine] Transfer store migrated to ${SCHEMA_VERSION} (reset)`)
      }

      const queued = []
      for await (const node of bee.createReadStream()) {
        const t = node.value
        if (t && t.id && t.status === STATUS.QUEUED) queued.push(t)
      }
      for (const t of queued) {
        this.queue.enqueue(t)
        this._emit(EVENTS.TRANSFER_QUEUED, t)
      }
      console.log(`[TransferEngine] loaded ${queued.length} queued transfer(s)`)
    } catch (err) {
      console.warn('[TransferEngine] init failed:', err.message)
    }
  }

  async _persist(id, patch) {
    try {
      const bee = await this.getBee('transfers')
      const entry = await bee.get(id)
      const next = { ...(entry?.value || {}), ...patch, id }
      await bee.put(id, next)
      return next
    } catch (err) {
      console.warn('[TransferEngine] persist failed:', err.message)
      return { id, ...patch }
    }
  }

  _emit(event, data) {
    try {
      this.sendEvent(event, data)
    } catch (err) {
      console.warn('[TransferEngine] event emit failed:', err.message)
    }
  }

  _resolveMethod(transferMethod, senderIdentity, isClaim) {
    if (transferMethod) return transferMethod
    return this.getTransferMethod(senderIdentity?.ipAddress || '', isClaim)
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async startSend(params) {
    const peerId = params.peerId || ''
    const peerObj = peerId ? this.getPeers().get(peerId) : null
    const transferMethod = this._resolveMethod(
      params.transferMethod,
      peerObj?.device || { ipAddress: params.ipAddress },
      false
    )
    const transfer = {
      id:
        params.transferId ||
        `transfer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      schema: SCHEMA_VERSION,
      filename: params.filename || 'Unknown',
      fileSize: params.fileSize || 0,
      fileType: params.fileType || getFileType(params.filename || ''),
      direction: 'send',
      status: STATUS.QUEUED,
      priority: params.priority || DEFAULT_PRIORITY,
      progress: 0,
      speed: 0,
      peakSpeed: 0,
      eta: 0,
      duration: 0,
      transferMethod,
      isEncrypted: true,
      peerId,
      peerName: params.peerName || peerObj?.device?.name || 'Unknown',
      coreKey: params.coreKey || '',
      filePath: params.filePath || '',
      destPath: '',
      byteOffset: 0,
      manifestHash: '',
      checksum: '',
      blockSize: CHUNK_SIZE,
      blockCount: 0,
      summary: {},
      createdAt: new Date().toISOString()
    }

    if (!transfer.filePath || !transfer.fileSize || transfer.fileSize <= 0) {
      throw new Error('Transfer requires a valid filePath and fileSize')
    }

    await this._persist(transfer.id, transfer)
    this._enqueue(transfer)
    return transfer
  }

  // Stage a file into a drop core (no offer). Used by FILES_CREATE_CODE: the
  // code topic is joined separately and the resulting coreKey/manifestHash are
  // stored on the pending share, then served to claimers.
  async stageDrop({ transferId, filePath, filename, fileSize, fileType }) {
    const core = this.exchangeStore.get({ name: `file-drop-${transferId}` })
    await core.ready()

    const { manifest, manifestHash } = await buildManifest({
      filePath,
      fsp: this.fsp,
      filename,
      fileSize,
      fileType: fileType || getFileType(filename),
      transferId
    })

    if (core.length === 0) {
      await core.append(Buffer.from(JSON.stringify(manifest)))
    }

    // Append any missing data blocks (resume-safe: same core, byteOffset from
    // actual core length, never from a stale counter).
    let byteOffset = 0
    let bytesWritten = 0
    const fd = await this.fsp.open(filePath, 'r')
    try {
      const appended = Math.max(0, core.length - 1) // manifest is block 0
      byteOffset = appended * CHUNK_SIZE
      bytesWritten = byteOffset
      const buf = Buffer.alloc(CHUNK_SIZE)
      while (bytesWritten < fileSize) {
        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, bytesWritten)
        if (bytesRead === 0) break
        const block = Buffer.from(buf.subarray(0, bytesRead))
        await core.append(block)
        bytesWritten += bytesRead
      }
    } finally {
      await fd.close()
    }

    await core.close().catch(() => {})
    return {
      coreKey: core.key.toString('hex'),
      manifestHash,
      checksum: manifest.checksum,
      blockSize: manifest.blockSize,
      blockCount: manifest.blockCount
    }
  }

  async _runSend(transfer) {
    const { fsp } = this
    const id = transfer.id
    const filePath = transfer.filePath
    const fileSize = transfer.fileSize

    const info = {
      direction: 'send',
      fd: null,
      core: null,
      flags: { paused: false, cancelled: false }
    }
    this.runs.set(id, info)

    let bytesWritten = 0
    try {
      const keyBuf = transfer.coreKey ? Buffer.from(transfer.coreKey, 'hex') : null
      const core = keyBuf
        ? this.exchangeStore.get(keyBuf)
        : this.exchangeStore.get({ name: `file-transfer-${id}` })
      await core.ready()
      info.core = core

      // Build the manifest on first run; read it back on resume so we keep the
      // SAME core and never fabricate a fresh one.
      let manifest = null
      let manifestHash = transfer.manifestHash || ''
      if (core.length === 0) {
        const built = await buildManifest({
          filePath,
          fsp,
          filename: transfer.filename,
          fileSize,
          fileType: transfer.fileType,
          transferId: id
        })
        manifest = built.manifest
        manifestHash = built.manifestHash
        await core.append(Buffer.from(JSON.stringify(manifest)))
        transfer.coreKey = core.key.toString('hex')
        transfer.manifestHash = manifestHash
        transfer.checksum = manifest.checksum
        transfer.blockSize = manifest.blockSize
        transfer.blockCount = manifest.blockCount
        await this._persist(id, {
          coreKey: transfer.coreKey,
          manifestHash,
          checksum: manifest.checksum,
          blockSize: manifest.blockSize,
          blockCount: manifest.blockCount,
          status: STATUS.ACTIVE,
          startedAt: transfer.startedAt || new Date().toISOString()
        })
      } else {
        const raw = await core.get(0, { wait: true, timeout: 15000 })
        manifest = parseManifest(raw)
        if (!manifest) {
          throw new Error('Transfer core is missing a valid manifest (block 0)')
        }
        if (manifestHash && manifestHash !== this._hashManifest(manifest)) {
          throw new Error('Stored manifestHash does not match the core manifest')
        }
        transfer.manifestHash = manifestHash || this._hashManifest(manifest)
        transfer.checksum = manifest.checksum
        transfer.blockSize = manifest.blockSize
        transfer.blockCount = manifest.blockCount
        await this._persist(id, {
          status: STATUS.ACTIVE,
          startedAt: transfer.startedAt || new Date().toISOString()
        })
      }

      this.sendOffer(id, transfer)

      bytesWritten = Math.max(0, core.length - 1) * CHUNK_SIZE
      const startTime = Date.now()
      let peakSpeed = 0
      let lastEmitTime = startTime
      let lastEmitBytes = bytesWritten
      let lastEmittedProgress = Math.min(100, Math.round((bytesWritten / fileSize) * 100))

      const fd = await fsp.open(filePath, 'r')
      info.fd = fd
      const buf = Buffer.alloc(CHUNK_SIZE)
      while (bytesWritten < fileSize) {
        if (info.flags.cancelled) throw new Error('interrupted')
        while (info.flags.paused && !info.flags.cancelled) await sleep(50)

        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, bytesWritten)
        if (bytesRead === 0) break
        const block = Buffer.from(buf.subarray(0, bytesRead))
        await core.append(block)
        bytesWritten += bytesRead

        const now = Date.now()
        const elapsed = (now - lastEmitTime) / 1000
        let speed = 0
        if (elapsed >= 1) {
          speed = Math.round((bytesWritten - lastEmitBytes) / elapsed)
          lastEmitTime = now
          lastEmitBytes = bytesWritten
        } else if (now - startTime > 0) {
          speed = Math.round(bytesWritten / ((now - startTime) / 1000))
        }
        if (speed > peakSpeed) peakSpeed = speed

        const progress = Math.min(100, Math.round((bytesWritten / fileSize) * 100))
        const remaining = fileSize - bytesWritten
        const eta = speed > 0 ? Math.round(remaining / speed) : 0
        if (progress === 100 || progress - lastEmittedProgress >= 2 || now - lastEmitTime >= 1000) {
          lastEmittedProgress = progress
          await this._persist(id, { progress, speed, peakSpeed, eta, byteOffset: bytesWritten })
          this._emit(EVENTS.TRANSFER_PROGRESS, { id, progress, speed, peakSpeed, eta })
        }
      }

      await fd.close()
      info.fd = null

      const totalElapsed = (Date.now() - startTime) / 1000
      const avgSpeed = totalElapsed > 0 ? Math.round(fileSize / totalElapsed) : 0
      const completed = await this._persist(id, {
        status: STATUS.COMPLETED,
        progress: 100,
        speed: avgSpeed,
        peakSpeed,
        eta: 0,
        duration: Math.max(1, Math.round(totalElapsed)),
        byteOffset: fileSize,
        completedAt: new Date().toISOString(),
        summary: {
          checksum: transfer.checksum,
          manifestHash: transfer.manifestHash,
          blocksVerified: manifest.blockCount,
          bytesVerified: fileSize
        }
      })
      this._emit(EVENTS.TRANSFER_COMPLETED, completed)
      this._recordHistory(completed, 'Sent')
    } catch (err) {
      if (info.fd) await info.fd.close().catch(() => {})
      const isInterrupt = info.flags.cancelled || /interrupted/i.test(err.message)
      await this._failOrInterrupt(transfer, err, isInterrupt, { info, bytesWritten })
    } finally {
      this.runs.delete(id)
      if (info.core) await info.core.close().catch(() => {})
      this.queue.release(transfer)
      this._kickQueue('send')
    }
  }

  sendOffer(id, transfer) {
    const offer = {
      type: 'TRANSFER_OFFER',
      transferId: id,
      filename: transfer.filename,
      fileSize: transfer.fileSize,
      fileType: transfer.fileType,
      coreKey: transfer.coreKey,
      manifestHash: transfer.manifestHash,
      checksum: transfer.checksum,
      senderIdentity: this.getDeviceIdentity() || { id: '', name: 'Local Device' },
      transferMethod: transfer.transferMethod
    }

    let sent = 0
    const sendTo = (peerId, peerObj) => {
      if (peerObj?.signaling) {
        peerObj.signaling.send(offer)
        sent++
      }
    }

    if (transfer.peerId) {
      const peerObj = this.getPeers().get(transfer.peerId)
      if (peerObj) sendTo(transfer.peerId, peerObj)
    }
    if (sent === 0) {
      for (const [peerId, peerObj] of this.getPeers().entries()) sendTo(peerId, peerObj)
    }
    if (sent === 0) {
      console.log(`[Worker] No connected peers to deliver TRANSFER_OFFER for ${id}`)
    }
  }

  // ── Receive ───────────────────────────────────────────────────────────────

  async receiveOffer(offer, { autoAccept = false, isClaim = false } = {}) {
    const { transferId, filename, fileSize, fileType, coreKey, senderIdentity, transferMethod } =
      offer

    if (!transferId || typeof coreKey !== 'string' || coreKey.length !== 64) {
      console.warn('[TransferEngine] Rejecting malformed TRANSFER_OFFER (bad coreKey/transferId)')
      return null
    }
    if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_TRANSFER_SIZE) {
      console.warn('[TransferEngine] Rejecting TRANSFER_OFFER with invalid fileSize')
      return null
    }
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 500) {
      console.warn('[TransferEngine] Rejecting TRANSFER_OFFER with invalid filename')
      return null
    }

    const bee = await this.getBee('transfers')
    const existing = await bee.get(transferId)
    if (existing) {
      console.log(
        `[TransferEngine] Transfer ${transferId} already exists, skipping duplicate offer`
      )
      return null
    }

    const downloadsDir = await this.getDownloadDirectory()
    const safeName = safeFilename(filename)
    const destPath = this.path.join(downloadsDir, safeName)

    const record = {
      id: transferId,
      schema: SCHEMA_VERSION,
      filename,
      fileSize,
      fileType: fileType || getFileType(filename),
      direction: 'receive',
      status: autoAccept ? STATUS.QUEUED : STATUS.PENDING_APPROVAL,
      priority: offer.priority || DEFAULT_PRIORITY,
      progress: 0,
      speed: 0,
      peakSpeed: 0,
      eta: 0,
      duration: 0,
      transferMethod: this._resolveMethod(transferMethod, senderIdentity, isClaim),
      isEncrypted: true,
      isClaim: !!isClaim,
      peerId: senderIdentity?.id || '',
      peerName: senderIdentity?.name || 'Remote Peer',
      shareId: offer.shareId || '',
      peerKey: offer.peerKey || '',
      coreKey,
      destPath,
      stagingPath: this.path.join(downloadsDir, '.p2p-staging', transferId, safeName + '.part'),
      byteOffset: 0,
      manifestHash: offer.manifestHash || '',
      checksum: offer.checksum || '',
      blockSize: CHUNK_SIZE,
      blockCount: 0,
      summary: {},
      createdAt: new Date().toISOString()
    }
    await this._persist(transferId, record)

    if (autoAccept) {
      this.pendingOffers.set(transferId, { offer, autoAccept: true })
      const validated = await this._validateReceive(record, offer)
      if (!validated) return null
      this._enqueue(record)
    } else {
      this._emit(EVENTS.TRANSFER_OFFER_RECEIVED, {
        transferId,
        filename,
        fileSize,
        fileType: fileType || getFileType(filename),
        senderIdentity: senderIdentity || { name: 'Remote Peer', id: '' }
      })
    }
    return record
  }

  async _validateReceive(record, offer = null) {
    const { fsp, path } = this
    if (offer) {
      if (
        typeof offer.fileSize !== 'number' ||
        offer.fileSize <= 0 ||
        offer.fileSize > MAX_TRANSFER_SIZE
      ) {
        await this._persist(record.id, {
          status: STATUS.FAILED,
          error: 'Invalid or oversized file'
        })
        return false
      }
    }

    // Path confinement: final destination must stay inside the downloads dir.
    const downloadsDir = await this.getDownloadDirectory()
    const resolvedDest = path.resolve(record.destPath || '')
    const resolvedBase = path.resolve(downloadsDir)
    if (!resolvedDest.startsWith(resolvedBase + path.sep)) {
      await this._persist(record.id, {
        status: STATUS.FAILED,
        error: 'Destination path outside downloads directory'
      })
      return false
    }

    // Disk space pre-check.
    try {
      if (typeof fsp.statfs === 'function') {
        const stats = await fsp.statfs(resolvedBase)
        const freeBytes = Number(stats.bavail || stats.bfree || 0) * Number(stats.bsize || 4096)
        if (freeBytes > 0 && freeBytes < record.fileSize) {
          await this._persist(record.id, {
            status: STATUS.FAILED,
            error: `Insufficient disk space: ${Math.round(freeBytes / (1024 * 1024))}MB free`
          })
          return false
        }
      }
    } catch (err) {
      console.warn('[TransferEngine] Disk space pre-check skipped:', err.message)
    }
    return true
  }

  async _runReceive(transfer) {
    const { fsp, path } = this
    const id = transfer.id
    const keyBuf = Buffer.from(transfer.coreKey, 'hex')
    const core = this.exchangeStore.get(keyBuf)
    await core.ready()

    const info = {
      direction: 'receive',
      fd: null,
      core,
      flags: { paused: false, cancelled: false },
      scheduler: null,
      download: null
    }
    this.runs.set(id, info)

    let bytesWritten = 0
    let verifiedBytes = 0
    try {
      // Integrity gate: the manifest (block 0) must exist and match the offer.
      const raw = await core.get(0, { wait: true, timeout: 30000 })
      const manifest = parseManifest(raw)
      if (!manifest) throw new Error('Remote core has no valid manifest (block 0)')
      const actualHash = this._hashManifest(manifest)
      if (transfer.manifestHash && actualHash !== transfer.manifestHash) {
        throw new Error('Manifest hash mismatch: sender integrity check failed')
      }

      const blockSize = manifest.blockSize
      const blockCount = manifest.blocks.length
      const stagingPath = transfer.stagingPath
      const destPath = transfer.destPath
      const firstDataBlock = 1
      const lastDataBlock = blockCount // core block indices 1..blockCount

      await fsp.mkdir(path.dirname(stagingPath), { recursive: true })
      // Resume: a partial .part file continues from a whole-block boundary.
      try {
        const stat = await fsp.stat(stagingPath)
        bytesWritten = Math.floor(stat.size / blockSize) * blockSize
      } catch {}
      bytesWritten = Math.max(0, Math.min(bytesWritten, manifest.fileSize))
      transfer.byteOffset = bytesWritten

      const flags = bytesWritten > 0 ? 'r+' : 'w'
      info.fd = await fsp.open(stagingPath, flags)

      // Resume from a whole-block boundary. The scheduler indexes `blocks` as
      // `coreIndex - first`, so the array must be sliced to start at the first
      // remaining data block (manifest.blocks[n] is the hash of core block 1+n).
      const resumeBlockIndex = Math.floor(bytesWritten / blockSize)
      const startTime = Date.now()
      let peakSpeed = 0
      let lastEmitTime = startTime
      let lastEmitBytes = bytesWritten
      let lastEmittedProgress = Math.round((bytesWritten / manifest.fileSize) * 100)
      verifiedBytes = bytesWritten

      const scheduler = new ChunkScheduler({
        core,
        firstDataBlock: firstDataBlock + resumeBlockIndex,
        lastDataBlock,
        blocks: manifest.blocks.slice(resumeBlockIndex),
        blockSize,
        onBlock: async (coreIndex, block) => {
          const fileOffset = (coreIndex - firstDataBlock) * blockSize
          await info.fd.write(block, 0, block.length, fileOffset)
          verifiedBytes += block.length

          // Progress: real bytes verified, no fabricated speeds.
          const now = Date.now()
          const elapsed = (now - lastEmitTime) / 1000
          let speed = 0
          if (elapsed >= 0.5) {
            speed = Math.round((verifiedBytes - lastEmitBytes) / elapsed)
            lastEmitTime = now
            lastEmitBytes = verifiedBytes
          }
          if (speed > peakSpeed) peakSpeed = speed
          const progress = Math.min(100, Math.round((verifiedBytes / manifest.fileSize) * 100))
          if (
            progress === 100 ||
            progress - lastEmittedProgress >= 2 ||
            now - lastEmitTime >= 1000
          ) {
            lastEmittedProgress = progress
            const remaining = Math.max(0, manifest.fileSize - verifiedBytes)
            const eta = speed > 0 ? Math.round(remaining / speed) : 0
            await this._persist(id, { progress, speed, peakSpeed, eta, byteOffset: verifiedBytes })
            this._emit(EVENTS.TRANSFER_PROGRESS, { id, progress, speed, peakSpeed, eta })
          }
        }
      })
      info.scheduler = scheduler
      const dl = core.download({ start: firstDataBlock, end: lastDataBlock })
      if (dl && typeof dl.destroy === 'function') info.download = dl

      await scheduler.run()

      if (info.flags.cancelled) throw new Error('interrupted')

      await info.fd.close()
      info.fd = null

      // Integrity verification: whole-file checksum from block hashes.
      const fileBytes = verifiedBytes
      if (fileBytes < manifest.fileSize) {
        throw new Error(`Incomplete file: ${fileBytes}/${manifest.fileSize} bytes`)
      }
      if (transfer.checksum && manifest.checksum !== transfer.checksum) {
        throw new Error('Checksum mismatch: file integrity verification failed')
      }

      // Atomic rename from the per-transfer staging dir into the final path,
      // resolving filename collisions.
      const finalPath = await this._uniqueFinalPath(destPath)
      await fsp.rename(stagingPath, finalPath)
      await fsp.rmdir(path.dirname(stagingPath)).catch(() => {})

      const totalElapsed = (Date.now() - startTime) / 1000
      const avgSpeed = totalElapsed > 0 ? Math.round(manifest.fileSize / totalElapsed) : 0
      const completed = await this._persist(id, {
        status: STATUS.COMPLETED,
        progress: 100,
        speed: avgSpeed,
        peakSpeed,
        eta: 0,
        duration: Math.max(1, Math.round(totalElapsed)),
        destPath: finalPath,
        byteOffset: manifest.fileSize,
        blockSize,
        blockCount,
        completedAt: new Date().toISOString(),
        summary: {
          checksum: manifest.checksum,
          manifestHash: transfer.manifestHash || this._hashManifest(manifest),
          blocksVerified: blockCount,
          bytesVerified: manifest.fileSize
        }
      })
      this._emit(EVENTS.TRANSFER_COMPLETED, completed)
      this._recordHistory(completed, 'Received')
      this._recordShared(completed, finalPath)
      // One-time share finished: tell the host to tear the drop down
      // (leave topic, unlink the staged file, invalidate the key).
      this.sendClaimComplete(completed)
    } catch (err) {
      const isInterrupt = info.flags.cancelled || /interrupted/i.test(err.message)
      await this._failOrInterrupt(transfer, err, isInterrupt, {
        info,
        bytesWritten: verifiedBytes || bytesWritten
      })
    } finally {
      if (info.fd) await info.fd.close().catch(() => {})
      if (info.download && typeof info.download.destroy === 'function') info.download.destroy()
      this.runs.delete(id)
      await core.close().catch(() => {})
      this.queue.release(transfer)
      this._kickQueue('receive')
    }
  }

  async _uniqueFinalPath(destPath) {
    const { path } = this
    const dir = path.dirname(destPath)
    const ext = path.extname(destPath)
    const base = path.basename(destPath, ext)
    let candidate = destPath
    let n = 1
    while (await this._exists(candidate)) {
      candidate = path.join(dir, `${base} (${n})${ext}`)
      n++
    }
    return candidate
  }

  async _exists(p) {
    try {
      await this.fsp.stat(p)
      return true
    } catch {
      return false
    }
  }

  _hashManifest(manifest) {
    return sha256(JSON.stringify(manifest)).toString('hex')
  }

  async _failOrInterrupt(transfer, err, isInterrupt, { info, bytesWritten }) {
    const id = transfer.id
    const msg = String(err?.message || err)
    console.warn(`[TransferEngine] ${isInterrupt ? 'interrupt' : 'fail'} ${id}: ${msg}`)

    if (isInterrupt) {
      const record = await this._persist(id, {
        status: STATUS.INTERRUPTED,
        byteOffset: bytesWritten || 0,
        progress:
          transfer.fileSize > 0
            ? Math.min(100, Math.round(((bytesWritten || 0) / transfer.fileSize) * 100))
            : 0,
        error: msg,
        interruptedAt: new Date().toISOString()
      })
      this._emit(EVENTS.TRANSFER_CANCELLED, record)
    } else {
      const record = await this._persist(id, {
        status: STATUS.FAILED,
        error: msg,
        completedAt: new Date().toISOString()
      })
      this._emit(EVENTS.TRANSFER_FAILED, record)
    }
  }

  async _recordHistory(transfer, action) {
    try {
      const bee = await this.getBee('history')
      const entry = {
        id: `hist-${transfer.id}`,
        type: 'transfer',
        title: `${action} ${transfer.filename}`,
        description: `${transfer.fileSize} bytes ${action.toLowerCase()} ${
          action === 'Sent'
            ? `to ${transfer.peerName || 'Unknown'}`
            : `from ${transfer.peerName || 'Remote Peer'}`
        }`,
        timestamp: new Date().toISOString(),
        transferId: transfer.id,
        transferMethod: transfer.transferMethod
      }
      await bee.put(entry.id, entry)
    } catch (err) {
      console.warn('[TransferEngine] history write failed:', err.message)
    }
  }

  // Notify the host that a one-time (DROP) claim download has finished so it
  // can tear the drop down. Never called for regular paired transfers.
  sendClaimComplete(transfer) {
    if (!transfer || !transfer.isClaim || !transfer.shareId || !transfer.peerKey) return
    const peerObj = this.getPeers().get(transfer.peerKey)
    if (!peerObj || !peerObj.signaling) return
    try {
      peerObj.signaling.send({ type: 'CLAIM_FILE_DONE', shareId: transfer.shareId })
    } catch (err) {
      console.error('[TransferEngine] Failed to send CLAIM_FILE_DONE:', err.message)
    }
  }

  async _recordShared(transfer, finalPath) {
    try {
      const bee = await this.getBee('shared')
      const entry = {
        id: transfer.id,
        name: transfer.filename,
        size: transfer.fileSize,
        type: transfer.fileType,
        modifiedAt: new Date().toISOString(),
        sharedWith: [],
        isFavorite: false,
        path: finalPath
      }
      await bee.put(transfer.id, entry)
    } catch (err) {
      console.warn('[TransferEngine] shared write failed:', err.message)
    }
  }

  // ── Queue scheduling ──────────────────────────────────────────────────────

  _enqueue(transfer) {
    if (this.queue._hasSlot(transfer)) {
      this._startTransfer(transfer)
    } else {
      this.queue.enqueue(transfer)
      this._emit(EVENTS.TRANSFER_QUEUED, transfer)
    }
  }

  _kickQueue(direction) {
    const next = this.queue.popNext(direction)
    if (!next) return
    this._startTransfer(next)
  }

  async _startTransfer(transfer) {
    this.queue.claim(transfer)
    const id = transfer.id
    try {
      if (transfer.direction === 'send') {
        const record = await this._persist(id, {
          status: STATUS.ACTIVE,
          startedAt: new Date().toISOString()
        })
        this._emit(EVENTS.TRANSFER_STARTED, record)
        this._runSend(record).catch(() => {})
      } else {
        const record = await this._persist(id, {
          status: STATUS.ACTIVE,
          startedAt: new Date().toISOString()
        })
        this._emit(EVENTS.TRANSFER_STARTED, record)
        this._runReceive(record).catch(() => {})
      }
    } catch (err) {
      console.warn(`[TransferEngine] start ${id} failed:`, err.message)
      await this._persist(id, { status: STATUS.FAILED, error: err.message })
      this._emit(EVENTS.TRANSFER_FAILED, { id, error: err.message })
      this.queue.release(transfer)
      this._kickQueue(transfer.direction)
    }
  }

  // ── Public IPC-backed operations ──────────────────────────────────────────

  async approve(transferId) {
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    if (!entry) throw new Error('Transfer offer not found')

    const record = entry.value
    if (record.direction !== 'receive') throw new Error('Only incoming transfers can be approved')

    const pending = this.pendingOffers.get(transferId)
    const ok = await this._validateReceive(record, pending?.offer || null)
    if (!ok) throw new Error('Transfer rejected during validation')
    this.pendingOffers.delete(transferId)

    await this._persist(transferId, {
      status: STATUS.QUEUED,
      priority: record.priority || DEFAULT_PRIORITY
    })
    const updated = { ...record, status: STATUS.QUEUED }
    this._enqueue(updated)
    return updated
  }

  async decline(transferId) {
    this.pendingOffers.delete(transferId)
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    const record = entry?.value || { id: transferId }
    const cancelled = await this._persist(transferId, {
      status: STATUS.CANCELLED,
      cancelledAt: new Date().toISOString()
    })
    this._emit(EVENTS.TRANSFER_CANCELLED, cancelled)
    return record
  }

  async pause(transferId) {
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    if (!entry) throw new Error('Transfer not found')

    const info = this.runs.get(transferId)
    if (info) info.flags.paused = true

    const record = await this._persist(transferId, { status: STATUS.PAUSED })
    this._emit(EVENTS.TRANSFER_PAUSED, record)
    return record
  }

  async resume(transferId) {
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    if (!entry) throw new Error('Transfer not found')

    const record = { ...entry.value, priority: entry.value.priority || DEFAULT_PRIORITY }
    if (this.runs.has(transferId)) {
      const info = this.runs.get(transferId)
      info.flags.paused = false
      if (info.scheduler) info.scheduler.resume()
      const updated = await this._persist(transferId, { status: STATUS.ACTIVE })
      this._emit(EVENTS.TRANSFER_RESUMED, updated)
      return updated
    }

    // Resume from an interrupted/paused record: reuse the same stored core.
    await this._persist(transferId, { status: STATUS.QUEUED })
    const updated = { ...record, status: STATUS.QUEUED }
    this._enqueue(updated)
    return updated
  }

  async cancel(transferId) {
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    if (!entry) throw new Error('Transfer not found')

    const info = this.runs.get(transferId)
    if (info) {
      info.flags.cancelled = true
      if (info.scheduler) info.scheduler.cancel()
    }
    // The active loop's finally block persists 'interrupted' + emits + frees the
    // queue slot; if nothing was running, do it here.
    if (!info) {
      const record = await this._persist(transferId, {
        status: STATUS.INTERRUPTED,
        interruptedAt: new Date().toISOString()
      })
      this._emit(EVENTS.TRANSFER_CANCELLED, record)
      return record
    }
    return null
  }

  async retry(transferId) {
    const bee = await this.getBee('transfers')
    const entry = await bee.get(transferId)
    if (!entry) throw new Error('Transfer not found')

    const record = { ...entry.value, priority: entry.value.priority || DEFAULT_PRIORITY }
    await this._persist(transferId, {
      status: STATUS.QUEUED,
      progress: 0,
      speed: 0,
      eta: 0,
      byteOffset: 0
    })
    const updated = {
      ...record,
      status: STATUS.QUEUED,
      progress: 0,
      speed: 0,
      eta: 0,
      byteOffset: 0
    }
    this._enqueue(updated)
    return updated
  }

  async list() {
    const bee = await this.getBee('transfers')
    const results = []
    for await (const node of bee.createReadStream()) {
      if (node.value && node.value.id) results.push(node.value)
    }
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return results
  }

  async clear() {
    const bee = await this.getBee('transfers')
    const keys = []
    for await (const node of bee.createReadStream()) {
      if (node.value && TERMINAL.has(node.value.status)) keys.push(node.key)
    }
    for (const k of keys) await bee.del(k)
    return { success: true, count: keys.length }
  }

  async shutdown() {
    for (const [, info] of this.runs.entries()) {
      info.flags.cancelled = true
      if (info.scheduler) info.scheduler.cancel()
      if (info.fd) await info.fd.close().catch(() => {})
      await info.core.close().catch(() => {})
    }
    this.runs.clear()
  }
}

module.exports = { TransferEngine, TransferQueue, ChunkScheduler, CHUNK_SIZE, STATUS, getFileType }
