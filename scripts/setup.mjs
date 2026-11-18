#!/usr/bin/env node
/**
 * dsh-remote-host setup.
 *
 * Two jobs:
 *  1. mint a browser-session cookie for the remote Host (so this machine can
 *     talk to it) — either by reading the remote's credential store over SSH
 *     or by exchanging the entry URL the remote printed;
 *  2. install this bundle into a DSH profile (dependency link, bundle row, and
 *     the id-targeted config the host half reads).
 *
 * Nothing here is remote-side: the remote keeps running exactly as it is.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-remote-host'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const next = process.argv[index + 1]
  if (next !== undefined && !next.startsWith('--')) { args.set(token.slice(2), next); index += 1 }
  else args.set(token.slice(2), 'true')
}
const flag = (name, fallback) => args.get(name) ?? fallback

const upstream = flag('upstream', undefined)
if (upstream === undefined) {
  console.error('usage: setup.mjs --upstream http://10.0.0.5:3082 [--ssh devbox] [--remote-home ~/.dsh] [--token <entry-url>] [--profile-dir ~/.dsh/profiles/desktop] [--port 19199] [--no-install]')
  process.exit(2)
}
const upstreamUrl = new URL(upstream)
const authority = flag('authority', upstreamUrl.host)
const cookieFile = join(homedir(), '.dsh', PACKAGE_NAME, 'cookie.txt')

const b64u = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** Mint the v1 browser cookie the remote Host would have issued itself. */
function mintCookie(credentialsText) {
  const lines = credentialsText.split('\n')
  let inRecord = false
  let version = null
  let secret = null
  for (const line of lines) {
    const record = /^\s{2}([^\s:][^:]*):\s*$/.exec(line)
    if (record !== null) { inRecord = record[1].trim() === 'client-connection/browser-session'; continue }
    if (!inRecord) continue
    const versionMatch = /^\s+version:\s*(\d+)\s*$/.exec(line)
    if (versionMatch !== null) version = Number(versionMatch[1])
    const secretMatch = /^\s+secret:\s*(\S+)\s*$/.exec(line)
    if (secretMatch !== null) secret = secretMatch[1]
  }
  if (secret === null || version !== 1) throw new Error('credentials file has no client-connection/browser-session grant')
  const key = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (key.byteLength !== 32) throw new Error('unexpected signing secret length')
  const issuedAt = Date.now()
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 3600 * 1000 }
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const name = 'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())
  return name + '=v1.' + body + '.' + b64u(createHmac('sha256', key).update(body).digest())
}

/** Exchange the remote's printed entry URL for the same cookie, through its own fence. */
async function exchangeToken(entry) {
  const response = await fetch(new URL(entry), { redirect: 'manual', headers: { host: authority } })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map((value) => value.split(';')[0]).find((value) => value.startsWith('dsh-auth-'))
  if (cookie === undefined) throw new Error('entry URL did not return an authentication cookie (status ' + String(response.status) + ')')
  return cookie
}

async function verify(cookie) {
  const response = await fetch(new URL('/', upstreamUrl), { headers: { cookie, host: authority } })
  const body = await response.text()
  if (response.status !== 200) throw new Error('remote rejected the credential: HTTP ' + String(response.status))
  return body.length
}

function install(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(manifestPath)) throw new Error('no DSH profile at ' + profileDir)
  const stamp = new Date().toISOString().replaceAll(':', '')
  copyFileSync(manifestPath, manifestPath + '.before-remote-host-' + stamp)
  if (existsSync(patchPath)) copyFileSync(patchPath, patchPath + '.before-remote-host-' + stamp)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // A pnpm-managed profile keeps `dependencies` and `pnpm-lock.yaml` in sync; adding a
  // dependency row the lockfile does not know would break a frozen install on the next
  // boot. The loader resolves bundles from `node_modules`, so the symlink below is enough.
  if (flag('with-dependency', 'false') === 'true') {
    manifest.dependencies = manifest.dependencies ?? {}
    manifest.dependencies[PACKAGE_NAME] = 'file:' + PACKAGE_ROOT
  }
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
  manifest.dsh.profile.bundles = bundles
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const linkPath = join(modules, PACKAGE_NAME)
  // A pnpm-managed profile already links an installed dependency here; only an
  // absent entry is ours to create. Replacing pnpm's entry would break it.
  if (!existsSync(linkPath)) {
    try {
      symlinkSync(PACKAGE_ROOT, linkPath)
    } catch (error) {
      console.warn('warning: could not link ' + linkPath + ': ' + String(error))
    }
  }

  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]\n'
  const block = [
    '- id: ' + PACKAGE_NAME,
    '  config:',
    '    upstream: ' + upstreamUrl.origin,
    '    authority: ' + authority,
    '    mount: ' + flag('mount', '/devbox'),
    '    label: ' + flag('label', 'devbox'),
    '    windowDays: ' + String(Number(flag('window-days', '30'))),
    ...(flag('streams', 'false') === 'true' ? ['    streams: true'] : []),
    '    cookieFile: ' + cookieFile,
  ].join('\n')
  const withoutOld = patch
    .replace(new RegExp('^- id: ' + PACKAGE_NAME + '\\n(?:  .*\\n)*', 'm'), '')
    .replace(/^\s*\[\]\s*$/m, '')
  writeFileSync(patchPath, (withoutOld.trim().length > 0 ? withoutOld.trimEnd() + '\n' : '') + block + '\n')
  console.log('installed into ' + profileDir)
  console.log('  backups: package.json.before-remote-host-' + stamp + ' / cordis.patch.yml.before-remote-host-' + stamp)
}

const tokenEntry = flag('token', undefined)
const sshHost = flag('ssh', undefined)
const credentialsText = tokenEntry === undefined && sshHost !== undefined
  ? execFileSync('ssh', ['-o', 'BatchMode=yes', sshHost, 'cat', flag('remote-home', '~/.dsh') + '/.credentials.yaml'], { encoding: 'utf8' })
  : undefined

const cookie = credentialsText !== undefined ? mintCookie(credentialsText) : await exchangeToken(tokenEntry)
const bytes = await verify(cookie)
mkdirSync(dirname(cookieFile), { recursive: true, mode: 0o700 })
writeFileSync(cookieFile, cookie + '\n', { mode: 0o600 })
chmodSync(cookieFile, 0o600)
console.log('credential stored: ' + cookieFile + ' (0600); remote answered 200 with ' + String(bytes) + ' bytes')

if (flag('no-install', 'false') !== 'true') {
  install(flag('profile-dir', join(homedir(), '.dsh', 'profiles', 'desktop')))
} else {
  console.log('skipped profile install (--no-install)')
}
console.log('restart DSH to load the bundle, then open the "devbox" entry in the sidebar.')
