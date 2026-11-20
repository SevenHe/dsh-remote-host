/**
 * Decision 1: how a remote Workspace record is folded into the shipped
 * workspace/follow baseline for each 'group' mode.
 *
 * Driven through the real mux router: open workspace/follow, feed one baseline
 * per leg, and read the merged baseline the shim hands the page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const LOCAL_SESSION = 'local-1'
const REMOTE_ITEMS = [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: LOCAL_SESSION, updatedAt: NOW, running: false }]

function localWorkspace() {
  return {
    workspaceId: 'local-ws',
    path: '/Users/somebody/Workspace/opencode',
    title: 'opencode',
    sessionIds: [LOCAL_SESSION],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
}

function remoteWorkspace(sessionIds = [REMOTE_SESSION]) {
  return {
    workspaceId: 'remote-ws',
    path: '/home/user/work/proj',
    title: 'proj',
    sessionIds,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
  }
}

/** Merge one workspace/follow baseline pair and return the merged value. */
async function mergeWorkspaceFollow({ group, remoteItems = REMOTE_ITEMS, remoteSessionIds, archived = [], pinned = [] }) {
  const page = createPage({ config: { group }, localItems: LOCAL_ITEMS, remoteItems })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'w1', endpoint: 'workspace/follow', payload: { args: {} } }))

  const localOpen = page.sent('local').find((frame) => frame.type === 'open')
  const remoteOpen = page.sent('remote').find((frame) => frame.type === 'open')
  assert.ok(localOpen, 'the local leg receives the workspace/follow open')
  assert.ok(remoteOpen, 'the remote leg receives the workspace/follow open')

  page.sockets.get('local').frame({
    type: 'item',
    streamId: localOpen.streamId,
    value: { type: 'baseline', value: { items: [localWorkspace()], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  page.sockets.get('remote').frame({
    type: 'item',
    streamId: remoteOpen.streamId,
    value: {
      type: 'baseline',
      value: { items: [remoteWorkspace(remoteSessionIds)], archivedSessionIds: archived, pinnedSessionIds: pinned },
    },
  })

  const baselines = page.frames((frame) => frame.value?.type === 'baseline')
  assert.equal(baselines.length, 1, 'exactly one merged baseline reaches the page')
  return { page, merged: baselines[0].value.value }
}

test('group none: no remote workspace reaches the shipped baseline', async () => {
  const { merged } = await mergeWorkspaceFollow({ group: 'none' })
  assert.deepEqual(merged.items.map((item) => item.workspaceId), ['local-ws'])
  assert.deepEqual(merged.items[0].sessionIds, [LOCAL_SESSION])
})
test('group none: remote archive/pin marks are not folded in', async () => {
  const { merged } = await mergeWorkspaceFollow({
    group: 'none',
    archived: [REMOTE_SESSION],
    pinned: [REMOTE_SESSION],
  })
  assert.deepEqual(merged.archivedSessionIds, [])
  assert.deepEqual(merged.pinnedSessionIds, [])
})

test("group single: remote workspaces collapse into one group holding only remote sessions", async () => {
  const { merged } = await mergeWorkspaceFollow({ group: 'single' })
  const remote = merged.items.filter((item) => item.workspaceId === 'drh:devbox')
  assert.equal(remote.length, 1, 'exactly one synthetic remote group')
  assert.equal(remote[0].title, '远端工作区 · devbox')
  assert.deepEqual(remote[0].sessionIds, [REMOTE_SESSION])
})

test('group single: a remote session no record claims still shows up', async () => {
  // The remote workspace claims a session the id table does not know; the
  // visible remote session must still be listed, or it would be unreachable.
  const { merged } = await mergeWorkspaceFollow({ group: 'single', remoteSessionIds: ['not-a-remote-session'] })
  const remote = merged.items.find((item) => item.workspaceId === 'drh:devbox')
  assert.deepEqual(remote.sessionIds, [REMOTE_SESSION])
})

test('group workspace: remote rows keep their id with the drh: prefix and drop foreign sessions', async () => {
  const { merged } = await mergeWorkspaceFollow({
    group: 'workspace',
    remoteSessionIds: [REMOTE_SESSION, LOCAL_SESSION],
  })
  const remote = merged.items.find((item) => item.workspaceId === 'drh:remote-ws')
  assert.equal(remote.workspaceId, 'drh:remote-ws', 'the shipped renderer keys rows by workspaceId')
  assert.deepEqual(remote.sessionIds, [REMOTE_SESSION], 'a session this host does not know stays out')
  assert.equal(remote.path, '/home/user/work/proj')
})

test('group workspace: a remote workspace owning no visible session is dropped', async () => {
  const { merged } = await mergeWorkspaceFollow({ group: 'workspace', remoteSessionIds: [LOCAL_SESSION] })
  assert.deepEqual(merged.items.map((item) => item.workspaceId), ['local-ws'])
})

test('group workspace: archive marks are filtered to remote sessions', async () => {
  const { merged } = await mergeWorkspaceFollow({
    group: 'workspace',
    archived: [REMOTE_SESSION, LOCAL_SESSION],
    pinned: [LOCAL_SESSION, REMOTE_SESSION],
  })
  assert.deepEqual(merged.archivedSessionIds, [REMOTE_SESSION])
  assert.deepEqual(merged.pinnedSessionIds, [REMOTE_SESSION])
})
