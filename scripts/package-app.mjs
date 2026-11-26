#!/usr/bin/env node
/**
 * Build the desktop artifact the way this machine needs it: with the upstream
 * model-catalogue fix already in it, verified in the finished dmg.
 *
 * Why this exists: the "a remote Session resolves its model from the Host that owns it"
 * change is not upstream, so a stock build silently loses it and remote Sessions fall back
 * to "请选择模型". The fix lives as scripts/patches/modelcatalog.patch; this script is
 * the only supported way to turn a checkout into a dmg, so no build can miss it and no
 * artifact ships without proof that it is in there.
 *
 *   node scripts/package-app.mjs                      # patch -> build -> package -> verify
 *   node scripts/package-app.mjs --dry-run            # print every command, change nothing
 *   node scripts/package-app.mjs verify --dmg <path>  # check an existing dmg / .app / app.asar
 *   node scripts/package-app.mjs deploy-remote --ssh devbox [--dry-run]
 *
 * @module
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPnpmCommand, pnpmMissingMessage, resolvePnpm } from './lib/pnpm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every upstream patch the build applies, discovered so a new one is recorded without a code change. */
const PATCH_FILES = readdirSync(join(HERE, 'patches')).filter((name) => name.endsWith('.patch')).sort()
const ROOT = resolve(HERE, '..')
const APPLY = join(HERE, 'apply-upstream-model-catalog.mjs')
/** A string that only the patch introduces. The stock build has 0 of it. */
const MARKER = 'OwnerEntry'
/** The stock build already contains this many (measured on the official 0.2.2-rc.5 app.asar); the patch adds more. */
const STOCK_STOREFOR = 17
const args = process.argv.slice(2)
const command = args[0] !== undefined && args[0].startsWith('--') !== true ? args[0] : 'package'
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const has = (name) => args.includes('--' + name)

/** The version lock lives in the patch replayer, so the two can never disagree. */
function upstreamLock() {
  const source = readFileSync(APPLY, 'utf8')
  const tag = /const BASE_TAG = '([^']+)'/.exec(source)
  const commit = /const BASE_COMMIT = '([^']+)'/.exec(source)
  if (tag === null || commit === null) fail('cannot read the version lock out of ' + APPLY)
  return { tag: tag[1], commit: commit[1] }
}

function fail(message) {
  console.error('package-app: ' + message)
  process.exit(1)
}

function run(argv, options = {}) {
  // Nested arrays let a call site keep its arguments readable: ['pnpm', ['run', 'build']].
  const flat = argv.flat()
  const printable = flat.join(' ')
  if (options.dryRun === true) {
    console.log('  [dry-run] ' + printable)
    return ''
  }
  console.log('  $ ' + printable)
  try {
    if (options.capture !== true) return execFileSync(flat[0], flat.slice(1), { cwd: options.cwd, encoding: 'utf8', stdio: 'inherit' })
    // Captured stdout is echoed afterwards; stderr stays a live stream so failures show as they happen.
    const output = execFileSync(flat[0], flat.slice(1), { cwd: options.cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
    process.stdout.write(output)
    return output
  } catch (error) {
    // A missing executable is a setup problem, not a build failure: name the command the operator
    // has to install instead of surfacing a stack whose first line is "spawnSync <cmd> ENOENT".
    if (error?.code === 'ENOENT') fail('cannot run ' + flat[0] + ': executable not found' + (isPnpmCommand(flat[0]) ? '; ' + pnpmMissingMessage() : ''))
    throw error
  }
}

/** The pnpm this run has to drive; the message names both ways out instead of a spawn stack. */
function requirePnpm(cwd) {
  const found = resolvePnpm({ cwd })
  if (found === undefined) fail(pnpmMissingMessage())
  return found
}

/** Count binary occurrences without pulling the whole 200 MB asar into a string. */
function countInFile(path, needle) {
  const buffer = readFileSync(path)
  const target = Buffer.from(needle)
  let count = 0
  let at = buffer.indexOf(target)
  while (at !== -1) {
    count += 1
    at = buffer.indexOf(target, at + target.length)
  }
  return count
}

function sha256(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function plistVersion(appDir) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(appDir, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  } catch (error) { return 'unknown' }
}

/** Detach a temporary mount and delete the directory mkdtempSync created for it. */
function detachMount(mountPoint) {
  execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' })
  // hdiutil leaves the (now empty) mount point behind; it is ours, so it goes with the mount.
  rmSync(mountPoint, { recursive: true, force: true })
}

/** The app bundle inside a dmg, an .app, or an app.asar. */
function locateAsar(target) {
  const path = resolve(target)
  if (!existsSync(path)) fail('not found: ' + path)
  if (path.endsWith('app.asar')) return { asar: path, app: dirname(dirname(dirname(path))), mounted: undefined }
  // Any bundle shape works here, including archived copies such as "Foo.app.saved".
  if (statSync(path).isDirectory()) {
    const asar = join(path, 'Contents/Resources/app.asar')
    if (existsSync(asar)) return { asar, app: path, mounted: undefined }
  }
  if (path.endsWith('.dmg') !== true) fail('expected a .dmg, .app or app.asar: ' + path)
  const mountPoint = mkdtempSync(join(tmpdir(), 'drh-verify-'))
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, path], { stdio: 'pipe' })
  const app = readdirSync(mountPoint).filter((name) => name.endsWith('.app')).map((name) => join(mountPoint, name))[0]
  if (app === undefined) {
    detachMount(mountPoint)
    fail('no .app inside ' + path)
  }
  const asar = join(app, 'Contents/Resources/app.asar')
  if (!existsSync(asar)) {
    detachMount(mountPoint)
    fail('no app.asar inside ' + app)
  }
  return { asar, app, mounted: mountPoint }
}

