import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseAsrError, type MuseAsrJob } from '@deepseek-ai/dsh-muse-account'
import { finishAudioTranscription, startAudioTranscription, type AudioAccount } from '../src/runner.ts'

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
  expect(await readFile(done.output_srt!, 'utf8')).toContain('00:00:21,000 --> 00:00:22,000')
  expect((await finishAudioTranscription(fixture.project, first.receipt, account)).status).toBe('complete')
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

it('binds screenplay purpose before submit and refuses a different purpose for an unfinished receipt', async () => {
  const fixture = await setup()
  const purposes: Array<string | undefined> = []
  const account: AudioAccount = { ...fixture.account, submitAudio: async (_file, id, _sha, _language, purpose) => {
    const receipt = JSON.parse(await readFile(join(fixture.project, 'transcript', 'jobs', 'clip-v1.json'), 'utf8')) as { purpose?: string }
    expect(receipt.purpose).toBe('screenplay')
    purposes.push(purpose)
    return { id, status: 'processing' }
  } }
  const media = { probe: async () => 30, encode: async (_source: string, target: string) => { await writeFile(target, 'audio') } }
  const first = await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')
  expect(first.purpose).toBe('screenplay')
  expect((await startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'screenplay')).job_id).toBe(first.job_id)
  await expect(startAudioTranscription(fixture.project, fixture.input, 'zh', account, config, media, 'subtitles')).rejects.toThrow('purpose')
  expect(purposes).toEqual(['screenplay'])
  const resume: AudioAccount = { ...account, audioStatus: async () => { throw new MuseAsrError('job-not-found') } }
  const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as Record<string, unknown>
  await writeFile(first.receipt, JSON.stringify({ ...receipt, status: 'prepared' }))
  expect((await finishAudioTranscription(fixture.project, first.receipt, resume)).purpose).toBe('screenplay')
  expect(purposes).toEqual(['screenplay', 'screenplay'])
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
  await expect(finishAudioTranscription(f.project, kind === 'outside' ? f.input : first.receipt, f.account)).rejects.toThrow(kind === 'outside' ? 'inside this project' : 'paths do not match')
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
    ? { id, status, ...(status === 'complete' ? { segments: [{ start: 0, end: 1, text: 'speech' }] } : {}) }
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
