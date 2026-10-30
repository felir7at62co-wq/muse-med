/** Working-budget instances admit only agents inside their own event scope. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Shared provider transport records actual ordinary calls from sibling scopes. */
class ScopedBudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 10_000 }, defaultMaxTokens: 128 })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) throw new Error('Fresh scoped sessions have no history to summarize')
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SCOPED_WORK_COMPLETE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('keeps sibling scoped budgets independent while sharing the same model runtime', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new ScopedBudgetAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const observedRequests = { small: 0, roomy: 0 }

  const make = async (name: 'small' | 'roomy', workingTokenLimit: number) => {
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(`budget-scope-${name}`),
      agentOptions: { provider: 'mock', model: 'shared' },
      async setup(agentCtx) {
        agentCtx.on('agent/request', (_event, next) => {
          observedRequests[name]++
          return next()
        })
        await agentCtx.isolate('compaction').plugin(BasicCompactionEngine, {
          thresholdRatio: 0.9, workingTokenLimit, headroomTokens: 0, retainTokens: 0,
          maxTokens: 32, maxOverflowRetries: 1,
        })
      },
    })
    return agent
  }
  const small = await make('small', 1_000)
  const roomy = await make('roomy', 5_000)
  const task = `CURRENT_SCOPED_TASK; ${'X'.repeat(8_000)}`

  // This fixture owns every follow-up until the next whole-agent idle boundary.
  roomy.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await roomy.whenIdle()
  expect(observedRequests).toEqual({ small: 0, roomy: 1 })
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.sessionId).toBe(roomy.session.id)
  expect(roomy.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
    .toEqual({ kind: 'completed' })

  small.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await small.whenIdle()
  expect(observedRequests).toEqual({ small: 1, roomy: 1 })
  expect(adapter.requests).toHaveLength(1)
  expect(small.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'WORKING_CONTEXT_LIMIT' } })

  const { agent: unmanaged } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('budget-scope-unmanaged'), agentOptions: { provider: 'mock', model: 'shared' },
  })
  unmanaged.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await unmanaged.whenIdle()
  expect(observedRequests).toEqual({ small: 1, roomy: 1 })
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.sessionId).toBe(unmanaged.session.id)
  expect(unmanaged.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
    .toEqual({ kind: 'completed' })
})
