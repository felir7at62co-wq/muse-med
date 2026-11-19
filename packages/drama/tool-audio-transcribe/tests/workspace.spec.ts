/** Relative projects resolve against the calling Session workspace, and silent screenplay results carry a model-visible note. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, MuseAsrClient, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
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

async function fixture(options: { identity?: MuseAccountStatus; refreshModels?: () => Promise<void>; asr?: MuseAsrClient } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const status = async (): Promise<MuseAccountStatus> => options.identity ?? { state: 'signed-out' }
  await ctx.plugin(MuseAccountService, { controller: {
    details: async () => { throw new Error('Unused fixture details') },
    status, logout: status, login: async () => { throw new Error('login is not part of a model tool call') },
  }, ...(options.refreshModels === undefined ? {} : { models: { refresh: options.refreshModels } }),
  ...(options.asr === undefined ? {} : { asr: options.asr }) })
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
  return { workspace, call, render, account: ctx.museAccount, agent: { session: { header: { cwd: workspace } } } as Agent }
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

it('resumes an owned receipt without waiting for the model catalog and still rejects a different owner', async () => {
  const refreshing = Promise.withResolvers<'models'>(), release = Promise.withResolvers<undefined>()
  const refreshModels = vi.fn(async () => { refreshing.resolve('models'); await release.promise })
  const { workspace, call, agent, account } = await fixture({ refreshModels,
    identity: { state: 'signed-in', username: 'writer', verified: false } })
  const project = join(workspace, 'proj'), jobs = join(project, 'transcript', 'jobs'), raw = join(project, 'transcript', 'raw')
  await Promise.all([mkdir(jobs, { recursive: true }), mkdir(raw, { recursive: true })])
  const own = randomUUID(), foreign = randomUUID()
  for (const [stem, accountUsername, id] of [['own', 'writer', own], ['foreign', 'other', foreign]] as const) {
    await writeFile(join(jobs, stem + '-v1.json'), JSON.stringify({ id, source: join(project, stem + '.wav'),
      stem, version: 1, accountUsername, language: 'zh', purpose: 'subtitles', status: 'complete',
      sha256: 'a'.repeat(64), mp3: join(jobs, '.' + id + '.wav') }))
  }
  await Promise.all([writeFile(join(raw, 'own-v1.txt'), 'speech'),
    writeFile(join(raw, 'own-v1.json'), JSON.stringify([{ start: 0, end: 1, text: 'speech' }]))])
  const inspect = (stem: string) => call({ method: 'inspect', project: 'proj', receipt: 'transcript/jobs/' + stem + '-v1.json' }, agent)
  const operation = inspect('own')
  try {
    expect(await Promise.race([refreshing.promise, operation.then(() => 'transcription')])).toBe('transcription')
    const completed = await operation
    expect(completed.isError).toBe(false)
    expect(text(completed.content)).toContain('"status":"complete"')
    const denied = await inspect('foreign')
    expect(denied.isError).toBe(true)
    expect(text(denied.content)).toContain('Sign in to the Muse account that created this transcription receipt')
    expect(refreshModels).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await operation }
  await account.status({})
  expect(refreshModels).toHaveBeenCalledOnce()
})

it('only status can resume a never-accepted receipt with its original audio and purpose', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-audio-local-gateway-'))
  directories.push(home)
  const baseUrl = 'https://muse.test', username = 'writer', sessionFile = join(home, 'session.json')
  await writeFile(sessionFile, JSON.stringify({ baseUrl, username, revision: randomUUID(), cookie: '__Host-muse=fixture' }))
  const id = randomUUID(), audio = 'fixtures are local', sha256 = createHash('sha256').update(audio).digest('hex')
  const job = { id, purpose: 'screenplay', service_version: 'standard-v2', status: 'processing' }
  let accepted = false
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'GET') return accepted ? Response.json(job) : Response.json({ error: 'ASR job not found' }, { status: 404 })
    if (init?.method !== 'POST' || !(init.body instanceof Blob)) throw new Error('Expected staged audio upload')
    expect(await init.body.text()).toBe(audio)
    accepted = true
    return Response.json(job, { status: 202 })
  })
  const asr = new MuseAsrClient({ baseUrl, sessionFile, requestTimeoutMs: 2000, fetcher })
  const { workspace, call, agent } = await fixture({ asr, identity: { state: 'signed-in', username, verified: false } })
  const project = join(workspace, 'proj'), jobs = join(project, 'transcript', 'jobs'), mp3 = join(jobs, '.' + id + '.wav')
  const receipt = 'transcript/jobs/original-v1.json'
  await mkdir(jobs, { recursive: true })
  await writeFile(mp3, audio)
  await writeFile(join(project, receipt), JSON.stringify({ id, sha256, mp3, source: join(project, 'original.mp4'),
    stem: 'original', version: 1, accountUsername: username, language: 'auto', purpose: 'screenplay', status: 'prepared' }))
  const read = (method: 'inspect' | 'status') => call({ method, project: 'proj', receipt }, agent)
  const inspected = await read('inspect')
  expect(inspected.isError).toBe(false)
  expect(inspected.value).toMatchObject({ job_id: id, error_code: 'job-not-found' })
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET'])
  for (const _attempt of [1, 2]) {
    const result = await read('status')
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ job_id: id, purpose: 'screenplay', status: 'processing', service_version: 'standard-v2' })
  }
  const queryPath = '/api/asr/jobs/' + id
  expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
    [queryPath, 'GET'], [queryPath, 'GET'], ['/api/asr/jobs', 'POST'], [queryPath, 'GET'],
  ])
  const headers = new Headers(fetcher.mock.calls[2]?.[1]?.headers)
  expect(['idempotency-key', 'x-audio-sha256', 'x-audio-language', 'x-muse-asr-purpose'].map(name => headers.get(name)))
    .toEqual([id, sha256, 'auto', 'screenplay'])
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
  expect(mixedContent).toHaveLength(2)
  expect(note(mixedContent)).toEqual([mixedContent[0]])
  const queued = { items: [
    { input: 'a.mp4', status: 'processing', receipt: complete.receipt, job_id: 'job-1', error_code: 'queue_full' },
    { input: 'b.mp4', ...silent },
  ] } satisfies AudioBatchResult
  const queuedContent = render(queued)
  expect(queuedContent).toHaveLength(3)
  expect(queuedContent[0]).toEqual({ type: 'text', text: 'Muse 转写队列已满，请稍后重试' })
  expect(note(queuedContent)).toEqual([queuedContent[1]])
  expect(queuedContent[2]).toEqual({ type: 'text', text: JSON.stringify(queued) })
  const stopped = { items: [complete, { input: 'b.mp4', error: 'Transcription input is not a file' }], not_started: ['c.mp4'] } satisfies AudioBatchResult
  expect(render(stopped)).toEqual([{ type: 'text', text: JSON.stringify(stopped) }])
})
