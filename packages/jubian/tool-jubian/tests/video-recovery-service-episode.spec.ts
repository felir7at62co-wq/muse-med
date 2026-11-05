/** Episode delivery validates renderer output and durable publication through the authenticated service. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { episodeDeliveryReceiptPath, readApprovedEpisodePlan } from '../src/episode-delivery.ts'
import { episodeFileExists, readEpisodeJob, writeEpisodeJob } from '../src/episode-delivery-job.ts'
import { decodeVideoFile } from '../src/video-media-check.ts'
import { reviewRecoveredVideo } from '../src/video-recovery.ts'
import { JubianVideoRecovery, type JubianVideoRecoveryOptions } from '../src/video-recovery-service.ts'
import type { ApprovedEpisodeRenderer } from '../src/types.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('../src/video-media-check.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/video-media-check.ts')>(), decodeVideoFile: vi.fn(),
}))

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

beforeEach(() => { vi.mocked(decodeVideoFile).mockReset().mockResolvedValue({ video: true, audio: true }) })

async function fixture(bgm = false) {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'jubian-service-episode-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const review = join(project, 'video_tasks', 'review')
  const editing = join(project, 'editing')
  const config = join(project, 'project_config.json')
  await mkdir(review, { recursive: true })
  await mkdir(editing)
  await mkdir(join(project, 'exports'))
  await writeFile(config, '{"jubian_script_id":1}\n')
  const timeline = join(editing, '01-timeline.json')
  const subtitle = join(editing, '01.srt')
  await writeFile(timeline, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1 }))
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await writeFile(join(editing, '01-mix.json'), JSON.stringify({ schema_version: 1, mode: bgm ? 'ducking' : 'no_bgm' }))
  if (bgm) await writeFile(join(editing, 'bgm.mp3'), 'background music')
  const key = 'service-episode-shot'
  const evidence = JSON.stringify({ idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + hash('approved shot'), video: true, audio: true }] })
  const ledger = new JubianLedger({ root: join(project, 'ledger') })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'sha256:' + hash('request'),
    scriptId: 1, beforeTaskIds: [], videoPreviewPath: join(project, 'video_tasks', 'shot.json') })
  await writeFile(join(review, hash(key) + '.json'), evidence)
  await reviewRecoveredVideo(project, key, { action: 'approve', digest: hash(evidence) })
  await writeFile(join(review, 'original-' + hash('approved shot') + '.mp4'), 'approved shot')
  const planPath = join(editing, '01-episode-delivery.json')
  const plan = { schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: key, review_digest: hash(evidence) }],
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', mix_profile: 'editing/01-mix.json',
    ...(bgm ? { bgm: 'editing/bgm.mp3' } : {}) }
  await writeFile(planPath, JSON.stringify(plan))
  const { digest, inputHashes } = await readApprovedEpisodePlan(project, 1)
  const request = { episode: 1, digest }
  const receipt = episodeDeliveryReceiptPath(project, 1, digest)
  const job = receipt.replace(/\.delivery\.json$/u, '.delivery-job.json')
  const attempt = randomUUID()
  const candidate = receipt.replace(/\.json$/u, `-${attempt}.mp4`)
  const media = 'rendered episode bytes'
  const delivery = { path: `exports/Supermuse-episode-01-${digest}.mp4`, sha256: hash(media), durationSeconds: 1,
    checks: [{ id: 'fixture', ok: true, detail: 'verified' }], inputHashes }
  const output = join(project, delivery.path)
  const render = vi.fn<ApprovedEpisodeRenderer['render']>(async ({ outputPath }) => {
    await writeFile(outputPath, media, { flag: 'wx' })
    return { durationSeconds: 1, checks: delivery.checks }
  })
  const clientForProject = vi.fn(() => { throw new Error('Cached approved source must not call the provider') })
  async function start(options: Partial<JubianVideoRecoveryOptions> = {}, renderer = true, fixed = true,
    drain = true, beforeMount?: (ctx: Context) => void) {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    if (renderer) ctx.provide('approvedEpisodeRenderer', { render })
    beforeMount?.(ctx)
    await ctx.plugin(JubianVideoRecovery, { ledger, settingsPath: join(project, 'recovery.json'), clientForProject,
      ffmpegPath: config, intervalMs: 60_000, decodeTimeoutMs: 60_000,
      ...(fixed ? { fixed: { projectDir: project } } : {}), ...options })
    // A queued report read drains the initial journal scan before each scenario mutates its files.
    if (fixed && drain) await ctx.jubianVideoRecovery.review({ action: 'read', idempotencyKey: key })
    return { ctx, service: ctx.jubianVideoRecovery }
  }
  return { project, review, editing, config, timeline, subtitle, planPath, plan, key, ledger, request, receipt, job,
    attempt, candidate, media, delivery, output, render, clientForProject, start }
}

it.each([false, true])('renders one approved episode and reuses the verified receipt, bgm=%s', async (bgm) => {
  const f = await fixture(bgm)
  const { service } = await f.start()
  const [first, second] = await Promise.all([service.deliverApprovedEpisode(f.request), service.deliverApprovedEpisode(f.request)])
  expect(first).toEqual(second)
  expect(first.delivery).toEqual(f.delivery)
  expect(f.render).toHaveBeenCalledOnce()
  expect(f.render.mock.calls[0]?.[0]).toMatchObject({ clips: [{ shot: 1, sha256: hash('approved shot') }],
    ...(bgm ? { bgmPath: join(f.editing, 'bgm.mp3') } : {}) })
  expect(await readFile(f.output, 'utf8')).toBe(f.media)
  expect(await episodeFileExists(f.job)).toBe(false)
  expect(f.clientForProject).not.toHaveBeenCalled()
})

it('does not scan a project replaced by another queued configuration', async () => {
  const first = await fixture()
  const second = await fixture()
  const { service } = await first.start({}, true, false)
  await Promise.all([
    service.configure({ enabled: false, projectDir: first.project }),
    service.configure({ enabled: false, projectDir: second.project }),
  ])
  await expect(service.review({ action: 'read', idempotencyKey: first.key })).rejects.toThrow('does not belong')
  expect(first.render).not.toHaveBeenCalled()
})

it('reports a non-Error failure from an individual resumed journal', async () => {
  const f = await fixture()
  await writeEpisodeJob(f.job, { phase: 'pending', attempt: f.attempt, inputHashes: f.delivery.inputHashes })
  f.render.mockRejectedValue('render unavailable')
  const warned = vi.fn()
  const restore: (() => void)[] = []
  try {
    await f.start({}, true, true, true, (ctx) => {
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(warned)
      restore.push(() => { warn.mockRestore() })
    })
    expect(warned).toHaveBeenCalledWith('Could not resume episode %s: %s', '01', 'render unavailable')
  } finally { for (const reset of restore) reset() }
})

it('stops the remaining journal scan after the Host aborts a resumed render', async () => {
  const f = await fixture()
  await writeEpisodeJob(f.job, { phase: 'pending', attempt: f.attempt, inputHashes: f.delivery.inputHashes })
  await writeFile(join(f.review, 'episode-02-' + '0'.repeat(64) + '.delivery-job.json'), '{}')
  const entered = Promise.withResolvers<AbortSignal>()
  f.render.mockImplementation(async (_input, signal) => {
    entered.resolve(signal)
    await new Promise<void>((done) => { signal.addEventListener('abort', () => { done() }, { once: true }) })
    signal.throwIfAborted()
    throw new Error('Aborted render must not return')
  })
  const { ctx } = await f.start({}, true, true, false)
  const signal = await entered.promise
  await ctx.fiber.dispose()
  expect(signal.aborted).toBe(true)
  expect(f.render).toHaveBeenCalledOnce()
})

it('suppresses a pending startup scan error after the owning Host closes', async () => {
  const f = await fixture()
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const closing = Promise.withResolvers<undefined>()
  const original = files.realpath
  const spy = vi.spyOn(files, 'realpath').mockImplementation(async (...args: Parameters<typeof files.realpath>) => {
    if (args[0] === f.review) {
      entered.resolve(undefined)
      await released.promise
      throw new Error('scan failed during shutdown')
    }
    return await original(...args)
  })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  ctx.effect(() => () => { closing.resolve(undefined) })
  ctx.provide('approvedEpisodeRenderer', { render: f.render })
  const service = new JubianVideoRecovery(ctx, { ledger: f.ledger, settingsPath: join(f.project, 'settings.json'),
    clientForProject: f.clientForProject, ffmpegPath: f.config, intervalMs: 60_000, decodeTimeoutMs: 60_000,
    fixed: { projectDir: f.project } })
  onTestFinished(async () => { released.resolve(undefined); await ctx.fiber.dispose(); spy.mockRestore(); warn.mockRestore() })
  await service[Service.init]()
  await entered.promise
  const disposal = ctx.fiber.dispose()
  await closing.promise
  released.resolve(undefined)
  await disposal
  expect(warn).not.toHaveBeenCalled()
})

it.each([0, 100, 1.5, Number.NaN])('refuses invalid episode number %s', async (episode) => {
  const f = await fixture()
  const { service } = await f.start()
  await expect(service.deliverApprovedEpisode({ ...f.request, episode })).rejects.toThrow('numbered episode')
})

it.each(['renderer', 'selection', 'digest', 'unapproved', 'occupied'] as const)
('refuses episode delivery with %s unavailable', async (kind) => {
  const f = await fixture()
  const { service } = await f.start({}, kind !== 'renderer', kind !== 'selection')
  if (kind === 'unapproved') await rm(join(f.review, hash(f.key) + '.json.decision.json'))
  if (kind === 'occupied') await writeFile(f.output, 'untracked output')
  const request = kind === 'digest' ? { ...f.request, digest: '0'.repeat(64) } : f.request
  await expect(service.deliverApprovedEpisode(request)).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
  expect(f.render).not.toHaveBeenCalled()
})

it.each(['missing-decoder', 'missing-video', 'missing-audio', 'empty-checks', 'failed-check', 'error', 'non-error', 'changed-input'] as const)
('keeps a resumable intent and removes rejected rendered bytes after %s', async (kind) => {
  const f = await fixture()
  const { service } = await f.start(kind === 'missing-decoder' ? { ffmpegPath: undefined } : {})
  if (kind === 'missing-video') vi.mocked(decodeVideoFile).mockResolvedValue({ video: false, audio: true })
  if (kind === 'missing-audio') vi.mocked(decodeVideoFile).mockResolvedValue({ video: true, audio: false })
  f.render.mockImplementation(async ({ outputPath }) => {
    await writeFile(outputPath, f.media)
    if (kind === 'error') throw new Error('Renderer failed')
    if (kind === 'non-error') throw 'renderer stopped'
    if (kind === 'changed-input') await writeFile(f.subtitle, 'Changed subtitles')
    return { durationSeconds: 1, checks: kind === 'empty-checks' ? [] : [{ id: 'fixture', ok: kind !== 'failed-check', detail: 'checked' }] }
  })
  await expect(service.deliverApprovedEpisode(f.request)).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
  const journal = await readEpisodeJob(f.job)
  expect(journal?.phase).toBe('pending')
  expect(await episodeFileExists(f.receipt)).toBe(false)
  const attempted = f.render.mock.calls[0]?.[0].outputPath
  expect(attempted).toBeDefined()
  expect(await episodeFileExists(attempted!)).toBe(false)
})

it.each(['output', 'hashes', 'empty-checks', 'failed-check'] as const)
('rejects a prepared journal whose %s differs from its verified intent', async (kind) => {
  const f = await fixture()
  const { service } = await f.start()
  const delivery = { ...f.delivery,
    ...(kind === 'output' ? { path: `exports/Supermuse-episode-02-${f.request.digest}.mp4` } : {}),
    ...(kind === 'hashes' ? { inputHashes: { ...f.delivery.inputHashes, subtitle: '0'.repeat(64) } } : {}),
    ...(kind === 'empty-checks' ? { checks: [] } : {}),
    ...(kind === 'failed-check' ? { checks: [{ id: 'fixture', ok: false, detail: 'failed' }] } : {}) }
  await writeEpisodeJob(f.job, { attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'prepared', delivery })
  await writeFile(f.output, f.media)
  await expect(service.deliverApprovedEpisode(f.request)).rejects.toThrow('does not match its journal')
})

it.each(['receipt-mismatch', 'pending-receipt', 'output-changed'] as const)
('refuses inconsistent published state %s', async (kind) => {
  const f = await fixture()
  const { service } = await f.start()
  await writeFile(f.output, kind === 'output-changed' ? 'changed' : f.media)
  await writeFile(f.receipt, JSON.stringify(f.delivery))
  if (kind !== 'output-changed') await writeEpisodeJob(f.job, kind === 'pending-receipt'
    ? { attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'pending' }
    : { attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'prepared',
      delivery: { ...f.delivery, durationSeconds: 2 } })
  await expect(service.deliverApprovedEpisode(f.request)).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
})

it('rejects a recorded episode whose public bytes changed when reading status', async () => {
  const f = await fixture()
  const { service } = await f.start()
  await writeFile(f.output, 'changed')
  await writeFile(f.receipt, JSON.stringify(f.delivery))
  await expect(service.status()).rejects.toThrow('recorded episode output changed')
})

it.each(['same', 'different', 'missing', 'permission', 'plain-error', 'non-error'] as const)
('checks the competing receipt writer after %s publication', async (kind) => {
  const f = await fixture()
  const { service } = await f.start()
  const original = files.link
  const fault = kind === 'non-error' ? 'receipt failed' : kind === 'plain-error' ? new Error('receipt failed')
    : Object.assign(new Error('receipt race'), { code: kind === 'permission' ? 'EACCES' : 'EEXIST' })
  const spy = vi.spyOn(files, 'link').mockImplementation(async (from, to) => {
    if (String(to) !== f.receipt) {
      await original(from, to)
      return
    }
    if (kind === 'same' || kind === 'different') await writeFile(f.receipt,
      JSON.stringify(kind === 'same' ? f.delivery : { ...f.delivery, durationSeconds: 2 }))
    throw fault
  })
  try {
    const result = service.deliverApprovedEpisode(f.request)
    if (kind === 'same') await expect(result).resolves.toMatchObject({ delivery: f.delivery })
    else await expect(result).rejects.toMatchObject({ code: 'jubian-video-recovery/rejected' })
  } finally { spy.mockRestore() }
  expect((await files.readdir(f.review)).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('accepts the matching receipt for a prepared output without replacing it', async () => {
  const f = await fixture()
  const { service } = await f.start()
  await writeEpisodeJob(f.job, { phase: 'prepared', attempt: f.attempt, inputHashes: f.delivery.inputHashes, delivery: f.delivery })
  await writeFile(f.receipt, JSON.stringify(f.delivery))
  await writeFile(f.output, f.media)
  await expect(service.deliverApprovedEpisode(f.request)).resolves.toMatchObject({ delivery: f.delivery })
  expect(f.render).not.toHaveBeenCalled()
})

it('rejects configuration bytes changed after the project was bound for delivery', async () => {
  const f = await fixture()
  const { service } = await f.start()
  const original = files.readFile
  let reads = 0
  const spy = vi.spyOn(files, 'readFile').mockImplementation(async (...args: Parameters<typeof files.readFile>) => {
    const result = await original(...args)
    if (args[0] === f.config && ++reads === 2) await writeFile(f.config, '{"jubian_script_id":1,"changed":true}')
    return result
  })
  try { await expect(service.deliverApprovedEpisode(f.request)).rejects.toThrow('inputs changed after delivery was requested') }
  finally { spy.mockRestore() }
})

it.each([new Error('cleanup failed'), 'cleanup failed'])('retains the render error when candidate cleanup fails with %s', async (cleanupError) => {
  const f = await fixture()
  const { ctx, service } = await f.start()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const original = files.unlink
  f.render.mockImplementation(async ({ outputPath }) => {
    await writeFile(outputPath, f.media)
    throw new Error('Original renderer failure')
  })
  const spy = vi.spyOn(files, 'unlink').mockImplementation(async (path) => {
    if (String(path).endsWith('.mp4')) throw cleanupError
    await original(path)
  })
  try {
    await expect(service.deliverApprovedEpisode(f.request)).rejects.toThrow('Original renderer failure')
    expect(warn).toHaveBeenCalledWith('Could not remove the rejected episode candidate: %s', 'cleanup failed')
  } finally { spy.mockRestore(); warn.mockRestore() }
})

it.each(['invalid-plan', 'undelivered'] as const)('reports %s episode summaries without a delivery receipt', async (kind) => {
  const f = await fixture()
  const { service } = await f.start()
  if (kind === 'invalid-plan') await writeFile(f.planPath, '{')
  await expect(service.status()).resolves.toMatchObject({ episodes: [{ readiness: kind === 'invalid-plan' ? 'invalid' : 'ready' }] })
})

it('propagates a non-missing project failure while enumerating episodes', async () => {
  const f = await fixture()
  const { service } = await f.start()
  const original = files.readFile
  let projectReads = 0
  const failure = Object.assign(new Error('project unavailable'), { code: 'EACCES' })
  const spy = vi.spyOn(files, 'readFile').mockImplementation(async (...args: Parameters<typeof files.readFile>) => {
    if (args[0] === f.config && ++projectReads === 2) throw failure
    return await original(...args)
  })
  try { await expect(service.status()).rejects.toBe(failure) }
  finally { spy.mockRestore() }
})

it.each(['missing', 'linked', 'permission', 'non-error'] as const)
('handles a %s startup journal directory without rendering', async (kind) => {
  const f = await fixture()
  const original = files.realpath
  const failure = kind === 'non-error' ? 'scan unavailable'
    : Object.assign(new Error('scan unavailable'), { code: kind === 'missing' ? 'ENOENT' : 'EACCES' })
  const spy = vi.spyOn(files, 'realpath').mockImplementation(async (...args: Parameters<typeof files.realpath>) => {
    if (String(args[0]) === f.review) {
      if (kind === 'linked') return f.editing
      throw failure
    }
    return await original(...args)
  })
  const warned = vi.fn()
  const restore: (() => void)[] = []
  try {
    const { service } = await f.start({}, true, true, false, (ctx) => {
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(warned)
      restore.push(() => { warn.mockRestore() })
    })
    await expect(service.review({ action: 'read', idempotencyKey: f.key })).resolves.toMatchObject({ decision: 'approve' })
    expect(f.render).not.toHaveBeenCalled()
    if (kind !== 'missing') expect(warned).toHaveBeenCalledWith('Could not resume episode deliveries: %s',
      kind === 'linked' ? 'Episode delivery requires a real project review directory' : 'scan unavailable')
  } finally { spy.mockRestore(); for (const reset of restore) reset() }
})
