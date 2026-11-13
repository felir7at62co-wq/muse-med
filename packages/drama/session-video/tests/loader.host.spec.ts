/** Real Loader, local filesystem, attachment storage and FFmpeg over synthetic media only. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { FsError } from '@deepseek-ai/dsh-fs'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import SessionVideo, { type Config } from '../src/index.ts'
import type { SessionVideoSourceId } from '../src/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { sourceStateSchema } from '../src/sources.ts'

const roots: string[] = []
const contexts: Context[] = []
const readReleases: (() => void)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const release of readReleases.splice(0)) { try { release() } catch (error) { errors.push(error) } }
  try { vi.restoreAllMocks() } catch (error) { errors.push(error) }
  try { vi.unstubAllGlobals() } catch (error) { errors.push(error) }
  const disposed = await Promise.allSettled(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  for (const result of disposed) if (result.status === 'rejected') errors.push(result.reason)
  for (const root of roots.splice(0)) { try { rmSync(root, { recursive: true, force: true }) } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Session video fixture cleanup failed')
})

async function openFixture(root: string, overrides: Partial<Config> = {}, persistenceRoot?: string) {
  const routes = new Map<string, { fetch(request: Request): Response | Promise<Response> }>()
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { name: 'cordis:sessions' }, { name: 'cordis:projections' }, { name: 'cordis:query' },
    ...(persistenceRoot === undefined ? [] : [{ name: 'cordis:history', config: { root: persistenceRoot, compression: 'none' } }]),
    { name: 'cordis:fs', config: { cwd: root } }, { name: 'cordis:attachments', config: { dshHome: root } },
    { name: 'cordis:subprocess' }, { name: 'cordis:policy', config: { mode: 'danger-full-access', workspaceRoot: root } },
    { id: 'video', name: 'cordis:video', config: { analysisWidth: 64, ...overrides } },
  ]))
  const ctx = await boot('dsh', configPath, [], (host) => {
    host.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
      routes.set(route.path, route); return () => routes.delete(route.path)
    } } } as never)
    Object.assign(host.loader.builtins, { sessions: Sessions, projections: Projections, query: Query, fs: FileSystem,
      attachments: Attachments, subprocess: Subprocess, policy: SandboxPolicy, video: SessionVideo, history: JsonlPersistence })
  })
  contexts.push(ctx)
  return { ctx, routes }
}

async function fixture(overrides: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-video-loader-')); roots.push(root)
  const file = join(root, 'three-shots.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
    '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file])
  const { ctx, routes } = await openFixture(root, overrides)
  const session = ctx.sessions.create(SessionId('fixture-session'), { meta: { cwd: root } })
  const signal = new AbortController().signal
  const user = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  const tool = (name: string, args: Record<string, unknown>, value: unknown) => {
    const callId = ToolCallId(`call-${session.seq}`)
    session.append('tool/call', { turn: 1, step: 1, name, callId, arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }) }, { surfaceOp: 'append' })
  }
  return { root, file, ctx, session, signal, user, tool, routes }
}

async function localPlayback(overrides: Partial<Config> = {}) {
  const f = await fixture(overrides)
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]
  const route = f.routes.get('/api/session-video')
  if (!route || !source?.playbackUrl) throw Error('Expected a recorded local playback route')
  return { ...f, source, route, url: new URL(source.playbackUrl, 'http://localhost/') }
}

/** Hold the return of a real read so cancellation and disposal have an observable boundary. */
function holdPlaybackRead(ctx: Context) {
  const entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<undefined>()
  const settled = Promise.withResolvers<undefined>()
  const release = () => { gate.resolve(undefined) }
  readReleases.push(release)
  const read = ctx.fs.readByteRange.bind(ctx.fs)
  void entered.promise.catch(() => {})
  vi.spyOn(ctx.fs, 'readByteRange').mockImplementationOnce(async (...args) => {
    try {
      const bytes = await read(...args), signal = args[2]
      if (!signal) throw Error('Playback read has no owning cancellation signal')
      entered.resolve(signal)
      await gate.promise
      return bytes
    } catch (error) { entered.reject(error); throw error }
    finally { settled.resolve(undefined) }
  })
  return { entered: entered.promise, release, settled: settled.promise }
}

