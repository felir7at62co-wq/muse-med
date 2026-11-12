/** Muse account model failover through the real AgentLoop and a local supplier. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'
import { oldSessionFixture, waitForIdle } from './model-routing-fixture.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import * as retry from '../../../llm/llm-retry/src/index.ts'

const providerIds = ['alpha', 'beta', 'gamma'] as const
interface CatalogProvider {
  id: string
  name: string
  models: {
    id: string
    name: string
    contextWindow: number
    maxTokens: number
    input: ('text' | 'image')[]
    reasoningEfforts: false | Record<string, string | null>
  }[]
}
const provider = (id: string): CatalogProvider => ({
  id,
  name: id,
  models: [{ id: 'writer', name: 'Writer', contextWindow: 128_000, maxTokens: 8_192,
    input: ['text'], reasoningEfforts: false }],
})
const catalog = { providers: providerIds.map(provider) }
type SupplierScript = Parameters<typeof mockServer>[0]

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  try { await closeMockServers() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Muse failover fixture cleanup failed')
})

async function harness(script: SupplierScript, options: {
  hiddenProviderIds?: readonly string[]
  providers?: CatalogProvider[]
  retryBeforeModels?: boolean
} = {}): Promise<{ ctx: Context; agent: Agent; server: Awaited<ReturnType<typeof mockServer>>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'muse-model-failover-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await oldSessionFixture(false, root)
  cleanup.push(() => fixture.ctx.fiber.dispose())
  if (options.retryBeforeModels) await installRetry(fixture.ctx)
  const server = await mockServer(script)
  await writeMuseSession(join(root, 'session.json'), {
    baseUrl: server.url, username: 'alice', cookie: '__Host-muse=alice-session',
  })
  const models = new MuseModels(fixture.ctx, {
    baseUrl: server.url,
    sessionFile: join(root, 'session.json'),
    requestTimeoutMs: 1_000,
    ...(options.hiddenProviderIds === undefined ? {} : { hiddenProviderIds: options.hiddenProviderIds }),
    fetcher: async () => Response.json({ providers: options.providers ?? catalog.providers }),
  })
  cleanup.push(() => models.dispose())
  await models.refresh()
  fixture.agent.model.select({ provider: 'muse-cloud-alpha', model: 'writer' })
  return { ctx: fixture.ctx, agent: fixture.agent, server, root }
}

async function installRetry(ctx: Context): Promise<void> {
  await ctx.plugin(Object.assign(async (scope: Context) => retry.apply(scope, {}), { inject: retry.inject }))
}

async function send(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Continue the approved draft.' }], source: { kind: 'user' },
  }))
  await idle
}

it('uses a different account supplier after a transient failure without duplicating the user message', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{"error":{"message":"private supplier diagnostic"}}' },
    { events: textEvents },
  ])
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/beta/chat/completions',
  ])
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
  expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
  expect(agent.model.current()).toMatchObject({ provider: 'muse-cloud-beta', model: 'writer' })
  expect(events.find(event => event.type === 'turn/end')?.data.reason).toMatchObject({ kind: 'completed' })
  expect(JSON.stringify(events)).not.toContain('private supplier diagnostic')
})

it('can fall back to a compatible model with a different name at another supplier', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: [provider('alpha'), { ...provider('beta'), models: [
    { ...provider('beta').models[0]!, id: 'other-writer', name: 'Other Writer' },
  ] }] })
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/beta/chat/completions',
  ])
  expect((server.requests as { model: string }[]).map(request => request.model))
    .toEqual(['writer', 'other-writer'])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('skips hidden and incompatible-effort suppliers while retaining a compatible account route', async () => {
  const supportsHigh = (id: string): CatalogProvider => ({ ...provider(id), models: [
    { ...provider(id).models[0]!, reasoningEfforts: { high: 'high' } },
  ] })
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { hiddenProviderIds: ['beta'], providers: [
    supportsHigh('alpha'), supportsHigh('beta'), provider('gamma'), supportsHigh('delta'),
  ] })
  agent.model.select({ provider: 'muse-cloud-alpha', model: 'writer', reasoningEffort: ReasoningEffortId('high') })
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/delta/chat/completions',
  ])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('leaves a saved hidden source through a visible supplier without selecting a hidden destination', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { hiddenProviderIds: ['alpha', 'gamma'] })
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/beta/chat/completions',
  ])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it.each([false, true])('uses five same-supplier retries before switching (retry registered first: %s)',
  { timeout: 30_000 }, async (retryBeforeModels) => {
    const { ctx, agent, server } = await harness([
      ...Array.from({ length: 6 }, () => ({ status: 503, body: '{}' })),
      { events: textEvents },
    ], { retryBeforeModels })
    if (!retryBeforeModels) await installRetry(ctx)
    expect(ctx.llm.providerRetryPolicy('muse-cloud-alpha')).toMatchObject({ mode: 'normal', maxRetries: 5 })
    // Keep the production retry count while reducing its delays for the test.
    const originalPrepareCall = ctx.llm.prepareCall.bind(ctx.llm)
    const shortPolicy = resolveRetryPolicy({
      mode: 'normal', maxRetries: 5,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'model failover test retryPolicy')
    vi.spyOn(ctx.llm, 'prepareCall').mockImplementation(async (config, signal, configure) => ({
      ...await originalPrepareCall(config, signal, configure), retryPolicy: shortPolicy,
    }))
    await send(ctx, agent)

    expect(server.paths).toEqual([
      ...Array.from({ length: 6 }, () => '/api/desktop-models/alpha/chat/completions'),
      '/api/desktop-models/beta/chat/completions',
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
      .map(event => ({ provider: event.data.provider, retry: event.data.retry })))
      .toEqual(Array.from({ length: 5 }, (_, index) => ({ provider: 'muse-cloud-alpha', retry: index + 1 })))
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'completed' })
  })

it('skips a supplier with image-only input when sending text', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: [provider('alpha'), { ...provider('beta'), models: [
    { ...provider('beta').models[0]!, input: ['image'] },
  ] }, provider('gamma')] })
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/gamma/chat/completions',
  ])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('requires enough context and explicit output tokens before selecting another supplier', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: [
    provider('alpha'),
    { ...provider('beta'), models: [{ ...provider('beta').models[0]!, contextWindow: 64_000 }] },
    { ...provider('gamma'), models: [{ ...provider('gamma').models[0]!, maxTokens: 4_096 }] },
    provider('delta'),
  ] })
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 6_000 }))
  await send(ctx, agent)

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/delta/chat/completions',
  ])
  expect((server.requests as { max_tokens: number }[]).map(request => request.max_tokens)).toEqual([6_000, 6_000])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('compares later suppliers with the original model capacity after a larger intermediate supplier fails', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: [
    provider('alpha'),
    { ...provider('beta'), models: [{ ...provider('beta').models[0]!, contextWindow: 1_000_000 }] },
    provider('gamma'),
  ] })
  await send(ctx, agent)

  expect(server.paths).toEqual(providerIds.map(id => `/api/desktop-models/${id}/chat/completions`))
  expect(agent.model.current()).toMatchObject({ provider: 'muse-cloud-gamma', model: 'writer' })
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('does not fall back to a text-only supplier when the same request contains an image', async () => {
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: [
    { ...provider('alpha'), models: [{ ...provider('alpha').models[0]!, input: ['text', 'image'] }] },
    provider('beta'),
    { ...provider('gamma'), models: [{ ...provider('gamma').models[0]!, input: ['text', 'image'] }] },
  ] })
  const image = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png' as const, bytes: 68, width: 1, height: 1 }
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  Object.assign(ctx.attachments, {
    imageHostPath: () => undefined,
    readImageRequest: async () => ({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: image,
      data: bytes, mediaType: 'image/png', bytes: bytes.byteLength, width: 1, height: 1,
      depth: 'uchar', space: 'srgb', hasAlpha: false,
    }),
  })
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'image', attachment: image }], source: { kind: 'user' } }))
  await idle

  expect(server.paths).toEqual([
    '/api/desktop-models/alpha/chat/completions',
    '/api/desktop-models/gamma/chat/completions',
  ])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'completed' })
})

it('does not use the previous account catalog after the login revision changes', async () => {
  const { ctx, agent, server, root } = await harness([{ events: textEvents }])
  await writeMuseSession(join(root, 'session.json'), {
    baseUrl: server.url, username: 'bob', cookie: '__Host-muse=bob-session',
  })
  await send(ctx, agent)

  expect(server.paths).toEqual([])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'MISSING_CREDENTIAL' } })
})

it('tries each account supplier at most once and reports an error when all are unavailable', async () => {
  const { ctx, agent, server } = await harness(providerIds.map(() => ({ status: 503, body: '{}' })))
  await send(ctx, agent)

  expect(server.paths).toEqual(providerIds.map(id => `/api/desktop-models/${id}/chat/completions`))
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
  expect(events.find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'MUSE_PROVIDERS_EXHAUSTED' } })
})

it('does not change supplier for a permanent request refusal', async () => {
  const { ctx, agent, server } = await harness([
    { status: 400, body: '{"error":{"message":"invalid request"}}' },
  ])
  await send(ctx, agent)

  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'INVALID_REQUEST' } })
})

it('does not switch suppliers when the account gateway returns 401 authentication failure', async () => {
  const { ctx, agent, server } = await harness([
    { status: 401, body: '{"error":{"message":"account session expired"}}' },
  ])
  await send(ctx, agent)

  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'AUTH' } })
})

it('does not start another supplier after the user cancels a streaming request', async () => {
  const { ctx, agent, server } = await harness([{ events: textEvents.slice(0, 1), holdOpen: true }])
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Continue the approved draft.' }], source: { kind: 'user' },
  }))
  await server.requestReceived
  agent.cancel({ kind: 'user' })
  await idle

  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'aborted' })
})
