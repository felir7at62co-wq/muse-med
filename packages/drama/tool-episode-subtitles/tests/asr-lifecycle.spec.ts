import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Runner from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readShotTranscript, transcribeShots, type AsrDeps } from '../src/asr.ts'
import { extractPcm, gateway, runnerMedia, settings } from './fixture.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-asr-lifecycle-'))
  onTestFinished(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const { account } = gateway(root, new Map())
  const deps: AsrDeps = { root, account, runner: settings, pacing: { retryBudgetMs: 0 }, pollIntervalMs: settings.pollIntervalMs,
    packSeconds: 10, gapSeconds: 0.8, maxBatchInputs: 1, media: { extractPcm, runner: runnerMedia } }
  const audio = async (name: string, data: Buffer) => {
    const path = join(root, name + '.wav')
    await writeFile(path, data)
    return { audio: path, audio_sha256: createHash('sha256').update(data).digest('hex') }
  }
  return { root, deps, audio }
}

it('writes a silent transcript for empty speech and refuses audio that changes during preparation', async () => {
  const f = await fixture()
  const silent = await f.audio('silent', Buffer.alloc(0))
  const changed = await f.audio('rewritten', Buffer.from('before'))
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch')
  const extract = vi.fn(async (source: string, target: string) => {
    await extractPcm(source, target)
    if (source === changed.audio) await writeFile(source, 'more bytes arrived while decoding')
  })
  const result = await transcribeShots([silent, changed, silent], { ...f.deps, media: { extractPcm: extract, runner: runnerMedia } },
    { allowNew: true, waitMs: 0 })
  expect(extract).toHaveBeenCalledTimes(2)
  expect(start).not.toHaveBeenCalled()
  expect(result).toMatchObject({ newSeconds: 0, pendingPacks: 0 })
  expect(result.states.get(changed.audio_sha256)).toEqual({ kind: 'blocked', reason: 'media_changed' })
  expect(result.states.get(silent.audio_sha256)).toMatchObject({ kind: 'ready', transcript: { samples: 0, silent: true, words: [] } })
  expect(await readShotTranscript(f.root, changed.audio_sha256)).toBeUndefined()
})

it('retains failed and uncertain original packs without polling or resubmitting them', async () => {
  const f = await fixture()
  const failed = await f.audio('failed', Buffer.alloc(11 * 32_000, 1))
  const uncertain = await f.audio('uncertain', Buffer.alloc(11 * 32_000, 2))
  const settle = vi.spyOn(Runner, 'finishAudioTranscription')
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch')
    .mockImplementationOnce(async (_root, inputs) => ({ items: [{ input: inputs[0]!, status: 'failed', receipt: 'failed', job_id: 'job-1' }] }))
    .mockImplementationOnce(async (_root, inputs) => ({ items: [{ input: inputs[0]!, status: 'uncertain', receipt: 'uncertain', job_id: 'job-2',
      recovery: { capability: 'no_query', next_action: 'inspect_receipt', automatic_resubmit: false } }] }))
  const once = await transcribeShots([failed, uncertain], f.deps, { allowNew: true, waitMs: 0 })
  expect(once).toMatchObject({ newSeconds: 22, pendingPacks: 0 })
  expect(once.states.get(failed.audio_sha256)).toEqual({ kind: 'blocked', reason: 'asr_failed' })
  expect(once.states.get(uncertain.audio_sha256)).toEqual({ kind: 'blocked', reason: 'asr_uncertain' })
  const reopened = await transcribeShots([uncertain, failed], f.deps, { allowNew: true, waitMs: 0 })
  expect(reopened.states).toEqual(once.states)
  expect(reopened.newSeconds).toBe(0)
  expect(start).toHaveBeenCalledTimes(2)
  expect(settle).not.toHaveBeenCalled()
})

