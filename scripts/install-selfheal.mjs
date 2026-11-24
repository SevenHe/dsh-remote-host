#!/usr/bin/env node
/**
 * Install the login/watch agent that keeps this plugin registered in a profile.
 *
 * The desktop app drops non-shipped bundle entries while migrating a profile (for
 * example during an app update), which silently unloads the plugin. This installs a
 * LaunchAgent that runs scripts/ensure-profile.mjs at login and whenever the app bundle
 * is replaced, so the next launch already has the plugin.
 *
 *   node scripts/install-selfheal.mjs [--profile desktop] [--node /path/to/node] [--uninstall]
 *
 * Pass --node when this script is run by the app's bundled runtime, which cannot be
 * executed as node without ELECTRON_RUN_AS_NODE.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.dsh-remote-host.ensure-profile'
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const profileName = argOf('profile', 'desktop')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = argOf('node', process.execPath)
const script = join(root, 'scripts/ensure-profile.mjs')
const home = process.env.HOME ?? ''
const logDir = join(home, 'Library/Logs')
const agentsDir = join(home, 'Library/LaunchAgents')
const plistPath = join(agentsDir, LABEL + '.plist')

/**
 * launchd keys an agent on its Label, not on the file name, so a second plist carrying
 * the same Label makes it run twice. That is how this machine once ended up with two
 * copies repairing the profile every 30 minutes.
 */
function strayAgentPlists() {
  try {
    return readdirSync(agentsDir)
      .filter((name) => name.endsWith('.plist'))
      .map((name) => join(agentsDir, name))
      .filter((path) => path !== plistPath)
      .filter((path) => {
        try { return readFileSync(path, 'utf8').includes('<string>' + LABEL + '</string>') } catch (error) { return false }
      })
  } catch (error) { return [] }
}

const bootout = () => {
  try { execFileSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }) } catch (error) { /* not loaded */ }
}

if (args.includes('--uninstall')) {
  bootout()
  rmSync(plistPath, { force: true })
  console.log('self-heal agent removed')
  process.exit(0)
}
if (!existsSync(script)) {
  console.error('install-selfheal: missing ' + script)
  process.exit(2)
}
const strays = strayAgentPlists()
if (strays.length > 0) {
  console.error('install-selfheal: another plist already carries the Label ' + LABEL + ':')
  for (const stray of strays) console.error('  ' + stray)
  console.error('install-selfheal: remove those first, or launchd runs the agent more than once')
  process.exit(2)
}
mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true })
mkdirSync(logDir, { recursive: true })

const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '  <key>Label</key><string>' + LABEL + '</string>',
  '  <key>ProgramArguments</key>',
  '  <array>',
  '    <string>' + node + '</string>',
  '    <string>' + script + '</string>',
  '    <string>--profile</string>',
  '    <string>' + profileName + '</string>',
  '  </array>',
  '  <key>RunAtLoad</key><true/>',
  '  <key>StartInterval</key><integer>1800</integer>',
  '  <key>WatchPaths</key>',
  '  <array><string>/Applications/DeepSeek Harness.app</string></array>',
  '  <key>StandardOutPath</key><string>' + join(logDir, 'dsh-remote-host-ensure.log') + '</string>',
  '  <key>StandardErrorPath</key><string>' + join(logDir, 'dsh-remote-host-ensure.log') + '</string>',
  '</dict>',
  '</plist>',
  '',
]
writeFileSync(plistPath, lines.join('\n'))
bootout()
execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), plistPath], { stdio: 'inherit' })
// post-write verification: a plist that vanishes installs nothing at the next login
if (!existsSync(plistPath) || statSync(plistPath).size === 0) {
  console.error('install-selfheal: the plist disappeared after bootstrap: ' + plistPath)
  process.exit(3)
}
console.log('self-heal agent installed: ' + plistPath)
console.log('node: ' + node + ' | profile: ' + profileName)
