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

  /** Build and publish the transport over `base`, chaining to it for local calls. */
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
      // Local pass-throughs must be observed as well: opening a Session this host owns is
      // what hands the model catalogue back to it.
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
          if (usingSocketFactory !== true && isMuxUrl(String(url))) {
            note('ws-patched-mux', { url: String(url) })
            try {
              return routeCreateWebSocket(String(url))
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
      /**
       * A mount failure as a carrier result. Every branch below returns this instead of
       * letting the promise reject: the shipped Client treats a rejection as a crashing
       * service call, and a corp-network blip reaches this path on every remote call.
       */
      var carrierUnavailable = function (endpoint, error) {
        note('carrier-failed', { method: endpoint, error: String(error).slice(0, 80) })
        return {
          ok: false,
          error: {
            code: 'gateway/carrier-unavailable',
            message: 'drh: the local carrier failed for ' + endpoint,
            details: {},
          },
        }
      }
      var remoteUnavailable = function (endpoint, error) {
        note('route-remote-failed', { method: endpoint, error: String(error).slice(0, 80) })
        return {
          ok: false,
          error: {
            code: 'gateway/remote-unavailable',
            message: 'drh: the mounted host is unreachable for ' + endpoint,
            details: {},
          },
        }
      }
      built.rpc = {
        call: function (channel, endpoint, payload, signal) {
          if (endpoint === 'session/list') {
            return Promise.all([
              // The local leg can fail too on a shell whose carrier travels the network.
              baseRpc.call(channel, endpoint, payload, signal).catch(function () { return undefined }),
              remoteUnary(endpoint, payload, signal).catch(function () { return undefined }),
            ]).then(function (both) {
              var localResult = both[0]
              var remoteResult = both[1]
              if (remoteResult === undefined || remoteResult === null || remoteResult.ok !== true) {
                note('list-merge-skipped', { reason: 'remote unavailable' })
                // The local half is the answer when it exists. When it does not, say so:
                // resolving undefined leaves the Client unable to render anything.
                if (localResult !== undefined && localResult !== null) return localResult
                return remoteUnavailable(endpoint, 'neither leg answered')
              }
              if (localResult === null || typeof localResult !== 'object' || localResult.ok !== true) {
                // Only the remote half answered: serve it rather than resolving to nothing.
                if (remoteResult.ok === true) return remoteResult
                // Both legs failed (a blip reaches the local carrier on some shells too).
                return remoteUnavailable(endpoint, 'local and mounted host both unavailable')
              }
              var merged = mergeListValues(localResult.value, remoteResult.value)
              note('list-merge', { local: merged.localCount, remote: merged.remoteCount, visibleRemote: merged.visibleRemote })
              // The rpc carrier merges like the fetch one, so it publishes like it too: the
              // plugin-rendered block reads only the published snapshot, and without this a
              // group:none page had to wait for the 4 s poll to see a remote Session.
              var remoteItems = sessionItemsOf(remoteResult)
              try { publishRemoteSessionList(remoteItems === undefined ? [] : remoteItems) } catch (error) { /* publishing is best effort */ }
              return { ok: true, value: merged.value }
            })
          }
          // A create is workspace-scoped, exactly as in the fetch carrier: a payload that
          // merely names the remote Session being restored must not be sent to the remote
          // host, and the synthetic claim workspace must reach the local host without its
          // workspaceId. A desktop shell publishes this carrier, so the decision has to be
          // repeated here or the fetch-side fix silently does nothing on that path.
          if (endpoint === 'session/create') {
            if (createTarget(payload) === 'remote') {
              note('route-remote', { endpoint: endpoint })
              return remoteUnary(endpoint, payload, signal).catch(function (error) {
                return remoteUnavailable(endpoint, error)
              })
            }
            var claimless = withoutWorkspaceId(payload)
            if (claimless !== undefined) note('claim-create-local', { endpoint: endpoint })
            return baseRpc.call(channel, endpoint, claimless === undefined ? payload : claimless, signal).catch(function (error) {
              return carrierUnavailable(endpoint, error)
            })
          }
          // The shell decodes this carrier instead of fetch, and it asks for the catalogue the
          // same way, so the owner decision has to exist here too.
          trackSessionFocus({ method: endpoint, payload: payload })
          if (endpoint === 'session/modelCatalog') {
            var ownedByMount = catalogOwnedByMount()
            note('catalog-owner', { remote: ownedByMount, carrier: 'rpc' })
            if (ownedByMount !== true) {
              return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
                return carrierUnavailable(endpoint, error)
              })
            }
            return remoteUnary(endpoint, payload, catalogSignal(signal)).catch(function () {
              note('route-local-fallback', { method: endpoint, reason: 'mount failed' })
              // The fallback itself can fail: answer a carrier result rather than reject.
              return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
                return carrierUnavailable(endpoint, error)
              })
            })
          }
          if (refersRemote(payload)) {
            note('route-remote', { endpoint: endpoint })
            return remoteUnary(endpoint, payload, signal).catch(function (error) {
              return remoteUnavailable(endpoint, error)
            })
          }
          return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
            return carrierUnavailable(endpoint, error)
          })
        },
      }
      if (typeof baseRpc.open === 'function') built.rpc.open = baseRpc.open
    }
    built.__dshRemoteHost = true
    globalThis.__DSH_TRANSPORT__ = built
    note('installed', { carrier: diag.hasRpc === true ? 'rpc' : 'fetch', streams: STREAMS, streamBaseUrl: diag.streamBaseUrl, group: GROUP_MODE })
    prefetchWorkspaces()
    prefetchRemoteSessions()
    // Last: breadcrumbs must never sit between a carrier and its first call.
    traceInstall()
    return built
  }

  install(previous)
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
