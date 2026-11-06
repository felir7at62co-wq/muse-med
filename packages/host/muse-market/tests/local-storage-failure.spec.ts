/** A destination metadata failure must propagate before extraction or ledger mutation. */
import type { PathLike, StatOptions } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MuseMarketLocal } from '../src/local.ts'
import { marketDigest, readMarketPackage } from '../src/package.ts'
import type { MarketRelease } from '../src/types.ts'

const failure = vi.hoisted(() => ({
  destination: undefined as string | undefined,
  error: Object.assign(new Error('Access denied for fixture package destination'), { code: 'EACCES' }),
}))

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat(path: PathLike, options?: StatOptions) {
      if (path === failure.destination) return Promise.reject(failure.error)
      return actual.lstat(path, options)
    },
  }
})

it('propagates the exact destination access error and leaves an empty installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-market-storage-denied-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const limits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 32 }
  const archive = await readFile(new URL('./fixtures/handoff/storyboard-starter-1.0.0.zip', import.meta.url))
  const sha256 = marketDigest(archive)
  const release: MarketRelease = {
    id: sha256 as MarketRelease['id'], publisherId: '0'.repeat(16) as MarketRelease['publisherId'],
    publisher: 'Local', status: 'draft', revision: 1, reviewNote: '', createdAt: '2026-11-02T00:00:00.000Z',
    bytes: archive.byteLength, sha256, manifest: readMarketPackage(archive, limits, []).manifest,
  }
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] })
  await local.ready()
  failure.destination = local.directory(release)
  try { await expect(local.install(release, archive)).rejects.toBe(failure.error) }
  finally { failure.destination = undefined }
  expect(await local.list()).toEqual([])
  expect(await readdir(join(root, 'packages'))).toEqual([])
  expect(await readdir(root)).toEqual(['packages'])
})
