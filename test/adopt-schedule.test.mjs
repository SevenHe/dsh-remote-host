/**
 * The boot-time carrier adoption schedule.
 *
 * The shim ships before the desktop shell's carrier in some boots, so it watches for
 * one on a few beats. That watch used to run a fixed 80-beat schedule (9 x 25ms then
 * 70 x 100ms, about 7.2s of ticks) even after the carrier was already installed: the
 * first attempt settled, and the remaining 79 timers still fired doing nothing.
 *
 * These tests pin the bounded replacement: a carrier present at boot schedules no
 * watch at all, a page without one backs off from 100ms to 250ms, and the first
 * successful adoption stops the schedule.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPage } from './helpers/page.mjs'

/** Largest delay the adoption watch itself may schedule. */
const ADOPT_CEILING_MS = 250

/** Drain the page's timer queue, returning every delay it scheduled. */
async function drainTimers (page) {
  const seen = []
  for (let round = 0; round < 200; round += 1) {
    const pending = page.timerDelays()
    if (pending.length === 0) return seen
    seen.push(...pending)
    page.fireTimers()
    await page.settle(1)
  }
  throw new Error('the timer queue did not drain')
}

test('a carrier present at boot schedules no adoption watch', async () => {
  const page = createPage({ config: { remoteBlock: true } })
  await page.settle(2)
  const delays = await drainTimers(page)
  const watch = delays.filter((delay) => delay <= ADOPT_CEILING_MS)
  assert.deepEqual(watch, [], 'a carrier already installed must not start the busy watch')
})

test('a missing carrier backs off from 100ms to 250ms within the caps', async () => {
  const page = createPage({ config: { remoteBlock: true }, carrier: false })
  await page.settle(2)
  const delays = await drainTimers(page)
  const watch = delays.filter((delay) => delay <= ADOPT_CEILING_MS)
  const expected = [100, 125, 150, 175, 200, 225, ...Array(17).fill(250)]
  assert.deepEqual(watch, expected, 'the watch must back off from 100ms and then hold 250ms')
  assert.ok(watch.length <= 24, 'the watch must stay within the attempt cap, got ' + watch.length)
  const total = watch.reduce((sum, delay) => sum + delay, 0)
  assert.ok(total <= 6000, 'the watch must stay within the elapsed cap, got ' + total + 'ms')
})

test('adoption stops the watch as soon as the shell publishes its carrier', async () => {
  const page = createPage({ config: { remoteBlock: true }, carrier: false })
  await page.settle(2)
  // First beat: nothing published yet, so the watch schedules its first re-check.
  // The page also carries install-time timers of its own; only the watch is under test.
  const first = page.timerDelays().filter((delay) => delay <= ADOPT_CEILING_MS)
  assert.deepEqual(first, [100], 'the first re-check waits 100ms')
  page.fireTimers()
  await page.settle(1)
  // The shell publishes after the first beat; the next attempt must adopt and stop.
  page.sandbox.__DSH_TRANSPORT__ = { fetch: page.sandbox.fetch, createWebSocket: () => ({}) }
  page.fireTimers()
  await page.settle(2)
  assert.equal(page.sandbox.__DSH_TRANSPORT__.__dshRemoteHost, true, 'the late carrier must be wrapped')
  const after = page.timerDelays().filter((delay) => delay <= ADOPT_CEILING_MS)
  assert.deepEqual(after, [], 'a successful adoption must schedule no further beat')
})
