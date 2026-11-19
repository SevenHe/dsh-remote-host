/**
 * Decision 5: the snapshot the plugin-rendered block reads.
 *
 * With group:none the shipped list never carries a remote Session, so this
 * snapshot is the block's only data source, and the published id set is what
 * stops remote sessions being classified as local.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

function row(overrides = {}) {
  return {
    sessionId: REMOTE_SESSION,
    updatedAt: NOW,
    running: true,
    cwd: '/data00/work/proj',
    projections: { kind: 'sequenced', asOfSeq: 7, values: { title: 'projected title' } },
    ...overrides,
  }
}

/** Publish one snapshot by running a session/list merge, then return it. */
async function publish(remoteItems) {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems })
  await page.settle()
  await page.built.fetch('api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
  })
  // Round-trip through JSON: the shim builds these objects in the vm realm, and a
  // cross-realm array would fail a strict prototype comparison for the wrong reason.
  const raw = page.sandbox.__DSH_REMOTE_HOST_SESSIONS__
  return { page, published: raw === undefined ? undefined : JSON.parse(JSON.stringify(raw)) }
}

test('publish: an entry carries exactly the block contract', async () => {
  const { published } = await publish([row()])
  assert.equal(published.length, 1)
  assert.deepEqual(Object.keys(published[0]), ['id', 'title', 'updatedAt', 'running', 'cwd'])
  assert.equal(published[0].id, REMOTE_SESSION)
})

test('publish: the title projection wins over a top-level title', async () => {
  const { published } = await publish([row({ title: 'raw title' })])
  assert.equal(published[0].title, 'projected title')
})

test('publish: the top-level title is the fallback when no projection exists', async () => {
  const { published } = await publish([row({ projections: undefined, title: 'raw title' })])
  assert.equal(published[0].title, 'raw title')
})

test('publish: the id itself is the last-resort title', async () => {
  const { published } = await publish([row({ projections: undefined, title: undefined, name: undefined })])
  assert.equal(published[0].title, REMOTE_SESSION)
})

test('publish: no cwd key when the remote row carries none', async () => {
  const { published } = await publish([row({ cwd: undefined })])
  assert.equal(Object.hasOwn(published[0], 'cwd'), false)
  assert.deepEqual(Object.keys(published[0]), ['id', 'title', 'updatedAt', 'running'])
})

test('publish: missing updatedAt becomes null and running is strictly boolean', async () => {
  const { published } = await publish([row({ updatedAt: undefined, running: 'yes' })])
  assert.equal(published[0].updatedAt, null)
  assert.equal(published[0].running, false)
})

test('publish: malformed rows are skipped rather than published', async () => {
  const { published } = await publish([row(), { sessionId: 42 }, null, { title: 'no id' }])
  assert.equal(published.length, 1)
  assert.deepEqual(published.map((entry) => entry.id), [REMOTE_SESSION])
})

test('state: nothing is published while no remote id is known', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: [] })
  await page.settle()
  // Publishing an empty id set would classify every remote Session as local.
  assert.equal(page.sandbox.__DSH_REMOTE_HOST_STATE__, undefined)
  assert.equal(page.sandbox.__DSH_REMOTE_HOST_IDS__, undefined)
})

test('state: known remote ids publish the id set and the group label', async () => {
  const page = createPage({
    config: { group: 'none' },
    localItems: LOCAL_ITEMS,
    remoteItems: [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }],
  })
  await page.settle()
  const state = JSON.parse(JSON.stringify(page.sandbox.__DSH_REMOTE_HOST_STATE__))
  assert.deepEqual(state.ids, [REMOTE_SESSION])
  assert.equal(state.label, '远端工作区 · devbox')
  assert.deepEqual(JSON.parse(JSON.stringify(page.sandbox.__DSH_REMOTE_HOST_IDS__)), [REMOTE_SESSION])
})

test('state: an empty refresh keeps the last good id set', async () => {
  let calls = 0
  const page = createPage({
    config: { group: 'none' },
    localItems: LOCAL_ITEMS,
    // The first answer (prefetch) knows the session; the merge afterwards sees none.
    remoteItems: () => {
      calls += 1
      return calls === 1 ? [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }] : []
    },
  })
  await page.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(page.sandbox.__DSH_REMOTE_HOST_STATE__.ids)), [REMOTE_SESSION])
  await page.built.fetch('api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'session/list', payload: { args: {} } }),
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.sandbox.__DSH_REMOTE_HOST_STATE__.ids)),
    [REMOTE_SESSION],
    'a blank refresh must not un-publish the set',
  )
})
