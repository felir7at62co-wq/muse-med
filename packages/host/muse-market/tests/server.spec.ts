import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MuseMarketCatalog, type MarketServerConfig } from '../src/server.ts'
import { createMarketPackage } from '../src/package.ts'
import type { MarketManifest } from '../src/types.ts'

const roots: string[] = []
const stores: MuseMarketCatalog[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const admin = { id: 'aaaaaaaaaaaaaaaa', username: 'admin', admin: true }
const author = { id: 'bbbbbbbbbbbbbbbb', username: 'author', admin: false }
const stranger = { id: 'cccccccccccccccc', username: 'stranger', admin: false }
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 32 }
const manifest: MarketManifest = { formatVersion: 1, kind: 'skill', name: 'script-review', title: 'Script review',
  description: 'Review a script', version: '1.0.0', category: 'script', license: 'MIT', examples: [], requirements: [],
  skills: [{ name: 'script-review', path: 'skills/script-review/SKILL.md' }] }
function archive(version = '1.0.0') {
  return createMarketPackage({ ...manifest, version }, { 'skills/script-review/SKILL.md': Buffer.from('---\nname: script-review\ndescription: Review scripts\n---\nReview the script.\n') }, limits, [])
}
async function setup(bounds: Partial<Pick<MarketServerConfig, 'maxReleases' | 'maxActiveUploads'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-')); roots.push(root)
  const config = { root, limits, allowedPlugins: [], maxReleases: 20, maxActiveUploads: 2, ...bounds }
  const store = await MuseMarketCatalog.open(config); stores.push(store)
  return { root, config, store, publisher: await store.invite(admin, 'Production team', author.id) }
}

describe('invited market publications', () => {
  it('reserves one upload per account and releases capacity idempotently', async () => {
    const { store, publisher } = await setup()
    const released = store.reserveUpload(author, publisher)
    expect(() => store.reserveUpload(author, publisher)).toThrow('upload-busy')
    released(); released()
    const active = store.reserveUpload(author, publisher)
    released()
    expect(() => store.reserveUpload(author, publisher)).toThrow('upload-busy')
    active()
    expect(() => store.reserveUpload(stranger, publisher)).toThrow('publisher-required')
  })
  it('keeps drafts private and publishes only the administrator-reviewed bytes', async () => {
    const { store, publisher } = await setup()
    await expect(store.invite(author, 'Fake', stranger.id)).rejects.toMatchObject({ code: 'admin-required' })
    await expect(store.upload(stranger, publisher, 'upload-0001', archive())).rejects.toMatchObject({ code: 'publisher-required' })
    const original = archive()
    const draft = await store.upload(author, publisher, 'upload-0001', original)
    expect(store.list(null, {})).toEqual([])
    expect(() => store.get(draft.id, stranger)).toThrow('not-found')
    await expect(store.transition(author, draft.id, draft.revision, 'approve', '')).rejects.toThrow('invalid-transition')
    const pending = await store.transition(author, draft.id, draft.revision, 'submit', '')
    await expect(store.transition(admin, draft.id, draft.revision, 'approve', '')).rejects.toThrow('revision-conflict')
    const published = await store.transition(admin, draft.id, pending.revision, 'approve', '')
    expect(store.list(null, { q: 'Production', kind: 'skill' })).toEqual([published])
    expect(Buffer.from(await store.download(published.id, stranger))).toEqual(Buffer.from(original))
    await store.transition(author, published.id, published.revision, 'withdraw', 'Maintenance')
    expect(store.list(null, {})).toEqual([])
    await expect(store.download(published.id, stranger)).rejects.toThrow('not-found')
  })

  it('makes retries idempotent while preserving immutable version identities', async () => {
    const { store, publisher } = await setup()
    const bytes = archive()
    const results = await Promise.all([store.upload(author, publisher, 'same-request', bytes), store.upload(author, publisher, 'same-request', bytes)])
    expect(results[0]?.id).toBe(results[1]?.id)
    await expect(store.upload(author, publisher, 'same-request', archive('2.0.0'))).rejects.toThrow('idempotency-conflict')
    await expect(store.upload(author, publisher, 'new-request1', bytes)).rejects.toThrow('version-exists')
  })

  it('refuses publication and download when stored bytes are modified', async () => {
    const { store, root, publisher } = await setup()
    const draft = await store.upload(author, publisher, 'upload-0001', archive())
    const pending = await store.transition(author, draft.id, 1, 'submit', '')
    await writeFile(join(root, 'blobs', `${draft.sha256}.zip`), 'corrupted')
    await expect(store.transition(admin, draft.id, pending.revision, 'approve', '')).rejects.toThrow('corrupt-storage')
    expect(store.get(draft.id, author).status).toBe('pending')
  })
})