it('detects three shot intervals through the real Loader and preserves original bytes', async () => {
  const f = await fixture()
  f.user('@three-shots.mp4')
  const before = readFileSync(f.file)
  const inventory = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(inventory.complete).toBe(true)
  expect(inventory.sources).toHaveLength(1)
  const source = inventory.sources[0]!
  expect(source.status).toBe('local')
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const result = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)
  expect(result.state).toBe('ready')
  expect(result.shots.map(shot => [shot.startSeconds, shot.endSeconds])).toEqual([[0, 1], [1, 2], [2, 3]])
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).toEqual(result)
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(readFileSync(f.file)).toEqual(before)
  const route = f.routes.get('/api/session-video')!
  const response = await route.fetch(new Request(`http://localhost/${source.playbackUrl}`, { headers: { range: 'bytes=0-15' } }))
  expect(response.status).toBe(206)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(before.subarray(0, 16)))
  const fiber = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'video')?.fiber
  await fiber?.dispose()
  expect(f.routes.size).toBe(0)
})

it('resolves uploaded video attachments outside the workspace and refuses foreign source ids and stale versions', async () => {
  const f = await fixture()
  const attachment = await f.ctx.attachments.saveFile({ data: readFileSync(f.file), name: 'upload.mp4' })
  f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment }] }), { surfaceOp: 'append' })
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  expect(source).toMatchObject({ origin: 'attachment', status: 'local' })
  expect(source.path).toContain('attachments')
  expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, 'stale', f.signal)).issue).toContain('changed')
  expect((await f.ctx.sessionVideo.detect(f.session.id, brandString<SessionVideoSourceId>('foreign'), source.version!, f.signal)).state).toBe('failed')
  const route = f.routes.get('/api/session-video')!
  expect((await route.fetch(new Request(`http://localhost/${source.playbackUrl}&path=/private/other.mp4`))).status).toBe(400)
  const aborted = new AbortController(); aborted.abort(new Error('fixture cancelled'))
  await expect(f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, aborted.signal)).rejects.toThrow('fixture cancelled')
})

it('downloads only a successful logged Jubian URL through the bounded existing seam, then detects the real video', async () => {
  const f = await fixture()
  const url = 'https://101.aigc.jubianai.net/session-video-fixture.mp4'
  f.tool('jubian_video', { method: 'subtasks', task_id: 7 }, { subtasks: { rows: [{ parent_task_id: 7, status: 'succeeded', video_url: url }] } })
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  expect(source).toMatchObject({ status: 'remote-only', playbackUrl: url, remoteUrl: url })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe(url)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return new Response(readFileSync(f.file))
  })
  vi.stubGlobal('fetch', fetch)
  const result = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)
  expect(result.state).toBe('ready')
  expect(result.shots).toHaveLength(3)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]?.status).toBe('local')
})

it('reports executable failure and source mutation without caching invented cut ranges', async () => {
  const f = await fixture()
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const resolve = vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockRejectedValueOnce(new Error('fixture missing ffprobe'))
  expect(await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).toMatchObject({ state: 'failed', shots: [], issue: 'fixture missing ffprobe' })
  resolve.mockRestore()
  const original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    if (/^ffmpeg(?:\.exe)?$/iu.test(basename(String(spec.argv[0])))) appendFileSync(f.file, 'fixture-version-change')
    return original(spec)
  })
  const changed = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)
  expect(changed.state).toBe('failed')
  expect(changed.shots).toEqual([])
  expect(changed.issue).toContain('changed during detection')
})

