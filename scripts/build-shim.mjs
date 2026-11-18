#!/usr/bin/env node
/**
 * Assemble lib/shim.js from the modules in src/shim.
 *
 * The shim is injected into the page as one classic script inside a single IIFE,
 * so the modules are concatenated rather than imported. Order is significant:
 * every module shares the IIFE scope, and declarations are therefore visible to
 * the modules that follow. Rebuild after editing src/shim/*.js:
 *
 *   node scripts/build-shim.mjs [--check]
 *
 * `--check` exits non-zero when lib/shim.js is stale, for CI.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourceDir = join(root, 'src/shim')
const target = join(root, 'lib/shim.js')

const head = readFileSync(join(sourceDir, '00-head.txt'), 'utf8')
const tail = readFileSync(join(sourceDir, '99-tail.txt'), 'utf8')
const modules = readdirSync(sourceDir)
  .filter((name) => /^\d\d-[a-z-]+\.js$/.test(name))
  .sort()

if (modules.length === 0) throw new Error('no shim modules found in ' + sourceDir)

const body = modules.map((name) => readFileSync(join(sourceDir, name), 'utf8')).join('')
const assembled = head + body + tail

if (process.argv.includes('--check')) {
  let current = ''
  try { current = readFileSync(target, 'utf8') } catch { /* missing counts as stale */ }
  if (current !== assembled) {
    console.error('lib/shim.js is stale; run: node scripts/build-shim.mjs')
    process.exit(1)
  }
  console.log('lib/shim.js is up to date (' + modules.length + ' modules)')
  process.exit(0)
}

writeFileSync(target, assembled)
console.log('built lib/shim.js from ' + modules.length + ' modules (' + assembled.split('\n').length + ' lines)')