function changeDatabase(root: string, sql: string) {
  const database = new DatabaseSync(join(root, 'market.sqlite'))
  try { database.exec(sql) } finally { database.close() }
}

it('rejects new Bot uploads and hides stored historical Bots from every active route', async () => {
  const { root, store, publisher } = await setup()
  const bot: MarketManifest = { ...manifest, kind: 'bot', skills: [], plugins: [] }
  await expect(store.upload(author, publisher, 'retired-bot', createMarketPackage(bot, {}, limits, [])))
    .rejects.toMatchObject({ code: 'skill-only' })
  expect(store.list(admin, { mine: true })).toEqual([])
  expect(() => store.list(null, { kind: 'bot' })).toThrow('invalid-query')
  const draft = await store.upload(author, publisher, 'original-skill', archive())
  const database = new DatabaseSync(join(root, 'market.sqlite'))
  try {
    database.prepare("UPDATE releases SET manifest=?,status='published' WHERE id=?").run(JSON.stringify(bot), draft.id)
    expect(store.list(null, {})).toEqual([])
    expect(store.list(admin, { mine: true })).toEqual([])
    expect(() => store.get(draft.id, admin)).toThrow('not-found')
    await expect(store.download(draft.id, author)).rejects.toThrow('not-found')
    await expect(store.transition(admin, draft.id, draft.revision, 'withdraw', '')).rejects.toThrow('not-found')
    expect(database.prepare('SELECT id FROM releases WHERE id=?').get(draft.id)?.id).toBe(draft.id)
  } finally { database.close() }
})

it('reopens the existing schema, rejects a newer schema and refuses unsafe storage configuration', async () => {
  const { root, config, store, publisher } = await setup()
  await store.close()
  const reopened = await MuseMarketCatalog.open(config); stores.push(reopened)
  expect(reopened.publishers(author)).toEqual([{ id: publisher, title: 'Production team' }])
  await reopened.close()
  changeDatabase(root, 'PRAGMA user_version=2')
  await expect(MuseMarketCatalog.open(config)).rejects.toThrow('Unsupported market schema version')

  for (const invalid of [{ ...config, root: 'relative' }, { ...config, maxReleases: 0 },
    { ...config, maxReleases: 1.5 }, { ...config, maxActiveUploads: 0 }, { ...config, maxActiveUploads: 1.5 },
    { ...config, limits: { ...limits, archiveBytes: 0 } }]) {
    await expect(MuseMarketCatalog.open(invalid)).rejects.toThrow('Invalid market configuration')
  }
  const other = join(root, 'other')
  await mkdir(other)
  const linkedRoot = join(root, 'linked-root')
  await symlink(other, linkedRoot, 'junction')
  try { await expect(MuseMarketCatalog.open({ ...config, root: linkedRoot })).rejects.toThrow('Market root cannot be a link') }
  finally { await unlink(linkedRoot) }
  const blobs = join(other, 'blobs')
  await symlink(root, blobs, 'junction')
  try { await expect(MuseMarketCatalog.open({ ...config, root: other })).rejects.toThrow('Market blobs cannot be a link') }
  finally { await unlink(blobs) }
})

