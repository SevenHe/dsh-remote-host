import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPage } from './helpers/page.mjs'

const MUX = 'http://127.0.0.1:19100/api/remote.mux'

/**
 * Attached windows use the shipped carrier against the remote. Mixed windows must
 * keep a local leg and let the Host reconnect the independent remote leg.
 */
test('streamRelay: the host always writes the switch into the shim settings', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('settings.streamRelay = streamRelay !== false'), 'the setting is written unconditionally')
  assert.ok(source.includes("config?.streamRelay !== false"), 'default on, explicit false is the escape hatch')
  assert.ok(readFileSync(new URL('../src/shim/00-config.js', import.meta.url), 'utf8').includes('config.streamRelay !== false'), 'the shim reads it as default on')
})

test('attached window: the mux URL is rewritten to the mount and no router is built', async () => {
  const page = createPage({ config: { streamRelay: true, attach: 'remote' } })
  await page.settle()
  const socket = page.built.createWebSocket(MUX)
  assert.ok(socket, 'a socket is returned')
  // calls.sockets records the leg kinds handed to the real socket factory: dialling one proves the
  // mounted stream went out through it, while the router path builds a FakeSocket and dials nothing.
  assert.ok(page.calls.sockets.includes('remote'), 'the mounted stream is dialled: ' + JSON.stringify(page.calls.sockets))
  assert.equal(typeof socket._close, 'undefined', 'the relay path does not build our mux router')
})

test('mixed default routes local history locally and never redials the remote peer in the renderer', async () => {
  const page = createPage({
    config: { streamRelay: undefined },
    remoteItems: [{ sessionId: 'remote-1', running: true }],
  })
  await page.settle()
  const client = page.openMux()
  function follow(streamId, sessionId) {
    client.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { sessionId } } }))
  }
  follow('local', 'local-1')
  assert.equal(page.sent('local').length, 1)
  assert.equal(page.sockets.has('remote'), false)
  follow('remote', 'remote-1')
  const remote = page.sockets.get('remote')
  assert.equal(new URL(remote.url, MUX).pathname, '/devbox/__dsh_remote_host__/mux')
  assert.equal(page.sent('remote').length, 1)

  remote.frame({ type: 'drh/relay-status', state: 'error' })
  const local = page.sockets.get('local')
  local.frame({ type: 'item', streamId: page.sent('local')[0].streamId, value: 'local history' })
  assert.equal(page.frames().at(-1).value, 'local history')

  remote.close()
  remote.emit('close', { code: 1006 })
  page.fireTimers()
  follow('next-remote', 'remote-1')
  assert.deepEqual(page.calls.sockets, ['local', 'remote'])
  assert.equal(client.readyState, 1)
  assert.equal(page.frames().at(-1).error.code, 'gateway/remote-unavailable')
  client.close()
  page.dispose()
})

test('streamRelay false: the mux router is still used (escape hatch)', async () => {
  const page = createPage({ config: { streamRelay: false } })
  await page.settle()
  const socket = page.built.createWebSocket(MUX)
  assert.ok(socket, 'a socket is returned')
  // Both paths dial a leg socket, so the difference is what the factory returns: our mux router
  // hands back a FakeSocket that carries _close, the relay hands back the shipped socket.
  assert.equal(typeof socket._close, 'function', 'the router path still builds our mux client')
})
