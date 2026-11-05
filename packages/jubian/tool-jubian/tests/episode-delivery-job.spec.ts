/** Episode delivery resumes verified publication from project-local state. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { expect, it, onTestFinished, vi } from 'vitest'
import { episodeDeliveryReceiptPath, readApprovedEpisodePlan, readEpisodeDelivery } from '../src/episode-delivery.ts'
import { ensureEpisodeDirectory, episodeFileExists, publishEpisodeCandidate, readEpisodeJob, removeEpisodeJobFile,
  writeEpisodeJob } from '../src/episode-delivery-job.ts'
import { reviewRecoveredVideo } from '../src/video-recovery.ts'
import { JubianVideoRecovery } from '../src/video-recovery-service.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-episode-job-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const review = join(project, 'video_tasks', 'review')
  const editing = join(project, 'editing')
  const config = join(project, 'project_config.json')
  await mkdir(review, { recursive: true })
  await mkdir(editing)
  await mkdir(join(project, 'exports'))
  await writeFile(config, '{"jubian_script_id":1}\n')
  await writeFile(join(editing, '01-timeline.json'), JSON.stringify({
    clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1,
  }))
  await writeFile(join(editing, '01.srt'), '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await writeFile(join(editing, '01-mix.json'), '{"schema_version":1,"mode":"no_bgm"}\n')
  const ledgerRoot = join(project, 'ledger')
  const key = 'episode-job-shot'
  const evidence = JSON.stringify({
    idempotency_key: key, task_id: 42, status: 'awaiting_review',
    media_checks: [{ sha256: 'sha256:' + sha256('shot'), video: true, audio: true }],
  })
  await new JubianLedger({ root: ledgerRoot }).begin({
    idempotencyKey: key, method: 'storyboard_native_submit', requestSha256: 'sha256:' + sha256('request'),
    scriptId: 1, beforeTaskIds: [], videoPreviewPath: join(project, 'video_tasks', 'shot.json'),
  })
  await writeFile(join(review, sha256(key) + '.json'), evidence)
  await reviewRecoveredVideo(project, key, { action: 'approve', digest: sha256(evidence) })
  await writeFile(join(editing, '01-episode-delivery.json'), JSON.stringify({
    schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: key, review_digest: sha256(evidence) }],
    timeline: 'editing/01-timeline.json', subtitle_srt: 'editing/01.srt', mix_profile: 'editing/01-mix.json',
  }))
  const { digest, inputHashes } = await readApprovedEpisodePlan(project, 1)
  const request = { episode: 1, digest }
  const receipt = episodeDeliveryReceiptPath(project, request.episode, request.digest)
  const job = receipt.replace(/\.delivery\.json$/u, '.delivery-job.json')
  const attempt = randomUUID()
  const candidate = receipt.replace(/\.json$/u, `-${attempt}.mp4`)
  const media = 'verified candidate MP4 bytes'
  const legacy = {
    path: `exports/Supermuse-episode-01-${digest}.mp4`, sha256: sha256(media), durationSeconds: 1,
    checks: [{ id: 'fixture', ok: true, detail: 'verified' }],
  }
  const delivery = { ...legacy, inputHashes }
  const output = join(project, delivery.path)
  const render = vi.fn(() => { throw new Error('Verified delivery must not rerender') })
  const clientForProject = vi.fn(() => { throw new Error('Verified delivery must not call the provider') })

  async function start() {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('approvedEpisodeRenderer', { render })
    await ctx.plugin(JubianVideoRecovery, {
      ledger: new JubianLedger({ root: ledgerRoot }), settingsPath: join(project, 'recovery.json'),
      ffmpegPath: undefined, intervalMs: 60_000, decodeTimeoutMs: 60_000, clientForProject,
      fixed: { projectDir: project },
    })
    return ctx
  }

  return {
    project, config, key, request, receipt, job, attempt, candidate, media, delivery, legacy, output, render, clientForProject, start,
  }
}

it.each([
  { state: 'the candidate has yet to be published', published: false },
  { state: 'the MP4 already exists without a receipt', published: true },
])('resumes a prepared delivery on startup when $state', async ({ published }) => {
  const f = await fixture()
  const first = await f.start()
  const review = { action: 'read', idempotencyKey: f.key } as const
  await expect(first.jubianVideoRecovery.review(review)).resolves.toMatchObject({ decision: 'approve' })
  await writeEpisodeJob(f.job, {
    attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'prepared', delivery: f.delivery,
  })
  await writeFile(published ? f.output : f.candidate, f.media)
  await first.fiber.dispose()
  const restarted = await f.start()
  // The report read queues behind startup publication.
  await expect(restarted.jubianVideoRecovery.review(review)).resolves.toMatchObject({ decision: 'approve' })
  expect(await readEpisodeDelivery(f.project, f.request.episode, f.request.digest)).toEqual(f.delivery)
  await expect(restarted.jubianVideoRecovery.deliverApprovedEpisode(f.request))
    .resolves.toMatchObject({ readiness: 'ready', delivery: f.delivery })
  expect(await readFile(f.output, 'utf8')).toBe(f.media)
  expect(await episodeFileExists(f.job)).toBe(false)
  expect(await episodeFileExists(f.candidate)).toBe(false)
  expect(f.render).not.toHaveBeenCalled()
  expect(f.clientForProject).not.toHaveBeenCalled()
})

it('preserves an occupied public path when it differs from the prepared MP4', async () => {
  const f = await fixture()
  const ctx = await f.start()
  await expect(ctx.jubianVideoRecovery.review({ action: 'read', idempotencyKey: f.key }))
    .resolves.toMatchObject({ decision: 'approve' })
  await writeEpisodeJob(f.job, {
    attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'prepared', delivery: f.delivery,
  })
  await writeFile(f.candidate, f.media)
  await writeFile(f.output, 'different MP4')
  await expect(ctx.jubianVideoRecovery.deliverApprovedEpisode(f.request))
    .rejects.toThrow('An existing episode output does not match the verified delivery')
  expect(await readFile(f.output, 'utf8')).toBe('different MP4')
  expect(await readFile(f.candidate, 'utf8')).toBe(f.media)
  expect(await episodeFileExists(f.receipt)).toBe(false)
  expect(f.render).not.toHaveBeenCalled()
})

it('rejects a bound receipt after the project config changes and keeps legacy receipts readable', async () => {
  const f = await fixture()
  await writeFile(f.output, f.media)
  await writeFile(f.receipt, JSON.stringify(f.delivery))
  const ctx = await f.start()
  const recovery = ctx.jubianVideoRecovery
  await expect(recovery.status()).resolves.toMatchObject({ episodes: [{ readiness: 'ready', delivery: f.delivery }] })
  await writeFile(f.config, '{"jubian_script_id":1,"changed":true}\n')
  expect((await readApprovedEpisodePlan(f.project, 1)).digest).toBe(f.request.digest)
  await expect(recovery.deliverApprovedEpisode(f.request)).rejects.toThrow('The episode inputs changed after delivery')
  const stale = (await recovery.status()).episodes?.[0]
  expect(stale).toMatchObject({ readiness: 'invalid' })
  expect(stale).not.toHaveProperty('delivery')
  expect(await readFile(f.receipt, 'utf8')).toBe(JSON.stringify(f.delivery))

  await writeFile(f.receipt, JSON.stringify(f.legacy))
  await expect(recovery.status()).resolves.toMatchObject({ episodes: [{ readiness: 'ready', delivery: f.legacy }] })
  await expect(recovery.deliverApprovedEpisode(f.request)).resolves.toMatchObject({ delivery: f.legacy })
  expect(f.render).not.toHaveBeenCalled()
  expect(f.clientForProject).not.toHaveBeenCalled()
})

it('does not link a candidate modified during the final input check', async () => {
  const f = await fixture()
  await writeFile(f.candidate, f.media)
  await expect(publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256, new AbortController().signal,
    async () => { await writeFile(f.candidate, 'changed candidate bytes') }))
    .rejects.toThrow('The verified episode candidate is missing or changed')
  expect(await episodeFileExists(f.output)).toBe(false)
})

it('keeps the receipt for an already published MP4 when configuration changes before restart', async () => {
  const f = await fixture()
  await writeEpisodeJob(f.job, {
    attempt: f.attempt, inputHashes: f.delivery.inputHashes, phase: 'prepared', delivery: f.delivery,
  })
  await writeFile(f.output, f.media)
  await writeFile(f.config, '{"jubian_script_id":1,"changed":true}\n')
  const ctx = await f.start()
  await ctx.jubianVideoRecovery.review({ action: 'read', idempotencyKey: f.key })
  expect(await readFile(f.receipt, 'utf8').then(JSON.parse)).toEqual(f.delivery)
  expect(await episodeFileExists(f.job)).toBe(false)
  const stale = (await ctx.jubianVideoRecovery.status()).episodes?.[0]
  expect(stale).toMatchObject({ readiness: 'invalid' })
  expect(stale).not.toHaveProperty('delivery')
  expect(f.render).not.toHaveBeenCalled()
})

it('creates missing real directories and rejects file and linked paths', async () => {
  const f = await fixture()
  const nested = join(f.project, 'new', 'nested')
  await ensureEpisodeDirectory(nested)
  expect((await files.lstat(nested)).isDirectory()).toBe(true)
  await writeFile(f.candidate, f.media)
  await expect(ensureEpisodeDirectory(f.candidate)).rejects.toThrow('real project directory')
  await expect(ensureEpisodeDirectory(f.project + '/editing/..')).rejects.toThrow('real project directory')
  const alias = join(f.project, 'directory-link')
  await symlink(nested, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(ensureEpisodeDirectory(alias)).rejects.toThrow('real project directory')
  await expect(episodeFileExists(nested)).rejects.toThrow('regular file')
  const fileLink = join(f.project, 'candidate-link.mp4')
  await symlink(f.candidate, fileLink, 'file')
  await expect(episodeFileExists(fileLink)).rejects.toThrow('regular file')
})

it.each([
  new Error('unclassified storage failure'),
  Object.assign(new Error('storage denied'), { code: 'EACCES' }),
  'storage unavailable',
])('preserves an unexpected filesystem failure (%j)', async (failure) => {
  const f = await fixture()
  for (const read of [episodeFileExists, ensureEpisodeDirectory]) {
    const inspect = vi.spyOn(files, 'lstat').mockRejectedValueOnce(failure)
    try { await expect(read(f.candidate)).rejects.toBe(failure) }
    finally { inspect.mockRestore() }
  }
})

it.each([
  new Error('mkdir failed'),
  Object.assign(new Error('mkdir denied'), { code: 'EACCES' }),
  'mkdir unavailable',
])('preserves a directory-creation failure (%j)', async (failure) => {
  const f = await fixture()
  const create = vi.spyOn(files, 'mkdir').mockRejectedValueOnce(failure)
  try { await expect(ensureEpisodeDirectory(join(f.project, 'new-folder'))).rejects.toBe(failure) }
  finally { create.mockRestore() }
})

it('accepts a directory created by another writer after its missing-file observation', async () => {
  const f = await fixture()
  const directory = join(f.project, 'raced-folder')
  const create = files.mkdir
  const mkdir = vi.spyOn(files, 'mkdir').mockImplementationOnce(async () => {
    await create(directory)
    throw Object.assign(new Error('created concurrently'), { code: 'EEXIST' })
  })
  try { await ensureEpisodeDirectory(directory) }
  finally { mkdir.mockRestore() }
  expect((await files.lstat(directory)).isDirectory()).toBe(true)
})

it('reads a pending journal and removes only an existing owned job file', async () => {
  const f = await fixture()
  expect(await readEpisodeJob(f.job)).toBeUndefined()
  const pending = { phase: 'pending', attempt: f.attempt, inputHashes: f.delivery.inputHashes } as const
  await writeEpisodeJob(f.job, pending)
  expect(await readEpisodeJob(f.job)).toEqual(pending)
  await removeEpisodeJobFile(f.job)
  await removeEpisodeJobFile(f.job)
  expect(await episodeFileExists(f.job)).toBe(false)
})

it.each([
  new Error('link failed'),
  Object.assign(new Error('link denied'), { code: 'EACCES' }),
  'link unavailable',
])('preserves a publication link failure (%j)', async (failure) => {
  const f = await fixture()
  await writeFile(f.candidate, f.media)
  const create = vi.spyOn(files, 'link').mockRejectedValueOnce(failure)
  try {
    await expect(publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256,
      new AbortController().signal, async () => {})).rejects.toBe(failure)
  } finally { create.mockRestore() }
  expect(await episodeFileExists(f.output)).toBe(false)
})

it.each([true, false])('verifies the competing writer after a publication race, present=%s', async (present) => {
  const f = await fixture()
  await writeFile(f.candidate, f.media)
  const create = vi.spyOn(files, 'link').mockImplementationOnce(async () => {
    if (present) await writeFile(f.output, f.media)
    throw Object.assign(new Error('other writer claimed the name'), { code: 'EEXIST' })
  })
  try {
    const publication = publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256,
      new AbortController().signal, async () => {})
    if (present) await publication
    else await expect(publication).rejects.toThrow('existing episode output does not match')
  } finally { create.mockRestore() }
})

it('preserves a different file that replaces the candidate link during publication', async () => {
  const f = await fixture()
  await writeFile(f.candidate, f.media)
  const link = files.link
  const create = vi.spyOn(files, 'link').mockImplementationOnce(async (candidate, output) => {
    await link(candidate, output)
    await unlink(f.output)
    await writeFile(f.output, 'replacement')
  })
  try {
    await expect(publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256,
      new AbortController().signal, async () => {})).rejects.toThrow('candidate changed during publication')
  } finally { create.mockRestore() }
  expect(await readFile(f.output, 'utf8')).toBe('replacement')
})

it('removes its own output link when its bytes change before final verification', async () => {
  const f = await fixture()
  await writeFile(f.candidate, f.media)
  const link = files.link
  const create = vi.spyOn(files, 'link').mockImplementationOnce(async (candidate, output) => {
    await link(candidate, output)
    await writeFile(f.output, 'changed')
  })
  try {
    await expect(publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256,
      new AbortController().signal, async () => {})).rejects.toThrow('existing episode output does not match')
  } finally { create.mockRestore() }
  expect(await episodeFileExists(f.output)).toBe(false)
  expect(await readFile(f.candidate, 'utf8')).toBe('changed')
})

it('rejects a missing private candidate before trying publication', async () => {
  const f = await fixture()
  await expect(publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256,
    new AbortController().signal, async () => {})).rejects.toThrow('candidate is missing or changed')
})

it('verifies an already published matching output without requiring a private candidate', async () => {
  const f = await fixture()
  await writeFile(f.output, f.media)
  await publishEpisodeCandidate(f.candidate, f.output, f.delivery.sha256, new AbortController().signal, async () => {})
  expect(await readFile(f.output, 'utf8')).toBe(f.media)
  expect(await episodeFileExists(f.candidate)).toBe(false)
})
