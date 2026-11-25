/** The data tab of the Bot team's details drawer: platforms, their whole collection, rankings and the Hongguo transcription stock. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MuseDataPeriod, MuseDataPlatform, MuseDataStockItem, MuseDataStockRequest, MuseDataWork, MuseDataWorks } from '@deepseek-ai/dsh-muse-account/types'
import { address, type Read, type Text } from './Production.tsx'
import css from './DrawerData.module.css'

type Key = Parameters<Text>[0]
type Period = MuseDataPeriod['period']
type Filter = MuseDataStockRequest['filter']

/** One platform: its name, glyph and the two metrics its rows show, in the order the tab lists them. */
const PLATFORMS: readonly { id: MuseDataPlatform; name: Key; glyph: Key; columns: readonly [string, Key][] }[] = [
  { id: 'hongguo', name: 'platformHongguo', glyph: 'glyphHongguo', columns: [['heat', 'metricHeat'], ['collection', 'metricCollection']] },
  { id: 'douyin', name: 'platformDouyin', glyph: 'glyphDouyin', columns: [['video_plays', 'metricPlays'], ['video_likes', 'metricLikes']] },
  { id: 'lvpaopao', name: 'platformLvpaopao', glyph: 'glyphLvpaopao', columns: [['likes', 'metricLikes'], ['comments', 'metricComments']] },
  { id: 'fanqie', name: 'platformFanqie', glyph: 'glyphFanqie', columns: [['currentReaders', 'metricReaders'], ['words', 'metricWords']] },
  { id: 'qimao', name: 'platformQimao', glyph: 'glyphQimao', columns: [['heat', 'metricHeat'], ['words', 'metricWords']] },
]
const PERIODS: readonly [Period, Key][] = [['day', 'periodDay'], ['week', 'periodWeek'], ['month', 'periodMonth']]
const FILTERS: readonly [Filter, Key][] = [['all', 'filterAll'], ['active', 'filterActive'], ['queued', 'filterQueued'], ['script', 'filterScript'], ['failed', 'filterFailed'], ['rejected', 'filterRejected']]
const STAGES: Record<NonNullable<MuseDataStockItem['job']>['state'], Key> = {
  queued: 'stageQueued', downloading: 'stageDownloading', transcribing: 'stageTranscribing', checking: 'stageChecking',
  published: 'stagePublished', failed: 'stageFailed', 'needs-attention': 'stageAttention', rejected: 'stageRejected',
}
const LANES: Record<NonNullable<MuseDataStockItem['job']>['lane'], Key> = { manual: 'laneManual', new: 'laneNew', backlog: 'laneBacklog' }
const RUNNING = new Set(['downloading', 'transcribing', 'checking'])
const STOCK_PAGE = 50
const COLLECTED_PAGE = 20
/** Ranking names nest by this separator, e.g. 男频 · 阅读榜 · 都市脑洞. */
const LEVEL = ' · '

/** What the drawer's owner hands the tab. */
export interface DrawerDataProps {
  t: Text
  useResource: Read
  useAccountEpoch: <T>(select: (value: number) => T) => T
  /** The open platform, or null on the platform list. */
  platform: string | null
  /** Open one platform in a panel tab of its own, named `title`. */
  openPlatform: (platform: { id: string; title: string }) => void
  /** Put a reference above the message box of the drawer's conversation. */
  quote: (text: string) => void
  /** Move a Hongguo drama to the front of the transcription queue as the signed-in member. */
  rush: (workId: string) => Promise<void>
}

/**
 * Browse the data station inside the Bot team's details drawer.
 * @param props - Data-station resources for the current login, the open platform and the conversation's message box.
 * @returns The data tab.
 */
export function DrawerData(props: DrawerDataProps) {
  const epoch = props.useAccountEpoch(n => n)
  const shown = PLATFORMS.find(entry => entry.id === props.platform)
  return shown === undefined
    ? <PlatformList key={epoch} {...props} epoch={epoch} />
    : <PlatformView key={`${epoch}:${shown.id}`} {...props} epoch={epoch} platform={shown} />
}

