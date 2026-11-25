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
import WebSocket from 'ws'
import { createRemoteMuxRelay } from './remote-mux.js'

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

/**
 * Whether the tunnel actually carries traffic right now.
 *
 * A bound listener is not proof: a frozen ssh keeps its port open (the kernel completes the
 * handshake out of the backlog) while nothing crosses the hop. Only a round trip through the
 * forward separates "up" from "wedged", which is what a health check needs.
 * @param port - local forward port.
 * @returns true when the far end answered at all.
 */
function probeTunnel(port) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (settled !== true) { settled = true; resolve(value) } }
    try {
      const request = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        headers: { host: '127.0.0.1:' + String(port) },
      }, (response) => {
        // Any status proves the hop works; the body is irrelevant.
        response.resume()
        done(true)
      })
      request.on('error', () => done(false))
      request.setTimeout(TUNNEL_HEALTH_TIMEOUT_MS, () => {
        request.destroy(new Error('no answer through the tunnel'))
        done(false)
      })
      request.end()
    } catch (error) {
      done(false)
    }
  })
}

/** Live tunnel children by pid, so this process exiting never leaves ssh behind. */
const LIVE_TUNNELS = new Set()
let tunnelExitHook = false

/**
 * Kill one tunnel child and its process group.
 *
 * ssh -N is spawned detached so it leads its own group; killing only the leader can leave
 * the forwarding side alive as an orphan (parent pid 1), which the lab caught.
 * @param child - spawned ssh, if any.
 */
export function killTunnel(child) {
  if (child === undefined || child === null) return
  const pid = child.pid
  if (typeof pid === 'number') {
    try { process.kill(-pid, 'SIGTERM') } catch { /* not a leader, or already gone */ }
    LIVE_TUNNELS.delete(pid)
  } else {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    return
  }
  // A STOPPED (or otherwise wedged) ssh queues SIGTERM until it is continued, so a polite
  // signal alone leaves it holding the local port: the next attempt then binds a port owned
  // by a corpse, the readiness probe is answered by that stale listener, and the tunnel
  // reports ok while nothing crosses it. Escalate so the port is really released.
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, 250)
  if (escalate !== null && escalate !== undefined && typeof escalate.unref === 'function') escalate.unref()
  try { child.kill('SIGTERM') } catch { /* already gone */ }
}

/** Take every live tunnel down when this process exits. */
function installTunnelExitHook() {
  if (tunnelExitHook === true) return
  tunnelExitHook = true
  process.once('exit', () => {
    for (const pid of LIVE_TUNNELS) {
      try { process.kill(-pid, 'SIGTERM') } catch { /* ignore */ }
    }
  })
}

/** stderr kept per attempt; ssh can chat for the whole length of an outage. */
const TUNNEL_STDERR_CAP = 2000

/** Bound on one health round trip through the forward. */
const TUNNEL_HEALTH_TIMEOUT_MS = 1200

/**
 * One SSH tunnel attempt. NEVER throws and never rejects: a failed attempt resolves
 * with a reason, because an escaping rejection here used to crash the host.
 *
 * @param sshHost - OpenSSH host alias from the user's ssh config.
 * @param remoteHost - address the remote daemon listens on, as seen from the remote.
 * @param remotePort - remote daemon port.
 * @param pinnedPort - local forward port to reuse; allocated when omitted.
 * @returns the tunnel, or the reason it is not up.
 */
