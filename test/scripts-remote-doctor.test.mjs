/**
 * The remote host doctor judges four remote facts from short shell output. Each judgement is a
 * pure function so the failure wording is pinned without an ssh session, and so a check cannot
 * quietly start accepting the state it exists to catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bannerCheck, envCheck, keyFileCheck, memoryCheck } from '../scripts/lib/remote-doctor.mjs'

test('doctor: the key file must exist, be owner-only, and be non-empty', () => {
  assert.equal(keyFileCheck('600 64').ok, true)
  assert.equal(keyFileCheck('').ok, false, 'a missing file fails')
  assert.equal(keyFileCheck('644 64').ok, false, 'a group- or world-readable key fails')
  assert.equal(keyFileCheck('600 0').ok, false, 'an empty key fails')
})

test('doctor: a key file complaint names the mode it saw', () => {
  assert.match(keyFileCheck('640 64').detail, /640/)
})

test('doctor: the banner check needs a token-bearing entry URL', () => {
  assert.equal(bannerCheck('dsh web: http://devbox.example.com:3080/?token=abc').ok, true)
  assert.equal(bannerCheck('').ok, false, 'nothing read fails')
  assert.equal(bannerCheck('dsh web: health at http://devbox.example.com:3080/health').ok, false, 'a banner without a token fails')
})

test('doctor: the environment check counts the variable by name', () => {
  assert.equal(envCheck('1').ok, true)
  assert.equal(envCheck('0').ok, false)
  assert.equal(envCheck('').ok, false, 'an unreadable environment fails')
})

test('doctor: only a 200 from the memory endpoint counts as healthy', () => {
  assert.equal(memoryCheck(200).ok, true)
  assert.equal(memoryCheck(502).ok, false)
  assert.equal(memoryCheck(401).ok, false)
  assert.match(memoryCheck(502).detail, /OpenViking/, 'the failure names the likely culprit')
})
