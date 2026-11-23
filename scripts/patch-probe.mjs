#!/usr/bin/env node
/**
 * Patch-path probe: prove that a state-only refresh patches the rows in place, that a
 * structural change still rebuilds them, and that the row interactions still work — with real
 * mouse and keyboard input on a mounted block.
 *
 * Usage: node scripts/patch-probe.mjs [--cdp 9222] [--url 19961]
 *
 * Run it against a lab (scripts/lab-block.sh) with Chrome attached over CDP. The probe injects
 * its own remote snapshot by locking the three published globals, so it needs no reachable
 * host: the render path under test is the production one (globals -> event -> repaint).
 *
 * Two evidence channels per case:
 *   - node identity (the row element the probe tagged before the change);
 *   - childList mutations split by level: container-level means the list was rewritten,
 *     nested means a node was patched in place. The container-level count is the discriminator,
 *     because a patch also produces a nested mutation (the state dot is a child of the row).
 */
const options = { cdp: 9222, url: "" }

function fail (message) {
  console.error("PATCH-PROBE FAIL: " + message)
  process.exit(1)
}

class Cdp {
  constructor (socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener("message", (event) => {
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      if (frame.id === undefined) return
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) entry.reject(new Error(entry.method + ": " + JSON.stringify(frame.error)))
      else entry.resolve(frame.result)
    })
  }

  send (method, params) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
    })
  }

  async evaluate (expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails !== undefined) {
      const exception = result.exceptionDetails.exception
      throw new Error("evaluate failed: " + String(exception === undefined ? result.exceptionDetails.text : exception.description))
    }
    return result.result.value
  }

  async click (x, y) {
    const point = { x, y, button: "left", clickCount: 1 }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
    await this.send("Input.dispatchMouseEvent", Object.assign({ type: "mousePressed" }, point))
    await this.send("Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased" }, point))
  }

  async escape () {
    const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyDown" }, key))
    await this.send("Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, key))
  }
}

async function connect () {
  const response = await fetch("http://127.0.0.1:" + options.cdp + "/json/list")
  const targets = await response.json()
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string")
  if (pages.length === 0) fail("no page target on CDP " + options.cdp)
  const page = options.url.length > 0 ? pages.find((t) => t.url.indexOf(options.url) !== -1) : pages[0]
  if (page === undefined) fail("no page target matching " + options.url)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve)
    socket.addEventListener("error", () => reject(new Error("cdp socket error")))
  })
  return new Cdp(socket)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor (cdp, expression, label, timeoutMs) {
  const started = Date.now()
  for (;;) {
    if (await cdp.evaluate(expression)) return
    if (Date.now() - started > timeoutMs) fail("timed out waiting for " + label)
    await sleep(250)
  }
}

