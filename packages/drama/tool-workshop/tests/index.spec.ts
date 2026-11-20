import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult, type ToolResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { WorkbenchHttpError, type WorkbenchRequest, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'

type Route = (path: string, options: WorkbenchRequest) => unknown

const READY = { ready: true, queue: { queued: 12, claimed: 2, label: 'ignored' }, maxSlots: 4 }
const SERIES = '7481108346636864536'
const OTHER_SERIES = '7470000000000000001'

function job(id: number, status: string, extra: Record<string, unknown> = {}) {
  return { id, job_type: 'video_transcribe', status, progress: {}, result: {}, error: null, created_at: '2026-11-20T00:05:00', finished_at: null, ...extra }
}

async function bench(route: Route, options: { approval?: string | null; connection?: boolean; config?: Partial<plugin.Config> } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const request = vi.fn(async (path: string, init: WorkbenchRequest = {}) => {
    const value = route(path, init)
    if (value instanceof Error) throw value
    return value
  })
  const session: WorkbenchSession = { identity: 'workshop-user', origin: 'https://muse.example/jubengongfang', request, fetch: vi.fn(), check: vi.fn() }
  const asked = vi.fn((_reason: string | undefined) => options.approval ?? 'allowed-once')
  class Connection extends Service {
    constructor(parent: Context) { super(parent, 'workshopConnection') }
    connection = vi.fn(async () => session)
  }
  class Approval extends Service {
    constructor(parent: Context) { super(parent, 'approval') }
    async request(req: { reason?: string }) { return asked(req.reason) }
  }
  if (options.approval !== null) await ctx.plugin(Approval)
  const service = options.connection === false ? undefined : ctx.plugin(Connection)
  await service?.await()
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, options.config ?? {})
  await fiber.await()
  const call = (args: unknown, agent = true) => executeToolFixture(ctx, {
    name: 'workshop_video_transcribe', arguments: args, callId: ToolCallId('workshop-call'), signal: new AbortController().signal,
    ...(agent ? { agent: { session: { id: 'session-1' } } as never } : {}),
  })
  return { ctx, call, request, asked, fiber, service }
}

function failure(result: ToolExecutionResult) {
  expect(result.isError).toBe(true)
  return { message: result.error?.message, ...result.error?.info }
}

function present(ctx: Context, result: ToolResult) {
  return ctx.tools.get('workshop_video_transcribe')?.presentResult?.({ action: 'status' }, result)
}

