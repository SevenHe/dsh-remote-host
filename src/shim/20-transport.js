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
   * Router scope audit (2026-11-23).
   *
   * refersRemote() decides by "does the payload text contain a known remote id", which is
   * only correct when that id is the call's SUBJECT. The cases below are the ones whose
   * scope is an explicit field, so a substring hit is an accident rather than an identity:
   *
   *   session/create        workspace-scoped  -> now decided by createTarget() (fixed here)
   *   workspace/{rename,delete,insertBefore,insertSessionBefore}
   *                         workspace-scoped  -> still substring. Works today only because a
   *                         remote workspace is published as drh:<raw> and <raw> is in
   *                         remoteWorkspaceIds, so the text contains the raw id; a local
   *                         workspace id cannot contain it. Same shape of fragility as the
   *                         create bug: prefer workspaceId here next.
   *   directoryPicker/*     path-scoped       -> no ids in the payload, never routed.
   *   session/{follow,events,state,page,projections,prompt,cancel,rename,fork,updateQueue,
   *   wait,attachment,selectModel}
   *                         session-scoped    -> correct by substring: the id named IS the
   *                         subject, including the address.sessionId form.
   *   session/list, $events, $events/result
   *                         special-cased     -> merge / forwarded-event rewrite, not this rule.
   *   settings/*, pluginManager/*, pluginInventory/*, agentPresets/list,
   *   permissionPresets/catalog, skills/list, schedule/*, speech/*, messageFeedback/*,
   *   workspaceFiles/*
   *                         host-global       -> no session/workspace subject, so they can
   *                         only be misrouted by an id appearing inside a path or title.
   *                         Left as-is; a workspaceFiles path containing a session id is the
   *                         realistic case to tighten later.
   *
   * Only session/create is changed in this commit; the rest is registered so the next pass
   * can move them to explicit-field decisions without rediscovering the list.
   */

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
      // The catalogue carries no Session id, but it does need an owner; routeFetch decides
      // that from the focus/persistence clues, so this request must be handled there.
      if (request.method === 'session/modelCatalog') return true
      return refersRemote(request.payload) === true
    } catch (error) { return false }
  }

  /**
   * Follow which host owns the Session the page is looking at. Opening a Session reads it
   * (and follows its stream) with its id in the payload, so ordinary traffic carries the
   * answer; a Session id this host does not own hands the focus back, which is why local
   * pass-throughs must be observed too.
   * @param request - parsed client request, when the body was a JSON envelope.
   */
  function trackSessionFocus(request) {
    if (request === undefined) return
    if (refersRemote(request.payload)) noteRemoteFocus(request.method)
    else if (mentionsSessionId(request.payload)) clearRemoteFocus('local-session')
  }

  /**
   * Bound for the mount catalogue read. The client awaits it while booting, so a mount that
   * stopped answering must not hold the promise open.
   */
  var CATALOG_READ_TIMEOUT_MS = 2500

  /** Compose the caller's signal with the catalogue bound, when the runtime has both. */
  function catalogSignal(signal) {
    try {
      if (typeof AbortSignal !== 'object' || AbortSignal === null) return signal
      if (typeof AbortSignal.timeout !== 'function') return signal
      var bound = AbortSignal.timeout(CATALOG_READ_TIMEOUT_MS)
      if (signal === undefined || signal === null) return bound
      return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, bound]) : signal
    } catch (error) { return signal }
  }

  /**
   * Answer session/modelCatalog from the host that owns the Session being viewed.
   *
   * The catalogue is NOT merged: the two hosts may serve different model lists, and a union
   * would offer a local Session a remote-only model (and the reverse), which fails the moment
   * it is selected. The owner is decided by catalogOwnedByMount(); when the answer must come
   * from the mount, the read is bounded and degrades to this host.
   */
  async function routeModelCatalog(input, init, request) {
    // The Host-level warm-up names NO Session. A Host patched to take an optional sessionId
    // advertises a ONE-parameter descriptor, and the gateway client's arity check counts
    // descriptor.parameters instead of honouring acceptsUndefined, so routing that
    // zero-argument read to such a Host throws "expected 1 argument(s), got 0" inside the
    // client - a rejection no caller handles. Keep the warm-up on this host: its descriptor
    // takes no argument, which is what the warm-up calls with.
    var args = request !== undefined && request !== null && request.payload !== undefined && request.payload !== null
      ? request.payload.args : undefined
    var sessionId = args !== undefined && args !== null && typeof args.sessionId === 'string' ? args.sessionId : ''
    if (sessionId.length === 0) {
      note('catalog-prewarm-local', {})
      return localFetch(input, init)
    }
    // Nothing below may throw: this runs inside the fetch wrapper, where a synchronous throw
    // would surface as an unhandled rejection instead of a failed request.
    var remote = false
    try {
      remote = catalogOwnedByMount()
      if (remote !== true && remoteFocused() !== true && persistedCurrentSessionId().length > 0) {
        // Cold start: the client asks for the catalogue before the mount's first snapshot has
        // landed, so the persisted Session cannot be classified yet. Waiting for that snapshot
        // (bounded, and it is already in flight) makes the decision correct instead of falling
        // back to this host and leaving a remote Session without its model.
        var settled = await remoteSnapshotSettledWithin(CATALOG_READ_TIMEOUT_MS)
        remote = catalogOwnedByMount()
        note('catalog-waited-snapshot', { settled: settled, remote: remote })
      }
      note('catalog-owner', { remote: remote, focus: remoteFocused(), persisted: persistedCurrentSessionIsRemote() })
    } catch (error) {
      note('catalog-owner-failed', { reason: String(error).slice(0, 80) })
      return localFetch(input, init)
    }
    if (remote !== true) return localFetch(input, init)
    var bounded = {}
    if (init !== undefined && init !== null) {
      for (var key in init) { if (Object.prototype.hasOwnProperty.call(init, key)) bounded[key] = init[key] }
    }
    bounded.signal = catalogSignal(init === undefined || init === null ? undefined : init.signal)
    return localFetch(mountUrl(input), bounded).then(function (response) {
      // A dead mount can answer with an error status instead of rejecting, so both shapes
      // must degrade; only a successful answer is usable.
      if (response !== null && response !== undefined && response.ok === true) return response
      note('route-local-fallback', {
        method: 'session/modelCatalog',
        reason: 'mount status ' + String(response === null || response === undefined ? 'none' : response.status),
      })
      return localFetch(input, init)
    }).catch(function (error) {
      note('route-local-fallback', {
        method: 'session/modelCatalog',
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
    if (method === 'session/modelCatalog') return routeModelCatalog(input, init, request)
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
    // The payload names one of the mounted host's Sessions.
    var remote = request !== undefined && refersRemote(request.payload)
    if (remote) {
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
