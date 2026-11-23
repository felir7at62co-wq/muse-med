import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as timers from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAsrError, type MuseAsrJob } from '@deepseek-ai/dsh-muse-account'
import { finishAudioTranscription, startAudioTranscription, startAudioTranscriptionBatch, type AudioAccount, type AudioMediaOperations } from '../src/runner.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('node:timers/promises', async original => ({ ...await original<typeof import('node:timers/promises')>() }))

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const config = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 1000, maxDurationSeconds: 18_000, maxAudioBytes: 1024 }

async function setup() {
  const project = await mkdtemp(join(tmpdir(), 'muse-audio-tool-'))
  directories.push(project)
  const input = join(project, 'source', 'clip.mp4')
  await import('node:fs/promises').then(fs => fs.mkdir(join(project, 'source')))
  await writeFile(input, 'video fixture')
  let submits = 0, queries = 0, job: MuseAsrJob = { id: randomUUID(), status: 'processing' }
  const account: AudioAccount = {
    status: async () => ({ state: 'signed-in', username: 'alice', verified: false }),
    submitAudio: async (_file, id) => { submits++; expect(await stat(join(project, 'transcript', 'jobs', 'clip-v1.json'))).toBeDefined(); job = { id, status: 'processing' }; return job },
    audioStatus: async (id) => { queries++; return { ...job, id } },
  }
  return { project, input, account, setJob: (next: MuseAsrJob) => { job = next }, counts: () => ({ submits, queries }) }
}

it('saves an account-bound receipt before submit and publishes versioned timed outputs once', async () => {
  const fixture = await setup()
  const media = { probe: async () => 45, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  expect(first.status).toBe('processing')
  expect((await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)).job_id).toBe(first.job_id)
  expect(fixture.counts().submits).toBe(1)
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 1.25, end: 2.5, text: '浣犲ソ' }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account)
  expect(done.output_txt).toContain('clip-v1.txt')
  expect(await readFile(done.output_txt!, 'utf8')).toBe('[00:00:01.250 --> 00:00:02.500] 浣犲ソ\n')
  expect(JSON.parse(await readFile(done.output_json!, 'utf8'))).toEqual([{ start: 1.25, end: 2.5, text: '浣犲ソ' }])
  expect((await finishAudioTranscription(fixture.project, first.receipt, fixture.account)).status).toBe('complete')
  expect(fixture.counts().queries).toBe(1)
  expect(await readdir(join(fixture.project, 'transcript', 'raw'))).toEqual(['clip-v1.json', 'clip-v1.srt', 'clip-v1.txt'])
})

it.each(['probing', 'staging'] as const)('stops overlapping starts at %s before creating a second job', async (phase) => {
  const fixture = await setup()
  const firstEntered = Promise.withResolvers<undefined>(), secondEntered = Promise.withResolvers<undefined>()
  const releaseFirst = Promise.withResolvers<undefined>(), releaseSecond = Promise.withResolvers<undefined>()
  let pauses = 0
  const pause = async () => {
    const first = ++pauses === 1
    const entered = first ? firstEntered : secondEntered
    const release = first ? releaseFirst : releaseSecond
    entered.resolve(undefined)
    await release.promise
  }
  const media: AudioMediaOperations = {
    probe: async () => { if (phase === 'probing') await pause(); return 20 },
    encode: async (_source, target) => {
      if (phase === 'staging') await pause()
      await writeFile(target, 'audio for one task')
    },
  }
  const start = () => startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const first = start()
  const outcomes = [first]
  void first.catch(() => undefined)
  try {
    await firstEntered.promise
    const second = start()
    outcomes.push(second)
    void second.catch(() => undefined)
    await secondEntered.promise
    releaseFirst.resolve(undefined)
    expect((await first).status).toBe('processing')
    releaseSecond.resolve(undefined)
    await expect(second).rejects.toThrow('Another transcription has started')
    expect(fixture.counts().submits).toBe(1)
    const files = await readdir(join(fixture.project, 'transcript', 'jobs'))
    expect(files.filter(file => file.endsWith('.json'))).toEqual(['clip-v1.json'])
    expect(files.filter(file => file.endsWith('.wav'))).toHaveLength(1)
  } finally {
    releaseFirst.resolve(undefined)
    releaseSecond.resolve(undefined)
    await Promise.allSettled(outcomes)
  }
})

it.each(['open', 'write'] as const)('cleans up a failed receipt %s before submitting', async (phase) => {
  const fixture = await setup()
  const jobs = join(fixture.project, 'transcript', 'jobs')
  const receipt = join(jobs, 'clip-v1.json')
  const failure = Object.assign(new Error('Synthetic receipt I/O failure'), { code: phase === 'open' ? 'EACCES' : 'ENOSPC' })
  const fs = await import('node:fs/promises')
  const originalOpen = fs.open
  let restoreWrite: (() => void) | undefined
  const open = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    if (file !== receipt || flags !== 'wx') return await originalOpen(file, flags, mode)
    if (phase === 'open') throw failure
    const handle = await originalOpen(file, flags, mode)
    const originalWrite = handle.writeFile.bind(handle)
    const write = vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await originalWrite('{')
      throw failure
    })
    restoreWrite = () => {
      write.mockRestore()
    }
    return handle
  })
  try {
    const media: AudioMediaOperations = {
      probe: async () => 20,
      encode: async (_source, target) => { await writeFile(target, 'staged audio') },
    }
    await expect(startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)).rejects.toBe(failure)
    expect(fixture.counts()).toEqual({ submits: 0, queries: 0 })
    expect(await readdir(jobs)).toEqual([])
  } finally {
    restoreWrite?.()
    open.mockRestore()
  }
})

it('resolves a relative input and receipt against the project root instead of the process directory', async () => {
  const fixture = await setup()
  const media = { probe: async () => 45, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, join('source', 'clip.mp4'), 'zh', fixture.account, config, media)
  expect(first.status).toBe('processing')
  expect(JSON.parse(await readFile(first.receipt, 'utf8'))).toMatchObject({ source: fixture.input })
  expect((await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)).job_id).toBe(first.job_id)
  expect(fixture.counts().submits).toBe(1)
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: '相对路径' }] })
  const done = await finishAudioTranscription(fixture.project, join('transcript', 'jobs', 'clip-v1.json'), fixture.account)
  expect(done.status).toBe('complete')
  expect(done.receipt).toBe(first.receipt)
})

it('reports exhausted provider allowance and later publishes the same original task without submitting again', async () => {
  const fixture = await setup()
  const media = { probe: async () => 45, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const metadata = { provider_diagnostic: { operation: 'query', http_status: 429, provider_code: '45000292', quota_type: 'audio_duration_lifetime' },
    recovery: { capability: 'query_original_task', next_action: 'inspect_receipt', automatic_resubmit: false, retry_after: 300 } } as const
  fixture.setJob({ id: first.job_id, status: 'uncertain', error_code: 'provider_rejected', ...metadata })
  const blocked = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1, probe: media.probe })
  expect(blocked).toMatchObject({ job_id: first.job_id, receipt: first.receipt, status: 'uncertain', retry_after_seconds: 300, ...metadata })
  expect(blocked.polling_note).toContain('原供应商应用的试用额度已用完')
  expect(blocked.resume_status).toMatchObject({ method: 'inspect', receipt: first.receipt })
  expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
  expect(JSON.parse(await readFile(first.receipt, 'utf8'))).toMatchObject({ id: first.job_id, ...metadata })
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: '原任务已完成' }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)
  expect(done.status).toBe('complete')
  expect(done.provider_diagnostic).toBeUndefined()
  expect(done.recovery).toBeUndefined()
  expect(done.job_id).toBe(first.job_id)
  expect(fixture.counts()).toEqual({ submits: 1, queries: 2 })
  expect(await readFile(done.output_txt!, 'utf8')).toContain('原任务已完成')
})

it('retains Flash lifetime-quota evidence without promising a provider query', async () => {
  const fixture = await setup()
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, shortMedia)
  const metadata = { service_version: 'flash', error_code: 'provider_rejected',
    provider_diagnostic: { operation: 'flash', http_status: 429, quota_type: 'audio_duration_lifetime' },
    recovery: { capability: 'no_query', next_action: 'inspect_receipt', automatic_resubmit: false } } as const
  fixture.setJob({ id: first.job_id, status: 'uncertain', ...metadata })
  const result = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1000, probe: shortMedia.probe })
  expect(result).toMatchObject({ job_id: first.job_id, status: 'uncertain', ...metadata })
  expect(result).not.toHaveProperty('resume_status')
  expect(result).not.toHaveProperty('polling_note')
  expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
})

it('returns the gateway delay instead of polling a pending original task before its next query', async () => {
  const fixture = await setup()
  const media = { probe: async () => 45, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  fixture.setJob({ id: first.job_id, status: 'processing', recovery: { capability: 'query_original_task', next_action: 'poll_original', automatic_resubmit: false, retry_after: 60 } })
  const pending = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1, probe: media.probe })
  expect(pending.retry_after_seconds).toBe(60)
  expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
})

it('waits for the longer gateway retry delay before querying the original task', async () => {
  const fixture = await setup()
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, shortMedia)
  fixture.setJob({ id: first.job_id, status: 'processing', recovery: { capability: 'query_original_task', next_action: 'poll_original', automatic_resubmit: false, retry_after: 4 } })
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const wait = vi.spyOn(timers, 'setTimeout').mockImplementationOnce(async (milliseconds) => {
    clock.mockReturnValue(milliseconds ?? 0)
    fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  })
  try {
    const result = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false,
      { waitMs: 5000, pollIntervalMs: 1000, probe: shortMedia.probe })
    expect(wait).toHaveBeenCalledExactlyOnceWith(4000, undefined, { signal: undefined })
    expect(result).toMatchObject({ job_id: first.job_id, status: 'complete' })
    expect(fixture.counts()).toEqual({ submits: 1, queries: 2 })
  } finally { wait.mockRestore(); clock.mockRestore() }
})

it.each([
  { waitMs: 1000, pollIntervalMs: 1000, elapsedMs: 1000, delays: 0 },
  { waitMs: 2000, pollIntervalMs: 1000, elapsedMs: 2000, delays: 1 },
])('returns the current result when a polling delay reaches the deadline ($waitMs ms)', async ({ waitMs, pollIntervalMs, elapsedMs, delays }) => {
  const fixture = await setup()
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, shortMedia)
  fixture.setJob({ id: first.job_id, status: 'processing', queued: true })
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const wait = vi.spyOn(timers, 'setTimeout').mockImplementationOnce(async () => { clock.mockReturnValue(elapsedMs) })
  try {
    const result = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false,
      { waitMs, pollIntervalMs, probe: shortMedia.probe })
    expect(wait).toHaveBeenCalledTimes(delays)
    expect(result).toMatchObject({ job_id: first.job_id, status: 'processing', queued: true })
    expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
  } finally { wait.mockRestore(); clock.mockRestore() }
})

it.each([
  { ids: [undefined, undefined], status: 'not_provided', labelled: 0, groups: 0 },
  { ids: ['0', undefined], status: 'partial', labelled: 1, groups: 1 },
  { ids: ['0', '0'], status: 'available', labelled: 2, groups: 1 },
  { ids: ['0', '1'], status: 'available', labelled: 2, groups: 2 },
] as const)('reports $status speaker coverage without changing timed transcripts or querying cached output', async ({ ids, status, labelled, groups }) => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media, 'screenplay')
  const segments = ids.map((id, index) => ({ start: index, end: index + 1, text: `原句${index + 1}`,
    ...(id === undefined ? {} : { speaker_id: id }) }))
  fixture.setJob({ id: first.job_id, status: 'complete', purpose: 'screenplay', segments })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)
  expect(done.speaker_summary).toMatchObject({ status, total_segments: 2, labelled_segments: labelled,
    unlabelled_segments: 2 - labelled, observed_groups: groups })
  expect(done.speaker_summary?.note).toContain('分组数不代表人数')
  expect(done.speaker_summary?.note).toContain('不构成音色试听或跨集身份确认')
  if (status === 'not_provided') expect(done.speaker_summary?.note).toContain('未提供说话人分组')
  else expect(done.speaker_summary?.note).toContain('output_json')
  const before = await Promise.all([done.output_json!, done.output_txt!, done.output_srt!].map(file => readFile(file, 'utf8')))
  expect(JSON.parse(before[0]!)).toEqual(segments)
  expect(before[1]).toBe('[00:00:00.000 --> 00:00:01.000] 原句1\n[00:00:01.000 --> 00:00:02.000] 原句2\n')
  expect(before[2]).toBe('1\n00:00:00,000 --> 00:00:01,000\n原句1\n\n2\n00:00:01,000 --> 00:00:02,000\n原句2\n')
  const cached = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)
  expect(cached.speaker_summary).toEqual(done.speaker_summary)
  expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
  expect(await Promise.all([done.output_json!, done.output_txt!, done.output_srt!].map(file => readFile(file, 'utf8')))).toEqual(before)
})

