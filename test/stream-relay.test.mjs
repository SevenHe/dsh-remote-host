import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPage } from './helpers/page.mjs'

const MUX = 'http://127.0.0.1:19100/api/remote.mux'

/**
 * Direction 1: the mux URL is only rewritten and handed to the shipped socket factory, so the
 * client owns the connection and its reconnects. Creating reconnect sockets ourselves is what
 * killed the renderer, so these tests pin the switch, its default, and the pipeline that carries
 * it into the page.
 */
test('streamRelay: the host always writes the switch into the shim settings', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('settings.streamRelay = streamRelay !== false'), 'the setting is written unconditionally')
  assert.ok(source.includes("config?.streamRelay !== false"), 'default on, explicit false is the escape hatch')
  assert.ok(readFileSync(new URL('../src/shim/00-config.js', import.meta.url), 'utf8').includes('config.streamRelay !== false'), 'the shim reads it as default on')
})

test('streamRelay on: the mux URL is rewritten to the mount and no router is built', async () => {
  const page = createPage({ config: { streamRelay: true } })
  await page.settle()
  const socket = page.built.createWebSocket(MUX)
  assert.ok(socket, 'a socket is returned')
  // calls.sockets records the leg kinds handed to the real socket factory: dialling one proves the
  // mounted stream went out through it, while the router path builds a FakeSocket and dials nothing.
  assert.ok(page.calls.sockets.includes('remote'), 'the mounted stream is dialled: ' + JSON.stringify(page.calls.sockets))
  assert.equal(typeof socket._close, 'undefined', 'the relay path does not build our mux router')
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
