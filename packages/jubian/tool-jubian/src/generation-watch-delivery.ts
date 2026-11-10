/** Durable delivery of one verified generation-watch notice to its original Session. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { GenerationWatchGroupOrigin, GenerationWatchNotice } from './generation-watch-store.ts'

const sourceKind = 'jubian-generation-watch' as const
const projectionKey = 'jubianGenerationNotices' as const
const progress = z.enum(['queued', 'running', 'settled', 'interrupted', 'needs-review'])
const deliveryState = z.object({ notices: z.record(z.uuid(), progress), running: z.array(z.uuid()) })

/** Durable outcome of the notice's continuation turn. */
export type GenerationNoticeDelivery = 'pending' | 'settled' | 'interrupted' | 'needs-review'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Verified provider results preserved as ordinary context without this producer.
     * Group routing uses the team's independently persisted assignment, not source metadata.
     * @persistenceAttribution
     */
    'jubian-generation-watch': {
      kind: typeof sourceKind
      groupOrigin?: GenerationWatchGroupOrigin
      groupReceiptId?: string
    } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { jubianGenerationNotices: z.infer<typeof deliveryState> }
}

/**
 * Keep delivery evidence after the Agent claims an inbox entry and after Host restart.
 * @param ctx - The Host plugin scope that owns generation observation.
 */
export function registerGenerationWatchDelivery(ctx: Context): void {
  ctx.effect(() => ctx.sessionProjections.register({
    key: projectionKey,
    stateSchema: deliveryState,
    init: () => ({ notices: {}, running: [] }),
    apply: (state, event) => {
      if (event.type === 'agent/inbox/spliced') {
        const ids = event.data.inserted.filter(message => message.source.kind === sourceKind).map(message => message.id)
        if (ids.length === 0) return state
        const notices = { ...state.notices }
        for (const id of ids) notices[id] ??= 'queued'
        return { ...state, notices }
      }
      if (event.type === 'user/message' && event.data.source.kind === sourceKind) {
        const { id } = event.data
        return { notices: { ...state.notices, [id]: 'running' }, running: [...state.running, id] }
      }
      if (event.type === 'turn/end' && state.running.length > 0) {
        const { reason } = event.data
        const interrupted = reason.kind === 'interrupted'
          || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')
        const outcome = interrupted ? 'interrupted' : reason.kind === 'completed' ? 'settled' : 'needs-review'
        const notices = { ...state.notices }
        for (const id of state.running) notices[id] = outcome
        return { notices, running: [] }
      }
      return state
    },
    stateVersion: 3,
  }))
}

/**
 * Allocate the message identity before the caller commits the pending outbox entry.
 * @param text - Verified results and the next allowed step.
 * @returns The undelivered outbox entry.
 */
export function createGenerationWatchNotice(text: string): GenerationWatchNotice {
  return { id: randomUUID(), text }
}

/**
 * Deliver the same outbox entry at most once to a durable Session inbox.
 * @param ctx - Host services for resolving Sessions and flushing inbox events.
 * @param sessionId - Original submitting Session.
 * @param notice - Outbox entry saved before any enqueue attempt.
 * @param signal - Optional Host lifetime signal, checked before enqueue.
 * @param groupOrigin - Original room assignment, when the submitting Session was delegated work.
 * @param groupReceiptId - Stable original notice identity, including on recovery.
 * @returns The durable turn outcome, or pending while the notice is queued or executing.
 */
export async function deliverGenerationWatchNotice(ctx: Context, sessionId: SessionId, notice: GenerationWatchNotice,
  signal?: AbortSignal, groupOrigin?: GenerationWatchGroupOrigin, groupReceiptId?: string): Promise<GenerationNoticeDelivery> {
  signal?.throwIfAborted()
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('Generation watch delivery requires the Host session controller')
  const receiptId = groupReceiptId ?? notice.id
  if (groupOrigin !== undefined) {
    const team = ctx.get('museTeam') as { prepareGenerationWatchDelivery?: (handoff: {
      workerSessionId: string
      origin: GenerationWatchGroupOrigin
      receiptId: string
      noticeId: string
      text: string
    }) => Promise<void> } | undefined
    if (team?.prepareGenerationWatchDelivery === undefined) {
      throw new Error('Generation watch is waiting for the original Muse Bot group service')
    }
    await team.prepareGenerationWatchDelivery({ workerSessionId: sessionId, origin: groupOrigin, receiptId,
      noticeId: notice.id, text: notice.text })
    signal?.throwIfAborted()
  }
  const resolved = await controller.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  signal?.throwIfAborted()
  const { agent } = resolved
  const prior = ctx.sessionProjections.stateOf(agent.session, projectionKey)
  if (prior === undefined) throw new Error('Generation watch delivery projection is not registered')
  const messageId = MessageId(notice.id)
  if (prior.notices[notice.id] === undefined) {
    agent.followup(freezeMessage<UserMessage>({ id: messageId, role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: sourceKind, form: 'notice', summary: '剧变视频生成结果已核对',
        ...(groupOrigin === undefined ? {} : { groupOrigin, groupReceiptId: receiptId }) } }))
  } else if (prior.notices[notice.id] === 'queued') {
    if (agent.wakePending === undefined) throw new Error('Generation watch delivery requires a resumable Agent inbox')
    agent.wakePending(messageId)
  }
  const observed = ctx.sessionProjections.stateOf(agent.session, projectionKey)?.notices[notice.id]
  const pending = agent.inbox.nextTurn.some(message => message.id === messageId)
    || agent.inbox.nextStep.some(message => message.id === messageId) || agent.status === 'running'
  if (!await ctx.sessions.flush(agent.session)) {
    throw new Error('Session persistence did not acknowledge the generation watch notice')
  }
  if (observed === 'interrupted' || observed === 'settled' || observed === 'needs-review') return observed
  return pending || observed === 'running' ? 'pending' : 'needs-review'
}
