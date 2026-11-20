#!/usr/bin/env node
/**
 * parity-snapshot.mjs - collect every UI-parity metric from a running lab in one JSON.
 *
 * Keys mirror docs/ui-parity.md section 4 so the output can be diffed against the
 * checked-in baseline table. Measurements use the real render tree: CSS :hover is
 * only real after Input.dispatchMouseEvent, and darwin-only rules only apply while
 * document.documentElement.dataset.platform is "darwin".
 *
 *   node scripts/parity-snapshot.mjs --port 19949 --cdp 9222
 *   node scripts/parity-snapshot.mjs --port 19949 --cdp 9222 --out /tmp/parity.json
 *   node scripts/parity-snapshot.mjs --self-test        # no browser: emit the key skeleton
 *
 * Requires Node >= 22 for the built-in WebSocket. Never hardcodes a machine path.
 */
import { createHash, createHmac } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HELP = [
  "usage: node scripts/parity-snapshot.mjs --port <labPort> [--cdp <cdpPort>] [options]",
  "",
  "  --port <n>          lab HTTP port (the port lab-block.sh printed)",
  "  --cdp <n>           Chrome DevTools Protocol port (default 9222)",
  "  --out <path>        also write the JSON here (default: stdout only)",
  "  --home <dir>        HOME to read credentials from (default: os.homedir())",
  "  --secret-file <p>   credentials YAML (default: <home>/.dsh/.credentials.yaml)",
  "  --boot-wait <ms>    wait before touching the page (default 16000)",
  "  --no-cookie         do not mint a dsh-auth cookie (page must already be logged in)",
  "  --self-test         print the JSON skeleton without touching a browser",
  "  --help              print this",
].join("\n")

const BLOCK = "#drh-remote-block"
const SURFACE = ".drh-menuSurface"

function fail (message) {
  process.stderr.write("parity-snapshot: " + message + "\n")
  process.exit(1)
}

function parseArgs (argv) {
  const out = { cdp: 9222, out: null, home: homedir(), secretFile: null, cookie: true, selfTest: false, port: null, bootWaitMs: 16000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) fail(arg + " needs a value")
      i += 1
      return value
    }
    if (arg === "--help" || arg === "-h") { process.stdout.write(HELP + "\n"); process.exit(0) }
    else if (arg === "--port") out.port = Number(next())
    else if (arg === "--cdp") out.cdp = Number(next())
    else if (arg === "--out") out.out = next()
    else if (arg === "--home") out.home = next()
    else if (arg === "--secret-file") out.secretFile = next()
    else if (arg === "--boot-wait") out.bootWaitMs = Number(next())
    else if (arg === "--no-cookie") out.cookie = false
    else if (arg === "--self-test") out.selfTest = true
    else fail("unknown argument " + arg)
  }
  if (out.selfTest !== true && (out.port === null || Number.isFinite(out.port) !== true)) {
    fail("--port is required (the lab HTTP port printed by scripts/lab-block.sh)")
  }
  if (Number.isFinite(out.cdp) !== true) fail("--cdp must be a number")
  return out
}

// ---------------------------------------------------------------------------
// dsh-auth cookie: the Host mints it from a persistent signing secret.
// Derivation verified against the shipping dsh-client-connection bundle:
//   name  = "dsh-auth-" + b64url(sha256(authority))
//   value = "v1." + b64url(JSON{version,authority,issuedAt,expiresAt}) + "." + b64url(hmacSha256(secret, body))
// Read-only: this only mints a cookie for a port the caller already owns.
// ---------------------------------------------------------------------------
function b64url (buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

function readBrowserSessionSecret (credentialsPath) {
  let text
  try { text = readFileSync(credentialsPath, "utf8") } catch { return undefined }
  const lines = text.split(/\r?\n/u)
  let inRecords = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^records:/u.test(line)) { inRecords = true; continue }
    if (inRecords !== true) continue
    if (/^\S/u.test(line)) { inRecords = false; continue }
    if (/^\s+["\x27]?client-connection\/browser-session["\x27]?:\s*$/u.test(line) !== true) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j]
      if (/^\s{0,2}\S/u.test(inner)) break
      const match = /^\s+secret:\s*([A-Za-z0-9_-]+)\s*$/u.exec(inner)
      if (match !== null) return match[1]
    }
  }
  return undefined
}

