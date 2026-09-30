/** Exercise the private artifact with the real Cordis service provider and Feishu schema. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as remote from './lib/remote.mjs'
import * as channel from './lib/index.js'
import { FeishuGateway } from './lib/upstream/feishu/gateway.js'

test('mounts the typed remote provider and leaves an unconfigured Feishu channel inert', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(remote)
    assert.equal(typeof ctx.museDesktopBridge.createTunnel, 'function')
    const tunnel = ctx.museDesktopBridge.createTunnel({
      serverUrl: 'ws://127.0.0.1:1/api/desktop/connect', headers: { cookie: 'muse_session=synthetic' },
      localPort: 1, loopbackCookie: 'host=synthetic', deviceId: 'synthetic-device', chunkBytes: 32768, ackTimeoutMs: 1000, reconnectMaxIntervalMs: 1000,
    })
    await tunnel.stop()
    await ctx.plugin(channel, { enabled: false })
    assert.equal(ctx.get('feishu'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('renames a live conversation through the injected title service', { timeout: 5000 }, async () => {
  const ctx = new Context()
  const ready = Promise.withResolvers()
  const sent = Promise.withResolvers()
  const errors = []
  ctx.logger.exporter({ export: message => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) } })
  ctx.on('internal/status', fiber => { if ('feishu' in fiber.inject && fiber.store?.feishu && !fiber.inertia) ready.resolve() })
  const session = { id: 'session-rename', header: { id: 'session-rename', cwd: process.cwd() } }
  let renamed = 0
  const services = {
    sessions: { list: () => [session], get: () => session }, agents: { get: () => undefined }, approval: {}, settings: { update: async () => undefined },
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] }, sessionPersistence: { list: async () => [] }, sessionProjectionCache: { cachedSnapshot: () => undefined }, agentPresets: {}, agentDefaultModel: {},
  }
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  const originalStart = FeishuGateway.prototype.start
  FeishuGateway.prototype.start = async function () {
    this.wsClient = { close: () => {} }
    this.sendMarkdownCard = async (_peer, text) => { sent.resolve(text); return { message_id: 'synthetic-message' } }
    this.setStatus('online')
    return true
  }
  try {
    await ctx.plugin({ name: 'synthetic-title-provider', apply: scope => scope.provide('sessionTitle', { rename: (actual, title) => { assert.equal(actual, session); assert.equal(title, 'New title'); renamed++ } }) })
    await ctx.plugin(channel, { enabled: true, appId: 'synthetic-app', appSecret: 'synthetic-secret', registeredBy: 'ou_owner', activeSessionId: session.id })
    await ready.promise
    ctx.emit('feishu/message', { peerId: 'ou_owner', senderId: 'ou_owner', isGroup: false, text: '/rename New title', messageType: 'text' })
    const reply = await sent.promise
    assert.equal(renamed, 1)
    assert.match(reply, /New title/)
    assert.deepEqual(errors, [])
  } finally {
    FeishuGateway.prototype.start = originalStart
    await ctx.fiber.dispose()
  }
})

test('drains the configured Feishu node and closes the SDK connection during unload', { timeout: 5000 }, async () => {
  const ctx = new Context()
  const started = Promise.withResolvers()
  const consumerReady = Promise.withResolvers()
  ctx.on('internal/status', fiber => { if ('feishu' in fiber.inject && fiber.store?.feishu && !fiber.inertia) consumerReady.resolve() })
  ctx.logger.exporter({ export: message => { if (message.type === 'error') started.reject(new Error(message.args.map(String).join(' '))) } })
  let gateway
  const originalStart = FeishuGateway.prototype.start
  let sdkClosed = false
  FeishuGateway.prototype.start = async function () {
    gateway = this
    this.wsClient = { close: options => { assert.deepEqual(options, { force: true }); sdkClosed = true } }
    this.setStatus('online')
    started.resolve()
    return true
  }
  try {
    const services = {
      sessions: { list: () => [], get: () => undefined }, agents: { get: () => undefined }, approval: {}, settings: { update: async () => undefined },
      workspaceRegistry: { archivedSessionIds: [], list: async () => [] }, sessionPersistence: { list: async () => [] }, sessionProjectionCache: { cachedSnapshot: () => undefined },
      sessionTitle: { rename: () => {} }, agentPresets: {}, agentDefaultModel: {},
    }
    for (const [name, service] of Object.entries(services)) { ctx.provide(name, service); assert.equal(ctx.get(name), service, `${name} is available`) }
    await ctx.plugin(channel, { enabled: true, appId: 'synthetic-app', appSecret: 'synthetic-secret', registeredBy: 'ou_owner' })
    await started.promise
    await consumerReady.promise
    assert.equal(gateway.status, 'online')
    const sending = Promise.withResolvers()
    const complete = Promise.withResolvers()
    gateway.sendMarkdownCard = async () => { sending.resolve(); await complete.promise; return { message_id: 'synthetic-message' } }
    ctx.emit('feishu/message', { peerId: 'ou_owner', senderId: 'ou_owner', isGroup: false, text: '/help', messageType: 'text' })
    await sending.promise
    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false, 'unload waits for an already accepted outbound operation')
    complete.resolve()
    await disposal
    assert.equal(sdkClosed, true)
    assert.equal(gateway.status, 'offline')
    assert.equal(gateway.wsClient, null)
  } finally {
    FeishuGateway.prototype.start = originalStart
    await ctx.fiber.dispose()
  }
})
