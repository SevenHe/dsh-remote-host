/**
 * Decision 3: which forwarded Remote events reach the page.
 *
 * Remote 'emit' frames reach the shipped client unfiltered. In particular
 * api-session/added does reach it and makes the client materialize a list row;
 * keeping that row out of the shipped sidebar is the hidden-session Set's job
 * (hidden-sessions.test.mjs), not an event filter's. The waterfall and ready
 * rules below are the ones this file locks down.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_ITEMS = [{ sessionId: 'worker-1', updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

/** Open the forwarded-event stream on both legs and return the leg stream ids. */
async function openEvents(group) {
  const page = createPage({ config: { group }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }))
  const localOpen = page.sent('local').find((frame) => frame.type === 'open')
  const remoteOpen = page.sent('remote').find((frame) => frame.type === 'open')
  assert.equal(localOpen.endpoint, '$events')
  assert.equal(remoteOpen.endpoint, '$events')
  const item = (kind, frame) => page.sockets.get(kind).frame({ type: 'item', streamId: kind === 'local' ? localOpen.streamId : remoteOpen.streamId, value: frame })
  return { page, item, localOpen, remoteOpen }
}

/** Every event name the page actually received, in order. */
const received = (page) => page.frames((frame) => frame.type === 'item').map((frame) => {
  const value = frame.value
  if (value?.type === 'emit') return 'emit:' + value.event
  if (value?.type === 'waterfall') return 'waterfall:' + value.event
  return String(value?.type)
})

test('events none: a remote api-session/added is forwarded and asks for a list refresh', async () => {
  const { page, item } = await openEvents('none')
  // Local side first, so the local host is known to be alive and forwarding.
  item('local', { type: 'emit', event: 'api-session/status', args: ['local-1', true] })
  item('remote', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'worker-1' }] })
  assert.deepEqual(received(page), ['emit:api-session/status', 'emit:api-session/added'],
    'the emitted frame is not filtered: the shipped tree hides the row itself')
  // The created Session is unknown to every published snapshot until a list answer arrives.
  const refresh = page.sandbox.__DSH_REMOTE_HOST_POLL_NOW__
  assert.equal(typeof refresh, 'function', 'the refresh entry point stays available')
  const before = page.apiCalls('mount').filter((path) => path.endsWith('/api/session/list')).length
  page.fireTimers()
  const after = page.apiCalls('mount').filter((path) => path.endsWith('/api/session/list')).length
  assert.equal(after, before + 1, 'the emit schedules one re-read of the mounted list')
})

test('events none: status, activity, removed and error still flow through', async () => {
  const { page, item } = await openEvents('none')
  item('remote', { type: 'emit', event: 'api-session/status', args: ['worker-1', true] })
  item('remote', { type: 'emit', event: 'api-session/activity', args: ['worker-1', NOW] })
  item('remote', { type: 'emit', event: 'api-session/removed', args: ['worker-1'] })
  item('remote', { type: 'emit', event: 'api-session/error', args: ['worker-1', 'boom'] })
  assert.deepEqual(received(page), [
    'emit:api-session/status',
    'emit:api-session/activity',
    'emit:api-session/removed',
    'emit:api-session/error',
  ])
})

test('events none: a remote waterfall is forwarded unless the local host owns the event', async () => {
  const { page, item } = await openEvents('none')
  item('local', { type: 'waterfall', event: 'account/watch', eventId: 'l1', agentId: 'a', request: {} })
  item('remote', { type: 'waterfall', event: 'account/watch', eventId: 'r1', agentId: 'a', request: {} })
  item('remote', { type: 'waterfall', event: 'other/hook', eventId: 'r2', agentId: 'a', request: {} })
  assert.deepEqual(received(page), ['waterfall:account/watch', 'waterfall:other/hook'])
  assert.equal(received(page).filter((name) => name === 'waterfall:account/watch').length, 1, 'the local answer wins')
})

test('events none: the remote ready frame is consumed, not forwarded', async () => {
  const { page, item } = await openEvents('none')
  item('remote', { type: 'ready', clientId: 'remote-client-1', host: { home: '/home/user' } })
  assert.deepEqual(received(page), [])
})

test('events single: api-session/added flows too', async () => {
  // No event filter is mode-specific any more; the hidden-session Set is only published with
  // group none, and the single mode shows the row through its merged workspace instead.
  const { page, item } = await openEvents('single')
  item('remote', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'worker-1' }] })
  assert.deepEqual(received(page), ['emit:api-session/added'])
})
