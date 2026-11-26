/**
 * MODULE: 50-router.js
 * The mux router: one browser socket, one upstream leg per host, per-stream
 * forwarding, local<->remote fallbacks, and merged workspace/event streams.
 */
  /**
   * A Session the mounted Host created must reach the remote block, never the shipped
   * list. The shipped client materializes a list row from the forwarded
   * `api-session/added` emit (`session-controller`'s `ctx.remote.$on` relay), and with
   * `group: none` no remote Workspace is published to claim that row, so it would show
   * up in the shipped "Ungrouped" bucket. Re-read the mounted Host's list instead: the
   * block renders from the published snapshot and the routing table learns the id.
   */
  var POLL_INTERVAL_MS = 4000
  var remoteSessionsRefresh
  var remoteSessionsPoll
  var remoteSessionsInFlight = false

  function scheduleRemoteSessionsRefresh() {
    if (remoteSessionsRefresh !== undefined) return
    if (typeof globalThis.setTimeout !== 'function') {
      refreshRemoteSessions()
      return
    }
    remoteSessionsRefresh = globalThis.setTimeout(function () {
      remoteSessionsRefresh = undefined
      refreshRemoteSessions()
    }, 250)
  }

  function refreshRemoteSessions() {
    // Single flight: a slow round trip must never stack another one on top.
    if (remoteSessionsInFlight === true) return
    remoteSessionsInFlight = true
    try {
      readMountSessionList().then(function (items) {
        if (items === undefined) return
        // The one snapshot path, shared with both unary carriers: it absorbs the ids and
        // publishes only when a row really moved, so a tick costs no repaint.
        publishRemoteSessionList(items)
      }).then(function () {
        remoteSessionsInFlight = false
        // The first answer (success or failure) is what the catalogue owner decision waits for.
        markRemoteSnapshotSettled()
      }, function (error) {
        remoteSessionsInFlight = false
        markRemoteSnapshotSettled()
        note('sessions-refresh-failed', { error: String(error).slice(0, 90) })
      })
    } catch (error) { remoteSessionsInFlight = false }
  }
  /**
   * Keep the published snapshot fresh.
   *
   * The mounted Host starts and stops Sessions without emitting anything this page subscribes
   * to, so a Session that began (or stopped) running kept its stale row until a click forced a
   * repaint. One interval drives the existing refresh path: single flight inside
   * refreshRemoteSessions, skipped while the page is hidden, and a failed round trip simply
   * waits for the next tick. No recursive scheduling, so ticks cannot stack.
   */
  function startRemoteSessionsPoll() {
    if (remoteSessionsPoll !== undefined) return
    if (typeof globalThis.setInterval !== 'function') return
    remoteSessionsPoll = globalThis.setInterval(function () {
      if (typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden') return
      refreshRemoteSessions()
    }, POLL_INTERVAL_MS)
  }

  /** Stop the interval; tests call this so a suite leaves no pending work behind. */
  function stopRemoteSessionsPoll() {
    if (remoteSessionsPoll === undefined) return
    try { if (typeof globalThis.clearInterval === 'function') globalThis.clearInterval(remoteSessionsPoll) } catch (error) { /* best effort */ }
    remoteSessionsPoll = undefined
  }

  startRemoteSessionsPoll()
  try { globalThis.__DSH_REMOTE_HOST_POLL_NOW__ = refreshRemoteSessions } catch (error) { /* diagnostics only */ }
  try { globalThis.__DSH_REMOTE_HOST_STOP_POLL__ = stopRemoteSessionsPoll } catch (error) { /* diagnostics only */ }

  /** Real JS call-stack depth; native stack exhaustion is a brk with no message, so measure. */
  function stackDepthNow() {
    try { return new Error().stack.split(String.fromCharCode(10)).length } catch (error) { return -1 }
  }

  /**
   * The leg sockets of one mux, and the remote leg's recovery ladder.
   *
   * The page keeps one mux for its whole life, so its legs are stateful: whether a dial may
   * reuse the socket in hand, what a dropped remote leg costs, and when an outage has outlived
   * DEGRADE_AFTER_MS so the mux must be handed back to the shipped client. Those decisions used
   * to be seven variables written from the connect/open/error/close callbacks of the router —
   * the arrangement whose one re-entrant path wedged the renderer — so this controller is their
   * only writer: the router reports what a socket did and reads back the socket to send on.
   *
   * @param options.dial - Opens and wires one leg socket and records it in `legs`; returns it,
   *   or undefined when no carrier can be built. The relay one-shot lives there, where the
   *   mount URL is resolved.
   * @param options.publishStatus - Reports one leg state to the shipped client.
   * @param options.note - Appends one diagnostics breadcrumb.
   * @param options.traceEvent - Appends one crash breadcrumb.
   * @param options.timers - `{ setTimeout, clearTimeout }`; without `setTimeout` an attempt runs
   *   inline instead of through the task queue.
   * @param options.now - Reads the clock, so a test can move the outage window.
   * @param options.legs - The mux's leg table, keyed by kind; the router sends on the same one.
   * @param options.mux - Router-side effects the recovery needs: how many streams rode the leg
   *   (`streamCount`), re-opening them (`replayStreams`), settling its merged streams
   *   (`settleMerged`), and handing the page socket back (`handOff`).
   * @returns the leg controller: `socketFor`, one callback per socket event, `report`, `dispose`.
   */
  function createRemoteLeg(options) {
    var dial = options.dial
    var publishStatus = options.publishStatus
    var note = options.note
    var traceEvent = options.traceEvent
    var timers = options.timers
    var now = options.now
    var legs = options.legs
    var mux = options.mux
    /** The shipped client owns the mount connection in relay mode, so no ladder runs there. */
    var relayMode = HOST_RECONNECTS_REMOTE === true

    /** First reconnect delay and its ceiling; see backoff(). */
    var RECONNECT_BASE_MS = 200
    var RECONNECT_CAP_MS = 10000
    /**
     * How long the remote leg may stay unusable before the mux is handed back.
     * A flapped connection used to end with a dead renderer 5.8-6.0 s after the outage began,
     * and the checks only run when a failure event arrives (attempts land at roughly 0.2, 0.6,
     * 1.4, 3.0 and 6.2 s), so a 6s window would be evaluated after the crash: 3.5s fires in time.
     */
    var DEGRADE_AFTER_MS = 3500
    /** An attempt that neither opens nor errors within this window counts as a failure. */
    var ATTEMPT_TIMEOUT_MS = 2500

    /** First moment the remote leg became unusable in the current outage; 0 while healthy. */
    var unavailableSince = 0
    /** True once the mux was handed back to the shipped client for this outage. */
    var degraded = false
    /** Suppress reconnect attempts once the browser is closing this page socket. */
    var shuttingDown = false
    /** Consecutive failed reconnects, for backoff and the error status. */
    var reconnectAttempts = 0
    /** The one pending reconnect timer, so overlapping handlers cannot stack loops. */
    var reconnectTimer
    /** True while a reconnect is scheduled or being attempted: the ladder's single-flight lock. */
    var reconnectPending = false
    /** Synchronous re-entry depth of reconnect() (should stay 1). */
    var reconnectDepth = 0
    /** Timer for the per-attempt open watchdog. */
    var attemptTimer

    /**
     * The leg socket for one kind, dialing one when none is reusable.
     *
     * Only a socket that is still CONNECTING or OPEN may be reused. A CLOSING/CLOSED one would
     * take the recovery listeners and never fire them, which is how a short flap left the page
     * half-recovered until it trapped (see docs/crash-path-b.md).
     */
    function socketFor(kind) {
      var existing = legs.get(kind)
      if (existing !== undefined) {
        if (existing.readyState === 0 || existing.readyState === 1) {
          traceEvent('connect-return', { kind: kind, socketId: existing.__drhSocketId, readyState: existing.readyState, reused: true })
          return existing
        }
        legs.delete(kind)
        traceEvent('leg-dropped-stale', { kind: kind, socketId: existing.__drhSocketId, readyState: existing.readyState })
      }
      return dial(kind)
    }

    /**
     * The remote leg opened: publish it outside the socket's dispatch.
     *
     * Publishing the status reaches the shipped client synchronously; deferring it lets the open
     * dispatch finish before anything re-subscribes. Relay mode publishes the Host's own report
     * over `drh/relay-status` instead.
     */
    function onOpen(socket) {
      if (relayMode === true) return
      traceEvent('status-open-enter', {})
      var publish = function () {
        publishStatus('remote', 'open')
        traceEvent('status-open-exit', {})
      }
      if (timers.setTimeout !== undefined) timers.setTimeout(publish, 0)
      else publish()
    }

    /** A remote leg error: report it and start the outage clock. */
    function onError(socket, event) {
      note('leg-error', { kind: 'remote', message: String((event && (event.message || event.type)) || 'error') })
      publishStatus('remote', 'error')
      if (relayMode !== true) noteUnavailable('error')
    }

    /** A remote leg close: report it, settle its merged streams, and start the ladder. */
    function onClose(socket, event) {
      note('leg-closed', { kind: 'remote', code: (event && event.code) || 0 })
      publishStatus('remote', 'error')
      if (relayMode === true) return
      noteUnavailable('close')
      // A dead remote leg must never wedge a merged stream.
      mux.settleMerged()
      reconnect()
    }

    /**
     * Delay before reconnect attempt N: 200, 400, 800, ... capped at 10 s, so a long outage
     * costs at most one attempt per cap window instead of a spin.
     */
    function backoff(attempt) {
      var step = attempt < 1 ? 1 : attempt
      var delay = RECONNECT_BASE_MS * Math.pow(2, step - 1)
      return delay > RECONNECT_CAP_MS ? RECONNECT_CAP_MS : delay
    }

    /**
     * Record that the remote leg is unusable right now, and hand the mux back once the outage
     * outlives DEGRADE_AFTER_MS.
     *
     * The trigger is event driven on purpose: on the flap that kills the renderer, dial() returns
     * a socket that fails asynchronously, so counting synchronous throws never fires.
     */
    function noteUnavailable(reason) {
      if (degraded === true) return
      var at = now()
      if (unavailableSince === 0) unavailableSince = at
      var unavailableMs = at - unavailableSince
      traceEvent('remote-unavailable', { reason: reason, ms: unavailableMs })
      if (unavailableMs > DEGRADE_AFTER_MS) handOff()
    }

    /** The remote leg opened: the outage is over, so the clock resets. */
    function noteAvailable() {
      if (unavailableSince !== 0) traceEvent('remote-available', { afterMs: now() - unavailableSince })
      unavailableSince = 0
      degraded = false
    }

    /**
     * Hand the mux back to the shipped client instead of holding its socket open.
     *
     * While the remote leg is unusable this router keeps the page socket open, so the shipped
     * connection layer never sees a failure it can react to: its services stay unavailable and
     * a flapped connection ended with a dead renderer (reproduced: exitCode 5 = SIGTRAP, and it
     * does not happen with streams disabled). Closing the socket makes the outage visible and
     * lets the client's own reconnect take over; no new WebSocket is opened until a fresh mux
     * connection builds a new router.
     */
    function handOff() {
      if (degraded === true) return
      degraded = true
      reconnectPending = false
      if (reconnectTimer !== undefined) {
        try { timers.clearTimeout(reconnectTimer) } catch (error) { /* already gone */ }
        reconnectTimer = undefined
      }
      if (attemptTimer !== undefined) {
        try { timers.clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
        attemptTimer = undefined
      }
      traceEvent('degrade-handoff', { unavailableMs: now() - unavailableSince })
      note('degrade: handing the mux back after ' + String(now() - unavailableSince) + ' ms unavailable')
      publishStatus('remote', 'error')
      mux.handOff()
    }

    /**
     * Reopen the remote leg after it dropped (1006), then replay its streams.
     *
     * Single flight: the close handler and the attempt watchdog both land here, and a socket that
     * cannot even be constructed must wait for the next backoff step rather than re-entering this
     * function — that recursion is what wedged the renderer.
     */
    function reconnect() {
      traceEvent('reconnect-enter', { degraded: degraded === true, pending: reconnectPending === true, stackDepth: stackDepthNow() })
      if (shuttingDown === true) { traceEvent('attempt-early-return', { reason: 'shutting-down' }); return }
      if (degraded === true) { traceEvent('attempt-early-return', { reason: 'degraded' }); return }
      if (reconnectPending === true) { traceEvent('attempt-early-return', { reason: 'pending' }); return }
      // Depth counter: a synchronous re-entry chain is invisible in the trace otherwise,
      // and it is exactly what a crashing flap looks like.
      reconnectDepth += 1
      traceEvent('reconnect-begin', { attempt: reconnectAttempts + 1, depth: reconnectDepth })
      try {
        reconnectPending = true
        reconnectAttempts += 1
        if (reconnectAttempts < 3) publishStatus('remote', 'connecting')
        else publishStatus('remote', 'error')
        // The dead socket must not be reused by the next attempt.
        legs.delete('remote')
        var attempt = function () {
          reconnectTimer = undefined
          traceEvent('attempt-run', { attempt: reconnectAttempts, degraded: degraded === true, stackDepth: stackDepthNow() })
          if (shuttingDown === true) { reconnectPending = false; return }
          var next
          try { next = dial('remote') } catch (error) { next = undefined }
          reconnectPending = false
          // A socket that is not connecting/open cannot recover: treat it as a failure instead of
          // attaching an open listener that can never fire.
          if (next !== undefined && next.readyState !== 0 && next.readyState !== 1) {
            traceEvent('stale-socket', { readyState: next.readyState })
            next = undefined
          }
          if (next === undefined) {
            // No carrier at all: the factory threw or the mount URL could not be resolved, so there
            // is no socket to wait on. Record the failure, because that clock is what hands the mux
            // back; a ladder that only re-entered here retried a dead carrier forever and the shipped
            // client never learned the remote leg was gone. The retry goes through the backoff timer
            // inside reconnect(), never a synchronous re-entry.
            traceEvent('reconnect-nocarrier', { attempt: reconnectAttempts, depth: reconnectDepth })
            noteUnavailable('no-carrier')
            if (degraded !== true) reconnect()
            return
          }
          if (attemptTimer !== undefined) {
            try { timers.clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
          }
          if (timers.setTimeout !== undefined) {
            attemptTimer = timers.setTimeout(function () {
              attemptTimer = undefined
              if (next !== undefined && next.readyState === 1) return
              // The socket never opened and never errored: it is stuck in CONNECTING (the browser
              // keeps it there when the link came back mid-handshake). Recording a failure is not
              // enough - the socket has to be abandoned and the attempt repeated, or the page stays
              // half-recovered until it traps (breadcrumbs: listener attached at readyState 0, then
              // no open, no error, ~15s to death).
              traceEvent('attempt-abandoned', {
                socketId: next === undefined ? -1 : next.__drhSocketId,
                readyState: next === undefined ? -1 : next.readyState,
              })
              try { if (next !== undefined) next.close() } catch (error) { /* best effort */ }
              if (legs.get('remote') === next) legs.delete('remote')
              noteUnavailable('attempt-timeout')
              if (degraded !== true) reconnect()
            }, ATTEMPT_TIMEOUT_MS)
          }
          traceEvent('attempt-socket', { socketId: next.__drhSocketId, readyState: next.readyState, attempt: reconnectAttempts, stackDepth: stackDepthNow() })
          var onRecovered = function () {
            reconnectAttempts = 0
            if (attemptTimer !== undefined) {
              try { timers.clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
              attemptTimer = undefined
            }
            traceEvent('remote-open', { streams: mux.streamCount() })
            // Do the recovery work OUTSIDE the socket's 'open' dispatch. Breadcrumbs show the page
            // freezing between the leg-open status publish and this handler, i.e. inside the
            // synchronous event dispatch: deferring it breaks that chain, so a listener that
            // re-subscribes cannot recurse into the reopened leg on the same stack.
            var resume = function () {
              noteAvailable()
              traceEvent('open-handled', { streams: mux.streamCount() })
              mux.replayStreams(reconnectDepth)
              traceEvent('replay-done', { streams: mux.streamCount() })
            }
            if (timers.setTimeout !== undefined) timers.setTimeout(resume, 0)
            else resume()
          }
          if (next.readyState === 1) {
            traceEvent('listener-attach', { socketId: next.__drhSocketId, readyState: 1, mode: 'immediate' })
            onRecovered()
          } else if (typeof next.addEventListener === 'function') {
            traceEvent('listener-attach', { socketId: next.__drhSocketId, readyState: next.readyState, mode: 'listener', stackDepth: stackDepthNow() })
            next.addEventListener('open', onRecovered)
          }
        }
        if (timers.setTimeout !== undefined) reconnectTimer = timers.setTimeout(attempt, backoff(reconnectAttempts))
        else attempt()
      } finally {
        reconnectDepth -= 1
        traceEvent('reconnect-end', { depth: reconnectDepth })
      }
    }

    /**
     * Diagnostics: the leg's state, so a crash report can tell whether the ladder was mid-flight
     * and for how long the mount has been unusable.
     */
    function report() {
      return {
        degraded: degraded === true,
        attempts: reconnectAttempts,
        pending: reconnectPending === true,
        unavailableMs: unavailableSince === 0 ? 0 : now() - unavailableSince,
      }
    }

    /** The browser is closing the page socket: stop the ladder and never dial another leg. */
    function dispose() {
      shuttingDown = true
    }

    return {
      socketFor: socketFor,
      onOpen: onOpen,
      onError: onError,
      onClose: onClose,
      report: report,
      dispose: dispose,
    }
  }

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
    /** Monotonic id per leg socket, so listener-vs-socket identity is visible in the trace. */
    var socketSeq = 0
    var merges = new Map()
    var counter = 0
    /** Frames seen per upstream leg, for the diagnostics report. */
    var relays = {}
    /** True once the relay path dialed the mount; the Host owns that connection, so it is one-shot. */
    var remoteRelayDialed = false

    /**
     * The legs of this mux: one controller owns each socket's dial policy and the remote leg's
     * recovery ladder, so no reconnect state is written from the socket callbacks below.
     */
    var remoteLeg = createRemoteLeg({
      dial: openLeg,
      publishStatus: publishStatus,
      note: note,
      traceEvent: traceEvent,
      // The ladder schedules through the page's own timers; a container without a task queue
      // runs an attempt inline instead.
      timers: {
        setTimeout: typeof setTimeout === 'function' ? setTimeout : undefined,
        clearTimeout: typeof clearTimeout === 'function' ? clearTimeout : undefined,
      },
      now: function () { return Date.now() },
      legs: upstreams,
      mux: {
        streamCount: function () { return remoteStreams.size },
        replayStreams: replayRemoteStreams,
        settleMerged: settleDeadRemoteStreams,
        handOff: function () { try { client.close() } catch (error) { /* the page reconnects on its own */ } },
      },
    })

    /** Send frames to one leg socket; the controller owns whether a dial may happen at all. */
    function connect(kind) {
      return remoteLeg.socketFor(kind)
    }

    /**
     * Open, wire and record one leg socket.
     *
     * The caller has already decided that this leg may be dialed; this resolves the target and
     * attaches every listener the mux needs.
     */
    function openLeg(kind) {
      var hostRelay = kind === 'remote' && HOST_RECONNECTS_REMOTE === true
      // The Host owns the mount connection in relay mode, so this page dials it exactly once;
      // a second socket would double-subscribe every stream. The flag is armed only after the
      // target resolved, so an unresolvable mount keeps reporting leg-no-url instead of silence.
      if (hostRelay && remoteRelayDialed) return undefined
      var target = kind === 'local' ? localPath : mountSocketUrl(localPath, hostRelay)
      if (target === undefined) {
        note('leg-no-url', { kind: kind, from: localPath })
        return undefined
      }
      var socket
      if (hostRelay) remoteRelayDialed = true
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
      socket.__drhSocketId = (socketSeq += 1)
      traceEvent('connect-return', { kind: kind, socketId: socket.__drhSocketId, readyState: socket.readyState, reused: false, stackDepth: stackDepthNow() })
      note('leg-open-requested', { kind: kind, url: target })
      publishStatus(kind, 'connecting')
      // A shell-provided socket may implement only addEventListener; assigning
      // `onopen` there would silently drop the event and hang the connection.
      var on = typeof socket.addEventListener === 'function'
        ? function (type, handler) { socket.addEventListener(type, handler) }
        : function (type, handler) { socket['on' + type] = handler }
      on('open', function (event) {
        note('leg-opened', { kind: kind })
        // The remote leg's status and recovery belong to its controller. The local leg mirrors
        // the real socket exactly: an invented open would leave the UI waiting on a connection
        // that never arrives.
        if (kind === 'remote') { remoteLeg.onOpen(socket); return }
        publishStatus(kind, 'open')
        client.readyState = 1
        client.dispatch('open', event || {})
      })
      // A leg that never opens must be distinguishable from one that opens and
      // then goes quiet, so sample its state instead of waiting forever.
      if (schedule !== undefined) {
        var sample = function () { note('leg-state', { kind: kind, state: socket.readyState }) }
        schedule(sample, 500)
        schedule(sample, 2000)
      }
      on('error', function (event) {
        if (kind === 'remote') { remoteLeg.onError(socket, event); return }
        note('leg-error', { kind: kind, message: String((event && (event.message || event.type)) || 'error') })
        publishStatus(kind, 'error')
        note('local-leg-error', { message: String((event && (event.message || event.type)) || 'error') })
        client.dispatch('error', event || {})
      })
      on('close', function (event) {
        if (kind === 'remote') { remoteLeg.onClose(socket, event); return }
        note('leg-closed', { kind: kind, code: (event && event.code) || 0 })
        client.readyState = 3
        client.dispatch('close', event || {})
      })
      on('message', function (event) {
        relays[kind] = (relays[kind] || 0) + 1
        if (relays[kind] === 1) note('leg-first-frame', { kind: kind })
        relayIn(kind, event.data)
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
      if (kind === 'remote' && HOST_RECONNECTS_REMOTE === true && frame.type === 'drh/relay-status') {
        if (frame.state === 'open' || frame.state === 'error' || frame.state === 'connecting') {
          if (frame.state === 'error') remoteEventClientId = undefined
          traceEvent('host-relay-status', { state: frame.state })
          publishStatus('remote', frame.state)
        }
        return
      }
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
            && (frame.value.type === 'baseline' || frame.value.type === 'replace')) {
            side.seen = true
            if (frame.value.type === 'baseline') traceEvent('workspace-baseline', { kind: kind })
          }
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
          // With 'group: none' the shipped list carries no remote Session and no remote
          // Workspace claims one, so the row the shipped client builds from this emit
          // lands in the shipped "Ungrouped" bucket. The remote block owns those Sessions;
          // refresh its published snapshot instead of growing the shipped list.
          if (GROUP_MODE === 'none' && value.type === 'emit' && value.event === 'api-session/added') {
            note('events-skip-remote-added', { count: 1 })
            scheduleRemoteSessionsRefresh()
            return
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
          try {
            if (connect('remote') !== undefined) {
              original.retried = true
              note('retry-remote', { endpoint: original.endpoint })
              byUpstream.delete(frame.streamId)
              counter += 1
              var retryId = route.clientId + '~retry' + counter
              byUpstream.set(retryId, { clientId: route.clientId, kind: 'remote', merge: false, mode: 'single' })
              byClient.set(route.clientId, [{ kind: 'remote', upstreamId: retryId }])
              sendLeg('remote', JSON.stringify({ type: 'open', streamId: retryId, endpoint: original.endpoint, payload: original.payload }))
              return
            }
          } catch (error) { /* fall through: forward the original failure */ }
        }
      }
      if (frame.type === 'error') {
        note('upstream-error', { kind: route.kind, error: JSON.stringify(frame.error ?? {}).slice(0, 120) })
      }
      if (frame.type === 'item' && frame.value?.type === 'snapshot'
        && opens.get(route.clientId)?.endpoint === 'session/follow') {
        traceEvent('session-snapshot', { kind: kind })
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

    /**
     * Re-open the remote leg's streams on the socket that just replaced it.
     * `depth` is the recovery ladder's re-entry depth, carried into the trace.
     */
    function replayRemoteStreams(depth) {
      if (remoteStreams.size === 0) return
      var sent = 0
      traceEvent('replay-enter', { total: remoteStreams.size, depth: depth })
      // Iterate a snapshot: the loop below re-keys every entry (delete + set), and Map.forEach
      // visits keys added during iteration — that turned each replay into an endless loop that
      // wedged the renderer the moment a tracked stream had to be replayed.
      Array.from(remoteStreams.entries()).forEach(function (pair) {
        var oldId = pair[0]
        var entry = pair[1]
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
          sent += 1
          if (sent <= 8) traceEvent('replay-send', { i: sent, endpoint: entry.endpoint })
        } catch (error) { /* the next attempt retries */ }
      })
      note('replay-remote', { streams: remoteStreams.size })
      traceEvent('replay-end', { streams: sent, total: remoteStreams.size, depth: depth })
    }

    /** A dead remote leg must never wedge a merged stream. */
    function settleDeadRemoteStreams() {
      merges.forEach(function (state, clientId) {
        if (state.remote.settled === true) return
        state.remote.settled = true
        flushMerged(clientId, state, true)
        maybeEnd(clientId, state)
      })
    }

    /** Diagnostics: the remote leg's ladder state (see createRemoteLeg's report()). */
    client.__legReport = remoteLeg.report

    client._close = function () {
      remoteLeg.dispose()
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
          if (kind === 'remote' && HOST_RECONNECTS_REMOTE !== true) {
            remoteStreams.set(upstreamId, {
              clientId: frame.streamId, endpoint: frame.endpoint, payload: frame.payload, merge: merge, mode: mode,
            })
          }
          sendLeg(kind, JSON.stringify({ type: 'open', streamId: upstreamId, endpoint: frame.endpoint, payload: frame.payload }))
        }
        if (opened.length === 0) {
          if (HOST_RECONNECTS_REMOTE === true) emitToClient({
            type: 'error',
            streamId: frame.streamId,
            error: { code: 'gateway/remote-unavailable', message: 'Remote stream relay is unavailable', details: {} },
          })
          return
        }
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

