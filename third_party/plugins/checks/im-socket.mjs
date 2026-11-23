/** Exercise actual socket close listeners without authenticating a platform connection. */
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'
import { closeMuseImSocket } from './lib/muse-im-socket.mjs'

// The reviewed SDK and the `ws` build it bundles, resolved from the SDK's own install.
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@larksuiteoapi/node-sdk'))
const { LoggerLevel, WSClient } = sdkRequire('@larksuiteoapi/node-sdk')
const { WebSocket, WebSocketServer } = sdkRequire('ws')

test('settles after the reviewed SDK closes an open socket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  try {
    await once(server, 'listening')
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`)
    await once(socket, 'open')
    // No start(): the client stays offline and only owns the local socket.
    const client = new WSClient({ appId: 'cli_0000000000000000', appSecret: 'unused', loggerLevel: LoggerLevel.error })
    client.wsConfig.setWSInstance(socket)
    let timer
    const outcome = await Promise.race([
      closeMuseImSocket(client).then(() => 'closed'),
      new Promise(resolve => { timer = setTimeout(resolve, 5_000, 'pending') }),
    ])
    clearTimeout(timer)
    assert.equal(outcome, 'closed')
    assert.equal(socket.readyState, WebSocket.CLOSED)
    assert.equal(socket.listenerCount('close'), 0)
  } finally {
    for (const peer of server.clients) peer.terminate()
    await new Promise(resolve => server.close(resolve))
  }
})

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
