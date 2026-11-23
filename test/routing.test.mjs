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

test('routing: the model catalogue follows the focused remote session', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  // Opening the remote Session is what sets the focus.
  await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  const mount = await mountCallsDuring(page, () => call(page, 'llm/listConfigurableProviders', {}))
  assert.deepEqual(mount, ['/devbox/api/llm/listConfigurableProviders'],
    'the picker must list the host that will run the turn')
})

test('routing: the model catalogue stays local before any remote session is opened', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const mount = await mountCallsDuring(page, () => call(page, 'llm/listConfigurableProviders', {}))
  assert.deepEqual(mount, [], 'a local Session keeps this host catalogue')
})

test('routing: opening a local session returns the catalogue to this host', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  await mountCallsDuring(page, () => call(page, 'session/follow', { sessionId: REMOTE_SESSION }))
  await call(page, 'session/follow', { sessionId: 'local-1' })
  const mount = await mountCallsDuring(page, () => call(page, 'llm/listProviders', {}))
  assert.deepEqual(mount, [], 'focus follows the Session the user opened')
})

