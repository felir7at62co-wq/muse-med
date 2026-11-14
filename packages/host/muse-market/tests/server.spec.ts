/** Durable cloud identity, visibility, archive integrity and cross-connection moderation. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile, mkdir } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { MuseMarketCatalog, handleMarket } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { MarketCloudError, parseMarketAccountId, parseMarketPublication, parseMarketPublicationId,
  parseMarketUploadRequestId, parseMarketPublisherId } from '../src/cloud-protocol.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { manifest, resources, limits } from './fixtures.ts'

const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
const reader = { id: parseMarketAccountId('c'.repeat(16)), username: 'reader', admin: false }
const key = (value: string) => parseMarketUploadRequestId(value)
const archive = (version = '1.0.0') => createMarketPackage({ ...manifest, version }, resources, limits)

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture(extra: Partial<MarketServerConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-server-')), stores: MuseMarketCatalog[] = []
  onTestFinished(async () => {
    for (const store of stores.reverse()) await store.close()
    await rm(root, { recursive: true, force: true })
  })
  const config: MarketServerConfig = { root, limits, maxReleases: 100, maxActiveUploads: 2,
    jsonRequestBytes: 16384, jsonResponseBytes: 2 * 1024 * 1024, catalogLimit: 100, ...extra }
  const open = async () => { const store = await MuseMarketCatalog.open(config); stores.push(store); return store }
  const store = await open(), publisher = await store.invite(admin, 'Production team', author.id)
  const database = () => new DatabaseSync(join(root, 'market.sqlite'))
  return { root, config, store, publisher, open, database }
}

/** Run the HTTP handler with an already asserted test administrator and owned loopback sockets. */
async function carrier(f: Awaited<ReturnType<typeof fixture>>,
  before?: (request: IncomingMessage, response: ServerResponse) => void) {
  const failures: unknown[] = [], pending = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    before?.(request, response)
    const operation = handleMarket(f.store, request, response, admin, f.config)
      .catch((error: unknown) => { failures.push(error); response.destroy() })
    pending.add(operation)
    void operation.finally(() => { pending.delete(operation) })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await Promise.allSettled(pending)
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    expect(failures).toEqual([])
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('Handler fixture did not bind a TCP port')
  return (path: string, body?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path, agent: false,
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.once('error', reject)
    request.setTimeout(15_000, () => { request.destroy(Error('Handler fixture response deadline exceeded')) })
    request.end(body)
  })
}

