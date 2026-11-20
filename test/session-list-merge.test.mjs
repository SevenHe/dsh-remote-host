/**
 * Decision 2: what the merged session/list answers.
 *
 * The 'none' case is the regression guard for the leak where a remote session
 * appeared in the shipped sidebar's "Ungrouped" bucket.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage, DAY } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const LOCAL_SESSION = 'local-1'
const LOCAL_ITEMS = [{ sessionId: LOCAL_SESSION, updatedAt: NOW, running: false }]

function remoteRow(overrides = {}) {
  return { sessionId: REMOTE_SESSION, updatedAt: NOW, running: true, ...overrides }
}

/** Ask the shim for session/list exactly as the page's carrier does. */
async function listMerge(options = {}) {
  const page = createPage(options)
  await page.settle()
  const response = await page.built.fetch('api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
  })
  const body = await response.json()
  assert.equal(body.result.ok, true, 'the merged answer stays a successful envelope')
  return { page, items: body.result.value.items }
}

test('session/list none: remote rows are listed so the client catalog can retain them', async () => {
  const { items } = await listMerge({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: [remoteRow()] })
  // The catalog needs the id before sessions.retain accepts it; leaking into the shipped
  // Ungrouped bucket is prevented by the hidden claiming Workspace (group-modes.test.mjs).
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION, REMOTE_SESSION])
})

test('session/list single: local rows first, then the visible remote ones', async () => {
  const { items } = await listMerge({ config: { group: 'single' }, localItems: LOCAL_ITEMS, remoteItems: [remoteRow()] })
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION, REMOTE_SESSION])
})

test('session/list workspace: remote rows are merged too', async () => {
  const { items } = await listMerge({ config: { group: 'workspace' }, localItems: LOCAL_ITEMS, remoteItems: [remoteRow()] })
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION, REMOTE_SESSION])
})

test('session/list: a stale, idle remote session is filtered out of the merge', async () => {
  const stale = remoteRow({ running: false, updatedAt: NOW - 400 * DAY })
  const { items } = await listMerge({ config: { group: 'single' }, localItems: LOCAL_ITEMS, remoteItems: [stale] })
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION])
})

test('session/list: a stale row that is still running is kept', async () => {
  const stale = remoteRow({ running: true, updatedAt: NOW - 400 * DAY })
  const { items } = await listMerge({ config: { group: 'single' }, localItems: LOCAL_ITEMS, remoteItems: [stale] })
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION, REMOTE_SESSION])
})

test('session/list: an unreachable mount leaves the local answer untouched', async () => {
  const { items, page } = await listMerge({
    config: { group: 'single' },
    localItems: LOCAL_ITEMS,
    remoteItems: [remoteRow()],
    failRemote: true,
  })
  assert.deepEqual(items.map((item) => item.sessionId), [LOCAL_SESSION])
  assert.equal(page.sandbox.__DSH_REMOTE_HOST_SESSIONS__ ?? undefined, undefined, 'nothing is published from a failed merge')
})
