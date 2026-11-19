/**
 * MODULE: 50-router.js
 * The mux router: one browser socket, one upstream leg per host, per-stream
 * forwarding, local<->remote fallbacks, and merged workspace/event streams.
 */
  /**
   * Multiplex one client mux socket onto up to two upstream mux sockets: the
   * local Host and the mounted remote Host.
   */
  function createMuxRouter(localPath) {
    var client = new FakeSocket()
    var upstreams = new Map()
    var byUpstream = new Map()
    var byClient = new Map()
    /**
     * Original open frames by client stream id. A local leg answering
     * `session/not-found` used to wedge the stream forever when the remote id
     * table had not been published yet (a boot-time race); the retry below sends
     * the same stream to the remote leg instead.
     */
    var opens = new Map()
    /**
     * Remote-scoped open frames, replayed after the remote leg reconnects: the
     * mounted socket can drop (1006), which used to leave live streams dead even
     * though the first frames had already arrived.
     */
    var remoteStreams = new Map()
    /** Suppress reconnect attempts once the browser is closing this socket. */
    var shuttingDown = false
    /** Consecutive failed reconnects, for backoff and the error status. */
    var reconnectAttempts = 0
    var merges = new Map()
    var counter = 0
    /** Frames seen per upstream leg, for the diagnostics report. */
    var relays = {}

    function connect(kind) {
      var existing = upstreams.get(kind)
      if (existing !== undefined) return existing
      var target = kind === 'local' ? localPath : mountSocketUrl(localPath)
      if (target === undefined) {
        note('leg-no-url', { kind: kind, from: localPath })
        return undefined
      }
      var socket
      try {
        socket = openSocket(target)
      } catch (error) {
        note('leg-threw', { kind: kind, url: target, error: String(error) })
        return undefined
      }
      if (socket === undefined) {
        note('leg-no-socket', { kind: kind, url: target })
        return undefined
      }
      note('leg-open-requested', { kind: kind, url: target })
      publishStatus(kind, 'connecting')
      // A shell-provided socket may implement only addEventListener; assigning
      // `onopen` there would silently drop the event and hang the connection.
      var on = typeof socket.addEventListener === 'function'
        ? function (type, handler) { socket.addEventListener(type, handler) }
        : function (type, handler) { socket['on' + type] = handler }
      on('open', function () {
        note('leg-opened', { kind: kind })
        publishStatus(kind, 'open')
      })
      // A leg that never opens must be distinguishable from one that opens and
      // then goes quiet, so sample its state instead of waiting forever.
      if (schedule !== undefined) {
        var sample = function () { note('leg-state', { kind: kind, state: socket.readyState }) }
        schedule(sample, 500)
        schedule(sample, 2000)
      }
      on('error', function (event) {
        note('leg-error', { kind: kind, message: String((event && (event.message || event.type)) || 'error') })
        publishStatus(kind, 'error')
      })
      on('close', function (event) {
        note('leg-closed', { kind: kind, code: (event && event.code) || 0 })
        if (kind !== 'local') publishStatus(kind, 'error')
      })
      on('message', function (event) {
        relays[kind] = (relays[kind] || 0) + 1
        if (relays[kind] === 1) note('leg-first-frame', { kind: kind })
        relayIn(kind, event.data)
      })
      if (kind === 'local') {
        // Mirror the real socket exactly: an invented open would leave the UI
        // waiting on a connection that never arrives.
        on('open', function (event) {
          client.readyState = 1
          client.dispatch('open', event || {})
        })
        on('error', function (event) {
          note('local-leg-error', { message: String((event && (event.message || event.type)) || 'error') })
          client.dispatch('error', event || {})
        })
      }
      on('close', function (event) {
        if (kind === 'local') {
          client.readyState = 3
          client.dispatch('close', event || {})
          return
        }
        // A dead remote leg must never wedge a merged stream.
        merges.forEach(function (state, clientId) {
          if (state.remote.settled === true) return
          state.remote.settled = true
          flushMerged(clientId, state, true)
          maybeEnd(clientId, state)
        })
        // The mounted socket can drop after delivering its first frames; keep the
        // remote side usable by reconnecting and replaying its streams.
        reconnectRemote()
      })
      // A lazily opened leg is still CONNECTING when the first frame arrives;
      // a browser WebSocket throws on send() there, so buffer until open.
      var outbox = []
      var flushOutbox = function () {
        var pending = outbox
        outbox = []
        for (var index = 0; index < pending.length; index += 1) {
          try { socket.send(pending[index]) } catch (error) { /* one lost frame, not a crash */ }
        }
      }
      var sendWhenOpen = function (text) {
        if (socket.readyState === 1) {
          try { socket.send(text) } catch (error) { /* ignore single-frame failure */ }
          return
        }
        if (socket.readyState === 0 || socket.readyState === undefined) {
          outbox.push(text)
          return
        }
      }
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', flushOutbox)
      }
      upstreams.set(kind, socket)
      socket.__sendWhenOpen = sendWhenOpen
      return socket
    }

    /** Send to one upstream leg, buffering while that leg is still connecting. */
    function sendLeg(kind, text) {
      var socket = upstreams.get(kind)
      if (socket === undefined) return
      if (typeof socket.__sendWhenOpen === 'function') socket.__sendWhenOpen(text)
      else { try { socket.send(text) } catch (error) { /* ignore */ } }
    }

    function emitToClient(frame) {
      client.dispatch('message', { data: JSON.stringify(frame) })
    }

    function settleMergedTone(state) {
      if (state.timer !== undefined) {
        try { globalThis.clearTimeout(state.timer) } catch (error) { /* ignore */ }
        state.timer = undefined
      }
    }

    /** Emit the merged Workspace state: baseline first, replace afterwards. */
    function flushMerged(clientId, state, final) {
      var ready = (state.local.seen || state.local.settled) && (state.remote.seen || state.remote.settled)
      if (state.emitted !== true) {
        if (ready !== true && final !== true) return
        state.emitted = true
        settleMergedTone(state)
        var baseline = mergeBaseline(state.local, state.remote)
        state.signature = JSON.stringify(baseline.items.map(function (item) { return [item.workspaceId, (item.sessionIds || []).length] }))
        emitToClient({ type: 'item', streamId: clientId, value: { type: 'baseline', value: baseline } })
        return
      }
      emitToClient({ type: 'item', streamId: clientId, value: { type: 'replace', value: mergeBaseline(state.local, state.remote) } })
    }

    function maybeEnd(clientId, state) {
      if (state.local.settled !== true || state.remote.settled !== true) return
      merges.delete(clientId)
      emitToClient({ type: 'end', streamId: clientId })
    }

    function relayIn(kind, data) {
      var frame
      try { frame = JSON.parse(typeof data === 'string' ? data : '') } catch (error) { return }
      if (frame === null || typeof frame !== 'object') return
      var route = byUpstream.get(frame.streamId)
      if (route === undefined) return
      if (route.merge === true) {
        var state = merges.get(route.clientId)
        if (state === undefined) return
        var side = state[kind]
        if (frame.type === 'item') {
          applyIncrement(side, frame.value)
          if (kind === 'remote') learnWorkspaces(side)
          if (frame.value !== null && typeof frame.value === 'object'
            && (frame.value.type === 'baseline' || frame.value.type === 'replace')) side.seen = true
          flushMerged(route.clientId, state, false)
          return
        }
        if (frame.type === 'end' || frame.type === 'error') {
          side.settled = true
          // Nothing to say on a plain end: only a never-emitted stream needs its
          // final baseline, otherwise the UI would get a redundant replace.
          if (state.emitted !== true) flushMerged(route.clientId, state, true)
          maybeEnd(route.clientId, state)
        }
        return
      }
      if (route.mode === 'events') {
        if (frame.type === 'end' || frame.type === 'error') {
          // The local Host owns the browser's connection generation: a remote
          // leg ending must never tear the event stream down.
          if (kind === 'local') {
            emitToClient({ type: 'end', streamId: route.clientId })
            byClient.delete(route.clientId)
            byUpstream.delete(frame.streamId)
          }
          return
        }
        if (frame.type !== 'item') return
        var value = frame.value
        if (kind === 'local' && value !== null && typeof value === 'object') {
          if (value.type === 'waterfall' && typeof value.event === 'string') localEventNames.add(value.event)
        }
        if (kind === 'remote' && value !== null && typeof value === 'object') {
          // Exactly one ready frame may reach the client; keep the remote's
          // client id, because its waterfall answers are addressed to it.
          if (value.type === 'ready') {
            if (typeof value.clientId === 'string') remoteEventClientId = value.clientId
            return
          }
          if (value.type === 'waterfall') {
            // Local state wins: never let a remote host answer an event the local
            // host already owns (accounts, settings, host identity).
            if (typeof value.event === 'string' && localEventNames.has(value.event)) {
              note('events-skip-remote', { event: value.event })
              return
            }
            rememberRemoteEvent(value.eventId)
          }
        }
        var events = {}
        for (var eventKey in frame) { if (Object.prototype.hasOwnProperty.call(frame, eventKey)) events[eventKey] = frame[eventKey] }
        events.streamId = route.clientId
        emitToClient(events)
        return
      }
      // A boot-time race can classify a remote session as local before the remote
      // id table is published; the local host then answers "session not found" and
      // the UI would wait forever. Retry the same stream on the remote leg.
      if (frame.type === 'error' && kind === 'local' && route.mode === 'single') {
        var failure = frame.error === null || typeof frame.error !== 'object' ? {} : frame.error
        var code = String(failure.code ?? '')
        var message = String(failure.message ?? '')
        var missing = code.indexOf('not-found') !== -1 || message.indexOf('not found') !== -1
        var original = opens.get(route.clientId)
        if (missing === true && original !== undefined && original.retried !== true) {
          original.retried = true
          note('retry-remote', { endpoint: original.endpoint })
          byUpstream.delete(frame.streamId)
          try {
            // The remote leg is lazy: connecting here is the point of the retry.
            connect('remote')
            counter += 1
            var retryId = route.clientId + '~retry' + counter
            byUpstream.set(retryId, { clientId: route.clientId, kind: 'remote', merge: false, mode: 'single' })
            byClient.set(route.clientId, [{ kind: 'remote', upstreamId: retryId }])
            sendLeg('remote', JSON.stringify({ type: 'open', streamId: retryId, endpoint: original.endpoint, payload: original.payload }))
            return
          } catch (error) { /* fall through: forward the original failure */ }
        }
      }
      if (frame.type === 'error') {
        note('upstream-error', { kind: route.kind, error: JSON.stringify(frame.error ?? {}).slice(0, 120) })
      }
      var out = {}
      for (var key in frame) { if (Object.prototype.hasOwnProperty.call(frame, key)) out[key] = frame[key] }
      out.streamId = route.clientId
      emitToClient(out)
      if (frame.type === 'end' || frame.type === 'error') {
        byClient.delete(route.clientId)
        byUpstream.delete(frame.streamId)
        opens.delete(route.clientId)
      }
    }

    function modeOf(endpoint) {
      // Attached mode owns no local list to merge with: pass the remote's frames
      // through untouched so its own workspaces appear as they are.
      if (ATTACH_REMOTE === true) return 'single'
      if (MERGED_ENDPOINTS[endpoint] === true) return 'workspace'
      if (endpoint === EVENTS_ENDPOINT) return 'events'
      return 'single'
    }

    function decide(endpoint, payload) {
      // Attached mode: the remote host owns every stream, so there is one instance.
      if (ATTACH_REMOTE === true) return ['remote']
      var mode = modeOf(endpoint)
      if (mode !== 'single') return ['local', 'remote']
      if (refersRemote(payload)) return ['remote']
      return ['local']
    }

    /** Re-open the remote leg's streams on the socket that just replaced it. */
    function replayRemoteStreams() {
      if (remoteStreams.size === 0) return
      remoteStreams.forEach(function (entry, oldId) {
        byUpstream.delete(oldId)
        counter += 1
        var nextId = entry.clientId + '~remote-replay' + counter
        byUpstream.set(nextId, { clientId: entry.clientId, kind: 'remote', merge: entry.merge, mode: entry.mode })
        var legs = byClient.get(entry.clientId)
        if (legs !== undefined) {
          for (var index = 0; index < legs.length; index += 1) {
            if (legs[index].kind === 'remote') legs[index] = { kind: 'remote', upstreamId: nextId }
          }
        }
        remoteStreams.delete(oldId)
        remoteStreams.set(nextId, entry)
        try {
          sendLeg('remote', JSON.stringify({ type: 'open', streamId: nextId, endpoint: entry.endpoint, payload: entry.payload }))
        } catch (error) { /* the next attempt retries */ }
      })
      note('replay-remote', { streams: remoteStreams.size })
    }

    /** Reopen the remote leg after it dropped (1006), then replay its streams. */
    function reconnectRemote() {
      if (shuttingDown === true) return
      reconnectAttempts += 1
      if (reconnectAttempts < 3) publishStatus('remote', 'connecting')
      else publishStatus('remote', 'error')
      upstreams.delete('remote')
      var delay = Math.min(500 * Math.pow(2, reconnectAttempts - 1), 8000)
      var attempt = function () {
        if (shuttingDown === true) return
        var socket
        try { socket = connect('remote') } catch (error) { socket = undefined }
        if (socket === undefined) { reconnectRemote(); return }
        var onOpen = function () {
          reconnectAttempts = 0
          replayRemoteStreams()
        }
        if (socket.readyState === 1) onOpen()
        else if (typeof socket.addEventListener === 'function') socket.addEventListener('open', onOpen)
      }
      if (typeof setTimeout === 'function') setTimeout(attempt, delay)
      else attempt()
    }

    client._close = function () {
      shuttingDown = true
      merges.forEach(function (state) { settleMergedTone(state) })
      merges.clear()
      upstreams.forEach(function (socket) { try { socket.close() } catch (error) { /* ignore */ } })
      upstreams.clear()
    }

    client.send = function (text) {
      var frame
      try { frame = JSON.parse(text) } catch (error) { return }
      if (frame === null || typeof frame !== 'object') return
      if (frame.type === 'open') {
        var targets = decide(frame.endpoint, frame.payload)
        var mode = modeOf(frame.endpoint)
        if (/^(session\/(follow|control|page)|\$events|workspace\/follow)$/.test(frame.endpoint)) {
          note('open-route', { endpoint: frame.endpoint, targets: targets.join('+') })
        }
        var merge = mode === 'workspace'
        var opened = []
        for (var index = 0; index < targets.length; index += 1) {
          var kind = targets[index]
          var socket
          try {
            socket = connect(kind)
          } catch (error) {
            // An unreachable remote leg must not break the local one.
            socket = undefined
          }
          if (socket === undefined) continue
          counter += 1
          var upstreamId = frame.streamId + '~' + kind + counter
          byUpstream.set(upstreamId, { clientId: frame.streamId, kind: kind, merge: merge, mode: mode })
          opened.push({ kind: kind, upstreamId: upstreamId })
          if (kind === 'remote') {
            remoteStreams.set(upstreamId, {
              clientId: frame.streamId, endpoint: frame.endpoint, payload: frame.payload, merge: merge, mode: mode,
            })
          }
          sendLeg(kind, JSON.stringify({ type: 'open', streamId: upstreamId, endpoint: frame.endpoint, payload: frame.payload }))
        }
        if (opened.length === 0) return
        byClient.set(frame.streamId, opened)
        opens.set(frame.streamId, { endpoint: frame.endpoint, payload: frame.payload, retried: false })
        if (merge === true) {
          var state = { local: emptySide(), remote: emptySide(), emitted: false, timer: undefined }
          if (targets.indexOf('local') === -1) state.local.settled = true
          if (targets.indexOf('remote') === -1) state.remote.settled = true
          merges.set(frame.streamId, state)
          state.timer = globalThis.setTimeout(function () { flushMerged(frame.streamId, state, true) }, 1500)
        }
        return
      }
      var legs = byClient.get(frame.streamId)
      if (legs === undefined) return
      for (var leg = 0; leg < legs.length; leg += 1) {
        var forwarded = {}
        for (var name in frame) { if (Object.prototype.hasOwnProperty.call(frame, name)) forwarded[name] = frame[name] }
        forwarded.streamId = legs[leg].upstreamId
        sendLeg(legs[leg].kind, JSON.stringify(forwarded))
      }
      if (frame.type === 'cancel') {
        byClient.delete(frame.streamId)
        var cancelled = merges.get(frame.streamId)
        if (cancelled !== undefined) { settleMergedTone(cancelled); merges.delete(frame.streamId) }
      }
    }

    /**
     * Re-emit merged group state after the remote session registry grows: the
     * workspace baseline can arrive before session/list, and a group built from
     * an empty registry would otherwise stay empty forever.
     */
    client.__refreshGroups = function () {
      merges.forEach(function (state, clientId) {
        if (state.emitted !== true) { flushMerged(clientId, state, true); return }
        var next = mergeBaseline(state.local, state.remote)
        var signature = JSON.stringify(next.items.map(function (item) { return [item.workspaceId, (item.sessionIds || []).length] }))
        // Re-emitting an unchanged baseline makes consumers refetch forever.
        if (state.signature === signature) return
        state.signature = signature
        emitToClient({ type: 'item', streamId: clientId, value: { type: 'replace', value: next } })
      })
    }

    var local = connect('local')
    if (local === undefined) throw new Error('drh: no local mux socket')
    activeRouter = client
    // Readiness comes from the real socket's open event, never from here.
    client.readyState = typeof local.readyState === 'number' ? local.readyState : 0
    return client
  }