it('checks the original queued receipt and republishes a missing shot transcript from completed evidence', async () => {
  const f = await fixture()
  const shot = await f.audio('queued', Buffer.alloc(32_000, 3))
  const original = { receipt: 'receipt-1', job_id: 'job-1' }
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch').mockImplementation(async (_root, inputs) => ({ items: [
    { input: inputs[0]!, ...original, status: 'processing', error_code: 'queue_full', retry_after_seconds: 3 },
  ] }))
  const output = join(f.root, 'published.json')
  await writeFile(output, JSON.stringify([{ start: 0.1, end: 0.7, text: '你好', speaker_id: 'speaker-a' }]))
  const finish = vi.spyOn(Runner, 'finishAudioTranscription').mockResolvedValue({ ...original, status: 'complete', output_json: output,
    service_version: 'standard-v2' })
  const queued = await transcribeShots([shot], f.deps, { allowNew: true, waitMs: 0 })
  expect(queued).toMatchObject({ newSeconds: 1, pendingPacks: 1, retryAfter: 3 })
  const wav = start.mock.calls[0]![1][0]!
  const resolved = await transcribeShots([shot], f.deps, { allowNew: false, waitMs: 0 })
  expect(resolved.states.get(shot.audio_sha256)).toMatchObject({ kind: 'ready', transcript: {
    silent: false, service_version: 'standard-v2', words: [{ start: 0.1, end: 0.7, text: '你好', speaker_id: 'speaker-a' }],
  } })
  await expect(readFile(wav)).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(join(f.root, 'transcript', 'shots', shot.audio_sha256 + '.json'))
  const rebuilt = await transcribeShots([shot], f.deps, { allowNew: false, waitMs: 0 })
  expect(rebuilt.states).toEqual(resolved.states)
  expect(finish.mock.calls.map(call => call[1])).toEqual(['receipt-1', 'receipt-1'])
  expect(start).toHaveBeenCalledTimes(1)
})

it('reports corrupt or unreadable receipts before treating them as a new upload', async () => {
  const f = await fixture()
  const shot = await f.audio('previous', Buffer.alloc(32_000, 3))
  const transcript = join(f.root, 'transcript')
  const shots = join(transcript, 'shots')
  const file = join(shots, shot.audio_sha256 + '.json')
  await mkdir(shots, { recursive: true })
  await writeFile(file, JSON.stringify({ version: 2, audio_sha256: shot.audio_sha256, words: [] }))
  await expect(readShotTranscript(f.root, shot.audio_sha256)).rejects.toThrow('镜头转写缓存无效')
  await rm(file)
  await mkdir(file)
  await expect(readShotTranscript(f.root, shot.audio_sha256)).rejects.toMatchObject({ code: 'EISDIR' })
  await writeFile(join(transcript, 'packs'), 'Not a folder')
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch')
  await expect(transcribeShots([shot], f.deps, { allowNew: true, waitMs: 0 })).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(start).not.toHaveBeenCalled()
})

it('reports sign-in and quota refusals while keeping staged packs ready to resume', async () => {
  const f = await fixture()
  const blocked = await f.audio('blocked', Buffer.alloc(11 * 32_000, 1))
  const staged = await f.audio('staged', Buffer.alloc(11 * 32_000, 2))
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch')
    .mockImplementationOnce(async (_root, inputs) => ({ items: [], not_started: [...inputs] }))
    .mockImplementationOnce(async (_root, inputs) => ({ items: [{ input: inputs[0]!, error: 'Sign in with Muse' }] }))
    .mockImplementationOnce(async (_root, inputs) => ({ items: [{ input: inputs[0]!, status: 'processing',
      receipt: 'receipt-quota', job_id: 'job-1', error_code: 'daily_quota' }] }))
  const first = await transcribeShots([blocked, staged], f.deps, { allowNew: true, waitMs: 0 })
  expect(first).toMatchObject({ newSeconds: 22, pendingPacks: 2 })
  expect(first.states.get(blocked.audio_sha256)).toEqual({ kind: 'pending' })
  const next = await transcribeShots([blocked, staged], f.deps, { allowNew: false, waitMs: 0 })
  expect(next).toMatchObject({ newSeconds: 0, pendingPacks: 2 })
  expect(next.states.get(blocked.audio_sha256)).toEqual({ kind: 'blocked', reason: 'sign_in_required' })
  expect(next.states.get(staged.audio_sha256)).toEqual({ kind: 'blocked', reason: 'daily_quota' })
  const finish = vi.spyOn(Runner, 'finishAudioTranscription').mockRejectedValue('Unusable response format')
  const rejected = await transcribeShots([staged], f.deps, { allowNew: false, waitMs: 0 })
  expect(rejected.states.get(staged.audio_sha256)).toEqual({ kind: 'blocked', reason: 'asr_error' })
  expect(finish.mock.calls[0]?.[1]).toBe('receipt-quota')
  expect(start).toHaveBeenCalledTimes(3)
})

