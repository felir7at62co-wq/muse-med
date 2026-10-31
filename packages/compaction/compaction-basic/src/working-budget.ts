/**
 * Final request admission for an optional estimated working-context budget.
 * Local recovery rebuilds logged history rather than forwarding a stale request.
 * @module @deepseek-ai/dsh-compaction-basic/working-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import { resolveTargetPolicy } from './config.ts'
import type { ResolvedConfig } from './types.ts'

/** Local admission failure; provider-supplied copies do not authorize recovery. */
export const WORKING_CONTEXT_LIMIT = 'WORKING_CONTEXT_LIMIT'

interface WorkingRequest {
  readonly agent: Agent
  readonly step: number
  readonly previousNodes: ReadonlySet<SessionSeq>
  protectedNodes: readonly SessionSeq[]
  limit?: number
  attempts: number
  pending: boolean
  terminal: boolean
}

/**
 * Refuse oversized finalized conversation requests and recover only witnessed
 * local failures. Auxiliary calls and routes without a working limit delegate
 * unchanged. Disposal cancels and drains active compaction before returning.
 * @param ctx - compaction plugin context owning reversible listeners.
 * @param config - validated defaults and exact-target policies.
 * @param compact - pressure compaction operation with protected inputs and the effective admission limit.
 */
export function registerWorkingBudget(
  ctx: Context,
  config: ResolvedConfig,
  compact: (
    agent: Agent, signal: AbortSignal, protectedNodes: readonly SessionSeq[], effectiveLimit: number,
  ) => Promise<CompactionResult | null>,
): void {
  if (config.workingTokenLimit === undefined
    && config.modelPolicies.every(policy => policy.workingTokenLimit === undefined)) return
  const requests = new WeakMap<AbortSignal, WorkingRequest>()
  const pending = new Map<AbortSignal, Agent>()
  let active = true
  const stopped = (): LlmError => new LlmError(
    'Working context could not be reduced below its configured budget. '
    + 'Existing work is retained; use file references or reduce the latest input and try again.',
    WORKING_CONTEXT_LIMIT,
  )

  ctx.effect(function* () {
    ctx.on('agent/request', ({ agent, step, signal }, next) => {
      const previous = requests.get(signal)
      if (previous?.agent !== agent || previous.step !== step) {
        requests.set(signal, {
          agent, step, previousNodes: new Set(agent.session.surface.nodes), protectedNodes: [],
          attempts: 0, pending: false, terminal: false,
        })
      }
      return next()
    })

    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next()
      const policy = resolveTargetPolicy(config, options)
      const limit = policy.workingTokenLimit
      if (limit === undefined) return next()
      return (async function* (): AsyncIterable<StreamChunk> {
        const signal = options.signal
        signal?.throwIfAborted()
        const request = signal === undefined ? undefined : requests.get(signal)
        // Agent events are scoped; a sibling preset can share this LLM service.
        if (request === undefined) {
          yield* next()
          return
        }
        if (!active || request.agent.session.id !== options.sessionId) throw stopped()
        if (request.terminal) throw stopped()
        let effectiveLimit = limit
        if (policy.adaptiveBudget) {
          const info = await ctx.llm.resolveModelInfo(options.provider, options.model, signal)
          signal?.throwIfAborted()
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can occur while model metadata resolves.
          if (!active) throw stopped()
          if (info.context !== undefined) {
            const available = info.context.contextWindow - (options.maxTokens ?? info.defaultMaxTokens ?? 0)
            if (available <= 0) throw stopped()
            const headroom = policy.headroomTokens >= available
              ? Math.floor(available * policy.thresholdRatio)
              : policy.headroomTokens
            effectiveLimit = Math.min(limit, available - headroom)
          }
        }
        request.limit = effectiveLimit
        if (ctx.tokenMeter.measureWorkingContext(request.agent.session).totalTokens < effectiveLimit) {
          yield* next()
          return
        }
        if (request.attempts >= policy.maxOverflowRetries) throw stopped()
        request.protectedNodes = request.agent.session.surface.nodes.filter(seq => !request.previousNodes.has(seq))
        request.pending = true
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: WORKING_CONTEXT_LIMIT,
              message: 'Estimated working context exceeds its configured budget; history must be compacted before sending.',
            },
          },
        }
      })()
    }, { prepend: true })

    ctx.on('agent/request-error', async ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
      const request = requests.get(signal)
      if (failure.code !== WORKING_CONTEXT_LIMIT || request?.pending !== true || request.agent !== agent) return next()
      request.pending = false
      request.attempts++
      signal.throwIfAborted()
      const header = agent.session.requestHeader()
      if (header === undefined) {
        request.terminal = true
        throw stopped()
      }
      const policy = resolveTargetPolicy(config, header.config)
      const limit = request.limit
      if (!active || limit === undefined || request.attempts > policy.maxOverflowRetries) {
        request.terminal = true
        throw stopped()
      }
      const generation = agent.session.surface.replaceGeneration
      pending.set(signal, agent)
      try {
        await compact(agent, signal, request.protectedNodes, limit)
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can run while compaction is awaited.
        if (!active || agent.session.surface.replaceGeneration <= generation
          || ctx.tokenMeter.measureWorkingContext(agent.session).totalTokens >= limit) throw stopped()
        const flushed = await ctx.sessions.flush(agent.session)
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can run while persistence is awaited.
        if (!active || !flushed) throw stopped()
        return { kind: 'retry' }
      } catch (_error: unknown) {
        request.terminal = true
        signal.throwIfAborted()
        // Local recovery failures never expose summarizer or credential details.
        throw stopped()
      } finally {
        pending.delete(signal)
      }
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
  }, 'working-context: cancel and drain pending compaction')
}
