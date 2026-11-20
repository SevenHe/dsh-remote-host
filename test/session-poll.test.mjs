import test from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

const NOW = 1_700_000_000_000
const REMOTE = [{ sessionId: 'worker-1', updatedAt: NOW, running: false }]

test('polling: the shim exposes a refresh and a stop entry', async () => {
  const page = createPage({ config: { group: 'single' }, localItems: [], remoteItems: REMOTE })
  await page.settle()
  assert.equal(typeof page.sandbox.__DSH_REMOTE_HOST_POLL_NOW__, 'function', 'a tick can be driven by hand')
  assert.equal(typeof page.sandbox.__DSH_REMOTE_HOST_STOP_POLL__, 'function', 'the interval can be stopped')
  page.dispose()
  assert.equal(page.sandbox.__DSH_REMOTE_HOST_STOP_POLL__(), undefined, 'stopping twice is harmless')
})

test('polling: an unchanged snapshot is not announced twice', async () => {
  const page = createPage({ config: { group: 'single' }, localItems: [], remoteItems: REMOTE })
  await page.settle()
  const doc = page.sandbox.document
  const realDispatch = doc.dispatchEvent
  let announced = 0
  doc.dispatchEvent = function (event) {
    if (event !== null && event !== undefined && String(event.type) === 'drh:sessions') announced += 1
    return realDispatch === undefined ? true : realDispatch.call(doc, event)
  }
  assert.equal(typeof page.sandbox.__DSH_REMOTE_HOST_POLL_NOW__, 'function')
  page.sandbox.__DSH_REMOTE_HOST_POLL_NOW__()
  await page.settle()
  const afterFirst = announced
  page.sandbox.__DSH_REMOTE_HOST_POLL_NOW__()
  await page.settle()
  assert.equal(afterFirst > 0, true, 'the first refresh publishes the snapshot')
  assert.equal(announced, afterFirst, 'an unchanged snapshot does not announce again')
  page.dispose()
})