function mintAuthCookie (authority, secretB64u) {
  const secret = Buffer.from(secretB64u.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  if (secret.byteLength !== 32) throw new Error("browser-session secret is not 32 bytes")
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000 }
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
  const signature = b64url(createHmac("sha256", secret).update(body).digest())
  return { name: "dsh-auth-" + b64url(createHash("sha256").update(authority).digest()), value: "v1." + body + "." + signature }
}

// ---------------------------------------------------------------------------
// Minimal CDP client over the page debugger WebSocket (one message at a time).
// ---------------------------------------------------------------------------
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
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error("cdp socket closed"))
      this.pending.clear()
    })
  }

  static async connect (cdpPort) {
    if (typeof globalThis.WebSocket !== "function") fail("Node >= 22 is required (global WebSocket)")
    let targets
    try {
      const response = await fetch("http://127.0.0.1:" + cdpPort + "/json/list")
      targets = await response.json()
    } catch (error) {
      fail("cannot reach CDP on 127.0.0.1:" + cdpPort + " (" + String(error) + "). Launch the app or Chrome with --remote-debugging-port=" + cdpPort)
    }
    const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string")
    if (pages.length === 0) fail("no page target on CDP " + cdpPort)
    return { pages }
  }

  static open (url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener("open", () => resolve(new Cdp(socket)))
      socket.addEventListener("error", () => reject(new Error("cdp websocket error")))
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
    const result = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception === undefined ? result.exceptionDetails.text : result.exceptionDetails.exception.description
      throw new Error("evaluate failed: " + String(detail))
    }
    return result.result === undefined ? undefined : result.result.value
  }

  async call (fn) {
    return await this.evaluate("(" + fn.toString() + ")()")
  }

  async waitFor (fn, timeoutMs) {
    const deadline = Date.now() + (timeoutMs === undefined ? 5000 : timeoutMs)
    for (;;) {
      const value = await this.call(fn)
      if (value !== null && value !== undefined && value !== false) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async mouseMove (x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 })
  }

  async click (x, y) {
    await this.mouseMove(x, y)
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 })
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 })
  }

  async escape () {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  }

  close () { try { this.socket.close() } catch { /* already closed */ } }
}
// ---------------------------------------------------------------------------
// Page-side probes. Each is serialized with toString() and evaluated in the page,
// so it must not close over Node scope and must read only the live render tree.
// ---------------------------------------------------------------------------
const pageEnv = () => {
  const state = globalThis.__DSH_REMOTE_HOST_STATE__
  return {
    url: location.href,
    platform: document.documentElement.dataset.platform ?? null,
    hasBlock: document.querySelector("#drh-remote-block") !== null,
    hasBlockCss: document.getElementById("drh-block-css") !== null,
    blockInstances: document.querySelectorAll("#drh-remote-block").length,
    remoteState: state === undefined || state === null ? null : {
      ids: Array.isArray(state.ids) ? state.ids.length : 0,
      workspaces: Array.isArray(state.workspaces) ? state.workspaces.length : 0,
    },
    status: globalThis.__DSH_REMOTE_HOST_STATUS__ ?? null,
  }
}

/** The shell slot the block mounts into; absent until the app shell has rendered. */
const pageSidebarSlot = () => document.querySelector('[data-slot="sidebar.workspaces"]') !== null

/** Where the app actually stopped, so a failed run explains itself instead of printing nulls. */
const pageDiagnose = () => {
  const slots = []
  for (const el of document.querySelectorAll('[data-slot]')) {
    const name = el.getAttribute('data-slot')
    if (slots.indexOf(name) === -1) slots.push(name)
  }
  const buttons = [...document.querySelectorAll('button')]
  const block = document.getElementById('drh-remote-block')
  const rect = block === null ? null : block.getBoundingClientRect()
  return {
    href: location.href,
    ready: document.readyState,
    text: (document.body === null ? '' : document.body.innerText).slice(0, 200),
    slotCount: slots.length,
    slots: slots.slice(0, 20),
    hasContinueGate: buttons.some((b) => (b.textContent || '').trim() === '继续'),
    blocks: document.querySelectorAll('#drh-remote-block').length,
    blockBox: rect === null ? null : { x: Math.round(rect.x), w: Math.round(rect.width) },
    groups: document.querySelectorAll('#drh-remote-block [data-drh-group]').length,
    rows: document.querySelectorAll('#drh-remote-block [data-drh-session]').length,
  }
}

