/**
 * MODULE: 20-transport.js
 * Request classification: which calls belong to the remote host, how the mount and
 * mux socket URLs are derived, and the error-envelope helper.
 */
  /** Rewrite a remote waterfall answer so the remote peer accepts it. */
  function rewriteEventResult(init) {
    try {
      var request = JSON.parse(init.body)
      var args = request.payload && request.payload.args
      if (args === null || typeof args !== 'object' || remoteEventIdSet.has(args.eventId) === false) return undefined
      if (typeof remoteEventClientId !== 'string') return undefined
      args.clientId = remoteEventClientId
      request.payload.args = args
      forgetRemoteEvent(args.eventId)
      var forwarded = {}
      for (var key in init) { if (Object.prototype.hasOwnProperty.call(init, key)) forwarded[key] = init[key] }
      forwarded.body = JSON.stringify(request)
      return forwarded
    } catch (error) {
      return undefined
    }
  }

  /**
   * Whether this call is rerouted away from the local Host. Only a reroute may
   * fall back to a second, local attempt: a pass-through request that fails has
   * already reached the Host once, and retrying it would duplicate POSTs.
   */
  function wouldRoute(input, init) {
    try {
      var request = requestOf(init)
      if (request === undefined) return false
      if (request.method === 'session/list') return true
      if (request.method === EVENT_RESULT_ENDPOINT) return true
      // Mount-scoped configuration: the model catalogue lists what THIS host can run,
      // and its request carries no session id, so it must follow the focused Session.
      if (modelScopedMethod(request.method)) return remoteFocused()
      return refersRemote(request.payload) === true
    } catch (error) { return false }
  }

  /**
   * Follow which host owns the Session the page is looking at. Opening a Session
   * reads it (and follows its stream) with its id in the payload, so ordinary
   * traffic carries the answer; a Session id this host does not own hands the
   * focus back, which is why local pass-throughs must be observed too.
   * @param request - parsed client request, when the body was a JSON envelope.
   */
  function trackSessionFocus(request) {
    if (request === undefined) return
    if (refersRemote(request.payload)) noteRemoteFocus(request.method)
    else if (mentionsSessionId(request.payload)) clearRemoteFocus('local-session')
  }

  /**
   * Bound for a mount-scoped configuration read. The renderer awaits it while
   * building the picker, so a mount that stopped answering must not hold the
   * promise open; the plugin's rule is that every awaited remote call is bounded
   * and degrades to this host.
   */
  var MODEL_READ_TIMEOUT_MS = 2500

  /** Compose the caller's signal with the model-read bound, when the runtime has both. */
  function boundedSignal(signal) {
    try {
      if (typeof AbortSignal !== 'object' || AbortSignal === null) return signal
      if (typeof AbortSignal.timeout !== 'function') return signal
      var bound = AbortSignal.timeout(MODEL_READ_TIMEOUT_MS)
      if (signal === undefined || signal === null) return bound
      return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, bound]) : signal
    } catch (error) { return signal }
  }

  /** Read a mount-scoped answer within the bound, falling back to this host. */
  function modelReadWithFallback(input, init, method) {
    var bounded = {}
    if (init !== undefined && init !== null) {
      for (var key in init) { if (Object.prototype.hasOwnProperty.call(init, key)) bounded[key] = init[key] }
    }
    bounded.signal = boundedSignal(init === undefined || init === null ? undefined : init.signal)
    return localFetch(mountUrl(input), bounded).catch(function (error) {
      note('route-local-fallback', {
        method: method,
        reason: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error).slice(0, 80),
      })
      return localFetch(input, init)
    })
  }

  /** Method names already reported, so diagnostics stay one line per endpoint. */
  var seenMethods = new Set()

  async function routeFetch(input, init) {
    var request = requestOf(init)
    var method = request === undefined ? undefined : request.method
    if (method !== undefined) {
      // Record every distinct method once: enough to see what the UI calls and where
      // it was routed, without flooding the report with repeated calls.
      if (seenMethods.has(method) !== true) {
        seenMethods.add(method)
        note('fetch-rpc', { method: method, remote: request !== undefined && refersRemote(request.payload) === true })
      }
    }
    trackSessionFocus(request)
    if (method === 'session/list') return mergeSessionList(input, init, request)
    if (method === EVENT_RESULT_ENDPOINT) {
      var rewritten = rewriteEventResult(init)
      if (rewritten !== undefined) return localFetch(mountUrl(input), rewritten)
      return localFetch(input, init)
    }
    // Two ways to belong to the mounted host: the payload names one of its Sessions,
    // or the method is per-host configuration and that host owns the focused Session.
    var remote = request !== undefined && (refersRemote(request.payload)
      || (modelScopedMethod(method) && remoteFocused()))
    if (remote) {
      note('route-remote', { method: method })
      if (modelScopedMethod(method)) return modelReadWithFallback(input, init, method)
      return localFetch(mountUrl(input), init)
    }
    return localFetch(input, init)
  }

  /** Resolve the same channel beneath the mount, preserving scheme and query. */
  function mountSocketUrl(url) {
    try {
      var parsed = new URL(url, typeof location === 'object' ? location.href : undefined)
      parsed.pathname = MOUNT + parsed.pathname
      return parsed.toString()
    } catch (error) {
      return undefined
    }
  }

  function openSocket(url) {
    var factory = previous.createWebSocket
    if (typeof factory === 'function') return factory(url)
    return new NativeWebSocket(url)
  }

  /** Exact mux pathname matching: a substring test would catch lookalikes. */
  function isMuxUrl(url) {
    if (typeof url !== 'string') return false
    try {
      var parsed = new URL(url, typeof location === 'object' ? location.href : undefined)
      return parsed.pathname === '/api/remote.mux' || parsed.pathname.slice(-15) === '/api/remote.mux'
    } catch (error) {
      return url.length >= 15 && url.slice(-15) === '/api/remote.mux'
    }
  }

