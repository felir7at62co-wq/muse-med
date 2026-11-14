/** Real Loader, local filesystem, attachment storage and FFmpeg over synthetic media only. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Sessions, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query'
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
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(overrides: Partial<Config> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-video-loader-')); roots.push(root)
  const file = join(root, 'three-shots.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1',
    '-filter_complex_threads', '1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file])
  const routes = new Map<string, { fetch(request: Request): Response | Promise<Response> }>()
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { name: 'cordis:sessions' }, { name: 'cordis:projections' }, { name: 'cordis:query' },
    { name: 'cordis:fs', config: { cwd: root } }, { name: 'cordis:attachments', config: { dshHome: root } },
    { name: 'cordis:subprocess' }, { name: 'cordis:policy', config: { mode: 'danger-full-access', workspaceRoot: root } },
    { id: 'video', name: 'cordis:video', config: { analysisWidth: 64, ...overrides } },
  ]))
  const ctx = await boot('dsh', configPath, [], (host) => {
    host.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
      routes.set(route.path, route); return () => routes.delete(route.path)
    } } } as never)
    Object.assign(host.loader.builtins, { sessions: Sessions, projections: Projections, query: Query, fs: FileSystem,
      attachments: Attachments, subprocess: Subprocess, policy: SandboxPolicy, video: SessionVideo })
  })
  contexts.push(ctx)
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
    if (basename(String(spec.argv[0])).replace(/\.exe$/iu, '') === 'ffmpeg') appendFileSync(f.file, 'fixture-version-change')
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
    if (basename(String(spec.argv[0])).replace(/\.exe$/iu, '') === 'ffmpeg') {
      child = original({ ...spec, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
      started.resolve(undefined)
      return child
    }
    return original(spec)
  })
  const controller = new AbortController()
  const pending = f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, controller.signal)
  const rejected = expect(pending).rejects.toThrow('fixture cancelled during command')
  try {
    await Promise.race([started.promise, pending.then(() => { throw Error('Detection finished before the held media process started') })])
    expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).issue).toContain('busy')
    controller.abort(new Error('fixture cancelled during command'))
    await rejected
  } finally {
    controller.abort(new Error('fixture cancelled during command'))
    await Promise.allSettled([pending, rejected])
    await child?.waitForExit()
    spawn.mockRestore()
  }
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

it('declares each operation against the exact requested Session resource', async () => {
  const f = await fixture()
  for (const method of remoteMethods(f.ctx.sessionVideo)) {
    const read = method.resources?.session
    if (read === undefined) throw Error('Session video operation must declare its Session resource')
    expect(read(f.session.id)).toBe(f.session.id)
    expect(read(SessionId('different-session'))).toBe('different-session')
  }
})

it('reads a persisted cold Session through the real query provider and rejects cancellation after the read', async () => {
  const f = await fixture()
  await f.ctx.plugin(Jsonl, { root: join(f.root, 'sessions'), compression: 'none' }).await()
  const session = Session.create(SessionId('cold-video-session'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '@three-shots.mp4' }] }), { surfaceOp: 'append' })
  const writer = await f.ctx.sessionPersistence.create(session.header)
  try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  expect(f.ctx.sessions.get(session.id)).toBeUndefined()
  expect((await f.ctx.sessionVideo.list(session.id, f.signal)).sources[0]).toMatchObject({ status: 'local', path: f.file })
  const controller = new AbortController(), read = f.ctx.sessionQuery.readSession.bind(f.ctx.sessionQuery)
  const observe = vi.spyOn(f.ctx.sessionQuery, 'readSession').mockImplementation(async (...args) => {
    const value = await read(...args); controller.abort(Error('Cold video caller left')); return value
  })
  try { await expect(f.ctx.sessionVideo.list(session.id, controller.signal)).rejects.toThrow('Cold video caller left') }
  finally { observe.mockRestore() }
})

it.each(['duration', 'pixels'] as const)('refuses a real video exceeding the %s policy before cut detection', async (limit) => {
  const f = await fixture(limit === 'duration' ? { maxDurationSeconds: 1 } : { maxSourcePixels: 1 })
  f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!, spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  expect(await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal))
    .toMatchObject({ state: 'failed', shots: [], issue: 'Video duration or dimensions exceed the configured detection limit' })
  expect(spawn).toHaveBeenCalledTimes(1)
})

it('evicts old successful analyses while preserving original media bytes and revalidating later requests', async () => {
  const f = await fixture({ maxCachedAnalyses: 1 })
  copyFileSync(f.file, join(f.root, 'second.mp4')); f.user('@three-shots.mp4 @second.mp4')
  const sources = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources, spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  for (const source of [sources[0]!, sources[1]!, sources[0]!]) {
    expect((await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal)).state).toBe('ready')
  }
  expect(spawn).toHaveBeenCalledTimes(6)
  expect(readFileSync(f.file)).toEqual(readFileSync(join(f.root, 'second.mp4')))
})

it.each(['missing', 'directory', 'oversized', 'size-unavailable', 'unreadable', 'opaque-error'] as const)(
  'reports the actual local source boundary: %s', async (kind) => {
    const f = await fixture(kind === 'oversized' ? { maxSourceBytes: 1 } : {})
    if (kind === 'missing') f.user('@missing.mp4')
    else if (kind === 'directory') { mkdirSync(join(f.root, 'directory.mp4')); f.user('@directory.mp4') }
    else f.user('@three-shots.mp4')
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    if (kind === 'size-unavailable') vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args)
      if (info === undefined) return info
      const { size: _size, ...available } = info; return available
    })
    if (kind === 'unreadable' || kind === 'opaque-error') vi.spyOn(f.ctx.fs, 'resolve').mockRejectedValueOnce(kind === 'unreadable' ? Error('Filesystem unavailable') : 'opaque provider failure')
    const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
    expect(source.status).toBe(kind === 'oversized' || kind === 'size-unavailable' ? 'unsupported' : 'missing')
    expect(source.playbackUrl).toBeNull()
    expect(source.issue).toBe(kind === 'unreadable' ? 'Filesystem unavailable' : kind === 'opaque-error' ? 'Recorded video is unreadable'
      : kind === 'oversized' || kind === 'size-unavailable' ? 'Recorded video exceeds the configured byte limit' : 'Recorded video file is missing')
  },
)

it.each(['host-path', 'world-path'] as const)('reports an uploaded file whose %s capability is unavailable', async (kind) => {
  const f = await fixture(), attachment = await f.ctx.attachments.saveFile({ data: readFileSync(f.file), name: 'upload.mp4' })
  f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment }] }), { surfaceOp: 'append' })
  if (kind === 'host-path') vi.spyOn(f.ctx.attachments, 'fileHostPath').mockReturnValue(undefined)
  else vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect((await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]).toMatchObject({ status: 'missing', issue: 'Stored video is unavailable in this filesystem' })
})

it('contains opaque execution failures without inventing cut ranges', async () => {
  const f = await fixture(); f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockRejectedValueOnce('opaque provider failure')
  expect(await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal))
    .toMatchObject({ state: 'failed', shots: [], issue: 'Video detection failed' })
})

it.each(['host-path', 'world-path'] as const)('refuses detection when downloaded media has no %s mapping', async (kind) => {
  const f = await fixture()
  f.tool('jubian_video', { method: 'subtasks', task_id: 7 }, { subtasks: { rows: [
    { parent_task_id: 7, status: 'succeeded', video_url: 'https://101.aigc.jubianai.net/unmapped.mp4' },
  ] } })
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(readFileSync(f.file))))
  if (kind === 'host-path') vi.spyOn(f.ctx.attachments, 'fileHostPath').mockReturnValue(undefined)
  else vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect(await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version!, f.signal))
    .toMatchObject({ state: 'failed', shots: [], issue: 'Video is not available as a local source' })
})

async function playbackFixture(overrides: Partial<Config> = {}) {
  const f = await fixture(overrides); f.user('@three-shots.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const route = f.routes.get('/api/session-video')
  if (route === undefined) throw Error('Session video route did not mount')
  return { ...f, source, route, play: (init: RequestInit = {}) => route.fetch(new Request(`http://localhost/${source.playbackUrl}`, init)) }
}

it('serves complete, open-ended, suffix and HEAD ranges as exact original bytes', async () => {
  const f = await playbackFixture({ playbackChunkBytes: 7 }), bytes = readFileSync(f.file)
  for (const [range, start, end] of [[null, 0, bytes.length - 1], ['bytes=5-', 5, bytes.length - 1],
    ['bytes=-7', bytes.length - 7, bytes.length - 1], ['bytes=2-9999999', 2, bytes.length - 1]] as const) {
    const response = await f.play(range === null ? {} : { headers: { range } })
    expect(response.status).toBe(range === null ? 200 : 206)
    expect(response.headers.get('content-length')).toBe(String(end - start + 1))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1))
  }
  for (const range of [undefined, 'bytes=2-8']) {
    const response = await f.play({ method: 'HEAD', ...(range === undefined ? {} : { headers: { range } }) })
    expect(response.status).toBe(range === undefined ? 200 : 206)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-length')).toBe(String(range === undefined ? bytes.length : 7))
  }
})

it.each(['webm', 'mov'] as const)('preserves %s playback MIME without recoding its selected bytes', async (extension) => {
  const f = await fixture(), name = `selected.${extension}`; copyFileSync(f.file, join(f.root, name)); f.user(`@${name}`)
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const response = await f.routes.get('/api/session-video')!.fetch(new Request(`http://localhost/${source.playbackUrl}`))
  expect(response.headers.get('content-type')).toBe(extension === 'webm' ? 'video/webm' : 'video/quicktime')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(f.file))
})

it('refuses missing, duplicate or caller-selected playback paths before reading source bytes', async () => {
  const f = await playbackFixture(), query = new URL(`http://localhost/${f.source.playbackUrl}`)
  for (const [key, value] of [['sessionId', 'duplicate'], ['sourceId', f.source.id], ['version', f.source.version!], ['path', '/private'], ['url', 'https://private.test']] as const) {
    const invalid = new URL(query); invalid.searchParams.append(key, value)
    expect((await f.route.fetch(new Request(invalid))).status).toBe(400)
  }
  for (const key of ['sessionId', 'sourceId', 'version']) {
    const invalid = new URL(query); invalid.searchParams.delete(key)
    expect((await f.route.fetch(new Request(invalid))).status).toBe(400)
  }
  const invalid = new URL(query); invalid.searchParams.set('sourceId', 'not-a-source-id')
  const head = await f.route.fetch(new Request(invalid, { method: 'HEAD' }))
  expect(head.status).toBe(400); expect(head.body).toBeNull()
})

it('refuses malformed and unsatisfiable byte ranges with the exact complete length', async () => {
  const f = await playbackFixture(), size = readFileSync(f.file).byteLength
  for (const range of ['items=0-2', 'bytes=-', 'bytes=-0', 'bytes=9-2', `bytes=${size}-`, 'bytes=999999999999999999999999-']) {
    const response = await f.play({ headers: { range } })
    expect(response.status).toBe(416); expect(response.headers.get('content-range')).toBe(`bytes */${size}`)
    expect(await response.text()).toBe('Invalid video range')
  }
})

it('refuses stale, changed-at-preflight and empty local playback sources', async () => {
  const f = await playbackFixture(), stat = f.ctx.fs.stat.bind(f.ctx.fs)
  let calls = 0
  const observe = vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (...args) => {
    if (++calls === 2) appendFileSync(f.file, 'changed at preflight')
    return stat(...args)
  })
  expect((await f.play()).status).toBe(409); observe.mockRestore()
  expect((await f.play()).status).toBe(409)
  writeFileSync(f.file, '')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const response = await f.route.fetch(new Request(`http://localhost/${source.playbackUrl}`))
  expect(response.status).toBe(404); expect(await response.text()).toBe('Video has no readable bytes')
})

