import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { format } from 'node:util'
import feishu, { decodeFrame, encodeFrame } from '../src/host/im/platforms/feishu.js'
import { fakeWsServer } from './fake-ws.js'

// A fake Feishu that answers only the calls the real service answers, with the
// real shapes: the tenant token is a string, /callback/ws/endpoint needs the
// Bearer token and the uppercase AppID/AppSecret body, and anything else is a
// 404. A regression to the old path, a token object or lowercase fields fails
// here instead of passing against a permissive mock.
async function fakeFeishu() {
  const calls = []
  const frames = []
  const replies = {}
  const resources = {}
  const held = new Map()
  const tokens = []
  let tokenValidUntil = 0
  let tokenReplyDelay = 0
  let failResources = false
  let cardRefusal
  // The resource endpoint sends the file itself, not a JSON envelope.
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // A tenant token also dies when its two hours are up, like the real one.
  const authorized = (req) => req.headers.authorization === `Bearer ${tokens.at(-1)}` && Date.now() < tokenValidUntil
  const refused = (res) => json(res, { code: 99991668, msg: 'user access token not support' })
  const http = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const params = JSON.parse(body || '{}')
      calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization })
      const override = replies[req.url]
      if (override !== undefined) { json(res, override.result); return }
      if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') {
        if (params.app_id !== 'cli_a1' || params.app_secret !== 'sec') { json(res, { code: 10003, msg: 'invalid param' }); return }
        const token = `fs-tok-${tokens.length + 1}`
        tokens.push(token)
        tokenValidUntil = Date.now() + 7_200_000
        setTimeout(() => json(res, { code: 0, tenant_access_token: token, expire: 7200 }), tokenReplyDelay)
        return
      }
      if (req.url === '/open-apis/bot/v3/info') {
        if (!authorized(req)) { refused(res); return }
        json(res, { code: 0, bot: { open_id: 'ou_bot', app_name: 'fakebot' } })
        return
      }
      if (req.method === 'POST' && req.url === '/callback/ws/endpoint') {
        if (!authorized(req)) { refused(res); return }
        const uppercase = params.AppID === 'cli_a1' && params.AppSecret === 'sec'
          && params.appId === undefined && params.appSecret === undefined
        if (!uppercase) { json(res, { code: 10003, msg: 'invalid param' }); return }
        json(res, { code: 0, msg: 'success', data: { URL: wss.url, ClientConfig: { PingInterval: 90, ReconnectInterval: 90 } } })
        return
      }
      if (req.url.startsWith('/open-apis/im/v1/messages/') && req.url.includes('/resources/')) {
        if (failResources || !authorized(req)) { res.writeHead(401); res.end(); return }
        // A transfer that starts and never finishes.
        if (held.has(req.url)) {
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...held.get(req.url) })
          res.write('x')
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(resources[req.url] ?? imageBytes)
        return
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        if (!authorized(req)) { refused(res); return }
        if (cardRefusal !== undefined && params.msg_type === 'interactive') {
          res.writeHead(cardRefusal.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(cardRefusal.body))
          return
        }
        json(res, { code: 0, data: { message_id: 'om_x' } })
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('404 page not found')
    })
  })
  const wss = await fakeWsServer({
    onSocket(ws) {
      ws.on('message', (raw) => {
        const frame = decodeFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'))
        frames.push({ ws, frame })
      })
      ws.send(encodeFrame({ SeqID: 1, LogID: 2, service: 100, method: 0, headers: [{ key: 'type', value: 'ping' }], payload: Buffer.from('ping') }))
    },
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  return {
    api: `http://127.0.0.1:${http.address().port}`,
    calls, replies, resources, frames, tokens, imageBytes,
    sockets: wss.sockets,
    failDownloads: () => { failResources = true },
    holdDownload: (path, headers = {}) => { held.set(path, headers) },
    // The service's answer to every card from now on; text messages still go through.
    refuseCards: (status, body) => { cardRefusal = { status, body } },
    slowTokens: (ms) => { tokenReplyDelay = ms },
    push: (ws, frame) => ws.send(encodeFrame(frame)),
    dataFrame: (type, payload, extra = {}) => ({
      SeqID: 9, LogID: 9, service: 100, method: 1,
      headers: [{ key: 'type', value: type }, { key: 'message_id', value: extra.messageId ?? 'fm1' }, ...(extra.headers ?? [])],
      payload: Buffer.from(JSON.stringify(payload)),
    }),
    close: () => { wss.close(); http.closeAllConnections?.(); http.close() },
  }
}

const env = (fake) => ({
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  config: { api: fake.api },
  runtime: { get: () => ({}), set: () => {} },
  log: { warn: (...args) => console.error('[im-feishu]', ...args) },
})
const FIELDS = { appId: 'cli_a1', appSecret: 'sec' }

const until = async (fn, tries = 80) => {
  for (let at = 0; at < tries; at += 1) {
    const value = await fn()
    if (value !== undefined && value !== false) return value
    await new Promise(done => setTimeout(done, 50))
  }
  return undefined
}

const message = (body) => ({
  header: { event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_u1' } },
    message: body,
  },
})

// Connects the adapter; returns its handle, the socket to push events on, the messages
// and joined chats it hands on, and its warnings as the lines a log would show.
const listen = async (t, fake) => {
  const messages = []
  const joined = []
  const warnings = []
  const log = { warn: (...args) => warnings.push(format(...args)) }
  const handle = feishu.connect(FIELDS, { ...env(fake), log }, {
    onMessage: async msg => { messages.push(msg) },
    onChat: async chat => { joined.push(chat) },
    onAction() {},
    onStatus() {},
  })
  t.after(() => { handle.stop(); fake.close() })
  return { handle, messages, joined, warnings, ws: await until(() => fake.sockets[0]) }
}
const sentMessages = fake => fake.calls.filter(call => call.method === 'POST' && call.path.startsWith('/open-apis/im/v1/messages?')).map(call => call.params)
const resourceCalls = fake => fake.calls.filter(call => call.path.includes('/resources/')).map(call => call.path)

test('check asks for a tenant token and names the bot with it', async () => {
  const fake = await fakeFeishu()
  const { account } = await feishu.check(FIELDS, env(fake))
  assert.equal(account.id, 'ou_bot')
  assert.equal(account.name, 'fakebot')
  const token = fake.calls.find(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(token.params.app_id, 'cli_a1')
  // The Bearer token is the token string, not the tenantToken() result object.
  const info = fake.calls.find(call => call.path === '/open-apis/bot/v3/info')
  assert.equal(info.auth, `Bearer ${fake.tokens[0]}`)
  await fake.close()
})

test('the fake refuses the old path, an object token and lowercase fields', async (t) => {
  const fake = await fakeFeishu()
  t.after(() => fake.close())
  const answer = await fetch(`${fake.api}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: 'cli_a1', app_secret: 'sec' }),
  })
  const { tenant_access_token: token } = await answer.json()
  const post = async (path, body, auth) => {
    const response = await fetch(`${fake.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth === undefined ? {} : { authorization: auth }) },
      body: JSON.stringify(body),
    })
    return { response, body: await response.json().catch(() => undefined) }
  }
  const oldPath = await post('/open-apis/bot/v2/endpoint', { AppID: 'cli_a1', AppSecret: 'sec' }, `Bearer ${token}`)
  assert.equal(oldPath.response.status, 404)
  const objectToken = await post('/callback/ws/endpoint', { AppID: 'cli_a1', AppSecret: 'sec' }, 'Bearer [object Object]')
  assert.equal(objectToken.body.code, 99991668)
  const lowercase = await post('/callback/ws/endpoint', { appId: 'cli_a1', appSecret: 'sec' }, `Bearer ${token}`)
  assert.equal(lowercase.body.code, 10003)
})

