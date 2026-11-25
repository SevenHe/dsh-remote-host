/**
 * MODULE: 30-streams.js
 * The minimal WebSocket face the stream client drives, plus the listener dispatch
 * that mirrors a real socket.
 */
  /** Minimal WebSocket face the stream client drives. */
  function FakeSocket() {
    this.readyState = 0
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    this._listeners = {}
  }
  FakeSocket.prototype.addEventListener = function (type, handler) {
    this._listeners[type] = (this._listeners[type] || []).concat(handler)
  }
  /** Deliver one event to the `onX` property and every registered listener. */
  FakeSocket.prototype.dispatch = function (type, event) {
    var direct = this['on' + type]
    if (typeof direct === 'function') {
      try { direct.call(this, event) } catch (error) { /* listener failure stays local */ }
    }
    var list = this._listeners[type]
    if (list === undefined) return
    for (var index = 0; index < list.length; index += 1) {
      try { list[index].call(this, event) } catch (error) { /* listener failure stays local */ }
    }
  }
  FakeSocket.prototype.removeEventListener = function (type, handler) {
    var list = this._listeners[type]
    if (list === undefined) return
    this._listeners[type] = list.filter(function (entry) { return entry !== handler })
  }
  /**
   * Mux socket carried by forwarded HTTP instead of a WebSocket.
   *
   * The page cannot open a socket from a custom scheme, but its ordinary requests reach the
   * Host, so the same mux frames travel as JSON on a cursor protocol. Everything above this
   * face — the stream client, its reconnect and its status — is unchanged.
   */
  function PollSocket() {
    FakeSocket.call(this)
    var socket = this
    var cursor = 0
    var uplink = []
    var opened = false
    var closed = false
    var pending = false
    var failures = 0
    var controller

    /** @param {string} data - one client frame to send on the next round trip. */
    this.send = function (data) {
      if (closed === true) return
      uplink.push(String(data))
      // End the current wait so the frame leaves now instead of at the deadline.
      try { if (controller !== undefined) controller.abort() } catch (error) { /* best effort */ }
    }

    this._close = function () {
      closed = true
      try { if (controller !== undefined) controller.abort() } catch (error) { /* best effort */ }
    }

    /** Stop for good and report the close once. */
    function finish() {
      if (closed === true) return
      closed = true
      socket.readyState = 3
      socket.dispatch('close', {})
    }

    /**
     * Run the next round trip on a fresh task.
     *
     * Scheduling instead of recursing matters: an aborted request settles synchronously in
     * some carriers, and an immediate retry from its handler would spin without ever
     * yielding to timers or I/O.
     */
    function schedule() {
      if (closed === true) return
      if (typeof globalThis.setTimeout !== 'function') { pull(); return }
      globalThis.setTimeout(pull, failures === 0 ? 0 : 400)
    }

    function pull() {
      if (closed === true || pending === true) return
      if (typeof globalThis.fetch !== 'function') { socket.dispatch('error', {}); finish(); return }
      pending = true
      var body = { cursor: cursor, uplink: uplink.splice(0, uplink.length), waitMs: POLL_HOLD_MS }
      controller = typeof AbortController === 'function' ? new AbortController() : undefined
      var init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
      if (controller !== undefined) init.signal = controller.signal
      globalThis.fetch(MOUNT + '/__dsh_remote_host__/mux-poll', init).then(function (response) {
        if (response.ok !== true) throw new Error('mux-poll HTTP ' + String(response.status))
        return response.json()
      }).then(function (answer) {
        pending = false
        controller = undefined
        failures = 0
        if (closed === true || answer === null || typeof answer !== 'object') return
        if (typeof answer.cursor === 'number') cursor = answer.cursor
        var frames = Array.isArray(answer.frames) ? answer.frames : []
        if (opened !== true && (answer.state === 'open' || frames.length > 0)) {
          opened = true
          socket.readyState = 1
          socket.dispatch('open', {})
        }
        for (var index = 0; index < frames.length; index += 1) {
          socket.dispatch('message', { data: frames[index] })
        }
        if (answer.state === 'closed' || answer.state === 'error' || answer.state === 'unavailable') {
          finish()
          return
        }
        schedule()
      }, function (error) {
        pending = false
        controller = undefined
        if (closed === true) return
        if (error !== undefined && error.name === 'AbortError') { schedule(); return }
        failures += 1
        socket.dispatch('error', {})
        if (failures >= 3) { finish(); return }
        schedule()
      })
    }
    pull()
  }
  PollSocket.prototype = Object.create(FakeSocket.prototype)
  PollSocket.prototype.constructor = PollSocket
  FakeSocket.prototype.close = function () {
    this.readyState = 3
    if (typeof this._close === 'function') this._close()
    if (typeof this.onclose === 'function') this.onclose({})
  }