it('refuses remote-only playback and contains opaque cold-session failures', async () => {
  const f = await fixture(), route = f.routes.get('/api/session-video')!
  f.tool('jubian_video', { method: 'subtasks', task_id: 7 }, { subtasks: { rows: [
    { parent_task_id: 7, status: 'succeeded', video_url: 'https://101.aigc.jubianai.net/remote.mp4' },
  ] } })
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]!
  const query = new URLSearchParams({ sessionId: f.session.id, sourceId: source.id, version: source.version! })
  expect((await route.fetch(new Request(`http://localhost/api/session-video?${query}`))).status).toBe(404)
  query.set('sessionId', 'cold-provider-failure')
  vi.spyOn(f.ctx.sessionQuery, 'readSession').mockRejectedValueOnce('opaque provider failure')
  const failed = await route.fetch(new Request(`http://localhost/api/session-video?${query}`))
  expect(failed.status).toBe(404); expect(await failed.text()).toBe('Video unavailable')
})

it('reserves playback slots until cancellation joins an owned read', async () => {
  const f = await playbackFixture({ maxPlaybackStreams: 1 })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const read = f.ctx.fs.readByteRange.bind(f.ctx.fs)
  const observe = vi.spyOn(f.ctx.fs, 'readByteRange').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return read(...args)
  })
  const response = await f.play()
  try {
    await entered.promise
    expect((await f.play()).status).toBe(429)
    let settled = false
    const cancelled = response.body!.cancel().then(() => { settled = true })
    expect(settled).toBe(false)
    release.resolve(undefined); await cancelled
    const next = await f.play(); expect(next.status).toBe(200); await next.arrayBuffer()
  } finally { release.resolve(undefined); await response.body?.cancel(); observe.mockRestore() }
})

