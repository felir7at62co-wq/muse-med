/**
 * The model-facing Script Workshop tools, as the signed-in Muse user: `workshop_video_transcribe` reports, starts, stops
 * and resumes the 视频转剧本 factory job with the parameters of the Workshop pipeline card; `script_finalize` uploads a
 * finished script to the finalized-script library after the user agreed; `script_library` reads a library script into
 * the workspace and records the Jingliu project a picked script became.
 * @module @deepseek-ai/dsh-tool-workshop
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, ToolArgsError, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { WorkbenchHttpError, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { detail, isActive, isTranscribeEntry, JOB_TYPE, service, summary, transcribeJob, type Fields, type TranscribeJob } from './jobs.ts'
import { applyFinalize } from './finalize.ts'
import { applyLibrary } from './library.ts'

export { checkEpisodes, finalizeTool, KINDS, LIMITS, RIGHTS, splitEpisodes, STYLES } from './finalize.ts'
export type { FinalizeArgs, FinalizeDependencies, FinalizeReport, ReadFile, UploadEpisode } from './finalize.ts'
export { episodeFiles, LIBRARY_ACTIONS, LIBRARY_FOLDER, libraryTool } from './library.ts'
export type { EpisodeFiles, LibraryArgs, LibraryDependencies, LibraryReport, WriteFile } from './library.ts'

/** Cordis plugin name. */
export const name = 'tool-workshop'
/** The tool registers once the Host also provides `workshopConnection`. */
export const inject = ['tools']

/** Deployment choice for unattended transcription. */
export interface Config {
  /**
   * Start or resume a job that names its dramas (`only_series`) without asking, for a deployment where Bots run
   * transcription unattended within the Workshop's slot limit. A job without named dramas still asks.
   */
  readonly autoStartNamedSeries: boolean
}

/** Validated plugin configuration; asking before every start is the default. */
export const Config: Schema<Config> = Schema.object({
  autoStartNamedSeries: Schema.boolean().default(false),
})

/** How `workshop_video_transcribe` confirms paid actions. */
export interface TranscribeOptions {
  /** See {@link Config.autoStartNamedSeries}. */
  readonly autoStartNamedSeries: boolean
}

/** Actions of `workshop_video_transcribe`. */
export const ACTIONS = ['status', 'start', 'stop', 'resume'] as const
/** Download qualities the Workshop accepts. */
export const QUALITIES = ['720p', '1080p'] as const
/** Most recent factory jobs scanned when `status` names no job. */
export const RECENT_JOBS = 50
/** 视频转剧本 jobs listed by `status` without a job ID. */
export const LISTED_JOBS = 10

const SERIES_ID = /^[1-9][0-9]{14,24}$/u

/** Canonical value of one call: the action and its report fields. */
export type Report = { action: typeof ACTIONS[number] } & Fields

/** The Agent whose conversation called the tool. */
type CallingAgent = NonNullable<ToolRunContext['agent']>

/** Authenticated Workshop access and one-time human confirmation. */
export interface Dependencies {
  connect(): Promise<WorkbenchSession>
  approve(agent: CallingAgent, exec: ToolRunContext, reason: string): Promise<boolean>
}

/** Arguments after schema validation. */
export interface Args {
  action: typeof ACTIONS[number]
  job_id?: number
  count?: number
  concurrency?: number
  quality?: typeof QUALITIES[number]
  publish?: boolean
  only_series?: string[]
}

/** The job parameters sent to the Workshop, with the pipeline card's defaults applied. */
export type StartSpec = {
  count: number
  concurrency: number
  quality: typeof QUALITIES[number]
  publish: boolean
  only_series: string[]
}

/**
 * Apply the pipeline card's defaults: 0 series (run until stopped), 1 at a time, 720p, not published, queue order.
 * @param args - `start` arguments.
 * @returns The parameters of the new job, not yet range-checked.
 */
