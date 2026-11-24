import WebSocket, { WebSocketServer } from 'ws'

// The router consumes the event and workspace baselines. The native session
// consumers need a new logical stream after they have accepted a baseline.
const RECOVERY = new Map([
  ['$events', 'relay'],
  ['workspace/follow', 'relay'],
  ['session/follow', 'client'],
  ['session/control', 'client'],
])
const RETRY_MIN_MS = 250
const RETRY_MAX_MS = 4000

/** Keep one renderer socket alive while the Host reconnects its upstream mux. */
export function createRemoteMuxRelay(connect) {
  const server = new WebSocketServer({ noServer: true })
  return {
    upgrade(req, socket, head) {
      server.handleUpgrade(req, socket, head, (client) => relay(client, connect))
    },
    dispose() {
      for (const client of server.clients) client.terminate()
      server.close()
    },
  }
}

function relay(client, connect) {
  const streams = new Map()
  let remote
  let retry
  let delay = RETRY_MIN_MS
  let reportedState

  function send(data) {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false })
  }

  function status(state) {
    if (reportedState === state) return
    reportedState = state
    send(JSON.stringify({ type: 'drh/relay-status', state }))
  }

  function fail(streamId) {
    streams.delete(streamId)
    send(JSON.stringify({
      type: 'error',
      streamId,
      error: {
        code: 'gateway/remote-unavailable',
        message: 'Remote stream disconnected before its outcome was known',
        details: {},
      },
    }))
  }

  function schedule() {
    if (client.readyState !== WebSocket.OPEN || streams.size === 0 || retry !== undefined) return
    retry = setTimeout(() => {
      retry = undefined
      dial()
    }, delay)
    retry.unref()
    delay = Math.min(delay * 2, RETRY_MAX_MS)
  }

  function sendOpen(stream) {
    stream.sent = true
    remote.send(stream.open, { binary: false })
    if (stream.end !== undefined) remote.send(stream.end, { binary: false })
  }

  function dial() {
    if (client.readyState !== WebSocket.OPEN || remote !== undefined || streams.size === 0) return
    let socket
    try { socket = connect() } catch { /* treat a failed dial like an unreachable upstream */ }
    if (socket === undefined) {
      status('error')
      schedule()
      return
    }
    remote = socket
    socket.once('open', () => {
      delay = RETRY_MIN_MS
      status('open')
      for (const stream of streams.values()) sendOpen(stream)
    })
    socket.on('message', (data, binary) => {
      if (binary) return
      const text = data.toString()
      const frame = parse(text)
      if (frame === undefined || !streams.has(frame.streamId)) return
      if (frame.type === 'end' || frame.type === 'error') streams.delete(frame.streamId)
      else if (frame.type === 'item') streams.get(frame.streamId).received = true
      send(text)
    })
    // ws emits close after a transport error, so handle loss only once.
    socket.on('error', () => {})
    socket.once('close', () => {
      remote = undefined
      status('error')
      for (const [id, stream] of streams) {
        if (stream.sent && stream.recovery === undefined) {
          fail(id)
        } else if (stream.received && stream.recovery === 'client') {
          // The native journal treats end after its baseline as a retryable loss.
          streams.delete(id)
          send(JSON.stringify({ type: 'end', streamId: id }))
        } else {
          stream.sent = false
        }
      }
      schedule()
    })
  }

  client.on('message', (data, binary) => {
    if (binary) return
    const text = data.toString()
    const frame = parse(text)
    if (frame === undefined) return
    if (frame.type === 'open') {
      const stream = { open: text, recovery: RECOVERY.get(frame.endpoint), sent: false, received: false }
      streams.set(frame.streamId, stream)
      if (remote?.readyState === WebSocket.OPEN) sendOpen(stream)
      else if (retry === undefined) dial()
      return
    }
    const stream = streams.get(frame.streamId)
    if (stream === undefined) return
    if (frame.type === 'cancel') streams.delete(frame.streamId)
    else if (frame.type === 'end') stream.end = text
    else if (frame.type === 'item') {
      if (remote?.readyState !== WebSocket.OPEN) { fail(frame.streamId); return }
      // Uplink items may change remote state. Their outcome is unknown on loss.
      stream.recovery = undefined
    }
    if (stream.sent && remote?.readyState === WebSocket.OPEN) remote.send(text, { binary: false })
  })
  client.on('error', () => {})
  client.once('close', () => {
    clearTimeout(retry)
    streams.clear()
    remote?.terminate()
  })
  status('connecting')
}

function parse(text) {
  try {
    const frame = JSON.parse(text)
    if (typeof frame?.streamId === 'string') return frame
  } catch { /* invalid mux frame */ }
}
