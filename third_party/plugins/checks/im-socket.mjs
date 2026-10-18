/** Exercise actual socket close listeners without authenticating a platform connection. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { closeMuseImSocket } from './lib/muse-im-socket.mjs'

test('waits for the current socket and removes listeners after closure', async () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1 })
  let closed = false
  const result = closeMuseImSocket({ wsConfig: { getWSInstance: () => socket }, close: options => {
    assert.deepEqual(options, { force: true })
    queueMicrotask(() => { closed = true; socket.readyState = 3; socket.emit('close') })
  } })
  await result
  assert.equal(closed, true)
  assert.equal(socket.listenerCount('close'), 0)
  assert.equal(socket.listenerCount('error'), 0)
})

test('removes close listeners when the SDK close operation throws', async () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1 })
  await assert.rejects(closeMuseImSocket({ wsConfig: { getWSInstance: () => socket }, close: () => { throw new Error('close failed') } }), /close failed/u)
  assert.equal(socket.listenerCount('close'), 0)
  assert.equal(socket.listenerCount('error'), 0)
})

test('does not wait for an absent or already closed socket', async () => {
  await closeMuseImSocket(null)
  const socket = Object.assign(new EventEmitter(), { readyState: 3 })
  await closeMuseImSocket({ wsConfig: { getWSInstance: () => socket }, close: () => {} })
  assert.equal(socket.listenerCount('close'), 0)
})
