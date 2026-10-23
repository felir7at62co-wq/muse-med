/** Metadata failures remain errors rather than erasing project music feedback. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readProjectMusicFeedback } from '../src/preferences.ts'

const fault = vi.hoisted((): { error: unknown } => ({ error: undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (fault.error !== undefined) throw fault.error
    return await actual.lstat(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  fault.error = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  Object.assign(new Error('metadata access denied'), { code: 'EACCES' }),
  new Error('metadata unavailable'),
  'metadata channel unavailable',
])('retains the original metadata failure before reading feedback (%s)', async (error) => {
  const project = await mkdtemp(join(tmpdir(), 'music-feedback-metadata-'))
  roots.push(project)
  fault.error = error
  await expect(readProjectMusicFeedback(project, new AbortController().signal)).rejects.toBe(error)
})
