/**
 * MODULE: 10-state.js
 * What the shim publishes to the page (remote ids, workspace layout) and the event
 * bookkeeping that keeps remote waterfalls answerable.
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
      published.push(entry)
    }
    globalThis.__DSH_REMOTE_HOST_SESSIONS__ = published
    announce('sessions', { count: published.length })
    return published
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
    var localItems = Array.isArray(localBody.result.value && localBody.result.value.items) ? localBody.result.value.items : []
    var remoteItems = Array.isArray(remoteBody.result.value && remoteBody.result.value.items) ? remoteBody.result.value.items : []
    var seen = new Set()
    var merged = []
    for (var index = 0; index < localItems.length; index += 1) {
      var item = localItems[index]
      if (item && typeof item.sessionId === 'string') seen.add(item.sessionId)
      merged.push(item)
    }
    for (var other = 0; other < remoteItems.length; other += 1) {
      var entry = remoteItems[other]
      if (entry === null || typeof entry !== 'object' || typeof entry.sessionId !== 'string') continue
      if (seen.has(entry.sessionId)) continue
      // A devbox accumulates hundreds of old sessions; the sidebar shows the
      // recent ones plus anything still running.
      var active = entry.running === true || (typeof entry.updatedAt === 'number' && entry.updatedAt >= WINDOW_FLOOR)
      if (active !== true) continue
      seen.add(entry.sessionId)
      remoteSessions.add(entry.sessionId)
      merged.push(labelRemoteItem(entry))
    }
    // Publish the remote summaries so a plugin-rendered block can show titles and times
    // without the shipped list carrying remote sessions.
    try { publishRemoteSessions(remoteItems) } catch (error) { /* publishing is best effort */ }
    var value = {}
    for (var key in localBody.result.value) { if (Object.prototype.hasOwnProperty.call(localBody.result.value, key)) value[key] = localBody.result.value[key] }
    // The remote rows always ride along: they are the client catalog's only source for a
    // remote id, and the claiming Workspace keeps them out of the shipped Ungrouped bucket.
    value.items = merged
    note('list-merge', { local: localItems.length, remote: remoteItems.length, visible: merged.length - localItems.length })
    publishRemoteState()
    refreshGroups()
    return envelope(localBody.rpcId, value)
  }

