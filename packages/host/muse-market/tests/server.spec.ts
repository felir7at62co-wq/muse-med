/** Durable cloud identity, visibility, archive integrity and cross-connection moderation. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rename, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuseMarketCatalog } from '../src/server.ts'
import type { MarketServerConfig } from '../src/server.ts'
import { MarketCloudError, parseMarketAccountId, parseMarketPublication, parseMarketPublicationId,
  parseMarketUploadRequestId } from '../src/cloud-protocol.ts'
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
