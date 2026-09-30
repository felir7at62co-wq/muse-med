import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MuseModels } from '../src/models.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { mockServer, closeMockServers, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { writeMuseSession, readMuseSession, clearMuseSessionIfUnchanged } from '../src/session.ts'
import * as DeepSeekApiKey from '../../../llm/llm-deepseek-api-key/src/index.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { buildModelCatalog } from '../../../api/session-controller/src/catalog.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'

const suppliedCatalog = { providers: [
  { id: 'aa', name: 'aa', models: [{ id: 'gemini-3.8-flash', name: 'gemini-3.8-flash',
    contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: false }] },
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash',
    contextWindow: 1000000, maxTokens: 256000, input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }] },
] }

async function directProviderFixture(configured: boolean) {
  return await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: {
      OTHER_PROVIDER_KEY: 'other-provider-test-value',
      ...(configured ? { OWN_DEEPSEEK_KEY: 'own-provider-test-value' } : {}),
    } },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'deepseek-official', model: 'previous-default' } },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'direct-deepseek', name: 'cordis:deepseek', config: { apiKeyEnv: 'OWN_DEEPSEEK_KEY',
      models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash' }] } },
  ], builtins: { llm: LlmRuntime, credentials: MemoryCredentials, deepseek: DeepSeekApiKey } })
}

async function oldSessionFixture(configured: boolean) {
  const fixture = await directProviderFixture(configured)
  await fixture.ctx.plugin(SessionStore)
  await fixture.ctx.plugin(SessionProjectionRegistry)
  await fixture.ctx.plugin(SystemPrompt, { personaPrefix: 'You use {{model}}.' })
  await fixture.ctx.plugin(ToolRuntime)
  await fixture.ctx.plugin(AgentRegistry)
  const controller = createSessionTestController(fixture.ctx, {
    cwd: root, defaultModelSelection: () => fixture.ctx.agentDefaultModel.currentSelection(),
  })
  const driver = await mountAgentLoopTestHarness(fixture.ctx)
  const agent = await driver.create(SessionId('old-direct-model-session'), {
    provider: 'deepseek-official', model: 'deepseek-flash',
  }, { cwd: root })
  const initialSelection = (await controller.selectModel({ sessionId: agent.id, provider: 'deepseek-official', model: 'deepseek-flash' })).selected
  return { ...fixture, controller, agent, initialSelection }
}

function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

class PersonalAdapter extends LlmAdapter {
  async *stream(): AsyncGenerator<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
let root: string
let ctx: Context
let models: MuseModels
const baseUrl = 'https://muse.test'
const catalog = { providers: [{ id: 'studio', name: '工作室', models: [{ id: 'writer', name: '编剧',
  contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'muse-models-'))
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['personal'], new PersonalAdapter())
})
afterEach(async () => {
  models?.dispose(); await ctx.fiber.dispose(); await closeMockServers()
  await rm(root, { recursive: true, force: true })
})
const sessionFile = (): string => join(root, 'session.json')
async function login(username = 'alice'): Promise<void> {
  await writeMuseSession(sessionFile(), { baseUrl, username, cookie: `__Host-muse=${username}-session` })
}

it('adds Muse models beside a personal adapter and removes only Muse on logout', async () => {
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  await models.refresh()
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal'])
  await login(); await models.refresh()
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal', 'muse-cloud-studio'])
  expect(await ctx.llm.listModels('muse-cloud-studio')).toMatchObject([{ id: 'writer' }])
  const session = await readMuseSession(sessionFile(), baseUrl)
  if (!session) throw new Error('Missing session')
  await clearMuseSessionIfUnchanged(sessionFile(), session); await models.refresh()
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal'])
})

it('does not publish catalog fetched for an account that changed during the request', async () => {
  await login()
  let entered: (() => void) | undefined
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => { entered?.(); await pending; return Response.json(catalog) } })
  const refresh = models.refresh(); await started
  await login('bob'); release?.(); await refresh
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal'])
  await models.refresh()
  expect(ctx.llm.listProviders().map(p => p.id)).toContain('muse-cloud-studio')
})

it('withdraws expired sessions and rejects malformed model metadata', async () => {
  await login()
  let response = Response.json(catalog)
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => response.clone() })
  await models.refresh()
  response = new Response('', { status: 401 }); await models.refresh()
  expect(await readMuseSession(sessionFile(), baseUrl)).toBeNull()
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal'])
  await login(); response = Response.json({ providers: [{ ...catalog.providers[0], id: '../admin' }] })
  await expect(models.refresh()).rejects.toThrow()
  expect(ctx.llm.listProviders().map(p => p.id)).toEqual(['personal'])
})

