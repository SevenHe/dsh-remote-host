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
  FakeSocket.prototype.close = function () {
    this.readyState = 3
    if (typeof this._close === 'function') this._close()
    if (typeof this.onclose === 'function') this.onclose({})
  }

