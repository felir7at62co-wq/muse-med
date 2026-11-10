/** Explicit saved-video samples and ASR comparisons, separate from manuscript-only continuity. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { VideoReviewId, readVideoSourceTimeline, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { ContinuityJudgment, ContinuityTarget } from './manuscript-continuity.ts'
import type { ManuscriptMaterialsDocument, ManuscriptMaterialsResult } from './manuscript-materials.ts'
import { manuscriptQuotationMatches, manuscriptReviewEvidenceSchema } from './manuscript-review-evidence.ts'
import type { ManuscriptTaskHuman, ManuscriptTaskRequest } from './manuscript-task-intent.ts'
import { manuscriptVideoReviewReader } from './manuscript-video-reads.ts'

const rangeSchema = z.strictObject({ start: z.number().int().positive(), end: z.number().int().positive() })
  .refine(value => value.end >= value.start)
const sourceInputSchema = z.strictObject({ review_id: z.string().min(1).transform(VideoReviewId),
  start_seconds: z.number().nonnegative(), end_seconds: z.number().positive(),
  draft_lines: rangeSchema, frame_ids: z.array(z.string().min(1)).min(1) })
  .refine(value => value.end_seconds > value.start_seconds)

/** Explicit source-to-draft selections; no file, episode, speaker or time alignment is inferred. */
export const videoSourceInputsSchema = z.array(sourceInputSchema).min(1)
/** Validated source selections, in caller-specified correspondence order. */
export type VideoSourceInputs = z.infer<typeof videoSourceInputsSchema>
/** Existing application video-evidence budgets also bound an explicit independent comparison. */
export interface VideoSourceLimits {
  videoEvidenceWindowSeconds: number
  videoEvidenceMaxScenes: number
  videoEvidenceMaxFrames: number
  videoEvidenceMaxBytes: number
  videoEvidenceMaxTranscriptBytes: number
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const identitySchema = z.object({ role: z.enum(['current', 'reference', 'candidate']), path: z.string(),
  file_sha256: digest, text_sha256: digest })
const sourceManifestSchema = z.object({ mapping: z.number().int().positive(), review_id: z.string().transform(VideoReviewId),
  path: z.string(), source_version: z.string(), material_sha256: digest, packet_sha256: digest,
  start_seconds: z.number(), end_seconds: z.number(), draft_lines: rangeSchema,
  frames: z.array(z.object({ frame_id: z.string(), planned_seconds: z.number(),
    decoded_seconds: z.number().optional(), image_sha256: digest })),
  speech_segment_ids: z.array(z.string()), context_only_segment_ids: z.array(z.string()),
  speech_source: z.object({ path: z.string(), version: z.string(), sha256: digest }).optional(),
  scan_complete: z.boolean(), scanned_until: z.number(), duration_seconds: z.number() })
/** Re-readable source dependencies; file versions are freshness tokens, while image digests cover actual cached bytes. */
export const videoSourceManifestSchema = z.object({ scope: z.literal('sampled_frames_and_saved_asr'),
  audio_verification: z.literal('not_performed'), asr_origin_and_speaker_verified: z.literal(false),
  target: identitySchema, inputs: videoSourceInputsSchema, sources: z.array(sourceManifestSchema),
  mapped_ranges: z.array(rangeSchema), unmapped_lines: z.array(z.number().int().positive()) })
/** Exact local source versions, samples and selected target ranges retained with the comparison. */
export type VideoSourceManifest = z.infer<typeof videoSourceManifestSchema>
/** Model-ready original image blocks and unedited ASR; old model observations are excluded from the comparison prompt. */
export interface VideoSourceBundle {
  manifest: VideoSourceManifest
  content: ContentBlock[]
  expectedImages: ImageAttachmentRef[]
  timelines: VideoSourceTimeline[]
  coverage_complete: boolean
  issues: string[]
}

const explanation = z.string().min(1).refine(value => value.trim().length > 0)
const dispositionSchema = z.strictObject({ id: z.string().min(1),
  disposition: z.enum(['matched', 'mismatch', 'omitted', 'authorized_change', 'unknown']), explanation,
  draft_evidence: z.array(manuscriptReviewEvidenceSchema),
  authorization: z.strictObject({ message_id: z.string().min(1), quote: explanation }).optional() })
const checkSchema = z.strictObject({ mapping: z.number().int().positive(), status: z.enum(['consistent', 'issues', 'unknown']),
  explanation, frame_checks: z.array(dispositionSchema), speech_checks: z.array(dispositionSchema) })
/** Source comparisons submit one disposition for every actual supplied image and in-range ASR segment. */
export const videoSourceAssessmentSchema = z.strictObject({ status: z.enum(['consistent', 'issues', 'unknown']),
  findings: z.array(z.never()).max(0), unknowns: z.array(explanation), source_checks: z.array(checkSchema) })
/** Semantic source assessment; exact quotations, coverage, images and file freshness are validated separately. */
export type VideoSourceAssessment = z.infer<typeof videoSourceAssessmentSchema>

function statusOf(dispositions: readonly z.infer<typeof dispositionSchema>[]): VideoSourceAssessment['status'] {
  return dispositions.some(item => item.disposition === 'mismatch' || item.disposition === 'omitted') ? 'issues'
    : dispositions.some(item => item.disposition === 'unknown') ? 'unknown' : 'consistent'
}

/** Check status declarations without discarding missing evidence or unresolved uncertainties.
 * @param value - Parsed structured source comparison.
 * @returns A status error, or undefined when all declarations agree.
 */
export function videoSourceAssessmentProblem(value: VideoSourceAssessment): string | undefined {
  if (value.source_checks.some(check => check.status !== statusOf([...check.frame_checks, ...check.speech_checks]))) {
    return 'Each source check status must agree with its actual frame and speech dispositions.'
  }
  const hasUnknown = value.source_checks.some(check => check.status === 'unknown'
    || [...check.frame_checks, ...check.speech_checks].some(item => item.disposition === 'unknown'))
  const expected = value.source_checks.some(check => check.status === 'issues') ? 'issues'
    : hasUnknown || value.unknowns.length > 0 ? 'unknown' : 'consistent'
  if (value.status !== expected || hasUnknown && value.unknowns.length === 0) {
    return 'The overall status must retain evidenced mismatches and substantive unknowns.'
  }
  return undefined
}

function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

async function readSources(ctx: Context, session: Session, inputs: VideoSourceInputs, limits: VideoSourceLimits, signal: AbortSignal) {
  if (inputs.length > limits.videoEvidenceMaxScenes
    || inputs.reduce((sum, input) => sum + input.frame_ids.length, 0) > limits.videoEvidenceMaxFrames) {
    throw Error('VIDEO_SOURCE_BUDGET: Narrow the explicit mappings or image selection; no evidence was truncated.')
  }
  const reader = manuscriptVideoReviewReader(ctx), sources: VideoSourceManifest['sources'] = []
  const timelines: VideoSourceTimeline[] = [], content: ContentBlock[] = [], expectedImages: ImageAttachmentRef[] = []
  for (const [index, input] of inputs.entries()) {
    signal.throwIfAborted()
    const result = await readVideoSourceTimeline(ctx, session, input.review_id, {
      windowSeconds: limits.videoEvidenceWindowSeconds, startSeconds: input.start_seconds, endSeconds: input.end_seconds,
      maxTranscriptBytes: limits.videoEvidenceMaxTranscriptBytes, maxBytes: limits.videoEvidenceMaxBytes,
      maxFrames: limits.videoEvidenceMaxFrames, frameIds: input.frame_ids,
    }, signal, reader)
    const timeline = result.timeline, review = Object.values(reader(session)).find(item => item.id === input.review_id)
    const images = result.content.flatMap(block => block.type === 'image' ? [block] : [])
    const frames: VideoSourceManifest['sources'][number]['frames'] = []
    for (const [frameIndex, id] of input.frame_ids.entries()) {
      const frame = review?.frames.find(frame => frame.id === id), image = images[frameIndex]
      if (frame === undefined || image === undefined) throw Error('VIDEO_SOURCE_FRAME: The requested cached frame is unavailable.')
      if (frame.decoded_time !== undefined && (frame.decoded_time < input.start_seconds || frame.decoded_time > input.end_seconds)) {
        throw Error('VIDEO_SOURCE_FRAME_TIME: Actual decoded frame time lies outside the explicit source interval.')
      }
      const stored = await ctx.attachments.readImage(image.attachment, signal)
      frames.push({ frame_id: id, planned_seconds: frame.time, image_sha256: hash(stored.data),
        ...frame.decoded_time === undefined ? {} : { decoded_seconds: frame.decoded_time } })
      expectedImages.push(image.attachment)
    }
    const segmentIds = new Set(timeline.windows.flatMap(window => window.speech_segment_ids))
    const contextOnly = timeline.speech?.segments.filter(segment => !segmentIds.has(segment.segment_id)) ?? []
    const source = { mapping: index + 1, review_id: input.review_id, path: timeline.source.path,
      source_version: timeline.source.source_version, material_sha256: timeline.material_sha256,
      start_seconds: input.start_seconds, end_seconds: input.end_seconds, draft_lines: input.draft_lines, frames,
      speech_segment_ids: [...segmentIds], context_only_segment_ids: contextOnly.map(segment => segment.segment_id),
      ...timeline.speech === undefined ? {} : { speech_source: {
        path: timeline.speech.source.path, version: timeline.speech.source.version, sha256: timeline.speech.source.sha256 } },
      scan_complete: timeline.source.scan_complete, scanned_until: timeline.source.scanned_until,
      duration_seconds: timeline.source.duration_seconds }
    sources.push({ ...source, packet_sha256: hash(JSON.stringify(source)) })
    timelines.push(timeline)
    content.push({ type: 'text', text: JSON.stringify({ source_mapping: source,
      saved_asr: timeline.speech === undefined ? undefined : { ...timeline.speech,
        segments: timeline.speech.segments.filter(segment => segmentIds.has(segment.segment_id)), continuous_speech_candidates: [] },
      context_only_asr: contextOnly, speech_unavailable: timeline.speech_unavailable,
      notice: 'Compare the actual images, not prior model observations. planned_seconds is an approximate sampling position; decoded_seconds, when present, is actual decoded PTS. '
        + 'ASR is saved recognition text, not listening or verified character identity/common origin. '
        + 'Samples and scan completion never establish continuous full-video coverage.' }) })
    for (const [imageIndex, image] of images.entries()) content.push({ type: 'text',
      text: `SOURCE_MAPPING ${index + 1} FRAME ${input.frame_ids[imageIndex]}: original cached image.` }, image)
    if (Buffer.byteLength(JSON.stringify({ sources, content })) > limits.videoEvidenceMaxBytes) {
      throw Error('VIDEO_SOURCE_BUDGET: Complete source materials exceed the return budget; no partial evidence was returned.')
    }
  }
  return { sources, timelines, content, expectedImages }
}

/** Read explicitly mapped source evidence without extraction, ASR submission or semantic interpretation.
 * @param ctx - Host with ready manuscript readers, local filesystem and attachments.
 * @param session - Actual author Session that owns the video observations.
 * @param inputs - Explicit source versions, intervals, draft line ranges and cached frame IDs.
 * @param target - Exact candidate or current document supplied to the independent review.
 * @param limits - Existing deployment-controlled video material budgets.
 * @param signal - Operation cancellation.
 * @returns Original image blocks, saved ASR and a complete or explicitly incomplete mapping manifest.
 */
export async function readVideoSourceReview(ctx: Context, session: Session, inputs: VideoSourceInputs,
  target: ManuscriptMaterialsDocument, limits: VideoSourceLimits, signal: AbortSignal): Promise<VideoSourceBundle> {
  for (const input of inputs) {
    const returned = target.lines.filter(line => line.number >= input.draft_lines.start && line.number <= input.draft_lines.end)
    if (returned.length !== input.draft_lines.end - input.draft_lines.start + 1) {
      throw Error('VIDEO_SOURCE_DRAFT_RANGE: Mappings must stay inside the actual returned target lines.')
    }
  }
  const read = await readSources(ctx, session, inputs, limits, signal)
  const unmapped = target.lines.filter(line => line.text.trim().length > 0 && !inputs.some(input =>
    input.draft_lines.start <= line.number && input.draft_lines.end >= line.number)).map(line => line.number)
  const manifest: VideoSourceManifest = { scope: 'sampled_frames_and_saved_asr', audio_verification: 'not_performed',
    asr_origin_and_speaker_verified: false, target: { role: target.role, path: target.path,
      file_sha256: target.file_sha256, text_sha256: target.text_sha256 }, inputs,
    sources: read.sources, mapped_ranges: inputs.map(input => input.draft_lines), unmapped_lines: unmapped }
  const issues = unmapped.length === 0 ? [] : [`Target lines without source mappings: ${unmapped.join(', ')}.`]
  for (const [index, timeline] of read.timelines.entries()) {
    if (timeline.speech === undefined) issues.push(`Mapping ${index + 1} has no current saved ASR. `
      + 'Only its supplied images can be compared; dialogue and original sound remain unverified.')
  }
  return { manifest, ...read, coverage_complete: unmapped.length === 0, issues }
}

/** Re-read the exact recorded source dependencies without another model request or media extraction.
 * @param ctx - Host with the same ready source readers.
 * @param session - Author Session owning these observations.
 * @param manifest - Previously issued source identities, image digests and original selections.
 * @param limits - Current deployment video material budgets.
 * @param signal - Operation cancellation.
 * @returns Whether every source, ASR, selected image and observation revision still matches; unavailable material returns false.
 */
export async function videoSourceReviewUnchanged(ctx: Context, session: Session, manifest: VideoSourceManifest,
  limits: VideoSourceLimits, signal: AbortSignal): Promise<boolean> {
  try {
    const current = await readSources(ctx, session, manifest.inputs, limits, signal)
    return JSON.stringify(current.sources) === JSON.stringify(manifest.sources)
  } catch (error) { signal.throwIfAborted(); void error; return false }
}

/** Build the dedicated source-comparison vocabulary; Host validation checks exact mapping coverage and original quotations.
 * @param materials - Exact numbered manuscripts actually supplied to this review.
 * @param bundle - Actual source packets and image identities.
 * @returns Structured source-result schema, separate from ordinary manuscript findings.
 */
export function buildVideoSourceOutputSchema(materials: ManuscriptMaterialsResult, bundle: VideoSourceBundle): ObjectJsonSchema {
  const citation: ObjectJsonSchema = { type: 'object', additionalProperties: false,
    required: ['role', 'path', 'file_sha256', 'text_sha256', 'line', 'quote'], properties: {
      ...Object.fromEntries(['role', 'path', 'file_sha256', 'text_sha256'].map(field => [field,
        { type: 'string', enum: [...new Set(materials.documents.map(document => document[field as keyof ContinuityTarget]))] }])),
      line: { type: 'integer' }, quote: { type: 'string' }, column: { type: 'integer' },
    } }
  const item: ObjectJsonSchema = { type: 'object', additionalProperties: false,
    required: ['id', 'disposition', 'explanation', 'draft_evidence'], properties: {
      id: { type: 'string', description: 'Exact frame_id for frame_checks or segment_id for speech_checks in this mapping.' },
      disposition: { type: 'string', enum: ['matched', 'mismatch', 'omitted', 'authorized_change', 'unknown'] },
      explanation: { type: 'string' }, draft_evidence: { type: 'array', items: citation },
      authorization: { type: 'object', additionalProperties: false, required: ['message_id', 'quote'],
        properties: { message_id: { type: 'string' }, quote: { type: 'string' } } },
    } }
  return { type: 'object', additionalProperties: false, required: ['status', 'findings', 'unknowns', 'source_checks'], properties: {
    status: { type: 'string', enum: ['consistent', 'issues', 'unknown'] },
    findings: { type: 'array', items: { type: 'object', properties: {} }, description: 'Always an empty array; source issues belong in source_checks.' },
    unknowns: { type: 'array', items: { type: 'string' } },
    source_checks: { type: 'array', description: 'Exactly one check per source mapping, every selected frame and every in-range ASR segment exactly once. Context-only segments are not scheduled coverage.',
      items: { type: 'object', additionalProperties: false,
        required: ['mapping', 'status', 'explanation', 'frame_checks', 'speech_checks'], properties: {
          mapping: { type: 'integer', enum: bundle.manifest.sources.map(source => source.mapping) },
          status: { type: 'string', enum: ['consistent', 'issues', 'unknown'] }, explanation: { type: 'string' },
          frame_checks: { type: 'array', items: item }, speech_checks: { type: 'array', items: item },
        } } },
  } }
}

/** Validate both draft-to-source mappings and source-to-draft dispositions without accepting invented citations.
 * @param raw - Committed structured_output value.
 * @param materials - Actual numbered text supplied to the reviewer.
 * @param target - Explicit assessed draft identity.
 * @param bundle - Original source images, saved ASR and requested mappings.
 * @param maxFindings - Deployment maximum for substantive mismatch/omission findings, not ordinary covered samples.
 * @param userRequest - Actual logged human requirements; absent requirements cannot authorize source changes.
 * @param retainedRequests - Earlier actual human requests retained for the explicit current manuscript, never Word author text.
 * @returns Grounded sample comparison or unknown; no automatic edits or full-video/audio claim.
 */
export function validateVideoSourceAssessment(raw: unknown, materials: ManuscriptMaterialsResult, target: ContinuityTarget,
  bundle: VideoSourceBundle, maxFindings: number, userRequest?: ManuscriptTaskRequest,
  retainedRequests: readonly ManuscriptTaskHuman[] = []): ContinuityJudgment & Partial<Pick<VideoSourceAssessment, 'source_checks'>> {
  const invalid = (message: string): ContinuityJudgment => ({ status: 'unknown', reason: 'invalid_evidence', findings: [], unknowns: [message] })
  const parsed = videoSourceAssessmentSchema.safeParse(raw)
  if (!parsed.success) return invalid('The structured source assessment is absent or invalid.')
  const value = parsed.data, problem = videoSourceAssessmentProblem(value)
  if (problem !== undefined || !bundle.coverage_complete) return invalid(problem ?? bundle.issues.join(' '))
  if (value.source_checks.length !== bundle.manifest.sources.length
    || new Set(value.source_checks.map(check => check.mapping)).size !== value.source_checks.length) {
    return invalid('Every actual source mapping requires exactly one assessment.')
  }
  let findings = 0
  for (const check of value.source_checks) {
    const source = bundle.manifest.sources.find(source => source.mapping === check.mapping)
    if (source === undefined) return invalid('A source check names an unrequested mapping.')
    for (const [items, expected] of [[check.frame_checks, source.frames.map(frame => frame.frame_id)],
      [check.speech_checks, source.speech_segment_ids]] as const) {
      if (items.length !== expected.length || new Set(items.map(item => item.id)).size !== items.length
        || items.some(item => !expected.includes(item.id))) return invalid('Every returned frame and in-range ASR segment needs exactly one disposition.')
      for (const item of items) {
        if (item.disposition === 'mismatch' || item.disposition === 'omitted') findings++
        if (['matched', 'mismatch'].includes(item.disposition) && item.draft_evidence.length === 0) {
          return invalid('A match or contradiction requires an actual target quotation; a source-only omission must be labelled omitted.')
        }
        for (const anchor of item.draft_evidence) {
          const document = materials.documents.find(document => document.role === anchor.role && document.path === anchor.path
            && document.file_sha256 === anchor.file_sha256 && document.text_sha256 === anchor.text_sha256)
          const line = document?.lines.find(line => line.number === anchor.line)
          if (anchor.path !== target.path || anchor.role !== target.role || anchor.file_sha256 !== target.file_sha256
            || anchor.text_sha256 !== target.text_sha256 || anchor.line < source.draft_lines.start || anchor.line > source.draft_lines.end
            || line === undefined || !manuscriptQuotationMatches(line.text, anchor)) return invalid('A draft quotation does not match this mapping and assessed file version.')
        }
        if (item.disposition === 'authorized_change') {
          const authorization = item.authorization
          const humans = [...userRequest?.request === undefined || userRequest.request === null ? [] : [userRequest.request],
            ...userRequest?.continuations ?? [], ...retainedRequests]
          if (authorization === undefined || !humans.some(human => human.message_id === authorization.message_id
            && human.text.includes(authorization.quote))) return invalid('Authorized source changes require an exact quotation from the actual human requirement.')
        } else if (item.authorization !== undefined) return invalid('An authorization citation applies only to authorized_change.')
      }
    }
  }
  if (findings > maxFindings) return invalid('Source mismatches exceed the configured result budget; narrow the explicit scope.')
  return { ...value, status: value.status === 'consistent' && bundle.issues.length > 0 ? 'unknown' : value.status,
    unknowns: [...value.unknowns, ...bundle.issues], reason: 'reviewed' }
}
