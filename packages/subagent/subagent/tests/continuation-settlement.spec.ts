import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { continuationActivations } from './continuation-internals.ts'
import { loadStoredSession } from './persistence-helpers.ts'

it('waits for injected context accepted during the final flush', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-final-flush-'))
  const ctx = new Context()
  const releaseFirstTurn = Promise.withResolvers<undefined>()
  const flushing = Promise.withResolvers<undefined>()
  const releaseFlush = Promise.withResolvers<undefined>()
  const context = createUserMessage({
    content: [{ type: 'text', text: 'context accepted during flush' }],
    source: { kind: 'user' },
  })
  let child: Agent | undefined
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const adapter = new MockAdapter([textResponse('child answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === parent) return { kind: 'reject' }
      await releaseFirstTurn.promise
      return next()
    })
    let heldFinalFlush = false
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession !== parent.id || heldFinalFlush) return
      heldFinalFlush = true
      flushing.resolve(undefined)
      await releaseFlush.promise
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    child = ctx.agents.get(started.childId)!
    releaseFirstTurn.resolve(undefined)
    await flushing.promise
    // The first readiness check passed before this context entered the Inbox.
    const activation = continuationActivations(ctx).get(started.childId)!
    const pendingChecks = vi.spyOn(activation.inbox, 'hasPending', 'get')
    child.inject(context)
    releaseFlush.resolve(undefined)
    await vi.waitFor(() => { expect(pendingChecks).toHaveReturnedWith(true) })
    expect(pendingChecks).toHaveBeenCalledTimes(1)
    expect(child.status).toBe('idle')
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(child.inbox.nextStep).toEqual([context])
    expect(activation.inbox.closing).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.remove(context.id)).toBe(true)
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'child answer'))).toBe(true)
    expect(loaded.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text'
        && block.text === 'context accepted during flush'))).toBe(false)
  } finally {
    releaseFirstTurn.resolve(undefined)
    releaseFlush.resolve(undefined)
    child?.inbox.remove(context.id)
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})
