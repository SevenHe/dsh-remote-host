/**
 * The hidden-session Set: page state that tells the shipped sidebar which remote Sessions
 * it must not list.
 *
 * With group:none no remote Workspace record reaches the merged baseline, so without this Set
 * the shipped tree would file every remote Session under its Ungrouped bucket. The shipped
 * tree reads it in `sessionVisible()`; this file pins the publishing side, which is all a
 * local test can see (the shipped client here is unpatched).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_ROW = (id) => ({ sessionId: id, updatedAt: NOW, running: true })
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

/** Ask the shim's merged session/list the way the page's carrier does. */
async function askList(page) {
  const response = await page.built.fetch('api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
  })
  return (await response.json()).result.value.items.map((item) => item.sessionId)
}

/**
 * Merge one workspace/follow baseline pair and return every frame the page received, so a
 * test can assert that no synthetic Workspace row is published in any mode.
 */
async function mergeBaseline(page) {
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'w1', endpoint: 'workspace/follow', payload: { args: {} } }))
  const localOpen = page.sent('local').find((frame) => frame.type === 'open')
  const remoteOpen = page.sent('remote').find((frame) => frame.type === 'open')
  const workspace = (workspaceId, title, sessionIds) => ({
    workspaceId, path: '/home/user/work/' + title, title, sessionIds,
    createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z',
  })
  page.sockets.get('local').frame({
    type: 'item',
    streamId: localOpen.streamId,
    value: { type: 'baseline', value: { items: [workspace('local-ws', 'opencode', ['local-1'])], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  page.sockets.get('remote').frame({
    type: 'item',
    streamId: remoteOpen.streamId,
    value: { type: 'baseline', value: { items: [workspace('remote-ws', 'proj', ['worker-1'])], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  const baselines = page.frames((frame) => frame.value?.type === 'baseline')
  assert.equal(baselines.length, 1, 'exactly one merged baseline reaches the page')
  return { page, merged: baselines[0].value.value }
}

test('group none: every visible remote session is published in the hidden set', async () => {
  const page = createPage({
    config: { group: 'none' },
    localItems: LOCAL_ITEMS,
    remoteItems: [REMOTE_ROW('worker-1'), REMOTE_ROW('worker-2')],
  })
  await page.settle()
  const hidden = page.sandbox.__DSH_HIDDEN_SESSIONS__
  assert.ok(hidden instanceof Set, 'the shipped tree reads a Set, so a Set is published')
  assert.deepEqual([...hidden].sort(), ['worker-1', 'worker-2'])
})

test('group none: no remote session yet publishes no set (never an empty one)', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: [] })
  await page.settle()
  assert.equal(page.sandbox.__DSH_HIDDEN_SESSIONS__, undefined,
    'an empty Set would hide nothing: publish nothing and keep the previous value')
})

test('the set is rebuilt only when its membership changes', async () => {
  const rows = [REMOTE_ROW('worker-1')]
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: () => rows })
  await page.settle()
  const first = page.sandbox.__DSH_HIDDEN_SESSIONS__
  assert.deepEqual([...first], ['worker-1'])
  // Same membership: the tree keeps the object it already holds, so no rewrite.
  await askList(page)
  assert.equal(page.sandbox.__DSH_HIDDEN_SESSIONS__, first, 'an unchanged set is not rebuilt')
  // New membership: a replace would leave the tree hiding a stale id, so a new Set is due.
  rows.push(REMOTE_ROW('worker-2'))
  await askList(page)
  const second = page.sandbox.__DSH_HIDDEN_SESSIONS__
  assert.notEqual(second, first, 'a changed set is republished')
  assert.deepEqual([...second].sort(), ['worker-1', 'worker-2'])
})

test('group single and workspace publish no hidden set', async () => {
  for (const group of ['single', 'workspace']) {
    const page = createPage({ config: { group }, localItems: LOCAL_ITEMS, remoteItems: [REMOTE_ROW('worker-1')] })
    await page.settle()
    assert.equal(page.sandbox.__DSH_HIDDEN_SESSIONS__, undefined,
      group + ' shows its remote rows through merged workspaces, so nothing is hidden')
  }
})

test('a global of another type is not taken over', async () => {
  const page = createPage({
    config: { group: 'none' },
    localItems: LOCAL_ITEMS,
    remoteItems: [REMOTE_ROW('worker-1')],
    globals: { __DSH_HIDDEN_SESSIONS__: ['somebody-elses-array'] },
  })
  await page.settle()
  assert.deepEqual(page.sandbox.__DSH_HIDDEN_SESSIONS__, ['somebody-elses-array'],
    'a non-Set value belongs to another producer and is left in place')
})

test('unloading the page releases the set, and the next list answer republishes it', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: [REMOTE_ROW('worker-1')] })
  await page.settle()
  assert.ok(page.sandbox.__DSH_HIDDEN_SESSIONS__ instanceof Set)
  page.emitGlobal('pagehide')
  assert.equal(page.sandbox.__DSH_HIDDEN_SESSIONS__, undefined, 'an unloaded page keeps hiding nothing')
  page.emitGlobal('pagehide')
  assert.equal(page.sandbox.__DSH_HIDDEN_SESSIONS__, undefined, 'releasing twice is harmless')
  // A restore from the back/forward cache keeps the process, so the state rebuilds from the
  // next list answer instead of staying lost.
  await askList(page)
  assert.deepEqual([...(page.sandbox.__DSH_HIDDEN_SESSIONS__ ?? [])], ['worker-1'])
})

test('no mode publishes a synthetic claim workspace any more', async () => {
  for (const group of ['none', 'single', 'workspace']) {
    const page = createPage({ config: { group }, localItems: LOCAL_ITEMS, remoteItems: [REMOTE_ROW('worker-1')] })
    await page.settle()
    const { merged } = await mergeBaseline(page)
    const published = [merged, await askList(page), page.sandbox.__DSH_REMOTE_HOST_STATE__,
      page.sandbox.__DSH_REMOTE_HOST_IDS__, page.sandbox.__DSH_REMOTE_HOST_SESSIONS__,
      page.sandbox.__DSH_REMOTE_HOST_MARKS__]
    const text = JSON.stringify(published)
    assert.equal(text.includes('drh:claim'), false, group + ': no published result carries a claim workspace')
    assert.equal(merged.items.some((item) => String(item.workspaceId).includes('claim')), false,
      group + ': the merged baseline carries no claiming row')
  }
})
