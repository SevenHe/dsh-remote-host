/** The relay leg owns its credential, so a spent socket never takes HTTP access with it. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { proxyUpgrade } from '../lib/index.js'

/** An upstream that completes an upgrade and records the credential it was sent. */
function upstream(behaviour) {
  const seen = []
  // Relayed sockets stay open by design; the test closes them so the runner can exit.
  const live = new Set()
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    seen.push(req.headers.cookie)
    const answer = behaviour(seen.length, req.headers.cookie)
    if (answer !== 'accept') {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    live.add(socket)
    socket.on('close', () => live.delete(socket))
  })
  const stop = () => {
    for (const socket of live) socket.destroy()
    server.close()
  }
  return { server, seen, stop }
}

/** A browser-side socket: a real duplex, because the relay pipes the upstream into it. */
function fakeSocket() {
  const socket = new PassThrough()
  const written = []
  socket.on('data', (chunk) => written.push(String(chunk)))
  socket.written = written
  return socket
}

const upgradeRequest = (path) => ({ url: path, method: 'GET', headers: { upgrade: 'websocket', connection: 'Upgrade' } })

test('relay upgrade dials with its own credential, not the proxies one', async (t) => {
  const { server, seen, stop } = upstream(() => 'accept')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => stop())
  const dir = mkdtempSync(join(tmpdir(), 'drh-relay-'))
  const proxyFile = join(dir, 'cookie.txt')
  const relayFile = join(dir, 'cookie.txt.relay')
  writeFileSync(proxyFile, 'proxy-credential')
  writeFileSync(relayFile, 'relay-credential')
  const dial = { hostname: '127.0.0.1', port: server.address().port, blocked: false }
  proxyUpgrade(upgradeRequest('/api/remote.mux'), fakeSocket(), Buffer.alloc(0), dial, '127.0.0.1:' + String(dial.port), proxyFile, { relayFile })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(seen, ['relay-credential'])
})

test('a relay credential that was never minted is exchanged before the dial', async (t) => {
  const { server, seen, stop } = upstream(() => 'accept')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => stop())
  const dir = mkdtempSync(join(tmpdir(), 'drh-relay-'))
  const proxyFile = join(dir, 'cookie.txt')
  const relayFile = join(dir, 'cookie.txt.relay')
  writeFileSync(proxyFile, 'proxy-credential')
  let refreshes = 0
  const dial = { hostname: '127.0.0.1', port: server.address().port, blocked: false }
  proxyUpgrade(upgradeRequest('/api/remote.mux'), fakeSocket(), Buffer.alloc(0), dial, '127.0.0.1:' + String(dial.port), proxyFile, {
    relayFile,
    refresh: async () => { refreshes += 1; writeFileSync(relayFile, 'fresh-relay') },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(refreshes, 1)
  assert.deepEqual(seen, ['fresh-relay'])
})

test('a 401 on the relay leg exchanges a credential and dials again', async (t) => {
  const { server, seen, stop } = upstream((attempt) => (attempt === 1 ? 'refuse' : 'accept'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => stop())
  const dir = mkdtempSync(join(tmpdir(), 'drh-relay-'))
  const proxyFile = join(dir, 'cookie.txt')
  const relayFile = join(dir, 'cookie.txt.relay')
  writeFileSync(proxyFile, 'proxy-credential')
  writeFileSync(relayFile, 'spent-relay')
  let refreshes = 0
  const dial = { hostname: '127.0.0.1', port: server.address().port, blocked: false }
  const socket = fakeSocket()
  proxyUpgrade(upgradeRequest('/api/remote.mux'), socket, Buffer.alloc(0), dial, '127.0.0.1:' + String(dial.port), proxyFile, {
    relayFile,
    refresh: async () => { refreshes += 1; writeFileSync(relayFile, 'fresh-relay') },
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(refreshes, 1)
  assert.deepEqual(seen, ['spent-relay', 'fresh-relay'])
  assert.ok(socket.written.some((line) => line.includes('101')), 'the page sees the retried upgrade: ' + JSON.stringify(socket.written))
})