/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
  claim: z.object({ turn: z.number().int().nonnegative(), step: z.number().int().positive(),
    nextStep: z.array(z.custom<UserMessage>()).readonly(), nextTurn: z.array(z.custom<UserMessage>()).readonly() }).optional(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type === 'agent/inbox/claim') {
      if (state.claim !== undefined) throw new Error('a durable inbox claim is already active')
      const { turn, step, nextStep, nextTurn } = event.data
      const steps = state['next-step'].slice(0, nextStep.length)
      const turns = state['next-turn'].slice(0, nextTurn.length)
      if (steps.some((message, i) => message.id !== nextStep[i]) || steps.length !== nextStep.length
        || turns.some((message, i) => message.id !== nextTurn[i]) || turns.length !== nextTurn.length) {
        throw new Error('durable inbox claim does not match pending messages')
      }
      return { 'next-step': state['next-step'].slice(nextStep.length), 'next-turn': state['next-turn'].slice(nextTurn.length),
        claim: { turn, step, nextStep: steps, nextTurn: turns } }
    }
    if (event.type === 'agent/inbox/claim-filtered') {
      const claim = state.claim
      if (claim === undefined || claim.turn !== event.data.turn || claim.step !== event.data.step) throw new Error('unknown durable inbox claim')
      const ids = new Set(event.data.discarded)
      if (ids.size !== event.data.discarded.length
        || [...ids].some(id => ![...claim.nextStep, ...claim.nextTurn].some(message => message.id === id))) {
        throw new Error('invalid durable inbox claim discard')
      }
      return { ...state, claim: { ...claim, nextStep: claim.nextStep.filter(message => !ids.has(message.id)),
        nextTurn: claim.nextTurn.filter(message => !ids.has(message.id)) } }
    }
    if (event.type === 'agent/inbox/claim-settled') {
      const claim = state.claim
      if (claim === undefined || claim.turn !== event.data.turn || claim.step !== event.data.step
        || claim.nextStep.length !== 0 || claim.nextTurn.length !== 0) throw new Error('durable inbox claim is not settled')
      const { claim: _claim, ...pending } = state
      return pending
    }
    if (event.type === 'user/message' && state.claim !== undefined) {
      const claim = state.claim
      return { ...state, claim: { ...claim, nextStep: claim.nextStep.filter(message => message.id !== event.data.id),
        nextTurn: claim.nextTurn.filter(message => message.id !== event.data.id) } }
    }
    if (event.type === 'turn/end' && state.claim?.turn === event.data.turn) {
      const { claim, ...pending } = state
      const dropped = event.data.reason.kind === 'forked'
        || (event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user')
      return dropped ? pending : { ...pending, 'next-step': [...claim.nextStep, ...pending['next-step']],
        'next-turn': [...claim.nextTurn, ...pending['next-turn']] }
    }
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step'], ...state.claim?.nextStep ?? [], ...state.claim?.nextTurn ?? []]
        : [...state['next-turn'], ...next, ...state.claim?.nextStep ?? [], ...state.claim?.nextTurn ?? []]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { ...state, 'next-turn': next }
        : { ...state, 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // Pending messages round-trip the session log as lossless JSON. Claims expose
    // only the identities and positions needed to follow later queue restoration.
    viewSchema: z.object({ 'next-turn': z.array(z.custom<UserMessage>()),
      'next-step': z.array(z.custom<UserMessage>()),
      activeClaim: z.object({ turn: z.number().int().nonnegative(), step: z.number().int().positive(),
        nextStep: z.array(z.custom<MessageId>()).readonly(), nextTurn: z.array(z.custom<MessageId>()).readonly() }).optional(),
    }) as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => ({ 'next-turn': state['next-turn'], 'next-step': state['next-step'],
      ...state.claim === undefined ? {} : { activeClaim: { turn: state.claim.turn, step: state.claim.step,
        nextStep: state.claim.nextStep.map(message => message.id), nextTurn: state.claim.nextTurn.map(message => message.id) } },
    }) as unknown as InboxWireState,
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param readState - reader for the live Inbox projection state.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly readState: () => InboxState,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.readState()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.readState()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.readState()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /** Claim an entire step with one replayable durable event. */
  claimDurably(target: InboxTarget, turn: number, step: number): UserMessage[] {
    const steps = [...this.nextStep]
    const turns = target === 'next-turn' ? this.nextTurn.slice(0, 1) : []
    if (steps.length === 0 && turns.length === 0) return []
    this.session.append('agent/inbox/claim', { turn, step,
      nextStep: steps.map(message => message.id), nextTurn: turns.map(message => message.id) })
    const claimed = [...steps, ...turns]
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /** Record identities intentionally removed by a pre-step decision. */
  filterClaim(turn: number, step: number, kept: readonly UserMessage[]): void {
    const claim = this.readState().claim
    if (claim === undefined) return
    const selected = new Set(kept.map(message => message.id))
    const discarded = [...claim.nextStep, ...claim.nextTurn].filter(message => !selected.has(message.id)).map(message => message.id)
    if (discarded.length > 0) this.session.append('agent/inbox/claim-filtered', { turn, step, discarded })
  }

  /** Close a fully accepted durable step claim. */
  settleClaim(turn: number, step: number): void {
    if (this.readState().claim !== undefined) this.session.append('agent/inbox/claim-settled', { turn, step })
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.readState()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.readState()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.readState()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step'], ...state.claim?.nextStep ?? [], ...state.claim?.nextTurn ?? []]
      : [...state['next-turn'], ...candidate, ...state.claim?.nextStep ?? [], ...state.claim?.nextTurn ?? []]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
