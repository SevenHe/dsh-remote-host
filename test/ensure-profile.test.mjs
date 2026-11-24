import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The self-heal script repairs a profile's registration. It must never rewrite the
 * profile's `node_modules/dsh-remote-host` link: an older copy of this agent did, and
 * repointed the running app at an unverified worktree every 30 minutes. These lock the
 * boundary: already registered means zero writes, and the link never moves.
 *
 * Every case runs against a throwaway DSH_HOME, never the real profile.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/ensure-profile.mjs')
const PLUGIN = 'dsh-remote-host'

function makeProfile({ bundles = [PLUGIN], dependency = 'link:/tmp/checkout', row = true, omitDependency = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'drh-ensure-home-'))
  const dshHome = join(home, '.dsh')
  const profile = join(dshHome, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const pkg = {
    name: 'dsh-profile-desktop',
    private: true,
    // Passing `undefined` would hit the default above, so omission needs its own flag.
    dependencies: omitDependency ? {} : { [PLUGIN]: dependency },
    dsh: { profile: { bundles } },
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const patch = row
    ? ['[]', '', '- id: ' + PLUGIN, '  config:', '    upstream: http://127.0.0.1:3080', '    mount: /devbox', '    label: devbox', ''].join('\n')
    : '[]\n'
  writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  const checkout = mkdtempSync(join(tmpdir(), 'drh-ensure-checkout-'))
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(checkout, join(profile, 'node_modules', PLUGIN))
  return { home, profile, checkout, env: { ...process.env, HOME: home, DSH_HOME: dshHome } }
}

/** Run the script with the throwaway home; return its exit code and combined output. */
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

test('ensure-profile: an already-registered profile is left byte-identical and the checkout link never moves', () => {
  const { profile, checkout, env } = makeProfile()
  const pkgBefore = readFileSync(join(profile, 'package.json'), 'utf8')
  const patchBefore = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')

  const result = run(env)
  assert.equal(result.code, 0, result.stdout)
  assert.match(result.stdout, /already registers/)
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), pkgBefore, 'package.json must not be rewritten')
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patchBefore, 'the config row must not be rewritten')
  assert.equal(readlinkSync(join(profile, 'node_modules', PLUGIN)), checkout, 'the profile link must not move')
  assert.deepEqual(readdirSync(profile).filter((name) => name.includes('.ensure-')), [], 'no backup is written when nothing is repaired')
})

test('ensure-profile: --check flags a dropped bundle entry, and the repair re-adds it without moving the link', () => {
  const { profile, checkout, env } = makeProfile({ bundles: [] })

  const check = run(env, ['--check'])
  assert.equal(check.code, 1, check.stdout)
  assert.match(check.stdout, /needs repair/)

  const repair = run(env)
  assert.equal(repair.code, 0, repair.stdout)
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh.profile.bundles.includes(PLUGIN), 'the bundle entry is back')
  assert.equal(readlinkSync(join(profile, 'node_modules', PLUGIN)), checkout, 'the profile link must not move')
  assert.ok(readdirSync(profile).some((name) => name.startsWith('package.json.ensure-')), 'the previous package.json is kept')
})

test('ensure-profile: a dropped config row is restored from the newest backup that still has one', () => {
  const { profile, env } = makeProfile({ row: false })
  writeFileSync(
    join(profile, 'cordis.patch.yml.bak-1795000000000'),
    ['[]', '', '- id: ' + PLUGIN, '  config:', '    mount: /devbox', '    label: recovered-label', ''].join('\n'),
  )

  const result = run(env)
  assert.equal(result.code, 0, result.stdout)
  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- id: dsh-remote-host$/m)
  assert.match(patch, /label: recovered-label/, 'the row comes from the backup, not from defaults')
})

test('ensure-profile: a missing dependency is reported instead of being invented', () => {
  const { env } = makeProfile({ omitDependency: true })
  const result = run(env)
  assert.equal(result.code, 2, result.stdout)
  assert.match(result.stdout, /dsh plugin --profile desktop add/)
})
