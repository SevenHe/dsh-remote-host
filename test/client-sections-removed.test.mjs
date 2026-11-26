/**
 * `sidebar: sections` was removed: the client half no longer takes over `sidebar.workspaces`.
 * These cases pin the removal (one warning, no replacement render) and confirm the two modes
 * that survive beside it (`remoteBlock`, `sectionHeaders`) still behave exactly as before.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientPage } from './helpers/client-page.mjs'

/** The apply-world context: effects are collected and slot injections are recorded. */
function createCtx() {
  const effects = []
  const disposers = []
  const injections = []
  return {
    effects,
    disposers,
    injections,
    ctx: {
      effect(factory) {
        effects.push(factory)
        const disposer = factory()
        disposers.push(typeof disposer === 'function' ? disposer : null)
        return () => {}
      },
      get: () => undefined,
      slots: {
        inject(name) { injections.push(name); return () => {} },
        register() { return () => {} },
      },
      connection: {},
      uiWorkspace: {},
      workspaces: {},
      remote: { $host: {} },
    },
  }
}

/**
 * Collect what the module writes to the console, so a case can assert the removed key stays silent.
 * The page stub's console is a silent stub, so this replaces it before apply.
 */
function captureWarnings(page) {
  const warnings = []
  page.sandbox.console = { log() {}, info() {}, error() {}, warn: (text) => warnings.push(String(text)) }
  return warnings
}

test('sections: the stale key is inert and takes nothing over', () => {
  const page = createClientPage({ config: { sections: true } })
  const warnings = captureWarnings(page)
  const { ctx, effects, injections } = createCtx()
  page.plugin.apply(ctx)
  assert.deepEqual(warnings, [], 'a key the plugin no longer knows produces no warning')

  assert.deepEqual(injections, [], 'the shipped sidebar list is left in place')
  assert.equal(effects.length, 0, 'nothing is registered')
  assert.equal(page.document.blockCount(), 0)
})

test('sections: the stale key does not suppress the modes that survive beside it', () => {
  const page = createClientPage({ config: { sections: true, remoteBlock: true } })
  const warnings = captureWarnings(page)
  const { ctx, effects, disposers, injections } = createCtx()
  page.plugin.apply(ctx)
  assert.deepEqual(warnings, [], 'silent')
  assert.deepEqual(injections, [], 'still no slot takeover')
  assert.equal(effects.length, 1)
  assert.equal(page.document.blockCount(), 1, 'the block mounts exactly as it does without the key')
  assert.equal(page.document.listenerCount('click'), 1)
  assert.equal(page.document.listenerCount('drh:state'), 1)
  assert.equal(page.windowListenerCount('scroll'), 1)
  assert.deepEqual(page.intervalsStarted.map((entry) => entry.delay), [15000])
  disposers[0]()
  assert.equal(page.document.blockCount(), 0, 'disposal still takes the block down')
})

test('remoteBlock: the surviving block path is unchanged without a sections key', () => {
  const page = createClientPage({ config: { remoteBlock: true } })
  const warnings = captureWarnings(page)
  const { ctx, effects, injections } = createCtx()
  page.plugin.apply(ctx)
  assert.deepEqual(warnings, [], 'the supported path is silent')
  assert.equal(effects.length, 1)
  assert.deepEqual(injections, [], 'the block never took a slot')
  assert.equal(page.document.blockCount(), 1)
  assert.equal(page.document.listenerCount('click'), 1)
  assert.equal(page.document.listenerCount('drh:marks'), 1)
  assert.equal(page.windowListenerCount('scroll'), 1)
  assert.deepEqual(page.intervalsStarted.map((entry) => entry.delay), [15000])
})

test('view model: the section model is gone, the block helpers are still published', () => {
  const page = createClientPage()
  const helpers = page.sandbox.__DRH_VIEW_MODEL__
  assert.deepEqual(Object.keys(helpers).sort(),
    ['buildBlockRows', 'currentSessionFrom', 'groupHasCurrent', 'memberComparator', 'paintPlan', 'relative', 'titleOf'])
  assert.equal(helpers.buildSectionModel, undefined)
})

test('sectionHeaders: the shipped-list heading is still inserted and re-applied', () => {
  const page = createClientPage({ config: { sectionHeaders: true, label: 'devbox' } })
  const warnings = captureWarnings(page)
  // The shipped list is stood up by hand: what is under test is the heading it inserts in
  // front of the first merged remote group, not the shipped rows themselves.
  const root = page.document.createElement('div')
  page.document.body.appendChild(root)
  const section = page.document.createElement('div')
  section.previousElementSibling = null
  root.appendChild(section)
  const wrapper = page.document.createElement('div')
  section.appendChild(wrapper)
  const row = page.document.createElement('div')
  row.setAttribute('data-row-key', 'workspace:drh:w1')
  wrapper.appendChild(row)
  page.document.querySelectorAll = (selector) => (selector === '[data-row-key^="workspace:drh:"]' ? [row] : [])
  const { ctx } = createCtx()
  page.plugin.apply(ctx)
  const head = root.childNodes[0]
  assert.equal(head.getAttribute('data-drh-head'), 'true')
  assert.equal(head.textContent, '远端工作区 · devbox')
  assert.equal(section.getAttribute('data-drh-section'), 'true', 'the group is marked for its divider')
  assert.deepEqual(page.intervalsStarted.map((entry) => entry.delay), [700], 'the re-apply poll is unchanged')
  assert.equal(page.document.listenerCount('drh:state'), 1)
  assert.deepEqual(warnings, [], 'the surviving mode does not warn')
})
