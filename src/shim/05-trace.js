/**
 * MODULE: 05-trace.js
 * Crash breadcrumbs: a bounded ring of what the page was doing, flushed to the
 * Host so a renderer crash leaves evidence behind.
 *
 * The desktop renderer dies inside V8 (EXC_BREAKPOINT) with a 21 MB heap, so what
 * matters is the activity immediately before it: which element was hit, how often
 * the tree mutated, and how the heap moved. Nothing here is user visible, every
 * entry point swallows its own failures, and the whole module is inert unless the
 * Host passes 'trace: true'.
 */
  var TRACE = config.trace === true
  /** Entries kept in memory; the oldest fall out first. */
  var TRACE_LIMIT = 40
  /** Flush as soon as this many entries are pending, instead of waiting for the timer. */
  var TRACE_BATCH = 10
  var TRACE_PATH = '/__dsh_remote_host__/trace'
  var traceRing = []
  var traceUnsent = 0
  var traceListeners = 0
  var traceRenders = 0
  var traceFlushTimer
  var traceHeartbeatTimer
  var traceObserver
  var traceBusy = false
  var traceInstalled = false
  /**
   * Diagnostics must never become a request storm. An early flush fires as soon as
   * TRACE_BATCH entries are pending, so a page that is busy because the mount is down
   * ends up posting breadcrumbs continuously — measured at 4.5 requests per second
   * against an unreachable host. One send per second is enough to reconstruct a crash,
   * and a failing sink backs off instead of retrying at the same rate.
   */
  /**
   * Events that MUST leave the page immediately.
   *
   * The crash lands inside 0.7 s of the remote leg reopening, which is shorter than the
   * batch (10 entries) and the one-per-second rate ceiling, so a batched send loses exactly
   * the evidence that matters. These are forced out synchronously instead.
   */
  var TRACE_CRITICAL = {
    'remote-open': true, 'open-handled': true, 'replay-enter': true, 'replay-send': true,
    'replay-done': true, 'status-open-enter': true, 'status-open-exit': true,
    'reconnect-enter': true, 'attempt-run': true, 'attempt-early-return': true,
    'connect-return': true, 'attempt-socket': true, 'listener-attach': true, 'leg-dropped-stale': true,
    'attempt-abandoned': true, 'attempt-deferred': true, 'reconnect-suppressed': true,
    'reconnect-begin': true, 'reconnect-end': true,
    'reconnect-nocarrier': true, 'replay-begin': true, 'replay-end': true,
    'stream-open': true, 'service-register': true, 'crash-marker': true,
  }
  /** Last entries kept in a plain global, so an external poller survives a failed send. */
  var TRACE_TAIL = 60
  var traceTail = []
  var TRACE_MIN_INTERVAL_MS = 1000
  var TRACE_BACKOFF_MIN_MS = 2000
  var TRACE_BACKOFF_MAX_MS = 30000
  /** Earliest time the next send may start. */
  var traceNextAt = 0
  /** Current backoff after a failed send; 0 while the sink is healthy. */
  var traceBackoff = 0
  var traceTrailingTimer

  /** One short scalar. Objects never reach the wire, so tracing stays cheap. */
  function traceScalar(value) {
    try {
      if (value === null || value === undefined) return undefined
      if (typeof value === 'number') return isFinite(value) ? value : null
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') return value.length > 60 ? value.slice(0, 60) : value
      if (typeof value === 'function') return '[fn]'
      if (Array.isArray(value)) return '[array]'
      return '[object]'
    } catch (error) { return undefined }
  }

  /** Copy a few short scalars out of a detail object; never stringify it. */
  function traceDetail(detail) {
    try {
      if (detail === null || typeof detail !== 'object') {
        var single = traceScalar(detail)
        return single === undefined ? undefined : { value: single }
      }
      var out = {}
      var keys = Object.keys(detail)
      // 12 keys: the heartbeat alone carries seven counters, and a cap of six
      // silently dropped every DOM counter after the first one.
      for (var index = 0; index < keys.length && index < 12; index += 1) {
        var key = keys[index]
        if (typeof key !== 'string' || key.length > 24) continue
        var value = traceScalar(detail[key])
        if (value !== undefined) out[key] = value
      }
      return out
    } catch (error) { return undefined }
  }

  /** Append one entry to the ring, flushing early once a batch is pending. */
  /**
   * Stable identity of THIS page instance.
   *
   * The trace file is shared by every instance on the machine (the desktop App, our labs,
   * e2e runs), so a bare "failure" line cannot be attributed. The block stamps a per-instance
   * id on its container; pairing it with the configured label makes each line attributable.
   */
  var traceInstance
  function traceInstanceId() {
    if (traceInstance !== undefined) return traceInstance
    var label = typeof config.label === 'string' && config.label.length > 0 ? config.label : 'remote'
    var inst = ''
    try {
      var element = document.getElementById('drh-remote-block')
      if (element !== null && element !== undefined) inst = element.getAttribute('data-drh-inst') || ''
    } catch (error) { inst = '' }
    traceInstance = inst.length > 0 ? label + '#' + inst : label + '#-'
    return traceInstance
  }

  function traceEvent(name, detail) {
    if (TRACE !== true) return
    try {
      var entry = { t: Date.now(), name: typeof name === 'string' ? name.slice(0, 40) : 'event' }
      entry.inst = traceInstanceId()
      var extra = traceDetail(detail)
      if (extra !== undefined) entry.detail = extra
      traceRing.push(entry)
      traceUnsent += 1
      // Mirror into a global tail: the harness polls it every 250 ms, so the last entries
      // survive even when the sink is rate limited and the page dies immediately after.
      try {
        traceTail.push(String(entry.t) + ' ' + entry.name + (entry.detail === undefined ? '' : ' ' + JSON.stringify(entry.detail).slice(0, 160)))
        if (traceTail.length > TRACE_TAIL) traceTail.splice(0, traceTail.length - TRACE_TAIL)
        globalThis.__DRH_TRACE_TAIL__ = traceTail
      } catch (error) { /* the tail is best effort */ }
      if (traceRing.length > TRACE_LIMIT) {
        traceRing.splice(0, traceRing.length - TRACE_LIMIT)
        if (traceUnsent > traceRing.length) traceUnsent = traceRing.length
      }
      if (TRACE_CRITICAL[entry.name] === true) {
        // Critical: ignore the rate ceiling for this one send.
        traceNextAt = 0
        traceFlush()
      } else if (traceUnsent >= TRACE_BATCH) traceFlush()
    } catch (error) { /* tracing must never break the page */ }
  }

  /**
   * Send whatever has not been sent yet. A failed send is dropped rather than
   * retried: a crashy page must not turn diagnostics into a request storm.
   */
  function traceFlush() {
    if (TRACE !== true || traceBusy === true) return
    try {
      if (traceUnsent <= 0) return
      // Rate ceiling: a trailing flush picks the batch up when the window opens, so
      // nothing is lost, it just cannot be sent more often than this.
      var now = Date.now()
      if (now < traceNextAt) {
        if (traceTrailingTimer === undefined) {
          traceTrailingTimer = globalThis.setTimeout(function () {
            traceTrailingTimer = undefined
            traceFlush()
          }, traceNextAt - now)
        }
        return
      }
      traceNextAt = now + TRACE_MIN_INTERVAL_MS
      if (traceTrailingTimer !== undefined) {
        globalThis.clearTimeout(traceTrailingTimer)
        traceTrailingTimer = undefined
      }
      var from = traceRing.length - traceUnsent
      if (from < 0) from = 0
      var lines = traceRing.slice(from)
      if (lines.length === 0) return
      traceUnsent = 0
      traceBusy = true
      var release = function () { traceBusy = false }
      var pending = globalThis.fetch(MOUNT + TRACE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines: lines }),
        keepalive: true,
      })
      var settled = function (ok) {
        release()
        if (ok === true) {
          traceBackoff = 0
          return
        }
        // The sink is unreachable: back off so a dead mount cannot be hammered.
        traceBackoff = traceBackoff === 0 ? TRACE_BACKOFF_MIN_MS : Math.min(traceBackoff * 2, TRACE_BACKOFF_MAX_MS)
        traceNextAt = Date.now() + traceBackoff
      }
      if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
        pending.then(function (response) { settled(response !== null && typeof response === 'object' && response.ok === true) }, function () { settled(false) })
      } else release()
    } catch (error) { traceBusy = false }
  }

  /**
   * Short description of one event target: element, classes, aria label and the
   * plugin's own data attributes. That is enough to name the row or button the
   * user hit without recording any page content.
   */
  function traceTarget(target) {
    try {
      if (target === null || typeof target !== 'object') return undefined
      var parts = []
      var tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag.length > 0) parts.push(tag)
      var className = typeof target.className === 'string' ? target.className.trim() : ''
      if (className.length > 0) parts.push('.' + className.slice(0, 40))
      if (typeof target.getAttribute === 'function') {
        var aria = target.getAttribute('aria-label')
        if (typeof aria === 'string' && aria.length > 0) parts.push('aria=' + aria.slice(0, 60))
        var attributes = target.attributes
        if (attributes !== null && typeof attributes === 'object') {
          for (var index = 0; index < attributes.length && index < 8; index += 1) {
            var attribute = attributes[index]
            if (attribute === null || typeof attribute !== 'object') continue
            var attributeName = typeof attribute.name === 'string' ? attribute.name : ''
            if (attributeName.indexOf('data-drh') !== 0) continue
            parts.push(attributeName + '=' + String(attribute.value).slice(0, 40))
          }
        }
      }
      var text = parts.join(' ').slice(0, 160)
      return text.length === 0 ? undefined : text
    } catch (error) { return undefined }
  }

  /** Record one user interaction, including the row or button it landed on. */
  function traceInteraction(type, event) {
    try {
      var key
      if (type === 'keydown' && event !== null && typeof event === 'object' && typeof event.key === 'string') key = event.key
      traceEvent('hit', {
        type: type,
        target: traceTarget(event === null || typeof event === 'object' ? event.target : undefined),
        key: key,
      })
    } catch (error) { /* ignore */ }
  }

  /** Failures are capped per page load, so a loop cannot turn them into a storm. */
  var TRACE_FAILURE_LIMIT = 20
  var traceFailures = 0

  /**
   * Record one JS-level failure and send it immediately.
   *
   * The desktop crash log says "no error-level renderer console output was captured" for
   * every renderer death, so the one artefact a V8 abort leaves behind — the page telling
   * us what was wrong — was being thrown away. Capturing it here is the only channel that
   * outlives the renderer, because the Host writes it to disk. The one-per-second ceiling
   * is bypassed (the page may not live to see the next window) but a hard cap keeps a
   * failure loop from becoming the storm that ceiling exists to prevent.
   */
  function traceFailure(kind, detail) {
    if (TRACE !== true) return
    try {
      if (traceFailures >= TRACE_FAILURE_LIMIT) return
      traceFailures += 1
      traceEvent('failure', Object.assign({ kind: kind, n: traceFailures }, detail))
      traceNextAt = 0
      traceFlush()
    } catch (error) { /* tracing must never break the page */ }
  }

  /** Periodic heap/size sample, so a crash has a 'how big was it' data point. */
  function traceHeartbeat() {
    try {
      var memory = typeof performance === 'object' && performance !== null ? performance.memory : undefined
      var nodes = 0
      try {
        nodes = typeof document === 'object' && document !== null ? document.getElementsByTagName('*').length : 0
      } catch (error) { nodes = 0 }
      // DOM accounting next to the size sample: a leak shows up as one of these
      // counters climbing while nodes/heap climb, which names the leaking surface
      // without another reproduction round.
      // Flat scalars on purpose: traceEvent stringifies objects as [object].
      var domCount = function (selector) {
        try {
          if (typeof document !== 'object' || document === null) return -1
          return document.querySelectorAll(selector).length
        } catch (error) { return -1 }
      }
      var bodyCount = -1
      try { bodyCount = document.body ? document.body.children.length : -1 } catch (error) { bodyCount = -1 }
      traceEvent('hb', {
        heap: memory === undefined ? undefined : memory.usedJSHeapSize,
        total: memory === undefined ? undefined : memory.totalJSHeapSize,
        nodes: nodes,
        listeners: traceListeners,
        renders: traceRenders,
        cards: domCount('#drh-hovercard'),
        menus: domCount('.drh-menuSurface'),
        panels: domCount('.drh-panel, #drh-block-panel'),
        roots: domCount('#drh-remote-block'),
        rows: domCount('#drh-remote-block [data-drh-session]'),
        groups: domCount('#drh-remote-block [data-drh-group]'),
        body: bodyCount,
      })
    } catch (error) { /* ignore */ }
  }

  /** Install listeners, timers and the announce tap. Idempotent; inert when disabled. */
  function traceInstall() {
    if (TRACE !== true || traceInstalled === true) return
    traceInstalled = true
    try {
      var types = ['pointerdown', 'mousedown', 'click', 'keydown', 'wheel']
      if (typeof globalThis.addEventListener === 'function') {
        for (var index = 0; index < types.length; index += 1) {
          globalThis.addEventListener(types[index], (function (type) {
            return function (event) { traceInteraction(type, event) }
          })(types[index]), { capture: true, passive: true })
          traceListeners += 1
        }
      }
      // Tree mutations stand in for renders: the point is counting activity, not
      // attributing it, and an observer costs nothing while nothing changes.
      if (typeof MutationObserver === 'function' && typeof document === 'object' && document !== null) {
        traceObserver = new MutationObserver(function () { traceRenders += 1 })
        traceObserver.observe(document, { childList: true, subtree: true })
      }
      if (typeof document === 'object' && document !== null && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function () {
          // Crashes cluster around hide/reflow, so flush before the page goes quiet.
          if (document.visibilityState === 'hidden') traceFlush()
        })
      }
      // The three ways a page reports its own trouble.
      try {
        if (typeof globalThis.addEventListener === 'function') {
          globalThis.addEventListener('error', function (event) {
            var record = event === null || typeof event !== 'object' ? {} : event
            traceFailure('error', {
              message: String(record.message === undefined ? '' : record.message).slice(0, 120),
              source: String(record.filename === undefined ? '' : record.filename).slice(-60),
              line: typeof record.lineno === 'number' ? record.lineno : undefined,
            })
          })
          globalThis.addEventListener('unhandledrejection', function (event) {
            var reason = event === null || typeof event !== 'object' ? undefined : event.reason
            var text = typeof reason === 'string'
              ? reason
              : String(reason !== null && reason !== undefined && reason.message !== undefined ? reason.message : reason)
            traceFailure('rejection', { message: text.slice(0, 120) })
          })
        }
      } catch (error) { /* ignore */ }
      // console.error is where the shell reports its own failures.
      try {
        var consoleBase = globalThis.console
        if (consoleBase !== undefined && consoleBase !== null && typeof consoleBase.error === 'function') {
          var consoleErrorBase = consoleBase.error
          consoleBase.error = function () {
            try {
              var parts = []
              for (var argIndex = 0; argIndex < arguments.length && argIndex < 3; argIndex += 1) {
                var value = arguments[argIndex]
                if (typeof value === 'string') parts.push(value)
                else if (value !== null && value !== undefined && value.message !== undefined) parts.push(String(value.message))
                else parts.push('[object]')
              }
              traceFailure('console-error', { message: parts.join(' ').slice(0, 160) })
            } catch (error) { /* ignore */ }
            return consoleErrorBase.apply(consoleBase, arguments)
          }
        }
      } catch (error) { /* ignore */ }
      traceHeartbeatTimer = globalThis.setInterval(traceHeartbeat, 5000)
      traceFlushTimer = globalThis.setInterval(traceFlush, 2000)
      // announce drives every published layout change; tracing it lines state
      // pushes up against the interactions above.
      var announceBase = announce
      announce = function (name, detail) {
        try { traceEvent('announce', { name: name }) } catch (error) { /* ignore */ }
        return announceBase(name, detail)
      }
      globalThis.__DRH_TRACE__ = traceEvent
      traceEvent('trace-on', { mount: MOUNT, streams: STREAMS })
    } catch (error) { /* a broken trace must never break the page */ }
  }