export function startSpec(args: Args): StartSpec {
  return {
    count: args.count ?? 0,
    concurrency: args.concurrency ?? 1,
    quality: args.quality ?? '720p',
    publish: args.publish ?? false,
    only_series: [...new Set(args.only_series ?? [])],
  }
}

/**
 * Check the ranges the parameter schema cannot express.
 * @param spec - Parameters of the new job.
 * @returns The same parameters.
 */
export function checkStart(spec: StartSpec): StartSpec {
  const violations = [
    ...(spec.count < 0 ? ['count 必须不小于 0，0 表示持续运行'] : []),
    ...(spec.concurrency < 1 ? ['concurrency 必须不小于 1'] : []),
    ...(spec.only_series.some(id => !SERIES_ID.test(id)) ? ['only_series 只能是红果作品编号（15 到 25 位数字）'] : []),
  ]
  if (violations.length > 0) throw new ToolArgsError(violations)
  return spec
}

function jobId(args: Args): number {
  if (args.job_id === undefined) throw new ToolArgsError([args.action + ' 需要 job_id'])
  if (args.job_id < 1) throw new ToolArgsError(['job_id 必须是正整数'])
  return args.job_id
}

/**
 * Read the parameters a job was started with, filling the pipeline card's defaults for missing fields.
 * @param config - `config` of a job summary.
 * @returns The parameters a resumed job keeps.
 */
function savedSpec(config: JsonValue | undefined): StartSpec {
  const saved = isMeta(config) ? config : {}
  const quality = QUALITIES.find(item => item === saved.quality)
  return startSpec({
    action: 'start',
    ...(typeof saved.count === 'number' ? { count: saved.count } : {}),
    ...(typeof saved.concurrency === 'number' ? { concurrency: saved.concurrency } : {}),
    ...(quality ? { quality } : {}),
    ...(typeof saved.publish === 'boolean' ? { publish: saved.publish } : {}),
    ...(Array.isArray(saved.only_series) ? { only_series: saved.only_series.filter((id): id is string => typeof id === 'string') } : {}),
  })
}

function describe(title: string, spec: StartSpec, maxSlots: JsonValue | undefined, effect: string): string {
  return [
    title,
    '部数：' + (spec.count === 0 ? '持续运行直到停止' : String(spec.count) + ' 部'),
    '同时转写：' + String(spec.concurrency) + ' 部' + (typeof maxSlots === 'number' ? '（最多 ' + String(maxSlots) + ' 部）' : ''),
    '画质：' + spec.quality,
    '通过检查后上架：' + (spec.publish ? '是' : '否'),
    '只转这些剧：' + (spec.only_series.length > 0 ? spec.only_series.join('、') : '按队列顺序'),
    effect,
  ].join('\n')
}

async function readJob(session: WorkbenchSession, id: number, signal: AbortSignal): Promise<TranscribeJob> {
  try {
    return transcribeJob(await session.request('/factory/jobs/' + String(id), { signal }), id)
  } catch (error) {
    if (error instanceof WorkbenchHttpError && error.status === 404) {
      throw new HarnessError('剧本工坊里没有当前账号的任务 #' + String(id) + '。', 'WORKSHOP_JOB_NOT_FOUND', { cause: error })
    }
    throw error
  }
}

async function readService(session: WorkbenchSession, signal: AbortSignal): Promise<Fields> {
  return service(await session.request('/factory/video-transcribe/status', { signal }))
}

async function recentJobs(session: WorkbenchSession, signal: AbortSignal): Promise<Fields[]> {
  const listed = await session.request('/factory/jobs?limit=' + String(RECENT_JOBS), { signal })
  if (!Array.isArray(listed)) throw new HarnessError('剧本工坊返回了无法识别的任务列表。', 'WORKSHOP_INVALID_RESULT')
  const items: unknown[] = listed
  return items.filter(isTranscribeEntry).slice(0, LISTED_JOBS).map(job => summary(transcribeJob(job)))
}