it('refuses unsupported provider origins and oversized downloads before spawning an analyzer', async () => {
  const f = await fixture({ maxSourceBytes: 64 })
  const fetch = vi.fn(async () => new Response(readFileSync(f.file)))
  vi.stubGlobal('fetch', fetch)
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  f.tool('jubian_video', { method: 'subtasks', task_id: 7 }, { subtasks: { rows: [
    { parent_task_id: 7, status: 'succeeded', video_url: 'http://127.0.0.1/private.mp4' },
    { parent_task_id: 7, status: 'succeeded', video_url: 'https://101.aigc.jubianai.net/oversized.mp4' },
  ] } })
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  expect(sources[0]?.status).toBe('unsupported')
  expect((await f.ctx.sessionVideo.detect(f.session.id, sources[0]!.id, sources[0]!.version!, f.signal)).state).toBe('failed')
  expect(fetch).not.toHaveBeenCalled()
  const oversized = await f.ctx.sessionVideo.detect(f.session.id, sources[1]!.id, sources[1]!.version!, f.signal)
  expect(oversized.state).toBe('failed')
  expect(oversized.shots).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(spawn).not.toHaveBeenCalled()
  expect((await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[1]?.status).toBe('remote-only')
})

it('cancels and joins a running process before another detection uses the slot', async () => {
  const f = await fixture({ maxConcurrent: 1 })
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const started = Promise.withResolvers<undefined>()
  let child: ReturnType<Context['subprocess']['spawn']> | undefined
  const original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    if (/^ffmpeg(?:\.exe)?$/iu.test(basename(String(spec.argv[0])))) {
      child = original({ ...spec, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
      started.resolve(undefined)
      return child
    }
    return original(spec)
  })
  const controller = new AbortController()
  const pending = f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, controller.signal)
  await started.promise
  expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).issue).toContain('busy')
  controller.abort(new Error('fixture cancelled during command'))
  await expect(pending).rejects.toThrow('fixture cancelled during command')
  await child?.waitForExit()
  spawn.mockRestore()
  expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).state).toBe('ready')
})

it('replays persisted source checkpoints when deployment inventory limits change', async () => {
  const original = await fixture({ maxSources: 2 })
  original.user('@first.mp4 @second.mp4')
  expect((await original.ctx.sessionVideo.list(original.session.id, original.signal)).sources).toHaveLength(2)
  const checkpoint = original.ctx.sessionProjections.checkpoint(original.session)
  const restricted = await fixture({ maxSources: 1 })
  const restored = restricted.ctx.sessionProjections.restore(checkpoint, original.session.snapshotEvents(), SessionLogOffset(0),
    original.session.header, SessionLogOffset(0))
  const state = sourceStateSchema.parse(restored.checkpoint.sessionVideoSources?.val)
  expect(state.sources).toHaveLength(1)
  expect(state.complete).toBe(false)
})

it('lists absent, directory and oversized recorded videos without starting detection', async () => {
  const f = await fixture({ maxSourceBytes: 1 }), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  mkdirSync(join(f.root, 'directory.mp4'))
  f.user('@missing.mp4 @directory.mp4 @three-shots.mp4')
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  expect(sources).toMatchObject([
    { path: 'missing.mp4', status: 'missing', playbackUrl: null, issue: 'Recorded video file is missing' },
    { path: 'directory.mp4', status: 'missing', playbackUrl: null, issue: 'Recorded video file is missing' },
    { path: 'three-shots.mp4', status: 'unsupported', playbackUrl: null, issue: 'Recorded video exceeds the configured byte limit' },
  ])
  expect(spawn).not.toHaveBeenCalled()
})

