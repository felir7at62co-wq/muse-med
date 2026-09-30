import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { WebSocketServer } from '../toolchain/node_modules/ws/wrapper.mjs'

const compatibility = join(import.meta.dirname, 'bridge-desktop.mjs')

async function fixture(t, serve, options = {}) {
  let tunnel
  assert.ok(existsSync(compatibility), 'the audited upstream adaptation is required')
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(compatibility).href)
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-transport-'))
  t.after(() => { unlinkSync(join(root, 'node_modules')); rmSync(root, { recursive: true, force: true }) })
  cpSync(join(import.meta.dirname, '../dsh-bridge'), root, { recursive: true })
  applyBridgeDesktopCompatibility(root)
  symlinkSync(join(import.meta.dirname, '../toolchain/node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const { createMuseDesktopTunnel } = await import(pathToFileURL(join(root, 'lib/muse-desktop-tunnel.mjs')).href)
  const local = createServer(serve)
  local.listen(0, '127.0.0.1')
  await once(local, 'listening')
  t.after(async () => { await tunnel?.stop(); local.closeAllConnections(); await new Promise(resolve => local.close(resolve)) })
  const relay = createServer()
  const wss = new WebSocketServer({ server: relay })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => relay.close(resolve)) })
  const connected = once(wss, 'connection')
  tunnel = createMuseDesktopTunnel({
    serverUrl: `ws://127.0.0.1:${relay.address().port}/api/desktop/connect`,
    headers: { cookie: 'muse_session=synthetic-session' }, localPort: local.address().port,
    loopbackCookie: 'host-session=synthetic-host', deviceId: 'synthetic-device',
    chunkBytes: 32768, ackTimeoutMs: 5000,
    reconnectMaxIntervalMs: 20,
    ...options,
  })
  t.after(() => tunnel.stop())
  const start = tunnel.start()
  const [control, request] = await connected
  assert.equal(request.headers.cookie, 'muse_session=synthetic-session')
  const messages = []
  const waiters = []
  control.on('message', bytes => {
    const msg = JSON.parse(bytes.toString())
    messages.push(msg)
    for (const waiter of [...waiters]) {
      if (waiter.match(msg)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(msg) }
    }
  })
  const next = match => {
    const existing = messages.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('control message not received')), 10000)
      waiters.push({ match, resolve: msg => { clearTimeout(timer); resolve(msg) } })
    })
  }
  assert.deepEqual(await next(msg => msg.type === 'connect'), { type: 'connect', version: 1, deviceId: 'synthetic-device' })
  control.send(JSON.stringify({ type: 'ready', publicUrl: 'https://muse.invalid' }))
  await start
  const send = message => control.send(JSON.stringify(message))
  return { tunnel, control, local, wss, messages, next, send }
}

test('streams binary uploads and range responses with per-chunk acknowledgements', async t => {
  const upload = Buffer.alloc(90000, 123)
  const media = Buffer.alloc(100000, 221)
  let cookie
  const f = await fixture(t, (req, res) => {
    cookie = req.headers.cookie
    const received = []
    req.on('data', chunk => received.push(chunk))
    req.on('end', () => {
      assert.deepEqual(Buffer.concat(received), upload)
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-99999/200000', 'content-length': media.length })
      res.end(media)
    })
  })
  f.send({ type: 'request-start', id: 'upload', method: 'POST', url: '/api/attachment/upload', headers: { cookie: 'muse_session=never-forward', range: 'bytes=0-99999', 'content-length': upload.length } })
  for (let offset = 0, seq = 0; offset < upload.length; offset += 32768, seq++) {
    f.send({ type: 'request-chunk', id: 'upload', seq, data: upload.subarray(offset, offset + 32768).toString('base64') })
    await f.next(msg => msg.type === 'request-ack' && msg.seq === seq)
  }
  f.send({ type: 'request-end', id: 'upload' })
  const start = await f.next(msg => msg.type === 'response-start')
  assert.equal(start.status, 206)
  assert.equal(start.headers['content-range'], 'bytes 0-99999/200000')
  assert.equal(cookie, 'host-session=synthetic-host')
  const received = []
  for (let seq = 0, length = 0; length < media.length; seq++) {
    const chunk = await f.next(msg => msg.type === 'response-chunk' && msg.seq === seq)
    const bytes = Buffer.from(chunk.data, 'base64')
    assert.ok(bytes.length <= 32768)
    received.push(bytes)
    length += bytes.length
    assert.equal(f.messages.some(msg => msg.type === 'response-chunk' && msg.seq > seq), false)
    f.send({ type: 'response-ack', id: 'upload', seq })
  }
  await f.next(msg => msg.type === 'response-end')
  assert.deepEqual(Buffer.concat(received), media)
})

