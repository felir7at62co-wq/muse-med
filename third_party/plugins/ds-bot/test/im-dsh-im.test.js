import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectDshIm, consumable, dshImConfig } from '../src/host/im/platforms/dsh-im.js'

const FINGERPRINT = 'f'.repeat(64)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

// A dsh-im service for one bot of `channel`, recording what DS Bot asks of it.
const fakeService = (channel, { formats = ['plain', 'markdown'], fingerprint = FINGERPRINT, replyError, push = true } = {}) => {
  const service = {
    inboundVersion: 1,
    replies: [],
    pushes: [],
    disposed: 0,
    async describeBot(botId) {
      return { version: 1, botId, channel, account: { fingerprint, name: `${channel} bot` }, connected: true, formats,
        capabilities: ['exclusive-text-consumer', 'reply-text-checked', ...(push ? ['proactive-text-checked'] : [])] }
    },
    async consumeInbound(botId, options) {
      service.botId = botId
      service.options = options
      return () => { service.disposed += 1 }
    },
    async replyChecked(botId, route, text, options) {
      if (replyError !== undefined) throw replyError
      service.replies.push({ route, text, format: options.format })
      return { sent: true, messageId: `r${service.replies.length}` }
    },
    async pushChecked(botId, target, text, options) {
      service.pushes.push({ target, text, format: options.format })
      return { sent: true }
    },
  }
  return service
}

const envOf = () => {
  const runtime = {}
  return { runtime: { get: () => runtime, set: patch => Object.assign(runtime, patch) }, log: { warn() {} }, saved: runtime }
}

const event = (channel, overrides = {}) => ({
  version: 1, channel, botId: `${channel}_bot`, fingerprint: FINGERPRINT, eventId: `${channel}:m1`, messageId: 'm1',
  actor: { kind: 'user', id: 'u1', name: 'Mei' },
  conversation: { kind: 'group', id: 'chat-1', title: 'Studio' },
  mentions: [], mentionedAccount: true, at: new Date(0).toISOString(), text: 'make a trailer', attachments: [],
  reply: { messageId: 'm1', conversationId: 'chat-1', kind: 'group' },
  target: { kind: 'group', route: { chatId: 'chat-1' } },
  ...overrides,
})

const connect = async (channel, options) => {
  const service = fakeService(channel, options)
  const messages = []
  const statuses = []
  const routes = new Map()
  const controller = new AbortController()
  const handle = await connectDshIm(service, { botId: `${channel}_bot`, fingerprint: options?.pinned }, envOf(), {
    onMessage: async msg => { messages.push(msg) },
    onStatus: status => statuses.push(status),
    routeOf: key => routes.get(key),
  }, controller.signal)
  return { service, handle, messages, statuses, routes, controller, deliver: (value, context = {}) => service.options.onEvent(value, { signal: new AbortController().signal, ...context }) }
}

for (const channel of ['dingtalk', 'wecom', 'weixin', 'qq', 'wecom-app']) {
  test(`dsh-im ${channel}: a message reaches its chat with sender, mention, route and lazy attachments`, async (t) => {
    const s = await connect(channel)
    t.after(() => { s.controller.abort(); s.handle.stop() })
    assert.equal(s.handle.channel, channel)
    assert.deepEqual(s.statuses.at(-1), { state: 'ready', account: { id: `${channel}_bot`, name: `${channel} bot` } })
    const loads = []
    await s.deliver(event(channel, { attachments: [{ kind: 'image', name: 'image' }, { kind: 'file', name: 'brief.pdf' }] }), {
      async loadAttachment(index, options) {
        loads.push([index, options.maxBytes > 0])
        return index === 0 ? { kind: 'image', data: PNG } : { kind: 'file', data: Buffer.from('pdf'), name: 'brief.pdf' }
      },
    })
    await s.deliver(event(channel))
    assert.equal(s.messages.length, 1, 'a redelivered message is taken once')
    const [msg] = s.messages
    assert.deepEqual(msg.chat, { key: 'chat-1', kind: 'group', title: 'Studio', reply: event(channel).reply, route: event(channel).target })
    assert.deepEqual(msg.sender, { id: 'u1', name: 'Mei' })
    assert.equal(msg.mentioned, true)
    assert.equal(msg.text, 'make a trailer')
    assert.match(msg.requestId, new RegExp(`^im:${channel}:[a-f0-9]{64}$`))
    assert.equal(loads.length, 0, 'attachments wait until the message is admitted')
    const loaded = await msg.attachments()
    assert.deepEqual(loaded.images, [{ mediaType: 'image/png', data: PNG.toString('base64') }])
    assert.deepEqual(loaded.files.map(file => [file.name, file.data.toString()]), [['brief.pdf', 'pdf']])
    await assert.rejects(async () => s.deliver(event(channel, { messageId: 'm2', fingerprint: '0'.repeat(64) })), /sender account/)
  })
}

