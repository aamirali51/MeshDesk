'use strict'

// Pairing code + challenge primitives for the Bare worker.
// Uses sodium-universal (keyed BLAKE2b = a proper MAC/PRF) and
// hypercore-crypto (randomBytes). Both ship with hyperswarm's stack.

let sodium = null
try {
  sodium = require('sodium-universal')
} catch {}
let hcrypto = null
try {
  hcrypto = require('hypercore-crypto')
} catch {}

// 32-char alphabet, no ambiguous 0/O/1/I
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_GROUPS = 4
const CODE_GROUP_SIZE = 4
const CODE_LENGTH = CODE_GROUPS * CODE_GROUP_SIZE // 16 chars * 5 bits = 80 bits

function randomBytes(n) {
  if (hcrypto && typeof hcrypto.randomBytes === 'function') return hcrypto.randomBytes(n)
  if (sodium && typeof sodium.randombytes_buf === 'function') {
    const buf = Buffer.allocUnsafe(n)
    sodium.randombytes_buf(buf)
    return buf
  }
  const buf = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

// Keyed BLAKE2b (sodium crypto_generichash) — a proper MAC construction.
// The pairing code is the key; message is the challenge nonce.
function mac(key, message) {
  if (!sodium || typeof sodium.crypto_generichash !== 'function') {
    throw new Error('MAC unavailable: sodium-universal is required')
  }
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
  const msgBuf = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')
  const out = Buffer.allocUnsafe(32)
  sodium.crypto_generichash(out, msgBuf, keyBuf)
  return out
}

function hash(data) {
  if (!hcrypto || typeof hcrypto.hash !== 'function') {
    throw new Error('hash unavailable: hypercore-crypto is required')
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  return hcrypto.hash([buf])
}

// SHA-256 (NIST). Used for transfer integrity manifests. sodium-universal is
// preferred (bare worker); falls back to node:crypto in the host/test runtime.
function sha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  if (sodium && typeof sodium.crypto_hash_sha256 === 'function') {
    const out = Buffer.alloc(32)
    sodium.crypto_hash_sha256(out, buf)
    return out
  }
  const nodeCrypto = require('crypto')
  return nodeCrypto.createHash('sha256').update(buf).digest()
}

// Stable, non-derivable device id derived from a public key (BLAKE2b).
// Never derived from a pairing code.
function deriveDeviceId(publicKey) {
  const pk = typeof publicKey === 'string' ? Buffer.from(publicKey, 'hex') : publicKey
  return hash(pk).toString('hex').slice(0, 16)
}

function formatCode(raw) {
  const groups = []
  for (let i = 0; i < CODE_GROUPS; i++) {
    groups.push(raw.slice(i * CODE_GROUP_SIZE, (i + 1) * CODE_GROUP_SIZE))
  }
  return 'MD-' + groups.join('-')
}

// Random 80-bit pairing code, e.g. MD-ABCD-EFGH-JKLM-NPQR
function generatePairingCode() {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % 32]
  }
  return formatCode(code)
}

// DROP code alphabet: full A-Z0-9 (claim parsing in FILES_CLAIM_CODE relies
// on this charset). 8 chars ≈ 41 bits of entropy.
const DROP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// Random one-time share code, e.g. DROP-AB12-CD34. Rejection sampling keeps
// the distribution uniform (no modulo bias); the previous generator used
// Math.random + Date.now which was neither secure nor collision-resistant.
function generateDropCode() {
  const max = Math.floor(256 / DROP_ALPHABET.length) * DROP_ALPHABET.length // 252
  let code = ''
  while (code.length < 8) {
    const b = randomBytes(1)[0]
    if (b >= max) continue
    code += DROP_ALPHABET[b % DROP_ALPHABET.length]
  }
  return `DROP-${code.slice(0, 4)}-${code.slice(4)}`
}

// Returns the canonical 'MD-XXXX-XXXX-XXXX-XXXX' or null if invalid.
function normalizePairingCode(raw) {
  if (typeof raw !== 'string') return null
  let clean = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (clean.startsWith('MD')) clean = clean.slice(2)
  if (clean.length !== CODE_LENGTH) return null
  return formatCode(clean)
}

// Non-secret identifier for a pairing secret, used in challenge messages so
// the responder knows which code to MAC with, without revealing the code.
function codeId(code) {
  return hash(code).toString('hex').slice(0, 16)
}

module.exports = {
  randomBytes,
  mac,
  hash,
  sha256,
  deriveDeviceId,
  generatePairingCode,
  generateDropCode,
  normalizePairingCode,
  formatCode,
  codeId,
  ALPHABET,
  CODE_LENGTH
}
