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
   * Rebuild a session/create init without its workspaceId.
   *
   * Only used for the synthetic claim Workspace: the create it carries can only be
   * answered by a Host, and no Host owns that id, so the id is dropped and the local Host
   * supplies a plain Session. Anything unexpected leaves the request untouched.
   */
  function dropWorkspaceId(init) {
    try {
      if (init === undefined || init === null || typeof init.body !== 'string') return undefined
      var parsed = JSON.parse(init.body)
      var request = createRequest(parsed.payload)
      if (request === undefined || request.workspaceId !== CLAIM_WORKSPACE_ID) return undefined
      var copy = {}
      for (var key in request) { if (Object.prototype.hasOwnProperty.call(request, key) && key !== 'workspaceId') copy[key] = request[key] }
      parsed.payload.args.request = copy
      var forwarded = {}
      for (var field in init) { if (Object.prototype.hasOwnProperty.call(init, field)) forwarded[field] = init[field] }
      forwarded.body = JSON.stringify(parsed)
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
      // A create is workspace-scoped: never let a mention of a remote Session id in the
      // payload send it to the mount (that is what made boot restore fail every start).
      // The claim Workspace still needs the rewrite below, so it is handled here too
      // rather than being passed straight to the local Host.
      if (request.method === 'session/create') {
        return createTarget(request.payload) === 'remote' || isClaimCreate(request.payload) === true
      }
      return refersRemote(request.payload) === true
    } catch (error) { return false }
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
    if (method === 'session/list') return mergeSessionList(input, init, request)
    if (method === EVENT_RESULT_ENDPOINT) {
      var rewritten = rewriteEventResult(init)
      if (rewritten !== undefined) return localFetch(mountUrl(input), rewritten)
      return localFetch(input, init)
    }
    if (method === 'session/create') {
      if (createTarget(request.payload) === 'remote') {
        note('route-remote', { method: method })
        return localFetch(mountUrl(input), init)
      }
      // The claim Workspace exists only in the merged client view, so neither Host can
      // resolve it. Restore asks for a Session there on the first load after such a
      // selection; drop the workspace and let the local Host answer, instead of failing
      // the whole restoration with workspace/not-found.
      var claimless = isClaimCreate(request.payload) === true ? dropWorkspaceId(init) : undefined
      if (claimless !== undefined) note('claim-create-local', { method: method })
      return localFetch(input, claimless === undefined ? init : claimless)
    }
    if (request !== undefined && refersRemote(request.payload)) {
      note('route-remote', { method: method })
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

