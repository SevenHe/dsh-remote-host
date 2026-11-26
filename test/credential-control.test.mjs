/** The mint's ssh transport: it joins the control socket the forward already opened. */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { sshMintArgs } from '../lib/credential-mint.js'
import { makeRefresher } from '../lib/credentials.js'
import { controlArgs, controlPathFor, DEFAULT_CONTROL_DIR, exitArgs } from '../lib/ssh-control.js'

/** A banner read's remote command, as `readEntryUrl` builds it. */
const COMMAND = "tmux capture-pane -p -S -4000 -t 'dsh-main' 2>/dev/null"

/** The argv a mint used before multiplexing existed: what a disabled mint must still produce. */
const LEGACY = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', 'devbox', COMMAND]

/** A control directory that is not the default, so a wrong default cannot pass unnoticed. */
const DIR = join(tmpdir(), 'drh-mint-control-test')

/** The socket path the mint's argv hands to OpenSSH. */
function socketOf(args) {
  const entry = args.find((arg) => typeof arg === 'string' && arg.startsWith('ControlPath='))
  assert.ok(entry !== undefined, 'the mint names a control socket: ' + JSON.stringify(args))
  return entry.slice('ControlPath='.length)
}

test('credential mint: the mint joins the control socket the forward opens for the same host', () => {
  const args = sshMintArgs({ sshHost: 'devbox', controlDir: DIR, command: COMMAND })

  assert.equal(socketOf(args), controlPathFor(DIR, 'devbox'), 'one host and directory mean one socket')
  const forward = controlArgs({ enabled: true, dir: DIR, host: 'devbox' })
  const hostAt = args.indexOf('devbox')
  assert.deepEqual(args.slice(hostAt - forward.length, hostAt), forward, 'the mint appends exactly the forward options, in order')
  assert.equal(args.includes('ControlMaster=auto'), true, 'the first caller may create the master, later ones reuse it')
  assert.equal(args.includes('ControlPersist=no'), true, 'a mint must not outlive the forward')
})

test('credential mint: cleanup addresses the socket the mint joined', () => {
  const args = sshMintArgs({ sshHost: 'devbox', controlDir: DIR, command: COMMAND })
  const cleanup = exitArgs({ dir: DIR, host: 'devbox' })

  assert.equal(cleanup.includes('ControlPath=' + socketOf(args)), true, 'ssh -O exit names the same path: ' + JSON.stringify(cleanup))
})

test('credential mint: with multiplexing off the argv is the pre-existing one', () => {
  const args = sshMintArgs({ sshHost: 'devbox', sshControl: false, controlDir: DIR, command: COMMAND })

  assert.deepEqual(args, LEGACY, 'nothing but the old handshake: ' + JSON.stringify(args))
})

test('credential mint: multiplexing is on by default, against the shared control directory', () => {
  const args = sshMintArgs({ sshHost: 'devbox', command: COMMAND })

  assert.equal(socketOf(args), controlPathFor(DEFAULT_CONTROL_DIR, 'devbox'), 'an unconfigured mint uses the shared directory')
})

test('credential mint: a malformed control setting falls back to the default', () => {
  // Config parsing normalizes these, but a mint must never throw on a value that reached it.
  for (const controlDir of [undefined, '', 42, null]) {
    const args = sshMintArgs({ sshHost: 'devbox', controlDir, command: COMMAND })
    assert.equal(socketOf(args), controlPathFor(DEFAULT_CONTROL_DIR, 'devbox'), 'controlDir ' + String(controlDir) + ' uses the shared directory')
  }
  const enabled = sshMintArgs({ sshHost: 'devbox', sshControl: 'no', controlDir: DIR, command: COMMAND })
  assert.equal(socketOf(enabled), controlPathFor(DIR, 'devbox'), 'only the boolean false turns multiplexing off')
})

test('credential mint: the mint stays non-interactive and bounded, with the command last', () => {
  const args = sshMintArgs({ sshHost: 'devbox', controlDir: DIR, command: COMMAND })

  assert.deepEqual(args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T'], 'the legacy flags keep their places')
  assert.equal(args.includes('-T'), true, 'no pseudo-terminal is allocated for a one-shot command')
  assert.equal(args[args.length - 1], COMMAND, 'the remote command remains the final argument')
  assert.equal(args[args.length - 2], 'devbox', 'the host alias is the operand the command runs on')
})

test('credential mint: a host alias that is not filename-safe cannot escape the control directory', () => {
  const hostile = '../../..//tmp/evil;rm -rf ~'
  const args = sshMintArgs({ sshHost: hostile, controlDir: DIR, command: COMMAND })
  const socket = socketOf(args)

  assert.equal(dirname(socket), DIR, 'the socket stays inside the control directory: ' + socket)
  assert.equal(join(DIR, basename(socket)), socket, 'no directory components are taken from the alias')
  assert.equal(resolve(socket).startsWith(resolve(DIR) + sep), true, 'the resolved socket does not escape: ' + socket)
  assert.equal(socket, controlPathFor(DIR, hostile), 'one deterministic name per alias')
  assert.equal(args[args.length - 2], hostile, 'ssh still receives the alias itself, unsanitised')
})

test('credential mint: a mint without a host alias behaves as it always did', () => {
  const args = sshMintArgs({ command: COMMAND })

  assert.deepEqual(args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T'])
  assert.equal(args[args.length - 1], COMMAND)
  assert.equal(args.some((arg) => typeof arg === 'string' && arg.startsWith('Control')), false, 'no alias means no socket: ' + JSON.stringify(args))
})
test('refresher: the mount forwards its control settings into the mint instead of letting it dial again', () => {
  const calls = []
  const refresh = (options) => { calls.push(options); return Promise.resolve({ ok: true }) }
  const refresher = makeRefresher(
    { sshHost: 'fakehost', tmuxSession: 'dsh-test' },
    '/tmp/drh-cookie-test.txt',
    { sshControl: false, controlDir: '/tmp/drh-control-test', refresh },
  )
  assert.equal(typeof refresher, 'function')
  refresher()
  assert.equal(calls.length, 1, 'the refresher must mint exactly once per call')
  assert.deepEqual(calls[0], {
    sshHost: 'fakehost',
    tmuxSession: 'dsh-test',
    cookieFile: '/tmp/drh-cookie-test.txt',
    sshControl: false,
    controlDir: '/tmp/drh-control-test',
  })
})

test('refresher: a mount without a credential names no ssh host at all', () => {
  assert.equal(makeRefresher({}, '/tmp/drh-cookie-test.txt'), undefined)
})
