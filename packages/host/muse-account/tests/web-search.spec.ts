/** Account search uses a fake gateway, never a supplier key or paid search endpoint. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as MuseAccount from '../src/index.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'
import { mountMuseWebSearch, MuseWebSearchProvider } from '../src/web-search.ts'

vi.mock('@deepseek-ai/dsh-mcp-client', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-mcp-client')>(), inject: [], apply: () => {},
}))

const origin = 'https://muse.example'
const cookie = '__Host-muse=fake-session-private'
const homes: string[] = []
function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input)
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function fixture(signedIn = true) {
  const home = await mkdtemp(join(tmpdir(), 'muse-web-search-')); homes.push(home)
  const sessionFile = join(home, 'session.json')
  if (signedIn) await writeMuseSession(sessionFile, { baseUrl: origin, username: 'editor', cookie })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [] }))
  const provider = new MuseWebSearchProvider({ baseUrl: origin, sessionFile, requestTimeoutMs: 60_000, fetcher })
  return { home, sessionFile, fetcher, provider }
}

it('uses only the Muse session at the fixed same-origin endpoint and maps citeable sources', async () => {
  const { provider, fetcher } = await fixture()
  fetcher.mockResolvedValueOnce(Response.json({ apiKey: 'not-a-client-field', results: [
    { title: 'First', url: 'https://source.example/1', snippet: 'excerpt', summary: 'unused summary', date: '2026-10-30', key: 'ignored' },
    { url: 'https://source.example/2', summary: 'summary fallback' },
    { url: 'https://source.example/1', title: 'duplicate' },
  ] }))
  const result = await provider.search({ query: 'Muse release', maxResults: 8 })
  expect(result).toEqual({ sources: [
    { title: 'First', url: 'https://source.example/1', snippet: 'excerpt', publishedAt: '2026-10-30' },
    { url: 'https://source.example/2', snippet: 'summary fallback' },
  ], truncated: false })
  const [url, init] = fetcher.mock.calls[0]!
  expect(requestUrl(url).href).toBe(`${origin}/api/web/search`)
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
    cookie, origin, 'content-type': 'application/json', accept: 'application/json',
  } })
  expect(new Headers(init?.headers).has('authorization')).toBe(false)
  expect(new Headers(init?.headers).has('x-api-key')).toBe(false)
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request text')
  expect(JSON.parse(init.body)).toEqual({ query: 'Muse release', maxResults: 8 })
  expect(JSON.stringify(result)).not.toMatch(/fake-session-private|not-a-client-field|ignored/)
})

it('preserves result-count bounds without changing anonymous fetching', async () => {
  const { provider, fetcher } = await fixture()
  fetcher.mockResolvedValueOnce(Response.json({ results: [{ url: 'https://a.example' }, { url: 'https://b.example' }] }))
  expect(await provider.search({ query: 'q', maxResults: 1 })).toEqual({ sources: [{ url: 'https://a.example' }], truncated: true })
})

it('refuses signed-out or wrong-origin sessions before contacting the gateway', async () => {
  const { provider, fetcher, sessionFile } = await fixture(false)
  await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  await writeMuseSession(sessionFile, { baseUrl: 'https://other.example', username: 'other', cookie })
  await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([401, 403, 429, 502, 503, 504, 302])('contains rejected HTTP %s diagnostics without response text or credentials', async (status) => {
  const { provider, fetcher } = await fixture()
  fetcher.mockResolvedValueOnce(new Response('supplier-key=never-expose-this ' + cookie, { status }))
  const error = await provider.search({ query: 'q' }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).not.toMatch(/never-expose-this|fake-session-private|supplier-key/)
  expect(error).toMatchObject({ code: status === 401 || status === 403 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR' })
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each(['not JSON', JSON.stringify({ results: [{ url: 'javascript:alert(1)' }] }),
  JSON.stringify({ results: [{ url: 'https://username:secret@example.com' }] }),
  JSON.stringify({ results: [{ url: 4 }] }), 'x'.repeat(1024 * 1024 + 1)])(
  'rejects invalid or oversized search replies without exposing their body', async (body) => {
    const { provider, fetcher } = await fixture()
    fetcher.mockResolvedValueOnce(new Response(body))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  },
)

it('contains transport exceptions, including foreign WebError messages', async () => {
  const { provider, fetcher } = await fixture()
  const { WebError } = await import('@deepseek-ai/dsh-web')
  fetcher.mockRejectedValueOnce(new WebError('private supplier-key and ' + cookie, 'FOREIGN'))
  await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR',
    message: 'Muse web search could not complete the request.' })
})

it('rejects results when the saved account changes during the request', async () => {
  const { provider, fetcher, sessionFile } = await fixture()
  fetcher.mockImplementationOnce(async () => {
    await writeMuseSession(sessionFile, { baseUrl: origin, username: 'new-user', cookie: '__Host-muse=other-fake-private' })
    return Response.json({ results: [{ url: 'https://source.example' }] })
  })
  await expect(provider.search({ query: 'q' })).rejects.toThrow('Muse account changed during search')
  expect((await readMuseSession(sessionFile, origin))?.username).toBe('new-user')
})

it('cancels an active request and does not expose the caller abort reason', async () => {
  const { provider, fetcher } = await fixture()
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
  fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    started()
    init?.signal?.addEventListener('abort', () => { reject(new Error('private transport token')) }, { once: true })
  }))
  const controller = new AbortController()
  const result = provider.search({ query: 'q' }, controller.signal)
  await active
  controller.abort('private caller token')
  await expect(result).rejects.toMatchObject({ code: 'WEB_ABORTED', message: 'Muse web search was cancelled.' })
})

it('refuses a pre-cancelled call before session access or gateway requests', async () => {
  const { provider, fetcher } = await fixture()
  const controller = new AbortController(); controller.abort()
  await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('removes the provider on plugin disposal and waits for active search cancellation', async () => {
  const { sessionFile, fetcher } = await fixture()
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { searchProvider: 'muse', fetchProvider: 'http' })
  const fiber = await ctx.plugin({ apply: (scope: Context) => { mountMuseWebSearch(scope, {
    baseUrl: origin, sessionFile, requestTimeoutMs: 60_000, fetcher,
  }) } })
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
  fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    started()
    init?.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
  }))
  const result = ctx.web.search({ query: 'q' })
  const rejected = expect(result).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  await active
  await fiber.dispose()
  await rejected
  await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  await ctx.fiber.dispose()
})

it('boots the actual Muse plugin through Loader and keeps the default model and fetch provider unchanged', async () => {
  const { home } = await fixture()
  const fetcher = vi.fn<typeof fetch>(async input => requestUrl(input).pathname === '/api/web/search'
    ? Response.json({ results: [{ title: 'Gateway source', url: 'https://source.example', snippet: 'offline fixture' }] })
    : Response.json({ providers: [{ id: 'test', name: 'Test', models: [{ id: 'writer', name: 'Writer',
      contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }))
  vi.stubGlobal('fetch', fetcher)
  const loaded = await configurationFixture({ hmr: false, rows: [
    { id: 'editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'model', name: 'cordis:model', config: { provider: 'personal', model: 'unchanged-default' } },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'web', name: 'cordis:web', config: { searchProvider: 'muse', fetchProvider: 'http' } },
    { id: 'account', name: 'cordis:muse', config: { baseUrl: origin, accountHome: home, webSearch: true } },
  ], builtins: { llm: LlmRuntime, projections: SessionProjectionRegistry, prompt: SystemPrompt, tools: ToolRuntime,
    web: WebRuntime, muse: MuseAccount } })
  expect(await loaded.ctx.web.search({ query: 'q', maxResults: 8 })).toEqual({ sources: [
    { title: 'Gateway source', url: 'https://source.example', snippet: 'offline fixture' },
  ], truncated: false })
  expect(loaded.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'unchanged-default' })
  await expect(loaded.ctx.web.fetch({ url: 'https://source.example' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  expect(fetcher.mock.calls.every(([input]) => requestUrl(input).origin === origin)).toBe(true)
})

it('leaves account search disabled by default and validates its independent request deadline', () => {
  expect(MuseAccount.Config({ baseUrl: origin })).toMatchObject({ webSearch: false, searchRequestTimeoutMs: 60_000 })
  for (const searchRequestTimeoutMs of [0, -1, 1.5, 120_001, '1000']) {
    expect(() => { Reflect.apply(MuseAccount.Config, undefined, [{ baseUrl: origin, searchRequestTimeoutMs }]) }).toThrow()
  }
})

it('bounds a stalled search by its independent deadline', async () => {
  const { sessionFile, fetcher } = await fixture()
  fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('private timeout diagnostic')) }, { once: true })
  }))
  const provider = new MuseWebSearchProvider({ baseUrl: origin, sessionFile, requestTimeoutMs: 10, fetcher })
  await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR',
    message: 'Muse web search timed out; try again later.' })
})

it('does not contact a redirect target with the saved account cookie', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-search-redirect-')); homes.push(home)
  let targetRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/api/web/search') response.writeHead(302, { location: '/redirect-target' }).end()
    else { targetRequests++; response.end('unexpected redirect') }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected private loopback listener')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const sessionFile = join(home, 'session.json')
    await writeMuseSession(sessionFile, { baseUrl, username: 'editor', cookie })
    const provider = new MuseWebSearchProvider({ baseUrl, sessionFile, requestTimeoutMs: 10_000 })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(targetRequests).toBe(0)
    await provider.dispose()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }
})
