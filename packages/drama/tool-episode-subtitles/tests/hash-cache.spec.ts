/** Digests are read again only after a file's stat changes, and probes of unchanged media start no process. */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HashCache } from '../src/hash-cache.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('persists digests by stat and memoizes probes by content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-hash-cache-'))
  roots.push(root)
  const file = join(root, 'shot.mp4')
  await writeFile(file, 'first')
  const cache = await HashCache.load(root)
  const first = await cache.sha256(file)
  const run = vi.fn(async () => ({ code: 0, stdout: '{"streams":[]}', stderr: '' }))
  const toolkit = cache.memoizeProbes({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run } })
  await toolkit.channel.run('ffprobe', ['-of', 'json', file])
  await toolkit.channel.run('ffprobe', ['-of', 'json', file])
  expect(run).toHaveBeenCalledTimes(1)
  await cache.save()

  const reloaded = await HashCache.load(root)
  await writeFile(file, 'lying')
  const stamp = new Date(Date.now() - 60_000)
  await utimes(file, stamp, stamp)
  expect(await reloaded.sha256(file)).not.toBe(first)
  await writeFile(file, 'first')
  const again = await HashCache.load(root)
  await expect(again.sha256(file)).resolves.toBe(first)
})