it('uses the Muse session for real streaming and rejects a stale catalog after account replacement', async () => {
  const server = await mockServer([{ events: textEvents }])
  await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
  models = new MuseModels(ctx, { baseUrl: server.url, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  await models.refresh()
  const result = await assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer', messages: [] })
  expect(result.finish).toEqual({ kind: 'stop' })
  expect(server.paths).toEqual(['/api/desktop-models/studio/chat/completions'])
  expect(server.headers[0]?.authorization).toBe('Bearer alice-session')
  expect(server.headers[0]?.origin).toBe(server.url)
  await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'bob', cookie: '__Host-muse=bob-session' })
  expect((await assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer', messages: [] })).finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  expect(server.requests).toHaveLength(1)
})

it('selects the first Muse model through real Loader settings and preserves a custom selection', async () => {
  const fixture = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'llm', name: 'cordis:llm' },
  ], builtins: { llm: LlmRuntime } })
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  await models.refresh()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'muse-cloud-studio', model: 'writer' })
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'personal', model: 'private-model' })
  await login('bob'); await models.refresh()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'personal', model: 'private-model' })
  models.dispose()
})

it.each([false, true])('repairs a saved direct default only when its own credential is unconfigured (%s)', async (configured) => {
  const fixture = await directProviderFixture(configured)
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'deepseek-official', model: 'deepseek-flash' })
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({
    provider: configured ? 'deepseek-official' : 'muse-cloud-deepseek-official', model: 'deepseek-flash',
  })
})

it('publishes the supplied Gemini and DeepSeek metadata through the browser catalog', async () => {
  await login()
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedModelPrefixes: ['gpt-', 'chatgpt-', 'o1', 'o3', 'o4'],
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const browser = await buildModelCatalog(ctx, { provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' })
  expect(browser.groups.filter(group => group.id.startsWith('muse-cloud-'))).toEqual([
    { id: 'muse-cloud-aa', name: 'Muse · aa', models: [{ id: 'gemini-3.8-flash', name: 'gemini-3.8-flash' }] },
    { id: 'muse-cloud-deepseek-official', name: 'Muse · DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash',
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }] },
  ])
  expect(browser.failures.filter(group => group.id.startsWith('muse-cloud-'))).toEqual([])
})

it('routes an existing unconfigured direct session through Muse and records the actual selection and request', async () => {
  const fixture = await oldSessionFixture(false)
  const server = await mockServer([{ events: textEvents }])
  await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
  models = new MuseModels(fixture.ctx, { baseUrl: server.url, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const idle = waitForIdle(fixture.ctx, fixture.agent)
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the script.' }], source: { kind: 'user' } }))
  await idle
  expect(server.paths).toEqual(['/api/desktop-models/deepseek-official/chat/completions'])
  expect(server.headers[0]?.authorization).toBe('Bearer alice-session')
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  expect(fixture.agent.session.requestHeader()?.config)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  expect(fixture.ctx.sessionProjections.snapshot(fixture.agent.session).values.modelSelection?.next)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  const routingEvents = fixture.agent.session.snapshotEvents()
    .filter(event => event.type === 'model/selection' || event.type === 'request/header')
    .map(event => ({ type: event.type, data: event.data }))
  await expect(`${JSON.stringify(routingEvents, null, 2)}\n`).toMatchFileSnapshot(fileURLToPath(
    new URL('./expected/muse-direct-model-login-repair.json', import.meta.url),
  ))
})

it('preserves an existing direct session with its own configured key', async () => {
  const fixture = await oldSessionFixture(true)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const count = fixture.agent.session.snapshotEvents().length
  const config = await agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-flash' }))
  expect(config).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  expect(fixture.agent.session.snapshotEvents()).toHaveLength(count)
})

it('does not replace an existing session with a different supplied model', async () => {
  const fixture = await oldSessionFixture(false)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json({ providers: [{ ...suppliedCatalog.providers[1],
      models: [{ ...suppliedCatalog.providers[1]!.models[0], id: 'other-model' }] }] }) })
  await models.refresh()
  const count = fixture.agent.session.snapshotEvents().length
  await expect(agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-flash',
    ...(fixture.initialSelection.reasoningEffort === undefined ? {}
      : { reasoningEffort: ReasoningEffortId(fixture.initialSelection.reasoningEffort) }) }))).rejects.toMatchObject({
    code: 'UNKNOWN_MODEL', message: 'The saved direct model is not in the Muse catalog. Select an available Muse model in the conversation model picker.',
  })
  expect(fixture.agent.session.snapshotEvents()).toHaveLength(count)
})

