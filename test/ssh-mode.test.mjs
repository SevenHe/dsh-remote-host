import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { killTunnel, proxyRequest, superviseSshTunnel } from '../lib/index.js'

/** Resolve after one macrotask turn, so a pending retry or health tick can be reached. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** A response stand-in that records what the proxy wrote. */
function fakeResponse() {
  const written = { status: undefined, headers: undefined, body: '' }
  return {
    written,
    writeHead(status, headers) { written.status = status; written.headers = headers; return this },
    end(body) { written.body = String(body ?? '') },
  }
}

/**
 * Configured for ssh means "only through the tunnel". Handing the dial back to the
 * configured upstream while the forward is down would put the traffic on the very path the
 * tunnel exists to avoid, and the request would then pay the full upstream timeout.
 */
test('ssh mode: a blocked dial answers 503 at once instead of dialling the direct route', async () => {
  const res = fakeResponse()
  const dial = { hostname: '127.0.0.1', port: 1, secure: false, blocked: true }
  const started = Date.now()
  // A request object that would explode if the proxy tried to pipe it anywhere.
  proxyRequest({ url: '/api/session/list', method: 'POST', headers: {}, on() { throw new Error('the proxy must not touch the request') } }, res, dial, 'devbox:3082', '/nonexistent/cookie')
  const elapsed = Date.now() - started
  assert.equal(res.written.status, 503, 'a blocked dial must answer 503')
  assert.ok(elapsed < 500, 'the answer must be immediate, took ' + String(elapsed) + 'ms')
  assert.match(res.written.body, /ssh tunnel is not up/)
})

/**
 * A rebuild must come back on the SAME local port: a new port breaks every connection,
 * including the event stream, so the renderer would reconnect on every blip.
 */
test('ssh mode: rebuilding keeps the local forward port', async () => {
  const ports = []
  let attempt = 0
  const exits = []
  const dispose = superviseSshTunnel({
    sshHost: 'devbox',
    remoteHost: '127.0.0.1',
    remotePort: 3082,
    ladder: [1],
    healthIntervalMs: 100000,
    attempt: (host, remoteHost, remotePort, pinnedPort) => {
      ports.push(pinnedPort)
      attempt += 1
      if (attempt % 2 === 1) {
        const child = { once: (event, handler) => { if (event === 'exit') exits.push(handler) } }
        return Promise.resolve({ ok: true, base: 'http://127.0.0.1:41234', child, port: 41234, close: () => {} })
      }
      return Promise.resolve({ ok: false, reason: 'still down' })
    },
    onReady: () => {},
    onLost: () => {},
  })
  // Three rebuilds: each death hands the supervisor back to attempt with a pinned port.
  for (let round = 0; round < 3; round += 1) {
    await tick(4)
    const handler = exits.pop()
    if (handler !== undefined) handler()
    await tick(6)
  }
  dispose()
  const pinned = ports.filter((port) => port !== undefined)
  assert.ok(pinned.length >= 2, 'the supervisor must pin the port for rebuilds, saw ' + JSON.stringify(ports))
  assert.deepEqual([...new Set(pinned)], [41234], 'every rebuild must reuse the first port, saw ' + JSON.stringify(ports))
})

/**
 * A wedged tunnel (ssh alive, nothing crossing the hop) never fires exit, so only a round
 * trip through the forward can see it. It must be noticed well inside five seconds.
 */
test('ssh mode: a wedged tunnel is rebuilt within five seconds', async () => {
  const lost = []
  const dispose = superviseSshTunnel({
    sshHost: 'devbox',
    remoteHost: '127.0.0.1',
    remotePort: 3082,
    ladder: [1],
    probe: () => Promise.resolve(false),
    attempt: () => Promise.resolve({
      ok: true,
      base: 'http://127.0.0.1:41235',
      child: { once: () => {} },
      port: 41235,
      close: () => {},
    }),
    onReady: () => {},
    onLost: () => { lost.push(Date.now()) },
  })
  const started = Date.now()
  while (lost.length === 0 && Date.now() - started < 8000) await tick(50)
  dispose()
  assert.equal(lost.length, 1, 'a wedged tunnel must be reported once')
  const elapsed = lost[0] - started
  assert.ok(elapsed <= 5000, 'the rebuild must start within 5s, took ' + String(elapsed) + 'ms')
})

/**
 * Killing only the ssh leader can leave the forward-serving side alive as an orphan with
 * parent pid 1, which the lab saw. The whole process group must go.
 */
test('ssh mode: killing a tunnel leaves no child behind', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
  const alive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  await tick(50)
  assert.ok(alive(), 'the stand-in child must be running')
  killTunnel(child)
  let gone = false
  for (let i = 0; i < 40; i += 1) { await tick(25); if (!alive()) { gone = true; break } }
  assert.ok(gone, 'killing the tunnel must reap the whole process group')
})
/**
 * A stopped ssh ignores SIGTERM, and while it lives it keeps the forwarded port: a rebuild
 * would then bind a port owned by a corpse and the readiness probe would be answered by the
 * stale listener. The kill must escalate.
 */
test('ssh mode: killing a stopped tunnel still releases it', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
  const alive = () => { try { process.kill(child.pid, 0); return true } catch { return false } }
  await tick(50)
  process.kill(child.pid, 'SIGSTOP')
  await tick(50)
  assert.ok(alive(), 'the stand-in child must be stopped, not gone')
  killTunnel(child)
  let gone = false
  for (let i = 0; i < 60; i += 1) { await tick(50); if (!alive()) { gone = true; break } }
  assert.ok(gone, 'a stopped tunnel must be killed, not left holding the port')
})