/**
 * The gate. An artifact without the patch is not shippable: on it, a remote Session shows
 * "请选择模型" and the whole point of this build is gone.
 */
function verify(target, { quiet = false } = {}) {
  const found = locateAsar(target)
  try {
    const marker = countInFile(found.asar, MARKER)
    const storeFor = countInFile(found.asar, 'storeFor')
    const version = plistVersion(found.app)
    const patched = marker > 0 && storeFor > STOCK_STOREFOR
    if (quiet !== true) {
      console.log('verify  : ' + resolve(target))
      console.log('  version    ' + version)
      console.log('  ' + MARKER.padEnd(10) + ' ' + marker + (marker > 0 ? ' (patch present)' : ' (MISSING — stock build)'))
      console.log('  storeFor   ' + storeFor + ' (stock has ' + STOCK_STOREFOR + ')')
    }
    if (patched !== true) fail('this artifact does NOT carry the model-catalogue patch: ' + resolve(target))
    if (quiet !== true) console.log('  verdict    OK')
    return { version, marker, storeFor, asar: found.asar, app: found.app }
  } finally {
    if (found.mounted !== undefined) detachMount(found.mounted)
  }
}

/** The patch's own replay guard keys on the client catalogue, which is where the marker lives. */
function repoIsPatched(repo) {
  const catalogue = join(repo, 'packages/client/ui-model-selection/src/client/catalog.ts')
  return existsSync(catalogue) && readFileSync(catalogue, 'utf8').includes(MARKER)
}

