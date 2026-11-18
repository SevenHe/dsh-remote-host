#!/usr/bin/env node
/**
 * Validate market/index.json against the documented index format: one entry per
 * published version, each with a SemVer version, a publish timestamp and a source.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = JSON.parse(readFileSync(join(root, 'market/index.json'), 'utf8'))
const fail = (message) => { console.error('index: ' + message); process.exit(1) }

if (index.format !== 1) fail('format must be 1')
if (!Array.isArray(index.plugins) || index.plugins.length === 0) fail('plugins must be a non-empty array')
for (const plugin of index.plugins) {
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) fail('plugin.name required')
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail('versions required for ' + plugin.name)
  for (const version of plugin.versions) {
    if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(String(version.version))) fail('semver required: ' + version.version)
    if (typeof version.publishTimestamp !== 'number') fail('publishTimestamp required for ' + version.version)
    const source = version.source
    if (source === null || typeof source !== 'object') fail('source required for ' + version.version)
    if (source.type === 'git') {
      if (!/^https:\/\//.test(String(source.url))) fail('git source needs an https url')
      if (!/^[0-9a-f]{40}$/.test(String(source.commit))) fail('git source needs a 40-hex commit')
    } else if (source.type !== 'npm') {
      fail('source.type must be npm or git')
    }
  }
}
console.log('index ok: ' + index.plugins.length + ' plugin(s)')
