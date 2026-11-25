/** proxyRequest's 401 replay: the buffered body is re-sent byte for byte, or the 401 stands. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { proxyRequest } from '../lib/index.js'

/** A remote Host stand-in: it records each request and answers with `reply`. */
async function remoteHost(reply) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
      calls.push(call)
      reply(call, res, calls.length)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, calls, port: server.address().port }
}

/** The mount's local origin: every request goes straight into proxyRequest. */
async function mountOrigin(port, cookieFile, options) {
  const dial = { hostname: '127.0.0.1', port, secure: false, blocked: false }
  const server = createServer((req, res) => {
    proxyRequest(req, res, dial, 'devbox:3082', cookieFile, options)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: server.address().port }
}

/** Send one request to the mount and read the answer the way the page would. */
function call(port, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(payload)
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/session/list',
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** Write the credential the proxies read, the way the mint leaves it. */
function cookieFileWith(value) {
  const file = join(mkdtempSync(join(tmpdir(), 'drh-replay-')), 'cookie.txt')
  writeFileSync(file, value + '\n', { mode: 0o600 })
  return file
}

/** The first request a spent credential produces: the Host rejects it. */
function rejectSpent(req, res) {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end('{"error":"credential spent"}')
}

test('proxy replay: a 401 re-sends the same buffered bytes with the fresh credential', async (t) => {
  const payload = JSON.stringify({
    type: 'server-request',
    rpcId: 'rpc-1',
    endpoint: 'session/list',
    payload: { groupByWorkspace: true, includeArchived: false, limit: 40 },
  })
  const remote = await remoteHost((req, res, ordinal) => {
    if (ordinal === 1) { rejectSpent(req, res); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  const cookieFile = cookieFileWith('dsh-auth=spent-value')
  let refreshes = 0
  const front = await mountOrigin(remote.port, cookieFile, {
    refresh: async () => {
      refreshes += 1
      writeFileSync(cookieFile, 'dsh-auth=fresh-value\n', { mode: 0o600 })
    },
  })
  t.after(() => {
    front.server.closeAllConnections(); front.server.close()
    remote.server.closeAllConnections(); remote.server.close()
  })

  const answer = await call(front.port, payload)

  assert.equal(answer.status, 200, 'the replayed request carries the page past the 401')
  assert.equal(answer.body, '{"ok":true}', 'the page reads the answer to the replay, not the 401 body')
  assert.equal(remote.calls.length, 2, 'exactly one replay: ' + String(remote.calls.length))
  assert.equal(refreshes, 1, 'the credential is exchanged once')
  const [first, second] = remote.calls
  assert.equal(first.body.toString('utf8'), payload)
  assert.equal(second.body.toString('utf8'), payload, 'the replay sends the same bytes')
  assert.deepEqual(second.body, first.body, 'the buffered body survives the 401')
  assert.equal(second.headers['content-length'], String(Buffer.byteLength(payload)))
  assert.equal(first.headers.cookie, 'dsh-auth=spent-value')
  assert.equal(second.headers.cookie, 'dsh-auth=fresh-value', 'the replay reads the re-minted credential')
  assert.equal(first.url, second.url)
  assert.equal(first.method, second.method)
})

test('proxy replay: without a refresh option the 401 reaches the page unchanged', async (t) => {
  const remote = await remoteHost(rejectSpent)
  const cookieFile = cookieFileWith('dsh-auth=spent-value')
  const front = await mountOrigin(remote.port, cookieFile)
  t.after(() => {
    front.server.closeAllConnections(); front.server.close()
    remote.server.closeAllConnections(); remote.server.close()
  })

  const answer = await call(front.port, '{"type":"server-request","rpcId":"rpc-2"}')

  assert.equal(answer.status, 401, 'a mount with no refresher does not replay')
  assert.equal(answer.body, '{"error":"credential spent"}', 'the remote body is relayed as-is')
  assert.equal(remote.calls.length, 1)
})

test('proxy replay: a refresh that fails answers 502 instead of leaving the page hanging', async (t) => {
  const remote = await remoteHost(rejectSpent)
  const cookieFile = cookieFileWith('dsh-auth=spent-value')
  const front = await mountOrigin(remote.port, cookieFile, {
    refresh: async () => { throw new Error('no ticket available') },
  })
  t.after(() => {
    front.server.closeAllConnections(); front.server.close()
    remote.server.closeAllConnections(); remote.server.close()
  })

  const answer = await call(front.port, '{"type":"server-request","rpcId":"rpc-3"}')

  assert.equal(answer.status, 502)
  assert.match(answer.body, /remote credential expired and could not be refreshed/)
  assert.equal(remote.calls.length, 1, 'a failed refresh does not replay')
})

test('proxy replay: a second 401 after the replay is not retried again', async (t) => {
  // A fresh credential that is still refused means something else is wrong; replaying forever
  // would turn one broken credential into an unbounded stream of remote requests.
  const remote = await remoteHost(rejectSpent)
  const cookieFile = cookieFileWith('dsh-auth=spent-value')
  let refreshes = 0
  const front = await mountOrigin(remote.port, cookieFile, {
    refresh: async () => {
      refreshes += 1
      writeFileSync(cookieFile, 'dsh-auth=fresh-value\n', { mode: 0o600 })
    },
  })
  t.after(() => {
    front.server.closeAllConnections(); front.server.close()
    remote.server.closeAllConnections(); remote.server.close()
  })

  const answer = await call(front.port, '{"type":"server-request","rpcId":"rpc-4"}')

  assert.equal(answer.status, 401, 'the second 401 stands')
  assert.equal(remote.calls.length, 2, 'one replay, then the 401 is final: ' + String(remote.calls.length))
  assert.equal(refreshes, 1)
})
