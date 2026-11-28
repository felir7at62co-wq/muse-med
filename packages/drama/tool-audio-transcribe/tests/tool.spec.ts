/** Registered transcription calls keep account operations private and route receipt-bound requests. */
import { resolve } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import * as Offline from '../src/offline.ts'
import * as Pronunciation from '../src/pronunciation.ts'
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

async function fixture(optional: Pick<Config, 'offline' | 'pronunciation'> = {}) {
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
    uploadRetryBudgetMs: 120_000, maxBatchInputs: 10, ...optional })
  apply(ctx, config)
  const tool = register.mock.calls[0]?.[0]
  if (tool === undefined) throw new Error('audio_transcribe was not registered')
  const account: unknown = ctx.get('museAccount')
  if (!(account instanceof MuseAccountService)) throw new Error('Muse account service was not mounted')
  let count = 0
  const agent = { session: { header: { cwd: workspace } } } as Agent
  return { tool, config, account, call: (args: Record<string, unknown>, withWorkspace = true) => executeModelToolFixture(ctx, {
    callId: ToolCallId(`audio-${++count}`), name: 'audio_transcribe', arguments: args, signal: new AbortController().signal,
    ...(withWorkspace ? { agent } : {}),
  }) }
}

const localAssets = { pythonPath: resolve(workspace, 'python'), libraryDir: resolve(workspace, 'library'),
  librarySha256: 'a'.repeat(64), modelDir: resolve(workspace, 'models') }
const phrase = { tokens: ['wo3', 'dai4', 'ding4'], target_index: 1, alternative: 'zai4',
  windows: [{ start: 2.2, end: 3.4 }, { start: 2, end: 3.5 }] }

it('exposes local speech methods only when provisioned and rejects cloud or ambiguous inputs before running a local engine', async () => {
  const disabled = await fixture()
  const enabled = await fixture({ offline: localAssets, pronunciation: localAssets })
  expect(disabled.tool.parameters).not.toHaveProperty('properties.pronunciation')
  expect(enabled.tool.parameters).toHaveProperty('properties.method.enum', ['start', 'inspect', 'status', 'offline', 'pronunciation'])
  expect(enabled.tool.parameters).toHaveProperty('properties.pronunciation')
  const project = resolve(workspace, 'project'), input = 'source.mp4'
  expect((await disabled.call({ method: 'offline', project, input })).isError).toBe(true)
  const transcribe = vi.spyOn(Offline, 'transcribeOffline')
  const compare = vi.spyOn(Pronunciation, 'inspectPronunciation')
  try {
    const calls = [
      [{ method: 'offline', project, input }, false, 'offline requires a workspace'],
      [{ method: 'offline', project, input, inputs: [input] }, true, 'offline requires a workspace'],
      [{ method: 'offline', project, input, pronunciation: phrase }, true, 'offline requires a workspace'],
      [{ method: 'pronunciation', project, input }, true, 'pronunciation requires a workspace'],
      [{ method: 'pronunciation', project, input, pronunciation: phrase, receipt: 'cloud.json' }, true, 'pronunciation requires a workspace'],
      [{ method: 'start', project, input, pronunciation: phrase }, true, 'pronunciation parameters require method pronunciation'],
    ] as const
    for (const [args, withWorkspace, message] of calls) {
      const result = await enabled.call(args, withWorkspace)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(message)
    }
    expect(transcribe).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    expect(startAudioTranscription).not.toHaveBeenCalled()
  } finally {
    transcribe.mockRestore()
    compare.mockRestore()
  }
})

