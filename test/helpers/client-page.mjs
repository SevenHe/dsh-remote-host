/**
 * Loads the real lib/client.js into a vm sandbox and instantiates its plugin module.
 *
 * lib/client.js is a classic script (no ESM exports): it registers one module with
 * window.__ModuleLoader__ and reads its config from the page global. This helper fakes
 * only those page globals and `react`, then calls the registered factory, which defines
 * the plugin without touching the DOM. Nothing below replaces the code under test.
 *
 * The pure view-model helpers the module publishes (__DRH_VIEW_MODEL__) are therefore
 * driven exactly as the shipped page would run them, and the suite stays offline.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
// Default: the shipped artifact. DRH_CLIENT points the suite at a mutated copy, which is
// how a maintainer proves a case fails when the behaviour regresses.
const CLIENT = process.env.DRH_CLIENT ?? join(HERE, '..', '..', 'lib', 'client.js')

/** React stand-in: the factory captures createElement and renders nothing at load time. */
const REACT_STUB = { createElement: () => ({}) }

/**
 * Copy a value the sandbox produced into this realm. Arrays and objects the vm creates
 * carry the sandbox's Array/Object prototypes, so node:assert/strict would reject them
 * as unequal even when they describe the same value.
 */
const toHost = (value) => (value === null || typeof value !== 'object' ? value : structuredClone(value))


/** Selector the block mounts itself against: the shipped sidebar's workspace slot. */
const SIDEBAR_SLOT = '[data-slot="sidebar.workspaces"]'

/** One DOM node: only what the block's mount, render and teardown paths touch. */
function createNode(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    style: {},
    textContent: '',
    innerHTML: '',
    parentNode: null,
    childNodes: [],
    attributes: new Map(),
    listeners: new Map(),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    setAttribute(name, value) { node.attributes.set(String(name), String(value)) },
    getAttribute(name) { return node.attributes.has(String(name)) ? node.attributes.get(String(name)) : null },
    addEventListener(type, handler) {
      const list = node.listeners.get(type) ?? []
      list.push(handler)
      node.listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = node.listeners.get(type) ?? []
      node.listeners.set(type, list.filter((entry) => entry !== handler))
    },
    appendChild(child) { child.parentNode = node; node.childNodes.push(child); return child },
    insertBefore(child, reference) {
      const at = reference === undefined || reference === null ? -1 : node.childNodes.indexOf(reference)
      child.parentNode = node
      node.childNodes.splice(at < 0 ? node.childNodes.length : at, 0, child)
      return child
    },
    removeChild(child) {
      const at = node.childNodes.indexOf(child)
      if (at >= 0) node.childNodes.splice(at, 1)
      child.parentNode = null
      return child
    },
    replaceChild(next, previous) {
      const at = node.childNodes.indexOf(previous)
      next.parentNode = node
      if (at >= 0) node.childNodes.splice(at, 1, next)
      else node.childNodes.push(next)
      previous.parentNode = null
      return previous
    },
    remove() { if (node.parentNode !== null) node.parentNode.removeChild(node) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    insertAdjacentHTML() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
  }
  const nextSibling = () => {
    if (node.parentNode === null) return null
    const at = node.parentNode.childNodes.indexOf(node)
    return at < 0 ? null : node.parentNode.childNodes[at + 1] ?? null
  }
  Object.defineProperty(node, 'nextSibling', { get: nextSibling })
  Object.defineProperty(node, 'parentElement', { get: () => node.parentNode })
  return node
}

/**
 * The page document, with the shipped sidebar slot mounted so the block can attach to it.
 * Listeners and the block's own nodes are observable, which is what the teardown test needs.
 */
