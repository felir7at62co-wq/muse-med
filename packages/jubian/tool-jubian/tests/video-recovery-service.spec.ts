/** Recovery decisions, current-file truth and cancellation belong to one service lifetime. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JubianVideoRecovery } from '../src/video-recovery-service.ts'
import * as Recovery from '../src/video-recovery.ts'
import * as Files from 'node:fs/promises'
import * as media from '../src/video-media-check.ts'
import { resolveVideoRecovery } from '../src/video-recovery-config.ts'
import type { VideoRecoveryDigest } from '../src/types.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-recovery-service-')))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(SubprocessLocal)
  const project = join(root, 'project'), directory = join(project, 'video_tasks', 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
  const preview = join(project, 'video_tasks', 'preview.json')
  await writeFile(preview, '{}')
  const ledger = new JubianLedger({ root: join(root, 'ledger') }), key = 'original-video'
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'original', scriptId: 1,
    beforeTaskIds: [], videoPreviewPath: preview })
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash('approved bytes'), video: true, audio: true }] })
  await writeFile(join(directory, hash(key) + '.json'), evidence)
  await writeFile(join(directory, 'original-' + hash('approved bytes') + '.mp4'), 'approved bytes')
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No new provider operation is allowed') })
  const settingsPath = join(root, 'recovery.json')
  const options = { ledger, settingsPath, clientForProject: () => new JubianClient({ credential: async () => 'fixture', fetch }),
    ffmpegPath: process.execPath, intervalMs: 100, decodeTimeoutMs: 1000, decodeGraceMs: 50, decodeMaxOutputBytes: 4096 }
  const fiber = ctx.plugin(JubianVideoRecovery, options)
  await fiber.await()
  const service = ctx.jubianVideoRecovery
  const input = { idempotencyKey: key, digest: brandString<VideoRecoveryDigest>(hash(evidence)) }
  return { root, project, directory, preview, ledger, key, settingsPath, options, ctx, fiber, service, input, fetch }
}

function invocation(ctx: Context, signal: AbortSignal): JubianVideoRecovery {
  return ctx.extend({ invocation: {
    request: { namespace: 'jubianVideoRecovery', method: 'test', args: {} }, service: 'jubianVideoRecovery',
    peer: { id: brandString<PeerId>('test-peer'), ctx, dispose: async () => {} }, signal, async *uplink() {},
  } }).jubianVideoRecovery
}

it('persists one selected project, reviews once and repairs exact direct bytes without replacing an existing inode', async () => {
  const f = await fixture()
  expect(await f.service.status()).toMatchObject({ enabled: false, projectDir: null, reports: [] })
  expect(await f.service.configure({ enabled: true, projectDir: f.project })).toMatchObject(
    { enabled: true, reports: [{ decision: null }] })
  await expect(f.service.deliverApprovedMp4(f.input)).rejects.toThrow('approved video')
  await f.service.review({ ...f.input, action: 'reject', reason: '需要调整' })
  const reopened = await f.service.review({ ...f.input, action: 'reopen', reason: '重新核对原视频' })
  await expect(f.service.review({ ...f.input, action: 'approve' })).rejects.toThrow('current report')
  const current = { ...f.input, digest: reopened.digest }
  await f.service.review({ ...current, action: 'approve' })
  const delivered = await f.service.deliverApprovedMp4(current)
  const path = join(f.project, delivered.directDelivery!.path)
  expect(await readFile(path, 'utf8')).toBe('approved bytes')
  const identity = await stat(path)
  const original = join(f.directory, 'original-' + hash('approved bytes') + '.mp4')
  await unlink(original)
  expect((await f.service.deliverApprovedMp4(current)).directDelivery?.sha256).toBe(hash('approved bytes'))
  await unlink(join(f.directory, reopened.digest + '.direct-delivery.json'))
  await f.service.deliverApprovedMp4(current)
  expect(await stat(path)).toMatchObject({ ino: identity.ino, dev: identity.dev })
  await writeFile(original, 'approved bytes')
  await unlink(path)
  expect((await f.service.status()).reports[0]).toMatchObject({ directDeliveryProblem: 'missing' })
  expect((await f.service.status()).reports[0]).not.toHaveProperty('directDelivery')
  await f.service.deliverApprovedMp4(current)
  await writeFile(path, 'foreign bytes')
  expect((await f.service.status()).reports[0]).toMatchObject({ directDeliveryProblem: 'changed' })
  await expect(f.service.deliverApprovedMp4(current)).rejects.toThrow('different bytes')
  expect(await readFile(path, 'utf8')).toBe('foreign bytes')
  await f.fiber.dispose()
  const restarted = f.ctx.plugin(JubianVideoRecovery, f.options)
  await restarted.await()
  expect((await f.ctx.jubianVideoRecovery.status()).reports[0]).toMatchObject({ decision: 'approve',
    reopenedFrom: { rejectionReason: '需要调整', reason: '重新核对原视频' }, directDeliveryProblem: 'changed' })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('captures a derivative, requires its new digest and never changes its source file', async () => {
  const f = await fixture()
  vi.spyOn(media, 'decodeVideoFile').mockResolvedValue({ video: true, audio: true })
  await f.service.configure({ enabled: false, projectDir: f.project })
  const source = join(f.project, 'video_tasks', 'edited.mp4')
  await writeFile(source, 'derivative bytes')
  const adopted = await f.service.adopt({ ...f.input, path: 'video_tasks/edited.mp4' })
  expect(adopted.digest).not.toBe(f.input.digest)
  expect(adopted.derivative?.sha256).toBe(hash('derivative bytes'))
  await expect(f.service.review({ ...f.input, action: 'approve' })).rejects.toThrow('current report')
  await f.service.review({ ...f.input, digest: adopted.digest, action: 'approve' })
  expect((await f.service.deliverApprovedMp4({ ...f.input, digest: adopted.digest })).directDelivery?.sha256).toBe(hash('derivative bytes'))
  expect(await readFile(source, 'utf8')).toBe('derivative bytes')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('aborts and drains an admitted status without an invocation before disposal resolves', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const original = f.ledger.records.bind(f.ledger)
  vi.spyOn(f.ledger, 'records').mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return original() })
  const resolve = f.ctx.subprocess.resolveExecutable.bind(f.ctx.subprocess)
  vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockImplementation((name, env, signal) => {
    signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return resolve(name, env, signal)
  })
  const status = f.service.status()
  const rejected = expect(status).rejects.toThrow('disposed')
  await entered.promise
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  await expect(f.service.status()).rejects.toThrow('shutting down')
  release.resolve(undefined)
  await Promise.all([rejected, disposal])
  expect(disposed).toBe(true)
})

it('captures each caller signal before waiting and cancelling one request leaves the other request usable', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const original = f.ledger.records.bind(f.ledger)
  vi.spyOn(f.ledger, 'records').mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return original() })
  const controller = new AbortController()
  const cancelled = invocation(f.ctx, controller.signal).status()
  const rejected = expect(cancelled).rejects.toThrow('cancel-only-A')
  await entered.promise
  controller.abort(new Error('cancel-only-A'))
  const independent = await invocation(f.ctx, new AbortController().signal).status()
  expect(independent.reports).toHaveLength(1)
  release.resolve(undefined)
  await rejected
})

it('holds teardown until an admitted derivative decoder finishes its cancellation cleanup', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await writeFile(join(f.project, 'video_tasks', 'edit.mp4'), 'edited')
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(media, 'decodeVideoFile').mockImplementationOnce(async (_path, _decoder, signal) => {
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined); await release.promise; signal.throwIfAborted()
    return { video: true, audio: true }
  })
  const operation = f.service.adopt({ ...f.input, path: 'video_tasks/edit.mp4' })
  const rejected = expect(operation).rejects.toThrow('disposed')
  await entered.promise
  let disposed = false
  const disposal = f.fiber.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await Promise.all([rejected, disposal])
  expect((await Recovery.reviewRecoveredVideo(f.project, f.key)).decision).toBeNull()
})

it('rejects simultaneous recovery modes and invalid limits before mounting a worker', () => {
  expect(() => resolveVideoRecovery({ videoRecoverySettings: true, videoRecovery: {
    projectDir: '/project', ffmpegPath: '/decoder' } }, 1000)).toThrow('mutually exclusive')
  for (const config of [{ videoRecoveryDecodeGraceMs: 0 }, { videoRecoveryDecodeMaxOutputBytes: 0 },
    { videoRecovery: { projectDir: 'relative', ffmpegPath: '/decoder' } }]) {
    expect(() => resolveVideoRecovery(config, 1000)).toThrow()
  }
})


it('keeps the namespace available after a saved project disappears and accepts a replacement', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: true, projectDir: f.project })
  await f.fiber.dispose()
  await rm(f.project, { recursive: true })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const restarted = f.ctx.plugin(JubianVideoRecovery, f.options)
  await restarted.await()
  const service = f.ctx.jubianVideoRecovery
  expect(await service.status()).toMatchObject({ enabled: true, projectDir: f.project, projectProblem: 'unavailable' })
  expect(await service.configure({ enabled: false })).toMatchObject({ enabled: false, projectProblem: 'unavailable' })
  const replacement = join(f.root, 'replacement')
  await mkdir(replacement)
  await writeFile(join(replacement, 'project_config.json'), '{"jubian_script_id":2}')
  await mkdir(join(replacement, 'video_tasks'))
  expect(await service.configure({ enabled: true, projectDir: replacement })).toMatchObject(
    { enabled: true, projectDir: replacement, reports: [] })
  expect(JSON.parse(await readFile(f.settingsPath, 'utf8'))).toEqual({ enabled: true, projectDir: replacement })
  await restarted.dispose()
  expect(f.fetch).not.toHaveBeenCalled()
  warn.mockRestore()
})


it.each(['directory', 'relative', 'enabled-without-project'] as const)('refuses malformed saved settings rather than silently resetting them: %s', async (kind) => {
  const f = await fixture()
  await f.fiber.dispose()
  if (kind === 'directory') await mkdir(f.settingsPath)
  else await writeFile(f.settingsPath, JSON.stringify(kind === 'relative'
    ? { enabled: false, projectDir: 'relative' } : { enabled: true, projectDir: null }))
  await expect(f.ctx.plugin(JubianVideoRecovery, f.options).await()).rejects.toThrow(kind === 'directory' ? 'regular file' : 'absolute project')
})

it('does not disguise a saved-settings permission failure as missing settings', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  const original = Files.lstat
  vi.spyOn(Files, 'lstat').mockImplementation(async (path) => {
    if (String(path) === f.settingsPath) throw Object.assign(new Error('settings read denied'), { code: 'EACCES' })
    return original(path)
  })
  await expect(f.ctx.plugin(JubianVideoRecovery, f.options).await()).rejects.toThrow('settings read denied')
})

it('refuses actions without a selected project, wrong original keys, invalid reasons and stale provider reports', async () => {
  const f = await fixture()
  await expect(f.service.configure({ enabled: true })).rejects.toThrow('Select a Jubian project')
  await expect(f.service.review({ ...f.input, action: 'read' })).rejects.toThrow('Select a Jubian project')
  await f.service.configure({ enabled: false, projectDir: f.project })
  await expect(f.service.review({ ...f.input, idempotencyKey: 'foreign', action: 'read' })).rejects.toThrow('original submission')
  await expect(f.service.review({ ...f.input, action: 'approve', reason: 'extra' })).rejects.toThrow('only rejection')
  await expect(f.service.review({ ...f.input, action: 'reopen' })).rejects.toThrow('requires a reason')
  await expect(f.service.review({ ...f.input, action: 'read', reason: 'extra' })).rejects.toThrow('only rejection')
  expect(await f.service.review({ ...f.input, action: 'read' })).toMatchObject({ decision: null })
  const report = join(f.directory, hash(f.key) + '.json')
  await writeFile(report, JSON.stringify({ idempotency_key: 'foreign', task_id: 42, status: 'awaiting_review', media_checks: [] }))
  await expect(f.service.review({ ...f.input, action: 'read' })).rejects.toThrow('another original key')
  await expect(f.service.status()).rejects.toThrow('cannot be read')
  await unlink(report)
  expect((await f.service.status()).reports).toEqual([])
})

it('retains an optional rejection reason as absent through a single reopening', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'reject' })
  const report = await f.service.review({ ...f.input, action: 'reopen', reason: 'Recheck' })
  expect(report.reopenedFrom).toMatchObject({ rejectionReason: null })
  await f.service.review({ ...f.input, digest: report.digest, action: 'approve' })
  expect((await f.service.review({ ...f.input, action: 'read' })).decision).toBe('approve')
})

it.each(['invalid-media-hash', 'failed-track', 'extra-output'] as const)('keeps approval separate from technical deliverability: %s', async (kind) => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  const reportPath = join(f.directory, hash(f.key) + '.json')
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { media_checks: { sha256: string; video: boolean; audio: boolean }[] }
  if (kind === 'invalid-media-hash') report.media_checks[0]!.sha256 = 'unrecognized-media-id'
  if (kind === 'failed-track') report.media_checks[0]!.audio = false
  if (kind === 'extra-output') report.media_checks.push({ ...report.media_checks[0]! })
  await writeFile(reportPath, JSON.stringify(report))
  const current = await f.service.review({ ...f.input, action: 'read' })
  await f.service.review({ ...f.input, digest: current.digest, action: 'approve' })
  await expect(f.service.deliverApprovedMp4({ ...f.input, digest: current.digest })).rejects.toThrow('passing picture and audio')
})

it('reports a malformed direct receipt without exposing a delivered path', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'approve' })
  expect((await f.service.review({ ...f.input, action: 'read' })).directDelivery).toBeUndefined()
  await f.service.deliverApprovedMp4(f.input)
  expect((await f.service.review({ ...f.input, action: 'read' })).directDelivery).toBeDefined()
  await writeFile(join(f.directory, f.input.digest + '.direct-delivery.json'), '{"path":"foreign","sha256":"' + hash('foreign') + '"}')
  const current = await f.service.review({ ...f.input, action: 'read' })
  expect(current.directDeliveryProblem).toBe('unreadable')
  expect(current.directDelivery).toBeUndefined()
})

it('rejects an approval record for a different evidence digest', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await writeFile(join(f.directory, hash(f.key) + '.json.decision.json'), JSON.stringify({ action: 'approve', digest: '0'.repeat(64) }))
  await expect(f.service.review({ ...f.input, action: 'read' })).rejects.toThrow('another report')
})

it.each([undefined, '/missing-native-decoder'] as const)('allows reading with unavailable decoder %j but refuses enabling and adoption', async (ffmpegPath) => {
  const f = await fixture()
  await f.fiber.dispose()
  const fiber = f.ctx.plugin(JubianVideoRecovery, { ...f.options, ffmpegPath })
  await fiber.await()
  const service = f.ctx.jubianVideoRecovery
  expect(await service.status()).toMatchObject({ decoderAvailable: false })
  await service.configure({ enabled: false, projectDir: f.project })
  await expect(service.configure({ enabled: true })).rejects.toThrow('decoder is unavailable')
  await expect(service.adopt({ ...f.input, path: 'video_tasks/edited.mp4' })).rejects.toThrow('decoder is unavailable')
})

it('does not swallow an unexpected resolver failure', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockRejectedValueOnce(new Error('resolver unavailable'))
  await expect(f.service.status()).rejects.toThrow('resolver unavailable')
})

it('cancels a queued decision without cancelling the earlier derivative operation', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await writeFile(join(f.project, 'video_tasks', 'edit.mp4'), 'edited')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  vi.spyOn(media, 'decodeVideoFile').mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return { video: true, audio: true } })
  const first = f.service.adopt({ ...f.input, path: 'video_tasks/edit.mp4' })
  await entered.promise
  const cancellation = new AbortController()
  const next = invocation(f.ctx, cancellation.signal).review({ ...f.input, action: 'approve' })
  const rejected = expect(next).rejects.toThrow('queued decision cancelled')
  cancellation.abort(new Error('queued decision cancelled'))
  release.resolve(undefined)
  expect((await first).derivative).toBeDefined()
  await rejected
  expect((await Recovery.reviewRecoveredVideo(f.project, f.key)).decision).toBeNull()
})

it('fails disposal when a decoder range could not be confirmed, even after the request failed', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await writeFile(join(f.project, 'video_tasks', 'edit.mp4'), 'edited')
  vi.spyOn(media, 'decodeVideoFile').mockRejectedValueOnce(new media.VideoMediaDrainError('range observation lost'))
  await expect(f.service.adopt({ ...f.input, path: 'video_tasks/edit.mp4' })).rejects.toThrow('range observation lost')
  const failures: unknown[][] = []
  f.ctx.logger.exporter({ export(message) { if (message.type === 'error') failures.push(message.args) } })
  await f.fiber.dispose()
  expect(failures.flat()).toContainEqual(expect.objectContaining({ message: 'range observation lost' }))
  expect((await Files.readdir(f.directory)).some(name => name.startsWith('artifact-'))).toBe(true)
})

it('drains an old worker during shutdown without starting the newly persisted selection', async () => {
  const f = await fixture()
  const stopped = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const worker = vi.spyOn(Recovery, 'runVideoRecovery').mockImplementationOnce(async (_client, _ledger, _project, _keys, _interval, signal) => {
    signal.addEventListener('abort', () => { stopped.resolve(undefined) }, { once: true })
    await release.promise
  })
  await f.service.configure({ enabled: true, projectDir: f.project })
  const replacement = join(f.root, 'replacement')
  await mkdir(replacement)
  await writeFile(join(replacement, 'project_config.json'), '{"jubian_script_id":2}')
  const changed = f.service.configure({ enabled: true, projectDir: replacement })
  const rejected = expect(changed).rejects.toThrow('disposed')
  await stopped.promise
  const disposed = f.fiber.dispose()
  release.resolve(undefined)
  await Promise.all([rejected, disposed])
  expect(worker).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(f.settingsPath, 'utf8'))).toEqual({ enabled: true, projectDir: replacement })
})

it.each([new Error('worker stopped'), 'worker stopped'] as const)('contains an unexpected worker failure without losing the selected project', async (failure) => {
  const f = await fixture(), reported = Promise.withResolvers<undefined>()
  vi.spyOn(Recovery, 'runVideoRecovery').mockRejectedValueOnce(failure)
  f.ctx.logger.exporter({ export(message) {
    if (message.type === 'warn' && message.args.includes('worker stopped')) reported.resolve(undefined)
  } })
  await f.service.configure({ enabled: true, projectDir: f.project })
  await reported.promise
  expect((await f.service.status()).projectDir).toBe(f.project)
})


it.each([true, false])('rechecks the current approval before delivery, already published=%s', async (published) => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'approve' })
  if (published) await f.service.deliverApprovedMp4(f.input)
  const read = Recovery.reviewRecoveredVideo
  let count = 0
  vi.spyOn(Recovery, 'reviewRecoveredVideo').mockImplementation(async (...args) => {
    const report = await read(...args)
    return ++count === 2 ? { ...report, digest: 'f'.repeat(64), decision: null } : report
  })
  await expect(f.service.deliverApprovedMp4(f.input)).rejects.toThrow('approval changed before delivery')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('contains a cancelled worker failure and executes its managed-media callback', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>()
  vi.spyOn(media, 'checkVideoMedia').mockResolvedValueOnce({ sha256: 'sha256:' + hash('fixture'), video: true, audio: true })
  vi.spyOn(Recovery, 'runVideoRecovery').mockImplementationOnce(async (_client, _ledger, _project, _keys, _interval, signal, onError, inspect) => {
    onError(f.key)
    expect(await inspect('https://example.test/fixture.mp4', signal)).toMatchObject({ video: true, audio: true })
    entered.resolve(undefined)
    await new Promise<void>((resolve) =>{  signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    throw new Error('cancelled worker')
  })
  await f.service.configure({ enabled: true, projectDir: f.project })
  await entered.promise
  await f.fiber.dispose()
  expect(f.ctx.logger.buffer.some(message => message.type === 'warn' && String(message.args[0]).includes('read failed'))).toBe(true)
  expect(f.ctx.logger.buffer.some(message => message.args.includes('cancelled worker'))).toBe(false)
})


it('keeps a saved valid project selectable when its configured decoder is unavailable', async () => {
  const f = await fixture()
  await f.fiber.dispose()
  await writeFile(f.settingsPath, JSON.stringify({ enabled: true, projectDir: f.project }))
  await f.ctx.plugin(JubianVideoRecovery, { ...f.options, ffmpegPath: undefined }).await()
  expect(await f.ctx.jubianVideoRecovery.status()).toMatchObject({ enabled: true, projectDir: f.project, decoderAvailable: false })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('uses only a readonly project provider when an approved original cache needs repair', async () => {
  const f = await fixture()
  await f.service.configure({ enabled: false, projectDir: f.project })
  await f.service.review({ ...f.input, action: 'approve' })
  await unlink(join(f.directory, 'original-' + hash('approved bytes') + '.mp4'))
  await expect(f.service.deliverApprovedMp4(f.input)).rejects.toThrow()
  expect(f.fetch).toHaveBeenCalled()
  expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET' || init?.method === 'POST')).toBe(true)
  expect(await f.ledger.records()).toHaveLength(1)
})
