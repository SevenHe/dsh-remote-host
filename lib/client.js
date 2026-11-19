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
        // Only one deviation is needed: the shipped rule caps the label at 45% for the
        // short "工作区"; ours names the host, so let it use the width it needs. Every
        // other metric comes from the ported stylesheet.
        style.textContent = '#drh-remote-block .drh-sectionLabel{max-width:none !important}'
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
      container: null,
      roots: [],
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

    function blockRows() {
      var state = globalThis.__DSH_REMOTE_HOST_STATE__
      var workspaces = state !== undefined && state !== null && Array.isArray(state.workspaces) ? state.workspaces : []
      var needle = blockState.query.trim().toLowerCase()
      var out = []
      for (var i = 0; i < workspaces.length; i += 1) {
        var space = workspaces[i]
        var ids = Array.isArray(space.sessionIds) ? space.sessionIds : []
        var members = []
        var published = blockSummaries()
        for (var j = 0; j < ids.length; j += 1) {
          var summary = published.get(ids[j])
          var title = summary === undefined ? ids[j] : (summary.title === undefined || summary.title === null ? ids[j] : String(summary.title))
          if (needle.length > 0 && title.toLowerCase().indexOf(needle) === -1) continue
          var when = summary === undefined || summary.updatedAt === null || summary.updatedAt === undefined ? '' : relative(summary.updatedAt)
          members.push({ id: ids[j], title: title, time: when })
        }
        if (members.length === 0 && needle.length > 0) continue
        out.push({ title: space.title, id: typeof space.id === 'string' ? space.id : '', key: 'w:' + ((typeof space.id === 'string' && space.id.length > 0) ? space.id : space.title), members: members })
      }
      var order = loadBlockOrder()
      out.sort(function (left, right) {
        var li = order.indexOf(left.key)
        var ri = order.indexOf(right.key)
        if (li === -1 && ri === -1) return 0
        if (li === -1) return 1
        if (ri === -1) return -1
        return li - ri
      })
      return out
    }

    /** First sprite id that exists, so a missing icon degrades to another one. */
    function pickIcon(candidates) {
      for (var i = 0; i < candidates.length; i += 1) {
        if (document.getElementById(candidates[i]) !== null) return candidates[i]
      }
      return candidates[candidates.length - 1]
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

    /** Floating preview for a remote session row, shown after a short hover delay. */
    function showHoverCard(row) {
      closeHoverCard()
      var id = row.getAttribute('data-drh-session')
      if (id === null || id === undefined) return
      var summary = blockSummaries().get(id)
      var box = row.getBoundingClientRect()
      var card = document.createElement('div')
      card.id = 'drh-hovercard'
      card.style.cssText = 'position:fixed;z-index:2147482000;max-width:280px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-elevated, #fff);box-shadow:0 6px 20px rgba(0,0,0,0.18);border:1px solid var(--dsw-alias-line-secondary, rgba(120,120,128,0.2));font-size:12px;line-height:1.5;pointer-events:none'
      var title = document.createElement('div')
      title.style.cssText = 'font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary, inherit);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      title.textContent = summary === undefined ? id : String(summary.title === undefined ? id : summary.title)
      card.appendChild(title)
      var meta = document.createElement('div')
      meta.style.cssText = 'color:var(--dsw-alias-label-tertiary, rgba(120,120,128,0.92))'
      var when = summary === undefined || summary.updatedAt === null || summary.updatedAt === undefined ? '' : relative(summary.updatedAt)
      meta.textContent = (summary !== undefined && summary.running === true ? '运行中' : '空闲') + (when === '' ? '' : ' · ' + when) + ' · 远端'
      card.appendChild(meta)
      card.style.left = Math.min(box.left + 12, window.innerWidth - 300) + 'px'
      card.style.top = Math.min(box.bottom + 6, window.innerHeight - 90) + 'px'
      document.body.appendChild(card)
    }

    function closeHoverCard() {
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

    function chevronSvg(open) {
      return '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="transform:rotate(' + (open ? '90' : '0') + 'deg);transition:transform 120ms ease">' +
        '<path d="M6.5 4.5 L10 8 L6.5 11.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    }

    function actionIcon(name, title, kind) {
      return '<button class="drh-rowAction" data-drh-act="' + kind + '" title="' + title + '" aria-label="' + title + '" style="width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary);opacity:0">' + sprite(name, 14) + '</button>'
    }

    function renderBlock(force) {
      var container = blockState.container
      if (container === null || container === undefined) return
      // Never repaint over an open inline editor: the periodic refresh would destroy it.
      if (blockState.editing !== null && blockState.editing !== undefined) return
      // Repaint only when something visible changed: rebuilding the whole block every refresh
      // made the section label flicker.
      var statusNow = remoteBlockStatus()
      var rowsNow = blockRows()
      var signature = [blockState.query, blockState.searchOpen === true, blockState.current, blockState.expanded.size, blockState.sort, statusNow, rowsNow.length, rowsNow.reduce(function (sum, group) { return sum + group.members.length }, 0)].join('|')
      if (force !== true && blockState.signature === signature) return
      blockState.signature = signature
      var groups = blockRows()
      // TEMPORARY diagnostic: is an expanded group empty, or does its key mismatch?
      try {
        globalThis.__DRH_DIAG__ = {
          groupKeys: groups.slice(0, 5).map(function (group) { return [group.key, group.members.length] }),
          expanded: Array.from(blockState.expanded),
          totalMembers: groups.reduce(function (sum, group) { return sum + group.members.length }, 0),
        }
      } catch (error) { /* diagnostic only */ }
      var total = groups.reduce(function (sum, group) { return sum + group.members.length }, 0)
      var folderIcon = pickIcon(['dsw-icon-folder-close-regular', 'dsw-icon-folder-regular'])
      var searchIcon = pickIcon(['dsw-icon-search-outline-regular', 'dsw-icon-search-regular', 'dsw-icon-ellipsis-outline-regular'])
      var closeIcon = pickIcon(['dsw-icon-close-fill-regular', 'dsw-icon-close-regular', 'dsw-icon-ellipsis-outline-regular'])
      var ellipsisIcon = pickIcon(['dsw-icon-ellipsis-outline-regular', 'dsw-icon-ellipsis-outline-medium', 'dsw-icon-filter-outline-regular'])
      var addIcon = pickIcon(['dsw-icon-folder-add-regular', 'dsw-icon-folder-close-regular'])
      var pinIcon = pickIcon(['dsw-icon-pin-outline-regular', 'dsw-icon-pin-fill-regular'])
      var archiveIcon = pickIcon(['dsw-icon-archive-outline-regular', 'dsw-icon-unarchive-outline-regular'])
      // Pinned/archived come from the host; the local set only bridges the moment between a
      // click and the next published frame.
      var pinned = new Set()
      try {
        var marks = globalThis.__DSH_REMOTE_HOST_MARKS__
        if (marks !== null && marks !== undefined && Array.isArray(marks.pinned)) {
          for (var pm = 0; pm < marks.pinned.length; pm += 1) pinned.add(marks.pinned[pm])
        }
      } catch (error) { /* ignore */ }
      if (blockState.pinned instanceof Set) blockState.pinned.forEach(function (id) { pinned.add(id) })
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
          '<button type="button" class="drh-iconButton" data-drh-toggleall="true" aria-label="全部展开或折叠">' + sprite(addIcon, 14) + '</button>' +
        '</div>' +
      '</div>'
      if (groups.length === 0) {
        html += '<div class="drh-empty" style="padding:6px 9px;font-size:12px;color:var(--dsw-alias-label-tertiary)">' + (needleOf() ? '无匹配会话' : '暂无远端工作区') + '</div>'
      } else {
        html += '<div class="drh-list">'
        for (var g = 0; g < groups.length; g += 1) {
          var group = groups[g]
          var open = blockState.expanded.has(group.key) === true
          html += '<div class="drh-groupSection">' +
            '<div class="drh-projectRow" draggable="true" role="treeitem" aria-expanded="' + (open ? 'true' : 'false') + '" data-drh-group="' + esc(group.key) + '">' +
              '<span class="drh-slot drh-chevron" style="width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption)">' + chevronSvg(open) + '</span>' +
              '<span class="drh-slot drh-folder" style="width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center">' + sprite(folderIcon, 16) + '</span>' +
              '<span class="drh-title">' + esc(group.title) + '</span>' +
              '<div class="drh-rowActions">' +
                '<button type="button" class="drh-iconButton" data-drh-groupmenu="true" aria-label="目录操作">' + sprite(ellipsisIcon, 14) + '</button>' +
              '</div>' +
            '</div>'
          if (open === true) {
            group.members.sort(function (left, right) {
              var lp = pinned.has(left.id) ? 0 : 1
              var rp = pinned.has(right.id) ? 0 : 1
              return lp - rp
            })
            for (var m = 0; m < group.members.length; m += 1) {
              var row = group.members[m]
              html += '<div class="drh-sessionRow' + (blockState.current === row.id ? ' selected' : '') + '" role="treeitem" data-drh-session="' + esc(row.id) + '" data-drh-row="true">' +
                (pinned.has(row.id) ? '<span class="drh-pinIndicator" title="已置顶">' + sprite(pinIconOf(), 11) + '</span>' : '') +
                '<span class="drh-title">' + esc(row.title) + '</span>' +
                '<span class="drh-time">' + esc(row.time) + '</span>' +
                '<div class="drh-rowActions">' +
                  (pinned.has(row.id) ? actionIcon(pinIcon, '取消置顶', 'unpin') : actionIcon(pinIcon, '置顶', 'pin')) +
                  actionIcon(archiveIcon, '归档', 'archive') +
                '</div>' +
              '</div>'
            }
          }
          html += '</div>'
        }
        html += '</div>'
      }
      container.innerHTML = html
      container.setAttribute('data-drh-count', String(total))
      ensureBlockExtras()
    }

    /** Hover reveal for the row actions; kept out of the ported stylesheet. */
    function ensureBlockExtras() {
      try {
        if (document.getElementById('drh-block-extra') !== null) return
        var style = document.createElement('style')
        style.id = 'drh-block-extra'
        style.textContent = [
          '[data-drh-row]{display:flex !important;flex-wrap:nowrap !important;align-items:center !important}',
          '[data-drh-row] .drh-title{flex:1 1 0% !important;min-width:0 !important}',
          '[data-drh-row] .drh-time{flex:0 0 auto !important;white-space:nowrap !important}',
          '[data-drh-row] .drh-actions{flex:0 0 auto !important}',
          '[data-drh-row]:hover .drh-rowAction{opacity:1 !important}',
          '[data-drh-row]:hover{background:var(--dsh-surface-hover, rgba(38, 49, 72, 0.06))}',
          '.drh-rowAction:hover{color:var(--dsw-alias-label-primary, currentColor) !important}',
          '[data-drh-row]:hover .drh-time{display:none}',
          '.drh-projectRow:hover,.drh-sessionRow:hover{background:var(--dsh-surface-hover, rgba(38, 49, 72, 0.06))}',
        ].join('')
        document.head.appendChild(style)
      } catch (error) { /* cosmetic */ }
    }
    function needleOf() { return blockState.query.trim() }

    function mountBlock(ctx) {
      try {
        ensureBlockStyles()
        var host = document.querySelector('[data-slot="sidebar.workspaces"]')
        if (host === null) return false
        var container = blockState.container
        if (container !== null && document.contains(container) === true) return true
        if (container === null) {
          container = document.createElement('div')
          container.className = 'drh-root'
          container.id = 'drh-remote-block'
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
                  openGroupMenu(ctx, rect.left, rect.bottom + 4, foundGroup)
                }
              }
              return
            }
            var act = target.closest('[data-drh-act]')
            if (act !== null && act !== undefined) {
              event.stopPropagation()
              var row = act.closest('[data-drh-session]')
              var id = row === null ? null : row.getAttribute('data-drh-session')
              if (id === null) return
              var kind = act.getAttribute('data-drh-act')
              try {
                if (kind === 'pin') { ctx.uiWorkspace.pinSession(id); blockState.pinned.add(id) }
                else if (kind === 'unpin') { ctx.uiWorkspace.unpinSession(id); blockState.pinned.delete(id) }
                else if (kind === 'archive') { ctx.uiWorkspace.archiveSession(id) }
              } catch (error) { /* the list repaints from the shim state */ }
              renderBlock(true)
              return
            }
            if (target.closest('[data-drh-toggleall]') !== null && target.closest('[data-drh-toggleall]') !== undefined) {
              var keys = blockRows().map(function (group) { return group.key })
              var allOpen = keys.length > 0 && keys.every(function (key) { return blockState.expanded.has(key) })
              blockState.expanded = allOpen ? new Set() : new Set(keys)
              renderBlock(true)
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
              // Paint the row immediately: the shipped list highlights the open session, and a
              // remote session does not move the local main reference.
              blockState.current = openId
              renderBlock(true)
              try { ctx.uiWorkspace.openSession(openId) } catch (error) { /* ignore */ }
            }
          })
          container.addEventListener('mouseover', function (event) {
            var target = event.target
            if (target === null || target === undefined || target.closest === undefined) return
            var row = target.closest('[data-drh-session]')
            if (row === null || row === undefined) return
            if (blockState.hoverTimer !== null && blockState.hoverTimer !== undefined) clearTimeout(blockState.hoverTimer)
            blockState.hoverTimer = setTimeout(function () { showHoverCard(row) }, 550)
          })
          container.addEventListener('mouseout', function (event) {
            var target = event.target
            if (target !== null && target !== undefined && target.closest !== undefined && target.closest('[data-drh-session]') === null) return
            if (blockState.hoverTimer !== null && blockState.hoverTimer !== undefined) clearTimeout(blockState.hoverTimer)
            blockState.hoverTimer = null
            closeHoverCard()
          })
          container.addEventListener('contextmenu', function (event) {
            var hit = event.target
            if (hit !== null && hit !== undefined && hit.closest !== undefined) {
              var groupHit = hit.closest('[data-drh-group]')
              if (groupHit !== null && groupHit !== undefined) {
                event.preventDefault()
                var groupKey = groupHit.getAttribute('data-drh-group')
                var found = blockRows().filter(function (group) { return group.key === groupKey })[0]
                if (found !== undefined) openGroupMenu(ctx, event.clientX, event.clientY, found)
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
        // A reload of the plugin can leave a previous block in the tree with the same id;
        // queries would then hit the stale one while clicks land on the new one.
        var duplicates = document.querySelectorAll('#drh-remote-block')
        for (var di = 0; di < duplicates.length; di += 1) {
          if (duplicates[di] !== container) duplicates[di].remove()
        }
        parent.insertBefore(container, host.nextSibling)
        renderBlock(true)
        return true
      } catch (error) { return false }
    }

    /** Remote summaries arrive with the shim state; just repaint. */
    function refreshBlockSummaries() {
      // Non-forced: the periodic refresh must not rebuild unchanged markup, or the section
      // label flickers every tick.
      renderBlock()
    }

    /** Row context menu: the actions the shipped list offers in its own menu. */
    function closeBlockMenu() {
      var open = document.getElementById('drh-block-menu')
      if (open !== null) open.remove()
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
    function openGroupMenu(ctx, x, y, group) {
      closeBlockMenu()
      var menu = document.createElement('div')
      menu.id = 'drh-block-menu'
      menu.style.cssText = 'position:fixed;z-index:2147483000;min-width:160px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-elevated, #fff);box-shadow:0 6px 20px rgba(0,0,0,0.18);border:1px solid var(--dsw-alias-line-secondary, rgba(120,120,128,0.2));font-size:13px'
      var actions = [
        { key: 'rename', label: '重命名目录' },
        { key: 'delete', label: '删除目录（远端）' },
      ]
      for (var i = 0; i < actions.length; i += 1) {
        var item = document.createElement('div')
        item.setAttribute('data-drh-menu', actions[i].key)
        item.textContent = actions[i].label
        item.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary, inherit)'
        menu.appendChild(item)
      }
      menu.style.left = Math.min(x, window.innerWidth - 200) + 'px'
      menu.style.top = Math.min(y, window.innerHeight - 120) + 'px'
      menu.addEventListener('click', function (event) {
        var target = event.target
        if (target === null || target === undefined || target.getAttribute === undefined) return
        var kind = target.getAttribute('data-drh-menu')
        var workspaces = ctx.get('workspaces')
        var id = group.id
        try {
          if (kind === 'rename' && id.length > 0) {
            startInlineRename(ctx, group)
          } else if (kind === 'delete' && id.length > 0) {
            if (window.confirm('删除远端目录「' + group.title + '」？')) workspaces.deleteWorkspace(id).catch(function () {})
          }
        } catch (error) { /* ignore */ }
        closeBlockMenu()
      })
      document.body.appendChild(menu)
      setTimeout(function () { document.addEventListener('click', closeBlockMenu, { once: true }) }, 0)
    }

    function openBlockMenu(ctx, x, y, sessionId, isPinned) {
      closeBlockMenu()
      var menu = document.createElement('div')
      menu.id = 'drh-block-menu'
      menu.style.cssText = 'position:fixed;z-index:2147483000;min-width:160px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-elevated, #fff);box-shadow:0 6px 20px rgba(0,0,0,0.18);border:1px solid var(--dsw-alias-line-secondary, rgba(120,120,128,0.2));font-size:13px'
      var items = [
        { key: isPinned === true ? 'unpin' : 'pin', label: isPinned === true ? '取消置顶' : '置顶' },
        { key: 'archive', label: '归档' },
        { key: 'open', label: '打开会话' },
      ]
      for (var i = 0; i < items.length; i += 1) {
        var item = document.createElement('div')
        item.setAttribute('data-drh-menu', items[i].key)
        item.textContent = items[i].label
        item.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary, inherit)'
        item.addEventListener('mouseenter', function () { this.style.background = 'var(--dsh-surface-hover, rgba(38,49,72,0.08))' })
        item.addEventListener('mouseleave', function () { this.style.background = 'transparent' })
        menu.appendChild(item)
      }
      menu.style.left = Math.min(x, window.innerWidth - 180) + 'px'
      menu.style.top = Math.min(y, window.innerHeight - 140) + 'px'
      menu.addEventListener('click', function (event) {
        var target = event.target
        if (target === null || target === undefined || target.getAttribute === undefined) return
        var kind = target.getAttribute('data-drh-menu')
        try {
          if (kind === 'pin') { ctx.uiWorkspace.pinSession(sessionId); blockState.pinned.add(sessionId) }
          else if (kind === 'unpin') { ctx.uiWorkspace.unpinSession(sessionId); blockState.pinned.delete(sessionId) }
          else if (kind === 'archive') ctx.uiWorkspace.archiveSession(sessionId)
          else if (kind === 'open') ctx.uiWorkspace.openSession(sessionId)
        } catch (error) { /* ignore */ }
        closeBlockMenu()
        renderBlock(true)
      })
      document.body.appendChild(menu)
      setTimeout(function () {
        document.addEventListener('click', closeBlockMenu, { once: true })
      }, 0)
    }
    function installRemoteBlock(ctx) {
      try {
        var kick = function () { mountBlock(ctx) }
        kick()
        refreshBlockSummaries(ctx)
        var timer = setInterval(function () { kick(); refreshBlockSummaries(ctx) }, 3000)
        document.addEventListener('drh:state', function () { renderBlock(); refreshBlockSummaries(ctx) })
        return function () { clearInterval(timer) }
      } catch (error) { return function () {} }
    }

    function apply(ctx) {
      // Section headers apply to the shipped list, so they work with sections mode off.
      if (config.remoteBlock === true) installRemoteBlock(ctx)
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

    return { apply, inject: ['slots', 'connection', 'uiWorkspace', 'workspaces'] }
  },
})
//# sourceMappingURL=client.js.map
