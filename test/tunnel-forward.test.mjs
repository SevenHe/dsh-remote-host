/**
 * One long-lived SSH forward, and the policy that decides when it may be rebuilt.
 *
 * The mount is re-applied whenever its entry restarts (config reload, HMR pass, profile
 * reconcile). A supervisor per activation used to allocate a fresh local port and dial a fresh
 * ssh every time, so a re-apply broke every socket already pointed at the previous port and a
 * burst of activations produced competing tunnels. These cases pin the lifecycle: one forward
 * per host, re-attached by the next activation, stopped only after it is genuinely idle.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attemptSshTunnel, sharedSshForward, superviseSshTunnel } from '../lib/index.js'

/** Resolve after one macrotask turn, so a pending attempt or retry can be reached. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** The ssh child a stand-in attempt hands back; records whether it was reaped. */
function childStub(record = { killed: 0 }) {
  return {
    exitCode: null,
    stderr: { on() {} },
    once() {},
    on() {},
    kill() { record.killed += 1 },
  }
}

/** A forward that answers on the first round trip, counting what the supervisor asked for. */
function alwaysUp(record) {
  return () => {
    record.attempts += 1
    return Promise.resolve({
      ok: true,
      base: 'http://127.0.0.1:' + String(record.port),
      port: record.port,
      child: childStub(record),
      close: () => { record.closed += 1 },
    })
  }
}

test('forward: a re-apply re-attaches to the live forward and its port', async () => {
  const record = { attempts: 0, closed: 0, killed: 0, port: 41300 }
  const seen = []
  const first = sharedSshForward({
    sshHost: 'host', remoteHost: '127.0.0.1', remotePort: 3080,
    idleStopMs: 5000,
    ladder: [1],
    healthIntervalMs: 100000,
    attempt: alwaysUp(record),
    probe: () => Promise.resolve(true),
    onReady: (base) => { seen.push(['first', base]) },
    onLost: () => {},
  })
  await tick(5)
  assert.deepEqual(seen, [['first', 'http://127.0.0.1:41300']], 'the first mount is told the base')

  // The next activation of the mount: same host, same remote address.
  const second = sharedSshForward({
    sshHost: 'host', remoteHost: '127.0.0.1', remotePort: 3080,
    idleStopMs: 5000,
    ladder: [1],
    healthIntervalMs: 100000,
    attempt: alwaysUp(record),
    probe: () => Promise.resolve(true),
    onReady: (base) => { seen.push(['second', base]) },
    onLost: () => {},
  })
  assert.deepEqual(seen[1], ['second', 'http://127.0.0.1:41300'], 'a re-apply re-attaches to the SAME base')
  assert.equal(record.attempts, 1, 're-attaching must not dial a second tunnel')

  first.detach()
  second.detach()
})

test('forward: the forward is stopped only after the last mount stays away', async () => {
  const record = { attempts: 0, closed: 0, killed: 0, port: 41301 }
  const options = {
    sshHost: 'idle', remoteHost: '127.0.0.1', remotePort: 3080,
    idleStopMs: 30,
    ladder: [1],
    healthIntervalMs: 100000,
    attempt: alwaysUp(record),
    probe: () => Promise.resolve(true),
    onReady: () => {},
    onLost: () => {},
  }
  const first = sharedSshForward(options)
  await tick(5)
  assert.equal(record.closed, 0)
  // A reload detaches, then re-attaches a moment later: the forward must survive that gap.
  first.detach()
  await tick(10)
  const second = sharedSshForward(options)
  await tick(40)
  assert.equal(record.closed, 0, 'a forward re-attached inside the idle window keeps running')
  assert.equal(record.attempts, 1, 'and it is still the same tunnel')
  // Nothing mounts it any more: now it may stop.
  second.detach()
  for (let i = 0; i < 40 && record.closed === 0; i += 1) await tick(5)
  assert.equal(record.closed, 1, 'the idle forward is stopped once, and only when it is idle')
})

test('ssh attempt: readiness needs a round trip, not just a bound port', async () => {
  let roundTrips = 0
  const result = await attemptSshTunnel('host', '127.0.0.1', 3080, 41400, undefined, {
    spawn: () => childStub(),
    // The port is bound from the first poll, but nothing crosses the hop yet.
    probeLoopback: () => Promise.resolve(true),
    probeTunnel: () => { roundTrips += 1; return Promise.resolve(roundTrips > 2) },
  })
  assert.equal(result.ok, true, 'the attempt eventually succeeds')
  assert.ok(roundTrips >= 3, 'a bound port alone must never count as ready, saw ' + String(roundTrips))
  result.close()
})

test('ssh attempt: a hop that never answers is not reported as up', async () => {
  const record = { killed: 0 }
  const started = Date.now()
  const controller = new AbortController()
  const pending = attemptSshTunnel('host', '127.0.0.1', 3080, 41401, controller.signal, {
    spawn: () => childStub(record),
    probeLoopback: () => Promise.resolve(true),
    probeTunnel: () => Promise.resolve(false),
  })
  await tick(30)
  controller.abort()
  const result = await pending
  assert.equal(result.ok, false, 'a forward that carries nothing is not up')
  assert.equal(result.cancelled, true)
  assert.ok(Date.now() - started < 5000, 'cancelling must not wait out the readiness budget')
  assert.equal(record.killed, 1, 'the cancelled attempt reaps its ssh child instead of holding the port')
})

test('tunnel: a flap keeps climbing the ladder instead of resetting it', async () => {
  const waits = []
  const record = { attempts: 0, closed: 0, killed: 0, port: 41500 }
  const dispose = superviseSshTunnel({
    sshHost: 'flap', remoteHost: '127.0.0.1', remotePort: 3080,
    ladder: [10, 20, 40, 80],
    healthIntervalMs: 5,
    healthFailures: 1,
    graceMs: 0,
    // The forward comes up and then never answers again: the wedge this policy exists for.
    probe: () => Promise.resolve(false),
    attempt: alwaysUp(record),
    onRetry: (wait) => { waits.push(wait) },
    onReady: () => {},
    onLost: () => {},
  })
  for (let i = 0; i < 200 && waits.length < 4; i += 1) await tick(5)
  dispose()
  assert.deepEqual(waits.slice(0, 4), [10, 20, 40, 80], 'each rebuild must wait longer than the last, saw ' + JSON.stringify(waits))
})

test('tunnel: a forward that stayed up long enough starts a fresh ladder', async () => {
  const waits = []
  const record = { attempts: 0, closed: 0, killed: 0, port: 41501 }
  const dispose = superviseSshTunnel({
    sshHost: 'recovered', remoteHost: '127.0.0.1', remotePort: 3080,
    ladder: [10, 20, 40],
    healthIntervalMs: 5,
    healthFailures: 1,
    graceMs: 0,
    // stableMs 0: every loss counts as a real recovery, so the ladder restarts each time.
    stableMs: 0,
    probe: () => Promise.resolve(false),
    attempt: alwaysUp(record),
    onRetry: (wait) => { waits.push(wait) },
    onReady: () => {},
    onLost: () => {},
  })
  for (let i = 0; i < 200 && waits.length < 3; i += 1) await tick(5)
  dispose()
  assert.deepEqual(waits.slice(0, 3), [10, 10, 10], 'a stable forward resets the ladder, saw ' + JSON.stringify(waits))
})
