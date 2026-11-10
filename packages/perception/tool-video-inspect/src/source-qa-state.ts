/** Compact issuance folded from real successful tool outcomes, including Session restoration. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'

const toolName = z.enum(['video_ocr', 'video_inspect', 'video_source_review'])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const ocrRecord = z.object({ path: z.string(), source_version: z.string(), sha256: digest })
const reviewRecord = z.object({ path: z.string(), source_version: z.string(), review_id: z.string(),
  session_id: z.string(), sha256: digest })
const schema = z.object({ native: z.record(z.string(), toolName), nested: z.record(z.string(), toolName),
  ocr: z.record(z.string(), ocrRecord), reviews: z.record(z.string(), reviewRecord) })
type IssuedEvidence = z.infer<typeof schema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { videoSourceQa: IssuedEvidence }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function values(content: readonly ContentBlock[], meta?: unknown): Record<string, unknown>[] {
  const result = object(meta) ? [meta] : []
  for (const block of content) {
    if (block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(block.text) }
    catch (_error) { continue /* Non-JSON tool text does not issue source evidence. */ }
    if (object(value)) result.push(value)
  }
  return result
}
function capture(state: IssuedEvidence, name: string, content: readonly ContentBlock[], meta?: unknown): IssuedEvidence {
  let next = state
  for (const value of values(content, meta)) {
    if (name === 'video_ocr') {
      const parsed = ocrRecord.safeParse({ path: value.path, source_version: value.source_version ?? value.sourceVersion,
        sha256: value.raw_json_sha256 ?? value.rawJsonSha256 })
      const file = value.raw_json_path ?? value.rawJsonPath
      if (parsed.success && typeof file === 'string') next = { ...next, ocr: { ...next.ocr, [file]: parsed.data } }
    }
    if ((name === 'video_inspect' || name === 'video_source_review') && value.complete === true) {
      const source = object(value.videoReviewEvidence) ? value.videoReviewEvidence : value
      const parsed = reviewRecord.safeParse({ path: source.path, source_version: source.source_version ?? source.sourceVersion,
        review_id: source.review_id ?? source.reviewId, session_id: source.observation_session_id ?? source.sessionId,
        sha256: source.observation_report_sha256 ?? source.sha256 })
      const file = source.observation_report ?? source.observationReport
      if (parsed.success && typeof file === 'string') next = { ...next, reviews: { ...next.reviews, [file]: parsed.data } }
    }
  }
  return next
}

/** Register rebuildable result issuance without adding or changing a durable Session event type.
 * @param ctx - Projection registry beside the complete-review provider.
 */
export function installSourceQaState(ctx: Context): void {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Source QA issuance requires sessionProjections')
  projections.register<'videoSourceQa', IssuedEvidence>({ key: 'videoSourceQa', stateSchema: schema, stateVersion: 1,
    init: () => ({ native: {}, nested: {}, ocr: {}, reviews: {} }),
    apply: (state, event) => {
      if (event.type === 'tool/call') {
        const name = toolName.safeParse(event.data.name)
        if (name.success) return { ...state, native: { ...state.native, [event.data.callId]: name.data } }
      }
      if (event.type === 'tool/ptc-dispatch-start') {
        const name = toolName.safeParse(event.data.name)
        if (name.success) return { ...state, nested: { ...state.nested, [event.data.subCallId]: name.data } }
      }
      if (event.type === 'tool/result') {
        const id = event.data.message.toolCallId, name = state.native[id]
        if (name === undefined) return state
        const { [id]: _completed, ...native } = state.native
        const next = { ...state, native }
        return event.data.message.isError ? next : capture(next, name, event.data.message.content, event.data.meta)
      }
      if (event.type === 'tool/ptc-dispatch') {
        const id = event.data.subCallId, name = state.nested[id]
        if (name === undefined) return state
        const { [id]: _completed, ...nested } = state.nested
        const next = { ...state, nested }
        return event.data.isError || name !== event.data.name ? next : capture(next, name, event.data.content)
      }
      return state
    },
  })
}

/** Read current successful issuance facts without a synchronous or historical Session scan.
 * @param ctx - Owning projection registry.
 * @param session - Actual initiating Session, including a restored instance of the same log.
 * @returns Compact successful OCR and complete-report facts derived only from committed tool outcomes.
 */
export function sourceQaStateOf(ctx: Context, session: Session): IssuedEvidence {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Source QA issuance requires sessionProjections')
  const state = projections.stateOf(session, 'videoSourceQa')
  if (state === undefined) throw Error('Source QA issuance is unavailable; enable complete video review')
  return state
}
