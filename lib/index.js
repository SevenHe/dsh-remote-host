/**
 * dsh-remote-host — host half.
 *
 * Makes a remote DeepSeek Harness host reachable from THIS app's own origin, so
 * the shipped UI can render that machine's sessions natively:
 *
 *   /devbox/<path>            -> proxy to the remote origin (cookie + Host rewritten)
 *   /devbox/api/remote.mux    -> WebSocket relay for the remote stream mux
 *   index <head> injection    -> installs the browser shim (lib/shim.js)
 *
 * The shim owns the routing decision (local vs remote per endpoint/session) and
 * the /api/session/list merge. Nothing here inspects payloads.
 */

import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader plugin identity. */
export const name = 'dsh-remote-host'

/**
 * Cordis defers application until the web server exists; without this the mount
 * would run before the service is provided and silently find nothing. The
 * connection fence stays optional (`ctx.get`) so a Host without it still mounts.
 */
export const inject = ['webServer']

/** Disposer of the mount created by the previous activation of this module. */
let mounted

const HERE = dirname(fileURLToPath(import.meta.url))

/** Pick a free loopback port for a tunnel. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Resolve after `ms` without holding the process open. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
  })
}

/** Whether anything accepts a connection on this loopback port yet. */
function probeLoopback(port) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (settled !== true) { settled = true; resolve(value) } }
    try {
      const socket = createConnection({ host: '127.0.0.1', port }, () => { socket.destroy(); done(true) })
      socket.on('error', () => done(false))
      socket.setTimeout(500, () => { socket.destroy(); done(false) })
    } catch (error) {
      done(false)
    }
  })
}

/** stderr kept per attempt; ssh can chat for the whole length of an outage. */
const TUNNEL_STDERR_CAP = 2000

/**
 * One SSH tunnel attempt. NEVER throws and never rejects: a failed attempt resolves
 * to `{ ok: false, reason }`, so the supervisor decides when to try again.
 *
 * Both failure modes here used to escape into the host's event loop, which is how a
 * dead ssh turned into a dead UI:
 *
 *   - a child spawned without an `error` listener re-emits that error as an uncaught
 *     exception (no ssh binary, no exec permission, a bad working directory);
 *   - the forward not coming up was thrown at the caller, which then happily kept
 *     dialing a tunnel that does not exist.
 *
 * @param sshHost - OpenSSH host alias from the user's ssh config.
 * @param remoteHost - host to reach from the remote side (its own loopback).
 * @param remotePort - port the remote Harness listens on.
 * @returns `{ ok: true, base, child, close }` or `{ ok: false, reason }`.
 */
function attemptSshTunnel(sshHost, remoteHost, remotePort) {
  let child
  let stderr = ''
  let settled = false
  return new Promise((resolve) => {
    const finish = (result) => {
      if (settled === true) return
      settled = true
      if (result.ok !== true && child !== undefined) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      resolve(result)
    }
    freePort().then((port) => {
      try {
        child = spawn('ssh', [
          '-N',
          '-o', 'BatchMode=yes',
          '-o', 'ExitOnForwardFailure=yes',
          '-o', 'ServerAliveInterval=15',
          '-o', 'ConnectTimeout=10',
          '-L', '127.0.0.1:' + String(port) + ':' + remoteHost + ':' + String(remotePort),
          sshHost,
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (error) {
        finish({ ok: false, reason: 'ssh could not start: ' + String(error) })
        return
      }
      child.on('error', (error) => { finish({ ok: false, reason: 'ssh could not start: ' + String(error) }) })
      if (child.stderr !== null && child.stderr !== undefined) {
        child.stderr.on('data', (chunk) => {
          if (stderr.length < TUNNEL_STDERR_CAP) stderr += String(chunk).slice(0, 400)
        })
        child.stderr.on('error', () => { /* a broken stderr pipe is not a tunnel failure */ })
      }
      child.on('exit', (code, signal) => {
        finish({ ok: false, reason: 'ssh exited (' + String(code) + '/' + String(signal) + ') before the forward was up: ' + stderr.slice(0, 200) })
      })
      void (async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (settled === true) return
          if (child.exitCode !== null) return
          const reachable = await probeLoopback(port)
          if (settled === true) return
          if (reachable === true) {
            note('ssh tunnel: ok 127.0.0.1:' + String(port) + ' -> ' + sshHost + ':' + remoteHost + ':' + String(remotePort))
            finish({
              ok: true,
              base: 'http://127.0.0.1:' + String(port),
              child: child,
              close: () => { try { child.kill('SIGTERM') } catch { /* already gone */ } },
            })
            return
          }
          await delay(200)
        }
        finish({ ok: false, reason: 'the forward never came up: ' + stderr.slice(0, 200) })
      })()
    }, (error) => { finish({ ok: false, reason: 'no free loopback port: ' + String(error) }) })
  })
}

/**
 * Backoff ladder for a tunnel that will not come up, or that keeps dying. Capped, and
 * it never gives up: a devbox that is asleep or off the network for an hour still
 * connects on the first attempt after it comes back, with no app restart.
 */
const TUNNEL_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000]