test('a ping gets a pong, a p2p is direct, a group counts only with a mention, data frames are ACKed', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const endpoint = await until(() => fake.calls.find(call => call.path === '/callback/ws/endpoint'))
  assert.equal(endpoint.auth, `Bearer ${fake.tokens[0]}`)
  assert.deepEqual(endpoint.params, { AppID: 'cli_a1', AppSecret: 'sec' })
  // The ping sent on connect gets a pong back.
  await until(() => fake.frames.some(({ frame }) => frame.method === 0 && frame.headers.some(h => h.key === 'type' && h.value === 'pong')))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) }), { messageId: 'fm1' }))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_2', message_type: 'text', content: JSON.stringify({ text: '@_user_1 ping' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] }), { messageId: 'fm2' }))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_3', message_type: 'text', content: JSON.stringify({ text: 'noise' }), mentions: [] }), { messageId: 'fm3' }))
  await until(() => messages.length === 3)
  assert.equal(messages[0].chat.kind, 'direct')
  assert.equal(messages[1].chat.kind, 'group')
  assert.equal(messages[1].mentioned, true)
  assert.equal(messages[1].text, 'ping')
  assert.equal(messages[2].mentioned, false)
  // Each data frame was ACKed back with the {"code":200} payload.
  await until(() => fake.frames.filter(({ frame }) => frame.method === 1 && frame.headers.some(h => h.key === 'biz_rt')).length === 3)
})

