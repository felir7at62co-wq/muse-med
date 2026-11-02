/** Signed Chat Completions tool calls survive persisted history and stay model-scoped. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

const tool = { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object', properties: { key: { type: 'number' } }, required: ['key'] } }
const signature = 'signed-gemini-tool-call'

function toolEvents(firstSignature: unknown): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant', reasoning_content: 'Look up both values.',
      tool_calls: [0, 1].map(index => ({
        index, id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ key: index }) },
      })),
    }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {
      tool_calls: [{ index: 0, extra_content: { google: { thought_signature: firstSignature } } }],
    }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    '[DONE]',
  ]
}

async function harness(url: string): Promise<Context> {
  vi.stubEnv('GEMINI_REPLAY_TEST_KEY', 'test-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { route: {
    api: 'openai-completions', baseURL: url, apiKeyEnv: 'GEMINI_REPLAY_TEST_KEY',
    models: [{ id: 'gemini' }, { id: 'other-model' }],
  } } })
  return ctx
}

function messages(request: unknown): Record<string, unknown>[] {
  if (typeof request !== 'object' || request === null || !('messages' in request) || !Array.isArray(request.messages)) {
    throw new Error('Expected Chat Completions request messages')
  }
  return request.messages as Record<string, unknown>[]
}

async function signedHistory(ctx: Context): Promise<Message[]> {
  const initial = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up both values.' }] })
  const first = await assemble(ctx, { provider: 'route', model: 'gemini', messages: [initial], tools: [tool] })
  expect(first.finish).toEqual({ kind: 'tool-calls' })
  const calls = first.message.content.filter(block => block.type === 'tool-call')
  expect(calls).toHaveLength(2)
  expect(first.message.source).toMatchObject({ replayState: { blocks: [
    { type: 'reasoning' }, { type: 'tool-call', thoughtSignature: signature }, { type: 'tool-call' },
  ] } })
  return JSON.parse(JSON.stringify([initial, first.message, ...calls.map(call => createToolResultMessage({
    callId: call.id, content: [{ type: 'text', text: 'value' }], isError: false,
  }))])) as Message[]
}

describe('Gemini Chat Completions signatures', () => {
  it('replays only the signed tool call after JSON persistence without changing history', async () => {
    const server = await mockServer([{ events: toolEvents(signature) }, { events: textEvents }])
    const ctx = await harness(server.url)
    const history = await signedHistory(ctx)
    const saved = JSON.stringify(history)
    const second = await assemble(ctx, { provider: 'route', model: 'gemini', messages: history, tools: [tool] })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(second.message.content).toEqual([{ type: 'text', text: 'hello' }])
    const calls = messages(server.requests[1]).flatMap(message => (message['tool_calls'] ?? []) as Record<string, unknown>[])
    expect(calls).toMatchObject([
      { id: 'call_0', function: { name: 'lookup', arguments: '{"key":0}' }, extra_content: { google: { thought_signature: signature } } },
      { id: 'call_1', function: { name: 'lookup', arguments: '{"key":1}' } },
    ])
    expect(calls[1]).not.toHaveProperty('extra_content')
    expect(messages(server.requests[1]).filter(message => message['role'] === 'tool').map(message => message['tool_call_id'])).toEqual(['call_0', 'call_1'])
    expect(JSON.stringify(history)).toBe(saved)
    expect(server.requests).toHaveLength(2)
  })

  it('omits another model\'s signature without destroying the original replay metadata', async () => {
    const server = await mockServer([{ events: toolEvents(signature) }, { events: textEvents }, { events: textEvents }])
    const ctx = await harness(server.url)
    const history = await signedHistory(ctx)
    const saved = JSON.stringify(history)
    expect((await assemble(ctx, { provider: 'route', model: 'other-model', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(server.requests[1])).not.toContain(signature)
    expect((await assemble(ctx, { provider: 'route', model: 'gemini', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(server.requests[2])).toContain(signature)
    expect(JSON.stringify(history)).toBe(saved)
  })

  it('keeps legacy OpenRouter encrypted reasoning in reasoning_details instead of Gemini extra_content', async () => {
    const detail = { type: 'reasoning.encrypted', id: 'legacy-reasoning', data: 'encrypted-content' }
    const server = await mockServer([{ events: toolEvents(JSON.stringify(detail)) }, { events: textEvents }])
    const ctx = await harness(server.url)
    const initial = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up both values.' }] })
    const first = await assemble(ctx, { provider: 'route', model: 'gemini', messages: [initial], tools: [tool] })
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    const history = [initial, first.message, ...calls.map(call => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'value' }], isError: false }))]
    expect((await assemble(ctx, { provider: 'route', model: 'gemini', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    const assistant = messages(server.requests[1]).find(message => message['role'] === 'assistant')
    expect(assistant).toHaveProperty('reasoning_details', [detail])
    expect(JSON.stringify(assistant)).not.toContain('extra_content')
  })

  it.each([undefined, '', 3, { value: 'invalid' }])('ignores absent or invalid signature metadata: %j', async (value) => {
    const server = await mockServer([{ events: toolEvents(value) }, { events: textEvents }])
    const ctx = await harness(server.url)
    const initial = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up both values.' }] })
    const first = await assemble(ctx, { provider: 'route', model: 'gemini', messages: [initial], tools: [tool] })
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    const history = [initial, first.message, ...calls.map(call => createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'value' }], isError: false }))]
    expect((await assemble(ctx, { provider: 'route', model: 'gemini', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(server.requests[1])).not.toContain('thought_signature')
  })
})

describe('Chat Completions usage preservation', () => {
  it.each([{}, { prompt_tokens: 'invalid', completion_tokens: 'invalid' }, { prompt_tokens: -1, completion_tokens: -1 }])('keeps valid usage when a later terminal frame carries unusable usage: %j', async (invalid) => {
    const server = await mockServer([{ events: [
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }], usage: { prompt_tokens: 13, completion_tokens: 5 } }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: invalid }),
      '[DONE]',
    ] }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { provider: 'route', model: 'gemini', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello.' }] })] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 })
  })

  it('uses valid choice usage when the top-level usage object is empty', async () => {
    const server = await mockServer([{ events: [
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop', usage: { prompt_tokens: 13, completion_tokens: 5 } }], usage: {} }),
      '[DONE]',
    ] }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { provider: 'route', model: 'gemini', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello.' }] })] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 })
  })
})