/**
 * Keep one tunnel alive forever, single-flight.
 *
 * @param options.sshHost - OpenSSH host alias.
 * @param options.remoteHost - host reached from the remote side.
 * @param options.remotePort - port the remote Harness listens on.
 * @param options.onReady - called with the tunnel base URL once a forward is up.
 * @param options.onLost - called when an established tunnel dies, before the retry.
 * @param options.attempt - attempt function; defaults to `attemptSshTunnel` (tests inject one).
 * @param options.ladder - backoff ladder in ms; defaults to `TUNNEL_BACKOFF_MS`.
 * @returns disposer that stops retrying and kills the live child.
 */
export function superviseSshTunnel(options) {
  const { sshHost, remoteHost, remotePort, onReady, onLost } = options
  const attempt = typeof options.attempt === 'function' ? options.attempt : attemptSshTunnel
  const ladder = Array.isArray(options.ladder) && options.ladder.length > 0 ? options.ladder : TUNNEL_BACKOFF_MS
  let disposed = false
  let timer
  let current
  let failures = 0
  const stopCurrent = () => {
    const live = current
    current = undefined
    if (live !== undefined) { try { live.close() } catch { /* already gone */ } }
  }
  const later = (why) => {
    if (disposed === true) return
    const wait = ladder[Math.min(failures, ladder.length - 1)]
    failures += 1
    note('ssh tunnel: retry ' + String(failures) + ' in ' + String(wait) + 'ms (' + why + ')')
    clearTimeout(timer)
    timer = setTimeout(() => { cycle().catch((error) => { note('ssh tunnel: cycle failed: ' + String(error)) }) }, wait)
    // Waiting for a retry must never hold the process open.
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
  }
  const cycle = async () => {
    if (disposed === true) return
    // An attempt that throws SYNCHRONOUSLY would otherwise reject this async function,
    // and the rejected promise is not awaited anywhere: that is an unhandled rejection
    // in the host, which is exactly how a broken ssh used to take the app down.
    let result
    try {
      result = await attempt(sshHost, remoteHost, remotePort)
    } catch (error) {
      result = { ok: false, reason: 'the attempt threw: ' + String(error) }
    }
    if (disposed === true) {
      if (result.ok === true) { try { result.close() } catch { /* already gone */ } }
      return
    }
    if (result.ok !== true) { later(String(result.reason).slice(0, 140)); return }
    failures = 0
    current = result
    try { onReady(result.base) } catch (error) { note('ssh tunnel: onReady failed: ' + String(error)) }
    if (result.child !== undefined) {
      result.child.once('exit', () => {
        if (disposed === true) return
        note('ssh tunnel: ssh exited; the forward is gone')
        stopCurrent()
        try { onLost() } catch (error) { note('ssh tunnel: onLost failed: ' + String(error)) }
        later('tunnel lost')
      })
    }
  }
  // Nothing awaits these cycles, so their rejections must be handled here: an
  // unhandled rejection in the host is a crash path, not a log line.
  const start = () => { cycle().catch((error) => { note('ssh tunnel: cycle failed: ' + String(error)) }) }
  start()
  return () => {
    disposed = true
    clearTimeout(timer)
    stopCurrent()
  }
}

