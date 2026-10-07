/** Continue settled output-limited responses through the agent's normal next-step input. */

import { createHash } from 'node:crypto'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ContinuationConfig } from './types.ts'
export type { OutputContinuationSource } from './types.ts'

/** Deployment limits for continuing one output-limited turn. */
export interface Config extends ContinuationConfig {}

/** Loader identity for automatic output continuation. */
export const name = 'agent-output-continuation'
/** Agent registry owns the exact live instances receiving continuation input. */
export const inject = ['agents']
/** Validated deployment policy; no progressing-request cap is imposed by default. */
export const Config = z.object({
  maxContinuations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  maxNoProgressResponses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(2),
  repeatWindowChars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(16384),
  continuationTailChars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1024),
}).strict().prefault({})

/** Model-visible continuation instruction, recorded as ordinary admitted context. */
const PROMPT = 'Your previous response was cut off before it finished. Continue exactly from where it stopped. '
  + 'Do not repeat the previous text or restart the answer. Complete the original request. '
  + 'If the response ended mid-sentence or mid-line, write only its missing suffix first; do not skip the unfinished item. '
  + 'If a tool call was cut off, issue the complete call again before claiming its action happened. '
  + 'Stop normally when the answer or required work is complete.'

interface State {
  turn: number
  finish: FinishReason['kind'] | undefined
  attempts: number
  admitted: boolean
  noProgress: number
  fingerprint: string | undefined
  tail: string
  responseEnd: string
  pendingId: MessageId | undefined
}

function fresh(turn: number): State {
  return { turn, finish: undefined, attempts: 0, admitted: false, noProgress: 0, fingerprint: undefined, tail: '', responseEnd: '', pendingId: undefined }
}

/** Last reported finish of the exact durable assistant attempt. */
function finishOf(data: SessionEventMap['assistant/message']): FinishReason['kind'] | undefined {
  for (const record of data.stream.toReversed()) {
    if (record.type === 'chunk' && record.chunk.type === 'finish') return record.chunk.reason.kind
  }
  return undefined
}

/**
 * Install same-turn continuation, admission fences and output-recovery reporting.
 * @param ctx - owning plugin context; disposal withdraws callbacks and queued continuation input.
 * @param config - deployment limits, validated at activation.
 */
export function apply(ctx: Context, config: Config): void {
  const policy = Config.parse(config)
  const states = new WeakMap<Agent, State>()
  const active = (signal: AbortSignal): boolean => ctx.fiber.state === FiberState.ACTIVE && !signal.aborted
  const removePending = (agent: Agent): void => {
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (message.source.kind === 'output-continuation') agent.inbox.remove(message.id)
    }
  }
  ctx.effect(() => () => { for (const agent of ctx.agents.list()) removePending(agent) })
  ctx.on('agent/created', ({ agent }) => { removePending(agent) })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') removePending(agent) })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'output-continuation' && agent.inbox.nextTurn.length > 0) removePending(agent)
  })
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return
    if (event.type === 'turn/start') {
      states.set(agent, fresh(event.data.turn))
      return
    }
    const state = states.get(agent)
    if (state === undefined) return
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'output-continuation') {
        state.admitted = true
        state.pendingId = undefined
      }
      else if (event.data.source.kind === 'user') states.set(agent, fresh(state.turn))
      return
    }
    if (event.type !== 'assistant/message' || event.data.turn !== state.turn) return
    state.finish = event.data.interrupted === true ? 'aborted' : finishOf(event.data)
    if (state.finish !== 'max-tokens') return
    const visible = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    state.responseEnd = visible.slice(-policy.continuationTailChars)
    const text = visible.trim()
    const fingerprint = createHash('sha256').update(text).digest('hex')
    const repeated = text.length === 0 || fingerprint === state.fingerprint || state.tail.includes(text)
    state.noProgress = repeated ? state.noProgress + 1 : 0
    state.fingerprint = fingerprint
    state.tail = (state.tail + text).slice(-policy.repeatWindowChars)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = states.get(agent)
    const humanInput = decision.messages.some(message => message.source.kind === 'user')
    return { ...decision, messages: decision.messages.filter((message) => {
      if (message.source.kind !== 'output-continuation') return true
      return active(signal) && !humanInput && agent.inbox.nextTurn.length === 0 && state?.turn === turn
        && message.id === state.pendingId
    }) }
  }, { prepend: true })
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = states.get(agent)
    if (!active(signal) || state?.turn !== turn || state.finish !== 'max-tokens'
      || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0 || state.noProgress >= policy.maxNoProgressResponses
      || policy.maxContinuations !== null && state.attempts >= policy.maxContinuations) return
    const attempt = state.attempts + 1
    const text = `${PROMPT}\n\nExact end of the interrupted response (JSON string): ${JSON.stringify(state.responseEnd)}`
    const message = createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'output-continuation' } })
    agent.inject(message)
    state.attempts = attempt
    state.pendingId = message.id
    if (!active(signal)) agent.inbox.remove(message.id)
  })
  ctx.on('agent/output-limit-recovered', async ({ agent, turn, signal }, next) => {
    const recovered = await next()
    const state = states.get(agent)
    return recovered || active(signal) && state?.turn === turn && state.admitted
      && (state.finish === 'stop' || state.finish === 'tool-calls')
  })
}
