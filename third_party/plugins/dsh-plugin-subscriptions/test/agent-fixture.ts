/** Typed, detached Agents for subscription consumers that never drive a turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

/**
 * Build an idle Agent backed by a validated detached Session.
 * @param rawId - test-owned session identity.
 * @param ctx - context owned and disposed by the caller.
 * @param options - model route observed by the subscription consumer.
 * @param session - detached session, optionally carrying fork metadata.
 * @returns a complete Agent whose unsupported turn operations fail immediately.
 */
export function subscriptionAgent(
  rawId: string,
  ctx: Context,
  options: AgentOptions = {},
  session: Session = Session.create(SessionId(rawId)),
): Agent {
  const unsupported = (): never => { throw new Error('subscription fixture does not drive turns') }
  const agent = {
    id: SessionId(rawId), ctx, options, session,
    model: { current: unsupported, select: unsupported }, inbox: unsupportedInbox(), status: 'idle' as const,
    send: unsupported, followup: unsupported, steer: unsupported, inject: unsupported,
    cancel: unsupported, runMaintenance: unsupported, whenIdle: async () => {},
  }
  return agent
}

/** Metadata accepted by the subscription speed classification fixture. */
export type SubscriptionSessionMeta = Pick<SessionHeader, 'origin' | 'parentSession' | 'isSeeded'>