async function readyService(session: WorkbenchSession, signal: AbortSignal): Promise<Fields> {
  const readiness = await readService(session, signal)
  if (readiness.ready !== true) {
    throw new HarnessError(typeof readiness.error === 'string' ? readiness.error : '剧本工坊的视频转剧本暂不可用。', 'WORKSHOP_TRANSCRIBE_UNAVAILABLE')
  }
  return readiness
}

/** Whether a paid action proceeds without asking: only a job that names its dramas, and only where the deployment allows it. */
function unattended(options: TranscribeOptions, spec: StartSpec): boolean {
  return options.autoStartNamedSeries && spec.only_series.length > 0
}

async function start(
  deps: Dependencies, options: TranscribeOptions, session: WorkbenchSession, spec: StartSpec, agent: CallingAgent, exec: ToolRunContext,
): Promise<Report> {
  const readiness = await readyService(session, exec.signal)
  if (typeof readiness.max_slots === 'number' && spec.concurrency > readiness.max_slots) {
    throw new ToolArgsError(['concurrency 必须是 1 到 ' + String(readiness.max_slots)])
  }
  const reason = describe('剧本工坊 · 视频转剧本', spec, readiness.max_slots, '领取数据站队列中的剧，下载红果全集并逐集转写，会产生下载与转写费用。')
  if (!unattended(options, spec) && !await deps.approve(agent, exec, reason)) {
    throw new HarnessError('本次视频转剧本任务未获确认。', 'WORKSHOP_APPROVAL_REQUIRED')
  }
  exec.signal.throwIfAborted()
  let created: unknown
  try {
    created = await session.request('/factory/jobs', { method: 'POST', body: { job_type: JOB_TYPE, config: spec }, signal: exec.signal })
  } catch (error) {
    if (error instanceof HarnessError || exec.signal.aborted) throw error
    throw new HarnessError('剧本工坊没有确认任务是否已创建。先用 status 查看最近的任务，确认没有新任务后再重试。', 'WORKSHOP_JOB_OUTCOME_UNKNOWN', { cause: error })
  }
  const id = typeof created === 'object' && created !== null && 'job_id' in created ? created.job_id : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new HarnessError('剧本工坊没有返回任务编号。先用 status 查看最近的任务，确认没有新任务后再重试。', 'WORKSHOP_JOB_OUTCOME_UNKNOWN')
  }
  return { action: 'start', job_id: id, config: spec }
}

async function stop(session: WorkbenchSession, id: number, signal: AbortSignal): Promise<Report> {
  const before = await readJob(session, id, signal)
  if (!isActive(before)) return { action: 'stop', stop_requested: false, job: summary(before) }
  try {
    await session.request('/factory/jobs/' + String(id) + '/stop', { method: 'POST', signal })
  } catch (error) {
    // The Workshop answers 400 when the job finished after it was read; report its final state.
    if (!(error instanceof WorkbenchHttpError && error.status === 400)) throw error
    return { action: 'stop', stop_requested: false, job: summary(await readJob(session, id, signal)) }
  }
  return { action: 'stop', stop_requested: true, job: summary(await readJob(session, id, signal)) }
}

