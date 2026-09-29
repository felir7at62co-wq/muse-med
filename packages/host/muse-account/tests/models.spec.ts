import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MuseModels } from '../src/models.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { mockServer, closeMockServers, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { writeMuseSession, readMuseSession, clearMuseSessionIfUnchanged } from '../src/session.ts'

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
