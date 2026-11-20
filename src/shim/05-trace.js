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
      for (var index = 0; index < keys.length && index < 6; index += 1) {
        var key = keys[index]
        if (typeof key !== 'string' || key.length > 24) continue
        var value = traceScalar(detail[key])
        if (value !== undefined) out[key] = value
      }
      return out
    } catch (error) { return undefined }
  }

  /** Append one entry to the ring, flushing early once a batch is pending. */
  function traceEvent(name, detail) {
    if (TRACE !== true) return
    try {
      var entry = { t: Date.now(), name: typeof name === 'string' ? name.slice(0, 40) : 'event' }
      var extra = traceDetail(detail)
      if (extra !== undefined) entry.detail = extra
      traceRing.push(entry)
      traceUnsent += 1
      if (traceRing.length > TRACE_LIMIT) {
        traceRing.splice(0, traceRing.length - TRACE_LIMIT)
        if (traceUnsent > traceRing.length) traceUnsent = traceRing.length
      }
      if (traceUnsent >= TRACE_BATCH) traceFlush()
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
      if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') pending.then(release, release)
      else release()
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

