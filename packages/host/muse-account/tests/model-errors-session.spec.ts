/** Supplier refusals exercise the account adapter through real AgentLoop settlement. */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { mockServer, closeMockServers } from '../../../llm/llm-pi-ai/tests/mock-server.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
  await closeMockServers()
})

it.each([{ status: 401, code: 'AUTH' }, { status: 400, code: 'INVALID_REQUEST' }])(
  'keeps supplier credentials out of durable failure events for HTTP $status', async ({ status, code }) => {
    const root = await mkdtemp(join(tmpdir(), 'muse-model-errors-session-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const owned = await oldSessionFixture(false, root)
    cleanup.push(() => owned.ctx.fiber.dispose())
    const key = 'synthetic-supplier-refusal-credential'
    const server = await mockServer([{ status, body: JSON.stringify({ error: { message: `Request credential ${key}` } }) }])
    const baseUrl = 'https://muse.test'
    const sessionFile = join(root, 'session.json')
    await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
    const catalog = { providers: [{ id: 'studio', name: 'Studio', models: [{ id: 'writer', name: 'Writer',
      contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
    const models = new MuseModels(owned.ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
      fetcher: async url => Response.json(new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers')
        ? { ...catalog, transport: 'direct' } : { transport: 'direct', providers: catalog.providers.map(provider => ({
          ...provider, access: { baseURL: server.url, apiKey: key },
        })) }) })
    cleanup.push(() => models.dispose())
    await models.refresh()
    await owned.controller.selectModel({ sessionId: owned.agent.id, provider: 'muse-cloud-studio', model: 'writer' })
    const idle = waitForIdle(owned.ctx, owned.agent)
    owned.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply OK.' }], source: { kind: 'user' } }))
    await idle
    const events = owned.agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'assistant/attempt')).toBe(true)
    const ending = events.find(event => event.type === 'turn/end')
    expect(ending?.data.reason).toMatchObject({ kind: 'error', error: { code } })
    expect(JSON.stringify(events)).not.toContain(key)
    expect(JSON.stringify(events)).not.toContain('Request credential')
  })
