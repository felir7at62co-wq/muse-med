/** Real authenticated Gateway streams with explicitly held producer operations. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { z } from 'zod'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

export const name = 'gateway-update-pause-supersession-fixture'
export const inject = ['tools']
const callId = 'call_gateway_pause'
const expected = {
  supersededPause: 'desktop update: stream pause was superseded',
  resumedStreamStayedOpen: true,
  nextPauseWaitedForOldProducer: true,
  oldProducerFinishedBeforePauseResolved: true,
}

/**
 * Register one Native tool and verify its actual result reaches the next model request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Ordinary Headless Loader context.
 * @returns {Promise<void>}
 */
export async function apply(ctx) {
  const owner = new URL('../../../packages/api/gateway/package.json', import.meta.url)
  const [{ Context, symbols }, { default: WebServer }, { default: Registry }, { default: Access },
    { default: Gateway }, connection, { Remote, TypertRemoteService }] = await Promise.all([
    importSnapshotPackage('@deepseek-ai/cordis', owner),
    importSnapshotPackage('@deepseek-ai/dsh-host-webserver', owner),
    importSnapshotPackage('@deepseek-ai/dsh-typert-registry', owner),
    importSnapshotPackage('@deepseek-ai/dsh-api-remote-access', owner),
    importSnapshotPackage('@deepseek-ai/dsh-api-gateway', owner),
    importSnapshotPackage('@deepseek-ai/dsh-client-connection', owner),
    importSnapshotPackage('@deepseek-ai/dsh-typert-protocol', owner),
  ])
  const initializers = []
  class Feed extends TypertRemoteService {
    source
    constructor(context) {
      super(context, 'fixtureFeed')
      for (const initialize of initializers) initialize.call(this)
    }
    items() { return this.source }
  }
  Remote({ mode: 'stream' })(Feed.prototype.items, {
    kind: 'method', name: 'items', static: false, private: false,
    addInitializer(initialize) { initializers.push(initialize) },
  })
  let runs = 0, seen = false
  ctx.effect(() => ctx.tools.register({
    name: 'gateway_pause_race',
    description: 'Verify superseded Gateway update pauses using authenticated local streams.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      assert.equal(++runs, 1)
      const host = new Context()
      const records = new Map()
      host.provide('credentials', {
        async modifyRecord(key, mutate) {
          const current = records.get(key), next = await mutate(current)
          if (next !== undefined) records.set(key, next)
          return next ?? current
        },
      })
      const oldRead = Promise.withResolvers(), oldReturn = Promise.withResolvers()
      const releaseOldRead = Promise.withResolvers(), releaseOldReturn = Promise.withResolvers()
      const newRead = Promise.withResolvers(), newReturn = Promise.withResolvers(), releaseNewRead = Promise.withResolvers()
      let oldFinished = false, oldSocket, newSocket, oldPause, newPause
      try {
        await host.plugin(WebServer, { host: '127.0.0.1', port: 0 })
        await host.plugin(Registry)
        await host.plugin(Access)
        await host.plugin(Gateway)
        await host.plugin({ inject: [...connection.inject], apply: connection.apply })
        await host.plugin(Feed)
        host.effect(() => host.typert.register({
          package: '@fixture/gateway-pause', face: 'host', schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: [{
            id: '@fixture/gateway-pause#fixtureFeed/items', service: 'fixtureFeed', namespace: 'fixtureFeed',
            method: 'items', mode: 'stream', invocation: { kind: 'direct' }, parameters: [],
            result: { mode: 'strict', typeSymbol: '@fixture/gateway-pause#Item', create: () => z.string() },
          }],
        }))
        const receiver = host.get('fixtureFeed'), feed = receiver[symbols.original] ?? receiver
        const origin = `http://127.0.0.1:${host.webServer.port}`
        const target = new URL(host.connection.authenticatedUrl(origin))
        let cookie
        host.connection.authorizeIndex({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } }, {
          writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] }, end() {},
        })
        assert.equal(typeof cookie, 'string')
        const open = async streamId => {
          const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { cookie } })
          await once(socket, 'open')
          socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'fixtureFeed/items', payload: { args: {} } }))
          return socket
        }
        feed.source = {
          [Symbol.asyncIterator]: () => ({
            async next() { oldRead.resolve(); await releaseOldRead.promise; oldFinished = true; return { done: true } },
            async return() { oldReturn.resolve(); await releaseOldReturn.promise; return { done: true } },
          }),
        }
        oldSocket = await open('old')
        await oldRead.promise
        const oldClosed = once(oldSocket, 'close')
        oldPause = host.serial('connection/update-pause')
        const oldOutcome = oldPause.then(() => ({ kind: 'resolved' }), error => ({ kind: 'rejected', message: error.message }))
        await oldReturn.promise
        await oldClosed
        await host.serial('connection/update-resume')
        feed.source = {
          [Symbol.asyncIterator]: () => ({
            async next() { newRead.resolve(); await releaseNewRead.promise; return { done: true } },
            async return() { newReturn.resolve(); return { done: true } },
          }),
        }
        newSocket = await open('resumed')
        await newRead.promise
        releaseOldReturn.resolve()
        const outcome = await Promise.race([oldOutcome, new Promise(resolve => setImmediate(() => resolve({ kind: 'pending' })))])
        assert.deepEqual(outcome, { kind: 'rejected', message: expected.supersededPause })
        assert.equal(oldFinished, false)
        assert.equal(newSocket.readyState, WebSocket.OPEN)
        const newClosed = once(newSocket, 'close')
        newPause = host.serial('connection/update-pause')
        releaseNewRead.resolve()
        await newReturn.promise
        await newClosed
        const currentOutcome = await Promise.race([
          newPause.then(() => 'resolved'), new Promise(resolve => setImmediate(() => resolve('pending'))),
        ])
        assert.equal(currentOutcome, 'pending')
        assert.equal(oldFinished, false)
        releaseOldRead.resolve()
        await newPause
        assert.equal(oldFinished, true)
        return JSON.stringify({
          supersededPause: outcome.message,
          resumedStreamStayedOpen: true,
          nextPauseWaitedForOldProducer: currentOutcome === 'pending',
          oldProducerFinishedBeforePauseResolved: oldFinished,
        })
      } finally {
        releaseOldRead.resolve(); releaseOldReturn.resolve(); releaseNewRead.resolve()
        oldSocket?.terminate(); newSocket?.terminate()
        await Promise.allSettled([oldPause, newPause])
        await host.fiber.dispose()
      }
    },
  }))
  ctx.on('llm/stream', async function* (options, next) {
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === callId)
    if (result !== undefined) {
      assert.equal(seen, false)
      assert.equal(result.isError, false, result.content[0].text)
      assert.deepEqual(JSON.parse(result.content[0].text), expected)
      seen = true
      await writeFile(join(process.cwd(), 'gateway-pause-proof.json'), JSON.stringify({ ...expected, observedInNextModelRequest: true }, null, 2) + '\n', { flag: 'wx' })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(runs, 1); assert.equal(seen, true) })
}
