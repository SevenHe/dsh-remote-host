/**
 * The shared ssh master, driven end to end.
 *
 * Every ssh this plugin starts for a host must join one OpenSSH master over a control
 * socket in a directory the plugin creates with mode 0700, and that master must die with
 * the forward. No SSH server is involved: a stand-in ssh first on PATH records every argv
 * and emulates OpenSSH far enough for the shipped readiness probe, the control socket and
 * the exit request to run unmodified. Everything below stays on loopback; no real host
 * alias is dialled and nothing leaves the machine.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after, before } from 'node:test'
import { readEntryUrl } from '../lib/credential-mint.js'
import { superviseSshTunnel } from '../lib/index.js'
import { controlPathFor } from '../lib/ssh-control.js'

/** PATH before this file put the stand-in ssh first. */
const ORIGINAL_PATH = String(process.env.PATH)

/** A host alias that resolves nowhere; the stand-in ssh answers every call. */
const HOST = 'fakehost'

/**
 * The stand-in ssh.
 *
 * It records one JSON line per invocation, then behaves as OpenSSH would for the argv it
 * was given: a forward becomes the master (it binds the local port, answers the readiness
 * probe, and holds the control socket at ControlPath), -O exit asks that master to stop,
 * and a one-shot remote command answers with a Host banner. Every process exits on
 * SIGTERM, so a leftover process cannot outlive a case unnoticed.
 */
const FAKE_SSH_SOURCE = [
  "import { appendFileSync, unlinkSync } from 'node:fs'",
  "import { connect, createServer } from 'node:net'",
  '',
  'const argv = process.argv.slice(2)',
  "appendFileSync(process.env.DRH_FAKE_SSH_LOG, JSON.stringify({ argv, pid: process.pid, ppid: process.ppid }) + '\\n')",
  '',
  '/** Value of an -o Name=value pair, or undefined. */',
  'const optionValue = (name) => {',
  '  for (let index = 0; index + 1 < argv.length; index += 1) {',
  "    if (argv[index] !== '-o') continue",
  '    const value = argv[index + 1]',
  "    if (typeof value === 'string' && value.startsWith(name + '=')) return value.slice(name.length + 1)",
  '  }',
  '  return undefined',
  '}',
  '',
  "const controlPath = optionValue('ControlPath')",
  "const oIndex = argv.indexOf('-O')",
  'const oWhat = oIndex >= 0 ? argv[oIndex + 1] : undefined',
  '',
  '/** Drive the master the way the -O client does: over its control socket. */',
  'const askMaster = (payload, onOk, onFail) => {',
  "  if (typeof controlPath !== 'string') return onFail()",
  '  const socket = connect({ path: controlPath })',
  "  socket.on('connect', () => { socket.end(payload + '\\n'); onOk() })",
  "  socket.on('error', () => onFail())",
  '}',
  '',
  '/** The forward spec of an -L flag, written either as two argv entries or attached. */',
  'const forwardSpec = () => {',
  "  const index = argv.indexOf('-L')",
  "  if (index >= 0 && typeof argv[index + 1] === 'string') return argv[index + 1]",
  "  const attached = argv.find((arg) => arg.startsWith('-L') && arg.length > 2)",
  '  return attached === undefined ? undefined : attached.slice(2)',
  '}',
  '',
  '/** Leave nothing behind: close the listeners and remove the control socket. */',
  'const cleanup = (servers) => {',
  '  for (const server of servers) { try { server.close() } catch { /* already closed */ } }',
  "  if (typeof controlPath === 'string') { try { unlinkSync(controlPath) } catch { /* already gone */ } }",
  '}',
  '',
  "if (oWhat === 'exit') {",
  "  askMaster('exit', () => process.exit(0), () => process.exit(0))",
  "} else if (oWhat === 'check') {",
  "  askMaster('check', () => process.exit(0), () => process.exit(255))",
  "} else if (typeof forwardSpec() === 'string') {",
  "  const parts = forwardSpec().split(':')",
  '  const localPort = Number(parts[parts.length - 3])',
  '  const servers = []',
  '  const tunnel = createServer((socket) => {',
  "    socket.once('data', () => {",
  "      socket.end('HTTP/1.1 200 OK\\r\\ncontent-type: text/plain\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok')",
  '    })',
  "    socket.on('error', () => {})",
  '  })',
  '  servers.push(tunnel)',
  "  tunnel.on('error', () => process.exit(97))",
  "  tunnel.listen(localPort, '127.0.0.1', () => {",
  "    if (typeof controlPath !== 'string') return",
  '    const control = createServer((socket) => {',
  "      socket.on('data', (chunk) => {",
  "        if (!String(chunk).includes('exit')) return",
  '        cleanup(servers)',
  '        process.exit(0)',
  '      })',
  "      socket.on('error', () => {})",
  '    })',
  '    servers.push(control)',
  "    control.on('error', () => {})",
  '    control.listen(controlPath)',
  '  })',
  "  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {",
  "    process.on(signal, () => { cleanup(servers); process.exit(0) })",
  '  }',
  '} else {',
  "  process.stdout.write('dsh web: http://127.0.0.1:3080/?token=integration-token\\n')",
  '  process.exit(0)',
  '}',
].join('\n') + '\n'

