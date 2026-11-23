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
 * The patch is version-locked on purpose. It applies to tag dsh-v0.2.2-rc.5
 * (9c2670d3); the file names and helper shapes differ on other revisions, so a
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

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, 'patches', 'rc5-modelcatalog.patch')
/** The upstream revision this patch was written against. */
const BASE_TAG = 'dsh-v0.2.2-rc.5'
const BASE_COMMIT = '9c2670d3bce5275e0d1610272958121af87787bb'

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

const rawRepo = argOf('repo', '')
if (rawRepo.length === 0) fail('--repo <path to a deepseek-harness clone> is required')
const repo = resolve(rawRepo.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
if (existsSync(repo) !== true) fail('repo not found: ' + repo)
if (existsSync(PATCH) !== true) fail('patch missing: ' + PATCH)

if (existsSync(join(repo, '.git')) !== true) fail('not a git checkout: ' + repo)

console.log('repo    : ' + repo)
console.log('patch   : ' + PATCH + ' (' + String(readFileSync(PATCH, 'utf8').length) + ' bytes)')

// Applied already?
const porcelain = git(repo, ['status', '--porcelain'])
if (porcelain.indexOf('ui-model-selection') !== -1) {
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

console.log('apply   : git apply --3way')
try {
  git(repo, ['apply', '--3way', PATCH])
} catch (error) {
  fail('patch did not apply: ' + String(error && error.message ? error.message : error))
}

const touched = git(repo, ['status', '--porcelain']).split('\n').filter((line) => line.trim().length > 0)
console.log('touched :')
for (const line of touched) console.log('  ' + line)

if (has('build') === true) {
  console.log('build   : pnpm install --ignore-scripts')
  execFileSync('pnpm', ['install', '--ignore-scripts'], { cwd: repo, stdio: 'inherit' })
  console.log('build   : pnpm run build:artifacts')
  execFileSync('pnpm', ['run', 'build:artifacts'], { cwd: repo, stdio: 'inherit' })
  console.log('build   : done — packages/client/ui-model-selection/lib and packages/api/session-controller/lib are ready to copy')
}

console.log('')
console.log('next steps (on the Host that should carry the fix):')
console.log('  1. back up runtime/node_modules/@deepseek-ai/dsh-api-session-controller and dsh-client-ui-model-selection')
console.log('  2. copy each package lib/ from the build over the runtime copy')
console.log('  3. restart the Host process the way it was started, then curl its port for 401')
