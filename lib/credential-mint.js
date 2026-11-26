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
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Entry URLs the Host prints, newest last. */
const ENTRY_PATTERN = /(https?:\/\/\S+?\?token=[A-Za-z0-9_-]+)/gu

/**
 * Bound on the banner read's stdout. The scrollback is capped at 4000 lines, but a resolved
 * banner can be long, and the default exec buffer (1 MiB) would turn a chatty Host into an
 * exchange failure.
 */
const BANNER_MAX_BYTES = 8 * 1024 * 1024

/** Expand a leading ~ against this machine's home directory. */
export const expandPath = (path) => path.replace(/^~(?=$|\/)/, homedir())

/**
 * Quote one value as a single POSIX shell word.
 *
 * The remote side parses this command with a shell. Double quotes — what JSON.stringify
 * produces — still expand `$(...)`, backticks, and `$VAR`, so a tmux session name would run as
 * code. Single quotes disable every expansion; an embedded `'` is spliced as `'\''`, which
 * closes the quote, emits an escaped quote, and reopens it.
 * @param value - the word to quote.
 * @returns the word wrapped in single quotes, safe to concatenate into a command line.
 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Read the entry URL from the remote Host's startup banner.
 * @param options - `sshHost` to reach the Host and `tmuxSession` holding its scrollback.
 * @returns A promise of the entry URL including its token; rejects when the read fails.
 */
export async function readEntryUrl(options) {
  const command = 'tmux capture-pane -p -S -4000 -t ' + shellQuote(options.tmuxSession) + ' 2>/dev/null'
  let stdout
  try {
    // Asynchronous on purpose: this read can spend the whole ConnectTimeout, and a synchronous
    // child process freezes the Host's single thread for that long. The tunnel health probe runs
    // on the same thread, so an 8s block reads as a wedged forward and gets a working tunnel
    // torn down.
    ({ stdout } = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-T', options.sshHost, command], {
      encoding: 'utf8',
      maxBuffer: BANNER_MAX_BYTES,
    }))
  } catch (error) {
    throw new Error('credential-mint: cannot read the Host banner over ssh: ' + String(error))
  }
  const matches = [...stdout.matchAll(ENTRY_PATTERN)]
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
  const entryUrl = await readEntryUrl(options)
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
