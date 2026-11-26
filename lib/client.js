/**
 * dsh-remote-host — browser half.
 *
 * Two opt-in contributions: the remote workspace block (`remoteBlock`), which renders the
 * mounted host's 工作区 → 会话 list in a second region of the sidebar, and `sectionHeaders`,
 * which only decorates the shipped list.
 *
 * The remote layout is published by the host half
 * (`globalThis.__DSH_REMOTE_HOST_STATE__`: id set plus workspaces with their session ids),
 * so remote groups mirror the remote's own 工作区 → 会话 layering and never depend on a
 * merged workspace record existing.
 *
 * `sidebar: sections` — the variant that took over `sidebar.workspaces` and rendered a
 * two-section list of its own — has been removed: it crashed the renderer with
 * EXC_BREAKPOINT inside V8 (scripts/ensure-profile.mjs strips the key after a crash), and
 * `remoteBlock` covers the same need without occupying a shipped slot. The key is gone from the
 * config surface, so a profile that still carries it is simply ignored: the shipped list stays and
 * nothing warns, because there is nothing left to configure.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-host',
  factory: (require) => {
    const config = globalThis.__DSH_REMOTE_HOST__ || {}

    /** Relative age text. `now` lets the pure view model resolve against one clock reading. */
    const relative = (value, now) => {
      if (typeof value !== 'number' || Number.isFinite(value) === false) return ''
      const delta = (typeof now === 'number' ? now : Date.now()) - value
      const minute = 60000
      if (delta < minute) return '刚刚'
      if (delta < 60 * minute) return Math.floor(delta / minute) + '分钟'
      if (delta < 24 * 60 * minute) return Math.floor(delta / (60 * minute)) + '小时'
      if (delta < 30 * 24 * 60 * minute) return Math.floor(delta / (24 * 60 * minute)) + '天'
      return Math.floor(delta / (30 * 24 * 60 * minute)) + '个月'
    }

    const titleOf = (summary) => {
      const title = summary?.projections?.values?.title
      if (typeof title === 'string' && title.length > 0) return title
      const cwd = typeof summary?.cwd === 'string' ? summary.cwd : ''
      return cwd.length > 0 ? cwd.split('/').filter(Boolean).slice(-1)[0] : '未命名'
    }

    /**
     * Last known-good remote state. The host half never publishes an empty set,
     * but a page that renders before the first merge would otherwise classify
     * every remote session as local (and show them as ungrouped).
     */
    let lastRemote = { ids: [], label: '', workspaces: [] }
    const remoteState = () => {
      const state = globalThis.__DSH_REMOTE_HOST_STATE__
      if (state !== null && typeof state === 'object' && Array.isArray(state.ids) && state.ids.length > 0) {
        lastRemote = state
        return state
      }
      return lastRemote
    }

    /**
     * Section heading for the merged remote groups.
     *
     * The shipped list renders the groups it owns, so this does not render rows: it puts one
     * plain heading element in front of the *first* merged remote group (recognised by the id
     * prefix the shim adds to those records) and marks that group for a divider. A bounded
     * poll re-applies it, because a re-render may drop the inserted node.
     */
    function installSectionHeaders() {
      try {
        if (config.sectionHeaders !== true) return
        const rows = document.querySelectorAll('[data-row-key^="workspace:drh:"]')
        if (rows.length === 0) return
        const first = rows[0]
        const wrapper = first.parentElement
        const section = wrapper === null ? undefined : wrapper.parentElement
        if (section === undefined || section === null) return
        if (section.getAttribute('data-drh-section') !== 'true') {
          section.setAttribute('data-drh-section', 'true')
          section.style.marginTop = '10px'
          section.style.borderTop = '1px solid var(--dsh-border-subtle, rgba(120,120,128,0.18))'
          section.style.paddingTop = '4px'
        }
        const previous = section.previousElementSibling
        if (previous !== null && previous.getAttribute('data-drh-head') === 'true') return
        const head = document.createElement('div')
        head.setAttribute('data-drh-head', 'true')
        head.textContent = '远端工作区 · ' + (config.label || 'remote')
        head.style.cssText = 'padding:0.9em 9px 0.25em;font-size:var(--dsh-content-font-size-secondary,13px);font-weight:500;letter-spacing:0.02em;color:var(--dsh-text-tertiary, rgba(120,120,128,0.92));user-select:none'
        if (section.parentElement !== null) section.parentElement.insertBefore(head, section)
      } catch (error) { /* cosmetic only */ }
    }

    /* ------------------------------------------------------------------ *
     * Remote workspace block.
     *
     * A second workspace region, rendered by this plugin because the shipped one fills a
     * single-occupancy hole. Markup order and class semantics are ported from
     * packages/client/ui-workspace (see src/client/block/upstream and PROVENANCE.md); the
     * styles come from the ported drh-* stylesheet, so it looks like the shipped block.
     * Interactions reuse the shipped services: ctx.uiWorkspace for open/pin/archive, and the
     * shim routes remote calls to the mounted host.
     * ------------------------------------------------------------------ */

    // Identifies this module instance and is stamped on the block element: a duplicate load
    // would otherwise fight over one #drh-remote-block id, and the probe could not tell them apart.
    var BLOCK_INSTANCE = (globalThis.__DRH_INSTANCE_SEQ__ = (globalThis.__DRH_INSTANCE_SEQ__ || 0) + 1)

    var blockState = {
      expanded: new Set(),
      collapsed: new Set(),
      pinned: new Set(),
      dragging: null,
      hoverTimer: null,
      editing: null,
      searchOpen: false,
      current: null,
      query: '',
      /** Group ordering of the session rows: 'default' (remote order) | 'time' | 'name'. */
      /** Grouping mode, ordering and archived filter, mirrored from the shipped view menu. */
      groupBy: 'workspace',
      orderBy: 'updated',
      filter: 'hide',
      /** Host home, used to abbreviate a Session path in the hover card. */
      home: '',
      /** Pointer is inside the hover card, so its row leaving must not dismiss it. */
      hoverHold: false,
      /** Outside-click guard of the floating add-workspace panel, while it is open. */
      panelGuard: null,
      /** 'session:<id>' or 'group:<key>' whose menu is open, so that row keeps its hover fill. */
      menuTarget: null,
      /** Workspaces created from this block that the published layout does not list yet. */
      created: [],
      container: null,
      roots: [],
      /** Last painted change signature; empty forces the next paint. */
      signature: '',
      /** Last painted header shape: the search toggle and the label, never the status. */
      headerShape: '',
      /** Last painted connection state of the mount leg; patched into the dot alone. */
      dotState: '',
      /** Last painted markup, so an unchanged repaint never touches the DOM. */
      html: '',
      /** Last render failure, kept for diagnostics instead of being swallowed silently. */
      error: null,
    }

    function ensureBlockStyles() {
      try {
        if (document.getElementById('drh-block-css') !== null) return
        var link = document.createElement('link')
        link.id = 'drh-block-css'
        link.rel = 'stylesheet'
        // MOUNT is a shim variable; the client half only knows config.mount.
        link.href = (typeof config.mount === 'string' && config.mount.length > 0 ? config.mount : '/devbox') + '/__dsh_remote_host__/asset/block.css'
        document.head.appendChild(link)
      } catch (error) { /* styles are cosmetic */ }
    }

    function esc(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    function sprite(name, size) {
      return '<svg width="' + size + '" height="' + size + '" data-icon="' + name + '" aria-hidden="true">' +
        '<use href="#' + name + '"></use></svg>'
    }

    /** Remote summaries published by the shim (title, time, running) keyed by session id. */
    /** Whether the published remote summary reports this Session as running. */
    function isRunningRemote(id) {
      var summary = blockSummaries().get(id)
      return summary !== undefined && summary.running === true
    }

    function blockSummaries() {
      var map = new Map()
      try {
        var list = globalThis.__DSH_REMOTE_HOST_SESSIONS__
        if (Array.isArray(list) !== true) return map
        for (var i = 0; i < list.length; i += 1) {
          var item = list[i]
          if (item !== null && typeof item === 'object' && typeof item.id === 'string') map.set(item.id, item)
        }
      } catch (error) { /* keep an empty map */ }
      return map
    }

    /**
     * Host-published remote pin/archive marks, plus the local bridge set that covers
     * the moment between a click and the next published frame.
     */
    function marksState() {
      var pinned = new Set()
      var archived = new Set()
      try {
        var marks = globalThis.__DSH_REMOTE_HOST_MARKS__
        if (marks !== null && marks !== undefined) {
          if (Array.isArray(marks.pinned)) for (var p = 0; p < marks.pinned.length; p += 1) pinned.add(marks.pinned[p])
          if (Array.isArray(marks.archived)) for (var a = 0; a < marks.archived.length; a += 1) archived.add(marks.archived[a])
        }
      } catch (error) { /* marks are advisory */ }
      if (blockState.pinned instanceof Set) blockState.pinned.forEach(function (id) { pinned.add(id) })
      return { pinned: pinned, archived: archived }
    }

    /**
     * Row order inside one group: pinned rows lead, then the order the list was built
     * with ('manual' keeps the remote order, 'updated' sorts by activity).
     */
    function memberComparator(pinned) {
      return function (left, right) {
        var lp = pinned.has(left.id) ? 0 : 1
        var rp = pinned.has(right.id) ? 0 : 1
        return lp - rp
      }
    }

    /**
     * Most recent activity inside one group; -1 when it holds no Session, so a workspace that
     * was just created (and still has none) sorts last instead of jumping to the top.
     */
    function newestAt(group) {
      var newest = -1
      for (var i = 0; i < group.members.length; i += 1) {
        var at = group.members[i].at || 0
        if (at > newest) newest = at
      }
      return newest
    }

    /**
     * Grouped rows for the remote block, derived from the published layout alone.
     *
     * Every input is a plain value — the remote workspaces, the published summaries, the
     * archived marks, workspaces created here, the view menu's filter and ordering, the
     * persisted drag order and one clock reading — so the grouping rules can be pinned
     * without a DOM.
     *
     * @param input.workspaces - Remote workspaces: { id, title, sessionIds }.
     * @param input.published - Remote summary per session id.
     * @param input.archived - Session ids the archived filter hides.
     * @param input.created - Workspaces created here that the host does not list yet.
     * @param input.query - Raw search text; trimmed and lowercased here.
     * @param input.filter - 'hide' (default) | 'all' | 'only'.
     * @param input.orderBy - 'updated' | 'manual'.
     * @param input.order - Persisted group order, read by 'manual' only.
     * @param input.now - Clock reading the row timestamps resolve against.
     * @returns One row per group: { title, id, key, members }.
     */
    function buildBlockRows(input) {
      var workspaces = Array.isArray(input.workspaces) ? input.workspaces : []
      var published = input.published instanceof Map ? input.published : new Map()
      var needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
      // Archived rows follow the shipped filter: hidden by default, mixed in for "all",
      // and exclusive for "only".
      var archivedNow = input.archived instanceof Set ? input.archived : new Set()
      var out = []
      for (var i = 0; i < workspaces.length; i += 1) {
        var space = workspaces[i]
        var ids = Array.isArray(space.sessionIds) ? space.sessionIds : []
        var members = []
        for (var j = 0; j < ids.length; j += 1) {
          var summary = published.get(ids[j])
          var title = summary === undefined ? ids[j] : (summary.title === undefined || summary.title === null ? ids[j] : String(summary.title))
          if (needle.length > 0 && title.toLowerCase().indexOf(needle) === -1) continue
          var when = summary === undefined || summary.updatedAt === null || summary.updatedAt === undefined ? '' : relative(summary.updatedAt, input.now)
          var at = summary === undefined || typeof summary.updatedAt !== 'number' ? 0 : summary.updatedAt
          members.push({ id: ids[j], title: title, time: when, at: at })
        }
        members = members.filter(function (member) {
          var isArchived = archivedNow.has(member.id) === true
          if (input.filter === 'all') return true
          if (input.filter === 'only') return isArchived
          return isArchived !== true
        })
        if (input.orderBy === 'updated') {
          members.sort(function (left, right) { return (right.at || 0) - (left.at || 0) })
        }
        if (members.length === 0 && needle.length > 0) continue
        out.push({ title: space.title, id: typeof space.id === 'string' ? space.id : '', key: 'w:' + ((typeof space.id === 'string' && space.id.length > 0) ? space.id : space.title), members: members })
      }
      // A workspace created from this block has no remote sessions yet, so the published layout
      // does not carry it. Keep it visible locally until the host reports it.
      var createdList = Array.isArray(input.created) ? input.created : []
      for (var created = 0; created < createdList.length; created += 1) {
        var mine = createdList[created]
        var already = false
        for (var scan = 0; scan < out.length; scan += 1) {
          if (out[scan].key === mine.key || (mine.id.length > 0 && out[scan].id === mine.id)) already = true
        }
        if (already !== true) out.push({ title: mine.title, id: mine.id, key: mine.key, members: [] })
      }
      if (input.orderBy === 'updated') {
        // The shipped list leads with the most recently active workspace, so a group ranks by
        // its newest Session: a Session that just started lifts its group to the top of the
        // block instead of being appended at the bottom.
        out.sort(function (left, right) { return newestAt(right) - newestAt(left) })
      } else {
        // Manual mode keeps the order the user dragged into place.
        var order = Array.isArray(input.order) ? input.order : []
        out.sort(function (left, right) {
          var li = order.indexOf(left.key)
          var ri = order.indexOf(right.key)
          if (li === -1 && ri === -1) return 0
          if (li === -1) return 1
          if (ri === -1) return -1
          return li - ri
        })
      }
      return out
    }

    /** buildBlockRows over the live page globals and this block's view state. */
    function blockRows() {
      var state = globalThis.__DSH_REMOTE_HOST_STATE__
      return buildBlockRows({
        workspaces: state !== undefined && state !== null ? state.workspaces : undefined,
        published: blockSummaries(),
        archived: marksState().archived,
        created: blockState.created,
        query: blockState.query,
        filter: blockState.filter,
        orderBy: blockState.orderBy,
        // Manual order is the only branch that reads the persisted list, so an idle
        // refresh never parses localStorage.
        order: blockState.orderBy === 'manual' ? loadBlockOrder() : [],
        now: Date.now(),
      })
    }

    /** First sprite id that exists, so a missing icon degrades to another one. */
    function pickIcon(candidates) {
      for (var i = 0; i < candidates.length; i += 1) {
        if (document.getElementById(candidates[i]) !== null) return candidates[i]
      }
      return candidates[candidates.length - 1]
    }

    /**
     * pickIcon with a one-way cache.
     *
     * The shipped sprite can render after the block's first paint, so a lookup is allowed to
     * miss at boot and hit a moment later. Only a hit on the PREFERRED candidate is cached: a
     * fallback stays live, so the next paint can still pick up the real sprite. The resolved
     * ids are part of the structural signature, so a sprite that arrives late rebuilds the
     * block once instead of leaving fallback glyphs on screen for the rest of the session.
     */
    var iconCache = Object.create(null)
    function pickIconCached(candidates) {
      var preferred = candidates[0]
      var hit = iconCache[preferred]
      if (typeof hit === 'string') return hit
      var resolved = pickIcon(candidates)
      if (resolved === preferred) iconCache[preferred] = resolved
      return resolved
    }

    /** Group order chosen by dragging; persisted so it survives reloads. */
    function loadBlockOrder() {
      try {
        var raw = globalThis.localStorage === undefined ? null : globalThis.localStorage.getItem('drh:order')
        var parsed = raw === null ? null : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch (error) { return [] }
    }

    function saveBlockOrder(order) {
      try {
        if (globalThis.localStorage !== undefined) globalThis.localStorage.setItem('drh:order', JSON.stringify(order))
      } catch (error) { /* ordering is cosmetic */ }
    }

    /** Abbreviate the Host home directory for display, like the shipped card. */
    function abbreviatePath(path) {
      var home = typeof blockState.home === 'string' ? blockState.home : ''
      if (home.length === 0) {
        // The mounted host publishes no home yet, so derive it from a devbox working
        // directory (/home/<user>) and reuse it for the following cards. A home
        // published by the shim later still wins, because it is assigned before this runs.
        var derived = /^\/data[0-9]*\/home\/[^/]+/.exec(path)
        if (derived !== null) {
          home = derived[0]
          blockState.home = home
        }
      }
      if (home.length > 0 && path === home) return '~'
      if (home.length > 0 && path.indexOf(home + '/') === 0) return '~' + path.slice(home.length)
      return path
    }

    /** Relative time in the shipped card's wording. */
    function agoText(at) {
      var value = relative(at)
      return value === '刚刚' ? '刚刚' : value + '前'
    }

    /** Shipped hover-card preview: dark surface with title, path, time and status. */
    function showHoverCard(row) {
      closeHoverCard()
      var id = row.getAttribute('data-drh-session')
      if (id === null || id === undefined) return
      var summary = blockSummaries().get(id)
      var box = row.getBoundingClientRect()
      var card = document.createElement('div')
      card.id = 'drh-hovercard'
      card.className = 'drh-hoverCard'
      var content = document.createElement('div')
      content.className = 'drh-hoverContent'
      var title = document.createElement('div')
      title.className = 'drh-hoverTitle'
      title.textContent = summary === undefined || summary.title === undefined ? id : String(summary.title)
      content.appendChild(title)
      var cwd = summary === undefined || typeof summary.cwd !== 'string' ? '' : summary.cwd
      if (cwd.length > 0) {
        var path = document.createElement('div')
        path.className = 'drh-hoverPath'
        path.textContent = abbreviatePath(cwd)
        content.appendChild(path)
      }
      if (summary !== undefined && typeof summary.updatedAt === 'number') {
        var time = document.createElement('div')
        time.className = 'drh-hoverTime'
        time.textContent = agoText(summary.updatedAt)
        content.appendChild(time)
      }
      // The shipped card keeps a zero-height spacer between the time and the status row.
      content.appendChild(document.createElement('div'))
      var status = document.createElement('div')
      status.className = 'drh-hoverStatus'
      var dot = document.createElement('span')
      dot.className = 'drh-hoverDot'
      dot.setAttribute('data-state', summary !== undefined && summary.running === true ? 'running' : 'idle')
      status.appendChild(dot)
      var state = document.createElement('span')
      state.textContent = summary !== undefined && summary.running === true ? '运行中' : '空闲'
      status.appendChild(state)
      content.appendChild(status)
      card.appendChild(content)
      // Pointer entry keeps the card open (the shipped preview stays hit-testable).
      card.addEventListener('mouseenter', function () { blockState.hoverHold = true })
      card.addEventListener('mouseleave', function () { blockState.hoverHold = false; closeHoverCard() })
      // The shipped card sits at the sidebar's right edge + 16 (280 with a 264px sidebar),
      // not at the hovered row's own right edge.
      var anchorRight = box.right
      try {
        var rootForAnchor = document.getElementById('drh-remote-block')
        if (rootForAnchor !== null) anchorRight = rootForAnchor.getBoundingClientRect().right
      } catch (error) { /* fall back to the row edge */ }
      card.style.left = (anchorRight + 16) + 'px'
      card.style.top = box.top + 'px'
      document.body.appendChild(card)
      var rect = card.getBoundingClientRect()
      if (rect.right > window.innerWidth - 8) card.style.left = Math.max(8, box.left - rect.width - 16) + 'px'
      if (rect.bottom > window.innerHeight - 8) card.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px'
    }

    function closeHoverCard() {
      blockState.hoverHold = false
      var card = document.getElementById('drh-hovercard')
      if (card !== null) card.remove()
    }

    /** Connection state of the mounted host: open | connecting | error. */
    function remoteBlockStatus() {
      try {
        var status = globalThis.__DSH_REMOTE_HOST_STATUS__
        var value = status === null || status === undefined ? undefined : status.remote
        if (value === 'open' || value === 'error' || value === 'connecting') return value
      } catch (error) { /* ignore */ }
      return 'connecting'
    }

    /** The shipped expand arrow: the filled right triangle, rotated down when open. */
    function arrowSvg(open) {
      return '<svg width="16" height="16" class="drh-arrow' + (open ? ' drh-arrowOpen' : '') + '" data-icon="' + arrowIcon + '" aria-hidden="true">' +
        '<use href="#' + arrowIcon + '"></use></svg>'
    }

    /**
     * Sprite ids the menus and the render pass share. They must live at module scope: a
     * function-local pickIcon left openBlockMenu referencing an unbound name, which threw a
     * ReferenceError inside the delegated click listener and silently kept the menu closed.
     */
    /** Filled triangle the shipped row uses as its expand arrow. */
    var arrowIcon = 'dsw-icon-triangle-right-fill-regular'
    /** The shipped row shows the open folder while a group is expanded. */
    var folderOpenIcon = 'dsw-icon-folder-open-regular'
    var PIN_CANDIDATES = ['dsw-icon-pin-outline-regular', 'dsw-icon-pin-fill-regular']
    var PIN_FILL_CANDIDATES = ['dsw-icon-pin-fill-regular', 'dsw-icon-pin-outline-regular']
    function iconOf(kind) {
      return pickIconCached(kind === 'pinFill' ? PIN_FILL_CANDIDATES : PIN_CANDIDATES)
    }

    /** Paint the block. A render failure must never freeze the block or break the refresh timer. */
    /**
     * Open a remote Session, making sure the client catalog knows it first.
     *
     * The catalog is fed by the client's own session/list refresh, so a Session created on
     * the remote a moment ago is still unknown to sessions.retain ("unknown session <id>").
     * Fill it from the SAME sessions service the workspace uses — ctx.uiWorkspace.sessions,
     * not ctx.get('sessions'), whose manager lives in another scope — then open, then remove
     * the injected row again so the shipped list never grows one. Every step degrades to the
     * plain openSession path, so a missing service cannot make opening worse than before.
     */
    function openRemoteSession(ctx, sessionId, summary) {
      var manager = null
      try {
        var scoped = ctx.uiWorkspace !== undefined && ctx.uiWorkspace !== null ? ctx.uiWorkspace.sessions : undefined
        if (scoped !== undefined && scoped !== null) manager = scoped.manager
      } catch (error) { manager = null }
      var injected = false
      var drop = function () {
        if (injected !== true) return
        injected = false
        try { if (typeof manager.handleSessionRemoved === 'function') manager.handleSessionRemoved(sessionId) } catch (error) { /* best effort */ }
      }
      /**
       * Settle the injected catalog row once the open has resolved.
       *
       * The row must STAY for a remote Session: the composer binds to the catalog entry, so
       * removing it left the main area showing the unavailable-composer state
       * (contenteditable=false) — the transcript rendered but could not be continued. Keeping
       * it cannot leak the row into the shipped list, because the shim publishes every
       * remote id in the page's hidden-session Set, which the shipped tree filters on.
       *
       * Only for an id the shim does not (yet) classify as remote is the row still dropped:
       * such an id is absent from that Set and would surface under the ungrouped bucket.
       */
      var settle = function () {
        if (injected !== true) return
        var isRemote = false
        try { isRemote = remoteState().ids.indexOf(sessionId) !== -1 } catch (error) { isRemote = false }
        if (isRemote === true) { injected = false; return }
        drop()
      }
      var injectAndOpen = function () {
        if (manager !== null && manager !== undefined && typeof manager.handleSessionAdded === 'function') {
          try {
            var row = {
              sessionId: sessionId,
              updatedAt: summary !== undefined && typeof summary.updatedAt === 'number' ? summary.updatedAt : Date.now(),
              running: summary !== undefined && summary.running === true,
              blank: summary !== undefined && summary.blank === true,
            }
            if (summary !== undefined && typeof summary.cwd === 'string' && summary.cwd.length > 0) row.cwd = summary.cwd
            // Carry the published row metadata as well: the view restoration reads these, and a
            // row without them opens to an empty shell.
            if (summary !== undefined && typeof summary.formatStatus === 'string' && summary.formatStatus.length > 0) row.formatStatus = summary.formatStatus
            if (summary !== undefined && typeof summary.parentSessionId === 'string' && summary.parentSessionId.length > 0) row.parentSessionId = summary.parentSessionId
            if (summary !== undefined && typeof summary.asOfSeq === 'number') row.asOfSeq = summary.asOfSeq
            manager.handleSessionAdded(row)
            injected = true
          } catch (error) { injected = false }
        }
        var pending = null
        try {
          pending = ctx.uiWorkspace.openSession(sessionId)
        } catch (error) {
          drop()
          return Promise.reject(error)
        }
        if (pending !== null && pending !== undefined && typeof pending.then === 'function') {
          return pending.then(function (value) { settle(); return value }, function (error) { drop(); return Promise.reject(error) })
        }
        settle()
        return Promise.resolve(pending)
      }
      // A Session created after this page loaded is missing from the client's own list, so the
      // row injected here is all it knows and the main area rendered an empty shell. The shim's
      // session/list carries the remote rows, so ask the client to refresh first and open the
      // complete row instead of one we built by hand.
      var refresh = null
      try {
        var sessions = ctx.get('sessions')
        if (sessions !== null && sessions !== undefined && typeof sessions.refresh === 'function') refresh = sessions.refresh()
        else if (manager !== null && manager !== undefined && typeof manager.refreshList === 'function') refresh = manager.refreshList()
      } catch (error) { refresh = null }
      if (refresh === null || refresh === undefined || typeof refresh.then !== 'function') return injectAndOpen()
      return refresh.then(function () { return undefined }, function () { return undefined }).then(injectAndOpen)
    }

    function renderBlock(force) {
      try {
        renderBlockUnsafe(force)
        blockState.error = null
      } catch (error) {
        // Keep the reason reachable for a probe instead of silently leaving a stale block.
        blockState.error = String(error !== null && error !== undefined && error.message ? error.message : error)
        try { globalThis.__DRH_RENDER_ERROR__ = blockState.error } catch (ignored) { /* diagnostics only */ }
      }
    }

    /** The shipped running-state spinner, shared by the row template and the patch path. */
    function stateDotMarkup() {
      return '<span class="drh-stateDot" role="img" aria-label="运行中" title="运行中">'
        + '<svg class="drh-stateDotSvg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">'
        + '<g class="drh-stateDotMotion">'
        + '<circle class="drh-stateDotTrack" cx="12" cy="12" r="9.5"></circle>'
        + '<circle class="drh-stateDotArc" cx="12" cy="12" r="9.5"></circle>'
        + '</g></svg></span>'
    }

    /**
     * Update the rows already on screen, without touching the DOM structure.
     *
     * Only called when the structural signature is unchanged, so every visible row exists and
     * none needs adding, removing or moving: the row text, the running spinner, the selected
     * and menu-open classes and the pin affordance are the only things that can differ. Focus,
     * hover and an open menu therefore survive a refresh.
     *
     * INVARIANT: every field of the state signature must be written here. A field that reaches
     * the markup but is not patched here goes stale until the next structural rebuild, which is
     * exactly the class of bug this split was meant to avoid.
     */
    function patchBlockRows(container, rowsNow, pinned, icons) {
      var byId = Object.create(null)
      var nodes = container.querySelectorAll('[data-drh-session]')
      for (var index = 0; index < nodes.length; index += 1) byId[nodes[index].getAttribute('data-drh-session')] = nodes[index]
      for (var g = 0; g < rowsNow.length; g += 1) {
        var members = rowsNow[g].members
        for (var m = 0; m < members.length; m += 1) {
          var member = members[m]
          var el = byId[member.id]
          if (el === undefined) continue
          var title = el.querySelector('.drh-title')
          if (title !== null && title !== undefined && title.textContent !== member.title) title.textContent = member.title
          var time = el.querySelector('.drh-timestamp')
          if (time !== null && time !== undefined && time.textContent !== member.time) time.textContent = member.time
          var dot = el.querySelector('.drh-stateDot')
          var wantDot = isRunningRemote(member.id) === true
          if (wantDot === true && (dot === null || dot === undefined)) el.insertAdjacentHTML('afterbegin', stateDotMarkup())
          else if (wantDot !== true && dot !== null && dot !== undefined && dot.parentNode !== null) dot.parentNode.removeChild(dot)
          var wantSelected = blockState.current === member.id
          if (el.classList.contains('selected') !== wantSelected) el.classList.toggle('selected', wantSelected)
          var wantOpen = blockState.menuTarget === 'session:' + member.id
          if (el.classList.contains('menuOpen') !== wantOpen) el.classList.toggle('menuOpen', wantOpen)
          var pinButton = el.querySelector('[data-drh-rowpin]')
          if (pinButton !== null && pinButton !== undefined) {
            var wantPinned = pinned.has(member.id) === true
            var isPinned = pinButton.getAttribute('aria-label') === '取消置顶'
            if (wantPinned !== isPinned) {
              pinButton.setAttribute('aria-label', wantPinned ? '取消置顶' : '置顶会话')
              pinButton.setAttribute('title', wantPinned ? '取消置顶' : '置顶')
              pinButton.innerHTML = sprite(wantPinned ? icons.pinFill : icons.pin, 14)
            }
          }
        }
      }
      // Group rows carry their own open state: the shipped project row keeps its trigger lit
      // while its menu is up. Patching the session rows alone left that class stale, because
      // opening a group menu changes no structural signature.
      var groupNodes = container.querySelectorAll('[data-drh-group]')
      for (var gi = 0; gi < groupNodes.length; gi += 1) {
        var groupEl = groupNodes[gi]
        var wantGroupOpen = blockState.menuTarget === 'group:' + groupEl.getAttribute('data-drh-group')
        if (groupEl.classList.contains('menuOpen') !== wantGroupOpen) groupEl.classList.toggle('menuOpen', wantGroupOpen)
      }
    }

    /**
     * What one refresh has to repaint.
     *
     * `structural` rewrites the list, `header` re-creates the section header (search toggle or
     * label change only), `state` patches row state in place, and `dot` patches the connection
     * dot alone. The connection status deliberately feeds `dot` only: a reconnecting leg
     * republishes `connecting` and then `open`, and a flapping mount does that several times a
     * second, so counting it as a structural change rebuilt the whole block — section label
     * included — on every flap, which reads as a blinking title.
     * @param input - the freshly derived signatures plus the last painted ones.
     * @returns which parts of the block this refresh has to touch.
     */
    function paintPlan(input) {
      var header = input.headerNow !== input.previousHeader
      return {
        structural: input.signature !== input.previousSignature || header === true || input.htmlEmpty === true,
        header: header,
        state: input.stateSignature !== input.previousState,
        dot: String(input.status) !== String(input.previousStatus),
      }
    }

    /**
     * Paint the connection dot without touching the header it sits in.
     *
     * Only the two attributes move: the dot's node, the label's text node and the trailing
     * controls keep their identity, so a status change cannot re-layout or re-rasterize the
     * section title. The connecting state's spinner also stops restarting on every refresh.
     * @param container - the mounted block.
     * @param statusNow - 'open' | 'connecting' | 'error'.
     */
    function patchHeaderDot(container, statusNow) {
      try {
        var dot = container.querySelector('.drh-sectionHeader .drh-dot')
        if (dot === null || dot === undefined) return
        var state = String(statusNow)
        if (dot.getAttribute('data-state') !== state) dot.setAttribute('data-state', state)
        var title = state === 'open' ? '已连接' : state === 'error' ? '连接失败' : '正在连接'
        if (dot.getAttribute('title') !== title) dot.setAttribute('title', title)
      } catch (error) { /* the dot is cosmetic */ }
    }

    function renderBlockUnsafe(force) {
      var container = blockState.container
      if (container === null || container === undefined) return
      // Never repaint over an open inline editor: the periodic refresh would destroy it.
      if (blockState.editing !== null && blockState.editing !== undefined) return
      var statusNow = remoteBlockStatus()
      var rowsNow = blockRows()
      var marksNow = marksState()
      // Repaint only when something visible changed: rebuilding the whole block on every refresh
      // made the section label flicker. The expanded KEYS (not just their count) and the pin
      // marks take part in the signature, so a toggle or a pin always lands.
      // Two signatures, because the two kinds of change cost very different amounts:
      // structural changes rebuild the list, everything else is patched into the rows that are
      // already on screen (no innerHTML, no node churn).
      // The mount leg's connection status is NOT a signature input either: a flapping tunnel
      // republishes connecting/open several times a second, and counting that as structural
      // rebuilt the list and the section label with it. It feeds the dot alone (paintPlan).
      // Icons resolve BEFORE the signatures: the shipped sprite can render late, and the
      // resolved ids are part of the markup, so they have to be able to force a rebuild.
      var folderIcon = pickIconCached(['dsw-icon-folder-close-regular', 'dsw-icon-folder-regular'])
      var searchIcon = pickIconCached(['dsw-icon-search-outline-regular', 'dsw-icon-search-regular', 'dsw-icon-ellipsis-outline-regular'])
      var closeIcon = pickIconCached(['dsw-icon-close-fill-regular', 'dsw-icon-close-regular', 'dsw-icon-ellipsis-outline-regular'])
      var ellipsisIcon = pickIconCached(['dsw-icon-ellipsis-outline-regular', 'dsw-icon-ellipsis-outline-medium', 'dsw-icon-filter-outline-regular'])
      var pinIcon = iconOf('pin')
      var pinFillIcon = iconOf('pinFill')
      var archiveIcon = pickIconCached(['dsw-icon-archive-outline-regular', 'dsw-icon-unarchive-outline-regular'])
      var newChatIcon = pickIconCached(['dsw-icon-new-chat-outline-regular', 'dsw-icon-plus-outline-regular'])
      // The shipped sidebar's own header sprites, read off its three controls: search, view
      // options (sliders) and add workspace (project-add).
      var viewIcon = pickIconCached(['dsw-icon-sliders-two-outline-regular', 'dsw-icon-chevrons-up-down-outline-regular', 'dsw-icon-ellipsis-outline-regular'])
      var addSpaceIcon = pickIconCached(['dsw-icon-project-add-outline-regular', 'dsw-icon-plus-outline-regular'])
      var iconKey = [folderIcon, searchIcon, closeIcon, ellipsisIcon, pinIcon, pinFillIcon, archiveIcon, newChatIcon, viewIcon, addSpaceIcon].join(',')
      var orderNow = rowsNow.map(function (group) {
        var members = group.members.slice().sort(memberComparator(marksNow.pinned))
        return group.key + ':' + members.map(function (member) { return member.id }).join(',')
      }).join(';')
      var signature = [
        blockState.query, blockState.searchOpen === true,
        blockState.groupBy, blockState.orderBy, blockState.filter,
        Array.from(blockState.expanded).sort().join(','),
        Array.from(marksNow.archived).sort().join(','),
        orderNow,
        iconKey,
      ].join('|')
      var stateSignature = [
        blockState.current, blockState.menuTarget,
        Array.from(marksNow.pinned).sort().join(','),
        rowsNow.map(function (group) {
          return group.members.map(function (member) {
            return member.id + ':' + (member.at || 0) + ':' + member.time + ':' + member.title
              + ':' + (isRunningRemote(member.id) === true ? '1' : '0')
          }).join(',')
        }).join(';'),
      ].join('|')
      var headerNow = String(blockState.searchOpen === true) + '|' + String(config.label || '')
      // A forced repaint only means "paint even if nothing changed"; it must not turn a
      // state-only change into a rebuild. An empty html baseline means this container has
      // never been painted (a fresh mount, or the shipped tree dropped our node), so there is
      // nothing to patch into and the paint has to be a full one.
      var plan = paintPlan({
        signature: signature,
        previousSignature: blockState.signature,
        stateSignature: stateSignature,
        previousState: blockState.stateSignature,
        headerNow: headerNow,
        previousHeader: blockState.headerShape,
        status: String(statusNow),
        previousStatus: String(blockState.dotState),
        htmlEmpty: blockState.html === '',
      })
      if (force !== true && plan.structural !== true && plan.state !== true && plan.dot !== true) return
      var structuralChanged = plan.structural
      blockState.headerShape = headerNow
      blockState.dotState = String(statusNow)
      blockState.signature = signature
      blockState.stateSignature = stateSignature
      var groups = rowsNow
      // Probe surface for the verification scripts: group keys with their member counts, plus
      // the open set, so a collapsed-but-expanded row can be told apart from an empty group.
      try {
        globalThis.__DRH_DIAG__ = {
          inst: BLOCK_INSTANCE,
          groupKeys: groups.slice(0, 5).map(function (group) { return [group.key, group.members.length] }),
          expanded: Array.from(blockState.expanded),
          totalMembers: groups.reduce(function (sum, group) { return sum + group.members.length }, 0),
        }
      } catch (error) { /* diagnostic only */ }
      var total = groups.reduce(function (sum, group) { return sum + group.members.length }, 0)
      // Pinned comes from the host; the local bridge set covers the moment between a click and
      // the next published frame (see marksState).
      var pinned = marksNow.pinned
      var html = ''
      html += '<div class="drh-sectionHeader">' +
        '<span class="drh-dot" data-state="' + esc(statusNow) + '" title="' + (statusNow === 'open' ? '已连接' : statusNow === 'error' ? '连接失败' : '正在连接') + '"></span>' +
        '<span class="drh-sectionLabel drh-wide' + (blockState.searchOpen === true ? ' drh-sectionLabelHidden' : '') + '">远端工作区 · ' + esc(config.label || 'remote') + '</span>' +
        (blockState.searchOpen === true
          ? '<div class="drh-searchSlot drh-searchSlotExpanded"><div class="drh-search drh-searchExpanded">' +
              '<button type="button" class="drh-searchButton" data-drh-searchclose="true" aria-label="关闭搜索">' + sprite(searchIcon, 11) + '</button>' +
              '<input class="drh-searchInput" data-drh-search="true" type="text" placeholder="搜索会话名称" value="' + esc(blockState.query) + '" />' +
              '<button type="button" class="drh-clearButton" data-drh-searchclose="true" aria-label="清除搜索">' + sprite(closeIcon, 12) + '</button>' +
            '</div></div>'
          : '<div class="drh-searchSlot"><button type="button" class="drh-searchButton" data-drh-searchopen="true" aria-label="搜索会话">' + sprite(searchIcon, 14) + '</button></div>') +
        '<div class="drh-headerActions' + (blockState.searchOpen === true ? ' drh-headerActionsHidden' : '') + '">' +
          '<button type="button" class="drh-iconButton" data-drh-viewmenu="true" aria-label="视图选项" title="视图选项">' + sprite(viewIcon, 16) + '</button>' +
          '<button type="button" class="drh-iconButton" data-drh-newspace="true" aria-label="添加工作区" title="添加工作区">' + sprite(addSpaceIcon, 16) + '</button>' +
        '</div>' +
      '</div>'
      // Grouping mode from the view menu: per-workspace sections (default), the same
      // sections with an indent under each (tree), or one list with no sections (flat).
      var treeMode = blockState.groupBy === 'tree'
      if (blockState.groupBy === 'flat') {
        var flatMembers = []
        for (var fg = 0; fg < groups.length; fg += 1) flatMembers = flatMembers.concat(groups[fg].members)
        flatMembers.sort(memberComparator(pinned))
        groups = [{ title: '', id: '', key: '__flat__', members: flatMembers }]
      }
      if (total === 0 && needleOf().length === 0) {
        html += '<div class="drh-empty" style="padding:6px 9px;font-size:12px;color:var(--dsw-alias-label-tertiary)">暂无远端工作区</div>'
      } else if (total === 0) {
        html += '<div class="drh-empty" style="padding:6px 9px;font-size:12px;color:var(--dsw-alias-label-tertiary)">无匹配会话</div>'
      } else {
        html += '<div class="drh-list">'
        for (var g = 0; g < groups.length; g += 1) {
          var group = groups[g]
          var flat = group.key === '__flat__'
          var open = flat === true || blockState.expanded.has(group.key) === true
          if (flat !== true) {
            html += '<div class="drh-groupSection">' +
              '<div class="drh-projectRow' + (blockState.menuTarget === 'group:' + group.key ? ' menuOpen' : '') + '" draggable="true" role="treeitem" aria-expanded="' + (open ? 'true' : 'false') + '" data-drh-group="' + esc(group.key) + '">' +
                // The shipped project row leads with the folder and swaps it for the filled
              // triangle on hover; the triangle points right closed and rotates down open.
              '<span class="drh-slot drh-chevron">' + arrowSvg(open) + '</span>' +
                '<span class="drh-slot drh-folder' + (open ? ' drh-folderActive' : '') + '">' + sprite(open ? folderOpenIcon : folderIcon, 16) + '</span>' +
                '<span class="drh-title">' + esc(group.title) + '</span>' +
                '<div class="drh-rowActions">' +
                  '<button type="button" class="drh-rowAction" data-drh-groupmenu="true" aria-label="工作区“' + esc(group.title) + '”的操作" title="目录操作">' + sprite(ellipsisIcon, 16) + '</button>' +
                  '<button type="button" class="drh-rowAction" data-drh-groupnewchat="true" aria-label="在“' + esc(group.title) + '”中新建会话" title="新建会话">' + sprite(newChatIcon, 14) + '</button>' +
                '</div>' +
              '</div>'
          }
          if (open === true) {
            group.members.sort(memberComparator(pinned))
            if (treeMode === true) html += '<div class="drh-treeIndent">'
            for (var m = 0; m < group.members.length; m += 1) {
              var row = group.members[m]
              html += '<div class="drh-sessionRow' + (blockState.current === row.id ? ' selected' : '') + (blockState.menuTarget === 'session:' + row.id ? ' menuOpen' : '') + '" role="treeitem" data-drh-session="' + esc(row.id) + '" data-drh-row="true">' +
                // Shipping parity: the shipped running-state spinner sits in the leading seat.
                (isRunningRemote(row.id) === true ? stateDotMarkup() : '') +
                '<span class="drh-title">' + esc(row.title) + '</span>' +
                // Resting cluster (time) yields to the actions cluster on hover, like the
                // shipped row: the ported stylesheet owns both states.
                '<span class="drh-rowResting">' +
                  '<span class="drh-time drh-timestamp">' + esc(row.time) + '</span>' +
                '</span>' +
                '<div class="drh-rowActions">' +
                  '<button type="button" class="drh-rowAction" data-drh-rowmenu="true" aria-label="会话“' + esc(row.title) + '”的操作" title="会话操作">' + sprite(ellipsisIcon, 16) + '</button>' +
                  '<button type="button" class="drh-rowAction" data-drh-rowarchive="true" aria-label="归档会话" title="归档">' + sprite(archiveIcon, 14) + '</button>' +
                  '<button type="button" class="drh-rowAction" data-drh-rowpin="true" aria-label="' + (pinned.has(row.id) ? '取消置顶' : '置顶会话') + '" title="' + (pinned.has(row.id) ? '取消置顶' : '置顶') + '">' + sprite(pinned.has(row.id) ? pinFillIcon : pinIcon, 14) + '</button>' +
                '</div>' +
              '</div>'
            }
            if (treeMode === true) html += '</div>'
          }
          if (flat !== true) html += '</div>'
        }
        html += '</div>'
      }
      // Writing innerHTML discards every node under the block, including whichever input the
      // user is typing in. Remember that focus (kind + caret) and restore it after the paint.
      var focusedKind = null
      var focusedCaret = 0
      try {
        var active = document.activeElement
        if (active !== null && active !== undefined && typeof active.getAttribute === 'function') {
          if (active.getAttribute('data-drh-search') === 'true') focusedKind = 'search'
          if (focusedKind !== null) focusedCaret = typeof active.selectionStart === 'number' ? active.selectionStart : 0
        }
      } catch (error) { /* focus restore is best effort */ }
      // Writing innerHTML discards every node under the block. Skipping an identical paint
      // keeps the 3s refresh free while nothing changed.
      var written = blockState.html !== html
      // ...but "the baseline differs" is not the same as "this paint replaced the list":
      // a patch never touches innerHTML, and the baseline is only refreshed by a rewrite,
      // so it stays stale after any patch. Focus restore and the diagnostics flag have to
      // key on the real rewrite, or a state-only refresh claims a rewrite that never
      // happened (and needlessly re-focuses the search box).
      var rewrote = structuralChanged === true && written === true
      if (structuralChanged !== true) {
        // Only row state or the connection dot moved: patch in place, never rebuild.
        if (plan.state === true) patchBlockRows(container, rowsNow, marksNow.pinned, { pin: pinIcon, pinFill: pinFillIcon })
      } else if (written === true) {
        blockState.html = html
        // Repaint only the list: the section header is built once and then left alone, so its
        // label text cannot blink once per refresh. Only the header's own shape — the search
        // toggle or a label change — replaces it; the connection status lives in the dot, which
        // is patched in place below.
        var oldHeader = container.querySelector('.drh-sectionHeader')
        if (oldHeader === null || oldHeader === undefined) {
          container.innerHTML = html
        } else {
          var template = document.createElement('div')
          template.innerHTML = html
          var newHeader = template.querySelector('.drh-sectionHeader')
          if (newHeader !== null && newHeader !== undefined && plan.header === true) {
            var host = oldHeader.parentNode
            host.replaceChild(newHeader, oldHeader)
            oldHeader = newHeader
          } else if (newHeader !== null && newHeader !== undefined) {
            // Same shape: drop the fresh copy instead of appending it, or the sibling loop
            // below would add a second header row.
            if (newHeader.parentNode !== null && newHeader.parentNode !== undefined) newHeader.parentNode.removeChild(newHeader)
          }
          var next = oldHeader.nextSibling
          while (next !== null && next !== undefined) {
            var following = next.nextSibling
            next.parentNode.removeChild(next)
            next = following
          }
          var host2 = oldHeader.parentNode
          while (template.firstChild !== null) host2.appendChild(template.firstChild)
        }
      }
      if (rewrote === true && focusedKind !== null) {
        try {
          var refocus = container.querySelector('[data-drh-search="true"]')
          if (refocus !== null) {
            refocus.focus()
            if (typeof refocus.setSelectionRange === 'function') refocus.setSelectionRange(focusedCaret, focusedCaret)
          }
        } catch (error) { /* focus restore is best effort */ }
      }
      // The dot is the one part of the header that may change between rebuilds: patch its
      // state here so a mux flap never has to rebuild the label it sits next to.
      patchHeaderDot(container, statusNow)
      container.setAttribute('data-drh-count', String(total))
      try {
        globalThis.__DRH_DIAG2__ = {
          inst: BLOCK_INSTANCE,
          connected: document.contains(container),
          isDocBlock: document.querySelector('#drh-remote-block') === container,
          blocks: document.querySelectorAll('#drh-remote-block').length,
          written: rewrote,
          groupBy: blockState.groupBy,
          orderBy: blockState.orderBy,
          filter: blockState.filter,
          createdCount: blockState.created.length,
          groupTitles: groups.slice(0, 3).map(function (group) { return group.title }),
          expanded: Array.from(blockState.expanded),
          rows: container.querySelectorAll('.drh-sessionRow').length,
        }
      } catch (error) { /* diagnostic only */ }
      ensureBlockExtras()
    }

    /** Hover reveal for the row actions; kept out of the ported stylesheet. */
    function ensureBlockExtras() {
      try {
        if (document.getElementById('drh-block-extra') !== null) return
        var style = document.createElement('style')
        style.id = 'drh-block-extra'
        style.textContent = [
          // Only layout guards live here: the row's hover fill, its resting/actions swap and the
          // title unclip all come from the ported (native) stylesheet.
          '[data-drh-row]{display:flex !important;flex-wrap:nowrap !important;align-items:center !important}',
          '[data-drh-row] .drh-title{flex:1 1 0% !important;min-width:0 !important}',
          '[data-drh-row] .drh-rowResting{flex:0 0 auto !important;white-space:nowrap !important}',
          '[data-drh-row] .drh-rowActions{flex:0 0 auto !important}',
        ].join('')
        document.head.appendChild(style)
      } catch (error) { /* cosmetic */ }
    }
    function needleOf() { return blockState.query.trim() }

    function mountBlock(ctx) {
      try {
        ensureBlockStyles()
        // Host home abbreviates a Session path in the hover card, like the shipped card.
        try {
          var hostFacts = ctx.remote === undefined || ctx.remote === null ? undefined : ctx.remote.$host
          if (hostFacts !== null && hostFacts !== undefined && typeof hostFacts.home === 'string') blockState.home = hostFacts.home
        } catch (error) { /* abbreviation is cosmetic */ }
        var host = document.querySelector('[data-slot="sidebar.workspaces"]')
        if (host === null) return false
        var container = blockState.container
        if (container !== null && document.contains(container) === true) return true
        // The shipped sidebar re-renders around this block: React can drop our node from the
        // document without telling anyone. Reusing a detached element would paint into an
        // orphan, so rebuild it (with fresh listeners) and force the next paint.
        if (container !== null) {
          try { container.remove() } catch (error) { /* already detached */ }
          blockState.container = null
          blockState.signature = ''
          blockState.html = ''
          container = null
        }
        if (container === null) {
          container = document.createElement('div')
          container.className = 'drh-root'
          container.id = 'drh-remote-block'
          container.setAttribute('data-drh-inst', String(BLOCK_INSTANCE))
          container.setAttribute('data-drh-block', 'true')
          container.addEventListener('click', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            if (target.closest('[data-drh-searchopen]') !== null && target.closest('[data-drh-searchopen]') !== undefined) {
              blockState.searchOpen = true
              renderBlock(true)
              var searchInputEl = document.querySelector('#drh-remote-block .drh-searchInput')
              if (searchInputEl !== null) searchInputEl.focus()
              return
            }
            if (target.closest('[data-drh-searchclose]') !== null && target.closest('[data-drh-searchclose]') !== undefined) {
              blockState.searchOpen = false
              blockState.query = ''
              renderBlock(true)
              return
            }
            var groupMenuBtn = target.closest('[data-drh-groupmenu]')
            if (groupMenuBtn !== null && groupMenuBtn !== undefined) {
              var groupRowEl = groupMenuBtn.closest('[data-drh-group]')
              if (groupRowEl !== null && groupRowEl !== undefined) {
                var keyOf = groupRowEl.getAttribute('data-drh-group')
                var foundGroup = blockRows().filter(function (group) { return group.key === keyOf })[0]
                if (foundGroup !== undefined) {
                  var rect = groupMenuBtn.getBoundingClientRect()
                  openGroupMenu(ctx, rect, rect.bottom + 4, foundGroup)
                }
              }
              return
            }
            var viewMenuBtn = target.closest('[data-drh-viewmenu]')
            if (viewMenuBtn !== null && viewMenuBtn !== undefined) {
              var viewRect = viewMenuBtn.getBoundingClientRect()
              openViewMenu(viewRect, viewRect.bottom + 4)
              return
            }
            var addSpaceBtn = target.closest('[data-drh-newspace]')
            if (addSpaceBtn !== null && addSpaceBtn !== undefined) {
              openNewSpacePanel(addSpaceBtn)
              return
            }
            var rowMenuBtn = target.closest('[data-drh-rowmenu]')
            if (rowMenuBtn !== null && rowMenuBtn !== undefined) {
              event.stopPropagation()
              var menuRow = rowMenuBtn.closest('[data-drh-session]')
              if (menuRow !== null && menuRow !== undefined) {
                var menuId = menuRow.getAttribute('data-drh-session')
                var menuRect = rowMenuBtn.getBoundingClientRect()
                openBlockMenu(ctx, menuRect, menuRect.bottom + 4, menuId, marksState().pinned.has(menuId))
              }
              return
            }
            // Archive and pin act immediately, like the shipped row buttons; only the menu opens.
            var rowArchiveBtn = target.closest('[data-drh-rowarchive]')
            if (rowArchiveBtn !== null && rowArchiveBtn !== undefined) {
              event.stopPropagation()
              var archiveRow = rowArchiveBtn.closest('[data-drh-session]')
              if (archiveRow !== null && archiveRow !== undefined) applyRowAction(ctx, 'archive', archiveRow.getAttribute('data-drh-session'))
              return
            }
            var rowPinBtn = target.closest('[data-drh-rowpin]')
            if (rowPinBtn !== null && rowPinBtn !== undefined) {
              event.stopPropagation()
              var pinRow = rowPinBtn.closest('[data-drh-session]')
              if (pinRow !== null && pinRow !== undefined) {
                var pinId = pinRow.getAttribute('data-drh-session')
                applyRowAction(ctx, marksState().pinned.has(pinId) ? 'unpin' : 'pin', pinId)
              }
              return
            }
            var groupNewChatBtn = target.closest('[data-drh-groupnewchat]')
            if (groupNewChatBtn !== null && groupNewChatBtn !== undefined) {
              event.stopPropagation()
              var chatGroupRow = groupNewChatBtn.closest('[data-drh-group]')
              if (chatGroupRow !== null && chatGroupRow !== undefined) {
                var chatKey = chatGroupRow.getAttribute('data-drh-group')
                var chatGroup = blockRows().filter(function (group) { return group.key === chatKey })[0]
                if (chatGroup !== undefined) void startSessionInGroup(ctx, chatGroup)
              }
              return
            }
            var groupRow = target.closest('[data-drh-group]')
            if (groupRow !== null && groupRow !== undefined) {
              var key = groupRow.getAttribute('data-drh-group')
              if (blockState.expanded.has(key) === true) blockState.expanded.delete(key)
              else blockState.expanded.add(key)
              renderBlock(true)
              return
            }
            var sessionRow = target.closest('[data-drh-session]')
            if (sessionRow !== null && sessionRow !== undefined) {
              var openId = sessionRow.getAttribute('data-drh-session')
              // The shipped row opens through uiWorkspace.openSession, which retains the
              // Session in the client catalog. A Session the mounted host owns is absent from
              // that catalog (the shim keeps remote rows out of the shipped list), so the call
              // is refused synchronously. Only paint the row as current when it really opened,
              // and report the refusal instead of leaving a cosmetic-only highlight.
              var openError = null
              try {
                var pendingOpen = openRemoteSession(ctx, openId, blockSummaries().get(openId))
                if (pendingOpen !== null && pendingOpen !== undefined && typeof pendingOpen.then === 'function') {
                  pendingOpen.catch(function (error) { reportOpenFailure(openId, error) })
                }
              } catch (error) {
                openError = error
              }
              if (openError === null) {
                blockState.current = openId
                renderBlock(true)
              } else {
                reportOpenFailure(openId, openError)
              }
            }
          })
          container.addEventListener('mouseover', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var row = target.closest('[data-drh-session]')
            if (row === null || row === undefined) return
            if (blockState.hoverTimer !== null && blockState.hoverTimer !== undefined) clearTimeout(blockState.hoverTimer)
            blockState.hoverTimer = setTimeout(function () { showHoverCard(row) }, 800)
          })
          container.addEventListener('mouseout', function (event) {
            var target = event.target
            if (target !== null && target !== undefined && target.closest !== undefined && target.closest('[data-drh-session]') === null) return
            if (blockState.hoverTimer !== null && blockState.hoverTimer !== undefined) clearTimeout(blockState.hoverTimer)
            blockState.hoverTimer = null
            // The shipped preview stays hit-testable: crossing the gap onto the card keeps
            // it open, so only a row exit with the pointer elsewhere dismisses it.
            if (blockState.hoverHold === true) return
            var related = event.relatedTarget
            var card = document.getElementById('drh-hovercard')
            if (related !== null && related !== undefined && card !== null && card.contains(related) === true) return
            closeHoverCard()
          })
          // A scrolled-away row must not leave its card behind. The window half of this
          // pair is registered once per install (see installRemoteBlock): mounting again
          // must not stack another window listener.
          container.addEventListener('scroll', function () { closeHoverCard() }, true)
          container.addEventListener('contextmenu', function (event) {
            var hit = event.target
            if (hit !== null && hit !== undefined && hit.closest !== undefined) {
              var groupHit = hit.closest('[data-drh-group]')
              if (groupHit !== null && groupHit !== undefined) {
                event.preventDefault()
                var groupKey = groupHit.getAttribute('data-drh-group')
                var found = blockRows().filter(function (group) { return group.key === groupKey })[0]
                if (found !== undefined) openGroupMenu(ctx, { left: event.clientX, right: event.clientX }, event.clientY, found)
                return
              }
            }
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var row = target.closest('[data-drh-session]')
            if (row === null || row === undefined) return
            event.preventDefault()
            var id = row.getAttribute('data-drh-session')
            openBlockMenu(ctx, event.clientX, event.clientY, id, blockState.pinned.has(id))
          })
          container.addEventListener('dragstart', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var row = target.closest('[data-drh-group]')
            if (row === null || row === undefined) return
            blockState.dragging = row.getAttribute('data-drh-group')
            try { event.dataTransfer.setData('text/plain', blockState.dragging) } catch (error) { /* ignore */ }
          })
          container.addEventListener('dragover', function (event) {
            if (blockState.dragging === null || blockState.dragging === undefined) return
            event.preventDefault()
          })
          container.addEventListener('drop', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var row = target.closest('[data-drh-group]')
            if (row === null || row === undefined) return
            var from = blockState.dragging
            var to = row.getAttribute('data-drh-group')
            blockState.dragging = null
            if (from === null || from === undefined || from === to) return
            event.preventDefault()
            var keys = blockRows().map(function (group) { return group.key })
            var order = loadBlockOrder().filter(function (key) { return keys.indexOf(key) !== -1 })
            for (var i = 0; i < keys.length; i += 1) if (order.indexOf(keys[i]) === -1) order.push(keys[i])
            var fromAt = order.indexOf(from)
            var toAt = order.indexOf(to)
            if (fromAt === -1 || toAt === -1) return
            order.splice(fromAt, 1)
            order.splice(toAt, 0, from)
            saveBlockOrder(order)
            renderBlock(true)
          })
          container.addEventListener('dragend', function () { blockState.dragging = null })
          container.addEventListener('keydown', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.getAttribute === undefined) return
            if (event.key !== 'Escape') return
            if (target.getAttribute('data-drh-search') !== 'true') return
            event.preventDefault()
            blockState.searchOpen = false
            blockState.query = ''
            renderBlock(true)
          })
          container.addEventListener('input', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.getAttribute === undefined) return
            if (target.getAttribute('data-drh-search') !== 'true') return
            blockState.query = target.value
            renderBlock(true)
          })
          blockState.container = container
        }
        var parent = host.parentElement
        if (parent === null) return false
        // A previous instance can still own a block with the same id: a duplicate script load
        // keeps both alive, and a replacement can mount before the old fiber's effect disposes
        // it. Queries would then hit the stale one while clicks land on the new one, so sweep
        // the residue even though the effect disposer removes this instance's own node.
        var duplicates = document.querySelectorAll('#drh-remote-block')
        for (var di = 0; di < duplicates.length; di += 1) {
          if (duplicates[di] !== container) duplicates[di].remove()
        }
        parent.insertBefore(container, host.nextSibling)
        renderBlock(true)
        return true
      } catch (error) { return false }
    }

    /** Row context menu: the actions the shipped list offers in its own menu. */
    function closeBlockMenu() {
      var open = document.getElementById('drh-block-menu')
      if (open !== null) {
        if (open.__outside !== undefined) document.removeEventListener('mousedown', open.__outside, true)
        open.remove()
      }
      if (blockState.menuTarget !== null && blockState.menuTarget !== undefined) {
        blockState.menuTarget = null
        renderBlock(true)
      }
    }

    /** Inline title editor for a merged group, matching the shipped row look. */
    function startInlineRename(ctx, group) {
      try {
        var row = document.querySelector('[data-drh-group="' + group.key.replace(/"/g, '\"') + '"]')
        if (row === null) return
        var title = row.querySelector('.drh-title')
        if (title === null) return
        var input = document.createElement('input')
        input.value = group.title
        input.setAttribute('data-drh-rename', 'true')
        input.style.cssText = 'flex:1 1 0%;min-width:0;font:inherit;font-size:14px;padding:1px 4px;border-radius:4px;border:1px solid var(--dsw-alias-line-active, #4d6bfe);background:var(--dsw-alias-bg-elevated, #fff);color:inherit;outline:none'
        blockState.editing = group.key
        title.replaceWith(input)
        input.focus()
        input.select()
        var finish = function (commit) {
          var next = input.value.trim()
          try {
            if (commit === true && next.length > 0 && next !== group.title && group.id.length > 0) {
              ctx.get('workspaces').renameWorkspace(group.id, next).catch(function () {})
            }
          } catch (error) { /* ignore */ }
          blockState.editing = null
          renderBlock(true)
        }
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); finish(true) }
          else if (event.key === 'Escape') { event.preventDefault(); finish(false) }
        })
        input.addEventListener('blur', function () { finish(false) })
      } catch (error) { /* ignore */ }
    }

    /** Workspace-level actions for a merged remote group: rename and delete. */
    /**
     * Folder-row menu on the shared popup surface (the shipped menu atoms), so it is the
     * frosted card rather than the old self-drawn opaque panel. Actions address the mounted
     * host; a capability the remote cannot offer stays visible but disabled, like the
     * shipped menu does for unavailable rows.
     */
    function openGroupMenu(ctx, anchor, y, group) {
      closeBlockMenu()
      var id = group.id
      // The shipped folder menu is a fixed 144px card holding three rows.
      var surface = menuSurface(144, false)
      // The shipped rows, in the shipped order: rename, reveal, then delete below a rule.
      menuItem(surface, { key: 'rename', label: '重命名', icon: pickIcon(['dsw-icon-edit-outline-regular', 'dsw-icon-list-pen-outline-regular']) })
      menuItem(surface, {
        key: 'reveal', label: '在 Finder 中显示',
        icon: pickIcon(['dsw-icon-folder-open-outline-regular', 'dsw-icon-folder-close-regular']),
        disabled: true, title: '远端工作区没有本机 Finder 位置',
      })
      menuSeparator(surface)
      var remove = menuItem(surface, {
        key: 'delete', label: '删除工作区',
        icon: pickIcon(['dsw-icon-trash-outline-regular', 'dsw-icon-archive-off-outline-regular']),
      })
      remove.classList.add('drh-menuDanger')
      bindMenuKeys(surface, closeBlockMenu)
      surface.addEventListener('click', function (event) {
        var hit = event.target
        var button = hit !== null && hit !== undefined && hit.closest !== undefined ? hit.closest('[data-drh-menu]') : null
        if (button === null || button === undefined) return
        if (button.getAttribute('aria-disabled') === 'true') return
        var kind = button.getAttribute('data-drh-menu')
        closeBlockMenu()
        if (kind === 'rename') startInlineRename(ctx, group)
        else if (kind === 'delete') {
          if (id.length === 0) { notifyBlock('该分组没有可用的远端工作区标识', true); return }
          if (window.confirm('删除远端工作区「' + group.title + '」？文件夹与会话记录会保留。')) {
            try { ctx.get('workspaces').deleteWorkspace(id).catch(function () { notifyBlock('远端删除失败', true) }) }
            catch (error) { notifyBlock('远端删除失败：' + describeError(error), true) }
          }
        }
      })
      blockState.menuTarget = 'group:' + group.key
      renderBlock(true)
      showMenu(surface, anchor, y, 'end')
    }

    /** Human-readable reason for a refused or failed row action. */
    function describeError(error) {
      if (error === null || error === undefined) return '未知错误'
      var rpc = error.rpcError
      if (rpc !== null && rpc !== undefined && typeof rpc === 'object') {
        var code = typeof rpc.code === 'string' ? rpc.code : ''
        var message = typeof rpc.message === 'string' ? rpc.message : ''
        if (code.length > 0) return code + (message.length > 0 ? '：' + message : '')
        if (message.length > 0) return message
      }
      return String(error.message !== null && error.message !== undefined ? error.message : error)
    }

    /**
     * Run one row action through the shipped services.
     *
     * The pin set carries an optimistic entry so the row reacts on click, but a host refusal
     * (an archived session cannot be pinned, for one) has to take that entry back: a phantom
     * pin would show a glyph the host does not have.
     */
    function applyRowAction(ctx, kind, id) {
      if (kind !== 'pin' && kind !== 'unpin' && kind !== 'archive') return
      var call
      try {
        if (kind === 'pin') { blockState.pinned.add(id); call = ctx.uiWorkspace.pinSession(id) }
        else if (kind === 'unpin') { blockState.pinned.delete(id); call = ctx.uiWorkspace.unpinSession(id) }
        else call = ctx.uiWorkspace.archiveSession(id)
      } catch (error) {
        if (kind === 'pin') blockState.pinned.delete(id)
        if (kind === 'unpin') blockState.pinned.add(id)
        notifyBlock((kind === 'pin' ? '置顶失败' : kind === 'unpin' ? '取消置顶失败' : '归档失败') + '：' + describeError(error), true)
        renderBlock(true)
        return
      }
      renderBlock(true)
      Promise.resolve(call).then(function () {
        renderBlock(true)
        // A resolved call is not proof that the mounted host changed: re-read the marks it
        // publishes from its own workspace baseline and report a mismatch, so a no-op can
        // never look like a successful action again.
        setTimeout(function () {
          try {
            var host = globalThis.__DSH_REMOTE_HOST_MARKS__
            if (host === null || host === undefined) return
            var applied = kind === 'pin'
              ? (Array.isArray(host.pinned) && host.pinned.indexOf(id) !== -1)
              : (kind === 'unpin'
                ? (Array.isArray(host.pinned) && host.pinned.indexOf(id) === -1)
                : (Array.isArray(host.archived) && host.archived.indexOf(id) !== -1))
            if (applied === true) return
            if (kind === 'pin') blockState.pinned.delete(id)
            if (kind === 'unpin') blockState.pinned.add(id)
            notifyBlock((kind === 'archive' ? '远端归档未生效' : kind === 'pin' ? '远端置顶未生效' : '远端取消置顶未生效') + '：远端状态未确认', true)
            renderBlock(true)
          } catch (error) { /* confirmation is best effort */ }
        }, 900)
      }, function (error) {
        if (kind === 'pin') blockState.pinned.delete(id)
        else if (kind === 'unpin') blockState.pinned.add(id)
        notifyBlock((kind === 'pin' ? '置顶失败' : kind === 'unpin' ? '取消置顶失败' : '归档失败') + '：' + describeError(error), true)
        renderBlock(true)
      })
    }

    /* ---- Popups ------------------------------------------------------- *
     * Structure and metrics are ported from the shipped menu: a transparent
     * surface, an inset frosted material layer (plus the darwin backing), and a
     * column viewport. The view-options menu is the dense variant (30px rows);
     * the row menu keeps the 34px rows. Selection is a trailing check glyph.
     * ------------------------------------------------------------------ */

    function menuSurface(width, dense) {
      var surface = document.createElement('div')
      surface.className = 'drh-menuSurface' + (dense === true ? ' drh-menuDense' : '')
      surface.id = 'drh-block-menu'
      surface.setAttribute('role', 'menu')
      if (width > 0) surface.style.width = width + 'px'
      var material = document.createElement('div')
      material.className = 'drh-menuMaterial'
      surface.appendChild(material)
      var backing = document.createElement('div')
      backing.className = 'drh-menuBacking'
      surface.appendChild(backing)
      var viewport = document.createElement('div')
      viewport.className = 'drh-menuViewport'
      surface.appendChild(viewport)
      surface.__viewport = viewport
      return surface
    }

    function menuLabel(surface, text) {
      var label = document.createElement('div')
      label.className = 'drh-menuLabel'
      label.textContent = text
      surface.__viewport.appendChild(label)
    }

    function menuSeparator(surface) {
      var line = document.createElement('div')
      line.className = 'drh-menuSeparator'
      surface.__viewport.appendChild(line)
    }

    /** One shipped menu row: icon, label, optional shortcut and selection check. */
    function menuItem(surface, spec) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'drh-menuItem'
      var radio = spec.selected !== undefined
      button.setAttribute('role', radio ? 'menuitemradio' : 'menuitem')
      if (radio) button.setAttribute('aria-checked', spec.selected === true ? 'true' : 'false')
      if (typeof spec.key === 'string') button.setAttribute('data-drh-menu', spec.key)
      if (spec.disabled === true) {
        button.setAttribute('aria-disabled', 'true')
        button.disabled = true
        if (typeof spec.title === 'string') button.title = spec.title
      }
      if (typeof spec.icon === 'string' && spec.icon.length > 0) {
        var icon = document.createElement('span')
        icon.className = 'drh-menuIcon'
        icon.setAttribute('aria-hidden', 'true')
        icon.innerHTML = sprite(spec.icon, 16)
        button.appendChild(icon)
      }
      var text = document.createElement('span')
      text.className = 'drh-menuText'
      text.textContent = spec.label
      button.appendChild(text)
      if (typeof spec.shortcut === 'string' && spec.shortcut.length > 0) {
        var shortcut = document.createElement('span')
        shortcut.className = 'drh-menuShortcut'
        shortcut.textContent = spec.shortcut
        button.appendChild(shortcut)
      }
      if (spec.selected === true) {
        var check = document.createElement('span')
        check.className = 'drh-menuCheck'
        check.setAttribute('aria-hidden', 'true')
        check.innerHTML = sprite(pickIcon(['dsw-icon-check-outline-regular', 'dsw-icon-check-regular', 'dsw-icon-check-fill-regular']), 14)
        button.appendChild(check)
      }
      surface.__viewport.appendChild(button)
      return button
    }

    /**
     * Append, reveal and clamp a menu; owns its outside-click dismissal.
     * The shipped popup is end-anchored on the trigger's right edge, so the card's right
     * edge lines up with it; a pointer anchor keeps start alignment. Both viewport edges
     * keep an 8px safety margin.
     */
    function showMenu(surface, anchor, y, align) {
      document.body.appendChild(surface)
      surface.setAttribute('data-menu-phase', 'enter')
      var rect = surface.getBoundingClientRect()
      var wanted = align === 'start' ? anchor.left : anchor.right - rect.width
      var left = Math.max(8, Math.min(wanted, window.innerWidth - rect.width - 8))
      var top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y
      surface.style.left = left + 'px'
      surface.style.top = top + 'px'
      var outside = function (event) {
        if (surface.contains(event.target) !== true) closeBlockMenu()
      }
      surface.__outside = outside
      setTimeout(function () { document.addEventListener('mousedown', outside, true) }, 0)
      var first = surface.querySelector('.drh-menuItem:not([aria-disabled="true"])')
      if (first !== null) first.focus()
    }

    /** Arrow/Home/End move real focus; Escape and Tab dismiss. */
    function bindMenuKeys(surface, onClose) {
      surface.addEventListener('keydown', function (event) {
        var items = Array.prototype.slice.call(surface.querySelectorAll('.drh-menuItem:not([aria-disabled="true"])'))
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
        if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
        if (items.length === 0) return
        var at = items.indexOf(document.activeElement)
        if (event.key === 'ArrowDown') { event.preventDefault(); items[(at + 1) % items.length].focus() }
        else if (event.key === 'ArrowUp') { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus() }
        else if (event.key === 'Home') { event.preventDefault(); items[0].focus() }
        else if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus() }
      })
    }

    /** Shipped view-options menu: three labelled groups of radio rows. */
    var VIEW_SECTIONS = [
      {
        label: '分组方式',
        items: [
          { key: 'group:workspace', label: '按工作区', icon: 'dsw-icon-folder-close-regular' },
          { key: 'group:tree', label: '按工作区树', icon: 'dsw-icon-workspace-tree-outline-regular' },
          { key: 'group:flat', label: '单列表', icon: 'dsw-icon-flat-list-outline-regular' },
        ],
      },
      {
        label: '排序方式',
        items: [
          { key: 'order:manual', label: '手动排序', icon: 'dsw-icon-chevrons-up-down-outline-regular' },
          { key: 'order:updated', label: '最近更新', icon: 'dsw-icon-clock-outline-regular' },
        ],
      },
      {
        label: '筛选会话',
        items: [
          { key: 'filter:hide', label: '隐藏已归档', icon: 'dsw-icon-archive-off-outline-regular' },
          { key: 'filter:all', label: '全部对话（显示已归档）', icon: 'dsw-icon-queue-outline-regular' },
          { key: 'filter:only', label: '仅显示已归档', icon: 'dsw-icon-archive-check-outline-regular' },
        ],
      },
    ]

    function openViewMenu(anchor, y) {
      closeBlockMenu()
      var surface = menuSurface(200, true)
      for (var s = 0; s < VIEW_SECTIONS.length; s += 1) {
        if (s > 0) menuSeparator(surface)
        menuLabel(surface, VIEW_SECTIONS[s].label)
        var group = VIEW_SECTIONS[s].items
        for (var i = 0; i < group.length; i += 1) {
          var spec = group[i]
          var current = spec.key.indexOf('group:') === 0
            ? blockState.groupBy === spec.key.slice(6)
            : (spec.key.indexOf('order:') === 0 ? blockState.orderBy === spec.key.slice(6) : blockState.filter === spec.key.slice(7))
          menuItem(surface, { key: spec.key, label: spec.label, icon: spec.icon, selected: current === true })
        }
      }
      bindMenuKeys(surface, closeBlockMenu)
      surface.addEventListener('click', function (event) {
        var hit = event.target
        var button = hit !== null && hit !== undefined && hit.closest !== undefined ? hit.closest('[data-drh-menu]') : null
        if (button === null || button === undefined) return
        var value = button.getAttribute('data-drh-menu')
        if (value.indexOf('group:') === 0) blockState.groupBy = value.slice(6)
        else if (value.indexOf('order:') === 0) blockState.orderBy = value.slice(6)
        else if (value.indexOf('filter:') === 0) blockState.filter = value.slice(7)
        else return
        blockState.html = ''
        closeBlockMenu()
        renderBlock(true)
        assertBlockIntact('view-menu')
      })
      showMenu(surface, anchor, y, 'end')
    }

    /**
     * Post one Remote call straight to the mounted host. The shim only reroutes a request that
     * names a known remote session or workspace id, and a brand-new path names neither, so this
     * call addresses the mount explicitly.
     */
    async function remoteRpc(method, args) {
      var mount = typeof config.mount === 'string' && config.mount.length > 0 ? config.mount : '/devbox'
      var rpcId = 'drh-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
      var response
      try {
        response = await globalThis.fetch(mount + '/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: rpcId, method: method, payload: { args: args } }),
        })
      } catch (error) {
        // A network blip must read as a failed call, not an unhandled rejection: every
        // caller here is fire-and-forget from a click handler.
        return { ok: false, error: { code: 'gateway/remote-unavailable', message: '远端连接中断，请稍后重试（' + method + '）' } }
      }
      var envelope
      try {
        envelope = await response.json()
      } catch (error) {
        return { ok: false, error: { code: 'gateway/bad-response', message: '远端返回了无法解析的响应（HTTP ' + String(response.status) + '）' } }
      }
      var result = envelope === null || typeof envelope !== 'object' ? undefined : envelope.result
      if (result === null || result === undefined || typeof result !== 'object') {
        return { ok: false, error: { code: 'gateway/bad-response', message: '远端返回了无法解析的响应（HTTP ' + String(response.status) + '）' } }
      }
      return result
    }

    /**
     * Create a Session inside one remote Workspace — the shipped folder-row action.
     * Verification never clicks it (it mutates the mounted host); it issues the same Remote
     * call the shipped button does and reports the outcome in the block.
     */
    async function startSessionInGroup(ctx, group) {
      if (group === null || group === undefined || typeof group.id !== 'string' || group.id.length === 0) {
        notifyBlock('该分组没有可用的远端工作区标识，无法新建会话', true)
        return
      }
      try {
        var result = await remoteRpc('session/create', { request: { workspaceId: group.id } })
        if (result.ok === true) {
          notifyBlock('已在远端工作区新建会话')
          return
        }
        var error = result.error === null || result.error === undefined ? {} : result.error
        var code = typeof error.code === 'string' ? error.code : 'unknown'
        var message = typeof error.message === 'string' ? error.message : '未知错误'
        notifyBlock('远端新建会话失败（' + code + '）：' + message, true)
      } catch (error) {
        notifyBlock('远端新建会话失败：' + String(error !== null && error !== undefined && error.message ? error.message : error), true)
      }
    }

    /**
     * Report a refused open. The shipped entry point retains the Session in the client
     * catalog, so a Session the mounted host owns cannot be opened by this renderer; that is
     * a limitation to state, not to hide behind a silent catch.
     */
    function reportOpenFailure(sessionId, error) {
      var reason = describeError(error)
      try { console.error('[dsh-remote-host] cannot open remote session ' + sessionId + ': ' + reason) } catch (ignored) { /* diagnostics only */ }
      notifyBlock('无法打开远端会话：' + reason, true)
    }

    /** Inline feedback for an action the block cannot show as a row change. */
    function notifyBlock(text, isError) {
      try {
        var stale = document.getElementById('drh-block-toast')
        if (stale !== null) stale.remove()
        var toast = document.createElement('div')
        toast.id = 'drh-block-toast'
        toast.className = 'drh-menuSurface drh-toastSurface' + (isError === true ? ' drh-toastError' : '')
        var toastMaterial = document.createElement('div')
        toastMaterial.className = 'drh-menuMaterial'
        toast.appendChild(toastMaterial)
        var toastBacking = document.createElement('div')
        toastBacking.className = 'drh-menuBacking'
        toast.appendChild(toastBacking)
        var toastText = document.createElement('div')
        toastText.className = 'drh-toastText'
        toastText.textContent = text
        toast.appendChild(toastText)
        document.body.appendChild(toast)
        setTimeout(function () { try { toast.remove() } catch (error) { /* ignore */ } }, 7000)
      } catch (error) { /* feedback is best effort */ }
    }

    /** Keep a workspace this block just created visible until the host publishes it. */
    function rememberCreatedSpace(path, workspaceId) {
      var trimmed = String(path).replace(/[/\\]+$/, '')
      var title = trimmed.split(/[/\\]/).pop()
      if (title === undefined || title.length === 0) title = trimmed
      var id = typeof workspaceId === 'string' ? workspaceId : ''
      var key = 'w:' + (id.length > 0 ? id : title)
      for (var i = 0; i < blockState.created.length; i += 1) {
        if (blockState.created[i].key === key) return
      }
      blockState.created.push({ title: title, id: id, key: key })
    }

    /**
     * Self-check the block after an interaction that must not disturb it: the container is
     * still mounted, every group it should show is still painted, and nothing threw.
     */
    function assertBlockIntact(label) {
      try {
        var root = document.getElementById('drh-remote-block')
        var expected = blockRows().length
        var inDoc = root !== null && document.contains(root)
        var groups = root === null ? 0 : root.querySelectorAll('.drh-projectRow').length
        var report = {
          label: label,
          inDoc: inDoc,
          groups: groups,
          expected: expected,
          rows: root === null ? 0 : root.querySelectorAll('.drh-sessionRow').length,
          error: blockState.error,
          intact: inDoc === true && groups === expected,
        }
        globalThis.__DRH_SELFCHECK__ = report
        if (report.intact !== true) console.warn('[dsh-remote-host] block integrity lost after ' + label, report)
        return report
      } catch (error) {
        return null
      }
    }

    /** Close the floating add-workspace panel and its outside-click guard. */
    function closeBlockPanel() {
      var open = document.getElementById('drh-block-panel')
      if (open !== null) open.remove()
      if (blockState.panelGuard !== null && blockState.panelGuard !== undefined) {
        document.removeEventListener('mousedown', blockState.panelGuard)
        blockState.panelGuard = null
      }
    }

    /**
     * "Add remote workspace" entry, aligned with the shipped dialog atoms instead of a
     * bespoke anchored popover: a centered masked modal (root z-index 1000, dialog 380px,
     * radius --dsw-radius-panel, background --dsw-alias-bg-layer-2, elevation
     * --dsw-elevation-prominent, 44px input, 36px footer buttons).
     *
     * The shipped add affordance opens the OS directory chooser, so the shipped *form*
     * dialog (workspace rename) is the reference anatomy for this single-input prompt.
     * Values and their provenance: docs/ui-parity.md section 4.
     * @param anchor - the header button that opened this dialog (focus returns to the list).
     */
    function openNewSpacePanel(anchor) {
      closeBlockMenu()
      closeBlockPanel()
      var root = document.createElement('div')
      root.id = 'drh-block-panel'
      root.className = 'drh-dialogRoot'
      root.setAttribute('role', 'presentation')
      var mask = document.createElement('div')
      mask.className = 'drh-dialogMask'
      root.appendChild(mask)
      var dialog = document.createElement('div')
      dialog.className = 'drh-dialog'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', '添加工作区')
      var header = document.createElement('div')
      header.className = 'drh-dialogHeader'
      var title = document.createElement('div')
      title.className = 'drh-dialogTitle'
      title.textContent = '添加工作区'
      var closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.className = 'drh-dialogClose'
      closeButton.setAttribute('aria-label', '关闭')
      closeButton.innerHTML = sprite(pickIcon(['dsw-icon-close-outline-regular', 'dsw-icon-close-fill-regular']), 16)
      header.appendChild(title)
      header.appendChild(closeButton)
      var body = document.createElement('div')
      body.className = 'drh-dialogBody'
      var input = document.createElement('input')
      input.type = 'text'
      input.className = 'drh-dialogInput'
      input.setAttribute('data-drh-newspaceinput', 'true')
      input.placeholder = '/home/you/project'
      var hint = document.createElement('div')
      hint.className = 'drh-dialogHint'
      hint.textContent = '远端主机上已存在的绝对路径'
      body.appendChild(input)
      body.appendChild(hint)
      var footer = document.createElement('div')
      footer.className = 'drh-dialogFooter'
      var cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'drh-dialogButton'
      cancel.textContent = '取消'
      var confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'drh-dialogButton drh-dialogButtonPrimary'
      confirm.setAttribute('data-drh-newspaceok', 'true')
      confirm.textContent = '添加'
      footer.appendChild(cancel)
      footer.appendChild(confirm)
      dialog.appendChild(header)
      dialog.appendChild(body)
      dialog.appendChild(footer)
      root.appendChild(dialog)

      var submit = function () { void createRemoteWorkspace(input.value) }
      cancel.addEventListener('click', function () { closeBlockPanel() })
      closeButton.addEventListener('click', function () { closeBlockPanel() })
      confirm.addEventListener('click', submit)
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); submit() }
        else if (event.key === 'Escape') { event.preventDefault(); closeBlockPanel() }
      })
      // The shipped modal closes on Escape from anywhere inside it, not just from the field.
      root.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closeBlockPanel() }
      })
      document.body.appendChild(root)
      var guard = function (event) {
        if (dialog.contains(event.target) !== true) closeBlockPanel()
      }
      blockState.panelGuard = guard
      setTimeout(function () { document.addEventListener('mousedown', guard) }, 0)
      input.focus()
      input.select()
      assertBlockIntact('open-add-workspace-panel')
    }

    /** Create a Workspace on the mounted host from the path typed into the panel. */
    async function createRemoteWorkspace(rawPath) {
      var path = String(rawPath === undefined || rawPath === null ? '' : rawPath).trim()
      if (path.length === 0) {
        notifyBlock('请输入远端主机上已存在的绝对路径（例如 /home/you/project）', true)
        return
      }
      if (path.charAt(0) !== '/') {
        notifyBlock('必须是从 / 开始的绝对路径：' + path, true)
        return
      }
      notifyBlock('正在远端添加工作区：' + path)
      try {
        // The Remote descriptor takes one parameter named 'request', so the wire args are
        // { request: { path } } -- a bare { path } is refused as gateway/arguments-invalid.
        var result = await remoteRpc('workspace/create', { request: { path: path } })
        if (result.ok === true) {
          var workspace = result.value === null || result.value === undefined ? undefined : result.value.workspace
          var workspaceId = workspace === null || workspace === undefined ? '' : workspace.workspaceId
          rememberCreatedSpace(path, workspaceId)
          blockState.html = ''
          if (typeof workspaceId === 'string' && workspaceId.length > 0) blockState.expanded.add('w:' + workspaceId)
          closeBlockPanel()
          renderBlock(true)
          notifyBlock('已在远端添加工作区：' + path + '（远端暂无会话，因此该分组先显示为空）')
          assertBlockIntact('create-workspace')
          return
        }
        var error = result.error === null || result.error === undefined ? {} : result.error
        var code = typeof error.code === 'string' ? error.code : 'unknown'
        var message = typeof error.message === 'string' ? error.message : '未知错误'
        notifyBlock('远端添加失败（' + code + '）：' + message, true)
        assertBlockIntact('create-workspace-failed')
      } catch (error) {
        notifyBlock('远端添加失败：' + String(error !== null && error !== undefined && error.message ? error.message : error), true)
        assertBlockIntact('create-workspace-error')
      }
    }

    /** Copy through the shipped clipboard path, with visible feedback. */
    function copyToClipboard(text, okMessage) {
      try {
        if (globalThis.navigator !== undefined && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(function () { notifyBlock(okMessage) }, function () { notifyBlock('复制失败，请重试', true) })
          return
        }
      } catch (error) { /* fall through */ }
      notifyBlock('当前环境不支持剪贴板', true)
    }

    /** Fork one remote Session; the mount creates the child and the block refreshes. */
    async function forkRemoteSession(ctx, sessionId) {
      try {
        var result = await remoteRpc('session/fork', { request: { sessionId: sessionId } })
        if (result.ok === true) {
          var child = result.value !== null && result.value !== undefined && typeof result.value.sessionId === 'string' ? result.value.sessionId : ''
          notifyBlock(child.length > 0 ? '已在远端分叉：' + child.slice(0, 8) : '已在远端分叉会话')
          document.dispatchEvent(new CustomEvent('drh:refresh-sessions', { detail: {} }))
          blockState.html = ''
          renderBlock(true)
          assertBlockIntact('fork-session')
          return
        }
        var error = result.error === null || result.error === undefined ? {} : result.error
        notifyBlock('远端分叉失败（' + (typeof error.code === 'string' ? error.code : 'unknown') + '）：' + (typeof error.message === 'string' ? error.message : '未知错误'), true)
      } catch (error) {
        notifyBlock('远端分叉失败：' + String(error !== null && error !== undefined && error.message ? error.message : error), true)
      }
    }

    /** Rename dialog in the shipped popup surface. */
    function openRenamePanel(sessionId, summary) {
      closeBlockMenu()
      var surface = menuSurface(272, false)
      surface.removeAttribute('role')
      var input = document.createElement('input')
      input.type = 'text'
      input.className = 'drh-menuInput'
      input.setAttribute('data-drh-renameinput', 'true')
      input.value = summary === undefined || summary.title === undefined ? '' : String(summary.title)
      surface.__viewport.appendChild(input)
      var row = document.createElement('div')
      row.className = 'drh-menuButtons'
      var cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'drh-menuButton'
      cancel.textContent = '取消'
      var confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'drh-menuButton drh-menuButtonPrimary'
      confirm.textContent = '保存'
      row.appendChild(cancel)
      row.appendChild(confirm)
      surface.__viewport.appendChild(row)
      var submit = async function () {
        var title = input.value.trim()
        closeBlockMenu()
        if (title.length === 0) return
        try {
          var result = await remoteRpc('session/rename', { request: { sessionId: sessionId, title: title } })
          if (result.ok !== true) {
            var error = result.error === null || result.error === undefined ? {} : result.error
            notifyBlock('远端重命名失败（' + (typeof error.code === 'string' ? error.code : 'unknown') + '）：' + (typeof error.message === 'string' ? error.message : '未知错误'), true)
          }
        } catch (error) { notifyBlock('远端重命名失败', true) }
      }
      cancel.addEventListener('click', closeBlockMenu)
      confirm.addEventListener('click', function () { void submit() })
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); void submit() }
        else if (event.key === 'Escape') { event.preventDefault(); closeBlockMenu() }
      })
      showMenu(surface, { left: 12, right: 12 }, 80, 'start')
      input.focus()
      input.select()
    }

    /** Shipped session-row menu: 34px rows, two separators, trailing check on the pin row. */
    function openBlockMenu(ctx, anchor, y, sessionId, isPinned) {
      closeBlockMenu()
      var summary = blockSummaries().get(sessionId)
      var cwd = summary === undefined || typeof summary.cwd !== 'string' ? '' : summary.cwd
      var surface = menuSurface(144, false)
      menuItem(surface, {
        key: 'pin', label: isPinned === true ? '取消置顶' : '置顶会话',
        icon: isPinned === true ? iconOf('pinFill') : iconOf('pin'), selected: isPinned === true,
      })
      menuItem(surface, { key: 'rename', label: '重命名', icon: 'dsw-icon-edit-outline-regular', shortcut: '⌥⌘G' })
      menuItem(surface, { key: 'fork', label: '分叉会话', icon: 'dsw-icon-branch-outline-regular', shortcut: '⇧⌘F' })
      menuItem(surface, { key: 'copy-id', label: '复制 Session ID', icon: 'dsw-icon-copy-outline-regular' })
      menuSeparator(surface)
      menuItem(surface, {
        key: 'copy-path', label: '复制远端路径', icon: 'dsw-icon-folder-open-outline-regular',
        disabled: cwd.length === 0,
        title: cwd.length === 0 ? '该远端会话没有工作目录' : cwd,
      })
      menuSeparator(surface)
      menuItem(surface, { key: 'archive', label: '归档会话', icon: 'dsw-icon-archive-outline-regular', shortcut: '⌥⌘A' })
      bindMenuKeys(surface, closeBlockMenu)
      surface.addEventListener('click', function (event) {
        var hit = event.target
        var button = hit !== null && hit !== undefined && hit.closest !== undefined ? hit.closest('[data-drh-menu]') : null
        if (button === null || button === undefined) return
        if (button.getAttribute('aria-disabled') === 'true') return
        var kind = button.getAttribute('data-drh-menu')
        closeBlockMenu()
        if (kind === 'pin') applyRowAction(ctx, isPinned === true ? 'unpin' : 'pin', sessionId)
        else if (kind === 'archive') applyRowAction(ctx, 'archive', sessionId)
        else if (kind === 'fork') void forkRemoteSession(ctx, sessionId)
        else if (kind === 'copy-id') copyToClipboard(sessionId, 'Session ID 已复制')
        else if (kind === 'copy-path') copyToClipboard(cwd, '远端路径已复制')
        else if (kind === 'rename') openRenamePanel(sessionId, summary)
      })
      blockState.menuTarget = 'session:' + sessionId
      renderBlock(true)
      showMenu(surface, anchor, y, 'end')
    }
    function installRemoteBlock(ctx) {
      try {
        // Crash-loop circuit breaker (see the shim's boot guard): this page has been
        // reborn four times inside a minute, so the remote section stays off for this
        // load. Local sessions keep working; a quiet minute brings the block back.
        if (globalThis.__DSH_REMOTE_HOST_SAFE__ === true) {
          console.warn('[dsh-remote-host] 安全模式：连续重启过多，本次不挂载远端分区（约一分钟后自动恢复）')
          return function () {}
        }
        // A hidden page has nothing to paint: skipping the tick keeps the refresh off the
        // renderer's style/layout path while the window is in the background.
        var tick = function () {
          if (typeof document === 'object' && document !== null && document.visibilityState === 'hidden') return
          mountBlock(ctx)
          renderBlock()
        }
        // Event-driven repaint goes through the signature check. An announce that changes
        // nothing visible used to rebuild the whole tree (one full rebuild per second while
        // idle, thousands of nodes each). A rebuilt container resets the signature, so a
        // re-mount still forces the paint.
        var repaint = function () { mountBlock(ctx); renderBlock() }
        mountBlock(ctx)
        renderBlock(true)
        // The tick is a safety net (React can drop our node), not the refresh
        // path: state/marks/sessions events already repaint. Ten seconds of headroom
        // keeps an idle window from doing per-tick DOM work every three seconds.
        // Our own highlight is set when a remote row is opened, and nothing used to clear it:
        // switching back to a local session left a stale "selected" row next to the real one.
        // Any click on a shipped session row means the host moved the main view to a local
        // session, so drop ours. Registered once here (not per mount) so listeners cannot
        // accumulate across the shipped tree's remounts.
        var clearOnLocalClick = function (event) {
          try {
            if (blockState.current === null) return
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var container = blockState.container
            if (container !== null && container.contains(target) === true) return
            var side = document.querySelector('[data-slot="sidebar.workspaces"]')
            if (side === null || side.contains(target) !== true) return
            if (target.closest('[data-row-key^="session:"]') === null) return
            blockState.current = null
            renderBlock()
          } catch (error) { /* highlight sync is cosmetic */ }
        }
        document.addEventListener('click', clearOnLocalClick, true)
        // The hover card also closes when the page scrolls; one listener per install, removed
        // with the block, so repeated mounts cannot accumulate them.
        var clearOnWindowScroll = function () { closeHoverCard() }
        window.addEventListener('scroll', clearOnWindowScroll, true)
        var timer = setInterval(tick, 15000)
        document.addEventListener('drh:state', repaint)
        document.addEventListener('drh:marks', repaint)
        document.addEventListener('drh:sessions', repaint)
        return function () {
          document.removeEventListener('click', clearOnLocalClick, true)
          window.removeEventListener('scroll', clearOnWindowScroll, true)
          clearInterval(timer)
          document.removeEventListener('drh:state', repaint)
          document.removeEventListener('drh:marks', repaint)
          document.removeEventListener('drh:sessions', repaint)
          try { if (blockState.container !== null) blockState.container.remove() } catch (error) { /* ignore */ }
          blockState.container = null
          blockState.signature = ''
          blockState.html = ''
        }
      } catch (error) { return function () {} }
    }

    /**
     * The block view model and the shared formatting helpers are pure, so an offline suite
     * without a DOM. This file is a classic script with no module exports, so they are
     * published the way the block already exposes its diagnostics (__DRH_DIAG__ and
     * friends): one page global that only a probe or the suite reads.
     */
    try {
      globalThis.__DRH_VIEW_MODEL__ = {
        titleOf: titleOf,
        relative: relative,
        memberComparator: memberComparator,
        buildBlockRows: buildBlockRows,
        paintPlan: paintPlan,
      }
    } catch (error) { /* diagnostics only */ }

    function apply(ctx) {
      // Registered through ctx.effect: a plugin reload or unload has to take the block's
      // DOM container, its document listeners and its 15s tick with it, instead of leaving
      // a second live instance behind to fight the fresh one over #drh-remote-block.
      if (config.remoteBlock === true) ctx.effect(() => installRemoteBlock(ctx))
      // Section headers decorate the shipped list, so they work with every other mode off.
      if (config.sectionHeaders === true) {
        installSectionHeaders()
        const retry = setInterval(installSectionHeaders, 700)
        setTimeout(() => clearInterval(retry), 15000)
        // The merged groups can arrive after boot, and a re-render can drop the heading.
        document.addEventListener('drh:state', installSectionHeaders)
      }
    }

    return { apply, inject: ['slots', 'connection', 'uiWorkspace', 'workspaces'] }
  },
})
