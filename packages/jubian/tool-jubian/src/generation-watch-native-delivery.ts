/** Native Session continuation held by the original execution owners. */
import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { acquireGenerationSessionBinding } from './generation-binding.ts'
import type { GenerationExecutionLease, GenerationSessionBinding } from './generation-binding.ts'
import { recordedSubmissionBinding } from './generation-watch-attestor.ts'
import { deliverGenerationWatchNotice } from './generation-watch-delivery.ts'
import type { GenerationNoticeDelivery, GenerationWatchDeliveryProjection } from './generation-watch-delivery.ts'
import type { GenerationWatchGroupOrigin, GenerationWatchNotice, GenerationWatchRun } from './generation-watch-store.ts'

interface HeldContinuation {
  agent: Agent
  binding: GenerationSessionBinding
  lease: GenerationExecutionLease
  release(): void
}

/** One effect-owned native watcher delivery operation. */
export type NativeGenerationDelivery = (sessionId: SessionId, notice: GenerationWatchNotice, signal: AbortSignal,
  groupOrigin?: GenerationWatchGroupOrigin, groupReceiptId?: string, run?: GenerationWatchRun) => Promise<GenerationNoticeDelivery>

const sourceKind = 'jubian-generation-watch'
const isConversation = (request: { purpose?: string }): boolean => request.purpose === undefined

/**
 * Guard pending and running automatic work at actual request and tool dispatch.
 * @param ctx - The real native Host with owned Workspace storage and Session controller.
 * @param projection - Durable notice receipt reader.
 * @returns Native delivery; missing historical proof remains pending.
 */
