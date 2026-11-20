/** Account-token data-station reads and 立即转写 for the 数据 drawer tab. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MuseDataError, MuseDataStationClient, museDataFailure } from '../src/data-station.ts'
import type { MuseDataStationOptions } from '../src/data-station.ts'
import { writeMuseSession } from '../src/session.ts'

const origin = 'https://muse.test'
const token = 'T'.repeat(43)
const prefix = `${origin}/data/api/muse-client/data`
const directories: string[] = []
const work = { id: 'hongguo:7600000000000000001', sourceId: '7600000000000000001', platform: 'hongguo', title: '好一个乖乖女', tags: ['都市'],
  episodeCount: 88, wordCount: null, metrics: [{ key: 'heat', label: '热度', value: 89_580_000 }], description: 'dropped by the client' }
const job = { workId: work.id, state: 'transcribing', lane: 'new', requestedBy: null, progress: { episode: 19, totalEpisodes: 88 }, lastError: null }
const stock = {
  summary: { stock: 0, queued: 148, active: 1, failures: 0, rejected: 1, candidates: 149, addedToday: 0 },
  items: [{ work: { id: work.id, sourceId: work.sourceId, title: work.title, tags: [], episodeCount: 88 },
    evaluation: { collection: { value: 18_951_000 }, douyin: { viewCount: 3_366_872_375 } }, job, script: null }],
  total: 150, page: 1, limit: 50,
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

type Reply = (url: string, init?: RequestInit) => Response | Promise<Response>
const urlOf = (input: RequestInfo | URL | undefined) =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
const abortError = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new Error('aborted')

async function fixture(reply: Reply, overrides: Partial<MuseDataStationOptions> = {}, signedIn = true) {
  const directory = await mkdtemp(join(tmpdir(), 'muse-data-station-'))
  directories.push(directory)
  const sessionFile = join(directory, 'session.json')
  if (signedIn) await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie: `__Host-muse=${token}` })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => await reply(urlOf(input), init))
  const client = new MuseDataStationClient({ baseUrl: origin, sessionFile, path: '/data/api/muse-client/data', requestTimeoutMs: 60_000,
    maxReplyBytes: 65_536, fetcher, ...overrides })
  return { client, fetcher, sessionFile }
}

function sent(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [input, init] = fetcher.mock.calls[index] ?? []
  return { url: urlOf(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body }
}

it('reads rankings, a ranking period, the stock board and the collector with the member token and no Origin', async () => {
  const { client, fetcher } = await fixture((url) => {
    if (url.includes('/boards/period')) return Response.json({ platform: 'hongguo', board: '综合热播榜', period: 'week', date: '2026-11-20', items: [{ position: 1, work }], days: [] })
    if (url.includes('/boards')) return Response.json({ boards: ['综合热播榜'], defaultBoard: '综合热播榜' })
    if (url.includes('/hits/board')) return Response.json(stock)
    return Response.json({ state: 'never-connected', label: '等待采集端接入', message: '采集端还没有连上数据站', needsHuman: false })
  })
  expect(await client.boards('hongguo')).toEqual({ boards: ['综合热播榜'], defaultBoard: '综合热播榜' })
  const period = await client.period({ platform: 'hongguo', board: '综合热播榜', period: 'week' })
  const { description: _description, ...parsed } = work
  expect(period.items[0]?.work).toEqual(parsed)
  await client.period({ platform: 'fanqie', board: '男频 · 阅读榜 · 都市脑洞', period: 'day', date: '2026-11-19' })
  expect((await client.stock({ filter: 'all', q: ' 乖乖女 ', page: 1, limit: 50 })).items[0]?.job?.progress).toEqual({ episode: 19, totalEpisodes: 88 })
  await client.stock({ filter: 'active', q: '  ', page: 2, limit: 10 })
  await client.stock({ filter: 'queued', page: 1, limit: 10 })
  expect(await client.collector()).toEqual({ state: 'never-connected', label: '等待采集端接入', message: '采集端还没有连上数据站' })
  const urls = fetcher.mock.calls.map((_call, index) => sent(fetcher, index).url)
  expect(urls).toEqual([
    `${prefix}/boards?platform=hongguo`,
    `${prefix}/boards/period?platform=hongguo&board=${encodeURIComponent('综合热播榜')}&period=week`,
    `${prefix}/boards/period?platform=fanqie&board=${new URLSearchParams({ b: '男频 · 阅读榜 · 都市脑洞' }).toString().slice(2)}&period=day&date=2026-11-19`,
    `${prefix}/hits/board?filter=all&page=1&limit=50&q=${encodeURIComponent('乖乖女')}`,
    `${prefix}/hits/board?filter=active&page=2&limit=10`,
    `${prefix}/hits/board?filter=queued&page=1&limit=10`,
    `${prefix}/lvpaopao/status`,
  ])
  const first = sent(fetcher)
  expect(first.method).toBe('GET')
  expect(first.headers.get('x-muse-account-token')).toBe(token)
  expect(first.headers.get('origin')).toBeNull()
  expect(first.headers.get('content-type')).toBeNull()
})

it('queues 立即转写 for a Hongguo work only, as a JSON POST', async () => {
  const { client, fetcher } = await fixture(() => Response.json({ workId: work.id, state: 'queued', lane: 'manual', requestedBy: 'alice' }))
  expect(await client.rush(work.id)).toEqual({ workId: work.id, state: 'queued', lane: 'manual' })
  const posted = sent(fetcher)
  expect(posted.url).toBe(`${prefix}/hits/${encodeURIComponent(work.id)}/rush`)
  expect(posted.method).toBe('POST')
  expect(posted.body).toBe('{}')
  expect(posted.headers.get('content-type')).toBe('application/json')
  await expect(client.rush('fanqie:1')).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(client.rush('hongguo:../admin')).rejects.toMatchObject({ code: 'invalid-input' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('reads one work for a finalized script\'s source card, refusing anything but a station work ID', async () => {
  const { client, fetcher } = await fixture(() => Response.json({ work: { ...work, board: '综合热播榜', rank: 3, author: null, observedAt: '2026-11-20T08:00:00.000Z', script: null } }))
  const { description: _description, ...parsed } = work
  expect(await client.work('fanqie:7300000000000000001')).toEqual({ ...parsed, board: '综合热播榜', rank: 3, author: null, observedAt: '2026-11-20T08:00:00.000Z' })
  expect(sent(fetcher).url).toBe(`${prefix}/works/${encodeURIComponent('fanqie:7300000000000000001')}`)
  await expect(client.work('fanqie:../admin')).rejects.toMatchObject({ code: 'invalid-input' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('searches the whole collection on one platform or all, newest first, cutting long descriptions', async () => {
  const listed = { ...work, board: '综合热播榜', rank: 3, author: '某作者', observedAt: '2026-11-20T08:00:00.000Z', script: null, description: '简'.repeat(400) }
  const reply = { items: [listed], total: 1, page: 1, limit: 20, categories: [], boards: [] }
  const { client, fetcher } = await fixture(() => Response.json(reply))
  const found = await client.works({ platform: 'hongguo', q: ' 乖乖女 ', page: 1, limit: 20 })
  const { description: _description, ...parsed } = work
  expect(found).toEqual({ items: [{ ...parsed, board: '综合热播榜', rank: 3, author: '某作者', observedAt: '2026-11-20T08:00:00.000Z', description: '简'.repeat(300) }], total: 1, page: 1, limit: 20 })
  await client.works({ q: '  ', page: 2, limit: 10 })
  await client.works({ platform: 'qimao', page: 1, limit: 5 })
  expect(sent(fetcher, 0).url).toBe(`${prefix}/works?origin=live&sort=recent&page=1&limit=20&platform=hongguo&q=${encodeURIComponent('乖乖女')}`)
  expect(sent(fetcher, 1).url).toBe(`${prefix}/works?origin=live&sort=recent&page=2&limit=10`)
  expect(sent(fetcher, 2).url).toBe(`${prefix}/works?origin=live&sort=recent&page=1&limit=5&platform=qimao`)
})

it.each([
  [400, false, 'invalid-input'], [401, false, 'sign-in-required'], [403, false, 'team-access-required'], [503, false, 'station-unavailable'],
  [500, false, 'unavailable'], [404, false, 'unavailable'], [500, true, 'unconfirmed'], [404, true, 'unavailable'], [409, true, 'not-requeueable'],
] as const)('maps HTTP %i (write %s) to %s', async (status, write, code) => {
  const { client } = await fixture(() => Response.json({ error: 'station text' }, { status }))
  const call = write ? client.rush(work.id) : client.collector()
  await expect(call).rejects.toMatchObject({ code })
})

it('needs a saved login and a readable session file', async () => {
  const signedOut = await fixture(() => Response.json({}), {}, false)
  await expect(signedOut.client.collector()).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(signedOut.fetcher).not.toHaveBeenCalled()
  const broken = await fixture(() => Response.json({}))
  await writeFile(broken.sessionFile, '{')
  await expect(broken.client.collector()).rejects.toMatchObject({ code: 'unavailable' })
})

it('rejects replies that are not JSON, too large, not UTF-8, echo the token or fail the schema', async () => {
  const cases: [() => Response, MuseDataError['code'], Partial<MuseDataStationOptions>?][] = [
    [() => new Response('<html>', { headers: { 'content-type': 'text/html' } }), 'invalid-response'],
    [() => new Response('{not json', { headers: { 'content-type': 'application/json' } }), 'invalid-response'],
    [() => Response.json({ state: 'x', label: 'y'.repeat(200), message: '' }), 'invalid-response', { maxReplyBytes: 64 }],
    [() => new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'content-type': 'application/json' } }), 'invalid-response'],
    [() => Response.json({ state: token, label: '', message: '' }), 'invalid-response'],
    [() => new Response(null, { headers: { 'content-type': 'application/json' } }), 'invalid-response'],
  ]
  for (const [reply, code, overrides] of cases) {
    const { client } = await fixture(reply, overrides)
    await expect(client.collector()).rejects.toMatchObject({ code })
  }
  const { client } = await fixture(() => Response.json({ boards: 'not a list', defaultBoard: null }))
  await expect(client.boards('qimao')).rejects.toBeInstanceOf(z.ZodError)
})

it('reports a lost connection as unavailable, or unconfirmed for 立即转写', async () => {
  const offline = await fixture(() => { throw new TypeError('fetch failed') })
  await expect(offline.client.collector()).rejects.toMatchObject({ code: 'unavailable' })
  await expect(offline.client.rush(work.id)).rejects.toMatchObject({ code: 'unconfirmed' })
})

const hang = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  if (signal?.aborted) reject(abortError(signal))
  signal?.addEventListener('abort', () => { reject(abortError(signal)) })
})

it('reports a reply that does not come in time as a timeout', async () => {
  const slow = await fixture(hang, { requestTimeoutMs: 20 })
  await expect(slow.client.collector()).rejects.toMatchObject({ code: 'timeout' })
})

it('stops requests still running when disposed', async () => {
  const stopped = await fixture(hang)
  const pending = stopped.client.collector()
  await vi.waitFor(() => { expect(stopped.fetcher).toHaveBeenCalled() })
  stopped.client.dispose()
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
})

it('uses the global fetch when no transport is injected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-data-station-'))
  directories.push(directory)
  const sessionFile = join(directory, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: origin, username: 'alice', cookie: `__Host-muse=${token}` })
  const global = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ state: 'online', label: '已连接', message: '' }))
  const client = new MuseDataStationClient({ baseUrl: origin, sessionFile, path: '/data/api/muse-client/data', requestTimeoutMs: 60_000, maxReplyBytes: 65_536 })
  expect((await client.collector()).label).toBe('已连接')
  expect(urlOf(global.mock.calls[0]?.[0])).toBe(`${prefix}/lvpaopao/status`)
})

it('names any failure with a fixed code', () => {
  const coded = new MuseDataError('timeout')
  expect(museDataFailure(coded)).toBe(coded)
  expect(museDataFailure(new z.ZodError([])).code).toBe('invalid-response')
  expect(museDataFailure(new Error('other')).code).toBe('unavailable')
  expect(coded.message).toBe('Muse data station: timeout')
})
