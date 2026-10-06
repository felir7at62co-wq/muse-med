import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPreparedJson } from '../src/prepared-file.ts'

let root: string
const key = 'a'.repeat(64)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-prepared-read-'))
  await mkdir(join(root, 'video_tasks'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('canonical prepared preview reads', () => {
  it('refuses a directory occupying the canonical preview filename', async () => {
    const path = join(root, 'video_tasks', `${key}.storyboard-edit.prepared.json`)
    await mkdir(path)
    await expect(readPreparedJson(root, key, path, 'storyboard-edit')).rejects.toThrow('regular file')
  })
  it.each(['missing', 'invalid JSON'])('reports an unreadable canonical preview: %s', async (reason) => {
    const path = join(root, 'video_tasks', `${key}.storyboard-edit.prepared.json`)
    if (reason === 'invalid JSON') await writeFile(path, '{')
    await expect(readPreparedJson(root, key, path, 'storyboard-edit')).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Cannot read canonical prepared preview',
    })
  })

  it('reads the canonical operation and refuses another path or key', async () => {
    const path = join(root, 'video_tasks', `${key}.storyboard-edit.prepared.json`)
    await writeFile(path, '{"version":1}')
    await expect(readPreparedJson(root, key, path, 'storyboard-edit')).resolves.toEqual({ version: 1 })
    await expect(readPreparedJson(root, 'invalid', path, 'storyboard-edit')).rejects.toThrow('path/key mismatch')
    await expect(readPreparedJson(root, key, path, 'storyboard-delete')).rejects.toThrow('path/key mismatch')
  })
})
