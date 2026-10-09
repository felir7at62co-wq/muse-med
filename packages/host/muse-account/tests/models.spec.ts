import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MuseModels } from '../src/models.ts'
import * as modelAccess from '../src/model-access.ts'
import { inject as accountInject } from '../src/index.ts'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { mockServer, closeMockServers, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { writeMuseSession, readMuseSession, clearMuseSessionIfUnchanged } from '../src/session.ts'
import { buildModelCatalog } from '../../../api/session-controller/src/catalog.ts'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { directProviderFixture, oldSessionFixture as routingFixture, waitForIdle } from './model-routing-fixture.ts'

const suppliedCatalog = { providers: [
  { id: 'aa', name: 'aa', models: [{ id: 'gemini-3.8-flash', name: 'gemini-3.8-flash',
    contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: false }] },
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-Flash',
    contextWindow: 1000000, maxTokens: 256000, input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }] },
] }

async function oldSessionFixture(configured: boolean) {
  return await routingFixture(configured, root)
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
  await models?.dispose(); await ctx.fiber.dispose(); await closeMockServers()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const sessionFile = (): string => join(root, 'session.json')
async function login(username = 'alice'): Promise<void> {
  await writeMuseSession(sessionFile(), { baseUrl, username, cookie: `__Host-muse=${username}-session` })
}

it('negotiates direct supplier streaming and stores private access outside the conversation', async () => {
  const server = await mockServer([{ events: textEvents }, { events: textEvents }])
  await login()
  let key = 'supplier-test-key'
  const calls: string[] = []
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async (url, init) => {
      expect(new Headers(init?.headers).get('cookie')).toBe('__Host-muse=alice-session')
      expect(new Headers(init?.headers).get('x-muse-model-access')).toBe('direct-v1')
      const path = new URL(url instanceof Request ? url.url : url).pathname
      calls.push(path)
      return Response.json(path.endsWith('/providers') ? { ...catalog, transport: 'direct' }
        : { transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider, access: { baseURL: server.url + '/v1', apiKey: key } })) })
    } })
  await models.refresh()
  const file = join(root, 'model-access.json')
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ baseUrl, providers: [{ id: 'studio', access: { apiKey: key } }] })
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  const prepared = await ctx.llm.prepareCall({ provider: 'muse-cloud-studio', model: 'writer' })
  key = 'rotated-supplier-test-key'; await models.refresh()
  for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* Drain the frozen request. */ }
  const result = await assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer', messages: [] })
  expect(result.finish).toEqual({ kind: 'stop' })
  expect(calls).toEqual(['/api/desktop-models/providers', '/api/desktop-models/access', '/api/desktop-models/providers', '/api/desktop-models/access'])
  expect(server.paths).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
  expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer supplier-test-key', 'Bearer rotated-supplier-test-key'])
  expect(server.headers.every(headers => headers.cookie === undefined && headers.origin === undefined)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('supplier-test-key')
  const session = await readMuseSession(sessionFile(), baseUrl)
  if (!session) throw new Error('Missing account')
  await clearMuseSessionIfUnchanged(sessionFile(), session); await models.refresh()
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancels a direct stream when its account logs out', async () => {
  const server = await mockServer([{ events: textEvents.slice(0, 2), holdOpen: true }])
  await login()
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers') ? { ...catalog, transport: 'direct' }
      : { transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider, access: { baseURL: server.url, apiKey: 'direct-test-key' } })) }) })
  await models.refresh()
  const result = assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer', messages: [] })
  await server.requestReceived
  const session = await readMuseSession(sessionFile(), baseUrl)
  if (!session) throw new Error('Missing account')
  await clearMuseSessionIfUnchanged(sessionFile(), session); await models.refresh()
  expect((await result).finish).toMatchObject({ kind: 'aborted' })
  await server.responseClosed
})