/** Block width, used to tell a collapsed sidebar rail from an open one. */
const pageBlockBox = () => {
  const block = document.getElementById('drh-remote-block')
  if (block === null) return null
  const rect = block.getBoundingClientRect()
  return { x: Math.round(rect.x), w: Math.round(rect.width) }
}

/** Bring one element into the viewport, so pointer input can reach it. */
const pageScrollIntoView = (selector) => {
  const el = document.querySelector(selector)
  if (el === null) return false
  el.scrollIntoView({ block: "center" })
  return true
}

/** Whether a session row is rendered (a group is expanded). */
const pageHasSessionRow = () => document.querySelector('#drh-remote-block [data-drh-session]') !== null

/** Click one element by selector through the page, for triggers a pointer cannot reach. */
const pageClickSelector = (selector) => {
  const el = document.querySelector(selector)
  if (el === null) return false
  el.click()
  return true
}

const pageCenter = (selector) => {
  const el = document.querySelector(selector)
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

const pageHeader = () => {
  const block = document.querySelector("#drh-remote-block")
  if (block === null) return null
  const controls = [...block.querySelectorAll("[data-drh-searchopen],[data-drh-viewmenu],[data-drh-newspace]")]
  const label = block.querySelector(".drh-sectionLabel")
  const cs = label === null ? null : getComputedStyle(label)
  return {
    controls: controls.map((el) => {
      const rect = el.getBoundingClientRect()
      const svg = el.querySelector("svg")
      const use = el.querySelector("use")
      return {
        icon: svg === null ? null : (svg.getAttribute("data-icon") ?? (use === null ? null : String(use.getAttribute("href") ?? "").replace("#", ""))),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }
    }),
    label: cs === null ? null : { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color },
  }
}

const pageSwap = () => {
  const row = document.querySelector("#drh-remote-block [data-drh-group]")
  if (row === null) return null
  const folder = row.querySelector(".drh-folder")
  const chevron = row.querySelector(".drh-chevron")
  return {
    folder: folder === null ? null : getComputedStyle(folder).display,
    chevron: chevron === null ? null : getComputedStyle(chevron).display,
  }
}

const pageRow = (rowSelector, actionSelector) => {
  const row = document.querySelector(rowSelector)
  if (row === null) return null
  const rowRect = row.getBoundingClientRect()
  const actions = [...row.querySelectorAll(actionSelector)].map((el) => {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const svg = el.querySelector("svg")
    const svgRect = svg === null ? null : svg.getBoundingClientRect()
    return {
      icon: svg === null ? null : svg.getAttribute("data-icon"),
      x: Math.round(rect.left - rowRect.left),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      svg: svgRect === null ? null : Math.round(svgRect.width),
      margin: cs.marginLeft,
      radius: cs.borderTopLeftRadius,
      display: cs.display,
    }
  })
  const last = actions.length === 0 ? null : actions[actions.length - 1]
  return {
    rowHeight: Math.round(rowRect.height),
    rowWidth: Math.round(rowRect.width),
    // Gap between the last action and the row's right edge. A row that is narrower only
    // because a classic scrollbar took horizontal space still reports the same inset,
    // which is what makes an 8px x shift easy to read instead of looking like a regression.
    actionsRightInset: last === null ? null : Math.round(rowRect.right - (rowRect.left + last.x + last.w)),
    actions,
  }
}

const pageMenu = (triggerSelector) => {
  const surface = document.querySelector(".drh-menuSurface")
  if (surface === null) return null
  const rect = surface.getBoundingClientRect()
  const items = [...surface.querySelectorAll(".drh-menuItem")].map((el) => {
    const elRect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      h: Math.round(elRect.height),
      padBlock: parseInt(cs.paddingTop, 10),
      padInline: parseInt(cs.paddingLeft, 10),
      fontSize: cs.fontSize,
      radius: cs.borderTopLeftRadius,
      gap: cs.gap,
      label: String(el.textContent ?? "").trim().slice(0, 40),
    }
  })
  const labels = [...surface.querySelectorAll(".drh-menuLabel")].map((el) => {
    const cs = getComputedStyle(el)
    return {
      text: String(el.textContent ?? "").trim().slice(0, 40),
      fontSize: cs.fontSize,
      padBlock: parseInt(cs.paddingTop, 10),
      padInline: parseInt(cs.paddingLeft, 10),
    }
  })
  const separators = [...surface.querySelectorAll(".drh-menuSeparator")].map((el) => {
    const elRect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      w: Math.round(elRect.width),
      h: cs.height,
      color: cs.backgroundColor,
      marginBlock: parseInt(cs.marginTop, 10),
      marginInline: parseInt(cs.marginLeft, 10),
    }
  })
  const checkEl = surface.querySelector(".drh-menuCheck")
  const checkRect = checkEl === null ? null : checkEl.getBoundingClientRect()
  const shortcuts = [...surface.querySelectorAll(".drh-menuShortcut")].map((el) => {
    const cs = getComputedStyle(el)
    return { text: String(el.textContent ?? "").trim(), fontSize: cs.fontSize, color: cs.color }
  })
  const material = surface.querySelector(".drh-menuMaterial")
  const backing = surface.querySelector(".drh-menuBacking")
  const materialStyle = material === null ? null : getComputedStyle(material)
  const backingStyle = backing === null ? null : getComputedStyle(backing)
  const trigger = document.querySelector(triggerSelector)
  const triggerRect = trigger === null ? null : trigger.getBoundingClientRect()
  return {
    box: { w: Math.round(rect.width), h: Math.round(rect.height) },
    items,
    labels,
    separators,
    shortcuts,
    check: checkRect === null ? null : { w: Math.round(checkRect.width), h: Math.round(checkRect.height) },
    material: materialStyle === null ? null : {
      fill: materialStyle.backgroundColor,
      backdropFilter: materialStyle.backdropFilter,
      zIndex: materialStyle.zIndex,
    },
    backing: backingStyle === null ? null : {
      display: backingStyle.display,
      zIndex: backingStyle.zIndex,
      borderRadius: backingStyle.borderTopLeftRadius,
      background: backingStyle.backgroundColor,
    },
    alignment: triggerRect === null ? null : {
      mode: "end",
      diffRight: Math.round(rect.right - triggerRect.right),
      diffLeft: Math.round(rect.left - triggerRect.left),
    },
  }
}

