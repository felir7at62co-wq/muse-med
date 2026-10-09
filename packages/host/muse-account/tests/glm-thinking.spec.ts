/** Account GLM wire settings and unchanged reasoning replay across real tool execution. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

afterEach(closeMockServers)

const reasoning = ['Read input\n', 'then call the probe.']
const history = z.object({ messages: z.array(z.object({
  role: z.string(),
  content: z.string().nullable().optional(),
  reasoning_content: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
})) })

it.each([
  { provider: 'zhipu-official', model: 'glm-5.3-flash' },
  { provider: 'zhipu-official', model: 'glm-5.3-flashx' },
  { provider: 'yunying', model: 'glm-5.3-flash' },
])('preserves official thinking through tool continuation without adding settings to $provider/$model', async ({ provider, model }) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-glm-thinking-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const official = provider === 'zhipu-official'
  const server = await mockServer([{ events: [
    ...official ? reasoning.map(part => JSON.stringify({ choices: [{ index: 0,
      delta: { reasoning_content: part }, finish_reason: null }] })) : [],
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'glm-probe', type: 'function',
      function: { name: 'catalog_probe', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 30, completion_tokens: 4 } }), '[DONE]',
  ] }, { events: textEvents }])
  const catalog = { providers: [{ id: provider, name: provider, models: [{ id: model, name: model,
    contextWindow: 200000, maxTokens: 128000, input: ['text'],
    reasoningEfforts: official ? { off: null, max: 'max' } : false,
    ...official ? { defaultReasoningEffort: 'max' } : {},
  }] }] }
  const sessionFile = join(home, 'session.json')
  const baseUrl = 'https://muse.test'
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
  const fixture = await oldSessionFixture(false, home)
  const models = new MuseModels(fixture.ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers')
      ? { ...catalog, transport: 'direct' }
      : { transport: 'direct', providers: catalog.providers.map(entry => ({ ...entry,
        access: { baseURL: `${server.url}/api/paas/v4`, apiKey: 'glm-thinking-fixture-key' } })) }),
  })
  onTestFinished(() => models.dispose())
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineContentToolFixture({ name: 'catalog_probe',
    description: 'Read the acceptance probe result.', parameters: {},
    execute: async () => [{ type: 'text', text: 'PROBE_OK' }],
  })))
  await models.refresh()
  await fixture.controller.selectModel({ sessionId: fixture.agent.id, provider: `muse-cloud-${provider}`, model })
  const idle = waitForIdle(fixture.ctx, fixture.agent)
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the probe, then report its result.' }], source: { kind: 'user' } }))
  await idle
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
    .toMatchObject([{ data: { reason: { kind: 'completed' } } }])
  expect(server.paths).toEqual(Array.from({ length: 2 }, () => '/api/paas/v4/chat/completions'))
  expect(server.requests).toHaveLength(2)
  for (const request of server.requests) {
    expect(request).toMatchObject({ model, max_tokens: 128000 })
    if (official) {
      expect(request).toMatchObject({ reasoning_effort: 'max', thinking: { type: 'enabled', clear_thinking: false } })
    } else {
      expect(request).not.toHaveProperty('thinking')
      expect(request).not.toHaveProperty('reasoning_effort')
    }
  }
  const messages = history.parse(server.requests[1]).messages
  const assistant = messages.find(message => message.role === 'assistant')
  expect(assistant?.tool_calls).toMatchObject([{ id: 'glm-probe', function: { name: 'catalog_probe', arguments: '{}' } }])
  expect(messages.find(message => message.role === 'tool'))
    .toMatchObject({ tool_call_id: 'glm-probe', content: 'PROBE_OK' })
  if (official) expect(assistant?.reasoning_content).toBe(reasoning.join(''))
})
