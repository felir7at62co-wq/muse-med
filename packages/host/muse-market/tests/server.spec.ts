/** Durable cloud identity, visibility, archive integrity and cross-connection moderation. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMarket, MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { MarketCloudError, parseMarketAccountId, parseMarketPublication, parseMarketPublicationId,
  parseMarketPublisherId, parseMarketUploadRequestId } from '../src/cloud-protocol.ts'
import { createMarketPackage, marketDigest } from '../src/package.ts'
import { manifest, resources, limits } from './fixtures.ts'

const admin = { id: parseMarketAccountId('a'.repeat(16)), username: 'admin', admin: true }
const author = { id: parseMarketAccountId('b'.repeat(16)), username: 'author', admin: false }
const reader = { id: parseMarketAccountId('c'.repeat(16)), username: 'reader', admin: false }
const key = (value: string) => parseMarketUploadRequestId(value)
const archive = (version = '1.0.0') => createMarketPackage({ ...manifest, version }, resources, limits)

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

describe('Skill cloud catalog', () => {
  it.each(['outside-prefix', 'normalized-outside'] as const)('refuses a native HTTP request outside its route (%s)', async (kind) => {
    const f = await fixture(), server = createServer((request, response) => {
      void handleMarket(f.store, request, response, author, f.config)
    })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing native HTTP address')
    const path = kind === 'outside-prefix' ? '/outside' : '/api/market/v1/../outside'
    const received = await new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path }, (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk: string) => { text += chunk })
        response.on('end', () => { resolve({ status: response.statusCode, text }) })
        response.on('error', reject)
      })
      request.on('error', reject); request.end()
    })
    expect(received.status).toBe(400)
    expect(JSON.parse(received.text)).toEqual({ error: 'invalid-request' })
    expect(f.store.identity(author).publishers).toEqual([{ id: f.publisher, title: 'Production team' }])
  })

  it('consumes a real HTTP string body after its carrier explicitly selects UTF-8', async () => {
    const f = await fixture(), server = createServer((request, response) => {
      request.setEncoding('utf8')
      void handleMarket(f.store, request, response, admin, f.config)
    })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing native HTTP address')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/market/v1/publishers`, {
      method: 'POST', body: JSON.stringify({ title: 'UTF-8 制作组', accountId: reader.id }),
    })
    expect(response.status).toBe(201)
    const body: unknown = await response.json()
    expect(body).toHaveProperty('id')
    const publishers = f.store.identity(reader).publishers
    expect(publishers).toHaveLength(1)
    expect(publishers[0]?.title).toBe('UTF-8 制作组')
    expect(body).toEqual({ id: publishers[0]?.id })
  })

  it('closes an already-started native response when request handling fails without writing a second header', async () => {
    const f = await fixture(), handled = Promise.withResolvers<undefined>()
    let writesAfterStart = -1
    const server = createServer((request, response) => {
      response.writeHead(200); response.flushHeaders()
      const writing = vi.spyOn(response, 'writeHead')
      void handleMarket(f.store, request, response, author, f.config).finally(() => {
        writesAfterStart = writing.mock.calls.length; writing.mockRestore(); handled.resolve(undefined)
      })
    })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing native HTTP address')
    await expect(fetch(`http://127.0.0.1:${address.port}/outside`).then(async response => await response.text())).rejects.toThrow()
    await handled.promise
    expect(writesAfterStart).toBe(0)
    expect(f.store.identity(author).publishers).toEqual([{ id: f.publisher, title: 'Production team' }])
  })

  it.each(['root', 'blobs'] as const)('refuses a pre-existing linked %s directory without modifying its target', async (location) => {
    const f = await fixture(); await f.store.close()
    const held = join(f.root, 'original-storage'), selected = location === 'root' ? join(f.root, 'linked-root') : join(f.root, 'blobs')
    if (location === 'root') await mkdir(held)
    else await rename(selected, held)
    await symlink(held, selected, process.platform === 'win32' ? 'junction' : 'dir')
    const before = await readdir(held)
    try {
      await expect(MuseMarketCatalog.open(location === 'root' ? { ...f.config, root: selected } : f.config))
        .rejects.toMatchObject({ code: 'unsafe-storage', status: 500 })
      expect(await readdir(held)).toEqual(before)
    } finally { await unlink(selected) }
  })

  it.each(['', '-wal', '-shm'])('refuses a directory occupying a SQLite file%s before opening the catalog', async (suffix) => {
    const f = await fixture(); await f.store.close()
    const selected = join(f.root, 'market.sqlite' + suffix), held = selected + '.retained'
    const existing = await readFile(selected).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      return undefined
    })
    if (existing !== undefined) await rename(selected, held)
    await mkdir(selected)
    await expect(MuseMarketCatalog.open(f.config)).rejects.toMatchObject({ code: 'unsafe-storage', status: 500 })
    expect(await readdir(selected)).toEqual([])
    if (existing !== undefined) expect(await readFile(held)).toEqual(existing)
  })

  it('refuses an unauthorized upload reservation without consuming the invited account capacity', async () => {
    const f = await fixture()
    expect(() => f.store.reserveUpload(reader, f.publisher)).toThrow(expect.objectContaining({ code: 'publisher-required', status: 403 }))
    const release = f.store.reserveUpload(author, f.publisher)
    release(); release()
    f.store.reserveUpload(author, f.publisher)()
  })

  it.each(['wrong-size', 'wrong-digest'] as const)('refuses a statically corrupted retained archive (%s) without changing its draft', async (kind) => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('corrupt-cache-key'), archive())
    const file = join(f.root, 'blobs', draft.sha256 + '.zip'), before = await readFile(file)
    const damaged = kind === 'wrong-size' ? before.subarray(0, before.length - 1) : Buffer.from(before)
    if (kind === 'wrong-digest') {
      const last = damaged[damaged.length - 1]
      if (last === undefined) throw new Error('Missing fixture archive trailer')
      damaged[damaged.length - 1] = last ^ 1
    }
    await writeFile(file, damaged)
    await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage', status: 500 })
    expect(f.store.get(draft.id, author)).toEqual(draft)
    expect(await readFile(file)).toEqual(damaged)
  })

  it('rolls back a moderation update ignored by SQLite and accepts a later healthy retry', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('ignored-update-key'), archive())
    const database = f.database()
    try { database.exec('CREATE TRIGGER fixture_ignored_update BEFORE UPDATE ON releases BEGIN SELECT RAISE(IGNORE); END') }
    finally { database.close() }
    await expect(f.store.transition(author, draft.id, 1, 'submit', '')).rejects.toMatchObject({ code: 'revision-conflict', status: 409 })
    expect(f.store.get(draft.id, author)).toEqual(draft)
    const repaired = f.database()
    try {
      expect(repaired.prepare('SELECT COUNT(*) AS count FROM reviews WHERE releaseId=?').get(draft.id)?.count).toBe(0)
      repaired.exec('DROP TRIGGER fixture_ignored_update')
    } finally { repaired.close() }
    expect(await f.store.transition(author, draft.id, 1, 'submit', '')).toMatchObject({ status: 'pending', revision: 2 })
  })

  it('reports a missing retained archive without returning partial bytes or changing publication metadata', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('missing-cache-key'), archive())
    await unlink(join(f.root, 'blobs', draft.sha256 + '.zip'))
    await expect(f.store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage', status: 500 })
    expect(f.store.get(draft.id, author)).toEqual(draft)
  })

  it.each(['same', 'changed-bytes', 'changed-team', 'new-key'] as const)(
    'rechecks concurrent upload admission across two real catalog connections (%s)', async (kind) => {
      const f = await fixture(), second = await f.open(), bytes = archive()
      const warming = await f.store.invite(admin, 'Cache warming team', author.id)
      await f.store.upload(author, warming, key('warm-complete-cache'), bytes)
      const otherTeam = kind === 'changed-team' ? await f.store.invite(admin, 'Second target team', author.id) : f.publisher
      // Shared bytes are already complete. This exercises SQLite admission
      // after asynchronous retention without racing cache-file creation.
      const request = key('concurrent-original-key')
      const results = await Promise.allSettled([
        f.store.upload(author, f.publisher, request, bytes),
        second.upload(author, otherTeam, kind === 'new-key' ? key('concurrent-other-key') : request,
          kind === 'changed-bytes' ? archive('2.0.0') : bytes),
      ])
      const successes = results.filter(result => result.status === 'fulfilled')
      expect(successes).toHaveLength(kind === 'same' ? 2 : 1)
      if (kind === 'same') expect(successes[1]?.value).toEqual(successes[0]?.value)
      else {
        const failures = results.filter(result => result.status === 'rejected')
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ status: 'rejected', reason: {
          code: kind === 'new-key' ? 'version-exists' : 'idempotency-conflict', status: 409,
        } })
      }
      expect(f.store.list(author, { q: '', mine: true }).filter(item => item.publisherId !== warming)).toHaveLength(1)
    },
  )

  it('rechecks the catalog bound after another connection commits during archive retention', async () => {
    const f = await fixture({ maxReleases: 2 }), second = await f.open()
    await f.store.upload(author, f.publisher, key('first-capacity-key'), archive())
    const results = await Promise.allSettled([
      f.store.upload(author, f.publisher, key('capacity-left-key'), archive('2.0.0')),
      second.upload(author, f.publisher, key('capacity-right-key'), archive('3.0.0')),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const failures = results.filter(result => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ status: 'rejected', reason: { code: 'catalog-full', status: 507 } })
    expect(f.store.list(author, { q: '', mine: true })).toHaveLength(2)
  })

  it('rolls back a failed team membership write and keeps the catalog available', async () => {
    const f = await fixture(), database = f.database()
    try { database.exec("CREATE TRIGGER fixture_membership_failure BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT, 'fixture-member-write'); END") }
    finally { database.close() }
    await expect(f.store.invite(admin, 'Uncommitted team', reader.id)).rejects.toThrow('fixture-member-write')
    expect(f.store.identity(admin).publishers).toEqual([{ id: f.publisher, title: 'Production team' }])
    const repair = f.database()
    try { repair.exec('DROP TRIGGER fixture_membership_failure') }
    finally { repair.close() }
    const admitted = await f.store.invite(admin, 'Admitted team', reader.id)
    expect(f.store.identity(reader).publishers).toEqual([{ id: admitted, title: 'Admitted team' }])
  })

  it('rolls back a failed publication write without inventing a draft or poisoning the next upload', async () => {
    const f = await fixture(), database = f.database(), bytes = archive()
    try { database.exec("CREATE TRIGGER fixture_publication_failure BEFORE INSERT ON releases BEGIN SELECT RAISE(ABORT, 'fixture-release-write'); END") }
    finally { database.close() }
    await expect(f.store.upload(author, f.publisher, key('failed-publication-key'), bytes)).rejects.toThrow('fixture-release-write')
    expect(f.store.list(author, { q: '', mine: true })).toEqual([])
    const repair = f.database()
    try { repair.exec('DROP TRIGGER fixture_publication_failure') }
    finally { repair.close() }
    const admitted = await f.store.upload(author, f.publisher, key('recovered-publication-key'), bytes)
    expect(admitted).toMatchObject({ status: 'draft', revision: 1, sha256: marketDigest(bytes) })
    expect(f.store.list(author, { q: '', mine: true })).toEqual([admitted])
  })

  it.each(['{', 'x'.repeat(limits.recordBytes + 1), Buffer.from('{}')])('refuses a corrupt persisted manifest without rewriting it %#', async (manifestValue) => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('corrupt-record'), archive())
    const database = f.database()
    try { database.prepare('UPDATE releases SET manifest=? WHERE id=?').run(manifestValue, draft.id) }
    finally { database.close() }
    expect(() => f.store.get(draft.id, author)).toThrow(expect.objectContaining({ code: 'corrupt-storage', status: 500 }))
  })

  it('refuses a persisted release whose search identity disagrees with its verified manifest', async () => {
    const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('mismatched-record'), archive())
    const database = f.database()
    try { database.prepare('UPDATE releases SET name=? WHERE id=?').run('another-release', draft.id) }
    finally { database.close() }
    expect(() => f.store.get(draft.id, author)).toThrow(expect.objectContaining({ code: 'corrupt-storage', status: 500 }))
  })

  it('lists administrator memberships and refuses missing teams or missing publication identities', async () => {
    const f = await fixture()
    expect(f.store.identity(admin)).toEqual({ accountId: admin.id, admin: true,
      publishers: [{ id: f.publisher, title: 'Production team' }] })
    const missing = parseMarketPublisherId('0'.repeat(32))
    await expect(f.store.upload(author, missing, key('missing-team-key'), archive()))
      .rejects.toMatchObject({ code: 'publisher-required', status: 403 })
    expect(() => f.store.get(parseMarketPublicationId('0'.repeat(32)), author))
      .toThrow(expect.objectContaining({ code: 'not-found', status: 404 }))
  })

  it.each(['', 'x'.repeat(101), Buffer.from('team')])('refuses a corrupt persisted team title %#', async (title) => {
    const f = await fixture(), database = f.database()
    try { database.prepare('UPDATE publishers SET title=? WHERE id=?').run(title, f.publisher) }
    finally { database.close() }
    expect(() => f.store.identity(admin)).toThrow(expect.objectContaining({ code: 'corrupt-storage', status: 500 }))
  })

  it.each([{ revision: 0, note: '' }, { revision: 1.5, note: '' }, { revision: 1, note: 'x'.repeat(2001) }])(
    'refuses an invalid moderation revision or note without changing a draft %#', async ({ revision, note }) => {
      const f = await fixture(), draft = await f.store.upload(author, f.publisher, key('invalid-review-key'), archive())
      await expect(f.store.transition(author, draft.id, revision, 'submit', note))
        .rejects.toMatchObject({ code: 'invalid-review', status: 400 })
      expect(f.store.get(draft.id, author)).toEqual(draft)
    },
  )

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

  it('restricts invitations and creator searches to the current account memberships', async () => {
    const f = await fixture()
    await expect(f.store.invite(author, 'Unauthorized team', reader.id)).rejects.toMatchObject({ code: 'admin-required', status: 403 })
    await expect(f.store.invite(admin, ' ', reader.id)).rejects.toMatchObject({ code: 'invalid-publisher', status: 400 })
    expect(f.store.identity(author)).toEqual({ accountId: author.id, admin: false,
      publishers: [{ id: f.publisher, title: 'Production team' }] })
    const other = await f.store.invite(admin, 'Reader team', reader.id)
    const own = await f.store.upload(author, f.publisher, key('author-private-draft'), archive())
    const separate = await f.store.upload(reader, other, key('reader-private-draft'), archive())
    expect(f.store.list(author, { q: '', mine: true })).toEqual([own])
    expect(f.store.list(reader, { q: '', mine: true })).toEqual([separate])
    expect(f.store.list(admin, { q: '', mine: true }).map(item => item.id).sort()).toEqual([own.id, separate.id].sort())
    expect(() => f.store.list(null, { q: '', mine: true })).toThrow(expect.objectContaining({ code: 'login-required' }))
    expect(() => f.store.list(admin, { q: 'x'.repeat(201), mine: true })).toThrow(expect.objectContaining({ code: 'invalid-query' }))
    expect(f.store.list(author, { q: 'missing-scene', mine: true })).toEqual([])
  })

  it('resubmits a rejected draft explicitly and refuses duplicate publication versions', async () => {
    const f = await fixture(), bytes = archive()
    const draft = await f.store.upload(author, f.publisher, key('review-rejected-draft'), bytes)
    await expect(f.store.upload(author, f.publisher, key('duplicate-version-key'), bytes)).rejects.toMatchObject({ code: 'version-exists', status: 409 })
    await f.store.transition(author, draft.id, 1, 'submit', '')
    const rejected = await f.store.transition(admin, draft.id, 2, 'reject', 'Revise the scene.')
    expect(rejected).toMatchObject({ status: 'rejected', revision: 3, reviewNote: 'Revise the scene.' })
    expect(await f.store.transition(author, draft.id, 3, 'submit', 'Revised.')).toMatchObject({ status: 'pending', revision: 4 })
    await expect(f.store.transition(author, draft.id, 4, 'submit', '')).rejects.toMatchObject({ code: 'invalid-transition', status: 409 })
    expect(await f.store.transition(admin, draft.id, 4, 'approve', 'Ready.')).toMatchObject({ status: 'published', revision: 5 })
    expect(f.store.list(null, { q: 'missing-scene', mine: false })).toEqual([])
    expect(f.store.get(draft.id, null)).toMatchObject({ status: 'published', revision: 5 })
  })

  it('rejects invalid catalog limits and paths before opening storage', async () => {
    const f = await fixture()
    for (const change of [{ root: 'relative-catalog' }, { maxReleases: 0 }, { maxActiveUploads: 0 },
      { jsonRequestBytes: 0 }, { jsonResponseBytes: 0 }, { catalogLimit: 101 }, { limits: { ...limits, recordBytes: 0 } }]) {
      await expect(MuseMarketCatalog.open({ ...f.config, ...change })).rejects.toMatchObject({ code: 'invalid-policy', status: 400 })
    }
    expect(f.store.identity(author).publishers).toEqual([{ id: f.publisher, title: 'Production team' }])
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
