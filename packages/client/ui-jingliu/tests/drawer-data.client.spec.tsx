// @vitest-environment jsdom
/** The data tab of the Bot team's details drawer: platforms, the whole collection, rankings, the Hongguo stock and 立即转写. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { DrawerData, type DrawerDataProps } from '../src/client/DrawerData.tsx'
import { en } from '../src/client/locales.ts'

type Extra = { tags?: string[]; wordCount?: number | null }
const work = (id: string, title: string | null, metrics: Record<string, number | null>, extra: Extra = {}) => ({
  id, sourceId: id.split(':')[1] ?? id, platform: id.split(':')[0], title, tags: extra.tags ?? ['Urban', 'Family'], episodeCount: 80, wordCount: extra.wordCount ?? null,
  metrics: Object.entries(metrics).map(([key, value]) => ({ key, label: key, value })),
})
const boards: Record<string, { boards: string[]; defaultBoard: string | null }> = {
  hongguo: { boards: ['综合热播榜', '综合新剧榜'], defaultBoard: '综合热播榜' },
  fanqie: { boards: ['男频 · 阅读榜 · 都市脑洞', '男频 · 阅读榜 · 传统玄幻', '男频 · 新书榜 · 都市脑洞', '女频 · 阅读榜 · 宫斗宅斗'], defaultBoard: '男频 · 阅读榜 · 都市脑洞' },
  qimao: { boards: ['男生榜 · 大热榜 · 日榜', '男生榜 · 更新榜'], defaultBoard: null },
  empty: { boards: [], defaultBoard: null },
  douyin: { boards: ['公开短剧作品监测（视频粒度，非榜单）'], defaultBoard: '公开短剧作品监测（视频粒度，非榜单）' },
  lvpaopao: { boards: [], defaultBoard: null },
}
const items = {
  hongguo: [{ position: 1, work: work('hongguo:1', 'Spoiled Daughter', { heat: 89_580_000, collection: 1_427_000 }) },
    { position: 2, work: work('hongguo:2', null, { heat: null }) }],
  fanqie: [{ position: 1, work: work('fanqie:1', 'Handed to the State', { currentReaders: 1_806_207 }, { wordCount: 1_110_841 }) },
    { position: 2, work: work('fanqie:2', 'Unknown Length', { currentReaders: 5 }) }],
  douyin: [{ position: null, work: work('douyin:1', 'Office Swap', { video_plays: 12_954_957, video_likes: 102_743 }) }],
  qimao: [],
}
/** A work as the whole collection (全收录) lists it. */
type Listing = Extra & { episodeCount?: number | null }
const listed = (id: string, title: string | null, metrics: Record<string, number | null>, extra: Listing = {}) => ({
  ...work(id, title, metrics, extra), episodeCount: extra.episodeCount === undefined ? 80 : extra.episodeCount,
  board: '综合热播榜', rank: 1, author: null, observedAt: '2026-11-20T08:00:00.000Z', description: 'A daughter returns.',
})
const collected: Record<string, ReturnType<typeof listed>[]> = {
  hongguo: [listed('hongguo:1', 'Spoiled Daughter', { heat: 89_580_000, collection: 1_427_000 }), listed('hongguo:3', null, {}, { tags: [], episodeCount: null })],
  fanqie: [listed('fanqie:1', 'Handed to the State', { currentReaders: 1_806_207 }, { wordCount: 1_110_841 })],
  lvpaopao: [],
}
const job = (state: string, lane: string, progress: { episode: number; totalEpisodes: number } | null = null) => ({ workId: 'x', state, lane, requestedBy: null, progress })
const stockItems = [
  { work: { id: 'hongguo:11', sourceId: '11', title: 'Good Girl', tags: [], episodeCount: 88 }, evaluation: { collection: { value: 18_951_000 }, douyin: { viewCount: 3_366_872_375 } },
    job: job('transcribing', 'new', { episode: 19, totalEpisodes: 88 }), script: null },
  { work: { id: 'hongguo:12', sourceId: '12', title: 'Home', tags: [], episodeCount: null }, evaluation: null, job: job('queued', 'new', { episode: 7, totalEpisodes: 79 }), script: null },
  { work: { id: 'hongguo:13', sourceId: '13', title: null, tags: [], episodeCount: 60 }, evaluation: { collection: null }, job: job('queued', 'manual'), script: null },
  { work: { id: 'hongguo:14', sourceId: '14', title: 'Fresh', tags: [], episodeCount: null }, evaluation: { douyin: null }, job: null, script: null },
  { work: { id: 'hongguo:15', sourceId: '15', title: 'Done', tags: [], episodeCount: 30 }, evaluation: null, job: job('published', 'backlog', { episode: 0, totalEpisodes: 0 }), script: { id: 's', fileName: 'Done.docx' } },
  { work: { id: 'hongguo:16', sourceId: '16', title: 'Stuck', tags: [], episodeCount: 40 }, evaluation: null, job: job('needs-attention', 'new'), script: null },
]

