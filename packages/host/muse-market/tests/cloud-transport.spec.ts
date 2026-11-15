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
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { MarketError } from '../src/format.ts'
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

it('encodes untrusted search controls inside the catalog query without admitting a raw path', async () => {
  const f = await fixture()
  expect(await f.cloud.catalog('line\\break\r\n#../场景', false)).toEqual([publication])
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]?.path).toBe('/api/market/v1/catalog?q=line%5Cbreak%0D%0A%23..%2F%E5%9C%BA%E6%99%AF&mine=false')
})

it('times out an actual HTTP request before response headers arrive', async () => {
  const f = await fixture({ requestTimeoutMs: 100 })
  f.route(() => {})
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'cloud-timeout', status: 503 } })
  expect(f.requests).toHaveLength(1)
})

it('contains a peer disconnect before response headers as unavailable cloud transport', async () => {
  const f = await fixture()
  f.route((_request, response) => { response.destroy() })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'cloud-unavailable', status: 503 } })
  expect(f.requests).toHaveLength(1)
})

it('aborts and joins a real HTTP request that has not received response headers', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>()
  f.route(() => { entered.resolve(undefined) })
  const active = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  await f.close()
  expect(await active).toMatchObject({ error: { details: { code: 'closing', status: 503 } } })
  expect(f.requests).toHaveLength(1)
})

it('unit: refuses different verified ZIP bytes returned by the publication provider', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  const replacement = createMarketPackage({ ...manifest, version: '2.0.0' }, resources, limits)
  const exported = vi.spyOn(f.ctx.museMarket, 'exportPackage').mockResolvedValueOnce({
    name: 'replacement.zip', base64: Buffer.from(replacement).toString('base64'),
  })
  onTestFinished(() => { exported.mockRestore() })
  try {
    await expect(f.cloud.publishDraft(prepared.release.id, publisher, key))
      .rejects.toMatchObject({ details: { code: 'digest-mismatch', status: 409 } })
    expect(exported).toHaveBeenCalledExactlyOnceWith(prepared.release.id)
    expect(f.requests).toEqual([])
    expect(await f.ctx.museMarket.installed()).toEqual([prepared])
  } finally { exported.mockRestore() }
})

it.each([
  { error: new MarketError('invalid-archive'), code: 'invalid-archive', status: 400 },
  { error: new Error('private-provider-diagnostic'), code: 'cloud-unavailable', status: 503 },
])('unit: contains a publication provider rejection as $code before HTTP', async ({ error, code, status }) => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  const exported = vi.spyOn(f.ctx.museMarket, 'exportPackage').mockRejectedValueOnce(error)
  onTestFinished(() => { exported.mockRestore() })
  try {
    const result = await f.cloud.publishDraft(prepared.release.id, publisher, key)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    expect(result).toMatchObject({ error: { message: 'Skill cloud operation failed', details: { code, status } } })
    expect(JSON.stringify(result)).not.toContain('private-provider-diagnostic')
    expect(exported).toHaveBeenCalledExactlyOnceWith(prepared.release.id)
    expect(f.requests).toEqual([])
    expect(await f.ctx.museMarket.installed()).toEqual([prepared])
  } finally { exported.mockRestore() }
})

it('aborts an admitted account read before any HTTP starts and joins the original request', async () => {
  const f = await fixture()
  const active = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
  await f.close()
  expect(await active).toMatchObject({ error: { details: { code: 'closing', status: 503 } } })
  expect(f.requests).toEqual([])
})

it('preserves an explicit upload refusal without claiming an unconfirmed write or sending a read-back', async () => {
  const f = await fixture(); await f.login()
  const prepared = await f.ctx.museMarket.prepare(metadata, f.skill.name)
  f.route((_req, res) => { json(res, { error: 'Private upstream detail' }, 403) })
  await expect(f.cloud.publishDraft(prepared.release.id, publisher, key))
    .rejects.toMatchObject({ details: { code: 'permission-denied', status: 403 } })
  expect(f.requests.map(request => [request.method, request.path])).toEqual([['POST', '/api/market/v1/uploads']])
  expect(await f.ctx.museMarket.installed()).toEqual([prepared])
})

