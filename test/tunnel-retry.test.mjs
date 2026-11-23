import { test } from 'node:test'
import assert from 'node:assert/strict'
import { superviseSshTunnel } from '../lib/index.js'

/** Resolve after one macrotask turn, so a pending retry can be reached. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A tunnel supervisor that gives up after one failure would leave the app pointing at
 * an unreachable machine until it is restarted. These lock the retry contract: keep
 * trying, never throw, close what is live when disposed.
 */
test('tunnel: a dead ssh is retried on the ladder instead of giving up', async () => {
  const waits = []
  const reasons = []
  let attempts = 0
  const dispose = superviseSshTunnel({
    sshHost: 'host',
    remoteHost: '127.0.0.1',
    remotePort: 3080,
    ladder: [1, 2, 3],
    attempt: () => { attempts += 1; return Promise.resolve({ ok: false, reason: 'ssh exited before the forward was up' }) },
    onReady: () => { throw new Error('onReady must not run while every attempt fails') },
    onLost: () => { throw new Error('onLost must not run before a tunnel existed') },
  })
  // The supervisor reports the ladder it chose; capture it through note()'s side channel
  // by inspecting attempt counts over time instead of timers.
  for (let i = 0; i < 12; i += 1) { await tick(3); if (attempts >= 3) break }
  dispose()
  assert.ok(attempts >= 3, 'expected at least three attempts, saw ' + String(attempts))
  assert.deepEqual(waits, [])
  assert.deepEqual(reasons, [])
})

test('tunnel: an unreachable ssh never rejects out of the supervisor', async () => {
  let attempts = 0
  const dispose = superviseSshTunnel({
    sshHost: 'host',
    remoteHost: '127.0.0.1',
    remotePort: 3080,
    ladder: [1],
    // A thrown attempt is the worst case: it must be swallowed, not escape as an
    // unhandled rejection (that is what used to take the renderer down).
    attempt: () => { attempts += 1; throw new Error('spawn failed') },
    onReady: () => {},
    onLost: () => {},
  })
  for (let i = 0; i < 12; i += 1) { await tick(3); if (attempts >= 3) break }
  dispose()
  assert.ok(attempts >= 3, 'a throwing attempt must still be retried, saw ' + String(attempts))
})

test('tunnel: a live tunnel is published, then replaced after it dies', async () => {
  const ready = []
  const lost = []
  let closed = 0
  let attempt = 0
  let killFirst
  const firstExit = new Promise((resolve) => { killFirst = resolve })
  const dispose = superviseSshTunnel({
    sshHost: 'host',
    remoteHost: '127.0.0.1',
    remotePort: 3080,
    ladder: [1],
    attempt: () => {
      attempt += 1
      if (attempt === 1) {
        const child = { once: (event, handler) => { if (event === 'exit') void firstExit.then(handler) } }
        return Promise.resolve({ ok: true, base: 'http://127.0.0.1:41000', child, close: () => { closed += 1 } })
      }
      return Promise.resolve({ ok: false, reason: 'still down' })
    },
    onReady: (base) => { ready.push(base) },
    onLost: () => { lost.push(true) },
  })
  await tick(5)
  assert.deepEqual(ready, ['http://127.0.0.1:41000'])
  assert.equal(lost.length, 0)
  killFirst()
  await tick(10)
  dispose()
  assert.equal(lost.length, 1, 'a dying tunnel must be reported once')
  assert.ok(closed >= 1, 'the dead child must be closed')
  assert.ok(attempt >= 2, 'the supervisor must try again after the tunnel died')
})

test('tunnel: dispose stops the ladder and closes the live child', async () => {
  let attempts = 0
  let closed = 0
  const dispose = superviseSshTunnel({
    sshHost: 'host',
    remoteHost: '127.0.0.1',
    remotePort: 3080,
    ladder: [5],
    attempt: () => {
      attempts += 1
      return Promise.resolve({ ok: true, base: 'http://127.0.0.1:41001', child: { once: () => {} }, close: () => { closed += 1 } })
    },
    onReady: () => {},
    onLost: () => {},
  })
  await tick(3)
  const seen = attempts
  dispose()
  await tick(20)
  assert.equal(attempts, seen, 'no attempt may start after dispose')
  assert.equal(closed, 1, 'the live child must be closed exactly once')
})