function createDocumentStub() {
  const created = []
  const listeners = new Map()
  const head = createNode('head')
  const body = createNode('body')
  const host = createNode('div')
  host.setAttribute('data-slot', 'sidebar.workspaces')
  const hostWrapper = createNode('div')
  body.appendChild(hostWrapper)
  hostWrapper.appendChild(host)
  const contains = (candidate) => {
    for (let at = candidate; at !== null && at !== undefined; at = at.parentNode) {
      if (at === body || at === head) return true
    }
    return false
  }
  const blocks = () => created.filter((node) => node.id === 'drh-remote-block' && contains(node) === true)
  const document = {
    visibilityState: 'visible',
    head,
    body,
    activeElement: null,
    createElement(tagName) { const node = createNode(tagName); created.push(node); return node },
    getElementById(id) { return created.find((node) => node.id === id && contains(node) === true) ?? null },
    querySelector(selector) {
      if (selector === SIDEBAR_SLOT) return contains(host) === true ? host : null
      if (selector === '#drh-remote-block') return blocks()[0] ?? null
      return null
    },
    querySelectorAll(selector) { return selector === '#drh-remote-block' ? blocks() : [] },
    contains,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      listeners.set(type, list.filter((entry) => entry !== handler))
    },
    dispatchEvent() { return true },
    /** How many handlers are attached for one document event. */
    listenerCount(type) { return (listeners.get(type) ?? []).length },
    /** Mounted blocks, i.e. how many instances currently own #drh-remote-block. */
    blockCount() { return blocks().length },
  }
  return document
}
/**
 * Instantiate the client plugin for one page.
 * @param options.config - the plugin config the page publishes (undefined fields default).
 */
export function createClientPage(options = {}) {
  const registrations = []
  const document = createDocumentStub()
  const windowListeners = new Map()
  const intervalsStarted = []
  const intervalsCleared = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date, Set, Map, Array, Object, String, Number, Boolean, RegExp, Promise,
    Error, TypeError, RangeError, isFinite, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, queueMicrotask,
    document,
    // Deterministic timers: nothing in the pure path may schedule work, and an interval
    // the plugin starts but never stops stays visible here.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval(handler, delay) {
      const id = intervalsStarted.length + 1
      intervalsStarted.push({ id, delay })
      return id
    },
    clearInterval(id) { intervalsCleared.push(id) },
    addEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      list.push(handler)
      windowListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      windowListeners.set(type, list.filter((entry) => entry !== handler))
    },
    __DSH_REMOTE_HOST__: options.config ?? {},
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.__ModuleLoader__ = {
    load(registration) { registrations.push(registration) },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'lib/client.js' })
  if (registrations.length !== 1) {
    throw new Error('lib/client.js must register exactly one module, got ' + registrations.length)
  }
  const plugin = registrations[0].factory((name) => {
    if (name === 'react') return REACT_STUB
    throw new Error('unexpected module request: ' + name)
  })
  const helpers = sandbox.__DRH_VIEW_MODEL__
  if (helpers === undefined || helpers === null) {
    throw new Error('lib/client.js did not publish __DRH_VIEW_MODEL__')
  }
  const view = {
    titleOf: (summary) => helpers.titleOf(summary),
    relative: (value, now) => helpers.relative(value, now),
    memberComparator: (pinned) => helpers.memberComparator(pinned),
    buildBlockRows: (input) => toHost(helpers.buildBlockRows(input)),
    buildSectionModel: (input) => toHost(helpers.buildSectionModel(input)),
    paintPlan: (input) => toHost(helpers.paintPlan(input)),
  }
  return {
    sandbox,
    plugin,
    view,
    document,
    intervalsStarted,
    intervalsCleared,
    /** Handlers currently attached to one page-window event. */
    windowListenerCount: (type) => (windowListeners.get(type) ?? []).length,
  }
}

/** One fixed clock for every relative-timestamp assertion. */
export const NOW = 1_700_000_000_000

/** A published remote summary, in the shape the host publishes. */
export function summary(id, title, updatedAt) {
  return updatedAt === undefined ? { id, title } : { id, title, updatedAt }
}

/** A session summary from the shipped workspace stream, optionally titled/archived. */
export function session(sessionId, title, extra = {}) {
  return { sessionId, projections: { values: { title } }, ...extra }
}
