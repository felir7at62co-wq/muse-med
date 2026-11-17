import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MuseAccountController } from '../src/account.ts'
import { createMuseAccountGateway, MuseGatewayError } from '../src/gateway.ts'
import { MuseAccountService } from '../src/service.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'
import { accountDetailsFixture } from './account-details-fixture.ts'
import { readMuseAccountDetails } from '../src/account-details.ts'

const roots: string[] = []
const contexts: Context[] = []
const baseUrl = 'https://muse.example'
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function controller(fetcher: typeof fetch): Promise<{ account: MuseAccountController; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'muse-account-details-'))
  roots.push(root)
  const file = join(root, 'session.json')
  return { file, account: new MuseAccountController({ baseUrl, sessionFile: file,
    gateway: createMuseAccountGateway(baseUrl, 1000, fetcher) }) }
}

it('returns only validated own profile and usage fields through the Remote account service', async () => {
  const expected = accountDetailsFixture()
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(url instanceof Request ? url.url : url).href).toBe(baseUrl + '/api/muse.account/details?period=7d&offset=50&limit=50')
    expect(new Headers(init?.headers).get('cookie')).toBe('__Host-muse=writer')
    return Response.json({ ...expected, cookie: 'PRIVATE_COOKIE', account: { ...expected.account, token: 'PRIVATE_TOKEN' } })
  })
  const { account, file } = await controller(fetcher)
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=writer', username: 'writer' })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MuseAccountService, { controller: account })
  expect(await ctx.museAccount.details({ period: '7d', offset: 50, limit: 50 })).toEqual(expected)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['invalid JSON', 'negative tokens', 'invalid group', 'invalid date', 'too many recent rows'])(
  'rejects %s without returning raw gateway data', async (kind) => {
    const data = accountDetailsFixture()
    let body = JSON.stringify(data)
    if (kind === 'invalid JSON') body = 'PRIVATE_RAW_BODY'
    if (kind === 'negative tokens') body = JSON.stringify({ ...data, usage: { ...data.usage, summary: { ...data.usage.summary, inputTokens: -1 } } })
    if (kind === 'invalid group') body = JSON.stringify({ ...data, groups: [{ id: 'bad', name: 'private', description: '' }] })
    if (kind === 'invalid date') body = JSON.stringify({ ...data, account: { ...data.account, createdAt: 'bad date' } })
    if (kind === 'too many recent rows') body = JSON.stringify({ ...data, usage: { ...data.usage, recent: Array(101).fill(data.usage.recent[0]) } })
    const gateway = createMuseAccountGateway(baseUrl, 1000, async () => new Response(body))
    await expect(gateway.details('__Host-muse=private', {})).rejects.toMatchObject({ code: 'gateway-rejected',
      message: 'MUSE account gateway: gateway-rejected' })
  },
)

it('rejects an oversized response and releases the reader', async () => {
  let cancelled = false
  const gateway = createMuseAccountGateway(baseUrl, 1000, async () => new Response(new ReadableStream({
    pull(stream) { stream.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })))
  await expect(gateway.details('__Host-muse=private', {})).rejects.toMatchObject({ code: 'gateway-rejected' })
  expect(cancelled).toBe(true)
})

it('preserves legacy identities without inventing a synchronized department', async () => {
  const expected = accountDetailsFixture()
  const identity = expected.account.feishuIdentities[0]!
  const legacy = { ...expected, account: { ...expected.account, feishuIdentities: [{
    name: identity.name, tenantKey: identity.tenantKey, boundAt: identity.boundAt, lastLoginAt: null,
  }] } }
  expect(await readMuseAccountDetails(Response.json(legacy))).toEqual(legacy)
})

it('bounds absent and interrupted response bodies without retaining transport diagnostics', async () => {
  await expect(readMuseAccountDetails(new Response(null))).rejects.toMatchObject({ code: 'gateway-rejected' })
  const interrupted = new Response(new ReadableStream({ start(stream) { stream.error(new Error('PRIVATE_NETWORK_DETAIL')) } }))
  await expect(readMuseAccountDetails(interrupted)).rejects.toMatchObject({ code: 'gateway-unavailable',
    message: 'MUSE account gateway: gateway-unavailable' })
})

it('does not make a details request while signed out', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { account } = await controller(fetcher)
  await expect(account.details({})).rejects.toMatchObject({ code: 'invalid-credentials' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('discards an old account response after another login is saved', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { account, file } = await controller(async () => { entered(); await gate; return Response.json(accountDetailsFixture()) })
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=writer', username: 'writer' })
  const request = account.details({})
  await started
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=new', username: 'new' })
  release()
  await expect(request).rejects.toMatchObject({ code: 'invalid-credentials' })
  expect((await readMuseSession(file, baseUrl))?.username).toBe('new')
})

it.each([401, 429, 503])('contains details HTTP %i and preserves storage except confirmed invalid login', async (status) => {
  const { account, file } = await controller(async () => new Response('PRIVATE_BODY', { status }))
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=writer', username: 'writer' })
  await expect(account.details({})).rejects.toMatchObject({ code: status === 401 ? 'invalid-credentials'
    : status === 429 ? 'rate-limited' : 'gateway-rejected' })
  expect(await readMuseSession(file, baseUrl)).toEqual(status === 401 ? null : expect.objectContaining({ username: 'writer' }))
})

it('uses a bounded service failure when private details transport fails', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MuseAccountService, { controller: {
    status: async () => ({ state: 'signed-out' }), login: async () => { throw new Error('unused') }, logout: async () => ({ state: 'signed-out' }),
    details: async () => { throw new MuseGatewayError('gateway-unavailable') },
  } })
  await expect(ctx.museAccount.details({})).rejects.toMatchObject({ code: 'muse-account/gateway-unavailable' })
})
