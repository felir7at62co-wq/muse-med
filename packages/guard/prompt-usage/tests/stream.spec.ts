import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { estimateToolSchemas } from '@deepseek-ai/dsh-token-meter/estimate'
import * as guard from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

const PROVIDER = 'muse-cloud-yunying'
const MODEL = 'gemini-3.1-pro'
const ESTIMATE = 52798
const ROUTE = { provider: PROVIDER, model: MODEL, minToolSchemaRatio: 1, minEstimateRatio: 0.5 }

/** Tool schemas whose heuristic size is about 24k tokens, like the incident request. */
const TOOLS: ToolSchema[] = Array.from({ length: 24 }, (_, index) => ({
  name: `tool_${index}`, description: 'x'.repeat(3950), parameters: { type: 'object' },
}))
const TOOL_TOKENS = estimateToolSchemas(TOOLS)

class ScriptedAdapter extends LlmAdapter {
  requests = 0
  exits = 0
  constructor(private readonly script: readonly StreamChunk[], private readonly onStart: () => void = () => {}) { super() }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onStart()
    this.requests++
    try {
      yield* this.script
    } finally {
      this.exits++
    }
  }
}

interface HarnessOptions {
  live?: Set<string>
  order?: string[]
  estimate?: number
}

async function harness(adapter: ScriptedAdapter, options: HarnessOptions = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(LlmRuntime)
  const live = options.live ?? new Set(['session-1', 'session-sub'])
  const measured: string[] = []
  // Service doubles: the guard reads only Sessions.get and TokenMeter.measureWorkingContext.
  ctx.provide('sessions', { get: (id: string) => live.has(id) ? { id } : undefined })
  ctx.provide('tokenMeter', {
    measureWorkingContext: (session: { id: string }) => {
      measured.push(session.id)
      options.order?.push('measure')
      return { totalTokens: options.estimate ?? ESTIMATE }
    },
  })
  ctx.llm.registerAdapter([PROVIDER, 'other'], adapter)
  const warn = vi.fn()
  const fiber = await ctx.plugin(guard, { routes: [ROUTE] })
  vi.spyOn(fiber.ctx.logger, 'warn').mockImplementation(warn)
  return { ctx, fiber, warn, measured }
}

function request(overrides: Partial<GenerateOptions> = {}, marked = true): GenerateOptions {
  const options: GenerateOptions = { provider: PROVIDER, model: MODEL, messages: [], tools: TOOLS, sessionId: SessionId('session-1'), ...overrides }
  return marked ? markAgentLoopRequest(options) : options
}

function sessionless(): GenerateOptions {
  const { sessionId: _sessionId, ...options } = request({}, false)
  return markAgentLoopRequest(options)
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const REPLY = 'I am not running inside the client, so I will write the content directly.'
function textReply(inputTokens: number, outputTokens = 662): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: REPLY },
    { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'resp-1' } } },
  ]
}

describe('plugin surface and configuration', () => {
  it('keeps named plugin exports without a default', () => {
    expect('default' in guard).toBe(false)
    expect(Object.keys(guard).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect(guard.name).toBe('prompt-usage-guard')
    expect(guard.inject).toEqual(['llm', 'sessions', 'tokenMeter'])
  })

  it('fails at load without explicit routes', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('tokenMeter', { measureWorkingContext: () => ({ totalTokens: 0 }) })
    await expect(ctx.plugin(guard, { routes: [{ ...ROUTE, minEstimateRatio: 1 }] })).rejects.toThrow(/minEstimateRatio/)
    // @ts-expect-error Deliberately missing external config must fail activation.
    await expect(ctx.plugin(guard, {})).rejects.toThrow()
  })
})

