/** Account-token data-station transport, Douyin link recognition and owned request lifecycle. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseDouyinStationClient, douyinTarget, parseDouyinLink } from '../src/douyin-station.ts'
import type { MuseDouyinStation, MuseDouyinStationOptions } from '../src/douyin-station.ts'
import { writeMuseSession } from '../src/session.ts'

const origin = 'https://muse.test'
const token = 'T'.repeat(43)
const cookie = `__Host-muse=${token}`
const prefix = `${origin}/data/api/muse-client/douyin`
const clients: MuseDouyinStationClient[] = []
const directories: string[] = []
const record = { id: 'r1', awemeId: '7570000000000000001', mixId: null, mixName: null, episode: null, title: '作品',
  state: 'done', key: 'download-video-date/douyin/20261115/7570000000000000001/video/000-7570000000000000001.mp4',
  url: 'https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115/7570000000000000001/video/000-7570000000000000001.mp4',
  error: null, attempts: 1, requestedBy: '成员', createdAt: '2026-11-15T00:00:00.000Z' }
const status = { enabled: true, access: 'public', linkSeconds: 0, dailyLimit: 50, usedToday: 3, unlimited: false, maxMixEpisodes: 300 }

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(overrides: Partial<MuseDouyinStationOptions> & { globalTransport?: true } = {}, signedIn = true) {
  const { globalTransport, ...options } = overrides
  const directory = await mkdtemp(join(tmpdir(), 'muse-douyin-station-'))
  directories.push(directory)
  const sessionFile = join(directory, 'session.json')
  if (signedIn) await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([record]))
  const client = new MuseDouyinStationClient({ baseUrl: origin, sessionFile, path: '/data/api/muse-client/douyin', requestTimeoutMs: 60_000,
    linkTimeoutMs: 60_000, maxReplyBytes: 65_536, listLimit: 300, ...globalTransport ? {} : { fetcher }, ...options })
  clients.push(client)
  const run = async <Result>(work: (station: MuseDouyinStation) => Promise<Result>, signal = new AbortController().signal) =>
    await client.run(signal, work)
  return { client, fetcher, sessionFile, run }
}

function request(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [input, init] = fetcher.mock.calls[index] ?? []
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  return { url, method: init?.method, headers: new Headers(init?.headers), body: init?.body }
}

it.each([
  ['https://www.douyin.com/video/7570000000000000001', { kind: 'work', awemeId: '7570000000000000001' }],
  ['https://www.douyin.com/user/self?modal_id=7570000000000000002', { kind: 'work', awemeId: '7570000000000000002' }],
  ['https://www.iesdouyin.com/share/video/7570000000000000003/?region=CN', { kind: 'work', awemeId: '7570000000000000003' }],
  ['https://www.douyin.com/collection/7529000000000000001', { kind: 'mix', mixId: '7529000000000000001' }],
  ['https://www.iesdouyin.com/share/mix/detail/7529000000000000002/', { kind: 'mix', mixId: '7529000000000000002' }],
  ['https://v.douyin.com/iRNBho6u/', { kind: 'short', url: 'https://v.douyin.com/iRNBho6u/' }],
  ['http://v.douyin.com/iRNBho6u', { kind: 'short', url: 'https://v.douyin.com/iRNBho6u' }],
  ['https://www.douyin.com/user/self?modal_id=abc', undefined],
  ['https://v.douyin.com/a/b/', undefined],
  ['https://www.douyin.com/discover', undefined],
  ['https://www.example.com/video/7570000000000000001', undefined],
  ['snssdk1128://aweme/detail/7570000000000000001', undefined],
] as const)('recognizes %s', (url, expected) => {
  expect(douyinTarget(new URL(url))).toEqual(expected)
})

it('finds the first recognized Douyin link in pasted share text', () => {
  expect(parseDouyinLink('7.43 复制打开抖音，看看【短剧第1集】 https://v.douyin.com/iRNBho6u/ ZzZ:/ 01/02'))
    .toEqual({ kind: 'short', url: 'https://v.douyin.com/iRNBho6u/' })
  expect(parseDouyinLink('www.douyin.com/discover，然后 www.douyin.com/video/7570000000000000001。')).toEqual({ kind: 'work', awemeId: '7570000000000000001' })
  expect(parseDouyinLink('https://www.douyin.com/video/%zz https://www.douyin.com/collection/7529000000000000001')).toEqual({ kind: 'mix', mixId: '7529000000000000001' })
  expect(parseDouyinLink('https://douyin.com:99999/video/1 没有其他链接')).toBeUndefined()
  expect(parseDouyinLink('没有抖音链接')).toBeUndefined()
})

it('sends only the account token header and exact bodies under the configured prefix', async () => {
  const f = await fixture()
  f.fetcher.mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(Response.json({ queued: [record], existing: [], skipped: 0 }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ queued: [], existing: [{ ...record, mixId: '7529000000000000001', episode: 1 }], skipped: 4 }, { status: 202 }))
    .mockResolvedValueOnce(Response.json([record]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json({ download: record, file: { url: record.url, expiresAt: null } }))
  const values = await f.run(async station => [await station.status(), await station.submit({ kind: 'work', awemeId: record.awemeId }),
    await station.submit({ kind: 'mix', mixId: '7529000000000000001' }), await station.list({ kind: 'work', awemeId: record.awemeId }),
    await station.list({ kind: 'mix', mixId: '7529000000000000001' }), await station.file('r/1')])
  expect(values[0]).toMatchObject({ enabled: true, dailyLimit: 50, usedToday: 3, maxMixEpisodes: 300 })
  expect(values[2]).toMatchObject({ skipped: 4 })
  expect(values[5]).toEqual({ url: record.url, expiresAt: null })
  const sent = f.fetcher.mock.calls.map((_call, index) => request(f.fetcher, index))
  expect(sent.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    { url: `${prefix}/downloads/status`, method: 'GET', body: undefined },
    { url: `${prefix}/downloads`, method: 'POST', body: JSON.stringify({ awemeId: record.awemeId }) },
    { url: `${prefix}/downloads/mix`, method: 'POST', body: JSON.stringify({ mixId: '7529000000000000001' }) },
    { url: `${prefix}/downloads?limit=300&awemeIds=${record.awemeId}`, method: 'GET', body: undefined },
    { url: `${prefix}/downloads?limit=300&mixId=7529000000000000001`, method: 'GET', body: undefined },
    { url: `${prefix}/downloads/r%2F1`, method: 'GET', body: undefined },
  ])
  for (const index of f.fetcher.mock.calls.keys()) {
    const { headers } = request(f.fetcher, index)
    expect(headers.get('x-muse-account-token')).toBe(token)
    expect(headers.has('origin')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect(f.fetcher.mock.calls[index]?.[1]?.redirect).toBe('manual')
  }
  expect(request(f.fetcher, 1).headers.get('content-type')).toBe('application/json')
  expect(request(f.fetcher, 0).headers.has('content-type')).toBe(false)
})

it('uses the global transport when none is injected', async () => {
  const f = await fixture({ globalTransport: true })
  const global = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/share/video/7570000000000000001/' } }))
  await expect(f.run(async station => await station.status())).resolves.toMatchObject({ enabled: true })
  await expect(f.run(async station => (await station.resolve('https://v.douyin.com/a/')).href))
    .resolves.toBe('https://v.douyin.com/share/video/7570000000000000001/')
  expect(global).toHaveBeenCalledTimes(2)
})

it.each([
  [400, 'GET', 'invalid-input'], [401, 'GET', 'sign-in-required'], [403, 'POST', 'team-access-required'],
  [429, 'POST', 'daily-limit'], [503, 'GET', 'station-unavailable'], [404, 'POST', 'unavailable'],
  [500, 'GET', 'unavailable'], [502, 'POST', 'unconfirmed'], [302, 'GET', 'unavailable'],
] as const)('maps HTTP %i on %s to %s without reading the error body', async (code, method, expected) => {
  const f = await fixture()
  const cancel = vi.fn()
  f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: code, headers: { 'content-type': 'application/json' } }))
  await expect(f.run(async station => method === 'GET' ? await station.status() : await station.submit({ kind: 'work', awemeId: '1' })))
    .rejects.toMatchObject({ code: expected })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('rejects replies with no JSON body, the wrong type, oversize, malformed text, echoed tokens or unexpected fields', async () => {
  const f = await fixture({ maxReplyBytes: 1024 })
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }))
  await expect(f.run(async station => await station.status())).rejects.toMatchObject({ code: 'sign-in-required' })
  for (const response of [
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array(1025), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    new Response('{', { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    Response.json({ ...status, echoed: token }),
    Response.json({ ...status, dailyLimit: -1 }),
    Response.json([{ ...record, url: 'http://muse.tos-cn-beijing.volces.com/x.mp4' }]),
    Response.json([{ ...record, url: 'https://user:pass@muse.tos-cn-beijing.volces.com/x.mp4' }]),
    Response.json([{ ...record, url: 'https://:pass@muse.tos-cn-beijing.volces.com/x.mp4' }]),
    Response.json([{ ...record, url: 'not a url' }]),
  ]) {
    f.fetcher.mockResolvedValueOnce(response)
    await expect(f.run(async station => await station.list({ kind: 'work', awemeId: '1' }))).rejects.toMatchObject({ code: 'invalid-response' })
  }
})

it('reports a missing or unreadable login before any request and an account change after a response', async () => {
  const absent = await fixture({}, false)
  await expect(absent.run(async station => await station.status())).rejects.toMatchObject({ code: 'sign-in-required' })
  await writeMuseSession(absent.sessionFile, { baseUrl: 'https://another.test', username: 'alice', cookie })
  await expect(absent.run(async station => await station.status())).rejects.toMatchObject({ code: 'sign-in-required' })
  await writeFile(absent.sessionFile, '[]')
  await expect(absent.run(async station => await station.status())).rejects.toMatchObject({ code: 'unavailable' })
  expect(absent.fetcher).not.toHaveBeenCalled()

  const changed = await fixture()
  changed.fetcher.mockImplementationOnce(async () => {
    await writeMuseSession(changed.sessionFile, { baseUrl: origin, username: 'bob', cookie: '__Host-muse=other' })
    return Response.json(status)
  })
  await expect(changed.run(async station => await station.status())).rejects.toMatchObject({ code: 'account-changed' })
  const broken = await fixture()
  broken.fetcher.mockImplementationOnce(async () => {
    await writeFile(broken.sessionFile, '{')
    return Response.json(status)
  })
  await expect(broken.run(async station => await station.status())).rejects.toMatchObject({ code: 'account-changed' })
  const late = await fixture()
  await expect(late.run(async () => { await writeMuseSession(late.sessionFile, { baseUrl: origin, username: 'bob', cookie }) }))
    .rejects.toMatchObject({ code: 'account-changed' })
})

it('separates read transport failure and timeout from an unconfirmed submission without retrying', async () => {
  const f = await fixture()
  f.fetcher.mockRejectedValueOnce(new Error('private socket error')).mockRejectedValueOnce(new Error('private socket error'))
  await expect(f.run(async station => await station.status())).rejects.toMatchObject({ code: 'unavailable' })
  await expect(f.run(async station => await station.submit({ kind: 'mix', mixId: '1' }))).rejects.toMatchObject({ code: 'unconfirmed' })
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  f.fetcher.mockImplementationOnce(async (_input, init) => {
    deadline.abort(new DOMException('Controlled deadline', 'TimeoutError'))
    init?.signal?.throwIfAborted()
    return Response.json(status)
  })
  await expect(f.run(async station => await station.status())).rejects.toMatchObject({ code: 'timeout' })
  expect(f.fetcher).toHaveBeenCalledTimes(3)
})

it('reads one share-link redirect without a body or account credential', async () => {
  const f = await fixture()
  const cancel = vi.fn()
  f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 302,
    headers: { location: 'https://www.iesdouyin.com/share/video/7570000000000000001/?region=CN' } }))
  const target = await f.run(async station => await station.resolve('https://v.douyin.com/iRNBho6u/'))
  expect(target.href).toBe('https://www.iesdouyin.com/share/video/7570000000000000001/?region=CN')
  expect(cancel).toHaveBeenCalledTimes(1)
  const { url, headers } = request(f.fetcher)
  expect(url).toBe('https://v.douyin.com/iRNBho6u/')
  expect([...headers.keys()]).toEqual([])
  for (const response of [new Response(null, { status: 200 }), new Response(null, { status: 404 }), new Response(null, { status: 302 }),
    new Response(null, { status: 302, headers: { location: 'http://[' } })]) {
    f.fetcher.mockResolvedValueOnce(response)
    await expect(f.run(async station => await station.resolve('https://v.douyin.com/iRNBho6u/'))).rejects.toMatchObject({ code: 'link-unresolved' })
  }
  f.fetcher.mockRejectedValueOnce(new Error('dns failure'))
  await expect(f.run(async station => await station.resolve('https://v.douyin.com/iRNBho6u/'))).rejects.toMatchObject({ code: 'link-unresolved' })
})

it('cancels waits, share-link reads and requests, and disposal settles active operations', async () => {
  const f = await fixture()
  const caller = new AbortController()
  const waiting = f.run(async (station) => { await station.wait(60_000) }, caller.signal)
  caller.abort()
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  const early = new AbortController()
  early.abort()
  await expect(f.run(async station => await station.status(), early.signal)).rejects.toMatchObject({ code: 'cancelled' })
  await expect(f.run(async (station) => { await station.wait(1) })).resolves.toBeUndefined()

  const link = new AbortController()
  f.fetcher.mockImplementationOnce(async () => { link.abort(); throw new Error('aborted transport') })
  await expect(f.run(async station => await station.resolve('https://v.douyin.com/a/'), link.signal)).rejects.toMatchObject({ code: 'cancelled' })
  const read = new AbortController()
  f.fetcher.mockImplementationOnce(async () => { read.abort(); throw new Error('aborted transport') })
  await expect(f.run(async station => await station.status(), read.signal)).rejects.toMatchObject({ code: 'cancelled' })

  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const active = f.run(async (station) => { entered(); await station.wait(60_000) })
  await started
  await f.client.dispose()
  await expect(active).rejects.toMatchObject({ code: 'cancelled' })
})

it('passes through work failures that are not station failures', async () => {
  const f = await fixture()
  await expect(f.run(async () => { throw new Error('tool failure') })).rejects.toThrow('tool failure')
})
