/** Authenticated project settings and review preserve decisions across Host lifetimes. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { RemoteError, type PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { verifyApprovedClipExport } from '../src/approved-clip-export.ts'
import { checkVideoMedia, decodeVideoFile } from '../src/video-media-check.ts'
import { materializeApprovedProviderVideo, reviewRecoveredVideo, runVideoRecovery } from '../src/video-recovery.ts'
import { JubianVideoRecovery, type JubianVideoRecoveryOptions } from '../src/video-recovery-service.ts'
import type { ApprovedClipDraftService } from '../src/types.ts'

vi.mock('../src/video-recovery.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/video-recovery.ts')>(),
  materializeApprovedProviderVideo: vi.fn(), runVideoRecovery: vi.fn(),
}))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('../src/video-media-check.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/video-media-check.ts')>(), decodeVideoFile: vi.fn(), checkVideoMedia: vi.fn(),
}))
vi.mock('../src/approved-clip-export.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/approved-clip-export.ts')>(), verifyApprovedClipExport: vi.fn(),
}))

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

beforeEach(() => {
  vi.mocked(runVideoRecovery).mockReset().mockImplementation(async (_client, _ledger, _project, _keys, _interval, signal) => {
    if (!signal.aborted) await new Promise<void>((done) => { signal.addEventListener('abort', () => { done() }, { once: true }) })
  })
  vi.mocked(decodeVideoFile).mockReset().mockResolvedValue({ video: true, audio: true })
  vi.mocked(checkVideoMedia).mockReset().mockResolvedValue({ sha256: 'sha256:' + hash('media'), video: true, audio: true })
  vi.mocked(verifyApprovedClipExport).mockReset().mockImplementation(async (_project, _source, sha256, path) => ({
    path, sha256, videoSimilarity: 1, audioSimilarity: 1,
  }))
  vi.mocked(materializeApprovedProviderVideo).mockReset()
})

function withInvocation(ctx: Context, signal: AbortSignal): JubianVideoRecovery {
  return ctx.extend({ invocation: {
    request: { namespace: 'jubianVideoRecovery', method: 'fixture', args: {} }, service: 'jubianVideoRecovery',
    peer: { id: 'fixture-peer' as PeerId, ctx, dispose: async () => {} }, signal,
    async *uplink() {},
  } }).jubianVideoRecovery
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jubian-video-service-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }) })
  const project = join(root, 'project')
  const directory = join(project, 'video_tasks', 'review')
  await mkdir(directory, { recursive: true })
  const config = join(project, 'project_config.json')
  await writeFile(config, '{"jubian_script_id":1}')
  const ffmpeg = join(root, 'ffmpeg')
  await writeFile(ffmpeg, 'decoder fixture')
  const settings = join(root, 'recovery.json')
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const key = 'reviewed-video'
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash('reviewed bytes'), video: true, audio: true }] })
  const reportPath = join(directory, hash(key) + '.json')
  await writeFile(reportPath, evidence)
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'request',
    scriptId: 1, beforeTaskIds: [], videoPreviewPath: join(project, 'video_tasks', 'preview.json') })
  const source = join(directory, 'original-' + hash('reviewed bytes') + '.mp4')
  await writeFile(source, 'reviewed bytes')
  vi.mocked(materializeApprovedProviderVideo).mockResolvedValue(source)
  const clientForProject = vi.fn(() => new JubianClient({ credential: async () => 'fixture-token',
    fetch: async () => { throw new Error('Unexpected provider request') } }))
  const create = vi.fn<ApprovedClipDraftService['create']>(async () => ({ path: join(root, 'draft'), name: 'Reviewed',
    editorOpenVerified: true }))
  const exportVideo = vi.fn<NonNullable<ApprovedClipDraftService['export']>>(async ({ outputPath }) => {
    await writeFile(outputPath, 'reviewed bytes')
    return { path: outputPath }
  })
  async function start(options: Partial<JubianVideoRecoveryOptions> = {}, provider?: ApprovedClipDraftService) {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    if (provider !== undefined) ctx.provide('approvedClipDraft', provider)
    await ctx.plugin(JubianVideoRecovery, { ledger, settingsPath: settings, clientForProject,
      ffmpegPath: ffmpeg, intervalMs: 10, decodeTimeoutMs: 1000, ...options })
    return { ctx, service: ctx.jubianVideoRecovery }
  }
  const input = { idempotencyKey: key, digest: hash(evidence) }
  return { root, project, directory, config, ffmpeg, settings, ledger, key, reportPath, source, input,
    create, exportVideo, clientForProject, start,
    approve: () => reviewRecoveredVideo(project, key, { action: 'approve', digest: input.digest }) }
}

it('persists the selected project and switch, starts one worker and drains it before restart', async () => {
  const f = await fixture()
  const first = await f.start()
  await expect(first.service.status()).resolves.toMatchObject({ enabled: false, projectDir: null, configurable: true,
    decoderAvailable: true, draftAvailable: false, automaticExportAvailable: false, reports: [], episodes: [] })
  await expect(first.service.configure({ enabled: true, projectDir: f.project }))
    .resolves.toMatchObject({ enabled: true, projectDir: f.project, reports: [{ taskId: 42, decision: null }] })
  expect(runVideoRecovery).toHaveBeenCalledOnce()
  await expect(first.service.configure({ enabled: false })).resolves.toMatchObject({ enabled: false, projectDir: f.project })
  expect(vi.mocked(runVideoRecovery).mock.calls[0]?.[5].aborted).toBe(true)
  expect(JSON.parse(await readFile(f.settings, 'utf8'))).toEqual({ enabled: false, projectDir: f.project })
  await first.ctx.fiber.dispose()
  const restarted = await f.start()
  await expect(restarted.service.status()).resolves.toMatchObject({ enabled: false, projectDir: f.project })
  await restarted.service.configure({ enabled: true })
  await restarted.ctx.fiber.dispose()
  expect(vi.mocked(runVideoRecovery).mock.calls[1]?.[5].aborted).toBe(true)
})

it('resumes a valid saved enabled worker and reports a missing decoder', async () => {
  const f = await fixture()
  await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: f.project }))
  const first = await f.start()
  expect(runVideoRecovery).toHaveBeenCalledOnce()
  await first.ctx.fiber.dispose()
  await rm(f.ffmpeg)
  const restarted = await f.start()
  await expect(restarted.service.status()).resolves.toMatchObject({ enabled: true, decoderAvailable: false })
  expect(runVideoRecovery).toHaveBeenCalledOnce()
})

it.each(['missing-selection', 'relative', 'missing-project', 'file-project', 'linked-project', 'missing-config',
  'invalid-config', 'invalid-binding', 'no-decoder', 'relative-decoder', 'save-error'] as const)
('rejects invalid operator configuration %s without starting a worker', async (kind) => {
  const f = await fixture()
  let project: string | undefined = f.project
  let decoder: string | undefined = f.ffmpeg
  if (kind === 'missing-selection') project = undefined
  if (kind === 'relative') project = 'relative-project'
  if (kind === 'missing-project') project = join(f.root, 'missing')
  if (kind === 'file-project') project = f.ffmpeg
  if (kind === 'linked-project') {
    project = join(f.root, 'linked-project')
    await symlink(f.project, project, process.platform === 'win32' ? 'junction' : 'dir')
  }
  if (kind === 'missing-config') await rm(f.config)
  if (kind === 'invalid-config') await writeFile(f.config, '{')
  if (kind === 'invalid-binding') await writeFile(f.config, '{"jubian_script_id":0}')
  if (kind === 'no-decoder') decoder = undefined
  if (kind === 'relative-decoder') decoder = 'ffmpeg'
  const { service } = await f.start({ ffmpegPath: decoder })
  if (kind === 'save-error') await mkdir(f.settings)
  await expect(service.configure({ enabled: true, ...(project === undefined ? {} : { projectDir: project }) }))
    .rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
  expect(runVideoRecovery).not.toHaveBeenCalled()
})

it.each(['directory', 'symlink', 'invalid-json', 'enabled-without-project', 'relative-project'] as const)
('refuses invalid saved settings %s during startup', async (kind) => {
  const f = await fixture()
  if (kind === 'directory') await mkdir(f.settings)
  if (kind === 'symlink') await symlink(f.config, f.settings, 'file')
  if (kind === 'invalid-json') await writeFile(f.settings, '{')
  if (kind === 'enabled-without-project') await writeFile(f.settings, '{"enabled":true,"projectDir":null}')
  if (kind === 'relative-project') await writeFile(f.settings, '{"enabled":false,"projectDir":"relative"}')
  await expect(f.start()).rejects.toThrow()
})

it('keeps deployment-managed choices read-only and filters fixed submission keys', async () => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project, keys: [] } })
  await expect(service.status()).resolves.toMatchObject({ configurable: false, enabled: true, reports: [] })
  await expect(service.configure({ enabled: false })).rejects.toThrow('deployment manages')
  await expect(service.review({ action: 'read', idempotencyKey: f.key })).rejects.toThrow('does not belong')
})

it('retains rejection, reopening and approval through a new service lifetime', async () => {
  const f = await fixture()
  const { ctx, service } = await f.start({ fixed: { projectDir: f.project } })
  await expect(service.review({ action: 'read', idempotencyKey: f.key })).resolves.toMatchObject({ decision: null })
  await expect(service.review({ ...f.input, action: 'reject', reason: 'Speech ends early' }))
    .resolves.toMatchObject({ decision: 'reject', reason: 'Speech ends early' })
  const reopened = await service.review({ ...f.input, action: 'reopen', reason: 'New audio check' })
  await expect(service.review({ idempotencyKey: f.key, digest: reopened.digest, action: 'approve' }))
    .resolves.toMatchObject({ decision: 'approve', reopenedFrom: { reason: 'New audio check' } })
  await ctx.fiber.dispose()
  const restarted = await f.start({ fixed: { projectDir: f.project } })
  await expect(restarted.service.status()).resolves.toMatchObject({ reports: [{ decision: 'approve',
    reopenedFrom: { rejectionReason: 'Speech ends early' } }] })
})

it.each([
  { action: 'approve', reason: 'not allowed' }, { action: 'reject', reason: ' ' },
  { action: 'reopen' }, { action: 'approve', digest: 'invalid' },
  { action: 'approve', digest: 'b'.repeat(64) }, { action: 'reopen', reason: 'Again' },
] as const)('rejects review mutation %j', async (change) => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } })
  await expect(service.review({ ...f.input, ...change })).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
})

it.each(['review', 'adopt', 'direct', 'draft'] as const)('requires project selection for %s', async (action) => {
  const f = await fixture()
  const { service } = await f.start({}, { create: f.create })
  const task = action === 'review' ? service.review({ ...f.input, action: 'read' })
    : action === 'adopt' ? service.adopt({ ...f.input, path: 'video_tasks/edited.mp4' })
      : action === 'direct' ? service.deliverApprovedMp4(f.input) : service.createDraft(f.input)
  await expect(task).rejects.toThrow('Select a Jubian project')
})

it('adopts a local derivative then drafts, exports, verifies and directly publishes its approval', async () => {
  const f = await fixture()
  const source = 'video_tasks/edited.mp4'
  await writeFile(join(f.project, source), 'edited video')
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create, export: f.exportVideo })
  const adopted = await service.adopt({ ...f.input, path: source })
  expect(adopted).toMatchObject({ decision: null, derivative: { sha256: hash('edited video') },
    mediaChecks: [{ video: true, audio: true }] })
  const input = { idempotencyKey: f.key, digest: adopted.digest }
  await service.review({ ...input, action: 'approve' })
  await expect(service.createDraft(input)).resolves.toMatchObject({ delivery: { draft: { name: 'Reviewed' } } })
  await service.createDraft(input)
  expect(f.create).toHaveBeenCalledOnce()
  await expect(service.deliverApprovedClip(input)).resolves.toMatchObject({ delivery: { export: { videoSimilarity: 1 } } })
  expect(f.create).toHaveBeenCalledTimes(2)
  expect(f.exportVideo).toHaveBeenCalledOnce()
  await expect(service.verifyExport({ ...input, path: 'exports/reviewed.mp4' }))
    .resolves.toMatchObject({ delivery: { export: { path: 'exports/reviewed.mp4' } } })
  const delivered = await service.deliverApprovedMp4(input)
  expect(delivered.directDelivery?.sha256).toBe(hash('edited video'))
  await expect(service.review({ ...input, action: 'read' })).resolves.toMatchObject({
    directDelivery: delivered.directDelivery, delivery: { export: { path: 'exports/reviewed.mp4' } },
  })
})

it('creates a draft for approved provider media and keeps its saved identity', async () => {
  const f = await fixture()
  await f.approve()
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create })
  vi.mocked(materializeApprovedProviderVideo).mockImplementationOnce(async (_project, _task, _hash, client) => {
    expect(client()).toBeInstanceOf(JubianClient)
    return f.source
  })
  await expect(service.status()).resolves.toMatchObject({ draftAvailable: true, automaticExportAvailable: false })
  await expect(service.createDraft(f.input)).resolves.toMatchObject({ delivery: { draft: { name: 'Reviewed' } } })
  expect(materializeApprovedProviderVideo).toHaveBeenCalledOnce()
  await expect(service.review({ ...f.input, action: 'read' })).resolves.toMatchObject({ delivery: { draft: { name: 'Reviewed' } } })
})

it.each(['adopt', 'export', 'verify'] as const)('requires an available decoder for %s', async (action) => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project }, ffmpegPath: undefined },
    { create: f.create, export: f.exportVideo })
  const result = action === 'adopt' ? service.adopt({ ...f.input, path: 'video_tasks/edited.mp4' })
    : action === 'export' ? service.deliverApprovedClip(f.input) : service.verifyExport({ ...f.input, path: 'exports/out.mp4' })
  await expect(result).rejects.toThrow('decoding is unavailable')
})

it.each(['draft', 'export'] as const)('reports an unavailable editor capability for %s', async (action) => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } })
  await expect(action === 'draft' ? service.createDraft(f.input) : service.deliverApprovedClip(f.input))
    .rejects.toThrow('unavailable on this Host')
})

it('rejects a stale approval, undecided media, cross-project key and export without a draft', async () => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create })
  await expect(service.createDraft(f.input)).rejects.toThrow('approved local video')
  await f.approve()
  await expect(service.createDraft({ ...f.input, digest: 'b'.repeat(64) })).rejects.toThrow('approved local video')
  await expect(service.createDraft({ ...f.input, idempotencyKey: 'other' })).rejects.toThrow('does not belong')
  await expect(service.adopt({ ...f.input, idempotencyKey: 'other', path: 'video_tasks/edited.mp4' }))
    .rejects.toThrow('does not belong')
  await expect(service.verifyExport({ ...f.input, path: 'exports/out.mp4' })).rejects.toThrow('Create the Jianying draft')
})

it.each(['review-json', 'report-key', 'decision-digest', 'provider-failure'] as const)
('wraps invalid persisted evidence %s in a review refusal', async (kind) => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } })
  if (kind === 'review-json') await writeFile(f.reportPath, '{')
  if (kind === 'report-key') await writeFile(f.reportPath, JSON.stringify({ idempotency_key: 'other', task_id: 42,
    status: 'awaiting_review', media_checks: [] }))
  if (kind === 'decision-digest') await writeFile(f.reportPath + '.decision.json', JSON.stringify({ action: 'approve', digest: 'b'.repeat(64) }))
  if (kind === 'provider-failure') await writeFile(f.reportPath, JSON.stringify({ idempotency_key: f.key, task_id: 42,
    status: 'provider_failed', media_checks: [] }))
  await expect(service.review({ ...f.input, action: kind === 'provider-failure' ? 'approve' : 'read' }))
    .rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
})

it('rejects new work after the Host has disposed its service', async () => {
  const f = await fixture()
  const { ctx, service } = await f.start({ fixed: { projectDir: f.project } })
  await ctx.fiber.dispose()
  await expect(service.review({ ...f.input, action: 'read' })).rejects.toThrow('Host is shutting down')
})

it.each(['configure', 'review', 'adopt', 'draft', 'direct', 'export', 'verify'] as const)
('propagates invocation cancellation through %s', async (action) => {
  const f = await fixture()
  const { ctx } = await f.start({}, { create: f.create, export: f.exportVideo })
  await ctx.jubianVideoRecovery.configure({ enabled: false, projectDir: f.project })
  await f.approve()
  await ctx.jubianVideoRecovery.createDraft(f.input)
  const source = 'video_tasks/edited.mp4'
  await writeFile(join(f.project, source), 'edited video')
  const controller = new AbortController()
  controller.abort(new Error('Client cancelled'))
  const service = withInvocation(ctx, controller.signal)
  const task = action === 'configure' ? service.configure({ enabled: false })
    : action === 'review' ? service.review({ ...f.input, action: 'reject' })
      : action === 'adopt' ? service.adopt({ ...f.input, path: source })
        : action === 'draft' ? service.createDraft(f.input)
          : action === 'direct' ? service.deliverApprovedMp4(f.input)
            : action === 'export' ? service.deliverApprovedClip(f.input)
              : service.verifyExport({ ...f.input, path: 'exports/out.mp4' })
  if (action === 'draft') await expect(task).resolves.toMatchObject({ delivery: { draft: { name: 'Reviewed' } } })
  else await expect(task).rejects.toThrow()
})

it.each(['draft', 'export', 'verify', 'direct'] as const)
('wraps an external %s failure and preserves an existing Remote refusal', async (action) => {
  const f = await fixture()
  await f.approve()
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create, export: f.exportVideo })
  const invoke = () => action === 'draft' ? service.createDraft(f.input)
    : action === 'export' ? service.deliverApprovedClip(f.input)
      : action === 'verify' ? service.verifyExport({ ...f.input, path: 'exports/out.mp4' }) : service.deliverApprovedMp4(f.input)
  if (action === 'verify') await service.createDraft(f.input)
  const owned = action === 'draft' ? f.create : action === 'export' ? f.exportVideo
    : action === 'verify' ? vi.mocked(verifyApprovedClipExport) : vi.mocked(materializeApprovedProviderVideo)
  for (const error of [new Error('Provider stopped'), 'Provider stopped',
    new RemoteError('jubian-video-recovery/rejected', 'Specific refusal', {})]) {
    owned.mockRejectedValueOnce(error)
    await expect(invoke()).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
  }
})

it('wraps invalid adoption and passes through an approved-file read failure', async () => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } })
  await expect(service.adopt({ ...f.input, digest: 'invalid', path: 'video_tasks/edited.mp4' }))
    .rejects.toThrow('Could not adopt')
  await f.approve()
  await rm(f.source)
  await expect(service.deliverApprovedMp4(f.input)).rejects.toThrow()
})

it('rejects editor output at a different path and an exports directory linked outside the project', async () => {
  const f = await fixture()
  await f.approve()
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create, export: f.exportVideo })
  f.exportVideo.mockResolvedValueOnce({ path: join(f.root, 'wrong.mp4') })
  await expect(service.deliverApprovedClip(f.input)).rejects.toThrow('unexpected export path')
  await rm(join(f.project, 'exports'), { recursive: true })
  await symlink(f.directory, join(f.project, 'exports'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(service.deliverApprovedClip(f.input)).rejects.toThrow('exports directory must be local')
})

it('refuses a provider review changed while its approved bytes are materialized', async () => {
  const f = await fixture()
  await f.approve()
  const { service } = await f.start({ fixed: { projectDir: f.project } }, { create: f.create })
  vi.mocked(materializeApprovedProviderVideo).mockImplementationOnce(async () => {
    await writeFile(f.reportPath, (await readFile(f.reportPath, 'utf8')) + '\n')
    await rm(f.reportPath + '.decision.json')
    return f.source
  })
  await expect(service.createDraft(f.input)).rejects.toThrow('review changed before delivery')
})

it('keeps missing reports out of status and refuses unreadable project data', async () => {
  const f = await fixture()
  const { service } = await f.start({ fixed: { projectDir: f.project } })
  await rm(f.reportPath)
  await expect(service.status()).resolves.toMatchObject({ reports: [] })
  await writeFile(f.reportPath, '{')
  await expect(service.status()).rejects.toThrow('report could not be read')
  await writeFile(f.config, '{}')
  await expect(service.status()).rejects.toThrow('configured Jubian project cannot be read')
  await rm(f.project, { recursive: true })
  await expect(service.status()).resolves.toMatchObject({ reports: [], episodes: [] })
})

it('reports a failed startup binding and drains worker errors and check callbacks', async () => {
  const f = await fixture()
  await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: join(f.root, 'missing') }))
  const missing = await f.start()
  expect(runVideoRecovery).not.toHaveBeenCalled()
  await missing.ctx.fiber.dispose()
  await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: f.project }))
  for (const error of [new Error('Worker stopped'), 'Worker stopped']) {
    vi.mocked(runVideoRecovery).mockImplementationOnce(async (_client, _ledger, _project, _keys, _interval, signal, failed, inspect) => {
      failed('fixture')
      await inspect('https://example.test/video.mp4', signal)
      throw error
    })
    const started = await f.start()
    await started.service.configure({ enabled: false })
    await started.ctx.fiber.dispose()
    await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: f.project }))
  }
  expect(checkVideoMedia).toHaveBeenCalledTimes(2)
})

it.each(['settings', 'decoder'] as const)('propagates a non-missing %s filesystem failure', async (target) => {
  const f = await fixture()
  const original = files.lstat
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    if (path === (target === 'settings' ? f.settings : f.ffmpeg)) throw new Error('Access denied')
    return await original(path, options)
  })
  onTestFinished(() => { inspect.mockRestore() })
  if (target === 'settings') await expect(f.start()).rejects.toThrow('Access denied')
  else {
    const { service } = await f.start()
    await expect(service.status()).rejects.toThrow('Access denied')
  }
})

it('does not apply saved settings after shutdown while the settings read is pending', async () => {
  const f = await fixture()
  await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: f.project }))
  const original = files.lstat
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    if (path === f.settings) { entered.resolve(undefined); await released.promise }
    return await original(path, options)
  })
  onTestFinished(() => { inspect.mockRestore(); released.resolve(undefined) })
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const service = new JubianVideoRecovery(ctx, { ledger: f.ledger, settingsPath: f.settings,
    clientForProject: f.clientForProject, ffmpegPath: f.ffmpeg, intervalMs: 10, decodeTimeoutMs: 1000 })
  const loading = service[Service.init]()
  await entered.promise
  await ctx.fiber.dispose()
  released.resolve(undefined)
  await loading
  expect(runVideoRecovery).not.toHaveBeenCalled()
})

it('warns when a saved project becomes unreadable with a non-Error filesystem failure', async () => {
  const f = await fixture()
  await writeFile(f.settings, JSON.stringify({ enabled: true, projectDir: f.project }))
  const original = files.lstat
  const inspect = vi.spyOn(files, 'lstat').mockImplementation(async (path, options) => {
    if (path === f.project) throw 'project unavailable'
    return await original(path, options)
  })
  onTestFinished(() => { inspect.mockRestore() })
  await f.start()
  expect(runVideoRecovery).not.toHaveBeenCalled()
})

it('does not start a replacement worker after shutdown interrupts a configuration save', async () => {
  const f = await fixture()
  const { ctx, service } = await f.start()
  await service.configure({ enabled: true, projectDir: f.project })
  const original = files.rename
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const save = vi.spyOn(files, 'rename').mockImplementation(async (source, target) => {
    if (target === f.settings) { entered.resolve(undefined); await released.promise }
    await original(source, target)
  })
  onTestFinished(() => { save.mockRestore(); released.resolve(undefined) })
  const changing = service.configure({ enabled: true })
  await entered.promise
  const closing = ctx.fiber.dispose()
  await vi.waitFor(() => { expect(vi.mocked(runVideoRecovery).mock.calls[0]?.[5].aborted).toBe(true) })
  released.resolve(undefined)
  await changing
  await closing
  expect(runVideoRecovery).toHaveBeenCalledOnce()
})
