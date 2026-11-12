/** Real Loader, local filesystem, attachment storage and FFmpeg over synthetic media only. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
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
