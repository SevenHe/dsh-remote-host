/**
 * One SSH transport per host, shared by everything this plugin runs against it.
 *
 * Two callers open their own ssh today: the long-lived forward (`ssh -N -L`) and every
 * credential mint (`ssh -T <host> <command>`). Each pays a full handshake and authentication,
 * and a flapping mount pays it again on every rebuild. OpenSSH already multiplexes: the first
 * connection becomes a master, and later ones address it through a control socket instead of
 * dialling the hop again. That is the arrangement Codex documents for its own SSH legs
 * ("SSH owns each helper process; multiplexing belongs to OpenSSH ControlMaster"), and it
 * keeps the number of connections to one host at one.
 *
 * The master PERSISTS: `ControlPersist` keeps it in the background after its client goes
 * away, which is what lets a reconnect — a rebuilt forward, a mint during an outage — reuse an
 * already-authenticated session instead of paying the handshake again. Persistence is bounded,
 * because this repository treats a leftover tunnel as a defect: the window is a configured
 * number of seconds, teardown still asks the master to exit, and a socket left by a crashed
 * Host is swept before the next master is created (`sweepControlSocket`).
 *
 * @module dsh-remote-host/ssh-control
 */
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Default directory for control sockets.
 *
 * `/tmp` rather than `os.tmpdir()` on POSIX: macOS answers with its per-user
 * `/var/folders/<2>/<32>/T`, and that plus the socket name lands exactly on the platform's
 * 104-byte `sun_path` limit. `/tmp` is four bytes, and the uid suffix keeps two accounts on
 * one machine apart. Windows has no unix sockets to place, so it keeps its own temporary
 * directory.
 */
export const DEFAULT_CONTROL_DIR = process.platform === 'win32'
  ? join(tmpdir(), 'drh-ssh-' + String(typeof process.getuid === 'function' ? process.getuid() : 'user'))
  : '/tmp/drh-ssh-' + String(typeof process.getuid === 'function' ? process.getuid() : 'user')

/**
 * Default persistence window, in seconds.
 *
 * Long enough to cover a reconnect: the forward's retry ladder tops out at 30s, and a Host
 * restart takes longer than that. Short enough that a crashed Host cannot keep a connection
 * (and its authenticated session) alive on the remote side for long.
 */
export const DEFAULT_PERSIST_SEC = 120

/**
 * Socket path for one host alias.
 *
 * Deterministic, not `%C`: a per-connection hash cannot be resolved by this side, and the
 * cleanup path has to be able to name the socket it wants gone. The alias is sanitised so a
 * host pattern from `~/.ssh/config` cannot escape the directory.
 * @param dir - directory holding control sockets.
 * @param host - OpenSSH host alias.
 * @returns the control socket path.
 */
export function controlPathFor(dir, host) {
  const safe = String(host).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32) || 'host'
  return join(dir, 'cm-' + safe)
}

/**
 * Options that join a caller to the shared master.
 *
 * `auto` rather than `yes`: the first caller creates the master, later ones reuse it, and a
 * caller whose master died creates a new one instead of failing.
 * @param options.enabled - whether multiplexing is configured on.
 * @param options.dir - directory holding control sockets.
 * @param options.host - OpenSSH host alias.
 * @param options.persistSec - seconds the master outlives its client; 0 (or absent) means the
 *   master exits with it, and `DEFAULT_PERSIST_SEC` applies when the caller has no opinion.
 * @returns the `-o` pairs to append to an ssh argv, empty when disabled.
 */
export function controlArgs(options) {
  if (options === undefined || options === null || options.enabled !== true) return []
  const seconds = Number.isFinite(options.persistSec) && options.persistSec >= 0
    ? Math.floor(options.persistSec)
    : DEFAULT_PERSIST_SEC
  return [
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=' + controlPathFor(options.dir, options.host),
    '-o', 'ControlPersist=' + (seconds === 0 ? 'no' : String(seconds)),
  ]
}

/**
 * Arguments that ask the master to exit.
 *
 * Killing the client leaves the master's socket in place until it notices, so the cleanup path
 * asks politely first; a wedged master ignores the request and the caller escalates to a
 * signal. Used with `ssh` directly (not `execFile`), so it runs as its own process.
 * @param options.dir - directory holding control sockets.
 * @param options.host - OpenSSH host alias.
 * @returns the ssh argv that closes the master, or an empty array when `host` is missing.
 */
export function exitArgs(options) {
  if (options === undefined || options === null || typeof options.host !== 'string' || options.host.length === 0) return []
  return ['-O', 'exit', '-o', 'ControlPath=' + controlPathFor(options.dir, options.host), options.host]
}

/**
 * Clear a control socket whose master is gone.
 *
 * The crash path is what this exists for: a Host that dies without tearing its tunnel down
 * leaves the socket file behind, and the next master would have to deal with a path that
 * looks live. A socket whose master still answers is left alone — that is the whole point of
 * keeping the master around between reconnects.
 * @param options.path - control socket path.
 * @param options.alive - whether a master answered on that socket.
 * @param options.exists - existence check; defaults to `node:fs`.
 * @param options.remove - remover; defaults to `node:fs`.
 * @returns 'absent' when there is nothing to clear, 'kept' when the master answered,
 *   'removed' when a corpse was cleared, 'stuck' when removal failed.
 */
export function sweepControlSocket(options) {
  const path = options === undefined || options === null ? '' : options.path
  if (typeof path !== 'string' || path.length === 0) return 'absent'
  const exists = typeof options.exists === 'function' ? options.exists : existsSync
  const remove = typeof options.remove === 'function' ? options.remove : unlinkSync
  if (exists(path) !== true) return 'absent'
  if (options.alive === true) return 'kept'
  try {
    remove(path)
    return 'removed'
  } catch {
    // A socket that cannot be removed is reported, not hidden: the next attempt will retry.
    return 'stuck'
  }
}

/**
 * Create the control-socket directory if it is not there yet.
 *
 * 0700 because a control socket is a credential: anything that can open it can drive the
 * master, which is authenticated to the remote host.
 * @param dir - directory to create.
 * @param mkdir - directory creator; defaults to `node:fs` `mkdirSync`.
 * @returns true when the directory exists afterwards.
 */
export function ensureControlDir(dir, mkdir = mkdirSync) {
  try {
    mkdir(dir, { recursive: true, mode: 0o700 })
    return true
  } catch {
    // A control directory that cannot be created only costs the optimisation.
    return false
  }
}
