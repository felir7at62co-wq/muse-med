import assert from 'node:assert/strict'
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { applyImDesktopCompatibility } from './im-desktop.mjs'
import { createMuseImAdmission } from './muse-im-admission.mjs'
import { isFeishuBotMentioned, requestFeishuBotInfo } from './muse-feishu-identity.mjs'

const checkout = resolve(import.meta.dirname, '../../..')
const sdkDirectory = resolve(import.meta.dirname, '../toolchain/node_modules/@larksuiteoapi/node-sdk')
const sdkManifest = JSON.parse(readFileSync(join(sdkDirectory, 'package.json'), 'utf8'))
const sdkUrl = pathToFileURL(join(sdkDirectory, sdkManifest.main)).href
const { default: Lark } = await import(sdkUrl)
const validBot = { code: 0, bot: { open_id: 'ou_muse_bot', app_name: 'Muse', avatar_url: 'synthetic-avatar' } }
const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

function offlineHttp(botResponse) {
  const requests = []
  const tokens = []
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
      throw new Error(`Unexpected offline SDK request: ${path}`)
    },
  }
  return { httpInstance, requests, tokens }
}

function rawMessage(id, { group = true, mentions, chat = 'oc_allowed', sender = 'ou_owner', text = '/help', messageType = 'text' } = {}) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: sender } },
    message: {
      message_id: id, chat_type: group ? 'group' : 'p2p', chat_id: chat,
      message_type: messageType, content: JSON.stringify(messageType === 'text' ? { text } : { image_key: 'blocked-image' }),
      ...(mentions === undefined ? {} : { mentions }),
    },
  }
}

async function mountedChannel(t, botOpenId = 'ou_muse_bot') {
  const root = mkdtempSync(join(tmpdir(), 'muse-native-feishu-identity-'))
  const source = join(root, 'plugin')
  const dependencies = join(source, 'node_modules')
  let bridge
  t.after(async () => {
    try { await bridge?.waitForIdle() } finally {
      let link
      try { link = lstatSync(dependencies) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (link) {
        assert.equal(link.isSymbolicLink(), true, 'fixture cleanup owns only the dependency link')
        unlinkSync(dependencies)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
  cpSync(join(import.meta.dirname, '../dsh-im'), source, { recursive: true })
  applyImDesktopCompatibility(source)
  symlinkSync(join(checkout, 'third_party/plugins/toolchain/node_modules'), dependencies,
    process.platform === 'win32' ? 'junction' : 'dir')
  const { FeishuHarnessBridge } = await import(pathToFileURL(join(source, 'src/channels/feishu/bridge.mjs')).href)
  const replies = []
  const seen = new Set()
  const state = { hasSeen: id => seen.has(id), markSeen: async id => seen.add(id), sessionFor: () => null }
  const scope = {
    mode: 'allowlist', open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: ['ou_owner', 'ou_member'].map(id => ({ id, canExecuteCommands: true })) },
  }
  const admission = createMuseImAdmission({ appId: 'synthetic-app', dshHome: root,
    inboundClaimRetentionMs: 60_000, inboundClaimMaxEntries: 100 }, {
    botId: 'synthetic-bot', botOpenId, legacyPolicy: { registeredBy: 'ou_owner', allowFrom: ['ou_owner'] },
  }).forBot('synthetic-bot')
  bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: { reply: async request => {
      replies.push(request)
      return { code: 0, data: { message_id: 'synthetic-reply-' + replies.length } }
    } } } } },
    channel: {}, harness: { ensureRunning: async () => true }, state,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0 },
    accessPolicy: { getSettings: () => ({ direct: scope, group: scope }), isPrivileged: () => false },
    museAdmission: admission, botOpenId, groupResponseMode: 'mention', mentionTopicReply: false,
    logger: silentLogger,
  })
  return { bridge, replies, seen }
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

test('native IM replies only to this bot mentions and authorized private messages', { timeout: 10000 }, async t => {
  const { bridge, replies, seen } = await mountedChannel(t)
  const mentioned = [{ key: '@_user_1', id: { open_id: 'ou_muse_bot' } }]
  await bridge.accept(rawMessage('with-mention', { text: '@_user_1 /help', mentions: mentioned }))
  await bridge.accept(rawMessage('native-allowed-member', { sender: 'ou_member', chat: 'oc_new_group',
    text: '@_user_1 /help', mentions: mentioned }))
  await bridge.accept(rawMessage('no-mention'))
  await bridge.accept(rawMessage('text-only-mention', { text: '@Muse /help' }))
  await bridge.accept(rawMessage('other-bot', { text: '@_user_1 /help', mentions: [{ key: '@_user_1', id: { open_id: 'ou_other_bot' }, name: 'Muse' }] }))
  await bridge.accept(rawMessage('unapproved-sender', { sender: 'ou_unapproved', mentions: mentioned }))
  await bridge.accept(rawMessage('unmentioned-media', { messageType: 'image' }))
  await bridge.accept(rawMessage('private', { group: false, chat: 'oc_private' }))
  await bridge.accept(rawMessage('unapproved-private', { group: false, sender: 'ou_unapproved' }))
  await bridge.waitForIdle()
  assert.deepEqual(replies.map(reply => reply.path.message_id), ['with-mention', 'native-allowed-member', 'private'])
  for (const reply of replies) {
    assert.equal(reply.data.msg_type, 'text')
    assert.match(JSON.parse(reply.data.content).text, /\/sessionlist/)
  }
  for (const id of ['no-mention', 'text-only-mention', 'other-bot', 'unmentioned-media']) assert.equal(seen.has(id), false)
})

test('native IM keeps group mentions closed without a bot identity while allowing authorized private replies', { timeout: 10000 }, async t => {
  const { bridge, replies } = await mountedChannel(t, null)
  await bridge.accept(rawMessage('failed-identity-group', { mentions: [{ id: { open_id: 'ou_muse_bot' } }] }))
  await bridge.accept(rawMessage('failed-identity-private', { group: false, chat: 'oc_private' }))
  await bridge.waitForIdle()
  assert.deepEqual(replies.map(reply => reply.path.message_id), ['failed-identity-private'])
})