it('rejects missing or unsafe direct access without falling back to relay', async () => {
  await login()
  let access: unknown = { ...catalog, transport: 'direct' }
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers') ? { ...catalog, transport: 'direct' } : access) })
  await expect(models.refresh()).rejects.toThrow('gateway-rejected')
  access = { ...catalog, transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider,
    access: { baseURL: 'http://public-provider.test/v1', apiKey: 'test-key' } })) }
  await expect(models.refresh()).rejects.toThrow('gateway-rejected')
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
  await expect(readFile(join(root, 'model-access.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['network', 'unauthorized', 'unavailable', 'malformed', 'oversized', 'downgrade', 'invalid-url'])(
  'refuses %s supplier access and never publishes its credentials', async (failure) => {
    await login()
    vi.stubGlobal('fetch', async (url: URL) => {
      if (new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers')) return Response.json({ ...catalog, transport: 'direct' })
      if (failure === 'network') throw new Error('secret-upstream-diagnostic')
      if (failure === 'unauthorized') return new Response('', { status: 401 })
      if (failure === 'unavailable') return new Response('', { status: 503 })
      if (failure === 'malformed') return new Response('{')
      if (failure === 'oversized') return new Response(' '.repeat(2 * 1024 * 1024 + 1))
      if (failure === 'downgrade') return Response.json(catalog)
      return Response.json({ transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider,
        access: { baseURL: 'not-a-url', apiKey: 'test-key' } })) })
    })
    models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000 })
    if (failure === 'unauthorized') {
      await models.refresh(); expect(await readMuseSession(sessionFile(), baseUrl)).toBeNull()
    } else await expect(models.refresh()).rejects.toThrow(/^MUSE account gateway: gateway-(?:unavailable|rejected)$/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
    await expect(readFile(join(root, 'model-access.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('does not distribute excluded supplier credentials and rejects issuance raced by a new login', async () => {
  await login()
  const access = { transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider,
    access: { baseURL: 'https://provider.test/v1', apiKey: 'test-key' } })) }
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedModelPrefixes: ['writer'],
    fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers') ? { ...catalog, transport: 'direct' } : access) })
  await models.refresh()
  const stored: unknown = JSON.parse(await readFile(join(root, 'model-access.json'), 'utf8'))
  expect(stored).toMatchObject({ providers: [] })
  await models.dispose()
  const save = modelAccess.saveModelAccess
  vi.spyOn(modelAccess, 'saveModelAccess').mockImplementation(async (...args) => {
    await login('bob')
    return await save(...args)
  })
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers') ? { ...catalog, transport: 'direct' } : access) })
  await models.refresh()
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
})

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
  await models.dispose()
})

it('completes catalog refresh while preserving a newer model selection committed during initial-default repair', async () => {
  const fixture = await directProviderFixture(false)
  await login()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const replace = fixture.ctx.settings.replace.bind(fixture.ctx.settings)
  vi.spyOn(fixture.ctx.settings, 'replace').mockImplementation(async (...args) => {
    entered(); await gate; await replace(...args)
  })
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedProviderIds: ['aa'], fetcher: async () => Response.json(suppliedCatalog) })
  const refreshing = models.refresh()
  try {
    await started
    const newer = { provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('high') }
    await fixture.ctx.agentDefaultModel.saveSelection(newer)
    expect(fixture.ctx.settings.describe().find(row => row.ns === 'agent-default-model')?.revision).toBe(1)
    release()
    await expect(refreshing).resolves.toBeUndefined()
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual(newer)
    expect((await fixture.ctx.llm.listModels('muse-cloud-deepseek-official')).map(model => model.id)).toEqual(['deepseek-flash'])
    await models.refresh()
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual(newer)
  } finally {
    release()
    await Promise.allSettled([refreshing])
  }
})

it('rejects an unexpected initial-default write failure and allows a later explicit refresh', async () => {
  const fixture = await directProviderFixture(false)
  await login()
  const failure = new Error('Initial model settings write failed')
  vi.spyOn(fixture.ctx.settings, 'replace').mockRejectedValueOnce(failure)
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedProviderIds: ['aa'], fetcher: async () => Response.json(suppliedCatalog) })
  await expect(models.refresh()).rejects.toBe(failure)
  await models.refresh()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
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

