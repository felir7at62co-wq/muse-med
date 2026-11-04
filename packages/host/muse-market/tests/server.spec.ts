import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MuseMarketCatalog } from '../src/server.ts'
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
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-')); roots.push(root)
  const store = await MuseMarketCatalog.open({ root, limits, allowedPlugins: [], maxReleases: 20, maxActiveUploads: 2 }); stores.push(store)
  return { root, store, publisher: await store.invite(admin, 'Production team', author.id) }
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
