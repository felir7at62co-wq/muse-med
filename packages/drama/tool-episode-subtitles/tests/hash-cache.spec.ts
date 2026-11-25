/** Digests are read again only after a file's stat changes, and probes of unchanged media start no process. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as media from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { afterEach, expect, it, vi } from 'vitest'
import { HASH_CACHE_FILE, HashCache } from '../src/hash-cache.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function cacheRoot() {
  const root = await mkdtemp(join(tmpdir(), 'muse-hash-cache-'))
  roots.push(root)
  return root
}

it('persists digests by stat and memoizes probes by content', async () => {
  const root = await cacheRoot()
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

it('rebuilds malformed cache data and reports a directory mistakenly occupying the cache path', async () => {
  const root = await cacheRoot()
  const file = join(root, 'shot.mp4')
  const cachePath = join(root, HASH_CACHE_FILE)
  await writeFile(file, 'picture bytes')
  const before = await stat(file)
  const expected = createHash('sha256').update('picture bytes').digest('hex')
  const row = { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino }
  for (const data of ['{', 'null', '{}', JSON.stringify({ files: { [file]: { ...row, sha256: 'wrong' }, incomplete: null }, probes: { ignored: 42 } })]) {
    await writeFile(cachePath, data)
    const cache = await HashCache.load(root)
    expect(await cache.sha256(file)).toBe(expected)
  }
  await rm(cachePath)
  await mkdir(cachePath)
  await expect(HashCache.load(root)).rejects.toMatchObject({ code: 'EISDIR' })
})

it('preserves the other writer’s digests and skips publishing a clean cache', async () => {
  const root = await cacheRoot()
  const cachePath = join(root, HASH_CACHE_FILE)
  const [first, second] = await Promise.all([HashCache.load(root), HashCache.load(root)])
  await first.save()
  await expect(readFile(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
  const picture = join(root, 'picture.mp4'), audio = join(root, 'audio.wav')
  await Promise.all([writeFile(picture, 'picture bytes'), writeFile(audio, 'audio bytes')])
  const [pictureSha, audioSha] = await Promise.all([first.sha256(picture), second.sha256(audio)])
  await Promise.all([first.save(), second.save()])
  const persisted: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
  expect(persisted).toMatchObject({ files: { [picture]: { sha256: pictureSha }, [audio]: { sha256: audioSha } } })
})

it('only caches successful probes and forwards commands with no input file unchanged', async () => {
  const root = await cacheRoot()
  const file = join(root, 'shot.mp4')
  await writeFile(file, 'picture bytes')
  const cache = await HashCache.load(root)
  const run = vi.fn<media.MediaToolkit['channel']['run']>().mockResolvedValue({ code: 0, stdout: 'probe', stderr: '' })
  const toolkit = cache.memoizeProbes({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run } })
  await toolkit.channel.run('ffmpeg', ['-version'])
  await toolkit.channel.run('ffprobe', [])
  expect(run.mock.calls).toEqual([['ffmpeg', ['-version']], ['ffprobe', []]])
  run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'try again' })
  await expect(toolkit.channel.run('ffprobe', [file])).resolves.toMatchObject({ code: 1, stderr: 'try again' })
  await expect(toolkit.channel.run('ffprobe', [file])).resolves.toMatchObject({ code: 0, stdout: 'probe' })
  await toolkit.channel.run('ffprobe', [file])
  expect(run).toHaveBeenCalledTimes(4)
})

it('coalesces concurrent media reads and retries when the file changes during hashing', async () => {
  const root = await cacheRoot()
  const file = join(root, 'shot.mp4')
  await writeFile(file, 'old')
  const cache = await HashCache.load(root)
  const digest = vi.spyOn(media, 'fileSha256').mockImplementationOnce(async () => {
    await writeFile(file, 'replacement picture bytes')
    return createHash('sha256').update('old').digest('hex')
  })
  try {
    await expect(Promise.all([cache.sha256(file), cache.sha256(file)])).rejects.toThrow('changed while it was being read')
    expect(digest).toHaveBeenCalledTimes(1)
    await expect(cache.sha256(file)).resolves.toBe(createHash('sha256').update('replacement picture bytes').digest('hex'))
    expect(digest).toHaveBeenCalledTimes(2)
  } finally {
    digest.mockRestore()
  }
})