it('serves the recorded filename media type and refuses an empty local video', async () => {
  const f = await fixture()
  for (const extension of ['webm', 'mov']) copyFileSync(f.file, join(f.root, `source.${extension}`))
  writeFileSync(join(f.root, 'empty.mp4'), '')
  f.user('@source.webm @source.mov @empty.mp4')
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  const route = f.routes.get('/api/session-video')!
  const read = vi.spyOn(f.ctx.fs, 'readByteRange')
  for (const [index, type] of ['video/webm', 'video/quicktime'].entries()) {
    const source = sources[index]!
    const response = await route.fetch(new Request(new URL(source.playbackUrl!, 'http://localhost/'), { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(response.headers.get('content-length')).toBe(String(readFileSync(f.file).length))
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }
  const empty = await route.fetch(new Request(new URL(sources[2]!.playbackUrl!, 'http://localhost/')))
  expect(empty.status).toBe(404)
  expect(await empty.text()).toBe('Video has no readable bytes')
  expect(read).not.toHaveBeenCalled()
})

it('rejects non-JSON output from a real analyzer process and retains its unchanged source', async () => {
  const f = await fixture({ ffprobePath: process.execPath })
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!, before = readFileSync(f.file)
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const result = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)
  expect(result.state).toBe('failed')
  expect(result.shots).toEqual([])
  expect(result.issue).toContain('not valid JSON')
  expect(spawn).toHaveBeenCalledOnce()
  expect(readFileSync(f.file)).toEqual(before)
  expect((await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]).toEqual(source)
})

it('evicts downloaded provider videos at the configured bound and downloads the old source again', async () => {
  const f = await fixture({ maxCachedAnalyses: 1 })
  const urls = ['https://101.aigc.jubianai.net/first.mp4', 'https://101.aigc.jubianai.net/second.mp4']
  f.tool('jubian_video', { method: 'subtasks', task_id: 7 }, { subtasks: { rows: urls.map(video_url => ({
    parent_task_id: 7, status: 'succeeded', video_url,
  })) } })
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(readFileSync(f.file)))
  vi.stubGlobal('fetch', fetch)
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  for (const index of [0, 1, 0]) {
    const source = sources[index]!
    expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).state).toBe('ready')
  }
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch.mock.calls.map(call => call[0])).toEqual(urls.concat(urls[0]!))
  const current = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  expect(current.map(source => source.status)).toEqual(['local', 'remote-only'])
})

it('keeps provider-only playback unavailable until detection has saved a local source', async () => {
  const f = await fixture(), url = 'https://101.aigc.jubianai.net/provider-only.mp4'
  f.tool('jubian_video', { method: 'sources' }, { sources: { sources: [{ status: 'succeeded', video_url: url }] } })
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  expect(source).toMatchObject({ status: 'remote-only', playbackUrl: url })
  if (source.version === null) throw Error('Provider source has no inventory version')
  const query = new URLSearchParams({ sessionId: f.session.id, sourceId: source.id, version: source.version })
  const route = f.routes.get('/api/session-video')!
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const read = vi.spyOn(f.ctx.fs, 'readByteRange'), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  for (const method of ['GET', 'HEAD']) {
    const response = await route.fetch(new Request(`http://localhost/api/session-video?${query}`, { method }))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Local video unavailable')
  }
  expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
})

it('binds playback to its conversation and exact current file version', async () => {
  const f = await localPlayback(), before = readFileSync(f.file)
  const read = vi.spyOn(f.ctx.fs, 'readByteRange'), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const foreign = f.ctx.sessions.create(SessionId('other-conversation'), { meta: { cwd: f.root } })
  const foreignUrl = new URL(f.url); foreignUrl.searchParams.set('sessionId', foreign.id)
  expect((await f.route.fetch(new Request(foreignUrl))).status).toBe(404)
  expect(read).not.toHaveBeenCalled()
  appendFileSync(f.file, 'real-source-version-change')
  expect((await f.route.fetch(new Request(f.url))).status).toBe(409)
  expect(read).not.toHaveBeenCalled()
  const latest = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]
  expect(latest?.version).not.toBe(f.source.version)
  if (!latest?.playbackUrl) throw Error('Expected refreshed local playback URL')
  const response = await f.route.fetch(new Request(new URL(latest.playbackUrl, f.url)))
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat([before, Buffer.from('real-source-version-change')]))
  expect(spawn).not.toHaveBeenCalled()
})

