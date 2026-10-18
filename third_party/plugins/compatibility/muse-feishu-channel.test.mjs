import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { applyBridgeDesktopCompatibility } from './bridge-desktop.mjs'
import { isFeishuBotMentioned, requestFeishuBotInfo } from './muse-feishu-identity.mjs'

const checkout = resolve(import.meta.dirname, '../../..')
const sdkDirectory = resolve(import.meta.dirname, '../toolchain/node_modules/@larksuiteoapi/node-sdk')
const sdkManifest = JSON.parse(readFileSync(join(sdkDirectory, 'package.json'), 'utf8'))
const sdkUrl = pathToFileURL(join(sdkDirectory, sdkManifest.main)).href
const { default: Lark } = await import(sdkUrl)
const { Context } = await import(pathToFileURL(join(checkout, 'vendor/cordis/lib/index.js')).href)
const validBot = { code: 0, bot: { open_id: 'ou_muse_bot', app_name: 'Muse', avatar_url: 'synthetic-avatar' } }
const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

function offlineHttp(botResponse) {
  const requests = []
  const tokens = []
  const cards = []
  const httpInstance = {
    async post(url, data) {
      assert.equal(new URL(url).pathname, '/open-apis/auth/v3/tenant_access_token/internal')
      tokens.push({ url, data })
      return { code: 0, tenant_access_token: 'synthetic-tenant-token', expire: 7200 }
    },
    async request(request) {
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path === '/open-apis/bot/v3/info') return botResponse
      if (path === '/open-apis/im/v1/messages') {
        cards.push(request)
        return { code: 0, data: { message_id: `synthetic-card-${cards.length}` } }
      }
      throw new Error(`Unexpected offline SDK request: ${path}`)
    },
  }
  return { httpInstance, requests, tokens, cards }
}

function rawMessage(id, { group = true, mentions, chat = 'oc_allowed', text = '/help', messageType = 'text' } = {}) {
  return {
    sender: { sender_id: { open_id: 'ou_owner' } },
    message: {
      message_id: id, chat_type: group ? 'group' : 'p2p', chat_id: chat,
      message_type: messageType, content: JSON.stringify(messageType === 'text' ? { text } : { image_key: 'blocked-image' }),
      ...(mentions === undefined ? {} : { mentions }),
    },
  }
}

