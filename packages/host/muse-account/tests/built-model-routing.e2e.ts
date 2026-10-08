/** Built Muse plugin activation and local HTTP streaming through the real Loader and AgentLoop. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

const artifact = fileURLToPath(new URL('../lib/index.js', import.meta.url))

it.each(['package', 'desktop'] as const)('loads the built %s Muse composition, repairs an old direct conversation, streams subsequent messages and withdraws models on logout', async (composition) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-built-routing-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const streams: (string | undefined)[] = []
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      switch (request.url) {
        case '/login':
          response.writeHead(303, { 'set-cookie': '__Host-muse=alice-session; Path=/; HttpOnly', location: '/' })
          response.end()
          return
        case '/logout':
          response.writeHead(303, { location: '/login' })
          response.end()
          return
        case '/api/muse.account':
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ username: 'alice' }))
          return
        case '/api/desktop-models/providers':
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ providers: [
            { id: 'aa', name: 'Gemini', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash',
              contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] },
            { id: 'yunying', name: '云映', models: [{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro',
              contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] },
            { id: 'deepseek-official', name: 'DeepSeek', models: [{
              id: 'deepseek-flash', name: 'DeepSeek-Flash', contextWindow: 1000000, maxTokens: 256000,
              input: ['text'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
            }] }] }))
          return
        case '/api/desktop-models/deepseek-official/chat/completions':
          streams.push(request.headers.authorization)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(textEvents.map(event => `data: ${event}\n\n`).join(''))
          return
        default:
          response.writeHead(404)
          response.end()
      }
    })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Muse gateway fixture has no assigned port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const fixture = await oldSessionFixture(false, home)
  const account = createRequire(import.meta.url)(artifact) as typeof import('../src/index.ts')
  const row = loadOverlayPatches('muse-built-routing', fileURLToPath(new URL(
    '../../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'muse-account')
  if (!Array.isArray(row?.inject)) throw new Error('Muse Desktop model injections are not an array')
  const productConfig: unknown = row.config
  if (typeof productConfig !== 'object' || productConfig === null || Array.isArray(productConfig)) {
    throw new Error('Muse Desktop account configuration is not an object')
  }
  fixture.ctx.loader.builtins['muse-account-built'] = account
  const id = await fixture.ctx.loader.create({
    name: 'cordis:muse-account-built',
    ...(composition === 'desktop' ? {
      inject: row.inject.filter((key: unknown): key is string => typeof key === 'string'
        && ['tools', 'llm', 'sessionProjections', 'agentDefaultModel'].includes(key)),
    } : {}),
    config: { ...(composition === 'desktop' ? productConfig : {}), baseUrl, accountHome: home, remoteAccess: false },
  })
  await fixture.ctx.loader.await()
  await fixture.ctx.loader.resolve(id).fiber?.await()
  const service: unknown = fixture.ctx.get('museAccount')
  if (!(service instanceof account.MuseAccountService)) throw new Error('Built Muse account service did not activate')
  expect(await service.status({ verify: false })).toEqual({ state: 'signed-out' })
  expect(fixture.ctx.tools.schemas().some(tool => tool.name === 'mcp__muse-account__muse_account_status')).toBe(true)
  expect(await service.login({ username: 'alice', password: 'local-test-password', registerIfMissing: false }))
    .toMatchObject({ outcome: 'signed-in', status: { state: 'signed-in', username: 'alice' } })
  expect(fixture.ctx.llm.listProviders().some(provider => provider.id === 'muse-cloud-aa')).toBe(composition === 'package')
  expect((await fixture.ctx.llm.listModels('muse-cloud-yunying')).map(model => model.id)).toEqual(['gemini-3.1-pro'])
  expect(fixture.ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  for (const text of ['Continue the script.', 'Continue the next scene.']) {
    const idle = waitForIdle(fixture.ctx, fixture.agent)
    fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await idle
  }
  const fresh = await fixture.driver.create(SessionId('fresh-account-conversation'), fixture.ctx.agentDefaultModel.currentSelection(), { cwd: home })
  const idle = waitForIdle(fixture.ctx, fresh)
  fresh.followup(createUserMessage({ content: [{ type: 'text', text: 'Start a new script.' }], source: { kind: 'user' } }))
  await idle
  expect(streams).toEqual(Array.from({ length: 3 }, () => 'Bearer alice-session'))
  for (const agent of [fixture.agent, fresh]) {
    expect(agent.session.requestHeader()?.config).toMatchObject({ provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toEqual([])
  }
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(2)
  expect(fresh.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  expect(fixture.agent.session.deriveMessages().filter(message => message.role === 'assistant').map(message => message.content))
    .toEqual(Array.from({ length: 2 }, () => [{ type: 'text', text: 'hello' }]))
  expect(fresh.session.deriveMessages().filter(message => message.role === 'assistant').map(message => message.content))
    .toEqual([[{ type: 'text', text: 'hello' }]])
  expect(await service.logout()).toEqual({ state: 'signed-out' })
  expect(fixture.ctx.llm.listProviders().map(provider => provider.id)).not.toContain('muse-cloud-deepseek-official')
})
