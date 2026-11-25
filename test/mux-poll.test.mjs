/** Behaviour of the host-side mux pump the desktop page polls instead of opening a socket. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createMuxPoller } from '../lib/mux-poll.js'

/** A stand-in for the remote mux socket. */
class FakeRemote extends EventEmitter {
  constructor() {
    super()
    this.readyState = 0
    this.sent = []
    this.closed = false
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  deliver(frame) {
    this.emit('message', frame)
  }

  send(frame) {
    this.sent.push(frame)
  }

  close() {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }
}

test('mux pump: a frame reaches the page after its cursor', async () => {
  const remote = new FakeRemote()
  const poller = createMuxPoller(() => remote, { waitMs: 300 })
  // The pump dials on its first poll, so the page's poll is what attaches the listeners.
  const pending = poller.poll({ cursor: 0, waitMs: 250 })
  remote.open()
  remote.deliver('a')
  remote.deliver('b')
  const first = await pending
  assert.equal(first.state, 'open')
  // The byte relay announces availability with a status frame; the pump mirrors it so the
  // page's status logic reads the same signal on both transports.
  assert.deepEqual(JSON.parse(first.frames[0]), { type: 'drh/relay-status', state: 'open' })
  assert.deepEqual(first.frames.slice(1), ['a', 'b'])
  remote.deliver('c')
  const second = await poller.poll({ cursor: first.cursor, waitMs: 20 })
  assert.deepEqual(second.frames, ['c'])
  poller.dispose()
})

test('mux pump: the client uplink reaches the remote socket', async () => {
  const remote = new FakeRemote()
  const poller = createMuxPoller(() => remote, { waitMs: 30 })
  const pending = poller.poll({ cursor: 0, waitMs: 20 })
  remote.open()
  await pending
  await poller.poll({ cursor: 0, uplink: ['up-1', 'up-2'], waitMs: 1 })
  assert.deepEqual(remote.sent, ['up-1', 'up-2'])
  poller.dispose()
})

test('mux pump: a closed remote answers the page with that state instead of hanging', async () => {
  const remote = new FakeRemote()
  const poller = createMuxPoller(() => remote, { waitMs: 200 })
  remote.open()
  // The open edge is announced first: the mux protocol expects the client handshake right
  // after open, so holding the answer would make the page handshake too late.
  const opened = await poller.poll({ cursor: 0, waitMs: 150 })
  assert.equal(opened.state, 'open')
  const pending = poller.poll({ cursor: opened.cursor, waitMs: 150 })
  remote.close()
  const answer = await pending
  assert.equal(answer.state, 'closed')
  // A closed relay reports itself the same way the byte relay does.
  assert.deepEqual(answer.frames.map((frame) => JSON.parse(frame)), [
    { type: 'drh/relay-status', state: 'closed' },
  ])
  poller.dispose()
})

test('mux pump: an undialable remote reports unavailable without waiting', async () => {
  const poller = createMuxPoller(() => undefined, { waitMs: 20 })
  const answer = await poller.poll({ cursor: 0, waitMs: 20 })
  assert.equal(answer.state, 'unavailable')
  poller.dispose()
})

test('mux pump: dispose closes the remote socket', () => {
  const remote = new FakeRemote()
  const poller = createMuxPoller(() => remote, { waitMs: 20 })
  void poller.poll({ cursor: 0, waitMs: 1 })
  poller.dispose()
  assert.equal(remote.closed, true)
})