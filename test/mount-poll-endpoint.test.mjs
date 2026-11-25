/** The mount endpoint the desktop page polls: wiring, dial and frame delivery. */
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'

/** A minimal Host context: the mount only reads webServer and the page hooks. */
function fakeContext(routes) {
  const webServer = {
    register(route) { routes.push(route); return () => {} },
    registerUpgrade(route) { routes.push(route); return () => {} },
  }
  return {
    get(name) { return name === 'webServer' ? webServer : undefined },
    on() { return () => {} },
  }
}

/** Drive one mount request and resolve with its captured response. */
function callRoute(route, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    const chunks = []
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      status: 0,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
      end(payload) {
        this.writableEnded = true
        if (payload !== undefined) chunks.push(String(payload))
        resolve({ status: this.status, headers: this.headers, body: chunks.join('') })
      },
    }
    try { route.handler(req, res) } catch (error) { reject(error); return }
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', body)
      req.emit('end')
    })
  })
}

test('mount endpoint: a poll is answered from the remote mux frames', async (t) => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstream, 'listening')
  const port = upstream.address().port
  upstream.on('connection', (socket) => { socket.send('{"type":"ready"}') })
  t.after(() => {
    for (const socket of upstream.clients) socket.terminate()
    upstream.close()
  })

  const routes = []
  const dir = mkdtempSync(join(tmpdir(), 'drh-endpoint-'))
  const cookieFile = join(dir, 'cookie.txt')
  writeFileSync(cookieFile, 'dsh-auth-test=value' + String.fromCharCode(10))
  apply(fakeContext(routes), {
    upstream: 'http://127.0.0.1:' + String(port),
    authority: '127.0.0.1:' + String(port),
    mount: '/devbox',
    label: 'test',
    streams: true,
    streamRelay: false,
    cookieFile,
    trace: false,
  })

  const mountRoute = routes.find((route) => route.kind === 'prefix' && route.path === '/devbox')
  assert.ok(mountRoute, 'the mount registers its prefix route: ' + JSON.stringify(routes.map((route) => route.path)))

  const frames = []
  let cursor = 0
  // The remote's first frame may arrive before or after the open edge is announced, so the
  // page reads frames across round trips instead of expecting them in one specific answer.
  for (let round = 0; round < 2; round += 1) {
    const answer = await callRoute(mountRoute, 'POST', '/devbox/__dsh_remote_host__/mux-poll',
      JSON.stringify({ cursor, uplink: [], waitMs: 4000 }))
    assert.equal(answer.status, 200)
    const parsed = JSON.parse(answer.body)
    assert.ok(parsed.state === 'open' || parsed.state === 'connecting', 'pump state: ' + String(parsed.state))
    cursor = parsed.cursor
    frames.push(...parsed.frames)
  }
  const kinds = frames.map((frame) => JSON.parse(frame).type)
  assert.deepEqual(kinds, ['drh/relay-status', 'ready'], 'pump frames: ' + JSON.stringify(frames))
})
