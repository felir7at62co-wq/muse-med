import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, expandAssistantStream, LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as guard from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

const PROVIDER = 'muse-cloud-yunying'
const MODEL = 'gemini-3.1-pro'
const CODE = 'PROMPT_USAGE_SHORTFALL'
const DEFAULT_CODES = ['EMPTY_RESPONSE', 'INVALID_TOOL_ARGUMENTS', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
const DROPPED = 'I am not running inside the client, so I will write the content directly.'

function reply(text: string, inputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
const dropped = (inputTokens = 40): StreamChunk[] => reply(DROPPED, inputTokens)
const healthy = (): StreamChunk[] => reply('Recovered answer.', 1_000_000)
const serverError = (): StreamChunk[] => [
  { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'synthetic server error' } } },
]

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly estimates: number[] = []

  constructor(
    private readonly ctx: Context, private readonly script: StreamChunk[][], private readonly policy: ResolvedRetryPolicy,
  ) { super() }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
    if (session !== undefined) this.estimates.push(this.ctx.tokenMeter.measureWorkingContext(session).totalTokens)
    const response = this.script.shift()
    if (response === undefined) throw new Error('unexpected extra model request')
    yield* response
  }
}

async function harness(script: StreamChunk[][], policy: {
  mode?: 'normal' | 'always'
  maxRetries?: number
  codes?: string[]
  shortfallLimit?: number
} = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(retry)
  await ctx.plugin(guard, { routes: [{ provider: PROVIDER, model: MODEL, minToolSchemaRatio: 1, minEstimateRatio: 0.5 }] })
  await ctx.plugin(AgentLoop, { agents: [] })
  const resolved = resolveRetryPolicy({
    mode: policy.mode ?? 'normal',
    ...policy.mode === 'always' ? {} : { maxRetries: policy.maxRetries ?? 2 },
    retryableCodes: policy.codes ?? [...DEFAULT_CODES, CODE],
    ...(policy.shortfallLimit === undefined ? {} : { consecutiveRetryLimits: { [CODE]: policy.shortfallLimit } }),
    backoff: { initialDelayMs: 1, maxDelayMs: 8, jitterRatio: 0 },
  }, 'test')
  const adapter = new Adapter(ctx, script, resolved)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.tools.register(defineTool({
    // About a thousand tokens of tool definitions, so a 40-token prompt is far below the request.
    name: 'read_episode', description: `Read one episode transcript from the project. ${'Keep speaker labels and timing. '.repeat(120)}`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'episode',
  }))
  const agent = await ctx.agentLoop.create(SessionId(`prompt-usage-${Math.random()}`), { provider: PROVIDER, model: MODEL })
  const run = async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Transcribe the next episode.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const events = () => agent.session.snapshotEvents()
  return { ctx, adapter, agent, run, events }
}

