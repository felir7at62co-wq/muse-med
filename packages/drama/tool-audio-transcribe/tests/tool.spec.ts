/** Registered transcription calls keep account operations private and route receipt-bound requests. */
import { resolve } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { finishAudioTranscription, probeMediaDuration, startAudioTranscription, startAudioTranscriptionBatch, type AudioBatchResult, type AudioRunResult } from '../src/runner.ts'

vi.mock('../src/runner.ts', () => ({
  startAudioTranscription: vi.fn(async () => ({ status: 'processing', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
  startAudioTranscriptionBatch: vi.fn(async () => ({ items: [{ input: 'ep1.mp4', status: 'processing', receipt: 'project/transcript/jobs/ep1-v1.json', job_id: 'job' }] })),
  probeMediaDuration: vi.fn(async () => 30),
  finishAudioTranscription: vi.fn(async () => ({ status: 'complete', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
}))

type Agent = NonNullable<Parameters<typeof executeModelToolFixture>[1]['agent']>
const contexts: Context[] = []
const workspace = resolve('/workspace')
afterEach(async () => {
  vi.clearAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' })
  await ctx.plugin(MuseAccountService, { controller: {
    details: async () => { throw new Error('Unused fixture details') },
    status, logout: status, login: async () => { throw new Error('login is not part of a model tool call') },
  } })
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(NativeToolExecutor)
  const register = vi.spyOn(ctx.tools, 'register')
  const config = Config({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 600_000,
    maxDurationSeconds: 18_000, chunkSeconds: 600, pollIntervalMs: 2000, maxAudioBytes: 100_000_000,
    uploadRetryBudgetMs: 120_000, maxBatchInputs: 10 })
  apply(ctx, config)
  const tool = register.mock.calls[0]?.[0]
  if (tool === undefined) throw new Error('audio_transcribe was not registered')
  const account: unknown = ctx.get('museAccount')
  if (!(account instanceof MuseAccountService)) throw new Error('Muse account service was not mounted')
  let count = 0
  const agent = { session: { header: { cwd: workspace } } } as Agent
  return { tool, config, account, call: (args: Record<string, unknown>) => executeModelToolFixture(ctx, {
    callId: ToolCallId(`audio-${++count}`), name: 'audio_transcribe', arguments: args, signal: new AbortController().signal, agent,
  }) }
}

it('uses the Host account for start and preserves explicit language and purpose', async () => {
  const { call, tool, config, account } = await fixture()
  for (const fields of [{}, { language: 'auto', purpose: 'screenplay' }]) {
    const result = await call({ method: 'start', project: 'project', input: 'source.mp4', ...fields })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'processing', job_id: 'job' })
    const args = vi.mocked(startAudioTranscription).mock.calls.at(-1)
    if (!args) throw new Error('Expected a transcription start call')
    const [project, input, language, receiver, options, unused, purpose, signal, pacing] = args
    expect([project, input, language, unused, purpose]).toEqual([resolve(workspace, 'project'), 'source.mp4',
      'language' in fields ? 'auto' : 'zh', undefined, 'purpose' in fields ? 'screenplay' : undefined])
    await expect(receiver.status({})).resolves.toEqual(await account.readLocalStatus())
    expect(options).toBe(config)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(pacing).toEqual({ retryBudgetMs: 120_000 })
  }
  expect(tool.parameters).not.toHaveProperty('properties.cookie')
  expect(tool.parameters).not.toHaveProperty('properties.token')
  // oxlint-disable-next-line typescript/unbound-method -- asserting the tool exposes no concurrency-safe method
  expect(tool.isConcurrencySafe).toBeUndefined()
})

it('routes inputs to one batch start with the configured upload pacing', async () => {
  const { call, config, account } = await fixture()
  const result = await call({ method: 'start', project: 'project', inputs: ['ep1.mp4', 'ep2.mp4'], purpose: 'screenplay' })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ items: [{ input: 'ep1.mp4', status: 'processing' }] })
  const args = vi.mocked(startAudioTranscriptionBatch).mock.calls[0]
  if (!args) throw new Error('Expected a batch transcription start call')
  const [project, inputs, language, receiver, options, unused, purpose, signal, pacing] = args
  expect([project, inputs, language, unused, purpose]).toEqual([resolve(workspace, 'project'), ['ep1.mp4', 'ep2.mp4'], 'zh', undefined, 'screenplay'])
  await expect(receiver.status({})).resolves.toEqual(await account.readLocalStatus())
  expect(options).toBe(config)
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(pacing).toEqual({ retryBudgetMs: 120_000 })
  expect(startAudioTranscription).not.toHaveBeenCalled()
})

it.each([
  [{ input: 'ep1.mp4', inputs: ['ep2.mp4'] }, 'start accepts input or inputs, not both'],
  [{ inputs: [] }, 'inputs must list 1 to 10 files'],
  [{ inputs: Array.from({ length: 11 }, (_, index) => `ep${index + 1}.mp4`) }, 'inputs must list 1 to 10 files'],
  [{}, 'start requires input or inputs'],
] as const)('rejects start arguments %j before any runner call', async (fields, message) => {
  const { call } = await fixture()
  const result = await call({ method: 'start', project: 'project', ...fields })
  expect(result.isError).toBe(true)
  expect(result.error).toMatchObject({ message: `invalid arguments: ${message}`, info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } })
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(startAudioTranscriptionBatch).not.toHaveBeenCalled()
})

it('validates a batch result that stops at a local error and explains a queue refusal once', async () => {
  const { call } = await fixture()
  const refusal = { status: 'processing', receipt: 'project/transcript/jobs/ep2-v1.json', job_id: 'job-2', error_code: 'queue_full',
    retry_after_seconds: 2, resume_status: { method: 'status', project: 'project', receipt: 'project/transcript/jobs/ep2-v1.json' } } as const
  const responses: AudioBatchResult[] = [
    { items: [{ input: 'ep1.mp4', status: 'processing', receipt: 'project/transcript/jobs/ep1-v1.json', job_id: 'job-1' },
      { input: 'ep2.mp4', error: 'Media duration exceeds the cloud transcription limit' }], not_started: ['ep3.mp4'], polling_note: 'note' },
    { items: [{ input: 'ep1.mp4', ...refusal }, { input: 'ep2.mp4', ...refusal }], not_started: ['ep3.mp4'], polling_note: 'note' },
  ]
  for (const [index, response] of responses.entries()) {
    vi.mocked(startAudioTranscriptionBatch).mockResolvedValueOnce(response)
    const result = await call({ method: 'start', project: 'project', inputs: ['ep1.mp4', 'ep2.mp4', 'ep3.mp4'] })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual(response)
    expect(result.content).toEqual([
      ...(index === 1 ? [{ type: 'text', text: 'Muse 转写队列已满，请稍后重试' }] : []),
      { type: 'text', text: JSON.stringify(response) },
    ])
  }
})

it('queries the original receipt and renders the canonical response', async () => {
  const { call, account, config } = await fixture()
  const result = await call({ method: 'status', project: 'project', receipt: 'original.json' })
  expect(finishAudioTranscription).toHaveBeenCalledOnce()
  const args = vi.mocked(finishAudioTranscription).mock.calls[0]
  if (!args) throw new Error('Expected a transcription status call')
  const [project, receipt, receiver, signal, allowResumeUpload] = args
  expect([project, receipt]).toEqual([resolve(workspace, 'project'), 'original.json'])
  await expect(receiver.status({})).resolves.toEqual(await account.readLocalStatus())
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(allowResumeUpload).toBe(true)
  expect(args[6]).toEqual({ retryBudgetMs: 120_000 })
  const probe = args[5]?.probe
  if (probe === undefined) throw new Error('Expected the original staged-audio recovery probe')
  expect(await probe('original-staged.wav', signal)).toBe(30)
  expect(probeMediaDuration).toHaveBeenCalledWith('original-staged.wav', config, signal)
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
})

it('routes inspect to the original receipt without permitting a recovery upload', async () => {
  const { call } = await fixture()
  const result = await call({ method: 'inspect', project: 'project', receipt: 'original.json', wait_seconds: 20 })
  expect(result.isError).toBe(false)
  expect(finishAudioTranscription).toHaveBeenCalledOnce()
  expect(vi.mocked(finishAudioTranscription).mock.calls[0]?.[4]).toBe(false)
  expect(vi.mocked(finishAudioTranscription).mock.calls[0]?.[5]).toMatchObject({ waitMs: 20_000, pollIntervalMs: 2000 })
  expect(vi.mocked(finishAudioTranscription).mock.calls[0]?.[6]).toEqual({ retryBudgetMs: 120_000 })
  expect(startAudioTranscription).not.toHaveBeenCalled()
})

it('returns observed speaker coverage as advisory result metadata', async () => {
  const { call } = await fixture()
  const response: AudioRunResult = { status: 'complete', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job',
    output_json: 'project/transcript/raw/source-v1.json', speaker_summary: {
      status: 'not_provided', total_segments: 2, labelled_segments: 0, unlabelled_segments: 2, observed_groups: 0,
      note: '本结果未提供说话人分组；结合画面核对角色。',
    } }
  vi.mocked(finishAudioTranscription).mockResolvedValueOnce(response)
  const result = await call({ method: 'inspect', project: 'project', receipt: response.receipt })
  expect(result.isError).toBe(false)
  expect(result.value).toEqual(response)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response) }])
})

