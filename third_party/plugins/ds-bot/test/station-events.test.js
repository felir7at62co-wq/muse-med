// Muse: the data station's signed 储备 changes reach the main Bot's chat as one message per batch.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { describeDelivery, describeEvent, install, readStationSecret, STATION_EVENTS_PATH, verifySignature } from '../src/host/station-events.js'

const SECRET = 'k'.repeat(48)
const NOW = 1_795_200_000_000
const sign = (timestamp, body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
const event = patch => ({ id: 1, workId: 'hongguo:7460844307990187033', title: '好一个乖乖女', at: '2026-11-21T00:00:00.000Z', from: null, to: 'queued', actor: 'selection', note: '新上榜作品入选', ...patch })

function harness({ mainBotIds = ['main-bot'], secretMode = 0o600, writeSecret = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'station-events-'))
  const secretFile = join(directory, 'secret')
  if (writeSecret) { writeFileSync(secretFile, `${SECRET}\n`); chmodSync(secretFile, secretMode) }
  const sent = []
  const routes = []
  const disposed = []
  const rt = {
    config: { stationEventsSecretFile: secretFile },
    state: { mainBotIds },
    now: () => NOW,
    warn: () => {},
    sendUser: async (message) => { sent.push(message) },
    ctx: {
      inject: (names, attach) => {
        assert.deepEqual(names, ['webServer'])
        attach({ webServer: { register: (route) => { routes.push(route); return () => { disposed.push(route) } } }, effect: (fn) => { disposed.push(fn()) } })
      },
    },
  }
  install(rt)
  const post = async (body, { timestamp = String(NOW), signature, method = 'POST', contentType = 'application/json' } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    const request = Readable.from([Buffer.from(text)])
    request.method = method
    request.headers = { 'content-type': contentType, 'x-muse-station-timestamp': timestamp, 'x-muse-station-signature': signature ?? sign(timestamp, text) }
    const response = { statusCode: 0, headers: {}, body: '', headersSent: false,
      setHeader(name, value) { this.headers[name] = value }, end(chunk) { this.body = chunk; this.headersSent = true } }
    await routes[0].handler(request, response)
    return { status: response.statusCode, body: response.body === '' ? null : JSON.parse(response.body) }
  }
  return { rt, sent, routes, post, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('the route registers only when a secret file is configured', () => {
  const off = []
  install({ config: {}, state: {}, ctx: { inject: () => { off.push('injected') } } })
  assert.deepEqual(off, [])
  const on = harness()
  try {
    assert.equal(on.routes.length, 1)
    assert.equal(on.routes[0].kind, 'exact')
    assert.equal(on.routes[0].path, STATION_EVENTS_PATH)
  } finally { on.cleanup() }
})

test('a signed batch becomes one message in the main Bot chat, and a repeat is acknowledged without a second one', async () => {
  const h = harness()
  try {
    const batch = { deliveryId: '7-8', events: [event({ id: 7 }), event({ id: 8, workId: 'hongguo:2', title: null, actor: '成员甲', note: '立即转写' })] }
    assert.deepEqual(await h.post(batch), { status: 202, body: { accepted: 2 } })
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].sessionId, 'main-bot')
    assert.equal(h.sent[0].requestId, 'station:7-8')
    assert.equal(h.sent[0].content[0].text, '【储备变化】数据站自动通知，不是用户发的消息；按技能 hit-transcription-dispatch 处理。\n- 新入储备：《好一个乖乖女》（新上榜作品入选）\n- 立即转写：《hongguo:2》，成员甲 发起')
    assert.deepEqual(await h.post(batch), { status: 200, body: { accepted: 0, repeated: true } })
    assert.equal(h.sent.length, 1)
  } finally { h.cleanup() }
})

