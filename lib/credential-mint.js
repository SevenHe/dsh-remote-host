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
import { controlArgs, DEFAULT_CONTROL_DIR, ensureControlDir } from './ssh-control.js'

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
 * Resolve the control socket one mint joins.
 *
 * Multiplexing is on unless the caller turns it off, and a mint without a host alias has no
 * socket to name: it keeps the per-call connection it has always made.
 * @param options.sshHost - OpenSSH host alias the mint dials; absent leaves the mint unmuxed.
 * @param options.sshControl - configured multiplexing switch; only `false` turns it off.
 * @param options.controlDir - directory holding control sockets; a value that is not a
 * non-empty string falls back to the shared directory rather than reaching `path.join`.
 * @param options.controlTag - this installation's socket tag, matching the forward's.
 * @returns controlArgs input, enabled only when a host alias can name a socket.
 */
function mintControl(options) {
  const host = options.sshHost
  const dir = options.controlDir
  return {
    enabled: typeof host === 'string' && host.length > 0 && options.sshControl !== false,
    dir: typeof dir === 'string' && dir.length > 0 ? dir : DEFAULT_CONTROL_DIR,
    // The tag names the installation: without it the mint would address a different socket
    // from the forward's, and pay the handshake this whole mechanism exists to avoid.
    tag: typeof options.controlTag === 'string' && options.controlTag.length > 0 ? options.controlTag : undefined,
    host,
  }
}

/**
 * Build the ssh argv the mint runs one remote command with.
 * @param control - resolved control-socket settings from `mintControl`.
 * @param command - remote command; the last argv element.
 * @returns the ssh argv for `execFile`.
 */
function mintArgv(control, command) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-T',
    ...controlArgs(control),
    control.host,
    command,
  ]
}

/**
 * Build the ssh argv that reads a remote command's output for the mint.
 *
 * Exported so the transport is assertable without spawning. The control socket is the one the
 * forward uses for the same host and directory, so a mint reuses the open master instead of
 * paying another handshake and authentication.
 * @param options.sshHost - OpenSSH host alias to dial.
 * @param options.sshControl - multiplexing switch; defaults on unless `false`.
 * @param options.controlDir - directory holding control sockets; defaults to `DEFAULT_CONTROL_DIR`.
 * @param options.command - remote command to run; becomes the last argv element.
 * @returns the ssh argv for `execFile`.
 */
export function sshMintArgs(options) {
  return mintArgv(mintControl(options), options.command)
}

/**
 * Read the entry URL from the remote Host's startup banner.
 * @param options - `sshHost` to reach the Host and `tmuxSession` holding its scrollback.
 * @returns A promise of the entry URL including its token; rejects when the read fails.
 */
export async function readEntryUrl(options) {
  const command = 'tmux capture-pane -p -S -4000 -t ' + shellQuote(options.tmuxSession) + ' 2>/dev/null'
  const control = mintControl(options)
  // The first ssh that joins a master creates the socket, and it cannot create the directory.
  if (control.enabled) ensureControlDir(control.dir)
  let stdout
  try {
    // Asynchronous on purpose: this read can spend the whole ConnectTimeout, and a synchronous
    // child process freezes the Host's single thread for that long. The tunnel health probe runs
    // on the same thread, so an 8s block reads as a wedged forward and gets a working tunnel
    // torn down.
    ({ stdout } = await exec('ssh', mintArgv(control, command), {
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