const pageHoverCard = () => {
  const card = document.querySelector(".drh-hoverCard")
  if (card === null) return null
  const rect = card.getBoundingClientRect()
  const cs = getComputedStyle(card)
  const root = document.querySelector("#drh-remote-block")
  const rootRect = root === null ? null : root.getBoundingClientRect()
  const readText = (selector) => {
    const el = card.querySelector(selector)
    if (el === null) return null
    const style = getComputedStyle(el)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
  }
  const dot = card.querySelector(".drh-hoverDot")
  const dotRect = dot === null ? null : dot.getBoundingClientRect()
  return {
    w: Math.round(rect.width),
    bg: cs.backgroundColor,
    radius: cs.borderTopLeftRadius,
    padBlock: parseInt(cs.paddingTop, 10),
    padInline: parseInt(cs.paddingLeft, 10),
    title: readText(".drh-hoverTitle"),
    path: readText(".drh-hoverPath"),
    time: readText(".drh-hoverTime"),
    status: readText(".drh-hoverStatus"),
    dot: dotRect === null ? null : { w: Math.round(dotRect.width), h: Math.round(dotRect.height) },
    anchorGap: rootRect === null ? null : Math.round(rect.left - rootRect.right),
    delayMs: 800,
  }
}
// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function skeleton () {
  return {
    meta: {
      tool: "parity-snapshot",
      generatedAt: new Date().toISOString(),
      selfTest: false,
      labOrigin: null,
      cdpPort: null,
      platform: null,
      cookieSet: false,
      /** Whether a browser-session secret was readable (the value is never printed). */
      secretFound: null,
      notes: [],
    },
    env: null,
    header: { controls: [], label: null },
    swap: null,
    sessionRow: { rowHeight: null, actions: [] },
    projectRow: { rowHeight: null, actions: [] },
    rowMenu: null,
    viewMenu: null,
    groupMenu: null,
    /** Top-level aliases so the JSON keys line up with the ui-parity.md baseline table. */
    menuMaterial: null,
    menuBacking: null,
    hoverCard: null,
  }
}

