/**
 * Video task reads: the remote generation identity a caller polls.
 *
 * Cost fields are carried through as observed strings. They are never a settled
 * charge: only a definitive provider receipt can settle billing, so these fields
 * are evidence for a human, not authorization for a program.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  const record = object(value)
  if (!Array.isArray(record.rows)) invalid()
  return record.rows.map(object)
}

function totalOf(value: unknown, fallback: number): number {
  const record = object(value)
  return typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : fallback
}

function id(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function nullableId(value: unknown): number | null {
  if (value === undefined || value === null) return null
  try { return id(value) } catch { return null }
}

function cost(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(value) ? value : null
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** One video generation task as this plugin exposes it. */
export interface VideoTask {
  task_id: number
  task_type: number | null
  status: string | null
  first_result_id: number | null
  parent_result_id: number | null
  real_cost: string | null
  estimated_cost: string | null
  discount_cost: string | null
  /** Episode the package belongs to; the upscale request needs it. */
  episode_id: number | null
  /** How many episodes the package covers; the upscale request needs it. */
  episode_count: number | null
  /** The provider's own name for the task, useful as an upscale task-name prefix. */
  task_name: string | null
}

/** The subtitle pixel geometry a regional erasure needs. */
export interface SubtitleBox { zimuLeft: number; zimuTop: number; zimuWidth: number; zimuHeight: number }

/**
 * The provider's own stage labels for one finished video.
 *
 * Verified against a real project after the operator ran one upscale: the
 * upscaled result carried `lastTaskType: 20` and `hdCount: 1`, a new sibling
 * subtask carried the SeedVR2 model with `resolution: 1080p`, and the original
 * subtask kept its old `tosVideoUrl` while `lastTosVideoUrl` pointed at the new
 * 1080p file. `2` is NOT an upscale — the one result carrying it was a
 * `gpt-image-2` image operation that failed.
 */
export const VIDEO_TASK_TYPES: Record<number, string> = {
  1: 'generate',
  10: 'erase_subtitle',
  20: 'upscale',
}

/** One entry of the provider's per-result history. */
export interface VideoVersionRecord {
  /** Provider task type that produced this entry. */
  task_type: number | null
  /** Stable name for {@link task_type}, or null when the provider adds a type. */
  stage: string | null
  result_id: number | null
  model_id: string | null
  status: string | null
  /** The file for this stage, on the origin the download allowlist accepts. */
  video_url: string | null
}

/**
 * The resolution ladder this provider uses, lowest first.
 *
 * A generation model can top out below the delivery target — seedance2.5 offers
 * only 480p and 720p — which is why "is this usable as-is" is a comparison and
 * not a constant.
 */
export const RESOLUTION_ORDER = ['480p', '720p', '768p', '1080p', '2K', '4K'] as const

/**
 * Rank one resolution label.
 * @param value - A provider resolution label such as `480p` or `1080p`.
 * @returns Its index in {@link RESOLUTION_ORDER}, or -1 when unrecognised.
 */
export function resolutionRank(value: string | null): number {
  if (value === null) return -1
  return RESOLUTION_ORDER.findIndex(entry => entry.toLowerCase() === value.trim().toLowerCase())
}

/**
 * Whether one result must be upscaled before it can be used at the target.
 *
 * A result at or above the target is usable as generated. A result below it is
 * not, and the caller must run the upscale stage first — a lower-resolution file
 * cannot be promoted by renaming or re-encoding it locally.
 * @param row - One read subtask.
 * @param deliveryTarget - The resolution the caller intends to deliver, e.g. `1080p`.
 * @returns `true` when the source is below the target, `false` when it is not, and
 *   `null` when either label is unrecognised so a caller never reads a guess as a verdict.
 */
export function needsUpscale(row: Pick<VideoSubtask, 'resolution' | 'upscaled'>,
  deliveryTarget: string): boolean | null {
  const source = resolutionRank(row.resolution)
  const target = resolutionRank(deliveryTarget)
  if (source < 0 || target < 0) return null
  return source < target
}

