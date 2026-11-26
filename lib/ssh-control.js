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
 * `ControlPersist=no` is deliberate. The master lives exactly as long as the forward that
 * created it, so a plugin that goes away leaves no ssh behind — this repository treats a
 * leftover tunnel as a defect, not as an optimisation.
 *
 * @module dsh-remote-host/ssh-control
 */
import { mkdirSync } from 'node:fs'
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
 * @returns the `-o` pairs to append to an ssh argv, empty when disabled.
 */
export function controlArgs(options) {
  if (options === undefined || options === null || options.enabled !== true) return []
  return [
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=' + controlPathFor(options.dir, options.host),
    '-o', 'ControlPersist=no',
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
