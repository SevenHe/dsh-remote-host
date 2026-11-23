/**
 * MODULE: 60-runtime.js
 * WebSocket factory, diagnostics sink, group refresh, and the prefetches that make
 * the routing table ready before the client asks.
 */
  /**
   * The carrier hands the factory an absolute mux URL; only that channel is
   * multiplexed, everything else keeps the original socket.
   */
  function routeCreateWebSocket(url) {
    var target = typeof url === 'string' ? url : String(url)
    note('ws-factory', { url: target.slice(0, 90), mux: isMuxUrl(target) === true })
    if (isMuxUrl(target) !== true) return openSocket(target)
    if (STREAM_RELAY === true) {
      // Only rewrite the URL: the shipped connection layer dials the mounted mux itself and
      // owns reconnects, so no reconnect socket is ever created here.
      var relayed = mountSocketUrl(target)
      if (relayed !== undefined) {
        note('stream-relay', { from: target.slice(0, 90), to: relayed.slice(0, 90) })
        traceEvent('stream-relay', { to: relayed.slice(0, 90) })
        return openSocket(relayed)
      }
      note('stream-relay-no-url', { url: target.slice(0, 90) })
    }
    try {
      note('mux-router', { url: target })
      return createMuxRouter(target)
    } catch (error) {
      note('mux-router-failed', { error: String(error) })
      return openSocket(target)
    }
  }

  /** Diagnostics the Host can read back through the mount. */
  var diag = {
    installedAt: new Date().toISOString(),
    href: typeof location === 'object' ? location.href : null,
    origin: typeof location === 'object' ? location.origin : null,
    mount: MOUNT,
    previousKeys: Object.keys(previous),
    hasRpc: previous.rpc !== undefined && previous.rpc !== null && typeof previous.rpc === 'object',
    rpcKeys: previous.rpc === undefined || previous.rpc === null ? [] : Object.keys(previous.rpc),
    hasFetch: typeof previous.fetch === 'function',
    hasCreateWebSocket: typeof previous.createWebSocket === 'function',
    streamBaseUrl: typeof previous.streamBaseUrl === 'string' ? previous.streamBaseUrl : null,
    events: [],
  }

  /**
   * Optional extra sink for development, off unless `diagnosticsSink` names one.
   * Diagnostics already reach the Host through the mount report route.
   */
  var SINK = typeof config.diagnosticsSink === 'string' && config.diagnosticsSink.length > 0
    ? config.diagnosticsSink
    : undefined

  function post(url, body) {
    try {
      globalThis.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      }).catch(function () {
        // A document that blocks fetch may still deliver a beacon.
        try {
          if (typeof navigator === 'object' && typeof navigator.sendBeacon === 'function') {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
          }
        } catch (error) { /* diagnostics are best effort */ }
      })
    } catch (error) { /* never break the page for a diagnostic */ }
  }

  /**
   * One send per second at most.
   *
   * The body is a whole snapshot, not an append-only log, so coalescing loses nothing
   * but intermediate states — while a page in trouble (which is exactly when note()
   * fires most often) otherwise posts continuously. Measured at 1.3 requests per
   * second against an unreachable mount before this ceiling.
   */
  var PUBLISH_MIN_INTERVAL_MS = 1000
  var publishLastAt = 0
  var publishPending = false
  var publishTimer

  function publish() {
    publishLastAt = Date.now()
    var body = JSON.stringify(diag)
    post(MOUNT + '/__dsh_remote_host__/report', body)
    if (SINK !== undefined) post(SINK, body)
  }

  /** Publish now, or once the window opens; the latest snapshot is what gets sent. */
  function publishSoon() {
    if (publishPending === true) return
    var wait = publishLastAt + PUBLISH_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) { publish(); return }
    publishPending = true
    publishTimer = globalThis.setTimeout(function () {
      publishPending = false
      publishTimer = undefined
      publish()
    }, wait)
  }

  function note(name, data) {
    diag.events.push({ name: name, at: Date.now(), data: data })
    if (diag.events.length > 40) diag.events.shift()
    publishSoon()
  }

  /** Refresh merged group frames when the remote session registry changed. */
  function refreshGroups() {
    try {
      if (activeRouter !== undefined && typeof activeRouter.__refreshGroups === 'function') activeRouter.__refreshGroups()
    } catch (error) { /* group refresh is best effort */ }
  }

  function nextRpcId() {
    try { return globalThis.crypto.randomUUID() } catch (error) {
      return 'rpc-' + String(Date.now()) + '-' + Math.random().toString(16).slice(2)
    }
  }