function normalizeMenu (menu) {
  if (menu === null || menu === undefined) return null
  return {
    box: menu.box,
    count: menu.items.length,
    items: menu.items,
    labels: menu.labels,
    separators: menu.separators,
    shortcuts: menu.shortcuts,
    check: menu.check,
    material: menu.material,
    backing: menu.backing,
    alignment: menu.alignment,
  }
}

function emit (snapshot, options) {
  const json = JSON.stringify(snapshot, null, 2)
  if (options.out !== null) {
    writeFileSync(options.out, json + "\n")
    process.stderr.write("parity-snapshot: wrote " + options.out + "\n")
  }
  process.stdout.write(json + "\n")
}

// Call a page function with JSON arguments without closing over Node scope.
function callWith (cdp, fn, ...args) {
  const list = args.map((value) => JSON.stringify(value)).join(",")
  return cdp.evaluate("(" + fn.toString() + ")(" + list + ")")
}

const pageBlockReady = () => document.querySelector("#drh-remote-block") !== null

/**
 * Dismiss the first-run gates. A fresh profile can show more than one, so keep clicking
 * while one is present instead of assuming a single step.
 * @returns how many gates were dismissed.
 */
async function dismissGates (cdp) {
  let dismissed = 0
  for (let round = 0; round < 6; round += 1) {
    const clicked = await cdp.evaluate("(() => { const b = [...document.querySelectorAll('button')].find((x) => ['继续', 'Continue', '开始使用', 'Get started'].includes((x.textContent || '').trim())); if (!b) return false; b.click(); return true })()")
    if (clicked !== true) break
    dismissed += 1
    await sleep(1200)
  }
  return dismissed
}

/**
 * Open the sidebar when the app booted with it collapsed. A collapsed rail leaves the
 * block at a negative x with no width, so every pointer-driven measurement below would
 * land off-screen and report null.
 * @returns whether the block ends up on screen with a usable width.
 */
async function ensureSidebarExpanded (cdp) {
  const box = await cdp.call(pageBlockBox)
  if (box === null) return false
  if (box.w > 80 && box.x >= 0) return true
  const opened = await cdp.evaluate("(() => { const b = [...document.querySelectorAll('button')].find((x) => ['打开侧边栏', 'Open sidebar', '展开侧边栏'].includes((x.getAttribute('aria-label') || '').trim())); if (!b) return false; b.click(); return true })()")
  if (opened !== true) return false
  await sleep(900)
  const after = await cdp.call(pageBlockBox)
  return after !== null && after.w > 80 && after.x >= 0
}

/**
 * Expand the first workspace group so session rows exist. The block renders a group's
 * sessions only while it is expanded, and every session-level measurement needs a row.
 * @returns whether a session row is rendered afterwards.
 */
