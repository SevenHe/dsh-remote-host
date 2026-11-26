#!/usr/bin/env node
/**
 * Read the running remote Host's entry URL and mint the credential its UI needs.
 *
 * Why this exists: from 0.2.3-alpha the Host prints an entry URL whose token authorizes the
 * browser page only. The mux and API accept a credential minted at `/connect`, so any stored
 * cookie silently expires whenever the Host restarts. This script reads the token the Host
 * printed, exchanges it for that credential, and stores it where the caller needs it.
 *
 * The mint itself lives in lib/credential-mint.js because the Host-side pump re-mints the same
 * credential; this entry point only adds the CLI surface (--open, doctor) on top of it. Keeping one
 * implementation is what makes the stored file mode and the ssh timeout identical on both paths.
 *
 *   node scripts/remote-access.mjs url --ssh devbox [--open]
 *   node scripts/remote-access.mjs refresh-cookie --ssh devbox
 *   node scripts/remote-access.mjs doctor --authority devbox.example.com:3080
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandPath, refreshCredential } from '../lib/credential-mint.js'

const args = process.argv.slice(2)
const command = args[0] !== undefined && args[0].startsWith('--') !== true ? args[0] : 'url'
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const has = (name) => args.includes('--' + name)

function fail(message) {
  console.error('remote-access: ' + message)
  process.exit(1)
}

/**
 * Check the credential chain the page depends on and print one verdict per hop.
 * @param options - `sshHost` used to name the re-mint command in the report.
 * @returns Nothing; failures exit non-zero after printing what to do.
 */
async function doctor(options) {
  const cookieFile = expandPath(argOf('cookie-file', join(homedir(), '.dsh', 'dsh-remote-host', 'cookie.txt')))
  const authority = argOf('authority', '')
  const problems = []
  console.log('cookie file : ' + cookieFile)
  if (existsSync(cookieFile) !== true) {
    problems.push('no credential file; run: npm run remote:cookie -- --ssh ' + options.sshHost)
  } else {
    const credential = readFileSync(cookieFile, 'utf8').trim()
    console.log('credential  : ' + String(credential.length) + ' chars')
    if (authority !== '') {
      const root = await fetch('http://' + authority + '/', { headers: { cookie: credential } })
      console.log('remote http : ' + String(root.status))
      if (root.status !== 200) problems.push('the remote answered ' + String(root.status) + ' for the stored credential; re-mint it')
    } else {
      console.log('remote http : skipped (pass --authority host:port)')
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error('remote-access: ' + problem)
    process.exit(1)
  }
  console.log('verdict     : credential usable over HTTP; a mux socket may still be spent — the pump re-mints when configured')
}

const sshHost = argOf('ssh', 'devbox')
const tmuxSession = argOf('tmux-session', 'dsh-superagent')
const cookieFile = expandPath(argOf('cookie-file', join(homedir(), '.dsh', 'dsh-remote-host', 'cookie.txt')))

if (command === 'doctor') {
  await doctor({ sshHost })
  process.exit(0)
}

if (command !== 'url' && command !== 'refresh-cookie') {
  fail('unknown command: ' + command + ' (url | refresh-cookie | doctor)')
}

let refreshed
try {
  refreshed = await refreshCredential({ sshHost, tmuxSession, cookieFile })
} catch (error) {
  // The mint already names the failing hop and the Host's status; this entry point only owns the
  // CLI prefix, so the operator sees one actionable line instead of a stack.
  fail(error instanceof Error ? error.message : String(error))
}
const url = new URL(refreshed.entryUrl)

console.log('host     : ' + url.origin)
console.log('entry    : ' + refreshed.entryUrl)
console.log('cookie   : ' + refreshed.cookieFile + ' (' + String(refreshed.length) + ' chars)')
if (refreshed.backup !== undefined) console.log('previous : ' + refreshed.backup)
if (command === 'url' && has('open') === true) {
  execFileSync('open', [refreshed.entryUrl], { stdio: 'ignore' })
  console.log('opened   : yes')
}
