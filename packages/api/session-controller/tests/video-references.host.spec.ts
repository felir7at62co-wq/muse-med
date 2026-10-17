/** Authenticated video reads require workspace containment or an exact recorded delivery. */
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
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
  const events = new Map<number, { type: string; data: unknown }>([[7, { type: 'deliverables/presented', data: { files: [{ path: 'clip.mp4' }] } }]])
  const readEvent = vi.fn(async (request: { sessionId: string; seq: number; before?: number; after?: number }, _signal?: AbortSignal) => {
    const target = events.get(request.seq)
    if (!target) throw new SessionQueryError('fixture event missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
    return { target }
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  // The route is a contribution of the existing session media owner.
  expect('SessionVideoReferences' in media).toBe(true)
  const video = Reflect.get(media, 'SessionVideoReferences')
  const videoFiber = ctx.plugin(video, { maxFileBytes: 100, chunkBytes: 3, maxStreams: 1 })
  await videoFiber.await()
  const file = join(root, 'clip.mp4')
  await writeFile(file, Uint8Array.from({ length: 10 }, (_, index) => index))
  return { root, file, fs: ctx.fs, ctx, videoFiber, unregister, events, readEvent,
    query: (query: URLSearchParams, init?: RequestInit) => {
      if (!handler) throw new Error('video route missing')
      return handler(new Request(`http://localhost/api/video?${query}`, init))
    },
    call: (path = 'clip.mp4', init?: RequestInit, session = 'owner-session', version?: string) => {
      if (!handler) throw new Error('video route missing')
      const query = new URLSearchParams({ sessionId: session, path })
      if (version !== undefined) query.set('version', version)
      return handler(new Request(`http://localhost/api/video?${query}`, init))
    },
  }
}

function deliveryQuery(seq = '7', index = '0'): URLSearchParams {
  return new URLSearchParams({ sessionId: 'owner-session', presentedSeq: seq, presentedIndex: index })
}

it('streams only the recorded delivery path outside the workspace with the same Range and HEAD behavior', async () => {
  const h = await mount()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-presented-video-'))
  roots.push(outside)
  const file = join(outside, '剪辑 #1.mp4')
  await writeFile(file, Uint8Array.from({ length: 10 }, (_, index) => index))
  const read = vi.spyOn(h.fs, 'readByteRange')
  const whole = vi.spyOn(h.fs, 'readBytes')
  for (const path of [file, join('..', outside.split(/[\\/]/).at(-1)!, '剪辑 #1.mp4')]) {
    h.events.set(7, { type: 'deliverables/presented', data: { files: [{ path: 'unused.mp4' }, { path }] } })
    const response = await h.query(deliveryQuery('7', '1'), { headers: { range: 'bytes=2-5' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4, 5])
    expect((await h.call(path)).status).toBe(403)
  }
  const count = read.mock.calls.length
  const head = await h.query(deliveryQuery('7', '1'), { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe('10')
  expect(head.body).toBeNull()
  expect(read).toHaveBeenCalledTimes(count)
  expect(whole).not.toHaveBeenCalled()
  expect(read.mock.calls.every(([, range]) => range.length <= 3)).toBe(true)
  expect(h.readEvent).toHaveBeenCalledWith({ sessionId: 'owner-session', seq: 7, before: 0, after: 0 }, expect.any(AbortSignal))
})

it.each([
  'sessionId=owner-session&presentedSeq=7', 'sessionId=owner-session&presentedIndex=0',
  'sessionId=owner-session&presentedSeq=&presentedIndex=0', 'sessionId=owner-session&presentedSeq=-1&presentedIndex=0',
  'sessionId=owner-session&presentedSeq=1.5&presentedIndex=0', 'sessionId=owner-session&presentedSeq=9007199254740992&presentedIndex=0',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=-1', 'sessionId=owner-session&presentedSeq=7&presentedIndex=0.5',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=9007199254740992', 'sessionId=owner-session&presentedSeq=7&presentedIndex=',
  'sessionId=owner-session&presentedSeq=7&presentedSeq=8&presentedIndex=0',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=0&presentedIndex=1',
  'sessionId=owner-session&sessionId=other&presentedSeq=7&presentedIndex=0',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=0&version=a&version=b',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=0&path=clip.mp4',
  'sessionId=owner-session&presentedSeq=7&presentedIndex=0&path=',
])('refuses incomplete, invalid, duplicate, or mixed delivery coordinates before I/O: %s', async (query) => {
  const h = await mount()
  const stat = vi.spyOn(h.ctx.sessionPersistence, 'stat')
  const read = vi.spyOn(h.fs, 'readByteRange')
  expect((await h.query(new URLSearchParams(query))).status).toBe(400)
  expect(stat).not.toHaveBeenCalled()
  expect(h.readEvent).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('refuses missing Sessions, missing events, other event types, absent indexes, and malformed delivery paths', async () => {
  const h = await mount()
  const read = vi.spyOn(h.fs, 'readByteRange')
  const missing = deliveryQuery()
  missing.set('sessionId', 'missing')
  expect((await h.query(missing)).status).toBe(404)
  expect(h.readEvent).not.toHaveBeenCalled()
  expect((await h.query(deliveryQuery('8'))).status).toBe(404)
  expect((await h.query(deliveryQuery('7', '1'))).status).toBe(404)
  for (const event of [
    { type: 'user/message', data: { files: [{ path: h.file }] } },
    ...[null, 'bad', {}, { files: 'bad' }, { files: [null] }, { files: ['bad'] },
      { files: [{}] }, { files: [{ path: 123 }] }, { files: [{ path: ' ' }] }, { files: [{ path: 'bad\0.mp4' }] }]
      .map(data => ({ type: 'deliverables/presented', data })),
  ]) {
    h.events.set(7, event)
    expect((await h.query(deliveryQuery())).status).toBe(404)
  }
  expect(read).not.toHaveBeenCalled()
})

it('applies source, container, version, and size checks to declared deliveries before byte reads', async () => {
  const h = await mount()
  const read = vi.spyOn(h.fs, 'readByteRange')
  for (const [path, status] of [['missing.mp4', 404], ['directory.mp4', 403], ['secret.txt', 415]] as const) {
    if (path === 'directory.mp4') await mkdir(join(h.root, path))
    if (path === 'secret.txt') await writeFile(join(h.root, path), 'secret')
    h.events.set(7, { type: 'deliverables/presented', data: { files: [{ path }] } })
    expect((await h.query(deliveryQuery())).status).toBe(status)
  }
  h.events.set(7, { type: 'deliverables/presented', data: { files: [{ path: h.file }] } })
  const stale = deliveryQuery()
  stale.set('version', 'stale-version')
  expect((await h.query(stale)).status).toBe(409)
  await writeFile(h.file, Buffer.alloc(101))
  expect((await h.query(deliveryQuery())).status).toBe(413)
  expect(read).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('refuses final delivery symlinks before resolving or reading their target (POSIX symlink privileges)', async () => {
  const h = await mount()
  const link = join(h.root, 'linked.mp4')
  await symlink(h.file, link)
  h.events.set(7, { type: 'deliverables/presented', data: { files: [{ path: link }] } })
  const resolve = vi.spyOn(h.fs, 'resolve')
  const read = vi.spyOn(h.fs, 'readByteRange')
  expect((await h.query(deliveryQuery())).status).toBe(403)
  expect(resolve).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('cancels and awaits pending delivery history during disposal without starting filesystem reads', async () => {
  const h = await mount()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  h.readEvent.mockImplementationOnce(async (_request, signal) => {
    signal?.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    return { target: { type: 'deliverables/presented', data: { files: [{ path: h.file }] } } }
  })
  const lstat = vi.spyOn(h.fs, 'lstat'), read = vi.spyOn(h.fs, 'readByteRange')
  const request = h.query(deliveryQuery())
  await entered.promise
  const disposing = h.videoFiber.dispose()
  let settled = false
  void disposing.then(() => { settled = true })
  try {
    await cancelled.promise
    await Promise.resolve()
    expect(settled).toBe(false)
  } finally { release.resolve(undefined) }
  expect((await request).status).toBe(499)
  await disposing
  expect(lstat).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(h.unregister).toHaveBeenCalledOnce()
})

it('maps history lookup errors without exposing file paths', async () => {
  const h = await mount()
  for (const [code, status] of [['SESSION_QUERY_SESSION_NOT_FOUND', 404], ['SESSION_QUERY_CORRUPT_SESSION', 500]] as const) {
    h.readEvent.mockRejectedValueOnce(new SessionQueryError('/private/history', code))
    const response = await h.query(deliveryQuery())
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('presented video unavailable')
  }
})

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
