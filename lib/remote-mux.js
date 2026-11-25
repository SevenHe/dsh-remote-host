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

/**
 * Keep one renderer socket alive while the Host reconnects its upstream mux.
 * @param connect - dials one upstream mux socket, or returns undefined while the dial is blocked.
 * @param options - logging sink and credential exchange for refused handshakes.
 * @param options.log - receives one diagnostic line per relay transition, when configured.
 * @param options.refresh - exchanges a usable credential after a refused handshake spent this leg's.
 */
export function createRemoteMuxRelay(connect, options = {}) {
  const log = options.log ?? (() => {})
  const refresh = options.refresh
  const server = new WebSocketServer({ noServer: true })
  return {
    upgrade(req, socket, head) {
      log('mux relay: upgrading ' + String(req.url ?? '?'))
      server.handleUpgrade(req, socket, head, (client) => relay(client, connect, log, refresh))
    },
    dispose() {
      for (const client of server.clients) client.terminate()
      server.close()
    },
  }
}

function relay(client, connect, log, refresh) {
  const streams = new Map()
  let remote
  let retry
  let delay = RETRY_MIN_MS
  let reportedState
  /** Set by a refused handshake: the credential this leg read is spent, so exchange a new one. */
  let refused = false
  /** True while a credential exchange is in flight, so one refusal exchanges once. */
  let exchanging = false

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
    if (client.readyState !== WebSocket.OPEN || remote !== undefined || exchanging) return
    if (streams.size === 0) return
    // A remote Host admits one socket per credential, so a refusal means this leg holds a spent
    // one. Exchanging before every retry is what makes the next handshake a fresh socket; retrying
    // the same value only spends the exchange budget on guaranteed 401s.
    if (refused && typeof refresh === 'function') {
      refused = false
      exchanging = true
      log('mux relay: exchanging a credential after the refused handshake')
      Promise.resolve()
        .then(() => refresh())
        .then(() => { exchanging = false; dial() }, (error) => {
          exchanging = false
          log('mux relay: credential exchange failed ' + String(error).slice(0, 160))
          status('error')
          schedule()
        })
      return
    }
    let socket
    try { socket = connect() } catch (error) {
      // A dial that cannot even construct a socket is the same outage as one that never opens.
      log('mux relay: dial threw ' + String(error).slice(0, 160))
    }
    if (socket === undefined) {
      log('mux relay: dial unavailable')
      status('error')
      schedule()
      return
    }
    remote = socket
    log('mux relay: dial ' + String(streams.size) + ' stream(s)')
    socket.once('open', () => {
      delay = RETRY_MIN_MS
      refused = false
      log('mux relay: upstream open')
      status('open')
      for (const stream of streams.values()) sendOpen(stream)
    })
    // A refused handshake never opens, and ws keeps the socket half-open for a listener that
    // handles the response; draining it is what lets the retry run instead of wedging the leg.
    socket.once('unexpected-response', (_request, response) => {
      refused = true
      log('mux relay: upstream refused HTTP ' + String(response.statusCode ?? '?'))
      response.resume()
      socket.terminate()
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
    // ws emits close after a transport error, so handle loss only once. A refusal is already
    // reported by the handshake line above; its close is not a second failure.
    socket.on('error', (error) => {
      if (refused !== true) log('mux relay: upstream error ' + String(error).slice(0, 160))
    })
    socket.once('close', (code) => {
      log('mux relay: upstream closed ' + String(code))
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
      log('mux relay: page open ' + String(frame.endpoint) + ' streams=' + String(streams.size + 1))
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
