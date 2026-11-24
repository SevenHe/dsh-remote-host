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