it('returns exact full, open and suffix byte ranges while HEAD performs no byte read', async () => {
  const f = await localPlayback({ playbackChunkBytes: 127 }), bytes = readFileSync(f.file)
  const read = vi.spyOn(f.ctx.fs, 'readByteRange')
  for (const range of [undefined, 'bytes=16-', 'bytes=-16', `bytes=0-${bytes.length + 100}`]) {
    const start = range === 'bytes=16-' ? 16 : range === 'bytes=-16' ? bytes.length - 16 : 0
    const response = await f.route.fetch(new Request(f.url, { headers: range ? { range } : {} }))
    expect(response.status).toBe(range ? 206 : 200)
    expect(response.headers.get('content-length')).toBe(String(bytes.length - start))
    expect(response.headers.get('content-range')).toBe(range ? `bytes ${start}-${bytes.length - 1}/${bytes.length}` : null)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start))
    const readsBeforeHead = read.mock.calls.length
    const head = await f.route.fetch(new Request(f.url, { method: 'HEAD', headers: range ? { range } : {} }))
    expect(head.status).toBe(response.status)
    expect([...head.headers]).toEqual([...response.headers])
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect(read).toHaveBeenCalledTimes(readsBeforeHead)
  }
  expect(readFileSync(f.file)).toEqual(bytes)
})