it('excludes only the specified account provider and retains Yunying Gemini and personal adapters', async () => {
  await login()
  const entry = suppliedCatalog.providers[0]!.models[0]!
  const personal = ctx.llm.registerAdapter(['aa'], new PersonalAdapter())
  try {
    models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
      excludedProviderIds: ['aa'], fetcher: async () => Response.json({ providers: [
        suppliedCatalog.providers[0],
        { id: 'yunying', name: '云映', models: [
          { ...entry, id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
          { ...entry, id: 'gpt-5', name: 'GPT 5' },
          { ...entry, id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
        ] },
        suppliedCatalog.providers[1],
      ] }) })
    await models.refresh()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual([
      'personal', 'aa', 'muse-cloud-yunying', 'muse-cloud-deepseek-official',
    ])
    const browser = await buildModelCatalog(ctx, { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro' })
    expect(browser.groups.filter(group => group.id.startsWith('muse-cloud-')).map(group => ({
      id: group.id, models: group.models.map(model => model.id),
    }))).toEqual([
      { id: 'muse-cloud-yunying', models: ['gemini-3.1-pro', 'gpt-5', 'claude-opus-4-6'] },
      { id: 'muse-cloud-deepseek-official', models: ['deepseek-flash'] },
    ])
    expect((await assemble(ctx, { provider: 'aa', model: 'gemini-3.8-flash', messages: [] })).finish)
      .toEqual({ kind: 'stop' })
    await models.dispose()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal', 'aa'])
  } finally { personal() }
})

it.each(['plugin', 'desktop'] as const)('routes an existing unconfigured direct session through the %s Muse scope and records the actual selection and request', async (composition) => {
  const fixture = await oldSessionFixture(false)
  const server = await mockServer([{ events: textEvents }, { events: textEvents }])
  await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
  const desktopRow = loadOverlayPatches('muse-models-test', fileURLToPath(new URL(
    '../../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'muse-account')
  if (!Array.isArray(desktopRow?.inject)) throw new Error('Muse Desktop model injections are not an array')
  const inject = composition === 'plugin' ? accountInject
    : desktopRow.inject.filter((key: unknown): key is string => typeof key === 'string'
      && ['tools', 'llm', 'sessionProjections', 'agentDefaultModel'].includes(key))
  const mounted = fixture.ctx.plugin({ inject, apply: (scope: Context) => {
    const owned = new MuseModels(scope, { baseUrl: server.url, sessionFile: sessionFile(), requestTimeoutMs: 1000,
      fetcher: async () => Response.json(suppliedCatalog) })
    models = owned
    scope.effect(() => () => owned.dispose())
  } })
  await mounted.await()
  await models.refresh()
  const idle = waitForIdle(fixture.ctx, fixture.agent)
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the script.' }], source: { kind: 'user' } }))
  await idle
  const end = fixture.agent.session.snapshotEvents().find(event => event.type === 'turn/end')
  expect(end?.type === 'turn/end' && end.data.reason.kind === 'error' ? end.data.reason.error : undefined).toBeUndefined()
  expect(server.paths).toEqual(['/api/desktop-models/deepseek-official/chat/completions'])
  expect(server.headers[0]?.authorization).toBe('Bearer alice-session')
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  expect(fixture.agent.session.requestHeader()?.config)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  expect(fixture.ctx.sessionProjections.snapshot(fixture.agent.session).values.modelSelection?.next)
    .toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  const secondIdle = waitForIdle(fixture.ctx, fixture.agent)
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the next scene.' }], source: { kind: 'user' } }))
  await secondIdle
  expect(server.paths).toEqual([
    '/api/desktop-models/deepseek-official/chat/completions',
    '/api/desktop-models/deepseek-official/chat/completions',
  ])
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(2)
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

it('loads Muse GLM models through Loader and retains reasoning on a tool continuation', async () => {
  const fixture = await oldSessionFixture(false)
  const events = [
    JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'saved GLM reasoning' }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'glm-call', type: 'function',
      function: { name: 'lookup', arguments: '{"query":"note"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]',
  ]
  const server = await mockServer([{ events }, { events: textEvents }, { events: textEvents }])
  await writeMuseSession(sessionFile(), { baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session' })
  fixture.ctx.loader.builtins['glm-models'] = {
    inject: accountInject,
    apply: async (scope: Context) => {
      const owned = new MuseModels(scope, { baseUrl: server.url, sessionFile: sessionFile(), requestTimeoutMs: 1000,
        fetcher: async () => Response.json({ providers: [{ id: 'yunying', name: 'Yunying', models: [{
          id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 200000, maxTokens: 32768,
          input: ['text'], reasoningEfforts: { low: 'low' }, defaultReasoningEffort: 'low',
        }] }] }) })
      models = owned
      scope.effect(() => () => owned.dispose())
      await owned.refresh()
    },
  }
  const id = await fixture.ctx.loader.create({ name: 'cordis:glm-models' })
  await fixture.ctx.loader.await()
  await fixture.ctx.loader.resolve(id).fiber?.await()
  const request = { provider: 'muse-cloud-yunying', model: 'glm-5.3-flash' }
  const first = await assemble(fixture.ctx, { ...request, messages: [] })
  expect(first.finish).toEqual({ kind: 'tool-calls' })
  const result = createToolResultMessage({ callId: ToolCallId('glm-call'), isError: false, content: [{ type: 'text', text: 'found' }] })
  expect((await assemble(fixture.ctx, { ...request, messages: [first.message, result] })).finish).toEqual({ kind: 'stop' })
  expect((await assemble(fixture.ctx, { ...request, reasoningEffort: ReasoningEffortId('low'), messages: [] })).finish).toEqual({ kind: 'stop' })
  const wire = server.requests as {
    max_tokens: number
    thinking?: object
    reasoning_effort?: string
    messages: { role: string; reasoning_content?: string }[]
  }[]
  expect(wire[0]?.max_tokens).toBe(32768)
  expect(wire[0]?.thinking).toEqual({ type: 'enabled' })
  expect(wire[0]?.reasoning_effort).toBe('low')
  expect(wire[1]?.messages.find(message => message.role === 'assistant')?.reasoning_content).toBe('saved GLM reasoning')
  expect(wire[2]?.thinking).toEqual({ type: 'enabled' })
  expect(wire[2]?.reasoning_effort).toBe('low')
  await fixture.ctx.loader.resolve(id).fiber?.dispose()
  expect(fixture.ctx.llm.listProviders().some(provider => provider.id === request.provider)).toBe(false)
})

it.each([
  { reasoningEfforts: false, defaultReasoningEffort: 'low' },
  { reasoningEfforts: { high: 'high' }, defaultReasoningEffort: 'low' },
  { reasoningEfforts: { low: null }, defaultReasoningEffort: 'low' },
  { reasoningEfforts: { low: '' }, defaultReasoningEffort: 'low' },
  { reasoningEfforts: { off: null, low: 'low' }, defaultReasoningEffort: 'off' },
])('rejects an account model default that is not an enabled offered effort (%j)', async (reasoning) => {
  await login()
  const entry = catalog.providers[0]?.models[0]
  if (!entry) throw new Error('Account model fixture has no model')
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json({ providers: [{ ...catalog.providers[0], models: [
      { ...entry, ...reasoning },
    ] }] }) })
  await expect(models.refresh()).rejects.toThrow()
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['personal'])
})

it.each(['network', 'http', 'oversized', 'json'] as const)(
  'rejects a failed model catalog safely and allows a later refresh (%s)', async (failure) => {
    await login()
    let failed = true
    models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
      fetcher: async () => {
        if (!failed) return Response.json(catalog)
        if (failure === 'network') throw new Error('PRIVATE_NETWORK_DETAIL')
        return failure === 'http' ? new Response('PRIVATE_HTTP_BODY', { status: 500 })
          : new Response(failure === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'PRIVATE_INVALID_JSON')
      } })
    await expect(models.refresh()).rejects.toMatchObject({ code: ['network', 'http'].includes(failure) ? 'gateway-unavailable' : 'gateway-rejected' })
    expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['personal'])
    failed = false
    await models.refresh()
    expect(ctx.llm.listProviders().map(row => row.id)).toContain('muse-cloud-studio')
  },
)

it('rejects duplicate provider metadata without replacing the registered model collection', async () => {
  await login()
  let duplicate = false
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(duplicate ? { providers: [...catalog.providers, ...catalog.providers] } : catalog) })
  await models.refresh()
  duplicate = true
  await expect(models.refresh()).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect((await ctx.llm.listModels('muse-cloud-studio')).map(row => row.id)).toEqual(['writer'])
})

it('keeps the previous collection when the LLM registry rejects a replacement', async () => {
  await login()
  let next = false
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(next ? suppliedCatalog : catalog) })
  await models.refresh()
  const adapter = ctx.llm.registerAdapter(['muse-cloud-aa'], new PersonalAdapter())
  try {
    next = true
    await expect(models.refresh()).rejects.toThrow()
    expect((await ctx.llm.listModels('muse-cloud-studio')).map(row => row.id)).toEqual(['writer'])
  } finally { adapter() }
})

