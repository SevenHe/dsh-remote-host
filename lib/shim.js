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
  var previous = globalThis.__DSH_TRANSPORT__ || {}
  /** Captured before any patching, so the router can still open real sockets. */
  var NativeWebSocket = globalThis.WebSocket
  var remoteSessions = new Set()
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
      published.push(entry)
    }
    globalThis.__DSH_REMOTE_HOST_SESSIONS__ = published
    announce('sessions', { count: published.length })
    return published
  }

  async function mergeSessionList(input, init, request) {
    var responses = await Promise.all([
      localFetch(input, init),
      localFetch(mountUrl(input), init).catch(function () { return undefined }),
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
      return refersRemote(request.payload) === true
    } catch (error) { return false }
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
    if (method === 'session/list') return mergeSessionList(input, init, request)
    if (method === EVENT_RESULT_ENDPOINT) {
      var rewritten = rewriteEventResult(init)
      if (rewritten !== undefined) return localFetch(mountUrl(input), rewritten)
      return localFetch(input, init)
    }
    if (request !== undefined && refersRemote(request.payload)) {
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
  var remoteSessionsRefresh

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
        publishRemoteSessions(items)
        publishRemoteState()
        refreshGroups()
      }).catch(function (error) { note('sessions-refresh-failed', { error: String(error).slice(0, 90) }) })
    } catch (error) { /* the next event or the client's own list retries */ }
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
    /** Suppress reconnect attempts once the browser is closing this socket. */
    var shuttingDown = false
    /** Consecutive failed reconnects, for backoff and the error status. */
    var reconnectAttempts = 0
    /** The one pending reconnect timer, so overlapping handlers cannot stack loops. */
    var reconnectTimer
    /** True while a reconnect is scheduled or being attempted. */
    var reconnectPending = false
    var merges = new Map()
    var counter = 0
    /** Frames seen per upstream leg, for the diagnostics report. */
    var relays = {}

    /** First reconnect delay and its ceiling; see reconnectBackoff. */
    var RECONNECT_BASE_MS = 200
    var RECONNECT_CAP_MS = 10000

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
    function reconnectRemote() {
      if (shuttingDown === true) return
      if (reconnectPending === true) return
      reconnectPending = true
      reconnectAttempts += 1
      if (reconnectAttempts < 3) publishStatus('remote', 'connecting')
      else publishStatus('remote', 'error')
      upstreams.delete('remote')
      var attempt = function () {
        reconnectTimer = undefined
        if (shuttingDown === true) { reconnectPending = false; return }
        var socket
        try { socket = connect('remote') } catch (error) { socket = undefined }
        reconnectPending = false
        if (socket === undefined) {
          // No carrier: yield, then schedule the next step through the timer.
          reconnectRemote()
          return
        }
        var onOpen = function () {
          reconnectAttempts = 0
          replayRemoteStreams()
        }
        if (socket.readyState === 1) onOpen()
        else if (typeof socket.addEventListener === 'function') socket.addEventListener('open', onOpen)
      }
      if (typeof setTimeout === 'function') reconnectTimer = setTimeout(attempt, reconnectBackoff(reconnectAttempts))
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

  function publish() {
    var body = JSON.stringify(diag)
    post(MOUNT + '/__dsh_remote_host__/report', body)
    if (SINK !== undefined) post(SINK, body)
  }

  function note(name, data) {
    diag.events.push({ name: name, at: Date.now(), data: data })
    if (diag.events.length > 40) diag.events.shift()
    publish()
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
/**
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
      built.rpc = {
        call: function (channel, endpoint, payload, signal) {
          if (endpoint === 'session/list') {
            return Promise.all([
              baseRpc.call(channel, endpoint, payload, signal),
              remoteUnary(endpoint, payload, signal).catch(function () { return undefined }),
            ]).then(function (both) {
              var localResult = both[0]
              var remoteResult = both[1]
              if (remoteResult === undefined || remoteResult === null || remoteResult.ok !== true) {
                note('list-merge-skipped', { reason: 'remote unavailable' })
                return localResult
              }
              if (localResult === null || typeof localResult !== 'object' || localResult.ok !== true) return localResult
              var merged = mergeListValues(localResult.value, remoteResult.value)
              note('list-merge', { local: merged.localCount, remote: merged.remoteCount, visibleRemote: merged.visibleRemote })
              return { ok: true, value: merged.value }
            })
          }
          if (refersRemote(payload)) {
            note('route-remote', { endpoint: endpoint })
            return remoteUnary(endpoint, payload, signal)
          }
          return baseRpc.call(channel, endpoint, payload, signal)
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
  function adopt() {
    var current = globalThis.__DSH_TRANSPORT__
    if (current === undefined || current === null) return
    if (current.__dshRemoteHost === true) return
    install(current)
    note('adopted-late-carrier', { keys: Object.keys(current) })
  }
  var schedule = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout.bind(globalThis)
    : undefined

  function adoptUntilSettled(attempt) {
    adopt()
    // The shell publishes its carrier after an async IPC boot, so keep watching
    // for a few seconds rather than assuming it lands within one beat.
    if (schedule === undefined || attempt >= 80) return
    schedule(function () { adoptUntilSettled(attempt + 1) }, attempt < 10 ? 25 : 100)
  }

  if (schedule !== undefined) {
    adoptUntilSettled(0)
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('load', function () { adopt() })
    }
  }
})()

