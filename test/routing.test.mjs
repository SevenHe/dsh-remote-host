/**
 * Decision 4: does one call belong to the mounted host?
 *
 * Asserted through the transport the page actually uses, by watching which leg
 * the shim calls: a wrongly-routed call reaches the wrong machine, so this is
 * the most expensive decision to get wrong.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const REMOTE_ITEMS = [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

const call = (page, method, args) => page.built.fetch('api/' + method, {
  method: 'POST',
  body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
})

/** Mount calls made while running one probe, ignoring install-time prefetches. */
async function mountCallsDuring(page, probe) {
  const before = page.apiCalls('mount').length
  await probe()
  return page.apiCalls('mount').slice(before)
}

test('routing: a payload naming a remote session goes to the mounted host', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  assert.deepEqual(mount, ['/devbox/api/session/follow'])
})

test('routing: a purely local payload is answered locally and never mounted', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: 'local-1' }))
  assert.deepEqual(mount, [])
  assert.equal(page.apiCalls('local').filter((path) => path === '/api/session/follow').length, 1)
})

test('routing: with no known remote ids nothing is treated as remote', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: [] })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  assert.deepEqual(mount, [], 'an unknown id must not be guessed into the remote leg')
})

test('routing: session/list always consults the mounted host', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'session/list', {}))
  assert.deepEqual(mount, ['/devbox/api/session/list'], 'the merge needs both sides')
})

test('routing: an unrelated method with no remote id stays local', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'deepseek/models', {}))
  assert.deepEqual(mount, [], 'an unrelated method must not be mistaken for remote traffic')
})

test('routing: a remote-id stream open is sent to the mounted leg only', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const client = page.openMux()
  const localOpensBefore = page.sent('local').filter((frame) => frame.type === 'open').length
  client.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { sessionId: REMOTE_SESSION } } }))
  assert.equal(page.sent('local').filter((frame) => frame.type === 'open').length, localOpensBefore, 'the local leg must not open a remote session')
  const remoteOpen = page.sent('remote').find((frame) => frame.type === 'open')
  assert.equal(remoteOpen.endpoint, 'session/follow')
  assert.equal(remoteOpen.payload.args.sessionId, REMOTE_SESSION)
})

const LOCAL_CATALOG = {
  default: { provider: 'cpa', model: 'modelhub-deepseek-v4.1-flash', reasoningEffort: 'max' },
  routableProviders: ['cpa'],
  groups: [{ id: 'cpa', name: 'CPA', models: [{ id: 'modelhub-deepseek-v4.1-flash', name: 'ModelHub V4.1 Flash' }] }],
  failures: [],
}
const REMOTE_CATALOG = {
  default: { provider: 'cpa', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
  routableProviders: ['cpa', 'remote-only-provider'],
  groups: [{ id: 'cpa', name: 'CPA (remote)', models: [{ id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' }] }],
  failures: [],
}

/** Read one decoded catalogue value through the page's own transport. */
const readCatalog = async (page, sessionId) => {
  const response = await call(page, 'session/modelCatalog', sessionId === undefined ? {} : { sessionId })
  const body = await response.json()
  return body.result.value
}

test('routing: the catalogue follows a remote Session focus, and is not unioned', async () => {
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG,
  })
  await page.settle()
  // Opening the remote Session is what sets the focus.
  await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  const mount = await mountCallsDuring(page, () => readCatalog(page, REMOTE_SESSION))
  assert.deepEqual(mount, ['/devbox/api/session/modelCatalog'], 'the catalogue comes from the owner')
  const value = await readCatalog(page, REMOTE_SESSION)
  assert.deepEqual(value.default, REMOTE_CATALOG.default, 'a remote Session gets the remote default')
  assert.deepEqual(value.routableProviders, REMOTE_CATALOG.routableProviders,
    'the catalogues are NOT unioned: a local Session must not see remote-only models')
  assert.deepEqual(value.groups, REMOTE_CATALOG.groups)
})

test('routing: an unreachable mount degrades the catalogue to this host', async () => {
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG, failRemoteCatalog: true,
  })
  await page.settle()
  await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  const mount = await mountCallsDuring(page, () => readCatalog(page, REMOTE_SESSION))
  assert.deepEqual(mount, ['/devbox/api/session/modelCatalog'], 'the mount leg is still attempted')
  const value = await readCatalog(page, REMOTE_SESSION)
  assert.deepEqual(value, LOCAL_CATALOG, 'a dead mount leaves this host catalogue untouched')
})

test('routing: a persisted remote current Session picks the mount before any focus', async () => {
  // Cold start: the catalogue request happens before the client restores the Session, so the
  // persisted current Session is the only clue available.
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG,
    localStorage: { 'dsh.sessions.current': JSON.stringify({ sessionId: REMOTE_SESSION }) },
  })
  await page.settle()
  const mount = await mountCallsDuring(page, () => readCatalog(page, REMOTE_SESSION))
  assert.deepEqual(mount, ['/devbox/api/session/modelCatalog'], 'the persisted remote Session decides the owner')
  const value = await readCatalog(page, REMOTE_SESSION)
  assert.deepEqual(value.default, REMOTE_CATALOG.default)
})

test('routing: a persisted bare-id remote Session is accepted too', async () => {
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG,
    localStorage: { 'dsh.sessions.current': REMOTE_SESSION },
  })
  await page.settle()
  const mount = await mountCallsDuring(page, () => readCatalog(page, REMOTE_SESSION))
  assert.deepEqual(mount, ['/devbox/api/session/modelCatalog'], 'both persisted shapes are parsed')
})

test('routing: a local current Session keeps this host catalogue', async () => {
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG,
    localStorage: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'local-1' }) },
  })
  await page.settle()
  // The current Session is local, so its catalogue read names THAT Session.
  const mount = await mountCallsDuring(page, () => readCatalog(page, 'session-local-1'))
  assert.deepEqual(mount, [], 'a local Session never consults the mount')
  const value = await readCatalog(page, 'session-local-1')
  assert.deepEqual(value, LOCAL_CATALOG)
})
/**
 * The Host-level warm-up names no Session. A Host patched to take an optional sessionId
 * advertises a one-parameter descriptor, and the gateway client counts descriptor.parameters
 * rather than honouring acceptsUndefined, so sending this read to such a Host makes the
 * client throw "expected 1 argument(s), got 0" - an unhandled rejection at boot. It must
 * stay on this host, whose descriptor takes no argument, even while a remote Session holds
 * the focus.
 */
test('routing: the Session-less warm-up never reaches a Host that wants an argument', async () => {
  const page = createPage({
    config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS,
    localCatalog: LOCAL_CATALOG, remoteCatalog: REMOTE_CATALOG,
  })
  await page.settle()
  // Put the page squarely on a remote Session: the focus alone used to send this read to the mount.
  await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  mountCallsDuring(page, () => {})
  const calls = []
  const mount = await mountCallsDuring(page, () => readCatalog(page))
  assert.deepEqual(mount, [], 'a zero-argument catalogue read must never be routed to the mount')
  const value = await readCatalog(page)
  assert.deepEqual(value, LOCAL_CATALOG, 'the warm-up still gets a usable catalogue')
  assert.deepEqual(calls, [])
})
