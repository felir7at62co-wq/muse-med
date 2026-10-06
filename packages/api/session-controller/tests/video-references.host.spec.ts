/** Authenticated video route reads byte windows in the addressed Session's workspace. */
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { afterEach, expect, it, vi } from 'vitest'
import * as media from '../src/media-references.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-route-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  let handler: ((request: Request) => Promise<Response>) | undefined
  const unregister = vi.fn(() => {})
  ctx.provide('connection', { fetch: { register: (entry: { fetch: typeof handler }) => {
    handler = entry.fetch
    return unregister
  } } } as never)
  ctx.provide('sessionPersistence', { stat: async (id: string) => id === 'owner-session' ? { header: { cwd: root } } : undefined } as never)
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  // The route is a contribution of the existing session media owner.
  expect('SessionVideoReferences' in media).toBe(true)
  const video = Reflect.get(media, 'SessionVideoReferences')
  const videoFiber = ctx.plugin(video, { maxFileBytes: 100, chunkBytes: 3, maxStreams: 1 })
  await videoFiber.await()
  const file = join(root, 'clip.mp4')
  await writeFile(file, Uint8Array.from({ length: 10 }, (_, index) => index))
  return { root, file, fs: ctx.fs, ctx, videoFiber, unregister,
    call: (path = 'clip.mp4', init?: RequestInit, session = 'owner-session', version?: string) => {
      if (!handler) throw new Error('video route missing')
      const query = new URLSearchParams({ sessionId: session, path })
      if (version !== undefined) query.set('version', version)
      return handler(new Request(`http://localhost/api/video?${query}`, init))
    },
  }
}

it('streams full video and bounded, suffix, and open-ended ranges without whole-file reads', async () => {
  const h = await mount()
  const whole = vi.spyOn(h.fs, 'readBytes')
  const windows = vi.spyOn(h.fs, 'readByteRange')
  for (const [range, expected, status, contentRange] of [
    [undefined, [0,1,2,3,4,5,6,7,8,9], 200, null],
    ['bytes=2-5', [2,3,4,5], 206, 'bytes 2-5/10'],
    ['bytes=-3', [7,8,9], 206, 'bytes 7-9/10'],
    ['bytes=8-', [8,9], 206, 'bytes 8-9/10'],
    ['bytes=8-999', [8,9], 206, 'bytes 8-9/10'],
  ] as const) {
    const response = await h.call('clip.mp4', range ? { headers: { range } } : {})
    expect(response.status).toBe(status)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected)
  }
  expect(whole).not.toHaveBeenCalled()
  expect(windows.mock.calls.every(([, range]) => range.length <= 3)).toBe(true)
})

it.each(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=abc', 'items=0-3'])('refuses unsatisfiable or unsupported range %s', async (range) => {
  const h = await mount()
  const response = await h.call('clip.mp4', { headers: { range } })
  expect(response.status).toBe(416)
  expect(response.headers.get('content-range')).toBe('bytes */10')
})

it('requires a stored Session and canonical workspace containment before reading', async () => {
  const h = await mount()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-video-outside-'))
  roots.push(outside)
  await writeFile(join(outside, 'outside.mp4'), 'private')
  const read = vi.spyOn(h.fs, 'readByteRange')
  expect((await h.call('clip.mp4', {}, 'missing')).status).toBe(404)
  expect((await h.call(join(outside, 'outside.mp4'))).status).toBe(403)
  expect((await h.call('../outside.mp4')).status).toBe(403)
  expect(read).not.toHaveBeenCalled()
})