it('bounds admission across publisher accounts and refuses new work after close', async () => {
  const { store, publisher } = await setup({ maxActiveUploads: 1, maxReleases: 1 })
  const otherTeam = await store.invite(admin, 'Second team', stranger.id)
  const active = store.reserveUpload(author, publisher)
  expect(() => store.reserveUpload(stranger, otherTeam)).toThrow('upload-busy')
  active()
  const other = store.reserveUpload(stranger, otherTeam)
  other()

  const bytes = archive()
  const draft = await store.upload(author, publisher, 'last-release', bytes)
  expect(await store.upload(author, publisher, 'last-release', bytes)).toEqual(draft)
  await expect(store.upload(stranger, otherTeam, 'over-capacity', archive('2.0.0'))).rejects.toMatchObject({
    code: 'catalog-full', status: 507,
  })
  await store.close()
  expect(() => store.reserveUpload(author, publisher)).toThrow('closed')
  await expect(store.invite(admin, 'Closed team', author.id)).rejects.toMatchObject({ code: 'closed', status: 503 })
})

it('validates shared content-addressed storage across independent releases and protects downloads against links', async () => {
  const { store, root, publisher } = await setup()
  const second = await store.invite(admin, 'Second team', author.id)
  const third = await store.invite(admin, 'Third team', author.id)
  const bytes = archive()
  const draft = await store.upload(author, publisher, 'first-upload', bytes)
  await expect(store.upload(author, second, 'first-upload', bytes)).rejects.toThrow('idempotency-conflict')
  const reused = await store.upload(author, second, 'second-upload', bytes)
  expect(reused.id).not.toBe(draft.id)
  expect(reused.sha256).toBe(draft.sha256)
  const blob = join(root, 'blobs', draft.sha256 + '.zip')
  await writeFile(blob, 'corrupt')
  await expect(store.upload(author, third, 'third-upload', bytes)).rejects.toMatchObject({ code: 'corrupt-storage', status: 500 })
  expect(store.list(author, { mine: true })).toHaveLength(2)

  const moved = join(root, 'corrupt-blob')
  await rename(blob, moved)
  await symlink(root, blob, 'junction')
  try { await expect(store.download(draft.id, author)).rejects.toMatchObject({ code: 'corrupt-storage', status: 500 }) }
  finally { await unlink(blob); await rename(moved, blob) }
})

it('reports filesystem write errors without recording a release', async () => {
  const { store, root, publisher } = await setup()
  const blobs = join(root, 'blobs')
  await rename(blobs, join(root, 'empty-blobs'))
  await writeFile(blobs, 'not a directory')
  await expect(store.upload(author, publisher, 'cannot-write', archive())).rejects.toSatisfy(
    (error: NodeJS.ErrnoException) => /ENOTDIR|ENOENT/.test(error.code ?? ''),
  )
  expect(store.list(admin, { mine: true })).toEqual([])
})

it('rolls back publisher invitations and release reviews if a SQLite write aborts', async () => {
  const { store, root, publisher } = await setup()
  await expect(store.invite(admin, '   ', stranger.id)).rejects.toThrow('invalid-publisher')
  await expect(store.invite(admin, 'x'.repeat(101), stranger.id)).rejects.toThrow('invalid-publisher')
  await expect(store.invite(admin, 'Invalid actor ID', 'short')).rejects.toThrow('not-found')
  changeDatabase(root, "CREATE TRIGGER deny_member BEFORE INSERT ON members BEGIN SELECT RAISE(ABORT,'fixture denied membership'); END;")
  await expect(store.invite(admin, 'Rolled back team', stranger.id)).rejects.toThrow('fixture denied membership')
  expect(store.publishers(admin)).toEqual([{ id: publisher, title: 'Production team' }])
  expect(store.publishers(stranger)).toEqual([])
  changeDatabase(root, 'DROP TRIGGER deny_member;')
  const draft = await store.upload(author, publisher, 'first-upload', archive())
  changeDatabase(root, "CREATE TRIGGER deny_review BEFORE INSERT ON reviews BEGIN SELECT RAISE(ABORT,'fixture denied review'); END;")
  await expect(store.transition(author, draft.id, draft.revision, 'submit', '')).rejects.toThrow('fixture denied review')
  expect(store.get(draft.id, author)).toEqual(draft)
  changeDatabase(root, 'DROP TRIGGER deny_review;')
  expect(await store.transition(author, draft.id, draft.revision, 'submit', '')).toMatchObject({ status: 'pending', revision: 2 })
})