/** One child generation result. */
export interface VideoSubtask {
  subtask_id: number
  parent_task_id: number | null
  status: string | null
  duration_seconds: number | null
  gen_num: number | null
  subtitle_box: SubtitleBox | null
  /**
   * The video the provider currently holds for this result: its newest file.
   *
   * After an upscale this differs from {@link base_video_url}: the provider keeps
   * the original file in `tosVideoUrl` and puts the upscaled file in
   * `lastTosVideoUrl`. **This is the URL a caller should use**, and both sit on
   * the origin the download allowlist accepts.
   */
  video_url: string | null
  /** The original generation file, still held after an upscale. */
  base_video_url: string | null
  /** The input reference images the package bound, in order. */
  image_urls: string[]
  /** The generation model this result came from. */
  model_id: string | null
  /** The provider's standard this result was generated against. */
  standard_id: number | null
  /** The resolution the provider recorded for this result, e.g. `480p`, `720p`, `1080p`. */
  resolution: string | null
  /** Source identities a subtitle erasure must submit verbatim. */
  first_result_id: number | null
  parent_result_id: number | null
  /**
   * The stage that produced the current file, as the provider records it.
   *
   * `1` generation, `2` upscale, `10` subtitle erasure; null when the provider
   * does not say. This is how a caller tells a raw generation from a processed
   * one without opening the file.
   */
  last_task_type: number | null
  /** Stable name for {@link last_task_type}. */
  last_stage: string | null
  /**
   * How many upscale passes the provider has recorded for this result.
   *
   * Zero means no upscale has been recorded, which is the signal that a video
   * below the delivery resolution still has to be upscaled before it is used.
   */
  hd_count: number | null
  /** When the provider stops accepting further work on this result. */
  expiration_time: string | null
  /** Every stage the provider holds for this result, in provider order. */
  versions: VideoVersionRecord[]
  /** Whether a subtitle erasure has been recorded as the latest stage. */
  subtitle_erased: boolean
  /** Whether an upscale pass has been recorded. */
  upscaled: boolean
}

/** Read the longest-lived file URL the provider offers for one result entry. */
function resultVideoUrl(entry: Record<string, unknown>): string | null {
  // `lastTosVideoUrl` is the newest file; `tosVideoUrl` is the generation output
  // and stays behind once an upscale has run.
  return nullableText(entry.lastTosVideoUrl ?? entry.tosVideoUrl ?? entry.originalVideoUrl)
}

/** Read one entry of the provider's per-result stage history. */
function versionRecord(entry: Record<string, unknown>): VideoVersionRecord {
  const taskType = typeof entry.taskType === 'number' ? entry.taskType : null
  return { task_type: taskType, stage: taskType === null ? null : VIDEO_TASK_TYPES[taskType] ?? null,
    result_id: nullableId(entry.firstResultId ?? entry.lastResultId),
    model_id: nullableText(entry.modelId ?? entry.lastModelId),
    status: nullableText(entry.resultStatus ?? entry.lastResultStatus),
    video_url: resultVideoUrl(entry) }
}

function task(row: Record<string, unknown>): VideoTask {
  return { task_id: id(row.id ?? row.taskId),
    task_type: typeof row.taskType === 'number' ? row.taskType : null,
    status: nullableText(row.taskStatus), first_result_id: nullableId(row.firstResultId),
    parent_result_id: nullableId(row.parentResultId), real_cost: cost(row.realCost),
    estimated_cost: cost(row.estimatedCost), discount_cost: cost(row.discountCost),
    episode_id: nullableId(row.episodeId),
    episode_count: nullableId(row.episodeCount),
    task_name: nullableText(row.taskName) }
}

