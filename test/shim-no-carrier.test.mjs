/**
 * The no-carrier branch of the mux reconnect ladder.
 *
 * A carrier factory can fail to produce the remote leg at all (it throws, or the mount URL
 * cannot be resolved). The ladder retries with backoff while the outage is young; once the
 * outage outlives DEGRADE_AFTER_MS it must hand the mux back to the shipped client instead of
 * retrying forever, because that handoff is the only way the page's own connection layer
 * learns that the remote leg is gone.
 *
 * This suite owns its page sandbox instead of test/helpers/page.mjs: it has to make the carrier
 * fail for the mount only, which the shared helper's socket factory cannot express.
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

/** One socket the page opened, driven like a browser WebSocket. */
class TestSocket {
  constructor(url) {
    this.url = String(url)
    this.readyState = 1
    this.listeners = new Map()
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type)
    if (list !== undefined) this.listeners.set(type, list.filter((entry) => entry !== handler))
  }
  send() {}
  close() { this.readyState = 3 }
  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

/**
 * Build one page view whose carrier can be told to stop dialling the mount.
 * @returns the page handle the tests below drive.
 */
function createPage() {
  const clock = { now: 1_795_420_000_000 }
  const timers = []
  const sockets = { local: undefined, remote: undefined }
  const dials = []
  const page = { clock, sockets, dialFails: false }

  const factory = (url) => {
    const target = String(url)
    // The mount leg is the one that can fail: everything else (the client mux socket and the
    // local leg) has to keep working, or the router would never be built at all.
    if (target.includes(MOUNT) !== true) {
      sockets.local = new TestSocket(target)
      return sockets.local
    }
    dials.push(target)
    if (page.dialFails === true) throw new Error('carrier cannot dial the mount')
    sockets.remote = new TestSocket(target)
    return sockets.remote
  }

  const config = { mount: MOUNT, label: 'devbox', streams: true, streamRelay: false }
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
    Response: class Response {
      constructor(body) { this.body = body; this.ok = true }
      async json() { return JSON.parse(this.body) }
    },
    Date: class extends Date { static now() { return clock.now } },
    setTimeout: (fn, delay) => { timers.push({ fn, delay: delay === undefined ? 0 : delay }); return timers.length },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    // Diagnostics and prefetches must answer without opening the network.
    fetch: () => Promise.resolve({ ok: true, json: async () => ({ result: { ok: true, value: { items: [] } } }) }),
    WebSocket: function WebSocket(url) { return factory(url) },
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
    document: null,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init === undefined ? undefined : init.detail }
    },
    __DSH_TRANSPORT__: { fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }), createWebSocket: factory },
    __DSH_REMOTE_HOST__: config,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SHIM, 'utf8'), sandbox, { filename: 'lib/shim.js' })

  const built = sandbox.__DSH_TRANSPORT__
  page.sandbox = sandbox
  page.built = built
  /** Mount dials the carrier was asked for: one per reconnect attempt. */
  page.dials = () => dials.length
  page.fireTimers = () => {
    const due = timers.splice(0, timers.length)
    for (const timer of due) timer.fn()
  }
  page.openMux = () => {
    const client = built.createWebSocket('/api/remote.mux')
    sockets.local?.emit('open', {})
    return client
  }
  page.dispose = () => {
    const stop = sandbox.__DSH_REMOTE_HOST_STOP_POLL__
    if (typeof stop === 'function') stop()
  }
  return page
}

/** Open the event stream so the mux router holds a remote leg. */
function openRemoteLeg(page) {
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  assert.ok(page.sockets.remote, 'the remote leg is dialled for the forwarded-event stream')
  return client
}

test('no carrier: the ladder keeps retrying while the outage is young', (t) => {
  const page = createPage()
  t.after(() => page.dispose())
  const client = openRemoteLeg(page)
  const remote = page.sockets.remote
  remote.emit('close', { code: 1006 })
  page.dialFails = true
  const dialsBefore = page.dials()
  page.clock.now += 200
  page.fireTimers()
  assert.equal(client.readyState, 1, 'a young outage keeps the mux open')
  assert.ok(page.dials() > dialsBefore, 'the failure is retried instead of given up on')
})

test('no carrier: once the outage outlives the window the mux is handed back', (t) => {
  const page = createPage()
  t.after(() => page.dispose())
  const client = openRemoteLeg(page)
  const remote = page.sockets.remote
  remote.emit('close', { code: 1006 })
  page.dialFails = true
  // First attempt inside the DEGRADE_AFTER_MS window: nothing is handed back yet.
  page.clock.now += 200
  page.fireTimers()
  assert.equal(client.readyState, 1, 'still connected inside the window')
  // A later attempt lands past the window: the router must hand the socket back.
  page.clock.now += 3400
  page.fireTimers()
  assert.equal(client.readyState, 3, 'the mux is handed back once the outage outlives the window')
  const dialsAtDegrade = page.dials()
  page.clock.now += 60000
  page.fireTimers()
  assert.equal(page.dials(), dialsAtDegrade, 'a degraded mux never dials the mount again')
})