type Status = 'live' | 'failed' | 'pending'
/** A board name as the resource address writes it. */
const param = (value: string) => new URLSearchParams({ v: value }).toString().slice(2)

afterEach(cleanup)

/** Open the Rankings view of a rendered platform. */
function rankings<View extends ReturnType<typeof render>>(view: View): View {
  fireEvent.click(view.getByRole('button', { name: 'Rankings' }))
  return view
}

type Options = { platform?: string | null; fail?: string[]; pending?: string[]; total?: number; active?: number; found?: number }
function setup(options: Options = {}) {
  const reads: string[] = []
  const useResource = ((address: string) => {
    reads.push(address)
    if (!address.startsWith('dsh-resource://')) return { status: 'none', failure: undefined, value: undefined }
    const url = new URL(address)
    const kind = url.host
    const status: Status = options.fail?.includes(kind) ? 'failed' : options.pending?.includes(kind) ? 'pending' : 'live'
    if (status !== 'live') return { status, failure: undefined, value: undefined }
    const platform = url.searchParams.get('platform') ?? ''
    if (kind === 'muse-data-boards') return { status, value: boards[platform] }
    if (kind === 'muse-data-period') return { status, value: { platform, board: url.searchParams.get('board'), period: url.searchParams.get('period'), date: '2026-11-20', items: items[platform as keyof typeof items] ?? [] } }
    if (kind === 'muse-data-works') {
      const found = collected[platform] ?? []
      return { status, value: { items: found, total: options.found ?? found.length, page: Number(url.searchParams.get('page')), limit: 20 } }
    }
    if (kind === 'muse-data-collector') return { status, value: { state: 'never-connected', label: 'Waiting for the collector', message: 'Install the collector to start' } }
    const filter = url.searchParams.get('filter')
    return { status, value: { summary: { stock: 1, queued: 148, active: options.active ?? 1, failures: 1, rejected: 1, candidates: 149 },
      items: filter === 'rejected' ? [] : stockItems, total: options.total ?? 6, page: Number(url.searchParams.get('page')), limit: 50 } }
  }) as DrawerDataProps['useResource']
  const props: DrawerDataProps = {
    t: makeTranslate(en), useResource, useAccountEpoch: select => select(1), platform: options.platform ?? null,
    openPlatform: vi.fn(), quote: vi.fn(), rush: vi.fn(async () => undefined),
  }
  return { props, reads }
}

it('lists the five platforms with their rankings, stock and collector, and opens one', () => {
  const { props } = setup()
  const view = render(<DrawerData {...props} />)
  const rows = [...view.getByRole('region', { name: en.dataPlatforms }).querySelectorAll('button')].map(button => button.textContent)
  expect(rows).toEqual(['HHongguo dramas2 rankings · 149 in stock', 'DDouyinPublic short-drama videos', 'LLvpaopao dramasWaiting for the collector',
    'FFanqie novels4 rankings', 'QQimao novels2 rankings'])
  expect(view.getByRole('img', { name: en.stageTranscribing })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: /Fanqie novels/u }))
  expect(props.openPlatform).toHaveBeenCalledWith({ id: 'fanqie', title: 'Fanqie novels' })
  view.unmount()
})

it('leaves out the counts it could not read and the live dot while nothing transcribes', () => {
  const { props } = setup({ pending: ['muse-data-boards', 'muse-data-stock', 'muse-data-collector'], active: 0 })
  const view = render(<DrawerData {...props} />)
  const rows = [...view.getByRole('region', { name: en.dataPlatforms }).querySelectorAll('button')].map(button => button.textContent)
  expect(rows).toEqual(['HHongguo dramas', 'DDouyinPublic short-drama videos', 'LLvpaopao dramas', 'FFanqie novels', 'QQimao novels'])
  expect(view.queryByRole('img', { name: en.stageTranscribing })).toBeNull()
  view.unmount()
})