for (const [mediaType, bytes] of [
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ['image/gif', Buffer.from('GIF89a')],
  ['image/webp', Buffer.from('RIFF\x04\x00\x00\x00WEBP')],
]) {
  test(`an inbound ${mediaType} keeps its bytes and declares their format`, async (t) => {
    const fake = await fakeFeishu()
    const messages = []
    fake.resources['/open-apis/im/v1/messages/om_image/resources/img_1?type=image'] = bytes
    const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
    t.after(() => { handle.stop(); fake.close() })
    const ws = await until(() => fake.sockets[0])
    fake.push(ws, fake.dataFrame('event', message({
      chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_image',
      message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }),
    })))
    await until(() => messages.length === 1)
    assert.deepEqual(messages[0].images, [{ mediaType, data: bytes.toString('base64') }])
  })
}

test('an unrecognized image is diagnosed instead of being declared as PNG', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const warnings = []
  fake.resources['/open-apis/im/v1/messages/om_image/resources/img_1?type=image'] = Buffer.from('not an image')
  const environment = { ...env(fake), log: { warn: (...args) => warnings.push(args.join(' ')) } }
  const handle = feishu.connect(FIELDS, environment, { onMessage: async msg => { messages.push(msg) }, onAction() {}, onStatus() {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_image',
    message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }),
  })))
  await until(() => messages.length === 1)
  assert.match(warnings.join('\n'), /unsupported image format/i)
  // The message still arrives, without a picture, so the person can be told.
  assert.deepEqual(messages[0].images, [])
  assert.equal(messages[0].unsupported, 'image')
})

test('a post flattens to its title, text, links and mentions, and its pictures and videos are downloaded', async (t) => {
  const fake = await fakeFeishu()
  const { messages, ws } = await listen(t, fake)
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: 'om_post', message_type: 'post',
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'fakebot' },
      { key: '@_user_2', id: { open_id: 'ou_u2' }, name: 'Lin' },
    ],
    content: JSON.stringify({
      title: 'Episode 3',
      content: [
        [
          { tag: 'at', user_id: '@_user_1', user_name: 'fakebot' },
          { tag: 'text', text: ' see ' },
          { tag: 'a', href: 'https://example.com/outline', text: 'the outline' },
          { tag: 'text', text: ' with ' },
          // Without a name of its own, a mention takes the one in `mentions`.
          { tag: 'at', user_id: '@_user_2', user_name: '' },
        ],
        [{ tag: 'img', image_key: 'img_1' }],
        [{ tag: 'media', file_key: 'file_1', image_key: 'img_cover' }],
        [{ tag: 'text', text: 'done ' }, { tag: 'emotion', emoji_type: 'SMILE' }],
        [{ tag: 'hr' }],
        [{ tag: 'code_block', language: 'JSON', text: '{"a":1}\n' }],
      ],
    }),
  })))
  await until(() => messages.length === 1)
  assert.equal(messages[0].mentioned, true)
  assert.equal(messages[0].text, [
    'Episode 3',
    'see [the outline](https://example.com/outline) with @Lin',
    'done [SMILE]',
    '---',
    '```json',
    '{"a":1}',
    '```',
  ].join('\n'))
  assert.deepEqual(messages[0].images, [{ mediaType: 'image/png', data: fake.imageBytes.toString('base64') }])
  assert.deepEqual(messages[0].files.map(file => file.name), ['video.mp4'])
  assert.equal(messages[0].unsupported, undefined)
  assert.deepEqual(resourceCalls(fake), [
    '/open-apis/im/v1/messages/om_post/resources/img_1?type=image',
    '/open-apis/im/v1/messages/om_post/resources/file_1?type=file',
  ])
})

test('a post kept under a locale key is read the same', async (t) => {
  const fake = await fakeFeishu()
  const { messages, ws } = await listen(t, fake)
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_post', message_type: 'post',
    content: JSON.stringify({ zh_cn: { title: '标题', content: [[{ tag: 'text', text: '第一段' }], [], [{ tag: 'text', text: '第二段' }]] } }),
  })))
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, '标题\n第一段\n\n第二段')
})

test('a post whose only picture cannot be downloaded still delivers its text', async (t) => {
  const fake = await fakeFeishu()
  const { messages, ws } = await listen(t, fake)
  fake.failDownloads()
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_post', message_type: 'post',
    content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: 'look at this' }], [{ tag: 'img', image_key: 'img_1' }]] }),
  })))
  await until(() => messages.length === 1)
  assert.equal(messages[0].text, 'look at this')
  assert.deepEqual(messages[0].images, [])
  assert.equal(messages[0].unsupported, undefined)
})

