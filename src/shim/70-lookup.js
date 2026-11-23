/**
 * MODULE: 70-lookup.js
 * Unary call handling: the session-list merge and the event-answer rewrite that
 * sends a remote waterfall answer back to the remote peer.
 */
  /**
   * Populate the routing table before the client asks for anything. The client
   * restores the previously selected Session during boot, which can precede the
   * first session/list, and an unrouted remote Session would look "not found".
   */
  function prefetchRemoteSessions() {
    try {
      globalThis.fetch(MOUNT + '/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: nextRpcId(),
          method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      }).then(function (response) { return response.json() }).then(function (envelope) {
        var value = envelope && envelope.result && envelope.result.ok === true ? envelope.result.value : undefined
        var items = value === undefined ? undefined : value.items
        if (Array.isArray(items) !== true) return
        var added = 0
        for (var index = 0; index < items.length; index += 1) {
          var item = items[index]
          if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue
          if (remoteSessions.has(item.sessionId)) continue
          var active = item.running === true || (typeof item.updatedAt === 'number' && item.updatedAt >= WINDOW_FLOOR)
          if (active !== true) continue
          remoteSessions.add(item.sessionId)
          added += 1
        }
        if (added > 0) {
      note('prefetch', { added: added, known: remoteSessions.size })
      publishRemoteState()
      refreshGroups()
    }
      }).catch(function (error) {
        note('prefetch-failed', { error: String(error).slice(0, 90) })
      })
    } catch (error) { /* prefetch is best effort */ }
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
    var init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: nextRpcId(), method: endpoint, payload: payload }),
    }
    if (signal !== undefined && signal !== null) init.signal = signal
    var response = await globalThis.fetch(MOUNT + '/api/' + endpoint, init)
    if (response.ok !== true) throw new Error('drh: mount answered HTTP ' + String(response.status))
    var envelope = await response.json()
    if (envelope === null || typeof envelope !== 'object' || envelope.result === undefined) {
      throw new Error('drh: invalid mount envelope')
    }
    return envelope.result
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
      var active = entry.running === true || (typeof entry.updatedAt === 'number' && entry.updatedAt >= WINDOW_FLOOR)
      if (active !== true) continue
      seen.add(entry.sessionId)
      remoteSessions.add(entry.sessionId)
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

  /** Build and publish the transport over `base`, chaining to it for local calls. */
  /**
   * Shim changes normally need a page reload, and the desktop shell has no reload
   * shortcut. Compare the loaded revision with the one on disk while the page is
   * hidden and reload then, so the refresh is invisible.
   */