/** Append one diagnostic line; the desktop shell keeps no live log of its own. */
function note(line) {
  try {
    appendFileSync('/tmp/dsh-remote-host.log', new Date().toISOString() + ' ' + line + '\n')
  } catch { /* logging must never fail the plugin */ }
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Headers describing the *browser* hop, which must not reach the remote Host:
 * its request fence requires a present `Origin` to match its own authority, so a
 * page origin such as `dsh-app://app` would be rejected — a WebSocket upgrade
 * then fails as an abnormal close (1006). A server-to-server proxy drops them.
 */
const CLIENT_HOP = new Set([
  'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
])

/** Ceiling for one proxied hop, so an unreachable remote cannot hang a request. */
const UPSTREAM_TIMEOUT_MS = 8000

/** Expand a leading `~/` so profile patches can use shell-style paths. */
export function expandPath(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Renderer breadcrumbs land here: one JSONL file, rotated once past the cap. */
const TRACE_LOG = '~/.dsh/dsh-remote-host/renderer-trace.log'
const TRACE_LOG_LIMIT = 4 * 1024 * 1024
const TRACE_BODY_LIMIT = 256 * 1024

/**
 * Append one batch of renderer breadcrumbs. Every failure is swallowed: this
 * sink exists to observe the page, never to affect it.
 * @param body - raw request text, already size-capped by the caller.
 */
function appendTraceLines(body) {
  try {
    let parsed
    try { parsed = JSON.parse(body) } catch (error) { return }
    const lines = parsed === null || typeof parsed !== 'object' ? undefined : parsed.lines
    if (Array.isArray(lines) !== true || lines.length === 0) return
    const file = expandPath(TRACE_LOG)
    mkdirSync(dirname(file), { recursive: true })
    let text = ''
    for (const line of lines) {
      if (line === null || typeof line !== 'object') continue
      try { text += JSON.stringify(line) + '\n' } catch (error) { /* skip one bad line */ }
    }
    if (text.length === 0) return
    // Rotation is best effort: a failed rename only means the file keeps growing.
    try {
      if (statSync(file).size > TRACE_LOG_LIMIT) renameSync(file, file + '.1')
    } catch (error) { /* first write: the file does not exist yet */ }
    appendFileSync(file, text)
  } catch (error) { /* diagnostics must never fail a request */ }
}

/** Read the minted cookie, or undefined when setup has not run. */
export function readCookie(cookieFile) {
  try {
    const value = readFileSync(expandPath(cookieFile), 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Strip hop-by-hop headers and rewrite the request for the remote authority. */
function forwardedHeaders(raw, authority, cookie) {
  const headers = { ...raw }
  for (const key of Object.keys(headers)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name) || CLIENT_HOP.has(name)) delete headers[key]
  }
  headers.host = authority
  if (cookie === undefined) delete headers.cookie
  else headers.cookie = cookie
  return headers
}

/**
 * Serve one proxied request from a same-origin mount.
 * @param req - incoming request whose url already has the mount stripped.
 * @param res - response owned here.
 * @param upstream - parsed remote origin.
 * @param authority - `host:port` the remote cookie was minted for.
 * @param cookieFile - credential location.
 */
function proxyRequest(req, res, dial, authority, cookieFile) {
  const cookie = readCookie(cookieFile)
  const headers = forwardedHeaders(req.headers, authority, cookie)
  const upstreamRequest = httpRequest({
    hostname: dial.hostname,
    port: dial.port,
    path: req.url,
    method: req.method,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers }
    for (const key of Object.keys(responseHeaders)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) delete responseHeaders[key]
    }
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
    upstreamResponse.pipe(res)
  })
  upstreamRequest.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh-remote-host: remote request failed: ' + String(error))
  })
  // A hop that answers nothing used to hold the browser request open until the OS
  // gave up, which reads as a frozen UI. Fail the request instead.
  upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('no answer within ' + String(UPSTREAM_TIMEOUT_MS) + ' ms'))
  })
  req.on('error', () => { try { upstreamRequest.destroy() } catch { /* already gone */ } })
  req.pipe(upstreamRequest)
}

/**
 * Relay one WebSocket upgrade to the remote mux, byte for byte.
 * @param req - upgrade request (already authenticated by the host fence).
 * @param socket - browser-side socket owned here.
 * @param head - bytes read past the handshake.
 * @param upstream - parsed remote origin.
 * @param authority - remote authority for Host/cookie.
 * @param cookieFile - credential location.
 */
function proxyUpgrade(req, socket, head, dial, authority, cookieFile) {
  const headers = forwardedHeaders(req.headers, authority, readCookie(cookieFile))
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade ?? 'websocket'
  const upstreamRequest = httpRequest({
    hostname: dial.hostname,
    port: dial.port,
    path: req.url,
    method: req.method,
    headers,
  })
  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(key + ': ' + item)
      else if (value !== undefined) lines.push(key + ': ' + value)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const destroy = () => { upstreamSocket.destroy(); socket.destroy() }
    upstreamSocket.on('error', destroy)
    socket.on('error', destroy)
    upstreamSocket.on('close', destroy)
    socket.on('close', destroy)
  })
  upstreamRequest.on('response', (upstreamResponse) => {
    const lines = ['HTTP/1.1 ' + String(upstreamResponse.statusCode ?? 502) + ' ' + (upstreamResponse.statusMessage ?? '')]
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(key + ': ' + item)
      else if (value !== undefined) lines.push(key + ': ' + value)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    upstreamResponse.pipe(socket)
  })
  upstreamRequest.on('error', () => socket.destroy())
  upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('no answer within ' + String(UPSTREAM_TIMEOUT_MS) + ' ms'))
  })
  upstreamRequest.end()
}