function attemptSshTunnel(sshHost, remoteHost, remotePort, pinnedPort) {
  let child
  let stderr = ''
  let settled = false
  const usedPinnedPort = pinnedPort !== undefined
  return new Promise((resolve) => {
    const finish = (result) => {
      if (settled === true) return
      settled = true
      if (result.ok !== true && child !== undefined) killTunnel(child)
      resolve({ usedPinnedPort: usedPinnedPort, ...result })
    }
    const allocate = usedPinnedPort ? Promise.resolve(pinnedPort) : freePort()
    allocate.then((port) => {
      try {
        child = spawn('ssh', [
          '-N',
          '-o', 'BatchMode=yes',
          '-o', 'ExitOnForwardFailure=yes',
          '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'ConnectTimeout=10',
          '-L', '127.0.0.1:' + String(port) + ':' + remoteHost + ':' + String(remotePort),
          sshHost,
        ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
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
            installTunnelExitHook()
            if (typeof child.pid === 'number') LIVE_TUNNELS.add(child.pid)
            note('ssh tunnel: ok 127.0.0.1:' + String(port) + ' -> ' + sshHost + ':' + remoteHost + ':' + String(remotePort))
            finish({
              ok: true,
              base: 'http://127.0.0.1:' + String(port),
              child: child,
              port: port,
              close: () => killTunnel(child),
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
 * Keep one SSH forward alive.
 *
 * The local port is allocated once and reused for every rebuild: a new port would break
 * every connection already pointed at the old one, including the event stream, forcing the
 * renderer to reconnect on each blip. A port that ssh itself rejects is dropped so the next
 * attempt allocates a fresh one.
 *
 * A tunnel can also be WEDGED rather than exited (ssh alive, nothing crossing the hop).
 * An exit never fires for that, so a periodic round trip through the forward decides whether
 * the tunnel works, and a few misses in a row rebuild it.
 *
 * @param options.sshHost - OpenSSH host alias.
 * @param options.remoteHost - remote listen address.
 * @param options.remotePort - remote listen port.
 * @param options.onReady - receives the local base URL once the forward answers.
 * @param options.onLost - called when the established tunnel stops working.
 * @param options.attempt - attempt function; defaults to the real one (tests inject one).
 * @param options.probe - health round trip; defaults to the real one.
 * @param options.ladder - backoff ladder in ms.
 * @param options.healthIntervalMs - health cadence; defaults to 1500.
 * @param options.healthFailures - consecutive misses before a rebuild; defaults to 2.
 * @returns disposer that stops the ladder and closes the live tunnel.
 */
export function superviseSshTunnel(options) {
  const { sshHost, remoteHost, remotePort, onReady, onLost } = options
  const attempt = typeof options.attempt === 'function' ? options.attempt : attemptSshTunnel
  const probe = typeof options.probe === 'function' ? options.probe : probeTunnel
  const ladder = Array.isArray(options.ladder) && options.ladder.length > 0 ? options.ladder : TUNNEL_BACKOFF_MS
  // Two misses inside five seconds: 1500 + 1500 lands the rebuild near three seconds, which
  // leaves margin under the bound without polling the hop aggressively.
  const healthIntervalMs = Number.isFinite(options.healthIntervalMs) ? options.healthIntervalMs : 1500
  const healthFailures = Number.isFinite(options.healthFailures) ? options.healthFailures : 2
  let disposed = false
  let timer
  let healthTimer
  let current
  let localPort
  let misses = 0
  let failures = 0
  const stopHealth = () => {
    if (healthTimer !== undefined) { clearTimeout(healthTimer); healthTimer = undefined }
  }
  const stopCurrent = () => {
    stopHealth()
    misses = 0
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
  /** One health round trip; a frozen tunnel is rebuilt without waiting for ssh to exit. */
  const health = async (live, port) => {
    if (disposed === true || current !== live) return
    let answered = false
    try { answered = (await probe(port)) === true } catch { answered = false }
    if (disposed === true || current !== live) return
    if (answered === true) {
      misses = 0
    } else {
      misses += 1
      note('ssh tunnel: health miss ' + String(misses) + '/' + String(healthFailures))
      if (misses >= healthFailures) {
        note('ssh tunnel: unhealthy; rebuilding the forward')
        stopCurrent()
        try { onLost() } catch (error) { note('ssh tunnel: onLost failed: ' + String(error)) }
        later('tunnel unhealthy')
        return
      }
    }
    healthTimer = setTimeout(() => { void health(live, port) }, healthIntervalMs)
    if (healthTimer !== null && healthTimer !== undefined && typeof healthTimer.unref === 'function') healthTimer.unref()
  }
  const cycle = async () => {
    if (disposed === true) return
    // An attempt that throws SYNCHRONOUSLY would otherwise reject this async function,
    // and the rejected promise is not awaited anywhere: that is an unhandled rejection
    // in the host, which is exactly how a broken ssh used to take the app down.
    let result
    try {
      result = await attempt(sshHost, remoteHost, remotePort, localPort)
    } catch (error) {
      result = { ok: false, reason: 'the attempt threw: ' + String(error), usedPinnedPort: localPort !== undefined }
    }
    if (disposed === true) {
      if (result.ok === true) { try { result.close() } catch { /* already gone */ } }
      return
    }
    if (result.ok !== true) {
      // A pinned port that ssh refused is no good any more; allocate a new one next time.
      if (result.usedPinnedPort === true) {
        note('ssh tunnel: local port ' + String(localPort) + ' is no longer usable; reallocating')
        localPort = undefined
      }
      later(String(result.reason).slice(0, 140))
      return
    }
    failures = 0
    misses = 0
    if (typeof result.port === 'number') localPort = result.port
    current = result
    try { onReady(result.base) } catch (error) { note('ssh tunnel: onReady failed: ' + String(error)) }
    if (typeof localPort === 'number') {
      const live = result
      healthTimer = setTimeout(() => { void health(live, localPort) }, healthIntervalMs)
      if (healthTimer !== null && healthTimer !== undefined && typeof healthTimer.unref === 'function') healthTimer.unref()
    }
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
    stopHealth()
    stopCurrent()
  }
}

/**
 * Where host-side breadcrumbs go.
 *
 * A single fixed path is shared by every instance on the machine AND is rewritten by
 * whatever started last, which made crash forensics impossible: the log of the run
 * that crashed was already gone. Prefer the instance's own DSH_HOME, and fall back to
 * a per-process file so two instances can never truncate each other.
 */
const NOTE_LOG = (() => {
  const home = typeof process?.env?.DSH_HOME === 'string' ? process.env.DSH_HOME : ''
  if (home.length > 0) return join(home, 'dsh-remote-host.log')
  return '/tmp/dsh-remote-host-' + String(process?.pid ?? 0) + '.log'
})()

/** Append one diagnostic line; the desktop shell keeps no live log of its own. */
function note(line) {
  try {
    appendFileSync(NOTE_LOG, new Date().toISOString() + ' ' + line + '\n')
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

/**
 * Bound on one proxied request, in ms.
 *
 * An ssh deployment shortens it: while the tunnel is rebuilding there is nothing to wait
 * for, and the lab measured an eight-second stall on a frozen hop that read as a frozen UI.
 * Fail in about two seconds instead.
 */
let upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS

/** Bound used instead while an ssh tunnel is the only route. */
const SSH_UPSTREAM_TIMEOUT_MS = 2000

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
export function proxyRequest(req, res, dial, authority, cookieFile) {
  // Configured to reach the remote only through ssh: while no forward is up there is no
  // hop to dial at all, and silently using the configured upstream would put the traffic
  // back on the very path the tunnel exists to avoid. Answer at once instead of stalling.
  if (dial.blocked === true) {
    note('dial-blocked')
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' })
    res.end('dsh-remote-host: the ssh tunnel is not up; not falling back to the direct route\n')
    return
  }
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
  upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
    upstreamRequest.destroy(new Error('no answer within ' + String(upstreamTimeoutMs) + ' ms'))
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
  if (dial.blocked === true) {
    note('dial-blocked')
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain; charset=utf-8\r\nretry-after: 2\r\nconnection: close\r\n\r\nssh tunnel is not up\n')
    try { socket.destroy() } catch { /* already gone */ }
    return
  }
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
  upstreamRequest.setTimeout(upstreamTimeoutMs, () => {
    upstreamRequest.destroy(new Error('no answer within ' + String(upstreamTimeoutMs) + ' ms'))
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

function buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, superagentLabel, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket, streamRelay) {
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
  // Direction 1: rewrite the mux URL instead of owning the remote connection.
  // Written unconditionally so the pipeline can never silently drop it again.
  settings.streamRelay = streamRelay !== false
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
  // Keep remote reconnects out of the plugin's renderer code by default.
  // In mixed mode the local Host owns the remote leg's reconnects.
  const streamRelay = config?.streamRelay !== false
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
  /**
   * Where the mount actually dials. An SSH tunnel swaps host/port once ready, and while no
   * forward is up the dial is BLOCKED rather than handed back to the configured upstream:
   * falling back would put the traffic on the very path ssh was configured to avoid, so a
   * request would pay the full timeout against a hop that cannot answer.
   */
  const dial = {
    hostname: upstream.hostname,
    port: Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),
    secure: upstream.protocol === 'https:',
    blocked: false,
  }
  // Without ssh the direct route is the only route, so the default bound stays.
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS
  if (sshHost !== undefined) {
    const sshRemoteHost = typeof config?.sshRemoteHost === 'string' && config.sshRemoteHost.length > 0 ? config.sshRemoteHost : '127.0.0.1'
    const sshRemotePort = Number(config?.sshRemotePort ?? upstream.port ?? 3080)
    // Before the first forward answers there is nothing to reach.
    dial.blocked = true
    // A dead hop is not worth eight seconds when the caller will retry anyway.
    upstreamTimeoutMs = Math.min(UPSTREAM_TIMEOUT_MS, SSH_UPSTREAM_TIMEOUT_MS)
    note('ssh tunnel: dial blocked until a forward answers (no direct fallback)')
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
          dial.blocked = false
          note('ssh tunnel: dial now ' + base + ' (authority stays ' + authority + ')')
        } catch (error) {
          // A base that will not parse is as good as no tunnel: stay blocked.
          dial.blocked = true
          note('ssh tunnel: keeping the dial blocked: ' + String(error).slice(0, 140))
        }
      },
      onLost: () => {
        dial.blocked = true
        // A deliberately dead local target, in case anything dials without checking the flag.
        dial.hostname = '127.0.0.1'
        dial.port = 1
        dial.secure = false
        note('ssh tunnel: dial blocked while the forward is down (no direct fallback)')
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
    // The renderer's page origin is a custom scheme, so the Host's origin policy rejects every
    // request that carries it (403) before this handler runs. The mount is loopback-only and
    // relays with the remote's own credential; it keeps its own admission check below.
    auth: 'anonymous',
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
      // Same origin-policy exemption as the mount; the handler keeps its admission check.
      auth: 'anonymous',
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
    // The renderer's WebSocket carries `Origin: dsh-app://app`, which no Host authority can
    // match, so an upgrade route left on the default `required` policy is refused with 403
    // before this handler runs. The mount is loopback-only and relays with the remote's own
    // credential, so the route declares itself anonymous and keeps its own fencing below.
    auth: 'anonymous',
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
  if (streams && streamRelay && attach === 'merge') {
    const relay = createRemoteMuxRelay(() => {
      if (dial.blocked) return undefined
      const hostname = dial.hostname.includes(':') && !dial.hostname.startsWith('[') ? '[' + dial.hostname + ']' : dial.hostname
      const url = (dial.secure ? 'wss://' : 'ws://') + hostname + ':' + dial.port + '/api/remote.mux'
      const cookie = readCookie(cookieFile)
      return new WebSocket(url, {
        headers: cookie === undefined ? { host: authority } : { host: authority, cookie },
        handshakeTimeout: upstreamTimeoutMs,
        perMessageDeflate: false,
      })
    })
    disposers.push(() => relay.dispose())
    safe('host mux relay', () => webServer.registerUpgrade({
      path: mount + '/__dsh_remote_host__/mux',
      // Same fence as the stream mount: the page origin cannot match the Host authority, so the
      // route opts out of the upgrade policy and relies on the admission check inside.
      auth: 'anonymous',
      handler: (req, socket, head) => {
        try {
          const admission = ctx.get?.('connection')?.admit?.(req)
          if (admission?.peer?.principal?.kind !== 'owner') {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            return
          }
          relay.upgrade(req, socket, head)
        } catch {
          socket.destroy()
        }
      },
    }))
  }
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
        table.push({ kind: 'script', placement: 'head', text: buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, superagentLabel, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket, streamRelay) })
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
