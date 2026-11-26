/**
 * Credential access for the mounted remote Host: where a leg's cookie lives, how a spent one
 * is exchanged, and what a refused (401) request means.
 *
 * Why this is its own module: the mount keeps three credential files (the proxies', the mux
 * leg's, the relay leg's) and the rules around them are shared. A `/connect` credential admits
 * exactly one WebSocket and is revoked when that socket closes, so reading, refreshing, and
 * replaying once form one policy; keeping it here is what stops a fourth route from inventing
 * a fourth variant.
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import { expandPath, refreshCredential } from './credential-mint.js'

// One expansion of a leading ~ for the cookie file and the trace log. credential-mint owns the
// implementation because it is also the module that writes the file; re-exported so callers
// keep importing it from the module they already read.
export { expandPath }

/** tmux session whose scrollback carries the Host banner when config names none. */
export const DEFAULT_TMUX_SESSION = 'dsh-superagent'

/**
 * Read the credential a proxy leg should present.
 * @param cookieFile - file the mint wrote, may start with `~`.
 * @returns the stored `name=value` pairs, or undefined when setup has not run.
 */
export function readCookie(cookieFile) {
  try {
    const value = readFileSync(expandPath(cookieFile), 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the refresher for one credential file.
 *
 * Each leg reads its own file, so the file is the only thing that differs between them; the
 * ssh host and tmux session come from the mount's `credential` config.
 *
 * The control-socket settings travel with the mint too: a mint that named its own socket would
 * open a second connection to a host the forward has already authenticated.
 * @param credential - bundle config `credential`; self-healing is off unless it names an ssh host.
 * @param cookieFile - destination file for this leg's credential.
 * @param options.sshControl - configured multiplexing switch, forwarded to the mint.
 * @param options.controlDir - directory holding control sockets, forwarded to the mint.
 * @param options.refresh - minting implementation; defaults to the real one, injectable for tests.
 * @returns a function minting and storing that file's credential, or undefined when disabled.
 */
export function makeRefresher(credential, cookieFile, options = {}) {
  const sshHost = credential?.sshHost
  if (typeof sshHost !== 'string' || sshHost.length === 0) return undefined
  const tmuxSession = typeof credential?.tmuxSession === 'string' && credential.tmuxSession.length > 0
    ? credential.tmuxSession
    : DEFAULT_TMUX_SESSION
  const refresh = typeof options.refresh === 'function' ? options.refresh : refreshCredential
  return () => refresh({
    sshHost,
    tmuxSession,
    cookieFile,
    sshControl: options.sshControl,
    controlDir: options.controlDir,
  })
}

/** Report a failed exchange; a spent credential is expected, so this must never throw. */
function reportRefreshFailure(error) {
  console.log('[dsh-remote-host] credential refresh failed: ' + String(error).slice(0, 200))
}

/**
 * Exchange a fresh credential, then let the caller retry once with it.
 *
 * A 401 is normal operation for this mount, not a failure: the remote admits one socket per
 * credential, so the value a leg read is usually already spent. The caller passes its own
 * replay flag (at most one retry), because replaying forever would turn one broken credential
 * into an unbounded stream of remote requests.
 * @param options.refresh - exchanges and stores a credential; omitted disables the replay.
 * @param options.retry - sends the same request again with the stored credential.
 * @param options.fail - answers the caller when the exchange itself fails.
 * @param options.report - receives the exchange failure; defaults to the host log.
 */
export function replayWithFreshCredential(options) {
  const report = typeof options.report === 'function' ? options.report : reportRefreshFailure
  // The exchange is deferred a turn so a synchronous throw from refresh() cannot escape into
  // the request handler that called this.
  Promise.resolve()
    .then(() => options.refresh())
    .then(() => { options.retry() })
    .catch((error) => {
      report(error)
      options.fail(error)
    })
}
