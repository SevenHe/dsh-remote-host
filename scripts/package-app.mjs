#!/usr/bin/env node
/**
 * Build the desktop artifact the way this machine needs it: with the upstream
 * model-catalogue fix already in it, verified in the finished dmg.
 *
 * Why this exists: the "a remote Session resolves its model from the Host that owns it"
 * change is not upstream, so a stock build silently loses it and remote Sessions fall back
 * to "请选择模型". The fix lives as scripts/patches/rc5-modelcatalog.patch; this script is
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

const HERE = dirname(fileURLToPath(import.meta.url))
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
  return execFileSync(flat[0], flat.slice(1), { cwd: options.cwd, encoding: 'utf8', stdio: options.capture === true ? 'pipe' : 'inherit' })
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
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' })
    fail('no .app inside ' + path)
  }
  const asar = join(app, 'Contents/Resources/app.asar')
  if (!existsSync(asar)) {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' })
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
    if (found.mounted !== undefined) execFileSync('hdiutil', ['detach', found.mounted], { stdio: 'pipe' })
  }
}

function repoIsPatched(repo) {
  return existsSync(join(repo, 'packages/api/session-controller/src/index.ts')) &&
    readFileSync(join(repo, 'packages/api/session-controller/src/index.ts'), 'utf8').includes(MARKER)
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
  if (skipInstall !== true) run(['pnpm', ['install', '--ignore-scripts']], { cwd: repo, dryRun })
  run(['pnpm', ['run', 'build']], { cwd: repo, dryRun })
  run(['pnpm', ['run', 'prepare:desktop']], { cwd: repo, dryRun })

  console.log('== 3/4 package (unsigned dmg) ==')
  run(['pnpm', ['run', 'package:desktop:mac:arm64:unsigned']], { cwd: repo, dryRun })

  if (dryRun) {
    console.log('')
    console.log('dry run: nothing was built or written.')
    return
  }

  console.log('== 4/4 verify the artifact, then publish it to ' + outDir + ' ==')
  const produced = newestDmg(repo)
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
    patch: 'scripts/patches/rc5-modelcatalog.patch',
    patchSha256: sha256(join(HERE, 'patches/rc5-modelcatalog.patch')),
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

/** The dmg electron-builder just wrote, whatever directory it chose. */
function newestDmg(repo) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name.endsWith('.dmg')) found.push({ path, at: statSync(path).mtimeMs })
    }
  }
  walk(repo, 0)
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
  const backup = remoteRuntime + '/modelcatalog-backup-' + stamp
  console.log('== deploy the model-catalogue fix to ' + sshHost + ' ==')
  console.log('  runtime  ' + remoteRuntime)
  console.log('  backup   ' + backup)
  const remote = (command) => run(['ssh', ['-o', 'BatchMode=yes', '-T', sshHost, command]], { dryRun })
  const quoted = (path) => "'" + path + "'"
  remote('mkdir -p ' + quoted(backup) + ' && for p in ' + packages.map((item) => quoted(item.name)).join(' ') + '; do cp -a ' + quoted(remoteRuntime) + '/$p/. ' + quoted(backup) + '/$p/ 2>/dev/null || true; done && echo "package-app: backed up to ' + backup + '"')
  for (const item of packages) {
    const archive = join(mkdtempSync(join(tmpdir(), 'drh-deploy-')), item.name + '.tar.gz')
    if (dryRun !== true) {
      execFileSync('tar', ['-czf', archive, '-C', item.from, '.'])
      run(['scp', ['-o', 'BatchMode=yes', archive, sshHost + ':' + backup + '/' + item.name + '.tar.gz']], { dryRun })
      remote('mkdir -p ' + quoted(remoteRuntime + '/' + item.name) + ' && tar -xzf ' + quoted(backup + '/' + item.name + '.tar.gz') + ' -C ' + quoted(remoteRuntime + '/' + item.name) + ' && echo "package-app: deployed ' + item.name + '"')
    }
  }
  console.log('')
  console.log('restart the Host so it loads the new packages:')
  console.log('  ssh ' + sshHost + ' "pkill -f \'dsh --profile\' || true"   # its watchdog restarts it')
  console.log('rollback: cp -a ' + backup + '/. ' + remoteRuntime + '/ && restart the Host')
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