function packageApp() {
  const dryRun = has('dry-run')
  const repo = resolve(argOf('repo', join(process.env.HOME ?? '', 'Workspace/deepseek-harness')))
  const outDir = resolve(argOf('out', join(process.env.HOME ?? '', 'Workspace/dsh-app-build')))
  const skipInstall = has('skip-install')
  const lock = upstreamLock()
  if (existsSync(repo) !== true) fail('harness checkout not found: ' + repo + ' (pass --repo)')

  console.log('== 1/4 source: patch the locked upstream revision ==')
  console.log('  repo     ' + repo)
  console.log('  base     ' + lock.tag + ' (' + lock.commit + ')')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()
  if (repoIsPatched(repo)) {
    console.log('  state    already patched — skipping the replay')
    if (head !== lock.commit) fail('patched tree is not on the locked base ' + lock.commit + ' (HEAD ' + head + ')')
  } else if (dirty.length > 0) {
    fail('checkout has unrelated changes; commit, stash or reset it first:\n' + dirty)
  } else {
    run([process.execPath, APPLY, '--repo', repo, '--checkout'], { dryRun })
  }

  console.log('== 2/4 build ==')
  // A dry run only prints, so it must work on a machine without pnpm; a real run resolves the
  // executable once, up front, so every build step calls the same one.
  const pnpm = dryRun ? 'pnpm' : requirePnpm(repo)
  if (skipInstall !== true) run([pnpm, ['install', '--ignore-scripts']], { cwd: repo, dryRun })
  run([pnpm, ['run', 'build']], { cwd: repo, dryRun })
  // The packaging step below prepares the runtime itself: `build --profile local`, pack,
  // prepare:runtime, prepare:packages and prepare:dsh. `prepare:desktop` is the release
  // `--prepare-only` mode instead: it reads apps/desktop/.env.macos release settings and
  // refuses to run without that file, which a local unsigned build neither has nor needs.

  console.log('== 3/4 package (unsigned dmg) ==')
  const packOutput = run([pnpm, ['run', 'package:desktop:mac:arm64:unsigned']], { cwd: repo, dryRun, capture: true })

  if (dryRun) {
    console.log('')
    console.log('dry run: nothing was built or written.')
    return
  }

  console.log('== 4/4 verify the artifact, then publish it to ' + outDir + ' ==')
  const produced = dmgFromOutput(packOutput) ?? newestDmg(repo)
  if (produced === undefined) fail('no dmg was produced under ' + repo)
  const { version, marker, storeFor } = verify(produced)
  mkdirSync(outDir, { recursive: true })
  const name = 'deepseek-harness-' + version + '-mac-arm64-unsigned.dmg'
  const target = join(outDir, name)
  copyFileSync(produced, target)
  const manifest = {
    app: name,
    version,
    baseTag: lock.tag,
    baseCommit: lock.commit,
    patch: 'scripts/patches/modelcatalog.patch',
    patchSha256: sha256(join(HERE, 'patches/modelcatalog.patch')),
    patches: PATCH_FILES.map((name) => ({ file: 'scripts/patches/' + name, sha256: sha256(join(HERE, 'patches', name)) })),
    markers: { [MARKER]: marker, storeFor, stockStoreFor: STOCK_STOREFOR },
    dmgSha256: sha256(target),
    dmgBytes: statSync(target).size,
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('')
  console.log('artifact : ' + target)
  console.log('bytes    : ' + manifest.dmgBytes)
  console.log('sha256   : ' + manifest.dmgSha256)
  console.log('manifest : ' + join(outDir, 'manifest.json'))
  console.log('')
  console.log('the remote Host needs the same fix; deploy it with:')
  console.log('  node scripts/package-app.mjs deploy-remote --ssh <host>')
}

/**
 * The artifact this run just wrote: the harness prints `DMG: <path>` for exactly this purpose
 * when a macOS packaging step succeeds, which is more reliable than searching the build tree.
 * @param output - Captured stdout of the packaging command.
 * @returns The existing dmg path, or undefined when the line is absent or stale.
 */
function dmgFromOutput(output) {
  const match = /^DMG: (.+)$/mu.exec(output)
  if (match === null) return undefined
  const path = match[1].trim()
  return existsSync(path) ? path : undefined
}

/**
 * Fallback when no `DMG:` line was printed: scan the desktop build output directories.
 * The scan stays shallow and skips bundle and store directories, because the packaging tree
 * holds a full Electron app and a pnpm store, and the dmg sits at a fixed shallow depth.
 * @param repo - Harness checkout root.
 * @returns The newest dmg path, or undefined when none exists.
 */
function newestDmg(repo) {
  const roots = [
    join(repo, 'apps/desktop/.desktop-build/targets'),
    join(repo, 'apps/desktop/dist'),
    join(repo, 'apps/desktop/release'),
  ]
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2 || existsSync(dir) !== true) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.endsWith('.app')) continue
        walk(path, depth + 1)
      } else if (entry.name.endsWith('.dmg')) found.push({ path, at: statSync(path).mtimeMs })
    }
  }
  for (const root of roots) walk(root, 0)
  found.sort((left, right) => right.at - left.at)
  return found[0]?.path
}

