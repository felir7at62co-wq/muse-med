/** Final-request working budgets through the production loop and local adapters. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createSystemMessage, createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import BasicCompactionEngine, { type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Separate auxiliary calls from ordinary requests without any network transport. */
class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  readonly summaryEntered = Promise.withResolvers<undefined>()
  summaryMode: 'success' | 'error' | 'wait-for-abort' = 'success'
  ordinaryFailure: string | undefined
  replies: ('tool' | 'text')[] = []
  onOrdinary: (() => void) | undefined

  constructor(
    private readonly contextWindow = 10_000,
    private readonly alwaysRetry = false,
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
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
function historySeed(systemHead = true, systemText = 'You are an AI agent powered by DeepSeek Harness.'): readonly SessionEvent[] {
  const session = Session.create(SessionId('budget-history'))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1 && systemHead) session.append('system/message', { turn, step: 1,
      message: createSystemMessage(systemText),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `OLD_CONTEXT_SENTINEL_${turn}; KEEP_POLICY; ${'H'.repeat(600)}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: 'mock', model: 'limited' } }, reason: 'initial' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: `historical answer ${'A'.repeat(600)}` }],
      source: { kind: 'model', provider: 'mock', model: 'limited' },
    }) }, { surfaceOp: 'append' })
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
    agentOptions: { provider: 'mock', model: options.model ?? 'limited' },
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

  it('stops with zero ordinary calls when summarization fails despite an always-retry provider', async () => {
    const { agent, adapter } = await harness({}, { alwaysRetry: true })
    adapter.summaryMode = 'error'
    await send(agent)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data.error).toContain('summary unavailable')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(lastReason(agent)?.kind).toBe('error')
  })

  it('blocks an indivisible new input above the actual 475000 budget while retaining physical 1M', async () => {
    const { ctx, agent, adapter } = await harness({ thresholdRatio: 0.45,
      modelPolicies: [{ provider: 'mock', model: 'limited', workingTokenLimit: 475_000 }],
    }, { seed: [], contextWindow: 1_000_000 })
    await send(agent, `OVERSIZED_NEW_INPUT; ${'X'.repeat(1_900_000)}`)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThanOrEqual(475_000)
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.session.requestContext()?.contextWindow).toBe(1_000_000)
    expect(lastReason(agent)?.kind).toBe('error')
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

  it('counts newly admitted tool schemas and rejects fixed content that no summary can shrink', async () => {
    const { ctx, agent, adapter } = await harness()
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'huge_schema', description: 'D'.repeat(4_400), parameters: {},
      async execute() { throw new Error('this tool must not execute') },
    })))
    await send(agent, 'small new request')
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThanOrEqual(1_000)
    expect(agent.session.requestHeader()?.tools?.[0]?.description.length).toBe(4_400)
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(0)
    expect(lastReason(agent)?.kind).toBe('error')
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
    await send(agent, 'X'.repeat(4_100))
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
})
