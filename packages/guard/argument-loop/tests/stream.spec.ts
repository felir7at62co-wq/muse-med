import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, ToolCallId, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as guard from '../src/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

class ScriptedAdapter extends LlmAdapter {
  requests = 0
  emitted: StreamChunk[] = []
  exits = 0

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    try {
      for (const chunk of this.script) {
        this.emitted.push(chunk)
        yield chunk
      }
    } finally {
      this.exits++
    }
  }
}

async function harness(adapter: LlmAdapter, repeatedPropertyLimit = 64) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['scripted'], adapter)
  const fiber = await ctx.plugin(guard, { repeatedPropertyLimit })
  return { ctx, fiber }
}

function request(signal?: AbortSignal): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'scripted', model: 'scripted', messages: [],
    ...signal === undefined ? {} : { signal },
  })
}

function delta(index: number, argumentsDelta: string): StreamChunk {
  return { type: 'tool-call-delta', index, id: ToolCallId(`call-${index}`), name: 'probe', argumentsDelta }
}

function blockEnd(index: number, argumentsText: string): StreamChunk {
  return { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`call-${index}`), name: 'probe', arguments: argumentsText } }
}

function repeatedMembers(count: number): string {
  return `{${Array.from({ length: count }, (_, index) => `"page_num":${index}`).join(',')}}`
}