/**
 * Build the shim as classic-script text for an index injection row.
 *
 * Rows feed two renderers: the served index renders them into HTML, and the
 * desktop shell ships the same table to a page-side interpreter. A `tapIndex`
 * HTML transform reaches neither the shell's document nor its interpreter, so
 * the row is the only channel that works in both.
 * @param mount - same-origin mount path.
 * @param label - display label.
 * @param windowDays - remote display window, when configured.
 * @returns classic-script source, safe inside a `<script>` element.
 */
/** Content hash of the shim, so a loaded page can tell it is stale. */
function shimRevision() {
  try {
    return createHash('sha256').update(readFileSync(join(HERE, 'shim.js'), 'utf8')).digest('hex').slice(0, 12)
  } catch (error) { return 'unknown' }
}

function buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, superagentLabel, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket) {
  const source = readFileSync(join(HERE, 'shim.js'), 'utf8')
  const settings = { mount, label }
  if (windowDays !== undefined) settings.windowDays = windowDays
  if (streams === true) settings.streams = true
  if (sections === true) settings.sections = true
  // CSS-only section headings for the shipped sidebar (no shadowing).
  if (sectionHeaders === true) settings.sectionHeaders = true
  // 'workspace' keeps every remote workspace as its own shipped group instead of folding
  // them into one, which is what gives the remote side a directory -> session hierarchy.
  if (group !== 'single') settings.group = group
  // Renders the second workspace block (remote) while the shipped block keeps the local one.
  if (remoteBlock === true) settings.remoteBlock = true
  if (attach === 'remote') settings.attach = 'remote'
  if (superagent === 'remote') settings.superagent = 'remote'
  if (typeof superagentLabel === 'string' && superagentLabel.length > 0) settings.superagentLabel = superagentLabel
  // Off by default: reloading a dsh-app:// document crashes the renderer in the desktop
  // shell (EXC_BREAKPOINT in V8), and every rebuild of this plugin produced exactly one
  // crash on the next time the window was hidden. Only opt in when developing the shim,
  // where a manual reload is expected anyway.
  if (selfUpdate === true) settings.rev = shimRevision()
  // Renderer breadcrumbs (crash diagnostics) are off unless asked for: the sink
  // writes a local JSONL file and the page gains listeners only when enabled.
  if (trace === true) settings.trace = true
  // Opt out of the global WebSocket replacement; the carrier factory stays patched.
  if (globalWebSocket === false) settings.globalWebSocket = false
  const config = JSON.stringify(settings)
  const text = 'window.__DSH_REMOTE_HOST__=' + config + ';\n' + source
  if (text.includes('</script')) throw new Error('shim source would close its script element early')
  return text
}

/**
 * Mount the remote host into this Harness host.
 * @param ctx - host context owning the web server.
 * @param config - bundle patch config (upstream, authority, cookieFile, mount, label).
 */
export function apply(ctx, config) {
  try {
    return mountRemote(ctx, config)
  } catch (error) {
    // A broken mount must degrade to a normal Harness, never to a failed Host.
    console.error('[dsh-remote-host] mount failed; continuing without the remote host: ' + String(error))
    return undefined
  }
}

/**
 * Register the mount, replacing any previous one (plugin reload re-applies).
 * @param ctx - host context.
 * @param config - bundle patch config.
 */
