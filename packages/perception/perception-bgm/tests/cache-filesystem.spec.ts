/** Cache errors and publication races retain unrelated files and verify the concurrent winner. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadTrack } from '../src/catalog.ts'
import type { CatalogConfig } from '../src/types.ts'

const failures = vi.hoisted(() => ({ path: '', mode: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === failures.path && failures.mode === 'stat-denied') throw Object.assign(new Error('cache access denied'), { code: 'EACCES' })
      return await actual.lstat(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]) === failures.path && failures.mode === 'unlink-denied') throw Object.assign(new Error('cache unlink denied'), { code: 'EACCES' })
      await actual.unlink(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === failures.path && failures.mode.startsWith('rename-')) {
        if (failures.mode === 'rename-winner') await actual.writeFile(args[1], await actual.readFile(args[0]))
        throw Object.assign(new Error('cache publication denied'), { code: 'EPERM' })
      }
      await actual.rename(...args)
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    if (String(args[0]) === failures.path && failures.mode === 'grew') {
      failures.mode = ''
      actual.appendFileSync(args[0], 'changed concurrently')
    }
    return actual.createReadStream(...args)
  } }
})
const roots: string[] = []
afterEach(async () => {
  failures.path = ''; failures.mode = ''
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'bgm-cache-'))
  roots.push(cacheDir)
  const bytes = Buffer.from('verified audio'), hex = createHash('sha256').update(bytes).digest('hex')
  const track = { id: `sha256:${hex}`, sha256: `sha256:${hex}`, name: 'track.mp3', bytes: bytes.length,
    url: `https://bgm.invalid/bgm/tracks/${hex}.mp3`, valence: 5, arousal: 5, moods: [] }
  const config: CatalogConfig = { cacheDir, catalogUrl: 'https://bgm.invalid/catalog.json',
    networkTimeoutMs: 60_000, maxCatalogBytes: 1_024, maxTrackBytes: 1_024 }
  const fetch = vi.fn(async (input: string) => input === config.catalogUrl
    ? new Response(JSON.stringify({ version: 1, tracks: [track] })) : new Response(bytes))
  vi.stubGlobal('fetch', fetch)
  const path = join(cacheDir, `${hex}.mp3`)
  failures.path = path
  await writeFile(join(cacheDir, 'unrelated'), 'retained')
  return { config, path, bytes, fetch, track, run: () => downloadTrack(config, track.id, new AbortController().signal) }
}

it.each(['stat-denied', 'unlink-denied'] as const)('preserves an invalid existing cache entry when %s prevents replacement', async (mode) => {
  const f = await fixture()
  await writeFile(f.path, 'bad')
  failures.mode = mode
  await expect(f.run()).rejects.toThrow('denied')
  expect(await readFile(f.path, 'utf8')).toBe('bad')
  expect(await readdir(f.config.cacheDir)).toEqual(expect.arrayContaining(['unrelated']))
  expect(f.fetch).toHaveBeenCalledOnce()
})

it('refuses a non-file cache destination without deleting it', async () => {
  const f = await fixture()
  await mkdir(f.path)
  await expect(f.run()).rejects.toThrow('not a regular file')
  expect(await readdir(f.path)).toEqual([])
})

it('replaces bytes that grow during cache verification with a newly verified download', async () => {
  const f = await fixture()
  await writeFile(f.path, f.bytes)
  failures.mode = 'grew'
  expect(await f.run()).toMatchObject({ cached: false })
  expect(await readFile(f.path)).toEqual(f.bytes)
})

it.each(['rename-winner', 'rename-denied'] as const)('verifies any concurrent cache winner after %s and cleans its temporary directory', async (mode) => {
  const f = await fixture()
  failures.mode = mode
  if (mode === 'rename-winner') {
    expect(await f.run()).toMatchObject({ cached: true, path: f.path })
    expect(await readFile(f.path)).toEqual(f.bytes)
  } else await expect(f.run()).rejects.toThrow('publication denied')
  expect((await readdir(f.config.cacheDir)).some(name => name.startsWith('.download-'))).toBe(false)
  expect(await readFile(join(f.config.cacheDir, 'unrelated'), 'utf8')).toBe('retained')
})
