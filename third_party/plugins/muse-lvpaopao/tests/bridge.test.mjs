/** Real shared service and JSONL transport with isolated files and synthetic managed subprocesses. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import LvpaopaoBridge from '../src/bridge.ts'
import { ACTIONS } from '../src/port.ts'

const rawConfig = { sshHostAlias: 'synthetic-target', remotePython: 'C:\\test\\python.exe',
  remoteHelper: 'C:\\test\\helper.py', helperSha256: 'a'.repeat(64), cwd: process.cwd(),
  connectTimeoutMs: 30000, requestTimeoutMs: 30000, downloadRequestTimeoutMs: 30000,
  cancelTimeoutMs: 5000, shutdownTimeoutMs: 5000 }
const signal = () => new AbortController().signal

function subprocessFixture(onRequest = (frame, connection) => connection.result(frame, { operation: frame.method }), options = {}) {
  const connections = [], frames = [], waiting = []
  function record(connection, frame) {
    frames.push({ connection, frame })
    for (const waiter of [...waiting]) if (waiter.match(connection, frame)) {
      waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve({ connection, frame })
    }
  }
  return { connections, frames,
    wait(match) {
      const found = frames.find(value => match(value.connection, value.frame))
      if (found) return Promise.resolve(found)
      return new Promise(resolve => waiting.push({ match, resolve }))
    },
    subprocess: { spawn(spec) {
      options.onSpawn?.(spec)
      const stdin = new PassThrough(), stdout = new PassThrough(), settled = Promise.withResolvers()
      const connection = { index: connections.length, spec, stdin, stdout,
        reply(frame) { stdout.write(JSON.stringify(frame) + '\n') },
        result(frame, value) { connection.reply({ protocol: 1, type: 'result', id: frame.id, value }) },
        finish() { stdout.end(); settled.resolve({ exitCode: 0, signal: null }) },
        closed() {
          connection.reply({ protocol: 1, type: 'event', event: 'closed', details: {
            status: 'control-close', cleanup: { dispose: true, unload: true, detach: true, serverClosed: options.cleanup !== false },
          } }); connection.finish()
        },
      }
      connections.push(connection)
      let buffered = ''
      stdin.on('data', chunk => {
        buffered += chunk.toString()
        for (;;) {
          const end = buffered.indexOf('\n'); if (end === -1) break
          const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1)
          record(connection, frame)
          if (frame.type === 'request' && frame.method === 'hello') {
            if (options.onHello) options.onHello(frame, connection)
            else connection.result(frame, { protocol_version: 1, helper_sha256: rawConfig.helperSha256,
              expected_app_id: 'wx404dde55fb12df78', actions: [...ACTIONS], ready: true })
          } else if (frame.type === 'close') {
            if (options.onClose) options.onClose(connection)
            else connection.closed()
          } else onRequest(frame, connection)
        }
      })
      return { stdin, stdout, done: settled.promise, collected: {},
        terminate() { connection.finish() },
        async waitForExit(abortSignal) {
          if (abortSignal?.aborted) return false
          return await new Promise(resolve => {
            const abort = () => resolve(false)
            abortSignal?.addEventListener('abort', abort, { once: true })
            settled.promise.then(() => { abortSignal?.removeEventListener('abort', abort); resolve(true) })
          })
        },
      }
    } },
  }
}

async function fixture(t, subprocess, { config = rawConfig, maxQueuedRequests = 8, autoSetup = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lvpaopao-bridge-'))
  const connectionFile = join(directory, 'connection.json')
  if (config !== undefined && config !== null) await writeFile(connectionFile, JSON.stringify(config), { mode: 0o600 })
  const ctx = new Context()
  t.after(async () => { try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', subprocess)
  const fiber = ctx.plugin(LvpaopaoBridge, { connectionFile, maxQueuedRequests, autoSetup })
  await fiber.await()
  assert.ok(ctx.lvpaopaoBridge)
  return { ctx, fiber, bridge: ctx.lvpaopaoBridge, connectionFile, directory }
}

test('missing connection configuration keeps the service available without starting a subprocess', async t => {
  const wire = subprocessFixture()
  const f = await fixture(t, wire.subprocess, { config: null })
  assert.equal(f.bridge.configuration, undefined)
  await assert.rejects(f.bridge.request('status', {}, signal()), { code: 'unconfigured' })
  await assert.rejects(f.bridge.request('search', { query: 'test' }, signal()), { code: 'unconfigured' })
  assert.equal(wire.connections.length, 0)
})

test('connection input rejects invalid JSON, configuration, unknown secret fields and unsafe file types', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lvpaopao-bridge-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const connectionFile = join(directory, 'connection.json')
  for (const content of ['{', '[]', JSON.stringify({ ...rawConfig, helperSha256: 'invalid' }),
    JSON.stringify({ ...rawConfig, password: 'synthetic-never-logged' }), ' '.repeat(65537)]) {
    await writeFile(connectionFile, content, { mode: 0o600 })
    assert.throws(() => new LvpaopaoBridge(ctx, { connectionFile, maxQueuedRequests: 2 }), /lvpaopao:/)
  }
  const link = join(directory, 'connection-link.json')
  await symlink(connectionFile, link)
  assert.throws(() => new LvpaopaoBridge(ctx, { connectionFile: link, maxQueuedRequests: 2 }), /owner-private and regular/)
  assert.throws(() => new LvpaopaoBridge(ctx, { connectionFile: directory, maxQueuedRequests: 2 }), /owner-private and regular/)
  assert.throws(() => new LvpaopaoBridge(ctx, { connectionFile: 'relative.json', maxQueuedRequests: 2 }), /must be absolute/)
})

test('POSIX connection files must not grant group or other access', { skip: process.platform === 'win32' && 'Windows does not expose POSIX private modes' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lvpaopao-bridge-mode-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const connectionFile = join(directory, 'connection.json')
  await writeFile(connectionFile, JSON.stringify(rawConfig), { mode: 0o600 }); await chmod(connectionFile, 0o644)
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  assert.throws(() => new LvpaopaoBridge(ctx, { connectionFile, maxQueuedRequests: 2 }), /owner-private and regular/)
})

test('FIFO operations share one connection and the shared pump does not inherit the first Agent', async t => {
  let ctx
  const wire = subprocessFixture((frame, connection) => {
    if (frame.method !== 'search') connection.result(frame, { operation: frame.method })
  }, { onSpawn() { assert.equal(ctx.agents.currentInitiator(), undefined) } })
  const f = await fixture(t, wire.subprocess); ctx = f.ctx
  assert.equal(Object.isFrozen(f.bridge.configuration), true)
  const first = ctx.agents.withInitiator({ id: 'synthetic-first-agent' }, () => f.bridge.request('search', { query: 'one' }, signal()))
  const held = await wire.wait((_connection, frame) => frame.method === 'search')
  const second = f.bridge.request('detail', { srcAppId: 'wx6522458df7ed3af2', dramaId: '121225' }, signal())
  const third = f.bridge.request('status', {}, signal())
  assert.deepEqual(wire.frames.filter(value => value.frame.type === 'request').map(value => value.frame.method), ['hello', 'search'])
  held.connection.result(held.frame, { operation: 'search' })
  assert.deepEqual(await Promise.all([first, second, third]), [{ operation: 'search' }, { operation: 'detail' }, { operation: 'status' }])
  assert.deepEqual(wire.frames.filter(value => value.frame.type === 'request').map(value => value.frame.method), ['hello', 'search', 'detail', 'status'])
  assert.equal(wire.connections.length, 1)
})

test('queued cancellation releases capacity without sending cancellation for the active request', async t => {
  const wire = subprocessFixture((frame, connection) => {
    if (frame.method !== 'search') connection.result(frame, {})
  })
  const f = await fixture(t, wire.subprocess, { maxQueuedRequests: 1 })
  const active = f.bridge.request('search', { query: 'held' }, signal())
  const held = await wire.wait((_connection, frame) => frame.method === 'search')
  const controller = new AbortController()
  const queued = assert.rejects(f.bridge.request('detail', {}, controller.signal), { code: 'cancelled' })
  await assert.rejects(f.bridge.request('status', {}, signal()), { code: 'request-capacity' })
  controller.abort(); await queued
  const replacement = f.bridge.request('status', {}, signal())
  assert.equal(wire.frames.some(value => value.frame.type === 'cancel'), false)
  held.connection.result(held.frame, {})
  await Promise.all([active, replacement])
  assert.equal(wire.frames.some(value => value.frame.method === 'detail'), false)
  assert.equal(wire.connections.length, 1)
})

test('unloading one borrowing scope waits for its cancellation acknowledgement without closing another scope connection', async t => {
  const cancellation = Promise.withResolvers()
  const wire = subprocessFixture((frame, connection) => {
    if (frame.type === 'cancel') cancellation.resolve({ frame, connection })
    else if (frame.params.query !== 'scope-a') connection.result(frame, { operation: frame.method })
  })
  const f = await fixture(t, wire.subprocess)
  const ownerA = new AbortController(), ownerB = new AbortController()
  let first, firstRejected, status, search
  const scopeA = f.ctx.plugin({ name: 'borrower-a', apply(ctx) {
    first = f.bridge.request('search', { query: 'scope-a' }, ownerA.signal)
    firstRejected = assert.rejects(first, { code: 'cancelled' })
    ctx.effect(() => async () => { ownerA.abort(); await firstRejected })
  } })
  await scopeA.await()
  await wire.wait((_connection, frame) => frame.method === 'search')
  const scopeB = f.ctx.plugin({ name: 'borrower-b', apply(ctx) {
    status = f.bridge.request('status', {}, ownerB.signal)
    search = f.bridge.request('search', { query: 'scope-b' }, ownerB.signal)
    ctx.effect(() => async () => { ownerB.abort(); await Promise.allSettled([status, search]) })
  } })
  await scopeB.await()
  let unloaded = false
  const unloading = scopeA.dispose().then(() => { unloaded = true })
  const cancelled = await cancellation.promise
  assert.equal(unloaded, false)
  assert.equal(wire.frames.some(value => value.frame.method === 'status'), false)
  assert.equal(wire.frames.some(value => value.frame.type === 'close'), false)
  cancelled.connection.reply({ protocol: 1, type: 'error', id: cancelled.frame.id, error: { code: 'cancelled' } })
  await Promise.all([firstRejected, unloading])
  assert.deepEqual(await Promise.all([status, search]), [{ operation: 'status' }, { operation: 'search' }])
  assert.equal(wire.connections.length, 1)
  assert.equal(wire.frames.filter(value => value.frame.method === 'search' && value.frame.params.query === 'scope-a').length, 1)
  assert.equal(wire.frames.some(value => value.frame.type === 'close'), false)
  await scopeB.dispose()
})

test('cancelling while the shared handshake is pending leaves that connection available to a later caller', async t => {
  const handshake = Promise.withResolvers()
  const wire = subprocessFixture(undefined, { onHello(frame, connection) { handshake.resolve({ frame, connection }) } })
  const f = await fixture(t, wire.subprocess)
  const controller = new AbortController()
  const cancelled = assert.rejects(f.bridge.request('search', { query: 'cancel-before-start' }, controller.signal), { code: 'cancelled' })
  const hello = await handshake.promise
  controller.abort(); await cancelled
  const status = f.bridge.request('status', {}, signal())
  hello.connection.result(hello.frame, { protocol_version: 1, helper_sha256: rawConfig.helperSha256,
    expected_app_id: 'wx404dde55fb12df78', actions: [...ACTIONS], ready: true })
  await status
  assert.equal(wire.connections.length, 1)
  assert.equal(wire.frames.some(value => value.frame.type === 'cancel' || value.frame.type === 'close'), false)
  assert.equal(wire.frames.some(value => value.frame.method === 'search'), false)
})

test('business failures are not retried and only explicit status starts a cleaned new generation', async t => {
  const wire = subprocessFixture((frame, connection) => {
    if (connection.index === 0) connection.reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'native-error' } })
    else connection.result(frame, { ready: true })
  })
  const f = await fixture(t, wire.subprocess)
  await assert.rejects(f.bridge.request('search', { query: 'once' }, signal()), { code: 'native-error' })
  await assert.rejects(f.bridge.request('detail', {}, signal()), { code: 'native-error' })
  assert.equal(wire.connections.length, 1)
  assert.equal(wire.frames.filter(value => value.frame.method === 'search').length, 1)
  assert.deepEqual(await f.bridge.request('status', {}, signal()), { ready: true })
  assert.equal(wire.connections.length, 2)
  assert.equal(wire.frames.filter(value => value.frame.type === 'close').length, 1)
})

test('status recovery waits for previous cleanup and never overlaps target connections', async t => {
  const closing = Promise.withResolvers()
  const wire = subprocessFixture((frame, connection) => {
    if (connection.index === 0) connection.reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'native-error' } })
    else connection.result(frame, {})
  }, { onClose(connection) { if (connection.index === 0) closing.resolve(connection); else connection.closed() } })
  const f = await fixture(t, wire.subprocess)
  const first = assert.rejects(f.bridge.request('search', { query: 'once' }, signal()), { code: 'native-error' })
  const previous = await closing.promise
  const status = f.bridge.request('status', {}, signal())
  assert.equal(wire.connections.length, 1)
  previous.closed(); await first; await status
  assert.equal(wire.connections.length, 2)
})

test('failed cleanup remains terminal even for an explicit status request', async t => {
  const wire = subprocessFixture((frame, connection) => connection.reply({ protocol: 1, type: 'error', id: frame.id,
    error: { code: 'native-error' } }), { cleanup: false })
  const f = await fixture(t, wire.subprocess)
  await assert.rejects(f.bridge.request('search', { query: 'once' }, signal()), { code: 'remote-cleanup-unconfirmed' })
  await assert.rejects(f.bridge.request('status', {}, signal()), { code: 'remote-cleanup-unconfirmed' })
  assert.equal(wire.connections.length, 1)
  // Exercise the exact cleanup promise registered by the service; Cordis reports effect rejections through its logger.
  await assert.rejects(f.bridge.dispose(), /remote-cleanup-unconfirmed/)
})

test('Host unload stops admission and waits for active cancellation plus complete remote cleanup', async t => {
  const closing = Promise.withResolvers()
  const wire = subprocessFixture((frame, connection) => {
    if (frame.type === 'cancel') connection.reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'cancelled' } })
  }, { onClose(connection) { closing.resolve(connection) } })
  const f = await fixture(t, wire.subprocess)
  const active = assert.rejects(f.bridge.request('search', { query: 'held' }, signal()), { code: 'cancelled' })
  await wire.wait((_connection, frame) => frame.method === 'search')
  const queued = assert.rejects(f.bridge.request('detail', {}, signal()), { code: 'connection-closed' })
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  const connection = await closing.promise
  assert.equal(disposed, false)
  await assert.rejects(f.bridge.request('status', {}, signal()), { code: 'connection-closed' })
  connection.closed(); await Promise.all([active, queued, disposal])
  assert.equal(disposed, true)
  assert.equal(wire.frames.some(value => value.frame.method === 'detail'), false)
  assert.equal(wire.connections.length, 1)
})

test('a business call before the target opens preserves its waiting connection instead of forcing another launch', async t => {
  let ready = false
  const wire = subprocessFixture((frame, connection) => {
    if (frame.method === 'search' && !ready) connection.reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'target-not-ready' } })
    else connection.result(frame, { operation: frame.method, ready })
  }, { onHello(frame, connection) { connection.result(frame, { protocol_version: 1, helper_sha256: rawConfig.helperSha256,
    expected_app_id: 'wx404dde55fb12df78', actions: [...ACTIONS], ready: false }) } })
  const f = await fixture(t, wire.subprocess)
  await assert.rejects(f.bridge.request('search', { query: 'not-started' }, signal()), { code: 'target-not-ready' })
  assert.deepEqual(await f.bridge.request('status', {}, signal()), { operation: 'status', ready: false })
  assert.equal(wire.frames.some(value => value.frame.type === 'close'), false)
  ready = true
  assert.deepEqual(await f.bridge.request('search', { query: 'explicit-next-request' }, signal()), { operation: 'search', ready: true })
  assert.equal(wire.connections.length, 1)
  assert.equal(wire.frames.filter(value => value.frame.method === 'search').length, 2)
})

test('a settled media transfer failure retains the healthy connection for an explicit original-key retry', async t => {
  const params = { srcAppId: 'wx0123456789abcdef', dramaId: 'example', episodeNo: 2, idempotencyKey: 'a'.repeat(64) }
  let attempts = 0
  const wire = subprocessFixture((frame, connection) => {
    if (frame.method === 'download_episode' && ++attempts === 1) connection.reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'transfer-failed' } })
    else connection.result(frame, { originalKey: frame.params.idempotencyKey })
  })
  const f = await fixture(t, wire.subprocess)
  await assert.rejects(f.bridge.request('download_episode', params, signal()), { code: 'transfer-failed' })
  assert.equal(wire.frames.some(value => value.frame.type === 'close'), false)
  assert.deepEqual(await f.bridge.request('download_episode', params, signal()), { originalKey: params.idempotencyKey })
  assert.equal(wire.connections.length, 1); assert.equal(attempts, 2)
  await f.fiber.dispose()
})
