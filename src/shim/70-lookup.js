/**
 * MODULE: 70-lookup.js
 * The prefetches that fill the routing table before the client asks, the one unary call
 * against the mount, the session-list merge both carriers share, and the diagnostics refresh.
 */
  /**
   * Read the mount's Session list.
   *
   * The poll and the boot prefetch ask exactly this question, so it is asked here once. Two
   * hand-written copies of the request and its decoding are what let one of them drift.
   * @returns a promise of the rows, or of undefined when the answer carries none.
   */
  function readMountSessionList() {
    return globalThis.fetch(MOUNT + '/api/session/list', mountRequestInit('session/list', { args: { _request: {} } }))
      .then(function (response) { return response.json() })
      .then(function (envelope) { return sessionItemsOf(mountResult(envelope)) })
  }

  /**
   * The rows one decoded mount result carries.
   * @param result - the decoded carrier result.
   * @returns the items array, or undefined when the answer carries none.
   */
  function sessionItemsOf(result) {
    var value = result === undefined ? undefined : result.value
    var items = value === null || typeof value !== 'object' ? undefined : value.items
    return Array.isArray(items) === true ? items : undefined
  }

  /**
   * Populate the routing table before the client asks for anything. The client
   * restores the previously selected Session during boot, which can precede the
   * first session/list, and an unrouted remote Session would look "not found".
   */
  function prefetchRemoteSessions() {
    try {
      readMountSessionList().then(function (items) {
        if (items === undefined) return
        var added = absorbRemoteSessions(items)
        if (added === 0) return
        note('prefetch', { added: added, known: remoteSessions.size })
        publishRemoteState()
        refreshGroups()
      }).then(function () {
        // This prefetch IS the first remote snapshot: the model-catalogue owner decision
        // waits on it, so it must settle even when the mount answered nothing.
        markRemoteSnapshotSettled()
      }, function (error) {
        markRemoteSnapshotSettled()
        note('prefetch-failed', { error: String(error).slice(0, 90) })
      })
    } catch (error) { markRemoteSnapshotSettled() /* prefetch is best effort */ }
  }

  /**
   * Learn remote workspace membership before the client's first session/list, so
   * merged rows can carry their workspace name in the same render.
   */
  function prefetchWorkspaces() {
    try {
      // Resolve against the carrier's Host base: the page origin may be the
      // desktop shell's custom scheme, whose host is not a network authority.
      var base = typeof diag.streamBaseUrl === 'string' && diag.streamBaseUrl.length > 0
        ? diag.streamBaseUrl
        : (typeof location === 'object' ? location.href : undefined)
      var url = new URL(MOUNT + '/api/remote.mux', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      var socket = new NativeWebSocket(url.toString())
      var done = false
      var finish = function () {
        if (done) return
        done = true
        try { socket.close() } catch (error) { /* ignore */ }
      }
      socket.addEventListener('message', function (event) {
        var frame
        try { frame = JSON.parse(event.data) } catch (error) { return }
        if (frame === null || typeof frame !== 'object' || frame.type !== 'item') return
        var value = frame.value
        if (value === null || typeof value !== 'object') return
        if (value.type === 'baseline' || value.type === 'replace') {
          var side = emptySide()
          applyIncrement(side, value)
          learnWorkspaces(side)
          note('prefetch-workspaces', { known: sessionWorkspace.size })
          finish()
        }
      })
      socket.addEventListener('open', function () {
        try {
          socket.send(JSON.stringify({ type: 'open', streamId: 'rh-ws-prefetch', endpoint: 'workspace/follow', payload: { args: {} } }))
        } catch (error) { finish() }
      })
      socket.addEventListener('error', function () { finish() })
      if (typeof setTimeout === 'function') setTimeout(finish, 8000)
    } catch (error) { /* workspace prefetch is best effort */ }
  }

  /** One unary call against the mounted Host, decoded to the carrier result. */
  async function remoteUnary(endpoint, payload, signal) {
    var response = await globalThis.fetch(MOUNT + '/api/' + endpoint, mountRequestInit(endpoint, payload, signal))
    if (response.ok !== true) throw new Error('drh: mount answered HTTP ' + String(response.status))
    var result = mountResult(await response.json())
    if (result === undefined) throw new Error('drh: invalid mount envelope')
    return result
  }

  /** Merge two decoded session/list values with the display window applied. */
  function mergeListValues(localValue, remoteValue) {
    var localItems = localValue !== null && typeof localValue === 'object' && Array.isArray(localValue.items) ? localValue.items : []
    var remoteItems = remoteValue !== null && typeof remoteValue === 'object' && Array.isArray(remoteValue.items) ? remoteValue.items : []
    var seen = new Set()
    var merged = []
    for (var index = 0; index < localItems.length; index += 1) {
      var item = localItems[index]
      if (item !== null && typeof item === 'object' && typeof item.sessionId === 'string') seen.add(item.sessionId)
      merged.push(item)
    }
    var added = 0
    for (var other = 0; other < remoteItems.length; other += 1) {
      var entry = remoteItems[other]
      if (entry === null || typeof entry !== 'object' || typeof entry.sessionId !== 'string') continue
      if (seen.has(entry.sessionId)) continue
      // A devbox accumulates hundreds of old sessions; the sidebar shows the recent ones plus
      // anything still running. This is the same window rule every other list reader applies.
      if (isActiveRemote(entry) !== true) continue
      seen.add(entry.sessionId)
      merged.push(labelRemoteItem(entry))
      added += 1
    }
    var value = {}
    if (localValue !== null && typeof localValue === 'object') {
      for (var key in localValue) { if (Object.prototype.hasOwnProperty.call(localValue, key)) value[key] = localValue[key] }
    }
    value.items = merged
    return { value: value, localCount: localItems.length, remoteCount: remoteItems.length, visibleRemote: added }
  }

  function refreshDiag(base) {
    diag.previousKeys = Object.keys(base)
    diag.hasRpc = base.rpc !== undefined && base.rpc !== null && typeof base.rpc === 'object'
    diag.rpcKeys = base.rpc === undefined || base.rpc === null ? [] : Object.keys(base.rpc)
    diag.hasFetch = typeof base.fetch === 'function'
    diag.hasCreateWebSocket = typeof base.createWebSocket === 'function'
    diag.streamBaseUrl = typeof base.streamBaseUrl === 'string' ? base.streamBaseUrl : null
    diag.installs = (typeof diag.installs === 'number' ? diag.installs : 0) + 1
  }