export function createNativeGenerationDelivery(ctx: Context, projection: GenerationWatchDeliveryProjection): NativeGenerationDelivery {
  const held = new Map<SessionId, HeldContinuation>()
  const notices = new Map<SessionId, { agent: Agent; ids: Set<string> }>()
  const inFlight = new Set<Promise<GenerationNoticeDelivery>>()
  const lifetime = new AbortController()
  let closing = false
  const isClosing = () => closing || ctx.fiber.state === FiberState.UNLOADING || ctx.fiber.state === FiberState.DISPOSED
  const assertOpen = () => {
    if (isClosing()) throw new Error('GENERATION_WATCH_BINDING_CHANGED: automatic continuation producer unloaded')
  }
  const forgetFinished = (agent: Agent) => {
    const owned = notices.get(agent.id)
    if (owned === undefined) return
    const state = projection.stateOf(agent.session)
    for (const id of owned.ids) {
      const pending = agent.inbox.nextTurn.some(message => message.id === id) || agent.inbox.nextStep.some(message => message.id === id)
      if (!pending && state.notices[id] !== 'queued' && state.notices[id] !== 'running' && state.notices[id] !== 'guard-rejected') owned.ids.delete(id)
    }
    if (owned.ids.size === 0) notices.delete(agent.id)
  }
  const park = (agent: Agent, ids: Set<string>) => {
    for (const id of ids) {
      if (agent.inbox.remove(MessageId(id))) agent.session.append('jubian/generation-notice-parked', { id })
    }
  }
  let teardownError: AggregateError | undefined
  ctx.effect(function* () {
    yield () => { if (teardownError !== undefined) throw teardownError }
    yield ctx.on('agent/pre-step', async ({ agent, messages, modelSelection }, next) => {
      const current = held.get(agent.session.id)
      if (current === undefined) {
        if (messages.some(message => message.source.kind === sourceKind)) {
          throw new Error('GENERATION_WATCH_BINDING_CHANGED: original native execution binding is not held')
        }
        return next()
      }
      assertOpen()
      current.lease.assertCurrent()
      if (!isDeepStrictEqual(modelSelection, current.binding.model)) throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model changed')
      const result = await next()
      assertOpen()
      current.lease.assertCurrent()
      return result
    }, { prepend: true })
    yield ctx.on('agent/request', async ({ agent }, next) => {
      const current = held.get(agent.session.id)
      if (current !== undefined) { assertOpen(); current.lease.assertCurrent() }
      const result = await next()
      if (current !== undefined) { assertOpen(); current.lease.assertCurrent() }
      return result
    }, { prepend: true })
    yield ctx.on('llm/stream', async function* (options, next) {
      const current = options.sessionId === undefined ? undefined : held.get(options.sessionId)
      if (current === undefined) { yield* next(); return }
      assertOpen()
      current.lease.assertCurrent()
      if (isConversation(options) && (options.provider !== current.binding.model.provider
        || options.model !== current.binding.model.model
        || current.binding.model.reasoningEffort !== undefined && options.reasoningEffort !== current.binding.model.reasoningEffort)) {
        throw new Error('GENERATION_WATCH_BINDING_CHANGED: original model request changed')
      }
      for await (const chunk of next()) {
        assertOpen()
        current.lease.assertCurrent()
        yield chunk
      }
    }, { prepend: true })
    yield ctx.tools.guard((exec) => {
      const current = exec.agent === undefined ? undefined : held.get(exec.agent.session.id)
      if (current === undefined) return undefined
      try { assertOpen(); current.lease.assertCurrent(); return undefined }
      catch (error) { return `GENERATION_WATCH_BINDING_CHANGED: ${String(error)}` }
    })
    yield ctx.on('tools/execute', async (exec, next) => {
      const current = exec.agent === undefined ? undefined : held.get(exec.agent.session.id)
      if (current === undefined) return next()
      assertOpen()
      current.lease.assertCurrent()
      const original = exec.signal
      exec.signal = AbortSignal.any([original, current.lease.signal])
      try { return await next() } finally { exec.signal = original }
    }, { prepend: true })
    yield ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !closing) { held.get(agent.session.id)?.release(); forgetFinished(agent) }
    })
    yield ctx.effect(() => async () => {
      closing = true
      const retained = [...held.values()]
      const running = retained.filter(current => current.agent.status === 'running')
      const failures: unknown[] = []
      for (const owned of notices.values()) {
        try { park(owned.agent, owned.ids) } catch (error) { failures.push(error) }
      }
      lifetime.abort(new Error('Automatic continuation producer unloaded'))
      for (const current of running) current.agent.cancel({ kind: 'hook', reason: 'Automatic continuation producer unloaded' }, { keepInbox: true })
      await Promise.allSettled([...inFlight])
      try {
        const settled = await Promise.allSettled(running.map(current => current.agent.whenIdle()))
        for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
        for (const owned of notices.values()) {
          try {
            park(owned.agent, owned.ids)
            if (!await ctx.sessions.flush(owned.agent.session)) throw new Error('Automatic continuation parking did not persist')
          } catch (error) { failures.push(error) }
        }
      } finally {
        for (const current of retained) current.release()
        notices.clear()
      }
      if (failures.length > 0) teardownError = new AggregateError(failures, 'Automatic continuation parking failed')
    })
  }, 'generation.nativeDelivery')

  const deliver: NativeGenerationDelivery = async (sessionId, notice, signal, groupOrigin, groupReceiptId, run) => {
    signal.throwIfAborted()
    if (isClosing()) return 'pending'
    if (run?.binding === undefined || run.sessionId !== sessionId || groupOrigin !== undefined || groupReceiptId !== undefined) return 'needs-review'
    if (ctx.get('agentLoop')?.config.durableInboxClaims !== true) return 'pending'
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    signal.throwIfAborted()
    assertOpen()
    const { agent } = resolved
    const prior = projection.stateOf(agent.session).notices[notice.id]
    if (prior === 'settled' || prior === 'unknown' || prior === 'interrupted' || prior === 'needs-review') {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('Generation notice settlement did not persist')
      return prior
    }
    const binding = run.binding
    if (!await ctx.sessions.flush(agent.session)) throw new Error('Original video submission did not persist')
    const before = await ctx.sessionPersistence.stat(sessionId)
    if (before === undefined) return 'pending'
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      if (run.packs.some(pack => !isDeepStrictEqual(binding, recordedSubmissionBinding(events, handle.inheritedEventCount,
        { runId: run.id, sessionId, key: pack.key, previewPath: pack.previewPath })))) return 'pending'
      const after = await ctx.sessionPersistence.stat(sessionId)
      if (after === undefined || after.revision !== before.revision) return 'pending'
    } finally { await handle.close() }
    signal.throwIfAborted()
    assertOpen()
    let current = held.get(sessionId)
    if (current !== undefined && (current.agent !== agent || !isDeepStrictEqual(current.binding, binding))) return 'pending'
    if (current === undefined) {
      const lease = await acquireGenerationSessionBinding(ctx, agent, binding, signal)
      if (lease === undefined) return 'pending'
      if (isClosing() || signal.aborted) { lease.release(); signal.throwIfAborted(); assertOpen() }
      let active = true
      const cancel = () => { if (active && !isClosing()) agent.cancel({ kind: 'hook', reason: 'Original generation binding was revoked' }, { keepInbox: true }) }
      const release = () => {
        if (!active) return
        active = false
        if (held.get(sessionId)?.lease === lease) held.delete(sessionId)
        lease.signal.removeEventListener('abort', cancel)
        lease.release()
      }
      current = { agent, binding, lease, release }
      held.set(sessionId, current)
      lease.signal.addEventListener('abort', cancel, { once: true })
      if (lease.signal.aborted) cancel()
    }
    let owned = notices.get(sessionId)
    if (owned === undefined) { owned = { agent, ids: new Set() }; notices.set(sessionId, owned) }
    owned.ids.add(notice.id)
    const bindingStillHeld = () => { assertOpen(); current.lease.assertCurrent(); return Promise.resolve(true) }
    try {
      assertOpen()
      current.lease.assertCurrent()
      return await deliverGenerationWatchNotice(ctx, sessionId, notice, signal, undefined, undefined,
        bindingStillHeld, projection, bindingStillHeld)
    } catch (error) {
      current.release()
      throw error
    } finally { if (!closing && agent.status === 'idle') forgetFinished(agent) }
  }
  return (sessionId, notice, signal, groupOrigin, groupReceiptId, run) => {
    const operation = deliver(sessionId, notice, AbortSignal.any([signal, lifetime.signal]), groupOrigin, groupReceiptId, run)
    inFlight.add(operation)
    void operation.finally(() => inFlight.delete(operation))
      .catch((_error: unknown) => { /* The caller receives the operation failure. */ })
    return operation
  }
}
