/**
 * MODULE: 80-install.js
 * Install: build the transport over the carrier, patch the global WebSocket, start
 * self-update and prefetch, and adopt a late-injected carrier.
 */
  function installSelfUpdate() {
    try {
      var rev = typeof config.rev === 'string' ? config.rev : undefined
      if (rev === undefined || typeof document !== 'object' || typeof document.addEventListener !== 'function') return
      var lastInput = Date.now()
      var markInput = function () { lastInput = Date.now() }
      var inputEvents = ['pointerdown', 'keydown', 'wheel']
      for (var eventIndex = 0; eventIndex < inputEvents.length; eventIndex += 1) {
        document.addEventListener(inputEvents[eventIndex], markInput, true)
      }
      var check = function () {
        try {
          globalThis.fetch(MOUNT + '/__dsh_remote_host__/report').then(function (response) {
            return response.json()
          }).then(function (payload) {
            if (payload === null || typeof payload !== 'object') return
            if (typeof payload.rev !== 'string' || payload.rev === rev) return
            // Reload while hidden, or once the page has been idle: a rebuild must
            // never interrupt typing.
            if (document.visibilityState !== 'hidden' && Date.now() - lastInput < 20000) return
            note('self-update', { from: rev, to: payload.rev })
            try { location.reload() } catch (error) { /* ignore */ }
          }).catch(function () { /* offline: try next time */ })
        } catch (error) { /* ignore */ }
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') setTimeout(check, 800)
      })
      // Poll as well: the desktop shell has no reload shortcut, and waiting for a
      // tab switch means a rebuild can stay invisible for hours.
      if (typeof setInterval === 'function') setInterval(check, 20000)
    } catch (error) { /* self update is best effort */ }
  }

  function install(base) {
    previous = base
    refreshDiag(base)
    var built = {}
    for (var key in base) { if (Object.prototype.hasOwnProperty.call(base, key)) built[key] = base[key] }
    built.fetch = function (input, init) {
      if (SUPERAGENT_REMOTE === true) {
        var superPath = pathOf(input)
        if (superPath !== undefined && (superPath === '/orchestrator' || superPath.indexOf('/orchestrator/') === 0)) {
          note('orchestrator-remote', { path: superPath.slice(0, 60) })
          return localFetch(mountUrl(input), init)
        }
      }
      if (ATTACH_REMOTE === true) {
        // Detect the call by path: the body may be a Request or a non-string body,
        // and parsing it wrongly silently fell back to the local host.
        var path = pathOf(input)
        if (path !== undefined && path.indexOf('/api/') !== -1) {
          return localFetch(mountUrl(input), init).then(function (response) {
            // An endpoint the remote does not serve belongs to the local shell.
            if (response.status !== 404) return response
            return localFetch(input, init)
          }).catch(function () { return localFetch(input, init) })
        }
        return localFetch(input, init)
      }
      if (wouldRoute(input, init) !== true) return localFetch(input, init)
      return routeFetch(input, init).catch(function () { return localFetch(input, init) })
    }
    if (STREAMS === true) {
      built.createWebSocket = routeCreateWebSocket
      // Catch-all: a carrier that resolves the mux URL itself (a streamBaseUrl
      // deployment) constructs WebSocket directly and never calls our factory.
      try {
        var RoutedWebSocket = function (url, protocols) {
          if (isMuxUrl(String(url))) {
            note('ws-patched-mux', { url: String(url) })
            try {
              return createMuxRouter(String(url))
            } catch (error) {
              note('ws-patched-failed', { error: String(error) })
            }
          }
          return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
        }
        RoutedWebSocket.prototype = NativeWebSocket.prototype
        RoutedWebSocket.CONNECTING = 0
        RoutedWebSocket.OPEN = 1
        RoutedWebSocket.CLOSING = 2
        RoutedWebSocket.CLOSED = 3
        globalThis.WebSocket = RoutedWebSocket
        note('ws-patched', { active: true })
      } catch (error) {
        note('ws-patch-failed', { error: String(error) })
      }
    }
    // The desktop shell may hand the page a fully decoded carrier (`rpc`)
    // instead of `fetch`; that carrier wins over every other field, so routing
    // has to wrap it too or nothing below would ever run.
    if (diag.hasRpc === true && typeof base.rpc.call === 'function') {
      var baseRpc = base.rpc
      built.rpc = {
        call: function (channel, endpoint, payload, signal) {
          if (endpoint === 'session/list') {
            return Promise.all([
              baseRpc.call(channel, endpoint, payload, signal),
              remoteUnary(endpoint, payload, signal).catch(function () { return undefined }),
            ]).then(function (both) {
              var localResult = both[0]
              var remoteResult = both[1]
              if (remoteResult === undefined || remoteResult === null || remoteResult.ok !== true) {
                note('list-merge-skipped', { reason: 'remote unavailable' })
                return localResult
              }
              if (localResult === null || typeof localResult !== 'object' || localResult.ok !== true) return localResult
              var merged = mergeListValues(localResult.value, remoteResult.value)
              note('list-merge', { local: merged.localCount, remote: merged.remoteCount, visibleRemote: merged.visibleRemote })
              return { ok: true, value: merged.value }
            })
          }
          if (refersRemote(payload)) {
            note('route-remote', { endpoint: endpoint })
            return remoteUnary(endpoint, payload, signal)
          }
          return baseRpc.call(channel, endpoint, payload, signal)
        },
      }
      if (typeof baseRpc.open === 'function') built.rpc.open = baseRpc.open
    }
    built.__dshRemoteHost = true
    globalThis.__DSH_TRANSPORT__ = built
    hooks = built
    note('installed', { carrier: diag.hasRpc === true ? 'rpc' : 'fetch', streams: STREAMS, streamBaseUrl: diag.streamBaseUrl, group: GROUP_MODE })
    prefetchWorkspaces()
    prefetchRemoteSessions()
    installSelfUpdate()
    return built
  }

  var hooks = install(previous)

  // The shell may publish its carrier after page scripts run. Adopt whatever is
  // there on a few beats, so either ordering ends with routing installed.
  function adopt() {
    var current = globalThis.__DSH_TRANSPORT__
    if (current === undefined || current === null) return
    if (current.__dshRemoteHost === true) return
    install(current)
    note('adopted-late-carrier', { keys: Object.keys(current) })
  }
  var schedule = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout.bind(globalThis)
    : undefined

  function adoptUntilSettled(attempt) {
    adopt()
    // The shell publishes its carrier after an async IPC boot, so keep watching
    // for a few seconds rather than assuming it lands within one beat.
    if (schedule === undefined || attempt >= 80) return
    schedule(function () { adoptUntilSettled(attempt + 1) }, attempt < 10 ? 25 : 100)
  }

  if (schedule !== undefined) {
    adoptUntilSettled(0)
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('load', function () { adopt() })
    }
  }
