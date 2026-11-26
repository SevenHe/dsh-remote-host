/**
 * The block repaints by signature, and the connection status must not reach a structural one.
 *
 * A flapping mount republishes `connecting` and then `open` several times a second (the shim
 * publishes per leg attempt and per leg open). While the status took part in the signature and
 * in the header shape, each of those transitions rebuilt the whole block and re-created the
 * section header, so the label next to the dot was destroyed and re-created — a blinking
 * title. These cases pin the split: the status patches the dot alone.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientPage } from './helpers/client-page.mjs'

const page = createClientPage({ config: { remoteBlock: true } })

/** A refresh whose nothing changed: every signature matches what was painted last. */
function unchanged(overrides = {}) {
  return page.view.paintPlan({
    signature: 'list-a',
    previousSignature: 'list-a',
    stateSignature: 'state-a',
    previousState: 'state-a',
    headerNow: 'false|devbox',
    previousHeader: 'false|devbox',
    status: 'open',
    previousStatus: 'open',
    htmlEmpty: false,
    ...overrides,
  })
}

test('paint plan: an unchanged refresh touches nothing', () => {
  assert.deepEqual(unchanged(), { structural: false, header: false, state: false, dot: false })
})

test('paint plan: a connection flap patches only the dot', () => {
  // The two transitions one mux reconnect produces: connecting, then open.
  assert.deepEqual(unchanged({ status: 'connecting' }), { structural: false, header: false, state: false, dot: true })
  assert.deepEqual(unchanged({ status: 'open', previousStatus: 'connecting' }), {
    structural: false, header: false, state: false, dot: true,
  })
})

test('paint plan: a failed and a recovered leg also stay off the structural path', () => {
  // Every transition, including the recovery back to open: the painted state is the
  // previous one, so each case really is a change.
  for (const status of ['error', 'connecting', 'open']) {
    const plan = unchanged({ status, previousStatus: status === 'open' ? 'connecting' : 'open' })
    assert.equal(plan.structural, false, 'status ' + status + ' must not rebuild the block')
    assert.equal(plan.header, false, 'status ' + status + ' must not re-create the header')
    assert.equal(plan.dot, true, 'status ' + status + ' must reach the dot')
  }
})

test('paint plan: the search toggle still re-creates the header', () => {
  const plan = unchanged({ headerNow: 'true|devbox' })
  assert.equal(plan.header, true)
  assert.equal(plan.structural, true, 'the header is built with the markup, so it rides a structural paint')
})

test('paint plan: a label change re-creates the header', () => {
  assert.equal(unchanged({ headerNow: 'false|other-host' }).header, true)
})

test('paint plan: list and row changes keep the header', () => {
  const order = unchanged({ signature: 'list-b' })
  assert.deepEqual(order, { structural: true, header: false, state: false, dot: false })
  const rows = unchanged({ stateSignature: 'state-b' })
  assert.deepEqual(rows, { structural: false, header: false, state: true, dot: false })
})

test('paint plan: an empty baseline forces a full paint', () => {
  const plan = unchanged({ htmlEmpty: true })
  assert.equal(plan.structural, true, 'a fresh or re-attached container has nothing to patch into')
  assert.equal(plan.header, false, 'a forced paint is structural, not a header rebuild')
})

test('paint plan: a dot change is not a structural change even with row state moving', () => {
  const plan = unchanged({ stateSignature: 'state-b', status: 'connecting' })
  assert.equal(plan.structural, false)
  assert.equal(plan.state, true)
  assert.equal(plan.dot, true)
})