for (const [type, content, name] of [
  ['file', { file_key: 'file_1', file_name: 'plan.txt' }, 'plan.txt'],
  ['audio', { file_key: 'file_1', duration: 2000 }, 'audio.opus'],
  ['media', { file_key: 'file_1', image_key: 'img_1', file_name: 'cut.mp4', duration: 2000 }, 'cut.mp4'],
]) {
  test(`an inbound ${type} is downloaded and handed on as the file ${name}`, async (t) => {
    const fake = await fakeFeishu()
    const bytes = Buffer.from(`${type} bytes`)
    fake.resources['/open-apis/im/v1/messages/om_file/resources/file_1?type=file'] = bytes
    const { messages, ws } = await listen(t, fake)
    fake.push(ws, fake.dataFrame('event', message({
      chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_file', message_type: type, content: JSON.stringify(content),
    })))
    await until(() => messages.length === 1)
    assert.equal(messages[0].files.length, 1)
    assert.equal(messages[0].files[0].name, name)
    assert.deepEqual(Buffer.from(messages[0].files[0].data), bytes)
    assert.deepEqual(messages[0].images, [])
    assert.equal(messages[0].unsupported, undefined)
    assert.deepEqual(resourceCalls(fake), ['/open-apis/im/v1/messages/om_file/resources/file_1?type=file'])
  })
}

for (const [type, content] of [
  ['sticker', JSON.stringify({ file_key: 'file_1' })],
  ['merge_forward', 'Merged and Forwarded Message'],
  ['share_chat', JSON.stringify({ chat_id: 'oc_9' })],
  ['share_user', JSON.stringify({ user_id: 'ou_9' })],
  ['text', JSON.stringify({ text: '  ' })],
]) {
  test(`an inbound ${type} with nothing to read is handed on as unsupported, fetching nothing`, async (t) => {
    const fake = await fakeFeishu()
    const { messages, ws } = await listen(t, fake)
    fake.push(ws, fake.dataFrame('event', message({
      chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: type, content,
    })))
    await until(() => messages.length === 1)
    assert.equal(messages[0].unsupported, type)
    assert.equal(messages[0].text, '')
    assert.deepEqual(messages[0].images, [])
    assert.deepEqual(messages[0].files, [])
    assert.deepEqual(resourceCalls(fake), [])
  })
}

test('a file that cannot be downloaded is handed on as unsupported, and the warning names only the type and the chat kind', async (t) => {
  const fake = await fakeFeishu()
  const { messages, warnings, ws } = await listen(t, fake)
  fake.failDownloads()
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_file', message_type: 'file',
    content: JSON.stringify({ file_key: 'file_1', file_name: 'plan.txt' }),
  })))
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0].files, [])
  assert.equal(messages[0].unsupported, 'file')
  assert.equal(warnings[0], 'ds-bot im: feishu file download failed in a direct chat')
})

test('a file over the cap is abandoned and handed on as unsupported', async (t) => {
  const fake = await fakeFeishu()
  // The declared length is past the cap; no such body is ever sent.
  fake.holdDownload('/open-apis/im/v1/messages/om_file/resources/file_1?type=file', { 'content-length': String(101 * 1024 * 1024) })
  const { messages, warnings, ws } = await listen(t, fake)
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_file', message_type: 'media',
    content: JSON.stringify({ file_key: 'file_1', file_name: 'cut.mp4' }),
  })))
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0].files, [])
  assert.equal(messages[0].unsupported, 'media')
  assert.equal(warnings[0], 'ds-bot im: feishu media in a direct chat is over the 104857600 byte cap, skipped')
})

test('a download that stalls is given up, and the messages after it still arrive', async (t) => {
  const fake = await fakeFeishu()
  fake.holdDownload('/open-apis/im/v1/messages/om_file/resources/file_1?type=file')
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 100)
  t.after(() => { AbortSignal.timeout = realTimeout })
  const { messages, warnings, ws } = await listen(t, fake)
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_file', message_type: 'file',
    content: JSON.stringify({ file_key: 'file_1', file_name: 'plan.txt' }),
  }), { messageId: 'fm1' }))
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_text', message_type: 'text', content: JSON.stringify({ text: 'still here' }),
  }), { messageId: 'fm2' }))
  await until(() => messages.length === 2)
  assert.deepEqual(messages[0].files, [])
  assert.equal(messages[0].unsupported, 'file')
  assert.equal(warnings[0], 'ds-bot im: feishu file download failed in a direct chat')
  assert.equal(messages[1].text, 'still here')
})

test('a group message that does not mention the bot fetches nothing and is not marked unsupported', async (t) => {
  const fake = await fakeFeishu()
  const { messages, warnings, ws } = await listen(t, fake)
  const group = (id, type, content) => fake.dataFrame('event', message({
    chat_type: 'group', chat_id: 'oc_2', message_id: id, message_type: type, content: JSON.stringify(content), mentions: [],
  }), { messageId: id })
  fake.push(ws, group('om_1', 'file', { file_key: 'file_1', file_name: 'plan.txt' }))
  fake.push(ws, group('om_2', 'image', { image_key: 'img_1' }))
  fake.push(ws, group('om_3', 'sticker', { file_key: 'file_2' }))
  await until(() => messages.length === 3)
  for (const msg of messages) {
    assert.equal(msg.mentioned, false)
    assert.equal(msg.unsupported, undefined)
    assert.deepEqual(msg.images, [])
    assert.deepEqual(msg.files, [])
  }
  assert.deepEqual(resourceCalls(fake), [])
  assert.deepEqual(warnings.filter(line => !line.includes('names for')), [])
})