const HARNESS = `
(() => {
  if (window.__probe !== undefined) return true
  const now = Date.now()
  const state = { ids: ['p-a', 'p-b', 'p-c'], label: 'probe', workspaces: [{ id: 'ws1', title: 'probe-ws', sessionIds: ['p-a', 'p-b', 'p-c'] }] }
  const marks = { pinned: [], archived: [] }
  const sessions = [
    { id: 'p-a', title: 'Alpha', updatedAt: now - 1000, running: false },
    { id: 'p-b', title: 'Bravo', updatedAt: now - 60000, running: false },
    { id: 'p-c', title: 'Charlie', updatedAt: now - 600000, running: false },
  ]
  Object.defineProperty(window, '__DSH_REMOTE_HOST_STATE__', { configurable: true, get: () => state, set: () => {} })
  Object.defineProperty(window, '__DSH_REMOTE_HOST_SESSIONS__', { configurable: true, get: () => sessions, set: () => {} })
  Object.defineProperty(window, '__DSH_REMOTE_HOST_MARKS__', { configurable: true, get: () => marks, set: () => {} })
  window.__probe = {
    state, marks, sessions,
    fire (kind) { document.dispatchEvent(new CustomEvent('drh:' + kind, { detail: {} })) },
    seed () { this.fire('state'); this.fire('sessions'); this.fire('marks') },
    observe () {
      const container = document.querySelector('#drh-remote-block')
      this.container = container
      this.log = { direct: 0, nested: 0, directDetail: [] }
      this.mo = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type !== 'childList') continue
          if (record.target === this.container) {
            this.log.direct += 1
            const added = Array.from(record.addedNodes).map((n) => n.className || n.tagName)
            const removed = Array.from(record.removedNodes).map((n) => n.className || n.tagName)
            this.log.directDetail.push({ added, removed })
          } else this.log.nested += 1
        }
      })
      this.mo.observe(container, { childList: true, subtree: true })
      return true
    },
    reset () {
      // Drain what is already queued, or the previous action's records land in this window.
      if (this.mo !== undefined) this.mo.takeRecords()
      this.log = { direct: 0, nested: 0, directDetail: [] }
      return true
    },
    async settle () {
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (this.mo !== undefined) { this.mo.takeRecords(); this.mo.observe(this.container, { childList: true, subtree: true }) }
      const diag = window.__DRH_DIAG2__
      return { mutations: { direct: this.log.direct, nested: this.log.nested, detail: this.log.directDetail }, written: diag === undefined ? null : diag.written, rows: diag === undefined ? null : diag.rows }
    },
    refs () {
      this.nodes = {}
      for (const id of ['p-a', 'p-b', 'p-c']) {
        const node = document.querySelector('#drh-remote-block [data-drh-session="' + id + '"]')
        if (node !== null) this.nodes[id] = node
      }
      this.groupNode = document.querySelector('#drh-remote-block [data-drh-group="w:ws1"]')
      return Object.keys(this.nodes).length
    },
    row (id) {
      const node = document.querySelector('#drh-remote-block [data-drh-session="' + id + '"]')
      if (node === null) return { missing: true }
      const dot = node.querySelector('.drh-stateDot')
      const arc = dot === null ? null : dot.querySelector('circle.drh-stateDotArc')
      const pin = node.querySelector('[data-drh-rowpin]')
      const use = pin === null ? null : pin.querySelector('use')
      return {
        same: this.nodes === undefined || this.nodes[id] === undefined ? null : this.nodes[id] === node,
        hasDot: dot !== null,
        dotR: arc === null ? null : arc.getAttribute('r'),
        title: node.querySelector('.drh-title').textContent,
        time: node.querySelector('.drh-timestamp').textContent,
        menuOpen: node.classList.contains('menuOpen'),
        pinLabel: pin === null ? null : pin.getAttribute('aria-label'),
        pinHref: use === null ? null : (use.getAttribute('href') || use.getAttribute('xlink:href')),
        actionCount: node.querySelectorAll('.drh-rowAction').length,
      }
    },
    order () {
      return Array.from(document.querySelectorAll('#drh-remote-block [data-drh-session]')).map((node) => node.getAttribute('data-drh-session'))
    },
    group () {
      const node = document.querySelector('#drh-remote-block [data-drh-group="w:ws1"]')
      if (node === null) return { missing: true }
      return { same: this.groupNode === undefined ? null : this.groupNode === node, menuOpen: node.classList.contains('menuOpen'), title: node.querySelector('.drh-title').textContent }
    },
    actionsVisible (id) {
      const node = document.querySelector('#drh-remote-block [data-drh-session="' + id + '"]')
      if (node === null) return null
      const box = node.querySelector('.drh-rowActions')
      if (box === null) return null
      const style = getComputedStyle(box)
      return { display: style.display, opacity: style.opacity, width: Math.round(box.getBoundingClientRect().width) }
    },
    center (selector) {
      const node = document.querySelector(selector)
      if (node === null) return null
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: Math.round(rect.width), right: Math.round(rect.right) }
    },
    setTitle (id, title) { this.sessions.find((s) => s.id === id).title = title; this.fire('sessions'); return true },
    setRunning (id, running) { this.sessions.find((s) => s.id === id).running = running; this.fire('sessions'); return true },
    setUpdated (id, at) { this.sessions.find((s) => s.id === id).updatedAt = at; this.fire('sessions'); return true },
    setPinned (ids) { this.marks.pinned = ids; this.fire('marks'); return true },
  }
  return true
})()
`;

const checks = []
function check (name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log((ok ? "  ok   " : "  FAIL ") + name + "  " + JSON.stringify(detail))
}

async function measure (cdp) {
  return cdp.evaluate("window.__probe.settle()")
}