it.each([
  { code: 'sign-in-required', reason: 'sign_in_required' },
  { code: 'provider_unavailable', reason: 'asr_error' },
] as const)('reports a structured $code receipt without replacing the staged media', async ({ code, reason }) => {
  const f = await fixture()
  const shot = await f.audio('structured', Buffer.alloc(32_000, 1))
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch').mockImplementation(async (_root, inputs) => ({ items: [
    { input: inputs[0]!, status: 'processing', receipt: 'original-receipt', job_id: 'original-job', error_code: code },
  ] }))
  const outcome = await transcribeShots([shot], f.deps, { allowNew: true, waitMs: 0 })
  expect(outcome.states.get(shot.audio_sha256)).toEqual({ kind: 'blocked', reason })
  expect(outcome.pendingPacks).toBe(1)
  await expect(readFile(start.mock.calls[0]![1][0]!)).resolves.toBeInstanceOf(Buffer)
})

it('preserves the original error state when upload and subsequent receipt polling fail', async () => {
  const f = await fixture()
  const shot = await f.audio('interrupted', Buffer.alloc(32_000, 2))
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch')
    .mockRejectedValueOnce(new Error('Sign in to resume the upload'))
    .mockRejectedValueOnce('Unknown transport error')
    .mockImplementationOnce(async (_root, inputs) => ({ items: [{ input: inputs[0]!, status: 'processing',
      receipt: 'retained-receipt', job_id: 'retained-job' }] }))
  const pass = (allowNew: boolean) => transcribeShots([shot], f.deps, { allowNew, waitMs: 0 })
  expect((await pass(true)).states.get(shot.audio_sha256)).toEqual({ kind: 'blocked', reason: 'sign_in_required' })
  expect((await pass(false)).states.get(shot.audio_sha256)).toEqual({ kind: 'blocked', reason: 'asr_error' })
  expect((await pass(false)).states.get(shot.audio_sha256)).toEqual({ kind: 'pending' })
  const finish = vi.spyOn(Runner, 'finishAudioTranscription').mockRejectedValueOnce(new Error('Sign in to read the original task'))
  expect((await pass(false)).states.get(shot.audio_sha256)).toEqual({ kind: 'blocked', reason: 'sign_in_required' })
  expect(finish.mock.calls[0]?.[1]).toBe('retained-receipt')
  expect(start.mock.calls.map(call => call[1])).toEqual(Array.from({ length: 3 }, () => start.mock.calls[0]![1]))
})

it('uses the configured media runner and publishes a silent cloud receipt without another submission', async () => {
  const f = await fixture()
  const shot = await f.audio('silent-on-server', Buffer.alloc(32_000, 2))
  const extract = vi.spyOn(Runner, 'extractSpeechPcm').mockImplementation(async (source, target) => extractPcm(source, target))
  const probe = vi.spyOn(Runner, 'probeMediaDuration').mockResolvedValue(1)
  const original = { receipt: 'original-receipt', job_id: 'original-job' }
  const start = vi.spyOn(Runner, 'startAudioTranscriptionBatch').mockImplementation(async (_root, inputs) => ({ items: [
    { input: inputs[0]!, status: 'processing', ...original },
  ] }))
  const { media: _media, ...deps } = f.deps
  const signal = new AbortController().signal
  await transcribeShots([shot], deps, { allowNew: true, waitMs: 0 }, signal)
  expect(extract).toHaveBeenCalledWith(shot.audio, expect.any(String), deps.runner, signal)
  const wav = start.mock.calls[0]![1][0]!
  const finish = vi.spyOn(Runner, 'finishAudioTranscription')
    .mockImplementationOnce(async (_root, _receipt, _account, _signal, _read, options) => {
      await options?.probe(wav, signal)
      return { ...original, status: 'complete', error_code: 'provider_unavailable' }
    })
    .mockResolvedValueOnce({ status: 'silent', ...original })
  const pending = await transcribeShots([shot], deps, { allowNew: false, waitMs: 0 }, signal)
  expect(pending.states.get(shot.audio_sha256)).toEqual({ kind: 'pending' })
  expect(probe).toHaveBeenCalledWith(wav, deps.runner, signal)
  const silent = await transcribeShots([shot], deps, { allowNew: false, waitMs: 0 }, signal)
  expect(silent.states.get(shot.audio_sha256)).toMatchObject({ kind: 'ready', transcript: { silent: true, words: [], flags: [] } })
  expect(finish.mock.calls.map(call => call[1])).toEqual(['original-receipt', 'original-receipt'])
  expect(start).toHaveBeenCalledTimes(1)
  await expect(readFile(wav)).rejects.toMatchObject({ code: 'ENOENT' })
})
