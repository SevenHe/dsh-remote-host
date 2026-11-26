/**
 * The decoded rpc carrier publishes what it merges.
 *
 * A desktop shell may publish a decoded carrier (rpc.call) instead of fetch, and its contract is
 * the decoded result: { ok, value } or { ok: false, error }, which is what the shipped client
 * reads (lib/client.js). That path merged session/list but never published the snapshot the
 * plugin-rendered block reads, so with group: none - where the block is the only place a remote
 * Session appears - the data fell back to the 4 s poll.
 *
 * This suite owns its page sandbox because test/helpers/page.mjs rpc call seeds an envelope
 * rather than a decoded result, so the merge branch never runs there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = process.env.DRH_SHIM ?? join(HERE, '..', 'lib', 'shim.js')
const MOUNT = '/devbox'
const NOW = 1_700_000_000_000
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]
const REMOTE_ITEMS = [{ sessionId: 'worker-1', updatedAt: NOW, running: true }]

/** The envelope the Host answers a mount request with. */
const envelope = (value) => ({ type: 'server-response', rpcId: 'test', result: { ok: true, value: value } })

/**
 * Build one page view whose shell publishes a decoded rpc carrier.
 * @returns the page handle the tests below drive.
 */
function createPage() {
  const calls = { mount: [], rpc: [], announced: [] }
  const page = {}

  const respond = (value) => ({ ok: true, status: 200, json: async () => envelope(value) })
  // The install-time prefetch answers empty on purpose: everything below must be learned from
  // the merged carrier answer, not from a snapshot that happened to arrive first.
  let listReads = 0
  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.includes(MOUNT + '/api/') !== true) return respond({})
    calls.mount.push(url)
    if (url.includes('/api/session/list')) {
      listReads += 1
      return respond({ items: listReads === 1 ? [] : REMOTE_ITEMS })
    }
    return respond({})
  }
  /** The shell decodes the response itself; the carrier hands the caller the result object. */
  const rpc = {
    call: async (channel, endpoint, payload) => {
      calls.rpc.push({ channel, endpoint, payload })
      if (endpoint === 'session/list') return { ok: true, value: { items: LOCAL_ITEMS } }
      return { ok: true, value: {} }
    },
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    Promise,
    Error,
    TypeError,
    Set,
    Map,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    RegExp,
    Date,
    Response: class Response {
      constructor(body) { this.body = body; this.ok = true; this.status = 200 }
      async json() { return JSON.parse(this.body) }
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: fetchImpl,
    // The workspace prefetch opens its own socket even when streams are off; it must stay inert.
    WebSocket: class WebSocket { addEventListener() {} send() {} close() {} },
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      dispatchEvent(event) {
        if (event !== null && event !== undefined) calls.announced.push(String(event.type))
        return true
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init === undefined ? undefined : init.detail }
    },
    __DSH_TRANSPORT__: { fetch: fetchImpl, rpc },
    __DSH_REMOTE_HOST__: { mount: MOUNT, label: 'devbox', group: 'none' },
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SHIM, 'utf8'), sandbox, { filename: 'lib/shim.js' })

  const built = sandbox.__DSH_TRANSPORT__
  page.sandbox = sandbox
  page.calls = calls
  /** Let the install-time prefetch settle. */
  page.settle = async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  /** Ask the carrier for session/list exactly as the shipped client does. */
  page.list = () => built.rpc.call('/api', 'session/list', { args: { _request: {} } }, undefined)
  page.call = (endpoint, payload) => built.rpc.call('/api', endpoint, payload, undefined)
  page.dispose = () => {
    const stop = sandbox.__DSH_REMOTE_HOST_STOP_POLL__
    if (typeof stop === 'function') stop()
  }
  return page
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('rpc carrier: session/list publishes the block snapshot and the id set', async () => {
  const page = createPage()
  await page.settle()
  assert.equal(page.sandbox.__DSH_REMOTE_HOST_SESSIONS__, undefined, 'the prefetch publishes no snapshot')
  const result = await page.list()
  assert.equal(result.ok, true)
  const published = page.sandbox.__DSH_REMOTE_HOST_SESSIONS__
  assert.ok(Array.isArray(published), 'the block snapshot is published from the merged answer')
  assert.deepEqual(plain(published.map((row) => row.id)), ['worker-1'])
  assert.deepEqual(plain(page.sandbox.__DSH_REMOTE_HOST_IDS__), ['worker-1'])
  page.dispose()
})

test('rpc carrier: an unchanged answer is not republished', async () => {
  const page = createPage()
  await page.settle()
  await page.list()
  const afterFirst = page.calls.announced.filter((type) => type === 'drh:sessions').length
  assert.ok(afterFirst > 0, 'the first merged answer publishes')
  await page.list()
  const afterSecond = page.calls.announced.filter((type) => type === 'drh:sessions').length
  assert.equal(afterSecond, afterFirst, 'the same rows do not repaint the block again')
  page.dispose()
})

test('rpc carrier: ids learned from the merged list are routed to the mount', async () => {
  const page = createPage()
  await page.settle()
  await page.list()
  const before = page.calls.mount.length
  await page.call('session/state', { args: { sessionId: 'worker-1' } })
  const mount = page.calls.mount.slice(before)
  assert.deepEqual(mount, [MOUNT + '/api/session/state'], 'the merged id reached the routing table')
  page.dispose()
})
