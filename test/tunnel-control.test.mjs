/**
 * The forward's share of the shared ssh transport.
 *
 * The long-lived `ssh -N -L` is the first connection to a host, so it becomes the control
 * master every later leg joins; cleanup has to close that same socket instead of only
 * signalling the client. These cases drive `attemptSshTunnel` and `killTunnel` through their
 * injected spawn, so nothing here dials ssh or the network.
 *
 * Expected argv comes from `controlArgs`/`exitArgs` in lib/ssh-control.js. Hardcoding the
 * flag strings here as well would let a caller that addresses a different socket pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { attemptSshTunnel, killTunnel } from '../lib/index.js'
import { controlArgs, exitArgs } from '../lib/ssh-control.js'

/** Resolve after one macrotask turn, so a spawned helper can report back. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** A short-lived directory for sockets; the caller removes it. */
const socketRoot = () => mkdtempSync(join(tmpdir(), 'drh-tunnel-control-'))

/** The ssh child a stand-in attempt hands back; records the signals it receives. */
function tunnelChild(record = {}) {
  return {
    // No pid: killTunnel then signals this child itself instead of a process group.
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stderr: { on() {} },
    on() {},
    once() {},
    kill(signal) { record.signals = [...(record.signals ?? []), signal] },
  }
}

/** A stand-in for the short-lived `ssh -O exit` helper. */
function exitHelper(record) {
  return {
    once(event, handler) { if (event === 'exit') queueMicrotask(() => handler(record.code ?? 255, null)) },
    kill(signal) { record.killed = signal },
  }
}

test('forward: the ssh argv joins the host master when control is on', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const calls = []
  const spawn = (command, args) => {
    calls.push({ command, args, dirExisted: existsSync(dir) })
    return tunnelChild()
  }
  try {
    const result = await attemptSshTunnel('devbox', '127.0.0.1', 3080, 41600, undefined, {
      spawn,
      probeLoopback: () => Promise.resolve(true),
      probeTunnel: () => Promise.resolve(true),
      control: { enabled: true, dir },
    })
    assert.equal(result.ok, true, 'the injected probes report a working forward')
    const tunnel = calls[0]
    assert.equal(tunnel.command, 'ssh')
    const expected = controlArgs({ enabled: true, dir, host: 'devbox' })
    const at = tunnel.args.findIndex((value, index) => value === expected[0] && tunnel.args[index + 1] === expected[1])
    assert.ok(at >= 0, 'the argv must carry the control options: ' + JSON.stringify(tunnel.args))
    assert.deepEqual(tunnel.args.slice(at, at + expected.length), expected)
    // The forward itself is untouched: the same local -L target, and the host stays last.
    assert.ok(tunnel.args.includes('127.0.0.1:41600:127.0.0.1:3080'), 'the -L forward must keep its target')
    assert.equal(tunnel.args[tunnel.args.length - 1], 'devbox', 'the host alias stays the last argv element')
    assert.equal(tunnel.dirExisted, true, 'the socket directory must exist before ssh starts')
    result.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forward: control off leaves the pre-existing ssh argv', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const calls = []
  const spawn = (command, args) => {
    calls.push({ command, args })
    return tunnelChild({})
  }
  try {
    const result = await attemptSshTunnel('devbox', '127.0.0.1', 3080, 41601, undefined, {
      spawn,
      probeLoopback: () => Promise.resolve(true),
      probeTunnel: () => Promise.resolve(true),
      control: { enabled: false, dir },
    })
    assert.equal(result.ok, true)
    const argv = calls[0].args
    assert.ok(argv.every((value) => String(value).startsWith('Control') === false), 'no control option may join a disabled forward: ' + JSON.stringify(argv))
    assert.equal(existsSync(dir), false, 'a disabled forward must not create a socket directory')
    result.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forward: the socket directory is created before ssh starts', async () => {
  const root = socketRoot()
  const dir = join(root, 'not', 'created', 'yet')
  const seen = []
  const spawn = () => {
    seen.push(existsSync(dir))
    return tunnelChild({})
  }
  try {
    assert.equal(existsSync(dir), false, 'the directory starts absent')
    const result = await attemptSshTunnel('devbox', '127.0.0.1', 3080, 41602, undefined, {
      spawn,
      probeLoopback: () => Promise.resolve(true),
      probeTunnel: () => Promise.resolve(true),
      control: { enabled: true, dir },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(seen, [true], 'ssh must never be asked to create the socket directory')
    assert.equal(existsSync(dir), true, 'the directory exists once the forward is up')
    result.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup: the master is asked to exit before the tunnel is signalled', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const order = []
  const requested = []
  const polite = exitHelper({})
  const spawn = (command, args) => {
    requested.push(args)
    order.push('exit-request')
    return polite
  }
  const child = {
    pid: undefined,
    stderr: { on() {} },
    on() {},
    once() {},
    kill(signal) { order.push('signal:' + signal) },
  }
  try {
    killTunnel(child, { enabled: true, dir, host: 'devbox', spawn })
    await tick(5)
    assert.deepEqual(requested, [exitArgs({ dir, host: 'devbox' })], 'the request must address the socket the forward joined')
    assert.deepEqual(order.slice(0, 2), ['exit-request', 'signal:SIGTERM'], 'the polite request comes first, the signal still follows: ' + JSON.stringify(order))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup: a failed exit request still escalates to a signal', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const record = {}
  const child = tunnelChild(record)
  try {
    killTunnel(child, { enabled: true, dir, host: 'devbox', spawn: () => exitHelper({ code: 255 }) })
    await tick(5)
    assert.deepEqual(record.signals, ['SIGTERM'], 'a master that refuses to exit must still be signalled')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup: an exit request that cannot start still escalates to a signal', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const record = {}
  const child = tunnelChild(record)
  try {
    killTunnel(child, { enabled: true, dir, host: 'devbox', spawn: () => { throw new Error('spawn ssh ENOENT') } })
    assert.deepEqual(record.signals, ['SIGTERM'], 'a missing ssh must not stop the cleanup')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup: without control settings no helper process is spawned', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const record = {}
  const child = tunnelChild(record)
  const spawn = () => { throw new Error('no exit request may be issued without control settings') }
  try {
    killTunnel(child)
    killTunnel(child, { enabled: false, dir, host: 'devbox', spawn })
    assert.deepEqual(record.signals, ['SIGTERM', 'SIGTERM'], 'the pre-existing signal-only cleanup is unchanged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('forward: an attempt whose port never answers still resolves with a reason', async () => {
  const root = socketRoot()
  const dir = join(root, 'sockets')
  const record = {}
  const controller = new AbortController()
  const pending = attemptSshTunnel('devbox', '127.0.0.1', 3080, 41603, controller.signal, {
    spawn: () => tunnelChild(record),
    probeLoopback: () => Promise.resolve(true),
    probeTunnel: () => Promise.resolve(false),
    control: { enabled: true, dir, spawn: () => exitHelper({}) },
  })
  try {
    await tick(20)
    controller.abort()
    const result = await pending
    assert.equal(result.ok, false, 'a forward that carries nothing is not up')
    assert.equal(typeof result.reason, 'string', 'a failed attempt always explains itself')
    assert.ok(result.reason.length > 0, 'the reason must not be empty')
    assert.equal(result.cancelled, true, 'the cancelled attempt reports the cancellation')
    assert.deepEqual(record.signals, ['SIGTERM'], 'the cancelled attempt reaps its ssh child')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
