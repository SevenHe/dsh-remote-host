/**
 * Mint the credential a restarted remote Host requires.
 *
 * Why this exists: from 0.2.3-alpha the Host prints an entry URL whose token authorizes the page
 * only, and each `/connect` credential admits exactly one WebSocket. A stored credential therefore
 * dies with its socket, and the page cannot mint a new one of its own. The Host side reads the
 * token the remote Host printed, exchanges it, and stores the result where the reader expects it.
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Entry URLs the Host prints, newest last. */
const ENTRY_PATTERN = /(https?:\/\/\S+?\?token=[A-Za-z0-9_-]+)/gu

/** Expand a leading ~ against this machine's home directory. */
export const expandPath = (path) => path.replace(/^~(?=$|\/)/, homedir())

/**
 * Read the entry URL from the remote Host's startup banner.
 * @param options - `sshHost` to reach the Host and `tmuxSession` holding its scrollback.
 * @returns The entry URL including its token.
 */
export function readEntryUrl(options) {
  const command = 'tmux capture-pane -p -S -4000 -t ' + JSON.stringify(options.tmuxSession) + ' 2>/dev/null'
  let output
  try {
    output = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', options.sshHost, command], { encoding: 'utf8' })
  } catch (error) {
    throw new Error('credential-mint: cannot read the Host banner over ssh: ' + String(error))
  }
  const matches = [...output.matchAll(ENTRY_PATTERN)]
  const last = matches[matches.length - 1]
  if (last === undefined) throw new Error('credential-mint: no "dsh web: http...?token=" banner in ' + options.tmuxSession)
  return last[1]
}

/**
 * Exchange an entry token for the credential the mux and API accept.
 * @param entryUrl - Entry URL carrying the token.
 * @returns One `name=value` cookie pair.
 */
export async function exchangeCredential(entryUrl) {
  const url = new URL(entryUrl)
  const connect = new URL('/connect', url.origin)
  connect.searchParams.set('token', url.searchParams.get('token') ?? '')
  connect.searchParams.set('interactions', 'none')
  const response = await fetch(connect, { redirect: 'manual' })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const pairs = cookies.map((value) => value.split(';')[0].trim()).filter((value) => value.includes('='))
  if (pairs.length === 0) throw new Error('credential-mint: the Host issued no credential (HTTP ' + String(response.status) + ')')
  return pairs.join('; ')
}

/**
 * Mint and store a usable credential, keeping the previous one.
 * @param options - ssh host, tmux session, and destination cookie file.
 * @returns The stored credential length and the previous file's backup path, when replaced.
 */
export async function refreshCredential(options) {
  const entryUrl = readEntryUrl(options)
  const credential = await exchangeCredential(entryUrl)
  const cookieFile = expandPath(options.cookieFile)
  mkdirSync(dirname(cookieFile), { recursive: true })
  let backup
  if (existsSync(cookieFile)) {
    backup = cookieFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    copyFileSync(cookieFile, backup)
  }
  writeFileSync(cookieFile, credential + '\n', { mode: 0o600 })
  // `mode` only applies when the file is created; an existing credential keeps its old mode.
  chmodSync(cookieFile, 0o600)
  return { entryUrl, cookieFile, length: credential.length, backup, previous: readFileSync(cookieFile, 'utf8').trim().length }
}