test('a card action reports the button data', async (t) => {
  const fake = await fakeFeishu()
  const actions = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: async action => { actions.push(action) }, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.sockets.length === 1)
  fake.push(ws, fake.dataFrame('card', {
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { v: 'q:q1:0' } }, operator: { open_id: 'ou_u1' }, context: { open_chat_id: 'oc_1' }, message_id: 'om_9' },
  }, { messageId: 'fm9' }))
  await until(() => actions.length === 1)
  assert.equal(actions[0].data, 'q:q1:0')
  assert.equal(actions[0].messageId, 'om_9')
})

test('send posts text and an interactive card, edit patches the message', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  const { messageId } = await handle.send({ key: 'oc_1', kind: 'direct' }, { text: 'hello', buttons: [{ data: 'q:q1:0', label: 'yes' }] })
  const post = fake.calls.find(call => call.path.startsWith('/open-apis/im/v1/messages?'))
  assert.ok(post, 'messages POST called')
  assert.equal(post.params.receive_id, 'oc_1')
  assert.equal(post.params.msg_type, 'interactive')
  const card = JSON.parse(post.params.content)
  const action = card.body.elements.at(-1)
  assert.equal(action.tag, 'action')
  assert.equal(action.actions[0].value.v, 'q:q1:0')
  assert.equal(messageId, 'om_x')
  await handle.edit({ key: 'oc_1', kind: 'direct' }, 'om_9', { text: 'done', buttons: [] })
  const patch = fake.calls.find(call => call.method === 'PATCH' && call.path === '/open-apis/im/v1/messages/om_9')
  assert.ok(patch, 'message PATCH called')
})

test('send drops blank lines at the start and end of the text', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  await until(() => fake.sockets[0])
  await until(() => fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  await handle.send({ key: 'oc_1', kind: 'direct' }, { text: '\n\nfirst\n\nsecond\n\n' })
  const posts = fake.calls.filter(call => call.path.startsWith('/open-apis/im/v1/messages?'))
  assert.equal(posts.length, 1)
  assert.equal(posts[0].params.msg_type, 'text')
  assert.equal(JSON.parse(posts[0].params.content).text, 'first\n\nsecond')
})

test('a dropped socket reconnects through a fresh endpoint and a renewed token', async (t) => {
  const fake = await fakeFeishu()
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  await until(() => fake.calls.filter(call => call.path === '/callback/ws/endpoint').length === 1)
  // Move the clock past the token's expiry, so the next handshake has to renew it.
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  ws.close()
  const endpoint = await until(() => fake.calls.filter(call => call.path === '/callback/ws/endpoint')[1], 160)
  assert.ok(endpoint, 'handshake after the reconnect')
  assert.equal(fake.tokens.length, 2)
  assert.equal(endpoint.auth, `Bearer ${fake.tokens[1]}`)
})

test('a refused handshake reports the code and the message', async (t) => {
  const fake = await fakeFeishu()
  fake.replies['/callback/ws/endpoint'] = { result: { code: 10003, msg: 'invalid param' } }
  const statuses = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: () => {}, onAction: () => {}, onStatus: status => { statuses.push(status) } })
  t.after(() => { handle.stop(); fake.close() })
  const error = await until(() => statuses.find(status => status.state === 'error'))
  assert.ok(error, 'an error status')
  assert.match(error.error, /invalid param/)
  assert.match(error.error, /10003/)
})

test('a network failure at start is retried until the platform answers (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let down = true
  const fetch = async (...args) => {
    if (down) throw new TypeError('fetch failed')
    return base.fetch(...args)
  }
  const handle = feishu.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  down = false
  await until(() => statuses.some(status => status.state === 'ready'), 160)
  assert.ok(fake.calls.some(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal'))
  assert.equal(fake.sockets.length, 1)
})

test('a ws endpoint failure after the token is accepted is retried (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let down = true
  let handshakes = 0
  const fetch = async (url, ...rest) => {
    if (String(url).endsWith('/callback/ws/endpoint')) {
      handshakes += 1
      if (down) throw new TypeError('fetch failed')
    }
    return base.fetch(url, ...rest)
  }
  const handle = feishu.connect(FIELDS, { ...base, fetch }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /fetch failed/)
  // The token and bot identity were accepted first, so this covers the websocket
  // handshake and not a second token failure.
  assert.equal(fake.calls.filter(call => call.path === '/open-apis/auth/v3/tenant_access_token/internal').length, 1)
  assert.ok(fake.calls.some(call => call.path === '/open-apis/bot/v3/info'))
  assert.equal(fake.sockets.length, 0)
  down = false
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after the retry')
  assert.equal(handshakes, 2)
  assert.equal(fake.sockets.length, 1, 'the retry opened one socket, not one per attempt')
})