it('shows a Hongguo ranking with its own metrics, quotes a work and queues 转写', async () => {
  const { props, reads } = setup({ platform: 'hongguo' })
  const view = rankings(render(<DrawerData {...props} />))
  const table = view.getByRole('table', { name: '综合热播榜' })
  expect(table.textContent).toContain('Spoiled Daughter')
  expect(table.textContent).toContain('89.6M')
  expect(table.textContent).toContain('1.4M')
  expect(table.textContent).toContain('hongguo:2'.split(':')[1])
  fireEvent.click(view.getByRole('button', { name: 'Quote Spoiled Daughter in the chat' }))
  expect(props.quote).toHaveBeenCalledWith('Spoiled Daughter (#1 on Hongguo dramas 综合热播榜)')
  fireEvent.click(view.getByRole('button', { name: '综合新剧榜' }))
  fireEvent.click(view.getByRole('button', { name: 'Day' }))
  expect(reads.some(address => address.includes('muse-data-period') && address.includes('period=day') && address.includes(encodeURIComponent('综合新剧榜')))).toBe(true)
  const [transcribe] = view.getAllByRole('button', { name: 'Transcribe' })
  await act(async () => { fireEvent.click(transcribe!) })
  expect(props.rush).toHaveBeenCalledWith('hongguo:1')
  expect(view.getByText('Queued')).toBeTruthy()
  view.unmount()
})

it('offers a retry when 转写 could not be queued', async () => {
  const { props } = setup({ platform: 'hongguo' })
  props.rush = vi.fn(async () => { throw new Error('refused') })
  const view = rankings(render(<DrawerData {...props} />))
  const [transcribe] = view.getAllByRole('button', { name: 'Transcribe' })
  await act(async () => { fireEvent.click(transcribe!) })
  await waitFor(() => { expect(view.getByRole('button', { name: 'Retry' }).getAttribute('title')).toBe(en.rushFailed) })
  view.unmount()
})

it('walks nested Fanqie rankings and keeps the deeper choice where the next ranking has it', () => {
  const { props, reads } = setup({ platform: 'fanqie' })
  const view = rankings(render(<DrawerData {...props} />))
  expect(view.getByRole('table').textContent).toContain('1.1M chars')
  expect(view.getByRole('table').textContent).toContain('—')
  fireEvent.click(view.getByRole('button', { name: '新书榜' }))
  expect(reads.at(-1)).toContain(param('男频 · 新书榜 · 都市脑洞'))
  fireEvent.click(view.getByRole('button', { name: '女频' }))
  expect(reads.at(-1)).toContain(param('女频 · 阅读榜 · 宫斗宅斗'))
  view.unmount()
})

it('reads the first Qimao ranking when the station names no default, and says when it is empty', () => {
  const { props, reads } = setup({ platform: 'qimao' })
  const view = rankings(render(<DrawerData {...props} />))
  expect(reads.some(address => address.includes(param('男生榜 · 大热榜 · 日榜')))).toBe(true)
  expect(view.getByText(en.nothingHere)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '更新榜' }))
  expect(reads.at(-1)).toContain(param('男生榜 · 更新榜'))
  view.unmount()
})

it('says a platform with no rankings has nothing yet, and waits while its rankings load', () => {
  const empty = setup({ platform: 'hongguo' })
  boards.hongguo = boards.empty!
  try {
    const view = rankings(render(<DrawerData {...empty.props} />))
    expect(view.getByText(en.nothingHere)).toBeTruthy()
    view.unmount()
  } finally {
    boards.hongguo = { boards: ['综合热播榜', '综合新剧榜'], defaultBoard: '综合热播榜' }
  }
  const pending = setup({ platform: 'hongguo', pending: ['muse-data-boards'] })
  const view = rankings(render(<DrawerData {...pending.props} />))
  expect(view.getByText(en.loading)).toBeTruthy()
  expect(pending.reads).toContain('studio://inactive')
})

