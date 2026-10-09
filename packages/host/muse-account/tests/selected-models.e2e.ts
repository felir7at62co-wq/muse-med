/** Keyless acceptance of the built account plugin and selected shared model catalog. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'

interface CatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  reasoningEfforts: false | Record<string, string | null>
  defaultReasoningEffort?: string
}
interface Catalog { providers: { id: string; name: string; models: CatalogModel[] }[] }
interface WireRequest {
  model: string
  max_tokens: number
  reasoning_effort?: string
  thinking?: { type: string }
  messages: { role: string; content?: string; reasoning_content?: string }[]
}

const selected = await import(new URL('../../../../services/muse-accounts/selected-models.mjs', import.meta.url).href) as {
  selectedModelProviders: (baseUrl: string) => Record<string, object>
}
const projection = await import(new URL('../../../../services/muse-accounts/desktop-models.mjs', import.meta.url).href) as {
  desktopModelCatalog: (models: { metadata(): { providers: Record<string, object> } }) => Catalog
}
const catalog = projection.desktopModelCatalog({ metadata: () => ({ providers: selected.selectedModelProviders('https://wy6688.token6688.com/v1') }) })
const expectedIds = ['deepseek-flash', 'deepseek-v4-pro', 'gpt-6-sol', 'gpt-6-astra',
  'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'gemini-3.1-pro', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flash']

class PersonalAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

function events(model: string, continued: boolean, effort: string | undefined): string[] {
  return [
    ...!continued && effort !== undefined
      ? [JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: `Reasoning for ${model}` }, finish_reason: null }] })] : [],
    JSON.stringify({ choices: [{ index: 0, delta: continued ? { content: `READY ${model}` }
      : { tool_calls: [{ index: 0, id: `call-${model}`, type: 'function', function: { name: 'catalog_probe', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: continued ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 30, completion_tokens: 4 } }), '[DONE]',
  ]
}

it('offers eleven account models after login, streams each through a tool continuation, and preserves personal credentials on logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-selected-models-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const requests: { route: string; authorization: string | undefined; body: WireRequest }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.once('end', () => {
      if (request.url === '/login') {
        response.writeHead(303, { 'set-cookie': '__Host-muse=alice-session; Path=/; HttpOnly', location: '/' }); response.end(); return
      }
      if (request.url === '/logout') { response.writeHead(303, { location: '/login' }); response.end(); return }
      if (request.url === '/api/muse.account') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ username: 'alice' })); return
      }
      if (request.url === '/api/desktop-models/providers') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog)); return
      }
      if (request.url?.endsWith('/chat/completions')) {
        const payload = JSON.parse(body) as WireRequest
        requests.push({ route: request.url, authorization: request.headers.authorization, body: payload })
        const continued = payload.messages.some(message => message.role === 'tool')
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events(payload.model, continued, payload.reasoning_effort).map(event => `data: ${event}\n\n`).join('')); return
      }
      response.writeHead(404); response.end()
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Account fixture has no allocated port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const fixture = await oldSessionFixture(false, home)
  fixture.ctx.effect(() => fixture.ctx.llm.registerAdapter(['personal'], new PersonalAdapter()))
  fixture.ctx.effect(() => fixture.ctx.tools.register(defineContentToolFixture({ name: 'catalog_probe',
    description: 'Read a deterministic acceptance result.', parameters: {},
    execute: async () => [{ type: 'text', text: 'PROBE_OK' }],
  })))
  const account = createRequire(import.meta.url)(fileURLToPath(new URL('../lib/index.js', import.meta.url))) as typeof import('../src/index.ts')
  fixture.ctx.loader.builtins['selected-account-built'] = account
  const id = await fixture.ctx.loader.create({ name: 'cordis:selected-account-built', config: { baseUrl, accountHome: home, remoteAccess: false } })
  await fixture.ctx.loader.await(); await fixture.ctx.loader.resolve(id).fiber?.await()
  const service: unknown = fixture.ctx.get('museAccount')
  if (!(service instanceof account.MuseAccountService)) throw new Error('Built account service did not activate')
  expect(await service.status({ verify: false })).toEqual({ state: 'signed-out' })
  expect(fixture.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('muse-cloud-deepseek-official')
  expect(await fixture.ctx.credentials.describe(credentialRef('OWN_DEEPSEEK_KEY'))).toMatchObject({ configured: false })
  expect(await service.login({ username: 'alice', password: 'local-test-password', registerIfMissing: false }))
    .toMatchObject({ outcome: 'signed-in', status: { state: 'signed-in', username: 'alice' } })
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  const available = await Promise.all(catalog.providers.map(async provider =>
    await fixture.ctx.llm.listModels(`muse-cloud-${provider.id}`)))
  expect(available.flat().map(model => model.id)).toEqual(expectedIds)
  for (const ref of ['OWN_DEEPSEEK_KEY', 'MUSE_DEEPSEEK_API_KEY', 'MUSE_YUNYING_API_KEY', 'MUSE_ZHIPU_API_KEY']) {
    expect(await fixture.ctx.credentials.describe(credentialRef(ref))).toMatchObject({ configured: false })
  }
  for (const provider of catalog.providers) for (const model of provider.models) {
    const route = `muse-cloud-${provider.id}`
    const agent = await fixture.driver.create(SessionId(`selected-${provider.id}-${model.id}`), fixture.ctx.agentDefaultModel.currentSelection(), { cwd: home })
    if (model.id !== 'deepseek-flash') await fixture.controller.selectModel({ sessionId: agent.id, provider: route, model: model.id })
    const idle = waitForIdle(fixture.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the probe, then report its result.' }], source: { kind: 'user' } }))
    await idle
    const config = agent.session.requestHeader()?.config
    expect(config).toMatchObject({ provider: route, model: model.id, maxTokens: model.maxTokens })
    expect(config?.reasoningEffort).toBe(model.defaultReasoningEffort)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toMatchObject([{ data: { reason: { kind: 'completed' } } }])
    expect(agent.session.deriveMessages().filter(message => message.role === 'assistant').at(-1)?.content)
      .toEqual([{ type: 'text', text: `READY ${model.id}` }])
    const pair = requests.filter(request => request.body.model === model.id && request.route === `/api/desktop-models/${provider.id}/chat/completions`)
    expect(pair).toHaveLength(2)
    expect(pair.map(request => request.route)).toEqual(Array.from({ length: 2 }, () => `/api/desktop-models/${provider.id}/chat/completions`))
    for (const request of pair) {
      expect(request.authorization).toBe('Bearer alice-session')
      expect(request.body.max_tokens).toBe(model.maxTokens)
      expect(request.body.reasoning_effort).toBe(model.defaultReasoningEffort)
      expect(request.body.thinking).toEqual(provider.id === 'deepseek-official' || provider.id === 'zhipu-official' ? { type: 'enabled' } : undefined)
    }
    expect(pair[1]?.body.messages.find(message => message.role === 'tool')?.content).toBe('PROBE_OK')
    expect(pair[1]?.body.messages.find(message => message.role === 'assistant')?.reasoning_content)
      .toBe(model.defaultReasoningEffort === undefined ? undefined : `Reasoning for ${model.id}`)
  }
  for (const effort of ['high', 'off']) {
    const explicit = await fixture.driver.create(SessionId(`explicit-${effort}`), {}, { cwd: home })
    await fixture.controller.selectModel({ sessionId: explicit.id, provider: 'muse-cloud-deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: effort })
    const idle = waitForIdle(fixture.ctx, explicit)
    explicit.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the explicit reasoning choice.' }], source: { kind: 'user' } }))
    await idle
    expect(requests.slice(-2).map(request => request.body.reasoning_effort)).toEqual(Array.from({ length: 2 }, () => effort === 'off' ? undefined : effort))
    expect(requests.slice(-2).map(request => request.body.thinking)).toEqual(Array.from({ length: 2 }, () => ({ type: effort === 'off' ? 'disabled' : 'enabled' })))
    expect(explicit.session.requestHeader()?.config.reasoningEffort).toBe(effort)
  }
  const repaired = waitForIdle(fixture.ctx, fixture.agent)
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the saved conversation after account login.' }], source: { kind: 'user' } }))
  await repaired
  expect(fixture.agent.session.requestHeader()?.config).toMatchObject({
    provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash', reasoningEffort: fixture.initialSelection.reasoningEffort, maxTokens: 393216,
  })
  expect(requests.slice(-2).map(request => request.body.model)).toEqual(['deepseek-flash', 'deepseek-flash'])
  expect(requests.slice(-2).map(request => request.body.reasoning_effort))
    .toEqual(Array.from({ length: 2 }, () => fixture.initialSelection.reasoningEffort))
  expect(requests).toHaveLength(28)
  for (const [provider, model] of [
    ['muse-cloud-yunying', 'gpt-6-sol'],
    ['muse-cloud-yunying', 'glm-5.3-flash'],
    ['muse-cloud-zhipu-official', 'glm-5.3-flashx'],
    ['muse-cloud-zhipu-official', 'glm-5.3-flash'],
    ['muse-cloud-yunying', 'claude-sonnet-5-5'],
    ['muse-cloud-deepseek-official', 'deepseek-flash'],
  ] as const) {
    await fixture.controller.selectModel({ sessionId: fixture.agent.id, provider, model })
    const before = requests.length
    const idle = waitForIdle(fixture.ctx, fixture.agent)
    fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Confirm the selected route.' }], source: { kind: 'user' } }))
    await idle
    expect(requests.length).toBeGreaterThan(before)
    expect(requests.at(-1)).toMatchObject({ route: `/api/desktop-models/${provider.slice('muse-cloud-'.length)}/chat/completions`, body: { model } })
    expect(fixture.agent.session.requestHeader()?.config).toMatchObject({ provider, model })
  }
  expect(await service.logout()).toEqual({ state: 'signed-out' })
  expect(fixture.ctx.llm.listProviders().map(provider => provider.id)).toContain('personal')
  expect(fixture.ctx.llm.listProviders().filter(provider => provider.id.startsWith('muse-cloud-'))).toEqual([])
  expect(await fixture.ctx.credentials.resolve(credentialRef('OTHER_PROVIDER_KEY'))).toEqual({ value: 'other-provider-test-value', source: 'memory' })
  const stored = await readFile(fixture.profile.patchPath, 'utf8')
  expect(stored).not.toContain('alice-session')
  expect(stored).not.toContain('local-test-password')
})
