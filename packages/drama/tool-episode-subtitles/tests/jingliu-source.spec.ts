import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { JingliuHttpError, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { jingliuSource, type JingliuSourceOptions } from '../src/source.ts'
import type { EpisodeSource, StoreShot } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: vi.fn(fs.mkdir) }
})

const firstPath = '/fw/media/generated/first.mp4'
const secondPath = '/fw/media/generated/second.mp4'
const shot = { shot_id: 'shot-1', order: 1, video_path: firstPath, clip_in_sec: 0.2, clip_dur_sec: 3, output_sec: 1.5,
  speed: 2, lines: ['你来了。'], subtitles: { status: 'missing' } }
const plan = (...shots: readonly unknown[]) => ({ names: ['青禾', null], episodes: [{ episode: 1, shots }] })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-jingliu-edit-plan-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const request = vi.fn<JingliuSession['request']>().mockResolvedValue(plan(shot))
  const downloads = (paths: readonly string[]) => new Map<string, LocalMedia>(paths.map(path => [path, {
    path, file: join(root, basename(path)), size: 10, contentType: 'video/mp4',
  }]))
  const download = vi.fn<NonNullable<JingliuSession['download']>>().mockImplementation(async paths => downloads(paths))
  const provider = (withDownloads = true, timing?: Pick<JingliuSourceOptions, 'jobWaitMs' | 'pollIntervalMs'>) =>
    jingliuSource({ root, project: 'film', jobWaitMs: 0, pollIntervalMs: 1000, ...timing,
      session: { identity: 'current-account', request, ...(withDownloads ? { download } : {}) } })
  return { root, request, download, downloads, provider }
}

it('refuses malformed edit plans before downloading media', async () => {
  const f = await fixture()
  for (const payload of [null, { names: [], episodes: [null] }, { names: [], episodes: [] },
    { names: [], episodes: [{ episode: 1, shots: null }] }, plan(null), plan({ ...shot, clip_dur_sec: -1 }),
    plan({ ...shot, speed: 0 }), plan({ ...shot, subtitles: { status: 'unknown' } })]) {
    f.request.mockResolvedValueOnce(payload)
    await expect(f.provider().resolve([1])).rejects.toMatchObject({ code: 'EPISODE_SUBTITLES_JINGLIU_INVALID' })
  }
  expect(f.download).not.toHaveBeenCalled()
  const forbidden = new JingliuHttpError(403, 'JINGLIU_HTTP_ERROR', 'Project permission denied')
  f.request.mockRejectedValueOnce(forbidden)
  await expect(f.provider().resolve([1])).rejects.toBe(forbidden)
})

it('reports missing video without downloading it and handles older edit plans without optional metadata', async () => {
  const f = await fixture()
  const missing = (order: number) => ({ ...shot, shot_id: `missing-${String(order)}`, video_path: null, order })
  f.request.mockResolvedValueOnce(plan()).mockResolvedValueOnce(plan(missing(8), shot, missing(5)))
    .mockResolvedValueOnce(plan({ ...shot, subtitles: { status: 'unverified' } }))
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'blocked', reason: 'shots_missing', shots: [] }])
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'blocked', reason: 'video_missing', shots: [8, 5] }])
  expect(f.download).not.toHaveBeenCalled()
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'ok', names: ['青禾'], shots: [{
    shot: 1, remote: { status: 'unverified', legacy: 1 }, jingliu: { etag: '', clip_in_us: 200_000, speed: 2 },
    window: { clipInUs: 200_000, durationUs: 3_000_000, speed: 2 },
  }] }])
})

it('isolates unavailable media and retries a failed batch when all individual videos can be read', async () => {
  const f = await fixture()
  const second = { ...shot, shot_id: 'shot-2', video_path: secondPath, order: 2 }
  f.request.mockResolvedValue(plan(shot, second))
  const missing = new Error('Video unavailable')
  f.download.mockRejectedValueOnce(missing).mockResolvedValueOnce(f.downloads([firstPath])).mockRejectedValueOnce(missing)
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'blocked', reason: 'media_unavailable', shots: [2] }])
  expect(f.download.mock.calls.map(([paths]) => paths)).toEqual([[firstPath, secondPath], [firstPath], [secondPath]])
  f.download.mockClear().mockRejectedValueOnce(new Error('Temporary batch read error'))
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'ok', shots: [{ shot: 1 }, { shot: 2 }] }])
  expect(f.download.mock.calls.map(([paths]) => paths))
    .toEqual([[firstPath, secondPath], [firstPath], [secondPath], [firstPath, secondPath]])
  f.download.mockResolvedValueOnce(f.downloads([firstPath]))
  await expect(f.provider().resolve([1])).resolves.toMatchObject([{ kind: 'blocked', reason: 'media_unavailable', shots: [2] }])
})

