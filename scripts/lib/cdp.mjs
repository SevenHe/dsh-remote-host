/**
 * The CDP client both browser probes speak to the page through.
 *
 * Why this exists: parity-snapshot.mjs and patch-probe.mjs each carried a copy, and the copies had
 * already drifted -- one dropped pending calls when the socket closed, the other assumed every
 * reply carries a result object. A probe whose measurements depend on which script dialled the
 * socket is not a measurement, so the transport lives in one place.
 *
 * One request at a time: every send() resolves exactly once, matched to its reply by frame id.
 * Nothing is retried or reordered, because a probe must reproduce the page's real ordering.
 *
 * @module
 */

/** One page-debugger connection. Construct through {@link Cdp.open}. */
export class Cdp {
  /**
   * Wrap an already-open socket.
   * @param socket - WebSocket to the page's `webSocketDebuggerUrl`.
   */
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      if (frame.id === undefined) return
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) entry.reject(new Error(entry.method + ': ' + JSON.stringify(frame.error)))
      else entry.resolve(frame.result)
    })
    // A closed socket can never answer, so reject what is in flight instead of letting callers hang.
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('cdp socket closed'))
      this.pending.clear()
    })
  }

  /**
   * Open the page debugger.
   * @param webSocketUrl - `webSocketDebuggerUrl` of the target page.
   * @returns The connected client.
   */
  static open(webSocketUrl) {
    return new Promise((resolve, reject) => {
      // Built-in WebSocket exists from Node 22; without the check the failure is a bare
      // ReferenceError that says nothing about the requirement.
      if (typeof globalThis.WebSocket !== 'function') {
        reject(new Error('Node >= 22 is required (global WebSocket)'))
        return
      }
      const socket = new WebSocket(webSocketUrl)
      socket.addEventListener('open', () => resolve(new Cdp(socket)))
      socket.addEventListener('error', () => reject(new Error('cdp websocket error')))
    })
  }

  /**
   * Send one protocol command.
   * @param method - CDP method name, for example `Runtime.evaluate`.
   * @param params - method parameters; omitted means none.
   * @returns The reply's `result` object.
   */
  send(method, params) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
    })
  }

  /**
   * Evaluate an expression in the page.
   * @param expression - expression to evaluate; promises it returns are awaited.
   * @returns The remote value, or undefined when the reply carries none.
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception === undefined ? result.exceptionDetails.text : result.exceptionDetails.exception.description
      throw new Error('evaluate failed: ' + String(detail))
    }
    return result.result === undefined ? undefined : result.result.value
  }

  /**
   * Evaluate a page-side function that takes no arguments.
   * @param fn - function defined only on the page side; serialized with toString().
   * @returns Its remote value.
   */
  async call(fn) {
    return await this.evaluate('(' + fn.toString() + ')()')
  }

  /**
   * Poll a page-side predicate until it reports ready.
   * @param fn - page-side predicate returning a truthy value once the wait is over.
   * @param timeoutMs - how long to keep polling; defaults to 5s.
   * @returns The first truthy value, or null on timeout.
   */
  async waitFor(fn, timeoutMs) {
    const deadline = Date.now() + (timeoutMs === undefined ? 5000 : timeoutMs)
    for (;;) {
      const value = await this.call(fn)
      if (value !== null && value !== undefined && value !== false) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Move the pointer without pressing, so `:hover` rules apply.
   * @param x - viewport x coordinate.
   * @param y - viewport y coordinate.
   */
  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  }

  /**
   * Left-click at viewport coordinates, after a pointer move over the same point.
   * @param x - viewport x coordinate.
   * @param y - viewport y coordinate.
   */
  async click(x, y) {
    await this.mouseMove(x, y)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  /**
   * Send Escape down and up, which closes any menu a previous click opened.
   * Both virtual key codes are sent: menus listen on the platform's native code, the page on key/code.
   */
  async escape() {
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  /** Close the socket; commands still in flight reject through the close listener. */
  close() {
    try { this.socket.close() } catch {
      // The page may have closed the debugger first; the socket is unusable either way.
    }
  }
}

/**
 * List the page targets a CDP endpoint exposes.
 * @param cdpPort - port the app or Chrome was started with (`--remote-debugging-port`).
 * @returns Page targets carrying a debugger URL, in the endpoint's order.
 */
export async function listPageTargets(cdpPort) {
  const response = await fetch('http://127.0.0.1:' + String(cdpPort) + '/json/list')
  const targets = await response.json()
  return (Array.isArray(targets) ? targets : []).filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
}
