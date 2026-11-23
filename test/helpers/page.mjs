/**
 * Loads the real lib/shim.js into a vm sandbox with stubbed page globals, so the
 * data-plane decisions can be driven through the shim's own carrier surface:
 * the transport fetch hook (unary routing + the session/list merge) and the
 * multiplexing WebSocket (stream routing, workspace merges, forwarded events).
 *
 * Nothing here stubs the code under test: only the browser and the network are
 * fake. Every URL is answered locally, so the suite is fully offline.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
// Default: the shipped artifact. DRH_SHIM points the suite at a mutated copy,
// which is how a maintainer proves a test fails when the behaviour regresses.
const SHIM = process.env.DRH_SHIM ?? join(HERE, '..', '..', 'lib', 'shim.js')
/** Fixed so window comparisons never depend on the wall clock. */
export const NOW = 1_700_000_000_000
export const DAY = 24 * 60 * 60 * 1000

/** Envelope the Host answers a Remote call with. */
export function envelope(itemsOrValue) {
  return { type: 'server-response', rpcId: 'test', result: { ok: true, value: itemsOrValue } }
}

/** One fake WebSocket in the page: the router drives it as a carrier. */
class FakeSocket {
  constructor(url, kind) {
    this.url = String(url)
    this.kind = kind
    this.readyState = 1
    this.sent = []
    this.listeners = new Map()
    this.closed = false
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    this.listeners.set(type, list.filter((entry) => entry !== handler))
  }

  send(text) { this.sent.push(JSON.parse(String(text))) }

  close() { this.closed = true; this.readyState = 3 }

  /** Deliver one carrier event the way a real socket would. */
  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  /** Deliver one text frame. */
  frame(value) { this.emit('message', { data: JSON.stringify(value) }) }
}

/**
 * Instantiate the shim for one page view.
 * @param options.config - shim config object (group mode, trace, ...).
 * @param options.localItems - rows the local Host answers session/list with.
 * @param options.remoteItems - rows the mounted Host answers session/list with.
 * @param options.failRemote - answer the mounted session/list with a failure.
 */
