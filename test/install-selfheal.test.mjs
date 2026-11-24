import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The self-heal agent is opt-in, but installing it twice is how this machine once ended up
 * with two copies repairing the profile. These lock the two properties that keep it safe:
 * a second plist with the same Label blocks the install, and --dry-run changes nothing.
 *
 * Neither case touches the real launchd session: the guard exits before bootstrap, and
 * --dry-run stops before writing.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/install-selfheal.mjs')
const LABEL = 'com.dsh-remote-host.ensure-profile'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'drh-selfheal-home-'))
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true })
  mkdirSync(join(home, 'Library/Logs'), { recursive: true })
  return { home, env: { ...process.env, HOME: home } }
}

function run(env, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--profile', 'desktop', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

test('install-selfheal: a second plist carrying the same Label blocks the install', () => {
  const { home, env } = makeHome()
  writeFileSync(
    join(home, 'Library/LaunchAgents/com.some-old-name.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>' + LABEL + '</string>\n</dict></plist>\n',
  )
  const result = run(env)
  assert.equal(result.code, 2, result.stdout)
  assert.match(result.stdout, /another plist already carries the Label/)
  assert.equal(existsSync(join(home, 'Library/LaunchAgents', LABEL + '.plist')), false, 'nothing is written when the guard trips')
})

test('install-selfheal: --dry-run reports the plist path and writes nothing', () => {
  const { home, env } = makeHome()
  const result = run(env, ['--dry-run'])
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /would write/)
  assert.deepEqual(readdirSync(join(home, 'Library/LaunchAgents')), [], 'dry run must not create a plist')
})
