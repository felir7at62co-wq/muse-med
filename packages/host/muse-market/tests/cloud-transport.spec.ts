/** Real HTTP requests, origin-bound credentials and verified disabled imports. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { writeMuseSession } from '../../muse-account/src/session.ts'
import MuseMarket from '../src/index.ts'
import MuseMarketCloud from '../src/cloud.ts'
import type { MuseMarketCloudConfig } from '../src/cloud.ts'
import type { MarketReleaseId } from '../src/types.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { parseMarketPublication, parseMarketPublisherId, parseMarketUploadRequestId } from '../src/cloud-protocol.ts'
import { bundle, limits, manifest, metadata, resources } from './fixtures.ts'

type Route = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
const publisher = parseMarketPublisherId('b'.repeat(32))
const key = parseMarketUploadRequestId('retained-upload-key')
const archive = Buffer.from(createMarketPackage(manifest, resources, limits))
const publication = parseMarketPublication({ id: 'a'.repeat(32), publisherId: publisher, publisher: 'Writing team',
  manifest, sha256: marketDigest(archive), bytes: archive.byteLength, status: 'published', reviewNote: '', revision: 1,
  createdAt: '2026-11-09T00:00:00.000Z' }, limits)
const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected HTTP bytes')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function fixture(extra: Partial<MuseMarketCloudConfig> = {}) {
  const source = await bundle(), ctx = new Context()
  let route: Route = (_req, res) => { json(res, { items: [publication] }) }
  const requests: { path: string; cookie?: string; origin?: string; method?: string }[] = []
  const errors: Error[] = []
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
      ...(req.headers.origin === undefined ? {} : { origin: req.headers.origin }),
      ...(req.method === undefined ? {} : { method: req.method }) })
    Promise.resolve(route(req, res)).catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error('Unexpected server failure')); res.destroy()
    })
  })
  let closeCloud: () => Promise<void> = async () => {}
  onTestFinished(async () => {
    try { await closeCloud(); await ctx.fiber.dispose() }
    finally {
      server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await source.cleanup()
    }
    expect(errors).toEqual([])
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback TCP address')
  const origin = `http://127.0.0.1:${address.port}`, sessionFile = join(source.root, 'session.json')
  await ctx.plugin(Skills).await(); ctx.skills.register(source.skill)
  await ctx.plugin(MuseMarket, { root: join(source.root, 'market'), ...limits }).await()
  const config = { baseUrl: origin, sessionFile, requestTimeoutMs: 2000, jsonRequestBytes: 16384,
    jsonResponseBytes: 1024 * 1024, catalogLimit: 100, ...extra }
  const cloudFiber = ctx.plugin(MuseMarketCloud, config)
  closeCloud = () => cloudFiber.dispose(); await cloudFiber.await()
  const cloud = ctx.get('museMarketCloud')
  if (cloud === undefined) throw new Error('Cloud service did not load')
  return { ...source, ctx, cloud, requests, origin, config, server,
    route: (next: Route) => { route = next }, close: () => closeCloud(),
    login: (username = 'author', baseUrl = origin) => writeMuseSession(sessionFile,
      { baseUrl, cookie: `__Host-muse=${username}`, username }),
  }
}

it('uses the configured origin and exact account file while preserving complete catalog metadata', async () => {
  const f = await fixture(); await f.login()
  expect(await f.cloud.catalog('fixture-skill 场景', false)).toEqual([publication])
  expect(f.requests).toEqual([{ path: '/api/market/v1/catalog?q=fixture-skill+%E5%9C%BA%E6%99%AF&mine=false',
    cookie: '__Host-muse=author', origin: f.origin, method: 'GET' }])
  f.route((_req, res) => { json(res, { accountId: 'd'.repeat(16), publishers: [{ id: publisher, title: 'Writing team' }], admin: false }) })
  expect(await f.cloud.identity()).toEqual({ accountId: 'd'.repeat(16), publishers: [{ id: publisher, title: 'Writing team' }], admin: false })
})

it('treats another origin account as anonymous and refuses authenticated operations before HTTP', async () => {
  const f = await fixture(); await f.login('author', 'https://other.example')
  await f.cloud.catalog('', false)
  expect(f.requests[0]).not.toHaveProperty('cookie')
  await expect(f.cloud.catalog('', true)).rejects.toMatchObject({ details: { code: 'login-required', status: 401 } })
  await expect(f.cloud.identity()).rejects.toMatchObject({ details: { code: 'login-required', status: 401 } })
  expect(f.requests).toHaveLength(1)
})

it('refuses a redirect without delivering an account cookie to its destination', async () => {
  const destination = await fixture(), f = await fixture(); await f.login()
  f.route((_req, res) => { res.writeHead(302, { location: destination.origin + '/api/market/v1/catalog' }); res.end() })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'redirect-refused', status: 302 } })
  expect(destination.requests).toEqual([])
})

it.each(['length', 'stream', 'items'] as const)('refuses an oversized %s catalog instead of truncating it', async (mode) => {
  const f = await fixture({ jsonResponseBytes: mode === 'items' ? 16384 : 1024, catalogLimit: 1 })
  f.route((_req, res) => {
    if (mode === 'items') { json(res, { items: [publication, publication] }); return }
    res.writeHead(200, { 'content-type': 'application/json', ...(mode === 'length' ? { 'content-length': '1025' } : {}) })
    res.end(' '.repeat(1025))
  })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: mode === 'items' ? 'invalid-response' : 'response-too-large' } })
})

it('validates get metadata, downloads original ZIP bytes and imports without registering a Skill', async () => {
  const f = await fixture(); await f.login()
  const before = await f.ctx.skills.list()
  f.route((req, res) => {
    if (req.url?.endsWith('/download')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength), 'x-content-sha256': publication.sha256 })
      res.end(archive)
    } else json(res, publication)
  })
  expect(await f.cloud.getPublication(publication.id)).toEqual(publication)
  const installed = await f.cloud.installPublication(publication.id, publication.sha256)
  expect(installed).toEqual({ publication, installation: { release: { id: publication.sha256, sha256: publication.sha256,
    bytes: publication.bytes, manifest }, enabled: false } })
  expect(await f.ctx.museMarket.installed()).toEqual([installed.installation])
  expect(await f.ctx.skills.list()).toEqual(before)
  expect(f.ctx.get('museMarketActivation')).toBeUndefined()
})

it.each(['selection', 'headers', 'bytes', 'manifest'] as const)('refuses changed %s before a local installation', async (mode) => {
  const f = await fixture(); await f.login()
  f.route((req, res) => {
    if (req.url?.endsWith('/download')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength),
        'x-content-sha256': mode === 'headers' ? 'c'.repeat(64) : publication.sha256 })
      const bytes = Buffer.from(archive); if (mode === 'bytes') bytes[0] = 0
      res.end(bytes)
    } else json(res, mode === 'manifest' ? { ...publication, manifest: { ...manifest, title: 'Changed title' } } : publication)
  })
  await expect(f.cloud.installPublication(publication.id, mode === 'selection' ? 'c'.repeat(64) : publication.sha256)).rejects.toMatchObject({
    code: 'muse-market/cloud-failed', details: { code: mode === 'selection' ? 'catalog-changed' : mode === 'headers' ? 'invalid-response'
      : 'archive-mismatch' },
  })
  expect(await f.ctx.museMarket.installed()).toEqual([])
  if (mode === 'selection') expect(f.requests).toHaveLength(1)
})

it('uploads the retained local archive with its original key and never submits implicitly', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name), draft = { ...publication, status: 'draft' }
  f.route(async (req, res) => {
    expect(req.url).toBe('/api/market/v1/uploads'); expect(req.headers['idempotency-key']).toBe(key)
    expect(req.headers['x-market-publisher']).toBe(publisher); expect(req.headers['content-type']).toBe('application/zip')
    expect(await body(req)).toEqual(archive); json(res, draft, 201)
  })
  expect(await f.cloud.publishDraft(prepared.release.id, publisher, key)).toEqual(draft)
  expect(f.requests).toHaveLength(1)
})

it('retains the original upload key after a lost reply and preserves local structured storage failures', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  f.route(async (req, _res) => { await body(req); req.socket.destroy() })
  await expect(f.cloud.publishDraft(prepared.release.id, publisher, key)).rejects.toMatchObject({ details: {
    code: 'publication-unconfirmed', status: 503, requestId: key,
  } })
  await f.ctx.museMarket.removePackage(prepared.release.id)
  await expect(f.cloud.publishDraft(prepared.release.id, publisher, key)).rejects.toMatchObject({
    code: 'muse-market/operation-failed', details: { code: 'not-installed' },
  })
  expect(f.requests).toHaveLength(1)
})

it.each(['metadata', 'account'] as const)('retains the original upload key after a changed %s reply', async (mode) => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  f.route(async (req, res) => {
    await body(req)
    if (mode === 'account') await f.login('replacement')
    json(res, mode === 'metadata' ? { ...publication, sha256: 'c'.repeat(64) } : publication)
  })
  await expect(f.cloud.publishDraft(prepared.release.id, publisher, key)).rejects.toMatchObject({ details: {
    code: mode === 'account' ? 'account-changed' : 'publication-unconfirmed', requestId: key,
  } })
  expect(f.requests).toHaveLength(1)
})

it('reconciles the original review after a lost response without submitting a newer revision', async () => {
  const f = await fixture(); await f.login()
  const pending = { ...publication, status: 'pending', revision: 2 }
  f.route(async (req, res) => {
    if (req.method === 'POST') { expect(JSON.parse((await body(req)).toString())).toEqual({ revision: 1, action: 'submit', note: '' }); req.socket.destroy() }
    else json(res, pending)
  })
  expect(await f.cloud.review(publication.id, 1, 'submit', '')).toEqual(pending)
  expect(f.requests.map(row => [row.method, row.path])).toEqual([
    ['POST', `/api/market/v1/releases/${publication.id}/review`], ['GET', `/api/market/v1/releases/${publication.id}`],
  ])
})

it('keeps the inspected revision and full observed record when another review wins', async () => {
  const f = await fixture(); await f.login()
  const observed = { ...publication, status: 'rejected', revision: 3, reviewNote: 'Revise the scene.' }
  f.route((req, res) => { json(res, req.method === 'POST' ? { error: '__Host-muse=private-cookie' } : observed, req.method === 'POST' ? 409 : 200) })
  await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ message: 'Skill cloud operation failed', details: {
    code: 'cloud-conflict', status: 409, publicationId: publication.id, reviewedRevision: 1, observed,
  } })
  expect(f.requests.map(row => row.method)).toEqual(['POST', 'GET'])
})

it('refuses an over-budget JSON request before HTTP and does not expose an upstream error body', async () => {
  const f = await fixture({ jsonRequestBytes: 1024 }); await f.login()
  await expect(f.cloud.review(publication.id, 1, 'reject', 'x'.repeat(1100))).rejects.toMatchObject({ details: { code: 'request-too-large', status: 413 } })
  expect(f.requests).toEqual([])
  f.route((_req, res) => { json(res, { error: '__Host-muse=private-cookie' }, 403) })
  try { await f.cloud.identity(); throw new Error('Expected refusal') }
  catch (error) {
    expect(error).toMatchObject({ details: { code: 'permission-denied', status: 403 } })
    expect(JSON.stringify(error)).not.toContain('private-cookie')
  }
})

it('rejects a reply admitted under an account file replaced before its body completes', async () => {
  const f = await fixture(); await f.login()
  f.route(async (_req, res) => { await f.login('replacement'); json(res, { items: [publication] }) })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'account-changed', status: 409 } })
})

it('aborts and joins an owned response reader on unload and rejects later calls', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>()
  f.route((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"items":'); entered.resolve(undefined) })
  const result = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise; await f.close()
  expect(await result).toMatchObject({ error: { details: { code: 'closing', status: 503 } } })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'closing' } })
})

it('times out the complete response body without waiting for the server to finish it', async () => {
  const f = await fixture({ requestTimeoutMs: 100 })
  f.route((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"items":') })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'cloud-timeout', status: 503 } })
})

it('requires an absolute session file before acquiring its transport', async () => {
  await expect(fixture({ sessionFile: 'relative' })).rejects.toMatchObject({ code: 'invalid-session-file' })
})

it.each([401, 403, 404, 409, 413, 429, 500] as const)('maps HTTP %s without reading private upstream error details', async (status) => {
  const f = await fixture()
  const codes = { 401: 'login-required', 403: 'permission-denied', 404: 'not-found', 409: 'cloud-conflict',
    413: 'response-too-large', 429: 'rate-limited', 500: 'cloud-unavailable' }
  f.route((_req, res) => { json(res, { private: 'must stay upstream' }, status) })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: codes[status], status } })
})

it.each(['invalid-json', 'wrong-type', 'no-type', 'empty-body', 'private-record', 'wrong-id'] as const)('rejects malformed or mismatched %s wire replies', async (mode) => {
  const f = await fixture()
  f.route((_req, res) => {
    if (mode === 'private-record') { json(res, { items: [{ ...publication, status: 'draft' }] }); return }
    if (mode === 'wrong-id') { json(res, { ...publication, id: 'c'.repeat(32) }); return }
    res.writeHead(mode === 'empty-body' ? 204 : 200,
      mode === 'no-type' ? {} : { 'content-type': mode === 'wrong-type' ? 'text/plain' : 'application/json' })
    res.end(mode === 'invalid-json' ? '{' : '{}')
  })
  await expect(mode === 'wrong-id' ? f.cloud.getPublication(publication.id) : f.cloud.catalog('', false))
    .rejects.toMatchObject({ details: { code: 'invalid-response', status: 502 } })
})

it('refuses invalid query, digest and review choices before any HTTP request', async () => {
  const f = await fixture(); await f.login()
  await expect(f.cloud.catalog('x'.repeat(201), false)).rejects.toMatchObject({ details: { code: 'invalid-query' } })
  await expect(f.cloud.installPublication(publication.id, 'bad')).rejects.toMatchObject({ details: { code: 'invalid-digest' } })
  await expect(f.cloud.review(publication.id, 0, 'submit', '')).rejects.toMatchObject({ details: { code: 'invalid-review' } })
  await expect(f.cloud.review(publication.id, 1, 'reject', '')).rejects.toMatchObject({ details: { code: 'invalid-review' } })
  await expect(f.cloud.publishDraft('bad' as MarketReleaseId, publisher, key)).rejects.toMatchObject({ details: { code: 'invalid-local-release' } })
  expect(f.requests).toEqual([])
})

it.each(['initial', 'after-reply'] as const)('refuses an unreadable account session %s', async (phase) => {
  const f = await fixture(); await f.login()
  if (phase === 'initial') await writeFile(f.config.sessionFile, '{')
  else f.route(async (_req, res) => { await writeFile(f.config.sessionFile, '{'); json(res, { items: [] }) })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'account-unavailable', status: 503 } })
})

it('contains an HTTP-incompatible cookie from the durable account file', async () => {
  const f = await fixture(); await f.login('中文')
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'cloud-unavailable', status: 503 } })
  expect(f.requests).toEqual([])
})

it.each(['close', 'timeout'] as const)('settles a request whose headers never arrive on %s', async (mode) => {
  const f = await fixture({ requestTimeoutMs: mode === 'timeout' ? 100 : 2000 }), entered = Promise.withResolvers<undefined>()
  f.route(() => { entered.resolve(undefined) })
  const result = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  if (mode === 'close') await f.close()
  expect(await result).toMatchObject({ error: { details: { code: mode === 'close' ? 'closing' : 'cloud-timeout', status: 503 } } })
})

it('refuses a response stream that disconnects after admitting its JSON header', async () => {
  const f = await fixture()
  f.route((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
    res.write('{', () => { res.destroy() })
  })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'cloud-unavailable' } })
})

it('maps malformed downloaded archive bytes to the package parser failure', async () => {
  const f = await fixture(); await f.login()
  f.route((req, res) => {
    if (!req.url?.endsWith('/download')) { json(res, publication); return }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength), 'x-content-sha256': publication.sha256 })
    res.end(Buffer.alloc(archive.byteLength))
  })
  await expect(f.cloud.installPublication(publication.id, publication.sha256)).rejects.toMatchObject({ details: { code: 'invalid-archive', status: 400 } })
  expect(await f.ctx.museMarket.installed()).toEqual([])
})

it('aborts an admitted response reader before completing its partial JSON body', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), original = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await original(...args)
    if (typeof args[0] === 'string' && args[0].startsWith(f.origin) && response.body !== null) {
      const reader = response.body.getReader(), read = reader.read.bind(reader)
      let calls = 0
      vi.spyOn(reader, 'read').mockImplementation((...input) => {
        if (++calls === 2) entered.resolve(undefined)
        return read(...input)
      })
      vi.spyOn(response.body, 'getReader').mockReturnValue(reader)
    }
    return response
  })
  f.route((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{') })
  const result = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise; await f.close()
    expect(await result).toMatchObject({ error: { details: { code: 'closing', status: 503 } } })
  } finally { await f.close(); await result; fetch.mockRestore() }
})

it('keeps an admitted upload owned through account transport shutdown before HTTP', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = f.ctx.museMarket.exportPackage.bind(f.ctx.museMarket)
  const capture = vi.spyOn(f.ctx.museMarket, 'exportPackage').mockImplementation(async (...args) => {
    const result = await original(...args); entered.resolve(undefined); await release.promise; return result
  })
  const outcome = f.cloud.publishDraft(prepared.release.id, publisher, key).then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    const closed = f.close(); release.resolve(undefined); await closed
    expect(await outcome).toMatchObject({ error: { details: { code: 'publication-unconfirmed', requestId: key } } })
    expect(f.requests).toEqual([])
  } finally { release.resolve(undefined); await outcome; capture.mockRestore() }
})

it('propagates a definite upload rejection without manufacturing an uncertain write', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  f.route(async (req, res) => { await body(req); json(res, {}, 403) })
  await expect(f.cloud.publishDraft(prepared.release.id, publisher, key)).rejects.toMatchObject({ details: { code: 'permission-denied', status: 403 } })
})

it.each(['approve', 'reject', 'withdraw'] as const)('confirms an exact %s transition without a reconciliation read', async (action) => {
  const f = await fixture(); await f.login()
  const value = { ...publication, revision: 2, status: action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : 'withdrawn', reviewNote: 'Reviewed.' }
  f.route(async (req, res) => { await body(req); json(res, value) })
  expect(await f.cloud.review(publication.id, 1, action, 'Reviewed.')).toEqual(value)
  expect(f.requests).toHaveLength(1)
})

it.each(['bad-success', 'read-failure', 'read-wrong-id', 'newer-read', 'account-on-write', 'account-on-read', 'forbidden'] as const)(
  'preserves the original reviewed revision after %s', async (mode) => {
    const f = await fixture(); await f.login()
    f.route(async (req, res) => {
      if (req.method === 'POST') {
        await body(req)
        if (mode === 'account-on-write') await f.login('replacement')
        json(res, publication, mode === 'forbidden' ? 403 : mode === 'bad-success' || mode === 'account-on-write' ? 200 : 500)
        return
      }
      if (mode === 'account-on-read') await f.login('replacement')
      json(res, mode === 'read-wrong-id' ? { ...publication, id: 'c'.repeat(32) } : { ...publication, revision: 3 }, mode === 'read-failure' ? 503 : 200)
    })
    const code = mode.startsWith('account-') ? 'account-changed' : mode === 'forbidden' ? 'permission-denied' : 'review-unconfirmed'
    await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ details: { code,
      ...(mode === 'forbidden' ? {} : { publicationId: publication.id, reviewedRevision: 1 }) } })
    expect(f.requests.filter(row => row.method === 'POST')).toHaveLength(1)
  },
)
