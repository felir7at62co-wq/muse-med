/** Read-only binding of video observations and OCR to real current-Session tool evidence. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { hasReviewUncertainty, pendingReview, reviewEvidenceJson, reviewsOf } from './review-state.ts'
import { sourceQaStateOf } from './source-qa-state.ts'

/** Exact video and observation files already hashed by a Host consumer. */
export interface VideoObservationEvidenceBinding {
  /** Current video, in the same Host filesystem. */
  readonly mediaPath: string
  /** SHA-256 independently checked by the caller against the current media bytes. */
  readonly mediaSha256: string
  /** Actual video_inspect observation_report path. */
  readonly inspectionPath: string
  /** Expected complete observation artifact SHA-256. */
  readonly inspectionSha256: string
  /** Owning current Session identity; another Session cannot lend approval. */
  readonly sessionId: string
  /** Current durable review identity. */
  readonly reviewId: string
}

/** Exact files already hashed by a formal source-adoption caller, including OCR. */
export interface VideoSourceQaEvidenceBinding extends VideoObservationEvidenceBinding {
  /** Complete actual video_ocr evidence file. */
  readonly ocrPath: string
  /** Expected complete OCR artifact SHA-256. */
  readonly ocrSha256: string
}

function hash(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }

/** Verify complete current-Session video observations without requiring OCR.
 * @param ctx - Same-world filesystem, policy and projection services.
 * @param session - Actual tool initiator, including a restored instance of the same Session.
 * @param binding - Exact media and report identities; the caller independently checks the media SHA-256.
 * @param signal - Cancels bounded reads; no extraction, OCR, or paid operation is started.
 * @returns Only after complete exposed observations, report bytes and successful tool issuance agree.
 * @throws Error for another Session, stale media, incomplete or uncertain observations, or unissued reports.
 */
export async function verifyVideoObservationEvidence(ctx: Context, session: Session | undefined,
  binding: VideoObservationEvidenceBinding, signal: AbortSignal): Promise<void> {
  await verifyVideoEvidence(ctx, session, binding, signal)
}

/** Verify actual OCR issuance and the current complete durable review without acquiring new evidence.
 * @param ctx - Same-world filesystem, policy and projection services.
 * @param session - Actual tool initiator; restored copies of this same Session retain its durable evidence.
 * @param binding - Exact artifacts chosen by the caller, never an approval receipt supplied by a model.
 * @param signal - Cancels bounded reads; no OCR, frame extraction or paid operation is started.
 * @returns Only after current source versions, artifact bytes and successful tool origins agree.
 * @throws Error for another Session, unbound old OCR, edited reports, incomplete or uncertain reviews.
 */
export async function verifyVideoSourceQaEvidence(ctx: Context, session: Session | undefined,
  binding: VideoSourceQaEvidenceBinding, signal: AbortSignal): Promise<void> {
  await verifyVideoEvidence(ctx, session, binding, signal, binding)
}

