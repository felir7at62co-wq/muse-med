/** Muse account model failover through the real AgentLoop and a local supplier. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MuseModels } from '../src/models.ts'
import * as sessionStorage from '../src/session.ts'
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
    defaultReasoningEffort?: 'low'
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
} = {}): Promise<{ ctx: Context; agent: Agent; models: MuseModels; server: Awaited<ReturnType<typeof mockServer>>; root: string }> {
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
  return { ctx: fixture.ctx, agent: fixture.agent, models, server, root }
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

it('tries the exact original model, then its family, before a different family regardless of catalog order', async () => {
  const choices = [
    ['alpha', 'deepseek-v4-flash'], ['beta', 'gpt-6-sol'],
    ['delta', 'deepseek-v4-pro'], ['gamma', 'deepseek-v4-flash'],
  ] as const
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' }, { status: 503, body: '{}' }, { status: 503, body: '{}' },
    { events: textEvents },
  ], { providers: choices.map(([id, model]) => ({ ...provider(id), models: [
    { ...provider(id).models[0]!, id: model, name: model },
  ] })) })
  agent.model.select({ provider: 'muse-cloud-alpha', model: 'deepseek-v4-flash' })
  await send(ctx, agent)

  expect(server.paths).toEqual(['alpha', 'gamma', 'delta', 'beta']
    .map(id => `/api/desktop-models/${id}/chat/completions`))
  expect((server.requests as { model: string }[]).map(request => request.model))
    .toEqual(['deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-6-sol'])
  expect(agent.model.current()).toEqual({ provider: 'muse-cloud-beta', model: 'gpt-6-sol' })
  expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user'))
    .toHaveLength(1)
})

it('can switch when the failed model supplied the omitted reasoning effort as an adapter default', async () => {
  const defaults = (id: string): CatalogProvider => ({ ...provider(id), models: [
    { ...provider(id).models[0]!, reasoningEfforts: { low: 'low' }, defaultReasoningEffort: 'low' },
  ] })
  const { ctx, agent, server } = await harness([
    { status: 503, body: '{}' }, { events: textEvents },
  ], { providers: [defaults('alpha'), defaults('beta')] })
  await send(ctx, agent)

  expect(server.paths).toEqual(['alpha', 'beta'].map(id => `/api/desktop-models/${id}/chat/completions`))
  expect((server.requests as { reasoning_effort: string }[]).map(request => request.reasoning_effort))
    .toEqual(['low', 'low'])
  expect(agent.model.current()).toEqual({ provider: 'muse-cloud-beta', model: 'writer' })
})

it.each(['provider', 'model', 'effort'] as const)('preserves a newer user %s choice made while recovery is pending', async (choice) => {
  const primary = provider('alpha')
  primary.models = [{ ...primary.models[0]!, reasoningEfforts: { low: 'low', high: 'high' } },
    { ...primary.models[0]!, id: 'other-writer', name: 'Other writer' }]
  const { ctx, agent, server } = await harness([{ status: 503, body: '{}' }], { providers: [primary, provider('beta')] })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  ctx.on('agent/request-error', async (_payload, next) => {
    entered.resolve(undefined)
    await release.promise
    return next()
  })
  agent.model.select({ provider: 'muse-cloud-alpha', model: 'writer', reasoningEffort: ReasoningEffortId('low') })
  const pending = send(ctx, agent)
  cleanup.push(async () => { release.resolve(undefined); await pending })
  await entered.promise
  const selection = choice === 'provider' ? { provider: 'muse-cloud-beta', model: 'writer' }
    : choice === 'model' ? { provider: 'muse-cloud-alpha', model: 'other-writer' }
      : { provider: 'muse-cloud-alpha', model: 'writer', reasoningEffort: ReasoningEffortId('high') }
  agent.model.select(selection)
  release.resolve(undefined)
  await pending

  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.model.current()).toEqual(selection)
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
})

it('does not recover from a catalog withdrawn by logout while downstream recovery is pending', async () => {
  const { ctx, agent, models, server, root } = await harness([{ status: 503, body: '{}' }])
  ctx.on('agent/request-error', async (_payload, next) => {
    await rm(join(root, 'session.json'))
    await models.refresh()
    return next()
  })
  await send(ctx, agent)

  expect(ctx.llm.listProviders().some(item => item.id.startsWith('muse-cloud-'))).toBe(false)
  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
})

it('rejects a public recovery event whose admitted carrier does not own its payload agent', async () => {
  const { ctx, agent, server, root } = await harness([{ status: 503, body: '{}' }])
  const ownerKey = { account: 'another-scope' }
  const ready = Promise.withResolvers<ReturnType<typeof createScope>>()
  await ctx.plugin(Object.assign((inner: Context) => { ready.resolve(createScope(inner, ownerKey)) }, { inject: ['llm'] }))
  const scope = await ready.promise
  cleanup.push(() => scope.dispose())
  const owner = new MuseModels(scope.ctx, {
    baseUrl: server.url, sessionFile: join(root, 'session.json'), requestTimeoutMs: 1_000,
    fetcher: async () => Response.json({ providers: [provider('studio'), provider('reserve')] }),
  })
  cleanup.push(() => owner.dispose())
  await owner.refresh()
  agent.model.select({ provider: 'muse-cloud-studio', model: 'writer' })
  await send(ctx, agent)
  let admitted = 0
  scope.ctx.on('agent/request-error', async (_payload, next) => { admitted += 1; return next() })
  const before = agent.session.snapshotEvents()

  // Exercise the public dispatch seam with an erroneous caller: carrier belongs to
  // the account scope, while the real payload Agent belongs to a different scope.
  const action = await ctx.waterfall(scopeTarget(agent, ownerKey), 'agent/request-error', {
    agent, turn: 1, step: 1, provider: 'muse-cloud-studio',
    failure: { code: 'SERVER', message: 'Unavailable' }, retryPolicy: undefined,
    signal: new AbortController().signal,
  }, async () => undefined)

  expect(admitted).toBe(1)
  expect(action).toBeUndefined()
  expect(server.paths).toEqual(['/api/desktop-models/studio/chat/completions'])
  expect(agent.model.current()).toEqual({ provider: 'muse-cloud-studio', model: 'writer' })
  expect(agent.session.snapshotEvents()).toEqual(before)
})

it.each(['logout', 'login replacement', 'catalog refresh', 'disposal'] as const)(
  'does not select a stale route when %s overlaps the recovery account read', async (change) => {
    const providers = [provider('alpha'), provider('beta')]
    const { ctx, agent, models, server, root } = await harness([{ status: 503, body: '{}' }], { providers })
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let recovering = false
    const read = sessionStorage.readMuseSession
    vi.spyOn(sessionStorage, 'readMuseSession').mockImplementation(async (...args) => {
      if (recovering) {
        recovering = false
        entered.resolve(undefined)
        await release.promise
      }
      return read(...args)
    })
    ctx.on('agent/request-error', async (_payload, next) => { recovering = true; return next() })
    const pending = send(ctx, agent)
    cleanup.push(async () => { release.resolve(undefined); await pending })
    await entered.promise
    if (change === 'logout') await rm(join(root, 'session.json'))
    else if (change === 'login replacement') await writeMuseSession(join(root, 'session.json'), {
      baseUrl: server.url, username: 'bob', cookie: '__Host-muse=bob-session',
    })
    else if (change === 'catalog refresh') { providers.push(provider('gamma')); await models.refresh() }
    else await models.dispose()
    release.resolve(undefined)
    await pending

    expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
    expect(agent.model.current()).toEqual({ provider: 'muse-cloud-alpha', model: 'writer' })
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
      .toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
  })

it.each(['cancellation', 'disposal'] as const)('lets %s stop a recovery listener that has already been captured', async (change) => {
  const { ctx, agent, models, server } = await harness([{ status: 503, body: '{}' }])
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  ctx.on('agent/request-error', async (_payload, next) => {
    entered.resolve(undefined)
    await release.promise
    return next()
  })
  const pending = send(ctx, agent)
  cleanup.push(async () => { release.resolve(undefined); await pending })
  await entered.promise
  if (change === 'cancellation') agent.cancel({ kind: 'user' })
  else await models.dispose()
  release.resolve(undefined)
  await pending

  expect(server.paths).toEqual(['/api/desktop-models/alpha/chat/completions'])
  expect(agent.model.current()).toEqual({ provider: 'muse-cloud-alpha', model: 'writer' })
  expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
    .toMatchObject(change === 'cancellation' ? { kind: 'aborted' } : { kind: 'error', error: { code: 'SERVER' } })
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
