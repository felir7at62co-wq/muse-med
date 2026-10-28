/**
 * Stop one agent-loop response when a streamed JSON object repeats one member
 * name beyond the deployment's explicit limit. This is a local stream failure,
 * not a provider error. Optional bounded resampling never replays tools.
 * @module @deepseek-ai/dsh-argument-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ArgumentLoopDetector } from './detector.ts'

/** Stable local failure code retained by the existing turn/error contract. */
export const TOOL_ARGUMENT_LOOP = 'TOOL_ARGUMENT_LOOP'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-argument-loop'

/** Activate only with the LLM stream service whose middleware this owns. */
export const inject = ['llm']

/** Deployment policy; the package deliberately supplies no global threshold. */
export interface Config {
  /** Occurrences of one decoded member name within one JSON object that stop a response. */
  repeatedPropertyLimit: number
  /** Maximum fresh responses after local loop failures within one turn; zero disables recovery. */
  recoveryAttempts?: number
}

/** Require an explicit threshold in the mounting composition. */
export const Config: z<Config> = z.object({
  repeatedPropertyLimit: z.number().required(),
  recoveryAttempts: z.number().default(0),
})

/** One request's detector state; separate tool-call indexes never share keys. */
class ResponseDetector {
  private readonly pending = new Map<number, ArgumentLoopDetector>()
  private readonly closed = new Set<number>()

  constructor(private readonly limit: number) {}

  /** Match canonical first-block-end behavior without counting full arguments twice. */
  observe(chunk: StreamChunk): boolean {
    if (chunk.type === 'tool-call-delta' && !this.closed.has(chunk.index)) {
      let detector = this.pending.get(chunk.index)
      if (detector === undefined) {
        detector = new ArgumentLoopDetector(this.limit)
        this.pending.set(chunk.index, detector)
      }
      return detector.push(chunk.argumentsDelta) !== undefined
    }
    if (chunk.type !== 'block-end' || this.closed.has(chunk.index)) return false
    this.closed.add(chunk.index)
    this.pending.delete(chunk.index)
    // Block-end-only adapters and authoritative full arguments are checked as
    // their own complete prefix, not appended again to accumulated deltas.
    return chunk.block.type === 'tool-call'
      && new ArgumentLoopDetector(this.limit).push(chunk.block.arguments) !== undefined
  }
}

/**
 * Install a request-local stream guard; the consumer owns upstream cancellation
 * and iterator cleanup. Recovery resamples only an unsettled request; disposal
 * cancels and awaits any pending recovery before it can dispatch another request.
 * @param ctx - plugin context; disposal removes the middleware registration.
 * @param config - explicit deployment threshold, validated before any request.
 */
export function apply(ctx: Context, config: Config): void {
  const limit = config.repeatedPropertyLimit
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new Error('tool-argument-loop: repeatedPropertyLimit must be an explicit safe integer >= 2')
  }
  const recoveryAttempts = config.recoveryAttempts ?? 0
  if (!Number.isSafeInteger(recoveryAttempts) || recoveryAttempts < 0) {
    throw new Error('tool-argument-loop: recoveryAttempts must be a non-negative safe integer')
  }
  const recoveries = new WeakMap<AbortSignal, { agent: Agent; attempts: number; pending: boolean }>()
  const pending = new Map<AbortSignal, Agent>()
  let active = true
  ctx.effect(function* () {
    const forgetPending = (agent: Agent): void => {
      for (const [signal, owner] of pending) if (owner === agent) pending.delete(signal)
    }
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') forgetPending(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { forgetPending(agent) })
    ctx.on('agent/request', ({ agent, signal }, next) => {
      if (!recoveries.has(signal)) recoveries.set(signal, { agent, attempts: 0, pending: false })
      return next()
    })
    ctx.on('agent/request-error', ({ failure, signal }, next): Promise<RequestErrorAction> => {
      const recovery = recoveries.get(signal)
      if (failure.code !== TOOL_ARGUMENT_LOOP || recovery?.pending !== true) return next()
      recovery.pending = false
      signal.throwIfAborted()
      if (!active) throw new LlmError(failure.message, TOOL_ARGUMENT_LOOP)
      return Promise.resolve({ kind: 'retry' })
    }, { prepend: true })
    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options)) return next()
      return (async function* (): AsyncIterable<StreamChunk> {
        const signal = options.signal
        const recovery = signal === undefined ? undefined : recoveries.get(signal)
        if (recovery !== undefined) recovery.pending = false
        const recovering = signal !== undefined && pending.has(signal)
        const detector = new ResponseDetector(limit)
        let repeated = false
        try {
          for await (const chunk of next()) {
            repeated = detector.observe(chunk)
            // Preserve the exact received triggering chunk in assistant/attempt.
            // The loop cannot dispatch tools until the response settles normally.
            yield chunk
            if (repeated) break
          }
        } finally {
          if (recovering) pending.delete(signal)
        }
        if (!repeated) return
        const message = `Tool arguments repeated one JSON member ${limit} times in the same object. `
          + 'The incomplete response was stopped; earlier completed work is retained. '
          + 'No tool from this response was executed'
        if (active && signal !== undefined && !signal.aborted && recovery !== undefined
          && recovery.attempts < recoveryAttempts) {
          recovery.attempts++
          recovery.pending = true
          pending.set(signal, recovery.agent)
          // The upstream iterator has closed before the loop settles this failed
          // attempt and requests recovery; partial calls never enter tool history.
          yield { type: 'finish', reason: { kind: 'error', failure: { code: TOOL_ARGUMENT_LOOP, message: `${message}.` } } }
          return
        }
        // Exhaustion stays outside provider retry semantics, including always.
        throw new LlmError(`${message} and no automatic recovery was requested.`, TOOL_ARGUMENT_LOOP)
      })()
    }, { prepend: true })
    yield async () => {
      active = false
      const waits: Promise<void>[] = []
      for (const [signal, agent] of pending) {
        if (!signal.aborted) agent.cancel({ kind: 'parent' })
        waits.push(agent.whenIdle())
      }
      await Promise.allSettled(waits)
      pending.clear()
    }
  }, 'tool-argument-loop: abort and drain pending recovery')
}
