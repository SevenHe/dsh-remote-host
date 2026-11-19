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

  function mergeBaseline(local, remote) {
    var kept = GROUP_MODE === 'none'
      ? { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
      : (GROUP_MODE === 'single' ? collapseRemoteSide(remote) : pruneRemoteSide(remote))
    return {
      items: local.items.concat(kept.items),
      archivedSessionIds: local.archivedSessionIds.concat(kept.archivedSessionIds),
      pinnedSessionIds: local.pinnedSessionIds.concat(kept.pinnedSessionIds),
    }
  }

