/**
 * Video upscaling: the paid stage that turns a sub-1080p generation into a
 * 1080p deliverable.
 *
 * This exists because the generation models top out below the delivery target.
 * `doubao-seedance-2-5-260628` offers only 480p and 720p, so a request for 2.5
 * at 480p means every shot still has to come through here before it can be used.
 *
 * The shape below is captured from the real workbench request, not inferred:
 * `taskType` 20, the SeedVR2 model, its two standard identifiers, and the result
 * identities of the source video. `taskType` 2 is NOT this stage — the one
 * result carrying it was a failed image operation.
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
 * @returns The wire body for one upscaling submission.
 */
export function buildVideoUpscaleRequest(input: VideoUpscaleInput): Record<string, unknown> {
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
    modelId: VIDEO_UPSCALE_MODEL.modelId,
    platformId: VIDEO_UPSCALE_MODEL.platformId,
    standardId: VIDEO_UPSCALE_MODEL.standardId,
    videoStandardId: VIDEO_UPSCALE_MODEL.videoStandardId,
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