function short(value: number | null | undefined, t: Text): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat(t('numberLocale'), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function metricOf(work: MuseDataWork, key: string, t: Text): string {
  if (key === 'words') return work.wordCount === null ? '—' : t('wordsValue', { value: short(work.wordCount, t) })
  return short(work.metrics.find(metric => metric.key === key)?.value, t)
}

function Glyph({ id, t, glyph }: { id: MuseDataPlatform; t: Text; glyph: Key }) {
  return <span aria-hidden="true" className={`${css.glyph} ${css[id]}`}>{t(glyph)}</span>
}

function PlatformList({ epoch, t, useResource, openPlatform }: DrawerDataProps & { epoch: number }) {
  const hongguo = useResource<'muse-data-boards'>(address('muse-data-boards', epoch, 0, { platform: 'hongguo' }))
  const fanqie = useResource<'muse-data-boards'>(address('muse-data-boards', epoch, 0, { platform: 'fanqie' }))
  const qimao = useResource<'muse-data-boards'>(address('muse-data-boards', epoch, 0, { platform: 'qimao' }))
  const stock = useResource<'muse-data-stock'>(address('muse-data-stock', epoch, 0, { filter: 'all', page: '1', limit: '1' }))
  const collector = useResource<'muse-data-collector'>(address('muse-data-collector', epoch, 0))
  const boards = (read: typeof hongguo) => read.value === undefined ? '' : t('boardCount', { count: String(read.value.boards.length) })
  const lines: Record<MuseDataPlatform, string> = {
    hongguo: [boards(hongguo), stock.value === undefined ? '' : t('stockCount', { count: String(stock.value.summary.candidates) })].filter(Boolean).join(' · '),
    douyin: t('monitorLine'),
    lvpaopao: collector.value?.label ?? '',
    fanqie: boards(fanqie),
    qimao: boards(qimao),
  }
  const busy = (stock.value?.summary.active ?? 0) > 0
  return <section className={css.drawer} aria-label={t('dataPlatforms')}>
    <ul className={css.platforms}>{PLATFORMS.map(entry => <li key={entry.id}>
      <button type="button" className={css.platform} onClick={() => { openPlatform({ id: entry.id, title: t(entry.name) }) }}>
        <Glyph id={entry.id} t={t} glyph={entry.glyph} />
        <span className={css.text}><strong>{t(entry.name)}</strong>{lines[entry.id] !== '' && <small>{lines[entry.id]}</small>}</span>
        {entry.id === 'hongguo' && busy && <span className={css.live} role="img" aria-label={t('stageTranscribing')} />}
      </button>
    </li>)}</ul>
  </section>
}

function PlatformView({ epoch, platform, t, useResource, openPlatform, quote, rush }: Omit<DrawerDataProps, 'platform'> & { epoch: number; platform: typeof PLATFORMS[number] }) {
  // A platform opens on its whole collection (全收录); rankings and the Hongguo stock are one chip away.
  const [view, setView] = useState<'all' | 'rank' | 'stock'>('all')
  const [choosing, setChoosing] = useState(false)
  const hongguo = platform.id === 'hongguo'
  return <section className={css.drawer}>
    <div className={css.bar}>
      <button type="button" className={css.pill} aria-expanded={choosing} aria-label={t('switchPlatform', { name: t(platform.name) })} onClick={() => { setChoosing(open => !open) }}>
        <Glyph id={platform.id} t={t} glyph={platform.glyph} /><strong>{t(platform.name)}</strong>
      </button>
      <div className={css.chips} role="group" aria-label={t('dataView')}>
        <button type="button" className={css.chip} aria-pressed={view === 'all'} onClick={() => { setView('all') }}>{t('viewCollected')}</button>
        <button type="button" className={css.chip} aria-pressed={view === 'rank'} onClick={() => { setView('rank') }}>{t('viewRankings')}</button>
        {hongguo && <button type="button" className={css.chip} aria-pressed={view === 'stock'} onClick={() => { setView('stock') }}>{t('viewStock')}</button>}
      </div>
    </div>
    {choosing && <ul className={css.menu}>{PLATFORMS.map(entry => <li key={entry.id}>
      <button type="button" className={css.platform} aria-pressed={entry.id === platform.id}
        onClick={() => { setChoosing(false); openPlatform({ id: entry.id, title: t(entry.name) }) }}>
        <Glyph id={entry.id} t={t} glyph={entry.glyph} /><span className={css.text}><strong>{t(entry.name)}</strong></span>
      </button>
    </li>)}</ul>}
    {view === 'all' ? <Collected epoch={epoch} platform={platform} t={t} useResource={useResource} quote={quote} rush={rush} />
      : hongguo && view === 'stock' ? <Stock epoch={epoch} t={t} useResource={useResource} quote={quote} rush={rush} />
        : <Rankings epoch={epoch} platform={platform} t={t} useResource={useResource} quote={quote} rush={rush} />}
  </section>
}

/** The ranking levels a set of nested names offers under the chosen one. */
function levelsOf(names: readonly string[], chosen: string): { options: string[]; value: string }[] {
  const want = chosen.split(LEVEL)
  const levels: { options: string[]; value: string }[] = []
  let pool = names.map(name => name.split(LEVEL))
  for (;;) {
    const depth = levels.length
    const options = [...new Set(pool.flatMap(part => part.slice(depth, depth + 1)))]
    const value = options.find(option => option === want[depth]) ?? options[0]
    if (value === undefined) return levels
    levels.push({ options, value })
    pool = pool.filter(part => part[depth] === value)
  }
}

/** The ranking a choice at one level leads to, keeping the deeper choices where that ranking has them. */
function boardAfter(names: readonly string[], chosen: string, depth: number, option: string): string | undefined {
  const want = chosen.split(LEVEL)
  const prefix = [...want.slice(0, depth), option].join(LEVEL)
  const same = [prefix, ...want.slice(depth + 1)].join(LEVEL)
  return names.find(name => name === same) ?? names.find(name => name === prefix || name.startsWith(prefix + LEVEL))
}

function Rankings({ epoch, platform, t, useResource, quote, rush }: Pick<DrawerDataProps, 't' | 'useResource' | 'quote' | 'rush'> & { epoch: number; platform: typeof PLATFORMS[number] }) {
  const [revision, refresh] = useState(0)
  const boards = useResource<'muse-data-boards'>(address('muse-data-boards', epoch, revision, { platform: platform.id }))
  const names = boards.value?.boards ?? []
  // An unset pick, or one the platform no longer lists, follows the station's default ranking.
  const [picked, setPicked] = useState<string | undefined>()
  const board = picked !== undefined && names.includes(picked) ? picked : boards.value?.defaultBoard ?? names[0] ?? null
  const [period, setPeriod] = useState<Period>('week')
  const ranking = useResource<'muse-data-period'>(board === null ? 'studio://inactive'
    : address('muse-data-period', epoch, revision, { platform: platform.id, board, period }))
  if (boards.status === 'live' && names.length === 0) {
    return platform.id === 'lvpaopao' ? <Collector epoch={epoch} t={t} useResource={useResource} /> : <p className={css.quiet}>{t('nothingHere')}</p>
  }
  const failed = boards.status === 'failed' || ranking.status === 'failed'
  const levels = board === null ? [] : levelsOf(names, board).map(level => ({ ...level, board }))
  return <>
    {platform.id === 'douyin'
      ? <p className={css.quiet}>{t('monitorNote')}</p>
      : <div className={css.controls}>
        {levels.map((level, depth) => level.options.length > 1 && <div key={depth} className={css.chips} role="group" aria-label={t('rankingLevel')}>
          {level.options.map(option => <button key={option} type="button" className={css.chip} aria-pressed={option === level.value}
            onClick={() => { setPicked(boardAfter(names, level.board, depth, option)) }}>{option}</button>)}
        </div>)}
        <div className={css.chips} role="group" aria-label={t('rankingPeriod')}>
          {PERIODS.map(([value, label]) => <button key={value} type="button" className={css.chip} aria-pressed={period === value} onClick={() => { setPeriod(value) }}>{t(label)}</button>)}
        </div>
      </div>}
    {failed ? <DataFailure t={t} retry={() => { refresh(n => n + 1) }} />
      : ranking.value === undefined ? <p className={css.quiet}>{t('loading')}</p>
        : ranking.value.items.length === 0 ? <p className={css.quiet}>{t('nothingHere')}</p>
          : <RankRows period={ranking.value} platform={platform} t={t} quote={quote} rush={rush} />}
  </>
}

function RankRows({ period, platform, t, quote, rush }: Pick<DrawerDataProps, 't' | 'quote' | 'rush'> & { period: MuseDataPeriod; platform: typeof PLATFORMS[number] }) {
  return <div className={css.table} role="table" aria-label={period.board}>
    <div className={`${css.row} ${css.head}`} role="row">
      <span role="columnheader" /><span role="columnheader" />
      {platform.columns.map(([key, label]) => <span key={key} role="columnheader" className={css.num}>{t(label)}</span>)}
      <span role="columnheader" />
    </div>
    {period.items.map(({ position, work }) => {
      const title = work.title ?? work.sourceId
      return <div key={work.id} className={css.row} role="row">
        <span role="cell" className={css.rank}>{position ?? ''}</span>
        <span role="cell" className={css.text}><strong>{title}</strong><small>{work.tags.slice(0, 3).join(' · ')}</small></span>
        <WorkCells work={work} platform={platform} t={t} rush={rush} title={title}
          onQuote={() => { quote(t('workReference', { platform: t(platform.name), board: period.board, rank: String(position ?? '—'), title })) }} />
      </div>
    })}
  </div>
}

function WorkCells({ work, platform, t, rush, title, onQuote }: Pick<DrawerDataProps, 't' | 'rush'> & {
  work: MuseDataWork
  platform: typeof PLATFORMS[number]
  title: string
  onQuote: () => void
}) {
  return <>
    {platform.columns.map(([key]) => <span key={key} role="cell" className={css.num}>{metricOf(work, key, t)}</span>)}
    <span role="cell" className={css.acts}>
      <QuoteButton t={t} title={title} onQuote={onQuote} />
      {platform.id === 'hongguo' && <RushButton t={t} workId={work.id} rush={rush} kind="transcribe" />}
    </span>
  </>
}

function Collected({ epoch, platform, t, useResource, quote, rush }: Pick<DrawerDataProps, 't' | 'useResource' | 'quote' | 'rush'> & { epoch: number; platform: typeof PLATFORMS[number] }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, refresh] = useState(0)
  const found = useResource<'muse-data-works'>(address('muse-data-works', epoch, revision, { platform: platform.id, q: query, page: String(page), limit: String(COLLECTED_PAGE) }))
  const total = found.value?.total ?? 0
  const empty = platform.id === 'lvpaopao' && query === '' ? <Collector epoch={epoch} t={t} useResource={useResource} /> : <p className={css.quiet}>{t('nothingHere')}</p>
  return <>
    <form className={css.search} role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); setPage(1) }}>
      <Input aria-label={t('searchCollected')} placeholder={t('searchCollected')} maxLength={100} value={draft}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim() === '') { setQuery(''); setPage(1) } }} />
    </form>
    {found.status === 'failed' ? <DataFailure t={t} retry={() => { refresh(n => n + 1) }} />
      : found.value === undefined ? <p className={css.quiet}>{t('loading')}</p>
        : found.value.items.length === 0 ? empty
          : <CollectedRows works={found.value} platform={platform} t={t} quote={quote} rush={rush} />}
    {total > COLLECTED_PAGE && <div className={css.pages}>
      <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => { setPage(n => Math.max(1, n - 1)) }}>{t('previous')}</Button>
      <Button variant="ghost" size="sm" disabled={page * COLLECTED_PAGE >= total} onClick={() => { setPage(n => n + 1) }}>{t('next')}</Button>
    </div>}
  </>
}