it('rejects ambiguous source coordinates and invalid byte ranges without opening a stream', async () => {
  const f = await localPlayback(), bytes = readFileSync(f.file), read = vi.spyOn(f.ctx.fs, 'readByteRange')
  const duplicated = new URL(f.url); duplicated.searchParams.append('sourceId', f.source.id)
  expect((await f.route.fetch(new Request(duplicated))).status).toBe(400)
  for (const range of ['bytes=-', 'bytes=3-2', `bytes=${bytes.length}-`, 'bytes=0-1,2-3', 'bytes=9007199254740992-']) {
    const response = await f.route.fetch(new Request(f.url, { headers: { range } }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
  }
  expect(read).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(bytes)
})

it('refuses already aborted GET and HEAD playback before reading source bytes', async () => {
  const f = await localPlayback(), before = readFileSync(f.file)
  const read = vi.spyOn(f.ctx.fs, 'readByteRange'), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const caller = new AbortController(); caller.abort(new Error('Playback request already cancelled'))
  for (const method of ['GET', 'HEAD']) {
    const response = await f.route.fetch(new Request(f.url, { method, signal: caller.signal }))
    expect(response.status).toBe(499)
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Playback request already cancelled')
  }
  expect(read).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  const next = await f.route.fetch(new Request(f.url))
  expect(next.status).toBe(200)
  expect(Buffer.from(await next.arrayBuffer())).toEqual(before)
})

it('refuses real probed duration and pixel limits before starting cut detection', async () => {
  for (const limits of [{ maxDurationSeconds: 1 }, { maxSourcePixels: 1 }]) {
    const f = await localPlayback(limits), before = readFileSync(f.file), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    if (!f.source.version) throw Error('Expected source version before detection')
    const result = await f.ctx.sessionVideo.detect(f.session.id, f.source.id, f.source.version, f.signal)
    expect(result).toMatchObject({ state: 'failed', shots: [], issue: 'Video duration or dimensions exceed the configured detection limit' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0].argv[0]).toMatch(/(?:^|[/\\])ffprobe(?:\.exe)?$/iu)
    expect(readFileSync(f.file)).toEqual(before)
  }
})

it('evicts an old analysis at the configured cache bound and reanalyzes its unchanged real source', async () => {
  const f = await fixture({ maxCachedAnalyses: 1 }), before = readFileSync(f.file), second = join(f.root, 'second.mp4')
  copyFileSync(f.file, second)
  f.user('@three-shots.mp4 @second.mp4')
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources
  const a = sources[0], b = sources[1]
  if (!a?.version || !b?.version) throw Error('Expected two versioned real sources')
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const initial = await f.ctx.sessionVideo.detect(f.session.id, a.id, a.version, f.signal)
  expect(initial.state).toBe('ready')
  expect(initial.shots.map(shot => [shot.startSeconds, shot.endSeconds])).toEqual([[0, 1], [1, 2], [2, 3]])
  expect(await f.ctx.sessionVideo.detect(f.session.id, a.id, a.version, f.signal)).toEqual(initial)
  expect(spawn).toHaveBeenCalledTimes(2)
  expect((await f.ctx.sessionVideo.detect(f.session.id, b.id, b.version, f.signal)).state).toBe('ready')
  expect(spawn).toHaveBeenCalledTimes(4)
  expect(await f.ctx.sessionVideo.detect(f.session.id, a.id, a.version, f.signal)).toEqual(initial)
  expect(spawn).toHaveBeenCalledTimes(6)
  expect(readFileSync(f.file)).toEqual(before); expect(readFileSync(second)).toEqual(before)
})

it('keeps a cancelled playback slot owned until its real pending read returns', async () => {
  const f = await localPlayback({ maxPlaybackStreams: 1, playbackChunkBytes: 64 }), before = readFileSync(f.file)
  const held = holdPlaybackRead(f.ctx), response = await f.route.fetch(new Request(f.url))
  if (!response.body) throw Error('Expected a playback body')
  const signal = await held.entered, reader = response.body.getReader()
  let cancelled = false
  const cancellation = reader.cancel().then(() => { cancelled = true })
  try {
    expect(signal.aborted).toBe(true)
    expect((await f.route.fetch(new Request(f.url))).status).toBe(429)
    expect(cancelled).toBe(false)
    held.release()
    await cancellation
    const next = await f.route.fetch(new Request(f.url))
    expect(next.status).toBe(200)
    expect(Buffer.from(await next.arrayBuffer())).toEqual(before)
    expect(createHash('sha256').update(readFileSync(f.file)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'))
  } finally { held.release(); await cancellation }
})

it('aborts playback and waits for its real pending read before completing plugin unload', async () => {
  const f = await localPlayback(), before = readFileSync(f.file)
  const held = holdPlaybackRead(f.ctx), response = await f.route.fetch(new Request(f.url))
  if (!response.body) throw Error('Expected a playback body')
  const outcome = response.body.getReader().read().then(value => ({ value }), (error: unknown) => ({ error }))
  const signal = await held.entered, aborted = Promise.withResolvers<undefined>()
  signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
  const fiber = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'video')?.fiber
  if (!fiber) throw Error('Expected the real video plugin fiber')
  let unloaded = false
  const disposal = fiber.dispose().then(() => { unloaded = true })
  try {
    await aborted.promise
    expect(unloaded).toBe(false)
    held.release()
    await disposal
    const read = await outcome
    if (!('error' in read)) throw Error('Playback returned data after plugin unload')
    expect(String(read.error)).toContain('Session video plugin stopped')
    expect(f.routes.size).toBe(0)
    expect(createHash('sha256').update(readFileSync(f.file)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'))
  } finally { held.release(); await disposal; await outcome }
})

it('propagates caller abort during playback and releases its slot after the owned read settles', async () => {
  const f = await localPlayback({ maxPlaybackStreams: 1 }), before = readFileSync(f.file)
  const held = holdPlaybackRead(f.ctx), caller = new AbortController(), reason = new Error('Caller stopped playback')
  const response = await f.route.fetch(new Request(f.url, { signal: caller.signal }))
  const outcome = response.arrayBuffer().then(bytes => ({ bytes }), (error: unknown) => ({ error }))
  try {
    const signal = await held.entered
    caller.abort(reason)
    expect(signal.reason).toBe(reason)
    const read = await outcome
    if (!('error' in read)) throw Error('Playback completed after caller cancellation')
    expect(read.error).toBe(reason)
    expect((await f.route.fetch(new Request(f.url))).status).toBe(429)
    held.release(); await held.settled
    const next = await f.route.fetch(new Request(f.url))
    expect(next.status).toBe(200)
    expect(Buffer.from(await next.arrayBuffer())).toEqual(before)
  } finally { caller.abort(reason); held.release(); await held.settled; await outcome }
})

it('lists a real persisted cold Session after reopening without a live owner or header cwd', async () => {
  const f = await fixture(), history = join(f.root, 'history'), id = SessionId('persisted-video-session')
  await f.ctx.plugin(JsonlPersistence, { root: history, compression: 'none' })
  const session = f.ctx.sessions.create(id)
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '@three-shots.mp4' }] }), { surfaceOp: 'append' })
  const before = readFileSync(f.file)
  const writer = await f.ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  try { await writer.append(session.snapshotEvents()) } finally { await writer.close() }
  await f.ctx.fiber.dispose()
  const { ctx } = await openFixture(f.root, {}, history)
  const query = vi.spyOn(ctx.sessionQuery, 'readSession'), resolve = vi.spyOn(ctx.fs, 'resolve')
  expect(ctx.sessions.get(id)).toBeUndefined()
  const inventory = await ctx.sessionVideo.list(id, f.signal)
  expect(query).toHaveBeenCalledExactlyOnceWith(id)
  expect(inventory).toMatchObject({ sessionId: id, complete: true, issues: [] })
  expect(inventory.sources).toHaveLength(1)
  expect(inventory.sources[0]).toMatchObject({ status: 'local', path: f.file, issue: null })
  expect(inventory.sources[0]?.playbackUrl).toContain('api/session-video?')
  expect(resolve.mock.calls[0]?.[0]).toBe('three-shots.mp4')
  expect(resolve.mock.calls[0]?.[1]?.cwd).toBe(f.root)
  expect(resolve.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  expect(ctx.sessions.get(id)).toBeUndefined()
  expect(readFileSync(f.file)).toEqual(before)
})

it('reports one standard filesystem refusal without analyzing and recovers from the unchanged source', async () => {
  const f = await fixture()
  f.user('@three-shots.mp4')
  const before = readFileSync(f.file), target = await f.ctx.fs.resolve(f.file, { cwd: f.root, signal: f.signal })
  const refusal = new FsError('The recorded video cannot be read', 'FS_PERMISSION_DENIED')
  const stat = vi.spyOn(f.ctx.fs, 'stat').mockRejectedValueOnce(refusal), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const unavailable = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(stat).toHaveBeenCalledOnce()
  expect(stat.mock.calls[0]?.[0].targetKey).toBe(target.targetKey)
  expect(unavailable.sources).toHaveLength(1)
  expect(unavailable.sources[0]).toMatchObject({ status: 'missing', version: null, playbackUrl: null, issue: refusal.message })
  expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(before)
  stat.mockRestore()
  const restored = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(restored.sources[0]).toMatchObject({ id: unavailable.sources[0]?.id, status: 'local', path: f.file, issue: null })
  expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(before)
})

it('hides non-Error filesystem failures and restores the unchanged recorded source', async () => {
  const f = await fixture()
  f.user('@three-shots.mp4')
  const before = readFileSync(f.file), detail = 'private-provider-metadata-detail'
  const stat = vi.spyOn(f.ctx.fs, 'stat').mockRejectedValueOnce(detail)
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const unavailable = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(stat).toHaveBeenCalledOnce()
  expect(unavailable.sources).toMatchObject([{ status: 'missing', version: null, playbackUrl: null,
    issue: 'Recorded video is unreadable' }])
  expect(JSON.stringify(unavailable)).not.toContain(detail)
  expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(before)
  stat.mockRestore()
  const restored = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(restored.sources[0]).toMatchObject({ id: unavailable.sources[0]?.id, status: 'local', path: f.file, issue: null })
  expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(before)
})

it('hides non-Error executable lookup failures without caching a failed analysis', async () => {
  const f = await fixture()
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]
  if (!source?.version) throw Error('Expected a versioned recorded video')
  const before = readFileSync(f.file), detail = 'private-provider-executable-detail'
  const resolve = vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockRejectedValueOnce(detail)
  const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  const failed = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version, f.signal)
  expect(resolve).toHaveBeenCalledOnce()
  expect(failed).toMatchObject({ state: 'failed', shots: [], durationSeconds: null, width: null, height: null,
    issue: 'Video detection failed' })
  expect(JSON.stringify(failed)).not.toContain(detail)
  expect(spawn).not.toHaveBeenCalled()
  expect(readFileSync(f.file)).toEqual(before)
  resolve.mockRestore()
  expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version, f.signal)).state).toBe('ready')
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(readFileSync(f.file)).toEqual(before)
})