/** Share observation checks while preserving the stricter source-adoption OCR requirement. */
async function verifyVideoEvidence(ctx: Context, session: Session | undefined,
  binding: VideoObservationEvidenceBinding, signal: AbortSignal,
  ocrBinding?: Pick<VideoSourceQaEvidenceBinding, 'ocrPath' | 'ocrSha256'>): Promise<void> {
  if (session === undefined || binding.sessionId !== session.id) throw Error(ocrBinding === undefined
    ? 'SOURCE_QA_SESSION: 需当前会话实际完整审看记录，不能借用其他会话认可。'
    : 'SOURCE_QA_SESSION: 需当前会话实际OCR和完整审看记录，不能借用其他会话认可。')
  signal.throwIfAborted()
  const policy = ctx.sandboxPolicy.resolve({ session })
  const source = await ctx.fs.resolve(binding.mediaPath, { cwd: policy.workspaceRoot, signal })
  const reviewTool = ctx.tools.get('video_source_review') === undefined ? 'video_inspect' : 'video_source_review'
  const sameTarget = async (file: string, target: FsTarget): Promise<boolean> => {
    try { return (await ctx.fs.resolve(file, { cwd: policy.workspaceRoot, signal })).targetKey === target.targetKey }
    catch { signal.throwIfAborted(); return false }
  }
  let review: ReturnType<typeof reviewsOf>[string] | undefined
  for (const candidate of Object.values(reviewsOf(ctx, session))) {
    if (candidate.id === binding.reviewId && await sameTarget(candidate.path, source)) { review = candidate; break }
  }
  if (review === undefined || review.id !== binding.reviewId || pendingReview(review) !== 0 || review.frames.length === 0
    || review.scanned_until < review.duration || review.frames.some(frame => !frame.exposed || frame.image === undefined
      || frame.observation === undefined || hasReviewUncertainty(frame.observation.uncertainty))) {
    throw Error(`SOURCE_QA_REVIEW: 当前视频仍需${reviewTool}完整scan、next实际看图及observe；缺口可通过scan.timestamps_seconds免费补看。`)
  }
  const captured = JSON.stringify(review)
  if ((await ctx.fs.stat(source, signal))?.version !== review.source_version) throw Error(ocrBinding === undefined
    ? 'SOURCE_QA_CHANGED: 视频版本变化，须重新审看。' : 'SOURCE_QA_CHANGED: 视频版本变化，须重新审看和OCR。')
  const read = async (file: string, expected: string) => {
    const target = await ctx.fs.resolve(file, { cwd: policy.workspaceRoot, signal })
    const before = await ctx.fs.stat(target, signal)
    if (before?.type !== 'file') throw Error('SOURCE_QA_ARTIFACT: 需要实际工具文件。')
    const bytes = await ctx.fs.readBytes(target, signal, 64 * 1024 * 1024)
    if (hash(bytes) !== expected || (await ctx.fs.stat(target, signal))?.version !== before.version) throw Error('SOURCE_QA_ARTIFACT: 证据文件已变化。')
    return { target, bytes }
  }
  const ocr = ocrBinding === undefined ? undefined : await read(ocrBinding.ocrPath, ocrBinding.ocrSha256)
  const inspection = await read(binding.inspectionPath, binding.inspectionSha256)
  if (new TextDecoder('utf-8', { fatal: true }).decode(inspection.bytes) !== reviewEvidenceJson(review)) throw Error('SOURCE_QA_REVIEW: 报告不是当前会话的准确完整观察记录。')
  const issuance = sourceQaStateOf(ctx, session)
  const pending = (names: readonly string[]) => [...Object.values(issuance.native), ...Object.values(issuance.nested)]
    .some(name => names.includes(name))
  const pendingMessage = ocrBinding === undefined
    ? 'SOURCE_QA_TOOL_PENDING: 实际工具结果尚在提交。结束当前run_code，在下一次独立调用继续；保留已有审看文件。'
    : 'SOURCE_QA_TOOL_PENDING: 实际工具结果尚在提交。结束当前run_code，在下一次独立调用继续render或stage_delivery；保留已有OCR和审看文件。'
  if (ocr !== undefined && ocrBinding !== undefined) {
    let ocrIssued = false
    for (const [file, issued] of Object.entries(issuance.ocr)) {
      if (issued.source_version === review.source_version && issued.sha256 === ocrBinding.ocrSha256
        && await sameTarget(file, ocr.target) && await sameTarget(issued.path, source)) { ocrIssued = true; break }
    }
    if (!ocrIssued) {
      if (pending(['video_ocr'])) throw Error(pendingMessage)
      throw Error('SOURCE_QA_OCR: 未找到当前会话成功且绑定完整摘要的video_ocr结果；旧记录须实际重扫。')
    }
  }
  let inspected = false
  for (const [file, issued] of Object.entries(issuance.reviews)) {
    if (issued.review_id === review.id && issued.source_version === review.source_version && issued.session_id === session.id
      && issued.sha256 === binding.inspectionSha256 && await sameTarget(file, inspection.target)
      && await sameTarget(issued.path, source)) { inspected = true; break }
  }
  if (!inspected) {
    if (pending(['video_inspect', 'video_source_review'])) throw Error(pendingMessage)
    throw Error(`SOURCE_QA_REVIEW: 报告路径不是当前会话成功${reviewTool}完整审看输出。`)
  }
  if ((await ctx.fs.stat(source, signal))?.version !== review.source_version
    || JSON.stringify(reviewsOf(ctx, session)[review.path]) !== captured) throw Error('SOURCE_QA_CHANGED: 核验期间源片或观察记录变化。')
}
