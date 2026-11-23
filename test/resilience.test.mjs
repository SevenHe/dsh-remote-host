/**
 * Failure-path resilience: an unreachable mount must degrade, never reject.
 *
 * The shipped Client treats a rejected carrier call as a crashing service
 * ("conversation service unavailable"), and a corporate-network blip used to make every
 * remote call reject. These cases drive the real shim with failing carriers and count
 * what escapes.
 *
 * Note: the shim runs in a node:vm realm, so a value it builds has that realm's
 * prototypes. Every assertion here round-trips the carrier result through JSON first;
 * comparing a sandbox {} to a test-realm {} fails deepStrictEqual for the wrong reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_ITEMS = [{ sessionId: 'worker-1', updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]
const REMOTE_ARGS = { sessionId: 'worker-1' }

/** Bring a sandbox-realm value into the test realm. */
const plain = (value) => JSON.parse(JSON.stringify(value))

/** Run body while recording any unhandled rejection that surfaces. */
async function unhandledDuring (body) {
  const seen = []
  const record = (reason) => seen.push(reason)
  process.on('unhandledRejection', record)
  try {
    await body()
    // Drain the microtask and timer queues so a stray rejection can surface.
    await new Promise((resolve) => setTimeout(resolve, 60))
  } finally {
    process.off('unhandledRejection', record)
  }
  return seen
}

test('rpc carrier: a failed remote call answers with a Remote failure, never rejects', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true, rpcFail: true })
  await page.settle() // the prefetch establishes the remote id set first
  page.options.failMountFetch = true // then the network blips
  const result = plain(await page.built.rpc.call('/api', 'session/state', { args: REMOTE_ARGS }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/remote-unavailable')
  assert.equal(typeof result.error.message, 'string')
  assert.deepEqual(result.error.details, {})
})

test('rpc carrier: session/list answers a carrier result when both legs fail', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true, rpcFail: true })
  await page.settle()
  page.options.failMountFetch = true
  const result = plain(await page.built.rpc.call('/api', 'session/list', { args: { _request: {} } }))
  assert.equal(typeof result, 'object')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/remote-unavailable')
})

test('twelve failing rpc calls leak no unhandled rejection', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true, rpcFail: true })
  await page.settle()
  page.options.failMountFetch = true
  const leaked = await unhandledDuring(async () => {
    for (let index = 0; index < 12; index += 1) {
      const result = plain(await page.built.rpc.call('/api', 'session/state', { args: REMOTE_ARGS }))
      assert.equal(result.ok, false, 'every call degrades instead of throwing')
    }
  })
  assert.deepEqual(leaked, [])
})

test('fetch carrier: a blip on the mount falls back to the local answer', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, failMountFetch: true })
  await page.settle()
  const leaked = await unhandledDuring(async () => {
    const response = await page.built.fetch('api/session/state', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/state', payload: { args: REMOTE_ARGS } }),
    })
    assert.equal(response.ok, true, 'the local leg answered')
  })
  assert.deepEqual(leaked, [])
})

test('repeated failures keep exactly one retry pending', async () => {
  const page = createPage({ config: { group: 'none' }, remoteItems: REMOTE_ITEMS, remoteReadyState: 0 })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  assert.ok(page.sockets.get('remote'), 'the remote leg is opened')
  // Samplers (500/2000) and the workspace prefetch (8000) are page noise, not retries.
  const noise = [500, 2000, 8000]
  const retries = () => page.timerDelays().filter((delay) => delay >= 200 && noise.includes(delay) === false)
  for (let round = 0; round < 12; round += 1) {
    const before = page.timerDelays().length
    page.sockets.get('remote').emit('close', { code: 1006 })
    const added = page.timerDelays().slice(before)
    assert.equal(added.length, 1, 'one retry per failure, round ' + String(round))
    page.fireTimers()
  }
  assert.ok(retries().length <= 1, 'retries do not accumulate: ' + String(retries().length))
})