test('forged, stale, malformed and misdirected deliveries are refused before any message', async () => {
  const h = harness()
  try {
    const batch = { deliveryId: '1-1', events: [event({})] }
    const text = JSON.stringify(batch)
    assert.equal((await h.post(text, { signature: sign(String(NOW), text, 'x'.repeat(48)) })).status, 401)
    assert.equal((await h.post(text, { signature: 'sha256=short' })).status, 401)
    const old = String(NOW - 6 * 60_000)
    assert.equal((await h.post(text, { timestamp: old, signature: sign(old, text) })).status, 401)
    assert.equal((await h.post(text, { timestamp: 'soon' })).status, 401)
    assert.equal((await h.post({ deliveryId: '1-1', events: [] })).status, 400)
    assert.equal((await h.post({ deliveryId: '1-1', events: [{ workId: 3 }] })).status, 400)
    assert.equal((await h.post('{not json')).status, 400)
    assert.equal((await h.post(batch, { method: 'GET' })).status, 405)
    assert.equal((await h.post(batch, { contentType: 'text/plain' })).status, 415)
    assert.equal((await h.post('x'.repeat(300 * 1024))).status, 413)
    assert.equal(h.sent.length, 0)
  } finally { h.cleanup() }
})

test('without a main Bot or a readable private secret the station is told to retry', async () => {
  const noBot = harness({ mainBotIds: [] })
  try { assert.equal((await noBot.post({ deliveryId: '1-1', events: [event({})] })).status, 503) } finally { noBot.cleanup() }
  const loose = harness({ secretMode: 0o644 })
  try { assert.equal((await loose.post({ deliveryId: '1-1', events: [event({})] })).status, 503) } finally { loose.cleanup() }
  const missing = harness({ writeSecret: false })
  try { assert.equal((await missing.post({ deliveryId: '1-1', events: [event({})] })).status, 503) } finally { missing.cleanup() }
})

test('each change reads as the work the main Bot has to do', () => {
  assert.equal(describeEvent(event({ to: 'queued', from: 'needs-attention', note: '立即转写', actor: '杨礼楷' })), '立即转写：《好一个乖乖女》，杨礼楷 发起')
  assert.equal(describeEvent(event({ to: 'queued', from: 'failed', note: '租约过期', actor: 'station' })), '重新排队：《好一个乖乖女》（租约过期）')
  assert.equal(describeEvent(event({ to: 'downloading', from: 'queued', actor: 'muse-hit-cloud-a', note: '第 1 次领取' })), '开始处理：《好一个乖乖女》，muse-hit-cloud-a（第 1 次领取）')
  assert.equal(describeEvent(event({ to: 'published', note: '剧本 s1' })), '已发布剧本：《好一个乖乖女》（剧本 s1）')
  assert.equal(describeEvent(event({ to: 'failed', note: null })), '失败待重试：《好一个乖乖女》')
  assert.equal(describeEvent(event({ to: 'needs-attention', note: '第 40 集三轮未过' })), '需要处理：《好一个乖乖女》（第 40 集三轮未过）')
  assert.equal(describeEvent(event({ to: 'rejected', note: '低龄向' })), '已淘汰：《好一个乖乖女》（低龄向）')
  assert.equal(describeEvent(event({ to: 'withdrawn', note: '下架' })), '撤出储备：《好一个乖乖女》（下架）')
  assert.equal(describeEvent(event({ from: 'transcribing', to: 'checking', note: null })), '《好一个乖乖女》：transcribing → checking')
  assert.equal(describeEvent(event({ from: null, to: 'odd', note: null })), '《好一个乖乖女》：— → odd')
  assert.equal(describeDelivery([event({})]).split('\n').length, 2)
})

test('the secret file must be private and long enough, and signatures compare exactly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-secret-'))
  try {
    const file = join(directory, 'secret')
    writeFileSync(file, `${SECRET}\n`); chmodSync(file, 0o600)
    assert.equal(readStationSecret(file), SECRET)
    chmodSync(file, 0o640)
    assert.throws(() => readStationSecret(file), /private regular file/)
    writeFileSync(file, 'short'); chmodSync(file, 0o600)
    assert.throws(() => readStationSecret(file), /too short/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
  assert.equal(verifySignature(SECRET, '1', 'b', sign('1', 'b')), true)
  assert.equal(verifySignature(SECRET, '1', 'b', undefined), false)
})
