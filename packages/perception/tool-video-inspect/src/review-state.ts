/** Durable per-video observation progress, independent of conversation compaction. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Host-issued identity for one source revision's observation task. */
export type VideoReviewId = Branded<'VideoReviewId'>
/** Brand a validated observation identity.
 * @param value - Observation identity admitted by its owning parser or generator.
 * @returns The same identity with its compile-time brand.
 */
export const VideoReviewId = brandString<VideoReviewId>
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { reviewEventSchema, type ReviewEvent } from './review-events.ts'
import type { ReviewTranscriptReference } from './review-speech.ts'

const imageSchema = z.object({ attachmentId: z.string(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number(), width: z.number(), height: z.number(), name: z.string().optional() })
/** Persisted frame, encoded image reference and optional grounded observation. */
export const reviewFrameSchema = z.object({ id: z.string(), time: z.number(), reasons: z.array(z.string()),
  decode: z.object({ start_seconds: z.number().nonnegative(), frame_index: z.number().int().nonnegative() }).optional(),
  image: imageSchema.optional(), decoded_time: z.number().optional(), exposed: z.boolean().default(false),
  observation: z.object({ visible: z.string().min(8), change: z.string().min(2), uncertainty: z.string() }).optional() })
const reviewSchema = z.object({ id: z.string().transform(VideoReviewId), episode: z.string(), path: z.string(), source_version: z.string(),
  duration: z.number(), scanned_until: z.number(), scan_complete: z.boolean(), frames: z.array(reviewFrameSchema),
  event_groups: z.array(reviewEventSchema).optional(),
  transcript_reference: z.object({ path: z.string(), version: z.string(), sha256: z.string() }).optional() })

/** One detected frame and its actual image-input and observation progress. */
export type ReviewFrame = z.infer<typeof reviewFrameSchema>
/** One episode's video revision; a new scan never inherits another source revision's completion. */
export type VideoReview = z.infer<typeof reviewSchema>
/** Latest review for each source path in this Session. */
export type VideoReviews = Record<string, VideoReview>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Start a source revision or incrementally commit scan, image and observation progress. */
    'video/review': {
      kind: 'start'
      review: VideoReview
    } | {
      kind: 'update'
      path: string
      id: VideoReviewId
      frames: ReviewFrame[]
      frame_count: number
      scanned_until: number
      scan_complete: boolean
      event_groups?: ReviewEvent[]
      transcript_reference?: ReviewTranscriptReference
    }
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { videoReviews: VideoReviews }
}

/**
 * Register resume-safe, Host-only observation progress.
 * @param ctx - Session projection registry.
 */
export function installReviewState(ctx: Context): void {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Video observation requires sessionProjections')
  projections.register<'videoReviews', VideoReviews>({ key: 'videoReviews',
    stateSchema: z.record(z.string(), reviewSchema), init: () => ({}), stateVersion: 1,
    apply: (state, event) => {
      if (event.type !== 'video/review') return state
      if (event.data.kind === 'start') return { ...state, [event.data.review.path]: event.data.review }
      const update = event.data, old = state[update.path]
      if (old === undefined || old.id !== update.id) throw Error('Video review update has no matching source revision')
      const replacements = new Map(update.frames.map(frame => [frame.id, frame]))
      const frames = Array.from({ length: update.frame_count }, (_, index) => {
        const id = `F${String(index + 1).padStart(5, '0')}`
        const frame = replacements.get(id) ?? old.frames[index]
        if (frame === undefined || frame.id !== id) throw Error('Video review update is missing a frame')
        return frame
      })
      return { ...state, [update.path]: { ...old, frames, scanned_until: update.scanned_until, scan_complete: update.scan_complete,
        ...update.event_groups === undefined ? {} : { event_groups: update.event_groups },
        ...update.transcript_reference === undefined ? {} : { transcript_reference: update.transcript_reference } } }
    },
  })
}

/**
 * Read the current projected observation tasks without historical log reads.
 * @param ctx - Projection registry.
 * @param session - Initiating Session.
 * @returns Latest review by canonical source path.
 */
export function reviewsOf(ctx: Context, session: Session): VideoReviews {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Video observation requires sessionProjections')
  return projections.stateOf(session, 'videoReviews') ?? {}
}

/**
 * Commit changed frames and scan progress before returning them to the model.
 * @param ctx - Projection registry supplying the previous state.
 * @param session - Owning Session.
 * @param review - New per-video state.
 */
export function saveReview(ctx: Context, session: Session, review: VideoReview): void {
  const old = reviewsOf(ctx, session)[review.path]
  if (old === undefined || old.id !== review.id) { session.append('video/review', { kind: 'start', review }); return }
  const frames = review.frames.filter((frame, index) => JSON.stringify(old.frames[index]) !== JSON.stringify(frame))
  if (!frames.length && old.frames.length === review.frames.length && old.scanned_until === review.scanned_until
    && old.scan_complete === review.scan_complete && JSON.stringify(old.event_groups) === JSON.stringify(review.event_groups)
    && JSON.stringify(old.transcript_reference) === JSON.stringify(review.transcript_reference)) return
  session.append('video/review', { kind: 'update', path: review.path, id: review.id, frames,
    frame_count: review.frames.length, scanned_until: review.scanned_until, scan_complete: review.scan_complete,
    ...review.event_groups === undefined ? {} : { event_groups: review.event_groups },
    ...review.transcript_reference === undefined ? {} : { transcript_reference: review.transcript_reference } })
}

/**
 * Restore the attachment brand at the tool-rendering interface.
 * @param frame - Frame whose encoded image has been extracted.
 * @returns Image attachment, or undefined before extraction.
 */
export function reviewImage(frame: ReviewFrame): ImageAttachmentRef | undefined {
  if (frame.image === undefined) return undefined
  const { name, ...image } = frame.image
  return { ...image, attachmentId: AttachmentId(image.attachmentId), ...name === undefined ? {} : { name } }
}

/**
 * Describe incomplete extraction or observations for one video.
 * @param review - Current episode state.
 * @returns Pending count, including a still-running scan.
 */
export function pendingReview(review: VideoReview): number {
  return review.frames.filter(frame => frame.observation === undefined).length + (review.scan_complete ? 0 : 1)
}

/**
 * Distinguish recorded uncertainty from conventional empty markers without changing the saved note.
 * @param value - Original model-authored uncertainty text.
 * @returns Whether the note contains a concern requiring adjacent context, rather than an exact empty marker.
 */
export function hasReviewUncertainty(value: string): boolean {
  const text = value.trim()
  return text.length > 0 && !/^(?:无|无疑点|none|n\s*\/\s*a)\s*[。.!！,，;；:：]?\s*$/iu.test(text)
}
