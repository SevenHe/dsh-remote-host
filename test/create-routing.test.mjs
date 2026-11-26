/**
 * session/create routing.
 *
 * A create is workspace-scoped, but the shim used to route it by "does the payload
 * mention a remote id". Every boot restores the last Session by calling session/create
 * with its id in the payload, so that decision sent the create to the mount, whose Host
 * does not own the workspace, and the page logged
 *   workspace/not-found
 * on every start.
 *
 * These cases pin the workspace-based decision: only a create naming a Workspace the
 * mounted Host really owns reaches the mount, every other create is answered locally,
 * and no carrier rewrites the payload on the way.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const REMOTE_SESSION = 'worker-1'
const REMOTE_ITEMS = [{ sessionId: REMOTE_SESSION, updatedAt: NOW, running: true }]
const LOCAL_ITEMS = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]

const createCall = (page, request) => page.built.fetch('api/session/create', {
  method: 'POST',
  body: JSON.stringify({ type: 'client-request', rpcId: 'c1', method: 'session/create', payload: { args: { request } } }),
})

function callsDuring (page, probe) {
  const beforeMount = page.apiCalls('mount').length
  const beforeLocal = page.apiCalls('local').length
  return Promise.resolve(probe()).then(() => ({
    mount: page.apiCalls('mount').slice(beforeMount),
    local: page.apiCalls('local').slice(beforeLocal),
  }))
}

/**
 * Teach the shim a Workspace the mounted Host owns, the way a real page does: the merged
 * workspace/follow baseline is the only place those ids are learned from.
 */
function learnRemoteWorkspace (page) {
  const client = page.openMux()
  client.send(JSON.stringify({ type: 'open', streamId: 'w1', endpoint: 'workspace/follow', payload: { args: {} } }))
  const localOpen = page.sent('local').find((frame) => frame.type === 'open')
  const remoteOpen = page.sent('remote').find((frame) => frame.type === 'open')
  assert.ok(localOpen, 'the local leg receives the workspace/follow open')
  assert.ok(remoteOpen, 'the remote leg receives the workspace/follow open')
  // The merged baseline is only emitted once both sides have answered, and that emit is
  // where the mounted Host's Workspace ids are learned.
  const localWorkspace = {
    workspaceId: 'local-ws',
    path: '/Users/somebody/Workspace/opencode',
    title: 'opencode',
    sessionIds: ['local-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }
  page.sockets.get('local').frame({
    type: 'item',
    streamId: localOpen.streamId,
    value: { type: 'baseline', value: { items: [localWorkspace], archivedSessionIds: [], pinnedSessionIds: [] } },
  })
  page.sockets.get('remote').frame({
    type: 'item',
    streamId: remoteOpen.streamId,
    value: {
      type: 'baseline',
      value: {
        items: [{
          workspaceId: 'remote-ws',
          path: '/home/user/work/proj',
          title: 'proj',
          sessionIds: [REMOTE_SESSION],
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    },
  })
  assert.equal(page.frames((frame) => frame.value?.type === 'baseline').length, 1,
    'the merged baseline is emitted, which is what teaches the shim the remote Workspace id')
}

/** The create bodies one leg received, in order. */
const createBodies = (page, leg) => page.calls.bodies[leg].filter((entry) => entry.path.endsWith('/api/session/create'))

test('session/create: a local workspace stays local even when the payload names a remote Session', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  const seen = await callsDuring(page, () => createCall(page, { workspaceId: 'local-ws', sessionId: REMOTE_SESSION }))
  assert.deepEqual(seen.mount, [], 'must not reach the mount: it does not own local-ws')
  assert.deepEqual(seen.local, ['/api/session/create'])
})

test('session/create: a real remote workspace create reaches the mount untouched', async () => {
  // The shipped tree creates a Session in a merged remote row by its prefixed id. No Host
  // rewrite is involved any more: the id names a Workspace the mount owns, so the payload
  // travels as the page built it.
  const page = createPage({ config: { group: 'workspace' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS })
  await page.settle()
  learnRemoteWorkspace(page)
  const seen = await callsDuring(page, () => createCall(page, { workspaceId: 'drh:remote-ws' }))
  assert.deepEqual(seen.local, [], 'the local Host does not own this workspace')
  assert.deepEqual(seen.mount, ['/devbox/api/session/create'])
  const forwarded = JSON.parse(createBodies(page, 'mount')[0].body)
  assert.equal(forwarded.payload.args.request.workspaceId, 'drh:remote-ws', 'the payload is not rewritten')
})
// --- the rpc carrier (desktop shell) must make the same decision -----------------------
// The shell publishes a decoded carrier, and the shim wraps rpc.call instead of fetch. The
// fetch-side rule alone would leave this path misrouting, so these cases pin it.

const rpcCreate = (page, payload) => page.built.rpc.call('/api', 'session/create', payload)

test('rpc carrier: a local workspace create is not sent to the mount', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true })
  await page.settle()
  const beforeMount = page.apiCalls('mount').length
  await rpcCreate(page, { args: { request: { workspaceId: 'local-ws', sessionId: REMOTE_SESSION } } })
  const mounted = page.apiCalls('mount').slice(beforeMount)
  assert.deepEqual(mounted, [], 'the mount must not receive a create for a local workspace')
  const seen = page.rpcCallsFor('session/create')
  assert.equal(seen.length, 1, 'the local carrier answers the create')
  assert.equal(seen[0].payload.args.request.workspaceId, 'local-ws')
  assert.equal(seen[0].payload.args.request.sessionId, REMOTE_SESSION)
})

test('rpc carrier: a real remote workspace create is sent to the mount as it is', async () => {
  const page = createPage({ config: { group: 'workspace' }, localItems: LOCAL_ITEMS, remoteItems: REMOTE_ITEMS, rpc: true })
  await page.settle()
  learnRemoteWorkspace(page)
  const beforeMount = page.apiCalls('mount').length
  await rpcCreate(page, { args: { request: { workspaceId: 'drh:remote-ws' } } })
  const mounted = page.apiCalls('mount').slice(beforeMount)
  assert.deepEqual(mounted, ['/devbox/api/session/create'], 'the mount owns this workspace, so it answers')
  assert.deepEqual(page.rpcCallsFor('session/create'), [], 'the local carrier is not asked')
  const forwarded = JSON.parse(createBodies(page, 'mount')[0].body)
  assert.equal(forwarded.payload.args.request.workspaceId, 'drh:remote-ws', 'the payload is not rewritten')
})
