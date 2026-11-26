/**
 * The remote block is DOM plus listeners plus a 15s tick, so its registration has to be
 * an effect: a plugin reload or unload must take all of it down. These cases drive apply()
 * against the page stub and assert what disposal actually removes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientPage } from './helpers/client-page.mjs'

/** The apply-world context: effects are collected, service reads answer empty. */
function createCtx() {
  const effects = []
  const disposers = []
  return {
    effects,
    disposers,
    ctx: {
      effect(factory) {
        effects.push(factory)
        const disposer = factory()
        disposers.push(typeof disposer === 'function' ? disposer : null)
        return () => {}
      },
      get: () => undefined,
      slots: { inject: () => () => {}, register: () => () => {} },
      connection: {},
      uiWorkspace: {},
      workspaces: {},
      remote: { $host: {} },
    },
  }
}

test('lifecycle: the block is an effect, and disposal removes its container, listeners and tick', () => {
  const page = createClientPage({ config: { remoteBlock: true } })
  const { ctx, effects, disposers } = createCtx()
  page.plugin.apply(ctx)
  assert.equal(effects.length, 1, 'the block is the only contribution while sections are off')
  assert.equal(typeof disposers[0], 'function', 'the effect hands back the block disposer')
  assert.equal(page.document.blockCount(), 1, 'the block mounted into the shipped sidebar slot')
  assert.equal(page.document.listenerCount('click'), 1)
  assert.equal(page.document.listenerCount('drh:state'), 1)
  assert.equal(page.document.listenerCount('drh:marks'), 1)
  assert.equal(page.document.listenerCount('drh:sessions'), 1)
  assert.equal(page.windowListenerCount('scroll'), 1)
  assert.deepEqual(page.intervalsStarted.map((entry) => entry.delay), [15000], 'the safety-net tick runs every 15s')
  disposers[0]()
  assert.equal(page.document.blockCount(), 0, 'the container leaves the document')
  assert.equal(page.document.listenerCount('click'), 0)
  assert.equal(page.document.listenerCount('drh:state'), 0)
  assert.equal(page.document.listenerCount('drh:marks'), 0)
  assert.equal(page.document.listenerCount('drh:sessions'), 0)
  assert.equal(page.windowListenerCount('scroll'), 0, 'the window listener is not left behind')
  assert.deepEqual(page.intervalsCleared, [1], 'the 15s tick is stopped')
})

test('lifecycle: unloading and loading again leaves one block and one listener set', () => {
  const page = createClientPage({ config: { remoteBlock: true } })
  const first = createCtx()
  page.plugin.apply(first.ctx)
  first.disposers[0]()
  const second = createCtx()
  page.plugin.apply(second.ctx)
  assert.equal(page.document.blockCount(), 1, 'a reload must not leave two blocks')
  assert.equal(page.document.listenerCount('click'), 1)
  assert.equal(page.document.listenerCount('drh:state'), 1)
  assert.equal(page.windowListenerCount('scroll'), 1)
})

test('lifecycle: no effect is registered when the block is off', () => {
  const page = createClientPage({ config: {} })
  const { ctx, effects } = createCtx()
  page.plugin.apply(ctx)
  assert.equal(effects.length, 0)
  assert.equal(page.document.blockCount(), 0)
})

test('lifecycle: a stale block left by an undisposed instance is swept on mount', () => {
  const page = createClientPage({ config: { remoteBlock: true } })
  const stale = page.document.createElement('div')
  stale.id = 'drh-remote-block'
  page.document.body.appendChild(stale)
  const { ctx } = createCtx()
  page.plugin.apply(ctx)
  assert.equal(page.document.blockCount(), 1, 'only the live instance owns the id')
  assert.equal(stale.parentNode, null, 'the stale node is detached')
})
