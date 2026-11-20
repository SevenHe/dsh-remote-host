/**
 * Reconnect policy: a dropped or unreachable remote leg retries on a capped
 * exponential ladder, one attempt at a time.
 *
 * The regression this locks: reconnectRemote() used to re-enter itself when a
 * carrier could not even be constructed, so a synchronously failing factory
 * recursed with no delay and wedged the renderer.
 *
 * Only the reconnect timers are asserted; a page also schedules unrelated
 * timers (leg readyState samplers at 500/2000 ms, the carrier-adoption ladder),
 * so the helper filters to the reconnect backoff range.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_ITEMS = [{ sessionId: 'worker-1', updatedAt: NOW, running: true }]
/**
 * Timers a page schedules on its own (leg readyState samplers, the adoption
 * ladder, the workspace prefetch timeout) would swamp a value filter, so a test
 * measures only the timers that appear after it acts.
 */
const addedDelays = (page, before) => page.timerDelays().slice(before)

/** Open the mux with a remote leg that never finishes connecting. */
async function openLegs() {
  const page = createPage({ config: { group: 'none' }, remoteItems: REMOTE_ITEMS, remoteReadyState: 0 })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  assert.ok(page.sockets.get('remote'), 'the remote leg is opened for the forwarded-event stream')
  return page
}

test('reconnect delays double from 200 ms and cap at 10 s', async () => {
  const page = await openLegs()
  const seen = []
  for (let step = 0; step < 8; step += 1) {
    const before = page.timerDelays().length
    page.sockets.get('remote').emit('close', { code: 1006 })
    const pending = addedDelays(page, before)
    assert.equal(pending.length, 1, 'one reconnect timer per failure, not a stack of them')
    seen.push(pending[0])
    page.fireTimers()
  }
  assert.deepEqual(seen, [200, 400, 800, 1600, 3200, 6400, 10000, 10000])
})

test('overlapping error and close events schedule a single reconnect', async () => {
  const page = await openLegs()
  const socket = page.sockets.get('remote')
  const before = page.timerDelays().length
  socket.emit('error', {})
  socket.emit('close', { code: 1006 })
  socket.emit('close', { code: 1006 })
  assert.deepEqual(addedDelays(page, before), [200], 'single flight: exactly one pending retry')
})
