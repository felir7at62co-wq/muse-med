/** Exercise the transport through a loopback HTTP socket without enabling HTTP in the client. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DramaWebClient, DramaWebError, normalizeBearer, readTokenClaims, secureApiRoot } from '../src/client.js'

const tokenEnv = 'TEST_DRAMA_TOKEN'
const mediaOrigin = 'https://media.example.test'

async function startStub(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const origin = 'https://127.0.0.1:' + port
  t.after(() => new Promise(resolve => server.close(resolve)))
  return {
    baseUrl: origin + '/api/v1',
    fetch: async (url, init) => {
      assert.ok(url.origin === origin || url.origin === mediaOrigin)
      assert.equal(url.protocol, 'https:')
      return await fetch('http://127.0.0.1:' + port + url.pathname + url.search, init)
    },
  }
}

function useToken(t) {
  const before = process.env[tokenEnv]
  process.env[tokenEnv] = 'offline-token'
  t.after(() => {
    if (before === undefined) delete process.env[tokenEnv]
    else process.env[tokenEnv] = before
  })
}

async function workspace(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drama-web-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { workspaceRoot: root, workspaceCwd: root }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function offlineClient(stub, config = {}) {
  return new DramaWebClient({ baseUrl: stub.baseUrl, tokenEnv, ...config }, { fetch: stub.fetch })
}

test('only a configured credential-free HTTPS API root is accepted', async t => {
  useToken(t)
  assert.equal(secureApiRoot('https://service.example.test/api/v1/'), 'https://service.example.test/api/v1')
  for (const baseUrl of [undefined, 'http://drama-web.jubianai.net/api/v1',
    'https://user@example.test/api/v1', 'https://site.example.test/api/v1?x=y',
    'https://site.example.test/api/v1#fragment', 'https://site.example.test/not-an-api']) {
    let calls = 0
    const client = new DramaWebClient({ baseUrl, tokenEnv }, { fetch: async () => {
      calls++
      throw new Error('Network reached for invalid configuration')
    } })
    await assert.rejects(() => client.me(), /approved HTTPS/)
    await assert.rejects(() => client.login({ username: 'offline-user', password: 'offline-pass' }), /approved HTTPS/)
    assert.equal(calls, 0)
  }
})

test('normalizeBearer strips paste artifacts but keeps the token', () => {
  assert.equal(normalizeBearer('  abc  '), 'abc')
  assert.equal(normalizeBearer('"abc"'), 'abc')
  assert.equal(normalizeBearer('abc;'), 'abc')
  assert.equal(normalizeBearer('a b'), '')
  assert.equal(normalizeBearer(undefined), '')
})

test('readTokenClaims decodes role, team and exp without verifying', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'synthetic', role: 'member', team: 'fixture', exp: 1795430754 })).toString('base64url')
  const claims = readTokenClaims('header.' + payload + '.signature')
  assert.equal(claims.role, 'member')
  assert.equal(claims.team, 'fixture')
  assert.equal(claims.exp, 1795430754)
  assert.equal(readTokenClaims('not-a-jwt'), null)
})

test('secure list sends a bearer token and the documented query names', async t => {
  useToken(t)
  const seen = {}
  const stub = await startStub(t, (req, res) => {
    seen.url = req.url
    seen.authorization = req.headers.authorization
    json(res, { items: [{ id: 42, title: '示例剧目' }], total: 1 })
  })
  const client = offlineClient(stub)
  const data = await client.listDramas({ keyword: '示例', page: 1, page_size: 20, status: undefined })
  assert.equal(data.total, 1)
  assert.equal(seen.authorization, 'Bearer offline-token')
  assert.match(seen.url, /keyword=%E7%A4%BA%E4%BE%8B/)
  assert.match(seen.url, /page=1/)
  assert.ok(!seen.url.includes('status='))
})

test('API refusals preserve status without exposing upstream message contents', async t => {
  useToken(t)
  const stub = await startStub(t, (_req, res) => {
    json(res, { credential: 'offline-rejected-value', signed: 'https://example.test/?test-signature=value' }, 401)
  })
  await assert.rejects(() => offlineClient(stub).getDrama(42), error => {
    assert.ok(error instanceof DramaWebError)
    assert.equal(error.status, 401)
    assert.match(error.message, /HTTP 401/)
    assert.doesNotMatch(JSON.stringify(error) + error.message, /offline-rejected-value|test-signature/)
    return true
  })
})

test('download streams a trusted HTTPS URL to a new workspace file and returns only its local receipt', async t => {
  const payload = 'episode-bytes'
  let mediaAuthorization
  useToken(t)
  const options = await workspace(t)
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/api/v1/files/7/url?disposition=attachment') {
      json(res, { url: mediaOrigin + '/blob/7?signature=offline-fixture' })
      return
    }
    mediaAuthorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  })
  const client = offlineClient(stub, { allowedMediaOrigins: [mediaOrigin] })
  options.workspaceCwd = join(options.workspaceRoot, 'session')
  await mkdir(options.workspaceCwd)
  const receipt = await client.download(7, 'nested/07.mp4', options)
  const target = join(options.workspaceCwd, 'nested', '07.mp4')
  assert.deepEqual(receipt, { path: target, bytes: payload.length, sha256: '04c3a36263ff0b676e79aca7df9f55281ae3264477a12924ab5b47d4f42f907d' })
  assert.equal(await readFile(target, 'utf8'), payload)
  assert.equal(mediaAuthorization, undefined)
  assert.deepEqual(await readdir(join(options.workspaceCwd, 'nested')), ['07.mp4'])
})

test('outside paths, junctions, and existing files fail before a download request', async t => {
  useToken(t)
  const options = await workspace(t)
  const outside = await workspace(t)
  const existing = join(options.workspaceRoot, 'existing.mp4')
  await writeFile(existing, 'keep')
  await symlink(outside.workspaceRoot, join(options.workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  let calls = 0
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async () => {
    calls++
    throw new Error('Download validation allowed a request')
  } })
  for (const path of ['../outside.mp4', 'nested/../outside.mp4', 'C:\\outside.mp4',
    join(options.workspaceRoot, 'absolute.mp4'), 'file.mp4:stream', 'linked/file.mp4', 'existing.mp4']) {
    await assert.rejects(() => client.download(7, path, options))
  }
  await assert.rejects(() => client.download(7, 'outside.mp4', { ...options, workspaceCwd: outside.workspaceCwd }), /inside the writable workspace/)
  assert.equal(calls, 0)
  assert.equal(await readFile(existing, 'utf8'), 'keep')
  assert.deepEqual(await readdir(outside.workspaceRoot), [])
})

test('untrusted HTTPS media origins fail before a second request and never expose the signed URL', async t => {
  useToken(t)
  const options = await workspace(t)
  let calls = 0
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async () => {
    calls++
    return Response.json({ data: { url: mediaOrigin + '/blob/7?signature=offline-fixture' } })
  } })
  await assert.rejects(() => client.download(7, '07.mp4', options), error => {
    assert.match(error.message, /outside the trusted HTTPS media origins/)
    assert.doesNotMatch(error.message, /offline-fixture/)
    return true
  })
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(options.workspaceRoot), [])
})

test('incomplete media leaves no published file or staging payload', async t => {
  useToken(t)
  const options = await workspace(t)
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async (url) => {
    if (url.pathname.startsWith('/api/v1/')) return Response.json({ url: url.origin + '/blob' })
    return new Response('short', { headers: { 'content-length': '20' } })
  } })
  await assert.rejects(() => client.download(7, '07.mp4', options), /length/)
  assert.deepEqual(await readdir(options.workspaceRoot), [])
})

test('concurrent downloads can publish the requested file only once', async t => {
  useToken(t)
  const options = await workspace(t)
  const apiRequests = Promise.withResolvers()
  let pending = 0
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async (url) => {
    if (url.pathname.startsWith('/api/v1/')) {
      pending++
      if (pending === 2) apiRequests.resolve()
      await apiRequests.promise
      return Response.json({ url: url.origin + '/blob' })
    }
    return new Response('fixture-file')
  } })
  const results = await Promise.allSettled([client.download(7, '07.mp4', options), client.download(7, '07.mp4', options)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const refused = results.find(result => result.status === 'rejected')
  assert.match(refused.reason.message, /destination already exists/)
  assert.equal(await readFile(join(options.workspaceRoot, '07.mp4'), 'utf8'), 'fixture-file')
  assert.deepEqual(await readdir(options.workspaceRoot), ['07.mp4'])
})

test('declared media above the byte ceiling leaves no output', async t => {
  useToken(t)
  const options = await workspace(t)
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async (url) => {
    if (url.pathname.startsWith('/api/v1/')) return Response.json({ url: url.origin + '/blob' })
    return new Response('large fixture declaration', { headers: { 'content-length': String(512 * 1024 * 1024 + 1) } })
  } })
  await assert.rejects(() => client.download(7, '07.mp4', options), /length/)
  assert.deepEqual(await readdir(options.workspaceRoot), [])
})

test('reads outside the allowlist, including normalized URLs, never reach the network', async t => {
  useToken(t)
  let called = false
  const client = new DramaWebClient({ baseUrl: 'https://service.example.test/api/v1', tokenEnv }, { fetch: async () => {
    called = true
    throw new Error('should not be reached')
  } })
  await assert.rejects(() => client.request('/admin/secret'), /outside the Drama Web read allowlist/)
  await assert.rejects(() => client.request('/dramas-other'), /outside the Drama Web read allowlist/)
  await assert.rejects(() => client.request('/dramas/../admin/secret'), /Invalid Drama Web API path/)
  assert.equal(called, false)
})

test('secure login stores a session token and reports the forced-password flag', async t => {
  const payload = Buffer.from(JSON.stringify({ sub: 'synthetic', role: 'member', team: 'fixture', exp: 1795430754 })).toString('base64url')
  const fixtureBearer = 'h.' + payload + '.s'
  const stub = await startStub(t, (req, res) => {
    if (req.url !== '/api/v1/auth/login') {
      res.writeHead(404)
      res.end()
      return
    }
    json(res, { access_token: fixtureBearer, must_change_password: true })
  })
  const client = offlineClient(stub)
  const result = await client.login({ username: 'offline-user', password: 'offline-pass' })
  assert.equal(result.mustChangePassword, true)
  assert.equal(client.token(), fixtureBearer)
  assert.equal(result.claims.team, 'fixture')
})
