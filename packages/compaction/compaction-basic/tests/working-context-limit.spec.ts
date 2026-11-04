/** Final-request working budgets through the production loop and local adapters. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createSystemMessage, createUserMessage, isAgentLoopRequest, LlmAdapter, LlmError, markAgentLoopRequest, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine, { type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveConfig } from '../src/config.ts'
import { summarizeWithLlm } from '../src/summarizer.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Separate auxiliary calls from ordinary requests without any network transport. */
class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  readonly summaryEntered = Promise.withResolvers<undefined>()
  summaryMode: 'success' | 'error' | 'empty' | 'wait-for-abort' = 'success'
  ordinaryFailure: string | undefined
  replies: ('tool' | 'text')[] = []
  onOrdinary: (() => void) | undefined

  constructor(
    private readonly contextWindow = 10_000,
    private readonly alwaysRetry = false,
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === 'unknown-context') return Promise.resolve({ provider, id: model, name: model })
    if (model === 'tiny-route') return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 8_192 }, defaultMaxTokens: 256 })
    if (model === 'small-summary') return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 512 }, defaultMaxTokens: 64 })
    if (model === 'bounded-summary') return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 128_000 }, defaultMaxTokens: 4_096 })
    if (model === 'windowed-summary') return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: 4_000 }, defaultMaxTokens: 4_096 })
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: this.contextWindow }, defaultMaxTokens: 256 })
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.alwaysRetry ? resolveRetryPolicy({ mode: 'always', backoff: {
      initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0,
    } }, 'working-context fixture retryPolicy') : undefined
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction') {
      this.summaries.push(options)
      this.summaryEntered.resolve(undefined)
      if (this.summaryMode === 'error') throw new LlmError('summary unavailable', 'SERVER')
      if (this.summaryMode === 'empty') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (this.summaryMode === 'wait-for-abort') {
        const signal = options.signal
        if (signal === undefined) throw new Error('summary requires its live cancellation signal')
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('summary cancelled')); return }
          signal.addEventListener('abort', () => { reject(new Error('summary cancelled')) }, { once: true })
        })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CHECKPOINT: KEEP_POLICY; stage=prepared.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.requests.push(options)
    this.onOrdinary?.()
    if (this.ordinaryFailure !== undefined) throw new LlmError('provider-owned failure', this.ordinaryFailure)
    if (this.replies.shift() === 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('work-once'), name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'work completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Keep the old surface below 900 estimated tokens until the new input is admitted. */
function historySeed(
  systemHead = true,
  systemText = 'You are an AI agent powered by DeepSeek Harness.',
  anchoredInputTokens?: number,
  messageChars = 600,
): readonly SessionEvent[] {
  const session = Session.create(SessionId('budget-history'))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1 && systemHead) session.append('system/message', { turn, step: 1,
      message: createSystemMessage(systemText),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `OLD_CONTEXT_SENTINEL_${turn}; KEEP_POLICY; ${'H'.repeat(messageChars)}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: 'mock', model: 'limited' } }, reason: 'initial' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: `historical answer ${'A'.repeat(messageChars)}` }],
      source: { kind: 'model', provider: 'mock', model: 'limited' },
    }), ...anchoredInputTokens === undefined ? {} : { usage: { inputTokens: anchoredInputTokens, outputTokens: 1 } } },
    { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

interface FixtureOptions {
  seed?: readonly SessionEvent[]
  model?: string
  contextWindow?: number
  alwaysRetry?: boolean
  durabilityListener?: boolean
  maxTokens?: number
}

async function harness(config: BasicCompactionConfig = {}, options: FixtureOptions = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  // Local acknowledgements exercise ordering; this fixture does not prove disk recovery.
  if (options.durabilityListener !== false) ctx.on('session/flush', () => undefined)
  const adapter = new BudgetAdapter(options.contextWindow, options.alwaysRetry)
  ctx.llm.registerAdapter(['mock'], adapter)
  if (options.alwaysRetry) await ctx.plugin(LlmRetry)
  const compactionFiber = await ctx.plugin(BasicCompactionEngine, {
    thresholdRatio: 0.09, headroomTokens: 0, retainTokens: 600, maxTokens: 64, compactionRetries: 0,
    modelPolicies: [{ provider: 'mock', model: 'limited', workingTokenLimit: 1_000 }],
    ...config,
  })
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('working-budget'), seed: options.seed ?? historySeed(),
    agentOptions: { provider: 'mock', model: options.model ?? 'limited',
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    },
  })
  return { ctx, adapter, agent, compactionFiber }
}

/** This fixture owns one followup-to-idle interval with no other input producer. */
async function send(agent: Agent, text = `LATEST_INPUT; ${'N'.repeat(2_000)}`): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function lastReason(agent: Agent) {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
}

describe('final working-context admission', () => {
  it.each(['error', 'empty'] as const)('continues a normal short input with retained 498K context when the summary is %s', async (mode) => {
    const { agent, adapter } = await harness({ adaptiveBudget: true,
      thresholdRatio: 0.45, headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [{ provider: 'mock', model: 'limited', workingTokenLimit: 475_000 }],
    }, { seed: historySeed(true, undefined, undefined, 498_000), contextWindow: 1_000_000, maxTokens: 393_216 })
    adapter.summaryMode = mode
    await send(agent, '继续下一段内容。')
    expect(adapter.summaries).toHaveLength(2)
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('OLD_CONTEXT_SENTINEL_1')
    expect(request).toContain('继续下一段内容。')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(agent.session.requestContext()).toMatchObject({ contextWindow: 1_000_000, workingTokenLimit: 475_000 })
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('rejects a failed summary above the actual output-reserved input budget', async () => {
    const { agent, adapter } = await harness({ adaptiveBudget: true,
      thresholdRatio: 0.45, headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [{ provider: 'mock', model: 'limited', workingTokenLimit: 475_000 }],
    }, { seed: historySeed(true, undefined, undefined, 498_000), contextWindow: 1_000_000, maxTokens: 600_000 })
    adapter.summaryMode = 'error'
    await send(agent, '继续下一段内容。')
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'COMPACTION_UNAVAILABLE' } })
  })

  it('does not fall back after a failed durability flush when summarization made no replacement', async () => {
    const { ctx, agent, adapter } = await harness()
    adapter.summaryMode = 'error'
    ctx.on('session/flush', () => { throw new Error('storage is unavailable') })
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'COMPACTION_PERSISTENCE_FAILED' } })
  })

  it.each([0, 1.5, 256])('refuses an unusable model context window (%s)', async (window) => {
    const { ctx, agent, adapter } = await harness()
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'mock', id: 'limited', name: 'limited', context: { contextWindow: window }, defaultMaxTokens: 256,
    })
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_BUDGET_UNAVAILABLE' } })
  })

  it('refuses a model window entirely consumed by configured headroom', async () => {
    const { ctx, agent, adapter } = await harness({ adaptiveBudget: false, headroomTokens: 10_000 })
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'mock', id: 'limited', name: 'limited', context: { contextWindow: 5_000 }, defaultMaxTokens: 256,
    })
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_BUDGET_UNAVAILABLE' } })
  })

  it('admits a model with no declared output cap using its full context window', async () => {
    const { agent, adapter } = await harness()
    vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
      provider, id: model, name: model, context: { contextWindow: 10_000 },
    }))
    await send(agent, 'short request')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.maxTokens).toBeUndefined()
    expect(agent.session.requestContext()).toMatchObject({ contextWindow: 10_000, workingTokenLimit: 1_000 })
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('does not duplicate identical measured context supplied earlier in the stream', async () => {
    const { ctx, agent, adapter } = await harness({}, { seed: [] })
    ctx.on('llm/stream', (options, next) => {
      if (isAgentLoopRequest(options) && options.purpose === undefined) {
        const measured = ctx.tokenMeter.measureWorkingContext(agent.session).totalTokens
        agent.session.append('request/context', {
          provider: options.provider, model: options.model, contextWindow: 10_000,
          workingTokenLimit: 1_000, workingContextTokens: measured,
        })
      }
      return next()
    }, { prepend: true })
    await send(agent, 'short request')
    expect(adapter.requests).toHaveLength(1)
    const contexts = agent.session.snapshotEvents().filter(event => event.type === 'request/context')
    expect(contexts).toHaveLength(2)
    expect(contexts.filter(event => event.data.workingContextTokens !== undefined)).toHaveLength(1)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('delegates a marked request without a cancellation signal', async () => {
    const { ctx, agent, adapter } = await harness({}, { seed: [] })
    const request = markAgentLoopRequest({ provider: 'mock', model: 'limited',
      sessionId: agent.session.id, messages: [createUserMessage({
        content: [{ type: 'text', text: 'one-shot input' }], source: { kind: 'user' },
      })],
    })
    for await (const _chunk of ctx.llm.stream(request)) { /* Drain the delegated request. */ }
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/context')).toHaveLength(0)
  })

  it('rejects a marked request that reuses another session ID with the live loop signal', async () => {
    const { ctx, agent, adapter } = await harness({}, { seed: [] })
    const foreignFailures: string[] = []
    ctx.on('agent/request', async ({ signal }, next) => {
      const config = await next()
      const foreign = markAgentLoopRequest({ provider: 'mock', model: 'limited',
        sessionId: SessionId('foreign-session'), signal, messages: [],
      })
      try {
        for await (const _chunk of ctx.llm.stream(foreign)) { /* Consume or reject the foreign stream. */ }
      } catch (error) {
        if (error instanceof LlmError) foreignFailures.push(error.code)
      }
      return config
    })
    await send(agent, 'short request')
    expect(foreignFailures).toEqual(['CONTEXT_BUDGET_UNAVAILABLE'])
    expect(adapter.requests).toHaveLength(1)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('uses retained context below the safe model budget when overflow retries are disabled', async () => {
    const { agent, adapter } = await harness({ maxOverflowRetries: 0 })
    await send(agent)
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('blocks over-budget retained context when overflow retries are disabled', async () => {
    const { agent, adapter } = await harness({ maxOverflowRetries: 0 }, { contextWindow: 3_000 })
    await send(agent, 'N'.repeat(20_000))
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'WORKING_CONTEXT_LIMIT' } })
  })

  it('blocks an unknown safe budget when overflow retries are disabled', async () => {
    const { agent, adapter } = await harness({ maxOverflowRetries: 0, workingTokenLimit: 1_000, modelPolicies: [] },
      { model: 'unknown-context' })
    await send(agent)
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_BUDGET_UNAVAILABLE' } })
  })

  it('retains history when a model without context capacity cannot summarize', async () => {
    const { agent, adapter } = await harness({ workingTokenLimit: 1_000, modelPolicies: [] },
      { model: 'unknown-context' })
    await send(agent)
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_BUDGET_UNAVAILABLE' } })
  })

  it('stops recovery if the persisted request header is unavailable', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.on('agent/request-error', ({ agent: current }, next) => {
      const header = vi.spyOn(current.session, 'requestHeader').mockReturnValue(undefined)
      return next().finally(() => { header.mockRestore() })
    }, { prepend: true })
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'CONTEXT_BUDGET_UNAVAILABLE' } })
  })

  it('refuses to retry after a compactor leaves an unmatched checkpoint bracket', async () => {
    const { ctx, agent, adapter } = await harness()
    const compact = ctx.get('compaction') as BasicCompactionEngine
    vi.spyOn(compact, 'compactIfNeeded').mockImplementation(async (current) => {
      if (current.session.snapshotEvents().some(event => event.type === 'assistant/attempt')) {
        current.session.append('compaction/start', { compactionId: CompactionId('incomplete-recovery'), turn: null })
      }
      return null
    })
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(1)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'COMPACTION_PERSISTENCE_FAILED' } })
  })

  it.each(['compaction/start', 'compaction/summary'] as const)('does not fall back after a failed %s write', async (failedType) => {
    const { agent, adapter } = await harness()
    const append = agent.session.append.bind(agent.session)
    // Fault injection covers every append overload without widening production event types.
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === failedType) throw new Error('compaction record could not be committed')
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)
    await send(agent)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'COMPACTION_PERSISTENCE_FAILED' } })
  })

  it('reserves configured headroom for Chinese summary input near the smaller model window', async () => {
    const { agent, adapter, ctx } = await harness()
    const message = createUserMessage({
      content: [{ type: 'text', text: '短剧制作角色剧情'.repeat(500) }], source: { kind: 'user' },
    })
    const config = resolveConfig({
      adaptiveBudget: true, thresholdRatio: 0.45, headroomTokens: 1_000, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: 'windowed-summary',
    })
    await summarizeWithLlm(ctx, config, { messages: [message] }, agent)
    expect(adapter.summaries).toHaveLength(1)
    const sent = adapter.summaries[0]
    if (sent === undefined) throw new Error('missing summary request')
    const instruction = sent.messages.at(-1)
    if (instruction?.role !== 'user') throw new Error('missing summary instruction')
    const measuredInstruction = ctx.tokenMeter.estimateMessage(createUserMessage({
      content: instruction.content, source: { kind: 'user' },
    }))
    expect(ctx.tokenMeter.estimateMessage(message) + measuredInstruction + 1_000 + (sent.maxTokens ?? 0))
      .toBeLessThanOrEqual(4_000)
    expect(sent.maxTokens).toBeGreaterThan(0)
    expect(sent.maxTokens).toBeLessThan(4_000)
  })

  it('scales the safety headroom down to fit a tight summary model window', async () => {
    const { agent, adapter, ctx } = await harness()
    const message = createUserMessage({
      content: [{ type: 'text', text: '剧'.repeat(12_000) }], source: { kind: 'user' },
    })
    const config = {
      adaptiveBudget: true, thresholdRatio: 0.45, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: 'windowed-summary',
    }
    await summarizeWithLlm(ctx, resolveConfig({ ...config, headroomTokens: 0 }), { messages: [message] }, agent)
    await summarizeWithLlm(ctx, resolveConfig({ ...config, headroomTokens: 1_000 }), { messages: [message] }, agent)
    expect(adapter.summaries).toHaveLength(2)
    const without = adapter.summaries[0]?.maxTokens
    const withHeadroom = adapter.summaries[1]?.maxTokens
    if (without === undefined || withHeadroom === undefined) throw new Error('summary output cap missing')
    expect(without).toBeLessThan(1_000)
    expect(withHeadroom).toBe(without - Math.floor(without * 0.45))
    expect(withHeadroom).toBeGreaterThan(0)
  })

  it('does not dispatch a summary when the remaining window cannot hold any safety headroom', async () => {
    const { agent, adapter, ctx } = await harness()
    const config = {
      adaptiveBudget: true, thresholdRatio: 0.45, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: 'windowed-summary',
    }
    const make = (text: string) => createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    })
    await summarizeWithLlm(ctx, resolveConfig({ ...config, headroomTokens: 0 }), { messages: [make('probe')] }, agent)
    const instruction = adapter.summaries[0]?.messages.at(-1)
    if (instruction?.role !== 'user') throw new Error('missing summary instruction')
    const instructionTokens = ctx.tokenMeter.estimateMessage(createUserMessage({
      content: instruction.content, source: { kind: 'user' },
    }))
    const oneTokenLeft = make('x'.repeat((4_000 - instructionTokens - 1 - 8) * 4))
    expect(ctx.tokenMeter.estimateMessage(oneTokenLeft) + instructionTokens).toBe(3_999)
    await expect(summarizeWithLlm(ctx, resolveConfig({ ...config, headroomTokens: 1_000 }),
      { messages: [oneTokenLeft] }, agent)).rejects.toThrow(/no safety headroom/)
    expect(adapter.summaries).toHaveLength(1)
  })

  it('prices only the selected summary input when provider usage anchors a much larger history', async () => {
    const { agent, adapter, ctx } = await harness({}, {
      contextWindow: 1_000_000, seed: historySeed(true, undefined, 300_000),
    })
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(128_000)
    const user = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    if (user === undefined) throw new Error('missing historical user message')
    const message = agent.session.deriveEventMessage(user)
    if (message === null) throw new Error('historical message cannot be derived')
    const config = resolveConfig({
      adaptiveBudget: true, thresholdRatio: 0.45, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: 'bounded-summary',
    })
    await summarizeWithLlm(ctx, config, { messages: [message] }, agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]).toMatchObject({ model: 'bounded-summary', maxTokens: 4_096 })
  })

  it('uses a safe estimate when measured history nodes are missing or do not derive a message', async () => {
    const { agent, adapter, ctx } = await harness()
    const nodes = ctx.tokenMeter.measure(agent.session).nodes
    const missing = nodes[0]?.seq
    const nonMessage = nodes[1]?.seq
    if (missing === undefined || nonMessage === undefined) throw new Error('fixture requires two priced nodes')
    // Existing Session history reads can race a rebuilt surface during summarization.
    const eventAt = agent.session.eventAt.bind(agent.session)
    vi.spyOn(agent.session, 'eventAt').mockImplementation(seq => seq === missing ? undefined : eventAt(seq))
    const derive = agent.session.deriveEventMessage.bind(agent.session)
    vi.spyOn(agent.session, 'deriveEventMessage').mockImplementation(event =>
      event.seq === nonMessage ? null : derive(event))
    const config = resolveConfig({ adaptiveBudget: true, headroomTokens: 0, maxTokens: 64,
      summarizationProvider: 'mock', summarizationModel: 'limited' })
    const message = createUserMessage({ content: [{ type: 'text', text: 'short checkpoint' }], source: { kind: 'user' } })
    await summarizeWithLlm(ctx, config, { messages: [message] }, agent)
    expect(adapter.summaries).toHaveLength(1)
  })

  it('keeps an adapter without context metadata usable within the configured fixed budget', async () => {
    const { agent, adapter } = await harness({
      adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45,
      headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [],
    }, { model: 'unknown-context', seed: [] })
    await send(agent, 'short request')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.model).toBe('unknown-context')
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('reevaluates the model window after a session switches models', async () => {
    const { agent, adapter, ctx } = await harness({
      adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45,
      headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [],
    }, { contextWindow: 100_000, seed: [] })
    ctx.on('agent/request', async ({ turn }, next) => {
      const config = await next()
      return turn === 2 ? { ...config, model: 'tiny-route' } : config
    })
    await send(agent, 'first request')
    expect(adapter.requests).toHaveLength(1)
    await send(agent, `SECOND_LARGE_INPUT; ${'Z'.repeat(50_000)}`)
    expect(adapter.requests).toHaveLength(1)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'WORKING_CONTEXT_LIMIT' } })
  })

  it.each([
    ['bounded-summary', 4_096],
    ['windowed-summary', 4_000],
  ])('caps a distinct %s summary request by available metadata', async (summaryModel, bound) => {
    const { agent, adapter } = await harness({
      adaptiveBudget: true, workingTokenLimit: 1_000, thresholdRatio: 0.09,
      headroomTokens: 0, retainTokens: 0, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: summaryModel, modelPolicies: [],
    })
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]?.model).toBe(summaryModel)
    const actual = adapter.summaries[0]?.maxTokens
    expect(actual).toBeDefined()
    expect(actual).toBeLessThanOrEqual(bound)
    if (summaryModel === 'bounded-summary') expect(actual).toBe(4_096)
    else expect(actual).toBeLessThan(bound)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('keeps a summary adapter without context metadata compatible with its configured cap', async () => {
    const { agent, adapter } = await harness({
      adaptiveBudget: true, workingTokenLimit: 1_000, thresholdRatio: 0.09,
      headroomTokens: 0, retainTokens: 0, maxTokens: 16_384,
      summarizationProvider: 'mock', summarizationModel: 'unknown-context', modelPolicies: [],
    })
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]).toMatchObject({ model: 'unknown-context', maxTokens: 16_384 })
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('keeps retained conversation context when a smaller separate summarizer cannot accept it', async () => {
    const { agent, adapter } = await harness({
      adaptiveBudget: true, workingTokenLimit: 1_000, thresholdRatio: 0.09,
      headroomTokens: 0, retainTokens: 0, maxTokens: 64,
      summarizationProvider: 'mock', summarizationModel: 'small-summary', modelPolicies: [],
    })
    await send(agent)
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('scales the real summary call for a small model and resumes its tool turn', async () => {
    const { agent, adapter, ctx } = await harness({
      adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45,
      headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [],
    }, { contextWindow: 4_096 })
    let calls = 0
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'work', description: 'Perform the prepared work.', parameters: {},
      async execute() { calls += 1; return [{ type: 'text', text: 'TOOL_AFTER_COMPACTION' }] },
    })))
    adapter.replies = ['tool', 'text']
    await send(agent, `LATEST_INPUT; ${'N'.repeat(6_500)}`)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]?.maxTokens).toBe(256)
    expect(calls).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('TOOL_AFTER_COMPACTION')
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('enforces a smaller model window before dispatch under the shared working budget', async () => {
    const { agent, adapter } = await harness({
      adaptiveBudget: true, workingTokenLimit: 475_000, thresholdRatio: 0.45,
      headroomTokens: 16_384, retainTokens: 65_536, maxTokens: 16_384,
      modelPolicies: [],
    }, { contextWindow: 8_192 })
    await send(agent, `TOO_LARGE_SINGLE_INPUT; ${'Z'.repeat(50_000)}`)
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)).toMatchObject({ kind: 'error', error: { code: 'WORKING_CONTEXT_LIMIT' } })
  })

  it('flushes a durable summary before deriving the retry and executes its tool once', async () => {
    const { ctx, agent, adapter } = await harness()
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(900)
    const order: string[] = []
    ctx.on('session/flush', () => { order.push('flush') })
    adapter.onOrdinary = () => { order.push('ordinary') }
    adapter.replies = ['tool', 'text']
    let executions = 0
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'work', description: 'Perform the prepared work.', parameters: {},
      async execute() { executions += 1; return [{ type: 'text', text: 'LATEST_TOOL_RESULT' }] },
    })))

    await send(agent)

    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]?.maxTokens).toBe(64)
    expect(adapter.requests).toHaveLength(2)
    expect(order.indexOf('flush')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('ordinary'))
    const first = JSON.stringify(adapter.requests[0]?.messages)
    expect(first).toContain('CHECKPOINT: KEEP_POLICY')
    expect(first).toContain('LATEST_INPUT')
    expect(first).not.toContain('OLD_CONTEXT_SENTINEL')
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('LATEST_TOOL_RESULT')
    expect(executions).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('LATEST_INPUT'))).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(1_000)
    expect(agent.session.requestContext()?.contextWindow).toBe(10_000)
    expect(agent.session.requestHeader()?.config.model).toBe('limited')
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it.each([true, false])('preserves new input after tool declarations are appended (system head: %s)', async (systemHead) => {
    const { ctx, agent, adapter } = await harness({ retainTokens: 0 }, { seed: historySeed(systemHead) })
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'newly_discovered', description: 'A newly discovered tool.', parameters: {},
      async execute() { return [{ type: 'text', text: 'unused' }] },
    })))
    await send(agent)
    for (const request of adapter.requests) expect(JSON.stringify(request.messages)).toContain('LATEST_INPUT')
    if (adapter.requests.length === 0) expect(lastReason(agent)?.kind).toBe('error')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('LATEST_INPUT'))).toHaveLength(1)
  })

  it('preserves admitted input when the real runtime-context projection appends a later user node', async () => {
    const { ctx, agent, adapter } = await harness({ retainTokens: 0 })
    ctx.effect(() => ctx.systemPrompt.context({ name: 'budget-fixture', order: 0, text: 'RUNTIME_TAIL: keep this policy.' }))
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('LATEST_INPUT')
    expect(request).toContain('RUNTIME_TAIL: keep this policy.')
    expect(request).not.toContain('OLD_CONTEXT_SENTINEL')
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context')).toBe(true)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('compacts older history when admission replaces an obsolete system head', async () => {
    const { ctx, agent, adapter } = await harness({ retainTokens: 0 }, {
      seed: historySeed(true, 'Obsolete system instructions from an earlier deployment.'),
    })
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('You are an AI agent powered by DeepSeek Harness.')
    expect(request).toContain('CHECKPOINT: KEEP_POLICY')
    expect(request).toContain('LATEST_INPUT')
    expect(request).not.toContain('Obsolete system instructions')
    expect(request).not.toContain('OLD_CONTEXT_SENTINEL')
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(1_000)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('continues below the safe model budget when summarization fails despite an always-retry provider', async () => {
    const { agent, adapter } = await harness({}, { alwaysRetry: true })
    adapter.summaryMode = 'error'
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data.error).toContain('summary unavailable')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('admits an indivisible input above the working target while below the safe model budget', async () => {
    const { ctx, agent, adapter } = await harness({ thresholdRatio: 0.45,
      modelPolicies: [{ provider: 'mock', model: 'limited', workingTokenLimit: 475_000 }],
    }, { seed: [], contextWindow: 1_000_000 })
    await send(agent, `OVERSIZED_NEW_INPUT; ${'X'.repeat(1_900_000)}`)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThanOrEqual(475_000)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.session.requestContext()?.contextWindow).toBe(1_000_000)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('does not dispatch a rebuilt request when the replacement durability checkpoint fails', async () => {
    const { ctx, agent, adapter } = await harness({}, { alwaysRetry: true })
    ctx.on('session/flush', () => { throw new Error('durability checkpoint unavailable') })
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(lastReason(agent)?.kind).toBe('error')
  })

  it('does not dispatch a rebuilt request without a durability listener', async () => {
    const { agent, adapter } = await harness({}, { durabilityListener: false, alwaysRetry: true })
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(lastReason(agent)?.kind).toBe('error')
  })

  it('keeps fixed tool declarations when they exceed only the working target', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'huge_schema', description: 'D'.repeat(4_400), parameters: {},
      async execute() { throw new Error('this tool must not execute') },
    })))
    await send(agent, 'small new request')
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThanOrEqual(1_000)
    expect(agent.session.requestHeader()?.tools?.[0]?.description.length).toBe(4_400)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('cancels a blocked summary without dispatching the original or rebuilt ordinary request', async () => {
    const { agent, adapter } = await harness()
    adapter.summaryMode = 'wait-for-abort'
    const run = send(agent)
    await adapter.summaryEntered.promise
    agent.cancel({ kind: 'user' })
    await run
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')
    expect(lastReason(agent)?.kind).toBe('aborted')
  })

  it('replays the replacement from the durable log without reviving old history', async () => {
    const first = await harness()
    await send(first.agent)
    const events = first.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    await first.ctx.fiber.dispose()

    const replay = await harness({}, { seed: events })
    await send(replay.agent, 'continue after log replay')
    expect(replay.adapter.summaries).toHaveLength(0)
    expect(replay.adapter.requests).toHaveLength(1)
    const request = JSON.stringify(replay.adapter.requests[0]?.messages)
    expect(request).toContain('CHECKPOINT: KEEP_POLICY')
    expect(request).toContain('LATEST_INPUT')
    expect(request).not.toContain('OLD_CONTEXT_SENTINEL')
    const seqs = replay.agent.session.snapshotEvents().map(event => event.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(lastReason(replay.agent)).toEqual({ kind: 'completed' })
  })

  it.each(['auto-disabled', 'limit-absent', 'other-route'] as const)(
    'leaves ordinary requests unchanged for %s', async (mode) => {
      const config: BasicCompactionConfig = mode === 'auto-disabled' ? { auto: false }
        : mode === 'limit-absent' ? { modelPolicies: [] } : {}
      const { agent, adapter } = await harness(config, { model: mode === 'other-route' ? 'other' : 'limited' })
      await send(agent)
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.summaries).toHaveLength(0)
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('OLD_CONTEXT_SENTINEL')
      expect(adapter.requests[0]?.model).toBe(mode === 'other-route' ? 'other' : 'limited')
      expect(lastReason(agent)).toEqual({ kind: 'completed' })
    },
  )

  it('ignores a provider-spoofed local error code without a local guard witness', async () => {
    const { agent, adapter } = await harness()
    adapter.ordinaryFailure = 'WORKING_CONTEXT_LIMIT'
    await send(agent, 'below the limit')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(lastReason(agent)?.kind).toBe('error')
  })

  it('allows a non-loop one-shot call associated with the same oversized session', async () => {
    const { ctx, agent, adapter } = await harness({}, { seed: [] })
    await send(agent, 'X'.repeat(40_100))
    expect(adapter.requests).toHaveLength(0)
    for await (const _chunk of ctx.llm.stream({ provider: 'mock', model: 'limited',
      sessionId: agent.session.id, messages: agent.session.deriveMessages(),
    })) { /* Consume the auxiliary caller's owned stream to settlement. */ }
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
  })

  it('removes the admission and recovery listeners with their owning plugin fiber', async () => {
    const { agent, adapter, compactionFiber } = await harness()
    await compactionFiber.dispose()
    await send(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(lastReason(agent)).toEqual({ kind: 'completed' })
  })

  it('cancels and drains pending recovery before plugin disposal resolves', async () => {
    const { agent, adapter, compactionFiber } = await harness()
    adapter.summaryMode = 'wait-for-abort'
    const run = send(agent)
    await adapter.summaryEntered.promise
    await compactionFiber.dispose()
    await run
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    expect(lastReason(agent)?.kind).toBe('aborted')
  })

  it('drains recovery already cancelled before plugin disposal', async () => {
    const { agent, adapter, compactionFiber } = await harness()
    adapter.summaryMode = 'wait-for-abort'
    const run = send(agent)
    await adapter.summaryEntered.promise
    agent.cancel({ kind: 'user' })
    await compactionFiber.dispose()
    await run
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    expect(lastReason(agent)?.kind).toBe('aborted')
  })
})
