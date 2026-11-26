/**
 * Which mounted route enforces the host connection policy, and which is deliberately exempt.
 *
 * The mount serves five routes and only some of them can ask the host's own admission question.
 * These lock the split: a request the policy refuses must be refused on the checked routes and
 * must still reach the remote from the two page-origin upgrade legs, where there is no Peer.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { ADMISSION } from '../lib/routes.js'

/** A host whose connection policy refuses any request carrying `x-deny: 1`. */
function fakeHost() {
  const routes = new Map()
  const upgrades = new Map()
  const webServer = {
    register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } },
    registerUpgrade(route) { upgrades.set(route.path, route); return () => { upgrades.delete(route.path) } },
  }
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return { admitConnection: (req) => (req.headers['x-deny'] === '1' ? { rejection: 'denied' } : undefined) }
      return undefined
    },
    on: () => () => {},
  }
  return { ctx, routes, upgrades }
}

/** A remote Host stand-in: it records what reached it, over HTTP and over upgrade. */
async function remoteHost() {
  const calls = []
  const live = new Set()
  const server = createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream')
  })
  server.on('upgrade', (req, socket) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers, upgraded: true })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    calls,
    port: server.address().port,
    stop() {
      for (const socket of live) socket.destroy()
      server.closeAllConnections()
      server.close()
    },
  }
}

/** The mount's own origin: every request goes into the handler apply() registered. */
async function mountOrigin(routes, upgrades) {
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    for (const route of routes.values()) {
      if (route.kind !== 'prefix') continue
      if (path !== route.path && path.startsWith(route.path + '/') !== true) continue
      route.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('no route')
  })
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(req.url ?? '')
    if (route === undefined) { socket.destroy(); return }
    route.handler(req, socket, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    stop() { server.closeAllConnections(); server.close() },
  }
}

/** Mount the remote against a fake host and a real upstream, returning every handle. */
async function mount(config = {}) {
  const remote = await remoteHost()
  const cookieFile = join(mkdtempSync(join(tmpdir(), 'drh-admission-')), 'cookie.txt')
  writeFileSync(cookieFile, 'dsh-auth=local-credential\n', { mode: 0o600 })
  const host = fakeHost()
  const mounted = apply(host.ctx, {
    mount: '/devbox',
    superagent: 'remote',
    streams: true,
    attach: 'merge',
    upstream: 'http://127.0.0.1:' + String(remote.port),
    cookieFile,
    ...config,
  })
  const front = await mountOrigin(host.routes, host.upgrades)
  return {
    remote,
    front,
    host,
    stop() {
      try { if (typeof mounted === 'function') mounted() } catch { /* already disposed */ }
      front.stop()
      remote.stop()
    },
  }
}

/** Send one HTTP request to the mount origin. */
function call(port, path, method, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body)
    const all = payload === undefined ? headers : { ...headers, 'content-length': String(payload.length) }
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, headers: all }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

/** Send one WebSocket upgrade and collect whatever the mount answers before it closes. */
function upgrade(port, path, headers = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let text = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(text)
    }
    const extra = Object.entries(headers).map(([key, value]) => key + ': ' + value + '\r\n').join('')
    socket.on('connect', () => {
      socket.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:' + String(port) + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' + extra + '\r\n')
    })
    socket.on('data', (chunk) => { text += String(chunk) })
    socket.on('error', finish)
    socket.on('close', finish)
    const timer = setTimeout(finish, 400)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

test('admission: the HTTP mount refuses a rejected request before it reaches the remote', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  const answer = await call(world.front.port, '/devbox/api/session/list', 'POST', { 'x-deny': '1' })
  assert.equal(answer.status, 401, 'a rejected request is answered by the mount itself')
  assert.match(answer.body, /not admitted by the host connection policy/)
  assert.equal(world.remote.calls.length, 0, 'nothing is dialled for a rejected request')
})

