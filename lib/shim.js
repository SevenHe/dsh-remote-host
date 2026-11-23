/**
 * dsh-remote-host — browser shim (injected into the index before boot).
 *
 * Owns one decision: for each Host API call, does it belong to this machine or
 * to the mounted remote host? Local calls keep the original transport; remote
 * calls are sent to the mount, where the Host relays them with the remote's own
 * credential. `session/list` is merged so remote sessions appear in the native
 * sidebar, and stream opens are routed per session the same way.
 *
 * Every path falls back to the unmodified behaviour when anything looks off, so
 * a bad config degrades to a normal Harness rather than a broken one.
 */
(function () {
/**
 * MODULE: 00-config.js
 * Configuration and the shared mutable state of this shim: the mount point, the
 * remote id/workspace registries, and the flags read once at install time.
 */
  var config = globalThis.__DSH_REMOTE_HOST__
  if (config === null || typeof config !== 'object' || typeof config.mount !== 'string') return
  var MOUNT = config.mount
  /**
   * Crash-loop circuit breaker.
   *
   * The desktop renderer sometimes dies inside V8 before it can say why (34 crash
   * reports land on one `brk #0`), and every death is followed by a reload that boots
   * the page again. If the page is being reborn several times a minute, mounting the
   * remote section again only feeds that loop, so after four boots inside a minute the
   * shim degrades: no block, no list merge. A usable list of local sessions is worth
   * more than a remote section that keeps taking the window down.
   *
   * The record lives in localStorage (same origin), because surviving the reload that
   * a crash causes is the one thing this has to do. It decays by itself: entries older
   * than a minute are dropped, so a quiet minute restores the block on the next load.
   */
  var BOOT_GUARD_KEY = 'drh:boots'
  var BOOT_GUARD_WINDOW_MS = 60000
  var BOOT_GUARD_LIMIT = 4
  var bootGuard = (function () {
    try {
      var store = globalThis.localStorage
      if (store === undefined || store === null) return { boots: 1, tripped: false }
      var raw = store.getItem(BOOT_GUARD_KEY)
      var parsed = raw === null ? null : JSON.parse(raw)
      var list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.t) ? parsed.t : []
      var now = Date.now()
      var recent = []
      for (var index = 0; index < list.length; index += 1) {
        if (typeof list[index] === 'number' && now - list[index] < BOOT_GUARD_WINDOW_MS) recent.push(list[index])
      }
      recent.push(now)
      if (recent.length > 16) recent = recent.slice(recent.length - 16)
      store.setItem(BOOT_GUARD_KEY, JSON.stringify({ t: recent }))
      return { boots: recent.length, tripped: recent.length > BOOT_GUARD_LIMIT }
    } catch (error) {
      return { boots: 1, tripped: false }
    }
  })()
  /** True when this page has been rebooting too fast to keep mounting the block. */
  var SAFE_MODE = bootGuard.tripped === true
  if (SAFE_MODE === true) globalThis.__DSH_REMOTE_HOST_SAFE__ = true
  var previous = globalThis.__DSH_TRANSPORT__ || {}
  /** Captured before any patching, so the router can still open real sockets. */
  var NativeWebSocket = globalThis.WebSocket
  var remoteSessions = new Set()
  /**
   * When a remote Session was last the page's focus.
   *
   * The client fetches session/modelCatalog once per page load, before it restores the
   * previous Session, so that request carries no Session id and cannot be routed by its
   * payload. Two clues decide the owner instead: this focus (set as soon as any request
   * names a remote Session) and, on a cold start, the Session the client persisted as
   * current (persistedCurrentSessionIsRemote). The catalogue is NOT merged: the two hosts
   * may legitimately serve different model lists, and a union would offer a local Session a
   * remote-only model that fails when it is selected.
   */
  var remoteFocusAt = 0
  /**
   * Focus expiry is only a safety net, not the mechanism: opening a Session this host owns
   * clears the focus explicitly (its id arrives in that request). The catalogue is cached
   * for the page lifetime anyway, so a lapsed window surfaces as the reload limitation
   * documented in docs/regression.md, not as a silent misroute.
   */
  var REMOTE_FOCUS_TTL_MS = 12 * 60 * 60 * 1000
  /** Workspace ids the mounted host reported for itself (used by createTarget only). */
  var remoteWorkspaceIds = new Set()
  /** Display window for remote work: recent activity, or anything still running. */
  var WINDOW_DAYS = typeof config.windowDays === 'number' && config.windowDays > 0 ? config.windowDays : 30
  var WINDOW_FLOOR = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  /**
   * Multiplexing the mux socket is opt-in. A carrier that does not behave like
   * a browser WebSocket would leave every connection waiting, so the default
   * keeps the shipped socket untouched and only merges unary traffic.
   */
  var STREAMS = config.streams === true
  /** The catch-all global WebSocket replacement; the carrier factory is always patched. */
  var GLOBAL_WS = config.globalWebSocket !== false
  /**
   * `attach: 'remote'` turns this window into a thin client of the mounted host:
   * every /api call and every stream goes to the remote, so sessions, history and
   * plugin panels all read ONE instance instead of merging two. Endpoints the
   * remote does not serve fall back to the local host, so shell-only features keep
   * working.
   */
  var ATTACH_REMOTE = config.attach === 'remote'
  /**
   * The super agent plugin serves its own routes under `/orchestrator/` (its API
   * prefix is `/orchestrator/api/`, registered with `ctx.webServer.register`).
   * With `superagent: 'remote'` those requests follow the mounted host, so the
   * panel drives the remote instance instead of a second local one.
   */
  var SUPERAGENT_REMOTE = config.superagent === 'remote'
  /** 'single' folds every remote Workspace into one group under this label. */
  // single: fold every remote workspace into one shipped group; workspace: keep each one as
  // a shipped group; none: publish remote data only, so a plugin-rendered block owns it.
  var GROUP_MODE = config.group === 'workspace' ? 'workspace' : (config.group === 'none' ? 'none' : 'single')
  var GROUP_ID = 'drh:devbox'
  /** Prefix that marks a merged remote workspace row (used by the section stylesheet). */
  var REMOTE_WORKSPACE_PREFIX = 'drh:'

  /** Short name used for the merged workspace path. */
  var GROUP_PATH = typeof config.label === 'string' && config.label.length > 0 ? config.label : 'devbox'
  /**
   * Title shown on the merged group. Keeping the remote sessions in one *native* group
   * (with a section-like title) preserves every shipped row behaviour — pin, archive,
   * search, drag, context menu — because the rows are the shipped rows.
   */
  var GROUP_LABEL = '远端工作区 · ' + GROUP_PATH
  /** Router currently owning the mux socket, so group merges can be refreshed. */
  var activeRouter
  /** Remote session id -> its Workspace title, for row labels inside the group. */
  var sessionWorkspace = new Map()
  /** Published copy of the remote id set, for the browser half's section split. */
  var remoteIdList = []
  /** Remote workspaces in their own order, for the browser half's remote groups. */
  var remoteSpaces = []

  /** Notify page listeners (the sidebar half) that published state changed. */
  function announce(name, detail) {
    try {
      if (typeof document !== 'object' || document === null || typeof CustomEvent !== 'function') return
      document.dispatchEvent(new CustomEvent('drh:' + name, { detail: detail }))
    } catch (error) { /* the page may not accept events yet */ }
  }

  /** Connection state per leg, surfaced by the sidebar's status indicator. */
  var legStatus = { remote: 'connecting', local: 'connecting' }

  /** Record and publish one leg's state: 'connecting' | 'open' | 'error'. */
  function publishStatus(kind, state) {
    try {
      // A retry loop republishes the same state; only a real transition is news.
      // Announcing every attempt drove a synchronous repaint per retry attempt.
      var current = globalThis.__DSH_REMOTE_HOST_STATUS__
      var unchanged = legStatus[kind] === state && current !== null && current !== undefined && current[kind] === state
      legStatus[kind] = state
      globalThis.__DSH_REMOTE_HOST_STATUS__ = { remote: legStatus.remote, local: legStatus.local }
      if (unchanged === true) return
      announce('status', globalThis.__DSH_REMOTE_HOST_STATUS__)
    } catch (error) { /* status is advisory */ }
  }

  /** Publish the remote id set and workspace layout for the sidebar sections. */
  function publishRemoteState() {
    try {
      var ids = Array.from(remoteSessions)
      var spaces = []
      for (var index = 0; index < remoteSpaces.length; index += 1) {
        var space = remoteSpaces[index]
        var members = space.ids.filter(function (id) { return remoteSessions.has(id) })
        if (members.length === 0) continue
        // Publish the raw remote id too: a workspace-level call (rename/delete) needs it, and
        // the merged row carries a drh: prefix.
        var rawId = String(
          space.id !== undefined && space.id !== null ? space.id
            : (space.workspaceId === undefined || space.workspaceId === null ? '' : space.workspaceId),
        ).replace(/^drh:/, '')
        spaces.push({ title: space.title, id: rawId, sessionIds: members })
      }
      // An empty set would classify every remote Session as local, which makes
      // them reappear under the client's ungrouped bucket. Keep the last good one.
      if (ids.length === 0) {
        note('publish-skip-empty', {})
        return
      }
      var signature = JSON.stringify([ids.length, spaces.map(function (space) { return [space.title, space.sessionIds.length] })])
      if (signature === publishedSignature) return
      publishedSignature = signature
      remoteIdList = ids
      globalThis.__DSH_REMOTE_HOST_IDS__ = ids
      globalThis.__DSH_REMOTE_HOST_STATE__ = { ids: ids, label: GROUP_LABEL, workspaces: spaces }
      announce('state', { ids: ids.length, workspaces: spaces.length })
    } catch (error) { /* publishing is best effort */ }
  }
  /** Cheap guard so unchanged layouts are not republished on every merge. */
  var publishedSignature = ''

  /** Record workspace membership so merged rows can carry their workspace name. */
  function learnWorkspaces(side) {
    if (side === undefined || Array.isArray(side.items) !== true) return
    var spaces = []
    for (var index = 0; index < side.items.length; index += 1) {
      var item = side.items[index]
      if (item === null || typeof item !== 'object' || Array.isArray(item.sessionIds) !== true) continue
      var title = typeof item.title === 'string' && item.title.length > 0 ? item.title : 'workspace'
      var ids = []
      for (var inner = 0; inner < item.sessionIds.length; inner += 1) {
        var id = item.sessionIds[inner]
        sessionWorkspace.set(id, title)
        ids.push(id)
      }
      // Keep the raw remote workspace id so workspace-level calls (rename/delete) can address
      // it; merged rows carry a drh: prefix that those RPCs do not accept.
      var rawWorkspaceId = String(item.workspaceId === undefined || item.workspaceId === null ? '' : item.workspaceId).replace(/^drh:/, '')
      spaces.push({ title: title, id: rawWorkspaceId, ids: ids })
    }
    if (spaces.length > 0) remoteSpaces = spaces
    publishRemoteState()
  }

  /** Prefix a remote row's title with its Workspace so one group stays readable. */
  function labelRemoteItem(item) {
    if (item === null || typeof item !== 'object') return item
    var workspace = sessionWorkspace.get(item.sessionId)
    if (workspace === undefined) return item
    var projections = item.projections
    var values = projections === null || typeof projections !== 'object' ? undefined : projections.values
    var title = values === null || typeof values !== 'object' ? undefined : values.title
    if (typeof title !== 'string' || title.length === 0) return item
    var prefix = workspace + ' · '
    if (title.indexOf(prefix) === 0) return item
    var copy = {}
    for (var key in item) { if (Object.prototype.hasOwnProperty.call(item, key)) copy[key] = item[key] }
    var nextProjections = {}
    for (var pkey in projections) { if (Object.prototype.hasOwnProperty.call(projections, pkey)) nextProjections[pkey] = projections[pkey] }
    var nextValues = {}
    for (var vkey in values) { if (Object.prototype.hasOwnProperty.call(values, vkey)) nextValues[vkey] = values[vkey] }
    nextValues.title = prefix + title
    nextProjections.values = nextValues
    copy.projections = nextProjections
    return copy
  }
  var EVENTS_ENDPOINT = '$events'
  var EVENT_RESULT_ENDPOINT = '$events/result'
  /**
   * Event names the LOCAL host has raised. A remote host raises its own
   * account/watch, settings and similar waterfalls, and forwarding those to one
   * client means the last answer wins — which is how the remote's (signed-out)
   * account could replace the local one. Local names are authoritative.
   */
  var localEventNames = new Set()
  /** The remote peer's client id from its (suppressed) ready frame. */
  var remoteEventClientId
  /** Event ids produced by the remote Host, so answers route back there. */
  var remoteEventIds = []
  var remoteEventIdSet = new Set()

  function rememberRemoteEvent(eventId) {
    if (typeof eventId !== 'string' || remoteEventIdSet.has(eventId)) return
    remoteEventIdSet.add(eventId)
    remoteEventIds.push(eventId)
    if (remoteEventIds.length > 512) {
      var oldest = remoteEventIds.shift()
      remoteEventIdSet.delete(oldest)
    }
  }

  function forgetRemoteEvent(eventId) {
    if (typeof eventId !== 'string' || remoteEventIdSet.has(eventId) === false) return
    remoteEventIdSet.delete(eventId)
    var at = remoteEventIds.indexOf(eventId)
    if (at !== -1) remoteEventIds.splice(at, 1)
  }

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

  /** Synthetic claim Workspace: published only in the merged client view, owned by no host. */
  var CLAIM_WORKSPACE_ID = REMOTE_WORKSPACE_PREFIX + 'claim'

  /** The create request inside a client-request payload, when it is a create. */
  function createRequest(payload) {
    var args = payload !== null && typeof payload === 'object' ? payload.args : undefined
    var request = args !== null && typeof args === 'object' ? args.request : undefined
    return request !== null && typeof request === 'object' ? request : undefined
  }

  /**
   * Which Host owns a session/create.
   *
   * A create is workspace-scoped, so it must be decided by its workspaceId. Deciding it
   * from "does the payload mention a remote id" routed a boot-time restore create to the
   * mount whenever the payload carried the remote Session id it was restoring, or the
   * synthetic claim workspace, and the mount answered workspace/not-found on every start.
   * Only a workspace the remote host actually owns belongs to the mount.
   * @returns 'remote' or 'local'.
   */
  function createTarget(payload) {
    var request = createRequest(payload)
    var workspaceId = request === undefined ? undefined : request.workspaceId
    if (typeof workspaceId !== 'string') return 'local'
    if (workspaceId.indexOf(REMOTE_WORKSPACE_PREFIX) !== 0) return 'local'
    var raw = workspaceId.slice(REMOTE_WORKSPACE_PREFIX.length)
    return remoteWorkspaceIds.has(raw) ? 'remote' : 'local'
  }

  /**
   * Copy a create payload without its workspaceId.
   *
   * The rpc carrier hands the payload object directly, so the claim rewrite has to build a
   * new object instead of editing a JSON body (dropWorkspaceId does that for the fetch
   * carrier). Only the request/args/payload objects are copied; the caller's payload is
   * never mutated, because a carrier may reuse it.
   * @returns the rewritten payload, or undefined when this is not a claim create.
   */
  function withoutWorkspaceId(payload) {
    var request = createRequest(payload)
    if (request === undefined || request.workspaceId !== CLAIM_WORKSPACE_ID) return undefined
    var nextRequest = {}
    for (var key in request) { if (Object.prototype.hasOwnProperty.call(request, key) && key !== 'workspaceId') nextRequest[key] = request[key] }
    var args = payload.args
    var nextArgs = {}
    for (var argKey in args) { if (Object.prototype.hasOwnProperty.call(args, argKey)) nextArgs[argKey] = args[argKey] }
    nextArgs.request = nextRequest
    var nextPayload = {}
    for (var field in payload) { if (Object.prototype.hasOwnProperty.call(payload, field)) nextPayload[field] = payload[field] }
    nextPayload.args = nextArgs
    return nextPayload
  }

  /** Whether a create names the synthetic claim Workspace, which no Host can resolve. */
  function isClaimCreate(payload) {
    var request = createRequest(payload)
    return request !== undefined && request.workspaceId === CLAIM_WORKSPACE_ID
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

  /** Whether a remote Session was the page's focus recently enough to own the catalogue. */
  function remoteFocused() {
    return remoteFocusAt > 0 && Date.now() - remoteFocusAt < REMOTE_FOCUS_TTL_MS
  }

  /** Record that the page is looking at a remote Session. */
  function noteRemoteFocus(method) {
    var already = remoteFocused()
    remoteFocusAt = Date.now()
    if (already !== true) note('focus-remote', { method: method })
  }

  /** Drop the focus once the page moves to a Session this host owns. */
  function clearRemoteFocus(reason) {
    if (remoteFocusAt === 0) return
    remoteFocusAt = 0
    note('focus-clear', { reason: reason })
  }

  /** Whether a payload addresses a Session at all (its id cannot be classified without one). */
  function mentionsSessionId(value) {
    try {
      var text = JSON.stringify(value)
      return typeof text === 'string' && text.indexOf('"sessionId"') !== -1
    } catch (error) { return false }
  }

  /**
   * Whether the first remote session snapshot has settled (succeeded or failed).
   *
   * The client asks for the model catalogue before the mount's first session/list lands, so
   * a persisted remote Session cannot be recognised at that instant. Waiting for this signal
   * (bounded) turns "unknown, assume this host" into the correct owner without a re-fetch.
   */
  var remoteSnapshotSettled = false
  var remoteSnapshotWaiters = []

  /** Mark the first snapshot settled and release anyone waiting on it. */
  function markRemoteSnapshotSettled() {
    if (remoteSnapshotSettled === true) return
    remoteSnapshotSettled = true
    var waiters = remoteSnapshotWaiters
    remoteSnapshotWaiters = []
    for (var index = 0; index < waiters.length; index += 1) {
      try { waiters[index](true) } catch (error) { /* a waiter must never break the refresh */ }
    }
  }

  /**
   * @param budgetMs - how long the caller may block for the first snapshot.
   * @returns true when it settled, false on timeout or without a timer.
   */
  function remoteSnapshotSettledWithin(budgetMs) {
    if (remoteSnapshotSettled === true) return Promise.resolve(true)
    return new Promise(function (resolve) {
      var done = false
      var finish = function (value) { if (done === true) return; done = true; resolve(value) }
      remoteSnapshotWaiters.push(finish)
      try { globalThis.setTimeout(function () { finish(false) }, budgetMs) } catch (error) { finish(false) }
    })
  }

  /**
   * Whether the Session the client persisted as "current" belongs to the mounted host.
   *
   * The catalogue request happens before the client restores that Session, so at a cold
   * start the focus above is still empty. The persisted value is the only clue available
   * that early. It is written in two shapes by the shipping client (a JSON object
   * { sessionId } and a bare id string), so both are accepted; anything unreadable or
   * unknown is treated as local, which keeps a local Session's behaviour unchanged.
   * @returns true only when the persisted id is a Session this shim already knows is remote.
   */
  function persistedCurrentSessionId() {
    try {
      var storage = globalThis.localStorage
      if (storage === null || storage === undefined || typeof storage.getItem !== 'function') return ''
      var raw = storage.getItem('dsh.sessions.current')
      if (typeof raw !== 'string' || raw.length === 0) return ''
      if (raw.charAt(0) !== '{') return raw
      var parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' && typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
    } catch (error) {
      return ''
    }
  }

  /** Whether the persisted current Session is one this shim already knows is remote. */
  function persistedCurrentSessionIsRemote() {
    var sessionId = persistedCurrentSessionId()
    return sessionId.length > 0 && remoteSessions.has(sessionId) === true
  }

  /**
   * Which host owns the model catalogue for this page load.
   *
   * 1. remote focus: a request already named a remote Session, so the user is looking at one;
   * 2. cold start: the Session the client persisted as current is remote (see above);
   * 3. otherwise this host, so a local Session's catalogue is exactly what it was before.
   * @returns true when the mounted host should answer.
   */
  function catalogOwnedByMount() {
    if (remoteFocused() === true) return true
    return persistedCurrentSessionIsRemote() === true
  }

  /**
   * Projections a published summary may carry, bounded.
   *
   * The block state is the only source for a remote row (group: none keeps remote rows
   * out of the shipped list), and the client injects that summary into its catalog before
   * opening the Session. Without projections the injected row carries no modelSelection,
   * so the composer shows the model placeholder even though the remote Session has a saved
   * selection. The whole values block is passed through when it is small, otherwise the
   * payload keeps only what a row or the composer needs.
   */
  var PROJECTION_VALUES_MAX_BYTES = 8192

  /**
   * @param projections - the remote list row's projections block.
   * @returns the block to publish, or undefined when there is nothing safe to send.
   */
  function projectionsForPublish(projections) {
    if (projections === null || typeof projections !== 'object') return undefined
    var values = projections.values
    if (values === null || typeof values !== 'object') return undefined
    var kept = {}
    if (typeof projections.kind === 'string') kept.kind = projections.kind
    if (typeof projections.asOfSeq === 'number') kept.asOfSeq = projections.asOfSeq
    try {
      if (JSON.stringify(values).length <= PROJECTION_VALUES_MAX_BYTES) {
        kept.values = values
        return kept
      }
    } catch (error) { /* fall through to the trimmed copy */ }
    // Too large to publish whole: keep the fields a row and the composer read.
    var trimmed = {}
    if (values.modelSelection !== undefined) trimmed.modelSelection = values.modelSelection
    if (values.agentPreset !== undefined) trimmed.agentPreset = values.agentPreset
    if (values.title !== undefined) trimmed.title = values.title
    kept.values = trimmed
    return kept
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
      // A blank remote Session must stay blank after injection, or its main area is empty.
      if (raw.blank === true) entry.blank = true
      entry.running = raw.running === true
      if (typeof raw.parentSessionId === 'string' && raw.parentSessionId.length > 0) entry.parentSessionId = raw.parentSessionId
      if (typeof raw.formatStatus === 'string' && raw.formatStatus.length > 0) entry.formatStatus = raw.formatStatus
      if (typeof raw.asOfSeq === 'number') entry.asOfSeq = raw.asOfSeq
      // Carry the saved model selection (and the rest of the bounded values) through to the
      // catalog row the client injects, so the composer can resolve the remote Session's
      // model instead of falling back to the placeholder.
      var publishable = projectionsForPublish(raw.projections)
      if (publishable !== undefined) entry.projections = publishable
      published.push(entry)
    }
    globalThis.__DSH_REMOTE_HOST_SESSIONS__ = published
    announce('sessions', { count: published.length })
    return published
  }

  /** Upper bound for any request to the mounted host, so a dead remote cannot block the UI. */
  var MOUNT_TIMEOUT_MS = 2500

  async function mergeSessionList(input, init, request) {
    // Safe mode: this page is in a boot loop, so answer locally and skip the mount.
    if (SAFE_MODE === true) return localFetch(input, init)
    // The mount leg must be bounded: an unreachable remote would otherwise leave this
    // promise pending forever, so the client's session/list never resolves and the whole
    // UI freezes (which then ends in a renderer crash). Fall back to the local answer.
    var mountInit = init
    try {
      var mountSignal = typeof AbortSignal === 'object' && AbortSignal !== null && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(MOUNT_TIMEOUT_MS)
        : undefined
      if (mountSignal !== undefined) {
        mountInit = {}
        for (var mountKey in init) { if (Object.prototype.hasOwnProperty.call(init, mountKey)) mountInit[mountKey] = init[mountKey] }
        mountInit.signal = mountSignal
      }
    } catch (error) { mountInit = init }
    var responses = await Promise.all([
      localFetch(input, init),
      localFetch(mountUrl(input), mountInit).catch(function () { return undefined }),
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

/**
 * MODULE: 20-transport.js
 * Request classification: which calls belong to the remote host, how the mount and
 * mux socket URLs are derived, and the error-envelope helper.
 */
  /** Rewrite a remote waterfall answer so the remote peer accepts it. */
  function rewriteEventResult(init) {
    try {
      var request = JSON.parse(init.body)
      var args = request.payload && request.payload.args
      if (args === null || typeof args !== 'object' || remoteEventIdSet.has(args.eventId) === false) return undefined
      if (typeof remoteEventClientId !== 'string') return undefined
      args.clientId = remoteEventClientId
      request.payload.args = args
      forgetRemoteEvent(args.eventId)
      var forwarded = {}
      for (var key in init) { if (Object.prototype.hasOwnProperty.call(init, key)) forwarded[key] = init[key] }
      forwarded.body = JSON.stringify(request)
      return forwarded
    } catch (error) {
      return undefined
    }
  }

  /**
   * Rebuild a session/create init without its workspaceId.
   *
   * Only used for the synthetic claim Workspace: the create it carries can only be
   * answered by a Host, and no Host owns that id, so the id is dropped and the local Host
   * supplies a plain Session. Anything unexpected leaves the request untouched.
   */
  function dropWorkspaceId(init) {
    try {
      if (init === undefined || init === null || typeof init.body !== 'string') return undefined
      var parsed = JSON.parse(init.body)
      var request = createRequest(parsed.payload)
      if (request === undefined || request.workspaceId !== CLAIM_WORKSPACE_ID) return undefined
      var copy = {}
      for (var key in request) { if (Object.prototype.hasOwnProperty.call(request, key) && key !== 'workspaceId') copy[key] = request[key] }
      parsed.payload.args.request = copy
      var forwarded = {}
      for (var field in init) { if (Object.prototype.hasOwnProperty.call(init, field)) forwarded[field] = init[field] }
      forwarded.body = JSON.stringify(parsed)
      return forwarded
    } catch (error) {
      return undefined
    }
  }

  /**
   * Router scope audit (2026-11-23).
   *
   * refersRemote() decides by "does the payload text contain a known remote id", which is
   * only correct when that id is the call's SUBJECT. The cases below are the ones whose
   * scope is an explicit field, so a substring hit is an accident rather than an identity:
   *
   *   session/create        workspace-scoped  -> now decided by createTarget() (fixed here)
   *   workspace/{rename,delete,insertBefore,insertSessionBefore}
   *                         workspace-scoped  -> still substring. Works today only because a
   *                         remote workspace is published as drh:<raw> and <raw> is in
   *                         remoteWorkspaceIds, so the text contains the raw id; a local
   *                         workspace id cannot contain it. Same shape of fragility as the
   *                         create bug: prefer workspaceId here next.
   *   directoryPicker/*     path-scoped       -> no ids in the payload, never routed.
   *   session/{follow,events,state,page,projections,prompt,cancel,rename,fork,updateQueue,
   *   wait,attachment,selectModel}
   *                         session-scoped    -> correct by substring: the id named IS the
   *                         subject, including the address.sessionId form.
   *   session/list, $events, $events/result
   *                         special-cased     -> merge / forwarded-event rewrite, not this rule.
   *   settings/*, pluginManager/*, pluginInventory/*, agentPresets/list,
   *   permissionPresets/catalog, skills/list, schedule/*, speech/*, messageFeedback/*,
   *   workspaceFiles/*
   *                         host-global       -> no session/workspace subject, so they can
   *                         only be misrouted by an id appearing inside a path or title.
   *                         Left as-is; a workspaceFiles path containing a session id is the
   *                         realistic case to tighten later.
   *
   * Only session/create is changed in this commit; the rest is registered so the next pass
   * can move them to explicit-field decisions without rediscovering the list.
   */

  /**
   * Whether this call is rerouted away from the local Host. Only a reroute may
   * fall back to a second, local attempt: a pass-through request that fails has
   * already reached the Host once, and retrying it would duplicate POSTs.
   */
  function wouldRoute(input, init) {
    try {
      var request = requestOf(init)
      if (request === undefined) return false
      if (request.method === 'session/list') return true
      if (request.method === EVENT_RESULT_ENDPOINT) return true
      // A create is workspace-scoped: never let a mention of a remote Session id in the
      // payload send it to the mount (that is what made boot restore fail every start).
      // The claim Workspace still needs the rewrite below, so it is handled here too
      // rather than being passed straight to the local Host.
      if (request.method === 'session/create') {
        return createTarget(request.payload) === 'remote' || isClaimCreate(request.payload) === true
      }
      // The catalogue carries no Session id, but it does need an owner; routeFetch decides
      // that from the focus/persistence clues, so this request must be handled there.
      if (request.method === 'session/modelCatalog') return true
      return refersRemote(request.payload) === true
    } catch (error) { return false }
  }

  /**
   * Follow which host owns the Session the page is looking at. Opening a Session reads it
   * (and follows its stream) with its id in the payload, so ordinary traffic carries the
   * answer; a Session id this host does not own hands the focus back, which is why local
   * pass-throughs must be observed too.
   * @param request - parsed client request, when the body was a JSON envelope.
   */
  function trackSessionFocus(request) {
    if (request === undefined) return
    if (refersRemote(request.payload)) noteRemoteFocus(request.method)
    else if (mentionsSessionId(request.payload)) clearRemoteFocus('local-session')
  }

  /**
   * Bound for the mount catalogue read. The client awaits it while booting, so a mount that
   * stopped answering must not hold the promise open.
   */
  var CATALOG_READ_TIMEOUT_MS = 2500

  /** Compose the caller's signal with the catalogue bound, when the runtime has both. */
  function catalogSignal(signal) {
    try {
      if (typeof AbortSignal !== 'object' || AbortSignal === null) return signal
      if (typeof AbortSignal.timeout !== 'function') return signal
      var bound = AbortSignal.timeout(CATALOG_READ_TIMEOUT_MS)
      if (signal === undefined || signal === null) return bound
      return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, bound]) : signal
    } catch (error) { return signal }
  }

  /**
   * Answer session/modelCatalog from the host that owns the Session being viewed.
   *
   * The catalogue is NOT merged: the two hosts may serve different model lists, and a union
   * would offer a local Session a remote-only model (and the reverse), which fails the moment
   * it is selected. The owner is decided by catalogOwnedByMount(); when the answer must come
   * from the mount, the read is bounded and degrades to this host.
   */
  async function routeModelCatalog(input, init, request) {
    // The Host-level warm-up names NO Session. A Host patched to take an optional sessionId
    // advertises a ONE-parameter descriptor, and the gateway client's arity check counts
    // descriptor.parameters instead of honouring acceptsUndefined, so routing that
    // zero-argument read to such a Host throws "expected 1 argument(s), got 0" inside the
    // client - a rejection no caller handles. Keep the warm-up on this host: its descriptor
    // takes no argument, which is what the warm-up calls with.
    var args = request !== undefined && request !== null && request.payload !== undefined && request.payload !== null
      ? request.payload.args : undefined
    var sessionId = args !== undefined && args !== null && typeof args.sessionId === 'string' ? args.sessionId : ''
    if (sessionId.length === 0) {
      note('catalog-prewarm-local', {})
      return localFetch(input, init)
    }
    // Nothing below may throw: this runs inside the fetch wrapper, where a synchronous throw
    // would surface as an unhandled rejection instead of a failed request.
    var remote = false
    try {
      remote = catalogOwnedByMount()
      if (remote !== true && remoteFocused() !== true && persistedCurrentSessionId().length > 0) {
        // Cold start: the client asks for the catalogue before the mount's first snapshot has
        // landed, so the persisted Session cannot be classified yet. Waiting for that snapshot
        // (bounded, and it is already in flight) makes the decision correct instead of falling
        // back to this host and leaving a remote Session without its model.
        var settled = await remoteSnapshotSettledWithin(CATALOG_READ_TIMEOUT_MS)
        remote = catalogOwnedByMount()
        note('catalog-waited-snapshot', { settled: settled, remote: remote })
      }
      note('catalog-owner', { remote: remote, focus: remoteFocused(), persisted: persistedCurrentSessionIsRemote() })
    } catch (error) {
      note('catalog-owner-failed', { reason: String(error).slice(0, 80) })
      return localFetch(input, init)
    }
    if (remote !== true) return localFetch(input, init)
    var bounded = {}
    if (init !== undefined && init !== null) {
      for (var key in init) { if (Object.prototype.hasOwnProperty.call(init, key)) bounded[key] = init[key] }
    }
    bounded.signal = catalogSignal(init === undefined || init === null ? undefined : init.signal)
    return localFetch(mountUrl(input), bounded).then(function (response) {
      // A dead mount can answer with an error status instead of rejecting, so both shapes
      // must degrade; only a successful answer is usable.
      if (response !== null && response !== undefined && response.ok === true) return response
      note('route-local-fallback', {
        method: 'session/modelCatalog',
        reason: 'mount status ' + String(response === null || response === undefined ? 'none' : response.status),
      })
      return localFetch(input, init)
    }).catch(function (error) {
      note('route-local-fallback', {
        method: 'session/modelCatalog',
        reason: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error).slice(0, 80),
      })
      return localFetch(input, init)
    })
  }

  /** Method names already reported, so diagnostics stay one line per endpoint. */
  var seenMethods = new Set()

  async function routeFetch(input, init) {
    var request = requestOf(init)
    var method = request === undefined ? undefined : request.method
    if (method !== undefined) {
      // Record every distinct method once: enough to see what the UI calls and where
      // it was routed, without flooding the report with repeated calls.
      if (seenMethods.has(method) !== true) {
        seenMethods.add(method)
        note('fetch-rpc', { method: method, remote: request !== undefined && refersRemote(request.payload) === true })
      }
    }
    trackSessionFocus(request)
    if (method === 'session/list') return mergeSessionList(input, init, request)
    if (method === 'session/modelCatalog') return routeModelCatalog(input, init, request)
    if (method === EVENT_RESULT_ENDPOINT) {
      var rewritten = rewriteEventResult(init)
      if (rewritten !== undefined) return localFetch(mountUrl(input), rewritten)
      return localFetch(input, init)
    }
    if (method === 'session/create') {
      if (createTarget(request.payload) === 'remote') {
        note('route-remote', { method: method })
        return localFetch(mountUrl(input), init)
      }
      // The claim Workspace exists only in the merged client view, so neither Host can
      // resolve it. Restore asks for a Session there on the first load after such a
      // selection; drop the workspace and let the local Host answer, instead of failing
      // the whole restoration with workspace/not-found.
      var claimless = isClaimCreate(request.payload) === true ? dropWorkspaceId(init) : undefined
      if (claimless !== undefined) note('claim-create-local', { method: method })
      return localFetch(input, claimless === undefined ? init : claimless)
    }
    // The payload names one of the mounted host's Sessions.
    var remote = request !== undefined && refersRemote(request.payload)
    if (remote) {
      note('route-remote', { method: method })
      return localFetch(mountUrl(input), init)
    }
    return localFetch(input, init)
  }

  /** Resolve the same channel beneath the mount, preserving scheme and query. */
  function mountSocketUrl(url) {
    try {
      var parsed = new URL(url, typeof location === 'object' ? location.href : undefined)
      parsed.pathname = MOUNT + parsed.pathname
      return parsed.toString()
    } catch (error) {
      return undefined
    }
  }

  function openSocket(url) {
    var factory = previous.createWebSocket
    if (typeof factory === 'function') return factory(url)
    return new NativeWebSocket(url)
  }

  /** Exact mux pathname matching: a substring test would catch lookalikes. */
  function isMuxUrl(url) {
    if (typeof url !== 'string') return false
    try {
      var parsed = new URL(url, typeof location === 'object' ? location.href : undefined)
      return parsed.pathname === '/api/remote.mux' || parsed.pathname.slice(-15) === '/api/remote.mux'
    } catch (error) {
      return url.length >= 15 && url.slice(-15) === '/api/remote.mux'
    }
  }
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

/**
 * MODULE: 40-workspace.js
 * Workspace stream merging: fold the remote workspaces into one group (or keep
 * theirs), prune stale ones, and label rows with their workspace name.
 */
  /** Workspace streams are merged: one baseline carrying both hosts' records. */
  var MERGED_ENDPOINTS = { 'workspace/follow': true }

  function emptySide() {
    return { items: [], archivedSessionIds: [], pinnedSessionIds: [], seen: false, settled: false }
  }

  function applyIncrement(side, frame) {
    if (frame === null || typeof frame !== 'object') return
    if (frame.type === 'baseline' || frame.type === 'replace') {
      var value = frame.value
      if (value === null || typeof value !== 'object') return
      side.items = Array.isArray(value.items) ? value.items.slice() : []
      side.archivedSessionIds = Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds.slice() : []
      side.pinnedSessionIds = Array.isArray(value.pinnedSessionIds) ? value.pinnedSessionIds.slice() : []
      side.seen = true
      return
    }
    if (frame.type === 'upsert' && frame.workspace && typeof frame.workspace.workspaceId === 'string') {
      var kept = side.items.filter(function (entry) { return entry.workspaceId !== frame.workspace.workspaceId })
      kept.push(frame.workspace)
      side.items = kept
      return
    }
    if (frame.type === 'remove') {
      side.items = side.items.filter(function (entry) { return entry.workspaceId !== frame.workspaceId })
      return
    }
    if (frame.type === 'order' && Array.isArray(frame.workspaceIds)) {
      var ranked = []
      var byId = {}
      side.items.forEach(function (entry) { byId[entry.workspaceId] = entry })
      frame.workspaceIds.forEach(function (id) { if (byId[id] !== undefined) ranked.push(byId[id]) })
      side.items.forEach(function (entry) { if (frame.workspaceIds.indexOf(entry.workspaceId) === -1) ranked.push(entry) })
      side.items = ranked
      return
    }
    if (frame.type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
      side.archivedSessionIds = frame.archivedSessionIds.slice()
      return
    }
    if (frame.type === 'pinned' && Array.isArray(frame.pinnedSessionIds)) {
      side.pinnedSessionIds = frame.pinnedSessionIds.slice()
    }
  }

  /** Fold every remote Workspace into one group so the sidebar stays readable. */
  function collapseRemoteSide(side) {
    var sessionIds = []
    var seen = new Set()
    var createdAt
    // Every visible remote Session belongs in this group, including the ones no
    // remote Workspace record claims any more; otherwise they would leak into the
    // client's ungrouped bucket.
    remoteSessions.forEach(function (id) {
      if (seen.has(id)) return
      seen.add(id)
      sessionIds.push(id)
    })
    for (var index = 0; index < side.items.length; index += 1) {
      var item = side.items[index]
      if (item === null || typeof item !== 'object') continue
      if (createdAt === undefined && typeof item.createdAt === 'string') createdAt = item.createdAt
      if (Array.isArray(item.sessionIds) === false) continue
      for (var inner = 0; inner < item.sessionIds.length; inner += 1) {
        var claimed = item.sessionIds[inner]
        if (remoteSessions.has(claimed) !== true || seen.has(claimed)) continue
        seen.add(claimed)
        sessionIds.push(claimed)
      }
    }
    if (sessionIds.length === 0) {
      return { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
    }
    // Keep one workspace's rows together inside the single group.
    sessionIds.sort(function (left, right) {
      var a = sessionWorkspace.get(left) ?? ''
      var b = sessionWorkspace.get(right) ?? ''
      return a < b ? -1 : a > b ? 1 : 0
    })
    return {
      items: [{
        workspaceId: GROUP_ID,
        path: GROUP_PATH,
        title: GROUP_LABEL,
        sessionIds: sessionIds,
        createdAt: createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      archivedSessionIds: side.archivedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
      pinnedSessionIds: side.pinnedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
    }
  }

  /** Keep only remote Workspaces that own a visible remote Session. */
  function pruneRemoteSide(side) {
    var items = []
    for (var index = 0; index < side.items.length; index += 1) {
      var item = side.items[index]
      if (item === null || typeof item !== 'object') continue
      var ids = Array.isArray(item.sessionIds)
        ? item.sessionIds.filter(function (id) { return remoteSessions.has(id) })
        : []
      if (ids.length === 0) continue
      if (typeof item.workspaceId === 'string') remoteWorkspaceIds.add(item.workspaceId)
      var copy = {}
      for (var key in item) { if (Object.prototype.hasOwnProperty.call(item, key)) copy[key] = item[key] }
      // Stable marker on the merged row: the shipped renderer keys rows by workspaceId, so
      // this prefix is what lets a stylesheet treat these rows as the remote section.
      // Session ids are untouched, so expanding a group and opening a session still work.
      if (typeof item.workspaceId === 'string') copy.workspaceId = REMOTE_WORKSPACE_PREFIX + item.workspaceId
      copy.sessionIds = ids
      items.push(copy)
    }
    return {
      items: items,
      archivedSessionIds: side.archivedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
      pinnedSessionIds: side.pinnedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
    }
  }

  /** Remote pin/archive state, republished so a plugin-rendered block can show it. */
  function publishRemoteMarks(marks) {
    try {
      globalThis.__DSH_REMOTE_HOST_MARKS__ = {
        pinned: marks.pinnedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
        archived: marks.archivedSessionIds.filter(function (id) { return remoteSessions.has(id) }),
      }
      announce('marks', { pinned: globalThis.__DSH_REMOTE_HOST_MARKS__.pinned.length })
    } catch (error) { /* publishing is best effort */ }
  }

  /**
   * Hidden claiming Workspace for the modes that fold no remote record into the shipped tree.
   *
   * The client catalog is fed by session/list, so a remote id has to be listed for
   * sessions.retain to accept it. One synthetic Workspace claims every visible remote
   * Session so the shipped tree can never place them in its Ungrouped bucket; the block
   * stylesheet hides its row, so the user sees no extra group.
   */
  function claimRemoteSide() {
    var ids = []
    remoteSessions.forEach(function (id) { ids.push(id) })
    if (ids.length === 0) return { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
    var now = new Date().toISOString()
    return {
      items: [{
        workspaceId: REMOTE_WORKSPACE_PREFIX + 'claim',
        path: GROUP_PATH,
        title: GROUP_LABEL,
        sessionIds: ids,
        createdAt: now,
        updatedAt: now,
      }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    }
  }

  function mergeBaseline(local, remote) {
    publishRemoteMarks(remote)
    var kept = GROUP_MODE === 'none'
      ? claimRemoteSide()
      : (GROUP_MODE === 'single' ? collapseRemoteSide(remote) : pruneRemoteSide(remote))
    return {
      items: local.items.concat(kept.items),
      archivedSessionIds: local.archivedSessionIds.concat(kept.archivedSessionIds),
      pinnedSessionIds: local.pinnedSessionIds.concat(kept.pinnedSessionIds),
    }
  }

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
  var remoteSessionsDigest = null

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
        var result = envelope === null || typeof envelope !== 'object' ? undefined : envelope.result
        var value = result === null || typeof result !== 'object' || result.ok !== true ? undefined : result.value
        var items = value === undefined || value === null ? undefined : value.items
        if (Array.isArray(items) !== true) return
        for (var index = 0; index < items.length; index += 1) {
          if (isActiveRemote(items[index]) === true) remoteSessions.add(items[index].sessionId)
        }
        // Announce only when the snapshot really moved, so the block is not asked to
        // repaint every tick; the digest covers what a row shows.
        var digest = items.map(function (item) {
          return String(item === null || item === undefined ? "" : item.sessionId) + ":"
            + String(item === null || item === undefined ? "" : item.updatedAt) + ":"
            + (item !== null && item !== undefined && item.running === true ? "1" : "0")
        }).join(",")
        if (digest !== remoteSessionsDigest) {
          remoteSessionsDigest = digest
          publishRemoteSessions(items)
          publishRemoteState()
          refreshGroups()
        }
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
    /** First moment the remote leg became unusable in the current outage; 0 while healthy. */
    var remoteUnavailableSince = 0
    /** True once the mux was handed back to the shipped client for this outage. */
    var degraded = false
    /** Timer for the per-attempt open watchdog. */
    var attemptTimer
    /** Suppress reconnect attempts once the browser is closing this socket. */
    var shuttingDown = false
    /** Consecutive failed reconnects, for backoff and the error status. */
    var reconnectAttempts = 0
    /** The one pending reconnect timer, so overlapping handlers cannot stack loops. */
    var reconnectTimer
    /** True while a reconnect is scheduled or being attempted. */
    var reconnectPending = false
    /** Synchronous re-entry depth of reconnectRemote (should stay 1). */
    var reconnectDepth = 0
    var merges = new Map()
    var counter = 0
    /** Frames seen per upstream leg, for the diagnostics report. */
    var relays = {}

    /** First reconnect delay and its ceiling; see reconnectBackoff. */
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

    function connect(kind) {
      var existing = upstreams.get(kind)
      if (existing !== undefined) {
        // Only a socket that is still connecting or open may be reused. A CLOSING/CLOSED one
        // would take the recovery listeners and never fire them, which is how a short flap left
        // the page half-recovered until it trapped (see docs/crash-path-b.md).
        if (existing.readyState === 0 || existing.readyState === 1) return existing
        upstreams.delete(kind)
        traceEvent('leg-dropped-stale', { kind: kind, readyState: existing.readyState })
      }
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
        if (kind !== 'remote') { publishStatus(kind, 'open'); return }
        traceEvent('status-open-enter', {})
        // Publishing the status reaches the shipped client synchronously; defer it so the open
        // dispatch finishes before anything re-subscribes.
        var publish = function () {
          publishStatus(kind, 'open')
          traceEvent('status-open-exit', {})
        }
        if (typeof setTimeout === 'function') setTimeout(publish, 0)
        else publish()
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
        if (kind === 'remote') noteRemoteUnavailable('error')
      })
      on('close', function (event) {
        note('leg-closed', { kind: kind, code: (event && event.code) || 0 })
        if (kind !== 'local') publishStatus(kind, 'error')
        if (kind === 'remote') noteRemoteUnavailable('close')
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
      var sent = 0
      traceEvent('replay-enter', { total: remoteStreams.size, depth: reconnectDepth })
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
          sent += 1
          if (sent <= 8) traceEvent('replay-send', { i: sent, endpoint: entry.endpoint })
        } catch (error) { /* the next attempt retries */ }
      })
      note('replay-remote', { streams: remoteStreams.size })
      traceEvent('replay-end', { streams: sent, total: remoteStreams.size, depth: reconnectDepth })
    }

    /**
     * Delay before reconnect attempt N: 200, 400, 800, ... capped at 10 s, so a
     * long outage costs at most one attempt per cap window instead of a spin.
     */
    function reconnectBackoff(attempt) {
      var step = attempt < 1 ? 1 : attempt
      var delay = RECONNECT_BASE_MS * Math.pow(2, step - 1)
      return delay > RECONNECT_CAP_MS ? RECONNECT_CAP_MS : delay
    }

    /**
     * Reopen the remote leg after it dropped (1006), then replay its streams.
     * Single flight: the close and error handlers both land here, and a socket that
     * cannot even be constructed must wait for the next backoff step rather than
     * re-entering this function — that recursion is what wedged the renderer.
     */
    /**
     * Record that the remote leg is unusable right now, and hand the mux back once the outage
     * outlives DEGRADE_AFTER_MS.
     *
     * The trigger is event driven on purpose: on the flap that kills the renderer, connect()
     * returns a socket that fails asynchronously, so counting synchronous throws never fires.
     */
    function noteRemoteUnavailable(reason) {
      if (degraded === true) return
      var now = Date.now()
      if (remoteUnavailableSince === 0) remoteUnavailableSince = now
      var unavailableMs = now - remoteUnavailableSince
      traceEvent('remote-unavailable', { reason: reason, ms: unavailableMs })
      if (unavailableMs > DEGRADE_AFTER_MS) degrade()
    }

    /** The remote leg opened: the outage is over, so the clock resets. */
    function noteRemoteAvailable() {
      if (remoteUnavailableSince !== 0) traceEvent('remote-available', { afterMs: Date.now() - remoteUnavailableSince })
      remoteUnavailableSince = 0
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
    function degrade() {
      if (degraded === true) return
      degraded = true
      reconnectPending = false
      if (reconnectTimer !== undefined) {
        try { clearTimeout(reconnectTimer) } catch (error) { /* already gone */ }
        reconnectTimer = undefined
      }
      if (attemptTimer !== undefined) {
        try { clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
        attemptTimer = undefined
      }
      traceEvent('degrade-handoff', { unavailableMs: Date.now() - remoteUnavailableSince })
      note('degrade: handing the mux back after ' + String(Date.now() - remoteUnavailableSince) + ' ms unavailable')
      publishStatus('remote', 'error')
      try { client.close() } catch (error) { /* the page reconnects on its own */ }
    }

    function reconnectRemote() {
      traceEvent('reconnect-enter', { degraded: degraded === true, pending: reconnectPending === true })
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
      upstreams.delete('remote')
      var attempt = function () {
        reconnectTimer = undefined
        traceEvent('attempt-run', { attempt: reconnectAttempts, degraded: degraded === true })
        if (shuttingDown === true) { reconnectPending = false; return }
        var socket
        try { socket = connect('remote') } catch (error) { socket = undefined }
        reconnectPending = false
        // A socket that is not connecting/open cannot recover: treat it as a failure instead of
        // attaching an open listener that can never fire.
        if (socket !== undefined && socket.readyState !== 0 && socket.readyState !== 1) {
          traceEvent('stale-socket', { readyState: socket.readyState })
          socket = undefined
        }
        if (socket === undefined) {
          // No carrier: yield, then schedule the next step through the timer.
          reconnectDepth += 1
          traceEvent('reconnect-nocarrier', { attempt: reconnectAttempts, depth: reconnectDepth })
          reconnectDepth -= 1
          reconnectRemote()
          return
        }
        if (attemptTimer !== undefined) {
          try { clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
        }
        if (typeof setTimeout === 'function') {
          attemptTimer = setTimeout(function () {
            attemptTimer = undefined
            if (socket !== undefined && socket.readyState === 1) return
            noteRemoteUnavailable('attempt-timeout')
          }, ATTEMPT_TIMEOUT_MS)
        }
        var onOpen = function () {
          reconnectAttempts = 0
          if (attemptTimer !== undefined) {
            try { clearTimeout(attemptTimer) } catch (error) { /* already gone */ }
            attemptTimer = undefined
          }
          traceEvent('remote-open', { streams: remoteStreams.size })
          // Do the recovery work OUTSIDE the socket's 'open' dispatch. Breadcrumbs show the page
          // freezing between the leg-open status publish and this handler, i.e. inside the
          // synchronous event dispatch: deferring it breaks that chain, so a listener that
          // re-subscribes cannot recurse into the reopened leg on the same stack.
          var resume = function () {
            noteRemoteAvailable()
            traceEvent('open-handled', { streams: remoteStreams.size })
            replayRemoteStreams()
            traceEvent('replay-done', { streams: remoteStreams.size })
          }
          if (typeof setTimeout === 'function') setTimeout(resume, 0)
          else resume()
        }
        if (socket.readyState === 1) onOpen()
        else if (typeof socket.addEventListener === 'function') socket.addEventListener('open', onOpen)
      }
      if (typeof setTimeout === 'function') reconnectTimer = setTimeout(attempt, reconnectBackoff(reconnectAttempts))
      else attempt()
      } finally {
        reconnectDepth -= 1
        traceEvent('reconnect-end', { depth: reconnectDepth })
      }
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

/**
 * MODULE: 60-runtime.js
 * WebSocket factory, diagnostics sink, group refresh, and the prefetches that make
 * the routing table ready before the client asks.
 */
  /**
   * The carrier hands the factory an absolute mux URL; only that channel is
   * multiplexed, everything else keeps the original socket.
   */
  function routeCreateWebSocket(url) {
    var target = typeof url === 'string' ? url : String(url)
    note('ws-factory', { url: target.slice(0, 90), mux: isMuxUrl(target) === true })
    if (isMuxUrl(target) !== true) return openSocket(target)
    try {
      note('mux-router', { url: target })
      return createMuxRouter(target)
    } catch (error) {
      note('mux-router-failed', { error: String(error) })
      return openSocket(target)
    }
  }

  /** Diagnostics the Host can read back through the mount. */
  var diag = {
    installedAt: new Date().toISOString(),
    href: typeof location === 'object' ? location.href : null,
    origin: typeof location === 'object' ? location.origin : null,
    mount: MOUNT,
    previousKeys: Object.keys(previous),
    hasRpc: previous.rpc !== undefined && previous.rpc !== null && typeof previous.rpc === 'object',
    rpcKeys: previous.rpc === undefined || previous.rpc === null ? [] : Object.keys(previous.rpc),
    hasFetch: typeof previous.fetch === 'function',
    hasCreateWebSocket: typeof previous.createWebSocket === 'function',
    streamBaseUrl: typeof previous.streamBaseUrl === 'string' ? previous.streamBaseUrl : null,
    events: [],
  }

  /**
   * Optional extra sink for development, off unless `diagnosticsSink` names one.
   * Diagnostics already reach the Host through the mount report route.
   */
  var SINK = typeof config.diagnosticsSink === 'string' && config.diagnosticsSink.length > 0
    ? config.diagnosticsSink
    : undefined

  function post(url, body) {
    try {
      globalThis.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
      }).catch(function () {
        // A document that blocks fetch may still deliver a beacon.
        try {
          if (typeof navigator === 'object' && typeof navigator.sendBeacon === 'function') {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
          }
        } catch (error) { /* diagnostics are best effort */ }
      })
    } catch (error) { /* never break the page for a diagnostic */ }
  }

  /**
   * One send per second at most.
   *
   * The body is a whole snapshot, not an append-only log, so coalescing loses nothing
   * but intermediate states — while a page in trouble (which is exactly when note()
   * fires most often) otherwise posts continuously. Measured at 1.3 requests per
   * second against an unreachable mount before this ceiling.
   */
  var PUBLISH_MIN_INTERVAL_MS = 1000
  var publishLastAt = 0
  var publishPending = false
  var publishTimer

  function publish() {
    publishLastAt = Date.now()
    var body = JSON.stringify(diag)
    post(MOUNT + '/__dsh_remote_host__/report', body)
    if (SINK !== undefined) post(SINK, body)
  }

  /** Publish now, or once the window opens; the latest snapshot is what gets sent. */
  function publishSoon() {
    if (publishPending === true) return
    var wait = publishLastAt + PUBLISH_MIN_INTERVAL_MS - Date.now()
    if (wait <= 0) { publish(); return }
    publishPending = true
    publishTimer = globalThis.setTimeout(function () {
      publishPending = false
      publishTimer = undefined
      publish()
    }, wait)
  }

  function note(name, data) {
    diag.events.push({ name: name, at: Date.now(), data: data })
    if (diag.events.length > 40) diag.events.shift()
    publishSoon()
  }

  /** Refresh merged group frames when the remote session registry changed. */
  function refreshGroups() {
    try {
      if (activeRouter !== undefined && typeof activeRouter.__refreshGroups === 'function') activeRouter.__refreshGroups()
    } catch (error) { /* group refresh is best effort */ }
  }

  function nextRpcId() {
    try { return globalThis.crypto.randomUUID() } catch (error) {
      return 'rpc-' + String(Date.now()) + '-' + Math.random().toString(16).slice(2)
    }
  }

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
   *//**
 * MODULE: 80-install.js
 * Install: build the transport over the carrier, patch the global WebSocket, start
 * self-update and prefetch, and adopt a late-injected carrier.
 */
  /**
   * Reload the page once when the shim on disk changed, while the window is hidden.
   *
   * One guard matters, learned the hard way: the shell can serve the same cached
   * document again, so a reload may not pick up the new shim. If the page still
   * holds the old revision afterwards, stop trying — reloading forever is worse than
   * running one revision behind. Rewriting the URL to bust that cache crashed the
   * renderer, so this only ever calls `location.reload()`.
   */
  function installSelfUpdate() {
    try {
      var rev = typeof config.rev === 'string' ? config.rev : undefined
      if (rev === undefined || typeof document !== 'object' || typeof document.addEventListener !== 'function') return
      var KEY = 'drh:self-update'
      var read = function () {
        try {
          if (globalThis.sessionStorage === undefined || globalThis.sessionStorage === null) return undefined
          var raw = globalThis.sessionStorage.getItem(KEY)
          return raw === null ? undefined : JSON.parse(raw)
        } catch (error) { return undefined }
      }
      var write = function (value) {
        try {
          if (globalThis.sessionStorage !== undefined && globalThis.sessionStorage !== null) globalThis.sessionStorage.setItem(KEY, JSON.stringify(value))
        } catch (error) { /* storage may be unavailable */ }
      }
      var attempt = read()
      if (attempt !== undefined && typeof attempt.forRev === 'string' && attempt.forRev !== rev) {
        note('self-update-give-up', { loaded: rev, wanted: attempt.forRev })
        return
      }
      var reloading = false
      var check = function () {
        if (reloading || document.visibilityState !== 'hidden') return
        try {
          globalThis.fetch(MOUNT + '/__dsh_remote_host__/report').then(function (response) {
            return response.json()
          }).then(function (payload) {
            if (reloading || document.visibilityState !== 'hidden') return
            if (payload === null || typeof payload !== 'object') return
            var next = typeof payload.rev === 'string' ? payload.rev : undefined
            if (next === undefined || next === rev) return
            reloading = true
            note('self-update', { from: rev, to: next })
            write({ forRev: next, at: Date.now() })
            // Plain reload only. Navigating a dsh-app:// URL with an added query
            // crashed the renderer (EXC_BREAKPOINT in V8) — and the one-shot guard
            // below already prevents a reload loop, so no cache busting is needed.
            location.reload()
          }).catch(function () { /* offline: try next time */ })
        } catch (error) { /* ignore */ }
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') setTimeout(check, 500)
      })
      if (typeof setInterval === 'function') setInterval(check, 60000)
    } catch (error) { /* self update is best effort */ }
  }

  function install(base) {
    previous = base
    refreshDiag(base)
    var built = {}
    for (var key in base) { if (Object.prototype.hasOwnProperty.call(base, key)) built[key] = base[key] }
    built.fetch = function (input, init) {
      if (SUPERAGENT_REMOTE === true) {
        var superPath = pathOf(input)
        if (superPath !== undefined && (superPath === '/orchestrator' || superPath.indexOf('/orchestrator/') === 0)) {
          note('orchestrator-remote', { path: superPath.slice(0, 60) })
          return localFetch(mountUrl(input), init)
        }
      }
      if (ATTACH_REMOTE === true) {
        // Detect the call by path: the body may be a Request or a non-string body,
        // and parsing it wrongly silently fell back to the local host.
        var path = pathOf(input)
        if (path !== undefined && path.indexOf('/api/') !== -1) {
          return localFetch(mountUrl(input), init).then(function (response) {
            // An endpoint the remote does not serve belongs to the local shell.
            if (response.status !== 404) return response
            return localFetch(input, init)
          }).catch(function () { return localFetch(input, init) })
        }
        return localFetch(input, init)
      }
      // Local pass-throughs must be observed as well: opening a Session this host owns is
      // what hands the model catalogue back to it.
      trackSessionFocus(requestOf(init))
      if (wouldRoute(input, init) !== true) return localFetch(input, init)
      return routeFetch(input, init).catch(function () { return localFetch(input, init) })
    }
    if (STREAMS === true) {
      built.createWebSocket = routeCreateWebSocket
      // Catch-all: a carrier that resolves the mux URL itself (a streamBaseUrl
      // deployment) constructs WebSocket directly and never calls our factory.
      // Replacing the global constructor is the most invasive hook we install, so
      // it stays switchable: a carrier that already calls createWebSocket does not
      // need it, and a native consumer that inspects the constructor can trip on a
      // JS stand-in. `globalWebSocket: false` keeps the factory patch only.
      if (GLOBAL_WS === true) try {
        var RoutedWebSocket = function (url, protocols) {
          if (isMuxUrl(String(url))) {
            note('ws-patched-mux', { url: String(url) })
            try {
              return createMuxRouter(String(url))
            } catch (error) {
              note('ws-patched-failed', { error: String(error) })
            }
          }
          return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
        }
        RoutedWebSocket.prototype = NativeWebSocket.prototype
        RoutedWebSocket.CONNECTING = 0
        RoutedWebSocket.OPEN = 1
        RoutedWebSocket.CLOSING = 2
        RoutedWebSocket.CLOSED = 3
        globalThis.WebSocket = RoutedWebSocket
        note('ws-patched', { active: true })
      } catch (error) {
        note('ws-patch-failed', { error: String(error) })
      }
    }
    // The desktop shell may hand the page a fully decoded carrier (`rpc`)
    // instead of `fetch`; that carrier wins over every other field, so routing
    // has to wrap it too or nothing below would ever run.
    if (diag.hasRpc === true && typeof base.rpc.call === 'function') {
      var baseRpc = base.rpc
      /**
       * A mount failure as a carrier result. Every branch below returns this instead of
       * letting the promise reject: the shipped Client treats a rejection as a crashing
       * service call, and a corp-network blip reaches this path on every remote call.
       */
      var carrierUnavailable = function (endpoint, error) {
        note('carrier-failed', { method: endpoint, error: String(error).slice(0, 80) })
        return {
          ok: false,
          error: {
            code: 'gateway/carrier-unavailable',
            message: 'drh: the local carrier failed for ' + endpoint,
            details: {},
          },
        }
      }
      var remoteUnavailable = function (endpoint, error) {
        note('route-remote-failed', { method: endpoint, error: String(error).slice(0, 80) })
        return {
          ok: false,
          error: {
            code: 'gateway/remote-unavailable',
            message: 'drh: the mounted host is unreachable for ' + endpoint,
            details: {},
          },
        }
      }
      built.rpc = {
        call: function (channel, endpoint, payload, signal) {
          if (endpoint === 'session/list') {
            return Promise.all([
              // The local leg can fail too on a shell whose carrier travels the network.
              baseRpc.call(channel, endpoint, payload, signal).catch(function () { return undefined }),
              remoteUnary(endpoint, payload, signal).catch(function () { return undefined }),
            ]).then(function (both) {
              var localResult = both[0]
              var remoteResult = both[1]
              if (remoteResult === undefined || remoteResult === null || remoteResult.ok !== true) {
                note('list-merge-skipped', { reason: 'remote unavailable' })
                // The local half is the answer when it exists. When it does not, say so:
                // resolving undefined leaves the Client unable to render anything.
                if (localResult !== undefined && localResult !== null) return localResult
                return remoteUnavailable(endpoint, 'neither leg answered')
              }
              if (localResult === null || typeof localResult !== 'object' || localResult.ok !== true) {
                // Only the remote half answered: serve it rather than resolving to nothing.
                if (remoteResult.ok === true) return remoteResult
                // Both legs failed (a blip reaches the local carrier on some shells too).
                return remoteUnavailable(endpoint, 'local and mounted host both unavailable')
              }
              var merged = mergeListValues(localResult.value, remoteResult.value)
              note('list-merge', { local: merged.localCount, remote: merged.remoteCount, visibleRemote: merged.visibleRemote })
              return { ok: true, value: merged.value }
            })
          }
          // A create is workspace-scoped, exactly as in the fetch carrier: a payload that
          // merely names the remote Session being restored must not be sent to the remote
          // host, and the synthetic claim workspace must reach the local host without its
          // workspaceId. A desktop shell publishes this carrier, so the decision has to be
          // repeated here or the fetch-side fix silently does nothing on that path.
          if (endpoint === 'session/create') {
            if (createTarget(payload) === 'remote') {
              note('route-remote', { endpoint: endpoint })
              return remoteUnary(endpoint, payload, signal).catch(function (error) {
                return remoteUnavailable(endpoint, error)
              })
            }
            var claimless = withoutWorkspaceId(payload)
            if (claimless !== undefined) note('claim-create-local', { endpoint: endpoint })
            return baseRpc.call(channel, endpoint, claimless === undefined ? payload : claimless, signal).catch(function (error) {
              return carrierUnavailable(endpoint, error)
            })
          }
          // The shell decodes this carrier instead of fetch, and it asks for the catalogue the
          // same way, so the owner decision has to exist here too.
          trackSessionFocus({ method: endpoint, payload: payload })
          if (endpoint === 'session/modelCatalog') {
            var ownedByMount = catalogOwnedByMount()
            note('catalog-owner', { remote: ownedByMount, carrier: 'rpc' })
            if (ownedByMount !== true) {
              return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
                return carrierUnavailable(endpoint, error)
              })
            }
            return remoteUnary(endpoint, payload, catalogSignal(signal)).catch(function () {
              note('route-local-fallback', { method: endpoint, reason: 'mount failed' })
              // The fallback itself can fail: answer a carrier result rather than reject.
              return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
                return carrierUnavailable(endpoint, error)
              })
            })
          }
          if (refersRemote(payload)) {
            note('route-remote', { endpoint: endpoint })
            return remoteUnary(endpoint, payload, signal).catch(function (error) {
              return remoteUnavailable(endpoint, error)
            })
          }
          return baseRpc.call(channel, endpoint, payload, signal).catch(function (error) {
            return carrierUnavailable(endpoint, error)
          })
        },
      }
      if (typeof baseRpc.open === 'function') built.rpc.open = baseRpc.open
    }
    built.__dshRemoteHost = true
    globalThis.__DSH_TRANSPORT__ = built
    hooks = built
    note('installed', { carrier: diag.hasRpc === true ? 'rpc' : 'fetch', streams: STREAMS, streamBaseUrl: diag.streamBaseUrl, group: GROUP_MODE })
    prefetchWorkspaces()
    prefetchRemoteSessions()
    // Last: breadcrumbs must never sit between a carrier and its first call.
    traceInstall()
    return built
  }

  var hooks = install(previous)
  installSelfUpdate()

  // The shell may publish its carrier after page scripts run. Adopt whatever is
  // there on a few beats, so either ordering ends with routing installed.
  /**
   * Whether a carrier was already present when this script ran. The install above
   * wraps whatever the base held, so a non-empty base means the shell published
   * before us and nothing has to be waited for. An empty base means the shell may
   * still publish one, and only then is the bounded watch below worth running.
   */
  var adoptedAtBoot = Object.keys(previous).length > 0
  /** First re-check delay; each miss adds one step up to the ceiling. */
  var ADOPT_FIRST_DELAY_MS = 100
  var ADOPT_DELAY_STEP_MS = 25
  var ADOPT_MAX_DELAY_MS = 250
  /** Hard caps, so a page whose shell never publishes a carrier cannot tick forever. */
  var ADOPT_MAX_ATTEMPTS = 24
  var ADOPT_MAX_ELAPSED_MS = 6000

  /** @returns true once a carrier is installed, by this call or an earlier one. */
  function adopt() {
    if (adoptedAtBoot === true) return true
    var current = globalThis.__DSH_TRANSPORT__
    if (current === undefined || current === null) return false
    // Our own wrapper from the install above: the shell has not published yet.
    if (current.__dshRemoteHost === true) return false
    install(current)
    note('adopted-late-carrier', { keys: Object.keys(current) })
    adoptedAtBoot = true
    return true
  }
  var schedule = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout.bind(globalThis)
    : undefined

  /**
   * Watch for a carrier the shell publishes after this script, for a bounded time.
   * Stops on the first successful adoption instead of running the whole schedule: a
   * carrier present at boot settles on the first call and schedules nothing.
   * @param attempt - zero-based attempt index, used for the backoff step.
   * @param startedAt - wall clock of the first attempt, for the elapsed cap.
   */
  function adoptUntilSettled(attempt, startedAt) {
    if (adopt() === true) return
    if (schedule === undefined) return
    if (attempt + 1 >= ADOPT_MAX_ATTEMPTS) return
    if (Date.now() - startedAt >= ADOPT_MAX_ELAPSED_MS) return
    var delay = Math.min(ADOPT_MAX_DELAY_MS, ADOPT_FIRST_DELAY_MS + attempt * ADOPT_DELAY_STEP_MS)
    schedule(function () { adoptUntilSettled(attempt + 1, startedAt) }, delay)
  }

  if (schedule !== undefined) {
    adoptUntilSettled(0, Date.now())
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('load', function () { adopt() })
    }
  }})()

