/** Process-local, read-only observation of one accepted Jubian operation. */
import { setTimeout as delay } from 'node:timers/promises'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readTaskPage, readSubtaskPage, terminalOutcome, VIDEO_TASK_TYPES } from '@deepseek-ai/dsh-jubian-api'
import type { VideoSubtask } from '@deepseek-ai/dsh-jubian-api'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { jubian: 'jubian' }
}

/** The accepted operation ID, never its source task ID. */
export interface WatchArgs {
  task_id: number
  stage: 'generate' | 'upscale' | 'erase_subtitle'
}

/** Validated process-local polling budgets, in milliseconds. */
export interface WatchConfig {
  watchPollIntervalMs: number
  watchTimeoutMs: number
}

/**
 * Resolve and validate polling budgets at plugin mount.
 * @param config - Optional deployment budgets.
 * @returns Bounded polling and total timeout values.
 */
export function resolveWatchConfig(config: Partial<WatchConfig>): WatchConfig {
  const resolved = { watchPollIntervalMs: config.watchPollIntervalMs ?? 15000,
    watchTimeoutMs: config.watchTimeoutMs ?? 1800000 }
  for (const [key, maximum] of [['watchPollIntervalMs', 60000], ['watchTimeoutMs', 86400000]] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1 || resolved[key] > maximum) {
      throw new TypeError(`${key} must be an integer within 1..${maximum}`)
    }
  }
  return resolved
}

/**
 * Validate model-authored operation identity before job admission.
 * @param args - Tool input.
 * @returns The validated operation identity.
 */
export function watchArgs(args: WatchArgs): WatchArgs {
  if (!Number.isSafeInteger(args.task_id) || args.task_id < 1
    || !['generate', 'upscale', 'erase_subtitle'].includes(args.stage)) {
    throw new TypeError('jubian_watch requires a positive safe-integer operation task_id and generate, upscale, or erase_subtitle stage')
  }
  return args
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function currentOutput(row: VideoSubtask, raw: unknown, stage: WatchArgs['stage']): boolean {
  if (!row.video_url || (row.last_task_type !== null && row.last_stage !== stage)) return false
  if (stage === 'generate' && row.last_task_type === null && row.video_url === row.base_video_url) return true
  const results = record(raw)?.resultList
  const current = Array.isArray(results) ? record(results[0]) : undefined
  if (row.last_stage === stage && current?.lastResultStatus !== undefined) {
    return terminalOutcome(String(current.lastResultStatus)) === 'succeeded'
      && current.lastTosVideoUrl === row.video_url
  }
  return Array.isArray(results) && results.some((value) => {
    const version = record(value)
    return version !== undefined && typeof version.taskType === 'number'
      && VIDEO_TASK_TYPES[version.taskType] === stage
      && (version.tosVideoUrl ?? version.originalVideoUrl) === row.video_url
      && typeof version.resultStatus === 'string' && terminalOutcome(version.resultStatus) === 'succeeded'
  })
}

async function observe(client: JubianClient, args: WatchArgs, signal: AbortSignal): Promise<JobOutcome | undefined> {
  const response = await client.request({ method: 'GET', path: `/admin/aigc/video/task/${args.task_id}`, signal })
  const task = readTaskPage(response.data)
  if (task.task_id !== args.task_id || task.task_type === null || VIDEO_TASK_TYPES[task.task_type] !== args.stage) return
  const status = terminalOutcome(task.status ?? '')
  if (status === 'failed') return { status: 'failed', detail: `provider operation ${task.status}` }
  if (status !== 'succeeded') return
  const rows: VideoSubtask[] = []
  const seen = new Set<number>()
  let total: number | undefined
  for (let pageNum = 1; ; pageNum++) {
    signal.throwIfAborted()
    const response = await client.request({ method: 'POST',
      path: `/admin/aigc/video/task/sub/list?pageNum=${pageNum}&pageSize=1000`,
      body: { aigcVideoTaskId: args.task_id }, signal })
    const raw = record(response.data)
    if (!Number.isSafeInteger(raw?.total) || (raw!.total as number) < 1) return
    const page = readSubtaskPage(response.data)
    if (total !== undefined && page.total !== total) return
    total = page.total
    if (!page.rows.length || rows.length + page.rows.length > total) return
    for (const [index, row] of page.rows.entries()) {
      if (row.parent_task_id !== args.task_id || seen.has(row.subtask_id)) return
      seen.add(row.subtask_id)
      if (terminalOutcome(row.status ?? '') === 'failed') {
        return { status: 'failed', detail: `provider child ${row.subtask_id} ${row.status}` }
      }
      if (terminalOutcome(row.status ?? '') !== 'succeeded'
        || !currentOutput(row, (raw!.rows as unknown[])[index], args.stage)) return
      rows.push(row)
    }
    if (rows.length === total) break
  }
  return { status: 'completed', detail: `${args.stage} operation verified; review required`, output: JSON.stringify({
    ...args, status: 'succeeded', outputs: rows.map(row => ({ subtask_id: row.subtask_id,
      video_url: row.video_url, first_result_id: row.first_result_id, parent_result_id: row.parent_result_id,
      resolution: row.resolution })),
    next: 'Review every output with frame/audio inspection and verify delivery resolution. Provider completion is not visual QA; subtitle removal still needs visual review. Do not repeat paid operations automatically.',
  }, null, 2) }
}

/**
 * Start abortable polling; the caller must admit this work through jobs.start.
 * @param client - Existing credential-aware read transport.
 * @param args - Validated accepted operation identity.
 * @param config - Resolved polling budgets.
 * @returns Synchronous idempotent cancellation and settlement after timer/request cleanup.
 */
export function watchJob(client: JubianClient, args: WatchArgs, config: WatchConfig): JobHooks {
  const controller = new AbortController()
  const timeout = new Error('timeout: operation completion unverified')
  const timer = setTimeout(() => controller.abort(timeout), config.watchTimeoutMs)
  const done = (async (): Promise<JobOutcome> => {
    try {
      for (;;) {
        controller.signal.throwIfAborted()
        try {
          const outcome = await observe(client, args, controller.signal)
          controller.signal.throwIfAborted()
          if (outcome) return outcome
        } catch (error) {
          controller.signal.throwIfAborted()
          // Missing provider identity is unverified, never successful completion.
          if (!(error instanceof JubianError) || error.code !== 'CONTRACT_CHANGED') throw error
        }
        await delay(config.watchPollIntervalMs, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (controller.signal.aborted) return controller.signal.reason === timeout
        ? { status: 'failed', detail: timeout.message }
        : { status: 'killed', detail: 'watch cancelled; provider operation unchanged' }
      return { status: 'failed', detail: error instanceof JubianError ? error.code : 'watch read failed' }
    } finally { clearTimeout(timer) }
  })()
  return { cancel: () => { controller.abort() }, done }
}