it('returns structured native-only receipts without invoking the cloud account and issues a new evidence ID per comparison', async () => {
  const { call, config } = await fixture({ offline: localAssets, pronunciation: localAssets })
  const project = resolve(workspace, 'project'), input = 'source.mp4'
  const source = { path: resolve(project, input), sha256: 'b'.repeat(64) }
  const pcm = { sha256: 'c'.repeat(64), sampleRate: 16_000, samples: 32_000 } as const
  const transcript: Offline.OfflineTranscript = {
    version: 1, kind: 'muse_offline_word_timing', project, source, pcm,
    model: { name: 'Systran/faster-whisper-small', revision: '536b0662742c02347bc0e980a01041f333bce120',
      sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671' },
    transcript: { path: resolve(project, 'transcript/words.json'), sha256: 'd'.repeat(64) },
    receipt: resolve(project, 'transcript/receipt.json'), listening_verified: false,
  }
  const pronunciation: Pronunciation.OfflinePronunciationResult = { offline_pronunciation: {
    version: 1, project, source, status: 'uncertain',
    model: { name: 'robinsonphan/sensevoice-small-zh-pinyin-dual-ctc', revision: '884e70660b97f9c242f1d77c8516aea62a8fdf29',
      sha256: 'ed3c7db2468b99fd3811578fff6000c990875c22b1e93abcd08f9c05bc61a93a' },
    expected: 'dai4', alternative: 'zai4', target_index: 1, minimum_margin: 8, listening_verified: false,
    windows: phrase.windows.map(window => ({ ...window, pcm })), note: 'advisory evidence only',
  } }
  const transcribe = vi.spyOn(Offline, 'transcribeOffline').mockResolvedValue(transcript)
  const compare = vi.spyOn(Pronunciation, 'inspectPronunciation').mockResolvedValue(pronunciation)
  try {
    const words = await call({ method: 'offline', project: 'project', input })
    expect(words.isError).toBe(false)
    expect(words).toMatchObject({ value: { offline_transcript: transcript }, content: [{ type: 'text', text: JSON.stringify(words.value) }] })
    expect(words.meta).toMatchObject({ [TOOL_BODY_META_KEY]: { offline_transcript: transcript } })
    expect(transcribe).toHaveBeenCalledWith(workspace, project, input, config, config.offline, expect.any(AbortSignal))
    const args = { method: 'pronunciation', project: 'project', input, pronunciation: phrase }
    const first = await call(args)
    const second = await call(args)
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(first.value).toMatchObject({ offline_pronunciation: { source, listening_verified: false } })
    expect(first.value).toHaveProperty('offline_pronunciation.evidence_id',
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu))
    expect(first.meta).toMatchObject({ [TOOL_BODY_META_KEY]: first.value })
    expect(second.value).not.toEqual(first.value)
    expect(compare).toHaveBeenCalledWith(workspace, project, input, phrase, config, config.pronunciation, expect.any(AbortSignal))
    expect(startAudioTranscription).not.toHaveBeenCalled()
    expect(finishAudioTranscription).not.toHaveBeenCalled()
  } finally {
    transcribe.mockRestore()
    compare.mockRestore()
  }
})

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
      { type: 'text', text: index === 1 ? '转写进度：第1项暂未推进、第2项暂未推进、另有 1 项本次未开始。'
        : '转写进度：第1项处理中、第2项出错、另有 1 项本次未开始。' },
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

it('reports the batch stages in input order and points a timed-out item back to its original receipt', async () => {
  const { call } = await fixture()
  const stages = [{ status: 'complete' }, { status: 'silent' }, { status: 'failed' }, { status: 'processing', queued: true },
    { status: 'preparing' }, { status: 'submitting' }, { status: 'uncertain', error_code: 'upload-timeout', resume_status: {
      method: 'inspect', project: 'project', receipt: 'project/transcript/jobs/clip-7-v1.json',
    } }] as const
  const response: AudioBatchResult = { items: stages.map((stage, index) => ({
    ...stage, input: `clip-${index + 1}.mp4`, receipt: `project/transcript/jobs/clip-${index + 1}-v1.json`, job_id: `job-${index + 1}`,
  })), not_started: ['clip-8.mp4'] }
  vi.mocked(startAudioTranscriptionBatch).mockResolvedValueOnce(response)
  const result = await call({ method: 'start', project: 'project', inputs: [...response.items.map(item => item.input), 'clip-8.mp4'] })
  expect(result.value).toEqual(response)
  expect(result.content).toEqual([
    { type: 'text', text: '转写进度：第1项已完成、第2项无语音、第3项失败、第4项已排队、第5项提交中、第6项提交中、第7项待确认、另有 1 项本次未开始。' },
    { type: 'text', text: '本次未能确认转写状态。请用原收据查询，已受理的任务仍可继续处理。' },
    { type: 'text', text: JSON.stringify(response) },
  ])
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
