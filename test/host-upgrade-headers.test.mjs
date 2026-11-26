/**
 * An upgrade the upstream refuses is an ordinary HTTP response, not a negotiated protocol.
 *
 * Copying that response's hop-by-hop headers toward the page would describe framing the page
 * never receives: node already de-chunked the body and owns the connection. A 101 keeps them —
 * there, connection and upgrade ARE the negotiation.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { proxyUpgrade } from '../lib/index.js'

/** An upstream that answers the upgrade with `answer` and then closes. */
async function upstream(answer) {
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    socket.write(answer)
    socket.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    stop() { server.closeAllConnections(); server.close() },
  }
}

/** The browser side: a real duplex, because the relay pipes the upstream into it. */
function browserSocket() {
  const socket = new PassThrough()
  const chunks = []
  socket.on('data', (chunk) => chunks.push(String(chunk)))
  socket.on('error', () => {})
  return { socket, text: () => chunks.join('') }
}

/** Resolve once the relay stops writing, or after `ms` so a stuck pipe fails loudly. */
function drained(socket, ms = 1000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => { if (settled) return; settled = true; resolve() }
    socket.once('end', finish)
    socket.once('close', finish)
    const timer = setTimeout(finish, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** Drive one upgrade through the shipped proxy and read what the browser would see. */
async function relayUpgrade(answer) {
  const remote = await upstream(answer)
  const dial = { hostname: '127.0.0.1', port: remote.port, secure: false, blocked: false }
  const browser = browserSocket()
  const cookieFile = join(mkdtempSync(join(tmpdir(), 'drh-upgrade-')), 'cookie.txt')
  proxyUpgrade(
    { url: '/api/remote.mux', method: 'GET', headers: { upgrade: 'websocket', connection: 'Upgrade' } },
    browser.socket,
    Buffer.alloc(0),
    dial,
    '127.0.0.1:' + String(remote.port),
    cookieFile,
  )
  await drained(browser.socket)
  remote.stop()
  browser.socket.destroy()
  return browser.text()
}

test('proxyUpgrade: a refused upgrade does not relay hop-by-hop response headers', async () => {
  const text = await relayUpgrade(
    'HTTP/1.1 403 Forbidden\r\n' +
    'X-Reason: nope\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    'Connection: keep-alive\r\n' +
    'Keep-Alive: timeout=5\r\n\r\n' +
    '4\r\ndeny\r\n0\r\n\r\n',
  )
  assert.match(text, /^HTTP\/1\.1 403 Forbidden/, 'the refusal status reaches the page: ' + JSON.stringify(text))
  assert.match(text, /x-reason: nope/i, 'an end-to-end header is still relayed')
  assert.doesNotMatch(text, /transfer-encoding/i, 'the body node already de-chunked must not claim to be chunked')
  assert.doesNotMatch(text, /keep-alive/i, 'no keep-alive of a connection this proxy does not keep')
  assert.match(text, /connection: close/i, 'the close-delimited body says so')
  assert.match(text, /deny$/, 'the body itself still arrives: ' + JSON.stringify(text))
})

test('proxyUpgrade: a 101 keeps every header, because the negotiation is the message', async () => {
  const text = await relayUpgrade('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: abc123\r\n\r\n')
  assert.match(text, /^HTTP\/1\.1 101 Switching Protocols/, 'the protocol switch is relayed: ' + JSON.stringify(text))
  assert.match(text, /upgrade: websocket/i, 'the negotiated protocol survives')
  assert.match(text, /connection: Upgrade/i, 'the connection header survives on a 101')
  assert.match(text, /sec-websocket-accept: abc123/i)
})
