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
  // Samplers (500/2000), the workspace prefetch (8000) and the per-attempt open watchdog
  // (2500) are page noise, not retries.
  const noise = [500, 2000, 8000, 2500]
  const retries = () => page.timerDelays().filter((delay) => delay >= 200 && noise.includes(delay) === false)
  for (let round = 0; round < 12; round += 1) {
    const before = page.timerDelays().length
    page.sockets.get('remote').emit('close', { code: 1006 })
    const added = page.timerDelays().slice(before)
    const addedRetries = added.filter((delay) => noise.includes(delay) === false)
    assert.equal(addedRetries.length, 1, 'one retry per failure, round ' + String(round))
    assert.ok(added.length <= 2, 'at most one retry plus one watchdog, round ' + String(round))
    page.fireTimers()
  }
  assert.ok(retries().length <= 1, 'retries do not accumulate: ' + String(retries().length))
})

/**
 * Degradation: while the remote leg is unusable this router keeps the page socket open, so the
 * shipped connection layer never sees a failure it can act on. A flapped connection used to end
 * with a dead renderer (exitCode 5 = SIGTRAP, reproduced outside this file); after
 * DEGRADE_AFTER_MS the mux is handed back instead. These tests pin that contract.
 */
function clockedPage(options) {
  const page = createPage(options)
  let now = 1795420000000
  page.sandbox.Date.now = () => now
  return { page, advance: (ms) => { now += ms } }
}

test('degrade: repeated async failures hand the mux back exactly once', async () => {
  const { page, advance } = clockedPage({ config: { group: 'none' }, remoteItems: REMOTE_ITEMS, remoteReadyState: 0 })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  const remote = page.sockets.get('remote')
  assert.ok(remote, 'the remote leg is opened')
  remote.emit('close', { code: 1006 })
  advance(3000)
  remote.emit('error', { type: 'error' })
  assert.equal(client.readyState === 3, false, 'still connected while inside the window')
  advance(3500)
  remote.emit('close', { code: 1006 })
  assert.equal(client.readyState, 3, 'past the window the mux is handed back')
  const after = page.timerDelays().length
  advance(20000)
  remote.emit('close', { code: 1006 })
  assert.equal(page.timerDelays().length, after, 'no new retry once degraded')
})

test('degrade: a successful remote open resets the clock', async () => {
  const { page, advance } = clockedPage({ config: { group: 'none' }, remoteItems: REMOTE_ITEMS, remoteReadyState: 0 })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  const remote = page.sockets.get('remote')
  remote.emit('close', { code: 1006 })
  advance(1000)
  remote.emit('open', {})
  // The recovery work is deferred out of the socket's open dispatch on purpose; drain it.
  page.fireTimers()
  page.fireTimers()
  advance(20000)
  assert.equal(client.readyState === 3, false, 'the successful open cleared the outage clock')
})

test('degrade: a healthy connection never degrades', async () => {
  const { page, advance } = clockedPage({ config: { group: 'none' }, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  const remote = page.sockets.get('remote')
  assert.ok(remote, 'the remote leg is opened')
  advance(60000)
  page.fireTimers()
  assert.equal(client.readyState, 1, 'a healthy mount stays connected')
})
