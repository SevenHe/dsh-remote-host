#!/usr/bin/env node
/**
 * Report whether a remote Host's service can heal itself after a restart.
 *
 * Two things have to hold on the far side, and neither is visible from the plugin's config: the
 * startup banner must be reachable where the mint looks for it, and the memory runtime's key must
 * be in the Host process environment. Both fail silently until a credential expires, at which
 * point the mount answers "remote credential expired and could not be refreshed".
 *
 * The checks are read-only and never print a secret: the key file is inspected by mode and size,
 * the process environment by presence, and the credential by HTTP status.
 *
 * Usage:
 *   node scripts/remote-host-doctor.mjs --ssh <alias> --banner-log-glob '<glob>'
 *
 * See docs/remote-host-service.md for the two deployment steps these checks cover.
 */
import { execFileSync } from 'node:child_process'
import { exchangeCredential, readEntryUrl } from '../lib/credential-mint.js'
import { bannerCheck, envCheck, KEY_FILE, keyFileCheck, memoryCheck } from './lib/remote-doctor.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

/** Run one remote shell command and return its trimmed stdout. */
function remote(ssh, command) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-T', ssh, command], { encoding: 'utf8' }).trim()
}

const ssh = argOf('ssh', '')
const bannerLogGlob = argOf('banner-log-glob', '')
if (ssh.length === 0) {
  console.error('remote-host-doctor: --ssh <alias> is required')
  process.exit(2)
}

const STAT = 'stat -c "%a %s" ' + KEY_FILE + ' 2>/dev/null || stat -f "%Lp %z" ' + KEY_FILE + ' 2>/dev/null'
const ENV = 'PID=$(pgrep -f "dsh --profile" | head -1); tr "\\0" "\\n" < /proc/$PID/environ 2>/dev/null | grep -c "^OPENVIKING_API_KEY="'

const results = []
try {
  const glob = bannerLogGlob.length > 0 ? bannerLogGlob : '~/.artifacts/dsh-superagent-*.log'
  results.push(['banner', bannerCheck(remote(ssh, 'ls -t ' + glob + " 2>/dev/null | head -1 | xargs -r grep -a 'dsh web: http'"))])
  results.push(['key file', keyFileCheck(remote(ssh, STAT))])
  results.push(['host env', envCheck(remote(ssh, ENV))])
} catch (error) {
  console.error('remote-host-doctor: cannot reach ' + ssh + ': ' + (error instanceof Error ? error.message : String(error)))
  process.exit(2)
}

// The credential and the endpoint it admits are checked together: a 200 here proves both.
try {
  const entryUrl = await readEntryUrl({
    sshHost: ssh,
    tmuxSession: 'dsh-superagent',
    bannerLogGlob: bannerLogGlob.length > 0 ? bannerLogGlob : undefined,
  })
  const cookie = await exchangeCredential(entryUrl)
  const response = await fetch(new URL(entryUrl).origin + '/orchestrator/api/memory', {
    headers: { cookie, 'x-orchestrator-request': '1' },
    redirect: 'manual',
  })
  results.push(['memory', memoryCheck(response.status)])
} catch (error) {
  results.push(['memory', { ok: false, detail: error instanceof Error ? error.message : String(error) }])
}

let failed = 0
for (const [name, result] of results) {
  if (result.ok !== true) failed += 1
  console.log((result.ok === true ? 'ok   ' : 'FAIL ') + String(name).padEnd(9) + ' ' + result.detail)
}
console.log('')
console.log(failed === 0 ? 'verdict     : the remote Host can heal itself' : 'verdict     : ' + String(failed) + ' check(s) failed')
process.exit(failed === 0 ? 0 : 1)