async function collect(stream: AsyncIterable<StreamChunk>, chunks: StreamChunk[] = []): Promise<StreamChunk[]> {
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('explicit configuration and request selection', () => {
  it('keeps named plugin exports without a default', () => {
    expect('default' in guard).toBe(false)
    expect(guard.name).toBe('tool-argument-loop')
    expect(guard.inject).toEqual(['llm'])
  })

  it.each([undefined, {}, { repeatedPropertyLimit: 0 }, { repeatedPropertyLimit: 1 },
    { repeatedPropertyLimit: -1 }, { repeatedPropertyLimit: 1.5 },
    { repeatedPropertyLimit: Number.NaN }, { repeatedPropertyLimit: Number.POSITIVE_INFINITY },
    { repeatedPropertyLimit: Number.MAX_SAFE_INTEGER + 1 }, { repeatedPropertyLimit: '64' },
  ])('rejects a missing or unusable explicit threshold: %j', async (config) => {
    const ctx = new Context()
    contexts.add(ctx)
    await ctx.plugin(LlmRuntime)
    // @ts-expect-error Deliberately malformed external config must fail activation.
    await expect(ctx.plugin(guard, config)).rejects.toThrow()
  })

  it.each(['compaction', 'session-title'] as const)('does not filter an unmarked %s request', async (purpose) => {
    const script = [delta(0, repeatedMembers(18_000)), { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream({ provider: 'scripted', model: 'scripted', messages: [], purpose })))
      .toEqual(script)
    expect(adapter.exits).toBe(1)
  })
})

describe('stream detection and canonical tool blocks', () => {
  it('retains the 64th delta, throws the local LlmError, and closes upstream before pulling later chunks', async () => {
    const members = Array.from({ length: 64 }, (_, index) => delta(0, `${index === 0 ? '{' : ','}"page_num":${index}`))
    const script = [
      { type: 'block-start', index: 0, blockType: 'tool-call' } satisfies StreamChunk,
      ...members,
      delta(0, ',"must-not-be-read":1}'),
      blockEnd(0, repeatedMembers(64)),
      { type: 'finish', reason: { kind: 'tool-calls' } } satisfies StreamChunk,
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    const received: StreamChunk[] = []
    const settled = collect(ctx.llm.stream(request()), received)
    await expect(settled).rejects.toBeInstanceOf(LlmError)
    await expect(settled).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    expect(received).toEqual(script.slice(0, 65))
    expect(received.at(-1)).toBe(members.at(-1))
    expect(adapter.emitted).toEqual(received)
    expect(adapter.requests).toBe(1)
    expect(adapter.exits).toBe(1)
  })

  it('checks block-end-only raw arguments and preserves the triggering block', async () => {
    const trigger = blockEnd(0, repeatedMembers(64))
    const adapter = new ScriptedAdapter([trigger, delta(1, '{}')])
    const { ctx } = await harness(adapter)
    const received: StreamChunk[] = []
    await expect(collect(ctx.llm.stream(request()), received)).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    expect(received).toEqual([trigger])
    expect(adapter.emitted).toEqual([trigger])
    expect(adapter.exits).toBe(1)
  })

  it('does not append authoritative full arguments to already observed deltas', async () => {
    const argumentsText = repeatedMembers(63)
    const script = [delta(0, argumentsText), blockEnd(0, argumentsText), { type: 'finish', reason: { kind: 'tool-calls' } } satisfies StreamChunk]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(adapter.exits).toBe(1)
  })

  it('checks authoritative full arguments even when earlier deltas were safe', async () => {
    const script = [delta(0, '{}'), blockEnd(0, repeatedMembers(64))]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    const received: StreamChunk[] = []
    await expect(collect(ctx.llm.stream(request()), received)).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    expect(received).toEqual(script)
    expect(adapter.exits).toBe(1)
  })

  it('isolates interleaved tool-call indexes and subsequent requests', async () => {
    const script = [delta(0, repeatedMembers(63)), delta(1, repeatedMembers(63)),
      blockEnd(1, repeatedMembers(63)), blockEnd(0, repeatedMembers(63))]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(adapter.requests).toBe(2)
    expect(adapter.exits).toBe(2)
  })

  it('detects a loop only within the matching interleaved index', async () => {
    const script = [delta(0, '{"page_num":0'), delta(1, '{"page_num":0'), delta(0, ',"page_num":1')]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter, 2)
    const received: StreamChunk[] = []
    await expect(collect(ctx.llm.stream(request()), received)).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    expect(received).toEqual(script)
  })

  it('ignores stray deltas and duplicate ends after the first block end', async () => {
    const script = [delta(0, '{}'), blockEnd(0, '{}'), delta(0, repeatedMembers(64)), blockEnd(0, repeatedMembers(64))]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(adapter.exits).toBe(1)
  })

  it('treats a non-tool first block-end as closed rather than counting a later tool block', async () => {
    const script = [
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } } satisfies StreamChunk,
      blockEnd(0, repeatedMembers(64)), delta(0, repeatedMembers(64)),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
  })

  it('does not inspect repeated prose, reasoning, string values, or keys in separate array objects', async () => {
    const prose = 'page_num '.repeat(18_000)
    const text = JSON.stringify({ text: `${prose}{"page_num":0,"page_num":1}`, rows: Array.from({ length: 128 }, () => ({ page_num: 0 })) })
    const script = [
      { type: 'text-delta', index: 0, text: prose } satisfies StreamChunk,
      { type: 'reasoning-delta', index: 1, text: prose } satisfies StreamChunk,
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } satisfies StreamChunk,
      delta(2, text), blockEnd(2, text),
      { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk,
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await harness(adapter)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
  })
})

describe('iterator ownership, cancellation, and disposal', () => {
  it('awaits upstream return cleanup before the guard rejection settles', async () => {
    const closing = Promise.withResolvers<null>()
    const release = Promise.withResolvers<null>()
    let closed = false
    class CleanupAdapter extends LlmAdapter {
      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        try {
          yield delta(0, repeatedMembers(64))
          yield delta(1, '{}')
        } finally {
          closing.resolve(null)
          await release.promise
          closed = true
        }
      }
    }
    const { ctx } = await harness(new CleanupAdapter())
    const iterator = ctx.llm.stream(request())[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    let settled = false
    const next = iterator.next().finally(() => { settled = true })
    const rejection = expect(next).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    try {
      await closing.promise
      expect(settled).toBe(false)
      expect(closed).toBe(false)
    } finally {
      release.resolve(null)
      await rejection
    }
    expect(settled).toBe(true)
    expect(closed).toBe(true)
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('returns a partially consumed stream and awaits the adapter finalizer', async () => {
    const adapter = new ScriptedAdapter([delta(0, '{"page_num":0'), delta(0, ',"page_num":1')])
    const { ctx } = await harness(adapter, 2)
    const stream = ctx.llm.stream(request())
    for await (const chunk of stream) {
      expect(chunk).toEqual(delta(0, '{"page_num":0'))
      break
    }
    expect(adapter.emitted).toHaveLength(1)
    expect(adapter.exits).toBe(1)
  })

  it('passes the exact cancellation signal and settles after an abort barrier without detached work', async () => {
    const entered = Promise.withResolvers<null>()
    const exited = Promise.withResolvers<null>()
    let seenSignal: AbortSignal | undefined
    let activeListeners = 0
    class AbortAdapter extends LlmAdapter {
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const signal = options.signal
        if (!signal) throw new Error('test request must carry its owned signal')
        seenSignal = signal
        const aborted = Promise.withResolvers<null>()
        const onAbort = () => { aborted.resolve(null) }
        signal.addEventListener('abort', onAbort, { once: true })
        activeListeners++
        try {
          entered.resolve(null)
          if (signal.aborted) aborted.resolve(null)
          await aborted.promise
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'synthetic request aborted' } } }
        } finally {
          signal.removeEventListener('abort', onAbort)
          activeListeners--
          exited.resolve(null)
        }
      }
    }
    const controller = new AbortController()
    const { ctx } = await harness(new AbortAdapter())
    const completed = collect(ctx.llm.stream(request(controller.signal)))
    try {
      await entered.promise
      expect(seenSignal).toBe(controller.signal)
      expect(activeListeners).toBe(1)
    } finally {
      controller.abort()
    }
    expect(await completed).toEqual([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'synthetic request aborted' } } }])
    await exited.promise
    expect(activeListeners).toBe(0)
  })

  it('removes the middleware for new calls while an owned active stream still settles', async () => {
    const script = [delta(0, '{"page_num":0'), delta(0, ',"page_num":1}')]
    const adapter = new ScriptedAdapter(script)
    const { ctx, fiber } = await harness(adapter, 2)
    const active = ctx.llm.stream(request())[Symbol.asyncIterator]()
    expect(await active.next()).toEqual({ done: false, value: script[0] })
    await fiber.dispose()
    expect(await active.next()).toEqual({ done: false, value: script[1] })
    await expect(active.next()).rejects.toMatchObject({ code: guard.TOOL_ARGUMENT_LOOP })
    expect(adapter.exits).toBe(1)
    expect(await collect(ctx.llm.stream(request()))).toEqual(script)
    expect(adapter.requests).toBe(2)
    expect(adapter.exits).toBe(2)
  })
})
