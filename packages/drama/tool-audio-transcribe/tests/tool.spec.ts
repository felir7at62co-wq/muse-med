/** Registered transcription calls keep account operations private and route receipt-bound requests. */
import { Context, symbols } from '@deepseek-ai/cordis'
import { MuseAccountService, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { finishAudioTranscription, startAudioTranscription, type AudioAccount, type AudioRunResult } from '../src/runner.ts'

vi.mock('../src/runner.ts', () => ({
  startAudioTranscription: vi.fn(async () => ({ status: 'processing', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
  finishAudioTranscription: vi.fn(async () => ({ status: 'complete', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
}))

const contexts: Context[] = []
function originalAccount(service: AudioAccount): MuseAccountService {
  const original: unknown = Reflect.get(service, symbols.original)
  if (!(original instanceof MuseAccountService)) throw new Error('Expected a Cordis account service receiver')
  return original
}
afterEach(async () => {
  vi.clearAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' })
  await ctx.plugin(MuseAccountService, { controller: {
    status, logout: status, login: async () => { throw new Error('login is not part of a model tool call') },
  } })
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await()
  const register = vi.spyOn(ctx.tools, 'register')
  const config = Config({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 600_000,
    maxDurationSeconds: 18_000, chunkSeconds: 600, maxAudioBytes: 100_000_000 })
  apply(ctx, config)
  const tool = register.mock.calls[0]?.[0]
  if (tool === undefined) throw new Error('audio_transcribe was not registered')
  const account: unknown = ctx.get('museAccount')
  if (!(account instanceof MuseAccountService)) throw new Error('Muse account service was not mounted')
  let count = 0
  return { tool, config, account, call: (args: Record<string, unknown>) => ctx.tools.execute({
    callId: ToolCallId(`audio-${++count}`), name: 'audio_transcribe', arguments: args, signal: new AbortController().signal,
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
    const [project, input, language, receiver, options, unused, purpose, signal] = args
    expect([project, input, language, unused, purpose]).toEqual(['project', 'source.mp4',
      'language' in fields ? 'auto' : 'zh', undefined, 'purpose' in fields ? 'screenplay' : undefined])
    expect(originalAccount(receiver) === originalAccount(account)).toBe(true)
    expect(options).toBe(config)
    expect(signal).toBeInstanceOf(AbortSignal)
  }
  expect(tool.parameters).not.toHaveProperty('properties.cookie')
  expect(tool.parameters).not.toHaveProperty('properties.token')
})

it('queries the original receipt and renders the canonical response', async () => {
  const { call, account } = await fixture()
  const result = await call({ method: 'status', project: 'project', receipt: 'original.json' })
  expect(finishAudioTranscription).toHaveBeenCalledOnce()
  const args = vi.mocked(finishAudioTranscription).mock.calls[0]
  if (!args) throw new Error('Expected a transcription status call')
  const [project, receipt, receiver, signal, allowResumeUpload] = args
  expect([project, receipt]).toEqual(['project', 'original.json'])
  expect(originalAccount(receiver) === originalAccount(account)).toBe(true)
  expect(signal).toBeInstanceOf(AbortSignal)
  expect(allowResumeUpload).toBe(true)
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
})

it('routes inspect to the original receipt without permitting a recovery upload', async () => {
  const { call } = await fixture()
  const result = await call({ method: 'inspect', project: 'project', receipt: 'original.json' })
  expect(result.isError).toBe(false)
  expect(finishAudioTranscription).toHaveBeenCalledOnce()
  expect(vi.mocked(finishAudioTranscription).mock.calls[0]?.[4]).toBe(false)
  expect(startAudioTranscription).not.toHaveBeenCalled()
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