function CollectedRows({ works, platform, t, quote, rush }: Pick<DrawerDataProps, 't' | 'quote' | 'rush'> & { works: MuseDataWorks; platform: typeof PLATFORMS[number] }) {
  return <div className={css.table} role="table" aria-label={t('viewCollected')}>
    <div className={`${css.row} ${css.collectedRow} ${css.head}`} role="row">
      <span role="columnheader" />
      {platform.columns.map(([key, label]) => <span key={key} role="columnheader" className={css.num}>{t(label)}</span>)}
      <span role="columnheader" />
    </div>
    {works.items.map((work) => {
      const title = work.title ?? work.sourceId
      const meta = [work.tags.slice(0, 2).join(' · '), work.episodeCount === null ? '' : t('episodeCount', { count: String(work.episodeCount) })].filter(Boolean).join(' · ')
      return <div key={work.id} className={`${css.row} ${css.collectedRow}`} role="row">
        <span role="cell" className={css.text}><strong>{title}</strong>{meta !== '' && <small>{meta}</small>}</span>
        <WorkCells work={work} platform={platform} t={t} rush={rush} title={title}
          onQuote={() => { quote(t('collectedReference', { platform: t(platform.name), title, id: work.id })) }} />
      </div>
    })}
  </div>
}

function Stock({ epoch, t, useResource, quote, rush }: Pick<DrawerDataProps, 't' | 'useResource' | 'quote' | 'rush'> & { epoch: number }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, refresh] = useState(0)
  const board = useResource<'muse-data-stock'>(address('muse-data-stock', epoch, revision, { filter, q: query, page: String(page), limit: String(STOCK_PAGE) }))
  const summary = board.value?.summary
  const total = board.value?.total ?? 0
  const counts: Partial<Record<Filter, number>> = summary === undefined ? {}
    : { active: summary.active, queued: summary.queued, script: summary.stock, failed: summary.failures, rejected: summary.rejected }
  const pick = (next: Filter) => { setFilter(next); setPage(1) }
  return <>
    <form className={css.search} role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); setPage(1) }}>
      <Input aria-label={t('searchStock')} placeholder={t('searchStock')} maxLength={100} value={draft}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim() === '') { setQuery(''); setPage(1) } }} />
    </form>
    <div className={css.chips} role="group" aria-label={t('stockFilter')}>
      {FILTERS.map(([value, label]) => <button key={value} type="button" className={css.chip} aria-pressed={filter === value} onClick={() => { pick(value) }}>
        {t(label)}{counts[value] !== undefined && <small className={css.count}>{counts[value]}</small>}
      </button>)}
    </div>
    {board.status === 'failed' ? <DataFailure t={t} retry={() => { refresh(n => n + 1) }} />
      : board.value === undefined ? <p className={css.quiet}>{t('loading')}</p>
        : board.value.items.length === 0 ? <p className={css.quiet}>{t('nothingHere')}</p>
          : <div className={css.table} role="table" aria-label={t('viewStock')}>
            <div className={`${css.row} ${css.stockRow} ${css.head}`} role="row">
              <span role="columnheader" />
              <span role="columnheader" className={css.num}>{t('metricCollection')}</span>
              <span role="columnheader" className={css.num}>{t('douyinTopic')}</span>
              <span role="columnheader" /><span role="columnheader" />
            </div>
            {board.value.items.map(item => <StockRow key={item.work.id} item={item} t={t} quote={quote} rush={rush} />)}
          </div>}
    {total > STOCK_PAGE && <div className={css.pages}>
      <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => { setPage(n => Math.max(1, n - 1)) }}>{t('previous')}</Button>
      <Button variant="ghost" size="sm" disabled={page * STOCK_PAGE >= total} onClick={() => { setPage(n => n + 1) }}>{t('next')}</Button>
    </div>}
  </>
}

