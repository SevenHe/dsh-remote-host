/**
 * Locate the pnpm executable the packaging scripts drive.
 *
 * Why this exists: both entry points used to spawn a bare `pnpm`, so a shell that does not put
 * pnpm on PATH (launchd, an editor task, a machine where pnpm comes from corepack) failed with
 * `spawnSync pnpm ENOENT` and a stack instead of telling the operator what to install. A checkout
 * built with `pnpm install` carries the executable in its own `node_modules/.bin`, so that copy is
 * a real fallback rather than a guess.
 *
 * @module
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Overrides discovery when pnpm lives outside PATH and outside the checkout. */
export const PNPM_ENV_VAR = 'PNPM'

/** The two ways out, quoted by every failure path so the message is actionable. */
export const PNPM_MISSING_HINT = 'install pnpm (npm install -g pnpm) or set ' + PNPM_ENV_VAR + ' to its path'

/** Windows resolves executables through PATHEXT; packaging runs on macOS, but a shared checkout must not crash. */
const WINDOWS_SUFFIXES = ['.cmd', '.exe', '.bat']

/** Executable files only: a directory or a non-executable file is not a usable command. */
function isExecutableFile(path) {
  try {
    if (statSync(path).isFile() !== true) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // Missing or unreadable both mean "not usable here"; the caller tries the next candidate.
    return false
  }
}

/** The pnpm inside a checkout's own bin directory, if it has one. */
function localPnpm(cwd) {
  const name = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const path = join(cwd, 'node_modules', '.bin', name)
  return isExecutableFile(path) ? path : undefined
}

/** First usable pnpm on PATH; an empty PATH entry is skipped rather than read as the working directory. */
function pnpmOnPath(env) {
  const suffixes = process.platform === 'win32' ? ['', ...WINDOWS_SUFFIXES] : ['']
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    for (const suffix of suffixes) {
      const path = join(dir, 'pnpm' + suffix)
      if (isExecutableFile(path)) return path
    }
  }
  return undefined
}

/**
 * Find the pnpm a command should run, in the order the failure message promises.
 *
 * `PNPM` wins over discovery because it is the operator saying where pnpm is; a value that is not
 * executable is a miss rather than a silent fallback, so a typo surfaces instead of running a
 * second copy of pnpm that happens to be on PATH.
 * @param options.cwd - checkout the command runs in; its `node_modules/.bin` is the last candidate.
 * @param options.env - environment to search; defaults to this process's.
 * @returns Path to the executable, or undefined when nothing usable was found.
 */
export function resolvePnpm({ cwd = process.cwd(), env = process.env } = {}) {
  const override = env[PNPM_ENV_VAR]
  if (override !== undefined && override.length > 0) return isExecutableFile(override) ? override : undefined
  return pnpmOnPath(env) ?? localPnpm(cwd)
}

/**
 * Whether a command name refers to pnpm, absolute paths from {@link resolvePnpm} included.
 * @param command - the argv[0] of a command that is about to run.
 * @returns True when the command is a pnpm executable.
 */
export function isPnpmCommand(command) {
  const name = String(command).split(/[\\/]/u).pop() ?? ''
  return /^pnpm(?:\.(?:cmd|exe|bat))?$/iu.test(name)
}

/**
 * Explain why no pnpm was found, without claiming a cause that did not happen.
 * @param options.env - environment that was searched; defaults to this process's.
 * @returns A sentence naming both ways out, or the unusable `PNPM` value that blocked discovery.
 */
export function pnpmMissingMessage({ env = process.env } = {}) {
  const override = env[PNPM_ENV_VAR]
  if (override !== undefined && override.length > 0) {
    return PNPM_ENV_VAR + ' points at ' + override + ', which is not an executable file; ' + PNPM_MISSING_HINT
  }
  return 'pnpm not found: neither on PATH nor in the checkout\'s node_modules/.bin; ' + PNPM_MISSING_HINT
}