it('reports an invalid cached speaker label without altering the original receipt or resubmitting audio', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: '原句' }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)
  const receipt = await readFile(first.receipt, 'utf8')
  const invalid = JSON.stringify([{ start: 0, end: 1, text: '原句', speaker_id: 1 }])
  await writeFile(done.output_json!, invalid)
  await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)).rejects.toThrow('invalid speaker label')
  expect(await readFile(first.receipt, 'utf8')).toBe(receipt)
  expect(await readFile(done.output_json!, 'utf8')).toBe(invalid)
  expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
})

it.each([{}, [], [null], ['not a segment'], [{}], [{ text: 7 }]].map(rows => ({ rows })))(
  'reports malformed cached speech segments without changing the receipt or resubmitting (%j)', async ({ rows }) => {
    const fixture = await setup()
    const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
    const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
    fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: '原句' }] })
    const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false)
    const receipt = await readFile(first.receipt, 'utf8')
    const invalid = JSON.stringify(rows)
    await writeFile(done.output_json!, invalid)
    await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account, undefined, false))
      .rejects.toThrow('Published transcription JSON')
    expect(await readFile(first.receipt, 'utf8')).toBe(receipt)
    expect(await readFile(done.output_json!, 'utf8')).toBe(invalid)
    expect(fixture.counts()).toEqual({ submits: 1, queries: 1 })
  },
)

it.each([
  ['non-object', null, 'Invalid transcription receipt'],
  ['source digest', { sourceSha256: 'invalid' }, 'Invalid source digest'],
  ['purpose', { purpose: 'other' }, 'Invalid transcription purpose'],
  ['empty parts', { parts: [] }, 'Invalid transcription parts'],
  ['non-array parts', { parts: {} }, 'Invalid transcription parts'],
  ['non-object part', { parts: [null] }, 'Invalid transcription parts'],
  ['bad part fields', { parts: [{}] }, 'Invalid transcription parts'],
] as const)('rejects a corrupted %s receipt before a provider query and retains the bytes', async (_label, patch, message) => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  const content = JSON.stringify(patch === null ? null : { ...receipt, ...patch })
  await writeFile(first.receipt, content)
  await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account)).rejects.toThrow(message)
  expect(fixture.counts()).toEqual({ submits: 1, queries: 0 })
  expect(await readFile(first.receipt, 'utf8')).toBe(content)
})

it('rejects empty completed speech without marking the receipt complete or publishing output', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const before = await readFile(first.receipt, 'utf8')
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [] })
  await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account)).rejects.toThrow('no timed speech segments')
  expect(await readFile(first.receipt, 'utf8')).toBe(before)
  await expect(stat(join(fixture.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('keeps staged audio, receipts, and published transcripts private on Unix', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { mp3: string }
  for (const path of [join(fixture.project, 'transcript'), join(fixture.project, 'transcript', 'jobs')]) {
    expect((await stat(path)).mode & 0o777).toBe(0o700)
  }
  for (const path of [receipt.mp3, first.receipt]) expect((await stat(path)).mode & 0o777).toBe(0o600)
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account)
  expect((await stat(join(fixture.project, 'transcript', 'raw'))).mode & 0o777).toBe(0o700)
  for (const path of [done.output_txt!, done.output_json!, first.receipt]) expect((await stat(path)).mode & 0o777).toBe(0o600)
})

it('keeps silent recognition as a receipt without creating an empty raw transcript', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  fixture.setJob({ id: first.job_id, status: 'silent' })
  expect((await finishAudioTranscription(fixture.project, first.receipt, fixture.account)).status).toBe('silent')
  expect(await stat(join(fixture.project, 'transcript', 'raw')).then(() => true, () => false)).toBe(false)
})

it('removes expired uncertain audio while retaining its receipt and original job ID', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { mp3: string }
  fixture.setJob({ id: first.job_id, status: 'uncertain', retentionExpired: true })
  const pending = await finishAudioTranscription(fixture.project, first.receipt, fixture.account)
  expect(pending.status).toBe('uncertain')
  expect(pending.job_id).toBe(first.job_id)
  expect(await stat(receipt.mp3).then(() => true, () => false)).toBe(false)
  expect((await readFile(first.receipt, 'utf8'))).toContain(first.job_id)
  expect(fixture.counts().submits).toBe(1)
})

it('does not query or publish a receipt after a different Muse account signs in', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const other: AudioAccount = { ...fixture.account, status: async () => ({ state: 'signed-in', username: 'bob', verified: false }) }
  await expect(finishAudioTranscription(fixture.project, first.receipt, other)).rejects.toThrow('account that created')
  expect(fixture.counts().queries).toBe(0)
})

it('queries a prepared receipt before retrying the identical idempotency key', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'compressed audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(first.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  let used: string | undefined
  const retry: AudioAccount = { ...fixture.account,
    audioStatus: async () => { throw new MuseAsrError('job-not-found') },
    submitAudio: async (_file, id) => { used = id; return { id, status: 'processing' } },
  }
  expect((await finishAudioTranscription(fixture.project, first.receipt, retry)).status).toBe('processing')
  expect(used).toBe(first.job_id)
})


it('merges word timestamps onto the source clock and scopes speaker identities to each durable part', async () => {
  const fixture = await setup()
  const calls: Array<{ offset: number; duration: number }> = []
  const states = new Map<string, MuseAsrJob>()
  let submits = 0
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => { submits++; states.set(id, { id, status: 'processing' }); return states.get(id)! },
    audioStatus: async id => states.get(id)!,
  }
  const media = { probe: async () => 25, encode: async (_source: string, target: string, range?: { offset: number; duration: number }) => {
    calls.push(range!); await writeFile(target, 'audio')
  } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, { ...config, chunkSeconds: 10 }, media)
  expect(calls).toEqual([{ offset: 0, duration: 10 }, { offset: 10, duration: 10 }, { offset: 20, duration: 5 }])
  expect(submits).toBe(3)
  for (const id of states.keys()) states.set(id, { id, status: 'complete', segments: [{ start: 1, end: 2, text: 'hi', speaker_id: '0', words: [{ start: 1, end: 2, text: 'hi' }] }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, account)
  const segments = JSON.parse(await readFile(done.output_json!, 'utf8')) as NonNullable<MuseAsrJob['segments']>
  expect(segments.map(row => row.words?.[0]?.start)).toEqual([1, 11, 21])
  expect(segments.map(row => row.speaker_id)).toEqual([...states.keys()].map(id => `${id}:0`))
  expect(done.speaker_summary).toMatchObject({ status: 'available', total_segments: 3, labelled_segments: 3,
    unlabelled_segments: 0, observed_groups: 3 })
  expect(await readFile(done.output_srt!, 'utf8')).toContain('00:00:21,000 --> 00:00:22,000')
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).speaker_summary).toEqual(done.speaker_summary)
  expect(submits).toBe(3)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { sourceSha256: string }
  expect(receipt.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
})

it('preserves a pending part without re-submission and rejects out-of-part timing', async () => {
  const fixture = await setup()
  const ids: string[] = []
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => { ids.push(id); return { id, status: 'processing' } },
    audioStatus: async id => ({ id, status: 'uncertain' }),
  }
  const media = { probe: async () => 12, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, { ...config, chunkSeconds: 10 }, media)
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).status).toBe('uncertain')
  expect(ids).toHaveLength(2)
  account.audioStatus = async id => ({ id, status: 'complete', segments: [{ start: 0, end: 100, text: 'bad' }] })
  await expect(finishAudioTranscription(fixture.project, first.receipt, account)).rejects.toThrow('exceeds its audio part')
})


it('reconciles published output after an interrupted receipt save without overwriting changed text', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media)
  const before = await readFile(first.receipt, 'utf8')
  fixture.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 1, end: 2, text: 'hello' }] })
  const done = await finishAudioTranscription(fixture.project, first.receipt, fixture.account)
  await writeFile(first.receipt, before)
  expect((await finishAudioTranscription(fixture.project, first.receipt, fixture.account)).output_srt).toBe(done.output_srt)
  await writeFile(first.receipt, before)
  await writeFile(done.output_txt!, 'user correction')
  await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account)).rejects.toThrow()
  expect(await readFile(done.output_txt!, 'utf8')).toBe('user correction')
})

it('resumes pre-charge split preparation and expires unresolved audio without losing IDs', async () => {
  const fixture = await setup()
  const submissions: string[] = []
  let expire = false
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => { submissions.push(id); return { id, status: 'processing' } },
    audioStatus: async id => expire ? { id, status: 'uncertain', retentionExpired: true } : { id, status: 'preparing' },
  }
  const media = { probe: async () => 12, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, { ...config, chunkSeconds: 10 }, media)
  await finishAudioTranscription(fixture.project, first.receipt, account)
  expect(submissions.slice(2)).toEqual(submissions.slice(0, 2))
  expire = true
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).status).toBe('uncertain')
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as {
    parts: readonly { mp3: string; retentionExpired: boolean }[]
  }
  for (const part of receipt.parts) {
    expect(part.retentionExpired).toBe(true)
    expect(await stat(part.mp3).then(() => true, () => false)).toBe(false)
  }
  account.audioStatus = async () => { throw new MuseAsrError('job-not-found') }
  await expect(finishAudioTranscription(fixture.project, first.receipt, account)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(submissions).toHaveLength(4)
})

it('keeps a pending screenplay job while explicitly starting one versioned subtitles job', async () => {
  const fixture = await setup()
  const purposes: Array<string | undefined> = []
  const account: AudioAccount = { ...fixture.account, submitAudio: async (_file, id, _sha, _language, purpose) => {
    const receiptName = purpose === 'screenplay' ? 'clip-v1.json' : 'clip-v2.json'
    const receipt = JSON.parse(await readFile(join(fixture.project, 'transcript', 'jobs', receiptName), 'utf8')) as { purpose?: string }
    expect(receipt.purpose).toBe(purpose)
    purposes.push(purpose)
    return { id, status: 'processing' }
  } }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')
  expect(first.purpose).toBe('screenplay')
  const firstBytes = await readFile(first.receipt, 'utf8')
  expect((await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')).job_id).toBe(first.job_id)
  await expect(startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media)).rejects.toThrow('specify purpose explicitly')
  expect(purposes).toEqual(['screenplay'])
  const subtitles = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'subtitles')
  expect(subtitles).toMatchObject({ purpose: 'subtitles', status: 'processing' })
  expect(subtitles.receipt).toContain('clip-v2.json')
  expect(subtitles.job_id).not.toBe(first.job_id)
  expect(await readFile(first.receipt, 'utf8')).toBe(firstBytes)
  expect((await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'subtitles')).job_id).toBe(subtitles.job_id)
  expect(purposes).toEqual(['screenplay', 'subtitles'])
  const resume: AudioAccount = { ...account, audioStatus: async () => { throw new MuseAsrError('job-not-found') } }
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(first.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  expect((await finishAudioTranscription(fixture.project, first.receipt, resume)).purpose).toBe('screenplay')
  expect(purposes).toEqual(['screenplay', 'subtitles', 'screenplay'])
})

