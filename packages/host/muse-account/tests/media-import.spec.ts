/** Real managed binary imports and codec validation over synthetic files only. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { MuseMediaImporter } from '../src/media-import.ts'
import { MuseMediaClient, MuseMediaError } from '../src/media.ts'
import type { MuseMediaJobId, MuseMediaTransfer } from '../src/media-types.ts'
import { writeMuseSession } from '../src/session.ts'

const execute = promisify(execFile)
const roots: string[] = [], contexts: Context[] = [], importers: MuseMediaImporter[] = [], clients: MuseMediaClient[] = []
const id = brandString<MuseMediaJobId>('80000000-0000-4000-8000-000000000001')
let video: Buffer
beforeAll(async () => {
  const made = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=128x72:r=5',
    '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 1_048_576 })
  video = made.stdout
})
afterEach(async () => {
  await Promise.all(importers.splice(0).map(value => value.dispose()))
  await Promise.all(clients.splice(0).map(value => value.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

interface FixtureOptions {
  client?: Pick<MuseMediaClient, 'withFile'>
  mode?: 'danger-full-access' | 'read-only' | 'workspace-write'
  missingCwd?: boolean
  bytes?: Buffer
  hash?: string
  kind?: 'video' | 'image'
  guard?: () => Promise<void>
  body?: (signal: AbortSignal) => ReadableStream<Uint8Array>
  partial?: boolean
}
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-media-import-')); roots.push(root)
  const cwd = await (await import('node:fs/promises')).realpath(root)
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(FsLocal, { cwd })
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(SandboxPolicy, { mode: options.mode ?? 'danger-full-access', workspaceRoot: cwd })
  if (options.mode === 'workspace-write') await ctx.plugin(SandboxLocal)
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId(`media-${randomUUID()}`), {}, options.missingCwd ? {} : { cwd })
  const payload = options.bytes ?? video
  let requests = 0
  const client: Pick<MuseMediaClient, 'withFile'> = {
    async withFile<Result>(_job: MuseMediaJobId, _name: string,
      consume: (transfer: MuseMediaTransfer) => Promise<Result>, signal?: AbortSignal): Promise<Result> {
      requests++
      return await consume({ file: { name: 'video.mp4', kind: options.kind ?? 'video', bytes: payload.length,
        sha256: options.hash ?? createHash('sha256').update(payload).digest('hex') },
      job: { state: options.partial ? 'partial' : 'cloud_saved', file_coverage: { reported: options.partial ? 2 : 1,
        accepted: 1, rejected: options.partial ? 1 : 0, complete: !options.partial, truncated: false } },
      body: options.body?.(signal ?? new AbortController().signal) ?? new ReadableStream({
        start(controller) { controller.enqueue(payload); controller.close() },
      }),
      signal: signal ?? new AbortController().signal, assertCurrent: options.guard ?? (async () => {}) })
    },
  }
  const importer = new MuseMediaImporter(ctx, options.client ?? client, { directory: 'source/media/company', nodePath: process.execPath,
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', timeoutMs: 30_000, graceMs: 1000, maxBytes: 1_048_576,
    maxOutputBytes: 65_536, maxPixels: 1_000_000, maxDurationSeconds: 60 })
  importers.push(importer)
  return { ctx, agent, importer, cwd, requests: () => requests, destination: join(cwd, 'source/media/company', `${id}-video.mp4`) }
}

it('publishes a complete real video and a stable file-backed receipt without private transaction fields', async () => {
  const f = await fixture()
  const result = await f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)
  expect(result).toMatchObject({ state: 'local_ready', path: f.destination, width: 128, height: 72,
    fullDecodeVerified: true, sourceJobState: 'cloud_saved', kind: 'video' })
  expect(result.durationSeconds).toBeGreaterThan(0)
  expect(await readFile(result.path)).toEqual(video)
  const receipt: unknown = JSON.parse(await readFile(result.receipt, 'utf8'))
  expect(receipt).toMatchObject({ sha256: createHash('sha256').update(video).digest('hex') })
  expect(receipt).not.toHaveProperty('transaction')
  expect(await readdir(join(f.cwd, 'source/media/company'))).toEqual([`${id}-video.mp4`, `${id}-video.mp4.source.json`])
})

it('imports the exact spaced and parenthesized manifest member through the current-account client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-media-manifest-')); roots.push(directory)
  const origin = 'https://muse.test', sessionFile = join(directory, 'session.json'), name = 'video (1).mp4'
  await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie: '__Host-muse=' + 'A'.repeat(43) })
  const hash = createHash('sha256').update(video).digest('hex')
  const manifest = { state: 'cloud_saved', job_id: id, files: [{ name, bytes: video.length, sha256: hash, kind: 'video' }],
    file_coverage: { reported: 1, accepted: 1, rejected: 0, complete: true, truncated: false } }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(manifest))
    .mockResolvedValueOnce(new Response(new Uint8Array(video), { headers: { 'content-length': String(video.length) } }))
  const client = new MuseMediaClient({ baseUrl: origin, sessionFile, requestTimeoutMs: 60_000, fileTimeoutMs: 60_000,
    maxReplyBytes: 1_048_576, maxFileBytes: 1_048_576, fetcher }); clients.push(client)
  const withFile = vi.spyOn(client, 'withFile'), f = await fixture({ client })
  const result = await f.importer.import(f.agent, id, name, new AbortController().signal)
  const destination = join(f.cwd, 'source/media/company', `${id}-${name}`)
  expect(withFile).toHaveBeenCalledWith(id, name, expect.any(Function), expect.any(AbortSignal), true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher).toHaveBeenNthCalledWith(2, new URL(`${origin}/api/media/jobs/${id}/files/video%20(1).mp4`),
    expect.objectContaining({ method: 'GET' }))
  expect(result).toMatchObject({ state: 'local_ready', fileName: name, path: destination, bytes: video.length,
    sha256: hash, fullDecodeVerified: true, kind: 'video', width: 128, height: 72 })
  expect(await readFile(destination)).toEqual(video)
  expect(JSON.parse(await readFile(result.receipt, 'utf8'))).toMatchObject({ jobId: id, fileName: name,
    path: destination, sha256: hash, bytes: video.length, fullDecodeVerified: true })
  expect((await readdir(join(f.cwd, 'source/media/company'))).sort()).toEqual([`${id}-${name}`, `${id}-${name}.source.json`])
})

it.each(['../video.mp4', 'dir/video.mp4', 'dir\\video.mp4', '.video.mp4', 'video..mp4', 'v'.repeat(129),
  'video.mp4\n', 'video.mp4\r\n'])('refuses an unsafe manifest filename before client or subprocess work: %j', async (name) => {
  const f = await fixture(), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
  await expect(f.importer.import(f.agent, id, name, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-input' })
  expect(f.requests()).toBe(0)
  expect(spawn).not.toHaveBeenCalled()
  expect(await readdir(f.cwd)).toEqual([])
})

it('uses the actual OS sandbox for workspace-write imports', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  const confine = vi.spyOn(f.ctx.sandbox, 'confine')
  expect(await f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).toMatchObject({ state: 'local_ready' })
  expect(confine).toHaveBeenCalled()
})

it('retains a partial cloud receipt while verifying its selected image independently', async () => {
  const image = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1_048_576 })
  const f = await fixture({ bytes: image.stdout, kind: 'image', partial: true })
  expect(await f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).toMatchObject({
    state: 'local_ready', sourceJobState: 'partial', kind: 'image', width: 64, height: 48,
    fileCoverage: { complete: false, rejected: 1 },
  })
})

it.each(['hash', 'metadata'] as const)('does not publish %s-corrupt media', async (kind) => {
  const f = await fixture(kind === 'hash' ? { hash: 'a'.repeat(64) } : { bytes: Buffer.from('this is not video') })
  await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: kind === 'hash' ? 'file-incomplete' : 'invalid-media' })
  expect(await readdir(join(f.cwd, 'source/media/company'))).toEqual([])
})

it('rejects a real video mislabeled as an image rather than reporting a cover import', async () => {
  const f = await fixture({ kind: 'image' })
  await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-media' })
  expect(await readdir(join(f.cwd, 'source/media/company'))).toEqual([])
})

it('refuses read-only and missing-workspace calls before network or subprocess work', async () => {
  for (const options of [{ mode: 'read-only' as const }, { missingCwd: true }]) {
    const f = await fixture(options), spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: options.missingCwd ? 'workspace-required' : 'read-only' })
    expect(f.requests()).toBe(0); expect(spawn).not.toHaveBeenCalled()
  }
})

it('refuses remote filesystem mapping and an out-of-root policy before network', async () => {
  const f = await fixture()
  const mapping = vi.spyOn(f.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'local-filesystem-required' })
  mapping.mockRestore()
  const outside = await mkdtemp(join(tmpdir(), 'muse-media-other-')); roots.push(outside)
  vi.spyOn(f.ctx.sandboxPolicy, 'resolve').mockReturnValue({ mode: 'workspace-write', workspaceRoot: outside })
  await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-outside' })
  expect(f.requests()).toBe(0)
})

it('refuses a symlinked destination without touching its target', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'muse-media-outside-')); roots.push(outside)
  await symlink(outside, join(f.cwd, 'source'), 'dir')
  await expect(f.importer.import(f.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-outside' })
  expect(await readdir(outside)).toEqual([])
})

it('preserves existing files and rolls back after an account changes at publication', async () => {
  const conflict = await fixture()
  await mkdir(join(conflict.cwd, 'source/media/company'), { recursive: true })
  await writeFile(conflict.destination, 'existing')
  await expect(conflict.importer.import(conflict.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'local-conflict' })
  expect(await readFile(conflict.destination, 'utf8')).toBe('existing')
  let checks = 0
  const changed = await fixture({ guard: async () => { if (++checks === 2) throw new MuseMediaError('account-changed') } })
  await expect(changed.importer.import(changed.agent, id, 'video.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'account-changed' })
  expect(await readdir(join(changed.cwd, 'source/media/company'))).toEqual([])
})

it('cancels an actual running helper and waits for rollback before resolving', async () => {
  const f = await fixture({ body: signal => new ReadableStream({ start(controller) {
    controller.enqueue(video.subarray(0, 100))
    signal.addEventListener('abort', () => { controller.error(new Error('cancelled input')) }, { once: true })
  } }) })
  const spawned = Promise.withResolvers<undefined>(), original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = original(spec)
    if (spec.stdio.control === 'pipe') spawned.resolve(undefined)
    return child
  })
  const controller = new AbortController()
  const operation = f.importer.import(f.agent, id, 'video.mp4', controller.signal)
  const rejected = expect(operation).rejects.toMatchObject({ code: 'cancelled' })
  await spawned.promise
  controller.abort()
  await rejected
  expect(await readdir(join(f.cwd, 'source/media/company')).catch(() => [])).toEqual([])
})

it.each(['account-change', 'cancel'] as const)('rolls back after %s at the real finalize exit even after staging removal', async (kind) => {
  let changed = false, finalized = false
  const controller = new AbortController()
  const f = await fixture({ guard: async () => { if (changed) throw new MuseMediaError('account-changed') } })
  const original = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = original(spec)
    if (!spec.argv.at(-1)?.includes('"operation":"finalize"')) return child
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control: child.control,
      collected: child.collected, terminate: () => { child.terminate() }, waitForExit: signal => child.waitForExit(signal),
      done: child.done.then(async (outcome) => {
        expect(outcome.exitCode).toBe(0)
        expect((await readdir(join(f.cwd, 'source/media/company'))).some(name => name.startsWith('.import-'))).toBe(false)
        finalized = true
        if (kind === 'account-change') changed = true
        else controller.abort()
        return outcome
      }) }
  })
  await expect(f.importer.import(f.agent, id, 'video.mp4', controller.signal)).rejects.toMatchObject({
    code: kind === 'account-change' ? 'account-changed' : 'cancelled',
  })
  expect(finalized).toBe(true)
  expect(await readdir(join(f.cwd, 'source/media/company'))).toEqual([])
})

it('keeps the real verified file when cancellation arrives during the cloud confirmation after local commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-media-committed-')); roots.push(directory)
  const origin = 'https://muse.test', sessionFile = join(directory, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie: '__Host-muse=' + 'A'.repeat(43) })
  const hash = createHash('sha256').update(video).digest('hex')
  const manifest = { state: 'cloud_saved', job_id: id, files: [{ name: 'video.mp4', bytes: video.length, sha256: hash, kind: 'video' }],
    file_coverage: { reported: 1, accepted: 1, rejected: 0, complete: true, truncated: false } }
  const caller = new AbortController()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(manifest))
    .mockResolvedValueOnce(new Response(new Uint8Array(video), {
      headers: { 'x-muse-media-lease': '22222222-2222-4222-8222-222222222222' },
    })).mockImplementationOnce(async () => {
      caller.abort()
      return Response.json({ state: 'acknowledged' })
    })
  const client = new MuseMediaClient({ baseUrl: origin, sessionFile, requestTimeoutMs: 60_000, fileTimeoutMs: 60_000,
    maxReplyBytes: 1_048_576, maxFileBytes: 1_048_576, fetcher }); clients.push(client)
  const f = await fixture({ client, mode: 'workspace-write' })
  const result = await f.importer.import(f.agent, id, 'video.mp4', caller.signal)
  expect(caller.signal.aborted).toBe(true)
  expect(result).toMatchObject({ state: 'local_ready', fullDecodeVerified: true, sha256: hash })
  expect(await readFile(result.path)).toEqual(video)
  expect(await readFile(result.receipt, 'utf8')).toContain(hash)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