it('serves HEAD metadata without body reads and rejects non-video files and directories', async () => {
  const h = await mount()
  const read = vi.spyOn(h.fs, 'readByteRange')
  const response = await h.call('clip.mp4', { method: 'HEAD' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-length')).toBe('10')
  expect(response.body).toBeNull()
  expect(read).not.toHaveBeenCalled()
  await mkdir(join(h.root, 'directory.mp4'))
  await writeFile(join(h.root, 'secret.txt'), 'secret')
  expect((await h.call('directory.mp4')).status).toBe(403)
  expect((await h.call('secret.txt')).status).toBe(415)
})

it('releases stream admission on cancellation and unregisters on disposal', async () => {
  const h = await mount()
  const first = await h.call()
  expect((await h.call()).status).toBe(429)
  await first.body!.cancel()
  const next = await h.call()
  expect(next.status).toBe(200)
  await next.body!.cancel()
  await h.ctx.fiber.dispose()
  expect(h.unregister).toHaveBeenCalledOnce()
})

it('refuses changed metadata versions and over-limit videos before reading their bytes', async () => {
  const h = await mount()
  const read = vi.spyOn(h.fs, 'readByteRange')
  expect((await h.call('clip.mp4', {}, 'owner-session', 'stale-version')).status).toBe(409)
  await writeFile(h.file, Buffer.alloc(101))
  expect((await h.call()).status).toBe(413)
  expect(read).not.toHaveBeenCalled()
})

it('ends streaming when the source changes during a filesystem window', async () => {
  const h = await mount()
  const original = h.fs.readByteRange.bind(h.fs)
  vi.spyOn(h.fs, 'readByteRange').mockImplementationOnce(async (target, range, signal) => {
    const bytes = await original(target, range, signal)
    await writeFile(h.file, Buffer.alloc(11))
    return bytes
  })
  const response = await h.call()
  await expect(response.arrayBuffer()).rejects.toThrow('Video changed during playback')
})

it('cancels a pending Session lookup and awaits it before finishing disposal', async () => {
  const h = await mount()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const original = h.ctx.sessionPersistence.stat.bind(h.ctx.sessionPersistence)
  vi.spyOn(h.ctx.sessionPersistence, 'stat').mockImplementationOnce(async (id, options) => {
    options?.signal?.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    return await original(id, options)
  })
  const read = vi.spyOn(h.fs, 'readByteRange')
  const request = h.call()
  await entered.promise
  const disposing = h.videoFiber.dispose()
  const first = await Promise.race([
    cancelled.promise.then(() => 'cancelled'),
    disposing.then(() => 'disposed'),
  ])
  release.resolve(undefined)
  const response = await request
  await disposing
  expect(first).toBe('cancelled')
  expect(response.status).toBe(499)
  expect(read).not.toHaveBeenCalled()
  expect(h.unregister).toHaveBeenCalledOnce()
  await response.body?.cancel()
})

it('refuses missing identifiers, cancelled requests, and calls retained after disposal before I/O', async () => {
  const h = await mount()
  const stat = vi.spyOn(h.ctx.sessionPersistence, 'stat')
  for (const [path, session] of [['', 'owner-session'], ['clip.mp4', ''], ['clip.mp4', 'a'.repeat(257)], ['bad\0.mp4', 'owner-session']]) {
    expect((await h.call(path, {}, session)).status).toBe(400)
  }
  const abort = new AbortController()
  abort.abort()
  const head = await h.call('clip.mp4', { method: 'HEAD', signal: abort.signal })
  expect(head.status).toBe(499)
  expect(head.body).toBeNull()
  await h.videoFiber.dispose()
  expect((await h.call()).status).toBe(499)
  expect(stat).not.toHaveBeenCalled()
})

it('rejects unavailable workspaces, absent files, and unavailable source sizes', async () => {
  const h = await mount()
  const originalSession = h.ctx.sessionPersistence.stat.bind(h.ctx.sessionPersistence)
  vi.spyOn(h.ctx.sessionPersistence, 'stat').mockImplementationOnce(async (id, options) => {
    const session = await originalSession(id, options)
    if (!session) throw new Error('fixture session missing')
    const header = { ...session.header }
    delete header.cwd
    return { ...session, header }
  })
  expect((await h.call()).status).toBe(403)
  expect((await h.call('missing.mp4')).status).toBe(404)
  const original = h.fs.stat.bind(h.fs)
  vi.spyOn(h.fs, 'stat').mockImplementationOnce(async (target, signal) => {
    const info = await original(target, signal)
    if (!info) throw new Error('fixture video missing')
    const metadata = { ...info }
    delete metadata.size
    return metadata
  })
  expect((await h.call()).status).toBe(500)
})

it('serves an empty video without reads and ignores Range when If-Range has no strong validator', async () => {
  const h = await mount()
  const response = await h.call('clip.mp4', { headers: { range: 'bytes=2-3', 'if-range': 'old-validator' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-range')).toBeNull()
  expect((await response.arrayBuffer()).byteLength).toBe(10)
  await writeFile(h.file, '')
  const read = vi.spyOn(h.fs, 'readByteRange')
  const empty = await h.call()
  expect(empty.status).toBe(200)
  expect((await empty.arrayBuffer()).byteLength).toBe(0)
  expect(read).not.toHaveBeenCalled()
  expect((await h.call('clip.mp4', { headers: { range: 'bytes=0-' } })).status).toBe(416)
})

it('maps filesystem failures and propagates unrelated metadata errors', async () => {
  const h = await mount()
  const stat = vi.spyOn(h.fs, 'stat')
  for (const [code, status] of [['FS_NOT_FOUND', 404], ['FS_NOT_REGULAR_FILE', 403], ['FS_PERMISSION_DENIED', 403],
    ['FS_SANDBOX_DENIED', 403], ['FS_TOO_LARGE', 413], ['FS_ABORTED', 499], ['FS_IO_ERROR', 500]] as const) {
    stat.mockRejectedValueOnce(new FsError('provider failure', code))
    const response = await h.call()
    expect(response.status).toBe(status)
    expect(await response.text()).toBe(code)
  }
  stat.mockRejectedValueOnce(new Error('unexpected provider failure'))
  await expect(h.call()).rejects.toThrow('unexpected provider failure')
})

it('detects source changes before a window read and empty reads from a changed provider', async () => {
  const h = await mount()
  const original = h.fs.stat.bind(h.fs)
  vi.spyOn(h.fs, 'stat').mockImplementationOnce(original).mockImplementationOnce(async (target, signal) => {
    const info = await original(target, signal)
    if (!info) throw new Error('fixture video missing')
    return { ...info, version: FsVersion('changed-before-read') }
  })
  await expect((await h.call()).arrayBuffer()).rejects.toThrow('Video changed during playback')
  vi.spyOn(h.fs, 'readByteRange').mockResolvedValueOnce(new Uint8Array())
  await expect((await h.call()).arrayBuffer()).rejects.toThrow('Video changed during playback')
})

it('aborts a streaming read and awaits provider settlement during disposal', async () => {
  const h = await mount()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const original = h.fs.readByteRange.bind(h.fs)
  vi.spyOn(h.fs, 'readByteRange').mockImplementationOnce(async (target, range, signal) => {
    signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    return original(target, range, signal)
  })
  const response = await h.call()
  const reading = response.arrayBuffer()
  const rejected = expect(reading).rejects.toThrow('Video playback disposed')
  await entered.promise
  const disposing = h.videoFiber.dispose()
  try {
    await aborted.promise
    let settled = false
    void disposing.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
  } finally { release.resolve(undefined) }
  await rejected
  await disposing
  expect(h.unregister).toHaveBeenCalledOnce()
})

it.each([false, true])('cancels metadata admission when the provider settles after abort, rejection=%s', async (reject) => {
  const h = await mount()
  const abort = new AbortController()
  const original = h.fs.stat.bind(h.fs)
  vi.spyOn(h.fs, 'stat').mockImplementationOnce(async (target, signal) => {
    const info = await original(target, signal)
    abort.abort()
    if (reject) throw new FsError('provider cancelled', 'FS_ABORTED')
    return info
  })
  const read = vi.spyOn(h.fs, 'readByteRange')
  const response = await h.call('clip.mp4', { signal: abort.signal })
  expect(response.status).toBe(499)
  expect(await response.text()).toBe('request cancelled')
  expect(read).not.toHaveBeenCalled()
})
