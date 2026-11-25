/**
 * Serve the remote stream mux to a page that cannot open a WebSocket of its own.
 *
 * Why this exists: the desktop shell serves the app from a custom scheme, and a custom scheme
 * cannot carry a WebSocket. The page's own origin is therefore rejected by the Host's request
 * fence, while its ordinary HTTP requests are forwarded to the Host by the shell with the Host
 * credential and no Origin. This module keeps the remote mux connection on the Host side and
 * hands its frames to such a page through long-polling on the same forwarded channel.
 *
 * @module
 */
import WebSocket from 'ws'

const DEFAULT_WAIT_MS = 20000
const DEFAULT_IDLE_MS = 30000
const DEFAULT_MAX_FRAMES = 4096

/**
 * Create one mux poller over a remote connection factory.
 * @param connect - Opens the remote mux socket, or returns undefined while it cannot dial.
 * @param options - Wait ceiling, idle teardown, and frame retention for one page.
 * @returns Poll entry point plus an explicit disposer.
 */
export function createMuxPoller(connect, options = {}) {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
  // Optional: obtain a fresh credential after a dial is refused. Each `/connect` credential
  // admits one socket, so a refused dial usually means the stored one was already spent.
  const onUnauthorized = options.onUnauthorized
  let socket
  let state = 'idle'
  let sequence = 0
  let frames = []
  let waiters = []
  let lastUse = Date.now()
  let idleTimer
  let announced = false
  let recovered = false

  const wake = () => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) {
      try { resolve() } catch { /* a waiter must not break the pump */ }
    }
  }

  const attach = () => {
    if (socket !== undefined) return
    state = 'connecting'
    let opened
    try { opened = connect() } catch { opened = undefined }
    if (opened === undefined) { state = 'unavailable'; return }
    socket = opened
    announced = false
    const status = (value) => {
      frames.push({ sequence: (sequence += 1), text: JSON.stringify({ type: 'drh/relay-status', state: value }) })
      if (frames.length > maxFrames) frames = frames.slice(-maxFrames)
    }
    socket.on('open', () => {
      state = 'open'
      status('open')
      wake()
    })
    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : String(data)
      frames.push({ sequence: (sequence += 1), text })
      if (frames.length > maxFrames) frames = frames.slice(-maxFrames)
      wake()
    })
    /**
     * A dial that never opened was refused rather than interrupted; when a refresher exists,
     * replace the credential and let the next poll dial again.
     */
    const fail = (next) => {
      if (state !== 'open' && typeof onUnauthorized === 'function' && recovered !== true) {
        recovered = true
        state = 'recovering'
        Promise.resolve()
          .then(() => onUnauthorized())
          .catch((error) => {
            console.log('[dsh-remote-host] credential refresh failed: ' + String(error).slice(0, 200))
          })
          .then(() => {
            try { socket.close() } catch { /* already gone */ }
            socket = undefined
            state = 'idle'
            wake()
          })
        return
      }
      state = next
      status('closed')
      wake()
    }
    socket.on('close', () => { fail('closed') })
    socket.on('error', () => { fail('error') })
    // The dial may already have settled before the listeners attach; adopt that state so a
    // first poll never reports `connecting` for a socket that is open or gone.
    if (socket.readyState === WebSocket.OPEN) state = 'open'
    else if (socket.readyState === WebSocket.CLOSED) state = 'closed'
  }

  const dispose = () => {
    if (idleTimer !== undefined) { clearInterval(idleTimer); idleTimer = undefined }
    if (socket !== undefined) {
      try { socket.close() } catch { /* already gone */ }
      socket = undefined
    }
    frames = []
    waiters = []
    state = 'closed'
  }

  const touch = () => {
    lastUse = Date.now()
    if (idleTimer !== undefined) return
    idleTimer = setInterval(() => {
      if (Date.now() - lastUse < idleMs) return
      dispose()
    }, Math.min(idleMs, 5000))
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  return {
    /**
     * Deliver uplink frames and wait for downlink frames after a cursor.
     * @param request - `{ cursor, uplink, waitMs }` from the page.
     * @returns `{ state, cursor, frames }` describing what is available now.
     */
    async poll(request) {
      touch()
      attach()
      const uplink = Array.isArray(request?.uplink) ? request.uplink : []
      for (const frame of uplink) {
        if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
          try { socket.send(String(frame), { binary: false }) } catch { /* dropped uplink frame */ }
        }
      }
      let cursor = Number.isFinite(Number(request?.cursor)) ? Number(request.cursor) : 0
      const budget = Math.min(Math.max(Number(request?.waitMs ?? waitMs), 0), waitMs)
      const deadline = Date.now() + budget
      for (;;) {
        const ready = frames.filter((entry) => entry.sequence > cursor)
        if (ready.length > 0) {
          return { state, cursor: ready[ready.length - 1].sequence, frames: ready.map((entry) => entry.text) }
        }
        // Announce the open edge immediately: the mux protocol expects the client's handshake
        // right after it opens, and a page that only learns about the open edge at the end of a
        // held poll would handshake too late — the remote closes the idle stream first.
        if (state === 'open' && announced !== true) {
          announced = true
          return { state, cursor, frames: [] }
        }
        if (state === 'closed' || state === 'error' || state === 'unavailable') return { state, cursor, frames: [] }
        const remaining = deadline - Date.now()
        if (remaining <= 0) return { state, cursor, frames: [] }
        await new Promise((resolve) => {
          waiters.push(resolve)
          const timer = setTimeout(resolve, remaining)
          if (typeof timer.unref === 'function') timer.unref()
        })
      }
    },
    dispose,
  }
}
