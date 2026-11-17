/** Legacy personal usage compatibility preserves real coverage, missing counters and account ownership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createMuseAccountGateway } from '../src/gateway.ts'
import { MuseAccountController } from '../src/account.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'

const baseUrl = 'https://muse.example'
const cookie = '__Host-muse=private'
const identity = { version: 1, accountId: '0123456789abcdef', username: 'writer', admin: true, secret: 'PRIVATE_IDENTITY' }
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function usageFixture() {
  return { version: 1, coverage: { transport: 'relay-only', direct: 'unobserved' }, from: '2026-10-19', to: '2026-11-17',
    summary: { requests: 461, completedRequests: 453, failedRequests: 8, pendingRequests: 0, unknownRequests: 0,
      reportedUsageRequests: 453, partialUsageRequests: 0, unreportedUsageRequests: 8,
      inputTokens: 95_947_984, outputTokens: 336_277, totalTokens: 96_284_261 },
    items: [{ requestId: '58ba3b25-132c-4397-8b40-2545ba74f9cb', accountId: 'PRIVATE_ACCOUNT',
      startedAt: '2026-11-16T08:30:03.036Z', finishedAt: '2026-11-16T08:30:05.000Z',
      channel: 'desktop-relay', route: 'deepseek-official', state: 'completed', usageStatus: 'reported',
      usage: { prompt_tokens: 12_034, completion_tokens: 3_838, total_tokens: 15_872,
        prompt_tokens_details: { cached_tokens: 10_000 }, completion_tokens_details: { reasoning_tokens: 12 } },
      requestedModel: 'deepseek-flash', forwardedModel: 'deepseek-flash', responseModel: 'deepseek-flash',
      upstreamStatus: 200, clientStatus: 200, errorKind: null, private: 'PRIVATE_CONTENT' }],
    nextCursor: 'b3BhcXVl', health: { state: 'degraded', private: 'PRIVATE_HEALTH' }, private: 'PRIVATE_RESPONSE' }
}

function relayFetcher(usage: object = usageFixture()): typeof fetch {
  return async (url) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname
    return path === '/api/muse.account/details' ? new Response('missing', { status: 404 })
      : Response.json(path === '/api/muse/identity' ? identity : usage)
  }
}

it('uses authenticated personal APIs only after a missing details endpoint and strips private fields', async () => {
  const calls: URL[] = []
  const source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(url)
    expect(url.origin).toBe(baseUrl)
    expect(new Headers(init?.headers).get('cookie')).toBe(cookie)
    expect(init?.redirect).toBe('manual')
    return source(input, init)
  })
  const result = await gateway.details(cookie, {})
  expect(result.protocol).toBe('account-data-v1')
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.account).toEqual({ id: identity.accountId, username: identity.username })
  expect(result.availability).toEqual({ profile: 'unavailable', groups: 'unavailable', feishuOrganization: 'unavailable' })
  expect(result.usage.summary.totalTokens).toBe(96_284_261)
  expect(result.usage.summary.requests).toBe(461)
  expect(result.usage.items).toHaveLength(1)
  expect(result.usage.items[0]?.usage?.prompt_tokens_details?.cached_tokens).toBe(10_000)
  expect(result.usage.coverage).toEqual({ transport: 'relay-only', direct: 'unobserved' })
  expect(result.usage.health).toEqual({ state: 'degraded' })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  expect(calls.map(url => url.pathname)).toEqual(['/api/muse.account/details', '/api/muse/identity', '/api/muse/usage'])
  expect(calls.every(url => !url.searchParams.has('accountId'))).toBe(true)
})

it.each([
  ['today', '2026-11-16'], ['7d', '2026-11-10'], ['30d', '2026-10-18'], [undefined, '2026-10-18'],
] as const)('resolves %s from UTC dates even when Beijing is on the following day', async (period, from) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T23:30:00.000Z'))
  const source = relayFetcher(), calls: URL[] = []
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    calls.push(new URL(input instanceof Request ? input.url : input))
    return source(input, init)
  })
  await gateway.details(cookie, { ...(period === undefined ? {} : { period }), limit: 2, cursor: 'b3BhcXVl' })
  expect(calls.at(-1)?.search).toBe('?from=' + from + '&to=2026-11-16&limit=2&cursor=b3BhcXVl')
})

it('retains the successful page dates across UTC midnight and resolves a new range on refresh', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T23:59:00.000Z'))
  const source = relayFetcher(), queries: URLSearchParams[] = []
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname !== '/api/muse/usage') return source(input, init)
    queries.push(url.searchParams)
    return Response.json({ ...usageFixture(), from: url.searchParams.get('from'), to: url.searchParams.get('to') })
  })
  const first = await gateway.details(cookie, { period: '7d' })
  if (first.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  const range = { from: first.usage.from, to: first.usage.to }
  vi.setSystemTime(new Date('2026-11-18T00:01:00.000Z'))
  await gateway.details(cookie, { period: '7d', cursor: first.usage.nextCursor!, range })
  await gateway.details(cookie, { period: '7d' })
  expect(queries.map(query => [query.get('from'), query.get('to'), query.get('cursor')])).toEqual([
    ['2026-11-11', '2026-11-17', null], ['2026-11-11', '2026-11-17', 'b3BhcXVl'], ['2026-11-12', '2026-11-18', null],
  ])
})

it.each([
  { from: '2026-2-01', to: '2026-11-17' }, { from: '2026-02-30', to: '2026-11-17' },
  { from: '2026-11-18', to: '2026-11-17' }, { from: '2026-11-17', to: '2026-11-17T00:00:00.000Z' },
])('rejects an invalid retained UTC range %j before requesting identity or usage', async (range) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, { range, cursor: 'b3BhcXVl' }))
    .rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects all-history even when a valid retained date range was supplied', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {
    period: 'all', range: { from: '2026-11-11', to: '2026-11-17' }, cursor: 'b3BhcXVl',
  })).rejects.toMatchObject({ code: 'unsupported-period' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('does not turn unknown supplier counters, absent models or unobserved direct use into zero', async () => {
  const data = usageFixture()
  const gateway = createMuseAccountGateway(baseUrl, 1000, relayFetcher({ ...data,
    summary: { ...data.summary, inputTokens: null, outputTokens: null, totalTokens: null },
    items: [{ requestId: data.items[0]!.requestId, startedAt: data.items[0]!.startedAt, finishedAt: null,
      channel: 'cloud-relay', route: null, state: 'pending', usageStatus: 'unreported', usage: null }], nextCursor: null,
  }))
  const result = await gateway.details(cookie, { cursor: 'b3BhcXVl' })
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.usage.summary.totalTokens).toBeNull()
  expect(result.usage.items[0]).toMatchObject({ usage: null, responseModel: null, requestedModel: null, upstreamStatus: null })
  expect(result.usage.nextCursor).toBeNull()
})

it.each([303, 401, 403, 429, 500, 200])('does not probe an older protocol after details HTTP %i', async (status) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('PRIVATE_BODY', { status }))
  const gateway = createMuseAccountGateway(baseUrl, 1000, fetcher)
  await expect(gateway.details(cookie, {})).rejects.toMatchObject({ code: status === 303 || status === 401
    ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects all-history and unsupported offset pagination before reading relay data', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }))
  const gateway = createMuseAccountGateway(baseUrl, 1000, fetcher)
  await expect(gateway.details(cookie, { period: 'all' })).rejects.toMatchObject({ code: 'unsupported-period' })
  await expect(gateway.details(cookie, { offset: 50 })).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([303, 401, 403, 429, 503])('contains legacy personal HTTP %i and never leaks its body', async (status) => {
  const fetcher = vi.fn<typeof fetch>(async input => new URL(input instanceof Request ? input.url : input).pathname === '/api/muse.account/details'
    ? new Response(null, { status: 404 }) : new Response('PRIVATE_LEGACY_BODY', { status }))
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})).rejects.toMatchObject({
    code: status === 303 || status === 401 ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected',
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each(['coverage', 'negative tokens', 'invalid date', 'cursor', 'oversized page', 'identity'])('rejects malformed relay %s', async (kind) => {
  const data = usageFixture()
  const usage = kind === 'coverage' ? { ...data, coverage: { transport: 'all', direct: 'observed' } }
    : kind === 'negative tokens' ? { ...data, items: [{ ...data.items[0], usage: { total_tokens: -1 } }] }
      : kind === 'invalid date' ? { ...data, from: '2026-02-30' }
        : kind === 'cursor' ? { ...data, nextCursor: '' }
          : kind === 'oversized page' ? { ...data, items: Array(101).fill(data.items[0]) } : data
  const source = relayFetcher(usage)
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => kind === 'identity'
    && new URL(input instanceof Request ? input.url : input).pathname === '/api/muse/identity'
    ? Response.json({ ...identity, accountId: 'invalid', secret: 'PRIVATE_SECRET' }) : source(input, init))
  await expect(gateway.details(cookie, {})).rejects.toMatchObject({ code: 'gateway-rejected', message: 'MUSE account gateway: gateway-rejected' })
})

it('discards relay data after the local account changes while the ledger response is pending', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  const root = await mkdtemp(join(tmpdir(), 'muse-relay-details-'))
  roots.push(root)
  const sessionFile = join(root, 'session.json'), source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).pathname === '/api/muse/usage') { entered(); await pending }
    return source(input, init)
  })
  const account = new MuseAccountController({ baseUrl, sessionFile, gateway })
  await writeMuseSession(sessionFile, { baseUrl, cookie, username: 'writer' })
  const result = account.details({})
  await started
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=newer', username: 'newer' })
  release()
  await expect(result).rejects.toMatchObject({ code: 'invalid-credentials' })
  expect((await readMuseSession(sessionFile, baseUrl))?.username).toBe('newer')
})
