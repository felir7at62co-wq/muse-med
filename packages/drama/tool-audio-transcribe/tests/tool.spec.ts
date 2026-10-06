/** Registered transcription calls keep account operations private and route receipt-bound requests. */
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { finishAudioTranscription, startAudioTranscription } from '../src/runner.ts'

vi.mock('../src/runner.ts', () => ({
  startAudioTranscription: vi.fn(async () => ({ status: 'processing', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
  finishAudioTranscription: vi.fn(async () => ({ status: 'complete', receipt: 'project/transcript/jobs/source-v1.json', job_id: 'job' })),
}))

const contexts: Context[] = []
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
    expect(startAudioTranscription).toHaveBeenLastCalledWith('project', 'source.mp4',
      'language' in fields ? 'auto' : 'zh', account, config, undefined, 'purpose' in fields ? 'screenplay' : undefined)
  }
  expect(tool.parameters).not.toHaveProperty('properties.cookie')
  expect(tool.parameters).not.toHaveProperty('properties.token')
})

it('queries the original receipt and renders the canonical response', async () => {
  const { call, account } = await fixture()
  const result = await call({ method: 'status', project: 'project', receipt: 'original.json' })
  expect(finishAudioTranscription).toHaveBeenCalledExactlyOnceWith('project', 'original.json', account)
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
})

it('rejects incomplete and unsupported tool JSON before starting or querying a job', async () => {
  const { call } = await fixture()
  for (const args of [{ method: 'start', project: 'project' }, { method: 'status', project: 'project' },
    { method: 'unknown', project: 'project', input: 'source.mp4' }]) expect((await call(args)).isError).toBe(true)
  expect(startAudioTranscription).not.toHaveBeenCalled()
  expect(finishAudioTranscription).not.toHaveBeenCalled()
})
