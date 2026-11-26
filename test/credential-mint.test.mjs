/** The credential mint: banner parsing, `/connect` exchange, and the stored cookie file. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exchangeCredential, readEntryUrl, refreshCredential } from '../lib/credential-mint.js'

/**
 * The fake `ssh` readEntryUrl shells out to.
 *
 * execFileSync('ssh', …) resolves through PATH, so PATH is the seam that leaves the shipped
 * function untouched. One script serves every case, because macOS verifies a freshly created
 * executable for several hundred ms; its banner, exit status and argv live in files instead.
 */
const FAKE_SSH = mkdtempSync(join(tmpdir(), 'drh-fake-ssh-'))
const ARGV_FILE = join(FAKE_SSH, 'argv.txt')
const BANNER_FILE = join(FAKE_SSH, 'banner.txt')
const STATUS_FILE = join(FAKE_SSH, 'status.txt')
writeFileSync(join(FAKE_SSH, 'ssh'), [
  '#!/bin/sh',
  "printf '%s\\n' \"$@\" > " + JSON.stringify(ARGV_FILE),
  'cat ' + JSON.stringify(BANNER_FILE),
  'exit "$(cat ' + STATUS_FILE + ')"',
].join('\n') + '\n', { mode: 0o755 })

/**
 * Answer the next ssh call with `banner` and `status`.
 * @param options.banner - text the fake ssh prints (stdout).
 * @param options.status - exit code of the fake ssh.
 * @param run - receives the file recording the ssh argv.
 */
async function withFakeSsh(options, run) {
  writeFileSync(BANNER_FILE, options.banner)
  writeFileSync(STATUS_FILE, String(options.status ?? 0))
  const previous = process.env.PATH
  process.env.PATH = FAKE_SSH + ':' + String(previous)
  try {
    return await run({ argsFile: ARGV_FILE })
  } finally {
    process.env.PATH = previous
  }
}

/** A Host stand-in: it records each /connect request and answers with `reply`. */
async function connectHost(reply) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url })
    reply(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, calls, base: 'http://127.0.0.1:' + String(server.address().port) }
}

/** A startup banner whose newest entry URL is the last one the Host printed. */
const BANNER = [
  '$ dsh web --host 0.0.0.0 --port 3080',
  'dsh web: http://127.0.0.1:3080/?token=stale-token (restart 12:01)',
  'dsh web: listening',
  'dsh web: http://127.0.0.1:3080/?token=fresh_token-2',
  'dsh web: token expires in 12h',
  // A plain URL after the entry line: only the token-bearing URL is an entry point.
  'dsh web: health at http://127.0.0.1:3080/health',
].join('\n') + '\n'

test('credential mint: the entry URL is the last token URL in the Host banner', async () => {
  await withFakeSsh({ banner: BANNER }, async ({ argsFile }) => {
    // readEntryUrl is async so a stalled ssh cannot block the host event loop.
    const url = await readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' })
    assert.equal(url, 'http://127.0.0.1:3080/?token=fresh_token-2', 'the newest banner line wins')
    const argv = readFileSync(argsFile, 'utf8').trim().split('\n')
    assert.ok(argv.includes('BatchMode=yes'), 'the banner read is non-interactive: ' + JSON.stringify(argv))
    const command = argv[argv.length - 1]
    assert.equal(command.includes('tmux capture-pane'), true, 'the banner comes from tmux: ' + JSON.stringify(argv))
    // The pane name is single-quoted so the remote shell cannot expand anything inside it.
    assert.equal(command.includes("'dsh-main'"), true, 'the asked-for session is quoted into the command: ' + JSON.stringify(argv))
  })
})

test('credential mint: an unreachable Host surfaces as an ssh failure, not a parse failure', async () => {
  // Async now: the same ssh failure surfaces as a rejection, with the same message.
  await withFakeSsh({ banner: '', status: 255 }, async () => {
    await assert.rejects(
      readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' }),
      /cannot read the Host banner over ssh/,
    )
  })
})

test('credential mint: a banner without an entry URL names the pane it read', async () => {
  // Async now: a missing entry URL rejects instead of throwing.
  await withFakeSsh({ banner: 'dsh web: listening on port 3080\nno token here\n' }, async () => {
    await assert.rejects(
      readEntryUrl({ sshHost: 'devbox', tmuxSession: 'dsh-main' }),
      /no "dsh web: http\.\.\.\?token=" banner in dsh-main/,
    )
  })
})

