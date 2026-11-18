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
    const REMOTE_PREFIX = 'dsh-remote-host:'

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
      const [state, setState] = React.useState({ workspaces: [], sessions: [], archived: [], remoteCount: -1, status: remoteStatus() })
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
            setState((previous) => ({ ...previous, workspaces: items, archived }))
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
        document.addEventListener('dsh-remote-host:state', onState)
        document.addEventListener('dsh-remote-host:status', onStatus)
        // Fallback for an event dispatched before this component mounted.
        const poll = setInterval(() => { void refreshSessions(false); syncStatus() }, 1500)
        const stopPolling = setTimeout(() => clearInterval(poll), 30000)
        return () => {
          closed = true
          clearInterval(poll)
          clearTimeout(stopPolling)
          document.removeEventListener('dsh-remote-host:state', onState)
          document.removeEventListener('dsh-remote-host:status', onStatus)
          try { socket?.close() } catch (error) { /* ignore */ }
        }
      }, [ctx])
      return state
    }

    const SectionHeader = ({ children }) => h('div', { style: S.header }, children)

    function SessionRow({ summary, open, stripPrefix, isCurrent }) {
      let title = titleOf(summary)
      if (typeof stripPrefix === 'string' && stripPrefix.length > 0 && title.indexOf(stripPrefix + ' · ') === 0) {
        title = title.slice(stripPrefix.length + 3)
      }
      // Native rows indent with an empty leading slot rather than padding.
      return h('div', {
        style: S.row,
        role: 'treeitem',
        title,
        'data-dsh-rh-row': '',
        'data-dsh-rh-current': isCurrent === true ? 'true' : 'false',
        onClick: () => open(summary.sessionId),
      },
        h('span', { style: S.indent }),
        summary?.running === true ? h('span', { style: S.dot }) : h('span', { style: { ...S.dot, background: 'transparent' } }),
        h('span', { style: S.title }, title),
        h('span', { style: S.time }, relative(summary?.updatedAt)),
      )
    }

    /** The app ships its own icon sprite; reusing it keeps group rows native-looking. */
    function FolderIcon() {
      return h('svg', { width: 16, height: 16, 'aria-hidden': 'true', style: { flex: '0 0 auto', opacity: 0.75 } },
        h('use', { href: '#dsw-icon-folder-close-regular' }))
    }

    function Group({ groupKey, label, sessions, open, expanded, onToggle, stripPrefix }) {
      return h('div', null,
        h('div', {
          style: S.groupRow,
          role: 'treeitem',
          'aria-expanded': expanded ? 'true' : 'false',
          'data-dsh-rh-row': '',
          onClick: onToggle,
        },
          h(Chevron, { open: expanded }),
          h(FolderIcon, null),
          h('span', { style: S.title }, label),
        ),
        expanded === true
          ? (sessions.length === 0
              ? h('div', { style: S.empty }, '暂无会话')
              : sessions.map((summary) => h(SessionRow, { key: summary.sessionId, summary, open, stripPrefix })))
          : null,
      )
    }

    function SectionsSidebar({ __ctx: ctx }) {
      const data = useSidebarData(ctx)
      const [collapsed, setCollapsed] = React.useState({})
      const isOpen = (key, fallback) => (collapsed[key] === undefined ? fallback : collapsed[key] !== true)
      const toggle = (key, fallback) => setCollapsed((previous) => ({
        ...previous,
        [key]: previous[key] === undefined ? fallback === true : previous[key] !== true,
      }))
      const open = (sessionId) => { try { ctx.uiWorkspace.openSession(sessionId) } catch (error) { /* ignore */ } }

      const remote = remoteState()
      const remoteIds = new Set(remote.ids)
      const archived = new Set(data.archived)
      // Subagent (child) sessions are not part of the workspace list the client
      // renders natively, and their history is not reachable from here.
      const visible = data.sessions.filter((summary) => !summary?.parentSessionId && !archived.has(summary.sessionId))
      const local = visible.filter((summary) => remoteIds.has(summary.sessionId) === false)
      const byId = new Map(visible.map((summary) => [summary.sessionId, summary]))

      const localGroups = data.workspaces
        .filter((workspace) => String(workspace.workspaceId).startsWith(REMOTE_PREFIX) === false)
        .map((workspace) => {
          const members = new Set(workspace.sessionIds ?? [])
          return {
            key: 'w:' + workspace.workspaceId,
            label: workspace.title || 'workspace',
            sessions: local.filter((summary) => members.has(summary.sessionId)),
          }
        })
        .filter((group) => group.sessions.length > 0)
      const accounted = new Set(data.workspaces.flatMap((workspace) => workspace.sessionIds ?? []))
      // Until the remote set is known, "not in a local workspace" is not evidence
      // of being ungrouped: it may simply be remote.
      const stray = remoteKnown() === true
        ? local.filter((summary) => accounted.has(summary.sessionId) === false)
        : []

      const remoteGroups = (remote.workspaces ?? []).map((space) => ({
        key: 'r:' + space.title,
        label: space.title,
        sessions: (space.sessionIds ?? []).map((id) => byId.get(id)).filter(Boolean),
        stripPrefix: space.title,
      })).filter((group) => group.sessions.length > 0)

      return h('div', { style: S.root },
        h(SectionHeader, { key: 'h:local' }, '工作区'),
        localGroups.length === 0 && stray.length === 0 ? h('div', { key: 'e:local', style: S.empty }, '暂无工作区') : null,
        ...localGroups.map((group) => h(Group, {
          key: group.key,
          groupKey: group.key,
          label: group.label,
          sessions: group.sessions,
          open,
          expanded: isOpen(group.key, true),
          onToggle: () => toggle(group.key, true),
        })),
        stray.length === 0 ? null : h(Group, {
          key: 'g:stray',
          label: '未分组',
          sessions: stray,
          open,
          expanded: isOpen('__stray__', false),
          onToggle: () => toggle('__stray__', false),
        }),

        h(SectionHeader, { key: 'h:remote' },
          h('span', {
            key: 'dot',
            className: 'dsh-rh-dot',
            'data-state': data.status,
            title: data.status === 'open' ? '已连接' : data.status === 'error' ? '连接失败' : '正在连接',
          }),
          '远端工作区 · ' + (remote.label || config.label || 'remote')),
        remoteGroups.length === 0
          ? h('div', { key: 'e:remote', style: S.empty }, '远端未连接')
          : null,
        ...remoteGroups.map((group) => h(Group, {
          key: group.key,
          groupKey: group.key,
          label: group.label,
          sessions: group.sessions,
          open,
          stripPrefix: group.stripPrefix,
          expanded: isOpen(group.key, false),
          onToggle: () => toggle(group.key, false),
        })),
      )
    }

    /** Native rows highlight on hover and for the open session; inline styles cannot. */
    function installRowStyles() {
      try {
        if (document.getElementById('dsh-remote-host-rows') !== null) return
        const style = document.createElement('style')
        style.id = 'dsh-remote-host-rows'
        style.textContent = [
          '[data-dsh-rh-row]{transition:background-color 120ms ease}',
          '[data-dsh-rh-row]:hover{background:var(--dsh-surface-hover, rgba(38, 49, 72, 0.06))}',
          '[data-dsh-rh-row][data-dsh-rh-current="true"]{background:var(--dsh-surface-selected, rgba(38, 49, 72, 0.09))}',
          '.dsh-rh-dot{flex:0 0 auto;width:.5em;height:.5em;border-radius:50%;box-sizing:border-box;background:var(--dsh-text-tertiary, rgba(120,120,128,.9))}',
          '.dsh-rh-dot[data-state="open"]{background:#2ea043}',
          '.dsh-rh-dot[data-state="error"]{background:#d1242f}',
          '.dsh-rh-dot[data-state="connecting"]{background:transparent;border:1.5px solid rgba(120,120,128,.75);border-top-color:transparent;animation:dsh-rh-spin .8s linear infinite}',
          '@keyframes dsh-rh-spin{to{transform:rotate(360deg)}}',
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
        const apply = () => {
          const entries = document.querySelectorAll('button,[role="button"],a,li,div')
          for (const entry of entries) {
            if ((entry.textContent || '').trim() !== 'Superagent') continue
            // The label may sit in a nested span, so walk every text node.
            const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
            let node = walker.nextNode()
            while (node !== null) {
              if ((node.textContent || '').trim() === 'Superagent') node.textContent = target
              node = walker.nextNode()
            }
          }
        }
        apply()
        const observer = new MutationObserver(apply)
        observer.observe(document.body, { childList: true, subtree: true })
        setTimeout(() => observer.disconnect(), 20000)
      } catch (error) { /* labelling is cosmetic */ }
    }

    function apply(ctx) {
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
