/** The remote leg of a page that cannot open a WebSocket: forwarded HTTP pump. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const DESKTOP_LOCATION = { href: 'dsh-app://app/', origin: 'dsh-app://app', pathname: '/', protocol: 'dsh-app:' }

test('custom-scheme page: the remote leg is pumped over the mount, never dialled as a socket', async () => {
  const page = createPage({
    location: DESKTOP_LOCATION,
    config: { streamRelay: undefined },
    remoteItems: [{ sessionId: 'remote-1', running: true }],
  })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { sessionId: 'remote-1' } } }))
  await page.settle(10)
  assert.equal(page.calls.sockets.includes('remote'), false,
    'a custom-scheme page cannot open a remote socket: ' + JSON.stringify(page.calls.sockets))
  assert.ok(page.calls.mount.some((url) => String(url).includes('/__dsh_remote_host__/mux-poll')),
    'the pump is polled instead: ' + JSON.stringify(page.calls.mount))
})

test('browser page: the remote leg still uses its own socket', async () => {
  const page = createPage({
    config: { streamRelay: undefined },
    remoteItems: [{ sessionId: 'remote-1', running: true }],
  })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { sessionId: 'remote-1' } } }))
  await page.settle(10)
  assert.equal(page.calls.mount.some((url) => String(url).includes('mux-poll')), false,
    'a browser keeps its byte relay')
})
