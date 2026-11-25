/** The page path a desktop shell needs: remote stream over the forwarded mux pump. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SHIM = new URL('../lib/shim.js', import.meta.url)

/**
 * Stand in for the desktop Host: it answers the pump with one `item` frame for the open
 * stream, which is exactly what the real Host forwards from the remote mux.
 */
function pumpHost() {
  const calls = []
  let upstreamId
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      calls.push(body)
      if (String(req.url).includes('/api/session/list')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { items: [{ sessionId: 'remote-1', running: true }] } } }))
        return
      }
      const request = JSON.parse(body)
      // The client's uplink frames carry the stream id the relay assigned; the remote answers
      // on that same id, which is how the relay maps a frame back to the client's stream.
      for (const frame of Array.isArray(request.uplink) ? request.uplink : []) {
        try {
          const parsed = JSON.parse(frame)
          if (parsed.type === 'open' && parsed.streamId !== undefined) upstreamId = String(parsed.streamId)
        } catch { /* not a frame we care about */ }
      }
      const deliver = request.cursor !== 0 && upstreamId !== undefined
      const frames = deliver ? [JSON.stringify({ type: 'item', streamId: upstreamId, value: 1 })] : []
      const answer = { state: 'open', cursor: Math.max(1, request.cursor), frames }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  return { server, calls }
}

test('desktop page: a remote stream rides the pump and its frames reach the client', async (t) => {
  const { server, calls } = pumpHost()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + String(server.address().port)
  t.after(() => server.close())

  const dials = []
  const sandbox = {
    console,
    location: { protocol: 'dsh-app:', href: 'dsh-app://app/', origin: 'dsh-app://app', pathname: '/' },
    document: {
      visibilityState: 'visible',
      addEventListener() {}, removeEventListener() {},
      querySelectorAll: () => [], getElementById: () => null, getElementsByTagName: () => ({ length: 0 }),
    },
    performance: { memory: undefined },
    setTimeout, clearTimeout, queueMicrotask, AbortController,
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); return timer },
    clearInterval,
    fetch: (input, init) => fetch(new URL(String(input?.url ?? input), base), init),
    WebSocket: class NativeSocket {
      constructor(url) { this.url = String(url); this.readyState = 0; dials.push(this.url) }
      send() {} close() {} addEventListener() {} removeEventListener() {}
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  sandbox.__DSH_TRANSPORT__ = {
    fetch: (input, init) => fetch(new URL(String(input?.url ?? input), base), init),
    createWebSocket: (url) => { dials.push(String(url)); return new sandbox.WebSocket(url) },
  }
  sandbox.__DSH_REMOTE_HOST__ = { mount: '/devbox', label: 'devbox', streams: true, trace: false, group: 'workspace', remoteBlock: true }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SHIM, 'utf8'), sandbox, { filename: 'lib/shim.js' })

  // The app's own mux client, obtained exactly like the shipped client does.
  const built = sandbox.__DSH_TRANSPORT__
  const client = built.createWebSocket('/api/remote.mux')
  const messages = []
  if (typeof client.addEventListener === 'function') {
    client.addEventListener('message', (event) => messages.push(String(event.data)))
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  client.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { sessionId: 'remote-1' } } }))

  // Give the pump a few round trips to deliver the frame.
  for (let index = 0; index < 40 && messages.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(calls.length > 0, 'the page polled the pump: ' + JSON.stringify(calls.length))
  assert.ok(messages.length > 0, 'the remote frame reached the client; dials=' + JSON.stringify(dials))
})