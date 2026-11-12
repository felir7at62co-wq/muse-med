/** Incremental answer state for output-specific listening, independent of historical event reads. */
import type { Context } from '@deepseek-ai/cordis'
import type { VideoObservationVerifier } from '@deepseek-ai/dsh-tool-video-inspect'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ContentListeningBinding } from './content-review.ts'

const PASS = '已完整试听，发音与声音内容通过'
const REJECT = '有问题或尚未完整试听'
const stateSchema = z.record(z.string(), z.object({ callId: z.string(), question: z.string(), accepted: z.boolean() }))
type ListeningState = z.infer<typeof stateSchema>
const ownedSchema = z.object({ inheritedEventCount: z.number().int().nonnegative(), answers: stateSchema })
type OwnedListeningState = z.infer<typeof ownedSchema>
/** Ready private reader owned by the projection's plugin scope. */
export type ContentListeningReader = (session: NonNullable<Parameters<VideoObservationVerifier>[0]>) => ListeningState
type Row = Record<string, unknown>
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contentListening: OwnedListeningState }
}

/** Build the exact output-specific question without opening a user prompt.
 * @param output - Current working MP4 path.
 * @param sha256 - Independently verified output digest.
 * @param duration - Full measured output duration.
 * @returns Question text and explicit completed or incomplete listening options.
 */
export function contentListeningQuestion(output: string, sha256: string, duration: number): {
  id: string
  question: string
  options: { label: string }[]
} {
  return { id: `content-listening-${sha256}`, question: `请实际完整试听 ${output}（SHA-256 ${sha256}），覆盖0–${duration.toFixed(6)}秒，核对实际发音、漏说错说、说话人及声音衔接。是否已完成且没有未决问题？`,
    options: [{ label: PASS }, { label: REJECT }] }
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return undefined /* Invalid model arguments never establish an answer. */ }
}

function fold(state: ListeningState, event: { readonly type: string; readonly data: unknown }): ListeningState {
  const data = event.data
  if (!object(data)) return state
  if (event.type === 'tool/call' && data.name === 'ask_user_question' && text(data.callId)) {
    const args = parsed(data.arguments)
    if (!object(args) || !Array.isArray(args.questions)) return state
    let next = state
    for (const question of args.questions) {
      if (!object(question) || !text(question.id) || !/^content-listening-[a-f0-9]{64}$/u.test(question.id)
        || !text(question.question) || question.multi_select === true || !Array.isArray(question.options)
        || question.options.length !== 2 || !object(question.options[0]) || question.options[0].label !== PASS
        || !object(question.options[1]) || question.options[1].label !== REJECT) continue
      next = { ...next, [question.id]: { callId: data.callId, question: question.question, accepted: false } }
    }
    return next
  }
  const native = event.type === 'tool/result' && object(data.message) ? data.message : undefined
  const late = event.type === 'user/message' && object(data.source) && data.source.kind === 'user-question-reply'
    && data.source.outcome === 'answered' ? data.source : undefined
  const callId = native?.toolCallId ?? late?.callId
  if (!text(callId)) return state
  const content = native?.content ?? data.content
  let answers: unknown[] = []
  if (native?.isError !== true && Array.isArray(content)) for (const block of content) {
    if (!object(block) || block.type !== 'text') continue
    const value = parsed(block.text)
    if (!object(value) || !Array.isArray(value.answers)) continue
    if (late !== undefined && (value.kind !== 'answer_to_pending_question' || value.tool !== 'ask_user_question'
      || value.callId !== callId)) continue
    answers = value.answers
    break
  }
  let next = state
  for (const [id, question] of Object.entries(state)) {
    if (question.callId !== callId) continue
    const answer = answers.find(item => object(item) && item.id === id)
    const accepted = object(answer) && Array.isArray(answer.selected) && answer.selected.length === 1
      && answer.selected[0] === PASS && !answer.custom
    next = { ...next, [id]: { ...question, accepted } }
  }
  return next
}

function verify(sessionId: string | undefined, state: ListeningState, binding: ContentListeningBinding): void {
  if (sessionId === undefined || sessionId !== binding.sessionId) throw Error('CONTENT_REVIEW_PENDING: 试听回答必须来自当前会话。')
  const answer = state[binding.questionId]
  if (!answer?.accepted || answer.callId !== binding.callId || answer.question !== binding.question) {
    throw Error('CONTENT_REVIEW_PENDING: 没有当前成片的真实已完成试听回答；ASR、增益测量和模型自报不能替代。')
  }
}

/** Register resume-safe listening answers on the existing Session projection registry.
 * @param ctx - Owning plugin scope carrying Session projections.
 * @returns A ready private reader retained for the owning scope lifetime.
 */
export async function installContentListeningState(ctx: Context): Promise<ContentListeningReader> {
  const projection = await ctx.sessionProjections.register({ key: 'contentListening', stateSchema: ownedSchema, stateVersion: 2,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, answers: {} }),
    apply: (owner, event) => {
      if (event.seq < owner.inheritedEventCount) return owner
      const answers = fold(owner.answers, event)
      return answers === owner.answers ? owner : { ...owner, answers }
    } })
  return session => projection.stateOf(session).answers
}

/** Verify already-projected answers without acquiring media or reading complete Session history.
 * @param readListening - Ready private reader owned by the Host scope.
 * @param session - Actual initiating Session.
 * @param binding - Exact output-specific question and native answer identity.
 */
export function verifyProjectedContentListening(readListening: ContentListeningReader, session: Parameters<VideoObservationVerifier>[0],
  binding: ContentListeningBinding): void {
  const state = session === undefined ? {} : readListening(session)
  verify(session?.id, state, binding)
}

/** Pure replay used by listening regression fixtures.
 * @param sessionId - Actual initiating Session identity.
 * @param events - Fixture events using the same incremental fold as production.
 * @param binding - Exact output-specific question and answer identity.
 */
export function verifyContentListeningAnswer(sessionId: string | undefined,
  events: readonly { readonly type: string; readonly data: unknown }[], binding: ContentListeningBinding): void {
  verify(sessionId, events.reduce(fold, {}), binding)
}