export function createPage(options = {}) {
  const config = { mount: '/devbox', label: 'devbox', streams: true, ...options.config }
  const localItems = options.localItems ?? []
  const remoteItems = options.remoteItems ?? []
  // bodies are recorded alongside the paths so a test can assert on a rewritten request
  // (the claim-workspace create drops its workspaceId before the local Host sees it).
  const calls = { local: [], mount: [], sockets: [], bodies: { local: [], mount: [] } }
  const sockets = new Map()
  const clientFrames = []

  const respond = (value) => ({
    ok: true,
    status: 200,
    json: async () => envelope(value),
  })

  async function fetchImpl(input, init) {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    // Normalize to one absolute-looking path: the shim calls both 'api/x' (page
    // relative) and '/devbox/api/x' (the mount), and assertions want one form.
    const path = '/' + url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '')
    const isMount = path === config.mount || path.startsWith(config.mount + '/')
    const leg = isMount ? 'mount' : 'local'
    if (typeof init?.body === 'string') calls.bodies[leg].push({ path, body: init.body })
    if (isMount) {
      calls.mount.push(path)
      if (path.endsWith('/api/session/modelCatalog')) {
        if (options.failRemoteCatalog === true) return { ok: false, status: 502, json: async () => ({}) }
        return respond(options.remoteCatalog === undefined ? {} : options.remoteCatalog)
      }
      if (path.endsWith('/api/session/list')) {
        if (options.failRemote === true) return { ok: false, status: 502, json: async () => ({}) }
        // A function form lets one test change the answer between calls.
        return respond({ items: typeof options.remoteItems === 'function' ? options.remoteItems() : remoteItems })
      }
      return { ok: true, status: 200, json: async () => envelope({}) }
    }
    calls.local.push(path)
    if (path.endsWith('/api/session/modelCatalog')) return respond(options.localCatalog === undefined ? {} : options.localCatalog)
    if (path.endsWith('/api/session/list')) return respond({ items: localItems })
    return respond({})
  }

  /** Deterministic timers: tests drive every transition, nothing fires later. */
  const pendingTimers = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    URL,
    JSON,
    Math,
    Date,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
    Error,
    TypeError,
    RangeError,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    structuredClone,
    Response,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    fetch: fetchImpl,
    WebSocket: FakeSocket,
    performance: { memory: undefined },
    setTimeout: (fn, delay) => { pendingTimers.push({ fn, delay: delay === undefined ? 0 : delay }); return pendingTimers.length },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    location: { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' },
    document: null,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail }
    },
  }
  /**
   * Minimal localStorage: the shim reads the client's persisted current Session as a
   * cold-start clue for the model catalogue owner, so a test has to be able to seed it.
   */
  const stored = new Map(Object.entries(options.localStorage === undefined ? {} : options.localStorage))
  sandbox.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: (key) => { stored.delete(key) },
  }

  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox

  const listeners = new Map()
  sandbox.document = {
    visibilityState: 'visible',
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) ?? []) handler(event)
      return true
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByTagName: () => ({ length: 0 }),
  }

  /**
   * Calls the page's own carrier received, when a test seeds a fully decoded rpc carrier.
   * The desktop shell publishes this shape, and the shim wraps it instead of fetch, so its
   * routing decisions need the same assertions as the fetch path.
   */
  const rpcCalls = []
  const rpcCall = async (channel, endpoint, payload) => {
    rpcCalls.push({ channel, endpoint, payload })
    if (endpoint === 'session/list') return envelope({ items: localItems })
    return envelope({})
  }

  /**
   * Every socket the page opens goes through here so tests can drive both legs.
   * Passing carrier:false withholds it entirely, which is how a test reproduces a
   * shell that publishes its carrier only after this script has run.
   */
  sandbox.__DSH_TRANSPORT__ = options.carrier === false ? undefined : {
    fetch: fetchImpl,
    ...options.rpc === true ? { rpc: { call: rpcCall } } : {},
    createWebSocket: (url) => {
      const kind = String(url).includes(config.mount) ? 'remote' : 'local'
      const socket = new FakeSocket(url, kind)
      if (kind === 'remote' && options.remoteReadyState !== undefined) socket.readyState = options.remoteReadyState
      sockets.set(kind, socket)
      calls.sockets.push(kind)
      return socket
    },
  }
  sandbox.__DSH_REMOTE_HOST__ = config

  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SHIM, 'utf8'), sandbox, { filename: 'lib/shim.js' })

  const built = sandbox.__DSH_TRANSPORT__

  /** Let the install-time prefetches settle (they populate the remote id set). */
  const settle = async (rounds = 6) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  /** Open the mux and hand back the client socket the shim multiplexes onto. */
  const openMux = () => {
    const client = built.createWebSocket('/api/remote.mux')
    client.addEventListener('message', (event) => clientFrames.push(JSON.parse(event.data)))
    for (const kind of ['local', 'remote']) sockets.get(kind)?.emit('open', {})
    return client
  }

  return {
    /** Stop timers the shim registered, so a suite leaves no pending work behind. */
    dispose() {
      try { if (typeof sandbox.__DSH_REMOTE_HOST_STOP_POLL__ === 'function') sandbox.__DSH_REMOTE_HOST_STOP_POLL__() } catch (error) { /* best effort */ }
    },
    sandbox,
    built,
    config,
    calls,
    clientFrames,
    sockets,
    settle,
    openMux,
    /** Paths the shim called on one leg, excluding the Host's own diagnostics posts. */
    apiCalls: (kind) => calls[kind].filter((path) => path.includes('/api/')),
    /** Calls the seeded rpc carrier received, in order. */
    rpcCalls,
    /** rpc carrier calls for one endpoint. */
    rpcCallsFor: (endpoint) => rpcCalls.filter((entry) => entry.endpoint === endpoint),
    /** Frames the router sent to one upstream leg. */
    sent: (kind) => sockets.get(kind)?.sent ?? [],
    /** Frames the router sent to the client, optionally filtered. */
    frames: (predicate) => (predicate === undefined ? clientFrames : clientFrames.filter(predicate)),
    /** Delays of the timers still pending, in scheduling order. */
    timerDelays: () => pendingTimers.map((timer) => timer.delay),
    fireTimers() {
      const due = pendingTimers.splice(0, pendingTimers.length)
      for (const timer of due) timer.fn()
    },
  }
}
