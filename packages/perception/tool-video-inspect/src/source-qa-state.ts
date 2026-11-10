/** Compact issuance folded from real successful tool outcomes, including Session restoration. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from './review-state.ts'

const toolName = z.enum(['video_ocr', 'video_inspect', 'video_source_review'])
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const ocrRecord = z.object({ path: z.string(), source_version: z.string(), sha256: digest })
const reviewRecord = z.object({ path: z.string(), source_version: z.string(), review_id: z.string(),
  session_id: z.string(), sha256: digest })
const schema = z.object({ native: z.record(z.string(), toolName), nested: z.record(z.string(), toolName),
  ocr: z.record(z.string(), ocrRecord), reviews: z.record(z.string(), reviewRecord) })
type IssuedEvidence = z.infer<typeof schema>
const ownedSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(),
  ownReviews: z.record(z.string(), z.string()), issuance: schema })
type OwnedEvidence = z.infer<typeof ownedSchema>

/** Synchronous reader retained by the registration owner.
 * @param session - Session whose committed tool results supply issuance facts.
 * @returns Current derived issuance state.
 */
export type SourceQaStateReader = (session: Session) => OwnedEvidence
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function capture(state: IssuedEvidence, name: string, meta?: unknown): IssuedEvidence {
  if (!object(meta) || !object(meta[TOOL_BODY_META_KEY])) return state
  const value = meta[TOOL_BODY_META_KEY]
  let next = state
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
  return next
}

/** Register rebuildable result issuance without adding or changing a durable Session event type.
 * @param ctx - Projection registry beside the complete-review provider.
 * @returns Ready reader retaining the owning projection handle.
 */
export async function installSourceQaState(ctx: Context): Promise<SourceQaStateReader> {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw Error('Source QA issuance requires sessionProjections')
  const projection = await projections.register<'videoSourceQa', OwnedEvidence>({ key: 'videoSourceQa', stateSchema: ownedSchema, stateVersion: 3,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, ownReviews: {},
      issuance: { native: {}, nested: {}, ocr: {}, reviews: {} } }),
    apply: (owner, event) => {
      if (event.seq < owner.inheritedEventCount) return owner
      if (event.type === 'video/review' && event.data.kind === 'start') {
        return { ...owner, ownReviews: { ...owner.ownReviews, [event.data.review.path]: event.data.review.id } }
      }
      const state = owner.issuance
      const ownerNext = (issuance: IssuedEvidence): OwnedEvidence => issuance === state ? owner : { ...owner, issuance }
      if (event.type === 'tool/call') {
        const name = toolName.safeParse(event.data.name)
        if (name.success) return ownerNext({ ...state, native: { ...state.native, [event.data.callId]: name.data } })
      }
      if (event.type === 'tool/ptc-dispatch-start') {
        const name = toolName.safeParse(event.data.name)
        if (name.success) return ownerNext({ ...state, nested: { ...state.nested, [event.data.subCallId]: name.data } })
      }
      if (event.type === 'tool/result') {
        const id = event.data.message.toolCallId, name = state.native[id]
        if (name === undefined) return owner
        const { [id]: _completed, ...native } = state.native
        const next = { ...state, native }
        return ownerNext(event.data.message.isError ? next : capture(next, name, event.data.meta))
      }
      if (event.type === 'tool/ptc-dispatch') {
        const id = event.data.subCallId, name = state.nested[id]
        if (name === undefined) return owner
        const { [id]: _completed, ...nested } = state.nested
        const next = { ...state, nested }
        return ownerNext(event.data.isError || name !== event.data.name ? next : capture(next, name, event.data.meta))
      }
      return owner
    },
  })
  return session => projection.stateOf(session)
}

/** Read successful issuance facts from the owner-retained projection.
 * @param readSourceQa - Ready reader retaining the owning projection handle.
 * @param session - Actual initiating Session, including a restored instance of the same log.
 * @returns Successful OCR and complete-report facts derived from committed tool outcomes.
 */
export function sourceQaStateOf(readSourceQa: SourceQaStateReader, session: Session): IssuedEvidence {
  return readSourceQa(session).issuance
}

/** Determine whether the Session itself started the reviewed source.
 * @param readSourceQa - Ready reader retaining the owning projection handle.
 * @param session - Session requesting strict evidence.
 * @param id - Exact review identity.
 * @param path - Review's original source path.
 * @returns Whether this Session started the matching review after its inherited prefix.
 */
export function sourceQaOwnsReview(readSourceQa: SourceQaStateReader, session: Session, id: string, path: string): boolean {
  return readSourceQa(session).ownReviews[path] === id
}
