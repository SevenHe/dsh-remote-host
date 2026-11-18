#!/usr/bin/env node
/**
 * Guard the package manifest: every path it advertises must exist, so a renamed
 * file cannot ship a broken bundle or client half.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const missing = []
const check = (path) => {
  if (typeof path !== 'string') return
  if (!existsSync(resolve(root, path))) missing.push(path)
}
check(pkg.main)
check(pkg.dsh?.bundle?.patch)
for (const entry of Object.values(pkg.exports ?? {})) check(entry)
for (const entry of pkg.files ?? []) check(entry)
if (missing.length > 0) {
  console.error('manifest references missing paths: ' + missing.join(', '))
  process.exit(1)
}
console.log('manifest ok: ' + pkg.name + '@' + pkg.version)
