/**
 * The banner read is one shell command and one child process.
 *
 * Both properties are load-bearing: the tmux session name comes from configuration and is
 * parsed by the remote shell, and the read can spend the whole ssh ConnectTimeout while the
 * Host's single thread also runs the tunnel health probe.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bannerSourcesCommand, readEntryUrl, shellQuote } from '../lib/credential-mint.js'

const ENTRY = 'http://127.0.0.1:3080/?token=banner-token'
const BIN = mkdtempSync(join(tmpdir(), 'drh-quote-bin-'))
const ARGV = join(BIN, 'ssh-argv.txt')
const TMUX_ARGV = join(BIN, 'tmux-argv.txt')
const SLEEP = join(BIN, 'sleep.txt')
const MODE = join(BIN, 'mode.txt')
const STATUS = join(BIN, 'status.txt')
const MARKERS = mkdtempSync(join(tmpdir(), 'drh-quote-markers-'))

/**
 * A fake ssh that behaves like the remote shell: it records its argv, then runs the command it
 * would have sent through /bin/sh, which is exactly the expansion surface the quoting must close.
 */
writeFileSync(join(BIN, 'ssh'), [
  '#!/bin/sh',
  "printf '%s\n' \"$@\" > " + JSON.stringify(ARGV),
  'sleep_for=$(cat ' + JSON.stringify(SLEEP) + ' 2>/dev/null || echo 0)',
  'if [ "$sleep_for" != "0" ]; then sleep "$sleep_for"; fi',
  'last=',
  'for arg in "$@"; do last=$arg; done',
  '/bin/sh -c "$last"',
  'code=$?',
  'if [ -f ' + JSON.stringify(STATUS) + ' ]; then exit "$(cat ' + JSON.stringify(STATUS) + ')"; fi',
  'exit $code',
].join('\n') + '\n', { mode: 0o755 })

/** A fake tmux: records the arguments it was given and prints the Host banner. */
writeFileSync(join(BIN, 'tmux'), [
  '#!/bin/sh',
  "printf '%s\n' \"$@\" > " + JSON.stringify(TMUX_ARGV),
  'mode=$(cat ' + JSON.stringify(MODE) + ' 2>/dev/null || echo banner)',
  'if [ "$mode" = "none" ]; then echo "dsh web: listening on port 3080"; else echo "dsh web: ' + ENTRY + '"; fi',
].join('\n') + '\n', { mode: 0o755 })

/** Run one case with the fake ssh first on PATH, the way the shipped read resolves it. */
async function withFakeSsh(options, run) {
  writeFileSync(SLEEP, String(options.sleep ?? 0))
  writeFileSync(MODE, options.mode ?? 'banner')
  if (options.status === undefined) { try { unlinkSync(STATUS) } catch { /* no status from the previous case */ } } else writeFileSync(STATUS, String(options.status))
  const previous = process.env.PATH
  process.env.PATH = BIN + ':' + String(previous)
  try {
    return await run()
  } finally {
    process.env.PATH = previous
  }
}

/** The command the fake ssh was asked to run. */
function lastCommand() {
  const argv = readFileSync(ARGV, 'utf8').trim().split('\n')
  return argv[argv.length - 1]
}

/** The tmux argument list, as the remote shell produced it. */
function tmuxArgs() {
  return readFileSync(TMUX_ARGV, 'utf8').replace(/\n$/, '').split('\n')
}

test('shell quoting: a session name is one literal shell word', async () => {
  const cases = [
    'plain-session',
    "a'b",
    'pane$(touch ' + join(MARKERS, 'substitution') + ')',
    'pane`touch ' + join(MARKERS, 'backtick') + '`',
    'pane; touch ' + join(MARKERS, 'semicolon'),
    'pane && touch ' + join(MARKERS, 'and-list'),
  ]
  await withFakeSsh({}, async () => {
    for (const session of cases) {
      const url = await readEntryUrl({ sshHost: 'devbox', tmuxSession: session })
      assert.equal(url, ENTRY, 'the banner is still parsed for ' + JSON.stringify(session))
      const args = tmuxArgs()
      assert.equal(args[args.indexOf('-t') + 1], session, 'tmux receives the name verbatim: ' + JSON.stringify(args))
    }
  })
  for (const marker of ['substitution', 'backtick', 'semicolon', 'and-list']) {
    assert.equal(existsSync(join(MARKERS, marker)), false, 'the shell must not run ' + marker)
  }
})

test('shell quoting: the command wraps the name in single quotes and splices a quote safely', async () => {
  await withFakeSsh({}, async () => {
    await readEntryUrl({ sshHost: 'devbox', tmuxSession: "it's mine" })
    assert.equal(lastCommand(), bannerSourcesCommand({ tmuxSession: "it's mine" }), 'the quote is spliced, not escaped with a backslash inside double quotes')
    assert.equal(shellQuote('plain'), "'plain'")
    assert.equal(shellQuote("a'b"), "'a'\\''b'")
  })
})

test('shell quoting: the banner read leaves the event loop free while ssh is outstanding', async () => {
  await withFakeSsh({ sleep: 1.2 }, async () => {
    const started = Date.now()
    let tickedAt
    const timer = setTimeout(() => { tickedAt = Date.now() }, 50)
    const url = await readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' })
    clearTimeout(timer)
    assert.equal(url, ENTRY)
    assert.ok(tickedAt !== undefined, 'a timer must run while ssh is still outstanding')
    assert.ok(tickedAt - started < 600, 'the thread must stay free, timer fired at ' + String(tickedAt - started) + 'ms')
    assert.ok(Date.now() - started >= 1000, 'the read itself waited for ssh: ' + String(Date.now() - started) + 'ms')
  })
})

test('shell quoting: an unreachable Host still reports an ssh failure, not a parse failure', async () => {
  await withFakeSsh({ status: 255 }, async () => {
    await assert.rejects(readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' }), /cannot read the Host banner over ssh/)
  })
})

test('shell quoting: a banner without an entry URL names the pane it read', async () => {
  await withFakeSsh({ mode: 'none' }, async () => {
    await assert.rejects(readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' }), /no "dsh web: http\.\.\.\?token=" banner in dsh-main/)
  })
})
