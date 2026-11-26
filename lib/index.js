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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createRemoteMuxRelay } from './remote-mux.js'
import { expandPath, makeRefresher, readCookie, replayWithFreshCredential } from './credentials.js'
import { createRouteHandlers } from './routes.js'
import {
  controlArgs, controlPathFor, DEFAULT_CONTROL_DIR, DEFAULT_PERSIST_SEC, ensureControlDir, exitArgs, sweepControlSocket,
} from './ssh-control.js'

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
 * @param timeoutMs - round-trip budget; defaults to the health bound.
 * @returns true when the far end answered at all.
 */
function probeTunnel(port, timeoutMs = TUNNEL_HEALTH_TIMEOUT_MS) {
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
      request.setTimeout(timeoutMs, () => {
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
 * Bound on the polite `ssh -O exit` issued during cleanup.
 *
 * The request is never awaited, so the bound exists for the helper itself: one that cannot
 * answer in a second is killed instead of outliving the tunnel it was meant to close.
 */
const CONTROL_EXIT_TIMEOUT_MS = 1000

/**
 * Ask the ssh master behind a tunnel to exit.
 *
 * `ControlPersist=no` ties the master to the tunnel that created it, so the client signal in
 * `killTunnel` usually suffices. A WEDGED master outlives its client instead, and it keeps the
 * control socket and the forwarded port; `-O exit` sent through that socket is the only way to
 * reach it. The request is advisory: it runs as its own short-lived child, its failure is
 * recorded and ignored, and the caller still signals the tunnel afterwards.
 * @param control - resolved control settings including the host alias; omitted issues nothing.
 */
function requestMasterExit(control) {
  if (control === undefined || control === null || control.enabled !== true) return
  const args = exitArgs({ dir: control.dir, host: control.host })
  if (args.length === 0) return
  const run = typeof control.spawn === 'function' ? control.spawn : spawn
  let polite
  try {
    polite = run('ssh', args, { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch (error) {
    note('ssh tunnel: the master exit request could not start: ' + String(error))
    return
  }
  if (polite === undefined || polite === null) return
  let done = false
  let bound
  const finish = (failure) => {
    if (done === true) return
    done = true
    clearTimeout(bound)
    if (failure !== undefined) note('ssh tunnel: the master exit request failed (' + failure + ')')
  }
  bound = setTimeout(() => {
    try { polite.kill('SIGKILL') } catch { /* the request already ended */ }
    finish('no answer within ' + String(CONTROL_EXIT_TIMEOUT_MS) + 'ms')
  }, CONTROL_EXIT_TIMEOUT_MS)
  if (bound !== null && bound !== undefined && typeof bound.unref === 'function') bound.unref()
  // Neither a missing ssh nor a silent master may outlive the tunnel: the first is ignored
  // here, the second is killed at the bound, and the signal escalation below covers both.
  polite.once('error', (error) => finish(String(error)))
  polite.once('exit', (code, signal) => finish(code === 0 && signal === null ? undefined : 'exit ' + String(code) + '/' + String(signal)))
}

/**
 * Kill one tunnel child and its process group.
 *
 * ssh -N is spawned detached so it leads its own group; killing only the leader can leave
 * the forwarding side alive as an orphan (parent pid 1), which the lab caught.
 *
 * The control socket is addressed first (see `requestMasterExit`): the forward is the master
 * every other ssh to this host joins, and `-O exit` is what closes one whose client is wedged.
 * The request is not awaited, so the signal path stays synchronous and the forwarded port is
 * released on the same tick as before.
 * @param child - spawned ssh, if any.
 * @param control - control settings for the master this child created; omitted keeps the
 *   pre-existing signal-only cleanup.
 */
export function killTunnel(child, control) {
  if (child === undefined || child === null) return
  requestMasterExit(control)
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

/**
 * Bound on one health round trip through the forward.
 *
 * A miss costs a full rebuild — every socket pointed at the forward dies — so a BUSY far end
 * must not be mistaken for a dead one. A loaded remote Host can take a second to answer while
 * it writes a Session. Codex's remote control is far more patient still (60s pong window) and
 * still declares dead; the point is that the probe must outwait real work, not that it be
 * fast. Two misses at 1.5s cadence then declare the forward wedged after roughly nine seconds.
 */
const TUNNEL_HEALTH_TIMEOUT_MS = 3000

/** How long one attempt may wait for the forward to answer. */
const TUNNEL_READY_TIMEOUT_MS = 12000
/** Budget for the readiness round trip: a first request through a cold hop. */
const TUNNEL_READY_PROBE_MS = 800

/**
 * Resolve the control socket a forward joins.
 *
 * Opt-in, because the mount is what owns the product default: `mountRemote` resolves the
 * configured switch once and passes the answer down. A low level that defaulted to on would
 * make every other caller — the offline suite included — open sockets nobody asked for. A
 * directory that is not a string falls back to the shared one: a typo costs the optimisation,
 * never the mount.
 * @param supplied - `deps.control` from the caller: `{ enabled, dir, persistSec }`, plus two
 *   optional stand-ins for the offline suite — `spawn` for the cleanup request and `probe`
 *   for the liveness check that decides whether a socket on disk is a corpse.
 * @returns settings for `controlArgs`, the cleanup path and the pre-flight sweep.
 */
function resolveControl(supplied) {
  const entry = supplied !== undefined && supplied !== null && typeof supplied === 'object' ? supplied : {}
  return {
    enabled: entry.enabled === true,
    dir: typeof entry.dir === 'string' && entry.dir.length > 0 ? entry.dir : DEFAULT_CONTROL_DIR,
    persistSec: Number.isFinite(entry.persistSec) ? entry.persistSec : undefined,
    spawn: typeof entry.spawn === 'function' ? entry.spawn : undefined,
    probe: typeof entry.probe === 'function' ? entry.probe : undefined,
  }
}

/**
 * Whether a master still answers on a control socket.
 *
 * `ssh -O check` is the only honest answer: the socket file survives a Host that died, and a
 * stale one makes the next master fail with "Control socket connect". A missing ssh, a refusal
 * and a timeout all mean "no master", which is what the sweep acts on.
 * @param path - control socket path.
 * @param host - OpenSSH host alias the socket belongs to.
 * @param control - resolved control settings, including the spawn stand-in.
 * @returns true when a master answered.
 */
function masterAnswers(path, host, control) {
  return new Promise((resolve) => {
    const run = control.spawn === undefined ? spawn : control.spawn
    let child
    try {
      child = run('ssh', ['-O', 'check', '-o', 'ControlPath=' + path, host], { stdio: ['ignore', 'ignore', 'ignore'] })
    } catch { resolve(false); return }
    if (child === undefined || child === null) { resolve(false); return }
    let settled = false
    const done = (value) => {
      if (settled === true) return
      settled = true
      clearTimeout(bound)
      resolve(value)
    }
    const bound = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done(false)
    }, CONTROL_EXIT_TIMEOUT_MS)
    if (bound !== null && bound !== undefined && typeof bound.unref === 'function') bound.unref()
    child.once('error', () => done(false))
    child.once('exit', (code) => done(code === 0))
  })
}

/**
 * Clear the socket a crashed Host left behind, before a new master claims the path.
 * @param control - resolved control settings; a disabled control block sweeps nothing.
 * @param host - OpenSSH host alias.
 * @returns the sweep outcome, for the log.
 */
async function sweepSocket(control, host) {
  if (control.enabled !== true) return 'absent'
  const path = controlPathFor(control.dir, host)
  if (existsSync(path) !== true) return 'absent'
  const alive = control.probe === undefined ? await masterAnswers(path, host, control) : await control.probe(path, host) === true
  const swept = sweepControlSocket({ path, alive })
  if (swept === 'removed') note('ssh tunnel: cleared a control socket whose master is gone')
  else if (swept === 'stuck') note('ssh tunnel: could not clear a stale control socket at ' + path)
  return swept
}

/**
 * One SSH tunnel attempt. NEVER throws and never rejects: a failed attempt resolves
 * with a reason, because an escaping rejection here used to crash the host.
 *
 * A bound local port is NOT readiness: `ssh -L` binds it before the far end is reachable,
 * and the kernel finishes a handshake out of the backlog while nothing crosses the hop. An
 * attempt that reported "ok" on that alone published a forward that answered nothing, and the
 * supervisor's own first health probe then tore it down — the rebuild loop this exists to
 * prevent. Readiness is one real round trip through the forward.
 *
 * @param sshHost - OpenSSH host alias from the user's ssh config.
 * @param remoteHost - address the remote daemon listens on, as seen from the remote.
 * @param remotePort - remote daemon port.
 * @param pinnedPort - local forward port to reuse; allocated when omitted.
 * @param signal - aborts the attempt and reaps its child; a superseded attempt must not hold a port.
 * @param deps - spawn and probe stand-ins, so the offline suite drives this without ssh;
 *   `deps.control = { enabled, dir }` names the control socket this forward joins.
 * @returns the tunnel, or the reason it is not up.
 */
export function attemptSshTunnel(sshHost, remoteHost, remotePort, pinnedPort, signal, deps = {}) {
  const run = typeof deps.spawn === 'function' ? deps.spawn : spawn
  const reachable = typeof deps.probeLoopback === 'function' ? deps.probeLoopback : probeLoopback
  const carries = typeof deps.probeTunnel === 'function' ? deps.probeTunnel : probeTunnel
  // This forward is the first ssh on the host, so it becomes the master every later leg
  // joins; the same settings tell the cleanup path which socket to close.
  const control = resolveControl(deps.control)
  const master = { ...control, host: sshHost }
  let child
  let stderr = ''
  let settled = false
  let abort
  const usedPinnedPort = pinnedPort !== undefined
  return new Promise((resolve) => {
    const finish = (result) => {
      if (settled === true) return
      settled = true
      if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', abort) } catch { /* ignore */ }
      }
      if (result.ok !== true && child !== undefined) killTunnel(child, master)
      resolve({ usedPinnedPort: usedPinnedPort, ...result })
    }
    abort = () => { finish({ ok: false, reason: 'the attempt was cancelled', cancelled: true }) }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) { finish({ ok: false, reason: 'the attempt was cancelled', cancelled: true }); return }
      if (typeof signal.addEventListener === 'function') {
        try { signal.addEventListener('abort', abort, { once: true }) } catch { /* an unsupported signal cannot cancel */ }
      }
    }
    const allocate = usedPinnedPort ? Promise.resolve(pinnedPort) : freePort()
    // A master that outlives its client can also outlive a crash, and its socket file then
    // blocks the next master. Sweep before spawning, never after: ssh owns the path.
    const preflight = control.enabled === true
      ? (async () => {
          ensureControlDir(control.dir)
          await sweepSocket(control, sshHost)
        })()
      : Promise.resolve()
    preflight.then(() => allocate).then((port) => {
      try {
        // ssh creates the socket, never the directory: it has to exist before this runs.
        // A directory that cannot be created (a read-only tmp) only costs the optimisation.
        if (control.enabled === true) ensureControlDir(control.dir)
        child = run('ssh', [
          '-N',
          '-o', 'BatchMode=yes',
          '-o', 'ExitOnForwardFailure=yes',
          '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3',
          '-o', 'ConnectTimeout=10',
          '-L', '127.0.0.1:' + String(port) + ':' + remoteHost + ':' + String(remotePort),
          ...controlArgs(master),
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
        // Bounded by wall clock, not by a tick count: a probe may itself take most of a second.
        const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (settled === true) return
          if (child.exitCode !== null) return
          const bound = await reachable(port)
          if (settled === true) return
          // Bound is only worth a round trip; the hop decides whether it carries anything.
          if (bound === true && await carries(port, TUNNEL_READY_PROBE_MS) === true) {
            if (settled === true) return
            installTunnelExitHook()
            if (typeof child.pid === 'number') LIVE_TUNNELS.add(child.pid)
            note('ssh tunnel: ok 127.0.0.1:' + String(port) + ' -> ' + sshHost + ':' + remoteHost + ':' + String(remotePort))
            finish({
              ok: true,
              base: 'http://127.0.0.1:' + String(port),
              child: child,
              port: port,
              close: () => killTunnel(child, master),
            })
            return
          }
          await delay(200)
        }
        finish({ ok: false, reason: 'the forward never answered: ' + stderr.slice(0, 200) })
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
 * Quiet period after a forward answers before the first health probe. A fresh hop needs a
 * moment (key exchange, remote accept queue) and probing it immediately is what made a
 * working tunnel look wedged.
 */
const TUNNEL_GRACE_MS = 1000

/**
 * How long a forward must have stayed up for its loss to count as a fresh failure rather
 * than another round of the same flap. Without this, every rebuild reset the ladder and a
 * tunnel that died one second after coming up retried at the shortest rung forever.
 */
const TUNNEL_STABLE_MS = 30000

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
 * @param options.sshControl - whether every rebuild joins the host's shared ssh master;
 *   only `false` turns multiplexing off.
 * @param options.controlDir - directory holding control sockets; defaults to `DEFAULT_CONTROL_DIR`.
 * @param options.controlPersistSec - seconds the master outlives its client; defaults to `DEFAULT_PERSIST_SEC`.
 * @param options.ladder - backoff ladder in ms.
 * @param options.healthIntervalMs - health cadence; defaults to 1500.
 * @param options.healthFailures - consecutive misses before a rebuild; defaults to 2.
 * @param options.graceMs - quiet period after a forward answers before the first probe; defaults to 1000.
 * @param options.stableMs - how long a forward must have stayed up for its loss to reset the ladder; defaults to 30000.
 * @param options.onRetry - observes each scheduled retry as (waitMs, why); diagnostics and the suite.
 * @returns disposer that stops the ladder and closes the live tunnel.
 */
export function superviseSshTunnel(options) {
  const { sshHost, remoteHost, remotePort, onReady, onLost } = options
  const attempt = typeof options.attempt === 'function' ? options.attempt : attemptSshTunnel
  const probe = typeof options.probe === 'function' ? options.probe : probeTunnel
  // The forward is the master for this host: every rebuild joins the socket the config names,
  // and the cleanup path closes that same socket.
  const control = resolveControl({
    enabled: options.sshControl, dir: options.controlDir, persistSec: options.controlPersistSec,
  })
  const ladder = Array.isArray(options.ladder) && options.ladder.length > 0 ? options.ladder : TUNNEL_BACKOFF_MS
  // Two misses inside five seconds: 1500 + 1500 lands the rebuild near three seconds, which
  // leaves margin under the bound without polling the hop aggressively.
  const healthIntervalMs = Number.isFinite(options.healthIntervalMs) ? options.healthIntervalMs : 1500
  const healthFailures = Number.isFinite(options.healthFailures) ? options.healthFailures : 2
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : TUNNEL_GRACE_MS
  const stableMs = Number.isFinite(options.stableMs) ? options.stableMs : TUNNEL_STABLE_MS
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : undefined
  // Cancels an attempt that is still dialling when this supervisor is disposed: a superseded
  // attempt used to keep its ssh child and its port for up to a readiness timeout.
  const cancellable = new AbortController()
  let disposed = false
  let timer
  let healthTimer
  let current
  let localPort
  let misses = 0
  let failures = 0
  /** When the live forward last answered; measures how long it actually survived. */
  let readyAt
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
    if (onRetry !== undefined) { try { onRetry(wait, String(why)) } catch { /* advisory */ } }
    clearTimeout(timer)
    timer = setTimeout(() => { cycle().catch((error) => { note('ssh tunnel: cycle failed: ' + String(error)) }) }, wait)
    // Waiting for a retry must never hold the process open.
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
  }
  /**
   * Account for one lost forward before scheduling the rebuild.
   *
   * A forward that stayed up counts as a real recovery, so its loss starts the ladder over.
   * One that died moments after it answered is the same flap continuing: keeping `failures`
   * makes the retries climb instead of hammering the hop at the shortest rung forever.
   */
  const noteLoss = () => {
    const stable = readyAt !== undefined && Date.now() - readyAt >= stableMs
    if (stable === true) failures = 0
    readyAt = undefined
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
        noteLoss()
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
      result = await attempt(sshHost, remoteHost, remotePort, localPort, cancellable.signal, { control })
    } catch (error) {
      result = { ok: false, reason: 'the attempt threw: ' + String(error), usedPinnedPort: localPort !== undefined }
    }
    if (disposed === true) {
      if (result.ok === true) { try { result.close() } catch { /* already gone */ } }
      return
    }
    // A cancelled attempt means this supervisor is going away; the disposer owns the cleanup.
    if (result.cancelled === true) return
    if (result.ok !== true) {
      // A pinned port that ssh refused is no good any more; allocate a new one next time.
      if (result.usedPinnedPort === true) {
        note('ssh tunnel: local port ' + String(localPort) + ' is no longer usable; reallocating')
        localPort = undefined
      }
      later(String(result.reason).slice(0, 140))
      return
    }
    misses = 0
    if (typeof result.port === 'number') localPort = result.port
    current = result
    // Not a fresh ladder: an attempt that answers is not proof of a stable forward. noteLoss()
    // resets the ladder once a forward has actually survived (TUNNEL_STABLE_MS).
    readyAt = Date.now()
    try { onReady(result.base) } catch (error) { note('ssh tunnel: onReady failed: ' + String(error)) }
    if (typeof localPort === 'number') {
      const live = result
      healthTimer = setTimeout(() => { void health(live, localPort) }, Math.max(0, graceMs))
      if (healthTimer !== null && healthTimer !== undefined && typeof healthTimer.unref === 'function') healthTimer.unref()
    }
    if (result.child !== undefined) {
      result.child.once('exit', () => {
        if (disposed === true) return
        note('ssh tunnel: ssh exited; the forward is gone')
        stopCurrent()
        noteLoss()
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
    // An attempt still dialling would otherwise keep its child (and its local port) until the
    // readiness timeout: a superseded supervisor must not race the one that replaced it.
    try { cancellable.abort() } catch { /* an unsupported signal cannot cancel */ }
  }
}

/** How long a forward with no mount attached is kept before it is stopped. */
const FORWARD_IDLE_STOP_MS = 30000

/** Live forwards, keyed by host and the remote address behind them. */
const FORWARDS = new Map()

/**
 * One SSH forward per (host, remote address), shared by every mount of it.
 *
 * The plugin is re-applied whenever its entry restarts — a config reload, an HMR pass while
 * the package is being edited, a profile reconcile. A supervisor per activation meant a fresh
 * `freePort()` and a fresh `ssh` child every time: six re-activations in forty milliseconds
 * produced six competing tunnels, "spawn failed" storms and a new upstream port per rebuild,
 * which also broke every socket already pointed at the previous one. The forward belongs to
 * the Host, not to one activation, so it outlives the mount and a re-apply re-attaches to the
 * running tunnel and the same local port. It stops when nothing has attached for
 * `idleStopMs`, which is what keeps a disabled plugin from leaving ssh behind.
 *
 * @param options.sshHost - OpenSSH host alias.
 * @param options.remoteHost - remote listen address.
 * @param options.remotePort - remote listen port.
 * @param options.onReady - receives the local base URL; called immediately when the forward is already up.
 * @param options.onLost - called when the forward stops answering.
 * @param options.sshControl - whether the forward joins the host's shared ssh master.
 * @param options.controlDir - directory holding control sockets; defaults to `DEFAULT_CONTROL_DIR`.
 * @param options.controlPersistSec - seconds the master outlives its client; carried into every attempt.
 * @param options.idleStopMs - how long to keep the forward after the last mount detaches; defaults to 30000.
 * @returns a handle whose `detach()` releases this mount without stopping the forward.
 */
export function sharedSshForward(options) {
  const key = String(options.sshHost) + '|' + String(options.remoteHost) + '|' + String(options.remotePort)
  const idleStopMs = Number.isFinite(options.idleStopMs) ? options.idleStopMs : FORWARD_IDLE_STOP_MS
  let entry = FORWARDS.get(key)
  if (entry === undefined) {
    const created = {
      observers: new Set(),
      base: undefined,
      up: false,
      idleTimer: undefined,
      dispose: undefined,
    }
    created.dispose = superviseSshTunnel({
      ...options,
      onReady: (base) => {
        created.base = base
        created.up = true
        // A throwing observer is one mount's problem, never the shared tunnel's.
        for (const observer of [...created.observers]) {
          try { observer.onReady(base) } catch { /* the next activation still gets the forward */ }
        }
      },
      onLost: () => {
        created.up = false
        for (const observer of [...created.observers]) {
          try { observer.onLost() } catch { /* one bad mount must not disarm the others */ }
        }
      },
    })
    FORWARDS.set(key, created)
    entry = created
  }
  const owner = { onReady: options.onReady, onLost: options.onLost }
  entry.observers.add(owner)
  if (entry.idleTimer !== undefined) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
  // Re-attaching to a live forward must hand the mount its current base at once, or the dial
  // stays blocked until the next health/rebuild event.
  if (entry.up === true && entry.base !== undefined) {
    try { owner.onReady(entry.base) } catch { /* the mount will report the failure itself */ }
  }
  const created = entry
  return {
    detach() {
      created.observers.delete(owner)
      if (created.observers.size > 0 || created.idleTimer !== undefined) return
      created.idleTimer = setTimeout(() => {
        created.idleTimer = undefined
        if (created.observers.size > 0) return
        FORWARDS.delete(key)
        try { created.dispose() } catch { /* already gone */ }
      }, idleStopMs)
      if (created.idleTimer !== null && typeof created.idleTimer.unref === 'function') created.idleTimer.unref()
    },
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
 * Response headers with the hop-by-hop ones removed.
 *
 * Node's HTTP client has already decoded a chunked body and owns the connection framing, so
 * copying `transfer-encoding` or `connection` onward describes framing the caller never
 * receives. The 101 negotiation is the one place those headers are the message itself, and that
 * branch keeps them.
 * @param raw - headers as the upstream response reported them.
 * @returns a copy safe to write toward the caller.
 */
function withoutHopByHop(raw) {
  const headers = {}
  for (const [key, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) !== true) headers[key] = value
  }
  return headers
}

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

// The path and cookie helpers belong to credentials.js (one expansion for the cookie file and
// the trace log); re-exported here because this module is where callers look for them.
export { expandPath, readCookie }

/** Renderer breadcrumbs land here: one JSONL file, rotated once past the cap. */
const TRACE_LOG = '~/.dsh/dsh-remote-host/renderer-trace.log'
const TRACE_LOG_LIMIT = 4 * 1024 * 1024
/** Whether the mounted relay records per-request diagnostics; set when the mount activates. */
let diagnostics = false

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
export function proxyRequest(req, res, dial, authority, cookieFile, options = {}) {
  // Configured to reach the remote only through ssh: while no forward is up there is no
  // hop to dial at all, and silently using the configured upstream would put the traffic
  // back on the very path the tunnel exists to avoid. Answer at once instead of stalling.
  if (dial.blocked === true) {
    note('dial-blocked')
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' })
    res.end('dsh-remote-host: the ssh tunnel is not up; not falling back to the direct route\n')
    return
  }
  // The body is buffered rather than piped: a 401 replay has to send the same bytes again, and a
  // consumed request stream cannot be re-sent. Mount bodies are small JSON envelopes.
  const chunks = []
  const dispatch = () => {
    const cookie = readCookie(cookieFile)
    const headers = forwardedHeaders(req.headers, authority, cookie)
    const body = Buffer.concat(chunks)
    if (body.length > 0) headers['content-length'] = String(body.length)
    if (diagnostics === true) {
      console.log('[dsh-remote-host] proxy ' + (req.method ?? '?') + ' ' + String(req.url ?? '?')
        + ' origin=' + String(req.headers.origin ?? '-')
        + ' sfs=' + String(req.headers['sec-fetch-site'] ?? '-')
        + ' cookie=' + (cookie === undefined ? 'none' : String(cookie.length)))
    }
    const upstreamRequest = httpRequest({
      hostname: dial.hostname,
      port: dial.port,
      path: req.url,
      method: req.method,
      headers,
    }, (upstreamResponse) => {
      const responseHeaders = withoutHopByHop(upstreamResponse.headers)
      if (diagnostics === true) console.log('[dsh-remote-host] proxy upstream ' + String(upstreamResponse.statusCode ?? '?') + ' for ' + String(req.url ?? '?'))
      // A 401 means the credential the proxies read was spent elsewhere (one WebSocket per
      // credential). Exchange it again and replay the buffered request once.
      if (upstreamResponse.statusCode === 401 && options.retried !== true && options.refresh !== undefined) {
        upstreamResponse.resume()
        replayWithFreshCredential({
          refresh: options.refresh,
          retry: () => { options = { ...options, retried: true }; dispatch() },
          fail: () => {
            if (res.writableEnded !== true) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('dsh-remote-host: remote credential expired and could not be refreshed')
            }
          },
        })
        return
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
    if (body.length > 0) upstreamRequest.write(body)
    upstreamRequest.end()
  }
  req.on('data', (chunk) => { chunks.push(chunk) })
  req.on('end', dispatch)
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
export function proxyUpgrade(req, socket, head, dial, authority, cookieFile, options = {}) {
  if (dial.blocked === true) {
    note('dial-blocked')
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain; charset=utf-8\r\nretry-after: 2\r\nconnection: close\r\n\r\nssh tunnel is not up\n')
    try { socket.destroy() } catch { /* already gone */ }
    return
  }

  /**
   * Dial the remote mux once. A 401 means the credential this leg used was spent by another
   * socket (one WebSocket per credential), so exchange a new one and dial again.
   */
  const attempt = (retried) => {
    // The relay keeps its own credential: the proxies read `cookieFile` for HTTP, and a socket
    // that spends it would silently break every request that follows.
    const credentialFile = options.relayFile ?? cookieFile
    const upgradeCookie = readCookie(credentialFile) ?? readCookie(cookieFile)
    if (diagnostics === true) {
      console.log('[dsh-remote-host] upgrade ' + String(req.url ?? '?')
        + ' origin=' + String(req.headers.origin ?? '-')
        + ' sfs=' + String(req.headers['sec-fetch-site'] ?? '-')
        + ' cookie=' + (upgradeCookie === undefined ? 'none' : String(upgradeCookie.length))
        + (retried === true ? ' retried' : ''))
    }
    const headers = forwardedHeaders(req.headers, authority, upgradeCookie)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const upstreamRequest = httpRequest({
      hostname: dial.hostname,
      port: dial.port,
      path: req.url,
      method: req.method,
      headers,
    })
    if (diagnostics === true) {
      upstreamRequest.on('error', (error) => {
        console.log('[dsh-remote-host] upgrade dial failed: ' + String(error))
      })
    }
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      if (diagnostics === true) console.log('[dsh-remote-host] upgrade upstream 101')
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
      if (upstreamResponse.statusCode === 401 && retried !== true && options.refresh !== undefined) {
        upstreamResponse.resume()
        replayWithFreshCredential({
          refresh: options.refresh,
          retry: () => { attempt(true) },
          fail: () => { socket.destroy() },
        })
        return
      }
      if (diagnostics === true) {
        console.log('[dsh-remote-host] upgrade refused upstream ' + String(upstreamResponse.statusCode ?? '?'))
      }
      // A refusal is an ordinary HTTP response, not a negotiated protocol: the hop-by-hop
      // headers describe framing this socket does not keep, and the body node already
      // de-chunked is delimited by the close instead.
      const refusal = withoutHopByHop(upstreamResponse.headers)
      refusal.connection = 'close'
      const lines = ['HTTP/1.1 ' + String(upstreamResponse.statusCode ?? 502) + ' ' + (upstreamResponse.statusMessage ?? '')]
      for (const [key, value] of Object.entries(refusal)) {
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

  // A relay credential that has never been minted would otherwise fall back to the proxies'
  // cookie and spend it, so exchange one first when the mount can mint.
  if (options.relayFile !== undefined && readCookie(options.relayFile) === undefined && options.refresh !== undefined) {
    replayWithFreshCredential({
      refresh: options.refresh,
      retry: () => { attempt(false) },
      // A missing relay credential still tries the proxies' cookie: a relay socket with the
      // shared value is better than no stream at all, and the 401 path re-exchanges.
      fail: () => { attempt(false) },
    })
    return
  }
  attempt(false)
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

function buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket, streamRelay) {
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
  diagnostics = trace
  const globalWebSocket = config?.globalWebSocket !== false
  // Keep remote reconnects out of the plugin's renderer code by default.
  // In mixed mode the local Host owns the remote leg's reconnects.
  const streamRelay = config?.streamRelay !== false
  // Reloading a dsh-app:// document crashes the renderer, so this stays opt-in.
  const selfUpdate = config?.selfUpdate === true
  const attach = config?.attach === 'remote' ? 'remote' : 'merge'
  const superagent = config?.superagent === 'remote' ? 'remote' : 'local'
  const sshHost = typeof config?.sshHost === 'string' && config.sshHost.length > 0 ? config.sshHost : undefined
  // Control multiplexing is on unless a deployment turns it off: the forward becomes the
  // master and every other ssh leg to this host joins its socket. A value that is not a
  // boolean falls back to the default instead of crashing the mount.
  const sshControl = typeof config?.sshControl === 'boolean' ? config.sshControl : true
  // How long the master outlives its client, so a reconnect reuses the authenticated session.
  // 0 asks ssh for the pre-multiplexing behaviour (master dies with the tunnel).
  const controlPersistSec = Number.isFinite(config?.controlPersistSec) && config.controlPersistSec >= 0
    ? Math.floor(config.controlPersistSec)
    : DEFAULT_PERSIST_SEC
  // Positions the socket only; a value that is not a string falls back to the shared short
  // directory that keeps the path inside the platform limit on a unix socket.
  const controlDir = typeof config?.controlDir === 'string' && config.controlDir.length > 0 ? config.controlDir : DEFAULT_CONTROL_DIR
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
    // The forward outlives this activation on purpose: a re-apply re-attaches to the running
    // tunnel and its local port instead of dialling a new one (see sharedSshForward).
    const forward = sharedSshForward({
      sshHost,
      remoteHost: sshRemoteHost,
      remotePort: sshRemotePort,
      sshControl,
      controlDir,
      controlPersistSec,
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
    })
    disposers.push(() => { forward.detach() })
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
  // A `/connect` credential admits exactly one WebSocket, and its peer is revoked when that socket
  // closes — which also ends its HTTP validity. Every outbound socket therefore reads its own
  // credential, so holding a stream open never spends the one the proxies read.
  const muxCookieFile = cookieFile + '.mux'
  // The relay owns a third credential for the same reason: its socket is long-lived, and a spent
  // credential would take the proxies' HTTP access down with it.
  const relayCookieFile = cookieFile + '.relay'
  // Opt-in self-healing: with `credential: { sshHost }` configured, a refused dial re-mints
  // the credential from the remote Host's startup banner instead of leaving the remote dark.
  // The three legs differ only in the file they read.
  const credential = config?.credential
  // A mint joins the same master the forward created, so the settings travel with it.
  const mintOptions = { sshControl, controlDir }
  const refreshProxyCredential = makeRefresher(credential, cookieFile, mintOptions)
  const refreshMuxCredential = makeRefresher(credential, muxCookieFile, mintOptions)
  const refreshRelayCredential = makeRefresher(credential, relayCookieFile, mintOptions)
  const upgradeCredentials = { relayFile: relayCookieFile, refresh: refreshRelayCredential }
  /**
   * Dial the remote stream mux once per consumer.
   *
   * The same dialer feeds both transports: the byte relay for pages that can open a
   * WebSocket, and the frame pump for the desktop page, whose custom scheme cannot.
   * @returns A connecting remote socket, or undefined while the dial is blocked.
   */
  const connectRemoteMux = () => {
    if (dial.blocked) return undefined
    const hostname = dial.hostname.includes(':') && !dial.hostname.startsWith('[') ? '[' + dial.hostname + ']' : dial.hostname
    const url = (dial.secure ? 'wss://' : 'ws://') + hostname + ':' + dial.port + '/api/remote.mux'
    const cookie = readCookie(muxCookieFile) ?? readCookie(cookieFile)
    if (diagnostics === true) {
      console.log('[dsh-remote-host] mux dial ' + url + ' cookie=' + (cookie === undefined ? 'none' : String(cookie.length)))
    }
    return new WebSocket(url, {
      headers: cookie === undefined ? { host: authority } : { host: authority, cookie },
      handshakeTimeout: upstreamTimeoutMs,
      perMessageDeflate: false,
    })
  }
  // One exchange at a time: the mount and the relay's first retry ask for the same value while the
  // stored one is already spent, and two concurrent exchanges would overwrite each other.
  let muxExchange
  const exchangeMuxCredential = () => {
    if (muxExchange !== undefined) return muxExchange
    const settle = () => { muxExchange = undefined }
    muxExchange = Promise.resolve().then(() => refreshMuxCredential()).then((result) => {
      settle()
      return result
    }, (error) => {
      settle()
      throw error
    })
    return muxExchange
  }
  // The mux relay's socket is long-lived, so its credential is exchanged at mount instead of
  // lazily: a missing file would otherwise fall back to the proxies' credential and spend it. The
  // exchange is unconditional because the remote admits one socket per credential, which makes a
  // stored value unusable after the socket that spent it closed — not only while it is missing.
  if (refreshMuxCredential !== undefined) {
    exchangeMuxCredential().catch((error) => {
      console.log('[dsh-remote-host] credential refresh failed: ' + String(error).slice(0, 200))
    })
  }
  // The relay owns the credential exchange: a refused handshake spent the value this leg read, so
  // it exchanges before the retry instead of dialing the same spent value again.
  const relay = streams && streamRelay && attach === 'merge'
    ? createRemoteMuxRelay(connectRemoteMux, {
      log: (line) => { if (diagnostics === true) console.log('[dsh-remote-host] ' + line) },
      refresh: refreshMuxCredential === undefined ? undefined : exchangeMuxCredential,
    })
    : undefined
  if (relay !== undefined) disposers.push(() => relay.dispose())
  /** Page-side endpoints the mount answers itself, outside the remote proxy. */
  const page = {
    blockCss: () => readFileSync(join(HERE, '..', 'src', 'client', 'block', 'block.css'), 'utf8'),
    revision: shimRevision,
    trace: { enabled: trace === true, bodyLimit: TRACE_BODY_LIMIT, append: appendTraceLines },
    report: () => report,
    setReport: (value) => { report = value },
  }
  const routes = createRouteHandlers({
    dial,
    authority,
    credentials: { cookieFile, proxyRefresh: refreshProxyCredential, upgrade: upgradeCredentials },
    admit,
    mount,
    log: (line) => { if (diagnostics === true) console.log('[dsh-remote-host] ' + line) },
    proxies: { request: proxyRequest, upgrade: proxyUpgrade },
    relay,
    page,
  })
  mountReady = safe('http mount', () => webServer.register({
    kind: 'prefix',
    path: mount,
    // Loopback-only mount carrying the remote's credential; the handler keeps its own admission
    // check. Anonymous does not bypass the Host/Origin trust fence that runs before it.
    auth: 'anonymous',
    handler: routes.mountHttp,
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
      handler: routes.orchestratorApi,
    }))
    safe('orchestrator stream proxy', () => webServer.registerUpgrade({
      path: '/orchestrator',
      handler: routes.orchestratorUpgrade,
    }))
  }
  safe('stream mount', () => webServer.registerUpgrade({
    path: mount + '/api/remote.mux',
    // Loopback-only mount that relays with the remote's own credential, so the route does not
    // demand a local Peer of its own. This does NOT make the route reachable from the renderer:
    // the Host/Origin trust fence runs before any policy and refuses a custom-scheme origin.
    auth: 'anonymous',
    handler: routes.streamMountUpgrade,
  }))
  if (relay !== undefined) {
    safe('host mux relay', () => webServer.registerUpgrade({
      path: mount + '/__dsh_remote_host__/mux',
      // Same fence as the stream mount: the page origin cannot match the Host authority, so the
      // route opts out of the upgrade policy and relies on the admission check inside.
      auth: 'anonymous',
      handler: routes.muxUpgrade,
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
        table.push({ kind: 'script', placement: 'head', text: buildShimScript(mount, label, windowDays, streams, sections, attach, superagent, sectionHeaders, selfUpdate, group, remoteBlock, trace, globalWebSocket, streamRelay) })
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
