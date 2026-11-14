/** Exercise the proxy fetch implementation over owned loopback HTTP sockets. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { proxiedFetch, proxySetConfig, resetProxyForTests } from '../src/http.js'
import { parseSse } from '../src/translate/sse.js'

async function listen(server: Server): Promise<number> {
  const ready = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await ready
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return address.port
}

test('proxy fetch preserves request text, response headers, SSE bytes and HTTP errors', async t => {
  const home = await mkdtemp(join(tmpdir(), 'subscriptions-proxy-route-'))
  const previousHome = process.env.DSH_HOME
  const sockets = new Set<Duplex>()
  const servers: Server[] = []
  t.after(async () => {
    await resetProxyForTests()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve() })
    })))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  process.env.DSH_HOME = home
  await resetProxyForTests()
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('proxy requests must use undici fetch') })
  const received: string[] = []
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    received.push(body)
    if (request.url === '/limited') {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      response.end('{"error":"quota"}')
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-route': 'proxy' })
      response.end('data: 配乐\n\n')
    }
  })
  servers.push(upstream)
  const upstreamPort = await listen(upstream)
  const proxy = createServer()
  servers.push(proxy)
  proxy.on('connect', (request, socket, head) => {
    assert.equal(request.url, `127.0.0.1:${upstreamPort}`)
    const target = connect(upstreamPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) target.write(head)
      target.pipe(socket)
      socket.pipe(target)
    })
    for (const owned of [socket, target]) {
      sockets.add(owned)
      owned.on('close', () => { sockets.delete(owned) })
    }
    target.on('error', error => { socket.destroy(error) })
    socket.on('error', () => { target.destroy() })
  })
  const proxyPort = await listen(proxy)
  await proxySetConfig({ enabled: true, url: `http://127.0.0.1:${proxyPort}`, bypass: [] })
  const response = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/events`, { method: 'POST', body: 'original text' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-route'), 'proxy')
  assert.ok(response.body)
  const events = []
  for await (const event of parseSse(response.body)) events.push(event)
  assert.deepEqual(events, [{ data: '配乐' }])
  const limited = await proxiedFetch(`http://127.0.0.1:${upstreamPort}/limited`)
  assert.equal(limited.ok, false)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '3')
  assert.deepEqual(await limited.json(), { error: 'quota' })
  assert.deepEqual(received, ['original text', ''])
})