it('resolves omitted new purpose to subtitles and preserves legacy receipts without a purpose header', async () => {
  const fixture = await setup(), purposes: Array<string | undefined> = []
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id, _sha, _language, purpose) => { purposes.push(purpose); return { id, status: 'processing' } },
    audioStatus: async () => { throw new MuseAsrError('job-not-found') },
  }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media)
  expect(first.purpose).toBe('subtitles')
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  delete receipt.purpose
  await writeFile(first.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  const legacy = await finishAudioTranscription(fixture.project, first.receipt, account)
  expect(legacy).not.toHaveProperty('purpose')
  expect(purposes).toEqual(['subtitles', undefined])
})

it('pins every audio part to the receipt purpose and retains it when resuming preparation', async () => {
  const fixture = await setup(), purposes: Array<string | undefined> = []
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id, _sha, _language, purpose) => {
      const receipt = JSON.parse(await readFile(join(fixture.project, 'transcript', 'jobs', 'clip-v1.json'), 'utf8')) as { purpose?: string; parts: Array<{ purpose?: string }> }
      expect(receipt.purpose).toBe('screenplay')
      expect(receipt.parts.every(part => part.purpose === receipt.purpose)).toBe(true)
      purposes.push(purpose)
      return { id, status: 'processing' }
    },
    audioStatus: async id => ({ id, status: 'preparing' }),
  }
  const media = { probe: async () => 12, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, { ...config, chunkSeconds: 10 }, media, 'screenplay')
  await finishAudioTranscription(fixture.project, first.receipt, account)
  expect(purposes).toEqual(['screenplay', 'screenplay', 'screenplay', 'screenplay'])
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { parts: Array<{ purpose: string }> }
  receipt.parts[0]!.purpose = 'subtitles'
  await writeFile(first.receipt, JSON.stringify(receipt))
  await expect(finishAudioTranscription(fixture.project, first.receipt, account)).rejects.toThrow('purpose')
  expect(purposes).toHaveLength(4)
})

it('refuses gateway purpose drift without changing the persisted receipt or publishing results', async () => {
  const fixture = await setup()
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', fixture.account, config, media, 'screenplay')
  const before = await readFile(first.receipt, 'utf8')
  fixture.setJob({ id: first.job_id, status: 'complete', purpose: 'subtitles', segments: [{ start: 0, end: 1, text: 'hello' }] })
  await expect(finishAudioTranscription(fixture.project, first.receipt, fixture.account)).rejects.toThrow('purpose')
  expect(await readFile(first.receipt, 'utf8')).toBe(before)
  expect(await stat(join(fixture.project, 'transcript', 'raw')).then(() => true, () => false)).toBe(false)
})

it.each(['queue_full', 'upload_busy', 'request_rate', 'provider_rate'] as const)('returns a durable %s recovery call and uses the original ID when explicitly resumed', async (code) => {
  const fixture = await setup(), submissions: string[] = []
  let reject = true
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => {
      submissions.push(id)
      if (reject) throw new MuseAsrError(code, 12)
      return { id, status: 'processing', purpose: 'screenplay' }
    },
    audioStatus: async () => { throw new MuseAsrError('job-not-found') },
  }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')
  expect(first).toMatchObject({ error_code: code, retry_after_seconds: 12, purpose: 'screenplay', resume_status: { method: 'status', project: fixture.project.replaceAll('\\', '/'), receipt: first.receipt } })
  expect(submissions).toEqual([first.job_id])
  reject = false
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).status).toBe('processing')
  expect(submissions).toEqual([first.job_id, first.job_id])
})

it.each(['daily_quota', 'sign-in-required', 'idempotency_conflict'] as const)('retains a %s rejection without suggesting an immediate resubmit', async (code) => {
  const fixture = await setup()
  let submits = 0
  const account: AudioAccount = { ...fixture.account, submitAudio: async () => { submits++; throw new MuseAsrError(code) } }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const result = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')
  expect(result.error_code).toBe(code)
  expect(result).not.toHaveProperty('resume_status')
  expect(submits).toBe(1)
  expect(await stat(result.receipt)).toBeDefined()
})

it('reconciles an unknown submit before any retry and retains every split ID after a queue refusal', async () => {
  const fixture = await setup(), submissions: string[] = []
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => { submissions.push(id); throw new MuseAsrError('server-unavailable') },
    audioStatus: async id => ({ id, status: 'processing', purpose: 'screenplay' }),
  }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')
  expect(first.status).toBe('uncertain')
  await finishAudioTranscription(fixture.project, first.receipt, account)
  expect(submissions).toEqual([first.job_id])
  const other = await setup()
  const splitAccount: AudioAccount = { ...other.account, submitAudio: async () => { throw new MuseAsrError('queue_full', 5) } }
  const split = await startAudioTranscription(other.project, other.input, 'zh', splitAccount, { ...config, chunkSeconds: 10 }, media, 'screenplay')
  const receipt = JSON.parse(await readFile(split.receipt, 'utf8')) as { parts: Array<{ id: string; purpose: string }> }
  expect(receipt.parts).toHaveLength(3)
  expect(receipt.parts.every(part => part.purpose === 'screenplay')).toBe(true)
  expect(new Set(receipt.parts.map(part => part.id)).size).toBe(3)
  expect(split.error_code).toBe('queue_full')
})

it('attempts each confirmed absent task once per explicit status even when the submit stays preparing', async () => {
  const fixture = await setup(), submissions: string[] = []
  const account: AudioAccount = { ...fixture.account,
    submitAudio: async (_file, id) => { submissions.push(id); return { id, status: 'preparing' } },
    audioStatus: async () => { throw new MuseAsrError('job-not-found') },
  }
  const media = { probe: async () => 12, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, { ...config, chunkSeconds: 10 }, media, 'screenplay')
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).status).toBe('processing')
  expect(submissions).toHaveLength(4)
  expect(submissions.slice(2)).toEqual(submissions.slice(0, 2))
})

const shortMedia = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }

it('requires a signed-in account and a regular source before creating paid work', async () => {
  const f = await setup()
  const signedOut: AudioAccount = { ...f.account, status: async () => ({ state: 'signed-out' }) }
  await expect(startAudioTranscription(f.project, f.input, 'zh', signedOut, config, shortMedia)).rejects.toThrow('Sign in')
  await expect(startAudioTranscription(f.project, join(f.project, 'source'), 'zh', f.account, config, shortMedia)).rejects.toThrow('not a file')
  expect(f.counts()).toEqual({ submits: 0, queries: 0 })
})

it('retains an unfinished receipt for its original account and returns prepared work without resubmission', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const original = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  delete original.purpose
  await writeFile(first.receipt, JSON.stringify({ ...original, status: 'prepared' }))
  const other: AudioAccount = { ...f.account, status: async () => ({ state: 'signed-in', username: 'bob', verified: false }) }
  await expect(startAudioTranscription(f.project, f.input, 'zh', other, config, shortMedia)).rejects.toThrow('another Muse account')
  const resumed = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  expect(resumed).toMatchObject({ status: 'uncertain', job_id: first.job_id })
  expect(resumed).not.toHaveProperty('purpose')
  expect(f.counts().submits).toBe(1)
})

it('starts a later version after a terminal receipt and ignores unrelated job-directory files', async () => {
  const f = await setup()
  const account: AudioAccount = { ...f.account, submitAudio: async (_file, id) => ({ id, status: 'failed' }) }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)
  await writeFile(join(f.project, 'transcript', 'jobs', 'readme.txt'), 'receipt notes')
  const second = await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)
  expect(second.receipt).toContain('clip-v2.json')
  expect(second.job_id).not.toBe(first.job_id)
  expect(await readFile(join(f.project, 'transcript', 'jobs', 'readme.txt'), 'utf8')).toBe('receipt notes')
})

it('uses a stable media stem for a source whose extension consumes its basename', async () => {
  const f = await setup()
  const source = join(f.project, 'source', '.mp4')
  await writeFile(source, 'video')
  const account: AudioAccount = { ...f.account, submitAudio: async (_file, id) => ({ id, status: 'processing' }) }
  expect((await startAudioTranscription(f.project, source, 'zh', account, config, shortMedia)).receipt).toContain('media-v1.json')
})

it.each([0, Number.NaN, config.maxDurationSeconds + 1])('refuses a media duration of %s before submission', async (duration) => {
  const f = await setup()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, config,
    { ...shortMedia, probe: async () => duration })).rejects.toThrow('duration exceeds')
  expect(f.counts().submits).toBe(0)
})

it.each([0, 7_201, 1.5])('refuses an unsupported chunk duration of %s before extraction', async (chunkSeconds) => {
  const f = await setup()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account,
    { ...config, chunkSeconds }, shortMedia)).rejects.toThrow('Invalid cloud audio chunk duration')
  expect(f.counts().submits).toBe(0)
})

it.each([0, config.maxAudioBytes + 1])('removes an invalid %s-byte extraction before creating a receipt', async (size) => {
  const f = await setup()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, config,
    { ...shortMedia, encode: async (_source, target) => { await writeFile(target, Buffer.alloc(size)) } })).rejects.toThrow('size limit')
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
  expect(f.counts().submits).toBe(0)
})

it.each([false, true])('refuses a source changed during %s-part extraction before submission', async (split) => {
  const f = await setup()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account,
    { ...config, chunkSeconds: split ? 10 : 600 }, { ...shortMedia, encode: async (source, target) => {
      await writeFile(target, 'audio'); await writeFile(source, 'changed video')
    } })).rejects.toThrow('Media changed')
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
  expect(f.counts().submits).toBe(0)
})

it.each([false, true])('retains a %s-part receipt when the gateway returns another task ID', async (split) => {
  const f = await setup()
  const account: AudioAccount = { ...f.account, submitAudio: async () => ({ id: randomUUID(), status: 'processing' }) }
  await expect(startAudioTranscription(f.project, f.input, 'zh', account,
    { ...config, chunkSeconds: split ? 10 : 600 }, shortMedia)).rejects.toThrow(split ? 'different part ID' : 'different task ID')
  expect(await stat(join(f.project, 'transcript', 'jobs', 'clip-v1.json'))).toBeDefined()
})

it('rejects a receipt with invalid scalar fields without querying the gateway', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(first.receipt, JSON.stringify({ ...receipt, version: 0 }))
  await expect(finishAudioTranscription(f.project, first.receipt, f.account)).rejects.toThrow('Invalid transcription receipt')
  expect(f.counts().queries).toBe(0)
})

it.each(['outside', 'basename', 'media'] as const)('rejects receipt %s paths without querying or rewriting', async (kind) => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  if (kind === 'media') await writeFile(first.receipt, JSON.stringify({ ...receipt, mp3: f.input }))
  if (kind === 'basename') await writeFile(first.receipt, JSON.stringify({ ...receipt, stem: 'other' }))
  await expect(finishAudioTranscription(f.project, kind === 'outside' ? f.input : first.receipt, f.account)).rejects.toThrow(kind === 'outside' ? `inside this project transcript/jobs directory: ${join(f.project, 'transcript', 'jobs')}` : 'paths do not match')
  expect(f.counts().queries).toBe(0)
})

it('returns a status recovery call when the gateway cannot answer and does not resubmit', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const account: AudioAccount = { ...f.account, audioStatus: async () => { throw new MuseAsrError('response-invalid') } }
  const result = await finishAudioTranscription(f.project, first.receipt, account)
  expect(result).toMatchObject({ status: 'uncertain', error_code: 'response-invalid', resume_status: { method: 'status' } })
  expect(f.counts().submits).toBe(1)
})

