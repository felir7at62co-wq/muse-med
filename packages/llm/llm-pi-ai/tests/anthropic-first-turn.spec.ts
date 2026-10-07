import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const toolEvents = [
  { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup_code', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"blue"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
].map(event => JSON.stringify(event))

const answerEvents = [
  { type: 'message_start', message: { id: 'msg_answer', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ocean.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
].map(event => JSON.stringify(event))

it('sends tools on the first Anthropic request and continues from its tool result', async () => {
  vi.stubEnv('PI_CLAUDE_TEST_KEY', 'synthetic-test-key')
  const server = await mockServer([{ events: toolEvents, namedEvents: true }, { events: answerEvents, namedEvents: true }])
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: {
      'claude-gateway-test': {
        apiKeyEnv: 'PI_CLAUDE_TEST_KEY',
        api: 'anthropic-messages',
        baseURL: server.url,
        models: [{ id: 'claude-test' }],
      },
    } })
    const prompt = [createUserMessage({
      content: [{ type: 'text', text: 'Use lookup_code with code blue.' }],
      source: { kind: 'user' },
    })]
    const tools = [{
      name: 'lookup_code',
      description: 'Look up a short code.',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }]
    const first = await assemble(ctx, { provider: 'claude-gateway-test', model: 'claude-test', messages: prompt, tools })
    expect(server.paths.map(path => new URL(path, server.url).pathname)).toEqual(['/v1/messages'])
    expect(server.requests[0]).toMatchObject({
      model: 'claude-test',
      tools: [{ name: 'lookup_code' }],
    })
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    expect(first.message.content).toMatchObject([{ type: 'tool-call', id: 'toolu_1', name: 'lookup_code', arguments: '{"code":"blue"}' }])

    const second = await assemble(ctx, {
      provider: 'claude-gateway-test', model: 'claude-test', tools,
      messages: [...prompt, first.message, createToolResultMessage({
        callId: ToolCallId('toolu_1'), content: [{ type: 'text', text: 'The code means ocean.' }], isError: false,
      })],
    })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(second.message.content).toEqual([{ type: 'text', text: 'Ocean.' }])
    expect(server.requests[1]).toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_code' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      ],
    })
  } finally {
    await ctx.fiber.dispose()
  }
})
