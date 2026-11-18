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

  /** Local sink, used while the Host half has not been reloaded yet. */
  var SINK = 'http://127.0.0.1:19777/report'

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

  function publish() {
    var body = JSON.stringify(diag)
    post(MOUNT + '/__dsh_remote_host__/report', body)
    post(SINK, body)
  }

  function note(name, data) {
    diag.events.push({ name: name, at: Date.now(), data: data })
    if (diag.events.length > 40) diag.events.shift()
    publish()
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

