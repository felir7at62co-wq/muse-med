/** Recovery drains provider reads before publishing durable review evidence. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { downloadMedia } from '@deepseek-ai/dsh-jubian-api'
import * as timers from 'node:timers/promises'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { recoverVideoSubmission } from '../src/native.ts'
import { isProjectVideoIntent, runVideoRecovery } from '../src/video-recovery.ts'
import { checkVideoMedia, VideoMediaDrainError } from '../src/video-media-check.ts'
import { observe } from '../src/watch.ts'

const managedFfmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH

vi.mock('@deepseek-ai/dsh-jubian-api', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-jubian-api')>(), downloadMedia: vi.fn(),
}))

vi.mock('../src/native.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native.ts')>(), recoverVideoSubmission: vi.fn(),
}))
vi.mock('../src/watch.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/watch.ts')>(), observe: vi.fn(),
}))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('node:timers/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:timers/promises')>() }))

beforeEach(() => {
  vi.mocked(recoverVideoSubmission).mockReset().mockResolvedValue({ status: 'submitted', task_id: '42' })
  vi.mocked(observe).mockReset().mockResolvedValue({ status: 'completed', detail: 'verified',
    result: JSON.stringify({ outputs: [{ video_url: 'https://example.test/review.mp4' }] }) })
})

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'jubian-recovery-worker-'))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const key = 'recover-original'
  await mkdir(join(project, 'video_tasks'))
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
  await writeFile(join(project, 'video_tasks', 'preview.json'), '{}')
  const ledger = new JubianLedger({ root: join(project, 'ledger') })
  const controller = new AbortController()
  const fetch = vi.fn<typeof globalThis.fetch>()
  const client = new JubianClient({ credential: async () => 'fixture-token', fetch })
  const inspect = vi.fn(async (_url: string, _signal: AbortSignal) => ({ sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true }))
  const failed = vi.fn(() => { controller.abort() })
  const report = join(project, 'video_tasks', 'review', createHash('sha256').update(key).digest('hex') + '.json')
  return { project, key, ledger, controller, inspect, failed, report,
    run: (keys: readonly string[] | null = [key]) => runVideoRecovery(client, ledger, project,
      keys ?? undefined, 1, controller.signal, failed, inspect) }
}

it.each(['completed', 'failed'] as const)('publishes %s evidence once and skips it after restart', async (status) => {
  const f = await fixture()
  if (status === 'failed') vi.mocked(observe).mockResolvedValue({ status, detail: 'provider refused' })
  await f.run()
  expect(JSON.parse(await readFile(f.report, 'utf8'))).toMatchObject({
    idempotency_key: f.key, task_id: 42, status: status === 'completed' ? 'awaiting_review' : 'provider_failed',
    media_checks: status === 'completed' ? [{ video: true, audio: true }] : [],
  })
  expect(f.inspect).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0)
  expect(f.failed).not.toHaveBeenCalled()
  await f.run()
  expect(recoverVideoSubmission).toHaveBeenCalledOnce()
})

it('retries unresolved submission and pending completion before publishing', async () => {
  const f = await fixture()
  vi.mocked(recoverVideoSubmission).mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ status: 'reconcile_required' })
  vi.mocked(observe).mockResolvedValueOnce(undefined)
  await f.run()
  expect(recoverVideoSubmission).toHaveBeenCalledTimes(4)
  expect(observe).toHaveBeenCalledTimes(2)
  expect(f.inspect).toHaveBeenCalledOnce()
  expect(f.failed).not.toHaveBeenCalled()
})

it('publishes multiple independent reports into an existing review directory', async () => {
  const f = await fixture()
  await f.run([f.key, 'another-key'])
  expect(f.inspect).toHaveBeenCalledTimes(2)
  expect(f.failed).not.toHaveBeenCalled()
})

it('stops after cancellation by the error receiver', async () => {
  const f = await fixture()
  vi.mocked(recoverVideoSubmission).mockRejectedValue(new Error('provider unavailable'))
  await f.run([f.key, 'another-key'])
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.key)
  expect(recoverVideoSubmission).toHaveBeenCalledOnce()
})

it('suppresses an in-flight failure once shutdown has begun', async () => {
  const f = await fixture()
  vi.mocked(recoverVideoSubmission).mockImplementation(async () => {
    f.controller.abort(); throw new Error('provider stopped')
  })
  await f.run()
  expect(f.failed).not.toHaveBeenCalled()
})

it.each(['recover', 'observe', 'inspect', 'report-directory'] as const)('reports an unsuccessful %s check without a review', async (stage) => {
  const f = await fixture()
  if (stage === 'recover') vi.mocked(recoverVideoSubmission).mockRejectedValue(new Error('read failed'))
  if (stage === 'observe') vi.mocked(observe).mockRejectedValue(new Error('read failed'))
  if (stage === 'inspect') f.inspect.mockRejectedValue(new Error('decode failed'))
  if (stage === 'report-directory') await writeFile(join(f.project, 'video_tasks', 'review'), 'replaced')
  await f.run()
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.key)
  await expect(readFile(f.report)).rejects.toThrow()
})

it.each(['recover', 'observe', 'inspect'] as const)('drains cancellation during %s without reporting a retry', async (stage) => {
  const f = await fixture()
  if (stage === 'recover') vi.mocked(recoverVideoSubmission).mockImplementation(async () => {
    f.controller.abort(); return { status: 'submitted', task_id: '42' }
  })
  if (stage === 'observe') vi.mocked(observe).mockImplementation(async () => {
    f.controller.abort(); return { status: 'failed', detail: 'stopped' }
  })
  if (stage === 'inspect') f.inspect.mockImplementation(async () => {
    f.controller.abort(); return { sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true }
  })
  await f.run()
  expect(f.failed).not.toHaveBeenCalled()
  await expect(readFile(f.report)).rejects.toThrow()
})

it('discovers only project-owned intents and does not repeat finished checks', async () => {
  const f = await fixture()
  await f.ledger.begin({ idempotencyKey: f.key, method: 'storyboard_native_submit', scriptId: 1,
    requestSha256: 'request', beforeTaskIds: [], videoPreviewPath: join(f.project, 'video_tasks', 'preview.json') })
  await f.ledger.begin({ idempotencyKey: 'other-project', method: 'storyboard_native_submit', scriptId: 1,
    requestSha256: 'request', beforeTaskIds: [], videoPreviewPath: join(f.project, 'other', 'preview.json') })
  const original = f.ledger.records.bind(f.ledger)
  const records = vi.spyOn(f.ledger, 'records')
  onTestFinished(() => { records.mockRestore() })
  records.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(async () => {
    f.controller.abort(); return await original()
  })
  await f.run(null)
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.inspect).toHaveBeenCalledOnce()
  expect(recoverVideoSubmission).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.ledger, f.project, f.key, f.controller.signal)
})

it.each([false, true])('handles ledger read failure with shutdown=%s', async (shutdown) => {
  const f = await fixture()
  const records = vi.spyOn(f.ledger, 'records').mockImplementation(async () => {
    if (shutdown) f.controller.abort()
    throw new Error('ledger unavailable')
  })
  onTestFinished(() => { records.mockRestore() })
  await f.run(null)
  expect(f.failed.mock.calls).toEqual(shutdown ? [] : [['ledger']])
})

it.each(['string', 'no-code', 'denied'] as const)('reports a review directory creation error %s', async (kind) => {
  const f = await fixture()
  const create = vi.spyOn(files, 'mkdir').mockRejectedValueOnce(kind === 'string' ? 'Creation denied'
    : kind === 'no-code' ? new Error('Creation denied') : Object.assign(new Error('Creation denied'), { code: 'EACCES' }))
  onTestFinished(() => { create.mockRestore() })
  await f.run()
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.key)
})

it('discovers an accepted legacy intent without a pre-dispatch snapshot', async () => {
  const f = await fixture()
  await f.ledger.begin({ idempotencyKey: f.key, method: 'storyboard_native_submit', scriptId: 1, requestSha256: 'request',
    videoPreviewPath: join(f.project, 'video_tasks', 'preview.json') })
  await f.ledger.settle(f.key, { outcome: 'accepted', httpStatus: 200, applicationCode: 200, responseSha256: 'response' })
  f.inspect.mockImplementationOnce(async () => {
    f.controller.abort()
    return { sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true }
  })
  await f.run(null)
  expect(recoverVideoSubmission).toHaveBeenCalledOnce()
})

it('propagates an unexpected timer failure while the worker is still active', async () => {
  const f = await fixture()
  vi.mocked(observe).mockResolvedValue(undefined)
  const wait = vi.spyOn(timers, 'setTimeout').mockRejectedValueOnce(new Error('Timer stopped'))
  onTestFinished(() => { wait.mockRestore() })
  await expect(f.run()).rejects.toThrow('Timer stopped')
})


it.skipIf(managedFfmpeg === undefined).each([false, true])(
  'retains an actual managed-decoder failure in the worker after cancellation=%s', async (cancelled) => {
    const f = await fixture(), ctx = new Context()
    let captured: string | undefined, joined = false
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      if (captured !== undefined && joined) await rm(dirname(captured), { recursive: true, force: true })
    })
    await ctx.plugin(SubprocessLocal)
    const configured = managedFfmpeg
    if (configured === undefined) throw new Error('Set MUSE_RECOVERY_TEST_FFMPEG to the reviewed bundled native decoder')
    const ffmpeg = await ctx.subprocess.resolveExecutable(configured), mediaPath = join(f.project, 'worker-input.mp4')
    const generated = ctx.subprocess.spawn({ argv: [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', 'color=black:size=32x32:rate=10', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono',
      '-t', '0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mediaPath],
    cwd: f.project, graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    expect((await generated.done).exitCode).toBe(0)
    expect(await generated.waitForExit()).toBe(true)
    const bytes = await readFile(mediaPath)
    vi.mocked(downloadMedia).mockReset().mockResolvedValueOnce({ bytes,
      sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), kind: 'video', media_type: 'video/mp4' })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const spawned = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec), wait = handle.waitForExit.bind(handle)
      const path = spec.argv[spec.argv.indexOf('-i') + 1]
      if (path === undefined) throw new Error('Decoder did not capture an input path')
      captured = path
      handle.waitForExit = async (signal) => {
        expect(signal).toBeUndefined()
        expect(await wait()).toBe(true)
        joined = true
        if (cancelled) f.controller.abort(new Error('operator cancelled'))
        throw new Error('provider lost its range observation')
      }
      return handle
    })
    f.inspect.mockImplementationOnce((url, signal) => checkVideoMedia(url, {
      subprocess: ctx.subprocess, ffmpegPath: ffmpeg, timeoutMs: 5000, graceMs: 100, maxOutputBytes: 4096,
    }, signal))
    await expect(f.run()).rejects.toBeInstanceOf(VideoMediaDrainError)
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(spawned).toHaveBeenCalledOnce()
    expect(downloadMedia).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
    expect(joined).toBe(true)
    if (captured === undefined) throw new Error('Expected retained captured media')
    expect(await readFile(captured)).toEqual(bytes)
    await expect(readFile(f.report)).rejects.toThrow()
  },
)


it('does not discover or query a project from a missing original intent', async () => {
  const f = await fixture()
  expect(await isProjectVideoIntent(undefined, join(f.project, 'not-selected'), f.controller.signal)).toBe(false)
  expect(recoverVideoSubmission).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
  expect(await f.ledger.records()).toEqual([])
})


it.each([false, true])('rejects an unconfirmed provider range without retry after cancellation=%s', async (cancelled) => {
  const f = await fixture()
  f.inspect.mockImplementationOnce(async () => {
    if (cancelled) f.controller.abort(new Error('provider operation cancelled'))
    throw new VideoMediaDrainError('provider range observation unavailable')
  })
  await expect(f.run()).rejects.toThrow('provider range observation unavailable')
  expect(f.inspect).toHaveBeenCalledOnce()
  expect(observe).toHaveBeenCalledOnce()
  expect(recoverVideoSubmission).toHaveBeenCalledOnce()
  expect(f.failed).not.toHaveBeenCalled()
  await expect(readFile(f.report)).rejects.toThrow()
})