/** Directory holding the stand-in ssh, created once for the file. */
let fakeSshDir = ''

before(() => {
  fakeSshDir = mkdtempSync(join(tmpdir(), 'drh-fake-ssh-'))
  writeFileSync(join(fakeSshDir, 'fake-ssh.mjs'), FAKE_SSH_SOURCE)
  writeFileSync(
    join(fakeSshDir, 'ssh'),
    '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(fakeSshDir, 'fake-ssh.mjs')) + ' "$@"\n',
    { mode: 0o755 },
  )
  chmodSync(join(fakeSshDir, 'ssh'), 0o755)
  process.env.PATH = fakeSshDir + ':' + ORIGINAL_PATH
})

after(() => {
  process.env.PATH = ORIGINAL_PATH
  if (fakeSshDir !== '') rmSync(fakeSshDir, { recursive: true, force: true })
})

/**
 * Poll until probe answers truthy; a hard deadline keeps a stuck case from hanging.
 *
 * Eight seconds, not three: every wait here races a spawned stand-in ssh plus a real port bind,
 * and under parallel suite load (or on a busy machine) three seconds turned a passing case into
 * a flake rather than a failure.
 */
async function waitFor(label, probe, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out after ' + String(timeoutMs) + 'ms waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Whether a recorded process is still running (ESRCH means the process is gone). */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Value of an -o Name=value pair in a recorded argv, or undefined. */
function optionValue(argv, name) {
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === '-o' && String(argv[index + 1]).startsWith(name + '=')) return argv[index + 1].slice(name.length + 1)
  }
  return undefined
}

/** The recorded invocations, oldest first, capped so a failure report stays readable. */
function evidence(entries) {
  if (entries.length === 0) return '\nrecorded ssh invocations: (none)'
  const lines = entries.slice(0, 20).map((entry) => '  ssh ' + entry.argv.join(' '))
  return '\nrecorded ssh invocations (up to 20):\n' + lines.join('\n')
}

/**
 * One case's private sandbox: a temp root, a control directory the plugin has to create,
 * and the ssh log the stand-in writes.
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'drh-ssh-it-'))
  const logFile = join(root, 'ssh.jsonl')
  const controlDir = join(root, 'nested', 'sockets')
  process.env.DRH_FAKE_SSH_LOG = logFile
  const invoke = () => {
    if (!existsSync(logFile)) return []
    return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.length > 0).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }
  return { root, logFile, controlDir, invoke }
}

/** Start the shipped supervisor and wait until it reports the forward ready. */
async function startTunnel(world, options = {}) {
  const ready = []
  const dispose = superviseSshTunnel({
    sshHost: HOST,
    remoteHost: '127.0.0.1',
    remotePort: 3080,
    sshControl: options.sshControl ?? true,
    controlDir: world.controlDir,
    ladder: [50],
    healthIntervalMs: 100000,
    onReady: (base) => ready.push(base),
    onLost: () => {},
    onRetry: () => {},
  })
  await waitFor('the forward to report ready', () => ready.length > 0)
  return { dispose, base: ready[0] }
}

/** Stop the supervisor, then leave nothing behind: no child and no temp tree. */
async function cleanup(world, dispose) {
  try {
    if (typeof dispose === 'function') dispose()
  } catch {
    // The supervisor already stopped; cleanup still has to finish.
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const entry of world.invoke()) {
    if (!alive(entry.pid)) continue
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      // It exited between the check and the signal.
    }
  }
  rmSync(world.root, { recursive: true, force: true })
}

test('ssh control: one master carries the shared control options', { timeout: 10000 }, async () => {
  const world = sandbox()
  let dispose
  try {
    ({ dispose } = await startTunnel(world))
    const recorded = world.invoke()
    const shown = evidence(recorded)
    const forwards = recorded.filter((entry) => entry.argv.includes('-N') || entry.argv.includes('-L'))
    assert.equal(forwards.length, 1, 'exactly one ssh may open the forward' + shown)
    const argv = forwards[0].argv
    assert.ok(argv.includes(HOST), 'the forward names the host alias' + shown)
    assert.equal(optionValue(argv, 'ControlMaster'), 'auto', 'the forward is the master' + shown)
    const socket = optionValue(argv, 'ControlPath')
    assert.equal(typeof socket, 'string', 'the forward carries a control socket path' + shown)
    assert.equal(socket, controlPathFor(world.controlDir, HOST), 'the socket is the deterministic path for this host' + shown)
    assert.equal(dirname(socket), world.controlDir, 'the socket lives in the plugin control directory' + shown)
    // Persistence is deliberate and BOUNDED: the master must survive long enough for a
    // reconnect to reuse the authenticated session, and no longer.
    const persist = optionValue(argv, 'ControlPersist')
    assert.match(String(persist), /^[0-9]+$/, 'the master persists for a configured number of seconds' + shown)
    assert.ok(Number(persist) > 0, 'a zero window would defeat the point: reuse on reconnect' + shown)
    assert.ok(Number(persist) <= 3600, 'an unbounded window would leave a master behind for good' + shown)
  } finally {
    await cleanup(world, dispose)
  }
})