test('admission: an admitted request is proxied with the minted credential', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  const answer = await call(world.front.port, '/devbox/api/session/list', 'GET', { 'x-probe': 'admitted' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body, 'upstream')
  assert.equal(world.remote.calls.length, 1)
  assert.equal(world.remote.calls[0].url, '/api/session/list', 'the mount prefix is stripped before the dial')
  assert.equal(world.remote.calls[0].headers.cookie, 'dsh-auth=local-credential', 'the minted credential is forwarded')
})

test('admission: the orchestrator api route refuses a rejected request', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  const answer = await call(world.front.port, '/orchestrator/api/status', 'GET', { 'x-deny': '1' })
  assert.equal(answer.status, 401)
  assert.equal(world.remote.calls.length, 0, 'the panel request never reaches the remote')
})

test('admission: the mux relay upgrade refuses a rejected socket with 403', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  const answer = await upgrade(world.front.port, '/devbox/__dsh_remote_host__/mux', { 'x-deny': '1' })
  assert.match(answer, /403 Forbidden/, 'the relay closes the upgrade instead of relaying it')
  assert.equal(world.remote.calls.length, 0, 'a rejected mux upgrade dials nothing')
})

test('admission: the two page-origin upgrade legs are exempt and still reach the remote', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  // The page origin is dsh-app://app, which can never equal this Host's authority, and the route
  // is anonymous, so there is no Peer for the connection policy to judge: the leg must relay.
  const orchestrator = await upgrade(world.front.port, '/orchestrator', { 'x-deny': '1' })
  assert.match(orchestrator, /101 Switching Protocols/, 'the superagent stream is relayed, not refused')
  const stream = await upgrade(world.front.port, '/devbox/api/remote.mux', { 'x-deny': '1' })
  assert.match(stream, /101 Switching Protocols/, 'the direct remote mux leg is relayed, not refused')
  const urls = world.remote.calls.map((entry) => entry.url)
  assert.deepEqual(urls, ['/orchestrator', '/api/remote.mux'], 'both legs arrive at the remote path they serve')
})

test('admission: the mount still serves its own page endpoints', async (t) => {
  const world = await mount()
  t.after(() => world.stop())
  const css = await call(world.front.port, '/devbox/__dsh_remote_host__/asset/block.css', 'GET')
  assert.equal(css.status, 200, 'the block stylesheet is served from the repository, not the remote')
  assert.match(String(css.headers['content-type']), /text\/css/)
  assert.ok(css.body.length > 0, 'the stylesheet has content: ' + String(css.body.length))
  const posted = await call(world.front.port, '/devbox/__dsh_remote_host__/report', 'POST', { 'content-type': 'application/json' }, '{"crash":"none"}')
  assert.equal(posted.status, 204, 'a renderer report is accepted without a body')
  const reported = JSON.parse((await call(world.front.port, '/devbox/__dsh_remote_host__/report', 'GET')).body)
  assert.equal(reported.crash, 'none', 'the report is kept on this host')
  assert.equal(typeof reported.rev, 'string', 'the shim revision is published with it')
  const trace = await call(world.front.port, '/devbox/__dsh_remote_host__/trace', 'GET')
  assert.deepEqual(JSON.parse(trace.body), { ok: true }, 'tracing is off, so nothing is written')
  assert.equal(world.remote.calls.length, 0, 'page endpoints are never proxied to the remote')
})

test('admission: exactly the two page-origin upgrade legs are declared exempt', () => {
  const exempt = Object.entries(ADMISSION).filter(([, stance]) => stance === 'exempt').map(([route]) => route)
  assert.deepEqual(exempt, ['orchestratorUpgrade', 'streamMountUpgrade'], 'a third exemption must be a deliberate edit of ADMISSION')
  const checked = Object.entries(ADMISSION).filter(([, stance]) => stance === 'checked').map(([route]) => route)
  assert.deepEqual(checked, ['mount', 'orchestratorApi', 'muxUpgrade'], 'the routes that can ask the policy keep asking it')
})
