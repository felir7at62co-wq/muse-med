/**
 * Paid video upscaling requests use taskType 20, live model selectors and the
 * provider's source-result identities. Omitted model selectors retain SeedVR2.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

/** The provider's task type for video upscaling, as the workbench submits it. */
export const VIDEO_UPSCALE_TASK_TYPE = 20

/** The SeedVR2 upscaling model the workbench selects by default. */
export const VIDEO_UPSCALE_MODEL = {
  modelId: '2074071626416742401',
  platformId: 'RUNNING_HUB',
  /** The model row's own id in the live catalogue. */
  standardId: 55,
  /** The 1080p video standard that row offers. */
  videoStandardId: 303,
} as const

/** Exact selectors of one live post-processing model and optional output specification. */
export interface PostProcessModel {
  modelId: string
  platformId: string
  standardId: number
  videoStandardId: number | null
}

/** Caller selection for a post-processing catalogue row. */
export interface PostProcessSelection {
  modelId: string
  platformId?: string
  resolution?: string
}

/**
 * Resolve an explicit model against its task-specific live catalogue.
 * @param catalogue - Rows from taskType 10 or 20.
 * @param selection - Exact model, optional platform and output resolution.
 * @returns Unique provider selectors; erasure models without standards return null for that selector.
 * @throws {JubianError} CONTRACT_CHANGED for missing, ambiguous or malformed model/specification rows.
 */
export function resolvePostProcessModel(catalogue: unknown, selection: PostProcessSelection): PostProcessModel {
  if (!Array.isArray(catalogue)) invalid()
  const objects = catalogue.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row))
  const matches = objects.filter(row => row.modelId === selection.modelId
    && (selection.platformId === undefined || row.platformId === selection.platformId))
  const [row] = matches
  if (matches.length !== 1 || row === undefined || typeof row.platformId !== 'string' || !row.platformId.trim()) {
    throw new JubianError('CONTRACT_CHANGED', 'Select one live model and platform from the task-specific catalogue')
  }
  const rawStandards = row.videoStandards
  if (!Array.isArray(rawStandards)) invalid()
  const standards = rawStandards.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item))
    .filter(item => selection.resolution === undefined
      || (typeof item.resolution === 'string' && item.resolution.toLowerCase() === selection.resolution.toLowerCase()))
  const [standard] = standards
  if ((rawStandards.length > 0 && standards.length !== 1)
    || (rawStandards.length === 0 && selection.resolution !== undefined)) {
    throw new JubianError('CONTRACT_CHANGED', 'Select one supported output resolution from the live model standards')
  }
  if (standard?.modelId !== undefined && standard.modelId !== selection.modelId) invalid()
  return { modelId: selection.modelId, platformId: row.platformId,
    standardId: positive(row.id ?? row.standardId), videoStandardId: standard === undefined ? null : positive(standard.id) }
}

/** One upscale submission as a caller states it. */
export interface VideoUpscaleInput {
  scriptId: number
  episodeId: number
  episodeCount: number
  /** The result identity the provider recorded for the source video. */
  firstResultId: number
  parentResultId: number
  /** The source duration in whole seconds, as the provider recorded it. */
  duration: number
  /**
   * The source video URL exactly as the provider reported it.
   *
   * The workbench submitted a rewritten mirror host here, while the payload
   * carries the object-storage host. The provider's own value is used verbatim
   * because fabricating one risks a mismatch the provider cannot resolve.
   */
  videoUrl: string
  taskName: string
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

/**
 * Build the exact upscale request body.
 * @param input - Source identity, duration, URL and a task name.
 * @param model - Live selectors; omitted legacy calls retain the SeedVR2 configuration.
 * @returns The wire body for one upscaling submission.
 */
export function buildVideoUpscaleRequest(input: VideoUpscaleInput,
  model: PostProcessModel = VIDEO_UPSCALE_MODEL): Record<string, unknown> {
  const videoUrl = input.videoUrl
  if (typeof videoUrl !== 'string' || !videoUrl.startsWith('https://')) invalid()
  if (typeof input.taskName !== 'string' || !input.taskName.trim() || !input.taskName.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(input.taskName)) invalid()
  const duration = input.duration
  if (!Number.isFinite(duration) || duration <= 0) invalid()
  return { scriptId: positive(input.scriptId),
    episodeId: positive(input.episodeId),
    episodeCount: positive(input.episodeCount),
    firstResultId: positive(input.firstResultId),
    parentResultId: positive(input.parentResultId),
    duration,
    taskName: input.taskName,
    taskType: VIDEO_UPSCALE_TASK_TYPE,
    modelId: model.modelId,
    platformId: model.platformId,
    standardId: positive(model.standardId),
    videoStandardId: positive(model.videoStandardId),
    videoUrl }
}

/**
 * Read the identity of a submitted upscale task out of a response envelope.
 * @param value - The parsed response envelope.
 * @returns The task id as a string, or null when the provider did not return one.
 */
export function readUpscaleTaskId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  const data = envelope.data
  // The provider may answer with the identity as `data` itself, or nest it.
  const candidates: unknown[] = [envelope.id, envelope.taskId, data]
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>
    candidates.push(nested.id, nested.taskId, nested.aigcVideoTaskId)
  }
  for (const candidate of candidates) {
    const number = typeof candidate === 'string' && /^[1-9][0-9]*$/.test(candidate)
      ? Number(candidate) : candidate
    if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) return String(number)
  }
  return null
}