describe('Skill cloud catalog', () => {
  it.each([
    { root: 'relative-root' }, { maxReleases: 0 }, { maxActiveUploads: 0 },
    { jsonRequestBytes: 0 }, { jsonResponseBytes: 0 }, { catalogLimit: 0 }, { catalogLimit: 101 },
    { limits: { ...limits, archiveBytes: 0 } }, { limits: { ...limits, expandedBytes: 0 } },
    { limits: { ...limits, fileCount: 0 } }, { limits: { ...limits, recordBytes: 0 } },
  ])('rejects an unusable resolved policy before changing storage: %j', async (extra) => {
    const f = await fixture()
    await expect(MuseMarketCatalog.open({ ...f.config, ...extra })).rejects.toMatchObject({ code: 'invalid-policy', status: 400 })
    expect(f.store.identity(author).publishers).toHaveLength(1)
  })

  it.each([
    { target: 'root', race: false }, { target: 'blobs', race: false },
    { target: 'root', race: true }, { target: 'blobs', race: true },
  ])('refuses a linked $target storage directory, replaced during inspection: $race', async ({ target, race }) => {
    const owner = await mkdtemp(join(tmpdir(), 'muse-market-storage-inspection-'))
    onTestFinished(() => rm(owner, { recursive: true, force: true }))
    const f = await fixture(), root = join(owner, 'catalog'), alternate = join(owner, 'alternate')
    await mkdir(join(root, 'blobs'), { recursive: true }); await mkdir(alternate)
    const selected = target === 'root' ? root : join(root, 'blobs'), held = join(owner, 'held')
    const replace = async () => { await rename(selected, held); await symlink(alternate, selected, 'junction') }
    const lstat = files.lstat
    let replaced = false
    if (!race) await replace()
    const inspection = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
      const info = await lstat(...args)
      if (race && args[0] === selected && !replaced) { replaced = true; await replace() }
      return info
    })
    try {
      await expect(MuseMarketCatalog.open({ ...f.config, root })).rejects.toMatchObject({ code: 'unsafe-storage' })
      expect(await readdir(alternate)).toEqual([])
    } finally { inspection.mockRestore() }
  })

  it('refuses a nonfile SQLite entry and preserves its retained database', async () => {
    const f = await fixture(); await f.store.close()
    const database = join(f.root, 'market.sqlite'), held = join(f.root, 'held.sqlite')
    const before = await readFile(database)
    await rename(database, held); await mkdir(database)
    await expect(MuseMarketCatalog.open(f.config)).rejects.toMatchObject({ code: 'unsafe-storage' })
    expect(await readFile(held)).toEqual(before)
  })

  it('refuses unreadable manifest JSON and catalog fields inconsistent with the immutable archive', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('damaged-manifest'), archive())
    const database = f.database()
    try {
      for (const manifestValue of [Buffer.from([0, 255]), '{incomplete', 'x'.repeat(limits.recordBytes + 1)]) {
        database.prepare('UPDATE releases SET manifest=? WHERE id=?').run(manifestValue, draft.id)
        expect(() => f.store.get(draft.id, author)).toThrow('corrupt-storage')
      }
      database.prepare('UPDATE releases SET manifest=? WHERE id=?').run(JSON.stringify(manifest), draft.id)
      for (const name of ['another-name', manifest.name]) {
        database.prepare('UPDATE releases SET name=?,version=? WHERE id=?').run(name, 'another-version', draft.id)
        expect(() => f.store.get(draft.id, author)).toThrow('corrupt-storage')
      }
    } finally { database.close() }
  })

  it('refuses corrupt team titles and hides private records without a valid publishing-team identity', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('damaged-team'), archive())
    const database = f.database()
    try {
      database.prepare('UPDATE publishers SET title=? WHERE id=?').run('', f.publisher)
      expect(() => f.store.identity(author)).toThrow('corrupt-storage')
      database.prepare('UPDATE publishers SET title=? WHERE id=?').run('Production team', f.publisher)
      for (const id of [Buffer.from([0, 255]), 'not-a-publisher']) {
        database.prepare('UPDATE releases SET publisherId=? WHERE id=?').run(id, draft.id)
        expect(() => f.store.get(draft.id, author)).toThrow(expect.objectContaining({ status: 404 }))
      }
    } finally { database.close() }
  })

  it('requires an administrator invitation and an owned or publicly visible catalog query', async () => {
    const f = await fixture()
    await expect(f.store.invite(author, 'Uninvited team', author.id)).rejects.toMatchObject({ code: 'admin-required' })
    for (const title of [' ', 'x'.repeat(101)]) {
      await expect(f.store.invite(admin, title, author.id)).rejects.toMatchObject({ code: 'invalid-publisher' })
    }
    expect(() => f.store.list(null, { q: '', mine: true })).toThrow('login-required')
    expect(() => f.store.list(author, { q: 'x'.repeat(201), mine: true })).toThrow('invalid-query')
    const draft = await f.store.upload(author, f.publisher, key('private-query'), archive())
    expect(f.store.list(author, { q: 'not present in any field', mine: true })).toEqual([])
    expect(f.store.list(author, { q: '', mine: true })).toEqual([draft])
    expect(f.store.list(reader, { q: '', mine: true })).toEqual([])
    expect(f.store.identity(admin).publishers).toHaveLength(1)
    expect(() => f.store.get(parseMarketPublicationId('0'.repeat(32)), author)).toThrow('not-found')
    await expect(f.store.upload(author, f.publisher, key('same-version-new-key'), archive()))
      .rejects.toMatchObject({ code: 'version-exists' })
    const release = f.store.reserveUpload(admin, f.publisher); release()
    expect(() => f.store.reserveUpload(author, parseMarketPublisherId('0'.repeat(32)))).toThrow('publisher-required')
  })

  it('bounds total upload-body reservations across different invited accounts', async () => {
    const f = await fixture({ maxActiveUploads: 1 })
    const second = await f.store.invite(admin, 'Second publisher', reader.id)
    const release = f.store.reserveUpload(author, f.publisher)
    expect(() => f.store.reserveUpload(reader, second)).toThrow('upload-busy')
    release()
    const admitted = f.store.reserveUpload(reader, second); admitted()
  })

  it.each(['missing', 'directory', 'size', 'digest'] as const)('refuses a %s immutable blob without changing its publication', async (damage) => {
    const f = await fixture(), bytes = Buffer.from(archive())
    const draft = await f.store.upload(author, f.publisher, key('damaged-blob'), bytes)
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), held = join(f.root, 'held.zip')
    if (damage === 'missing' || damage === 'directory') {
      await rename(file, held)
      if (damage === 'directory') await mkdir(file)
    } else {
      const changed = damage === 'size' ? Buffer.from('different length') : Buffer.from(bytes)
      if (damage === 'digest') changed[0] = (changed[0] ?? 0) ^ 255
      await writeFile(file, changed)
    }
    await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage' })
    expect(f.store.get(draft.id, author)).toEqual(draft)
    if (damage === 'missing' || damage === 'directory') expect(await readFile(held)).toEqual(bytes)
  })

  it.each(['open', 'after-read'] as const)('refuses a same-byte archive identity replacement at %s', async (phase) => {
    const f = await fixture(), bytes = Buffer.from(archive())
    const draft = await f.store.upload(author, f.publisher, key('blob-identity-race'), bytes)
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), held = join(f.root, 'original.zip')
    const lstat = files.lstat
    let reads = 0, replaced = false
    const inspection = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
      const info = await lstat(...args)
      if (args[0] === file && ++reads === (phase === 'open' ? 1 : 2)) {
        await rename(file, held); await writeFile(file, bytes); replaced = true
        if (phase === 'after-read') return await lstat(...args)
      }
      return info
    })
    try {
      await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage' })
      expect(replaced).toBe(true)
      expect(await readFile(held)).toEqual(bytes)
      expect(await readFile(file)).toEqual(bytes)
    } finally { inspection.mockRestore() }
  })

  it('releases a failed archive-link transaction without publishing a row or retaining a staging file', async () => {
    const f = await fixture(), failure = Object.assign(Error('Storage link refused'), { code: 'EIO' })
    const link = vi.spyOn(files, 'link').mockRejectedValueOnce(failure)
    try {
      await expect(f.store.upload(author, f.publisher, key('failed-retention'), archive())).rejects.toBe(failure)
      expect(f.store.list(author, { q: '', mine: true })).toEqual([])
      expect(await readdir(join(f.root, 'blobs'))).toEqual([])
    } finally { link.mockRestore() }
  })

  it.each(['before-read', 'after-read'] as const)('refuses an in-place archive mutation %s while joining its descriptor', async (phase) => {
    const f = await fixture(), bytes = Buffer.from(archive())
    const draft = await f.store.upload(author, f.publisher, key('blob-in-place-race'), bytes)
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), open = files.open
    let changed = false
    const inspect = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[0] === file) {
        const stat = handle.stat.bind(handle)
        let count = 0
        Object.defineProperty(handle, 'stat', { value: async () => {
          count++
          if (phase === 'before-read') {
            const info = await stat()
            if (count === 1) { await writeFile(file, Buffer.concat([bytes, Buffer.from('x')])); changed = true }
            return info
          }
          if (count === 2) { await writeFile(file, Buffer.concat([bytes, Buffer.from('x')])); changed = true }
          return stat()
        } })
      }
      return handle
    })
    try {
      await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage' })
      expect(changed).toBe(true)
      await rename(file, join(f.root, 'closed-descriptor.zip'))
    } finally { inspect.mockRestore() }
  })

  it('refuses malformed raw request targets before choosing an API operation', async () => {
    const f = await fixture(), call = await carrier(f)
    for (const target of ['/outside', '/api/market/v1/../outside', '/api/market/v1/catalog#fragment', '/api/market/v1/ca\\talog']) {
      expect(await call(target)).toEqual({ status: 400, text: '{"error":"invalid-request"}' })
    }
  })

  it.each(['text', 'bytes', 'invalid'] as const)('handles carrier body chunks as %s without leaking a partial write', async (mode) => {
    const f = await fixture(), title = '多语言测试团队'
    const call = await carrier(f, (request) => {
      if (mode === 'text') { request.setEncoding('utf8'); return }
      const original = request.iterator.bind(request)
      vi.spyOn(request, 'iterator').mockImplementation((options) => {
        const iterator = original(options), next = iterator.next.bind(iterator)
        vi.spyOn(iterator, 'next').mockImplementation(async (...args) => {
          const item = await next(...args)
          if (item.done) return item
          if (!Buffer.isBuffer(item.value)) throw Error('Expected a raw HTTP byte chunk')
          return { done: false, value: mode === 'bytes' ? new Uint8Array(item.value) : 5 }
        })
        return iterator
      })
    })
    const response = await call('/api/market/v1/publishers', JSON.stringify({ title, accountId: author.id }))
    expect(response.status).toBe(mode === 'invalid' ? 400 : 201)
    if (mode === 'invalid') expect(response.text).toBe('{"error":"invalid-request"}')
    expect(f.store.identity(author).publishers.some(row => row.title === title)).toBe(mode !== 'invalid')
  })

  it('leaves an already completed response intact on both successful and rejected operations', async () => {
    const f = await fixture(), call = await carrier(f, (_request, response) => { response.end('Already complete') })
    for (const path of ['/api/market/v1/catalog', '/outside']) {
      expect(await call(path)).toEqual({ status: 200, text: 'Already complete' })
    }
  })

  it('destroys a partially committed HTTP response instead of writing a second header or error body', async () => {
    const f = await fixture(), call = await carrier(f, (_request, response) => { response.writeHead(200) })
    await expect(call('/outside')).rejects.toMatchObject({ code: 'ECONNRESET' })
  })

  it('joins archive verification when the HTTP downloader disconnects before its response is written', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('disconnected-download'), archive())
    let response: ServerResponse | undefined
    const call = await carrier(f, (_request, current) => { response = current })
    const download = f.store.download.bind(f.store)
    const reader = vi.spyOn(f.store, 'download').mockImplementation(async (...args) => {
      const bytes = await download(...args)
      if (!response) throw Error('No active download response')
      response.destroy()
      return bytes
    })
    try {
      await expect(call(`/api/market/v1/releases/${draft.id}/download`)).rejects.toMatchObject({ code: 'ECONNRESET' })
      expect(reader).toHaveBeenCalledOnce()
      expect(f.store.get(draft.id, author)).toEqual(draft)
    } finally { reader.mockRestore() }
  })

  it('contains an unexpected SQLite read failure without returning database internals', async () => {
    const f = await fixture(), call = await carrier(f), database = f.database()
    try { database.exec('DROP TABLE releases') } finally { database.close() }
    expect(await call('/api/market/v1/catalog')).toEqual({ status: 500, text: '{"error":"market-unavailable"}' })
  })

  it('rolls back a team invitation when its membership insert fails', async () => {
    const f = await fixture(), database = f.database()
    try {
      database.exec("CREATE TRIGGER deny_membership BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT, 'fixture membership failure'); END;")
      await expect(f.store.invite(admin, 'Refused team', author.id)).rejects.toThrow('fixture membership failure')
      expect(database.prepare('SELECT COUNT(*) AS count FROM publishers').get()?.count).toBe(1)
    } finally { database.close() }
  })

  it.each(['same-key', 'changed-bytes', 'same-version', 'capacity'] as const)(
    'fences independent SQLite upload connections at commit: %s', async (mode) => {
      const f = await fixture(mode === 'capacity' ? { maxReleases: 1 } : {}), second = await f.open()
      const firstBytes = archive(), nextBytes = mode === 'changed-bytes' || mode === 'capacity' ? archive('2.0.0') : firstBytes
      const firstKey = key('concurrent-upload'), nextKey = mode === 'same-key' || mode === 'changed-bytes' ? firstKey : key('second-upload')
      const outcomes = await Promise.allSettled([
        f.store.upload(author, f.publisher, firstKey, firstBytes), second.upload(author, f.publisher, nextKey, nextBytes),
      ])
      const accepted = outcomes.filter(result => result.status === 'fulfilled')
      expect(accepted).toHaveLength(mode === 'same-key' ? 2 : 1)
      if (mode === 'same-key') {
        const ids = accepted.map(result => result.value.id)
        expect(new Set(ids).size).toBe(1)
      } else {
        const rejected = outcomes.find(result => result.status === 'rejected')
        if (!rejected || rejected.status !== 'rejected') throw Error('Expected a fenced upload refusal')
        expect(rejected.reason).toMatchObject({ code: mode === 'changed-bytes' ? 'idempotency-conflict'
          : mode === 'capacity' ? 'catalog-full' : 'version-exists' })
      }
      const database = f.database()
      try { expect(database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count).toBe(1) }
      finally { database.close() }
    },
  )

  it('requires a reviewable pending state and a successful revision-fenced update before recording moderation', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('moderation-fence'), archive())
    await expect(f.store.transition(author, draft.id, 0, 'submit', '')).rejects.toMatchObject({ code: 'invalid-review' })
    await expect(f.store.transition(author, draft.id, 1, 'submit', 'x'.repeat(2001))).rejects.toMatchObject({ code: 'invalid-review' })
    const pending = await f.store.transition(author, draft.id, 1, 'submit', '')
    const rejected = await f.store.transition(admin, draft.id, pending.revision, 'reject', 'Revise the examples')
    expect(rejected.status).toBe('rejected')
    const resubmitted = await f.store.transition(author, draft.id, rejected.revision, 'submit', '')
    const database = f.database()
    try {
      database.exec('CREATE TRIGGER ignore_review BEFORE UPDATE ON releases BEGIN SELECT RAISE(IGNORE); END;')
      await expect(f.store.transition(admin, draft.id, resubmitted.revision, 'approve', '')).rejects.toMatchObject({ code: 'revision-conflict' })
      expect(f.store.get(draft.id, author)).toMatchObject({ status: 'pending', revision: resubmitted.revision })
      expect(database.prepare('SELECT COUNT(*) AS count FROM reviews WHERE releaseId=?').get(draft.id)?.count).toBe(3)
    } finally { database.close() }
  })

  it('keeps uploads private until explicit owner submission and administrator approval', async () => {
    const f = await fixture(), bytes = archive()
    const draft = await f.store.upload(author, f.publisher, key('original-upload'), bytes)
    expect(draft.id).toMatch(/^[a-f0-9]{32}$/u)
    expect(draft.sha256).toBe(marketDigest(bytes)); expect(draft.id).not.toBe(draft.sha256)
    expect(draft).toMatchObject({ status: 'draft', revision: 1, bytes: bytes.byteLength })
    expect(f.store.list(null, { q: '', mine: false })).toEqual([])
    expect(() => f.store.get(draft.id, reader)).toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.store.transition(reader, draft.id, 1, 'submit', '')).rejects.toMatchObject({ status: 404 })
    const pending = await f.store.transition(author, draft.id, 1, 'submit', '')
    expect(pending).toMatchObject({ status: 'pending', revision: 2 })
    await expect(f.store.transition(author, draft.id, 2, 'approve', '')).rejects.toMatchObject({ status: 403 })
    await expect(f.store.transition(admin, draft.id, 2, 'reject', ' ')).rejects.toMatchObject({ status: 409 })
    const published = await f.store.transition(admin, draft.id, 2, 'approve', 'Reviewed')
    expect(published).toMatchObject({ status: 'published', revision: 3 })
    expect(f.store.get(draft.id, null)).toEqual(published)
    expect(Buffer.from(await f.store.download(draft.id, reader))).toEqual(Buffer.from(bytes))
    expect(f.store.list(null, { q: manifest.name, mine: false })).toEqual([published])
    expect(f.store.list(null, { q: 'fixture-skill', mine: false })).toEqual([published])
    expect(f.store.list(null, { q: draft.id, mine: false })).toEqual([published])
    await expect(f.store.transition(author, draft.id, 2, 'withdraw', '')).rejects.toMatchObject({ code: 'revision-conflict' })
    expect(await f.store.transition(author, draft.id, 3, 'withdraw', 'Retained')).toMatchObject({ status: 'withdrawn', revision: 4 })
    expect(() => f.store.get(draft.id, null)).toThrow(expect.objectContaining({ status: 404 }))
  })

  it('retains one account-key identity and refuses changed bytes or publishing team', async () => {
    const f = await fixture(), bytes = archive(), request = key('retry-original-key')
    const first = await f.store.upload(author, f.publisher, request, bytes)
    expect(await f.store.upload(author, f.publisher, request, bytes)).toEqual(first)
    const other = await f.store.invite(admin, 'Second team', author.id)
    await expect(f.store.upload(author, other, request, bytes)).rejects.toMatchObject({ code: 'idempotency-conflict', status: 409 })
    await expect(f.store.upload(author, f.publisher, request, archive('2.0.0'))).rejects.toMatchObject({ code: 'idempotency-conflict' })
    await expect(f.store.upload(reader, f.publisher, key('unauthorized-key'), bytes)).rejects.toMatchObject({ status: 403 })
    const database = f.database()
    try { expect(database.prepare('SELECT COUNT(*) AS count FROM releases').get()?.count).toBe(1) }
    finally { database.close() }
    expect(await readdir(join(f.root, 'blobs'))).toEqual([first.sha256 + '.zip'])
    await f.store.close()
    const reopened = await f.open()
    expect(await reopened.upload(author, f.publisher, request, bytes)).toEqual(first)
  })

  it('commits only one approval when two independent SQLite connections inspect the same pending revision', async () => {
    const f = await fixture()
    const draft = await f.store.upload(author, f.publisher, key('concurrent-review'), archive())
    const pending = await f.store.transition(author, draft.id, 1, 'submit', '')
    const second = await f.open()
    const outcomes = await Promise.allSettled([
      f.store.transition(admin, draft.id, pending.revision, 'approve', 'First review'),
      second.transition(admin, draft.id, pending.revision, 'approve', 'Second review'),
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(result => result.status === 'rejected')
    if (rejected?.status !== 'rejected') throw new Error('Expected the stale independent approval to be refused')
    expect(rejected.reason).toMatchObject({ code: 'revision-conflict', status: 409 })
    expect(f.store.get(draft.id, admin)).toMatchObject({ revision: 3, status: 'published' })
    const database = f.database()
    try { expect(database.prepare('SELECT COUNT(*) AS count FROM reviews WHERE releaseId=?').get(draft.id)?.count).toBe(2) }
    finally { database.close() }
  })

  it('hides raw retired Bot records before Skill parsing while retaining their exact rows and blobs', async () => {
    const f = await fixture(), bytes = archive()
    const draft = await f.store.upload(author, f.publisher, key('retired-cloud-row'), bytes)
    const raw = JSON.stringify({ kind: 'bot', legacy: { plugins: ['retired-plugin'] } })
    const database = f.database()
    try { database.prepare("UPDATE releases SET manifest=?,status='published' WHERE id=?").run(raw, draft.id) }
    finally { database.close() }
    expect(f.store.list(admin, { q: '', mine: true })).toEqual([])
    expect(f.store.list(null, { q: '', mine: false })).toEqual([])
    expect(() => f.store.get(draft.id, admin)).toThrow(expect.objectContaining({ status: 404 }))
    await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ status: 404 })
    await expect(f.store.transition(admin, draft.id, 1, 'withdraw', '')).rejects.toMatchObject({ status: 404 })
    const retained = f.database()
    try { expect(retained.prepare('SELECT manifest FROM releases WHERE id=?').get(draft.id)?.manifest).toBe(raw) }
    finally { retained.close() }
    expect(await readFile(join(f.root, 'blobs', draft.sha256 + '.zip'))).toEqual(Buffer.from(bytes))
  })

  it('refuses corrupt supported records and mismatched archive metadata instead of returning partial data', async () => {
    const f = await fixture(), bytes = archive()
    const draft = await f.store.upload(author, f.publisher, key('corrupt-cloud-row'), bytes)
    const database = f.database()
    try { database.prepare('UPDATE releases SET manifest=? WHERE id=?').run(JSON.stringify({ kind: 'skill' }), draft.id) }
    finally { database.close() }
    expect(() => f.store.get(draft.id, admin)).toThrow(expect.objectContaining({ code: 'corrupt-storage', status: 500 }))
    expect(() => f.store.list(admin, { q: '', mine: true })).toThrow('corrupt-storage')
    const changed = f.database()
    try { changed.prepare('UPDATE releases SET manifest=? WHERE id=?').run(JSON.stringify({ ...manifest, title: 'Wrong catalog title' }), draft.id) }
    finally { changed.close() }
    await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage' })
    expect(() => parseMarketPublication({ ...draft, bytes: 0 }, limits)).toThrow(MarketCloudError)
    expect(() => parseMarketPublicationId(draft.sha256)).toThrow('invalid-publication')
  })

  it('applies result limits after retired rows and preserves original-key retries at capacity', async () => {
    const f = await fixture({ catalogLimit: 1, maxReleases: 2 }), bytes = archive()
    const old = await f.store.upload(author, f.publisher, key('retired-limit-row'), bytes)
    const live = await f.store.upload(author, f.publisher, key('live-limit-row'), archive('2.0.0'))
    const database = f.database()
    try {
      database.prepare("UPDATE releases SET manifest=?,status='published',createdAt='2099-01-01T00:00:00.000Z' WHERE id=?")
        .run(JSON.stringify({ kind: 'bot' }), old.id)
      database.prepare("UPDATE releases SET status='published' WHERE id=?").run(live.id)
    } finally { database.close() }
    expect(f.store.list(null, { q: '', mine: false })).toEqual([{ ...live, status: 'published' }])
    expect(await f.store.upload(author, f.publisher, key('live-limit-row'), archive('2.0.0'))).toMatchObject({ id: live.id })
    await expect(f.store.upload(author, f.publisher, key('over-capacity-row'), archive('3.0.0'))).rejects.toMatchObject({ status: 507 })
    expect((await readdir(join(f.root, 'blobs'))).sort()).toEqual([old.sha256 + '.zip', live.sha256 + '.zip'].sort())
  })

  it('owns upload reservations and refuses new work after close', async () => {
    const f = await fixture({ maxActiveUploads: 1 })
    const release = f.store.reserveUpload(author, f.publisher)
    expect(() => f.store.reserveUpload(author, f.publisher)).toThrow(expect.objectContaining({ status: 429 }))
    release(); release()
    const again = f.store.reserveUpload(author, f.publisher); again()
    await f.store.close()
    expect(() => f.store.reserveUpload(author, f.publisher)).toThrow('closed')
    await expect(f.store.upload(author, f.publisher, key('after-close-key'), archive())).rejects.toMatchObject({ status: 503 })
  })

  it('rejects a future SQLite generation without modifying it', async () => {
    const f = await fixture(); await f.store.close()
    const database = f.database()
    try { database.exec('PRAGMA user_version=2') } finally { database.close() }
    const before = await readFile(join(f.root, 'market.sqlite'))
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      await expect(MuseMarketCatalog.open(f.config)).rejects.toMatchObject({ code: 'unsupported-schema' })
      expect(close).toHaveBeenCalledTimes(1)
    } finally { close.mockRestore() }
    expect(await readFile(join(f.root, 'market.sqlite'))).toEqual(before)
  })

  // Windows file-link creation requires privileges that its test runners need not grant.
  it.runIf(process.platform !== 'win32')('refuses a linked immutable blob without following it', async () => {
    const f = await fixture(), bytes = archive()
    const draft = await f.store.upload(author, f.publisher, key('linked-blob-key'), bytes)
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), moved = join(f.root, 'original.zip')
    await rename(file, moved); await symlink(moved, file)
    try { await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage' }) }
    finally { await unlink(file); await rename(moved, file) }
    expect(await readFile(file)).toEqual(Buffer.from(bytes))
  })

  it('refuses unauthorized and stale approvals before reading an unavailable archive', async () => {
    const f = await fixture()
    const draft = await f.store.upload(author, f.publisher, key('early-approval-guard'), archive())
    await f.store.transition(author, draft.id, 1, 'submit', '')
    await f.store.transition(admin, draft.id, 2, 'approve', '')
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), held = join(f.root, 'held.zip')
    await rename(file, held)
    try {
      await expect(f.store.transition(reader, draft.id, 3, 'approve', '')).rejects.toMatchObject({ status: 403 })
      await expect(f.store.transition(admin, draft.id, 2, 'approve', '')).rejects.toMatchObject({ code: 'revision-conflict' })
      expect(f.store.get(draft.id, admin)).toMatchObject({ revision: 3, status: 'published' })
      const database = f.database()
      try { expect(database.prepare('SELECT COUNT(*) AS count FROM reviews WHERE releaseId=?').get(draft.id)?.count).toBe(2) }
      finally { database.close() }
    } finally { await rename(held, file) }
  })
})