it('keeps a completed legacy transcript without an SRT and recovers missing output through the original job', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  f.setJob({ id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  const done = await finishAudioTranscription(f.project, first.receipt, f.account)
  if (done.output_txt === undefined || done.output_json === undefined || done.output_srt === undefined) throw new Error('missing published transcript')
  await rm(done.output_srt)
  expect(await finishAudioTranscription(f.project, first.receipt, f.account)).not.toHaveProperty('output_srt')
  await rm(done.output_txt)
  expect((await finishAudioTranscription(f.project, first.receipt, f.account)).output_srt).toBe(done.output_srt)
  await rm(done.output_json)
  expect((await finishAudioTranscription(f.project, first.receipt, f.account)).status).toBe('complete')
  expect(f.counts().submits).toBe(1)
})

it.each(['preparing', 'failed'] as const)('resumes %s single-part preparation with its original ID', async (status) => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  f.setJob({ id: first.job_id, status })
  expect((await finishAudioTranscription(f.project, first.receipt, f.account)).status).toBe('processing')
  expect(f.counts().submits).toBe(2)
})

it('does not recreate a confirmed absent job after its local audio has expired', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  if (typeof receipt.mp3 !== 'string') throw new Error('missing staged audio')
  await rm(receipt.mp3)
  await writeFile(first.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  const account: AudioAccount = { ...f.account, audioStatus: async () => { throw new MuseAsrError('job-not-found') } }
  await expect(finishAudioTranscription(f.project, first.receipt, account)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(f.counts().submits).toBe(1)
})

it('retains a legacy receipt without a source digest and preserves processing status after a queue refusal', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  delete receipt.sourceSha256
  await writeFile(first.receipt, JSON.stringify(receipt))
  expect((await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)).job_id).toBe(first.job_id)
  const account: AudioAccount = { ...f.account, audioStatus: async () => { throw new MuseAsrError('queue_full') } }
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ status: 'processing', error_code: 'queue_full' })
  expect(f.counts().submits).toBe(1)
})

it.each([false, true])('rejects a changed gateway ID %s a preparation retry without publishing', async (retry) => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const before = await readFile(first.receipt, 'utf8')
  const account: AudioAccount = { ...f.account,
    audioStatus: async id => ({ id: retry ? id : randomUUID(), status: retry ? 'preparing' : 'processing' }),
    submitAudio: async () => ({ id: randomUUID(), status: 'processing' }),
  }
  await expect(finishAudioTranscription(f.project, first.receipt, account)).rejects.toThrow('different task ID')
  expect(await readFile(first.receipt, 'utf8')).toBe(before)
})

it('retains a failed job after its staged audio has expired without attempting a new submit', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { mp3: string }
  await rm(receipt.mp3)
  f.setJob({ id: first.job_id, status: 'failed' })
  expect((await finishAudioTranscription(f.project, first.receipt, f.account)).status).toBe('failed')
  expect(f.counts().submits).toBe(1)
})

async function splitFixture() {
  const f = await setup()
  const account: AudioAccount = { ...f.account, submitAudio: async (_file, id) => ({ id, status: 'processing' }) }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, { ...config, chunkSeconds: 20 }, shortMedia)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as {
    parts: { id: string; mp3: string; offset: number; retentionExpired?: boolean }[]
  }
  return { ...f, account, first, receipt }
}

it.each(['sequence', 'duplicate', 'path'] as const)('rejects a damaged part %s without querying or discarding audio', async (kind) => {
  const f = await splitFixture()
  const first = f.receipt.parts[0], last = f.receipt.parts[1]
  if (first === undefined || last === undefined) throw new Error('missing split parts')
  if (kind === 'sequence') last.offset = 5
  if (kind === 'duplicate') { last.id = first.id; last.mp3 = first.mp3 }
  if (kind === 'path') last.mp3 = f.input
  await writeFile(f.first.receipt, JSON.stringify(f.receipt))
  await expect(finishAudioTranscription(f.project, f.first.receipt, f.account)).rejects.toThrow('Invalid transcription part sequence')
  expect(f.counts().queries).toBe(0)
  expect(await stat(first.mp3)).toBeDefined()
})

it.each([false, true])('refuses changed staged audio %s a missing-task preparation retry', async (missing) => {
  const f = await splitFixture()
  const part = f.receipt.parts[0]
  if (part === undefined) throw new Error('missing split part')
  await writeFile(part.mp3, 'changed audio')
  const account: AudioAccount = { ...f.account, audioStatus: async (id) => {
    if (missing) throw new MuseAsrError('job-not-found')
    return { id, status: 'preparing' }
  } }
  await expect(finishAudioTranscription(f.project, f.first.receipt, account)).rejects.toThrow('Staged audio part changed')
  expect(await readFile(part.mp3, 'utf8')).toBe('changed audio')
})

it.each([false, true])('refuses a changed part ID %s a retry without publishing', async (retry) => {
  const f = await splitFixture()
  const account: AudioAccount = { ...f.account,
    audioStatus: async id => ({ id: retry ? id : randomUUID(), status: retry ? 'preparing' : 'processing' }),
    submitAudio: async () => ({ id: randomUUID(), status: 'processing' }),
  }
  await expect(finishAudioTranscription(f.project, f.first.receipt, account)).rejects.toThrow('different part ID')
  await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['silent', 'failed', 'complete'] as const)('combines terminal split results into %s without resubmission', async (status) => {
  const f = await splitFixture()
  const firstPart = f.receipt.parts[0]
  if (firstPart === undefined) throw new Error('missing first split part')
  const account: AudioAccount = { ...f.account, audioStatus: async id => id === firstPart.id
    ? { id, status, ...(status === 'failed' ? { error_code: 'provider_rejected',
      recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } } as const : {}), ...(status === 'complete' ? { segments: [{ start: 0, end: 1, text: 'speech' }] } : {}) }
    : { id, status: 'silent' } }
  const result = await finishAudioTranscription(f.project, f.first.receipt, account)
  expect(result.status).toBe(status)
  for (const part of f.receipt.parts) await expect(stat(part.mp3)).rejects.toMatchObject({ code: 'ENOENT' })
  if (status === 'complete') {
    if (result.output_json === undefined) throw new Error('missing published output')
    expect(JSON.parse(await readFile(result.output_json, 'utf8'))).toEqual([{ start: 0, end: 1, text: 'speech' }])
    for (const extension of ['json', 'txt', 'srt']) {
      await rm(join(f.project, 'transcript', 'raw', `clip-v1.${extension}`))
      expect((await finishAudioTranscription(f.project, f.first.receipt, account)).status).toBe('complete')
    }
  } else await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cleans every prepared part when an extraction produces an oversized chunk', async () => {
  const f = await setup()
  await expect(startAudioTranscription(f.project, f.input, 'zh', f.account, { ...config, chunkSeconds: 20 },
    { ...shortMedia, encode: async (_source, target) => { await writeFile(target, Buffer.alloc(config.maxAudioBytes + 1)) } })).rejects.toThrow('part exceeds cloud limit')
  expect(await readdir(join(f.project, 'transcript', 'jobs'))).toEqual([])
  expect(f.counts().submits).toBe(0)
})

const flashUnknown = { service_version: 'flash', error_code: 'provider_unavailable',
  provider_diagnostic: { reason: 'timeout', operation: 'flash' },
  recovery: { capability: 'no_query', next_action: 'inspect_receipt', automatic_resubmit: false } } as const

it('persists Flash unknown-outcome diagnostics and never replaces its paid identity', async () => {
  const f = await setup()
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => ({ id, status: 'uncertain', ...flashUnknown }),
    audioStatus: async id => ({ id, status: 'uncertain', ...flashUnknown }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)
  expect(first).toMatchObject({ status: 'uncertain', ...flashUnknown })
  expect(JSON.parse(await readFile(first.receipt, 'utf8'))).toMatchObject(flashUnknown)
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject(flashUnknown)
  expect((await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)).job_id).toBe(first.job_id)
  const offline: AudioAccount = { ...account, audioStatus: async () => { throw new MuseAsrError('server-unavailable') } }
  expect(await finishAudioTranscription(f.project, first.receipt, offline)).not.toHaveProperty('resume_status')
  await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps client transport uncertainty queryable until the gateway supplies recovery facts', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', { ...f.account,
    submitAudio: async () => { throw new MuseAsrError('server-unavailable') },
  }, config, shortMedia)
  expect(first).toMatchObject({ status: 'uncertain', resume_status: { method: 'status' } })
  expect(first).not.toHaveProperty('service_version')
  expect(first).not.toHaveProperty('recovery')
  const result = await finishAudioTranscription(f.project, first.receipt, { ...f.account,
    audioStatus: async id => ({ id, status: 'processing', service_version: 'standard-v2', queued: true,
      recovery: { capability: 'none', next_action: 'wait', automatic_resubmit: false } }),
  })
  expect(result).toMatchObject({ status: 'processing', service_version: 'standard-v2', queued: true })
})

it('retains the pinned service through completion and refuses a service change before publication', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', { ...f.account,
    submitAudio: async (_file, id) => ({ id, status: 'processing', service_version: 'standard-v2' }),
  }, config, shortMedia, 'screenplay')
  await expect(finishAudioTranscription(f.project, first.receipt, { ...f.account,
    audioStatus: async id => ({ id, status: 'complete', service_version: 'flash', segments: [{ start: 0, end: 1, text: 'speech' }] }),
  })).rejects.toThrow('service does not match')
  const account: AudioAccount = { ...f.account, audioStatus: async id => ({ id, status: 'complete', service_version: 'standard-v2',
    recovery: { capability: 'none', next_action: 'use_result', automatic_resubmit: false }, segments: [{ start: 0, end: 1, text: 'speech' }] }) }
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ service_version: 'standard-v2' })
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ service_version: 'standard-v2' })
})

it.each(['preparing', 'failed'] as const)('uploads %s only when gateway confirms the original paid request has not started', async (status) => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  let uploads = 0
  const account: AudioAccount = { ...f.account,
    audioStatus: async id => ({ id, status, service_version: 'flash',
      recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } }),
    submitAudio: async (_file, id) => { uploads++; return { id, status: 'processing', service_version: 'flash' } },
  }
  expect((await finishAudioTranscription(f.project, first.receipt, account)).status).toBe(status)
  expect(uploads).toBe(0)
  const another = await setup()
  const second = await startAudioTranscription(another.project, another.input, 'zh', another.account, config, shortMedia)
  account.audioStatus = async id => ({ id, status, service_version: 'flash',
    recovery: { capability: 'none', next_action: 'resume_upload', automatic_resubmit: false } })
  expect((await finishAudioTranscription(another.project, second.receipt, account)).status).toBe('processing')
  expect(uploads).toBe(1)
})

it.each([false, true])('inspects %s-part recoverable jobs without another upload', async (split) => {
  const f = await setup()
  let uploads = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { uploads++; return { id, status: 'processing', service_version: 'flash' } },
    audioStatus: async id => ({ id, status: 'failed', ...preSubmitFailure }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account,
    { ...config, chunkSeconds: split ? 20 : 600 }, shortMedia)
  const initialUploads = uploads
  const inspected = await finishAudioTranscription(f.project, first.receipt, account, undefined, false)
  expect(inspected.status).toBe('failed')
  expect(uploads).toBe(initialUploads)
  account.audioStatus = async () => { throw new MuseAsrError('job-not-found') }
  await expect(finishAudioTranscription(f.project, first.receipt, account, undefined, false)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(uploads).toBe(initialUploads)
})

it('publishes a completed job through inspect without uploading audio', async () => {
  const f = await setup()
  let uploads = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { uploads++; return { id, status: 'processing', service_version: 'flash' } },
    audioStatus: async id => ({ id, status: 'complete', service_version: 'flash',
      segments: [{ start: 0, end: 1, text: 'speech' }] }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)
  const inspected = await finishAudioTranscription(f.project, first.receipt, account, undefined, false)
  expect(inspected.status).toBe('complete')
  expect(typeof inspected.output_json).toBe('string')
  expect(uploads).toBe(1)
})

it('does not recreate a known accepted task after gateway ledger loss', async () => {
  const f = await setup()
  let submits = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { submits++; return { id, status: 'uncertain', ...flashUnknown } },
    audioStatus: async () => { throw new MuseAsrError('job-not-found') },
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, config, shortMedia)
  await expect(finishAudioTranscription(f.project, first.receipt, account)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(submits).toBe(1)
})

it('retains each split task service and unknown-outcome reason while preserving all original IDs', async () => {
  const f = await setup()
  const ids: string[] = []
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { ids.push(id); return { id, status: 'uncertain', ...flashUnknown } },
    audioStatus: async id => ({ id, status: 'uncertain', ...flashUnknown }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, { ...config, chunkSeconds: 20 }, shortMedia)
  expect(first).toMatchObject({ status: 'uncertain', diagnostic_job_id: ids[0], ...flashUnknown })
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ status: 'uncertain', diagnostic_job_id: ids[0], ...flashUnknown })
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { parts: object[] }
  expect(receipt.parts).toHaveLength(2)
  for (const part of receipt.parts) expect(part).toMatchObject(flashUnknown)
  expect(ids).toHaveLength(2)
  const absent: AudioAccount = { ...account, audioStatus: async () => { throw new MuseAsrError('job-not-found') } }
  await expect(finishAudioTranscription(f.project, first.receipt, absent)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(ids).toHaveLength(2)
})

