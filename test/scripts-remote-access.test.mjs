/** remote-access.mjs: the CLI wraps lib/credential-mint.js, so it inherits its file mode and errors. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/remote-access.mjs', import.meta.url))

/**
 * A fake `ssh` on PATH.
 *
 * The shared mint resolves `ssh` through PATH, so PATH is the seam that leaves the shipped code
 * untouched. The banner and exit status live in files so one stub serves both cases.
 * @param options.banner - text the stub prints (stdout).
 * @param options.status - exit code of the stub.
 * @returns Directory to prepend to PATH.
 */
function installFakeSsh({ banner, status = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'drh-fake-ssh-'))
  const bannerFile = join(dir, 'banner.txt')
  writeFileSync(bannerFile, banner)
  writeFileSync(join(dir, 'ssh'), [
    '#!/bin/sh',
    'cat ' + JSON.stringify(bannerFile),
    'exit ' + String(status),
  ].join('\n') + '\n', { mode: 0o755 })
  return dir
}

/**
 * A Host stand-in: answers every `/connect` with one credential cookie.
 * @param t - test context, used to tear the server down.
 * @returns The requests it saw and the origin to put in the banner.
 */
async function cookieHost(t) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push(req.url)
    res.writeHead(200, { 'set-cookie': 'dsh-auth=script-value; Path=/; HttpOnly' })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return { calls, origin: 'http://127.0.0.1:' + String(server.address().port) }
}

test('remote-access: a re-mint replaces the cookie, keeps a backup, and forces 0600', async (t) => {
  const host = await cookieHost(t)
  const fakeSsh = installFakeSsh({ banner: 'dsh web: ' + host.origin + '/?token=entry-token\n' })
  const dir = mkdtempSync(join(tmpdir(), 'drh-cookie-'))
  const cookieFile = join(dir, 'cookie.txt')
  // The drift this guards: an existing world-readable credential used to keep that mode after a
  // re-mint, because chmod only ran when the file was created.
  // chmod, not the write mode: the write mode is masked by umask, and this test needs a
  // world-readable file regardless of the runner's umask.
  writeFileSync(cookieFile, 'dsh-auth=spent-value\n')
  chmodSync(cookieFile, 0o644)
  assert.equal(statSync(cookieFile).mode & 0o777, 0o644, 'fixture starts world-readable')

  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, 'refresh-cookie', '--ssh', 'devbox', '--tmux-session', 'dsh-main', '--cookie-file', cookieFile], {
    env: { ...process.env, PATH: fakeSsh + ':' + String(process.env.PATH) },
  })

  assert.match(stdout, /^host     : http:\/\/127\.0\.0\.1:\d+$/m)
  assert.match(stdout, /^cookie   : .*cookie\.txt \(\d+ chars\)$/m)
  assert.equal(readFileSync(cookieFile, 'utf8'), 'dsh-auth=script-value\n')
  assert.equal(statSync(cookieFile).mode & 0o777, 0o600, 'the stored credential is owner-only even when the old file was world-readable')
  const backups = readdirSync(dir).filter((name) => name.startsWith('cookie.txt.bak-'))
  assert.equal(backups.length, 1, 'one backup per re-mint: ' + JSON.stringify(readdirSync(dir)))
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), 'dsh-auth=spent-value\n', 'the backup holds the spent credential')
  assert.deepEqual(host.calls, ['/connect?token=entry-token&interactions=none'])
})

test('remote-access: an unreachable Host reports one actionable line, not a stack', async () => {
  const fakeSsh = installFakeSsh({ banner: '', status: 255 })
  const cookieFile = join(mkdtempSync(join(tmpdir(), 'drh-cookie-')), 'cookie.txt')
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, 'refresh-cookie', '--ssh', 'devbox', '--cookie-file', cookieFile], {
      env: { ...process.env, PATH: fakeSsh + ':' + String(process.env.PATH) },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })

  assert.equal(result.error?.code, 1, 'a failed mint exits non-zero')
  assert.match(result.stderr, /remote-access: credential-mint: cannot read the Host banner over ssh/)
  assert.equal(result.stderr.includes('at execFileSync'), false, 'the failure is a report, not a stack: ' + result.stderr)
  assert.equal(existsSync(cookieFile), false, 'a failed mint writes nothing')
})
