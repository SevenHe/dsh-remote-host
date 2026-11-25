import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { createRemoteMuxRelay } from '../lib/remote-mux.js'

test('transport loss keeps the renderer socket open and recovers each read stream on its own baseline', { timeout: 7000 }, async (t) => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstream, 'listening')
  let dialAvailable = true
  const addresses = []
  upstream.on('connection', (socket) => {
    const messages = []
    addresses.push({ socket, messages })
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      messages.push(frame)
      if (frame.type === 'open') {
        socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: addresses.length }))
      }
    })
  })
  const relay = createRemoteMuxRelay(() => dialAvailable
    ? new WebSocket('ws://127.0.0.1:' + upstream.address().port + '/api/remote.mux')
    : undefined)
  const front = createServer()
  front.on('upgrade', (req, socket, head) => relay.upgrade(req, socket, head))
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')
  const browser = new WebSocket('ws://127.0.0.1:' + front.address().port)
  t.after(() => {
    browser.terminate()
    relay.dispose()
    for (const socket of upstream.clients) socket.terminate()
    upstream.close()
    front.close()
  })
  const events = []
  browser.on('message', (data) => events.push(JSON.parse(data.toString())))
  await once(browser, 'open')
  const send = (frame) => browser.send(JSON.stringify(frame))
  async function waitFor(predicate) {
    const stop = AbortSignal.timeout(5000)
    while (!events.some(predicate)) await once(browser, 'message', { signal: stop })
  }

  for (const [id, endpoint] of [['workspace', 'workspace/follow'], ['history', 'session/follow'], ['cancelled', 'workspace/follow'], ['interactive', 'terminal/attach']]) {
    send({ type: 'open', streamId: id, endpoint, payload: { args: {} } })
    await waitFor((frame) => frame.streamId === id && frame.type === 'item')
  }
  send({ type: 'item', streamId: 'interactive', value: 'one input' })
  send({ type: 'end', streamId: 'workspace' })
  dialAvailable = false
  addresses[0].socket.terminate()
  await waitFor((frame) => frame.type === 'drh/relay-status' && frame.state === 'error')
  await waitFor((frame) => frame.streamId === 'interactive' && frame.type === 'error')
  await waitFor((frame) => frame.streamId === 'history' && frame.type === 'end')
  assert.equal(browser.readyState, WebSocket.OPEN)
  send({ type: 'cancel', streamId: 'cancelled' })
  send({ type: 'open', streamId: 'new-history', endpoint: 'session/follow', payload: { args: {} } })

  dialAvailable = true
  await waitFor((frame) => frame.streamId === 'workspace' && frame.value === 2)
  await waitFor((frame) => frame.streamId === 'new-history' && frame.value === 2)
  assert.deepEqual(addresses[1].messages.map(({ type, streamId }) => [type, streamId]), [
    ['open', 'workspace'],
    ['end', 'workspace'],
    ['open', 'new-history'],
  ])
  assert.equal(browser.readyState, WebSocket.OPEN)
})
test('a refused handshake exchanges one credential and redials instead of going dark', { timeout: 7000 }, async (t) => {
  // The remote admits one socket per credential, so a spent value answers 401. The relay must
  // exchange before the retry; retrying the same value leaves the page dark until a reload.
  const front = createServer()
  front.__sockets = new Set()
  front.on('connection', (socket) => {
    front.__sockets.add(socket)
    socket.on('close', () => front.__sockets.delete(socket))
  })
  const upstream = new WebSocketServer({ noServer: true })
  const accepted = new Set()
  let refusals = 0
  front.on('upgrade', (req, socket, head) => {
    if (refusals === 0) {
      refusals += 1
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    upstream.handleUpgrade(req, socket, head, (client) => {
      // A manually emitted connection is not tracked by the server, so the test keeps its own set.
      accepted.add(client)
      upstream.emit('connection', client, req)
    })
  })
  upstream.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'open') socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: 'after-refresh' }))
    })
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')

  let refreshes = 0
  // The relay keeps its own upstream socket, which its dispose does not own: track every dial the
  // test causes so the cleanup can end them and the file can exit.
  const dialed = new Set()
  let dialOpen = true
  const relay = createRemoteMuxRelay(
    () => {
      if (dialOpen !== true) return undefined
      const socket = new WebSocket('ws://127.0.0.1:' + String(front.address().port) + '/api/remote.mux')
      dialed.add(socket)
      socket.on('close', () => dialed.delete(socket))
      return socket
    },
    { refresh: async () => { refreshes += 1 } },
  )
  t.after(() => {
    dialOpen = false
    for (const socket of dialed) socket.terminate()
    relay.dispose()
    for (const socket of accepted) socket.terminate()
    for (const socket of front.__sockets ?? []) socket.destroy()
    upstream.close()
    front.closeAllConnections?.()
    front.close()
  })

  const page = createServer()
  page.on('upgrade', (req, socket, head) => relay.upgrade(req, socket, head))
  page.listen(0, '127.0.0.1')
  await once(page, 'listening')
  const browser = new WebSocket('ws://127.0.0.1:' + String(page.address().port))
  t.after(() => {
    browser.terminate()
    page.closeAllConnections?.()
    page.close()
  })
  const events = []
  browser.on('message', (data) => events.push(JSON.parse(data.toString())))
  await once(browser, 'open')

  browser.send(JSON.stringify({ type: 'open', streamId: 'history', endpoint: 'session/follow', payload: { args: {} } }))
  const stop = AbortSignal.timeout(6000)
  while (!events.some((frame) => frame.streamId === 'history' && frame.type === 'item')) {
    await once(browser, 'message', { signal: stop })
  }
  assert.equal(refreshes, 1, 'one refusal exchanges exactly one credential')
  assert.equal(events.find((frame) => frame.streamId === 'history' && frame.type === 'item').value, 'after-refresh')
  assert.equal(browser.readyState, WebSocket.OPEN, 'the page socket survives the refusal')
})