const preSubmitFailure = { service_version: 'flash', error_code: 'storage_unavailable',
  recovery: { capability: 'none', next_action: 'resume_upload', automatic_resubmit: false } } as const

it.each([false, true])('retains safe pre-submit failure audio during %s-part original-ID recovery without retry loops', async (split) => {
  const f = await setup()
  const submitted: string[] = []
  let recovered = false
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { submitted.push(id); return recovered
      ? { id, status: 'processing', service_version: 'flash', queued: true,
        recovery: { capability: 'none', next_action: 'wait', automatic_resubmit: false } }
      : { id, status: 'failed', ...preSubmitFailure } },
    audioStatus: async id => ({ id, status: 'failed', ...preSubmitFailure }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account,
    { ...config, chunkSeconds: split ? 20 : 600 }, shortMedia)
  const initialIds = [...submitted]
  const resumed = await startAudioTranscription(f.project, f.input, 'zh', account,
    { ...config, chunkSeconds: split ? 20 : 600 }, shortMedia)
  expect(resumed.job_id).toBe(first.job_id)
  expect(submitted).toEqual(initialIds)
  const pending = await finishAudioTranscription(f.project, first.receipt, account)
  expect(pending).toMatchObject({ status: 'failed', ...preSubmitFailure })
  expect(submitted).toEqual([...initialIds, ...initialIds])
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { mp3: string; parts?: Array<{ id: string; mp3: string }> }
  for (const part of receipt.parts ?? [receipt]) expect(await stat(part.mp3)).toBeDefined()
  recovered = true
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ status: 'processing', queued: true })
  expect(submitted).toEqual([...initialIds, ...initialIds, ...initialIds])
  for (const part of receipt.parts ?? [receipt]) expect(await stat(part.mp3)).toBeDefined()
})

it('cleans a terminal provider failure separately from a recoverable unsubmitted split task', async () => {
  const f = await setup(), ids: string[] = []
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { ids.push(id); return { id, status: 'processing', service_version: 'flash' } },
    audioStatus: async id => ({ id, status: 'processing', service_version: 'flash' }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, { ...config, chunkSeconds: 20 }, shortMedia)
  const initialIds = [...ids]
  account.audioStatus = async id => id === initialIds[0]
    ? { id, status: 'failed', service_version: 'flash', error_code: 'provider_rejected',
      recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } }
    : { id, status: 'failed', ...preSubmitFailure }
  account.submitAudio = async (_file, id) => { ids.push(id); return { id, status: 'failed', ...preSubmitFailure } }
  expect((await finishAudioTranscription(f.project, first.receipt, account)).status).toBe('failed')
  expect(ids).toEqual([...initialIds, initialIds[1]])
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { parts: Array<{ mp3: string }> }
  await expect(stat(receipt.parts[0]!.mp3)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await stat(receipt.parts[1]!.mp3)).toBeDefined()
})

it('queries each accepted queued split task without another upload or loss of pinned service', async () => {
  const f = await setup(), ids: string[] = []
  const queued = { service_version: 'standard-v2', queued: true,
    recovery: { capability: 'none', next_action: 'wait', automatic_resubmit: false } } as const
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { ids.push(id); return { id, status: 'processing', ...queued } },
    audioStatus: async id => ({ id, status: 'processing', ...queued }),
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, { ...config, chunkSeconds: 20 }, shortMedia, 'screenplay')
  expect(await finishAudioTranscription(f.project, first.receipt, account)).toMatchObject({ status: 'processing', ...queued })
  expect(ids).toHaveLength(2)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as { parts: Array<{ mp3: string }> }
  for (const part of receipt.parts) { expect(part).toMatchObject(queued); expect(await stat(part.mp3)).toBeDefined() }
})


it('returns a live inspect call for pending work instead of treating the local receipt as a watcher', async () => {
  const f = await setup()
  const pending = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  expect(pending.resume_status).toEqual({ method: 'inspect', project: f.project.replaceAll('\\', '/'), receipt: pending.receipt })
  expect(pending.polling_note).toContain('Bash')
  const done = await finishAudioTranscription(f.project, pending.receipt, { ...f.account, audioStatus: async id => ({ id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] }) }, undefined, false)
  expect(done).not.toHaveProperty('resume_status')
  expect(done).not.toHaveProperty('polling_note')
})

it('polls original tasks inside one bounded call and publishes without another upload', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  let queries = 0
  const account: AudioAccount = { ...f.account, audioStatus: async id => ++queries === 1 ? { id, status: 'processing', queued: true }
    : { id, status: 'complete', segments: [{ start: 0, end: 1, text: 'ready' }] } }
  const done = await finishAudioTranscription(f.project, first.receipt, account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1, probe: shortMedia.probe })
  expect(done.status).toBe('complete')
  expect(queries).toBe(2)
  expect(f.counts().submits).toBe(1)
  expect(await readFile(done.output_txt!, 'utf8')).toContain('ready')
})

it.each([false, true])('bounds the active GET for a split=%s receipt and publishes only after a later read of the same IDs', async (split) => {
  const f = await setup(), submitted: string[] = [], reads: string[] = []
  let slow = true, interrupted = false
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => { submitted.push(id); return { id, status: 'processing' } },
    audioStatus: async (id, signal) => {
      reads.push(id)
      if (slow) {
        try { await timers.setTimeout(1500, undefined, { signal }) }
        finally { interrupted = signal?.aborted === true }
      }
      return { id, status: 'complete', segments: [{ start: 0, end: 1, text: 'original task' }] }
    },
  }
  const first = await startAudioTranscription(f.project, f.input, 'zh', account, { ...config, chunkSeconds: split ? 20 : 600 }, shortMedia)
  const before = await readFile(first.receipt, 'utf8')
  const result = await finishAudioTranscription(f.project, first.receipt, account, undefined, false,
    { waitMs: 400, pollIntervalMs: 1, probe: shortMedia.probe })
  expect(result).toMatchObject({ status: 'uncertain', error_code: 'query-timeout', job_id: first.job_id,
    resume_status: { method: 'inspect', receipt: first.receipt } })
  expect(interrupted).toBe(true)
  expect(reads).toEqual(submitted.slice(0, 1))
  expect(await readFile(first.receipt, 'utf8')).toBe(before)
  await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
  slow = false
  const recovered = await finishAudioTranscription(f.project, first.receipt, account, undefined, false)
  expect(recovered).toMatchObject({ status: 'complete', job_id: first.job_id })
  expect(await readFile(recovered.output_txt!, 'utf8')).toContain('original task')
  expect(submitted).toHaveLength(split ? 2 : 1)
  expect(reads).toEqual([submitted[0], ...submitted])
})

it('does not dispatch a status request after the wait expires during local receipt validation', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const account: AudioAccount = { ...f.account, status: async (options) => {
    await timers.setTimeout(40)
    return await f.account.status(options)
  } }
  const result = await finishAudioTranscription(f.project, first.receipt, account, undefined, false,
    { waitMs: 20, pollIntervalMs: 1, probe: shortMedia.probe })
  expect(result).toMatchObject({ job_id: first.job_id, error_code: 'query-timeout', resume_status: { method: 'inspect' } })
  expect(f.counts()).toEqual({ submits: 1, queries: 0 })
})

it('keeps the last confirmed status when the next poll falls outside the wait', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const pending = await finishAudioTranscription(f.project, first.receipt, f.account, undefined, false,
    { waitMs: 400, pollIntervalMs: 30_000, probe: shortMedia.probe })
  expect(pending).toMatchObject({ job_id: first.job_id, status: 'processing', resume_status: { method: 'inspect' } })
  expect(pending.error_code).toBeUndefined()
  expect(f.counts()).toEqual({ submits: 1, queries: 1 })
})

it('reports unconfirmed upload and remaining inputs, then safely continues the same batch', async () => {
  const f = await setup(), another = join(f.project, 'source', 'next.mp4'), attempts: string[] = [], reads: string[] = []
  await writeFile(another, 'next episode')
  const account: AudioAccount = { ...f.account,
    submitAudio: async (_file, id) => {
      attempts.push(id)
      if (attempts.length === 1) throw new MuseAsrError('upload-timeout')
      return { id, status: 'processing' }
    },
    audioStatus: async (id) => { reads.push(id); return { id, status: 'processing', queued: true } },
  }
  const args = [f.project, [f.input, another], 'zh', account, config, shortMedia] as const
  const first = await startAudioTranscriptionBatch(...args)
  expect(first).toMatchObject({ items: [{ input: f.input, status: 'uncertain', error_code: 'upload-timeout', job_id: attempts[0],
    resume_status: { method: 'inspect' } }], not_started: [another] })
  expect(attempts).toHaveLength(1)
  const followup = await startAudioTranscriptionBatch(...args)
  expect(followup).toMatchObject({ items: [{ input: f.input, job_id: attempts[0], status: 'processing', queued: true },
    { input: another, job_id: attempts[1], status: 'processing' }] })
  expect(followup).not.toHaveProperty('not_started')
  expect(attempts).toHaveLength(2)
  expect(new Set(attempts).size).toBe(2)
  expect(reads).toEqual(attempts.slice(0, 1))
})

it('does not wait through a no-query recovery blocker or start a recovery upload', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  let queries = 0
  const account: AudioAccount = { ...f.account, audioStatus: async (id) => { queries++; return { id, status: 'uncertain', recovery: { capability: 'no_query', next_action: 'inspect_receipt', automatic_resubmit: false } } } }
  const result = await finishAudioTranscription(f.project, first.receipt, account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1, probe: shortMedia.probe })
  expect(result).not.toHaveProperty('resume_status')
  expect(queries).toBe(1)
  expect(f.counts().submits).toBe(1)
})

it('rejects invalid waiting budgets before querying a task', async () => {
  const f = await setup()
  await expect(finishAudioTranscription(f.project, 'unused', f.account, undefined, false,
    { waitMs: 30_001, pollIntervalMs: 1, probe: shortMedia.probe })).rejects.toThrow('polling budget')
  expect(f.counts().queries).toBe(0)
})

it.each(['verified', 'outside-audio', 'changed-audio'] as const)('verifies legacy packet-range overruns against the original staged audio: %s', async (kind) => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  const before = await readFile(f.first.receipt, 'utf8')
  if (kind === 'changed-audio') await writeFile(firstPart.mp3, 'different audio')
  const account: AudioAccount = { ...f.account, audioStatus: async id => ({ id, status: 'complete', segments: [{ start: 0, end: id === firstPart.id ? 20.5 : 1, text: 'keep original words' }] }) }
  const operation = finishAudioTranscription(f.project, f.first.receipt, account, undefined, false,
    { waitMs: 0, pollIntervalMs: 1, probe: async () => kind === 'outside-audio' ? 20 : 20.6 })
  if (kind !== 'verified') {
    await expect(operation).rejects.toThrow(kind === 'changed-audio' ? 'Staged audio part changed' : 'timestamp exceeds')
    expect(await readFile(f.first.receipt, 'utf8')).toBe(before)
    await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
    return
  }
  const result = await operation
  expect(result.status).toBe('complete')
  expect(result.timing_warnings).toEqual([{ part_id: firstPart.id, planned_seconds: 20, staged_seconds: 20.6 }])
  expect(result.progress).toEqual({ completed_parts: 2, total_parts: 2 })
  const rows = JSON.parse(await readFile(result.output_json!, 'utf8')) as { start: number; end: number; text: string }[]
  expect(rows.map(row => row.end)).toEqual([20.5, 21])
  expect(rows.every(row => row.text === 'keep original words')).toBe(true)
})