test('a socket that cannot be built at the handshake is retried (#1119)', async (t) => {
  const fake = await fakeFeishu()
  const statuses = []
  const base = env(fake)
  let failures = 1
  const WebSocket = function (...args) {
    if (failures > 0) { failures -= 1; throw new TypeError('socket unavailable') }
    return new base.WebSocket(...args)
  }
  const handle = feishu.connect(FIELDS, { ...base, WebSocket }, { onMessage: () => {}, onAction: () => {}, onStatus: next => statuses.push(next) })
  t.after(() => { handle.stop(); fake.close() })
  const failed = await until(() => statuses.find(status => status.state === 'retrying'))
  assert.match(failed.error, /could not open a socket/)
  const ready = await until(() => statuses.slice(statuses.indexOf(failed) + 1).find(status => status.state === 'ready'), 160)
  assert.ok(ready !== undefined, 'the connection became ready after a new socket')
  assert.equal(fake.sockets.length, 1)
})

test('an inbound image refreshes an expired tenant token before download', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const image = (id) => fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: id, message_type: 'image',
    content: JSON.stringify({ image_key: `key_${id}` }),
  }), { messageId: id })
  fake.push(ws, image('om_1'))
  await until(() => messages.length === 1)
  assert.equal(messages[0].images[0].data, fake.imageBytes.toString('base64'))
  // Two hours later the cached token is dead: the download has to renew it.
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  fake.push(ws, image('om_2'))
  await until(() => messages.length === 2)
  assert.equal(messages[1].images.length, 1)
  assert.equal(messages[1].images[0].data, fake.imageBytes.toString('base64'))
  assert.equal(fake.tokens.length, 2, 'the expired token was renewed once')
  const download = fake.calls.findLast(call => call.path.includes('/resources/'))
  assert.equal(download.auth, `Bearer ${fake.tokens[1]}`)
})

test('a failed image download warns instead of staying silent', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const warns = []
  const log = { warn: (...args) => warns.push(args.join(' ')) }
  const handle = feishu.connect(FIELDS, { ...env(fake), log }, { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  fake.failDownloads()
  fake.push(ws, fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: 'image',
    content: JSON.stringify({ image_key: 'key_1' }),
  }), { messageId: 'fm1' }))
  await until(() => warns.length === 1)
  assert.match(warns[0], /om_1/)
  await until(() => messages.length === 1)
  assert.equal(messages[0].images.length, 0, 'the message still arrives, without the image')
})

// #1417: the send path classified 5xx as retryable but carried no status, so the
// queue could not tell a broken tunnel from a network blip and retried forever.
test('a 5xx answer is retryable and carries its status; a 4xx answer is permanent', async () => {
  const responding = (status, body) => async (url) => (url.endsWith('/tenant_access_token/internal')
    ? { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tok', expire: 7200 }) }
    : { ok: false, status, json: async () => body })
  await assert.rejects(feishu.check(FIELDS, { fetch: responding(502, { msg: 'bad gateway' }), config: { api: 'https://open.feishu.cn' } }), (error) => {
    assert.equal(error.status, 502)
    assert.notEqual(error.permanent, true, 'a 5xx must stay retryable')
    return true
  })
  await assert.rejects(feishu.check(FIELDS, { fetch: responding(403, { msg: 'forbidden' }), config: { api: 'https://open.feishu.cn' } }), (error) => {
    assert.equal(error.status, 403)
    assert.equal(error.permanent, true, 'a 4xx is not retried')
    return true
  })
})

test('images arriving together after expiry share one token refresh', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const realNow = Date.now
  Date.now = () => realNow() + 7_300_000
  t.after(() => { Date.now = realNow })
  // Slow token replies make a second refresh overtake the first download
  // deterministically; the fake only accepts its newest token.
  fake.slowTokens(50)
  const image = (id) => fake.dataFrame('event', message({
    chat_type: 'p2p', chat_id: 'oc_1', message_id: id, message_type: 'image',
    content: JSON.stringify({ image_key: `key_${id}` }),
  }), { messageId: id })
  fake.push(ws, image('om_1'))
  fake.push(ws, image('om_2'))
  await until(() => messages.length === 2)
  assert.equal(fake.tokens.length, 2, 'two expired downloads share the one refresh')
  assert.equal(messages[0].images.length, 1)
  assert.equal(messages[1].images.length, 1)
})