it('marks Douyin as per-video monitoring without ranks or 转写', () => {
  const { props } = setup({ platform: 'douyin' })
  const view = rankings(render(<DrawerData {...props} />))
  expect(view.getByText(en.monitorNote)).toBeTruthy()
  expect(view.getByRole('table').textContent).toContain('13M')
  expect(view.queryByRole('button', { name: 'Transcribe' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Quote Office Swap in the chat' }))
  expect(props.quote).toHaveBeenCalledWith(expect.stringContaining('#—'))
  view.unmount()
})

it('shows the Lvpaopao collector state while it has no rankings', () => {
  const { props } = setup({ platform: 'lvpaopao' })
  const view = rankings(render(<DrawerData {...props} />))
  expect(view.getByText('Waiting for the collector')).toBeTruthy()
  expect(view.getByText('Install the collector to start')).toBeTruthy()
  view.unmount()
  const loading = setup({ platform: 'lvpaopao', pending: ['muse-data-collector'] })
  const waiting = rankings(render(<DrawerData {...loading.props} />))
  expect(waiting.getByText(en.loading)).toBeTruthy()
})

it('reports a ranking it could not read and reads again on refresh', () => {
  const { props, reads } = setup({ platform: 'hongguo', fail: ['muse-data-period'] })
  const view = rankings(render(<DrawerData {...props} />))
  expect(view.getByRole('alert').textContent).toContain(en.dataFailed)
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(reads.some(address => address.includes('muse-data-period') && address.includes('revision=1'))).toBe(true)
  view.unmount()
})

it('waits for a ranking that is still loading', () => {
  const { props } = setup({ platform: 'hongguo', pending: ['muse-data-period'] })
  const view = rankings(render(<DrawerData {...props} />))
  expect(view.getByText(en.loading)).toBeTruthy()
  view.unmount()
})

it('switches platform from the platform button', () => {
  const { props } = setup({ platform: 'hongguo' })
  const view = render(<DrawerData {...props} />)
  const pill = view.getByRole('button', { name: 'Hongguo dramas, switch platform' })
  fireEvent.click(pill)
  expect(pill.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(view.getAllByRole('button', { name: /Qimao novels/u }).at(-1)!)
  expect(props.openPlatform).toHaveBeenCalledWith({ id: 'qimao', title: 'Qimao novels' })
  view.unmount()
})

it('shows the Hongguo stock with counts, progress and 立即转写 only where it moves a drama forward', async () => {
  const { props, reads } = setup({ platform: 'hongguo', total: 120 })
  const view = render(<DrawerData {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Stock' }))
  const filters = view.getByRole('group', { name: en.stockFilter })
  expect([...filters.querySelectorAll('button')].map(button => button.textContent)).toEqual(
    ['All', 'Transcribing1', 'Queued148', 'With script1', 'Needs attention1', 'Rejected1'])
  const table = view.getByRole('table', { name: 'Stock' })
  expect(table.textContent).toContain('19/88')
  expect(table.textContent).toContain('19M')
  expect(table.textContent).toContain('3.4B')
  expect(view.getByRole('img', { name: 'Episode 19 of 88' })).toBeTruthy()
  expect(view.getByRole('img', { name: en.stageTranscribing })).toBeTruthy()
  expect(view.getAllByRole('button', { name: 'Transcribe now' })).toHaveLength(3)
  expect(table.textContent).toContain('Ready')
  fireEvent.click(view.getByRole('button', { name: 'Quote Good Girl in the chat' }))
  expect(props.quote).toHaveBeenCalledWith('Good Girl (from the transcription stock)')
  await act(async () => { fireEvent.click(view.getAllByRole('button', { name: 'Transcribe now' })[0]!) })
  expect(props.rush).toHaveBeenCalledWith('hongguo:12')
  fireEvent.change(view.getByRole('textbox', { name: en.searchStock }), { target: { value: ' Good ' } })
  fireEvent.submit(view.getByRole('search'))
  expect(reads.at(-1)).toContain('q=Good')
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(reads.at(-1)).toContain('page=2')
  fireEvent.click(view.getByRole('button', { name: en.previous }))
  expect(reads.at(-1)).toContain('page=1')
  fireEvent.change(view.getByRole('textbox', { name: en.searchStock }), { target: { value: '' } })
  expect(reads.at(-1)).toContain('q=&')
  fireEvent.click(view.getByRole('button', { name: /Rejected/u }))
  expect(view.getByText(en.nothingHere)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Rankings' }))
  expect(view.getByRole('table', { name: '综合热播榜' })).toBeTruthy()
  view.unmount()
})

it('reports a stock page it could not read, and waits while it loads', () => {
  const failed = setup({ platform: 'hongguo', fail: ['muse-data-stock'] })
  let view = render(<DrawerData {...failed.props} />)
  fireEvent.click(view.getByRole('button', { name: 'Stock' }))
  expect(view.getByRole('alert')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(failed.reads.some(address => address.includes('muse-data-stock') && address.includes('revision=1'))).toBe(true)
  view.unmount()
  const pending = setup({ platform: 'hongguo', pending: ['muse-data-stock'] })
  view = render(<DrawerData {...pending.props} />)
  fireEvent.click(view.getByRole('button', { name: 'Stock' }))
  expect(view.getByText(en.loading)).toBeTruthy()
  view.unmount()
})

it('opens a platform on its whole collection, searches it, quotes a work with its ID and queues 转写', async () => {
  const { props, reads } = setup({ platform: 'hongguo', found: 45 })
  const view = render(<DrawerData {...props} />)
  expect(view.getByRole('button', { name: 'All collected' }).getAttribute('aria-pressed')).toBe('true')
  const table = view.getByRole('table', { name: 'All collected' })
  expect(table.textContent).toContain('Spoiled DaughterUrban · Family · 80 episodes89.6M1.4M')
  expect(table.textContent).toContain('3—')
  expect(reads.at(-1)).toContain('muse-data-works')
  expect(reads.at(-1)).toContain('platform=hongguo')
  fireEvent.click(view.getByRole('button', { name: 'Quote Spoiled Daughter in the chat' }))
  expect(props.quote).toHaveBeenCalledWith('Spoiled Daughter on Hongguo dramas (hongguo:1)')
  await act(async () => { fireEvent.click(view.getAllByRole('button', { name: 'Transcribe' })[0]!) })
  expect(props.rush).toHaveBeenCalledWith('hongguo:1')
  fireEvent.change(view.getByRole('textbox', { name: en.searchCollected }), { target: { value: ' Daughter ' } })
  fireEvent.submit(view.getByRole('search'))
  expect(reads.at(-1)).toContain('q=Daughter')
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(reads.at(-1)).toContain('page=2')
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(view.getByRole('button', { name: en.next }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: en.previous }))
  expect(reads.at(-1)).toContain('page=2')
  fireEvent.change(view.getByRole('textbox', { name: en.searchCollected }), { target: { value: '' } })
  expect(reads.at(-1)).toContain('q=&')
  expect(reads.at(-1)).toContain('page=1')
  rankings(view)
  expect(view.getByRole('table', { name: '综合热播榜' })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'All collected' }))
  expect(view.getByRole('table', { name: 'All collected' })).toBeTruthy()
  view.unmount()
})

it('shows a novel platform\'s collection without 转写, and says when a search finds nothing', () => {
  const { props } = setup({ platform: 'fanqie' })
  const view = render(<DrawerData {...props} />)
  expect(view.getByRole('table', { name: 'All collected' }).textContent).toContain('1.1M chars')
  expect(view.queryByRole('button', { name: 'Transcribe' })).toBeNull()
  expect(view.queryByRole('button', { name: en.next })).toBeNull()
  view.unmount()
  const empty = render(<DrawerData {...setup({ platform: 'qimao' }).props} />)
  expect(empty.getByText(en.nothingHere)).toBeTruthy()
  empty.unmount()
  const searched = render(<DrawerData {...setup({ platform: 'lvpaopao' }).props} />)
  expect(searched.getByText('Waiting for the collector')).toBeTruthy()
  fireEvent.change(searched.getByRole('textbox', { name: en.searchCollected }), { target: { value: 'x' } })
  fireEvent.submit(searched.getByRole('search'))
  expect(searched.getByText(en.nothingHere)).toBeTruthy()
  searched.unmount()
})

it('reports a collection page it could not read, and waits while it loads', () => {
  const failed = setup({ platform: 'hongguo', fail: ['muse-data-works'] })
  let view = render(<DrawerData {...failed.props} />)
  expect(view.getByRole('alert')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(failed.reads.some(address => address.includes('muse-data-works') && address.includes('revision=1'))).toBe(true)
  view.unmount()
  view = render(<DrawerData {...setup({ platform: 'hongguo', pending: ['muse-data-works'] }).props} />)
  expect(view.getByText(en.loading)).toBeTruthy()
  view.unmount()
})
