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
      legStatus[kind] = state
      globalThis.__DSH_REMOTE_HOST_STATUS__ = { remote: legStatus.remote, local: legStatus.local }
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
        spaces.push({ title: space.title, sessionIds: members })
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
      spaces.push({ title: title, ids: ids })
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