function StockRow({ item, t, quote, rush }: Pick<DrawerDataProps, 't' | 'quote' | 'rush'> & { item: MuseDataStockItem }) {
  const { work, job, evaluation } = item
  const title = work.title ?? work.sourceId
  const running = job !== null && RUNNING.has(job.state)
  const done = job?.progress?.episode ?? null
  const total = job?.progress?.totalEpisodes ?? work.episodeCount
  const canRush = job === null || (job.state === 'queued' && job.lane !== 'manual') || job.state === 'failed' || job.state === 'needs-attention' || job.state === 'rejected'
  const meta = [total === null ? '' : t('episodeCount', { count: String(total) }), job === null ? '' : t(LANES[job.lane])].filter(Boolean).join(' · ')
  return <div className={`${css.row} ${css.stockRow}`} role="row">
    <span role="cell" className={css.text}><strong>{title}</strong>{meta !== '' && <small>{meta}</small>}</span>
    <span role="cell" className={css.num}>{short(evaluation?.collection?.value, t)}</span>
    <span role="cell" className={css.num}>{short(evaluation?.douyin?.viewCount, t)}</span>
    <span role="cell" className={css.stage}>
      {done !== null && total !== null && total > 0
        ? <><span className={`${css.track} ${running ? css.trackLive : ''}`} role="img" aria-label={t('episodeProgress', { done: String(done), total: String(total) })}>
          <span style={{ width: `${Math.min(100, Math.round(done / total * 100))}%` }} /></span>
        <small>{done}/{total}</small></>
        : <small>{job === null ? '' : t(STAGES[job.state])}</small>}
    </span>
    <span role="cell" className={css.acts}>
      <QuoteButton t={t} title={title} onQuote={() => { quote(t('stockReference', { title })) }} />
      {running ? <span className={css.live} role="img" aria-label={t('stageTranscribing')} />
        : canRush ? <RushButton t={t} workId={work.id} rush={rush} kind="rushNow" /> : null}
    </span>
  </div>
}