it('does not register a provider when all supplied models are excluded', async () => {
  await login()
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    excludedModelPrefixes: ['writer'], fetcher: async () => Response.json(catalog) })
  await models.refresh()
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['personal'])
})

it('does not fetch after disposal and cancels a catalog whose response arrives after disposal', async () => {
  await login()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetcher = vi.fn<typeof fetch>(async () => { entered(); await gate; return Response.json(catalog) })
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000, fetcher })
  const refreshing = models.refresh(); await started
  const disposal = models.dispose(); release()
  await expect(refreshing).rejects.toThrow()
  await disposal
  await models.refresh()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['personal'])
})

it('uses the default transport with account cookies and refuses a malformed bearer before streaming', async () => {
  await writeMuseSession(sessionFile(), { baseUrl, username: 'alice', cookie: '__Host-muse=invalid!token' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog))
  vi.stubGlobal('fetch', fetcher)
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000 })
  await models.refresh()
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { cookie: '__Host-muse=invalid!token' }, redirect: 'error' })
  expect((await assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer', messages: [] })).finish)
    .toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('retains unchanged registrations across catalog polling', async () => {
  await login()
  const register = vi.spyOn(ctx.llm, 'registerAdapter'), fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog))
  models = new MuseModels(ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000, fetcher })
  await models.refresh(); await models.refresh()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(register).toHaveBeenCalledTimes(1)
  expect((await ctx.llm.listModels('muse-cloud-studio')).map(row => row.id)).toEqual(['writer'])
})