function box(row: Record<string, unknown>): SubtitleBox | null {
  const fields = ['zimuLeft', 'zimuTop', 'zimuWidth', 'zimuHeight'] as const
  if (fields.some(field => typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]))) return null
  return { zimuLeft: row.zimuLeft as number, zimuTop: row.zimuTop as number,
    zimuWidth: row.zimuWidth as number, zimuHeight: row.zimuHeight as number }
}

/**
 * Read one video generation task.
 * @param data - Envelope `data` from `/admin/aigc/video/task/{taskId}`.
 */
export function readTaskPage(data: unknown): VideoTask {
  return task(object(data))
}

/**
 * Read one page of generation tasks for a project.
 * @param data - Envelope `data` from `/admin/aigc/video/task/list`.
 */
export function readTaskList(data: unknown): { total: number; rows: VideoTask[] } {
  const rows = rowsOf(data)
  return { total: totalOf(data, rows.length), rows: rows.map(task) }
}

/**
 * Read one page of child results, keeping the finished-video URL and the
 * geometry a regional erasure needs.
 * @param data - Envelope `data` from `/admin/aigc/video/task/sub/list`.
 */
export function readSubtaskPage(data: unknown): { total: number; rows: VideoSubtask[] } {
  const rows = rowsOf(data)
  return { total: totalOf(data, rows.length), rows: rows.map((row) => {
    const materials = Array.isArray(row.videoMaterials) ? row.videoMaterials : []
    const first = materials.length ? object(materials[0]) : undefined
    const results = Array.isArray(row.resultList) ? row.resultList : []
    const result = results.length ? object(results[0]) : undefined
    const images = Array.isArray(row.imageMaterials) ? row.imageMaterials : []
    const entries = results.map(object).map(versionRecord)
    // Both shapes in one payload: the product's older nested material carries
    // `videoUrl`, while the live payload puts the finished file on `resultList`.
    const fromMaterial = first === undefined ? null : nullableText(first.videoUrl)
    const base = result === undefined ? null
      : nullableText(result.tosVideoUrl ?? result.originalVideoUrl)
    const current = result === undefined ? null : resultVideoUrl(result)
    const lastTaskType = result === undefined || typeof result.lastTaskType !== 'number'
      ? null : result.lastTaskType
    const hdCount = result !== undefined && typeof result.hdCount === 'number' ? result.hdCount : null
    return { subtask_id: id(row.id ?? row.subTaskId),
      parent_task_id: nullableId(row.aigcVideoTaskId), status: nullableText(row.taskStatus),
      duration_seconds: typeof row.duration === 'number' && Number.isFinite(row.duration) ? row.duration : null,
      gen_num: typeof row.genNum === 'number' ? row.genNum : null, subtitle_box: box(row),
      video_url: current ?? fromMaterial,
      base_video_url: base,
      image_urls: images.map((entry) => {
        const material = object(entry)
        const url = nullableText(material.imageUrl ?? material.materialUrl)
        return url
      }).filter((url): url is string => url !== null),
      model_id: nullableText(row.modelId),
      standard_id: nullableId(row.standardId),
      resolution: nullableText(row.resolution),
      first_result_id: nullableId(row.firstResultId ?? result?.firstResultId),
      parent_result_id: nullableId(row.parentResultId),
      last_task_type: lastTaskType,
      last_stage: lastTaskType === null ? null : VIDEO_TASK_TYPES[lastTaskType] ?? null,
      hd_count: hdCount,
      expiration_time: nullableText(row.videoExpirationTime ?? result?.expirationTime),
      versions: entries,
      subtitle_erased: lastTaskType === 10
        || entries.some(entry => entry.task_type === 10 && entry.status === 'succeeded'),
      // An upscale is recorded by its count and its stage, and it is visible as a
      // newer file than the generation output. The count alone is the provider's
      // own statement, so it is the primary signal.
      upscaled: (hdCount !== null && hdCount > 0)
        || lastTaskType === 20
        || (base !== null && current !== null && base !== current) }
  }) }
}
