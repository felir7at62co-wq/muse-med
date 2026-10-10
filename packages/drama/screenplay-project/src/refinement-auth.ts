/** Host-only projection of real user-message identities for refinement grant capture. @module screenplay-project/refinement-auth */
import { z } from 'zod'
import { MessageId, type Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { sha256 } from './episode.ts'
import type { HumanAuthorization } from './refinement.ts'
import type { ActorId } from './ids.ts'

const userIdentity = z.strictObject({
  message_id: z.string().transform(MessageId), seq: z.number().int().nonnegative().transform(SessionSeq),
  message_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const stateSchema = z.strictObject({ users: z.array(userIdentity) })
type UserIdentityState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Original committed real-human message identities, omitted from client snapshots. */
    screenplayRefinementUsers: UserIdentityState
  }
}

/** Real committed source:user identities; content remains solely in the original Session. */
export const refinementUserProjection = {
  key: 'screenplayRefinementUsers', stateSchema, stateVersion: 1,
  init: () => ({ users: [] }),
  apply: (state, event) => event.type !== 'user/message' || event.data.source.kind !== 'user' ? state
    : { users: [...state.users, { message_id: event.data.id, seq: event.seq, message_sha256: sha256(JSON.stringify(event.data)) }] },
} satisfies ProjectionDefinition<'screenplayRefinementUsers', UserIdentityState>

/**
 * Capture an exact quote only from an unchanged, currently visible real human message.
 * @param state - Host-projected committed user identities, including restored checkpoints.
 * @param messages - Current model-visible Session messages.
 * @param actor - Real initiating Session identity.
 * @param quote - Exact human-authored grant selected by the model.
 * @param assessment - Model explanation of intent and category scope, not automatic consent proof.
 * @returns Host-stamped identity evidence; absent matches fail closed.
 */
export function captureRefinementAuthorization(state: UserIdentityState, messages: readonly Message[], actor: ActorId,
  quote: string, assessment: string): HumanAuthorization {
  const visible = new Map(messages.map(message => [message.id, message]))
  const identity = state.users.findLast((record) => {
    const message = visible.get(record.message_id)
    return message?.role === 'user' && message.source.kind === 'user'
      && sha256(JSON.stringify(message)) === record.message_sha256
      && message.content.some(block => block.type === 'text' && block.text.includes(quote))
  })
  if (!quote.trim() || identity === undefined) {
    throw Error('refinement_human_authorization: 原话须来自当前仍可见且未改写的真实用户消息；工具、附件及第三方文本不能授权。')
  }
  return { source: 'user', session_id: actor, message_id: identity.message_id, seq: identity.seq,
    message_sha256: identity.message_sha256, quote, consent_assessment: assessment }
}
