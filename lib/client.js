/**
 * dsh-remote-host — browser half (opt-in two-section sidebar).
 *
 * `sidebar: sections` replaces the sidebar's workspace list and renders two
 * siblings: 工作区 (local) and 远端工作区 (the mounted host). A sibling section
 * has no slot of its own — `sidebar.workspaces` is single-occupancy and has no
 * section list beside it — so the list itself is rendered here.
 *
 * The remote layout is published by the host half
 * (`globalThis.__DSH_REMOTE_HOST_STATE__`: id set plus workspaces with their
 * session ids), so remote groups mirror the remote's own 工作区 → 会话 layering
 * and never depend on a merged workspace record existing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-host',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const config = globalThis.__DSH_REMOTE_HOST__ || {}
    const ENABLED = config.sections === true
    const REMOTE_PREFIX = 'drh:'

    // Typography follows the app's own tokens, which the appearance settings scale
    // on `document.body`; hardcoded px ignored a user's larger content font size.
    const BODY = 'var(--dsh-content-font-size, 14px)'
    const SMALL = 'var(--dsh-content-font-size-secondary, 13px)'
    const MUTED = 'var(--dsh-text-tertiary, var(--dsw-alias-label-tertiary, rgba(120,120,128,0.92)))'

    // Row metrics copied from the shipped browser's computed styles at the default
    // size: 32px rows, 12px radius, padding 0 8px 0 9px, 6px gap. Sizes stay in
    // `em` against the body size so they track the appearance setting exactly.
    // 32px at 14px, matching the nav items above (插件 / 自动化任务 …): same rhythm,
    // just with a narrower session indent than the shipped list.
    const ROW_HEIGHT = '2.29em'
    const HOVER = 'var(--dsh-surface-hover, rgba(38, 49, 72, 0.06))'

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 0, padding: '0 0 8px', overflow: 'auto', minHeight: 0, fontSize: BODY },
      header: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '0.9em 6px 0.25em',
        fontSize: SMALL, fontWeight: 500, letterSpacing: '0.02em',
        color: MUTED, userSelect: 'none',
      },
      groupRow: {
        display: 'flex', alignItems: 'center', gap: '5px', minHeight: ROW_HEIGHT,
        padding: '0 6px 0 6px', borderRadius: '8px',
        cursor: 'pointer', fontSize: BODY, userSelect: 'none',
      },
      row: {
        display: 'flex', alignItems: 'center', gap: '5px', minHeight: ROW_HEIGHT,
        padding: '0 6px 0 6px', borderRadius: '8px',
        cursor: 'pointer', fontSize: BODY, minWidth: 0,
      },
      // One chevron width plus a hair: sessions sit just inside their workspace row
      // instead of under a wide gutter (the old 1.6em gutter looked empty).
      indent: { flex: '0 0 auto', width: '0.95em' },
      title: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.35 },
      time: { flex: '0 0 auto', fontSize: SMALL, color: MUTED, marginLeft: '4px' },
      count: { flex: '0 0 auto', fontSize: SMALL, color: MUTED, marginLeft: 'auto' },
      empty: { padding: '0.15em 6px 0.35em 2.0em', fontSize: SMALL, color: MUTED },
      dot: { flex: '0 0 auto', width: '0.45em', height: '0.45em', borderRadius: '50%', background: 'var(--dsh-accent, #4d6bfe)' },
      actions: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '2px' },
      search: {
        margin: '0 6px 4px', padding: '0.3em 0.5em', borderRadius: '8px', fontSize: SMALL,
        border: '1px solid var(--dsh-border-subtle, rgba(120,120,128,0.25))',
        background: 'transparent', color: 'inherit', outline: 'none', minWidth: 0,
      },
      toggleRow: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '0 6px',
        fontSize: SMALL, color: MUTED, cursor: 'pointer', userSelect: 'none', minHeight: '1.9em',
      },
    }
    void HOVER

    /** Native-looking disclosure triangle; the text glyphs were too small to read. */
    function Chevron({ open }) {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true',
        style: { flex: '0 0 auto', opacity: 0.7, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' },
      }, h('path', {
        d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    const relative = (value) => {
      if (typeof value !== 'number' || Number.isFinite(value) === false) return ''
      const delta = Date.now() - value
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
    const remoteKnown = () => remoteState().ids.length > 0

    /** 'open' | 'connecting' | 'error' for the mounted host. */
    const remoteStatus = () => {
      const status = globalThis.__DSH_REMOTE_HOST_STATUS__
      const value = status === null || typeof status !== 'object' ? undefined : status.remote
      return value === 'open' || value === 'error' || value === 'connecting' ? value : 'connecting'
    }

    /**
     * Read the session list through whichever carrier exists. A fetch-only carrier
     * (the desktop shell, and `attach: remote`) has no `connection.rpc`, which
     * silently emptied this list before.
     */
    const listSessions = async (ctx) => {
      const transport = globalThis.__DSH_TRANSPORT__
      if (transport !== undefined && typeof transport.fetch === 'function') {
        const body = JSON.stringify({
          type: 'client-request', rpcId: 'rh-sidebar-list', method: 'session/list', payload: { args: { _request: {} } },
        })
        const response = await transport.fetch('/api/session/list', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        })
        const envelope = await response.json()
        const items = envelope?.result?.value?.items
        if (Array.isArray(items)) return items
      }
      const result = await ctx.connection.rpc.call('/api', 'session/list', { args: { _request: {} } })
      if (result === undefined || result.ok !== true) return []
      return Array.isArray(result.value?.items) ? result.value.items : []
    }

    function useSidebarData(ctx) {
      const [state, setState] = React.useState({ workspaces: [], sessions: [], archived: [], pinned: [], remoteCount: -1, status: remoteStatus() })
      React.useEffect(() => {
        let closed = false
        let fetchedFor = -1
        const refreshSessions = async (force) => {
          const ids = remoteState().ids
          if (closed) return
          if (force !== true && ids.length === fetchedFor) return
          fetchedFor = ids.length
          try {
            const items = await listSessions(ctx)
            if (closed) return
            setState((previous) => ({ ...previous, sessions: items, remoteCount: ids.length }))
          } catch (error) { /* keep the last good list */ }
        }
        void refreshSessions(true)
        let socket
        // Keep this socket open: closing it propagates through the shared router and can
        // tear down the shim's own legs (the remote status dot went red when it did).
        try {
          socket = ctx.connection.openWebSocket('/api/remote.mux')
          socket.addEventListener('open', () => {
            try {
              socket.send(JSON.stringify({ type: 'open', streamId: 'rh-sidebar', endpoint: 'workspace/follow', payload: { args: {} } }))
            } catch (error) { /* ignore */ }
          })
          socket.addEventListener('message', (event) => {
            let frame
            try { frame = JSON.parse(event.data) } catch (error) { return }
            if (frame?.streamId !== 'rh-sidebar' || frame.type !== 'item') return
            const value = frame.value
            if (value?.type !== 'baseline' && value?.type !== 'replace') return
            const items = Array.isArray(value.value?.items) ? value.value.items : []
            const archived = Array.isArray(value.value?.archivedSessionIds) ? value.value.archivedSessionIds : []
            // Pin state travels in the same workspace snapshot; the native list uses
            // it to float sessions, and both sections honour it here.
            const pinned = Array.isArray(value.value?.pinnedSessionIds) ? value.value.pinnedSessionIds : []
            setState((previous) => ({ ...previous, workspaces: items, archived, pinned }))
            // Refetching on every frame would drive the host's merge refresh in a loop.
            void refreshSessions(false)
          })
        } catch (error) { /* sessions alone still render */ }
        // The shim publishes remote state and connection state as page events; the
        // sidebar must follow them or a late publish leaves it showing "未连接".
        const syncStatus = () => {
          const next = remoteStatus()
          setState((previous) => (previous.status === next ? previous : { ...previous, status: next }))
        }
        const onState = () => { syncStatus(); void refreshSessions(true) }
        const onStatus = () => { syncStatus(); void refreshSessions(true) }
        document.addEventListener('drh:state', onState)
        document.addEventListener('drh:status', onStatus)
        // Fallback for an event dispatched before this component mounted.
        const poll = setInterval(() => { void refreshSessions(false); syncStatus() }, 1500)
        const stopPolling = setTimeout(() => clearInterval(poll), 30000)
        return () => {
          closed = true
          clearInterval(poll)
          clearTimeout(stopPolling)
          document.removeEventListener('drh:state', onState)
          document.removeEventListener('drh:status', onStatus)
          try { socket?.close() } catch (error) { /* ignore */ }
        }
      }, [ctx])
      return state
    }

    const SectionHeader = ({ children }) => h('div', { style: S.header }, children)

    function SessionRow({ summary, open, stripPrefix, isCurrent, pinned, onPin, onArchive }) {
      let title = titleOf(summary)
      if (typeof stripPrefix === 'string' && title.indexOf(stripPrefix + ' · ') === 0) {
        title = title.slice(stripPrefix.length + 3)
      }
      // Native rows indent with an empty leading slot rather than padding.
      return h('div', {
        style: S.row,
        role: 'treeitem',
        title,
        // Match the shipped row contract: keys, selection and focusability.
        'data-row-key': 'session:' + summary.sessionId,
        'aria-selected': isCurrent === true ? 'true' : 'false',
        tabindex: 0,
        'data-drh-row': '',
        'data-drh-current': isCurrent === true ? 'true' : 'false',
        onClick: () => open(summary.sessionId),
      },
        h('span', { style: S.indent }),
        pinned === true
          ? h(Icon, { name: 'dsw-icon-pin-fill-regular', size: 16, color: MUTED })
          : (summary?.running === true ? h('span', { style: S.dot }) : h('span', { style: { ...S.dot, background: 'transparent' } })),
        h('span', { style: S.title }, title),
        // Row actions reuse the shipped sprite icons and the native workspace service,
        // so local behaviour is the shipped behaviour and remote calls are routed by
        // the shim.
        h('span', { style: S.actions },
          h('button', {
            key: 'pin',
            className: 'drh-action',
            title: pinned === true ? '取消置顶' : '置顶',
            'aria-label': pinned === true ? '取消置顶' : '置顶',
            onClick: (event) => { event.stopPropagation(); onPin(summary.sessionId, pinned !== true) },
          }, h(Icon, { name: pinned === true ? 'dsw-icon-pin-fill-regular' : 'dsw-icon-pin-outline-regular', size: 16 })),
          h('button', {
            key: 'archive',
            className: 'drh-action',
            title: '归档',
            'aria-label': '归档',
            onClick: (event) => { event.stopPropagation(); onArchive(summary.sessionId) },
          }, h(Icon, { name: 'dsw-icon-archive-outline-regular', size: 16 })),
        ),
        h('span', { style: S.time }, relative(summary?.updatedAt)),
      )
    }

    /** Sprite icon the shipped UI uses, so our rows match it exactly. */
    function Icon({ name, size }) {
      return h('svg', { width: size, height: size, 'data-icon': name, 'aria-hidden': 'true', style: { display: 'block' } },
        h('use', { href: '#' + name }))
    }

    /** The app ships its own icon sprite; reusing it keeps group rows native-looking. */
    function FolderIcon() {
      return h('svg', { width: 16, height: 16, 'aria-hidden': 'true', style: { flex: '0 0 auto', opacity: 0.75 } },
        h('use', { href: '#dsw-icon-folder-close-regular' }))
    }

    function Group({ groupKey, label, sessions, open, expanded, onToggle, stripPrefix, pinnedIds, archivedIds, onPin, onArchive, onUnarchive }) {
      return h('div', null,
        h('div', {
          style: S.groupRow,
          role: 'treeitem',
          'aria-expanded': expanded ? 'true' : 'false',
          'data-drh-row': '',
          onClick: onToggle,
        },
          h(Chevron, { open: expanded }),
          h(FolderIcon, null),
          h('span', { style: S.title }, label),
        ),
        expanded === true
          ? (sessions.length === 0
              ? h('div', { style: S.empty }, '暂无会话')
              : sessions.map((summary) => h(SessionRow, {
                  key: summary.sessionId,
                  summary,
                  open,
                  stripPrefix,
                  pinned: pinnedIds.has(summary.sessionId),
                  onPin,
                  onArchive: archivedIds.has(summary.sessionId) ? onUnarchive : onArchive,
                })))
          : null,
      )
    }

    function SectionsSidebar({ __ctx: ctx }) {
      const data = useSidebarData(ctx)
      const [collapsed, setCollapsed] = React.useState({})
      const [query, setQuery] = React.useState('')
      const [showArchived, setShowArchived] = React.useState(false)
      const isOpen = (key, fallback) => (collapsed[key] === undefined ? fallback : collapsed[key] !== true)
      const toggle = (key, fallback) => setCollapsed((previous) => ({
        ...previous,
        [key]: previous[key] === undefined ? fallback === true : previous[key] !== true,
      }))

      // Pin, archive and open all reuse the native workspace service: local sessions
      // behave exactly like the shipped sidebar, and the shim routes the same calls to
      // the mounted host for remote sessions.
      const service = ctx.uiWorkspace
      const run = (call) => {
        try {
          const task = call()
          if (task !== undefined && task !== null && typeof task.catch === 'function') task.catch(() => {})
        } catch (error) { /* the list re-renders from the workspace stream either way */ }
      }
      const open = (sessionId) => { try { service.openSession(sessionId) } catch (error) { /* ignore */ } }
      const onPin = (sessionId, next) => run(() => (next === true ? service.pinSession(sessionId) : service.unpinSession(sessionId)))
      const onArchive = (sessionId) => run(() => service.archiveSession(sessionId))
      const onUnarchive = (sessionId) => run(() => service.unarchiveSession(sessionId))

      const remote = remoteState()
      const remoteIds = new Set(remote.ids)
      const archivedIds = new Set(data.archived)
      const pinnedIds = new Set(data.pinned)
      const needle = query.trim().toLowerCase()
      const matches = (summary) => needle.length === 0 || titleOf(summary).toLowerCase().indexOf(needle) !== -1
      // Subagent (child) sessions are not part of the workspace list the client
      // renders natively, and their history is not reachable from here.
      const listed = data.sessions.filter((summary) => !summary?.parentSessionId && matches(summary))
      const live = listed.filter((summary) => archivedIds.has(summary.sessionId) === false)
      const archivedList = listed.filter((summary) => archivedIds.has(summary.sessionId) === true)
      const byId = new Map(live.map((summary) => [summary.sessionId, summary]))

      const local = live.filter((summary) => remoteIds.has(summary.sessionId) === false)
      const localPinned = local.filter((summary) => pinnedIds.has(summary.sessionId) === true)
      const localRest = local.filter((summary) => pinnedIds.has(summary.sessionId) === false)
      const localGroups = data.workspaces
        .filter((workspace) => String(workspace.workspaceId).startsWith(REMOTE_PREFIX) === false)
        .map((workspace) => {
          const members = new Set(workspace.sessionIds ?? [])
          return {
            key: 'w:' + workspace.workspaceId,
            label: workspace.title || 'workspace',
            sessions: localRest.filter((summary) => members.has(summary.sessionId)),
          }
        })
        .filter((group) => group.sessions.length > 0)
      const accounted = new Set(data.workspaces.flatMap((workspace) => workspace.sessionIds ?? []))
      // Until the remote set is known, "not in a local workspace" is not evidence
      // of being ungrouped: it may simply be remote.
      const stray = remoteKnown() === true
        ? localRest.filter((summary) => accounted.has(summary.sessionId) === false)
        : []

      const remoteOf = (ids) => ids.map((id) => byId.get(id)).filter(Boolean)
      const remotePinned = (remote.workspaces ?? []).reduce((all, space) => all.concat(remoteOf(space.sessionIds ?? [])), [])
        .filter((summary) => pinnedIds.has(summary.sessionId) === true)
      const remoteGroups = (remote.workspaces ?? []).map((space) => ({
        key: 'r:' + space.title,
        label: space.title,
        sessions: remoteOf(space.sessionIds ?? []).filter((summary) => pinnedIds.has(summary.sessionId) === false),
        stripPrefix: space.title,
      })).filter((group) => group.sessions.length > 0)

      const archivedLocal = archivedList.filter((summary) => remoteIds.has(summary.sessionId) === false)
      const archivedRemote = archivedList.filter((summary) => remoteIds.has(summary.sessionId) === true)

      const groupProps = { pinnedIds, archivedIds, onPin, onArchive, onUnarchive, open }
      // Local groups open by default like the shipped sidebar; remote groups start
      // collapsed so the local section stays readable.
      const group = (key, label, sessions, options) => {
        const openByDefault = options !== undefined && options.openByDefault !== undefined ? options.openByDefault : true
        return h(Group, {
          key,
          groupKey: key,
          label,
          sessions,
          expanded: isOpen(key, openByDefault),
          onToggle: () => toggle(key, openByDefault),
          stripPrefix: options === undefined ? undefined : options.stripPrefix,
          ...groupProps,
        })
      }

      return h('div', { style: S.root },
        h('input', {
          key: 'search',
          style: S.search,
          placeholder: '搜索会话名称',
          value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Escape') setQuery('') },
        }),

        h(SectionHeader, { key: 'h:local' }, '工作区'),
        localGroups.length === 0 && stray.length === 0 && localPinned.length === 0
          ? h('div', { key: 'e:local', style: S.empty }, needle.length > 0 ? '无匹配会话' : '暂无工作区')
          : null,
        localPinned.length === 0 ? null : group('__pin_local__', '置顶', localPinned),
        ...localGroups.map((item) => group(item.key, item.label, item.sessions)),
        stray.length === 0 ? null : group('__stray__', '未分组', stray, { openByDefault: false }),

        h(SectionHeader, { key: 'h:remote' },
          h('span', {
            key: 'dot',
            className: 'drh-dot',
            'data-state': data.status,
            title: data.status === 'open' ? '已连接' : data.status === 'error' ? '连接失败' : '正在连接',
          }),
          // The shim already prefixes the merged group label; do not prefix it twice.
          (String(remote.label || config.label || 'remote').startsWith('远端工作区') === true
            ? String(remote.label || config.label || 'remote')
            : '远端工作区 · ' + (remote.label || config.label || 'remote'))),
        remoteGroups.length === 0 && remotePinned.length === 0
          ? h('div', { key: 'e:remote', style: S.empty }, data.status === 'error' ? '远端未连接' : '暂无远端会话')
          : null,
        remotePinned.length === 0 ? null : group('__pin_remote__', '置顶', remotePinned),
        ...remoteGroups.map((item) => group(item.key, item.label, item.sessions, { stripPrefix: item.stripPrefix, openByDefault: false })),

        h('div', {
          key: 'toggle:archived',
          style: S.toggleRow,
          onClick: () => setShowArchived((previous) => previous !== true),
        }, (showArchived === true ? '▾ ' : '▸ ') + '已归档' + (archivedList.length === 0 ? '' : ' (' + archivedList.length + ')')),
        showArchived !== true || archivedList.length === 0
          ? null
          : group('__archived_local__', '已归档 · 工作区', archivedLocal, { openByDefault: true }),
        showArchived !== true || archivedRemote.length === 0
          ? null
          : group('__archived_remote__', '已归档 · 远端', archivedRemote, { openByDefault: true }),
      )
    }
    /** Native rows highlight on hover and for the open session; inline styles cannot. */
    function installRowStyles() {
      try {
        if (document.getElementById('dsh-remote-host-rows') !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-remote-host-rows'
        style.textContent = [
          '[data-drh-row]{transition:background-color 120ms ease}',
          '[data-drh-row]:hover{background:var(--dsh-surface-hover, rgba(38, 49, 72, 0.06))}',
          '[data-drh-row][data-drh-current="true"]{background:var(--dsh-surface-selected, rgba(38, 49, 72, 0.09))}',
          '.drh-action{opacity:0;border:0;background:transparent;cursor:pointer;padding:0 1px;font-size:.85em;line-height:1;color:var(--dsh-text-tertiary, rgba(120,120,128,.9))}',
          '[data-drh-row]:hover .drh-action{opacity:1}',
          '.drh-action:hover{color:var(--dsh-text-primary, currentColor)}',
          '.drh-dot{flex:0 0 auto;width:.5em;height:.5em;border-radius:50%;box-sizing:border-box;background:var(--dsh-text-tertiary, rgba(120,120,128,.9))}',
          '.drh-dot[data-state="open"]{background:#2ea043}',
          '.drh-dot[data-state="error"]{background:#d1242f}',
          '.drh-dot[data-state="connecting"]{background:transparent;border:1.5px solid rgba(120,120,128,.75);border-top-color:transparent;animation:drh-spin .8s linear infinite}',
          '@keyframes drh-spin{to{transform:rotate(360deg)}}',
        ].join('')
        document.head.appendChild(style)
      } catch (error) { /* styling is best effort */ }
    }

    /**
     * The Superagent nav entry belongs to that plugin, and its label cannot be
     * re-registered from here. When the panel is attached to the mounted host,
     * suffixing the label is the one honest signal we can add.
     */
    function labelSuperagent() {
      try {
        const suffix = typeof config.superagentLabel === 'string' ? config.superagentLabel.trim() : ''
        if (suffix.length === 0) return
        const target = 'Superagent · ' + suffix
        // Narrow scan: only row-like elements whose whole text is the label. A
        // subtree MutationObserver over the document proved unsafe in the shell, so
        // this polls a few times instead and stops as soon as it succeeds.
        const apply = () => {
          const entries = document.querySelectorAll('[role="treeitem"],button,a,li')
          for (const entry of entries) {
            if (entry.childElementCount > 4) continue
            if ((entry.textContent || '').trim() !== 'Superagent') continue
            const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
            let node = walker.nextNode()
            while (node !== null) {
              if ((node.textContent || '').trim() === 'Superagent') node.textContent = target
              node = walker.nextNode()
            }
            return true
          }
          return false
        }
        if (apply() === true) return
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          if (apply() === true || ticks >= 10) clearInterval(timer)
        }, 600)
      } catch (error) { /* labelling is cosmetic */ }
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
    function apply(ctx) {
      // Section headers apply to the shipped list, so they work with sections mode off.
      if (config.sectionHeaders === true) {
        installSectionHeaders()
        const retry = setInterval(installSectionHeaders, 700)
        setTimeout(() => clearInterval(retry), 15000)
        // The merged groups can arrive after boot, and a re-render can drop the heading.
        document.addEventListener('drh:state', installSectionHeaders)
      }
      if (ENABLED !== true) return
      installRowStyles()
      labelSuperagent()
      // A single-slot occupant cannot be replaced at the same priority; the
      // runtime asks for a different one, and the lowest priority renders.
      // Shadowing changes rendering, not ownership: the shipped occupant still
      // declares the child slots, so re-declaring them here fails with
      // 'slot "sidebar.workspaces.directoryFlow" is already declared'. Keep the
      // contract empty and let those injections stay attached to the shipped
      // browser (they render nothing while its rows are not mounted).
      ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
        name: 'sidebar.workspaces',
        children: {},
        priority: -1,
      }, (props) => h(SectionsSidebar, { ...props, __ctx: ctx }))))
    }

    return { apply, inject: ['slots', 'connection', 'uiWorkspace'] }
  },
})
//# sourceMappingURL=client.js.map
