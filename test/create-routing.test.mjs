/**
 * session/create routing.
 *
 * A create is workspace-scoped, but the shim used to route it by "does the payload
 * mention a remote id". Every boot restores the last Session by calling session/create
 * with a remote Session id in the payload, so that decision sent the create to the mount,
 * whose Host does not own the workspace, and the page logged
 *   workspace/not-found: workspace "drh:claim" not found
 * on every start.
 *
 * These cases pin the workspace-based decision and the claim-workspace rewrite.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const REMOTE_ITEMS = [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

const createCall = (page, request) => page.built.fetch('api/session/create', {
  method: 'POST',
  body: JSON.stringify({ type: 'client-request', rpcId: 'c1', method: 'session/create', payload: { args: { request } } }),
})

function callsDuring (page, probe) {
  const beforeMount = page.apiCalls('mount').length
  const beforeLocal = page.apiCalls('local').length
  return Promise.resolve(probe()).then(() => ({
    mount: page.apiCalls('mount').slice(beforeMount),
    local: page.apiCalls('local').slice(beforeLocal),
    localBodies: page.calls.bodies.local.slice(beforeLocal),
  }))
}

test('session/create: a local workspace stays local even when the payload names a remote Session', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const seen = await callsDuring(page, () => createCall(page, { workspaceId: 'local-ws', sessionId: REMOTE_SESSION }))
  assert.deepEqual(seen.mount, [], 'must not reach the mount: it does not own local-ws')
  assert.deepEqual(seen.local, ['/api/session/create'])
})

test('session/create: the synthetic claim workspace is created locally without its workspaceId', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const seen = await callsDuring(page, () => createCall(page, { workspaceId: 'drh:claim' }))
  assert.deepEqual(seen.mount, [], 'no Host owns drh:claim, so it must not reach the mount')
  assert.deepEqual(seen.local, ['/api/session/create'])
  assert.equal(seen.localBodies.length, 1, 'the local create is observed')
  const forwarded = JSON.parse(seen.localBodies[0].body)
  assert.equal(Object.prototype.hasOwnProperty.call(forwarded.payload.args.request, 'workspaceId'), false,
    'the claim workspaceId is dropped so the local Host can answer')
})
// --- the rpc carrier (desktop shell) must make the same decision -----------------------
// The shell publishes a decoded carrier, and the shim wraps rpc.call instead of fetch. The
// fetch-side fix alone would leave this path misrouting, so these two cases pin it.

const rpcCreate = (page, payload) => page.built.rpc.call('/api', 'session/create', payload)

test('rpc carrier: a local workspace create is not sent to the mount', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true })
  await page.settle()
  const beforeMount = page.apiCalls('mount').length
  await rpcCreate(page, { args: { request: { workspaceId: 'local-ws', sessionId: REMOTE_SESSION } } })
  const mounted = page.apiCalls('mount').slice(beforeMount)
  assert.deepEqual(mounted, [], 'the mount must not receive a create for a local workspace')
  const seen = page.rpcCallsFor('session/create')
  assert.equal(seen.length, 1, 'the local carrier answers the create')
  assert.equal(seen[0].payload.args.request.workspaceId, 'local-ws')
  assert.equal(seen[0].payload.args.request.sessionId, REMOTE_SESSION)
})

test('rpc carrier: the claim workspace create reaches the local carrier without workspaceId', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true })
  await page.settle()
  const beforeMount = page.apiCalls('mount').length
  await rpcCreate(page, { args: { request: { workspaceId: 'drh:claim' } } })
  const mounted = page.apiCalls('mount').slice(beforeMount)
  assert.deepEqual(mounted, [], 'no Host owns drh:claim, so the mount must not see it')
  const seen = page.rpcCallsFor('session/create')
  assert.equal(seen.length, 1, 'the create still happens, locally')
  assert.equal(Object.prototype.hasOwnProperty.call(seen[0].payload.args.request, 'workspaceId'), false,
    'the claim workspaceId is dropped before the local carrier sees it')
  assert.equal(seen[0].channel, '/api')
})