async function main () {
  const cdp = await connect()
  await cdp.send("Runtime.enable")
  await waitFor(cdp, "document.readyState === 'complete'", "page load", 30000)
  // A first-boot modal covers the window and swallows pointer input: dismiss it for real.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const blocker = await cdp.evaluate("(() => { const mask = document.querySelector('[class*=_mask_]'); if (mask === null) return null; const button = document.querySelector('[class*=_dialog_] button, [class*=_dialog_] [role=button]'); if (button === null) return { blocked: true }; const rect = button.getBoundingClientRect(); return { blocked: false, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } })()")
    if (blocker === null) break
    if (blocker.blocked === true) fail("a modal mask covers the page and offers no button")
    await cdp.click(blocker.x, blocker.y)
    await sleep(300)
  }
  await waitFor(cdp, "document.querySelector('#drh-remote-block') !== null", "the block to mount", 30000)
  await cdp.evaluate("try { window.__DSH_REMOTE_HOST_STOP_POLL__() } catch (error) {}; true")
  await cdp.evaluate(HARNESS)
  await cdp.evaluate("window.__probe.seed(); window.__probe.observe(); true")
  await sleep(300)

  // Structural baseline: expand the only group with a real click.
  let center = await cdp.evaluate("window.__probe.center('#drh-remote-block [data-drh-group=\"w:ws1\"]')")
  if (center === null) fail("no group row to expand")
  await cdp.click(center.x, center.y)
  await waitFor(cdp, "document.querySelectorAll('#drh-remote-block [data-drh-session]').length === 3", "three rows", 10000)
  await sleep(200)
  if ((await cdp.evaluate("window.__probe.refs()")) !== 3) fail("could not tag the three rows")
  check("baseline: three rows after expanding the group", true, { order: await cdp.evaluate("window.__probe.order()") })

  // 1. hover reveals the shipped three-button cluster
  const rowCenter = await cdp.evaluate("window.__probe.center('#drh-remote-block [data-drh-session=\"p-b\"]')")
  const before = await cdp.evaluate("window.__probe.actionsVisible('p-b')")
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowCenter.x, y: rowCenter.y, button: "none" })
  await sleep(300)
  const after = await cdp.evaluate("window.__probe.actionsVisible('p-b')")
  const actionCount = (await cdp.evaluate("window.__probe.row('p-b')")).actionCount
  check("hover reveals the 3 row actions", before.display === "none" && after.display !== "none" && after.width > 0 && actionCount === 3, { before, after, actionCount })

  // 2. running state changes the spinner only: patch in place
  await cdp.evaluate("window.__probe.reset(); window.__probe.setRunning('p-a', true); true")
  const added = await measure(cdp)
  const addedRow = await cdp.evaluate("window.__probe.row('p-a')")
  check("running -> spinner added in place", addedRow.same === true && addedRow.hasDot === true && added.written === false && added.mutations.direct === 0, { same: addedRow.same, hasDot: addedRow.hasDot, dotR: addedRow.dotR, written: added.written, mutations: added.mutations.direct, nested: added.mutations.nested })

  await cdp.evaluate("window.__probe.reset(); window.__probe.setRunning('p-a', false); true")
  const removed = await measure(cdp)
  const removedRow = await cdp.evaluate("window.__probe.row('p-a')")
  check("idle -> spinner removed in place", removedRow.same === true && removedRow.hasDot === false && removed.written === false && removed.mutations.direct === 0, { same: removedRow.same, hasDot: removedRow.hasDot, written: removed.written, mutations: removed.mutations.direct })

  // 3. title text only: patch in place, node identity kept
  await cdp.evaluate("window.__probe.reset(); window.__probe.setTitle('p-b', 'Bravo renamed'); true")
  const titled = await measure(cdp)
  const titledRow = await cdp.evaluate("window.__probe.row('p-b')")
  check("title text patched in place", titledRow.same === true && titledRow.title === "Bravo renamed" && titled.written === false && titled.mutations.direct === 0, { same: titledRow.same, title: titledRow.title, written: titled.written, mutations: titled.mutations.direct })

  // 4. row menu: open and close patch the class, and the surface is end-anchored
  const rowMenuButton = await cdp.evaluate("window.__probe.center('#drh-remote-block [data-drh-session=\"p-b\"] [data-drh-rowmenu]')")
  await cdp.evaluate("window.__probe.reset(); true")
  await cdp.click(rowMenuButton.x, rowMenuButton.y)
  await sleep(250)
  const openRow = await cdp.evaluate("window.__probe.row('p-b')")
  const surface = await cdp.evaluate("(() => { const m = document.getElementById('drh-block-menu'); if (m === null) return null; const r = m.getBoundingClientRect(); return { right: Math.round(r.right), width: Math.round(r.width), radius: getComputedStyle(m).borderTopLeftRadius } })()")
  const openMut = await measure(cdp)
  await cdp.escape()
  await sleep(250)
  const closedRow = await cdp.evaluate("window.__probe.row('p-b')")
  const closedMut = await measure(cdp)
  check("row menu opens and closes in place", openRow.menuOpen === true && closedRow.menuOpen === false && closedRow.same === true && openMut.mutations.direct === 0 && closedMut.mutations.direct === 0, { open: openRow.menuOpen, closed: closedRow.menuOpen, same: closedRow.same, anchor: { surfaceRight: surface === null ? null : surface.right, triggerRight: rowMenuButton.right }, openDirect: openMut.mutations.direct, closeDirect: closedMut.mutations.direct })

  // 5. GROUP menu: the group row's own open class must follow too (a state-only change)
  const groupMenuButton = await cdp.evaluate("window.__probe.center('#drh-remote-block [data-drh-group=\"w:ws1\"] [data-drh-groupmenu]')")
  await cdp.evaluate("window.__probe.reset(); true")
  await cdp.click(groupMenuButton.x, groupMenuButton.y)
  await sleep(250)
  const openGroup = await cdp.evaluate("window.__probe.group()")
  const groupOpenMut = await measure(cdp)
  await cdp.escape()
  await sleep(250)
  const closedGroup = await cdp.evaluate("window.__probe.group()")
  const groupClosedMut = await measure(cdp)
  check("group menu open class patched in place", openGroup.menuOpen === true && closedGroup.menuOpen === false && groupOpenMut.mutations.direct === 0 && groupClosedMut.mutations.direct === 0, { open: openGroup.menuOpen, closed: closedGroup.menuOpen, openDirect: groupOpenMut.mutations.direct, closeDirect: groupClosedMut.mutations.direct })

  // 6. pin the row that is already first: the glyph is patched, the order does not move
  await cdp.evaluate("window.__probe.reset(); window.__probe.setPinned(['p-a']); true")
  const pinned = await measure(cdp)
  const pinnedRow = await cdp.evaluate("window.__probe.row('p-a')")
  check("pin glyph patched in place", pinnedRow.same === true && pinnedRow.pinLabel === "取消置顶" && String(pinnedRow.pinHref).indexOf("pin-fill") !== -1 && pinned.written === false && pinned.mutations.direct === 0, { same: pinnedRow.same, pinLabel: pinnedRow.pinLabel, pinHref: pinnedRow.pinHref, written: pinned.written, mutations: pinned.mutations.direct, order: await cdp.evaluate("window.__probe.order()") })
  await cdp.evaluate("window.__probe.reset(); window.__probe.setPinned([]); true")
  await measure(cdp)

  // 7. manual order keeps the position: a time change is a pure text patch
  const viewButton = await cdp.evaluate("window.__probe.center('#drh-remote-block [data-drh-viewmenu]')")
  await cdp.click(viewButton.x, viewButton.y)
  await sleep(250)
  const manualItem = await cdp.evaluate("window.__probe.center('#drh-block-menu [data-drh-menu=\"order:manual\"]')")
  if (manualItem === null) fail("no manual-order item in the view menu")
  await cdp.click(manualItem.x, manualItem.y)
  await sleep(300)
  await cdp.evaluate("window.__probe.refs(); window.__probe.reset(); true")
  const orderBefore = await cdp.evaluate("window.__probe.order()")
  await cdp.evaluate("window.__probe.setUpdated('p-c', Date.now() - 120000); true")
  const timeOnly = await measure(cdp)
  const timeRow = await cdp.evaluate("window.__probe.row('p-c')")
  const orderAfter = await cdp.evaluate("window.__probe.order()")
  check("manual order: time text patched in place", JSON.stringify(orderBefore) === JSON.stringify(orderAfter) && timeRow.same === true && timeOnly.written === false && timeOnly.mutations.direct === 0, { before: orderBefore, after: orderAfter, same: timeRow.same, time: timeRow.time, written: timeOnly.written, mutations: timeOnly.mutations.direct })

  // 8. order change must rebuild, not patch
  await cdp.evaluate("window.__probe.refs(); window.__probe.reset(); window.__probe.setUpdated('p-c', Date.now() + 5000); true")
  const reordered = await measure(cdp)
  const reorderedRow = await cdp.evaluate("window.__probe.row('p-c')")
  const finalOrder = await cdp.evaluate("window.__probe.order()")
  check("order change rebuilds the list", reordered.written === true && reorderedRow.same === false && finalOrder[0] === "p-c" && reordered.mutations.direct > 0, { order: finalOrder, same: reorderedRow.same, written: reordered.written, mutations: reordered.mutations.direct })

  const failed = checks.filter((entry) => entry.ok !== true)
  console.log("PATCH-PROBE RESULT " + JSON.stringify({ total: checks.length, passed: checks.length - failed.length, failed: failed.map((entry) => entry.name) }))
  if (failed.length > 0) fail(failed.length + " check(s) failed")
}

main().then(() => process.exit(0), (error) => fail(String(error && error.stack ? error.stack : error)))