it('preserves a staged-audio read failure without treating it as expired audio or uploading again', async () => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  const before = await readFile(f.first.receipt, 'utf8')
  await rm(firstPart.mp3)
  await mkdir(firstPart.mp3)
  let uploads = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async () => { uploads++; throw new Error('Unexpected upload') },
    audioStatus: async id => ({ id, status: 'complete', segments: [{ start: 0, end: 20.5, text: 'original speech' }] }),
  }
  await expect(finishAudioTranscription(f.project, f.first.receipt, account, undefined, false,
    { waitMs: 0, pollIntervalMs: 1, probe: async () => 20.6 })).rejects.toHaveProperty('code', expect.stringMatching(/^(EISDIR|EACCES|EPERM)$/u))
  expect(uploads).toBe(0)
  expect(await readFile(f.first.receipt, 'utf8')).toBe(before)
})

it('provides the upload-recovery command for an original task without submitting from a read-only inspection', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  f.setJob({ id: first.job_id, status: 'processing',
    recovery: { capability: 'none', next_action: 'resume_upload', automatic_resubmit: false } })
  const result = await finishAudioTranscription(f.project, first.receipt, f.account)
  expect(result.resume_status).toMatchObject({ method: 'status', receipt: first.receipt.replaceAll('\\', '/') })
  expect(f.counts()).toEqual({ submits: 1, queries: 1 })
})

it('retains verified legacy durations and warnings after audio cleanup and recreates missing outputs without upload', async () => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  let probes = 0, queries = 0, uploads = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async () => { uploads++; throw new Error('Unexpected recovery upload') },
    audioStatus: async (id) => { queries++; return { id, status: 'complete', segments: [
      { start: 0, end: id === firstPart.id ? 20.5 : 1, text: 'keep original words' },
    ] } },
  }
  const options = { waitMs: 0, pollIntervalMs: 1, probe: async () => { probes++; return 20.6 } }
  const first = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
  const warning = [{ part_id: firstPart.id, planned_seconds: 20, staged_seconds: 20.6 }]
  for (const part of f.receipt.parts) await expect(stat(part.mp3)).rejects.toMatchObject({ code: 'ENOENT' })
  const cached = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
  expect(cached.timing_warnings).toEqual(warning)
  expect(cached.progress).toEqual({ completed_parts: 2, total_parts: 2 })
  for (const output of [first.output_txt!, first.output_json!, first.output_srt!]) {
    const content = await readFile(output, 'utf8')
    await rm(output)
    const recovered = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
    expect(recovered.status).toBe('complete')
    expect(recovered.timing_warnings).toEqual(warning)
    expect(await readFile(output, 'utf8')).toBe(content)
  }
  expect({ probes, queries, uploads }).toEqual({ probes: 1, queries: 8, uploads: 0 })
  const receipt = JSON.parse(await readFile(f.first.receipt, 'utf8')) as { parts: { id: string; verifiedDurationSeconds?: number }[] }
  expect(receipt.parts.find(part => part.id === firstPart.id)).toMatchObject({ ...firstPart, verifiedDurationSeconds: 20.6 })
})

it.each(['20.6', null, 0, -1, 19, 30.251])('rejects an invalid retained legacy duration %j before querying', async (value) => {
  const f = await splitFixture()
  let queries = 0
  const receipt = JSON.parse(await readFile(f.first.receipt, 'utf8')) as { parts: Record<string, unknown>[] }
  receipt.parts[0]!.verifiedDurationSeconds = value
  const content = JSON.stringify(receipt)
  await writeFile(f.first.receipt, content)
  const account: AudioAccount = { ...f.account, audioStatus: async (id) => { queries++; return { id, status: 'silent' } } }
  await expect(finishAudioTranscription(f.project, f.first.receipt, account, undefined, false))
    .rejects.toThrow(/Invalid (?:transcription parts|verified audio duration)/u)
  expect(queries).toBe(0)
  expect(await readFile(f.first.receipt, 'utf8')).toBe(content)
})

it.each([NaN, 19, 30.251])('does not retain a probed legacy duration outside its source bounds: %s', async (duration) => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  const before = await readFile(f.first.receipt, 'utf8')
  const account: AudioAccount = { ...f.account, audioStatus: async id => ({ id, status: 'complete', segments: [
    { start: 0, end: id === firstPart.id ? 20.5 : 1, text: 'speech' },
  ] }) }
  await expect(finishAudioTranscription(f.project, f.first.receipt, account, undefined, false,
    { waitMs: 0, pollIntervalMs: 1, probe: async () => duration })).rejects.toThrow('timestamp exceeds its audio part')
  expect(await readFile(f.first.receipt, 'utf8')).toBe(before)
  await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await stat(firstPart.mp3)).toBeDefined()
})

it('rejects changed original-task results beyond retained duration without replacing published outputs', async () => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  let end = 20.5, probes = 0
  const account: AudioAccount = { ...f.account, audioStatus: async id => ({ id, status: 'complete', segments: [
    { start: 0, end: id === firstPart.id ? end : 1, text: 'speech' },
  ] }) }
  const options = { waitMs: 0, pollIntervalMs: 1, probe: async () => { probes++; return 20.6 } }
  const first = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
  const receipt = await readFile(f.first.receipt, 'utf8'), json = await readFile(first.output_json!, 'utf8')
  await rm(first.output_srt!)
  end = 22
  await expect(finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options))
    .rejects.toThrow('timestamp exceeds its audio part')
  expect(probes).toBe(1)
  expect(await readFile(f.first.receipt, 'utf8')).toBe(receipt)
  expect(await readFile(first.output_json!, 'utf8')).toBe(json)
  await expect(stat(first.output_srt!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps complete legacy outputs readable and diagnoses missing duration evidence without uploading again', async () => {
  const f = await splitFixture(), firstPart = f.receipt.parts[0]!
  let queries = 0, uploads = 0
  const account: AudioAccount = { ...f.account,
    submitAudio: async () => { uploads++; throw new Error('Unexpected recovery upload') },
    audioStatus: async (id) => { queries++; return { id, status: 'complete', segments: [
      { start: 0, end: id === firstPart.id ? 20.5 : 1, text: 'legacy speech' },
    ] } },
  }
  const options = { waitMs: 0, pollIntervalMs: 1, probe: async () => 20.6 }
  const first = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
  const receipt = JSON.parse(await readFile(f.first.receipt, 'utf8')) as { parts: Record<string, unknown>[] }
  for (const part of receipt.parts) delete part.verifiedDurationSeconds
  const legacy = JSON.stringify(receipt)
  await writeFile(f.first.receipt, legacy)
  const cached = await finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options)
  expect(cached.status).toBe('complete')
  expect(cached.output_json).toBe(first.output_json)
  expect(cached).not.toHaveProperty('timing_warnings')
  expect(queries).toBe(2)
  const json = await readFile(first.output_json!, 'utf8')
  await rm(first.output_srt!)
  await expect(finishAudioTranscription(f.project, f.first.receipt, account, undefined, false, options))
    .rejects.toThrow('restore the original staged audio to recover missing outputs without resubmitting')
  expect(uploads).toBe(0)
  expect(await readFile(f.first.receipt, 'utf8')).toBe(legacy)
  expect(await readFile(first.output_json!, 'utf8')).toBe(json)
  await expect(stat(first.output_srt!)).rejects.toMatchObject({ code: 'ENOENT' })
})


it('cancels native waiting without a later query or publication', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const controller = new AbortController(), reason = new Error('stop waiting')
  const realDelay = timers.setTimeout
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
  const wait = vi.spyOn(timers, 'setTimeout').mockImplementationOnce(async (milliseconds, value, options) => {
    const pending = realDelay(milliseconds, value, options)
    controller.abort(reason)
    return await pending
  })
  try {
    await expect(finishAudioTranscription(f.project, first.receipt, f.account, controller.signal, false,
      { waitMs: 30_000, pollIntervalMs: 1000, probe: shortMedia.probe })).rejects.toBe(reason)
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000, undefined, { signal: controller.signal })
    expect(f.counts()).toEqual({ submits: 1, queries: 1 })
    await expect(stat(join(f.project, 'transcript', 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { wait.mockRestore(); clock.mockRestore() }
})

const batchNote = '各集收据是上次查询的快照，不会自行刷新。按各集 resume_status 继续调用 audio_transcribe，inspect 可带 wait_seconds；把同一 inputs 原样再次 start 会沿用已有收据，不会重复计费。不要用 Bash 循环读取收据，也不要删除收据。'

/** Episodes in one project with a gateway that records every upload attempt and knows only accepted IDs. */
async function episodes(count: number) {
  const project = await mkdtemp(join(tmpdir(), 'muse-audio-batch-'))
  directories.push(project)
  await mkdir(join(project, 'source'))
  const inputs = Array.from({ length: count }, (_, index) => join('source', `ep${index + 1}.mp4`))
  for (const input of inputs) await writeFile(join(project, input), `video ${input}`)
  const episodeOf = new Map<string, string>(), accepted = new Map<string, MuseAsrJob>()
  const calls = { probes: [] as string[], encodes: [] as string[], queries: [] as string[],
    submits: [] as Array<{ episode: string; id: string; accepted: boolean }> }
  let refuse: (episode: string, attempt: number, id: string) => MuseAsrError | undefined = () => undefined
  let respond = (id: string): MuseAsrJob => ({ id, status: 'processing' })
  const media: AudioMediaOperations = {
    probe: async (source) => { calls.probes.push(basename(source)); return 30 },
    encode: async (source, target) => { calls.encodes.push(basename(source)); episodeOf.set(target, basename(source)); await writeFile(target, 'audio') },
  }
  const account: AudioAccount = {
    status: async () => ({ state: 'signed-in', username: 'alice', verified: false }),
    submitAudio: async (file, id) => {
      const episode = episodeOf.get(file) ?? 'unknown'
      const error = refuse(episode, calls.submits.filter(row => row.id === id).length + 1, id)
      calls.submits.push({ episode, id, accepted: error === undefined })
      if (error !== undefined) throw error
      accepted.set(id, respond(id))
      return accepted.get(id)!
    },
    audioStatus: async (id) => {
      calls.queries.push(id)
      const job = accepted.get(id)
      if (job === undefined) throw new MuseAsrError('job-not-found')
      return job
    },
  }
  const jobs = join(project, 'transcript', 'jobs')
  return { project, inputs, media, account, calls, accepted, jobs,
    refuse: (next: typeof refuse) => { refuse = next }, respond: (next: typeof respond) => { respond = next } }
}

it('waits out one upload_busy refusal and offers the same staged upload again under the original ID', async () => {
  const f = await episodes(1)
  f.refuse((_episode, attempt) => attempt === 1 ? new MuseAsrError('upload_busy', 1) : undefined)
  const result = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 5000 })
  expect(result.status).toBe('processing')
  expect(result).not.toHaveProperty('error_code')
  expect(f.calls.submits.map(row => row.id)).toEqual([result.job_id, result.job_id])
  expect(JSON.parse(await readFile(result.receipt, 'utf8'))).toMatchObject({ id: result.job_id, status: 'processing' })
})

it('returns a request_rate refusal at once when its delay exceeds the waiting budget', async () => {
  const f = await episodes(1)
  f.refuse(() => new MuseAsrError('request_rate', 60))
  const started = Date.now()
  const result = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 5000 })
  expect(Date.now() - started).toBeLessThan(1000)
  expect(result).toMatchObject({ error_code: 'request_rate', retry_after_seconds: 60, resume_status: { method: 'status', receipt: result.receipt } })
  expect(f.calls.submits).toHaveLength(1)
})