/**
 * Copy the two patched packages onto a Host's runtime. Without this the app is fixed but
 * the remote Host still answers the old model catalogue, so remote Sessions keep asking.
 */
function deployRemote() {
  const dryRun = has('dry-run')
  const sshHost = argOf('ssh', 'devbox')
  const remoteRuntime = argOf('remote-runtime', '~/.local/share/super-agent/runtime/node_modules/@deepseek-ai')
  const repo = resolve(argOf('repo', join(process.env.HOME ?? '', 'Workspace/deepseek-harness')))
  const packages = [
    { name: 'dsh-api-session-controller', from: join(repo, 'packages/api/session-controller/lib') },
    { name: 'dsh-client-ui-model-selection', from: join(repo, 'packages/client/ui-model-selection/lib') },
  ]
  for (const item of packages) {
    if (existsSync(item.from) !== true) fail('build output missing: ' + item.from + ' (build first)')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const remote = (command) => run(['ssh', ['-o', 'BatchMode=yes', '-T', sshHost, command]], { dryRun })
  // A single-quoted `~` never expands in the remote shell: the backup then copied nothing and the
  // upload addressed a relative path, while the run still looked successful. Resolve the remote home
  // once and quote the absolute path instead.
  const remoteHome = dryRun ? '$HOME' : run(['ssh', ['-o', 'BatchMode=yes', '-T', sshHost, 'printf %s "$HOME"']], { capture: true }).trim()
  if (remoteHome.length === 0) fail('could not resolve the home directory on ' + sshHost)
  const runtimePath = remoteRuntime.startsWith('~/') ? remoteHome + remoteRuntime.slice(1) : remoteRuntime
  const backup = runtimePath + '/modelcatalog-backup-' + stamp
  console.log('== deploy the model-catalogue fix to ' + sshHost + ' ==')
  console.log('  runtime  ' + runtimePath)
  console.log('  backup   ' + backup)
  const quoted = (path) => (path.startsWith('$HOME') ? '"' + path + '"' : "'" + path + "'")
  const names = packages.map((item) => quoted(item.name)).join(' ')
  remote('mkdir -p ' + quoted(backup) + ' && for p in ' + names + '; do mkdir -p ' + quoted(backup) + '/$p && cp -a ' + quoted(runtimePath) + '/$p/. ' + quoted(backup) + '/$p/ || exit 1; done && echo "package-app: backed up to ' + backup + '"')
  for (const item of packages) {
    const archive = join(mkdtempSync(join(tmpdir(), 'drh-deploy-')), item.name + '.tar.gz')
    if (dryRun !== true) {
      execFileSync('tar', ['-czf', archive, '-C', item.from, '.'])
      run(['scp', ['-o', 'BatchMode=yes', archive, sshHost + ':' + backup + '/' + item.name + '.tar.gz']], { dryRun })
      // The archive holds the contents of the package's lib/, so it extracts into lib/ rather than
      // the package root; extracting one level up left the shipped lib/ untouched and scattered
      // copies of the patched files beside it.
      const libPath = runtimePath + '/' + item.name + '/lib'
      remote('mkdir -p ' + quoted(libPath) + ' && tar -xzf ' + quoted(backup + '/' + item.name + '.tar.gz') + ' -C ' + quoted(libPath) + ' && echo "package-app: deployed ' + item.name + '"')
    }
  }
  console.log('')
  console.log('restart the Host so it loads the new packages:')
  console.log('  ssh ' + sshHost + ' "pkill -f \'dsh --profile\' || true"   # its watchdog restarts it')
  console.log('rollback: cp -a ' + backup + '/. ' + runtimePath + '/ && restart the Host')
}

if (command === 'verify') {
  const dmg = argOf('dmg', argOf('app', ''))
  if (dmg === '') fail('verify needs --dmg <path> (a .dmg, .app or app.asar)')
  const result = verify(dmg)
  console.log('')
  console.log('OK: ' + result.asar)
} else if (command === 'deploy-remote') {
  deployRemote()
} else if (command === 'package') {
  packageApp()
} else {
  fail('unknown command: ' + command + ' (package | verify | deploy-remote)')
}
