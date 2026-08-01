'use strict'

// Worker IPC: the framed stream to Electron main, the send/sendEvent helpers,
// and the message router that dispatches protocol requests to handlers.

const FramedStream = require('framed-stream')
const {
  createResponse,
  createEvent,
  parseMessage,
  isProtocolCompatible,
  PROTOCOL_VERSION
} = require('../src/shared/protocol.js')

function createIpc() {
  const pipe = new FramedStream(Bare.IPC)

  const send = (data) => {
    try {
      pipe.write(Buffer.from(data))
    } catch (err) {
      console.error('[Worker IPC Error]:', err.message)
    }
  }

  const sendEvent = (event, data) => send(createEvent(event, data))

  return { pipe, send, sendEvent }
}

function createMessageRouter({ send, handlers }) {
  return async (raw) => {
    const msg = parseMessage(raw)
    if (!msg) return

    if (!isProtocolCompatible(msg)) {
      if (msg.type === 'request' && msg.id) {
        send(
          createResponse(msg.id, null, `Protocol version mismatch (expected ${PROTOCOL_VERSION})`)
        )
      }
      console.warn('[Worker] Rejected message with unsupported protocol version:', msg.v)
      return
    }

    if (msg.type === 'request') {
      const handler = handlers[msg.method]
      if (!handler) {
        send(createResponse(msg.id, null, `Unknown method: ${msg.method}`))
        return
      }
      try {
        const result = await handler(msg.params)
        send(createResponse(msg.id, result))
      } catch (err) {
        send(createResponse(msg.id, null, err.message))
      }
    }
  }
}

module.exports = { createIpc, createMessageRouter }
