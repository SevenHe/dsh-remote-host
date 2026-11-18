#!/usr/bin/env node
/**
 * Stage the SSH helper for a remote POSIX host and print the dsh-ssh config row.
 *
 * The registry publishes @deepseek-ai/dsh-ssh but not its helper runtime, so the
 * helper is assembled from the installed package: `lib/helper.js` plus its sibling
 * chunks and the runtime dependencies the helper imports (cordis, zod, dsh-fs).
 *
 * Usage:
 *   node scripts/ssh-helper-deploy.mjs --profile ~/.dsh/profiles/desktop --dry-run
 *   node scripts/ssh-helper-deploy.mjs --profile ~/.dsh/profiles/desktop \
 *     --remote devbox --remoteDir '~/.dsh/ssh-helper'
 *
 * Without --dry-run it creates the remote directory, copies the tarball over SSH,
 * extracts it there, and prints the config row to paste into the profile patch.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf('--' + name)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const profile = resolve(String(option('profile', join(process.env.HOME ?? '', '.dsh/profiles/desktop'))))
const dryRun = option('dry-run', false) === true
const remote = option('remote', undefined)
const remoteDir = option('remoteDir', '~/.dsh/ssh-helper')
const workspace = option('workspace', undefined)

const fail = (message) => { console.error('ssh-helper: ' + message); process.exit(1) }

const modules = join(profile, 'node_modules')
const sshPackage = join(modules, '@deepseek-ai/dsh-ssh')
if (!existsSync(sshPackage)) fail('install the providers first: pnpm add @deepseek-ai/dsh-ssh @deepseek-ai/dsh-fs-ssh @deepseek-ai/dsh-subprocess-ssh')

const helperEntry = join(sshPackage, 'lib/helper.js')
if (!existsSync(helperEntry)) fail('helper entry missing at ' + helperEntry)

// A hoisted install gives a self-contained tree: the helper imports sibling
// chunks plus cordis/zod/dsh-fs, and pnpm otherwise leaves those under .pnpm.
const staging = mkdtempSync(join(tmpdir(), 'ssh-helper-'))
const target = join(staging, 'package')
mkdirSync(target, { recursive: true })
const sshVersion = String(option('version', JSON.parse(readFileSync(join(sshPackage, 'package.json'), 'utf8')).version))
if (/^0\.1\./.test(sshVersion)) {
  console.warn('ssh-helper: ' + sshVersion + ' is the stale npm latest tag; the runtime disables it as incompatible. Install the providers at the app version, e.g. @0.2.2-rc.3.')
}
writeFileSync(join(target, 'package.json'), JSON.stringify({
  name: 'dsh-ssh-helper-install',
  private: true,
  type: 'module',
  dependencies: { '@deepseek-ai/dsh-ssh': sshVersion },
}, null, 2) + '\n')

const pnpm = option('pnpm', process.env.DSH_PNPM ?? undefined)
if (typeof pnpm !== 'string') fail('pass --pnpm /path/to/pnpm.mjs (or set DSH_PNPM) so the tree can be built')
console.log('building hoisted tree with ' + pnpm + ' …')
execFileSync(process.execPath, [pnpm, 'install', '--node-linker=hoisted', '--ignore-scripts', '--prod'], {
  cwd: target,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

const installedSsh = join(target, 'node_modules/@deepseek-ai/dsh-ssh')
if (!existsSync(installedSsh)) fail('hoisted install did not produce the ssh package')
const helperRel = 'package/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
const helperHash = createHash('sha256').update(readFileSync(join(target, 'node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'))).digest('hex')
const archive = join(staging, 'ssh-helper.tar.gz')
execFileSync('tar', ['-czf', archive, '-C', staging, 'package'], { stdio: 'inherit' })

console.log('profile:      ' + profile)
console.log('staged:       ' + target)
console.log('helper entry: ' + helperRel)
console.log('archive:      ' + archive + ' (' + Math.round(readFileSync(archive).length / 1024) + ' KiB)')
console.log('helper sha256:' + helperHash)

const nodeGuess = '/usr/bin/node'
console.log('\n# paste into the profile patch (adjust node/workspace to the remote host):')
// 0.2.2-rc.3 moved node inside launch; the 0.1.x docs (still npm latest) keep it
// at the top level, which the current schema rejects.
console.log('# insert rows, NOT profile bundles: these packages declare no dsh.bundle')
console.log('- insert:')
console.log('    - id: dsh-ssh')
console.log('      name: "@deepseek-ai/dsh-ssh"')
console.log('      config:')
console.log('        host: ' + String(remote ?? '<openssh-alias>'))
console.log('        helper: ' + String(remoteDir).replace(/\/$/, '') + '/' + helperRel)
console.log('        helperHash: ' + helperHash)
console.log('        workspace: ' + String(workspace ?? '<absolute remote workspace>'))
console.log('        launch:')
console.log('          kind: node-script')
console.log('          node: ' + nodeGuess)
console.log('    - id: dsh-fs-ssh')
console.log('      name: "@deepseek-ai/dsh-fs-ssh"')
console.log('    - id: dsh-subprocess-ssh')
console.log('      name: "@deepseek-ai/dsh-subprocess-ssh"')

if (dryRun === true) {
  console.log('\ndry run: nothing copied to a remote host')
  rmSync(staging, { recursive: true, force: true })
  process.exit(0)
}
if (remote === undefined) fail('pass --remote <openssh-alias> or --dry-run')

execFileSync('ssh', ['-o', 'BatchMode=yes', remote, 'mkdir -p ' + remoteDir], { stdio: 'inherit' })
execFileSync('scp', ['-o', 'BatchMode=yes', archive, remote + ':' + remoteDir + '/ssh-helper.tar.gz'], { stdio: 'inherit' })
execFileSync('ssh', ['-o', 'BatchMode=yes', remote, 'tar -xzf ' + remoteDir + '/ssh-helper.tar.gz -C ' + remoteDir], { stdio: 'inherit' })
console.log('\ninstalled on ' + remote + ':' + remoteDir + '/package  (remove that directory to undeploy)')
rmSync(staging, { recursive: true, force: true })
