/** Data-station Douyin tool schema, target selection, bounded waiting and model-visible states. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { mountMuseDouyinTools } from '../src/douyin-tools.ts'
import { MuseDouyinError } from '../src/douyin-station.ts'
import type { MuseDouyinRecord, MuseDouyinStation, MuseDouyinStationClient } from '../src/douyin-station.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

const aweme = '7570000000000000001'
const mix = '7529000000000000001'
const publicUrl = (id: string) => `https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115/${mix}/video/${id}.mp4`
const item = (patch: Partial<MuseDouyinRecord>): MuseDouyinRecord => ({ id: 'r1', awemeId: aweme, state: 'done', ...patch })

async function fixture(options = { maxWaitSeconds: 60, pollIntervalMs: 5_000 }) {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const station = {
    status: vi.fn<MuseDouyinStation['status']>(), submit: vi.fn<MuseDouyinStation['submit']>(), list: vi.fn<MuseDouyinStation['list']>(),
    file: vi.fn<MuseDouyinStation['file']>(), resolve: vi.fn<MuseDouyinStation['resolve']>(),
    wait: vi.fn<MuseDouyinStation['wait']>().mockResolvedValue(undefined),
  }
  const signals: AbortSignal[] = []
  let failure: unknown
  const client: Pick<MuseDouyinStationClient, 'run'> = {
    run: async (signal, work) => {
      signals.push(signal)
      if (failure !== undefined) throw failure
      return await work(station)
    },
  }
  const fiber = ctx.plugin({ inject: ['tools'], apply: (scope: Context) => { mountMuseDouyinTools(scope, client, options) } })
  await fiber.await()
  let next = 0
  return { ctx, fiber, station, signals, fail: (error: unknown) => { failure = error },
    call: async (args: object, signal = new AbortController().signal) => (await executeToolFixture(ctx, {
      name: 'douyin_download', arguments: args, callId: ToolCallId(`douyin-${++next}`), signal })).value }
}

it('registers one deferred Chinese tool with its configured bounds and removes it on unload', async () => {
  const f = await fixture({ maxWaitSeconds: 45, pollIntervalMs: 3_000 })
  const [schema] = f.ctx.tools.schemas()
  expect(f.ctx.tools.schemas().map(row => row.name)).toEqual(['douyin_download'])
  expect(schema?.deferLoading).toBe(true)
  expect(schema?.description).toContain('Muse 唯一的抖音视频下载方式')
  expect(schema?.description).toContain('wait_seconds（0–45）')
  expect(schema?.description).toContain('约每 3 秒')
  expect(JSON.stringify(schema?.parameters)).toContain('0–45')
  await f.fiber.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
})

it('presents submissions as execution and queries as reads', async () => {
  const { ctx } = await fixture()
  const tool = ctx.tools.get('douyin_download')
  expect(tool?.presentCall?.({ action: 'download', url: 'https://v.douyin.com/a/' }))
    .toEqual({ card: 'generic', title: 'https://v.douyin.com/a/', kind: 'execute' })
  expect(tool?.presentCall?.({ action: 'query', aweme_id: aweme })).toEqual({ card: 'generic', title: aweme, kind: 'read' })
  expect(tool?.presentCall?.({ action: 'download', mix_id: mix })).toEqual({ card: 'generic', title: mix, kind: 'execute' })
  expect(tool?.presentCall?.({ action: 'quota' })).toEqual({ card: 'generic', title: 'quota', kind: 'read' })
})

it('reports the shared daily allowance and a disabled station without submitting', async () => {
  const f = await fixture(), signal = new AbortController().signal
  f.station.status.mockResolvedValueOnce({ enabled: true, dailyLimit: 50, usedToday: 3, unlimited: false, maxMixEpisodes: 300 })
    .mockResolvedValueOnce({ enabled: false, reason: 'TOS 未配置', dailyLimit: 0, usedToday: 0, maxMixEpisodes: 0 })
  const enabled = await f.call({ action: 'quota' }, signal)
  expect(enabled).toMatchObject({ state: 'ok', dailyLimit: 50, usedToday: 3 })
  expect(JSON.stringify(enabled)).toContain('网页和 Muse 共用')
  const disabled = await f.call({ action: 'quota' })
  expect(disabled).toMatchObject({ state: 'ok', enabled: false, reason: 'TOS 未配置' })
  expect(JSON.stringify(disabled)).toContain('未开放')
  expect(f.signals[0]).toBe(signal)
  expect(f.station.submit).not.toHaveBeenCalled()
})

it('tells the model that an unlimited account is not bound by the daily allowance', async () => {
  const f = await fixture()
  f.station.status.mockResolvedValueOnce({ enabled: true, dailyLimit: 50, usedToday: 0, unlimited: true, maxMixEpisodes: 300 })
  const result = await f.call({ action: 'quota' })
  expect(result).toMatchObject({ state: 'ok', enabled: true, unlimited: true })
  expect(JSON.stringify(result)).toContain('不受每日额度限制')
  expect(JSON.stringify(result)).not.toContain('不能再提交')
})

it('submits a work from share text and returns its public address without waiting', async () => {
  const f = await fixture()
  f.station.submit.mockResolvedValue({ queued: [item({ state: 'queued', url: null })], existing: [], skipped: 0 })
  f.station.list.mockResolvedValue([item({ title: '第1集', url: publicUrl(aweme) })])
  const result = await f.call({ action: 'download', url: `7.43 复制打开抖音 https://www.douyin.com/video/${aweme} 看看` })
  expect(f.station.submit).toHaveBeenCalledExactlyOnceWith({ kind: 'work', awemeId: aweme })
  expect(f.station.list).toHaveBeenCalledExactlyOnceWith({ kind: 'work', awemeId: aweme })
  expect(f.station.wait).not.toHaveBeenCalled()
  expect(f.station.file).not.toHaveBeenCalled()
  expect(result).toMatchObject({ state: 'done', action: 'download', target: { awemeId: aweme }, title: '第1集',
    submitted: { queued: 1, existing: 0, skipped: 0 }, counts: { total: 1, done: 1, preparing: 0, failed: 0 } })
  expect(JSON.stringify(result)).toContain('不是本地文件')
  expect(JSON.stringify(result)).toContain(JSON.stringify([{ awemeId: aweme, state: 'done', url: publicUrl(aweme) }]))
})

it('resolves one share-link redirect and refuses a redirect that names no work', async () => {
  const f = await fixture()
  f.station.resolve.mockResolvedValueOnce(new URL(`https://www.iesdouyin.com/share/video/${aweme}/`))
    .mockResolvedValueOnce(new URL('https://www.example.com/'))
    .mockResolvedValueOnce(new URL('https://v.douyin.com/again/'))
  f.station.list.mockResolvedValue([])
  const missing = await f.call({ action: 'query', url: 'https://v.douyin.com/iRNBho6u/' })
  expect(missing).toMatchObject({ state: 'not_found', target: { awemeId: aweme } })
  expect(JSON.stringify(missing)).toContain('action=download')
  expect(f.station.submit).not.toHaveBeenCalled()
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await f.call({ action: 'download', url: 'https://v.douyin.com/iRNBho6u/' })).toMatchObject({ state: 'error', code: 'link-unresolved' })
  }
  expect(f.station.resolve).toHaveBeenCalledWith('https://v.douyin.com/iRNBho6u/')
  expect(f.station.submit).not.toHaveBeenCalled()
})

it('waits for a series in bounded polls, orders episodes and reads private file links', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  f.station.wait.mockImplementation(async (ms) => { vi.setSystemTime(Date.now() + ms) })
  f.station.submit.mockResolvedValue({ queued: [], existing: [], skipped: 2 })
  const settled = [
    item({ id: 'r3', awemeId: '3', episode: 3, state: 'failed', error: '抖音没有返回可下载的视频地址' }),
    item({ id: 'r1', awemeId: '1', episode: 1, url: null, mixName: '合集名' }),
    item({ id: 'r2', awemeId: '2', episode: 2, url: publicUrl('2') }),
    item({ id: 'r9', awemeId: '9', state: 'failed', error: null }),
  ]
  f.station.list.mockResolvedValueOnce([item({ id: 'r1', awemeId: '1', episode: 1, state: 'downloading', url: null })]).mockResolvedValueOnce(settled)
  f.station.file.mockResolvedValue({ url: 'https://muse.tos-cn-beijing.volces.com/signed/1.mp4', expiresAt: '2026-11-15T01:00:00.000Z' })
  const result = await f.call({ action: 'download', mix_id: mix, wait_seconds: 30 })
  expect(f.station.wait).toHaveBeenCalledExactlyOnceWith(5_000)
  expect(f.station.file).toHaveBeenCalledExactlyOnceWith('r1')
  expect(result).toMatchObject({ state: 'partial', action: 'download', target: { mixId: mix }, mixName: '合集名',
    submitted: { queued: 0, existing: 0, skipped: 2 }, counts: { total: 4, done: 2, preparing: 0, failed: 2 } })
  expect(JSON.stringify(result)).toContain(JSON.stringify([
    { awemeId: '1', episode: 1, state: 'done', url: 'https://muse.tos-cn-beijing.volces.com/signed/1.mp4', expiresAt: '2026-11-15T01:00:00.000Z' },
    { awemeId: '2', episode: 2, state: 'done', url: publicUrl('2') },
    { awemeId: '3', episode: 3, state: 'failed', error: '抖音没有返回可下载的视频地址' },
    { awemeId: '9', state: 'failed' },
  ]))
  expect(JSON.stringify(result)).toMatch(/部分作品失败.*另有 2 集因今日额度不足未排队/u)
})

it('stops waiting at the requested deadline and reports unfinished preparation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  f.station.wait.mockImplementation(async (ms) => { vi.setSystemTime(Date.now() + ms) })
  f.station.list.mockResolvedValue([item({ state: 'queued', url: null }), item({ id: 'r2', awemeId: '2', state: 'uploading', url: null })])
  f.station.file.mockResolvedValue(null)
  const result = await f.call({ action: 'query', aweme_id: aweme, wait_seconds: 12 })
  expect(f.station.wait.mock.calls).toEqual([[5_000], [5_000], [2_000]])
  expect(f.station.list).toHaveBeenCalledTimes(4)
  expect(result).toMatchObject({ state: 'preparing', counts: { total: 2, done: 0, preparing: 2, failed: 0 } })
  expect(JSON.stringify(result)).toContain('不要重复提交')
  expect(result).not.toHaveProperty('submitted')
  expect(result).not.toHaveProperty('title')
})

it.each([
  { records: [item({ state: 'failed', error: 'x' })], link: null, state: 'failed', work: { awemeId: aweme, state: 'failed', error: 'x' } },
  { records: [item({ url: null })], link: { url: publicUrl(aweme), expiresAt: null }, state: 'done',
    work: { awemeId: aweme, state: 'done', url: publicUrl(aweme) } },
  { records: [item({ url: null })], link: null, state: 'done', work: { awemeId: aweme, state: 'done' } },
] as const)('summarizes a series as $state without inventing an address', async ({ records, link, state, work }) => {
  const f = await fixture()
  f.station.list.mockResolvedValue([...records])
  f.station.file.mockResolvedValue(link)
  const result = await f.call({ action: 'query', mix_id: mix })
  expect(result).toMatchObject({ state, target: { mixId: mix } })
  expect(JSON.stringify(result)).toContain(`"works":${JSON.stringify([work])}`)
  expect(result).not.toHaveProperty('mixName')
})

it.each([
  { action: 'download' },
  { action: 'download', url: `https://www.douyin.com/video/${aweme}`, aweme_id: aweme },
  { action: 'query', aweme_id: 'abc' },
  { action: 'query', mix_id: '' },
  { action: 'download', aweme_id: aweme, wait_seconds: 61 },
  { action: 'download', aweme_id: aweme, wait_seconds: -1 },
])('rejects an ambiguous or invalid target before the station: %j', async (args) => {
  const f = await fixture()
  const result = await f.call(args)
  expect(result).toMatchObject({ state: 'error', code: 'invalid-input' })
  expect(JSON.stringify(result)).toContain('只提供一个下载目标')
  expect(f.signals).toEqual([])
})

it('rejects an unrecognized link before the station and reports station failures with fixed guidance', async () => {
  const f = await fixture()
  expect(await f.call({ action: 'download', url: 'https://www.douyin.com/discover' })).toMatchObject({ state: 'error', code: 'link-unresolved' })
  expect(f.signals).toEqual([])
  f.fail(new MuseDouyinError('daily-limit'))
  const limited = await f.call({ action: 'download', aweme_id: aweme })
  expect(limited).toMatchObject({ state: 'error', code: 'daily-limit' })
  expect(JSON.stringify(limited)).toContain('网页和 Muse 共用同一额度')
  f.fail(new Error('private station body'))
  const result = await f.call({ action: 'quota' })
  expect(result).toMatchObject({ state: 'error', code: 'unavailable' })
  expect(JSON.stringify(result)).not.toContain('private station body')
})