describe('guarded requests', () => {
  it('replaces the stop of a tool-less reply with a too-small prompt and closes the inner stream', async () => {
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx, warn } = await harness(adapter)
    const chunks = await collect(ctx.llm.stream(request()))
    expect(chunks.slice(0, 4)).toEqual(textReply(4637).slice(0, 4))
    expect(chunks).toHaveLength(5)
    expect(chunks[4]).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'PROMPT_USAGE_SHORTFALL',
          message: `The model provider reported 4637 prompt tokens for a request with about ${TOOL_TOKENS} tokens of tool definitions and about ${ESTIMATE} tokens in total, so it likely received an incomplete request. The reply was discarded.`,
        },
      },
    })
    expect(adapter.exits).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('discarded a reply from provider "muse-cloud-yunying" model "gemini-3.1-pro"')
    expect(warn.mock.calls[0]![0]).not.toContain(REPLY)
  })

  it('keeps inner listeners from completing on a rejected reply', async () => {
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx } = await harness(adapter)
    const observed = { completed: false, closed: false }
    ctx.on('llm/stream', (_options, next) => (async function* () {
      try {
        for await (const chunk of next()) yield chunk
        observed.completed = true
      } finally {
        observed.closed = true
      }
    })())
    await collect(ctx.llm.stream(request()))
    expect(observed).toEqual({ completed: false, closed: true })
    const healthy = new ScriptedAdapter(textReply(50349))
    ctx.llm.registerAdapter(['healthy'], healthy)
    await collect(ctx.llm.stream(request({ provider: 'healthy' })))
    expect(observed.completed).toBe(true)
  })

  it('forwards a healthy reply unchanged', async () => {
    const adapter = new ScriptedAdapter(textReply(50349))
    const { ctx, warn } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(textReply(50349))
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs a near miss and keeps the reply', async () => {
    // Below half the estimate but above the tool schemas.
    const adapter = new ScriptedAdapter(textReply(TOOL_TOKENS + 1))
    const { ctx, warn } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(textReply(TOOL_TOKENS + 1))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('below only the working-estimate threshold')
  })

  it('logs a near miss below only the tool-schema threshold', async () => {
    const adapter = new ScriptedAdapter(textReply(TOOL_TOKENS - 1))
    const { ctx, warn } = await harness(adapter, { estimate: TOOL_TOKENS })
    expect(await collect(ctx.llm.stream(request()))).toEqual(textReply(TOOL_TOKENS - 1))
    expect(warn.mock.calls[0]![0]).toContain('below only the tool-schema threshold')
  })

  it('passes a request without tools', async () => {
    const { tools: _tools, ...rest } = request({}, false)
    const withoutTools = markAgentLoopRequest(rest)
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx, warn, measured } = await harness(adapter)
    // The runtime fills an absent tool list before listeners run; the waterfall itself may still carry none.
    const stream = ctx.waterfall(ctx.llm, 'llm/stream', withoutTools, () => adapter.stream(withoutTools))
    expect(await collect(stream)).toEqual(textReply(4637))
    expect(warn).not.toHaveBeenCalled()
    expect(measured).toEqual(['session-1'])
  })

  it('measures once per request before the adapter starts', async () => {
    const order: string[] = []
    const adapter = new ScriptedAdapter(textReply(50349), () => order.push('adapter'))
    const { ctx, measured } = await harness(adapter, { order })
    await collect(ctx.llm.stream(request()))
    expect(order).toEqual(['measure', 'adapter'])
    expect(measured).toEqual(['session-1'])
  })

  it('judges a subagent session the same way', async () => {
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx, measured } = await harness(adapter)
    const chunks = await collect(ctx.llm.stream(request({ sessionId: SessionId('session-sub') })))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'PROMPT_USAGE_SHORTFALL' } } })
    expect(measured).toEqual(['session-sub'])
  })

  it('excludes deferred tool schemas from the reference', async () => {
    const deferred = TOOLS.map(tool => ({ ...tool, deferLoading: true as const }))
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request({ tools: deferred })))).toEqual(textReply(4637))
  })

  it('stops the inner stream when the consumer returns early', async () => {
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx } = await harness(adapter)
    for await (const chunk of ctx.llm.stream(request())) {
      expect(chunk.type).toBe('block-start')
      break
    }
    expect(adapter.exits).toBe(1)
  })
})

