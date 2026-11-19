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
const profileName = flag('profile', 'desktop')
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)

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
