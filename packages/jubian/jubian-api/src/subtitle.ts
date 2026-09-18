/**
 * Subtitle erasure: the paid regional or automatic removal request.
 *
 * The regional route needs the pixel box the provider itself reports on the
 * child task, which is why the caller reads the source snapshot first rather
 * than trusting a hand-written rectangle.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'
import type { SubtitleBox } from './video.ts'

export type { SubtitleBox }

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}

/** The two erasure models the provider exposes, with their live catalogue identity. */
export const SUBTITLE_ERASE_MODELS = ['quzimuToB', 'ark-erase-video-subtitle-pro'] as const
/** The model id that selects the automatic route. */
export const AUTOMATIC_ERASE_MODEL = 'ark-erase-video-subtitle-pro'

/**
 * The default erasure region, as exact fractions of the frame.
 *
 * The workbench's dialog opens on a default rectangle and the frontend scales it
 * from the preview canvas into video coordinates before submitting; that scaling
 * is not reproducible from the two observed numbers, so this plugin never asks a
 * caller to draw the box. It derives one from the source frame instead.
 *
 * The fractions are the two real submissions against one 720x1280 video, kept as
 * exact ratios so no rounding is applied twice: `zimuTop 570`, `zimuHeight 720`
 * (the box reaches the bottom edge), and `zimuWidth 719` (one pixel inside the
 * frame). A caller with a genuinely different caption position can still pass
 * explicit coordinates.
 */
export const DEFAULT_SUBTITLE_REGION = {
  /** Left edge as a fraction of frame width. */
  left: 0,
  /** Top edge as a fraction of frame height: 570 / 1280. */
  top: 570 / 1280,
  /** Width as a fraction of frame width: 719 / 720. */
  width: 719 / 720,
  /** Height as a fraction of frame height: 720 / 1280. */
  height: 720 / 1280,
} as const

/** The provider's erasure standard, as the workbench submits it. */
export const SUBTITLE_ERASE_STANDARDS: Record<typeof SUBTITLE_ERASE_MODELS[number], number> = {
  quzimuToB: 26,
  'ark-erase-video-subtitle-pro': 67,
}

/**
 * Derive the erasure rectangle for one source video.
 *
 * A caller states the frame size it read from the provider; the plugin applies
 * the provider's own default proportions. Passing explicit coordinates is still
 * possible for a caption that genuinely sits elsewhere.
 * @param videoWidth - Decoded frame width.
 * @param videoHeight - Decoded frame height.
 * @returns Integer pixel coordinates inside the frame.
 */
export function defaultSubtitleBox(videoWidth: number, videoHeight: number): SubtitleBox {
  if (!Number.isSafeInteger(videoWidth) || videoWidth < 1
    || !Number.isSafeInteger(videoHeight) || videoHeight < 1) invalid()
  const box = { zimuLeft: Math.round(DEFAULT_SUBTITLE_REGION.left * videoWidth),
    zimuTop: Math.round(DEFAULT_SUBTITLE_REGION.top * videoHeight),
    zimuWidth: Math.round(DEFAULT_SUBTITLE_REGION.width * videoWidth),
    zimuHeight: Math.round(DEFAULT_SUBTITLE_REGION.height * videoHeight) }
  // Deliberately NOT clamped to the frame: the captured workbench request sent
  // `zimuTop 570` + `zimuHeight 720` against a 1280-tall video — ten pixels past
  // the bottom edge — and the provider accepted it. Reproducing the measured
  // arithmetic matters more than a tidier rectangle.
  if (box.zimuWidth < 1 || box.zimuHeight < 1) invalid()
  return box
}

/** One erasure source as the caller states it. */
export interface SubtitleEraseInput {
  scriptId: number
  episodeId: number
  episodeCount: number
  taskName: string
  firstResultId: number
  parentResultId: number
  videoUrl: string
  duration: number
  videoWidth: number
  videoHeight: number
  /**
   * Explicit pixel rectangle; omitted uses {@link defaultSubtitleBox} from the
   * frame size. Rejected for the automatic route, which takes no rectangle.
   */
  subtitleBox?: SubtitleBox
}

/**
 * Build the exact `/aigc/storyboard/subtitleEraser` body.
 *
 * The shape is the workbench's own captured request. Both standard identifiers
 * are pinned per model because they were observed in that request — `26` for the
 * regional eraser against a `taskType=10` catalogue whose row id is also 26 —
 * so no catalogue read is needed before submitting.
 * @param modelId - Explicit model selection; there is no fallback route.
 * @param input - Source identities, frame size and an optional explicit rectangle.
 * @returns The wire body for one erasure task.
 */
export function buildSubtitleEraseRequest(modelId: string,
  input: SubtitleEraseInput): Record<string, unknown> {
  if (modelId !== 'quzimuToB' && modelId !== AUTOMATIC_ERASE_MODEL) invalid()
  const automatic = modelId === AUTOMATIC_ERASE_MODEL
  const standardId = SUBTITLE_ERASE_STANDARDS[modelId]
  const platformId = automatic ? 'AI_MEDIA_KIT' : 'YU_DIAN'
  const width = positive(input.videoWidth), height = positive(input.videoHeight)
  if (!Number.isFinite(input.duration) || input.duration <= 0) invalid()
  if (typeof input.taskName !== 'string' || !input.taskName.trim() || !input.taskName.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(input.taskName)) invalid()
  let url: URL
  try { url = new URL(input.videoUrl) } catch { return invalid() }
  if (!input.videoUrl.startsWith('https://') || /[\s\\]/.test(input.videoUrl) || input.videoUrl.includes('#')
    || url.protocol !== 'https:' || url.username || url.password) invalid()
  const payload: Record<string, unknown> = { scriptId: positive(input.scriptId),
    episodeId: positive(input.episodeId), episodeCount: positive(input.episodeCount),
    firstResultId: positive(input.firstResultId), parentResultId: positive(input.parentResultId),
    taskName: input.taskName, taskType: 10, videoUrl: input.videoUrl,
    standardId, platformId, modelId, videoStandardId: null, duration: input.duration }
  if (automatic) {
    if (input.subtitleBox !== undefined) invalid()
    return payload
  }
  const box = input.subtitleBox ?? defaultSubtitleBox(width, height)
  if (!Number.isSafeInteger(box.zimuLeft) || box.zimuLeft < 0
    || !Number.isSafeInteger(box.zimuTop) || box.zimuTop < 0
    || !Number.isSafeInteger(box.zimuWidth) || box.zimuWidth < 1
    || !Number.isSafeInteger(box.zimuHeight) || box.zimuHeight < 1
    || box.zimuLeft >= width || box.zimuTop >= height) invalid()
  return { ...payload, zimuLeft: box.zimuLeft, zimuTop: box.zimuTop, zimuWidth: box.zimuWidth,
    zimuHeight: box.zimuHeight, videoWidth: width, videoHeight: height }
}

/**
 * Read the erasure task identity out of a response envelope.
 * @param value - The parsed response envelope.
 * @returns The task id as a string, or null when the identity fields disagree or are absent.
 */
export function readSubtitleTaskId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (envelope.code !== 0 && envelope.code !== 200) return null
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return null
  const data = envelope.data as Record<string, unknown>
  const raw = [data.taskId, data.jobId].filter(id => id !== undefined && id !== null)
  if (!raw.length) return null
  const normalized = raw.map((id) => {
    const candidate = typeof id === 'string' && /^[1-9][0-9]*$/.test(id) ? Number(id) : id
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
      ? String(candidate) : null
  })
  const first = normalized[0]
  return first && normalized.every(other => other === first) ? first : null
}
