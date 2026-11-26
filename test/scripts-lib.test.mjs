/** The script helpers: pnpm discovery, the dsh-auth cookie, and the CDP transport. */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Cdp, listPageTargets } from '../scripts/lib/cdp.mjs'
import { assertCookieVersion, b64url, COOKIE_NAME_PREFIX, DSH_AUTH_TTL_MS, DSH_AUTH_VERSION, mintAuthCookie } from '../scripts/lib/cookie.mjs'
import { isPnpmCommand, PNPM_ENV_VAR, pnpmMissingMessage, resolvePnpm } from '../scripts/lib/pnpm.mjs'

/**
 * An executable stub named `pnpm` inside `dir`.
 * @param dir - directory to place the stub in; created when missing.
 * @returns Path to the stub.
 */
function stubPnpm(dir) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'pnpm')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return path
}

test('pnpm: a PATH entry is used first and returned as an absolute path', () => {
  const bin = mkdtempSync(join(tmpdir(), 'drh-pnpm-bin-'))
  const onPath = stubPnpm(bin)
  const checkout = mkdtempSync(join(tmpdir(), 'drh-pnpm-repo-'))
  const fallback = stubPnpm(join(checkout, 'node_modules', '.bin'))
  assert.equal(resolvePnpm({ cwd: checkout, env: { PATH: bin } }), onPath)
  assert.notEqual(onPath, fallback)
})

test('pnpm: a stripped PATH still finds the checkout node_modules/.bin fallback', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'drh-pnpm-repo-'))
  const fallback = stubPnpm(join(checkout, 'node_modules', '.bin'))
  assert.equal(resolvePnpm({ cwd: checkout, env: { PATH: '' } }), fallback)
})

test('pnpm: nothing usable resolves to undefined and the message names both ways out', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'drh-pnpm-repo-'))
  assert.equal(resolvePnpm({ cwd: checkout, env: { PATH: '' } }), undefined)
  const message = pnpmMissingMessage({ env: { PATH: '' } })
  assert.match(message, /pnpm not found/)
  assert.match(message, /install pnpm/)
  assert.match(message, new RegExp(PNPM_ENV_VAR))
})

test('pnpm: PNPM overrides discovery, and an unusable override is named', () => {
  const bin = mkdtempSync(join(tmpdir(), 'drh-pnpm-bin-'))
  const onPath = stubPnpm(bin)
  const override = stubPnpm(mkdtempSync(join(tmpdir(), 'drh-pnpm-env-')))
  assert.equal(resolvePnpm({ cwd: '/nonexistent', env: { PATH: bin, [PNPM_ENV_VAR]: override } }), override)
  assert.notEqual(onPath, override)
  assert.equal(resolvePnpm({ cwd: '/nonexistent', env: { PATH: bin, [PNPM_ENV_VAR]: '/no/such/pnpm' } }), undefined)
  const message = pnpmMissingMessage({ env: { [PNPM_ENV_VAR]: '/no/such/pnpm' } })
  assert.match(message, /\/no\/such\/pnpm/)
  assert.match(message, /not an executable file/)
})

test('pnpm: the ENOENT hint is attached to pnpm only', () => {
  assert.equal(isPnpmCommand('pnpm'), true)
  assert.equal(isPnpmCommand('/repo/node_modules/.bin/pnpm'), true)
  assert.equal(isPnpmCommand('C:\\tools\\pnpm.cmd'), true)
  assert.equal(isPnpmCommand('ssh'), false)
  assert.equal(isPnpmCommand('pnpmx'), false)
})

test('cookie: minting uses the shared version, window, and derivation', () => {
  const secret = Buffer.alloc(32, 7)
  const now = 1_700_000_000_000
  const authority = 'devbox.example.com:3080'
  const cookie = mintAuthCookie({ authority, secretB64u: secret.toString('base64url'), now })
  assert.equal(cookie.name, COOKIE_NAME_PREFIX + b64url(createHash('sha256').update(authority).digest()))
  const [tokenPrefix, body, signature] = cookie.value.split('.')
  assert.equal(tokenPrefix, 'v' + String(DSH_AUTH_VERSION), 'the token prefix carries the payload version')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  assert.equal(payload.version, DSH_AUTH_VERSION)
  assert.equal(payload.authority, authority)
  assert.equal(payload.issuedAt, now)
  assert.equal(payload.expiresAt, now + DSH_AUTH_TTL_MS)
  assert.equal(DSH_AUTH_TTL_MS, 7 * 24 * 60 * 60 * 1000, 'the stricter of the two advertised windows')
  assert.equal(signature, b64url(createHmac('sha256', secret).update(body).digest()), 'the signature covers the exact body')
})

