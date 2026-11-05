/** Account-supplied DeepSeek thinking parameters and reasoning replay over HTTP. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

afterEach(closeMockServers)

const reasoning = 'Read the supplier probe before answering.'
const toolEvents = [
  JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'supplier-probe', type: 'function',
    function: { name: 'supplier_probe', arguments: '{}' } }] }, finish_reason: null }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 30, completion_tokens: 4 } }), '[DONE]',
]
const wireHistory = z.object({ messages: z.array(z.object({
  role: z.string(), reasoning_content: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string() })).optional(),
  tool_call_id: z.string().optional(), content: z.string().nullable().optional(),
})) })

async function fixture(provider: string, model: string, enabled = true) {
  const home = await mkdtemp(join(tmpdir(), 'muse-supplier-thinking-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const server = await mockServer([{ events: toolEvents }, { events: textEvents }])
  const sessionFile = join(home, 'session.json'), baseUrl = server.url
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=supplier-session' })
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async () => Response.json({ providers: [{ id: provider, name: provider, models: [{
      id: model, name: model, contextWindow: 128000, maxTokens: 2048, input: ['text'],
      reasoningEfforts: enabled ? { off: null, low: 'low', high: 'high' } : false,
      ...enabled ? { defaultReasoningEffort: 'low' } : {},
    }] }] }),
  })
  onTestFinished(() => models.dispose())
  await models.refresh()
  return { ctx, server, provider: `muse-cloud-${provider}`, model }
}

it.each([
  ['volcengine-ark', 'deepseek-v4-1-flash-260910'],
  ['volcengine-ark', 'deepseek-v4-1-flash-261017'],
  ['volcengine-ark', 'deepseek-v4.1-flash-260910'],
  ['volcengine-ark', 'deepseek-v4.1-flash-261017'],
  ['alibaba-bailian', 'deepseek-v4.1-flash-1017'],
] as const)('preserves %s/%s reasoning through a tool continuation', async (provider, model) => {
  const f = await fixture(provider, model)
  const prepared = await f.ctx.llm.prepareCall({ provider: f.provider, model })
  expect(prepared.config.reasoningEffort).toBe('low')
  const called = await assemble(f.ctx, { ...prepared.config, messages: [] })
  expect(called.finish).toEqual({ kind: 'tool-calls' })
  expect(called.message.content).toEqual([
    { type: 'reasoning', text: reasoning },
    { type: 'tool-call', id: 'supplier-probe', name: 'supplier_probe', arguments: '{}' },
  ])
  const continued = await assemble(f.ctx, { ...prepared.config, messages: [called.message,
    createToolResultMessage({ callId: ToolCallId('supplier-probe'), isError: false,
      content: [{ type: 'text', text: 'SUPPLIER_PROBE_OK' }] }),
  ] })
  expect(continued.finish).toEqual({ kind: 'stop' })
  expect(f.server.requests).toHaveLength(2)
  for (const request of f.server.requests) {
    expect(request).toMatchObject({ model, max_tokens: 2048, reasoning_effort: 'low' })
    if (provider === 'alibaba-bailian') {
      expect(request).toHaveProperty('enable_thinking', true)
      expect(request).not.toHaveProperty('thinking')
    } else {
      expect(request).toHaveProperty('thinking', { type: 'enabled' })
      expect(request).not.toHaveProperty('enable_thinking')
    }
  }
  const messages = wireHistory.parse(f.server.requests[1]).messages
  expect(messages.find(message => message.role === 'assistant'))
    .toMatchObject({ reasoning_content: reasoning, tool_calls: [{ id: 'supplier-probe' }] })
  expect(messages.find(message => message.role === 'tool'))
    .toMatchObject({ tool_call_id: 'supplier-probe', content: 'SUPPLIER_PROBE_OK' })
  expect(f.server.paths).toEqual(Array.from({ length: 2 }, () => `/api/desktop-models/${provider}/chat/completions`))
})

it.each([
  ['volcengine-ark', 'deepseek-v4-1-flash-261017'],
  ['alibaba-bailian', 'deepseek-v4.1-flash-1017'],
] as const)('honors explicit on and off choices for %s/%s', async (provider, model) => {
  const f = await fixture(provider, model)
  for (const effort of ['high', 'off'] as const) {
    const prepared = await f.ctx.llm.prepareCall({ provider: f.provider, model, reasoningEffort: ReasoningEffortId(effort) })
    await assemble(f.ctx, { ...prepared.config, messages: [] })
    const wire = f.server.requests.at(-1)
    if (effort === 'off') expect(wire).not.toHaveProperty('reasoning_effort')
    else expect(wire).toHaveProperty('reasoning_effort', effort)
    if (provider === 'alibaba-bailian') {
      expect(wire).toHaveProperty('enable_thinking', effort !== 'off')
      expect(wire).not.toHaveProperty('thinking')
    } else {
      expect(wire).toHaveProperty('thinking', { type: effort === 'off' ? 'disabled' : 'enabled' })
      expect(wire).not.toHaveProperty('enable_thinking')
    }
  }
  expect((await f.ctx.llm.prepareCall({ provider: f.provider, model })).config.reasoningEffort).toBe('low')
})

it.each([
  ['volcengine-ark', 'deepseek-v4-1-flash-261017'],
  ['alibaba-bailian', 'deepseek-v4.1-flash-1017'],
] as const)('supplies required empty reasoning for earlier tool calls on %s/%s', async (provider, model) => {
  const f = await fixture(provider, model)
  const prepared = await f.ctx.llm.prepareCall({ provider: f.provider, model })
  await assemble(f.ctx, { ...prepared.config, messages: [
    createAssistantMessage({ source: { provider: f.provider, model },
      content: [{ type: 'tool-call', id: ToolCallId('previous-probe'), name: 'supplier_probe', arguments: '{}' }] }),
    createToolResultMessage({ callId: ToolCallId('previous-probe'), isError: false,
      content: [{ type: 'text', text: 'PREVIOUS_PROBE_OK' }] }),
  ] })
  const messages = wireHistory.parse(f.server.requests[0]).messages
  expect(messages.find(message => message.role === 'assistant'))
    .toMatchObject({ reasoning_content: '', tool_calls: [{ id: 'previous-probe' }] })
})

it.each([
  ['studio', 'deepseek-v4-1-flash-261017'],
  ['studio', 'deepseek-v4.1-flash-1017'],
  ['volcengine-ark', 'deepseek-v4-1-flash-unknown'],
  ['alibaba-bailian', 'qwen-unlisted'],
] as const)('keeps generic reasoning settings for the other route %s/%s', async (provider, model) => {
  const f = await fixture(provider, model)
  const prepared = await f.ctx.llm.prepareCall({ provider: f.provider, model })
  await assemble(f.ctx, { ...prepared.config, messages: [] })
  expect(f.server.requests[0]).toHaveProperty('reasoning_effort', 'low')
  expect(f.server.requests[0]).not.toHaveProperty('thinking')
  expect(f.server.requests[0]).not.toHaveProperty('enable_thinking')
})

it.each([
  ['studio', 'deepseek-v4-1-flash-261017'],
  ['studio', 'deepseek-v4.1-flash-1017'],
  ['volcengine-ark', 'glm-5.3-flash-260828'],
  ['volcengine-ark', 'deepseek-v4-1-flash-unknown'],
  ['alibaba-bailian', 'qwen-unlisted'],
] as const)('does not add supplier thinking fields to %s/%s without declared thinking', async (provider, model) => {
  const f = await fixture(provider, model, false)
  const prepared = await f.ctx.llm.prepareCall({ provider: f.provider, model })
  await assemble(f.ctx, { ...prepared.config, messages: [] })
  expect(prepared.config).not.toHaveProperty('reasoningEffort')
  expect(f.server.requests[0]).not.toHaveProperty('thinking')
  expect(f.server.requests[0]).not.toHaveProperty('enable_thinking')
  expect(f.server.requests[0]).not.toHaveProperty('reasoning_effort')
})