test('cancels an open Host request and stops to socket quiescence', async t => {
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: active\n\n')
    res.on('close', resolveClosed)
  })
  f.send({ type: 'request-start', id: 'cancel', method: 'GET', url: '/api/remote.events', headers: {} })
  f.send({ type: 'request-end', id: 'cancel' })
  await f.next(msg => msg.type === 'response-chunk')
  f.send({ type: 'request-cancel', id: 'cancel' })
  await closed
  const controlClosed = once(f.control, 'close')
  await f.tunnel.stop()
  await controlClosed
})

test('preserves the native remote.mux WebSocket handshake and binary frames', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(404); res.end() })
  const localWs = new WebSocketServer({ noServer: true })
  t.after(() => new Promise(resolve => localWs.close(resolve)))
  const echo = Buffer.alloc(70000, 81)
  let hostCookie
  f.local.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/api/remote.mux')
    hostCookie = req.headers.cookie
    localWs.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => ws.send(data))
      ws.send(echo)
    })
  })
  f.send({ type: 'ws-open', wsId: 'mux', path: '/api/remote.mux', headers: {
    connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', cookie: 'muse_session=never-forward',
  } })
  const accepted = await f.next(msg => msg.type === 'ws-accept')
  assert.equal(accepted.statusCode, 101)
  assert.equal(hostCookie, 'host-session=synthetic-host')
  const raw = []
  for (let seq = 0, length = 0; length < echo.length + 10; seq++) {
    const chunk = await f.next(msg => msg.type === 'ws-frame' && msg.seq === seq)
    const bytes = Buffer.from(chunk.data, 'base64')
    assert.ok(bytes.length <= 32768)
    length += bytes.length
    raw.push(bytes)
    assert.equal(f.messages.some(msg => msg.type === 'ws-frame' && msg.seq > seq), false)
    f.send({ type: 'ws-ack', wsId: 'mux', seq })
  }
  const frame = Buffer.concat(raw)
  assert.equal(frame[0], 0x82)
  assert.equal(frame[1], 127)
  assert.equal(Number(frame.readBigUInt64BE(2)), echo.length)
  assert.deepEqual(frame.subarray(10), echo)
  const masked = Buffer.from([0x81, 0x83, 1, 2, 3, 4, 65 ^ 1, 66 ^ 2, 67 ^ 3])
  f.send({ type: 'ws-frame', wsId: 'mux', seq: 0, data: masked.toString('base64') })
  await f.next(msg => msg.type === 'ws-ack' && msg.seq === 0)
  const reply = await f.next(msg => msg.type === 'ws-frame' && msg.seq === raw.length)
  assert.deepEqual(Buffer.from(reply.data, 'base64').subarray(2), Buffer.from('ABC'))
  f.send({ type: 'ws-ack', wsId: 'mux', seq: reply.seq })
  f.send({ type: 'ws-close', wsId: 'mux' })
  await f.next(msg => msg.type === 'ws-close')
})

test('forwards an incomplete native frame before its remaining bytes arrive', async t => {
  const f = await fixture(t, (_req, res) => { res.end() })
  let localSocket
  t.after(() => localSocket?.destroy())
  f.local.on('upgrade', (req, socket) => {
    localSocket = socket
    socket.on('end', () => socket.destroy())
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    const header = Buffer.alloc(10); header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(90000n, 2)
    socket.write(Buffer.concat([header, Buffer.alloc(20, 65)]))
  })
  f.send({ type: 'ws-open', wsId: 'fragment', path: '/api/remote.mux', headers: {
    connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
  } })
  await f.next(msg => msg.type === 'ws-accept')
  const first = await f.next(msg => msg.type === 'ws-frame' && msg.wsId === 'fragment')
  const receivedBytes = Buffer.from(first.data, 'base64').length
  assert.ok(receivedBytes > 0 && receivedBytes <= 30)
  f.send({ type: 'ws-ack', wsId: 'fragment', seq: first.seq })
  f.send({ type: 'ws-close', wsId: 'fragment' })
  await f.next(msg => msg.type === 'ws-close' && msg.wsId === 'fragment')
})