it('reports a Host without local downloads and preserves cancellation during the download', async () => {
  const f = await fixture()
  await expect(f.provider(false).resolve([1])).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_LOCAL_DISABLED' })
  const cancelled = new Error('Stopped this edit-plan read')
  f.download.mockRejectedValueOnce(new Error('Download interrupted'))
  await expect(f.provider().resolve([1], AbortSignal.abort(cancelled))).rejects.toBe(cancelled)
  expect(f.download).toHaveBeenCalledTimes(1)
})

async function publication(source: EpisodeSource) {
  const [episode] = await source.resolve([1])
  if (episode?.kind !== 'ok' || episode.shots.length === 0 || source.store === undefined) throw new Error('Expected a publishable Jingliu episode')
  const store = source.store.bind(source)
  const audioSha = 'a'.repeat(64)
  const candidates = episode.shots.map((shot): StoreShot => ({ shot,
    rules: { key: 'canonical-rules', audio_sha256: audioSha, words: [{ start: 0, end: 0.5, text: '你来了。', seg: 0 }],
      lines: shot.lines, names: [...episode.names], decisions: [], flags: [] },
    state: { shot: shot.shot, audio_sha256: audioSha, key: 'canonical-rules', cues: [], items: [] },
  }))
  return (prepare?: (shot: StoreShot) => StoreShot) => store(episode,
    prepare === undefined ? candidates : candidates.map(prepare), { replaceLegacy: false })
}

const segments = (shots: readonly unknown[], refused: readonly unknown[] = []) => JSON.stringify({ mode: 'segments', shots, refused })

it.each([
  { name: 'an invalid job status', job: { status: null } },
  { name: 'unreadable stored JSON', job: { status: 'done', result: '{' } },
  { name: 'a refused row without a shot ID', job: { status: 'done', result: segments([], [null]) } },
  { name: 'an unexpected refused shot', job: { status: 'done', result: segments([], [{ shot_id: 'another-shot' }]) } },
  { name: 'a written row without a shot ID', job: { status: 'done', result: segments([{ items: [] }]) } },
  { name: 'a written row with invalid review items', job: { status: 'done', result: segments([{ shot_id: 'shot-1', items: null }]) } },
  { name: 'an unexpected written shot', job: { status: 'done', result: segments([{ shot_id: 'another-shot', items: [] }]) } },
  { name: 'a malformed review item', job: { status: 'done', result: segments([{ shot_id: 'shot-1', items: [null] }]) } },
])('rejects $name without treating the episode as stored', async ({ job }) => {
  const f = await fixture()
  const store = await publication(f.provider())
  f.request.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce(job)
  await expect(store()).rejects.toMatchObject({ code: 'EPISODE_SUBTITLES_JINGLIU_INVALID' })
  expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/projects/film/edit-plan', '/jobs', '/jobs/job-1'])
})

it.each([
  { name: 'the service returns no subtitle rows for a completed job', job: { status: 'done', result: null }, reason: 'jingliu_outdated' },
  { name: 'the job fails', job: { status: 'failed', result: null }, reason: 'subtitle_job_failed' },
  { name: 'a requested row is missing', job: { status: 'done', result: segments([]) }, reason: 'subtitle_job_failed' },
  { name: 'the service refuses a requested row', job: { status: 'done', result: segments([], [{ shot_id: 'shot-1', reason: 'unavailable' }]) },
    reason: 'subtitle_job_failed' },
])('reports a blocked episode when $name', async ({ job, reason }) => {
  const f = await fixture()
  const store = await publication(f.provider())
  f.request.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce(job)
  await expect(store()).resolves.toMatchObject({ kind: 'blocked', reason, shots: [1] })
})

it('polls the acknowledged job within the configured wait and stores the exact returned review choice', async () => {
  const f = await fixture()
  const store = await publication(f.provider(true, { jobWaitMs: 60_000, pollIntervalMs: 10 }))
  const item = { id: 'review-1', kind: 'differ', heard: '来了', script: '到了', start: 0.1, end: 0.4, decision: 'script' }
  f.request.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce({ status: 'running' })
    .mockResolvedValueOnce({ status: 'done', result: segments([{ shot_id: 'shot-1', items: [item] }]) })
  await expect(store()).resolves.toEqual({ kind: 'stored', legacy: [], shots: new Map([[1, { items: [item],
    stored: { video_path: firstPath, key: 'canonical-rules', job: 'job-1' } }]]) })
  expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/projects/film/edit-plan', '/jobs', '/jobs/job-1', '/jobs/job-1'])
})

