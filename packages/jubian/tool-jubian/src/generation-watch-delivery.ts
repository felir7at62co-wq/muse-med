/** Durable delivery of one verified generation-watch notice to its original Session. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { GenerationWatchGroupOrigin, GenerationWatchNotice } from './generation-watch-store.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Automatic input removed before its producer unloads, eligible for verified re-enqueue. */
    'jubian/generation-notice-parked': { id: string }
  }
}

const sourceKind = 'jubian-generation-watch' as const
const projectionKey = 'jubianGenerationNotices' as const
const progress = z.enum(['queued', 'running', 'settled', 'interrupted', 'needs-review', 'guard-rejected', 'unknown'])
const deliveryState = z.object({ notices: z.record(z.uuid(), progress), running: z.array(z.uuid()),
  inbox: z.object({ 'next-turn': z.array(z.string()), 'next-step': z.array(z.string()) }),
  claimTurn: z.number().int().nonnegative().nullable(), claimed: z.record(z.uuid(), z.number().int().nonnegative()),
  durableClaim: z.object({ turn: z.number().int().nonnegative(), nextStep: z.array(z.string()), nextTurn: z.array(z.string()) }).nullable(),
  durableRunning: z.array(z.uuid()) })

/** Durable outcome of the notice's continuation turn. */
export type GenerationNoticeDelivery = 'pending' | 'settled' | 'interrupted' | 'needs-review' | 'unknown'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Verified provider results preserved as ordinary context without this producer.
     * Legacy group attribution remains readable; this producer does not route archived group notices.
     * @persistenceAttribution
     */
    'jubian-generation-watch': {
      kind: typeof sourceKind
      groupOrigin?: GenerationWatchGroupOrigin
      groupReceiptId?: string
    } & ContextFormed
  }
}

/** Retained Host reader for the notice lifecycle projection. */
export type GenerationWatchDeliveryProjection = ProjectionHandle<z.infer<typeof deliveryState>>

/**
 * Keep delivery evidence after the Agent claims an inbox entry and after Host restart.
 * @param ctx - The Host plugin scope that owns generation observation.
 * @returns An effect-owned reader used for notice delivery.
 */