test('stops reconnection when the Muse account or device is rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'muse-bridge-rejection-'))
  cpSync(join(import.meta.dirname, '../dsh-bridge'), root, { recursive: true })
  const { applyBridgeDesktopCompatibility } = await import(pathToFileURL(compatibility).href)
  applyBridgeDesktopCompatibility(root)
  symlinkSync(join(import.meta.dirname, '../toolchain/node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => { unlinkSync(join(root, 'node_modules')); rmSync(root, { recursive: true, force: true }) })
  const { createMuseDesktopTunnel } = await import(pathToFileURL(join(root, 'lib/muse-desktop-tunnel.mjs')).href)
  const relay = createServer()
  const wss = new WebSocketServer({ server: relay })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  let tunnel
  t.after(async () => { await tunnel?.stop(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => relay.close(resolve)) })
  wss.on('connection', ws => ws.once('message', () => { ws.send(JSON.stringify({ type: 'rejected', reason: 'device-conflict' })); ws.close(1008, 'Device conflict') }))
  const states = []
  tunnel = createMuseDesktopTunnel({ serverUrl: `ws://127.0.0.1:${relay.address().port}/api/desktop/connect`, headers: { cookie: 'muse_session=synthetic-session' }, localPort: 1, loopbackCookie: 'host-session=synthetic-host', deviceId: 'synthetic-device', chunkBytes: 32768, ackTimeoutMs: 5000, reconnectMaxIntervalMs: 20, onState: state => states.push(state) })
  await assert.rejects(tunnel.start())
  assert.deepEqual(states, ['connecting', 'rejected'])
})

test('cancels the response ACK when the control send fails', async t => {
  const f = await fixture(t, (_req, res) => res.end(Buffer.alloc(40000, 1)))
  const failed = Promise.withResolvers()
  const send = f.tunnel._send.bind(f.tunnel)
  f.tunnel._send = message => {
    if (message.type !== 'response-chunk') return send(message)
    failed.resolve()
    return Promise.reject(new Error('synthetic disconnected control'))
  }
  f.send({ type: 'request-start', id: 'failed-send', method: 'GET', url: '/video', headers: {} })
  f.send({ type: 'request-end', id: 'failed-send' })
  await failed.promise
  await f.tunnel.stop()
  assert.equal(f.tunnel.requests.size, 0)
})

test('cancels the native WebSocket ACK when the control send fails', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(404).end())
  const host = new WebSocketServer({ server: f.local })
  t.after(() => new Promise(resolve => host.close(resolve)))
  host.on('connection', ws => ws.send(Buffer.alloc(70000, 2)))
  const failed = Promise.withResolvers()
  const send = f.tunnel._send.bind(f.tunnel)
  f.tunnel._send = message => {
    if (message.type !== 'ws-frame') return send(message)
    failed.resolve()
    return Promise.reject(new Error('synthetic disconnected control'))
  }
  f.send({ type: 'ws-open', wsId: 'failed-ws', path: '/api/remote.mux', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'MDEyMzQ1Njc4OWFiY2RlZg==', 'sec-websocket-version': '13' } })
  await failed.promise
  await f.tunnel.stop()
  assert.equal(f.tunnel.wsAcks.size, 0)
})

test('recovers after more than five rejected control transports', { timeout: 5000 }, async t => {
  const states = []
  const f = await fixture(t, (_req, res) => res.end(), { reconnectMaxIntervalMs: 1, onState: state => states.push(state) })
  const recovered = Promise.withResolvers()
  let attempts = 0
  f.wss.on('connection', ws => {
    attempts++
    ws.once('message', () => {
      if (attempts <= 6) ws.close(1011, 'synthetic transport outage')
      else { ws.send(JSON.stringify({ type: 'ready' })); recovered.resolve() }
    })
  })
  f.control.close(1011, 'synthetic transport outage')
  await recovered.promise
  assert.equal(attempts, 7)
  assert.equal(states.includes('rejected'), false)
  await f.tunnel.stop()
  assert.equal(f.tunnel.reconnectTimer, null)
})

test('reports an aborted Host response without closing the control connection', async t => {
  let response
  const f = await fixture(t, (_req, res) => {
    response = res
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
  })
  f.send({ type: 'request-start', id: 'aborted-response', method: 'GET', url: '/api/remote.events', headers: {} })
  f.send({ type: 'request-end', id: 'aborted-response' })
  const chunk = await f.next(msg => msg.type === 'response-chunk' && msg.id === 'aborted-response')
  f.send({ type: 'response-ack', id: 'aborted-response', seq: chunk.seq })
  const failed = f.next(msg => msg.type === 'response-error' && msg.id === 'aborted-response')
  response.destroy()
  assert.deepEqual(await failed, { type: 'response-error', id: 'aborted-response', error: 'host-unavailable' })
  assert.equal(f.control.readyState, f.control.OPEN)
})