test('a group message carries the group and sender names read from Feishu; without the scope the ids stand in', async (t) => {
  const fake = await fakeFeishu()
  const messages = []
  fake.replies['/open-apis/im/v1/chats/oc_2'] = { result: { code: 0, data: { name: '短剧剧组' } } }
  fake.replies['/open-apis/im/v1/chats/oc_2/members?member_id_type=open_id&page_size=100'] = { result: { code: 0, data: { items: [{ member_id: 'ou_x', name: 'X' }], has_more: true, page_token: 'p2' } } }
  fake.replies['/open-apis/im/v1/chats/oc_2/members?member_id_type=open_id&page_size=100&page_token=p2'] = { result: { code: 0, data: { items: [{ member_id: 'ou_u1', name: '杨礼楷' }], has_more: false } } }
  fake.replies['/open-apis/im/v1/chats/oc_1/members?member_id_type=open_id&page_size=100'] = { result: { code: 0, data: { items: [{ member_id: 'ou_u1', name: '杨礼楷' }] } } }
  const handle = feishu.connect(FIELDS, env(fake), { onMessage: async msg => { messages.push(msg) }, onAction: () => {}, onStatus: () => {} })
  t.after(() => { handle.stop(); fake.close() })
  const ws = await until(() => fake.sockets[0])
  const mention = [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_1', message_type: 'text', content: JSON.stringify({ text: '@_user_1 hi' }), mentions: mention })))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_2', message_type: 'text', content: JSON.stringify({ text: 'hi' }) })))
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_9', message_id: 'om_3', message_type: 'text', content: JSON.stringify({ text: '@_user_1 hi' }), mentions: mention })))
  await until(() => messages.length === 3)
  assert.deepEqual(messages[0].chat, { key: 'oc_2', kind: 'group', title: '短剧剧组' })
  assert.deepEqual(messages[0].sender, { id: 'ou_u1', name: '杨礼楷' })
  assert.deepEqual(messages[1].chat, { key: 'oc_1', kind: 'direct', title: '杨礼楷' })
  assert.deepEqual(messages[2].chat, { key: 'oc_9', kind: 'group', title: 'oc_9' })
  assert.deepEqual(messages[2].sender, { id: 'ou_u1', name: 'ou_u1' })
  // Names are read once per chat, not for every message.
  fake.push(ws, fake.dataFrame('event', message({ chat_type: 'group', chat_id: 'oc_2', message_id: 'om_4', message_type: 'text', content: JSON.stringify({ text: '@_user_1 again' }), mentions: mention })))
  await until(() => messages.length === 4)
  assert.equal(fake.calls.filter(call => call.path === '/open-apis/im/v1/chats/oc_2').length, 1)
})

test('a Feishu progress card replies inside the original topic and edits its own message', async (t) => {
  const { createFeishuHttp } = await import('../src/host/im/platforms/feishu.js')
  const fake = await fakeFeishu()
  t.after(() => fake.close())
  const client = createFeishuHttp(FIELDS, env(fake))
  const route = { messageId: 'om_source', threadId: 'omt_original' }
  const id = await client.progress(route, 'Muse is working', { mode: 'streaming_card' })
  await client.progress(route, 'Muse finished', { mode: 'streaming_card', messageId: id })
  const [send, edit] = fake.calls.filter(call => call.path.startsWith('/open-apis/im/v1/messages'))
  assert.equal(send.path, '/open-apis/im/v1/messages/om_source/reply')
  assert.equal(send.params.reply_in_thread, true)
  assert.equal(send.params.msg_type, 'interactive')
  assert.equal(JSON.parse(send.params.content).body.elements[0].content, 'Muse is working')
  assert.equal(edit.method, 'PATCH')
  assert.equal(edit.path, '/open-apis/im/v1/messages/om_x')
  assert.equal(JSON.parse(edit.params.content).body.elements[0].content, 'Muse finished')
})

test('chats lists the groups the bot is in, page after page', async (t) => {
  const fake = await fakeFeishu()
  fake.replies['/open-apis/im/v1/chats?page_size=100'] = { result: { code: 0, data: { items: [{ chat_id: 'oc_a', name: '编剧组' }, { chat_id: 'oc_b', name: '' }], has_more: true, page_token: 'p2' } } }
  fake.replies['/open-apis/im/v1/chats?page_size=100&page_token=p2'] = { result: { code: 0, data: { items: [{ chat_id: 'oc_c', name: '剪辑组' }], has_more: false } } }
  const { handle } = await listen(t, fake)
  assert.deepEqual(await handle.chats(), [
    { key: 'oc_a', kind: 'group', title: '编剧组' },
    { key: 'oc_b', kind: 'group', title: '' },
    { key: 'oc_c', kind: 'group', title: '剪辑组' },
  ])
  assert.equal(fake.calls.filter(call => call.path.startsWith('/open-apis/im/v1/chats?')).every(call => call.method === 'GET'), true)
})

test('chats fails when the app may not read its chat list', async (t) => {
  const fake = await fakeFeishu()
  fake.replies['/open-apis/im/v1/chats?page_size=100'] = { result: { code: 99991672, msg: 'Access denied' } }
  const { handle } = await listen(t, fake)
  await assert.rejects(handle.chats(), /Access denied/)
})