async function resume(
  deps: Dependencies, options: TranscribeOptions, session: WorkbenchSession, id: number, agent: CallingAgent, exec: ToolRunContext,
): Promise<Report> {
  const before = await readJob(session, id, exec.signal)
  if (isActive(before)) return { action: 'resume', resumed: false, job: summary(before) }
  const readiness = await readyService(session, exec.signal)
  const saved = savedSpec(summary(before).config)
  const reason = describe('剧本工坊 · 续跑视频转剧本任务 #' + String(id), saved, readiness.max_slots,
    '沿用原参数，接着处理已领取的剧并继续领取新剧，会产生下载与转写费用。')
  if (!unattended(options, saved) && !await deps.approve(agent, exec, reason)) throw new HarnessError('本次续跑未获确认。', 'WORKSHOP_APPROVAL_REQUIRED')
  exec.signal.throwIfAborted()
  let answer: unknown
  try {
    answer = await session.request('/factory/jobs/' + String(id) + '/resume', { method: 'POST', signal: exec.signal })
  } catch (error) {
    // The Workshop answers 409 when the job is running again; report its current state.
    if (!(error instanceof WorkbenchHttpError && error.status === 409)) throw error
    return { action: 'resume', resumed: false, job: summary(await readJob(session, id, exec.signal)) }
  }
  if (typeof answer !== 'object' || answer === null || !('resumed' in answer) || answer.resumed !== true) {
    throw new HarnessError('这个剧本工坊版本还不能续跑视频转剧本任务，请先更新工坊。', 'WORKSHOP_RESUME_UNSUPPORTED')
  }
  return { action: 'resume', resumed: true, job: summary(await readJob(session, id, exec.signal)) }
}

const CALL_TITLES: Readonly<Record<Exclude<typeof ACTIONS[number], 'start'>, string>> = {
  status: '视频转剧本 · 任务', stop: '视频转剧本 · 停止任务', resume: '视频转剧本 · 续跑任务',
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '等待开始', running: '运行中', stopped: '已停止', completed: '已完成', failed: '失败',
}