it.each(['connection-error', 'owner-close'] as const)('joins an actual pending HTTP body read on %s', async (ending) => {
  const f = await fixture(), waiting = Promise.withResolvers<undefined>(), observed = Promise.withResolvers<Response>()
  const held = Promise.withResolvers<ServerResponse>(), restore: (() => void)[] = []
  f.route((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"items":')
    held.resolve(response)
  })
  const nativeFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await nativeFetch(...args)
    const input = args[0], url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== f.origin + '/api/market/v1/catalog?q=&mine=false') return response
    if (response.body === null) throw new Error('Expected the real HTTP response stream')
    const reader = response.body.getReader(), read = reader.read.bind(reader)
    let reads = 0
    const reading = vi.spyOn(reader, 'read').mockImplementation(() => {
      const pending = read()
      if (++reads === 2) waiting.resolve(undefined)
      return pending
    })
    restore.push(() => { reading.mockRestore() })
    const selecting = vi.spyOn(response.body, 'getReader').mockReturnValue(reader)
    restore.push(() => { selecting.mockRestore() })
    observed.resolve(response)
    return response
  })
  onTestFinished(() => { for (const release of restore.splice(0).reverse()) release(); fetch.mockRestore() })
  try {
    const active = f.cloud.catalog('', false).then(value => ({ value }), (error: unknown) => ({ error }))
    await Promise.race([waiting.promise, active.then(() => { throw new Error('Request settled before its second body read') })])
    if (ending === 'owner-close') await f.close()
    else (await held.promise).destroy()
    expect(await active).toMatchObject({ error: { details: {
      code: ending === 'owner-close' ? 'closing' : 'cloud-unavailable', status: 503,
    } } })
    expect((await observed.promise).body?.locked).toBe(false)
    expect(f.requests).toHaveLength(1)
  } finally {
    await f.close()
    for (const release of restore.splice(0).reverse()) release()
    fetch.mockRestore()
  }
})

it('rejects a relative credential path before making an HTTP request', async () => {
  await expect(fixture({ sessionFile: 'relative-session.json' })).rejects.toMatchObject({ code: 'invalid-session-file' })
})

it('refuses a corrupt private account record and permits a later repaired login', async () => {
  const f = await fixture()
  await writeFile(f.config.sessionFile, '{')
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'account-unavailable', status: 503 } })
  expect(f.requests).toEqual([])
  await f.login()
  expect(await f.cloud.catalog('', false)).toEqual([publication])
})

it('rejects an admitted response when its account record becomes unreadable before completion', async () => {
  const f = await fixture(); await f.login()
  f.route(async (_req, res) => { await writeFile(f.config.sessionFile, '{'); json(res, { items: [publication] }) })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'account-unavailable', status: 503 } })
  expect(f.requests).toHaveLength(1)
})

it('refuses a successful HTTP response without a JSON body', async () => {
  const f = await fixture()
  f.route((_req, res) => { res.writeHead(204, { 'content-type': 'application/json' }); res.end() })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'invalid-response', status: 502 } })
  expect(f.requests).toHaveLength(1)
})

it('refuses a malformed installation digest before downloading or importing anything', async () => {
  const f = await fixture(); await f.login()
  await expect(f.cloud.installPublication(publication.id, 'not-a-digest'))
    .rejects.toMatchObject({ details: { code: 'invalid-digest', status: 400 } })
  expect(f.requests).toEqual([])
  expect(await f.ctx.museMarket.installed()).toEqual([])
})

it.each([{ id: 'e'.repeat(32) }, { revision: 3 }, { status: 'draft' }, { reviewNote: 'Unrequested note' }])(
  'confirms a mismatched review acknowledgement only through the original publication read-back %#', async (change) => {
    const f = await fixture(); await f.login()
    const confirmed = { ...publication, status: 'pending', revision: 2, reviewNote: '' }
    f.route((req, res) => { json(res, req.method === 'POST' ? { ...confirmed, ...change } : confirmed) })
    expect(await f.cloud.review(publication.id, 1, 'submit', '')).toEqual(confirmed)
    expect(f.requests.map(request => [request.method, request.path])).toEqual([
      ['POST', `/api/market/v1/releases/${publication.id}/review`], ['GET', `/api/market/v1/releases/${publication.id}`],
    ])
  },
)

it('retains an unconfirmed review when the read-back names another publication', async () => {
  const f = await fixture(); await f.login()
  f.route((req, res) => { json(res, req.method === 'POST' ? { error: 'Unavailable' } : { ...publication, id: 'e'.repeat(32) }, req.method === 'POST' ? 500 : 200) })
  await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ details: {
    code: 'review-unconfirmed', status: 503, publicationId: publication.id, reviewedRevision: 1,
  } })
  expect(f.requests.map(request => request.method)).toEqual(['POST', 'GET'])
})

it('reports an unconfirmed review with the unchanged observed publication after a failed write', async () => {
  const f = await fixture(); await f.login()
  f.route((req, res) => { json(res, req.method === 'POST' ? { error: 'Unavailable' } : publication, req.method === 'POST' ? 500 : 200) })
  await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ details: {
    code: 'review-unconfirmed', status: 503, publicationId: publication.id, reviewedRevision: 1, observed: publication,
  } })
  expect(f.requests.map(request => request.method)).toEqual(['POST', 'GET'])
})

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