test('cookie: an unsupported grant version is refused and names its source', () => {
  assert.equal(assertCookieVersion(DSH_AUTH_VERSION, 'fixture.yaml'), undefined)
  assert.throws(() => assertCookieVersion(2, 'fixture.yaml'), /dsh-auth version 2 in fixture\.yaml is not supported \(expected 1\)/)
  assert.throws(() => assertCookieVersion(undefined, 'fixture.yaml'), /dsh-auth version undefined in fixture\.yaml/)
})

test('cookie: a secret that is not 32 bytes cannot sign a cookie', () => {
  assert.throws(
    () => mintAuthCookie({ authority: 'devbox.example.com:3080', secretB64u: Buffer.alloc(16, 1).toString('base64url') }),
    /browser-session secret is not 32 bytes/,
  )
})

/** A stand-in for the page debugger WebSocket; the test plays the page. */
class FakeSocket {
  /**
   * @param options.respond - answer every command with an empty result, for multi-step methods.
   */
  constructor({ respond = false } = {}) {
    this.respond = respond
    this.sent = []
    this.listeners = new Map()
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  send(data) {
    const frame = JSON.parse(data)
    this.sent.push(frame)
    if (this.respond === true) queueMicrotask(() => this.reply({ id: frame.id, result: {} }))
  }

  close() { this.emit('close', {}) }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  /** Deliver one protocol frame from the page. */
  reply(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
}

test('cdp: a reply resolves the request carrying the same id', async () => {
  const socket = new FakeSocket()
  const cdp = new Cdp(socket)
  const pending = cdp.send('Runtime.enable')
  assert.deepEqual(socket.sent, [{ id: 1, method: 'Runtime.enable', params: {} }])
  socket.reply({ id: 1, result: { ok: true } })
  assert.deepEqual(await pending, { ok: true })
})

test('cdp: a protocol error rejects with the method that failed', async () => {
  const socket = new FakeSocket()
  const cdp = new Cdp(socket)
  const pending = cdp.send('Page.navigate', { url: 'about:blank' })
  socket.reply({ id: 1, error: { code: -32000, message: 'cannot navigate' } })
  await assert.rejects(pending, /Page\.navigate: .*cannot navigate/)
})

test('cdp: evaluate unwraps the value and reports page exceptions', async () => {
  const socket = new FakeSocket()
  const cdp = new Cdp(socket)
  const value = cdp.evaluate('1 + 1')
  socket.reply({ id: 1, result: { result: { value: 2 } } })
  assert.equal(await value, 2)
  const thrown = cdp.evaluate('boom')
  socket.reply({ id: 2, result: { exceptionDetails: { exception: { description: 'ReferenceError: boom is not defined' } } } })
  await assert.rejects(thrown, /evaluate failed: ReferenceError: boom is not defined/)
})

test('cdp: closing the socket rejects commands still in flight', async () => {
  const socket = new FakeSocket()
  const cdp = new Cdp(socket)
  const pending = cdp.send('Runtime.enable')
  socket.close()
  await assert.rejects(pending, /cdp socket closed/)
})

test('cdp: click and escape send the sequences the menus need', async () => {
  const socket = new FakeSocket({ respond: true })
  const cdp = new Cdp(socket)
  await cdp.click(10, 20)
  assert.deepEqual(socket.sent.map((frame) => frame.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  const [move, press, release] = socket.sent.map((frame) => frame.params)
  assert.deepEqual(move, { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0 }, 'a hover precedes the press')
  assert.equal(press.button, 'left')
  assert.equal(press.buttons, 1, 'the press reports the held button')
  assert.equal(press.clickCount, 1)
  assert.equal(release.buttons, 0, 'the release clears the held button')
  socket.sent.length = 0
  await cdp.escape()
  assert.deepEqual(socket.sent.map((frame) => frame.params.type), ['keyDown', 'keyUp'])
  assert.equal(socket.sent[0].params.key, 'Escape')
  assert.equal(socket.sent[0].params.nativeVirtualKeyCode, 27, 'menus read the native code')
})

test('cdp: page targets are filtered to pages that expose a debugger URL', async (t) => {
  const targets = [
    { type: 'page', url: 'http://127.0.0.1:1/', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' },
    { type: 'background_page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/2' },
    { type: 'page', url: 'http://127.0.0.1:1/other' },
  ]
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(targets))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })

  const pages = await listPageTargets(server.address().port)
  assert.deepEqual(seen, ['/json/list'])
  assert.deepEqual(pages.map((page) => page.url), ['http://127.0.0.1:1/'], 'only page targets with a debugger URL survive')
})
