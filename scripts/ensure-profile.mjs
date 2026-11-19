#!/usr/bin/env node
/**
 * Re-register this plugin in a profile after the app drops it.
 *
 * The desktop app rewrites `profiles/<name>/package.json` while migrating a profile
 * (it keeps `dependencies` but drops bundle entries it does not ship), which silently
 * unloads the plugin. This repairs both halves — the bundle entry and the config row —
 * and recovers the previous row from a backup when one exists.
 *
 *   node scripts/ensure-profile.mjs [--profile desktop] [--check]
 *
 * `--check` exits 1 when a repair is needed, so it can gate a restart.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'dsh-remote-host'
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const checkOnly = args.includes('--check')
const force = args.includes('--force')
const profileName = flag('profile', 'desktop')
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)

/** Kill switch: drop the plugin from a profile in one command. */
if (args.includes('--disable')) {
  const stampOff = Date.now()
  copyFileSync(pkgPath, pkgPath + '.disable-' + stampOff)
  pkg.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN)
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const patchOff = /^- id: dsh-remote-host\n(?: {2,}.*\n?)+/m
  if (patchOff.test(patchText)) {
    copyFileSync(patchPath, patchPath + '.disable-' + stampOff)
    writeFileSync(patchPath, patchText.replace(patchOff, ''))
  }
  console.log('ensure-profile: disabled ' + PLUGIN + ' in ' + profileName)
  process.exit(0)
}

if (!existsSync(profileDir)) {
  console.error('ensure-profile: no profile at ' + profileDir)
  process.exit(2)
}

const pkgPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('ensure-profile: ' + pkgPath + ' has no dsh.profile.bundles')
  process.exit(2)
}

const repairs = []
if (!bundles.includes(PLUGIN)) repairs.push('bundle')
const patchText = readFileSync(patchPath, 'utf8')
if (/^- id: dsh-remote-host\s*$/m.test(patchText) !== true) repairs.push('row')
if (pkg.dependencies?.[PLUGIN] === undefined) repairs.push('dependency')

if (repairs.length === 0) {
  console.log('ensure-profile: ' + profileName + ' already registers ' + PLUGIN)
  process.exit(0)
}
if (checkOnly) {
  console.error('ensure-profile: ' + profileName + ' needs repair: ' + repairs.join(', '))
  process.exit(1)
}
if (repairs.includes('dependency')) {
  console.error('ensure-profile: the dependency is gone; run: dsh plugin --profile ' + profileName + ' add ' + PLUGIN)
  process.exit(2)
}

const stamp = Date.now()

/**
 * Circuit breaker: a plugin that crashes the renderer must not be re-registered by this
 * script, or the repair itself creates a crash loop. Two renderer crash reports inside
 * 30 minutes mean "leave it out and say so".
 */
function recentRendererCrashes() {
  const dir = join(process.env.HOME ?? '', 'Library/Logs/DiagnosticReports')
  try {
    return readdirSync(dir).filter((name) => /Harness.*Renderer.*\.ips$/.test(name)).filter((name) => {
      const at = /(\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})(\d{2}))/.exec(name)
      if (at === null) return false
      const when = new Date(at[1].slice(0, 10) + 'T' + at[2] + ':' + at[3] + ':' + at[4]).getTime()
      return Date.now() - when < 30 * 60 * 1000
    }).length
  } catch (error) { return 0 }
}
const crashes = recentRendererCrashes()
if (crashes >= 2 && checkOnly !== true) {
  console.error('ensure-profile: ' + crashes + ' renderer crashes in the last 30 minutes; leaving ' + PLUGIN + ' unregistered')
  console.error('ensure-profile: re-run with --force once the cause is fixed')
  process.exit(3)
}

/** The row this plugin used last, recovered from the newest backup that has one. */
function recoverRow() {
  const backups = readdirSync(profileDir)
    .filter((name) => name.startsWith('cordis.patch.yml.'))
    .map((name) => ({ name, at: Number((/\.bak[^0-9]*(\d{10,})/.exec(name) ?? [])[1] ?? 0) }))
    .sort((left, right) => right.at - left.at)
  for (const backup of backups) {
    const text = readFileSync(join(profileDir, backup.name), 'utf8')
    const match = /^- id: dsh-remote-host\n(?: {2,}.*\n?)+/m.exec(text)
    if (match !== null) return { row: match[0].trimEnd(), from: backup.name }
  }
  return undefined
}

if (repairs.includes('bundle')) {
  copyFileSync(pkgPath, pkgPath + '.ensure-' + stamp)
  bundles.push(PLUGIN)
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log('ensure-profile: re-added ' + PLUGIN + ' to bundles (' + bundles.length + ' total)')
}

if (repairs.includes('row')) {
  const recovered = recoverRow()
  copyFileSync(patchPath, patchPath + '.ensure-' + stamp)
  const row = recovered === undefined
    ? ['- id: ' + PLUGIN, '  config:', '    upstream: http://127.0.0.1:3080', '    mount: /devbox', '    label: remote'].join('\n')
    : recovered.row
  writeFileSync(patchPath, patchText.replace(/\n?$/, '\n') + row + '\n')
  console.log('ensure-profile: re-added the config row' + (recovered === undefined ? ' (defaults)' : ' (from ' + recovered.from + ')'))
}
console.log('ensure-profile: repaired ' + repairs.join(', ') + ' in ' + profileName)
