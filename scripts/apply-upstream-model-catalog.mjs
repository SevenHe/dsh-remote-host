#!/usr/bin/env node
/**
 * Re-apply, and optionally build, the upstream model-catalogue patch.
 *
 * Why this lives here: the "a remote Session resolves its model from the host that
 * owns it" change belongs to deepseek-harness itself, but it is not upstream yet, so
 * the built packages on a remote Host carry it as a local modification. Without a
 * replayable artefact that modification exists only as bytes in somebody's checkout —
 * and a Host that has to be rebuilt (or a new machine) silently loses the fix.
 *
 * The patch is version-locked on purpose. It applies to tag dsh-v0.2.3-alpha.2
 * (4b399c39); the file names and helper shapes differ on other revisions, so a
 * fuzzy apply would produce code that compiles but means something else.
 *
 *   node scripts/apply-upstream-model-catalog.mjs --repo ~/Workspace/deepseek-harness
 *   node scripts/apply-upstream-model-catalog.mjs --repo ... --build
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pnpmMissingMessage, resolvePnpm } from './lib/pnpm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Upstream patches, applied in order. Each is version-locked to the revision below. */
const PATCHES = [
  join(HERE, 'patches', 'modelcatalog.patch'),
  join(HERE, 'patches', 'hidden-sessions.patch'),
]
/** The upstream revision this patch was written against. */
const BASE_TAG = 'dsh-v0.2.3-alpha.2'
const BASE_COMMIT = '4b399c39a6d1479cd84ca591b4d7c88e24d38a96'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const has = (name) => args.includes('--' + name)

function fail(message) {
  console.error('apply-upstream: ' + message)
  process.exit(1)
}

function git(repo, argv) {
  return execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim()
}

/**
 * Run pnpm in the checkout.
 * @param pnpm - executable to run, as returned by resolvePnpm.
 * @param argv - arguments to pass through.
 * @param cwd - checkout the command runs in.
 * @returns Nothing; a missing executable reports the way out instead of a spawn stack.
 */
function pnpmRun(pnpm, argv, cwd) {
  try {
    return execFileSync(pnpm, argv, { cwd, stdio: 'inherit' })
  } catch (error) {
    if (error?.code === 'ENOENT') fail('cannot run ' + pnpm + ': executable not found; ' + pnpmMissingMessage())
    throw error
  }
}

const rawRepo = argOf('repo', '')
if (rawRepo.length === 0) fail('--repo <path to a deepseek-harness clone> is required')
const repo = resolve(rawRepo.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
if (existsSync(repo) !== true) fail('repo not found: ' + repo)
for (const patch of PATCHES) if (existsSync(patch) !== true) fail('patch missing: ' + patch)

if (existsSync(join(repo, '.git')) !== true) fail('not a git checkout: ' + repo)

console.log('repo    : ' + repo)
for (const patch of PATCHES) console.log('patch   : ' + patch + ' (' + String(readFileSync(patch, 'utf8').length) + ' bytes)')

// Applied already?
const porcelain = git(repo, ['status', '--porcelain'])
if (porcelain.indexOf('ui-model-selection') !== -1 || porcelain.indexOf('ui-workspace') !== -1) {
  console.log('note    : the working tree already has model-selection changes; refusing to stack patches')
  fail('dirty tree on ui-model-selection — commit, stash or reset first')
}

let head = git(repo, ['rev-parse', 'HEAD'])
console.log('head    : ' + head)

if (head !== BASE_COMMIT) {
  if (has('checkout') !== true) {
    console.log('note    : HEAD is not ' + BASE_TAG + ' (' + BASE_COMMIT + ')')
    console.log('          re-run with --checkout to move to the base tag, or check the base commit yourself')
    fail('wrong base revision')
  }
  console.log('checkout: fetching ' + BASE_TAG)
  try {
    git(repo, ['fetch', '--depth=1', 'origin', 'refs/tags/' + BASE_TAG])
  } catch (error) {
    fail('could not fetch ' + BASE_TAG + ': ' + String(error))
  }
  git(repo, ['checkout', '--detach', 'FETCH_HEAD'])
  head = git(repo, ['rev-parse', 'HEAD'])
  console.log('head    : ' + head + ' (after checkout)')
  if (head !== BASE_COMMIT) fail('resolved ' + BASE_TAG + ' to ' + head + ', expected ' + BASE_COMMIT)
}

for (const patch of PATCHES) {
  console.log('apply   : git apply --3way ' + patch)
  try {
    git(repo, ['apply', '--3way', patch])
  } catch (error) {
    fail('patch did not apply: ' + patch + ': ' + String(error && error.message ? error.message : error))
  }
}

const touched = git(repo, ['status', '--porcelain']).split('\n').filter((line) => line.trim().length > 0)
console.log('touched :')
for (const line of touched) console.log('  ' + line)

if (has('build') === true) {
  // Resolve once so both steps drive the same pnpm; a shell without pnpm on PATH is reported by
  // name and remedy instead of failing inside the first spawn with an ENOENT stack.
  const pnpm = resolvePnpm({ cwd: repo })
  if (pnpm === undefined) fail(pnpmMissingMessage())
  console.log('build   : pnpm install --ignore-scripts')
  pnpmRun(pnpm, ['install', '--ignore-scripts'], repo)
  console.log('build   : pnpm run build:artifacts')
  pnpmRun(pnpm, ['run', 'build:artifacts'], repo)
  console.log('build   : done — packages/client/ui-model-selection/lib and packages/api/session-controller/lib are ready to copy')
}

console.log('')
console.log('next steps (on the Host that should carry the fix):')
console.log('  1. back up runtime/node_modules/@deepseek-ai/dsh-api-session-controller and dsh-client-ui-model-selection')
console.log('  2. copy each package lib/ from the build over the runtime copy')
console.log('  3. restart the Host process the way it was started, then curl its port for 401')
