/** Exercise the Host cloud client with real loopback HTTP and origin-bound sessions. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMuseSession } from '@deepseek-ai/dsh-muse-account/session'
import { expect, it, onTestFinished } from 'vitest'
import { MuseMarketCloud } from '../src/cloud.ts'
import { marketDigest } from '../src/package.ts'
import type { MarketRelease } from '../src/types.ts'

const cookie = '__Host-muse=fixture'
const release: MarketRelease = {
  id: 'a'.repeat(32) as MarketRelease['id'],
  publisherId: 'b'.repeat(32) as MarketRelease['publisherId'],
  publisher: 'Studio', sha256: 'c'.repeat(64), bytes: 4, status: 'published', reviewNote: '',
  revision: 3, createdAt: '2026-11-02T00:00:00.000Z',
  manifest: { formatVersion: 1, kind: 'skill', name: 'review', title: 'Review',
    description: 'Review scenes', version: '1.0.0', category: 'Production', license: 'MIT',
    examples: [], requirements: [], skills: [{ name: 'review', path: 'skills/review/SKILL.md' }] },
}

async function start(handler: RequestListener, archiveBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-cloud-'))
  const server = createServer(handler)
  const resources: { cloud?: MuseMarketCloud } = {}
  onTestFinished(async () => {
    try { await resources.cloud?.close() }
    finally {
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error) reject(error); else resolve() })
          server.closeAllConnections()
        })
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not acquire a TCP address')
  const origin = 'http://127.0.0.1:' + String(address.port)
  const sessionFile = join(root, 'session.json')
  const cloud = new MuseMarketCloud({ baseUrl: origin, sessionFile, allowedPlugins: [], archiveBytes, requestTimeoutMs: 10000 })
  resources.cloud = cloud
  return {
    cloud, origin,
    login: () => writeMuseSession(sessionFile, { baseUrl: origin, cookie, username: 'fixture' }),
  }
}

it.each(['http://not-loopback.test', 'https://author@muse.test', 'https://:secret@muse.test',
  'https://muse.test/subpath', 'https://muse.test/?query', 'https://muse.test/#anchor'])('rejects the unapproved market origin %s', (baseUrl) => {
  expect(() => new MuseMarketCloud({ baseUrl, sessionFile: '', allowedPlugins: [], archiveBytes: 1024, requestTimeoutMs: 1000 }))
    .toThrow('Invalid market origin')
})

it('uses a stored cookie only for the matching origin and leaves anonymous resources independent', async () => {
  const requests: { url: string | undefined; cookie: string | undefined; origin: string | undefined }[] = []
  const { cloud, origin, login } = await start((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie, origin: request.headers.origin })
    response.end(JSON.stringify(request.url === '/market/catalog.json' ? { entries: [] } : { items: [release] }))
  })
  await expect(cloud.identity()).rejects.toMatchObject({ code: 'login-required', status: 401 })
  expect(requests).toEqual([])
  await expect(cloud.list('view scenes', 'skill', false)).resolves.toEqual([release])
  await login()
  await expect(cloud.list('', '', true)).resolves.toEqual([release])
  await expect(cloud.legacyCatalog('', '')).resolves.toEqual([])
  expect(requests).toEqual([
    { url: '/api/market/v1/catalog?q=view+scenes&kind=skill&mine=false', origin, cookie: undefined },
    { url: '/api/market/v1/catalog?q=&kind=skill&mine=true', origin, cookie },
    { url: '/market/catalog.json', origin, cookie: undefined },
  ])
})

it('filters stale Bot catalogue entries and refuses their direct download before fetching bytes', async () => {
  const bot = { ...release, manifest: { ...release.manifest, kind: 'bot', plugins: [] } }
  const paths: string[] = []
  const { cloud, login } = await start((request, response) => {
    paths.push(request.url ?? '')
    response.end(JSON.stringify(request.url?.includes('/catalog?') ? { items: [bot, release] } : bot))
  })
  await expect(cloud.list('', 'bot', false)).rejects.toMatchObject({ code: 'skill-only' })
  await expect(cloud.legacyCatalog('', 'bot')).rejects.toMatchObject({ code: 'skill-only' })
  await expect(cloud.downloadLegacy('muse/bots/review', 'a'.repeat(64))).rejects.toMatchObject({ code: 'skill-only' })
  expect(paths).toEqual([])
  await login()
  await expect(cloud.list('', '', false)).resolves.toEqual([release])
  await expect(cloud.download(release.id)).rejects.toMatchObject({ code: 'skill-only' })
  expect(paths.some(path => path.endsWith('/download'))).toBe(false)
  await expect(cloud.upload(release.publisherId, 'retired-response', Buffer.from('data'))).rejects.toMatchObject({ code: 'skill-only' })
  await expect(cloud.review(release.id, 1, 'approve', '')).rejects.toMatchObject({ code: 'skill-only' })
})

it.each([[303, 'login-required'], [401, 'login-required'], [403, 'publisher-required'],
  [409, 'cloud-conflict'], [500, 'cloud-unavailable'], [304, 'cloud-unavailable']])(
  'maps an HTTP %s market failure without following redirects', async (status, code) => {
    const paths: (string | undefined)[] = []
    const { cloud } = await start((request, response) => {
      paths.push(request.url)
      response.writeHead(status, { location: '/login' }).end('Gateway response')
    })
    await expect(cloud.list('', '', false)).rejects.toMatchObject({ code, status })
    expect(paths).toEqual(['/api/market/v1/catalog?q=&kind=skill&mine=false'])
  },
)

it.each([[204, ''], [200, '{'], [200, 'null'], [200, '42'], [200, '{}'], [200, '{"items":{}}']])(
  'rejects an invalid catalog response (%s %s)', async (status, body) => {
    const { cloud } = await start((_request, response) => { response.writeHead(status).end(body) })
    await expect(cloud.list('', '', false)).rejects.toMatchObject({ code: 'invalid-response' })
  },
)

it.each([
  null, 7, {}, { publishers: false }, { publishers: [] }, { publishers: [], admin: 0 },
  { publishers: [null], admin: false }, { publishers: [{}], admin: false },
  { publishers: [{ id: 'short', title: 'Studio' }], admin: false },
  { publishers: [{ id: release.publisherId, title: 42 }], admin: false },
  { publishers: [{ id: release.publisherId, title: 'a'.repeat(101) }], admin: false },
])('rejects malformed publisher identity %j', async (identity) => {
  const { cloud, login } = await start((_request, response) => { response.end(JSON.stringify(identity)) })
  await login()
  await expect(cloud.identity()).rejects.toMatchObject({ code: 'invalid-response' })
})

it('sends exact ZIP bytes and review metadata to the authenticated gateway', async () => {
  const requests: {
    method: string | undefined
    url: string | undefined
    headers: IncomingMessage['headers']
    bytes: Buffer
  }[] = []
  const identity = { publishers: [{ id: release.publisherId, title: 'Studio' }], admin: true }
  const receive = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    requests.push({ method: request.method, url: request.url, headers: request.headers, bytes: Buffer.concat(chunks) })
    response.end(request.url?.endsWith('/download') ? Buffer.from('data')
      : JSON.stringify(request.url?.endsWith('/me') ? identity : release))
  }
  const { cloud, origin, login } = await start((request, response) => {
    void receive(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await login()
  await expect(cloud.identity()).resolves.toEqual(identity)
  await expect(cloud.download('incorrect')).rejects.toMatchObject({ code: 'invalid-release' })
  await expect(cloud.review('incorrect', 1, 'submit', '')).rejects.toMatchObject({ code: 'invalid-release' })
  await expect(cloud.upload(release.publisherId, 'fixture-1', Buffer.from('data'))).resolves.toEqual(release)
  await expect(cloud.review(release.id, 2, 'approve', 'Reviewed')).resolves.toEqual(release)
  await expect(cloud.download(release.id)).resolves.toEqual({ release, archive: Buffer.from('data') })
  expect(requests.map(row => [row.method, row.url, row.headers.origin, row.headers.cookie])).toEqual([
    ['GET', '/api/market/v1/me', origin, cookie],
    ['POST', '/api/market/v1/uploads', origin, cookie],
    ['POST', '/api/market/v1/releases/' + release.id + '/review', origin, cookie],
    ['GET', '/api/market/v1/releases/' + release.id, origin, cookie],
    ['GET', '/api/market/v1/releases/' + release.id + '/download', origin, cookie],
  ])
  expect(requests[1]?.headers).toMatchObject({
    'content-type': 'application/zip', 'x-market-publisher': release.publisherId, 'idempotency-key': 'fixture-1',
  })
  expect(requests[1]?.bytes).toEqual(Buffer.from('data'))
  expect(JSON.parse(requests[2]?.bytes.toString('utf8') ?? '')).toEqual({ revision: 2, action: 'approve', note: 'Reviewed' })
})

it('checks the advertised legacy digest before and after reading bounded archive bytes', async () => {
  const exact = Buffer.from('data')
  const sha256 = marketDigest(exact)
  const entry = { id: 'muse/skills/review', kind: 'skill', name: 'Review', version: '1.0.0',
    description: 'Review scenes', category: 'Production', requirements: [], validation: 'Verified',
    sha256, package: 'downloads/review.zip' }
  let catalog: Buffer = Buffer.from([255])
  let archive = exact
  let downloads = 0
  const { cloud } = await start((request, response) => {
    if (request.url === '/market/catalog.json') { response.end(catalog); return }
    downloads++; response.end(archive)
  }, 4)
  await expect(cloud.legacyCatalog('', '')).rejects.toMatchObject({ code: 'invalid-response' })
  await expect(cloud.downloadLegacy('review', sha256)).rejects.toMatchObject({ code: 'invalid-release' })
  await expect(cloud.downloadLegacy(entry.id, 'short')).rejects.toMatchObject({ code: 'invalid-release' })
  catalog = Buffer.from(JSON.stringify({ entries: [entry] }))
  await expect(cloud.downloadLegacy('muse/skills/missing', sha256)).rejects.toMatchObject({ code: 'legacy-not-found', status: 404 })
  await expect(cloud.downloadLegacy(entry.id, 'a'.repeat(64))).rejects.toMatchObject({ code: 'legacy-catalog-changed', status: 409 })
  expect(downloads).toBe(0)
  await expect(cloud.downloadLegacy(entry.id, sha256)).resolves.toMatchObject({ archive: exact, resource: { id: entry.id, sha256 } })
  archive = Buffer.from('edit')
  await expect(cloud.downloadLegacy(entry.id, sha256)).rejects.toMatchObject({ code: 'digest-mismatch' })
  archive = Buffer.from('overflow')
  await expect(cloud.downloadLegacy(entry.id, sha256)).rejects.toMatchObject({ code: 'response-too-large', status: 413 })
  expect(downloads).toBe(3)
})

it('aborts an in-flight catalog body when the client closes', async () => {
  const opened = Promise.withResolvers<undefined>()
  const disconnected = Promise.withResolvers<undefined>()
  const { cloud } = await start((_request, response) => {
    response.once('close', () => { disconnected.resolve(undefined) })
    response.writeHead(200).write('{"items":[')
    opened.resolve(undefined)
  })
  const listing = expect(cloud.list('', '', false)).rejects.toMatchObject({ name: 'AbortError' })
  await opened.promise
  await cloud.close()
  await listing
  await disconnected.promise
})
