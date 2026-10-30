/** Read-only access to current video evidence for tools and logged manuscript context. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { reviewsOf, reviewImage, type VideoReview, type VideoReviewId } from './review-state.ts'
import type { ReviewTranscriptReference } from './review-speech.ts'
import { buildVideoSourceTimeline, type VideoSourceTimeline, type VideoTimelineSelection } from './review-timeline.ts'
import { resolveReviewTranscript, type VideoTranscriptCandidates } from './review-transcript.ts'

/** Current logged video identity and its explicitly associated saved ASR, without reading source files. */
export interface VideoReviewSummary {
  review_id: VideoReviewId
  episode: string
  path: string
  source_version: string
  /** Follow-up activity is separate from source coverage; missing persisted status is active. */
  follow_up: NonNullable<VideoReview['follow_up']>
  transcript_reference?: ReviewTranscriptReference
}

/** Caller-resolved bounds for one source read; frame selection never changes observation progress. */
export interface VideoSourceTimelineReadOptions extends VideoTimelineSelection {
  /** Maximum complete saved ASR bytes admitted to the parser. */
  maxTranscriptBytes: number
  /** Maximum serialized result bytes, including metadata and all content-block references. */
  maxBytes: number
  /** Maximum explicitly requested cached images; omitted frameIds returns text only. */
  maxFrames: number
  /** Actual selected frame identities; each must lie inside the requested interval. */
  frameIds?: readonly string[]
  /** Host-verified current-task successful JSON reads; one same-directory ASR may be returned as an unverified candidate. */
  transcriptCandidates?: VideoTranscriptCandidates
}

/** One version-checked source timeline and model-ready text and optional original image blocks. */
export interface VideoSourceTimelineContent {
  timeline: VideoSourceTimeline
  content: ContentBlock[]
}

/**
 * List current logged video revisions without choosing a draft or inferring ASR association.
 * @param ctx - Host projection registry.
 * @param session - Owning Session.
 * @returns All current review identities, including closed follow-ups, and saved ASR references; no filesystem freshness claim.
 */
export function videoReviewSummaries(ctx: Context, session: Session): VideoReviewSummary[] {
  return Object.values(reviewsOf(ctx, session)).map(review => ({ review_id: review.id, episode: review.episode,
    path: review.path, source_version: review.source_version, follow_up: review.follow_up ?? { status: 'active' },
    ...review.transcript_reference === undefined ? {} : { transcript_reference: review.transcript_reference } }))
}

/**
 * Read current source evidence and optionally re-present its cached frames without extraction or progress changes.
 * @param ctx - Same-world filesystem, attachments, sandbox policy and review projections.
 * @param session - Owning Session; returned blocks must enter the normal logged context or tool-result path.
 * @param reviewId - Current logged source revision identity.
 * @param options - Explicit range and complete-result budgets; requested images must already be recorded.
 * @param signal - Cancellation for source, ASR and attachment reads.
 * @returns Model-ready source evidence; stale optional ASR is reported, while changed video or missing cache rejects the read.
 */
export async function readVideoSourceTimeline(ctx: Context, session: Session, reviewId: VideoReviewId,
  options: VideoSourceTimelineReadOptions, signal: AbortSignal): Promise<VideoSourceTimelineContent> {
  signal.throwIfAborted()
  const review = Object.values(reviewsOf(ctx, session)).find(value => value.id === reviewId)
  if (review === undefined) throw Error('VIDEO_TIMELINE_REVIEW: 当前会话不存在这个视频版本；未选择其他视频。')
  const policy = ctx.sandboxPolicy.resolve({ session })
  const source = await ctx.fs.resolve(review.path, { cwd: policy.workspaceRoot, signal })
  if ((await ctx.fs.stat(source, signal))?.version !== review.source_version) {
    throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频版本已变，本次未返回旧版时间线。')
  }
  const resolved = await resolveReviewTranscript(ctx, review, source, options, policy.workspaceRoot, signal)
  let timeline = buildVideoSourceTimeline(review, options, resolved.link.speech, resolved.link.speech_unavailable, resolved.resolution)
  const frameIds = options.frameIds ?? []
  if (frameIds.length > options.maxFrames || new Set(frameIds).size !== frameIds.length) {
    throw Error('VIDEO_TIMELINE_IMAGES: 缓存原图数量超限或frame_id重复；本次未截断选择。')
  }
  const selectedIds = new Set(timeline.windows.flatMap(window => window.frames.map(frame => frame.frame_id)))
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ video_source_timeline: timeline }) }]
  for (const id of frameIds) {
    const frame = review.frames.find(value => value.id === id)
    if (!selectedIds.has(id) || frame?.observation === undefined) {
      throw Error(`VIDEO_TIMELINE_FRAME: ${id}不属于当前范围的已记录帧。`)
    }
    const image = reviewImage(frame)
    if (image === undefined) throw Error(`VIDEO_REVISIT_IMAGE_MISSING: ${id}没有缓存原图引用；不重新抽帧。`)
    try { await ctx.attachments.readImage(image, signal) } catch (error) {
      signal.throwIfAborted()
      throw Error(`VIDEO_REVISIT_IMAGE_MISSING: ${id}缓存原图不可读取；不重新抽帧。`
        + (error instanceof Error ? error.message : String(error)))
    }
    content.push({ type: 'text', text: `VIDEO_FRAME ${review.id}/${frame.id} ${review.episode} ${frame.time}s附近：重看缓存原图；原观察保留，供核对。` },
      { type: 'image', attachment: image })
  }
  let changedSpeech: string | undefined
  if (resolved.stillCurrent !== undefined) {
    try {
      if (!await resolved.stillCurrent()) changedSpeech = 'VIDEO_TRANSCRIPT_CHANGED: ASR在读取缓存图片期间变化。'
    } catch (error) {
      signal.throwIfAborted()
      changedSpeech = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    }
  }
  if (resolved.reference !== undefined && changedSpeech !== undefined) {
    const resolution = resolved.resolution?.kind === 'successful_read_candidate' ? { ...resolved.resolution,
      kind: 'unavailable' as const, diagnostics: resolved.resolution.diagnostics.map(diagnostic =>
        diagnostic.status === 'valid' ? { ...diagnostic, status: 'unavailable' as const, reason: changedSpeech } : diagnostic) }
      : resolved.resolution
    timeline = buildVideoSourceTimeline(review, options, undefined, { reference: resolved.reference,
      reason: changedSpeech, notice: '本次仅返回画面材料，未使用变化后的ASR或提交新转写。' }, resolution)
    content[0] = { type: 'text', text: JSON.stringify({ video_source_timeline: timeline }) }
  }
  const result = { timeline, content }
  if (Buffer.byteLength(JSON.stringify(result)) > options.maxBytes) {
    throw Error('VIDEO_TIMELINE_SIZE: 完整时间线与图片引用超出本次返回上限；未返回截断材料，不影响写稿或交付。')
  }
  if ((await ctx.fs.stat(source, signal))?.version !== review.source_version
    || Object.values(reviewsOf(ctx, session)).find(value => value.id === reviewId) !== review) {
    throw Error('VIDEO_REVIEW_SOURCE_CHANGED: 视频或观察在读取期间变化，请回读当前时间线。')
  }
  return result
}