test('credential mint: the entry token is exchanged at /connect for one cookie pair', async (t) => {
  const host = await connectHost((req, res) => {
    res.writeHead(200, { 'set-cookie': ['dsh-auth=credit-one; Path=/; HttpOnly', 'dsh-aux=second; Path=/', 'not-a-cookie'] })
    res.end()
  })
  t.after(() => { host.server.closeAllConnections(); host.server.close() })

  const credential = await exchangeCredential(host.base + '/?token=entry-token')
  assert.equal(credential, 'dsh-auth=credit-one; dsh-aux=second', 'every Set-Cookie is kept, in order')
  assert.equal(host.calls.length, 1)
  assert.equal(host.calls[0].url, '/connect?token=entry-token&interactions=none', 'the exchange asks for no interactions')
})

test('credential mint: a Host that issues no cookie fails with its status', async (t) => {
  const host = await connectHost((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('expired')
  })
  t.after(() => { host.server.closeAllConnections(); host.server.close() })

  await assert.rejects(exchangeCredential(host.base + '/?token=entry-token'), /issued no credential \(HTTP 401\)/)
})

test('credential mint: a fresh mint creates the cookie file readable only by its owner', async (t) => {
  const host = await connectHost((req, res) => {
    res.writeHead(200, { 'set-cookie': 'dsh-auth=fresh-value; Path=/' })
    res.end()
  })
  t.after(() => { host.server.closeAllConnections(); host.server.close() })
  // The parent directory does not exist yet: the mint is the first writer.
  const cookieFile = join(mkdtempSync(join(tmpdir(), 'drh-mint-')), 'nested', 'cookie.txt')
  const entryUrl = host.base + '/?token=entry-token'

  const result = await withFakeSsh({ banner: entryUrl + '\n' }, () => refreshCredential({
    sshHost: 'devbox',
    tmuxSession: 'dsh-main',
    cookieFile,
  }))

  assert.equal(result.entryUrl, entryUrl, 'the banner source is reported back')
  assert.equal(result.cookieFile, cookieFile)
  assert.equal(result.backup, undefined, 'nothing was there to back up')
  assert.equal(result.length, 'dsh-auth=fresh-value'.length)
  assert.equal(result.previous, result.length, 'the returned previous length is the file just written')
  assert.equal(readFileSync(cookieFile, 'utf8'), 'dsh-auth=fresh-value\n')
  assert.equal(statSync(cookieFile).mode & 0o777, 0o600, 'only the owner may read the credential')
})

test('credential mint: a re-mint backs the spent cookie up before replacing it', async (t) => {
  const host = await connectHost((req, res) => {
    res.writeHead(200, { 'set-cookie': 'dsh-auth=second-value; Path=/' })
    res.end()
  })
  t.after(() => { host.server.closeAllConnections(); host.server.close() })
  const dir = mkdtempSync(join(tmpdir(), 'drh-mint-'))
  const cookieFile = join(dir, 'cookie.txt')
  const stale = 'dsh-auth=spent-value\n'
  writeFileSync(cookieFile, stale, { mode: 0o600 })
  const entryUrl = host.base + '/?token=entry-token'

  const result = await withFakeSsh({ banner: entryUrl + '\n' }, () => refreshCredential({
    sshHost: 'devbox',
    tmuxSession: 'dsh-main',
    cookieFile,
  }))

  assert.ok(typeof result.backup === 'string' && result.backup.startsWith(cookieFile + '.bak-'), 'the previous file is kept: ' + String(result.backup))
  assert.equal(existsSync(result.backup), true)
  assert.equal(readFileSync(result.backup, 'utf8'), stale, 'the backup holds the spent credential')
  assert.equal(readFileSync(cookieFile, 'utf8'), 'dsh-auth=second-value\n')
  assert.equal(statSync(cookieFile).mode & 0o777, 0o600)
  assert.equal(result.length, 'dsh-auth=second-value'.length)
  const backups = readdirSync(dir).filter((name) => name.startsWith('cookie.txt.bak-'))
  assert.equal(backups.length, 1, 'one backup per re-mint: ' + JSON.stringify(readdirSync(dir)))
  assert.equal(join(dir, backups[0]), result.backup)
})
