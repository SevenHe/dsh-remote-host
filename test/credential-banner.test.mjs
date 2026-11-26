/**
 * The Host banner is not always in the tmux pane: a launcher that redirects the Host's stdout to a
 * log file leaves that pane empty, and a refresh that only looks there cannot heal an expired
 * credential. These cases pin which source wins and that the glob cannot smuggle shell syntax.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bannerSourcesCommand, pickEntryUrl } from '../lib/credential-mint.js'

const BANNER = (token) => 'http://devbox.example.com:3080/?token=' + token

test('banner: a launcher log beats a stale banner left in the pane', () => {
  const stdout = ['pane\t' + BANNER('stale-pane'), 'log\t' + BANNER('live-log')].join('\n')
  assert.equal(pickEntryUrl(stdout), BANNER('live-log'))
})

test('banner: the pane is still used when no launcher log matched', () => {
  assert.equal(pickEntryUrl('pane\t' + BANNER('only-pane')), BANNER('only-pane'))
})

test('banner: the last banner within one source wins', () => {
  const stdout = ['log\t' + BANNER('first'), 'log\t' + BANNER('second')].join('\n')
  assert.equal(pickEntryUrl(stdout), BANNER('second'))
})

test('banner: output without a banner yields nothing', () => {
  assert.equal(pickEntryUrl(''), undefined)
  assert.equal(pickEntryUrl('some unrelated line'), undefined)
  assert.equal(pickEntryUrl('pane\tno banner here'), undefined)
})

test('banner: the command reads the pane, and the log only when a glob is configured', () => {
  const paneOnly = bannerSourcesCommand({ tmuxSession: 'dsh-superagent' })
  assert.match(paneOnly, /tmux capture-pane/)
  assert.doesNotMatch(paneOnly, /ls -t/)
  const both = bannerSourcesCommand({ tmuxSession: 'dsh-superagent', bannerLogGlob: '~/logs/*.log' })
  assert.match(both, /tmux capture-pane/)
  assert.match(both, /ls -t ~\/logs\/\*\.log/)
})

test('banner: a glob carrying shell syntax is ignored instead of interpolated', () => {
  const command = bannerSourcesCommand({ tmuxSession: 'dsh-superagent', bannerLogGlob: '~/logs/*.log; rm -rf /' })
  assert.doesNotMatch(command, /rm -rf/)
  assert.equal(command.indexOf('ls -t'), -1, 'an unsafe glob contributes no log lookup')
})
