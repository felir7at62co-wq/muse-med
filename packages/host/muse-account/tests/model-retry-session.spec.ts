/** Failed Muse model replies retry as fresh requests through the real AgentLoop, retry policy and account adapter. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { NormalRetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import * as retry from '../../../llm/llm-retry/src/index.ts'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4.1-flash-261017'
const ROUTE = `muse-cloud-${PROVIDER}`
// The Desktop composition's policy, with its backoff shortened to keep the suite fast.
const policy: NormalRetryPolicyConfig = {
  mode: 'normal', maxRetries: 8,
  retryableCodes: ['EMPTY_RESPONSE', 'INVALID_TOOL_ARGUMENTS', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROMPT_USAGE_SHORTFALL'],
  consecutiveRetryLimits: { PROMPT_USAGE_SHORTFALL: 1, INVALID_TOOL_ARGUMENTS: 2 },
  backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
}
const catalog = { providers: [{ id: PROVIDER, name: 'DeepSeek', models: [{ id: MODEL, name: 'DeepSeek Flash',
  contextWindow: 1_000_000, maxTokens: 32_000, input: ['text'], reasoningEfforts: false }] }] }

type Script = Parameters<typeof mockServer>[0]
const body = z.object({ messages: z.array(z.unknown()) })

const reasoning = JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Record the frames.' }, finish_reason: null }] })
const call = (id: string, args: string): string => JSON.stringify({ choices: [{ index: 0, delta: {
  tool_calls: [{ index: 0, id, type: 'function', function: { name: 'inspect', arguments: args } }] }, finish_reason: null }] })
const toolCallsFinish = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 5 } })
const toolReply = (id: string, args: string): Script[number] => ({ events: [reasoning, call(id, args), toolCallsFinish, '[DONE]'] })
// One complete argument object followed by an extra brace, as the cloud route streamed it.
const extraBrace = toolReply('call_bad', '{"note":"frame"}}')

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const operation of cleanup.splice(0).reverse()) await operation()
  await closeMockServers()
})

async function harness(script: Script, execute: () => Promise<string> = async () => 'recorded') {
  const root = await mkdtemp(join(tmpdir(), 'muse-model-retry-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await oldSessionFixture(false, root)
  cleanup.push(() => fixture.ctx.fiber.dispose())
  await fixture.ctx.plugin(Object.assign(async (scope: Context) => retry.apply(scope, {}), { inject: retry.inject }))
  const server = await mockServer(script)
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
  const models = new MuseModels(fixture.ctx, { baseUrl: server.url, sessionFile, requestTimeoutMs: 1000,
    modelRetryPolicy: policy, fetcher: async () => Response.json(catalog) })
  cleanup.push(() => models.dispose())
  const executions: unknown[] = []
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineContentToolFixture({ name: 'inspect',
    description: 'Record one frame note.', parameters: { note: { type: 'string' } },
    execute: async (args) => { executions.push(args); return [{ type: 'text', text: await execute() }] },
  })))
  await models.refresh()
  fixture.agent.model.select({ provider: ROUTE, model: MODEL })
  return { ctx: fixture.ctx, agent: fixture.agent, server, executions }
}

async function send(ctx: Context, agent: Agent): Promise<readonly SessionEvent[]> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Record the next frames.' }], source: { kind: 'user' } }))
  await idle
  return agent.session.snapshotEvents()
}

const of = <T extends SessionEvent['type']>(events: readonly SessionEvent[], type: T) =>
  events.filter((event): event is SessionEvent<T> => event.type === type)
const bodies = (requests: unknown[]) => requests.map(request => body.parse(request))

it('retries a reply whose tool arguments fail to parse as a fresh request before any tool runs', async () => {
  const { ctx, agent, server, executions } = await harness([extraBrace, { events: textEvents }])
  const events = await send(ctx, agent)

  expect(of(events, 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  expect(executions).toEqual([])
  expect(of(events, 'tool/call')).toEqual([])
  expect(of(events, 'llm/retry').map(event => event.data)).toMatchObject([{ step: 1, provider: ROUTE, retry: 1,
    failure: { code: 'INVALID_TOOL_ARGUMENTS', message: 'Upstream model returned invalid tool arguments. No tool from this reply ran; please retry.' } }])
  expect(of(events, 'assistant/attempt')).toHaveLength(1)
  expect(server.paths).toEqual([`/api/desktop-models/${PROVIDER}/chat/completions`, `/api/desktop-models/${PROVIDER}/chat/completions`])
  const [first, second] = bodies(server.requests)
  expect(second?.messages).toEqual(first?.messages)
  expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
})

it('retries a stream that ends inside an event without a finish reason', async () => {
  const truncated = `data: ${reasoning}\n\ndata: {"choices":[{"index":0,"delta":{"reasoning_content":"Rec`
  const { ctx, agent, server } = await harness([
    { headers: { 'content-type': 'text/event-stream' }, body: truncated }, { events: textEvents },
  ])
  const events = await send(ctx, agent)

  expect(of(events, 'llm/retry').map(event => event.data.failure.code)).toEqual(['TRANSPORT'])
  expect(of(events, 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  const [first, second] = bodies(server.requests)
  expect(second?.messages).toEqual(first?.messages)
})

it('stops at the consecutive limit for invalid tool arguments with the classified failure', async () => {
  const { ctx, agent, server, executions } = await harness([extraBrace, extraBrace, extraBrace, { events: textEvents }])
  const events = await send(ctx, agent)

  expect(server.requests).toHaveLength(3)
  expect(of(events, 'llm/retry')).toHaveLength(2)
  expect(executions).toEqual([])
  expect(of(events, 'turn/end').map(event => event.data.reason)).toMatchObject([{ kind: 'error', error: { code: 'INVALID_TOOL_ARGUMENTS' } }])
})

it('retries only the failed later step and does not repeat a tool that already ran', async () => {
  const { ctx, agent, server, executions } = await harness([
    toolReply('call_ok', '{"note":"first"}'), toolReply('call_bad', '{"note":"second"}}'), { events: textEvents },
  ])
  const events = await send(ctx, agent)

  expect(executions).toEqual([{ note: 'first' }])
  expect(of(events, 'llm/retry').map(event => event.data.step)).toEqual([2])
  expect(of(events, 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  const [, failed, retried] = bodies(server.requests)
  expect(retried?.messages).toEqual(failed?.messages)
  expect(retried?.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call_ok', content: 'recorded' }))
})

it('does not retry a request after its tool ran, even when the tool fails with a retryable code', async () => {
  const { ctx, agent, server, executions } = await harness([toolReply('call_ok', '{"note":"first"}'), { events: textEvents }],
    async () => { throw new LlmError('connection reset', 'TRANSPORT') })
  const events = await send(ctx, agent)

  expect(executions).toHaveLength(1)
  expect(server.requests).toHaveLength(2)
  expect(of(events, 'llm/retry')).toEqual([])
  expect(of(events, 'tool/result').map(event => ({ isError: event.data.message.isError, code: event.data.error?.code })))
    .toEqual([{ isError: true, code: 'TRANSPORT' }])
  expect(of(events, 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
})

it.each<[string, Script[number], string]>([
  ['a 402 quota refusal', { status: 402, body: JSON.stringify({ error: { code: 'quota_exhausted', message: 'Muse quota exhausted' } }) }, 'QUOTA'],
  ['a provider error event', { headers: { 'content-type': 'text/event-stream' },
    body: `data: ${reasoning}\n\ndata: ${JSON.stringify({ error: { message: 'request refused' } })}\n\n` }, 'PI_AI_ERROR'],
  ['a content filter finish', { events: [JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }), '[DONE]'] }, 'CONTENT_FILTER'],
])('does not retry %s', async (_label, reply, code) => {
  const { ctx, agent, server } = await harness([reply, { events: textEvents }])
  const events = await send(ctx, agent)

  expect(server.requests).toHaveLength(1)
  expect(of(events, 'llm/retry')).toEqual([])
  expect(of(events, 'turn/end').map(event => event.data.reason)).toMatchObject([{ kind: 'error', error: { code } }])
})

it('logs the original class, code and a quote-free message when a client exception becomes UNKNOWN', async () => {
  const { ctx, agent, server } = await harness([{ events: textEvents }])
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => { warnings.push(String(message)) })
  ctx.on('llm-pi-ai/request-headers', () => { throw new TypeError('header value "Secret argument" is invalid') })
  const events = await send(ctx, agent)

  expect(server.requests).toHaveLength(0)
  expect(of(events, 'turn/end').map(event => event.data.reason)).toMatchObject([{ kind: 'error', error: { code: 'UNKNOWN' } }])
  expect(warnings.filter(line => line.startsWith('Muse model failure reported as UNKNOWN'))).toEqual([
    `Muse model failure reported as UNKNOWN: provider="${ROUTE}" model="${MODEL}" source=thrown errorClass="LlmError"`
    + ' code="REQUEST_HEADERS" message="pi-ai request header preparation failed for provider …"',
  ])
  expect(warnings.join('\n')).not.toContain('Secret')
})
