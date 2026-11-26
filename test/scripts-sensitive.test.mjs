/** The sensitive-data gate: a real leak still hits, and the documented placeholders stay legal. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { rules, scanLine, scanText } from '../scripts/verify-sensitive.mjs'

const GATE = fileURLToPath(new URL('../scripts/verify-sensitive.mjs', import.meta.url))

/**
 * Leak fixtures, assembled from fragments at run time.
 *
 * The gate scans every committed file -- this one included -- so a literal leaked address here
 * would itself be a leak. Building the same text in memory exercises the rules without ever
 * committing the value.
 */
const LEAKS = {
  privateIp: ['192', '168', '10', '7'].join('.'),
  homeDir: '/' + 'Users' + '/' + 'real' + 'person',
  email: 'ops' + '@' + 'mail.corp-host.test',
  apiKey: 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2',
}

test('sensitive gate: a real leak is reported per rule with its line number', () => {
  const text = [
    '# notes',
    'host ' + LEAKS.privateIp,
    'path ' + LEAKS.homeDir,
    'mail ' + LEAKS.email,
    'key ' + LEAKS.apiKey,
  ].join('\n')
  const found = scanText(text).map((hit) => hit.rule + '@' + hit.line)
  assert.ok(found.includes('ipv4-literal@2'), 'a non-loopback address is a leak: ' + JSON.stringify(found))
  assert.ok(found.includes('personal-dir@3'), 'a real home directory is a leak: ' + JSON.stringify(found))
  assert.ok(found.includes('real-email@4'), 'a non-example mailbox is a leak: ' + JSON.stringify(found))
  assert.ok(found.includes('credential@5'), 'an API-key-shaped token is a leak: ' + JSON.stringify(found))
})

test('sensitive gate: the documented placeholders stay legal', () => {
  const text = [
    'host devbox.example.com:3080',
    'loopback 127.0.0.1:3080 broadcast 0.0.0.0',
    'linux home /home/<user>, macos home /Users/me, project /home/user/project',
    'mail user@example.com',
    'header Authorization: Bearer <token>',
    'flag --password=xxxxx',
    'crash record v8=15.2.124.28-electron.0',
  ].join('\n')
  assert.deepEqual(scanText(text), [], 'documented placeholders must not trip the gate')
})

test('sensitive gate: the exported rule set still covers every documented class', () => {
  // Pinning the names keeps the export a contract: dropping a rule from the array must fail a
  // test instead of quietly narrowing the gate that `npm run check` relies on.
  assert.deepEqual(rules.map((rule) => rule.name), [
    'ipv4-literal',
    'internal-domain',
    'internal-product-name',
    'personal-dir',
    'internal-partition-path',
    'credential',
    'real-email',
  ])
  const hits = scanLine('two addresses ' + LEAKS.privateIp + ' and ' + ['10', '1', '2', '3'].join('.'))
  assert.equal(hits.filter((hit) => hit.rule === 'ipv4-literal').length, 1, 'one hit per rule per line')
})

test('sensitive gate: the CLI still exits 1 on a leak and 0 on a clean tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drh-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'clean.md'), 'host devbox.example.com:3080 and /Users/me\n')
  const clean = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8' })
  assert.equal(clean.status, 0, 'a clean tree passes: ' + clean.stdout + clean.stderr)

  // The gate scans untracked files too, so a leak is caught before anyone git-adds it.
  writeFileSync(join(dir, 'leak.md'), 'host ' + LEAKS.privateIp + '\n')
  const dirty = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8' })
  assert.equal(dirty.status, 1, 'a leak fails the gate: ' + dirty.stdout)
  assert.match(dirty.stdout, /leak\.md:1 ipv4-literal/)
})
