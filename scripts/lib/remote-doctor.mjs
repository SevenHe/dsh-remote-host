/**
 * Judgements the remote host doctor makes from short shell output.
 *
 * They live apart from the CLI so a test can pin the failure wording without an ssh session, and
 * so no check can quietly start accepting the state it exists to catch.
 * @module scripts/lib/remote-doctor
 */

/** The key the memory runtime presents to OpenViking, read from this file by the launcher. */
export const KEY_FILE = '~/.config/super-agent/openviking/api-key'

/**
 * Read the key file's mode and size from `stat` output.
 * @param output - `%a %s` (GNU) or `%Lp %z` (BSD) formatted stat output.
 * @returns Whether the file exists, is owner-only, and is non-empty; with a detail line.
 */
export function keyFileCheck(output) {
  const text = String(output).trim()
  if (text.length === 0) return { ok: false, detail: 'key file missing' }
  const [mode, size] = text.split(/\s+/)
  if (mode !== '600') return { ok: false, detail: 'key file mode is ' + String(mode) + ', want 600' }
  if (!(Number(size) > 0)) return { ok: false, detail: 'key file is empty' }
  return { ok: true, detail: 'key file 0600, ' + String(size) + ' bytes' }
}

/**
 * Read whether the Host banner is reachable.
 * @param output - The banner line the remote shell printed, or empty.
 * @returns Whether a token-bearing entry URL was found, without echoing it.
 */
export function bannerCheck(output) {
  return /\?token=[A-Za-z0-9_-]+/.test(String(output))
    ? { ok: true, detail: 'entry banner reachable' }
    : { ok: false, detail: 'no entry banner in the configured log' }
}

/**
 * Read whether the Host process environment carries the memory key.
 * @param output - A count of matching environment entries.
 * @returns Whether the variable is present, reported by name only.
 */
export function envCheck(output) {
  const count = Number(String(output).trim())
  return count > 0
    ? { ok: true, detail: 'Host environment carries OPENVIKING_API_KEY' }
    : { ok: false, detail: 'Host environment has no OPENVIKING_API_KEY' }
}

/**
 * Read whether the memory endpoint answers.
 * @param status - HTTP status from `/orchestrator/api/memory`.
 * @returns Whether OpenViking answered through the memory runtime.
 */
export function memoryCheck(status) {
  return status === 200
    ? { ok: true, detail: 'memory endpoint answered 200' }
    : { ok: false, detail: 'memory endpoint answered ' + String(status) + ' (OpenViking refused the runtime)' }
}