test('dsh-im replies keep Markdown where the channel shows it and send plain text elsewhere', async () => {
  const rich = await connect('dingtalk')
  await rich.handle.send({ key: 'chat-1', reply: event('dingtalk').reply }, { text: '**Done**' })
  assert.deepEqual(rich.service.replies, [{ route: event('dingtalk').reply, text: '**Done**', format: 'markdown' }])
  const plain = await connect('weixin', { formats: ['plain'] })
  await plain.handle.send({ key: 'chat-1', reply: event('weixin').reply }, { text: '**Done** with `code`' })
  assert.equal(plain.service.replies[0].format, 'plain')
  assert.doesNotMatch(plain.service.replies[0].text, /\*\*/)
  rich.handle.stop()
  plain.handle.stop()
})

test('dsh-im writes first through the saved chat route and splits long text', async () => {
  const s = await connect('wecom')
  s.routes.set('chat-2', { kind: 'group', route: { chatId: 'chat-2' } })
  await s.handle.send({ key: 'chat-2' }, { text: `${'a'.repeat(4000)}${'b'.repeat(10)}` })
  assert.deepEqual(s.service.pushes.map(entry => [entry.target.route.chatId, entry.text.length]), [['chat-2', 4000], ['chat-2', 10]])
  // A reply route from another chat is never used.
  await s.handle.send({ key: 'chat-2', reply: { messageId: 'm9', conversationId: 'chat-9' } }, { text: 'x' })
  assert.equal(s.service.replies.length, 0)
  await assert.rejects(s.handle.send({ key: 'chat-3' }, { text: 'x' }), error => error.permanent === true)
  const noPush = await connect('qq', { push: false })
  noPush.routes.set('chat-2', { kind: 'group', route: { groupOpenId: 'chat-2' } })
  await assert.rejects(noPush.handle.send({ key: 'chat-2' }, { text: 'x' }), error => error.permanent === true)
  s.handle.stop()
  noPush.handle.stop()
})

test('dsh-im send failures: not connected retries, refused stays failed, unknown is never resent', async () => {
  const offline = await connect('dingtalk', { replyError: Object.assign(new Error('bot-not-connected'), { code: 'bot-not-connected' }) })
  const retry = await offline.handle.send({ key: 'chat-1', reply: event('dingtalk').reply }, { text: 'x' }).catch(error => error)
  assert.equal(retry.permanent, undefined)
  assert.equal(retry.unknown, undefined)
  const refused = await connect('dingtalk', { replyError: Object.assign(new Error('target-rejected'), { code: 'target-rejected' }) })
  assert.equal((await refused.handle.send({ key: 'chat-1', reply: event('dingtalk').reply }, { text: 'x' }).catch(error => error)).permanent, true)
  const unknown = await connect('dingtalk', { replyError: Object.assign(new Error('reply-result-unknown'), { code: 'reply-result-unknown' }) })
  assert.equal((await unknown.handle.send({ key: 'chat-1', reply: event('dingtalk').reply }, { text: 'x' }).catch(error => error)).unknown, true)
  for (const s of [offline, refused, unknown]) s.handle.stop()
})

test('dsh-im refuses an account other than the one the connection was linked with', async () => {
  await assert.rejects(connect('dingtalk', { pinned: 'e'.repeat(64) }), /changed/)
  assert.equal(consumable({ version: 1, channel: 'telegram', account: { fingerprint: FINGERPRINT }, capabilities: [] }), false)
  assert.deepEqual([...dshImConfig({ im_0123abcd: 'wx_bot' })], [['im_0123abcd', 'wx_bot']])
  assert.throws(() => dshImConfig({ im_0123abcd: 'wx_bot', im_0123abce: 'wx_bot' }), /single Muse connection/)
  assert.throws(() => dshImConfig({ conn: 'wx_bot' }), /dshIm must map/)
})
