/** Opt-in supplier calls through the built Muse account plugin and real account gateway. */
import { createRequire } from 'node:module'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'

const liveConfig = process.env.MUSE_DIRECT_E2E_CONFIG_PATH
const modules = new URL('../../../../services/muse-accounts/', import.meta.url)
const { openStore } = await import(new URL('store.mjs', modules).href) as {
  openStore: (file: string) => Promise<{ create(username: string, password: string): Promise<unknown> }>
}
interface LiveModel { id: string; reasoningEfforts?: false | Record<string, string | null> }
interface LiveDirectory {
  metadata(): { providers: Record<string, { models: LiveModel[] }> }
  resolve(provider: string, model: string): { apiKey: string }
}
const { openGlobalModels } = await import(new URL('global-models.mjs', modules).href) as {
  openGlobalModels: (file: string) => Promise<LiveDirectory>
}
const { createAccountServer } = await import(new URL('gateway.mjs', modules).href) as {
  createAccountServer: (options: Record<string, unknown>) => Server
}

it.skipIf(!liveConfig).each(['deepseek-official', 'yunying', 'zhipu-official'])(
  'streams a real %s supplier tool continuation directly through the built Muse plugin', async (provider) => {
    if (!liveConfig) throw new Error('Private live model configuration is required')
    const home = await mkdtemp(join(tmpdir(), 'muse-direct-live-'))
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    const globalModels = await openGlobalModels(liveConfig)
    const model = globalModels.metadata().providers[provider]?.models[0]
    if (!model) throw new Error(`Live configuration is missing ${provider}`)
    const store = await openStore(join(home, 'accounts.json'))
    await store.create('live-tester', 'synthetic-live-test-password')
    let relayCalls = 0
    const server = createAccountServer({ store, globalModels, desktopModelTransport: 'direct',
      publicOrigin: 'https://muse.test', modelForward: () => { relayCalls++; throw new Error('Direct calls must bypass the model relay') } })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Gateway has no assigned port')
    const localUrl = `http://127.0.0.1:${address.port}`
    const baseUrl = 'https://muse.test'
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const response = await realFetch(url.origin === baseUrl ? `${localUrl}${url.pathname}${url.search}` : input, init)
      if (url.origin !== baseUrl) console.info(JSON.stringify({ provider, requestPath: url.pathname, status: response.status }))
      return response
    })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const fixture = await oldSessionFixture(false, home)
    fixture.ctx.effect(() => fixture.ctx.tools.register(defineContentToolFixture({
      name: 'direct_probe', description: 'Return the direct transport test marker.', parameters: {},
      execute: async () => [{ type: 'text', text: 'DIRECT_OK' }],
    })))
    const account = createRequire(import.meta.url)(fileURLToPath(new URL('../lib/index.js', import.meta.url))) as typeof import('../src/index.ts')
    fixture.ctx.loader.builtins['live-direct-account'] = account
    const id = await fixture.ctx.loader.create({ name: 'cordis:live-direct-account',
      config: { baseUrl, accountHome: home, remoteAccess: false } })
    await fixture.ctx.loader.await(); await fixture.ctx.loader.resolve(id).fiber?.await()
    const service: unknown = fixture.ctx.get('museAccount')
    if (!(service instanceof account.MuseAccountService)) throw new Error('Built Muse plugin did not activate')
    await service.login({ username: 'live-tester', password: 'synthetic-live-test-password', registerIfMissing: false })
    const agent = await fixture.driver.create(SessionId(`direct-live-${provider}`), {}, { cwd: home })
    await fixture.controller.selectModel({ sessionId: agent.id, provider: `muse-cloud-${provider}`, model: model.id,
      ...(model.reasoningEfforts && Object.hasOwn(model.reasoningEfforts, 'off') ? { reasoningEffort: 'off' }
        : model.reasoningEfforts && Object.hasOwn(model.reasoningEfforts, 'low') ? { reasoningEffort: 'low' } : {}) })
    const started = performance.now()
    const idle = waitForIdle(fixture.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text',
      text: 'Call direct_probe exactly once. After the tool returns, reply with only DIRECT_OK. Do nothing else.' }], source: { kind: 'user' } }))
    await idle
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/end')).toMatchObject([{ data: { reason: { kind: 'completed' } } }])
    const messages = agent.session.deriveMessages()
    expect(messages.some(message => message.role === 'tool')).toBe(true)
    expect(messages.filter(message => message.role === 'assistant').at(-1)?.content)
      .toEqual([{ type: 'text', text: 'DIRECT_OK' }])
    expect(relayCalls).toBe(0)
    expect(await readFile(join(home, 'model-access.json'), 'utf8')).toContain(globalModels.resolve(provider, model.id).apiKey)
    expect(JSON.stringify(events)).not.toContain(globalModels.resolve(provider, model.id).apiKey)
    console.info(JSON.stringify({ provider, model: model.id, elapsedMs: Math.round(performance.now() - started), relayCalls }))
    await service.logout()
    await expect(readFile(join(home, 'model-access.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)