test('being added to a group reports the chat', async (t) => {
  const fake = await fakeFeishu()
  const { joined, messages, ws } = await listen(t, fake)
  fake.push(ws, fake.dataFrame('event', {
    header: { event_type: 'im.chat.member.bot.added_v1' },
    event: { chat_id: 'oc_new', name: '新剧组', operator_id: { open_id: 'ou_u1' } },
  }))
  await until(() => joined.length === 1)
  assert.deepEqual(joined, [{ key: 'oc_new', kind: 'group', title: '新剧组' }])
  assert.equal(messages.length, 0)
})

test('a reply that uses Markdown goes out as a card; a plain reply stays a text message', async (t) => {
  const fake = await fakeFeishu()
  const { handle } = await listen(t, fake)
  const chat = { key: 'oc_1', kind: 'direct' }
  const table = '| 集 | 状态 |\n| --- | --- |\n| 1 | 完成 |'
  const { messageId } = await handle.send(chat, { text: `## 结论\n\n**可以**，见 ![分镜](https://example.com/a.png)\n\n${table}` })
  await handle.send(chat, { text: '好的，马上处理。\n第二行 2*3*4 和 snake_case_name' })
  const [rich, plain] = sentMessages(fake)
  assert.equal(messageId, 'om_x')
  assert.equal(rich.receive_id, 'oc_1')
  assert.equal(rich.msg_type, 'interactive')
  // The Markdown goes into the card as written, but for the picture: a card cannot fetch one.
  assert.deepEqual(JSON.parse(rich.content), {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content: `## 结论\n\n**可以**，见 [分镜](https://example.com/a.png)\n\n${table}` }] },
  })
  assert.equal(plain.msg_type, 'text')
  assert.equal(JSON.parse(plain.content).text, '好的，马上处理。\n第二行 2*3*4 和 snake_case_name')
})

test('a reply with more tables than a card accepts goes out as several cards', async (t) => {
  const fake = await fakeFeishu()
  const { handle } = await listen(t, fake)
  const table = n => `表 ${n}\n\n| a | b |\n| - | - |\n| ${n} | ${n} |`
  await handle.send({ key: 'oc_1', kind: 'direct' }, { text: [1, 2, 3, 4, 5, 6, 7].map(table).join('\n\n') })
  const cards = sentMessages(fake).map(message => JSON.parse(message.content).body.elements[0].content)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].match(/\| - \| - \|/g).length, 5)
  assert.equal(cards[1].match(/\| - \| - \|/g).length, 2)
  // The cut falls where the sixth table begins; its lead-in stays on the card before.
  assert.ok(cards[0].endsWith('表 6'))
  assert.ok(cards[1].startsWith('| a | b |'))
})

test('a card the service refuses for its content goes out as text instead', async (t) => {
  const fake = await fakeFeishu()
  const { handle, warnings } = await listen(t, fake)
  fake.refuseCards(400, { code: 230099, msg: 'Failed to create card content' })
  const { messageId } = await handle.send({ key: 'oc_1', kind: 'direct' }, { text: '**结论**：可以' })
  const sent = sentMessages(fake)
  assert.deepEqual(sent.map(message => message.msg_type), ['interactive', 'text'])
  assert.equal(JSON.parse(sent[1].content).text, '**结论**：可以')
  assert.equal(messageId, 'om_x')
  assert.deepEqual(warnings.filter(line => line.includes('card')), ['ds-bot im: feishu refused a card (HTTP 400, code 230099), sent as text'])
  // A card with buttons has no text form: its refusal stays an error.
  await assert.rejects(handle.send({ key: 'oc_1', kind: 'direct' }, { text: 'pick one', buttons: [{ data: 'q:q1:0', label: 'yes' }] }), /Failed to create card content/)
})

test('a chunk whose card would pass the size cap goes out as text', async (t) => {
  const fake = await fakeFeishu()
  const { handle } = await listen(t, fake)
  // A control character takes six bytes once the card is serialised.
  const text = `**a** ${'\u0001'.repeat(3994)}`
  await handle.send({ key: 'oc_1', kind: 'direct' }, { text })
  const sent = sentMessages(fake)
  assert.deepEqual(sent.map(message => message.msg_type), ['text'])
  assert.equal(JSON.parse(sent[0].content).text, text)
})

test('a card refused for the app\'s access is not retried as text', async (t) => {
  const fake = await fakeFeishu()
  const { handle } = await listen(t, fake)
  fake.refuseCards(403, { code: 99991672, msg: 'Access denied' })
  await assert.rejects(handle.send({ key: 'oc_1', kind: 'direct' }, { text: '**结论**：可以' }), /Access denied/)
  assert.deepEqual(sentMessages(fake).map(message => message.msg_type), ['interactive'])
})
