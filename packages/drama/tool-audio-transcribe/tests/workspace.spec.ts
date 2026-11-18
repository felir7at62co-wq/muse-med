/** Relative projects resolve against the calling Session workspace, and silent screenplay results carry a model-visible note. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import type { AudioBatchResult, AudioRunResult } from '../src/runner.ts'

type Agent = NonNullable<Parameters<typeof executeModelToolFixture>[1]['agent']>
type Rendered = Parameters<ContentRenderer>[1]
type ContentRenderer = NonNullable<Parameters<Context['tools']['register']>[0]['output']>['render']

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-out' })
  await ctx.plugin(MuseAccountService, { controller: {
    status, logout: status, login: async () => { throw new Error('login is not part of a model tool call') },
  } })
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(NativeToolExecutor)
  const register = vi.spyOn(ctx.tools, 'register')
  apply(ctx, Config({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', commandTimeoutMs: 600_000,
    maxDurationSeconds: 18_000, chunkSeconds: 600, pollIntervalMs: 2000, maxAudioBytes: 100_000_000,
    uploadRetryBudgetMs: 120_000, maxBatchInputs: 10 }))
  const tool = register.mock.calls[0]?.[0]
  if (tool === undefined) throw new Error('audio_transcribe was not registered')
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'muse-audio-workspace-')))
  directories.push(workspace)
  await mkdir(join(workspace, 'proj'))
  let count = 0
  const call = (args: Record<string, unknown>, agent?: Agent) => executeModelToolFixture(ctx, {
    callId: ToolCallId(`audio-${++count}`), name: 'audio_transcribe', arguments: args, signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
  })
  const render = (value: Rendered): ContentBlock[] => {
    if (tool.output === undefined) throw new Error('audio_transcribe has no output renderer')
    return tool.output.render({}, value)
  }
  return { workspace, call, render, agent: { session: { header: { cwd: workspace } } } as Agent }
}

function text(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

it('resolves a relative project of a batch start against the Session workspace', async () => {
  const { workspace, call, agent } = await fixture()
  const result = await call({ method: 'start', project: 'proj', inputs: ['ep1.mp4'] }, agent)
  expect(result.isError).toBe(true)
  expect(text(result.content)).toContain(`(resolved to ${join(workspace, 'proj', 'ep1.mp4')})`)
  expect(text(result.content)).not.toContain(join(process.cwd(), 'proj'))
})

it('reads a relative receipt under the Session workspace project and names the jobs directory it requires', async () => {
  const { workspace, call, agent } = await fixture()
  const missing = await call({ method: 'inspect', project: 'proj', receipt: 'transcript/jobs/ep1-v1.json' }, agent)
  expect(missing.isError).toBe(true)
  expect(text(missing.content)).toContain(join(workspace, 'proj', 'transcript', 'jobs', 'ep1-v1.json'))
  const outside = await call({ method: 'status', project: 'proj', receipt: 'ep1-v1.json' }, agent)
  expect(outside.isError).toBe(true)
  expect(text(outside.content)).toContain(`transcript/jobs directory: ${join(workspace, 'proj', 'transcript', 'jobs')}`)
})

it('rejects a relative project without a Session workspace and keeps an absolute project as given', async () => {
  const { workspace, call } = await fixture()
  const relative = await call({ method: 'start', project: 'proj', inputs: ['ep1.mp4'] })
  expect(relative.isError).toBe(true)
  expect(relative.error).toMatchObject({ info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } })
  expect(text(relative.content)).toContain('project "proj" is relative but this Session has no workspace')
  const absolute = await call({ method: 'start', project: join(workspace, 'proj'), inputs: ['ep1.mp4'] })
  expect(absolute.isError).toBe(true)
  expect(text(absolute.content)).toContain(`(resolved to ${join(workspace, 'proj', 'ep1.mp4')})`)
})

const silent = { status: 'silent', receipt: '/w/proj/transcript/jobs/ep2-v1.json', job_id: 'job-2', purpose: 'screenplay' } satisfies AudioRunResult
const note = (content: readonly ContentBlock[]) => content.filter(block => block.type === 'text' && block.text.includes('不等于本集没有对白'))

it('prepends one note to a silent screenplay result', async () => {
  const { render } = await fixture()
  const content = render(silent)
  expect(content).toHaveLength(2)
  expect(note(content)).toEqual([content[0]])
  expect(text([content[0]!])).toMatch(/video_ocr.*video_inspect.*单个 input 并带 purpose: screenplay.*重转一次/)
  expect(text([content[0]!])).toMatch(/仍为 silent.*不再重转/)
  expect(content[1]).toEqual({ type: 'text', text: JSON.stringify(silent) })
})

it.each([{ purpose: 'subtitles' }, {}] satisfies Pick<AudioRunResult, 'purpose'>[])('renders a silent result with purpose %j as JSON only', async (fields) => {
  const { render } = await fixture()
  const value = { status: 'silent', receipt: silent.receipt, job_id: silent.job_id, ...fields } satisfies AudioRunResult
  expect(render(value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
})

it('prepends the silent note once to a batch after any queue refusal sentence', async () => {
  const { render } = await fixture()
  const complete = { input: 'a.mp4', status: 'complete', receipt: '/w/proj/transcript/jobs/a-v1.json', job_id: 'job-1', purpose: 'screenplay' } satisfies AudioBatchResult['items'][number]
  const mixed = { items: [complete, { input: 'b.mp4', ...silent }, { input: 'c.mp4', ...silent }] } satisfies AudioBatchResult
  const mixedContent = render(mixed)
  expect(mixedContent).toHaveLength(3)
  expect(note(mixedContent)).toEqual([mixedContent[0]])
  expect(mixedContent[1]).toEqual({ type: 'text', text: '转写进度：第1项已完成、第2项无语音、第3项无语音。' })
  const queued = { items: [
    { input: 'a.mp4', status: 'processing', receipt: complete.receipt, job_id: 'job-1', error_code: 'queue_full' },
    { input: 'b.mp4', ...silent },
  ] } satisfies AudioBatchResult
  const queuedContent = render(queued)
  expect(queuedContent).toHaveLength(4)
  expect(queuedContent[0]).toEqual({ type: 'text', text: 'Muse 转写队列已满，请稍后重试' })
  expect(note(queuedContent)).toEqual([queuedContent[1]])
  expect(queuedContent[2]).toEqual({ type: 'text', text: '转写进度：第1项暂未推进、第2项无语音。' })
  expect(queuedContent[3]).toEqual({ type: 'text', text: JSON.stringify(queued) })
  const stopped = { items: [complete, { input: 'b.mp4', error: 'Transcription input is not a file' }], not_started: ['c.mp4'] } satisfies AudioBatchResult
  expect(render(stopped)).toEqual([
    { type: 'text', text: '转写进度：第1项已完成、第2项出错、另有 1 项本次未开始。' },
    { type: 'text', text: JSON.stringify(stopped) },
  ])
})

it('does not label an unfamiliar status as a successful upload', async () => {
  const { render } = await fixture()
  const batch = { items: [{ input: 'clip.mp4', status: 'not-recognized' }] }
  expect(render(batch)[0]).toEqual({ type: 'text', text: '转写进度：第1项待核对。' })
})