async function mountedChannel(t, botResponse = validBot) {
  const root = mkdtempSync(join(tmpdir(), 'muse-feishu-identity-'))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  cpSync(join(import.meta.dirname, '../dsh-bridge'), root, { recursive: true })
  applyBridgeDesktopCompatibility(root)
  const dependencyRoot = join(root, 'node_modules')
  for (const [name, target] of [
    ['@deepseek-ai/cordis', 'vendor/cordis'],
    ['@deepseek-ai/schemastery', 'vendor/schemastery'],
    ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ]) {
    const destination = join(dependencyRoot, name)
    mkdirSync(resolve(destination, '..'), { recursive: true })
    symlinkSync(join(checkout, target), destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const sdkWrapper = join(dependencyRoot, '@larksuiteoapi/node-sdk')
  mkdirSync(sdkWrapper, { recursive: true })
  writeFileSync(join(sdkWrapper, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  // The SDK client, token manager and generated message API remain real; only transport is offline.
  writeFileSync(join(sdkWrapper, 'index.mjs'), `import Lark from ${JSON.stringify(sdkUrl)}
export const state = { botResponse: ${JSON.stringify(botResponse)}, requests: [], tokens: [], cards: [], closed: false }
class Client extends Lark.Client {
  constructor(options) {
    super({ ...options, cache: { get: () => undefined, set: () => {} }, httpInstance: {
      async post(url, data) {
        if (new URL(url).pathname !== '/open-apis/auth/v3/tenant_access_token/internal') throw new Error('Unexpected token endpoint')
        state.tokens.push({ url, data })
        return { code: 0, tenant_access_token: 'synthetic-tenant-token', expire: 7200 }
      },
      async request(request) {
        state.requests.push(request)
        const path = new URL(request.url).pathname
        if (path === '/open-apis/bot/v3/info') return state.botResponse
        if (path === '/open-apis/im/v1/messages') {
          state.cards.push(request)
          return { code: 0, data: { message_id: 'synthetic-card-' + state.cards.length } }
        }
        throw new Error('Unexpected offline SDK request: ' + path)
      },
    } })
  }
}
class WSClient {
  async start() {}
  close() { state.closed = true }
}
export default { ...Lark, Client, WSClient }
`)
  const { state } = await import(pathToFileURL(join(sdkWrapper, 'index.mjs')).href)
  const nodeReady = Promise.withResolvers()
  const online = Promise.withResolvers()
  const privateReply = Promise.withResolvers()
  const errors = []
  let gateway
  ctx.logger.exporter({ export: message => { if (message.type === 'error') errors.push(message.args.map(String).join(' ')) } })
  ctx.on('internal/status', fiber => {
    if ('feishu' in fiber.inject && fiber.store?.feishu && !fiber.inertia) {
      gateway = fiber.store.feishu.value
      nodeReady.resolve()
    }
  })
  ctx.on('feishu/status', event => { if (event.status === 'online') online.resolve() })
  const session = { id: 'synthetic-session', header: { id: 'synthetic-session', cwd: root } }
  const services = {
    sessions: { list: () => [session], get: () => session }, agents: { get: () => undefined }, approval: {}, settings: { update: async () => undefined },
    workspaceRegistry: { archivedSessionIds: [], list: async () => [] }, sessionPersistence: { list: async () => [] }, sessionProjectionCache: { cachedSnapshot: () => undefined },
    sessionTitle: { rename: () => {} }, agentPresets: {}, agentDefaultModel: {},
  }
  for (const [name, service] of Object.entries(services)) ctx.provide(name, service)
  const channel = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  await ctx.plugin(channel, {
    enabled: true, appId: 'synthetic-app', appSecret: 'synthetic-secret', registeredBy: 'ou_owner',
    allowFrom: ['oc_allowed', 'ou_owner'], activeSessionId: session.id,
  })
  await Promise.all([nodeReady.promise, online.promise])
  const sendCard = gateway.sendCard.bind(gateway)
  gateway.sendCard = async (...args) => {
    const result = await sendCard(...args)
    if (args[0] === 'ou_owner') privateReply.resolve()
    return result
  }
  return { ctx, state, gateway, errors, privateReply: privateReply.promise }
}

test('queries bot identity using the pinned SDK authenticated request method', async () => {
  assert.equal(sdkManifest.version, '1.73.0')
  const transport = offlineHttp(validBot)
  const client = new Lark.Client({ appId: 'synthetic-direct-app', appSecret: 'synthetic-secret', logger: silentLogger, cache: { get: () => undefined, set: () => {} }, httpInstance: transport.httpInstance })
  assert.equal(client.bot.v3, undefined)
  assert.deepEqual(await requestFeishuBotInfo(client), validBot)
  assert.equal(transport.tokens.length, 1)
  assert.deepEqual(transport.tokens[0].data, { app_id: 'synthetic-direct-app', app_secret: 'synthetic-secret' })
  assert.equal(transport.requests.length, 1)
  const [request] = transport.requests
  assert.equal(request.url, 'https://open.feishu.cn/open-apis/bot/v3/info')
  assert.equal(request.method, 'GET')
  assert.equal(request.data, undefined)
  assert.equal(request.headers.Authorization, 'Bearer synthetic-tenant-token')
})

test('rejects unsuccessful or incomplete bot identities from the SDK response', async t => {
  for (const [name, response] of [
    ['business failure', { code: 99991663, bot: validBot.bot }],
    ['missing code', { bot: validBot.bot }],
    ['missing bot', { code: 0 }],
    ['missing open ID', { code: 0, bot: {} }],
    ['blank open ID', { code: 0, bot: { open_id: '  ' } }],
    ['non-string open ID', { code: 0, bot: { open_id: 123 } }],
  ]) {
    await t.test(name, async () => {
      const transport = offlineHttp(response)
      const client = new Lark.Client({ appId: 'synthetic-invalid-app', appSecret: 'synthetic-secret', logger: silentLogger, cache: { get: () => undefined, set: () => {} }, httpInstance: transport.httpInstance })
      await assert.rejects(requestFeishuBotInfo(client), /valid bot open ID/)
      assert.equal(transport.requests.length, 1)
    })
  }
})

test('matches only structured mentions of the known bot', () => {
  const event = mentions => ({ raw: { message: { mentions } } })
  assert.equal(isFeishuBotMentioned(event([{ id: { open_id: 'ou_muse_bot' } }]), 'ou_muse_bot'), true)
  for (const mentions of [undefined, {}, [], [null], [{ id: {} }], [{ id: { open_id: 'ou_other_bot' }, name: 'Muse' }]]) {
    assert.equal(isFeishuBotMentioned(event(mentions), 'ou_muse_bot'), false)
  }
  assert.equal(isFeishuBotMentioned(event([{ id: {} }]), undefined), false)
  assert.equal(isFeishuBotMentioned(event([{ id: { open_id: '' } }]), ''), false)
})

test('replies to this bot mention and private messages while rejecting unmentioned and other-bot group messages', { timeout: 10000 }, async t => {
  const fixture = await mountedChannel(t)
  const { gateway, state, ctx } = fixture
  assert.equal(gateway.botInfo.openId, 'ou_muse_bot')
  await gateway._handleMessageReceive(rawMessage('with-mention', { text: '@_user_1 /help', mentions: [{ key: '@_user_1', id: { open_id: 'ou_muse_bot' } }] }))
  await gateway._handleMessageReceive(rawMessage('no-mention'))
  await gateway._handleMessageReceive(rawMessage('text-only-mention', { text: '@Muse /help' }))
  await gateway._handleMessageReceive(rawMessage('other-bot', { text: '@_user_1 /help', mentions: [{ key: '@_user_1', id: { open_id: 'ou_other_bot' }, name: 'Muse' }] }))
  await gateway._handleMessageReceive(rawMessage('unapproved-group', { chat: 'oc_unapproved', mentions: [{ id: { open_id: 'ou_muse_bot' } }] }))
  await gateway._handleMessageReceive(rawMessage('unmentioned-media', { messageType: 'image' }))
  await gateway._handleMessageReceive(rawMessage('private', { group: false }))
  await fixture.privateReply
  await ctx.fiber.dispose()
  assert.deepEqual(state.cards.map(card => [card.data.receive_id, card.params.receive_id_type]), [['oc_allowed', 'chat_id'], ['ou_owner', 'open_id']])
  for (const card of state.cards) {
    assert.equal(card.data.msg_type, 'interactive')
    assert.match(JSON.parse(card.data.content).body.elements[0].content, /\/help/)
  }
  assert.equal(state.requests.filter(request => new URL(request.url).pathname === '/open-apis/bot/v3/info').length, 1)
  assert.equal(state.closed, true)
  assert.deepEqual(fixture.errors, [])
})

test('keeps group mention policy closed when bot identity fails without disabling authorized private replies', { timeout: 10000 }, async t => {
  const fixture = await mountedChannel(t, { code: 99991663, msg: 'synthetic identity failure' })
  assert.equal(fixture.gateway.botInfo, null)
  await fixture.gateway._handleMessageReceive(rawMessage('failed-identity-group', { mentions: [{ id: { open_id: 'ou_muse_bot' } }] }))
  await fixture.gateway._handleMessageReceive(rawMessage('failed-identity-private', { group: false }))
  await fixture.privateReply
  await fixture.ctx.fiber.dispose()
  assert.deepEqual(fixture.state.cards.map(card => card.data.receive_id), ['ou_owner'])
  assert.deepEqual(fixture.errors, [])
})
