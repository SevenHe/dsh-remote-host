/**
 * The remote leg's reconnect controller: the diagnostic trace it must keep emitting in the same
 * order, the ladder state it owns privately, and the handoff that ends it.
 *
 * createMuxRouter used to carry this state in seven variables written from the
 * connect/open/error/close callbacks. The extraction moved them into one controller, so these
 * cases pin the observable contract the move had to preserve: renderer-trace.log and
 * docs/crash-triage.md read the trace event names, and the page must keep behaving the same.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_ITEMS = [{ sessionId: 'worker-1', updatedAt: NOW, running: true }]

/**
 * Trace event names, in order, as the crash harness reads them out of the page global.
 * The shim runs in a node:vm realm, so the tail is its realm's Array: rebuild it in this one,
 * or deepEqual fails on the prototypes rather than on the values.
 */
function traceNames(page) {
  const tail = page.sandbox.__DRH_TRACE_TAIL__ ?? []
  return Array.from(tail, (line) => String(line).split(' ')[1])
}

/** Bring the controller's sandbox-realm report into this realm. */
const reportOf = (client) => JSON.parse(JSON.stringify(client.__legReport()))

/**
 * Open the mux onto a remote leg that never finishes connecting, so the ladder keeps working.
 * @param options.config - extra shim config; `trace` and `group` are always set.
 */
async function openLegs(options = {}) {
  const page = createPage({
    config: { group: 'none', trace: true, ...(options.config ?? {}) },
    remoteItems: REMOTE_ITEMS,
    remoteReadyState: 0,
  })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  assert.ok(page.sockets.get('remote'), 'the remote leg is dialled for the forwarded-event stream')
  return { page, client, remote: page.sockets.get('remote') }
}

test('reconnect: the ladder keeps its diagnostic trace names and order', async (t) => {
  const { page, remote } = await openLegs()
  t.after(() => page.dispose())
  const seen = traceNames(page).length
  remote.emit('close', { code: 1006 })
  page.fireTimers() // the 200 ms backoff attempt: dial, wire, arm the open watchdog
  page.fireTimers() // the watchdog: abandon the socket that never opened, and repeat
  assert.deepEqual(traceNames(page).slice(seen), [
    // the outage starts and the first attempt is scheduled
    'announce', 'remote-unavailable', 'reconnect-enter', 'reconnect-begin', 'announce', 'reconnect-end',
    // the attempt dials and arms the watchdog
    'attempt-run', 'connect-return', 'attempt-socket', 'listener-attach',
    // a socket that neither opened nor errored is abandoned, and the ladder repeats
    'attempt-abandoned', 'remote-unavailable', 'reconnect-enter', 'reconnect-begin', 'reconnect-end',
  ])
  assert.deepEqual(page.timerDelays().filter((delay) => delay === 400), [400], 'the next attempt backs off to 400 ms')
})

test('report: the leg reports the ladder state it owns privately', async (t) => {
  const { page, client, remote } = await openLegs()
  t.after(() => page.dispose())
  let now = 1_795_420_000_000
  page.sandbox.Date.now = () => now
  assert.deepEqual(reportOf(client), { degraded: false, attempts: 0, pending: false, unavailableMs: 0 })
  remote.emit('close', { code: 1006 })
  assert.deepEqual(reportOf(client), { degraded: false, attempts: 1, pending: true, unavailableMs: 0 })
  now += 3000
  remote.emit('error', { type: 'error' })
  assert.deepEqual(reportOf(client), {
    degraded: false, attempts: 1, pending: true, unavailableMs: 3000,
  }, 'the outage clock starts at the first failure and is reported in milliseconds')
})

test('degrade: the handoff reports the leg as degraded and stops the ladder', async (t) => {
  const { page, client, remote } = await openLegs()
  t.after(() => page.dispose())
  let now = 1_795_420_000_000
  page.sandbox.Date.now = () => now
  remote.emit('close', { code: 1006 })
  now += 3000
  remote.emit('error', { type: 'error' })
  now += 3500
  const seen = traceNames(page).length
  remote.emit('close', { code: 1006 })
  assert.deepEqual(traceNames(page).slice(seen), [
    'remote-unavailable', 'degrade-handoff', 'reconnect-enter', 'attempt-early-return',
  ], 'the outage outlives the window, so the mux is handed back and the ladder refuses to restart')
  assert.equal(client.readyState, 3, 'the shipped client sees the failure and can reconnect')
  assert.deepEqual(reportOf(client), {
    degraded: true, attempts: 1, pending: false, unavailableMs: 6500,
  })
  const timersAtDegrade = page.timerDelays().length
  now += 60000
  remote.emit('close', { code: 1006 })
  assert.equal(page.timerDelays().length, timersAtDegrade, 'a degraded leg never schedules another attempt')
})

test('relay: the Host owns the mount, so the renderer never re-dials its leg', async (t) => {
  // streamRelay is on by default in the page; the relay leg is the Host's to reconnect.
  const { page, client, remote } = await openLegs({ config: { streamRelay: undefined } })
  t.after(() => page.dispose())
  remote.close()
  remote.emit('close', { code: 1006 })
  assert.deepEqual(reportOf(client), {
    degraded: false, attempts: 0, pending: false, unavailableMs: 0,
  }, 'no ladder runs for a relayed leg')
  client.send(JSON.stringify({
    type: 'open', streamId: 'r2', endpoint: 'session/follow', payload: { args: { sessionId: 'worker-1' } },
  }))
  const remoteDials = page.calls.sockets.filter((kind) => kind === 'remote').length
  assert.equal(remoteDials, 1, 'the renderer dialled the mount once and never again')
  assert.equal(client.readyState, 1, 'the page socket stays open: only the Host reconnects')
})