function mountRemote(ctx, config) {
  let upstream
  try {
    upstream = new URL(config?.upstream ?? 'http://127.0.0.1:3080')
  } catch (error) {
    console.error('[dsh-remote-host] invalid upstream "' + String(config?.upstream) + '"; nothing mounted')
    return undefined
  }
  const authority = config?.authority ?? upstream.host
  const cookieFile = config?.cookieFile ?? '~/.dsh/dsh-remote-host/cookie.txt'
  const mount = (config?.mount ?? '/devbox').replace(/\/+$/, '')
  const label = config?.label ?? 'devbox'
  const windowDays = typeof config?.windowDays === 'number' && config.windowDays > 0 ? config.windowDays : undefined
  // Stream multiplexing is opt-in: a carrier mismatch there can stall every
  // connection, while unary routing alone already surfaces remote Sessions.
  const streams = config?.streams === true
  const sections = config?.sidebar === 'sections'
  const sectionHeaders = config?.sectionHeaders === true
  const group = config?.group === 'workspace' ? 'workspace' : (config?.group === 'none' ? 'none' : 'single')
  const remoteBlock = config?.remoteBlock === true
  // Crash-diagnostic breadcrumbs from the renderer. Off by default: it adds page
  // listeners and a local log file, and exists only to explain a renderer crash.
  const trace = config?.trace === true
  const globalWebSocket = config?.globalWebSocket !== false
  // Reloading a dsh-app:// document crashes the renderer, so this stays opt-in.
  const selfUpdate = config?.selfUpdate === true
  const attach = config?.attach === 'remote' ? 'remote' : 'merge'
  const superagent = config?.superagent === 'remote' ? 'remote' : 'local'
  // Label the Superagent entry with the attached host, so it cannot be mistaken
  // for a local instance.
  const superagentLabel = superagent === 'remote' && typeof config?.superagentLabel === 'string'
    ? config.superagentLabel
    : (superagent === 'remote' ? (typeof config?.label === 'string' ? config.label : undefined) : undefined)
  const sshHost = typeof config?.sshHost === 'string' && config.sshHost.length > 0 ? config.sshHost : undefined
  note('apply: upstream=' + upstream.origin + ' mount=' + mount + ' streams=' + String(streams) + (sshHost === undefined ? '' : ' ssh=' + sshHost))
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer
  if (webServer === undefined) {
    console.error('[dsh-remote-host] no web server on this host; nothing mounted')
    return undefined
  }
  if (mounted !== undefined) {
    try { mounted() } catch { /* ignore */ }
    mounted = undefined
  }
  const disposers = []
  let mountReady = false
  /** Latest browser diagnostics snapshot, written by the shim. */
  let report
  const safe = (what, register) => {
    try {
      const dispose = register()
      if (typeof dispose === 'function') disposers.push(dispose)
      note(what + ': ok')
      return true
    } catch (error) {
      note(what + ': FAILED ' + String(error))
      console.error('[dsh-remote-host] ' + what + ' not registered: ' + String(error))
      return false
    }
  }
  /** Where the mount actually dials; an SSH tunnel swaps host/port once ready. */
  const dial = {
    hostname: upstream.hostname,
    port: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),
    secure: upstream.protocol === 'https:',
  }
  if (sshHost !== undefined) {
    const sshRemoteHost = typeof config?.sshRemoteHost === 'string' && config.sshRemoteHost.length > 0 ? config.sshRemoteHost : '127.0.0.1'
    const sshRemotePort = Number(config?.sshRemotePort ?? upstream.port ?? 3080)
    // While no tunnel is up the mount dials the configured upstream directly, which
    // fails immediately (or hits the request timeout) instead of hanging on a hop that
    // is not listening. A tunnel that dies hands the dial back the same way.
    const directDial = { hostname: dial.hostname, port: dial.port, secure: dial.secure }
    disposers.push(superviseSshTunnel({
      sshHost,
      remoteHost: sshRemoteHost,
      remotePort: sshRemotePort,
      onReady: (base) => {
        try {
          const parsed = new URL(base)
          dial.hostname = parsed.hostname
          dial.port = Number(parsed.port)
          dial.secure = false
          note('ssh tunnel: dial now ' + base + ' (authority stays ' + authority + ')')
        } catch (error) {
          note('ssh tunnel: keeping direct dial: ' + String(error).slice(0, 140))
        }
      },
      onLost: () => {
        dial.hostname = directDial.hostname
        dial.port = directDial.port
        dial.secure = directDial.secure
        note('ssh tunnel: dial back to the configured upstream while the tunnel is down')
      },
    }))
  }

  // Same access policy as /api: the mount carries the remote host's full
  // credential, so it must not be reachable by anything the Host would reject.
  const admit = (req) => {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || typeof connection.admitConnection !== 'function') return true
    try {
      const admission = connection.admitConnection(req)
      return admission === undefined || !('rejection' in admission)
    } catch {
      return false
    }
  }
  mountReady = safe('http mount', () => webServer.register({
    kind: 'prefix',
    path: mount,
    handler: (req, res) => {
      try {
        if (!admit(req)) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('dsh-remote-host: not admitted by the host connection policy\n')
          return
        }
        const url = req.url ?? '/'
        const path = url.length > mount.length ? url.slice(mount.length) : '/'
        if (path === '/__dsh_remote_host__/asset/block.css') {
          // Ported workspace-block stylesheet; served from the repository so the block and
          // its styles ship together.
          try {
            const css = readFileSync(join(HERE, '..', 'src', 'client', 'block', 'block.css'), 'utf8')
            res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
            res.end(css)
          } catch (error) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('dsh-remote-host: block.css missing\n')
          }
          return
        }
        if (path === '/__dsh_remote_host__/report') {
          if (req.method === 'POST') {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => {
              try { report = JSON.parse(body) } catch { report = { error: 'unparsable' } }
              res.writeHead(204, { 'cache-control': 'no-store' })
              res.end()
            })
            return
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          // `rev` lets a loaded page notice that the shim on disk changed.
          res.end(JSON.stringify({ ...(report ?? { report: 'none yet' }), rev: shimRevision() }))
          return
        }
        if (path === '/__dsh_remote_host__/trace') {
          // Breadcrumbs are written locally and never proxied: the remote host has
          // no business seeing what this renderer was doing.
          if (req.method !== 'POST' || trace !== true) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end('{"ok":true}')
            return
          }
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
            // Bound the buffer: a runaway page must not pin memory on the Host.
            if (body.length > TRACE_BODY_LIMIT) body = body.slice(0, TRACE_BODY_LIMIT)
          })
          req.on('end', () => {
            try { appendTraceLines(body) } catch (error) { /* swallowed again, deliberately */ }
            try {
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              res.end('{"ok":true}')
            } catch (error) { /* the page may already be gone */ }
          })
          return
        }
        req.url = path
        proxyRequest(req, res, dial, authority, cookieFile)
      } catch (error) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-remote-host: ' + String(error))
      }
    },
  }))
  // The super agent plugin serves its data under /orchestrator/api/ on THIS host,
  // and its panel calls it with plain fetch — which the browser shim never sees.
  // Proxying that prefix at the root makes the panel read the mounted instance.
  if (superagent === 'remote') {
    safe('orchestrator api proxy', () => webServer.register({
      kind: 'prefix',
      path: '/orchestrator/api',
      handler: (req, res) => {
        try {
          if (!admit(req)) {
            res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('dsh-remote-host: not admitted by the host connection policy\n')
            return
          }
          // req.url already is /orchestrator/api/…, which is what the remote serves.
          proxyRequest(req, res, dial, authority, cookieFile)
        } catch (error) {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh-remote-host: ' + String(error))
        }
      },
    }))
    safe('orchestrator stream proxy', () => webServer.registerUpgrade({
      path: '/orchestrator',
      handler: (req, socket, head) => {
        try {
          proxyUpgrade(req, socket, head, dial, authority, cookieFile)
        } catch (error) {
          try { socket.destroy() } catch { /* ignore */ }
        }
      },
    }))
  }

  safe('stream mount', () => webServer.registerUpgrade({
    path: mount + '/api/remote.mux',
    handler: (req, socket, head) => {
      try {
        // The browser sends `Origin: dsh-app://app`, which can never equal the
        // Host authority, so the connection fence would reject every remote
        // stream. The mount therefore relies on the Host binding loopback only
        // (documented in the README) instead of re-applying that fence here.
        const url = req.url ?? '/'
        req.url = url.startsWith(mount) ? url.slice(mount.length) : url
        proxyUpgrade(req, socket, head, dial, authority, cookieFile)
      } catch (error) {
        console.error('[dsh-remote-host] stream relay failed: ' + String(error))
        socket.destroy()
      }
    },
  }))
  safe('shim injection', () => {
    // Never install page code that depends on a mount which failed to register.
    if (mountReady !== true) throw new Error('refusing to inject the shim without a registered mount')
    if (typeof ctx.on !== 'function') throw new Error('no cordis events on this context')
    const off = ctx.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        // Read the shim per render: a page reload then picks up a fixed shim
        // without restarting the Host, which is the difference between a
        // one-minute iteration and a full app restart.
        table.push({ kind: 'script', placement: 'head', text: buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, superagentLabel, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket) })
      } catch (error) {
        console.error('[dsh-remote-host] index row failed: ' + String(error))
      }
    })
    return typeof off === 'function' ? off : () => {}
  })
  mounted = () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
  console.log('[dsh-remote-host] mounted ' + upstream.origin + ' at ' + mount + ' as "' + label + '"')
  return mounted
}
