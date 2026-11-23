/** Data-station tools (whole-collection search, 立即转写 requeue): schema, arguments, model-visible results and failures. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { mountMuseDataTools } from '../src/data-tools.ts'
import { MuseDataError, type MuseDataStationClient } from '../src/data-station.ts'
import type { MuseDataWorks } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

type Listed = MuseDataWorks['items'][number]
const listed = (patch: Partial<Listed>): Listed => ({
  id: 'hongguo:7600000000000000001', sourceId: '7600000000000000001', platform: 'hongguo', title: '好一个乖乖女', tags: ['都市', '逆袭'],
  episodeCount: 88, wordCount: null, metrics: [{ key: 'heat', label: '热度', value: 89_580_000 }, { key: 'collection', label: '收藏', value: null }],
  board: '综合热播榜', rank: 3, author: null, observedAt: '2026-11-20T08:00:00.000Z', description: '她回家了。', ...patch,
})

async function fixture(pageSize = 10) {
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const works = vi.fn<MuseDataStationClient['works']>()
  const rush = vi.fn<MuseDataStationClient['rush']>()
  const fiber = ctx.plugin({ inject: ['tools'], apply: (scope: Context) => { mountMuseDataTools(scope, { works, rush }, { pageSize }) } })
  await fiber.await()
  let next = 0
  const run = async (name: string, args: object) => (await executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId(`data-${++next}`), signal: new AbortController().signal })).value
  return { ctx, fiber, works, rush,
    call: async (args: object) => await run('data_station_search', args),
    requeue: async (args: object) => await run('data_station_requeue', args) }
}

it('registers deferred Chinese search and requeue tools, presents their calls and removes them on unload', async () => {
  const f = await fixture(15)
  const [schema] = f.ctx.tools.schemas()
  expect(f.ctx.tools.schemas().map(row => row.name)).toEqual(['data_station_search', 'data_station_requeue'])
  expect(f.ctx.tools.schemas().every(row => row.deferLoading)).toBe(true)
  expect(schema?.deferLoading).toBe(true)
  expect(schema?.description).toContain('全收录')
  expect(schema?.description).toContain('每页 15 部')
  const tool = f.ctx.tools.get('data_station_search')
  expect(tool?.presentCall?.({ query: '乖乖女' })).toEqual({ card: 'generic', title: '乖乖女', kind: 'read' })
  expect(tool?.presentCall?.({ platform: 'fanqie' })).toEqual({ card: 'generic', title: 'fanqie', kind: 'read' })
  expect(tool?.presentCall?.({})).toEqual({ card: 'generic', title: '全收录', kind: 'read' })
  expect(f.ctx.tools.get('data_station_requeue')?.presentCall?.({ id: 'hongguo:1' })).toEqual({ card: 'generic', title: 'hongguo:1', kind: 'execute' })
  await f.fiber.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
})

it('searches one platform or all and reports each work compactly with its ID, metrics and ranking', async () => {
  const f = await fixture()
  f.works.mockResolvedValueOnce({ items: [listed({}), listed({ id: 'fanqie:1', sourceId: '1', platform: 'fanqie', title: null, tags: [], episodeCount: null,
    wordCount: 1_110_841, metrics: [{ key: 'currentReaders', label: '在读', value: 1_806_207 }, { key: 'dup', label: '在读', value: 1 }],
    rank: null, author: '某作者', description: '' })], total: 23, page: 2, limit: 10 })
  expect(await f.call({ query: ' 乖乖女 ', platform: 'hongguo', page: 2 })).toEqual({ state: 'ok', total: 23, page: 2, pages: 3, works: [
    { id: 'hongguo:7600000000000000001', platform: 'hongguo', title: '好一个乖乖女', tags: ['都市', '逆袭'], episodes: 88, metrics: { 热度: 89_580_000 },
      board: '综合热播榜', rank: 3, observedAt: '2026-11-20T08:00:00.000Z', description: '她回家了。' },
    { id: 'fanqie:1', platform: 'fanqie', title: '1', author: '某作者', words: 1_110_841, metrics: { 在读: 1_806_207 }, board: '综合热播榜', observedAt: '2026-11-20T08:00:00.000Z' },
  ] })
  expect(f.works).toHaveBeenLastCalledWith({ platform: 'hongguo', q: '乖乖女', page: 2, limit: 10 })
  f.works.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 10 })
  const empty = await f.call({ query: '  ' })
  expect(empty).toMatchObject({ state: 'ok', total: 0, works: [] })
  expect(JSON.stringify(empty)).toContain('换个关键词')
  expect(f.works).toHaveBeenLastCalledWith({ page: 1, limit: 10 })
})

it('refuses words or pages the station would not accept, without asking it', async () => {
  const f = await fixture()
  for (const args of [{ query: '剧'.repeat(201) }, { page: 0 }, { page: 100_001 }]) {
    const refused = await f.call(args)
    expect(refused, JSON.stringify(args)).toMatchObject({ state: 'error', code: 'invalid-input' })
    expect(JSON.stringify(refused)).toContain('200')
  }
  expect(f.works).not.toHaveBeenCalled()
})

it('turns station failures into fixed codes with guidance', async () => {
  const f = await fixture()
  f.works.mockRejectedValueOnce(new MuseDataError('sign-in-required'))
  const signedOut = await f.call({ query: 'x' })
  expect(signedOut).toMatchObject({ state: 'error', code: 'sign-in-required' })
  expect(JSON.stringify(signedOut)).toContain('登录 Muse')
  f.works.mockRejectedValueOnce(new z.ZodError([]))
  expect(await f.call({ query: 'x' })).toMatchObject({ state: 'error', code: 'invalid-response' })
  f.works.mockRejectedValueOnce(new Error('socket closed'))
  expect(await f.call({ query: 'x' })).toMatchObject({ state: 'error', code: 'unavailable' })
})

it('requeues one Hongguo drama by its station ID and reports the queued job', async () => {
  const f = await fixture()
  f.rush.mockResolvedValueOnce({ workId: 'hongguo:7550544718799588376', state: 'queued', lane: 'new' })
  expect(await f.requeue({ id: ' hongguo:7550544718799588376 ' })).toEqual({ state: 'ok', id: 'hongguo:7550544718799588376', jobState: 'queued', lane: 'new' })
  expect(f.rush).toHaveBeenLastCalledWith('hongguo:7550544718799588376')
  for (const id of ['7550544718799588376', 'fanqie:1', 'hongguo:x']) {
    expect(await f.requeue({ id }), id).toMatchObject({ state: 'error', code: 'invalid-input' })
  }
  expect(f.rush).toHaveBeenCalledTimes(1)
})

it('tells the model when a drama cannot be requeued or the outcome is unknown', async () => {
  const f = await fixture()
  f.rush.mockRejectedValueOnce(new MuseDataError('not-requeueable'))
  const busy = await f.requeue({ id: 'hongguo:1' })
  expect(busy).toMatchObject({ state: 'error', code: 'not-requeueable' })
  expect(JSON.stringify(busy)).toContain('转写进度在数据站的储备看板里')
  f.rush.mockRejectedValueOnce(new MuseDataError('unconfirmed'))
  expect(await f.requeue({ id: 'hongguo:1' })).toMatchObject({ state: 'error', code: 'unconfirmed' })
})
