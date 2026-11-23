/**
 * MODULE: 80-install.js
 * Install: build the transport over the carrier, patch the global WebSocket, start
 * self-update and prefetch, and adopt a late-injected carrier.
 */
  /**
   * Reload the page once when the shim on disk changed, while the window is hidden.
   *
   * One guard matters, learned the hard way: the shell can serve the same cached
   * document again, so a reload may not pick up the new shim. If the page still
   * holds the old revision afterwards, stop trying — reloading forever is worse than
   * running one revision behind. Rewriting the URL to bust that cache crashed the
   * renderer, so this only ever calls `location.reload()`.
   */
  function installSelfUpdate() {
    try {
      var rev = typeof config.rev === 'string' ? config.rev : undefined
      if (rev === undefined || typeof document !== 'object' || typeof document.addEventListener !== 'function') return
      var KEY = 'drh:self-update'
      var read = function () {
        try {
          if (globalThis.sessionStorage === undefined || globalThis.sessionStorage === null) return undefined
          var raw = globalThis.sessionStorage.getItem(KEY)
          return raw === null ? undefined : JSON.parse(raw)
        } catch (error) { return undefined }
      }
      var write = function (value) {
        try {
          if (globalThis.sessionStorage !== undefined && globalThis.sessionStorage !== null) globalThis.sessionStorage.setItem(KEY, JSON.stringify(value))
        } catch (error) { /* storage may be unavailable */ }
      }
      var attempt = read()
      if (attempt !== undefined && typeof attempt.forRev === 'string' && attempt.forRev !== rev) {
        note('self-update-give-up', { loaded: rev, wanted: attempt.forRev })
        return
      }
      var reloading = false
      var check = function () {
        if (reloading || document.visibilityState !== 'hidden') return
        try {
          globalThis.fetch(MOUNT + '/__dsh_remote_host__/report').then(function (response) {
            return response.json()
          }).then(function (payload) {
            if (reloading || document.visibilityState !== 'hidden') return
            if (payload === null || typeof payload !== 'object') return
            var next = typeof payload.rev === 'string' ? payload.rev : undefined
            if (next === undefined || next === rev) return
            reloading = true
            note('self-update', { from: rev, to: next })
            write({ forRev: next, at: Date.now() })
            // Plain reload only. Navigating a dsh-app:// URL with an added query
            // crashed the renderer (EXC_BREAKPOINT in V8) — and the one-shot guard
            // below already prevents a reload loop, so no cache busting is needed.
            location.reload()
          }).catch(function () { /* offline: try next time */ })
        } catch (error) { /* ignore */ }
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') setTimeout(check, 500)
      })
      if (typeof setInterval === 'function') setInterval(check, 60000)
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
      // Local pass-throughs must be observed as well: opening a Session this host
      // owns is what hands the mount-scoped configuration reads back to it.
      trackSessionFocus(requestOf(init))
      if (wouldRoute(input, init) !== true) return localFetch(input, init)
      return routeFetch(input, init).catch(function () { return localFetch(input, init) })
    }
    if (STREAMS === true) {
      built.createWebSocket = routeCreateWebSocket
      // Catch-all: a carrier that resolves the mux URL itself (a streamBaseUrl
      // deployment) constructs WebSocket directly and never calls our factory.
      // Replacing the global constructor is the most invasive hook we install, so
      // it stays switchable: a carrier that already calls createWebSocket does not
      // need it, and a native consumer that inspects the constructor can trip on a
      // JS stand-in. `globalWebSocket: false` keeps the factory patch only.
      if (GLOBAL_WS === true) try {
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
          // The desktop shell decodes this carrier instead of fetch, so mount-scoped
          // configuration reads have to be routed here too, or the picker keeps
          // listing this host's models for a Session the mount will run.
          trackSessionFocus({ method: endpoint, payload: payload })
          if (modelScopedMethod(endpoint) && remoteFocused()) {
            note('route-remote', { endpoint: endpoint })
            return remoteUnary(endpoint, payload, boundedSignal(signal)).catch(function () {
              note('route-local-fallback', { method: endpoint, reason: 'mount failed' })
              return baseRpc.call(channel, endpoint, payload, signal)
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
    // Last: breadcrumbs must never sit between a carrier and its first call.
    traceInstall()
    return built
  }

  var hooks = install(previous)
  installSelfUpdate()

  // The shell may publish its carrier after page scripts run. Adopt whatever is
  // there on a few beats, so either ordering ends with routing installed.
  /**
   * Whether a carrier was already present when this script ran. The install above
   * wraps whatever the base held, so a non-empty base means the shell published
   * before us and nothing has to be waited for. An empty base means the shell may
   * still publish one, and only then is the bounded watch below worth running.
   */
  var adoptedAtBoot = Object.keys(previous).length > 0
  /** First re-check delay; each miss adds one step up to the ceiling. */
  var ADOPT_FIRST_DELAY_MS = 100
  var ADOPT_DELAY_STEP_MS = 25
  var ADOPT_MAX_DELAY_MS = 250
  /** Hard caps, so a page whose shell never publishes a carrier cannot tick forever. */
  var ADOPT_MAX_ATTEMPTS = 24
  var ADOPT_MAX_ELAPSED_MS = 6000

  /** @returns true once a carrier is installed, by this call or an earlier one. */
  function adopt() {
    if (adoptedAtBoot === true) return true
    var current = globalThis.__DSH_TRANSPORT__
    if (current === undefined || current === null) return false
    // Our own wrapper from the install above: the shell has not published yet.
    if (current.__dshRemoteHost === true) return false
    install(current)
    note('adopted-late-carrier', { keys: Object.keys(current) })
    adoptedAtBoot = true
    return true
  }
  var schedule = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout.bind(globalThis)
    : undefined

  /**
   * Watch for a carrier the shell publishes after this script, for a bounded time.
   * Stops on the first successful adoption instead of running the whole schedule: a
   * carrier present at boot settles on the first call and schedules nothing.
   * @param attempt - zero-based attempt index, used for the backoff step.
   * @param startedAt - wall clock of the first attempt, for the elapsed cap.
   */
  function adoptUntilSettled(attempt, startedAt) {
    if (adopt() === true) return
    if (schedule === undefined) return
    if (attempt + 1 >= ADOPT_MAX_ATTEMPTS) return
    if (Date.now() - startedAt >= ADOPT_MAX_ELAPSED_MS) return
    var delay = Math.min(ADOPT_MAX_DELAY_MS, ADOPT_FIRST_DELAY_MS + attempt * ADOPT_DELAY_STEP_MS)
    schedule(function () { adoptUntilSettled(attempt + 1, startedAt) }, delay)
  }

  if (schedule !== undefined) {
    adoptUntilSettled(0, Date.now())
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('load', function () { adopt() })
    }
  }