async function ensureGroupExpanded (cdp) {
  if ((await cdp.call(pageHasSessionRow)) === true) return true
  const clicked = await cdp.evaluate("(() => { const g = document.querySelector('#drh-remote-block [data-drh-group]'); if (g === null) return false; g.click(); return true })()")
  if (clicked !== true) return false
  await sleep(700)
  return (await cdp.call(pageHasSessionRow)) === true
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  const snapshot = skeleton()
  snapshot.meta.cdpPort = options.cdp

  if (options.selfTest === true) {
    snapshot.meta.selfTest = true
    snapshot.meta.notes.push("self-test: no browser contacted; every measured value is null")
    // Exercise the credential reader without printing the secret, so a broken
    // parser shows up here instead of as a mystery 401 later.
    const selfTestSecretPath = options.secretFile ?? join(options.home, ".dsh", ".credentials.yaml")
    const selfTestSecret = readBrowserSessionSecret(selfTestSecretPath)
    snapshot.meta.secretFound = selfTestSecret !== undefined
    snapshot.meta.notes.push(selfTestSecret === undefined
      ? "no browser-session secret in " + selfTestSecretPath
      : "browser-session secret found in " + selfTestSecretPath + " (value not printed)")
    emit(snapshot, options)
    return
  }

  const origin = "http://127.0.0.1:" + options.port
  const authority = "127.0.0.1:" + options.port
  snapshot.meta.labOrigin = origin

  const { pages } = await Cdp.connect(options.cdp)
  const target = pages.find((page) => String(page.url).startsWith(origin)) ?? pages[0]
  process.stderr.write("parity-snapshot: target " + String(target.url) + "\n")

  const cdp = await Cdp.open(target.webSocketDebuggerUrl)
  try {
    await cdp.send("Runtime.enable")
    await cdp.send("Page.enable")
    await cdp.send("Network.enable")
    // A headless window defaults to about 800x600, which in this app pushes the remote
    // block below the fold: every pointer-driven probe would then measure an unhovered,
    // zero-size row. Pin a viewport tall enough for the sidebar plus the block.
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    } catch (error) {
      snapshot.meta.notes.push("could not pin the viewport (" + (error instanceof Error ? error.message : String(error)) + ")")
    }

    if (options.cookie === true) {
      const secretPath = options.secretFile ?? join(options.home, ".dsh", ".credentials.yaml")
      const secret = readBrowserSessionSecret(secretPath)
      if (secret === undefined) {
        snapshot.meta.notes.push("no browser-session secret in " + secretPath + "; relying on the page existing session")
      } else {
        try {
          const cookie = mintAuthCookie(authority, secret)
          await cdp.send("Network.setCookie", { name: cookie.name, value: cookie.value, url: origin + "/", path: "/" })
          snapshot.meta.cookieSet = true
        } catch (error) {
          snapshot.meta.notes.push("cookie minting failed (" + (error instanceof Error ? error.message : String(error)) + "); relying on the page session")
        }
      }
    }

    if (String(target.url).startsWith(origin) !== true) {
      await cdp.send("Page.navigate", { url: origin + "/" })
    }

    // A fresh profile boots into the welcome gate and can leave the sidebar collapsed. The
    // block only mounts once the shell's sidebar slot exists, so wait for the app itself
    // before any block selector is meaningful, and record what the page actually showed
    // when something is still missing.
    await sleep(options.bootWaitMs)
    const gates = await dismissGates(cdp)
    if (gates > 0) snapshot.meta.notes.push("dismissed " + gates + " first-run gate(s)")
    await sleep(1500)

    // darwin-only rules (menu backing and friends) never apply without this.
    await cdp.evaluate("document.documentElement.dataset.platform = \"darwin\"")

    const shell = await cdp.waitFor(pageSidebarSlot, 20000)
    if (shell !== true) {
      snapshot.meta.notes.push("the app shell never rendered [data-slot=sidebar.workspaces]; page state: " + JSON.stringify(await cdp.call(pageDiagnose)))
    }

    const ready = await cdp.waitFor(pageBlockReady, 20000)
    if (ready !== true) {
      snapshot.meta.notes.push("no #drh-remote-block (check config.remoteBlock); page state: " + JSON.stringify(await cdp.call(pageDiagnose)))
    } else {
      if ((await ensureSidebarExpanded(cdp)) !== true) snapshot.meta.notes.push("the sidebar stayed collapsed; pointer-driven fields may be null")
      if ((await ensureGroupExpanded(cdp)) !== true) snapshot.meta.notes.push("no workspace group expanded; session-level fields may be null")
    }

    snapshot.env = await cdp.call(pageEnv)
    snapshot.header = (await cdp.call(pageHeader)) ?? snapshot.header
    if (snapshot.env !== null && snapshot.env !== undefined) snapshot.meta.platform = snapshot.env.platform

    const groupSelector = "#drh-remote-block [data-drh-group]"
    await callWith(cdp, pageScrollIntoView, groupSelector)
    await sleep(200)
    const groupCenter = await callWith(cdp, pageCenter, groupSelector)
    if (groupCenter === null) {
      snapshot.meta.notes.push("no [data-drh-group] row: swap/projectRow/groupMenu left null")
    } else {
      await cdp.mouseMove(groupCenter.x, groupCenter.y)
      await sleep(200)
      snapshot.swap = await cdp.call(pageSwap)
      snapshot.projectRow = (await callWith(cdp, pageRow, groupSelector, "[data-drh-rowmenu],[data-drh-groupnewchat]")) ?? snapshot.projectRow
    }

    const sessionSelector = "#drh-remote-block [data-drh-session]"
    await callWith(cdp, pageScrollIntoView, sessionSelector)
    await sleep(200)
    const sessionCenter = await callWith(cdp, pageCenter, sessionSelector)
    if (sessionCenter === null) {
      snapshot.meta.notes.push("no [data-drh-session] row: sessionRow/hoverCard/rowMenu left null")
    } else {
      await cdp.mouseMove(sessionCenter.x, sessionCenter.y)
      await sleep(200)
      snapshot.sessionRow = (await callWith(cdp, pageRow, sessionSelector, "[data-drh-rowmenu],[data-drh-rowarchive],[data-drh-rowpin]")) ?? snapshot.sessionRow
      await sleep(900)
      snapshot.hoverCard = await cdp.call(pageHoverCard)
      if (snapshot.hoverCard === null) snapshot.meta.notes.push("hover card did not appear after 900ms")

      const rowTrigger = sessionSelector + " [data-drh-rowmenu]"
      const rowMenuCenter = await callWith(cdp, pageCenter, rowTrigger)
      if (rowMenuCenter === null) {
        snapshot.meta.notes.push("no row menu trigger on the hovered session row")
      } else {
        await cdp.click(rowMenuCenter.x, rowMenuCenter.y)
        await sleep(250)
        snapshot.rowMenu = normalizeMenu(await callWith(cdp, pageMenu, rowTrigger))
        await cdp.escape()
        await sleep(150)
      }
    }

    const viewTrigger = "#drh-remote-block [data-drh-viewmenu]"
    await callWith(cdp, pageScrollIntoView, viewTrigger)
    await sleep(200)
    const viewCenter = await callWith(cdp, pageCenter, viewTrigger)
    if (viewCenter === null) {
      snapshot.meta.notes.push("no view menu trigger")
    } else {
      await cdp.click(viewCenter.x, viewCenter.y)
      await sleep(250)
      snapshot.viewMenu = normalizeMenu(await callWith(cdp, pageMenu, viewTrigger))
      await cdp.escape()
      await sleep(150)
    }

    if (groupCenter !== null) {
      // Re-read the row immediately before hovering it: the session and header steps above
      // scrolled the sidebar, so a centre measured earlier no longer points at this row,
      // and the menu trigger only gains a box while the row is actually hovered.
      await callWith(cdp, pageScrollIntoView, groupSelector)
      await sleep(200)
      const groupHover = await callWith(cdp, pageCenter, groupSelector)
      if (groupHover !== null) await cdp.mouseMove(groupHover.x, groupHover.y)
      await sleep(350)
      const groupTrigger = groupSelector + " [data-drh-groupmenu]"
      const groupMenuCenter = await callWith(cdp, pageCenter, groupTrigger)
      if (groupMenuCenter === null) {
        snapshot.meta.notes.push("no group menu trigger on the hovered group row")
      } else {
        await cdp.click(groupMenuCenter.x, groupMenuCenter.y)
        await sleep(250)
        snapshot.groupMenu = normalizeMenu(await callWith(cdp, pageMenu, groupTrigger))
        await cdp.escape()
      }
    }
  } finally {
    cdp.close()
  }

  // One material/backing pair is shared by every menu; publish it top-level so a
  // baseline diff can address menuMaterial.* / menuBacking.* directly.
  const materialSource = snapshot.viewMenu ?? snapshot.rowMenu ?? snapshot.groupMenu
  if (materialSource !== null) {
    snapshot.menuMaterial = materialSource.material
    snapshot.menuBacking = materialSource.backing
  }

  emit(snapshot, options)
}

main().catch((error) => {
  process.stderr.write("parity-snapshot: " + (error instanceof Error ? error.message : String(error)) + "\n")
  process.exit(1)
})
