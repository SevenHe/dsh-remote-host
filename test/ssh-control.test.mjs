/**
 * The shared-transport vocabulary: the socket name, the join options and the exit request.
 *
 * These are the strings every ssh caller has to agree on — a caller that names the socket
 * differently is not multiplexed, it is a second connection that happens to look similar.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  controlArgs, controlPathFor, DEFAULT_CONTROL_DIR, DEFAULT_PERSIST_SEC, ensureControlDir, exitArgs, instanceTag, sweepControlSocket,
} from '../lib/ssh-control.js'

test('control: the socket name is derived from the host, and stays inside the directory', () => {
  assert.equal(controlPathFor('/tmp/drh', 'devbox'), '/tmp/drh/cm-devbox')
  // An alias from ~/.ssh/config is user input; it must not steer the path.
  assert.equal(controlPathFor('/tmp/drh', '../../etc/passwd'), '/tmp/drh/cm-.._.._etc_passwd')
  assert.equal(controlPathFor('/tmp/drh', ''), '/tmp/drh/cm-host')
})

test('control: a long alias is truncated, so the socket path stays under the platform limit', () => {
  const path = controlPathFor(DEFAULT_CONTROL_DIR, 'a'.repeat(200))
  // macOS caps sun_path at 104 bytes; the path has to leave room for the template ssh adds.
  assert.ok(path.length < 100, 'socket path is too long: ' + String(path.length))
  assert.ok(DEFAULT_CONTROL_DIR.length < 40, 'default directory leaves no room for the name')
})

test('control: the join options name the socket and bound how long the master outlives its client', () => {
  assert.deepEqual(controlArgs({ enabled: true, dir: '/tmp/drh', host: 'devbox' }), [
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=/tmp/drh/cm-devbox',
    '-o', 'ControlPersist=' + String(DEFAULT_PERSIST_SEC),
  ])
})

test('control: the persistence window is the caller\'s to set, and zero restores the old lifetime', () => {
  const persist = (persistSec) => controlArgs({ enabled: true, dir: '/tmp/drh', host: 'devbox', persistSec }).slice(-1)[0]
  assert.equal(persist(0), 'ControlPersist=no', 'a zero window keeps the master tied to its client')
  assert.equal(persist(45), 'ControlPersist=45', 'a reconnect inside the window reuses the session')
  // A fractional or negative value must not reach ssh as a malformed option.
  assert.equal(persist(-5), 'ControlPersist=' + String(DEFAULT_PERSIST_SEC))
  assert.equal(persist(1.9), 'ControlPersist=1')
})

test('control: a socket whose master is gone is cleared before the next master claims the path', () => {
  const removed = []
  const remove = (path) => { removed.push(path) }
  const exists = () => true
  assert.equal(sweepControlSocket({ path: '/tmp/drh/cm-devbox', alive: true, exists, remove }), 'kept')
  assert.deepEqual(removed, [], 'a live master keeps its socket')
  assert.equal(sweepControlSocket({ path: '/tmp/drh/cm-devbox', alive: false, exists, remove }), 'removed')
  assert.deepEqual(removed, ['/tmp/drh/cm-devbox'], 'a corpse is cleared exactly once')
  assert.equal(sweepControlSocket({ path: '/tmp/drh/cm-devbox', alive: false, exists: () => false, remove }), 'absent')
  // A socket that cannot be removed is reported rather than silently treated as cleared.
  assert.equal(sweepControlSocket({ path: '/tmp/drh/cm-devbox', alive: false, exists, remove: () => { throw new Error('EBUSY') } }), 'stuck')
  assert.equal(sweepControlSocket({}), 'absent')
})

test('control: disabled means no options at all, so the argv is the pre-existing one', () => {
  assert.deepEqual(controlArgs({ enabled: false, dir: '/tmp/drh', host: 'devbox' }), [])
  assert.deepEqual(controlArgs({}), [])
  assert.deepEqual(controlArgs(undefined), [])
})

test('control: the exit request addresses the same socket the join options used', () => {
  const joinArgs = controlArgs({ enabled: true, dir: '/tmp/drh', host: 'devbox' })
  const socket = joinArgs[joinArgs.indexOf('-o', 1) + 1]
  assert.deepEqual(exitArgs({ dir: '/tmp/drh', host: 'devbox' }), ['-O', 'exit', '-o', socket, 'devbox'])
})

test('control: an exit request without a host is empty rather than a call to ssh', () => {
  assert.deepEqual(exitArgs({ dir: '/tmp/drh', host: '' }), [])
  assert.deepEqual(exitArgs({ dir: '/tmp/drh' }), [])
})

test('control: the directory is created private, and creating it twice is harmless', () => {
  const root = mkdtempSync(join(tmpdir(), 'drh-control-test-'))
  try {
    const dir = join(root, 'nested', 'sockets')
    assert.equal(ensureControlDir(dir), true)
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'a control socket is a credential; keep it private')
    assert.equal(ensureControlDir(dir), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('control: a directory that cannot be created only costs the optimisation', () => {
  // /dev/null is a file: every mkdir under it fails, which is the shape of a read-only tmp.
  assert.equal(ensureControlDir('/dev/null/nope'), false)
})
test('control: a socket name carries the installation tag, so two installations never share one', () => {
  const tag = instanceTag('/Users/me/.dsh')
  assert.match(tag, /^[0-9a-f]{8}$/, 'the tag is short and filename-safe: ' + tag)
  assert.equal(instanceTag('/Users/me/.dsh'), tag, 'the tag is stable for one installation')
  assert.notEqual(instanceTag('/tmp/dsh-rh-lab'), tag, 'a lab profile gets its own socket')
  assert.equal(controlPathFor('/tmp/drh', 'devbox', tag), '/tmp/drh/cm-devbox-' + tag)
  // The socket path still has to respect the platform limit with a tag on it.
  assert.ok(controlPathFor(DEFAULT_CONTROL_DIR, 'h'.repeat(200), tag).length < 100)
  assert.equal(exitArgs({ dir: '/tmp/drh', host: 'devbox', tag })[3], 'ControlPath=/tmp/drh/cm-devbox-' + tag, 'cleanup addresses the tagged socket too')
})