it.each(['provider', 'reasoning'] as const)('retains a newer explicit %s selection when an account-route repair reaches the Session queue', async (change) => {
  const fixture = await oldSessionFixture(false)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const wanted = change === 'provider' ? { provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' }
    : { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }
  const userChange = fixture.controller.selectModel({ sessionId: fixture.agent.id, ...wanted })
  const repair = fixture.controller.selectModelIfCurrent({ sessionId: fixture.agent.id,
    provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' }, fixture.initialSelection)
  await userChange
  expect(await repair).toBeUndefined()
  expect(fixture.ctx.sessionProjections.snapshot(fixture.agent.session).values.modelSelection?.next)
    .toMatchObject(wanted)
})

it.each(['provider', 'reasoning'] as const)('does not replace a newer %s choice when the Muse request router resumes an older request', async (change) => {
  const fixture = await oldSessionFixture(false)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const wanted = change === 'provider' ? { provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' }
    : { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }
  const assembled = { provider: fixture.initialSelection.provider, model: fixture.initialSelection.model,
    ...(fixture.initialSelection.reasoningEffort === undefined ? {}
      : { reasoningEffort: ReasoningEffortId(fixture.initialSelection.reasoningEffort) }) }
  const config = await agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => {
    await fixture.controller.selectModel({ sessionId: fixture.agent.id, ...wanted })
    return assembled
  })
  expect(config).toEqual(assembled)
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
    .toEqual(wanted)
  expect(fixture.ctx.sessionProjections.snapshot(fixture.agent.session).values.modelSelection?.next).toEqual(wanted)
})

it('excludes supplied GPT models while leaving custom adapters available', async () => {
  await login()
  const provider = catalog.providers[0]!
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedModelPrefixes: ['gpt-', 'chatgpt-', 'o1', 'o3', 'o4'],
    fetcher: async () => Response.json({ providers: [{ ...provider, models: [provider.models[0],
      { ...provider.models[0], id: 'openai/GPT-5' }, { ...provider.models[0], id: 'o3' }] }] }) })
  await models.refresh()
  expect((await ctx.llm.listModels('muse-cloud-studio')).map(model => model.id)).toEqual(['writer'])
  expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('personal')
})


it.each(['same-model', 'changed-model', 'changed-provider', 'missing-replay'] as const)(
  'keeps reasoning separate from answer text during %s Muse history replay', async (history) => {
    const events = [
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'private scratchpad' }, finish_reason: null }] }),
      ...textEvents.slice(0, 2),
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1',
        type: 'function', function: { name: 'lookup', arguments: '{"query":"note"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]
    const server = await mockServer([{ events }, { events: textEvents }])
    await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
    models = new MuseModels(ctx, { baseUrl: server.url, sessionFile: sessionFile(), requestTimeoutMs: 1000,
      fetcher: async () => Response.json({ providers: ['deepseek-official', 'studio'].map(id => ({
        id, name: id, models: ['deepseek-v4-flash', 'previous'].map(id => ({
          id, name: id, contextWindow: 128000, maxTokens: 8192,
          input: ['text'], reasoningEfforts: { low: 'low', high: 'high' },
        })),
      })) }) })
    await models.refresh()
    const request = { provider: 'muse-cloud-deepseek-official', model: 'deepseek-v4-flash' }
    const first = await assemble(ctx, { ...request, messages: [] })
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    expect(first.message.content).toEqual([
      { type: 'reasoning', text: 'private scratchpad' }, { type: 'text', text: 'hello' },
      { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"query":"note"}' },
    ])
    if (first.message.role !== 'assistant') throw new Error('Expected assistant history')
    const source = first.message.source
    const message = { ...first.message, source: {
      ...source,
      ...(history === 'missing-replay' ? { replayState: undefined } : {}),
    } }
    expect((await assemble(ctx, { ...request,
      ...(history === 'changed-model' ? { model: 'previous' } : {}),
      ...(history === 'changed-provider' ? { provider: 'muse-cloud-studio' } : {}),
      messages: [message, createToolResultMessage({ callId: ToolCallId('call-1'), isError: false, content: [{ type: 'text', text: 'found' }] })] })).finish).toEqual({ kind: 'stop' })
    const payload = server.requests[1] as { messages: { role: string; content: string; reasoning_content?: string }[] }
    const assistant = payload.messages.find(message => message.role === 'assistant')
    expect(assistant?.content).toBe('hello')
    expect(assistant?.reasoning_content).toBe(history === 'same-model' ? 'private scratchpad' : history === 'changed-provider' ? undefined : '')
  },
)
