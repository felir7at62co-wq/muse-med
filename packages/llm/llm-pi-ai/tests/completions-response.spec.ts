import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { completeCompletionsResponse } from '../src/completions-response.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const encoder = new TextEncoder()
const headers = { 'content-type': 'text/event-stream' }

function responseOf(parts: Uint8Array[], close = false) {
  const cancelled = Promise.withResolvers<unknown>()
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      if (close) controller.close()
    },
    cancel(reason) { cancelled.resolve(reason) },
  }), { headers })
  return { response, cancelled: cancelled.promise }
}

describe('Chat Completions transport completion', () => {
  it.each(['\n', '\r\n', '\r'])('recognizes a terminal event split at every byte with %j line endings', async (newline) => {
    const payload = `data: {"choices":[{"delta":{"content":"你好"}}]}${newline}${newline}`
    const terminal = `: keepalive${newline}id: final${newline}data: [DONE]${newline}${newline}`
    const bytes = encoder.encode(payload + terminal)
    for (let split = 0; split <= bytes.length; split++) {
      const source = responseOf([bytes.subarray(0, split), bytes.subarray(split), encoder.encode(': ignored\n\n')])
      const text = await completeCompletionsResponse(source.response).text()
      // CR alone already dispatches the event when its optional LF is in a later chunk.
      expect(text === payload + terminal || (newline === '\r\n' && text === (payload + terminal).slice(0, -1)))
        .toBe(true)
      await source.cancelled
    }
  })

  it('preserves usage and all choices after finish_reason, then drops a same-chunk tail', async () => {
    const beforeDone = [
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"index":1,"delta":{"content":"other choice"},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
      'data:[DONE]\n\n',
    ].join('')
    const source = responseOf([encoder.encode(beforeDone + 'data: {"error":{"message":"late error"}}\n\n')])
    expect(await completeCompletionsResponse(source.response).text()).toBe(beforeDone)
    await source.cancelled
  })

  it('keeps incomplete markers, comments, multiline data, and marker-like content until a real terminal event', async () => {
    const misleading = [
      '\n',
      ': data: [DONE]\n\n',
      'data: {"content":"[DONE]"}\n\n',
      `data: ${'x'.repeat(100_000)}\n\n`,
      'data: [DONE] suffix\n\n',
      'data:  [DONE]\n\n',
      'data\ndata: [DONE]\n\n',
      'data: [DONE]\ndata:\n\n',
      'data: [DONE]\ndata: extra\n\n',
    ].join('')
    const source = responseOf([encoder.encode(misleading), encoder.encode('data: [DO'), encoder.encode('NE]\n'), encoder.encode('\n')])
    expect(await completeCompletionsResponse(source.response).text()).toBe(misleading + 'data: [DONE]\n\n')
    await source.cancelled
  })

  it('recognizes a UTF-8 BOM split across the first terminal event', async () => {
    const bytes = encoder.encode('\uFEFFdata: [DONE]\n\n')
    const source = responseOf(Array.from(bytes, byte => Uint8Array.of(byte)))
    expect(await completeCompletionsResponse(source.response).text()).toBe('data: [DONE]\n\n')
    await source.cancelled
  })

  it.each(['data: [DONE]', 'data: [DONE]\n', 'data: {"finish_reason":"stop"}\n\n'])('preserves ordinary EOF without a complete marker: %j', async (text) => {
    const source = responseOf([encoder.encode(text)], true)
    expect(await completeCompletionsResponse(source.response).text()).toBe(text)
  })

  it('preserves status and headers', async () => {
    const response = new Response('data: [DONE]\n\n', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-request-id': 'synthetic', 'retry-after': '3' },
    })
    const wrapped = completeCompletionsResponse(response)
    expect(wrapped.status).toBe(response.status)
    expect(wrapped.statusText).toBe(response.statusText)
    expect([...wrapped.headers]).toEqual([...response.headers])
    expect(await wrapped.text()).toBe('data: [DONE]\n\n')
  })

  it.each([
    new Response(null, { status: 204, headers }),
    new Response('{"error":"invalid"}', { status: 400, headers }),
    new Response('{}', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array()),
  ])('does not replace non-SSE, unsuccessful, or bodyless responses', (response) => {
    expect(completeCompletionsResponse(response)).toBe(response)
  })

  it('propagates consumer cancellation to the original body', async () => {
    const source = responseOf([])
    const response = completeCompletionsResponse(source.response)
    await response.body!.cancel('consumer stopped')
    expect(await source.cancelled).toBe('consumer stopped')
  })

  it('propagates body errors before completion', async () => {
    const error = new Error('synthetic socket failure')
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(error) },
    }), { headers })
    await expect(completeCompletionsResponse(response).text()).rejects.toBe(error)
  })

  it('does not replace protocol completion with a rejected trailing-body cancellation', async () => {
    const cancelled = Promise.withResolvers<void>()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')) },
      cancel() {
        cancelled.resolve()
        return Promise.reject(new Error('synthetic cancellation failure'))
      },
    }), { headers })
    expect(await completeCompletionsResponse(response).text()).toBe('data: [DONE]\n\n')
    await cancelled.promise
  })
})