it.each(['start', 'status'] as const)('explains a %s queue refusal without changing its recovery response', async (method) => {
  const { call } = await fixture()
  const response: AudioRunResult = { status: 'processing', receipt: 'project/transcript/jobs/source-v1.json',
    job_id: 'job', error_code: 'queue_full', retry_after_seconds: 2,
    resume_status: { method: 'status', project: 'project', receipt: 'project/transcript/jobs/source-v1.json' } }
  if (method === 'start') vi.mocked(startAudioTranscription).mockResolvedValueOnce(response)
  else vi.mocked(finishAudioTranscription).mockResolvedValueOnce(response)
  const result = await call({ method, project: 'project', input: 'source.mp4', receipt: response.receipt })
  expect(result.isError).toBe(false)
  expect(result.value).toEqual(response)
  expect(result.content).toEqual([
    { type: 'text', text: 'Muse 转写队列已满，请稍后重试' },
    { type: 'text', text: JSON.stringify(response) },
  ])
})

it.each(['upload_busy', 'request_rate', 'provider_rate', 'daily_quota', 'server-unavailable', 'response-invalid',
  'request-rejected', 'idempotency_conflict'] as const)('keeps %s distinct from a queue refusal', async (code) => {
  const { call } = await fixture()
  const response: AudioRunResult = { status: 'processing', receipt: 'project/transcript/jobs/source-v1.json',
    job_id: 'job', error_code: code }
  vi.mocked(finishAudioTranscription).mockResolvedValueOnce(response)
  const result = await call({ method: 'status', project: 'project', receipt: response.receipt })
  expect(result.value).toEqual(response)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(response) }])
})

it('rejects incomplete and unsupported tool JSON before starting or querying a job', async () => {
  const { call } = await fixture()
  for (const args of [{ method: 'start', project: 'project' }, { method: 'status', project: 'project' },
    { method: 'inspect', project: 'project' },
    { method: 'unknown', project: 'project', input: 'source.mp4' }]) expect((await call(args)).isError).toBe(true)
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(finishAudioTranscription).not.toHaveBeenCalled()
})
