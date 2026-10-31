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
import { assertNoActiveCompaction, CompactionCommitError } from './region.ts'
import type { ResolvedConfig } from './types.ts'

/** Local admission failure; provider-supplied copies do not authorize recovery. */
export const WORKING_CONTEXT_LIMIT = 'WORKING_CONTEXT_LIMIT'

interface WorkingRequest {
  readonly agent: Agent
  readonly step: number
  readonly previousNodes: ReadonlySet<SessionSeq>
  protectedNodes: readonly SessionSeq[]
  limit?: number
  safeInputBudget?: number
  attempts: number
  pending: boolean
  terminal: boolean
  useExistingContext: boolean
}

/** Fixed failures distinguish capacity, summary and durability without exposing upstream details. */
function stopped(kind: 'capacity' | 'summary' | 'persistence' | 'unavailable'): LlmError {
  switch (kind) {
    case 'capacity':
      return new LlmError('The request exceeds the model\'s estimated safe input budget and could not be reduced. Existing work is retained; compact again or reduce attached context.', WORKING_CONTEXT_LIMIT)
    case 'summary':
      return new LlmError('Summarization is unavailable and the request exceeds the model\'s estimated safe input budget. Existing work is retained; retry when summarization is available.', 'COMPACTION_UNAVAILABLE')
    case 'persistence':
      return new LlmError('The context checkpoint could not be saved. Existing work is retained; retry after storage is available.', 'COMPACTION_PERSISTENCE_FAILED')
    case 'unavailable':
      return new LlmError('The model\'s safe input budget is unavailable. Existing work is retained; check the model capacity and output reservation.', 'CONTEXT_BUDGET_UNAVAILABLE')
  }
}

/**
 * Compact finalized requests above their working target. Retained context may
 * continue below the calibrated model budget after output and headroom are reserved.
 * Auxiliary calls delegate unchanged; disposal cancels and drains active recovery.
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
  const requests = new WeakMap<AbortSignal, WorkingRequest>()
  const pending = new Map<AbortSignal, Agent>()
  let active = true

  ctx.effect(function* () {
    ctx.on('agent/request', ({ agent, step, signal }, next) => {
      const previous = requests.get(signal)
      if (previous?.agent !== agent || previous.step !== step) {
        requests.set(signal, {
          agent, step, previousNodes: new Set(agent.session.surface.nodes), protectedNodes: [],
          attempts: 0, pending: false, terminal: false, useExistingContext: false,
        })
      }
      return next()
    })

    ctx.on('llm/stream', (options, next) => {
      if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next()
      return (async function* (): AsyncIterable<StreamChunk> {
        const signal = options.signal
        signal?.throwIfAborted()
        const request = signal === undefined ? undefined : requests.get(signal)
        // Agent events are scoped; a sibling preset can share this LLM service.
        if (signal === undefined || request === undefined) {
          yield* next()
          return
        }
        if (!active || request.agent.session.id !== options.sessionId || request.terminal) throw stopped('unavailable')
        const policy = resolveTargetPolicy(config, options)
        const limit = policy.workingTokenLimit
        if (limit === undefined) {
          yield* next()
          return
        }
        const previousContext = request.agent.session.requestContext()
        let effectiveLimit = limit
        pending.set(signal, request.agent)
        const info = await ctx.llm.resolveModelInfo(options.provider, options.model, signal)
          .finally(() => { pending.delete(signal) })
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can occur while model metadata resolves.
        if (!active) throw stopped('unavailable')
        delete request.safeInputBudget
        if (info.context !== undefined) {
          const window = info.context.contextWindow
          const reserved = options.maxTokens ?? info.defaultMaxTokens ?? 0
          if (!Number.isInteger(window) || window <= 0 || !Number.isInteger(reserved) || reserved < 0) throw stopped('unavailable')
          const available = window - reserved
          if (available <= 0) throw stopped('unavailable')
          const headroom = policy.adaptiveBudget && policy.headroomTokens >= available
            ? Math.floor(available * policy.thresholdRatio)
            : policy.headroomTokens
          request.safeInputBudget = available - headroom
          if (request.safeInputBudget <= 0) throw stopped('unavailable')
          effectiveLimit = Math.min(limit, request.safeInputBudget)
        }
        request.limit = effectiveLimit
        const measured = ctx.tokenMeter.measureWorkingContext(request.agent.session).totalTokens
        if (previousContext?.workingTokenLimit !== effectiveLimit || previousContext.workingContextTokens !== measured) {
          request.agent.session.append('request/context', {
            ...previousContext, provider: options.provider, model: options.model,
            ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
            workingTokenLimit: effectiveLimit, workingContextTokens: measured,
          })
        }
        const belowSafeBudget = request.safeInputBudget !== undefined && measured < request.safeInputBudget
        if (measured < effectiveLimit || (request.useExistingContext && belowSafeBudget)) {
          yield* next()
          return
        }
        if (request.attempts >= policy.maxOverflowRetries) {
          if (belowSafeBudget) { yield* next(); return }
          throw stopped(request.safeInputBudget === undefined ? 'unavailable' : 'capacity')
        }
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
        throw stopped('unavailable')
      }
      const policy = resolveTargetPolicy(config, header.config)
      const limit = request.limit
      if (!active || limit === undefined || request.attempts > policy.maxOverflowRetries) {
        request.terminal = true
        throw stopped('unavailable')
      }
      pending.set(signal, agent)
      try {
        let summaryFailed = false
        try { await compact(agent, signal, request.protectedNodes, limit) }
        catch (error: unknown) {
          signal.throwIfAborted()
          if (error instanceof CompactionCommitError) throw stopped('persistence')
          summaryFailed = true
        }
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can run while compaction is awaited.
        if (!active) throw stopped('unavailable')
        try { assertNoActiveCompaction(agent.session, 'working-context recovery') }
        catch (_error: unknown) { throw stopped('persistence') }
        try {
          const flushed = await ctx.sessions.flush(agent.session)
          signal.throwIfAborted()
          if (!flushed) throw stopped('persistence')
        } catch (_error: unknown) {
          signal.throwIfAborted()
          throw stopped('persistence')
        }
        signal.throwIfAborted()
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can run while persistence is awaited.
        if (!active) throw stopped('unavailable')
        const measured = ctx.tokenMeter.measureWorkingContext(agent.session).totalTokens
        const context = agent.session.requestContext()
        if (context?.workingTokenLimit !== limit || context.workingContextTokens !== measured) {
          agent.session.append('request/context', {
            ...context, provider: header.config.provider, model: header.config.model,
            workingTokenLimit: limit, workingContextTokens: measured,
          })
        }
        if (measured < limit) return { kind: 'retry' }
        if (request.safeInputBudget !== undefined && measured < request.safeInputBudget) {
          request.useExistingContext = true
          ctx.logger.warn(`compaction recovery ${summaryFailed ? 'failed' : 'did not reach its target'}; continuing with retained context below the estimated safe request budget`)
          return { kind: 'retry' }
        }
        throw stopped(request.safeInputBudget === undefined ? 'unavailable' : summaryFailed ? 'summary' : 'capacity')
      } catch (error: unknown) {
        request.terminal = true
        signal.throwIfAborted()
        throw error
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
