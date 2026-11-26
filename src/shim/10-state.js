/**
 * MODULE: 10-state.js
 * Decisions over one client request: the claim-Workspace create rewrite, which Host owns a
 * Session or the model catalogue, and the session/list merge with the snapshot it publishes.
 */
  function localFetch(input, init) {
    return previous.fetch ? previous.fetch(input, init) : globalThis.fetch(input, init)
  }

  /** The request's path, whether the caller passed a string, a URL or a Request. */
  function pathOf(input) {
    try {
      if (typeof input === 'string') {
        var parsed = new URL(input, typeof location === 'object' ? location.href : undefined)
        return parsed.pathname + parsed.search
      }
      if (input !== null && typeof input === 'object' && typeof input.url === 'string') {
        var fromRequest = new URL(input.url, typeof location === 'object' ? location.href : undefined)
        return fromRequest.pathname + fromRequest.search
      }
    } catch (error) { /* fall through */ }
    return undefined
  }

  function mountUrl(input) {
    var path = pathOf(input)
    if (path !== undefined) return MOUNT + path
    var text = typeof input === 'string' ? input : String(input)
    var relative = text.charAt(0) === '/' ? text : '/' + text
    return MOUNT + relative
  }

  function requestOf(init) {
    try {
      if (init === undefined || typeof init.body !== 'string') return undefined
      var parsed = JSON.parse(init.body)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch (error) { return undefined }
  }

  /** Synthetic claim Workspace: published only in the merged client view, owned by no host. */
  var CLAIM_WORKSPACE_ID = REMOTE_WORKSPACE_PREFIX + 'claim'

  /** The create request inside a client-request payload, when it is a create. */
  function createRequest(payload) {
    var args = payload !== null && typeof payload === 'object' ? payload.args : undefined
    var request = args !== null && typeof args === 'object' ? args.request : undefined
    return request !== null && typeof request === 'object' ? request : undefined
  }

  /**
   * Which Host owns a session/create.
   *
   * A create is workspace-scoped, so it must be decided by its workspaceId. Deciding it
   * from "does the payload mention a remote id" routed a boot-time restore create to the
   * mount whenever the payload carried the remote Session id it was restoring, or the
   * synthetic claim workspace, and the mount answered workspace/not-found on every start.
   * Only a workspace the remote host actually owns belongs to the mount.
   * @returns 'remote' or 'local'.
   */
  function createTarget(payload) {
    var request = createRequest(payload)
    var workspaceId = request === undefined ? undefined : request.workspaceId
    if (typeof workspaceId !== 'string') return 'local'
    if (workspaceId.indexOf(REMOTE_WORKSPACE_PREFIX) !== 0) return 'local'
    var raw = workspaceId.slice(REMOTE_WORKSPACE_PREFIX.length)
    return remoteWorkspaceIds.has(raw) ? 'remote' : 'local'
  }

  /**
   * Copy a create payload without its workspaceId.
   *
   * The rpc carrier hands the payload object directly, so the claim rewrite has to build a
   * new object instead of editing a JSON body (dropWorkspaceId does that for the fetch
   * carrier). Only the request/args/payload objects are copied; the caller's payload is
   * never mutated, because a carrier may reuse it.
   * @returns the rewritten payload, or undefined when this is not a claim create.
   */
  function withoutWorkspaceId(payload) {
    var request = createRequest(payload)
    if (request === undefined || request.workspaceId !== CLAIM_WORKSPACE_ID) return undefined
    var nextRequest = {}
    for (var key in request) { if (Object.prototype.hasOwnProperty.call(request, key) && key !== 'workspaceId') nextRequest[key] = request[key] }
    var args = payload.args
    var nextArgs = {}
    for (var argKey in args) { if (Object.prototype.hasOwnProperty.call(args, argKey)) nextArgs[argKey] = args[argKey] }
    nextArgs.request = nextRequest
    var nextPayload = {}
    for (var field in payload) { if (Object.prototype.hasOwnProperty.call(payload, field)) nextPayload[field] = payload[field] }
    nextPayload.args = nextArgs
    return nextPayload
  }

  /** Whether a create names the synthetic claim Workspace, which no Host can resolve. */
  function isClaimCreate(payload) {
    var request = createRequest(payload)
    return request !== undefined && request.workspaceId === CLAIM_WORKSPACE_ID
  }

  function refersRemote(value) {
    if (remoteSessions.size === 0) return false
    var text
    try { text = JSON.stringify(value) } catch (error) { return false }
    if (typeof text !== 'string') return false
    var hit = false
    remoteSessions.forEach(function (id) { if (!hit && text.indexOf(id) !== -1) hit = true })
    if (hit !== true) remoteWorkspaceIds.forEach(function (id) { if (!hit && text.indexOf(id) !== -1) hit = true })
    return hit
  }

  /** Whether a remote Session was the page's focus recently enough to own the catalogue. */
  function remoteFocused() {
    return remoteFocusAt > 0 && Date.now() - remoteFocusAt < REMOTE_FOCUS_TTL_MS
  }

  /** Record that the page is looking at a remote Session. */
  function noteRemoteFocus(method) {
    var already = remoteFocused()
    remoteFocusAt = Date.now()
    if (already !== true) note('focus-remote', { method: method })
  }

  /** Drop the focus once the page moves to a Session this host owns. */
  function clearRemoteFocus(reason) {
    if (remoteFocusAt === 0) return
    remoteFocusAt = 0
    note('focus-clear', { reason: reason })
  }

  /** Whether a payload addresses a Session at all (its id cannot be classified without one). */
  function mentionsSessionId(value) {
    try {
      var text = JSON.stringify(value)
      return typeof text === 'string' && text.indexOf('"sessionId"') !== -1
    } catch (error) { return false }
  }

  /**
   * Whether the first remote session snapshot has settled (succeeded or failed).
   *
   * The client asks for the model catalogue before the mount's first session/list lands, so
   * a persisted remote Session cannot be recognised at that instant. Waiting for this signal
   * (bounded) turns "unknown, assume this host" into the correct owner without a re-fetch.
   */
  var remoteSnapshotSettled = false
  var remoteSnapshotWaiters = []

  /** Mark the first snapshot settled and release anyone waiting on it. */
  function markRemoteSnapshotSettled() {
    if (remoteSnapshotSettled === true) return
    remoteSnapshotSettled = true
    var waiters = remoteSnapshotWaiters
    remoteSnapshotWaiters = []
    for (var index = 0; index < waiters.length; index += 1) {
      try { waiters[index](true) } catch (error) { /* a waiter must never break the refresh */ }
    }
  }

  /**
   * @param budgetMs - how long the caller may block for the first snapshot.
   * @returns true when it settled, false on timeout or without a timer.
   */
  function remoteSnapshotSettledWithin(budgetMs) {
    if (remoteSnapshotSettled === true) return Promise.resolve(true)
    return new Promise(function (resolve) {
      var done = false
      var finish = function (value) { if (done === true) return; done = true; resolve(value) }
      remoteSnapshotWaiters.push(finish)
      try { globalThis.setTimeout(function () { finish(false) }, budgetMs) } catch (error) { finish(false) }
    })
  }

  /**
   * Whether the Session the client persisted as "current" belongs to the mounted host.
   *
   * The catalogue request happens before the client restores that Session, so at a cold
   * start the focus above is still empty. The persisted value is the only clue available
   * that early. It is written in two shapes by the shipping client (a JSON object
   * { sessionId } and a bare id string), so both are accepted; anything unreadable or
   * unknown is treated as local, which keeps a local Session's behaviour unchanged.
   * @returns true only when the persisted id is a Session this shim already knows is remote.
   */
  function persistedCurrentSessionId() {
    try {
      var storage = globalThis.localStorage
      if (storage === null || storage === undefined || typeof storage.getItem !== 'function') return ''
      var raw = storage.getItem('dsh.sessions.current')
      if (typeof raw !== 'string' || raw.length === 0) return ''
      if (raw.charAt(0) !== '{') return raw
      var parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' && typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
    } catch (error) {
      return ''
    }
  }

  /** Whether the persisted current Session is one this shim already knows is remote. */
  function persistedCurrentSessionIsRemote() {
    var sessionId = persistedCurrentSessionId()
    return sessionId.length > 0 && remoteSessions.has(sessionId) === true
  }

  /**
   * Which host owns the model catalogue for this page load.
   *
   * 1. remote focus: a request already named a remote Session, so the user is looking at one;
   * 2. cold start: the Session the client persisted as current is remote (see above);
   * 3. otherwise this host, so a local Session's catalogue is exactly what it was before.
   * @returns true when the mounted host should answer.
   */
  function catalogOwnedByMount() {
    if (remoteFocused() === true) return true
    return persistedCurrentSessionIsRemote() === true
  }

  /**
   * Projections a published summary may carry, bounded.
   *
   * The block state is the only source for a remote row (group: none keeps remote rows
   * out of the shipped list), and the client injects that summary into its catalog before
   * opening the Session. Without projections the injected row carries no modelSelection,
   * so the composer shows the model placeholder even though the remote Session has a saved
   * selection. The whole values block is passed through when it is small, otherwise the
   * payload keeps only what a row or the composer needs.
   */
  var PROJECTION_VALUES_MAX_BYTES = 8192

  /**
   * @param projections - the remote list row's projections block.
   * @returns the block to publish, or undefined when there is nothing safe to send.
   */
  function projectionsForPublish(projections) {
    if (projections === null || typeof projections !== 'object') return undefined
    var values = projections.values
    if (values === null || typeof values !== 'object') return undefined
    var kept = {}
    if (typeof projections.kind === 'string') kept.kind = projections.kind
    if (typeof projections.asOfSeq === 'number') kept.asOfSeq = projections.asOfSeq
    try {
      if (JSON.stringify(values).length <= PROJECTION_VALUES_MAX_BYTES) {
        kept.values = values
        return kept
      }
    } catch (error) { /* fall through to the trimmed copy */ }
    // Too large to publish whole: keep the fields a row and the composer read.
    var trimmed = {}
    if (values.modelSelection !== undefined) trimmed.modelSelection = values.modelSelection
    if (values.agentPreset !== undefined) trimmed.agentPreset = values.agentPreset
    if (values.title !== undefined) trimmed.title = values.title
    kept.values = trimmed
    return kept
  }

  function envelope(rpcId, value) {
    return new Response(JSON.stringify({ type: 'server-response', rpcId: rpcId, result: { ok: true, value: value } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  /**
   * Window rule: a remote Session is worth showing when it runs or was active
   * recently. A devbox accumulates hundreds of old Sessions, so the merged list and
   * the published block state read this one predicate.
   */
  function isActiveRemote(item) {
    if (item === null || typeof item !== 'object') return false
    return item.running === true || (typeof item.updatedAt === 'number' && item.updatedAt >= WINDOW_FLOOR)
  }

  /**
   * Teach the routing table every visible Session in one mounted list answer.
   *
   * The payload-based routing decision, the published layout and the group merge all read this
   * set, so every reader of the list populates it through this one loop.
   * @param items - session rows from the mounted host.
   * @returns how many ids were new.
   */
  function absorbRemoteSessions(items) {
    var added = 0
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index]
      if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue
      if (isActiveRemote(item) !== true || remoteSessions.has(item.sessionId) === true) continue
      remoteSessions.add(item.sessionId)
      added += 1
    }
    return added
  }

  /**
   * Publish the remote summaries the plugin-rendered block reads. With `group: none`
   * the shipped list never carries a remote Session, so this snapshot is the block's
   * only data source; the list merge and the event path both refresh it. A remote
   * Session has no list `title` field — its title lives in the `title` projection.
   */
  function publishRemoteSessions(remoteItems) {
    var published = []
    for (var index = 0; index < remoteItems.length; index += 1) {
      var raw = remoteItems[index]
      if (raw === null || typeof raw !== 'object' || typeof raw.sessionId !== 'string') continue
      var projections = raw.projections
      var values = projections === null || typeof projections !== 'object' ? undefined : projections.values
      var projected = values === null || typeof values !== 'object' ? undefined : values.title
      var entry = {
        id: raw.sessionId,
        title: typeof projected === 'string' && projected.length > 0 ? projected
          : (typeof raw.title === 'string' ? raw.title : (typeof raw.name === 'string' ? raw.name : raw.sessionId)),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
        running: raw.running === true,
      }
      // The shipped hover card shows the Session's working directory, and the block's
      // "copy remote path" row action reads the same value; both come from the remote
      // list row, which carries it as cwd.
      if (typeof raw.cwd === 'string' && raw.cwd.length > 0) entry.cwd = raw.cwd
      // A blank remote Session must stay blank after injection, or its main area is empty.
      if (raw.blank === true) entry.blank = true
      entry.running = raw.running === true
      if (typeof raw.parentSessionId === 'string' && raw.parentSessionId.length > 0) entry.parentSessionId = raw.parentSessionId
      if (typeof raw.formatStatus === 'string' && raw.formatStatus.length > 0) entry.formatStatus = raw.formatStatus
      if (typeof raw.asOfSeq === 'number') entry.asOfSeq = raw.asOfSeq
      // Carry the saved model selection (and the rest of the bounded values) through to the
      // catalog row the client injects, so the composer can resolve the remote Session's
      // model instead of falling back to the placeholder.
      var publishable = projectionsForPublish(raw.projections)
      if (publishable !== undefined) entry.projections = publishable
      published.push(entry)
    }
    globalThis.__DSH_REMOTE_HOST_SESSIONS__ = published
    announce('sessions', { count: published.length })
    return published
  }

  /** Digest of the last published session list, so an unchanged answer is not repainted. */
  var remoteSessionsDigest = null

  /** What one row shows: identity, freshness and activity, which is all a repaint reacts to. */
  function sessionListDigest(items) {
    var parts = []
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index]
      parts.push(String(item === null || item === undefined ? '' : item.sessionId) + ':'
        + String(item === null || item === undefined ? '' : item.updatedAt) + ':'
        + (item !== null && item !== undefined && item.running === true ? '1' : '0'))
    }
    return parts.join(',')
  }

  /**
   * Publish one mounted session/list answer: teach the routing table its ids, then publish the
   * snapshot the plugin block renders from.
   *
   * Every path that learns the mount's Session list goes through here. Publishing was wired into
   * some of them only, so a page fed by the decoded rpc carrier had no block data until the 4 s
   * poll came around.
   * @param remoteItems - session rows from the mounted host.
   */
  function publishRemoteSessionList(remoteItems) {
    absorbRemoteSessions(remoteItems)
    // Only the row snapshot is digest-gated: it is the one publish that announces. The layout
    // and the merged groups guard themselves, and they must still run when a merge learned an
    // id whose row set happened to be unchanged.
    var digest = sessionListDigest(remoteItems)
    if (digest !== remoteSessionsDigest) {
      remoteSessionsDigest = digest
      publishRemoteSessions(remoteItems)
    }
    publishRemoteState()
    refreshGroups()
  }

  /** Upper bound for any request to the mounted host, so a dead remote cannot block the UI. */
  var MOUNT_TIMEOUT_MS = 2500

  async function mergeSessionList(input, init, request) {
    // Safe mode: this page is in a boot loop, so answer locally and skip the mount.
    if (SAFE_MODE === true) return localFetch(input, init)
    // The mount leg must be bounded: an unreachable remote would otherwise leave this
    // promise pending forever, so the client's session/list never resolves and the whole
    // UI freezes (which then ends in a renderer crash). Fall back to the local answer.
    var mountInit = init
    try {
      var mountSignal = typeof AbortSignal === 'object' && AbortSignal !== null && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(MOUNT_TIMEOUT_MS)
        : undefined
      if (mountSignal !== undefined) {
        mountInit = {}
        for (var mountKey in init) { if (Object.prototype.hasOwnProperty.call(init, mountKey)) mountInit[mountKey] = init[mountKey] }
        mountInit.signal = mountSignal
      }
    } catch (error) { mountInit = init }
    var responses = await Promise.all([
      localFetch(input, init),
      localFetch(mountUrl(input), mountInit).catch(function () { return undefined }),
    ])
    var local = responses[0]
    var remote = responses[1]
    if (remote === undefined || !remote.ok) return local
    var localBody = await local.json()
    var remoteBody = await remote.json()
    if (localBody === null || typeof localBody !== 'object' || !localBody.result || localBody.result.ok !== true) return new Response(JSON.stringify(localBody), { status: 200, headers: { 'content-type': 'application/json' } })
    if (remoteBody === null || typeof remoteBody !== 'object' || !remoteBody.result || remoteBody.result.ok !== true) return new Response(JSON.stringify(localBody), { status: 200, headers: { 'content-type': 'application/json' } })
    // One merge and one publish, shared with the decoded rpc carrier: the two hand-written
    // copies had already drifted apart in which side published what.
    var merged = mergeListValues(localBody.result.value, remoteBody.result.value)
    note('list-merge', { local: merged.localCount, remote: merged.remoteCount, visible: merged.visibleRemote })
    // The remote rows always ride along inside merged.value.items: they are the client
    // catalog's only source for a remote id, and the claiming Workspace keeps them out of
    // the shipped Ungrouped bucket.
    var remoteItems = sessionItemsOf(remoteBody.result)
    try { publishRemoteSessionList(remoteItems === undefined ? [] : remoteItems) } catch (error) { /* publishing is best effort */ }
    return envelope(localBody.rpcId, merged.value)
  }

