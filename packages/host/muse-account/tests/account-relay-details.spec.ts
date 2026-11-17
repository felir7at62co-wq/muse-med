/** Legacy personal usage compatibility preserves real coverage, missing counters and account ownership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createMuseAccountGateway } from '../src/gateway.ts'
import { MuseAccountController } from '../src/account.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'
import { probeMuseAccountRelayIdentity } from '../src/account-relay-details.ts'

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
    return path === '/api/muse.account/details' || path === '/api/muse/profile' || path === '/api/workbench' ? new Response('missing', { status: 404 })
      : Response.json(path === '/api/muse/identity' ? identity : usage)
  }
}

function profileFixture() {
  return { version: 1, account: { id: identity.accountId, username: identity.username,
    createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: '2026-11-17T00:00:00.000Z', lastActivityAt: null,
    feishuIdentities: [{ name: 'Writer', tenantKey: 'tenant', boundAt: '2026-10-01T00:00:00.000Z',
      lastLoginAt: '2026-11-17T00:00:00.000Z', openId: 'PRIVATE_OPEN_ID' }], secret: 'PRIVATE_ACCOUNT' },
  groups: [{ id: 'group-0123456789abcdef', name: 'Production', description: 'Assigned by Muse administrator' }],
  organization: { status: 'available', updatedAt: '2026-11-17T00:00:00.000Z', departments: [
    { id: 'department-team', name: 'Team', path: 'Company / Team', pathIds: ['department-root', 'department-team'], private: 'PRIVATE_DEPARTMENT' },
  ] }, private: 'PRIVATE_PROFILE' }
}

function profileFetcher(profile: object): typeof fetch {
  const source = relayFetcher()
  return async (input, init) => new URL(input instanceof Request ? input.url : input).pathname === '/api/muse/profile'
    ? Response.json(profile) : source(input, init)
}

function workbenchFixture() {
  return { scope: 'self', me: { id: identity.accountId, name: 'Writer' },
    organization: { status: 'partial', updatedAt: '2026-11-17T00:00:00.000Z' },
    members: [{ id: identity.accountId, username: identity.username, departmentPaths: [[
      { id: '0', name: 'Company' }, { id: 'department-team', name: 'Team' },
    ]], tasks: ['PRIVATE_MEMBER_TASK'] }],
    coordination: { tasks: [{ prompt: 'PRIVATE_PROMPT' }] }, production: { private: 'PRIVATE_PRODUCTION' } }
}

function workbenchFetcher(workbench: object): typeof fetch {
  const source = relayFetcher()
  return async (input, init) => new URL(input instanceof Request ? input.url : input).pathname === '/api/workbench'
    ? Response.json(workbench) : source(input, init)
}

it.each(['ready', 'partial'])('reads only the authenticated self workbench departments when organization is %s', async (status) => {
  const fixture = workbenchFixture(), source = workbenchFetcher({ ...fixture, organization: { ...fixture.organization, status } })
  const calls: URL[] = []
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(url)
    expect(new Headers(init?.headers).get('cookie')).toBe(cookie)
    return source(input, init)
  })
  const result = await gateway.details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.profile).toBeUndefined()
  expect(result.organization).toEqual({ status: 'available', updatedAt: fixture.organization.updatedAt,
    departments: [{ id: 'department-team', name: 'Team', path: 'Company / Team', pathIds: ['0', 'department-team'] }] })
  expect(result.availability).toEqual({ profile: 'unavailable', groups: 'unavailable', feishuOrganization: 'available' })
  expect(calls.map(url => url.pathname)).toEqual(['/api/muse/identity', '/api/muse/profile', '/api/workbench', '/api/muse/usage'])
  expect(calls.find(url => url.pathname === '/api/workbench')?.searchParams.get('scope')).toBe('self')
  expect(calls.find(url => url.pathname === '/api/workbench')?.searchParams.has('from')).toBe(true)
  expect(calls.find(url => url.pathname === '/api/workbench')?.searchParams.has('to')).toBe(true)
  expect(result.usage.summary.totalTokens).toBe(96_284_261)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it.each(['null paths', 'global unavailable', 'empty departments', 'shared ancestor'])(
  'preserves the meaning of self workbench %s', async (kind) => {
    const fixture = workbenchFixture(), member = fixture.members[0]!
    const organization = kind === 'global unavailable' ? { ...fixture.organization, status: 'unavailable' } : fixture.organization
    const departmentPaths = kind === 'null paths' ? null : kind === 'empty departments' ? []
      : kind === 'shared ancestor' ? [...member.departmentPaths, [{ id: '0', name: 'Company' }, { id: 'department-other', name: 'Other' }]]
        : member.departmentPaths
    const result = await createMuseAccountGateway(baseUrl, 1000, workbenchFetcher({ ...fixture,
      organization: { ...organization, updatedAt: null }, members: [{ ...member, departmentPaths }],
    })).details(cookie, {})
    if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
    const available = kind === 'empty departments' || kind === 'shared ancestor'
    expect(result.organization?.status).toBe(available ? 'available' : 'unavailable')
    expect(result.organization?.updatedAt).toBeNull()
    expect(result.organization?.departments).toHaveLength(kind === 'shared ancestor' ? 2 : 0)
    expect(result.availability).toEqual({ profile: 'unavailable', groups: 'unavailable', feishuOrganization: available ? 'available' : 'unavailable' })
  },
)

it.each(['scope', 'me id', 'member id', 'username', 'extra member', 'status', 'date', 'empty path', 'missing node',
  'cycle', 'duplicate path', 'inconsistent name', 'inconsistent parent', 'depth', 'path count', 'blank name', 'node id'])(
  'rejects invalid self workbench %s without returning task content', async (kind) => {
    const fixture = workbenchFixture(), member = fixture.members[0]!, path = member.departmentPaths[0]!
    const departmentPaths = kind === 'empty path' ? [[]] : kind === 'missing node' ? [[{ id: '0' }]]
      : kind === 'cycle' ? [[...path, path[0]]]
        : kind === 'duplicate path' ? [path, path]
          : kind === 'inconsistent name' ? [path, [{ id: '0', name: 'Wrong' }, { id: 'other', name: 'Other' }]]
            : kind === 'inconsistent parent' ? [path, [{ id: 'root-other', name: 'Other' }, path[1]]]
              : kind === 'depth' ? [Array.from({ length: 101 }, (_, index) => ({ id: 'department-' + String(index), name: 'Department' }))]
                : kind === 'path count' ? Array(101).fill(path)
                  : kind === 'blank name' ? [[{ id: '0', name: '  ' }]]
                    : kind === 'node id' ? [[{ id: 'bad id', name: 'Company' }]] : member.departmentPaths
    const value = { ...fixture, scope: kind === 'scope' ? 'organization' : fixture.scope,
      me: { ...fixture.me, id: kind === 'me id' ? 'fedcba9876543210' : fixture.me.id },
      organization: { status: kind === 'status' ? 'unknown' : fixture.organization.status,
        updatedAt: kind === 'date' ? 'invalid date' : fixture.organization.updatedAt },
      members: kind === 'extra member' ? [member, member] : [{ ...member,
        id: kind === 'member id' ? 'fedcba9876543210' : member.id,
        username: kind === 'username' ? 'other' : member.username, departmentPaths }],
    }
    await expect(createMuseAccountGateway(baseUrl, 1000, workbenchFetcher(value)).details(cookie, {}))
      .rejects.toMatchObject({ code: 'gateway-rejected', message: 'MUSE account gateway: gateway-rejected' })
  },
)

it.each([303, 401, 403, 429, 503])('does not treat self workbench HTTP %i as absent support', async (status) => {
  const source = relayFetcher()
  const fetcher: typeof fetch = async (input, init) => new URL(input instanceof Request ? input.url : input).pathname === '/api/workbench'
    ? new Response('PRIVATE_WORKBENCH_ERROR', { status }) : source(input, init)
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})).rejects.toMatchObject({
    code: status === 303 || status === 401 ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected',
  })
})

it.each([false, true])('keeps relay data when the missing self workbench has no readable body (empty: %s)', async (empty) => {
  const source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => new URL(input instanceof Request ? input.url : input).pathname === '/api/workbench'
    ? new Response(empty ? null : new ReadableStream({ cancel() { throw new Error('PRIVATE_CANCEL_ERROR') } }), { status: 404 }) : source(input, init))
  const result = await gateway.details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.profile).toBeUndefined()
  expect(result.organization).toBeUndefined()
  expect(result.usage.summary.requests).toBe(461)
})

it.each(['2026-11-17T00:00:00.000Z', null])('joins verified profile data and retains its organization timestamp %s', async (updatedAt) => {
  const profile = profileFixture()
  const fetcher = vi.fn<typeof fetch>(profileFetcher({ ...profile,
    organization: { ...profile.organization, updatedAt },
  }))
  const result = await createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.profile).toMatchObject({ version: 1, account: { id: identity.accountId, username: identity.username },
    groups: [{ name: 'Production' }], organization: { status: 'available', departments: [{ name: 'Team', path: 'Company / Team' }] } })
  expect(result.availability).toEqual({ profile: 'available', groups: 'available', feishuOrganization: 'available' })
  expect(result.profile?.organization.updatedAt).toBe(updatedAt)
  expect(result.organization).toEqual(result.profile?.organization)
  expect(fetcher.mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : input).pathname === '/api/workbench')).toBe(true)
  expect(result.usage.coverage).toEqual({ transport: 'relay-only', direct: 'unobserved' })
  expect(result.usage.summary.totalTokens).toBe(96_284_261)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
})

it('retains verified empty Muse groups separately from unavailable organization data', async () => {
  const result = await createMuseAccountGateway(baseUrl, 1000, profileFetcher({ ...profileFixture(), groups: [],
    organization: { status: 'unavailable', updatedAt: null, departments: [] },
  })).details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.profile?.groups).toEqual([])
  expect(result.availability).toEqual({ profile: 'available', groups: 'available', feishuOrganization: 'unavailable' })
})

it.each(['account id', 'username', 'date', 'group id', 'organization', 'departments'])(
  'rejects invalid personal-profile %s before returning any relay data', async (kind) => {
    const source = profileFixture()
    const profile = kind === 'account id' ? { ...source, account: { ...source.account, id: 'fedcba9876543210' } }
      : kind === 'username' ? { ...source, account: { ...source.account, username: 'another-user' } }
        : kind === 'date' ? { ...source, account: { ...source.account, createdAt: 'invalid' } }
          : kind === 'group id' ? { ...source, groups: [{ ...source.groups[0], id: 'invalid' }] }
            : kind === 'organization' ? { ...source, organization: { ...source.organization, status: 'unknown' } }
              : { ...source, organization: { ...source.organization, departments: Array(101).fill(source.organization.departments[0]) } }
    await expect(createMuseAccountGateway(baseUrl, 1000, profileFetcher(profile)).details(cookie, {}))
      .rejects.toMatchObject({ code: 'gateway-rejected', message: 'MUSE account gateway: gateway-rejected' })
  },
)

it.each([303, 401, 403, 429, 503])('does not treat personal-profile HTTP %i as absent support', async (status) => {
  const source = relayFetcher(), calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    calls.push(path)
    return path === '/api/muse/profile' ? new Response('PRIVATE_PROFILE_ERROR', { status }) : source(input, init)
  }
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})).rejects.toMatchObject({
    code: status === 303 || status === 401 ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected',
  })
  expect(calls).toEqual(['/api/muse/identity', '/api/muse/profile'])
})

it.each([false, true])('keeps relay data when the missing-profile response has no readable body (empty: %s)', async (empty) => {
  const source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    if (new URL(input instanceof Request ? input.url : input).pathname !== '/api/muse/profile') return source(input, init)
    return new Response(empty ? null : new ReadableStream({ cancel() { throw new Error('PRIVATE_CANCEL_ERROR') } }), { status: 404 })
  })
  const result = await gateway.details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.profile).toBeUndefined()
  expect(result.usage.summary.requests).toBe(461)
})

it('selects authenticated personal APIs from verified identity capability and strips private fields', async () => {
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
  expect(calls.map(url => url.pathname)).toEqual(['/api/muse/identity', '/api/muse/profile', '/api/workbench', '/api/muse/usage'])
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
])('rejects an invalid retained UTC range %j before requesting profile or usage', async (range) => {
  const fetcher = vi.fn<typeof fetch>(relayFetcher())
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, { range, cursor: 'b3BhcXVl' }))
    .rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects all-history even when a valid retained date range was supplied', async () => {
  const fetcher = vi.fn<typeof fetch>(relayFetcher())
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

it.each([303, 401, 403, 429, 500, 200])('does not select relay details after unrecognized capability and full details HTTP %i', async (status) => {
  const fetcher = vi.fn<typeof fetch>(async input => new URL(input instanceof Request ? input.url : input).pathname === '/api/muse/identity'
    ? new Response(null, { status: 404 }) : new Response('PRIVATE_BODY', { status }))
  const gateway = createMuseAccountGateway(baseUrl, 1000, fetcher)
  await expect(gateway.details(cookie, {})).rejects.toMatchObject({ code: status === 303 || status === 401
    ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('rejects all-history and unsupported offset pagination before reading relay data', async () => {
  const fetcher = vi.fn<typeof fetch>(relayFetcher())
  const gateway = createMuseAccountGateway(baseUrl, 1000, fetcher)
  await expect(gateway.details(cookie, { period: 'all' })).rejects.toMatchObject({ code: 'unsupported-period' })
  await expect(gateway.details(cookie, { offset: 50 })).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([303, 401, 403, 429, 503])('contains legacy personal HTTP %i and never leaks its body', async (status) => {
  let first = true
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (path === '/api/muse/identity' && first) { first = false; return new Response(null, { status: 404 }) }
    return path === '/api/muse.account/details' ? new Response(null, { status: 404 }) : new Response('PRIVATE_LEGACY_BODY', { status })
  })
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})).rejects.toMatchObject({
    code: status === 303 || status === 401 ? 'invalid-credentials' : status === 429 ? 'rate-limited' : 'gateway-rejected',
  })
  expect(fetcher).toHaveBeenCalledTimes(3)
})

it('retains strict relay discovery after an unrecognized identity probe and a missing full-details endpoint', async () => {
  let probes = 0
  const source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (path === '/api/muse/identity' && ++probes === 1) return new Response('legacy HTML')
    return source(input, init)
  })
  expect((await gateway.details(cookie, {})).protocol).toBe('account-data-v1')
  expect(probes).toBe(2)
})

it('rejects an invalid strict identity after an unrecognized capability and a missing full endpoint', async () => {
  let probes = 0
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input) => {
    if (new URL(input instanceof Request ? input.url : input).pathname !== '/api/muse/identity') return new Response(null, { status: 404 })
    probes++
    return probes === 1 ? new Response('HTML') : Response.json({ ...identity, accountId: 'invalid' })
  })
  await expect(gateway.details(cookie, {})).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(probes).toBe(2)
})

it.each([null, 7, {}, { version: 2 }])('leaves an identity probe that does not claim version one unrecognized: %j', async (value) => {
  expect(await probeMuseAccountRelayIdentity(Response.json(value))).toBeUndefined()
})

it('preserves an interrupted identity-probe read as a transport failure', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('PRIVATE_NETWORK_ERROR')) },
  })))
  await expect(createMuseAccountGateway(baseUrl, 1000, fetcher).details(cookie, {})).rejects.toMatchObject({ code: 'gateway-unavailable' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps older recorded history separate from the overlapping cursor ledger', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'))
  const fixture = workbenchFixture(), source = relayFetcher()
  const gateway = createMuseAccountGateway(baseUrl, 1000, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname !== '/api/workbench') return source(input, init)
    return Response.json({ ...fixture, filters: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
      usage: { available: true, recordingSince: '2026-10-29T00:00:00.000Z', coverage: 'server-relay-only', limited: false, writeFailures: 0 },
      members: [{ ...fixture.members[0], usage: { status: 'recorded', metrics: { requests: 2, reported: 2, partial: 0, unknown: 0,
        inputTokens: 12, outputTokens: 8, totalTokens: 20, inputTokensReports: 2, outputTokensReports: 2, totalTokensReports: 2 } } }],
    })
  })
  const result = await gateway.details(cookie, {})
  if (result.protocol !== 'account-data-v1') throw new Error('Expected relay protocol')
  expect(result.history).toMatchObject({ from: '2026-10-29', to: '2026-11-17', timeZone: 'Asia/Shanghai', summary: { requests: 2, totalTokens: 20 } })
  expect(result.usage.summary.totalTokens).toBe(96_284_261)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
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
