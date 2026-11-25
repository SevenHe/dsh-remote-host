#!/usr/bin/env node
/**
 * Read the running remote Host's entry URL and mint the credential its UI needs.
 *
 * Why this exists: from 0.2.3-alpha the Host prints an entry URL whose token authorizes the
 * browser page only. The mux and API accept a credential minted at `/connect`, so any stored
 * cookie silently expires whenever the Host restarts. This script reads the token the Host
 * printed, exchanges it for that credential, and stores it where the caller needs it.
 *
 *   node scripts/remote-access.mjs url --ssh devbox [--open]
 *   node scripts/remote-access.mjs refresh-cookie --ssh devbox
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

/** Expand a leading ~ against this machine's home directory. */
const expand = (path) => path.replace(/^~(?=$|\/)/, homedir())

/**
 * Read the entry URL the Host printed at startup: the credential lives only there.
 * @param sshHost - Host alias reachable with the user's existing SSH setup.
 * @param tmuxSession - Session whose scrollback carries the startup banner.
 * @returns The entry URL including its token query parameter.
 */
function readEntryUrl(sshHost, tmuxSession) {
  const remote = [
    'tmux capture-pane -p -S -4000 -t ' + JSON.stringify(tmuxSession) + ' 2>/dev/null',
  ].join(' || ')
  let output
  try {
    output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-T', sshHost, remote], { encoding: 'utf8' })
  } catch (error) {
    fail('could not read the Host startup banner over ssh: ' + String(error))
  }
  const entry = [...output.matchAll(/(https?:\/\/\S+?\?token=[A-Za-z0-9_-]+)/gu)].pop()
  if (entry === undefined) fail('no "dsh web: http...?token=" line found in ' + tmuxSession)
  return entry[1]
}

/**
 * Exchange the entry token for the mux/API credential the Host issues at /connect.
 * @param entryUrl - Entry URL carrying the token.
 * @returns One `name=value` cookie pair.
 */
async function mintCredential(entryUrl) {
  const url = new URL(entryUrl)
  const connect = new URL('/connect', url.origin)
  connect.searchParams.set('token', url.searchParams.get('token') ?? '')
  connect.searchParams.set('interactions', 'none')
  const response = await fetch(connect, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const pair = cookies.map((value) => value.split(';')[0].trim()).filter((value) => value.includes('='))
  if (pair.length === 0) fail('the Host returned no credential (HTTP ' + String(response.status) + ')')
  return pair.join('; ')
}

/**
 * Store the credential where the configured reader expects it, keeping the previous one.
 * @param cookieFile - Destination file.
 * @param credential - Cookie pairs to write.
 * @returns The backup path, when a previous credential existed.
 */
function storeCredential(cookieFile, credential) {
  mkdirSync(dirname(cookieFile), { recursive: true })
  let backup
  if (existsSync(cookieFile)) {
    backup = cookieFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    copyFileSync(cookieFile, backup)
  }
  writeFileSync(cookieFile, credential + '\n', { mode: 0o600 })
  return backup
}

const sshHost = argOf('ssh', 'devbox')
const tmuxSession = argOf('tmux-session', 'dsh-superagent')
const cookieFile = expand(argOf('cookie-file', join(homedir(), '.dsh', 'dsh-remote-host', 'cookie.txt')))

if (command !== 'url' && command !== 'refresh-cookie') {
  fail('unknown command: ' + command + ' (url | refresh-cookie)')
}

const entryUrl = readEntryUrl(sshHost, tmuxSession)
const credential = await mintCredential(entryUrl)
const backup = storeCredential(cookieFile, credential)
const url = new URL(entryUrl)

console.log('host     : ' + url.origin)
console.log('entry    : ' + entryUrl)
console.log('cookie   : ' + cookieFile + ' (' + String(credential.length) + ' chars)')
if (backup !== undefined) console.log('previous : ' + backup)
if (command === 'url' && has('open') === true) {
  execFileSync('open', [entryUrl], { stdio: 'ignore' })
  console.log('opened   : yes')
}

