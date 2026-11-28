/** Validate advisory listening results against the exact rendered audio extent. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const axes = ['pronunciation', 'dialogue_completeness', 'speaker', 'continuity'] as const
const maxEntries = 64
const maxReasonBytes = 384
const maxAssessmentBytes = 64 * 1024
const reason = z.string().trim().min(1).max(maxReasonBytes)
  .refine(value => Buffer.byteLength(value, 'utf8') <= maxReasonBytes)
const span = z.strictObject({ start_us: z.number().int().nonnegative(), end_us: z.number().int().positive(), reason })
const axisAssessment = z.strictObject({ status: z.enum(['ok', 'issues', 'uncertain']), reason })
const finding = span.extend({ axis: z.enum(axes), status: z.enum(['issues', 'uncertain']) })
const providerAssessment = z.strictObject({
  ranges: z.array(span).min(1).max(maxEntries),
  assessments: z.strictObject({
    pronunciation: axisAssessment, dialogue_completeness: axisAssessment,
    speaker: axisAssessment, continuity: axisAssessment,
  }),
  findings: z.array(finding).max(maxEntries),
})

/** Coverage and reported findings retained for subsequent review of the same audio. */
export type ContentListeningAssessment = Readonly<z.infer<typeof providerAssessment>> & {
  readonly duration_us: number
  readonly status: 'needs_review' | 'issues_found'
  readonly listening_verified: false
  readonly grants_approval: false
}

function invalid(message: string): never {
  throw new HarnessError(message, 'CONTENT_LISTENING_ASSESSMENT_INVALID')
}

/** Normalize a dedicated reviewer's JSON for the measured duration of the actual audio.
 * @param durationUs - Full sample-derived duration, measured locally in integer microseconds.
 * @param value - Untrusted JSON from the dedicated reviewer.
 * @returns Advisory findings and conclusions with both approval flags cleared.
 * @throws {HarnessError} When the reply is malformed, exceeds bounds, or gives inconsistent coverage or conclusions.
 */
export function parseContentListeningAssessment(durationUs: number, value: unknown): ContentListeningAssessment {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) invalid('缺少成片实测音频时长，无法核对听校范围。')
  const parsed = providerAssessment.safeParse(value)
  if (!parsed.success) invalid('听校回复格式无效。请返回完整区间、四项复核结论和疑点时段。')
  const { ranges, assessments, findings } = parsed.data

  let reviewedUntil = 0
  for (const range of ranges) {
    if (range.start_us !== reviewedUntil || range.end_us <= range.start_us || range.end_us > durationUs) {
      invalid('听校区间须按时间顺序从零连续覆盖成片音轨。')
    }
    reviewedUntil = range.end_us
  }
  if (reviewedUntil !== durationUs) invalid('听校区间须覆盖完整成片音轨，包括片尾。')

  const reportedStatus = new Map<(typeof axes)[number], 'issues' | 'uncertain'>()
  for (const item of findings) {
    if (item.end_us <= item.start_us || item.end_us > durationUs) invalid('听校疑点的时间超出实际音轨范围或区间无效。')
    if (reportedStatus.get(item.axis) !== 'issues') reportedStatus.set(item.axis, item.status)
  }
  for (const axis of axes) {
    if (assessments[axis].status !== (reportedStatus.get(axis) ?? 'ok')) {
      invalid('听校结论与对应项目的疑点不一致。请逐项核对。')
    }
  }

  const assessment: ContentListeningAssessment = { ranges, assessments, findings, duration_us: durationUs,
    status: axes.some(axis => reportedStatus.get(axis) === 'issues') ? 'issues_found' : 'needs_review',
    listening_verified: false, grants_approval: false }
  if (Buffer.byteLength(JSON.stringify(assessment), 'utf8') > maxAssessmentBytes) {
    invalid('听校报告过长。请保留时段并缩短每条依据。')
  }
  return assessment
}