export async function registerGenerationWatchDelivery(ctx: Context): Promise<GenerationWatchDeliveryProjection> {
  return await ctx.sessionProjections.register({
    key: projectionKey,
    stateSchema: deliveryState,
    init: () => ({ notices: {}, running: [], inbox: { 'next-turn': [], 'next-step': [] }, claimTurn: null, claimed: {}, durableClaim: null, durableRunning: [] }),
    apply: (state, event) => {
      if (event.type === 'turn/start') return { ...state, claimTurn: event.data.turn }
      if (event.type === 'step/start') return { ...state, claimTurn: null }
      if (event.type === 'jubian/generation-notice-parked') {
        const previous = state.notices[event.data.id]
        if (previous === 'queued' || previous === 'guard-rejected') {
          return { ...state, notices: { ...state.notices, [event.data.id]: 'guard-rejected' } }
        }
        return state
      }
      if (event.type === 'agent/inbox/claim') {
        if (state.durableClaim !== null) throw new Error('Generation watch already has an active durable claim')
        const { turn, nextStep, nextTurn } = event.data
        const steps = state.inbox['next-step'].slice(0, nextStep.length)
        const turns = state.inbox['next-turn'].slice(0, nextTurn.length)
        if (steps.length !== nextStep.length || turns.length !== nextTurn.length
          || steps.some((id, index) => id !== nextStep[index]) || turns.some((id, index) => id !== nextTurn[index])) {
          throw new Error('Generation watch durable claim does not match inbox')
        }
        return { ...state, inbox: { 'next-step': state.inbox['next-step'].slice(nextStep.length),
          'next-turn': state.inbox['next-turn'].slice(nextTurn.length) },
        durableClaim: { turn, nextStep: steps, nextTurn: turns } }
      }
      if (event.type === 'agent/inbox/claim-filtered') {
        const claim = state.durableClaim
        if (claim === null || claim.turn !== event.data.turn) throw new Error('Generation watch claim is missing')
        const discarded = new Set<string>(event.data.discarded), notices = { ...state.notices }
        for (const id of discarded) if (notices[id] === 'queued') notices[id] = 'needs-review'
        return { ...state, notices, durableClaim: { ...claim,
          nextStep: claim.nextStep.filter(id => !discarded.has(id)), nextTurn: claim.nextTurn.filter(id => !discarded.has(id)) } }
      }
      if (event.type === 'agent/inbox/claim-settled') {
        if (state.durableClaim === null || state.durableClaim.turn !== event.data.turn
          || state.durableClaim.nextStep.length > 0 || state.durableClaim.nextTurn.length > 0) {
          throw new Error('Generation watch durable claim is not settled')
        }
        return { ...state, durableClaim: null }
      }
      if (event.type === 'agent/inbox/spliced') {
        const { target, start, inserted, outcome } = event.data
        const removedCount = event.data.removedCount ?? 0
        const queue = state.inbox[target]
        if (start < 0 || removedCount < 0 || start + removedCount > queue.length) throw new Error('Invalid inbox projection splice')
        const removed = queue.slice(start, start + removedCount)
        const inbox = { ...state.inbox, [target]: queue.toSpliced(start, removedCount, ...inserted.map(message => message.id)) }
        const notices = { ...state.notices }, claimed = { ...state.claimed }
        for (const message of inserted) {
          if (message.source.kind === sourceKind && (notices[message.id] === undefined || notices[message.id] === 'guard-rejected')) {
            notices[message.id] = 'queued'
          }
        }
        if (state.claimTurn !== null && outcome === undefined && inserted.length === 0) {
          for (const id of removed) if (notices[id] === 'queued') claimed[id] = state.claimTurn
        }
        return { ...state, inbox, notices, claimed }
      }
      if (event.type === 'user/message') {
        const { id } = event.data, claim = state.durableClaim
        const inDurable = claim !== null && (claim.nextStep.includes(id) || claim.nextTurn.includes(id))
        const durableClaim = claim === null ? null : { ...claim,
          nextStep: claim.nextStep.filter(item => item !== id), nextTurn: claim.nextTurn.filter(item => item !== id) }
        if (event.data.source.kind !== sourceKind) return { ...state, durableClaim }
        const notices: z.infer<typeof deliveryState>['notices'] = { ...state.notices, [id]: 'running' }
        const { [id]: _claimed, ...claimed } = state.claimed
        return { ...state, notices, claimed, durableClaim, running: [...state.running, id],
          durableRunning: inDurable ? [...state.durableRunning, id] : state.durableRunning }
      }
      if (event.type === 'turn/end') {
        const { reason, turn } = event.data
        const interrupted = reason.kind === 'interrupted'
          || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')
        const outcome = interrupted ? 'interrupted' : reason.kind === 'completed' ? 'settled' : 'needs-review'
        const notices = { ...state.notices }
        const claimed = Object.fromEntries(Object.entries(state.claimed).filter(([, claimedTurn]) => claimedTurn !== turn))
        for (const id of state.running) notices[id] = state.durableRunning.includes(id) && reason.kind !== 'completed' ? 'unknown' : outcome
        for (const [id, claimedTurn] of Object.entries(state.claimed)) {
          if (claimedTurn !== turn) continue
          if (reason.kind === 'error' && reason.error.message.startsWith('GENERATION_WATCH_BINDING_CHANGED:')) notices[id] = 'guard-rejected'
        }
        const claim = state.durableClaim?.turn === turn ? state.durableClaim : null
        const drop = reason.kind === 'forked' || (reason.kind === 'aborted' && reason.reason.kind === 'user')
        if (claim !== null) {
          for (const id of [...claim.nextStep, ...claim.nextTurn]) {
            if (notices[id] === 'queued') notices[id] = drop ? 'needs-review' : 'guard-rejected'
          }
        }
        const inbox = claim === null || drop ? state.inbox : {
          'next-step': [...claim.nextStep, ...state.inbox['next-step']],
          'next-turn': [...claim.nextTurn, ...state.inbox['next-turn']],
        }
        return { ...state, inbox, notices, claimed, running: [], claimTurn: null, durableClaim: null, durableRunning: [] }
      }
      return state
    },
    stateVersion: 6,
  })
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
 * @param verifySession - Host-owned native runtime and original Session verification; absence keeps the notice pending.
 * @param projection - Effect-owned notice state reader.
 * @param canResume - Host-owned check that a temporarily changed binding has been restored.
 * @returns The durable turn outcome, or pending while the notice is queued or executing.
 */
export async function deliverGenerationWatchNotice(ctx: Context, sessionId: SessionId, notice: GenerationWatchNotice,
  signal?: AbortSignal, groupOrigin?: GenerationWatchGroupOrigin, groupReceiptId?: string,
  verifySession?: (id: SessionId) => Promise<boolean>,
  projection?: GenerationWatchDeliveryProjection,
  canResume?: () => Promise<boolean>): Promise<GenerationNoticeDelivery> {
  signal?.throwIfAborted()
  if (groupOrigin !== undefined || groupReceiptId !== undefined) {
    throw new Error('Archived Bot group notices require manual ownership review')
  }
  if (verifySession === undefined) return 'pending'
  if (!await verifySession(sessionId)) return 'needs-review'
  signal?.throwIfAborted()
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('Generation watch delivery requires the Host session controller')
  const resolved = await controller.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  signal?.throwIfAborted()
  const { agent } = resolved
  if (agent.session.id !== sessionId || !await verifySession(sessionId)) return 'needs-review'
  signal?.throwIfAborted()
  if (projection === undefined) throw new Error('Generation watch delivery projection is not registered')
  let prior = projection.stateOf(agent.session)
  const messageId = MessageId(notice.id)
  const modeRequiresBinding = ctx.get('agentLoop')?.config.durableInboxClaims === true
  const checkBinding = prior.notices[notice.id] === 'guard-rejected'
    || (prior.notices[notice.id] === 'queued' && (canResume !== undefined || modeRequiresBinding))
    || (prior.notices[notice.id] === undefined && modeRequiresBinding)
  if (checkBinding) {
    if (canResume === undefined || !await canResume()) return 'pending'
    signal?.throwIfAborted()
    if (!await verifySession(sessionId)) return 'needs-review'
    signal?.throwIfAborted()
    prior = projection.stateOf(agent.session)
  }
  const alreadyQueued = agent.inbox.nextTurn.some(message => message.id === messageId)
    || agent.inbox.nextStep.some(message => message.id === messageId)
  if (prior.notices[notice.id] === undefined || (prior.notices[notice.id] === 'guard-rejected' && !alreadyQueued)) {
    agent.followup(freezeMessage<UserMessage>({ id: messageId, role: 'user',
      content: [{ type: 'text', text: notice.text }],
      source: { kind: sourceKind, form: 'notice', summary: '剧变视频生成结果已核对' } }))
  } else if (prior.notices[notice.id] === 'queued' || prior.notices[notice.id] === 'guard-rejected') {
    if (agent.wakePending === undefined) throw new Error('Generation watch delivery requires a resumable Agent inbox')
    agent.wakePending(messageId)
  }
  const observed = projection.stateOf(agent.session).notices[notice.id]
  const pending = agent.inbox.nextTurn.some(message => message.id === messageId)
    || agent.inbox.nextStep.some(message => message.id === messageId) || agent.status === 'running'
  if (!await ctx.sessions.flush(agent.session)) {
    throw new Error('Session persistence did not acknowledge the generation watch notice')
  }
  if (observed === 'guard-rejected') return 'pending'
  if (observed === 'interrupted' || observed === 'settled' || observed === 'needs-review' || observed === 'unknown') return observed
  return pending || observed === 'running' ? 'pending' : 'needs-review'
}