it('caps retries of a failed free subtitle job while preserving the original project scope', async () => {
  const f = await fixture()
  const store = await publication(f.provider())
  let jobs = 0
  f.request.mockImplementation(async (route) => {
    if (route === '/jobs') return { id: `job-${String(++jobs)}` }
    return { status: 'failed' }
  })
  for (let call = 0; call < 4; call++) {
    await expect(store()).resolves.toMatchObject({ kind: 'blocked', reason: 'subtitle_job_failed', shots: [1] })
  }
  expect(jobs).toBe(3)
  for (const [, options] of f.request.mock.calls.filter(([path]) => path === '/jobs')) {
    expect(options?.body).toMatchObject({ kind: 'auto_subtitles', payload: { project_id: 'film', episode: 1 } })
  }
})

it('keeps an unacknowledged subtitle job visible after its free retries are exhausted', async () => {
  const f = await fixture()
  const store = await publication(f.provider())
  f.request.mockImplementation(async (route) => {
    if (route === '/jobs') throw new Error('Connection closed before acknowledgement')
    throw new Error(`Unexpected request: ${route}`)
  })
  for (let call = 0; call < 4; call++) {
    await expect(store()).resolves.toEqual({ kind: 'blocked', reason: 'subtitle_job_unknown', shots: [1] })
  }
  expect(f.request.mock.calls.slice(1).map(([route]) => route)).toEqual(['/jobs', '/jobs', '/jobs'])
})

it('reports a conflicting receipt fingerprint without resubmitting the job', async () => {
  const f = await fixture()
  const store = await publication(f.provider())
  f.request.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce({ status: 'running' })
  await expect(store()).resolves.toEqual({ kind: 'waiting', changed: [] })
  const jobs = join(f.root, 'subtitles', 'jobs')
  const [fingerprint] = (await readdir(jobs)).filter(file => !file.endsWith('.json'))
  expect(fingerprint).toBeDefined()
  await writeFile(join(jobs, fingerprint!), 'a-different-request')
  await expect(store()).rejects.toMatchObject({ code: 'JINGLIU_JOB_CONFLICT' })
  expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/projects/film/edit-plan', '/jobs', '/jobs/job-1'])
})

it.each([
  { reason: 'video_changed', outcome: { kind: 'waiting', changed: [3, 8] } },
  { reason: 'unavailable', outcome: { kind: 'blocked', reason: 'subtitle_job_failed', shots: [3, 8] } },
  { reason: 'legacy_subtitles', outcome: { kind: 'stored', legacy: [3, 8] } },
])('reports $reason refusals in shot order', async ({ reason, outcome }) => {
  const f = await fixture()
  const planned = (order: number) => ({ ...shot, shot_id: `shot-${String(order)}`, order, video_path: `/fw/media/generated/${String(order)}.mp4` })
  f.request.mockResolvedValueOnce(plan(planned(8), planned(3), planned(13)))
  const store = await publication(f.provider())
  f.request.mockResolvedValueOnce({ id: 'job-1' }).mockResolvedValueOnce({ status: 'done', result: segments(
    [{ shot_id: 'shot-13', items: [] }], [{ shot_id: 'shot-8', reason }, { shot_id: 'shot-3', reason }],
  ) })
  const result = await store()
  expect(result).toMatchObject(outcome)
  if (result.kind === 'stored') expect([...result.shots.keys()]).toEqual([13])
})

it.each(['jingliu', 'remote'] as const)('refuses to publish a shot missing its %s edit-plan data', async (missing) => {
  const f = await fixture()
  const store = await publication(f.provider())
  await expect(store((candidate) => {
    const { jingliu, remote, ...shot } = candidate.shot
    if (!jingliu || !remote) throw new Error('Expected Jingliu edit-plan data')
    return { ...candidate, shot: missing === 'jingliu' ? { ...shot, remote } : { ...shot, jingliu } }
  })).rejects.toMatchObject({ code: 'EPISODE_SUBTITLES_JINGLIU_INVALID' })
  expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/projects/film/edit-plan'])
})

it('reports denied receipt-directory creation and keeps the job unsubmitted', async () => {
  const f = await fixture()
  const store = await publication(f.provider())
  const denied = Object.assign(new Error('Cannot create receipt directory'), { code: 'EACCES' })
  await vi.mocked(mkdir).withImplementation(async () => { throw denied }, async () => {
    await expect(store()).rejects.toBe(denied)
  })
  expect(f.request.mock.calls.map(([route]) => route)).toEqual(['/projects/film/edit-plan'])
})