function QuoteButton({ t, title, onQuote }: { t: Text; title: string; onQuote: () => void }) {
  return <button type="button" className={css.quote} aria-label={t('quoteWork', { title })} title={t('quoteWork', { title })} onClick={onQuote}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /><path d="M9 10h6" />
    </svg>
  </button>
}

function RushButton({ t, workId, rush, kind }: Pick<DrawerDataProps, 't' | 'rush'> & { workId: string; kind: 'transcribe' | 'rushNow' }) {
  const [state, setState] = useState<'idle' | 'busy' | 'queued' | 'failed'>('idle')
  if (state === 'queued') return <span className={css.tag}>{t('queuedNow')}</span>
  const go = () => {
    setState('busy')
    rush(workId).then(() => { setState('queued') }, () => { setState('failed') })
  }
  return <Button size="sm" variant="outline" disabled={state === 'busy'} title={state === 'failed' ? t('rushFailed') : undefined} onClick={go}>
    {state === 'failed' ? t('retry') : t(kind)}
  </Button>
}

function Collector({ epoch, t, useResource }: Pick<DrawerDataProps, 't' | 'useResource'> & { epoch: number }) {
  const collector = useResource<'muse-data-collector'>(address('muse-data-collector', epoch, 0))
  return <div className={css.empty}>
    <strong>{collector.value?.label ?? t('loading')}</strong>
    {collector.value?.message && <small>{collector.value.message}</small>}
  </div>
}

function DataFailure({ t, retry }: { t: Text; retry: () => void }) {
  return <div className={css.failure} role="alert">{t('dataFailed')} <Button variant="ghost" size="sm" onClick={retry}>{t('refresh')}</Button></div>
}
