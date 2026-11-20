import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = Date.now()
const LOCAL = [{ sessionId: 'local-1', updatedAt: NOW, running: false }]
const REMOTE = [{ sessionId: 'worker-1', updatedAt: NOW, running: false, blank: true, cwd: '/home/x/proj' }]

test('publishRemoteSessions: a blank remote row keeps blank, running and cwd', async () => {
  const page = createPage({ config: { group: 'none' }, localItems: LOCAL, remoteItems: REMOTE })
  await page.settle()
  await page.built.fetch('api/session/list', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { args: {} } }),
  })
  const published = page.sandbox.__DSH_REMOTE_HOST_SESSIONS__ || []
  const row = published.find((entry) => entry.id === 'worker-1')
  assert.ok(row, 'the remote row is published')
  assert.equal(row.blank, true, 'a blank remote Session must stay blank after injection')
  assert.equal(row.running, false)
  assert.equal(row.cwd, '/home/x/proj')
})
