/** Transport facts verified against the live site: bearer header, 401 shape, download receipt. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DramaWebClient, DramaWebError, normalizeBearer, readTokenClaims } from '../src/client.js'

/** Start a throwaway HTTP server and return its base URL plus a stop function. */
async function startStub(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}/api/v1`, stop: () => new Promise(resolve => server.close(resolve)) }
}

test('normalizeBearer strips paste artifacts but keeps the token', () => {
  assert.equal(normalizeBearer('  abc  '), 'abc')
  assert.equal(normalizeBearer('"abc"'), 'abc')
  assert.equal(normalizeBearer('abc;'), 'abc')
  assert.equal(normalizeBearer('a b'), '')
  assert.equal(normalizeBearer(undefined), '')
})

test('readTokenClaims decodes role, team and exp without verifying', () => {
  const payload = Buffer.from(JSON.stringify({ sub: '525', role: 'member', team: 'production', exp: 1795430754 })).toString('base64url')
  const claims = readTokenClaims(`header.${payload}.signature`)
  assert.equal(claims.role, 'member')
  assert.equal(claims.team, 'production')
  assert.equal(claims.exp, 1795430754)
  assert.equal(readTokenClaims('not-a-jwt'), null)
})

test('list sends the bearer token and the documented query names', async () => {
  const seen = {}
  const stub = await startStub((req, res) => {
    seen.url = req.url
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [{ id: 1584, title: '豪门小保洁' }], total: 1 }))
  })
  try {
    const client = new DramaWebClient({ baseUrl: stub.baseUrl, tokenEnv: 'TEST_DRAMA_TOKEN' })
    process.env.TEST_DRAMA_TOKEN = 'tok-123'
    const data = await client.listDramas({ keyword: '豪门', page: 1, page_size: 20, status: undefined })
    assert.equal(data.total, 1)
    assert.equal(seen.authorization, 'Bearer tok-123')
    assert.match(seen.url, /keyword=%E8%B1%AA%E9%97%A8/)
    assert.match(seen.url, /page=1/)
    assert.ok(!seen.url.includes('status='))
  }
  finally {
    await stub.stop()
  }
})

test('a rejected call keeps the upstream status and does not invent a reason', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    const client = new DramaWebClient({ baseUrl: stub.baseUrl, tokenEnv: 'TEST_DRAMA_TOKEN' })
    await assert.rejects(() => client.getDrama(1584), (error) => {
      assert.ok(error instanceof DramaWebError)
      assert.equal(error.status, 401)
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /empty body/)
      return true
    })
  }
  finally {
    await stub.stop()
  }
})

test('download resolves the signed url, writes bytes and reports the digest', async () => {
  const payload = 'episode-bytes'
  const stub = await startStub((req, res) => {
    if (req.url === '/api/v1/files/7/url?disposition=attachment') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: `http://127.0.0.1:${req.socket.localPort}/blob/7` }))
      return
    }
    if (req.url === '/blob/7') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(payload)
      return
    }
    res.writeHead(404)
    res.end()
  })
  const dir = await mkdtemp(join(tmpdir(), 'drama-web-'))
  try {
    const client = new DramaWebClient({ baseUrl: stub.baseUrl, tokenEnv: 'TEST_DRAMA_TOKEN' })
    const target = join(dir, 'nested', '07.mp4')
    const receipt = await client.download(7, target)
    assert.equal(receipt.bytes, payload.length)
    assert.equal(await readFile(target, 'utf8'), payload)
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/)
  }
  finally {
    await rm(dir, { recursive: true, force: true })
    await stub.stop()
  }
})

test('reads outside the allowlist never reach the network', async () => {
  let called = false
  const client = new DramaWebClient({ baseUrl: 'http://127.0.0.1:9/api/v1', tokenEnv: 'TEST_DRAMA_TOKEN' })
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    called = true
    throw new Error('should not be reached')
  }
  try {
    await assert.rejects(() => client.request('/admin/secret'), /outside the read allowlist/)
  }
  finally {
    globalThis.fetch = original
  }
  assert.equal(called, false)
})

test('login stores the session token and reports the forced-password flag', async () => {
  const payload = Buffer.from(JSON.stringify({ sub: '525', role: 'member', team: 'production', exp: 1795430754 })).toString('base64url')
  const stub = await startStub((req, res) => {
    if (req.url !== '/api/v1/auth/login') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: `h.${payload}.s`, must_change_password: true }))
  })
  try {
    const client = new DramaWebClient({ baseUrl: stub.baseUrl })
    const result = await client.login({ username: 'u', password: 'p' })
    assert.equal(result.mustChangePassword, true)
    assert.equal(client.token(), `h.${payload}.s`)
    assert.equal(result.claims.team, 'production')
  }
  finally {
    await stub.stop()
  }
})
