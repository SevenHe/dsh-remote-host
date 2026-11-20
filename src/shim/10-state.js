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
      published.push(entry)
    }
    globalThis.__DSH_REMOTE_HOST_SESSIONS__ = published
    announce('sessions', { count: published.length })
    return published
  }

  async function mergeSessionList(input, init, request) {
    var responses = await Promise.all([
      localFetch(input, init),
      localFetch(mountUrl(input), init).catch(function () { return undefined }),
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

