'use strict'

// Shared pure helpers and ctx-based operations extracted from the main worker.
// Pure functions take no ctx; the rest take the shared context object.

const fsp = require('bare-fs/promises')
const path = require('bare-path')
const { createEvent, EVENTS } = require('../src/shared/protocol.js')

// ─── Pure helpers ───────────────────────────────────────────────────────────

function getDurationMs(preset) {
  const map = {
    '5m': 5 * 60 * 1000,
    '10m': 10 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    never: 0
  }
  return map[preset] || 30 * 60 * 1000
}

function getTransferMethod(ipAddress, isClaim = false) {
  if (isClaim) return 'internet'
  if (!ipAddress) return 'internet'
  let ip = String(ipAddress)
    .trim()
    .replace(/^::ffff:/, '')
  // Socket remote addresses are "host:port". Strip the port so LAN/loopback
  // classification is not defeated by it (127.0.0.1:port must still be LAN).
  if (ip.startsWith('[')) {
    // IPv6 bracket form: [::1]:port
    const end = ip.indexOf(']')
    if (end !== -1) ip = ip.slice(1, end)
  } else if (ip.indexOf(':') === ip.lastIndexOf(':')) {
    // Exactly one colon => IPv4 host:port (or bare host); IPv6 has >= 2 colons
    // and must be left untouched.
    ip = ip.replace(/:\d+$/, '')
  }
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip === '0.0.0.0') return 'lan'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(ip)) return 'lan'
  return 'internet'
}

// Canonical settings schema. Merge of the previous two competing defaults;
// `downloadDir` is read by getDownloadDirectory, the rest drive the UI.
const DEFAULT_SETTINGS = {
  theme: 'dark',
  deviceName: '',
  autoTrustLAN: true,
  noiseEncryption: true,
  autoUpdate: true,
  releaseChannel: 'stable',
  notifications: { transfer: true, device: true, sound: false },
  downloadDir: null
}

function mergeSettings(saved) {
  return { ...DEFAULT_SETTINGS, ...(saved || {}) }
}

// ─── ctx-based operations ───────────────────────────────────────────────────

async function getDownloadDirectory(ctx) {
  try {
    const bee = await ctx.getBee('settings')
    const entry = await bee.get('settings')
    if (entry && entry.value && entry.value.downloadDir) {
      const dir = entry.value.downloadDir
      try {
        await fsp.mkdir(dir, { recursive: true })
      } catch {}
      return dir
    }
  } catch {}
  const dir = path.join(ctx.STORAGE_DIR, 'downloads')
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch {}
  return dir
}

// Whether peers discovered on the local network should be auto-trusted
// without a manual pairing code. Reads the persisted settings bee; defaults
// to true when settings are missing or unreadable. Cached on ctx until
// invalidateSettingsCache() runs (wired to the settings.updated path) so the
// toggle takes effect without a restart.
async function getAutoTrustLAN(ctx) {
  if (ctx.autoTrustLANCache !== undefined) return ctx.autoTrustLANCache
  let value = true
  try {
    const bee = await ctx.getBee('settings')
    const entry = await bee.get('settings')
    value = mergeSettings(entry?.value).autoTrustLAN !== false
  } catch {}
  ctx.autoTrustLANCache = value
  return value
}

async function cleanupPendingShare(ctx, id, newStatus = 'cancelled') {
  const bee = await ctx.getBee('pendingShares')
  const entry = await bee.get(id)
  if (!entry) return null
  const share = { ...entry.value, status: newStatus }
  await bee.put(id, share)

  const active = ctx.pendingSwarmTopics.get(id)
  if (active) {
    if (active.topicLabel) {
      try {
        ctx.topicRegistry.leave(active.topicLabel)
      } catch {}
    }
    if (active.core) {
      try {
        await active.core.close()
      } catch {}
    }
    if (active.stagedPath) {
      try {
        await fsp.unlink(active.stagedPath)
      } catch {}
    }
    ctx.pendingSwarmTopics.delete(id)
  }

  if (newStatus === 'expired') {
    ctx.send(createEvent(EVENTS.PENDING_SHARE_EXPIRED, { id }))
  }
  ctx.send(createEvent(EVENTS.PENDING_SHARE_UPDATED, share))
  return share
}

async function checkPendingExpirations(ctx) {
  // Expire old pairing secrets so stale codes cannot be used indefinitely
  if (ctx.trustManager) ctx.trustManager.expireSecrets()

  try {
    const bee = await ctx.getBee('pendingShares')
    const now = Date.now()
    for await (const node of bee.createReadStream()) {
      const share = node.value
      if (!share || share.status === 'expired' || share.status === 'cancelled') continue
      if (share.expiresAt > 0 && now >= share.expiresAt) {
        console.log(`[Worker] Pending share ${share.code} (${share.id}) EXPIRED`)
        await cleanupPendingShare(ctx, share.id, 'expired')
      }
    }
  } catch (err) {
    console.error('[Worker] Expiration check failed:', err.message)
  }
}

function startExpirationChecker(ctx) {
  const timer = setInterval(() => checkPendingExpirations(ctx), 10000)
  timer.unref()
  return timer
}

module.exports = {
  getDurationMs,
  getTransferMethod,
  DEFAULT_SETTINGS,
  mergeSettings,
  getDownloadDirectory,
  getAutoTrustLAN,
  cleanupPendingShare,
  checkPendingExpirations,
  startExpirationChecker
}