it('preserves a configured Muse default that is still advertised', async () => {
  const fixture = await directProviderFixture(false)
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'muse-cloud-studio', model: 'writer' })
  await login()
  const replace = vi.spyOn(fixture.ctx.settings, 'replace')
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  await models.refresh()
  expect(replace).not.toHaveBeenCalled()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'muse-cloud-studio', model: 'writer' })
})

it('keeps a saved default when the supplied catalog contains no available model', async () => {
  const fixture = await directProviderFixture(false)
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'muse-cloud-studio', model: 'previous' })
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json({ providers: [] }) })
  await models.refresh()
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'muse-cloud-studio', model: 'previous' })
})

it.each(['account-change', 'dispose'] as const)('does not save an initial default when credential lookup resumes after %s', async (change) => {
  const fixture = await directProviderFixture(false)
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'deepseek-official', model: 'deepseek-flash' })
  await login()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const describe = fixture.ctx.credentials.describe.bind(fixture.ctx.credentials)
  vi.spyOn(fixture.ctx.credentials, 'describe').mockImplementation(async (ref) => { entered(); await gate; return await describe(ref) })
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  const refreshing = models.refresh()
  await started
  const disposal = change === 'dispose' ? models.dispose() : login('bob')
  if (change === 'account-change') await disposal
  release(); await Promise.all([refreshing, disposal])
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
})

it.each(['matching', 'primitive', 'missing', 'empty-ref', 'absent-route'] as const)(
  'resolves a provider-owned nested credential setting conservatively (%s)', async (value) => {
    const fixture = await directProviderFixture(false)
    await fixture.ctx.settings.replace('agent-default-model', { provider: 'deepseek-official', model: 'deepseek-flash' })
    const routes = fixture.ctx.llm.listConfigurableProviders()
    vi.spyOn(fixture.ctx.llm, 'listConfigurableProviders').mockReturnValue(value === 'absent-route' ? []
      : routes.map(row => ({ ...row, settingsPath: ['nested', 'profile'] })))
    const describe = fixture.ctx.settings.describe.bind(fixture.ctx.settings)
    vi.spyOn(fixture.ctx.settings, 'describe').mockImplementation(options => describe(options).map(row => String(row.ns) === 'direct-deepseek'
      ? { ...row, value: value === 'matching' ? { nested: { profile: { apiKeyEnv: 'OWN_DEEPSEEK_KEY' } } }
        : value === 'empty-ref' ? { nested: { profile: { apiKeyEnv: '' } } }
          : value === 'primitive' ? { nested: 7 } : undefined } : row))
    await login()
    models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
      fetcher: async () => Response.json(suppliedCatalog) })
    await models.refresh()
    expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({
      provider: value === 'matching' ? 'muse-cloud-deepseek-official' : 'deepseek-official', model: 'deepseek-flash',
    })
  },
)