test('ssh control: the control directory is private', { timeout: 10000 }, async () => {
  const world = sandbox()
  let dispose
  try {
    ({ dispose } = await startTunnel(world))
    assert.equal(existsSync(world.controlDir), true, 'the plugin creates the control directory it hands to ssh')
    assert.equal(statSync(world.controlDir).mode & 0o777, 0o700, 'a control socket is a credential: mode 0700')
  } finally {
    await cleanup(world, dispose)
  }
})

test('ssh control: a credential mint joins the live master instead of dialling again', { timeout: 10000 }, async () => {
  const world = sandbox()
  let dispose
  try {
    ({ dispose } = await startTunnel(world))
    const forward = world.invoke().find((entry) => entry.argv.includes('-N'))
    const socket = optionValue(forward.argv, 'ControlPath')
    assert.equal(typeof socket, 'string', 'the forward published a control path')
    const before = world.invoke().length
    await readEntryUrl({ sshHost: HOST, tmuxSession: 'dsh-main', sshControl: true, controlDir: world.controlDir })
    const recorded = world.invoke()
    const added = recorded.slice(before)
    const shown = evidence(recorded)
    assert.equal(added.length, 1, 'the mint is one more ssh invocation' + shown)
    assert.equal(optionValue(added[0].argv, 'ControlPath'), socket, 'the mint addresses the same socket as the forward' + shown)
    assert.equal(optionValue(added[0].argv, 'ControlMaster'), 'auto', 'the mint joins the shared master' + shown)
    const forwards = recorded.filter((entry) => entry.argv.includes('-N') || entry.argv.includes('-L'))
    assert.equal(forwards.length, 1, 'the mint must not open a second forward' + shown)
  } finally {
    await cleanup(world, dispose)
  }
})

test('ssh control: disposing the tunnel closes the master and leaves no ssh behind', { timeout: 12000 }, async () => {
  const world = sandbox()
  let dispose
  try {
    const started = await startTunnel(world)
    dispose = started.dispose
    const socket = controlPathFor(world.controlDir, HOST)
    const forward = world.invoke().find((entry) => entry.argv.includes('-N'))
    await waitFor('the master to create its control socket', () => existsSync(socket))
    dispose()
    dispose = undefined
    await waitFor('the exit request to the master', () => world.invoke().some((entry) => entry.argv.includes('-O') && entry.argv.includes('exit')))
    const recorded = world.invoke()
    const shown = evidence(recorded)
    const exitRequests = recorded.filter((entry) => entry.argv.includes('-O') && entry.argv.includes('exit'))
    assert.ok(exitRequests.length >= 1, 'the tunnel asks the master to exit' + shown)
    for (const request of exitRequests) {
      assert.equal(optionValue(request.argv, 'ControlPath'), socket, 'the exit request addresses the same socket' + shown)
      assert.ok(request.argv.includes(HOST), 'the exit request names the host' + shown)
    }
    await waitFor('the control socket to disappear', () => !existsSync(socket))
    await waitFor('every ssh child to exit', () => world.invoke().every((entry) => !alive(entry.pid)))
    const survivors = world.invoke().filter((entry) => alive(entry.pid)).map((entry) => String(entry.pid) + ': ' + entry.argv.join(' '))
    assert.deepEqual(survivors, [], 'no ssh process for this host may outlive the tunnel' + shown)
    assert.equal(existsSync(socket), false, 'the control socket must be gone' + shown)
  } finally {
    await cleanup(world, dispose)
  }
})

test('ssh control: disabling multiplexing restores the plain ssh argv', { timeout: 10000 }, async () => {
  const world = sandbox()
  let dispose
  try {
    ({ dispose } = await startTunnel(world, { sshControl: false }))
    await readEntryUrl({ sshHost: HOST, tmuxSession: 'dsh-main', sshControl: false, controlDir: world.controlDir })
    const recorded = world.invoke()
    const shown = evidence(recorded)
    const options = recorded.flatMap((entry) => entry.argv.filter((arg) => /^Control(Master|Path|Persist)=/.test(arg)))
    assert.deepEqual(options, [], 'no argv may carry control options when the feature is off' + shown)
    assert.equal(recorded.some((entry) => entry.argv.includes('-O')), false, 'nothing was shared, so nothing may be asked to exit' + shown)
    assert.equal(existsSync(controlPathFor(world.controlDir, HOST)), false, 'a disabled run creates no control socket' + shown)
  } finally {
    await cleanup(world, dispose)
  }
})