describe('discarded replies through the real loop and retry policy', () => {
  it('retries a discarded reply and commits only the healthy one', async () => {
    const test = await harness([dropped(), healthy()], { shortfallLimit: 1 })
    await test.run()
    const events = test.events()
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    expect(attempts).toHaveLength(1)
    const raw = expandAssistantStream(attempts[0]!.data.stream).map(record => record.chunk)
    expect(raw.find(chunk => chunk.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } })
    expect(raw.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'PROMPT_USAGE_SHORTFALL' } } })
    const retries = events.filter(event => event.type === 'llm/retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]!.data.failure.code).toBe('PROMPT_USAGE_SHORTFALL')
    const messages = events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages[0]!.data.message.content)).toContain('Recovered answer.')
    expect(JSON.stringify(test.adapter.requests[1]!.messages)).not.toContain(DROPPED)
    expect(test.adapter.estimates).toHaveLength(2)
    expect(test.adapter.estimates[1]).toBe(test.adapter.estimates[0])
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })

  it('ends the turn with the failure once the retry budget is spent', async () => {
    const test = await harness([dropped(), dropped(), dropped()])
    await test.run()
    const events = test.events()
    expect(test.adapter.requests).toHaveLength(3)
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(3)
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toMatchObject({ kind: 'error', error: { code: 'PROMPT_USAGE_SHORTFALL' } })
  })

  it('keeps the two distinct measurements and ends consecutive shortfall without downstream recovery', async () => {
    const test = await harness([dropped(40), dropped(71), healthy()], { maxRetries: 8, shortfallLimit: 1 })
    const downstream = vi.fn(async () => ({ kind: 'retry' as const }))
    test.ctx.on('agent/request-error', downstream)
    await test.run()

    const events = test.events()
    const finishes = events.filter(event => event.type === 'assistant/attempt').map(event =>
      expandAssistantStream(event.data.stream).at(-1)?.chunk)
    expect(test.adapter.requests).toHaveLength(2)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
    expect(finishes).toHaveLength(2)
    for (const [index, inputTokens] of [40, 71].entries()) {
      const finish = finishes[index]
      if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
        throw new Error('expected an unsettled shortfall attempt')
      }
      expect(finish.reason.failure.code).toBe(CODE)
      expect(finish.reason.failure.message).toContain(`reported ${inputTokens} prompt tokens`)
    }
    const retries = events.filter(event => event.type === 'llm/retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]?.data.failure.message).toContain('reported 40 prompt tokens')
    const end = events.findLast(event => event.type === 'turn/end')?.data.reason
    expect(end).toMatchObject({ kind: 'error', error: { code: CODE } })
    expect(end?.kind === 'error' ? end.error.message : undefined).toContain('reported 71 prompt tokens')
    expect(downstream).not.toHaveBeenCalled()
  })

  it('starts another short retry streak after a different failure while preserving the total ordinal', async () => {
    const test = await harness([dropped(), serverError(), dropped(), dropped()], { maxRetries: 8, shortfallLimit: 1 })
    await test.run()

    expect(test.adapter.requests).toHaveLength(4)
    expect(test.events().filter(event => event.type === 'llm/retry').map(event => [
      event.data.failure.code, event.data.retry, event.data.delayMs,
    ])).toEqual([[CODE, 1, 1], ['SERVER', 2, 2], [CODE, 3, 1]])
    expect(test.events().findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: CODE } })
  })

  it('honors the overall retry budget before starting another streak', async () => {
    const test = await harness([dropped(), serverError(), dropped()], { maxRetries: 2, shortfallLimit: 1 })
    await test.run()
    expect(test.adapter.requests).toHaveLength(3)
    expect(test.events().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(test.events().findLast(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: CODE } })
  })

  it('allows the user to stop before the scheduled shortfall retry starts', async () => {
    const test = await harness([dropped(), healthy()], { shortfallLimit: 1 })
    test.ctx.on('session/event', (session, event) => {
      if (session === test.agent.session && event.type === 'llm/retry') test.agent.cancel({ kind: 'user' })
    })
    await test.run()

    expect(test.adapter.requests).toHaveLength(1)
    expect(test.events().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(test.events().filter(event => event.type === 'llm/retry-started')).toHaveLength(0)
  })

  it('leaves a shortfall retry undispatched if the user stops during request preparation', async () => {
    const test = await harness([dropped(), healthy()], { shortfallLimit: 1 })
    const preparingRetry = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let preparations = 0
    test.ctx.on('agent/request', async ({ agent }, next) => {
      if (agent === test.agent && ++preparations === 2) {
        preparingRetry.resolve(undefined)
        await release.promise
      }
      return next()
    })
    const running = test.run()
    try {
      await Promise.race([preparingRetry.promise, running.then(() => { throw new Error('retry preparation was not reached') })])
      expect(test.events().filter(event => event.type === 'llm/retry')).toHaveLength(1)
      expect(test.events().filter(event => event.type === 'llm/retry-started')).toHaveLength(0)
      test.agent.cancel({ kind: 'user' })
    } finally {
      release.resolve(undefined)
    }
    await running

    expect(test.adapter.requests).toHaveLength(1)
    expect(test.events().filter(event => event.type === 'llm/retry-started')).toHaveLength(0)
  })

  it('ends the turn at once when the route does not retry the code', async () => {
    const test = await harness([dropped()], { codes: DEFAULT_CODES })
    await test.run()
    const events = test.events()
    expect(test.adapter.requests).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toMatchObject({ kind: 'error', error: { code: 'PROMPT_USAGE_SHORTFALL' } })
  })

  it('leaves the bound to the route policy, which always mode does not have', async () => {
    const test = await harness([dropped(), dropped(), dropped(), healthy()], { mode: 'always' })
    await test.run()
    expect(test.adapter.requests).toHaveLength(4)
    expect(test.events().filter(event => event.type === 'llm/retry')).toHaveLength(3)
    expect(test.events().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })
})