it('retains an assembled direct request whose own credential is configured', async () => {
  const fixture = await oldSessionFixture(true)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  const config = { provider: fixture.initialSelection.provider, model: fixture.initialSelection.model,
    ...(fixture.initialSelection.reasoningEffort === undefined ? {}
      : { reasoningEffort: ReasoningEffortId(fixture.initialSelection.reasoningEffort) }) }
  expect(await agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => config)).toEqual(config)
})

it.each(['credential', 'catalog', 'session'] as const)('retains an assembled route when %s changes during repair', async (boundary) => {
  const fixture = await oldSessionFixture(false)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  if (boundary === 'credential') {
    const original = fixture.ctx.credentials.describe.bind(fixture.ctx.credentials)
    vi.spyOn(fixture.ctx.credentials, 'describe').mockImplementation(async (ref) => { entered(); await gate; return await original(ref) })
  } else {
    const original = fixture.ctx.llm.listModels.bind(fixture.ctx.llm)
    vi.spyOn(fixture.ctx.llm, 'listModels').mockImplementation(async (provider) => { entered(); await gate; return await original(provider) })
  }
  const config = { provider: fixture.initialSelection.provider, model: fixture.initialSelection.model,
    ...(fixture.initialSelection.reasoningEffort === undefined ? {}
      : { reasoningEffort: ReasoningEffortId(fixture.initialSelection.reasoningEffort) }) }
  const routed = agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => config)
  await started
  await login('bob')
  if (boundary !== 'session') await models.refresh()
  release()
  expect(await routed).toEqual(config)
})

it.each(['default', 'header', 'adapter-default', 'header-effort'] as const)('repairs a session without a pending model selection from its %s', async (baseline) => {
  const fixture = await oldSessionFixture(false)
  const agent = await fixture.driver.create(SessionId(`unselected-${baseline}`), {
    provider: 'deepseek-official', model: 'deepseek-flash',
  }, { cwd: root })
  await login()
  const noReasoning = { providers: [{ ...suppliedCatalog.providers[1], models: [{
    ...suppliedCatalog.providers[1]!.models[0], reasoningEfforts: false,
  }] }] }
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(baseline === 'header-effort' ? suppliedCatalog : noReasoning) })
  await models.refresh()
  await fixture.ctx.settings.replace('agent-default-model', { provider: 'deepseek-official', model: 'deepseek-flash' })
  if (baseline !== 'default') agent.session.append('request/header', { reason: 'initial', header: {
    config: { provider: 'deepseek-official', model: 'deepseek-flash',
      ...(['adapter-default', 'header-effort'].includes(baseline) ? { reasoningEffort: ReasoningEffortId('low') } : {}) },
    ...(baseline === 'adapter-default' ? { adapterDefaults: { reasoningEffort: true } } : {}),
  } })
  const routed = await agentEvents(fixture.ctx, agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ provider: 'deepseek-official', model: 'deepseek-flash',
    ...(baseline === 'header-effort' ? { reasoningEffort: ReasoningEffortId('low') } : {}) }))
  expect(routed).toEqual({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash',
    ...(baseline === 'header-effort' ? { reasoningEffort: ReasoningEffortId('low') } : {}) })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data)
    .toEqual({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash',
      ...(baseline === 'header-effort' ? { reasoningEffort: 'low' } : {}) })
})

it('resolves the older request without replacing a newer choice committed before its queued route repair', async () => {
  const fixture = await oldSessionFixture(false)
  await login()
  models = new MuseModels(fixture.ctx, { baseUrl, sessionFile: sessionFile(), requestTimeoutMs: 1000,
    fetcher: async () => Response.json(suppliedCatalog) })
  await models.refresh()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const select = fixture.controller.selectModelIfCurrent.bind(fixture.controller)
  vi.spyOn(fixture.controller, 'selectModelIfCurrent').mockImplementation(async (wanted, expected) => {
    entered(); await gate; return await select(wanted, expected)
  })
  const routed = agentEvents(fixture.ctx, fixture.agent).waterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ provider: fixture.initialSelection.provider, model: fixture.initialSelection.model,
    ...(fixture.initialSelection.reasoningEffort === undefined ? {}
      : { reasoningEffort: ReasoningEffortId(fixture.initialSelection.reasoningEffort) }) }))
  await started
  await fixture.controller.selectModel({ sessionId: fixture.agent.id, provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' })
  release()
  expect(await routed).toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  expect(fixture.ctx.sessionProjections.snapshot(fixture.agent.session).values.modelSelection?.next)
    .toEqual({ provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' })
})
