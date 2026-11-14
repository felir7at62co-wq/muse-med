/** Episode hash reads retain the caller's handle and respect its offset and cancellation. */
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hashEpisodeFileHandle } from '../src/episode-file-hash.ts'

it.each([undefined, new AbortController().signal])('hashes all remaining bytes and leaves the handle open: %s', async (signal) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-episode-hash-'))
  try {
    const path = join(root, 'input'), content = Buffer.alloc(65_537, 0xa5)
    await writeFile(path, Buffer.concat([Buffer.from('prefix'), content]))
    const file = await open(path, 'r')
    try {
      await file.read(Buffer.alloc(6), 0, 6, null)
      expect(await hashEpisodeFileHandle(file, signal)).toEqual({
        bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),
      })
      expect((await file.stat()).size).toBe(content.length + 6)
      expect(await hashEpisodeFileHandle(file, signal)).toEqual({ bytes: 0, sha256: createHash('sha256').digest('hex') })
    } finally { await file.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects cancellation before consuming bytes or closing the caller handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-episode-hash-'))
  try {
    const path = join(root, 'input')
    await writeFile(path, 'original')
    const file = await open(path, 'r'), controller = new AbortController(), reason = new Error('Stop hashing')
    try {
      controller.abort(reason)
      await expect(hashEpisodeFileHandle(file, controller.signal)).rejects.toBe(reason)
      const first = Buffer.alloc(1)
      expect((await file.read(first, 0, 1, null)).bytesRead).toBe(1)
      expect(first.toString()).toBe('o')
    } finally { await file.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
