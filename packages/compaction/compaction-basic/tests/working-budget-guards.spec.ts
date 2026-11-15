/** Working-budget admission and recovery at their scoped event entry points. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { WORKING_CONTEXT_LIMIT, registerWorkingBudget } from '../src/working-budget.ts'
import type { BasicCompactionConfig } from '../src/types.ts'

const contexts: Context[] = []
const route = { provider: 'mock', model: 'budget' }
const finish = { type: 'finish', reason: { kind: 'stop' } }
const unavailable = { code: 'CONTEXT_BUDGET_UNAVAILABLE' }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

class BudgetAdapter extends LlmAdapter {
  override resolveModel(): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(1_000))
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function modelInfo(contextWindow?: number, defaultMaxTokens?: number): LlmResolvedModelInfo {
  return {
    provider: route.provider, id: route.model, name: route.model,
    ...contextWindow === undefined ? {} : { context: { contextWindow } },
    ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
  }
}

async function harness(config: BasicCompactionConfig = {}, hasHeader = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.on('session/flush', () => undefined)
  ctx.effect(() => ctx.llm.registerAdapter([route.provider], new BudgetAdapter()))
  const agent = await ctx.agentLoop.create(SessionId('working-budget-guards'), route)
  if (hasHeader) agent.session.append('request/header', { header: { config: route }, reason: 'initial' })

  const compact = vi.fn<Parameters<typeof registerWorkingBudget>[2]>(async () => null)
  const fiber = await ctx.plugin({
    inject: ['llm', 'sessions', 'tokenMeter'],
    apply(owner: Context) {
      registerWorkingBudget(owner, resolveConfig({ headroomTokens: 0, maxTokens: 32, workingTokenLimit: 100, ...config }), compact)
    },
  })
  const controller = new AbortController()
  const events = agentEvents(ctx, agent)
  const { signal } = controller
  const begin = () => events.waterfall('agent/request', { turn: 1, step: 1, signal }, async () => route)
  const stream = (options: Partial<GenerateOptions> = {}, withSignal = true) => ctx.llm.stream(markAgentLoopRequest({
    ...route, sessionId: agent.session.id, ...withSignal ? { signal } : {}, messages: [], ...options,
  }))
  const recover = () => events.waterfall('agent/request-error', {
    turn: 1, step: 1, provider: route.provider, signal, retryPolicy: undefined,
    failure: { code: WORKING_CONTEXT_LIMIT, message: 'local admission required compaction' },
  }, async () => undefined)
  let tokens = 200
  const measure = ctx.tokenMeter.measureWorkingContext.bind(ctx.tokenMeter)
  vi.spyOn(ctx.tokenMeter, 'measureWorkingContext').mockImplementation(session => ({ ...measure(session), totalTokens: tokens }))
  await begin()
  return { ctx, agent, controller, fiber, stream, recover, compact, setTokens: (value: number) => { tokens = value } }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function expectOverBudget(stream: AsyncIterable<StreamChunk>) {
  expect(await collect(stream)).toMatchObject([{ type: 'finish', reason: {
    kind: 'error', failure: { code: WORKING_CONTEXT_LIMIT },
  } }])
}

it('leaves a marked request without a loop signal unclaimed', async () => {
  const { stream, ctx } = await harness()
  const info = vi.spyOn(ctx.llm, 'resolveModelInfo')
  const chunks = await collect(stream({}, false))
  expect(chunks).toEqual([finish])
  expect(info).not.toHaveBeenCalled()
})

it('rejects an admitted signal paired with a different session', async () => {
  const { stream } = await harness()
  await expect(collect(stream({ sessionId: SessionId('unrelated-session') }))).rejects.toMatchObject(unavailable)
})

it.each([
  { reserved: 100, defaultReserved: 200, expectedLimit: 900 },
  { reserved: undefined, defaultReserved: 200, expectedLimit: 800 },
  { reserved: undefined, defaultReserved: undefined, expectedLimit: 1_000 },
])('deduplicates unchanged admission metadata with a $expectedLimit token limit', async ({ reserved, defaultReserved, expectedLimit }) => {
  const { ctx, stream, agent } = await harness({ workingTokenLimit: 2_000 })
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue(modelInfo(1_000, defaultReserved))
  const options = reserved === undefined ? {} : { maxTokens: reserved }
  expect(await collect(stream(options))).toEqual([finish])
  expect(await collect(stream(options))).toEqual([finish])
  expect(agent.session.requestContext()).toMatchObject({ workingTokenLimit: expectedLimit, workingContextTokens: 200 })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'request/context')).toHaveLength(1)
})

it.each([
  { window: 0, reserved: 0, headroom: 0 },
  { window: 1_000, reserved: -1, headroom: 0 },
  { window: 1_000, reserved: 1_000, headroom: 0 },
  { window: 1_000, reserved: 100, headroom: 900 },
])('rejects admission with window $window, reservation $reserved and headroom $headroom', async ({ window, reserved, headroom }) => {
  const { ctx, stream, agent } = await harness({ headroomTokens: headroom })
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue(modelInfo(window, reserved))
  await expect(collect(stream())).rejects.toMatchObject(unavailable)
  expect(agent.session.requestContext()).toBeUndefined()
})

it('admits requests above the working target within known safe capacity when retries are disabled', async () => {
  const { stream, compact } = await harness({ maxOverflowRetries: 0 })
  expect(await collect(stream())).toEqual([finish])
  expect(compact).not.toHaveBeenCalled()
})

it.each([
  { window: 150, code: WORKING_CONTEXT_LIMIT },
  { window: undefined, code: unavailable.code },
])('rejects unsafe or unknown capacity after exhausting the retry allowance ($code)', async ({ window, code }) => {
  const { ctx, stream, compact } = await harness({ maxOverflowRetries: 0 })
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue(modelInfo(window))
  await expect(collect(stream())).rejects.toMatchObject({ code })
  expect(compact).not.toHaveBeenCalled()
})

it('cannot recover without the durable request route and closes that attempt', async () => {
  const { stream, recover, compact } = await harness({}, false)
  await expectOverBudget(stream())
  await expect(recover()).rejects.toMatchObject(unavailable)
  await expect(collect(stream())).rejects.toMatchObject(unavailable)
  expect(compact).not.toHaveBeenCalled()
})

it('uses the current durable route to reject recovery beyond its retry allowance', async () => {
  const { agent, stream, recover, compact } = await harness({ modelPolicies: [{
    provider: route.provider, model: 'no-retry', maxOverflowRetries: 0,
  }] })
  await expectOverBudget(stream())
  agent.session.append('request/header', { header: { config: { ...route, model: 'no-retry' } }, reason: 'change' })
  await expect(recover()).rejects.toMatchObject(unavailable)
  expect(compact).not.toHaveBeenCalled()
})

it('does not retain oversized context when the adapter has no safe capacity estimate', async () => {
  const { ctx, stream, recover, compact } = await harness()
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue(modelInfo())
  await expectOverBudget(stream())
  await expect(recover()).rejects.toMatchObject(unavailable)
  expect(compact).toHaveBeenCalledOnce()
})

it('does not retry after compaction leaves a live durable bracket', async () => {
  const { agent, stream, recover, compact, ctx } = await harness()
  const flush = vi.spyOn(ctx.sessions, 'flush')
  compact.mockImplementationOnce(async () => {
    agent.session.append('compaction/start', { compactionId: CompactionId('unclosed'), turn: null })
    return null
  })
  await expectOverBudget(stream())
  await expect(recover()).rejects.toMatchObject({ code: 'COMPACTION_PERSISTENCE_FAILED' })
  expect(flush).not.toHaveBeenCalled()
})

function barrier<T>() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<T>()
  return {
    wait: () => { entered.resolve(undefined); return released.promise },
    async releaseAfter(operation: Promise<unknown>, value: T, during: () => Promise<unknown>) {
      try {
        await Promise.race([entered.promise, operation])
        await during()
      } finally {
        released.resolve(value)
      }
    },
  }
}

it('cannot forward a stream after disposal while model capacity is being looked up', async () => {
  const { ctx, stream, fiber, agent } = await harness()
  const pending = barrier<LlmResolvedModelInfo>()
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementationOnce(pending.wait)
  const result = collect(stream())
  await Promise.all([
    expect(result).rejects.toMatchObject(unavailable),
    pending.releaseAfter(result, modelInfo(1_000), () => fiber.dispose()),
  ])
  expect(agent.session.requestContext()).toBeUndefined()
})

it('cannot resume a recovery disposed while compaction is running', async () => {
  const { ctx, stream, recover, compact, fiber } = await harness()
  const pending = barrier<null>()
  const flush = vi.spyOn(ctx.sessions, 'flush')
  compact.mockImplementationOnce(pending.wait)
  await expectOverBudget(stream())
  const result = recover()
  await Promise.all([
    expect(result).rejects.toMatchObject(unavailable),
    pending.releaseAfter(result, null, () => fiber.dispose()),
  ])
  expect(flush).not.toHaveBeenCalled()
})

it.each([false, true])('prevents recovery after disposal while a checkpoint is flushing (aborted: %s)', async (aborted) => {
  const { ctx, agent, controller, stream, recover, fiber, setTokens } = await harness()
  const pending = barrier<boolean>()
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(pending.wait)
  const cancel = vi.spyOn(agent, 'cancel')
  await expectOverBudget(stream())
  const result = recover()
  await Promise.all([
    expect(result).rejects.toMatchObject(aborted ? { name: 'AbortError' } : unavailable),
    pending.releaseAfter(result, true, async () => {
      setTokens(25)
      if (aborted) controller.abort()
      await fiber.dispose()
    }),
  ])
  expect(cancel).toHaveBeenCalledTimes(aborted ? 0 : 1)
  expect(agent.session.requestContext()?.workingContextTokens).toBe(200)
})