describe('requests the guard leaves alone', () => {
  const toolCallVariants: [string, StreamChunk[]][] = [
    ['block-start', [{ type: 'block-start', index: 1, blockType: 'tool-call' }]],
    ['tool-call-delta', [{ type: 'tool-call-delta', index: 1, id: ToolCallId('c'), name: 'read', argumentsDelta: '{}' }]],
    ['block-end', [{ type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c'), name: 'read', arguments: '{}' } }]],
  ]

  it.each(toolCallVariants)('passes a reply with tool-call evidence from %s', async (_form, evidence) => {
    const script = [...textReply(4637).slice(0, 3), ...evidence, ...textReply(4637).slice(3)]
    const { ctx, warn } = await harness(new ScriptedAdapter(script))
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each<[string, StreamChunk[]]>([
    ['no usage', textReply(4637).filter(chunk => chunk.type !== 'usage')],
    ['zero usage', textReply(0)],
  ])('passes a reply with %s', async (_case, script) => {
    const { ctx } = await harness(new ScriptedAdapter(script))
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
  })

  it('passes a text reply whose usage reports 5008 prompt and 0 completion tokens, as BB6 sends it', async () => {
    const script = textReply(5008, 0)
    const { ctx, warn } = await harness(new ScriptedAdapter(script), { estimate: 120000 })
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still judges an empty reply that reports zero completion tokens', async () => {
    const empty: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 5008, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { ctx } = await harness(new ScriptedAdapter(empty), { estimate: 120000 })
    const chunks = await collect(ctx.llm.stream(request()))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'PROMPT_USAGE_SHORTFALL' } } })
  })

  it.each<[string, GenerateOptions]>([
    ['another model', request({ model: 'gpt-6.1-sol' })],
    ['another provider', request({ provider: 'other' })],
    ['an unmarked auxiliary purpose', request({ purpose: 'compaction' }, false)],
    ['an unmarked request', request({}, false)],
    ['no session id', sessionless()],
    ['a session that is not live', request({ sessionId: SessionId('gone') })],
  ])('passes %s without measuring', async (_case, options) => {
    const { ctx, measured, warn } = await harness(new ScriptedAdapter(textReply(4637)))
    expect(await collect(ctx.llm.stream(options))).toEqual(textReply(4637))
    expect(measured).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('forwards an aborted stream unchanged', async () => {
    const controller = new AbortController()
    const script: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } },
    ]
    const { ctx, warn } = await harness(new ScriptedAdapter(script))
    expect(await collect(ctx.llm.stream(request({ signal: controller.signal })))).toEqual(script)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('disposal', () => {
  it('forwards a stream that the guard selected but that starts after disposal', async () => {
    const adapter = new ScriptedAdapter(textReply(4637))
    const { ctx, fiber, measured } = await harness(adapter)
    let disposeBeforeStart = true
    ctx.on('llm/stream', (_options, next) => (async function* () {
      const inner = next()
      if (disposeBeforeStart) await fiber.dispose()
      yield* inner
    })(), { prepend: true })
    expect(await collect(ctx.llm.stream(request()))).toEqual(textReply(4637))
    expect(measured).toEqual([])
    disposeBeforeStart = false
  })

  it('removes the listener and stops judging a stream that outlives the plugin', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    class SlowAdapter extends ScriptedAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const chunks = textReply(4637)
        yield* chunks.slice(0, 4)
        await gate
        yield chunks[4]!
        void options
      }
    }
    const adapter = new SlowAdapter([])
    const { ctx, fiber, warn } = await harness(adapter)
    const pending = collect(ctx.llm.stream(request()))
    await new Promise(resolve => setTimeout(resolve, 0))
    await fiber.dispose()
    release()
    expect(await pending).toEqual(textReply(4637))
    expect(warn).not.toHaveBeenCalled()
    // The same guarded route now reaches the adapter without the listener.
    expect(await collect(ctx.llm.stream(request()))).toEqual(textReply(4637))
  })
})