it.each(['queue_full', 'provider_rate', 'server_draining'] as const)('does not retry a %s refusal inside the call', async (code) => {
  const f = await episodes(1)
  f.refuse(() => new MuseAsrError(code, 1))
  const result = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 5000 })
  expect(result.error_code).toBe(code)
  expect(f.calls.submits).toHaveLength(1)
})

it('cancels a paced wait with the caller reason and keeps the receipt prepared without another upload', async () => {
  const f = await episodes(1)
  const controller = new AbortController(), reason = new Error('stop pacing')
  let timer: ReturnType<typeof setTimeout> | undefined
  f.refuse(() => { timer = setTimeout(() => { controller.abort(reason) }, 50); return new MuseAsrError('upload_busy', 1) })
  try {
    await expect(startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media, undefined, controller.signal,
      { retryBudgetMs: 5000 })).rejects.toBe(reason)
    expect(f.calls.submits).toHaveLength(1)
    expect(JSON.parse(await readFile(join(f.jobs, 'ep1-v1.json'), 'utf8'))).toMatchObject({ status: 'prepared' })
  } finally { clearTimeout(timer) }
})

it.each([false, true])('recovers a never-accepted %s-part receipt through status after one paced refusal', async (split) => {
  const f = await episodes(1)
  const media = split ? { ...f.media, probe: async () => 12 } : f.media
  const settings = { ...config, chunkSeconds: split ? 10 : 600 }
  f.refuse(() => new MuseAsrError('upload_busy', 2))
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, settings, media)
  expect(start).toMatchObject({ status: 'preparing', error_code: 'upload_busy' })
  const ids = (JSON.parse(await readFile(start.receipt, 'utf8')) as { parts?: Array<{ id: string }> }).parts?.map(part => part.id) ?? [start.job_id]
  const last = ids.at(-1)!
  let refusedOnce = false
  f.refuse((_episode, _attempt, id) => {
    if (id !== last || refusedOnce) return undefined
    refusedOnce = true
    return new MuseAsrError('upload_busy', 1)
  })
  const recovered = await finishAudioTranscription(f.project, start.receipt, f.account, undefined, true, undefined, { retryBudgetMs: 5000 })
  expect(recovered.status).toBe('processing')
  expect(recovered).not.toHaveProperty('error_code')
  expect(f.calls.submits.filter(row => row.id === last).map(row => row.accepted)).toEqual(split ? [false, true] : [false, false, true])
  for (const id of ids) expect(f.accepted.has(id)).toBe(true)
})

it('spends the batch budget on waiting only, so a slow extraction keeps its retry', async () => {
  const f = await episodes(2)
  const media = { ...f.media, encode: async (source: string, target: string) => {
    if (basename(source) === 'ep2.mp4') await new Promise(resolveDelay => setTimeout(resolveDelay, 1200))
    await f.media.encode(source, target)
  } }
  f.refuse((episode, attempt) => episode === 'ep2.mp4' && attempt === 1 ? new MuseAsrError('upload_busy', 1) : undefined)
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, media, undefined, undefined, { retryBudgetMs: 1500 })
  expect(result.items.map(item => 'status' in item ? item.status : item.error)).toEqual(['processing', 'processing'])
  expect(f.calls.submits.filter(row => row.episode === 'ep2.mp4').map(row => row.accepted)).toEqual([false, true])
})

it('shares one waiting budget across the batch and stops at the refusal it cannot wait out', async () => {
  const f = await episodes(3)
  f.refuse((_episode, attempt) => attempt === 1 ? new MuseAsrError('upload_busy', 1) : undefined)
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 1500 })
  expect(result.items).toHaveLength(2)
  expect(result.items[0]).toMatchObject({ input: f.inputs[0], status: 'processing' })
  expect(result.items[1]).toMatchObject({ input: f.inputs[1], status: 'preparing', error_code: 'upload_busy', retry_after_seconds: 1 })
  expect(result.not_started).toEqual([f.inputs[2]])
  expect(f.calls.submits.map(row => row.accepted)).toEqual([false, true, false])
})

it('submits a batch in input order and returns an unfinished receipt without another upload', async () => {
  const f = await episodes(3)
  const existing = await startAudioTranscription(f.project, f.inputs[1]!, 'zh', f.account, config, f.media)
  const before = { encodes: f.calls.encodes.length, submits: f.calls.submits.length }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items.map(item => item.input)).toEqual(f.inputs)
  const items = result.items.map((item) => {
    if (!('receipt' in item)) throw new Error(item.error)
    return item
  })
  expect(items.map(item => item.status)).toEqual(['processing', 'processing', 'processing'])
  expect(new Set(items.map(item => item.receipt)).size).toBe(3)
  expect(items[1]).toMatchObject({ receipt: existing.receipt, job_id: existing.job_id })
  expect(f.calls.encodes.slice(before.encodes)).toEqual(['ep1.mp4', 'ep3.mp4'])
  expect(f.calls.submits.length - before.submits).toBe(2)
  expect(result).not.toHaveProperty('not_started')
})

it('returns complete and failed same-purpose receipts from a batch while a single start still adds a version', async () => {
  const f = await episodes(2)
  const done = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  const failed = await startAudioTranscription(f.project, f.inputs[1]!, 'zh', f.account, config, f.media)
  f.accepted.set(done.job_id, { id: done.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  f.accepted.set(failed.job_id, { id: failed.job_id, status: 'failed', error_code: 'provider_rejected',
    recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } })
  for (const receipt of [done.receipt, failed.receipt]) await finishAudioTranscription(f.project, receipt, f.account, undefined, false)
  const before = { encodes: f.calls.encodes.length, submits: f.calls.submits.length }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items).toEqual([
    { input: f.inputs[0], status: 'complete', receipt: done.receipt, job_id: done.job_id, purpose: 'subtitles' },
    { input: f.inputs[1], status: 'failed', receipt: failed.receipt, job_id: failed.job_id, purpose: 'subtitles', error_code: 'provider_rejected',
      recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } },
  ])
  expect(result).not.toHaveProperty('polling_note')
  expect({ encodes: f.calls.encodes.length, submits: f.calls.submits.length }).toEqual(before)
  expect((await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)).receipt).toContain('ep1-v2.json')
})

it('refuses an unfinished reused receipt with a changed language', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  const receipt = await readFile(first.receipt, 'utf8')
  await expect(startAudioTranscription(f.project, f.input, 'auto', f.account, config, shortMedia))
    .rejects.toThrow('Check the original transcription receipt')
  expect(f.counts()).toEqual({ submits: 1, queries: 0 })
  expect(await readFile(first.receipt, 'utf8')).toBe(receipt)
})

it('refuses a completed batch receipt with a changed language', async () => {
  const f = await episodes(1)
  const input = f.inputs[0]!
  const first = await startAudioTranscription(f.project, input, 'zh', f.account, config, f.media)
  f.accepted.set(first.job_id, { id: first.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  const completed = await finishAudioTranscription(f.project, first.receipt, f.account, undefined, false)
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'auto', f.account, config, f.media)
  expect(result.items).toHaveLength(1)
  const [item] = result.items
  expect(item?.input).toBe(input)
  expect(item && 'error' in item ? item.error : undefined).toContain('Check the original transcription receipt')
  expect(f.calls.submits).toHaveLength(1)
  expect(f.calls.queries).toEqual([first.job_id])
  expect(JSON.parse(await readFile(completed.output_json!, 'utf8'))).toEqual([{ start: 0, end: 1, text: 'speech' }])
})

it('returns the latest complete same-purpose version of a source from a batch', async () => {
  const f = await episodes(1)
  for (const text of ['first', 'second']) {
    const run = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
    f.accepted.set(run.job_id, { id: run.job_id, status: 'complete', segments: [{ start: 0, end: 1, text }] })
    await finishAudioTranscription(f.project, run.receipt, f.account, undefined, false)
  }
  const before = { encodes: f.calls.encodes.length, submits: f.calls.submits.length }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items).toEqual([expect.objectContaining({ input: f.inputs[0], status: 'complete', receipt: join(f.jobs, 'ep1-v2.json').replaceAll('\\', '/') })])
  expect({ encodes: f.calls.encodes.length, submits: f.calls.submits.length }).toEqual(before)
})

it('refuses a batch input whose ended receipt has no source digest instead of paying again', async () => {
  const f = await episodes(2)
  const legacy = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  f.accepted.set(legacy.job_id, { id: legacy.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  await finishAudioTranscription(f.project, legacy.receipt, f.account, undefined, false)
  const receipt = JSON.parse(await readFile(legacy.receipt, 'utf8')) as Record<string, unknown>
  delete receipt.sourceSha256
  await writeFile(legacy.receipt, JSON.stringify(receipt))
  const before = { encodes: f.calls.encodes.length, submits: f.calls.submits.length }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items).toEqual([{ input: f.inputs[0], error: expect.stringContaining('without a source digest') }])
  expect(result.not_started).toEqual([f.inputs[1]])
  expect({ encodes: f.calls.encodes.length, submits: f.calls.submits.length }).toEqual(before)
  expect((await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)).receipt).toContain('ep1-v2.json')
})

it('reuses a legacy complete receipt without a purpose as subtitles and starts a separate screenplay version', async () => {
  const f = await episodes(1)
  const legacy = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  f.accepted.set(legacy.job_id, { id: legacy.job_id, status: 'complete', segments: [{ start: 0, end: 1, text: 'speech' }] })
  await finishAudioTranscription(f.project, legacy.receipt, f.account, undefined, false)
  const receipt = JSON.parse(await readFile(legacy.receipt, 'utf8')) as Record<string, unknown>
  delete receipt.purpose
  await writeFile(legacy.receipt, JSON.stringify(receipt))
  const subtitles = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(subtitles.items).toEqual([{ input: f.inputs[0], status: 'complete', receipt: legacy.receipt, job_id: legacy.job_id }])
  expect(f.calls.submits).toHaveLength(1)
  const screenplay = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media, 'screenplay')
  expect(screenplay.items).toEqual([expect.objectContaining({ status: 'processing', purpose: 'screenplay', receipt: join(f.jobs, 'ep1-v2.json').replaceAll('\\', '/') })])
  expect(f.calls.submits).toHaveLength(2)
})

it.each([false, true])('completes a prepared %s-part receipt in a batch by querying before uploading under the original ID', async (split) => {
  const f = await episodes(1)
  const media = split ? { ...f.media, probe: async () => 12 } : f.media
  const settings = { ...config, chunkSeconds: split ? 10 : 600 }
  f.refuse(() => new MuseAsrError('upload_busy', 2))
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, settings, media)
  const ids = (JSON.parse(await readFile(start.receipt, 'utf8')) as { parts?: Array<{ id: string }> }).parts?.map(part => part.id) ?? [start.job_id]
  f.refuse(() => undefined)
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, settings, media)
  expect(result.items).toEqual([expect.objectContaining({ input: f.inputs[0], status: 'processing', receipt: start.receipt, job_id: start.job_id })])
  expect(f.calls.queries).toEqual(ids)
  expect(f.calls.submits.filter(row => row.accepted).map(row => row.id)).toEqual(ids)
  expect(f.calls.encodes).toHaveLength(ids.length)
})

