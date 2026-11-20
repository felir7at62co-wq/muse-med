/** Bounded projections of Script Workshop's 视频转剧本 readiness and factory job responses. @module */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** JSON object fields returned to the model. */
export type Fields = { [key: string]: JsonValue }

/** Factory job type of the 视频转剧本 step. */
export const JOB_TYPE = 'video_transcribe'
/** Series entries kept per list in one job report; the totals stay complete. */
export const SERIES_LIMIT = 20

const SERIES_ID = /^[1-9][0-9]{14,24}$/u

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit = 200): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, limit) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function pick(source: Record<string, unknown>, fields: Readonly<Record<string, 'text' | 'count' | 'flag'>>): Fields {
  const out: Fields = {}
  for (const [key, kind] of Object.entries(fields)) {
    const value = kind === 'text' ? text(source[key]) : kind === 'count' ? count(source[key]) : typeof source[key] === 'boolean' ? source[key] : undefined
    if (value !== undefined) out[key] = value
  }
  return out
}

function counts(value: Record<string, unknown>): Fields {
  const out: Fields = {}
  for (const [key, item] of Object.entries(value)) {
    const number = count(item)
    if (number !== undefined) out[key] = number
  }
  return out
}

function entries(value: unknown, fields: Readonly<Record<string, 'text' | 'count' | 'flag'>>): Fields[] {
  return Array.isArray(value) ? value.filter(isFields).map(item => pick(item, fields)) : []
}

/**
 * Read the readiness of the deployment's 视频转剧本 step.
 * @param value - Response of `GET /factory/video-transcribe/status`.
 * @returns Readiness, the operator's error, the station queue counts and the slot limit.
 */
export function service(value: unknown): Fields {
  if (!isFields(value) || typeof value.ready !== 'boolean') {
    throw new HarnessError('剧本工坊返回了无法识别的视频转剧本状态。', 'WORKSHOP_INVALID_RESULT')
  }
  const slots = count(value.maxSlots)
  const error = text(value.error, 500)
  return {
    ready: value.ready,
    ...(error === undefined ? {} : { error }),
    ...(isFields(value.queue) ? { queue: counts(value.queue) } : {}),
    ...(slots === undefined ? {} : { max_slots: slots }),
  }
}

/**
 * Whether one entry of the factory job list belongs to the 视频转剧本 step.
 * @param value - Untrusted list entry.
 * @returns True for an object whose `job_type` is the step's.
 */
export function isTranscribeEntry(value: unknown): boolean {
  return isFields(value) && value.job_type === JOB_TYPE
}

/** A factory job of the 视频转剧本 step. */
export interface TranscribeJob {
  readonly id: number
  readonly status: string
  /** Remaining response fields, read defensively. */
  readonly fields: Record<string, unknown>
}

/**
 * Validate a factory job and confirm it belongs to the 视频转剧本 step.
 * @param value - One job of `GET /factory/jobs` or `GET /factory/jobs/{id}`.
 * @param id - Requested job, when one was named.
 * @returns The job.
 */
export function transcribeJob(value: unknown, id?: number): TranscribeJob {
  const malformed = () => new HarnessError('剧本工坊返回了无法识别的任务。', 'WORKSHOP_INVALID_RESULT')
  if (!isFields(value)) throw malformed()
  const jobId = count(value.id)
  if (jobId === undefined || typeof value.job_type !== 'string' || typeof value.status !== 'string') throw malformed()
  if (id !== undefined && jobId !== id) throw new HarnessError('剧本工坊返回了另一个任务。', 'WORKSHOP_INVALID_RESULT')
  if (value.job_type !== JOB_TYPE) throw new HarnessError('任务 #' + String(jobId) + ' 不是视频转剧本任务。', 'WORKSHOP_NOT_TRANSCRIBE_JOB')
  return { id: jobId, status: value.status, fields: value }
}

/**
 * Whether the job is taking or may still take series from the queue.
 * @param job - Validated job.
 * @returns True while the job is pending or running.
 */
export function isActive(job: TranscribeJob): boolean {
  return job.status === 'pending' || job.status === 'running'
}

function settings(value: unknown): Fields | undefined {
  if (!isFields(value)) return undefined
  const series = Array.isArray(value.only_series) ? value.only_series.filter((item): item is string => typeof item === 'string' && SERIES_ID.test(item)) : []
  return {
    ...pick(value, { count: 'count', concurrency: 'count', quality: 'text', publish: 'flag' }),
    only_series: series,
  }
}

/**
 * Summarize a 视频转剧本 job without its per-series lists.
 * @param job - Validated job.
 * @returns ID, state, progress line, the parameters when the response carries them, and the delivered, attention and rejected totals.
 */
export function summary(job: TranscribeJob): Fields {
  const { fields } = job
  const progress = isFields(fields.progress) ? fields.progress : {}
  const result = isFields(fields.result) ? fields.result : {}
  const total = (key: string) => Array.isArray(result[key]) ? result[key].length : 0
  const percent = count(progress.percent)
  const message = text(progress.status_message, 500)
  const error = text(fields.error, 500)
  const config = settings(fields.config_json)
  return {
    id: job.id,
    status: job.status,
    ...(percent === undefined ? {} : { percent }),
    ...(message === undefined ? {} : { message }),
    ...(config === undefined ? {} : { config }),
    delivered: total('delivered'),
    attention: total('attention'),
    rejected: total('rejected'),
    ...(error === undefined ? {} : { error }),
    ...pick(fields, { created_at: 'text', finished_at: 'text' }),
  }
}

/**
 * Report one 视频转剧本 job with its transcription slots and the latest series of each outcome.
 * @param job - Validated job from `GET /factory/jobs/{id}`.
 * @returns The summary, the slot states and up to `SERIES_LIMIT` newest entries per outcome list.
 */
export function detail(job: TranscribeJob): Fields {
  const progress = isFields(job.fields.progress) ? job.fields.progress : {}
  const result = isFields(job.fields.result) ? job.fields.result : {}
  const latest = (key: string, fields: Readonly<Record<string, 'text' | 'count' | 'flag'>>) => entries(result[key], fields).slice(-SERIES_LIMIT)
  return {
    ...summary(job),
    slots: entries(progress.slots, { slot: 'count', state: 'text', series_id: 'text', title: 'text', episode: 'count', total: 'count', message: 'text' }),
    ...(isFields(progress.queue) ? { queue: counts(progress.queue) } : {}),
    delivered_series: latest('delivered', { series_id: 'text', title: 'text', episodes: 'count', published: 'flag' }),
    attention_series: latest('attention', { series_id: 'text', title: 'text', state: 'text', reason: 'text' }),
    rejected_series: latest('rejected', { series_id: 'text', title: 'text', reason: 'text' }),
  }
}
