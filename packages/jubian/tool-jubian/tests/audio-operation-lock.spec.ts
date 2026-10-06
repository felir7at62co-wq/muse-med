import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertNoAudioDeletion, withAudioDeletionLock } from '../src/audio-operation-lock.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-audio-exclusion-'))
  await mkdir(join(root, 'video_tasks'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('project audio exclusion', () => {
  it('propagates filesystem errors instead of treating an unreadable parent as idle', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'owned')
    await expect(assertNoAudioDeletion(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(withAudioDeletionLock(file, 2708, async () => 'unreachable')).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await readFile(file, 'utf8')).toBe('owned')
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