function model(baseUrl: string): Model<'openai-completions'> {
  return {
    id: 'glm-test', name: 'glm-test', api: 'openai-completions', provider: 'test', baseUrl,
    reasoning: true, input: ['text'], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { thinkingFormat: 'zai', supportsReasoningEffort: true, zaiToolStream: true, maxTokensField: 'max_tokens' },
  }
}

async function collect(baseUrl: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = []
  for await (const event of streamSimple(model(baseUrl), normalizeContext({
    messages: [{ role: 'user', content: 'synthetic request', timestamp: 0 }],
  }), {
    apiKey: 'synthetic-key', maxRetries: 0, reasoning: 'low', maxTokens: 64,
    headers: { 'x-provider-header': 'retained' }, signal,
    fetch: async (input, init) => completeCompletionsResponse(await fetcher(input, init)),
  })) events.push(event)
  return events
}

describe('installed pi-ai Chat Completions protocol', () => {
  it.each(['\n', '\r\n', '\r'])('finishes when the whole response arrives one byte at a time with %j endings', async (newline) => {
    const bytes = encoder.encode([
      'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].map(event => event + newline + newline).join(''))
    const source = responseOf(Array.from(bytes, byte => Uint8Array.of(byte)))
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const events = await collect('http://127.0.0.1:9', controller.signal, async () => source.response)
    expect(events.at(-1)).toMatchObject({
      type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: '你好' }] },
    })
    await source.cancelled
  })

  it('finishes with trailing usage while the provider leaves HTTP open', async () => {
    const server = await mockServer([{ holdOpen: true, events: [
      '{"choices":[{"index":0,"delta":{"reasoning_content":"checking"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
      '[DONE]',
    ] }])
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const events = await collect(server.url, controller.signal)
    expect(events.at(-1)).toMatchObject({
      type: 'done', reason: 'stop',
      message: {
        content: [{ type: 'thinking', thinking: 'checking' }, { type: 'text', text: '你好' }],
        usage: { input: 11, output: 7, totalTokens: 18 },
      },
    })
    await server.responseClosed
    expect(controller.signal.aborted).toBe(false)
    expect(server.requests).toEqual([expect.objectContaining({
      model: 'glm-test', max_tokens: 64, reasoning_effort: 'low', thinking: { type: 'enabled', clear_thinking: false },
    })])
    expect(server.headers[0]).toMatchObject({ authorization: 'Bearer synthetic-key', 'x-provider-header': 'retained' })
  })

  it('finalizes streamed tool arguments before completing a held-open response', async () => {
    const server = await mockServer([{ holdOpen: true, events: [
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"probe","arguments":"{\\"value\\":"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}',
      '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ] }])
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const events = await collect(server.url, controller.signal)
    expect(events.at(-1)).toMatchObject({
      type: 'done', reason: 'toolUse',
      message: { content: [{ type: 'toolCall', id: 'call-1', name: 'probe', arguments: { value: 1 } }] },
    })
    expect(events.some(event => event.type === 'toolcall_end')).toBe(true)
    await server.responseClosed
  })

  it('keeps a missing finish_reason as an SDK error even when DONE closes the body', async () => {
    const server = await mockServer([{ holdOpen: true, events: [
      '{"choices":[{"index":0,"delta":{"content":"incomplete"},"finish_reason":null}]}', '[DONE]',
    ] }])
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const events = await collect(server.url, controller.signal)
    expect(events.at(-1)).toMatchObject({
      type: 'error', error: { errorMessage: expect.stringContaining('Stream ended without finish_reason') },
    })
    await server.responseClosed
  })

  it('preserves caller abort while waiting for the terminal event', async () => {
    const server = await mockServer([{ holdOpen: true, events: [] }])
    const controller = new AbortController()
    onTestFinished(() => { controller.abort() })
    const collecting = collect(server.url, controller.signal)
    await server.requestReceived
    controller.abort('synthetic caller abort')
    expect((await collecting).at(-1)).toMatchObject({ type: 'error', reason: 'aborted' })
    await server.responseClosed
  })
})