describe('workshop_video_transcribe', () => {
  it('registers only while the Host provides the Workshop connection and removes itself on disposal', async () => {
    const { ctx, fiber, service } = await bench(() => READY)
    const definition = ctx.tools.get('workshop_video_transcribe')
    expect(definition?.description).toBe('剧本工坊的视频转剧本任务：从数据站爆款队列领剧，经 AI 观众选材、红果整剧下载和云端 Muse 逐集转写，出稿存为工坊剧本。'
      + 'status 查看是否就绪、队列和任务进度；start 按参数开始一个任务，resume 沿用原参数续跑已停止的任务，两者都会产生下载与转写费用，提交前请用户确认；'
      + 'stop 停止任务，已领取的剧保留进度。')
    expect(definition?.isConcurrencySafe?.({ action: 'status' })).toBe(true)
    expect(definition?.isConcurrencySafe?.({ action: 'start' })).toBe(false)
    await service?.dispose()
    expect(ctx.tools.get('workshop_video_transcribe')).toBeUndefined()
    await fiber.dispose()
    const absent = await bench(() => READY, { connection: false })
    expect(absent.ctx.tools.get('workshop_video_transcribe')).toBeUndefined()
  })

  it('reports readiness and the newest 视频转剧本 jobs without their per-series lists', async () => {
    const listed = [
      { ...job(31, 'running', { progress: { percent: 40, status_message: '2 部转写中 · 已出稿 2 部' }, result: { delivered: [{}, {}], attention: [{}], rejected: [] } }) },
      { id: 30, job_type: 'create_spawn', status: 'completed' },
      ...Array.from({ length: 11 }, (_, index) => job(29 - index, 'completed', { error: index === 0 ? '数据站暂时无法访问' : null })),
    ]
    const { call, request } = await bench(path => path === '/factory/video-transcribe/status' ? READY : listed)
    const result = await call({ action: 'status' })
    expect(result.value).toEqual({
      action: 'status',
      service: { ready: true, queue: { queued: 12, claimed: 2 }, max_slots: 4 },
      jobs: [
        { id: 31, status: 'running', percent: 40, message: '2 部转写中 · 已出稿 2 部', delivered: 2, attention: 1, rejected: 0, created_at: '2026-11-20T00:05:00' },
        { id: 29, status: 'completed', delivered: 0, attention: 0, rejected: 0, error: '数据站暂时无法访问', created_at: '2026-11-20T00:05:00' },
        ...Array.from({ length: 8 }, (_, index) => ({ id: 28 - index, status: 'completed', delivered: 0, attention: 0, rejected: 0, created_at: '2026-11-20T00:05:00' })),
      ],
    })
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/factory/video-transcribe/status', '/factory/jobs?limit=50'])
    expect(result.meta).toEqual({ action: 'status', ready: true, jobs: 10 })
  })

  it('reports one job with its slots and the newest series of each outcome', async () => {
    const delivered = Array.from({ length: 25 }, (_, index) => ({ series_id: String(7481108346636864500n + BigInt(index)), title: '剧' + String(index), episodes: 60, published: index % 2 === 0, private: 'x' }))
    const detailed = job(12, 'running', {
      config_json: { count: 0, concurrency: 2, quality: '1080p', publish: true, only_series: [SERIES, 'bad'], task_name: 't' },
      progress: { percent: 5, status_message: '1 部转写中', queue: { queued: 9 }, slots: [
        { slot: 1, state: 'transcribing', series_id: SERIES, title: '家里家外', episode: 12, total: 79, message: '第12集' }, { slot: 2, state: 'idle' }, 'bad'] },
      result: { delivered, attention: [{ series_id: OTHER_SERIES, title: '待查', state: 'needs-attention', reason: 'x'.repeat(300) }], rejected: 'bad' },
    })
    const { call } = await bench(path => path === '/factory/jobs/12' ? detailed : { ready: false, error: '工坊尚未启用视频转剧本，请管理员配置转写执行器' })
    const result = await call({ action: 'status', job_id: 12 })
    expect(result.value).toMatchObject({
      action: 'status',
      service: { ready: false, error: '工坊尚未启用视频转剧本，请管理员配置转写执行器' },
      job: {
        id: 12, status: 'running', percent: 5, message: '1 部转写中', delivered: 25, attention: 1, rejected: 0,
        config: { count: 0, concurrency: 2, quality: '1080p', publish: true, only_series: [SERIES] },
        slots: [{ slot: 1, state: 'transcribing', series_id: SERIES, title: '家里家外', episode: 12, total: 79, message: '第12集' }, { slot: 2, state: 'idle' }],
        queue: { queued: 9 },
        attention_series: [{ series_id: OTHER_SERIES, title: '待查', state: 'needs-attention', reason: 'x'.repeat(200) }],
        rejected_series: [],
      },
    })
    const reported = result.value as { job: { delivered_series: { title: string; private?: string }[] } }
    expect(reported.job.delivered_series.map(item => item.title)).toEqual(delivered.slice(-20).map(item => item.title))
    expect(reported.job.delivered_series[0]).not.toHaveProperty('private')
    expect(result.meta).toEqual({ action: 'status', job_id: 12, status: 'running', percent: 5, ready: false })
  })

  it('reports a job whose progress, results and parameters are missing or malformed', async () => {
    const bare = { ...job(8, 'pending', { progress: null, result: null }), config_json: { count: 'x', publish: 'yes', only_series: 'bad' } }
    const { call } = await bench(path => path === '/factory/jobs/8' ? bare : READY)
    expect((await call({ action: 'status', job_id: 8 })).value).toEqual({
      action: 'status', service: { ready: true, queue: { queued: 12, claimed: 2 }, max_slots: 4 },
      job: { id: 8, status: 'pending', config: { only_series: [] }, delivered: 0, attention: 0, rejected: 0, created_at: '2026-11-20T00:05:00',
        slots: [], delivered_series: [], attention_series: [], rejected_series: [] },
    })
  })

  it.each<[string, Route, Record<string, unknown>, string]>([
    ['a missing job', path => path === '/factory/jobs/5' ? new WorkbenchHttpError(404, 'WORKSHOP_HTTP_ERROR', 'Job not found') : READY, { job_id: 5 }, 'WORKSHOP_JOB_NOT_FOUND'],
    ['another job type', path => path === '/factory/jobs/5' ? { ...job(5, 'running'), job_type: 'create_spawn' } : READY, { job_id: 5 }, 'WORKSHOP_NOT_TRANSCRIBE_JOB'],
    ['another job ID', path => path === '/factory/jobs/5' ? job(6, 'running') : READY, { job_id: 5 }, 'WORKSHOP_INVALID_RESULT'],
    ['a malformed job', path => path === '/factory/jobs/5' ? { id: 5 } : READY, { job_id: 5 }, 'WORKSHOP_INVALID_RESULT'],
    ['a non-object job', path => path === '/factory/jobs/5' ? 'job' : READY, { job_id: 5 }, 'WORKSHOP_INVALID_RESULT'],
    ['a server failure', path => path === '/factory/jobs/5' ? new WorkbenchHttpError(500, 'WORKSHOP_HTTP_ERROR', '剧本工坊请求失败。') : READY, { job_id: 5 }, 'WORKSHOP_HTTP_ERROR'],
    ['a malformed readiness', () => ({ ready: 'yes' }), {}, 'WORKSHOP_INVALID_RESULT'],
    ['a malformed job list', path => path === '/factory/video-transcribe/status' ? READY : { jobs: [] }, {}, 'WORKSHOP_INVALID_RESULT'],
    ['a zero job ID', () => READY, { job_id: 0 }, 'INVALID_ARGS'],
  ])('reports %s', async (_name, route, args, code) => {
    const { call } = await bench(route)
    expect(failure(await call({ action: 'status', ...args }))).toMatchObject({ code })
  })

  it('starts a job with the pipeline card defaults after the user confirms its parameters', async () => {
    const { call, request, asked } = await bench(path => path === '/factory/jobs' ? { job_id: 41 } : READY)
    const result = await call({ action: 'start' })
    expect(result.value).toEqual({ action: 'start', job_id: 41, config: { count: 0, concurrency: 1, quality: '720p', publish: false, only_series: [] } })
    expect(asked).toHaveBeenCalledWith([
      '剧本工坊 · 视频转剧本', '部数：持续运行直到停止', '同时转写：1 部（最多 4 部）', '画质：720p', '通过检查后上架：否', '只转这些剧：按队列顺序',
      '领取数据站队列中的剧，下载红果全集并逐集转写，会产生下载与转写费用。',
    ].join('\n'))
    expect(request.mock.calls.at(-1)).toMatchObject(['/factory/jobs', { method: 'POST', body: { job_type: 'video_transcribe', config: { count: 0, concurrency: 1, quality: '720p', publish: false, only_series: [] } } }])
    expect(result.meta).toEqual({ action: 'start', job_id: 41 })
  })

  it('sends chosen parameters once and names them in the confirmation', async () => {
    const { call, request, asked } = await bench(path => path === '/factory/jobs' ? { job_id: 42 } : { ready: true })
    const args = { action: 'start', count: 3, concurrency: 2, quality: '1080p', publish: true, only_series: [SERIES, OTHER_SERIES, SERIES] }
    expect((await call(args)).value).toMatchObject({ job_id: 42, config: { count: 3, concurrency: 2, quality: '1080p', publish: true, only_series: [SERIES, OTHER_SERIES] } })
    expect(asked.mock.calls[0]?.[0]).toContain('部数：3 部\n同时转写：2 部\n画质：1080p\n通过检查后上架：是\n只转这些剧：' + SERIES + '、' + OTHER_SERIES)
    expect(request.mock.calls.filter(([path]) => path === '/factory/jobs')).toHaveLength(1)
  })

  it.each<[string, Record<string, unknown>, Route, string, string]>([
    ['a negative count', { count: -1 }, () => READY, 'INVALID_ARGS', 'count 必须不小于 0'],
    ['zero concurrency', { concurrency: 0 }, () => READY, 'INVALID_ARGS', 'concurrency 必须不小于 1'],
    ['an invalid series', { only_series: ['abc'] }, () => READY, 'INVALID_ARGS', 'only_series 只能是红果作品编号'],
    ['more slots than the deployment has', { concurrency: 5 }, () => READY, 'INVALID_ARGS', 'concurrency 必须是 1 到 4'],
    ['an unavailable step', {}, () => ({ ready: false, error: '红果下载配置尚未安装' }), 'WORKSHOP_TRANSCRIBE_UNAVAILABLE', '红果下载配置尚未安装'],
    ['an unavailable step without a reason', {}, () => ({ ready: false }), 'WORKSHOP_TRANSCRIBE_UNAVAILABLE', '剧本工坊的视频转剧本暂不可用。'],
    ['a rejected config', {}, path => path === '/factory/jobs' ? new WorkbenchHttpError(400, 'WORKSHOP_HTTP_ERROR', '同时转写部数必须是 1 到 4') : READY, 'WORKSHOP_HTTP_ERROR', '同时转写部数必须是 1 到 4'],
    ['an unknown submission outcome', {}, path => path === '/factory/jobs' ? new TypeError('fetch failed') : READY, 'WORKSHOP_JOB_OUTCOME_UNKNOWN', '先用 status 查看最近的任务'],
    ['a reply without a job', {}, path => path === '/factory/jobs' ? { ok: true } : READY, 'WORKSHOP_JOB_OUTCOME_UNKNOWN', '没有返回任务编号'],
    ['a reply with an invalid job', {}, path => path === '/factory/jobs' ? { job_id: 0 } : READY, 'WORKSHOP_JOB_OUTCOME_UNKNOWN', '没有返回任务编号'],
    ['a non-object reply', {}, path => path === '/factory/jobs' ? null : READY, 'WORKSHOP_JOB_OUTCOME_UNKNOWN', '没有返回任务编号'],
  ])('does not report a started job for %s', async (_name, args, route, code, message) => {
    const { call } = await bench(route)
    const error = failure(await call({ action: 'start', ...args }))
    expect(error).toMatchObject({ code })
    expect(error?.message).toContain(message)
  })

  it('submits nothing without the user’s confirmation', async () => {
    for (const approval of ['denied', null]) {
      const { call, request } = await bench(() => READY, { approval })
      expect(failure(await call({ action: 'start' }))).toMatchObject({ code: 'WORKSHOP_APPROVAL_REQUIRED', message: '本次视频转剧本任务未获确认。' })
      expect(request.mock.calls.map(([path]) => path)).toEqual(['/factory/video-transcribe/status'])
    }
  })

  it('starts and resumes a job that names its dramas without asking where the deployment allows it', async () => {
    let state = 'stopped'
    const { ctx, call, asked } = await bench((path) => {
      if (path === '/factory/jobs') return { job_id: 21 }
      if (path === '/factory/jobs/12') return job(12, state, { config_json: { count: 1, concurrency: 1, quality: '720p', publish: true, only_series: [SERIES] } })
      if (path === '/factory/jobs/13') return job(13, 'stopped', { config_json: { count: 0 } })
      if (path === '/factory/jobs/12/resume') { state = 'running'; return { job_id: 12, resumed: true } }
      return READY
    }, { approval: 'denied', config: { autoStartNamedSeries: true } })
    expect(ctx.tools.get('workshop_video_transcribe')?.description).toContain('用 only_series 指定了剧的任务直接执行，没有指定的提交前请用户确认')
    expect((await call({ action: 'start', count: 1, publish: true, only_series: [SERIES] })).value).toMatchObject({ action: 'start', job_id: 21 })
    expect((await call({ action: 'resume', job_id: 12 })).value).toMatchObject({ action: 'resume', resumed: true })
    expect(asked).not.toHaveBeenCalled()
    expect(failure(await call({ action: 'start' }))).toMatchObject({ code: 'WORKSHOP_APPROVAL_REQUIRED' })
    expect(failure(await call({ action: 'resume', job_id: 13 }))).toMatchObject({ code: 'WORKSHOP_APPROVAL_REQUIRED' })
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('keeps a cancellation as a cancellation', async () => {
    const controller = new AbortController()
    const { ctx } = await bench((path) => {
      if (path === '/factory/jobs') { controller.abort(); return controller.signal.reason }
      return READY
    })
    const result = await executeToolFixture(ctx, {
      name: 'workshop_video_transcribe', arguments: { action: 'start' }, callId: ToolCallId('abort'), signal: controller.signal,
      agent: { session: { id: 'session-1' } } as never,
    })
    expect(failure(result)).toMatchObject({ name: 'AbortError' })
  })

  it('stops a running job and reports its state, and leaves a finished job alone', async () => {
    let state = 'running'
    let stop: unknown = { message: 'Stop signal sent', job_id: 12 }
    const { call, request } = await bench((path) => {
      if (path === '/factory/jobs/12/stop') return stop
      return job(12, state, { result: { delivered: [{ series_id: SERIES }], manual_stop_requested: true } })
    })
    const stopped = await call({ action: 'stop', job_id: 12 })
    expect(stopped.value).toEqual({ action: 'stop', stop_requested: true, job: { id: 12, status: 'running', delivered: 1, attention: 0, rejected: 0, created_at: '2026-11-20T00:05:00' } })
    expect(request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([['/factory/jobs/12', undefined], ['/factory/jobs/12/stop', 'POST'], ['/factory/jobs/12', undefined]])
    expect(stopped.meta).toEqual({ action: 'stop', job_id: 12, status: 'running', stop_requested: true })
    stop = new WorkbenchHttpError(400, 'WORKSHOP_HTTP_ERROR', 'Cannot stop job with status: completed')
    expect((await call({ action: 'stop', job_id: 12 })).value).toMatchObject({ stop_requested: false, job: { status: 'running' } })
    stop = new WorkbenchHttpError(502, 'WORKSHOP_HTTP_ERROR', '剧本工坊请求失败。')
    expect(failure(await call({ action: 'stop', job_id: 12 }))).toMatchObject({ code: 'WORKSHOP_HTTP_ERROR' })
    state = 'completed'
    request.mockClear()
    expect((await call({ action: 'stop', job_id: 12 })).value).toMatchObject({ stop_requested: false, job: { status: 'completed' } })
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/factory/jobs/12'])
    expect(failure(await call({ action: 'stop' }))).toMatchObject({ code: 'INVALID_ARGS' })
    expect(failure(await call({ action: 'stop', job_id: 12 }, false))).toMatchObject({ code: 'WORKSHOP_SESSION_REQUIRED' })
  })

  it('resumes a stopped job with its saved parameters after the user confirms them', async () => {
    let state = 'stopped'
    const saved = { count: 3, concurrency: 2, quality: '1080p', publish: true, only_series: [SERIES] }
    const { call, request, asked } = await bench((path) => {
      if (path === '/factory/jobs/12/resume') { state = 'running'; return { job_id: 12, resumed: true, message: '已续跑视频转剧本任务' } }
      if (path === '/factory/jobs/12') return job(12, state, { config_json: saved, result: { delivered: [{ series_id: SERIES }] } })
      return READY
    })
    const resumed = await call({ action: 'resume', job_id: 12 })
    expect(resumed.value).toEqual({ action: 'resume', resumed: true, job: {
      id: 12, status: 'running', config: saved, delivered: 1, attention: 0, rejected: 0, created_at: '2026-11-20T00:05:00' } })
    expect(asked).toHaveBeenCalledWith([
      '剧本工坊 · 续跑视频转剧本任务 #12', '部数：3 部', '同时转写：2 部（最多 4 部）', '画质：1080p', '通过检查后上架：是', '只转这些剧：' + SERIES,
      '沿用原参数，接着处理已领取的剧并继续领取新剧，会产生下载与转写费用。',
    ].join('\n'))
    expect(request.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ['/factory/jobs/12', undefined], ['/factory/video-transcribe/status', undefined], ['/factory/jobs/12/resume', 'POST'], ['/factory/jobs/12', undefined]])
    expect(resumed.meta).toEqual({ action: 'resume', job_id: 12, status: 'running', resumed: true })
    request.mockClear()
    expect((await call({ action: 'resume', job_id: 12 })).value).toMatchObject({ resumed: false, job: { status: 'running' } })
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/factory/jobs/12'])
    expect(asked).toHaveBeenCalledOnce()
  })

  it('names the card defaults when a resumed job has no saved parameters', async () => {
    const { call, asked } = await bench(path => path === '/factory/jobs/9/resume' ? { job_id: 9, resumed: true }
      : path === '/factory/jobs/9' ? job(9, 'failed') : { ready: true })
    expect((await call({ action: 'resume', job_id: 9 })).value).toMatchObject({ action: 'resume', resumed: true, job: { id: 9 } })
    expect(asked.mock.calls[0]?.[0]).toBe([
      '剧本工坊 · 续跑视频转剧本任务 #9', '部数：持续运行直到停止', '同时转写：1 部', '画质：720p', '通过检查后上架：否', '只转这些剧：按队列顺序',
      '沿用原参数，接着处理已领取的剧并继续领取新剧，会产生下载与转写费用。',
    ].join('\n'))
  })

  it.each<[string, unknown, Record<string, unknown>]>([
    ['the job running again', new WorkbenchHttpError(409, 'WORKSHOP_HTTP_ERROR', '任务正在运行，无需续跑'), { value: { action: 'resume', resumed: false } }],
    ['a server failure', new WorkbenchHttpError(502, 'WORKSHOP_HTTP_ERROR', '剧本工坊请求失败。'), { code: 'WORKSHOP_HTTP_ERROR' }],
    ['a Workshop without 视频转剧本 resume', { message: '没有卡住的大纲', resumed: 0 }, { code: 'WORKSHOP_RESUME_UNSUPPORTED' }],
    ['an answer without the resume flag', { message: '已重启' }, { code: 'WORKSHOP_RESUME_UNSUPPORTED' }],
    ['an empty answer', null, { code: 'WORKSHOP_RESUME_UNSUPPORTED' }],
    ['a text answer', 'ok', { code: 'WORKSHOP_RESUME_UNSUPPORTED' }],
  ])('reports %s after a resume request', async (_name, answer, outcome) => {
    const { call } = await bench(path => path === '/factory/jobs/4/resume' ? answer : path === '/factory/jobs/4' ? job(4, 'stopped') : READY)
    const result = await call({ action: 'resume', job_id: 4 })
    if ('value' in outcome) expect(result.value).toMatchObject(outcome.value as object)
    else expect(failure(result)).toMatchObject(outcome)
  })

  it('resumes nothing without confirmation, readiness or a job ID', async () => {
    const route: Route = path => path === '/factory/jobs/4' ? job(4, 'stopped') : READY
    const denied = await bench(route, { approval: 'denied' })
    expect(failure(await denied.call({ action: 'resume', job_id: 4 }))).toMatchObject({ code: 'WORKSHOP_APPROVAL_REQUIRED', message: '本次续跑未获确认。' })
    expect(denied.request.mock.calls.map(([path]) => path)).not.toContain('/factory/jobs/4/resume')
    const offline = await bench(path => path === '/factory/jobs/4' ? job(4, 'stopped') : { ready: false, error: '数据站暂时无法访问（ConnectError）' })
    expect(failure(await offline.call({ action: 'resume', job_id: 4 }))).toMatchObject({ code: 'WORKSHOP_TRANSCRIBE_UNAVAILABLE', message: '数据站暂时无法访问（ConnectError）' })
    expect(failure(await offline.call({ action: 'resume' }))).toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('titles pending and completed cards from the arguments and the persisted result facts', async () => {
    const { ctx } = await bench(() => READY)
    const definition = ctx.tools.get('workshop_video_transcribe')
    expect(definition?.presentCall?.({ action: 'status' })).toEqual({ card: 'generic', kind: 'read', title: '视频转剧本 · 状态' })
    expect(definition?.presentCall?.({ action: 'status', job_id: 3 })).toEqual({ card: 'generic', kind: 'read', title: '视频转剧本 · 任务 #3' })
    expect(definition?.presentCall?.({ action: 'stop', job_id: 3 })).toEqual({ card: 'generic', kind: 'other', title: '视频转剧本 · 停止任务 #3' })
    expect(definition?.presentCall?.({ action: 'stop' })).toEqual({ card: 'generic', kind: 'other', title: '视频转剧本 · 停止任务' })
    expect(definition?.presentCall?.({ action: 'resume', job_id: 3 })).toEqual({ card: 'generic', kind: 'other', title: '视频转剧本 · 续跑任务 #3' })
    expect(definition?.presentCall?.({ action: 'resume' })).toEqual({ card: 'generic', kind: 'other', title: '视频转剧本 · 续跑任务' })
    expect(definition?.presentCall?.({ action: 'start', count: 2 })).toEqual({ card: 'generic', kind: 'other', title: '视频转剧本 · 开始转写',
      rawInput: { count: 2, concurrency: 1, quality: '720p', publish: false, only_series: [] } })
    const done = (meta: JsonValue | undefined, isError = false): ToolResult => ({
      content: [], isError, ...(meta === undefined ? {} : { meta }),
    })
    const titles = [
      [{ action: 'start', job_id: 41 }, '视频转剧本 · 已开始任务 #41'],
      [{ action: 'start' }, undefined],
      [{ action: 'stop', job_id: 12, stop_requested: true, status: 'running' }, '视频转剧本 · 已请求停止任务 #12'],
      [{ action: 'stop', job_id: 12, stop_requested: false, status: 'completed' }, '视频转剧本 · 任务 #12 已完成'],
      [{ action: 'stop', job_id: 12, stop_requested: false }, '视频转剧本 · 任务 #12'],
      [{ action: 'resume', job_id: 12, resumed: true, status: 'running' }, '视频转剧本 · 已续跑任务 #12'],
      [{ action: 'resume', job_id: 12, resumed: false, status: 'running' }, '视频转剧本 · 任务 #12 运行中'],
      [{ action: 'resume', job_id: 12, resumed: false }, '视频转剧本 · 任务 #12'],
      [{ action: 'resume' }, undefined],
      [{ action: 'status', job_id: 12, status: 'paused', percent: 30 }, '视频转剧本 · 任务 #12 paused 30%'],
      [{ action: 'status', job_id: 12 }, '视频转剧本 · 任务 #12'],
      [{ action: 'status', ready: false }, '视频转剧本 · 暂不可用'],
      [{ action: 'status', ready: true, jobs: 2 }, '视频转剧本 · 已就绪，最近 2 个任务'],
      [{ action: 'status', ready: true }, undefined],
      [{ action: 'retired' }, undefined],
    ] as const
    for (const [meta, title] of titles) {
      expect(present(ctx, done(meta))).toEqual(title === undefined ? undefined : { card: 'generic', title })
    }
    expect(present(ctx, done({ action: 'start', job_id: 41 }, true))).toBeUndefined()
    expect(present(ctx, done('text'))).toBeUndefined()
    expect(present(ctx, done(undefined))).toBeUndefined()
  })
})
