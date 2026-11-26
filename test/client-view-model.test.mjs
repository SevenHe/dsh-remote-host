/**
 * The remote block's rows are pure functions of the published page state, so they are
 * pinned here without a DOM: grouping, the search filter, the archived filter, the
 * ordering modes and the empty-set fallbacks.
 *
 * The helpers come from the shipped lib/client.js (loaded through the vm helper), so a
 * regression in the real file fails these tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NOW, createClientPage, summary } from './helpers/client-page.mjs'

/** The block's view state, as the live wrapper fills it. */
const BLOCK_STATE = {
  published: new Map(),
  archived: new Set(),
  created: [],
  query: '',
  filter: 'hide',
  orderBy: 'updated',
  order: [],
  now: NOW,
}

const rowsOf = (page, overrides = {}) => page.view.buildBlockRows({ ...BLOCK_STATE, ...overrides })
const idsOf = (list) => list.map((entry) => entry.id)
const sessionIdsOf = (list) => list.map((entry) => entry.sessionId)
const keysOf = (groups) => groups.map((group) => group.key)

test('block rows: sessions group by workspace, newest first inside the group', () => {
  const page = createClientPage()
  const published = new Map([
    ['s1', summary('s1', 'Alpha', NOW - 60_000)],
    ['s2', summary('s2', 'Beta', NOW - 5 * 60_000)],
  ])
  const rows = rowsOf(page, {
    workspaces: [{ id: 'w1', title: 'one', sessionIds: ['s1', 's2'] }],
    published,
  })
  assert.deepEqual(keysOf(rows), ['w:w1'])
  assert.deepEqual(idsOf(rows[0].members), ['s1', 's2'], 'the more recent Session leads')
  assert.deepEqual(rows[0].members.map((member) => member.time), ['1分钟', '5分钟'], 'ages resolve against the injected clock')
})

test('block rows: a group with no sessions still renders, and a locally created workspace is appended once', () => {
  const page = createClientPage()
  const rows = rowsOf(page, {
    workspaces: [{ id: 'w1', title: 'one', sessionIds: [] }],
    created: [{ id: '', title: '新目录', key: 'w:新目录' }],
  })
  assert.deepEqual(keysOf(rows), ['w:w1', 'w:新目录'])
  assert.deepEqual(rows[0].members, [], 'an empty workspace is still a row')
  assert.deepEqual(rows[1].members, [], 'the pending workspace has no rows yet')
  // Once the host lists it, the local placeholder must not appear twice.
  const publishedNow = rowsOf(page, {
    workspaces: [{ id: 'w9', title: 'fresh', sessionIds: [] }],
    created: [{ id: 'w9', title: 'fresh', key: 'w:w9' }],
  })
  assert.deepEqual(keysOf(publishedNow), ['w:w9'])
})

test('block rows: the search filters titles (trimmed, case-insensitive) and drops groups left empty', () => {
  const page = createClientPage()
  const published = new Map([
    ['s1', summary('s1', 'Alpha', NOW)],
    ['s2', summary('s2', 'Beta', NOW)],
  ])
  const workspaces = [
    { id: 'w1', title: 'one', sessionIds: ['s1'] },
    { id: 'w2', title: 'two', sessionIds: ['s2'] },
  ]
  const hit = rowsOf(page, { workspaces, published, query: '  ALP ' })
  assert.deepEqual(keysOf(hit), ['w:w1'])
  assert.deepEqual(idsOf(hit[0].members), ['s1'])
  const miss = rowsOf(page, { workspaces, published, query: 'nothing-matches-this' })
  assert.deepEqual(miss, [], 'no group survives a query that matches no title')
  // A Session with no published summary is matched by its id, which is what the row shows.
  const unpublished = rowsOf(page, {
    workspaces: [{ id: 'w3', title: 'three', sessionIds: ['ghost-id'] }],
    query: 'ghost',
  })
  assert.deepEqual(unpublished[0].members.map((member) => member.title), ['ghost-id'])
})

test('block rows: the archived filter hides, mixes in, or keeps only archived sessions', () => {
  const page = createClientPage()
  const published = new Map([
    ['s1', summary('s1', 'Alpha', NOW)],
    ['s2', summary('s2', 'Beta', NOW)],
  ])
  const workspaces = [{ id: 'w1', title: 'one', sessionIds: ['s1', 's2'] }]
  const archived = new Set(['s2'])
  assert.deepEqual(idsOf(rowsOf(page, { workspaces, published, archived })[0].members), ['s1'])
  assert.deepEqual(idsOf(rowsOf(page, { workspaces, published, archived, filter: 'all' })[0].members), ['s1', 's2'])
  assert.deepEqual(idsOf(rowsOf(page, { workspaces, published, archived, filter: 'only' })[0].members), ['s2'])
})

test('block rows: manual order follows the dragged keys and appends unknown groups', () => {
  const page = createClientPage()
  const workspaces = [
    { id: 'a', title: 'A', sessionIds: [] },
    { id: 'b', title: 'B', sessionIds: [] },
    { id: 'c', title: 'C', sessionIds: [] },
  ]
  const rows = rowsOf(page, { workspaces, orderBy: 'manual', order: ['w:c', 'w:a'] })
  assert.deepEqual(keysOf(rows), ['w:c', 'w:a', 'w:b'], 'a group the user never dragged keeps its list order last')
})

test('block rows: no published layout yields no rows', () => {
  const page = createClientPage()
  assert.deepEqual(rowsOf(page, { workspaces: [] }), [])
  assert.deepEqual(rowsOf(page, { workspaces: undefined }), [])
  assert.deepEqual(rowsOf(page, { workspaces: [], created: [] }), [], 'a created workspace is not invented without one')
})

test('member order: pinned sessions lead and the list order is otherwise kept', () => {
  const page = createClientPage()
  const members = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
  const ordered = members.slice().sort(page.view.memberComparator(new Set(['s3'])))
  assert.deepEqual(idsOf(ordered), ['s3', 's1', 's2'])
  assert.deepEqual(idsOf(members), ['s1', 's2', 's3'], 'the comparator does not reorder the source list')
})

test('title: projected title, else the working directory name, else a placeholder', () => {
  const page = createClientPage()
  assert.equal(page.view.titleOf({ projections: { values: { title: 'Named' } }, cwd: '/home/me/project' }), 'Named')
  assert.equal(page.view.titleOf({ cwd: '/home/me/project' }), 'project')
  assert.equal(page.view.titleOf({}), '未命名')
})

test('relative time: resolves against an explicit clock', () => {
  const page = createClientPage()
  assert.equal(page.view.relative(NOW - 1_000, NOW), '刚刚')
  assert.equal(page.view.relative(NOW - 2 * 60_000, NOW), '2分钟')
  assert.equal(page.view.relative(NOW - 3 * 3_600_000, NOW), '3小时')
  assert.equal(page.view.relative(undefined, NOW), '')
})
