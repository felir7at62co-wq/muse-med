/** Missing journal paths retain ancestor errors and descriptor reads retain platform semantics. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readEpisodeBytes, readEpisodeStateSnapshot } from '../src/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'episode-journal-ancestor-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'missing', 'nested', 'journal.json') }
}

it('finds an existing directory above multiple absent journal ancestors', async () => {
  const f = await fixture()
  expect(await readEpisodeBytes(f.path, 1024)).toBeUndefined()
  expect(await files.readdir(f.root)).toEqual([])
})

it('rejects a file ancestor even when journal inspection reports ENOENT', async () => {
  const f = await fixture(), path = join(f.root, 'file', 'journal.json')
  await writeFile(dirname(path), 'retained ancestor')
  const missing = Object.assign(new Error('Journal unavailable'), { code: 'ENOENT' })
  const lstat = vi.spyOn(files, 'lstat').mockRejectedValueOnce(missing)
  try {
    await expect(readEpisodeBytes(path, 1024)).rejects.toMatchObject({
      message: 'Episode journal path has a non-directory parent', cause: missing,
    })
  } finally { lstat.mockRestore() }
  expect(await files.readFile(dirname(path), 'utf8')).toBe('retained ancestor')
})

it.each(['non-error', 'without-code', 'denied', 'missing-root'] as const)(
  'preserves a %s ancestor inspection failure', async (kind) => {
    const f = await fixture()
    const failure = kind === 'non-error' ? 'Ancestor failure' : kind === 'without-code' ? new Error('Ancestor failure')
      : Object.assign(new Error('Ancestor failure'), { code: kind === 'denied' ? 'EACCES' : 'ENOENT' })
    const stat = vi.spyOn(files, 'stat').mockRejectedValue(failure)
    try { await expect(readEpisodeBytes(f.path, 1024)).rejects.toBe(failure) }
    finally { stat.mockRestore() }
  },
)

it('reads and bounds descriptor-based state observations independently of Windows path checks', async () => {
  const f = await fixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('Expected process platform descriptor')
  await mkdir(dirname(f.path), { recursive: true })
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    expect(await readEpisodeStateSnapshot(f.path, 4)).toBeUndefined()
    await writeFile(f.path, '{}')
    expect(await readEpisodeStateSnapshot(f.path, 2)).toEqual({})
    await expect(readEpisodeStateSnapshot(f.path, 1)).rejects.toThrow('bounded regular file')
    await expect(readEpisodeStateSnapshot(f.root, 1024)).rejects.toThrow('bounded regular file')
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it.each(['non-error', 'without-code', 'denied', 'symlink-loop'] as const)(
  'retains a %s descriptor-open failure', async (kind) => {
    const f = await fixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('Expected process platform descriptor')
    const failure = kind === 'non-error' ? 'State failure' : kind === 'without-code' ? new Error('State failure')
      : Object.assign(new Error('State failure'), { code: kind === 'denied' ? 'EACCES' : 'ELOOP' })
    const open = vi.spyOn(files, 'open').mockRejectedValueOnce(failure)
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
      if (kind === 'symlink-loop') {
        await expect(readEpisodeStateSnapshot(f.path, 1024)).rejects.toMatchObject({
          message: 'Episode state must be a bounded regular file', cause: failure,
        })
      } else await expect(readEpisodeStateSnapshot(f.path, 1024)).rejects.toBe(failure)
    } finally { Object.defineProperty(process, 'platform', descriptor); open.mockRestore() }
  },
)
