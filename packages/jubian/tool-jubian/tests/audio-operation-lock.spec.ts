import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertNoAudioDeletion, withAudioDeletionLock } from '../src/audio-operation-lock.ts'

const access = vi.hoisted(() => ({ path: '', openPath: '', error: Object.assign(new Error('audio lock access denied'), { code: 'EACCES' }) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (args[0] === access.openPath) throw access.error
    return await actual.open(...args)
  }, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (args[0] === access.path) throw access.error
    return await actual.lstat(...args)
  } }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-audio-exclusion-'))
  await mkdir(join(root, 'video_tasks'))
})
afterEach(async () => { access.path = ''; access.openPath = ''; await rm(root, { recursive: true, force: true }) })

describe('project audio exclusion', () => {
  it('preserves a lock creation failure without admitting the guarded operation', async () => {
    access.openPath = join(root, '.audio-asset-delete.lock')
    const operation = vi.fn(async () => 'unreachable')
    await expect(withAudioDeletionLock(root, 2708, operation)).rejects.toBe(access.error)
    expect(operation).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['video_tasks'])
  })
  // Windows reports ENOENT for a child of a regular file; ENOTDIR is a POSIX filesystem result.
  it.skipIf(process.platform === 'win32')('propagates a non-directory parent without changing its file', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'owned')
    await expect(assertNoAudioDeletion(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(withAudioDeletionLock(file, 2708, async () => 'unreachable')).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await readFile(file, 'utf8')).toBe('owned')
  })

  it('propagates metadata permission failure for a valid project instead of reporting an idle writer', async () => {
    access.path = join(root, '.audio-asset-delete.lock')
    await expect(assertNoAudioDeletion(root)).rejects.toBe(access.error)
    expect(await readdir(root)).toEqual(['video_tasks'])
  })

  it('refuses an existing lock directory before admitting the guarded operation', async () => {
    const directory = join(root, '.audio-asset-delete.lock')
    await mkdir(directory)
    await writeFile(join(directory, 'retained.txt'), 'other owner')
    const operation = vi.fn(async () => 'unreachable')
    await expect(withAudioDeletionLock(root, 2708, operation)).rejects.toThrow('writer holds a lock')
    expect(operation).not.toHaveBeenCalled()
    expect(await readFile(join(directory, 'retained.txt'), 'utf8')).toBe('other owner')
    expect((await readdir(root)).sort()).toEqual(['.audio-asset-delete.lock', 'video_tasks'])
  })

  it('retains another writer lock and removes only locks acquired by this operation', async () => {
    const bible = join(root, '.project-bible.lock')
    await writeFile(bible, 'other writer')
    await expect(withAudioDeletionLock(root, 2708, async () => 'unreachable')).rejects.toThrow('writer holds a lock')
    expect(await readFile(bible, 'utf8')).toBe('other writer')
    expect((await readdir(root)).sort()).toEqual(['.project-bible.lock', 'video_tasks'])
  })

  it('releases both owned locks when the guarded operation fails', async () => {
    const failure = new Error('readback failed')
    await expect(withAudioDeletionLock(root, 2708, async () => { throw failure })).rejects.toBe(failure)
    await expect(assertNoAudioDeletion(root)).resolves.toBeUndefined()
    expect(await readdir(root)).toEqual(['video_tasks'])
  })

  it('reports a lost lock during cleanup and releases the other owned lock', async () => {
    await expect(withAudioDeletionLock(root, 2708, async () => {
      await unlink(join(root, '.project-bible.lock'))
      return 'completed'
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual(['video_tasks'])
  })
})