it.each(['before-read', 'after-read', 'truncate'] as const)('rejects real source mutation %s without streaming stale bytes', async (phase) => {
  const f = await playbackFixture(), stat = f.ctx.fs.stat.bind(f.ctx.fs), read = f.ctx.fs.readByteRange.bind(f.ctx.fs)
  let observations = 0
  if (phase !== 'after-read') vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (...args) => {
    const info = await stat(...args)
    if (++observations === 3) {
      if (phase === 'truncate') { writeFileSync(f.file, ''); return info }
      appendFileSync(f.file, 'mutated before read'); return stat(...args)
    }
    return info
  })
  else vi.spyOn(f.ctx.fs, 'readByteRange').mockImplementationOnce(async (...args) => {
    const bytes = await read(...args); appendFileSync(f.file, 'mutated after read'); return bytes
  })
  const response = await f.play()
  await expect(response.arrayBuffer()).rejects.toThrow('Video changed during playback')
})

it.each(['before-access', 'during-preflight', 'during-read'] as const)('settles request cancellation %s', async (phase) => {
  const f = await playbackFixture(), controller = new AbortController(), read = f.ctx.fs.readByteRange.bind(f.ctx.fs)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  if (phase === 'before-access') controller.abort('opaque caller cancellation')
  if (phase === 'during-preflight') {
    const stat = f.ctx.fs.stat.bind(f.ctx.fs); let calls = 0
    vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (...args) => {
      const info = await stat(...args); if (++calls === 2) controller.abort(Error('Caller left at preflight')); return info
    })
  }
  if (phase === 'during-read') vi.spyOn(f.ctx.fs, 'readByteRange').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return read(...args)
  })
  const response = await f.play({ signal: controller.signal })
  if (phase === 'before-access') { expect(response.status).toBe(499); expect(await response.text()).toBe('Video unavailable'); return }
  const outcome = response.arrayBuffer().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    if (phase === 'during-read') { await entered.promise; controller.abort(Error('Caller left during read')) }
    release.resolve(undefined)
    expect(await outcome).toHaveProperty('error')
  } finally { release.resolve(undefined); await outcome }
})

it('unloads only after aborting every playback stream and joining active reads', async () => {
  const f = await playbackFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const read = f.ctx.fs.readByteRange.bind(f.ctx.fs)
  vi.spyOn(f.ctx.fs, 'readByteRange').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return read(...args)
  })
  const response = await f.play(), outcome = response.arrayBuffer().then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const fiber = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'video')?.fiber
  if (fiber === undefined) throw Error('Missing video owner')
  let settled = false
  const disposed = fiber.dispose().then(() => { settled = true })
  try {
    expect(settled).toBe(false)
    release.resolve(undefined); await disposed
    expect(await outcome).toHaveProperty('error'); expect(f.routes.size).toBe(0)
    expect((await f.play()).status).toBe(499)
  } finally { release.resolve(undefined); await disposed; await outcome }
})