it('refuses overlong search text before HTTP and inconsistent public catalog replies without truncating them', async () => {
  const f = await fixture({ catalogLimit: 1 })
  await expect(f.cloud.catalog('x'.repeat(201), false)).rejects.toMatchObject({ details: { code: 'invalid-query', status: 400 } })
  expect(f.requests).toEqual([])
  for (const value of [{ items: [publication, publication] }, { items: [{ ...publication, status: 'draft' }] },
    { items: [], total: 0 }, { items: null }]) {
    f.route((_req, res) => { json(res, value) })
    await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'invalid-response', status: 502 } })
  }
})

it('refuses a different publication in a selected detail or installation response', async () => {
  const f = await fixture(); await f.login()
  f.route((_req, res) => { json(res, { ...publication, id: 'e'.repeat(32) }) })
  await expect(f.cloud.getPublication(publication.id)).rejects.toMatchObject({ details: { code: 'invalid-response' } })
  await expect(f.cloud.installPublication(publication.id, publication.sha256)).rejects.toMatchObject({ details: { code: 'catalog-changed' } })
  expect(f.requests).toHaveLength(2)
  expect(await f.ctx.museMarket.installed()).toEqual([])
})

it.each([[401, 'login-required'], [404, 'not-found'], [413, 'response-too-large'], [429, 'rate-limited']] as const)(
  'returns the bounded cloud refusal for HTTP %s', async (status, code) => {
    const f = await fixture(); await f.login()
    f.route((_req, res) => { json(res, { error: 'private upstream diagnostic' }, status) })
    await expect(f.cloud.identity()).rejects.toMatchObject({ details: { code, status } })
  },
)

it('refuses malformed JSON instead of returning a partial catalog', async () => {
  const f = await fixture()
  f.route((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{') })
  await expect(f.cloud.catalog('', false)).rejects.toMatchObject({ details: { code: 'invalid-response', status: 502 } })
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

it.each([
  ['approve', 'published', 'Approved for publication.'],
  ['reject', 'rejected', 'Revise the scene.'],
  ['withdraw', 'withdrawn', 'Withdrawn by the author.'],
] as const)('confirms an explicit %s with the inspected revision and note', async (action, status, note) => {
  const f = await fixture(); await f.login()
  const result = { ...publication, revision: 2, status, reviewNote: note }
  f.route(async (req, res) => {
    expect(req.method).toBe('POST')
    expect(JSON.parse((await body(req)).toString())).toEqual({ revision: 1, action, note })
    json(res, result)
  })
  expect(await f.cloud.review(publication.id, 1, action, note)).toEqual(result)
  expect(f.requests).toHaveLength(1)
})

it.each([{ revision: 0, action: 'submit', note: '' }, { revision: 1.5, action: 'submit', note: '' },
  { revision: 1, action: 'submit', note: 'x'.repeat(2001) }, { revision: 1, action: 'reject', note: ' ' }] as const)(
  'refuses an invalid review before HTTP %#', async ({ revision, action, note }) => {
    const f = await fixture(); await f.login()
    await expect(f.cloud.review(publication.id, revision, action, note)).rejects.toMatchObject({ details: { code: 'invalid-review', status: 400 } })
    expect(f.requests).toEqual([])
  },
)

it('retains the original review context when its follow-up read also fails', async () => {
  const f = await fixture(); await f.login()
  f.route((_req, res) => { json(res, { error: 'private upstream diagnostic' }, 500) })
  await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ details: {
    code: 'review-unconfirmed', status: 503, publicationId: publication.id, reviewedRevision: 1,
  } })
  expect(f.requests.map(row => row.method)).toEqual(['POST', 'GET'])
})

it.each(['write', 'read'] as const)('retains the inspected review when the account changes during its %s reply', async (phase) => {
  const f = await fixture(); await f.login()
  f.route(async (req, res) => {
    if (phase === 'read' && req.method === 'POST') { json(res, { error: 'Unavailable' }, 500); return }
    await f.login('replacement')
    json(res, { ...publication, status: 'pending', revision: 2 })
  })
  await expect(f.cloud.review(publication.id, 1, 'submit', '')).rejects.toMatchObject({ details: {
    code: 'account-changed', status: 409, publicationId: publication.id, reviewedRevision: 1,
  } })
  expect(f.requests.map(row => row.method)).toEqual(phase === 'write' ? ['POST'] : ['POST', 'GET'])
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