it('does not upload a prepared receipt again when the gateway already has its task', async () => {
  const f = await episodes(1)
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  const receipt = JSON.parse(await readFile(start.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(start.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items).toEqual([expect.objectContaining({ status: 'processing', job_id: start.job_id })])
  expect(f.calls.queries).toEqual([start.job_id])
  expect(f.calls.submits).toHaveLength(1)
})

it('stops a batch at its own refused upload and continues it when the same list is sent again', async () => {
  const f = await episodes(4)
  f.refuse(episode => episode === 'ep2.mp4' ? new MuseAsrError('upload_busy', 1) : undefined)
  const first = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 500 })
  expect(first.items).toHaveLength(2)
  expect(first.items[0]).toMatchObject({ input: f.inputs[0], status: 'processing' })
  expect(first.items[1]).toMatchObject({ input: f.inputs[1], status: 'preparing', error_code: 'upload_busy', resume_status: { method: 'status' } })
  expect(first.not_started).toEqual([f.inputs[2], f.inputs[3]])
  expect(first.polling_note).toBe(batchNote)
  expect((await readdir(f.jobs)).filter(name => name.endsWith('.json')).sort()).toEqual(['ep1-v1.json', 'ep2-v1.json'])
  expect((await readdir(f.jobs)).filter(name => name.endsWith('.wav'))).toHaveLength(2)
  expect(f.calls.encodes).toEqual(['ep1.mp4', 'ep2.mp4'])
  f.refuse(() => undefined)
  const second = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media, undefined, undefined, { retryBudgetMs: 500 })
  expect(second.items.map(item => 'status' in item ? item.status : item.error)).toEqual(['processing', 'processing', 'processing', 'processing'])
  expect(second).not.toHaveProperty('not_started')
  const refused = first.items[1]
  if (refused === undefined || !('job_id' in refused)) throw new Error('missing refused batch item')
  expect(second.items[1]).toMatchObject({ receipt: refused.receipt, job_id: refused.job_id })
  expect(f.calls.submits.filter(row => row.id === refused.job_id).map(row => row.accepted)).toEqual([false, true])
  const acceptedIds = f.calls.submits.filter(row => row.accepted).map(row => row.id)
  expect(acceptedIds).toHaveLength(4)
  expect(new Set(acceptedIds).size).toBe(4)
  expect(f.calls.encodes).toEqual(['ep1.mp4', 'ep2.mp4', 'ep3.mp4', 'ep4.mp4'])
})

it('continues past a reused receipt whose gateway metadata carries an error code', async () => {
  const f = await episodes(2)
  f.respond(id => ({ id, status: 'uncertain', ...flashUnknown }))
  const first = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  f.respond(id => ({ id, status: 'processing' }))
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items[0]).toMatchObject({ job_id: first.job_id, status: 'uncertain', error_code: 'provider_unavailable' })
  expect(result.items[1]).toMatchObject({ input: f.inputs[1], status: 'processing' })
  expect(result).not.toHaveProperty('not_started')
})

it('rejects a missing or repeated batch input before probing or uploading anything', async () => {
  const f = await episodes(2)
  await expect(startAudioTranscriptionBatch(f.project, [f.inputs[0]!, join('source', 'missing.mp4')], 'zh', f.account, config, f.media))
    .rejects.toThrow(`Transcription input is not a file: ${join('source', 'missing.mp4')}`)
  await expect(startAudioTranscriptionBatch(f.project, [f.inputs[0]!, join('source', 'missing.mp4')], 'zh', f.account, config, f.media))
    .rejects.toThrow(`(resolved to ${join(f.project, 'source', 'missing.mp4')})`)
  await expect(startAudioTranscriptionBatch(f.project, [f.inputs[0]!, 'source'], 'zh', f.account, config, f.media))
    .rejects.toThrow('Transcription input is not a file: source')
  await expect(startAudioTranscriptionBatch(f.project, [f.inputs[0]!, f.inputs[1]!, join(f.project, f.inputs[0]!)], 'zh', f.account, config, f.media))
    .rejects.toThrow('same input more than once')
  expect({ probes: f.calls.probes.length, submits: f.calls.submits.length }).toEqual({ probes: 0, submits: 0 })
  await expect(stat(f.jobs)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('stops a batch at a local input error and leaves later inputs without receipts', async () => {
  const f = await episodes(3)
  const media = { ...f.media, probe: async (source: string) => basename(source) === 'ep2.mp4' ? config.maxDurationSeconds + 1 : 30 }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, media)
  expect(result.items).toEqual([expect.objectContaining({ input: f.inputs[0], status: 'processing' }),
    { input: f.inputs[1], error: 'Media duration exceeds the cloud transcription limit' }])
  expect(result.not_started).toEqual([f.inputs[2]])
  expect(result.polling_note).toBe(batchNote)
  expect((await readdir(f.jobs)).filter(name => name.endsWith('.json'))).toEqual(['ep1-v1.json'])
})

it('reports a non-Error media adapter rejection as the text of the stopping batch item', async () => {
  const f = await episodes(2)
  const media = { ...f.media, probe: async () => { throw 'probe unavailable' } }
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, media)
  expect(result.items).toEqual([{ input: f.inputs[0], error: 'probe unavailable' }])
  expect(result.not_started).toEqual([f.inputs[1]])
  expect(f.calls.submits).toHaveLength(0)
})

it('cancels a batch during extraction with the caller reason and keeps only finished receipts', async () => {
  const f = await episodes(3)
  const controller = new AbortController(), reason = new Error('stop batch')
  const media = {
    ...f.media,
    encode: async (source: string, target: string, range?: { offset: number; duration: number }, signal?: AbortSignal) => {
      await f.media.encode(source, target, range, signal)
      if (basename(source) === 'ep2.mp4') { controller.abort(reason); signal?.throwIfAborted() }
    },
  }
  await expect(startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, media, undefined, controller.signal)).rejects.toBe(reason)
  const files = await readdir(f.jobs)
  expect(files.filter(name => name.endsWith('.json'))).toEqual(['ep1-v1.json'])
  expect(files.filter(name => name.endsWith('.wav'))).toEqual([basename((JSON.parse(await readFile(join(f.jobs, 'ep1-v1.json'), 'utf8')) as { mp3: string }).mp3)])
  expect(f.calls.submits).toHaveLength(1)
})

it('moves the generic polling note to the batch and keeps a lifetime-quota note on its item', async () => {
  const f = await episodes(2)
  const exhausted = { error_code: 'provider_rejected', provider_diagnostic: { operation: 'query', http_status: 429, provider_code: '45000292', quota_type: 'audio_duration_lifetime' },
    recovery: { capability: 'query_original_task', next_action: 'inspect_receipt', automatic_resubmit: false } } as const
  f.respond(id => ({ id, status: 'uncertain', ...exhausted }))
  await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  f.respond(id => ({ id, status: 'processing' }))
  const result = await startAudioTranscriptionBatch(f.project, f.inputs, 'zh', f.account, config, f.media)
  expect(result.items[0]).toMatchObject({ status: 'uncertain', resume_status: { method: 'inspect' } })
  expect(result.items[0]).toHaveProperty('polling_note', expect.stringContaining('原供应商应用的试用额度已用完'))
  expect(result.items[1]).toMatchObject({ status: 'processing', resume_status: { method: 'inspect' } })
  expect(result.items[1]).not.toHaveProperty('polling_note')
  expect(result.polling_note).toBe(batchNote)
})

it('returns a status call when inspect finds a task the gateway never accepted', async () => {
  const f = await episodes(1)
  f.refuse(() => new MuseAsrError('upload_busy', 2))
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, config, f.media)
  const before = await readFile(start.receipt, 'utf8')
  const started = Date.now()
  const result = await finishAudioTranscription(f.project, start.receipt, f.account, undefined, false,
    { waitMs: 30_000, pollIntervalMs: 1000, probe: f.media.probe.bind(f.media) })
  expect(Date.now() - started).toBeLessThan(1000)
  expect(result).toMatchObject({ status: 'preparing', job_id: start.job_id, error_code: 'job-not-found',
    resume_status: { method: 'status', receipt: start.receipt } })
  expect(result.polling_note).toContain('不要删除收据')
  expect(f.calls.queries).toEqual([start.job_id])
  expect(f.calls.submits).toHaveLength(1)
  expect(await readFile(start.receipt, 'utf8')).toBe(before)
})

it('names the never-accepted part when inspect reads a split receipt', async () => {
  const f = await episodes(1)
  const media = { ...f.media, probe: async () => 12 }
  let submitted = 0
  f.refuse(() => ++submitted === 2 ? new MuseAsrError('upload_busy', 2) : undefined)
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, { ...config, chunkSeconds: 10 }, media)
  const before = await readFile(start.receipt, 'utf8')
  const parts = (JSON.parse(before) as { parts: Array<{ id: string }> }).parts
  const result = await finishAudioTranscription(f.project, start.receipt, f.account, undefined, false)
  expect(result).toMatchObject({ status: 'preparing', job_id: start.job_id, diagnostic_job_id: parts[1]!.id, error_code: 'job-not-found',
    resume_status: { method: 'status', receipt: start.receipt } })
  expect(f.calls.submits).toHaveLength(2)
  expect(await readFile(start.receipt, 'utf8')).toBe(before)
})

it.each([false, true])('still fails inspect of a never-accepted %s-part task whose staged audio is gone', async (split) => {
  const f = await episodes(1)
  const media = split ? { ...f.media, probe: async () => 12 } : f.media
  let submitted = 0
  f.refuse(() => ++submitted === (split ? 2 : 1) ? new MuseAsrError('upload_busy', 2) : undefined)
  const start = await startAudioTranscription(f.project, f.inputs[0]!, 'zh', f.account, { ...config, chunkSeconds: split ? 10 : 600 }, media)
  const receipt = JSON.parse(await readFile(start.receipt, 'utf8')) as { mp3: string; parts?: Array<{ mp3: string }> }
  await rm(receipt.parts?.[1]?.mp3 ?? receipt.mp3)
  await expect(finishAudioTranscription(f.project, start.receipt, f.account, undefined, false)).rejects.toMatchObject({ code: 'job-not-found' })
  expect(f.calls.submits).toHaveLength(split ? 2 : 1)
})

it('starts a new version when a regenerated source keeps its path but changes its bytes', async () => {
  const f = await setup()
  const first = (await startAudioTranscriptionBatch(f.project, [f.input], 'zh', f.account, config, shortMedia)).items[0]
  f.setJob({ id: first && 'job_id' in first ? first.job_id : '', status: 'complete', segments: [{ start: 0, end: 1, text: '旧镜头' }] })
  await finishAudioTranscription(f.project, (first as { receipt: string }).receipt, f.account)
  const reused = (await startAudioTranscriptionBatch(f.project, [f.input], 'zh', f.account, config, shortMedia)).items[0]
  expect(reused).toMatchObject({ status: 'complete', receipt: join(f.project, 'transcript', 'jobs', 'clip-v1.json') })
  expect(f.counts().submits).toBe(1)

  await writeFile(f.input, 'regenerated video fixture')
  const fresh = (await startAudioTranscriptionBatch(f.project, [f.input], 'zh', f.account, config, shortMedia)).items[0]
  expect(fresh).toMatchObject({ status: 'processing', receipt: join(f.project, 'transcript', 'jobs', 'clip-v2.json') })
  expect(f.counts().submits).toBe(2)
  expect(JSON.parse(await readFile(join(f.project, 'transcript', 'jobs', 'clip-v2.json'), 'utf8')))
    .toMatchObject({ version: 2, source: f.input })
})

it('does not return a pending receipt for bytes that no longer exist at its path', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  expect((await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)).receipt).toBe(first.receipt)
  await writeFile(f.input, 'regenerated video fixture')
  const second = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  expect(second.receipt).toBe(join(f.project, 'transcript', 'jobs', 'clip-v2.json'))
  expect(second.job_id).not.toBe(first.job_id)
  expect(f.counts().submits).toBe(2)
})

it('neither reuses nor silently pays again over a finished legacy receipt that cannot prove which bytes it transcribed', async () => {
  const f = await setup()
  const first = await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)
  f.setJob({ id: first.job_id, status: 'silent' })
  await finishAudioTranscription(f.project, first.receipt, f.account)
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  delete receipt.sourceSha256
  await writeFile(first.receipt, JSON.stringify(receipt))
  const next = (await startAudioTranscriptionBatch(f.project, [f.input], 'zh', f.account, config, shortMedia)).items[0]
  expect(next).toMatchObject({ input: f.input, error: expect.stringContaining(first.receipt) })
  expect(f.counts().submits).toBe(1)
  expect((await startAudioTranscription(f.project, f.input, 'zh', f.account, config, shortMedia)).receipt)
    .toBe(join(f.project, 'transcript', 'jobs', 'clip-v2.json'))
  expect(f.counts().submits).toBe(2)
})
