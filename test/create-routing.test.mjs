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