function isMeta(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resultTitle(meta: { [key: string]: JsonValue }): string | undefined {
  const job = typeof meta.job_id === 'number' ? '任务 #' + String(meta.job_id) : undefined
  const state = typeof meta.status === 'string' ? STATUS_LABELS[meta.status] ?? meta.status : undefined
  switch (meta.action) {
    case 'start': return job && '视频转剧本 · 已开始' + job
    case 'stop': return job && (meta.stop_requested === true ? '视频转剧本 · 已请求停止' + job : '视频转剧本 · ' + job + (state ? ' ' + state : ''))
    case 'resume': return job && (meta.resumed === true ? '视频转剧本 · 已续跑' + job : '视频转剧本 · ' + job + (state ? ' ' + state : ''))
    case 'status':
      if (job) return '视频转剧本 · ' + job + (state ? ' ' + state : '') + (typeof meta.percent === 'number' ? ' ' + String(meta.percent) + '%' : '')
      if (meta.ready === false) return '视频转剧本 · 暂不可用'
      return typeof meta.jobs === 'number' ? '视频转剧本 · 已就绪，最近 ' + String(meta.jobs) + ' 个任务' : undefined
    default: return undefined
  }
}

/**
 * Report, start, stop and resume the 视频转剧本 factory job.
 * @param deps - Workshop connection and the confirmation channel.
 * @param options - Whether jobs that name their dramas proceed without asking.
 * @returns The tool definition; Workshop credentials never appear in its arguments or results.
 */
export function transcribeTool(deps: Dependencies, options: TranscribeOptions = { autoStartNamedSeries: false }): ToolDefinition {
  return defineTool({
    name: 'workshop_video_transcribe',
    description: '剧本工坊的视频转剧本任务：从数据站爆款队列领剧，经 AI 观众选材、红果整剧下载和云端 Muse 逐集转写，出稿存为工坊剧本。'
      + 'status 查看是否就绪、队列和任务进度；start 按参数开始一个任务，resume 沿用原参数续跑已停止的任务，两者都会产生下载与转写费用，'
      + (options.autoStartNamedSeries ? '用 only_series 指定了剧的任务直接执行，没有指定的提交前请用户确认；' : '提交前请用户确认；')
      + 'stop 停止任务，已领取的剧保留进度。',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true },
      job_id: { type: 'integer', description: 'status：查看这个任务的进度和出稿，省略时列出最近的任务。stop 和 resume：必填。' },
      count: { type: 'integer', description: 'start：转写部数，0 表示持续运行直到停止，默认 0。' },
      concurrency: { type: 'integer', description: 'start：同时转写部数，1 到 status 返回的 max_slots，默认 1。' },
      quality: { type: 'string', enum: QUALITIES, description: 'start：下载画质，默认 720p。' },
      publish: { type: 'boolean', description: 'start：通过检查的剧本上架到数据站储备看板，默认 false。' },
      only_series: { type: 'array', items: { type: 'string' }, description: 'start：只转这些红果作品编号，省略时按队列顺序领取。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { action: { type: 'string', enum: ACTIONS, required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => {
        const job = isMeta(value.job) ? value.job : {}
        const id = value.job_id ?? job.id
        return {
          action: value.action,
          ...(typeof id === 'number' ? { job_id: id } : {}),
          ...(typeof job.status === 'string' ? { status: job.status } : {}),
          ...(typeof job.percent === 'number' ? { percent: job.percent } : {}),
          ...(typeof value.stop_requested === 'boolean' ? { stop_requested: value.stop_requested } : {}),
          ...(typeof value.resumed === 'boolean' ? { resumed: value.resumed } : {}),
          ...(isMeta(value.service) && typeof value.service.ready === 'boolean' ? { ready: value.service.ready } : {}),
          ...(Array.isArray(value.jobs) ? { jobs: value.jobs.length } : {}),
        }
      },
    },
    isConcurrencySafe: args => args.action === 'status',
    async execute(args, exec): Promise<Report> {
      const agent = exec.agent
      if (!agent) throw new HarnessError('请在 Muse 会话中使用剧本工坊。', 'WORKSHOP_SESSION_REQUIRED')
      const session = await deps.connect()
      switch (args.action) {
        case 'status': {
          const readiness = await readService(session, exec.signal)
          if (args.job_id !== undefined) return { action: 'status', service: readiness, job: detail(await readJob(session, jobId(args), exec.signal)) }
          return { action: 'status', service: readiness, jobs: await recentJobs(session, exec.signal) }
        }
        case 'start': return await start(deps, options, session, checkStart(startSpec(args)), agent, exec)
        case 'stop': return await stop(session, jobId(args), exec.signal)
        case 'resume': return await resume(deps, options, session, jobId(args), agent, exec)
        /* v8 ignore next -- the tool schema admits only the handled actions */
        default: return assertNever(args.action)
      }
    },
    presentCall: args => ({
      card: 'generic',
      kind: args.action === 'status' ? 'read' : 'other',
      title: args.action === 'start' ? '视频转剧本 · 开始转写'
        : args.action === 'status' && args.job_id === undefined ? '视频转剧本 · 状态'
          : CALL_TITLES[args.action] + (args.job_id === undefined ? '' : ' #' + String(args.job_id)),
      ...(args.action === 'start' ? { rawInput: startSpec(args) } : {}),
    }),
    presentResult: (_args, result) => {
      if (result.isError || !isMeta(result.meta)) return undefined
      const title = resultTitle(result.meta)
      return title === undefined ? undefined : { card: 'generic', title }
    },
  })
}

/**
 * Register `workshop_video_transcribe` while the Host provides the Script Workshop connection, and `script_finalize` and
 * `script_library` while it also provides workspace files.
 * @param ctx - Agent or Host context with the tool registry.
 * @param config - Whether jobs that name their dramas start without asking.
 */
export function apply(ctx: Context, config?: Config): void {
  applyFinalize(ctx)
  applyLibrary(ctx)
  ctx.inject(['workshopConnection'], (scope) => {
    const tool = transcribeTool({
      connect: () => scope.workshopConnection.connection(),
      approve: async (agent, exec, reason) => {
        const approval = scope.get('approval')
        return !!approval && await approval.request({ agent, callId: exec.callId, toolName: exec.name, reason, signal: exec.signal }) === 'allowed-once'
      },
    }, { autoStartNamedSeries: config?.autoStartNamedSeries === true })
    scope.effect(() => scope.tools.register(tool))
  })
}
