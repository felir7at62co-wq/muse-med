import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { ArrowDownToLine, CalendarDays, ChevronLeft, ChevronRight, GitCompareArrows, RefreshCw, Search } from 'lucide-react';
import { LVPAOPAO_BOARD_PREFIX } from '../shared/lvpaopao';
import { PLATFORM_GLYPHS, PLATFORM_LABELS, type BoardDayList, type BoardPeriod, type BoardPeriodItem, type BoardPeriodView, type Platform } from '../shared/types';
import { periodRange } from '../shared/board-period';
import { buildTopicFacets } from '../shared/topic-facets';
import { request } from './api';
import type { CatalogDisplayCache } from './catalog-display-cache';
import { dateText, Empty, Loading, RankChange, WorkLink } from './components';
import { ScriptOrTranscribe } from './Transcribe';
import { OriginalDownload } from './OriginalDownload';
import { platformMetricColumns } from './platform-metrics';
import { TopicFilters } from './TopicFilters';
import { BoardComparisonView } from './BoardHistory';
import { applicationUrl } from './url';
import { boardDaysQuery, periodQuery } from './board-queries';

type Notify = (text: string, error?: boolean) => void;
const PAGE_SIZE = 20;
/** Boards read in the background after the shown one renders. */
const PREFETCH_LIMIT = 12;
const PERIOD_LABELS: Record<BoardPeriod, string> = { day: '日榜', week: '周榜', month: '月榜' };
const PERIOD_UNITS: Record<BoardPeriod, string> = { day: '采集日', week: '周', month: '月' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Reads a board period once per data version and holds it in the display cache.
 * A latest-day read is also held under its resolved date, so choosing that date needs no request.
 */
function loadPeriod(cache: CatalogDisplayCache, query: string, version: number): Promise<BoardPeriodView> {
  return cache.once(`period:${version}:${query}`, () => request<BoardPeriodView>(`/api/boards/period?${query}`).then(value => {
    cache.savePeriod(query, value, version);
    if (!new URLSearchParams(query).has('date')) cache.savePeriod(periodQuery(value.platform, value.board, value.period, value.date), value, version);
    return value;
  }));
}

function loadDays(cache: CatalogDisplayCache, query: string, version: number): Promise<BoardDayList> {
  return cache.once(`days:${version}:${query}`, () => request<BoardDayList>(`/api/boards/days?${query}`).then(value => {
    cache.saveBoardDays(query, value, version);
    return value;
  }));
}

function monthDay(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

function averageText(value: number | null): string {
  return value === null ? '名次未知' : value.toFixed(1);
}

function rankText(value: number | null): string {
  return value === null ? '—' : String(value).padStart(2, '0');
}

/** Short chip labels for Hongguo's official boards; other platforms show their board names. */
const BOARD_CHIP_LABELS: Record<string, string> = {
  综合热播榜: '综合热播', 真人热播榜: '真人热播', 'AI 热播榜': 'AI 热播', 漫剧热播榜: '漫剧热播', 综合新剧榜: '新剧', 综合收藏榜: '收藏', 综合必看榜: '必看',
};

/** Hongguo chip order: 综合、真人、AI、漫剧热播, then 新剧、收藏、必看. */
const BOARD_CHIP_ORDER = ['综合热播榜', '真人热播榜', 'AI 热播榜', '漫剧热播榜', '综合新剧榜', '综合收藏榜', '综合必看榜'];

/** Returns the label shown on a board chip. */
export function boardChipLabel(board: string): string {
  return BOARD_CHIP_LABELS[board] ?? boardDisplayName(board);
}

/** Board name without the storage prefix that keeps 绿泡泡 boards apart from other platforms' boards of the same name. */
export function boardDisplayName(board: string): string {
  return board.startsWith(LVPAOPAO_BOARD_PREFIX) ? board.slice(LVPAOPAO_BOARD_PREFIX.length) : board;
}

/** Orders boards for chips: Hongguo's official boards in their platform order, then every other board in its given order. */
export function orderBoardChips(boards: string[]): string[] {
  const rank = (board: string) => { const index = BOARD_CHIP_ORDER.indexOf(board); return index < 0 ? BOARD_CHIP_ORDER.length : index; };
  return boards.map((board, index) => ({ board, index })).sort((a, b) => rank(a.board) - rank(b.board) || a.index - b.index).map(entry => entry.board);
}

/** Hongguo's drama formats; every Hongguo ranking row carries its format as a platform tag. */
export const DRAMA_FORMATS = ['真人剧', '漫剧', 'AI剧'] as const;
/** A chosen format, or the empty string for all formats. */
export type DramaFormat = typeof DRAMA_FORMATS[number] | '';
/** Each format's own official hot board; the other boards rank all formats together. */
const FORMAT_HOT_BOARDS: Record<Exclude<DramaFormat, ''>, string> = { 真人剧: '真人热播榜', 漫剧: '漫剧热播榜', AI剧: 'AI 热播榜' };
const HOT_BOARDS = ['综合热播榜', ...Object.values(FORMAT_HOT_BOARDS)];

/**
 * Boards offered under a format: that format's hot board in place of the four hot boards, then the boards that rank all formats.
 * @param boards Boards of the platform.
 * @param format Chosen format; empty keeps every board.
 */
export function formatBoards(boards: string[], format: DramaFormat): string[] {
  return format ? boards.filter(board => board === FORMAT_HOT_BOARDS[format] || !HOT_BOARDS.includes(board)) : boards;
}

/**
 * The board to show after choosing a format: a hot board becomes the chosen format's hot board, or 综合热播榜 for all formats.
 * @param board Board shown now.
 * @param format Newly chosen format.
 * @param boards Boards of the platform; a missing target keeps the current board.
 */
export function boardForFormat(board: string, format: DramaFormat, boards: string[]): string {
  if (!HOT_BOARDS.includes(board)) return board;
  const target = format ? FORMAT_HOT_BOARDS[format] : '综合热播榜';
  return boards.includes(target) ? target : board;
}

/**
 * Whether a board's rows need filtering to show one format: a format's own hot board already holds only that format.
 * @param board Shown board.
 * @param format Chosen format.
 */
export function filtersFormat(board: string, format: DramaFormat): boolean {
  return format !== '' && board !== FORMAT_HOT_BOARDS[format];
}

/** 全部 / 真人剧 / 漫剧 / AI剧 tabs above the Hongguo board chips. */
export function FormatTabs({ format, disabled, onSelect }: { format: DramaFormat; disabled: boolean; onSelect: (format: DramaFormat) => void }) {
  return <div className="format-tabs" role="group" aria-label="剧种筛选">{(['', ...DRAMA_FORMATS] as DramaFormat[]).map(value => <button key={value || 'all'}
    className={format === value ? 'active' : ''} aria-pressed={format === value} disabled={disabled} onClick={() => onSelect(value)}>{value || '全部'}</button>)}</div>;
}

/**
 * One live board as a day, week or month view.
 * The whole period arrives in one request; search, topic filters, sorting and pages run in the browser.
 * Views are held per platform, board, period and date for this tab, and the platform's other boards for the same date load in the background.
 */
export function BoardPeriodPanel({ platform, board, format = '', boards, chips, period, onPeriod, date, onDate, version, cache, openDetail, notify, onChanged }: {
  platform: Platform; board: string; format?: DramaFormat; boards: string[]; chips: ReactNode;
  period: BoardPeriod; onPeriod: (period: BoardPeriod) => void; date: string; onDate: (date: string) => void;
  version: number; cache: CatalogDisplayCache; openDetail: (id: string, board?: string) => void; notify: Notify; onChanged: () => void;
}) {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<'rank' | 'rising'>('rank');
  const [page, setPage] = useState(1);
  const [comparing, setComparing] = useState(false);
  const query = periodQuery(platform, board, period, date);
  const snapshot = cache.period(query);
  const view = snapshot?.value ?? null;
  const ready = Boolean(view && snapshot?.version === version);
  useEffect(() => { setPage(1); setComparing(false); }, [query]);
  useEffect(() => { setPage(1); setTag(''); }, [format]);
  useEffect(() => {
    if (cache.period(query)?.version === version) { setLoading(false); setError(''); return; }
    let cancelled = false;
    setLoading(true); setError('');
    loadPeriod(cache, query, version).then(() => { if (!cancelled) rerender(); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cache, query, version, retry]);
  const dayListQuery = boardDaysQuery(platform, board);
  const dayList = cache.boardDays(dayListQuery);
  const [daysError, setDaysError] = useState('');
  useEffect(() => {
    if (cache.boardDays(dayListQuery)?.version === version) return;
    let cancelled = false;
    setDaysError('');
    loadDays(cache, dayListQuery, version).then(() => { if (!cancelled) rerender(); })
      .catch((reason: Error) => { if (!cancelled) setDaysError(reason.message); });
    return () => { cancelled = true; };
  }, [cache, dayListQuery, version, retry]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const others = boards.filter(value => value !== board).slice(0, PREFETCH_LIMIT);
    const timer = setTimeout(async () => {
      for (const other of others) {
        if (cancelled) return;
        const otherQuery = periodQuery(platform, other, period, date);
        try {
          if (cache.period(otherQuery)?.version !== version) await loadPeriod(cache, otherQuery, version);
          if (cache.boardDays(boardDaysQuery(platform, other))?.version !== version) await loadDays(cache, boardDaysQuery(platform, other), version);
        } catch (_error) { /* A failed background read leaves that board to load, and report, when it is chosen. */ }
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cache, ready, platform, board, boards, period, date, version]);

  const filteringFormat = filtersFormat(board, format);
  const items = useMemo(() => {
    const all = view?.items ?? [];
    return filteringFormat ? all.filter(item => item.work.tags.includes(format)) : all;
  }, [view, filteringFormat, format]);
  const needle = search.trim().toLocaleLowerCase();
  const searched = useMemo(() => needle ? items.filter(item => [item.work.title ?? '', item.work.author ?? '', item.work.sourceId].join(' ').toLocaleLowerCase().includes(needle)) : items, [items, needle]);
  const facets = useMemo(() => buildTopicFacets(searched.map(item => item.work)), [searched]);
  const filtered = tag ? searched.filter(item => tag === 'unclassified' ? !item.work.topics?.length : item.work.topics?.some(topic => topic.id === tag)) : searched;
  const rows: BoardPeriodItem[] = period === 'day' && sort === 'rising'
    ? [...filtered].sort((a, b) => (b.work.rankChange ?? -Infinity) - (a.work.rankChange ?? -Infinity) || (a.position ?? Infinity) - (b.position ?? Infinity))
    : filtered;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shownPage = Math.min(page, pageCount);
  const pageRows = rows.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE);

  const collected = dayList?.value.days ?? [];
  const anchor = date || view?.date || '';
  const range = anchor ? periodRange(period, anchor) : null;
  const earlier = range ? collected.find(day => day.date < range.start) : undefined;
  const later = range ? [...collected].reverse().find(day => day.date > range.end) : undefined;
  const uncollectedDay = period === 'day' && Boolean(view && !view.days.length);
  const distance = (day: { date: string }) => anchor ? Math.abs(Date.parse(day.date) - Date.parse(anchor)) : 0;
  const nearest = [...collected].sort((a, b) => distance(a) - distance(b) || a.date.localeCompare(b.date))[0];
  const today = view?.days.at(-1);
  const restored = snapshot?.version === -1;
  const metricColumns = platformMetricColumns[platform];
  const daily = period === 'day';
  const latestDay = collected[0]?.date;
  const exportQuery = new URLSearchParams({ origin: 'live', platform, board });
  if (today && latestDay && today.date !== latestDay) exportQuery.set('at', today.observedAt);

  const subtitle = !view ? (error ? '' : '正在读取榜单…')
    : daily ? (today ? `北京时间 ${view.date} 最后一次采集（${timeFormat.format(new Date(today.observedAt))}）· ${view.previous ? `排名变化对比前一天（${view.previous.date}）最后一次采集` : '前一天未采集，不计算排名变化'}` : `${view.date} 当天未采集`)
      : `${view.start} 至 ${view.end} · 覆盖 ${view.days.length}/${view.daysInPeriod} 天`;
  const formatNote = filteringFormat ? `只显示${format}，${daily ? '名次' : '本站排名'}沿用${board}全部剧种的排名` : '';
  return <div className="board-period" data-testid="board-period">
    <div className="board-hero" data-testid="board-hero">
      <div className="board-hero-heading">
        <span className={`collector-logo logo-${platform}`} aria-hidden="true">{PLATFORM_GLYPHS[platform]}</span>
        <div><h3>{PLATFORM_LABELS[platform]} · {boardDisplayName(board)}<span className="period-badge">{PERIOD_LABELS[period]}</span>{!daily && <span className="computed-badge">本站按日榜计算，非平台官方</span>}</h3><p data-testid="board-subtitle">{subtitle}</p>{formatNote && <p className="format-note" data-testid="format-note">{formatNote}</p>}</div>
      </div>
      <div className="board-hero-controls">
        <div className="segmented period-tabs" role="group" aria-label="榜单周期">{(Object.keys(PERIOD_LABELS) as BoardPeriod[]).map(value => <button key={value} className={period === value ? 'active' : ''} aria-pressed={period === value} onClick={() => onPeriod(value)}>{PERIOD_LABELS[value]}</button>)}</div>
        <form className="board-search" role="search" onSubmit={event => { event.preventDefault(); setPage(1); }}>
          <Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索本榜单" placeholder={`搜索本榜单${platform === 'hongguo' ? '剧名' : '书名'} / 作者`} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
          <button className="button button-primary" type="submit">搜索</button>
        </form>
        <div className="board-date">
          <label htmlFor="board-date"><CalendarDays size={14} />统计日期</label>
          <button className="icon-button" aria-label={`上一个${PERIOD_UNITS[period]}`} disabled={!earlier} onClick={() => earlier && onDate(earlier.date)}><ChevronLeft size={15} /></button>
          <input id="board-date" type="date" value={anchor} min={collected.at(-1)?.date} max={collected[0]?.date} onChange={event => { if (event.target.value) onDate(event.target.value); }} />
          <button className="icon-button" aria-label={`下一个${PERIOD_UNITS[period]}`} disabled={!later} onClick={() => later && onDate(later.date)}><ChevronRight size={15} /></button>
          {uncollectedDay && <span className="uncollected-note">当天未采集</span>}
          {daysError && <span className="uncollected-note">采集日期暂时无法读取</span>}
        </div>
      </div>
      {chips}
    </div>
    {comparing && view?.previous && today ? <BoardComparisonView platform={platform} board={board} from={view.previous.observedAt} to={today.observedAt} version={version} onClose={() => setComparing(false)} openDetail={openDetail} /> : <>
      {view && view.days.length > 0 && <TopicFilters groups={facets.groups} selected={tag} onSelect={id => { setTag(id); setPage(1); }} />}
      <div className="catalog-toolbar"><span className="muted small">当前筛选 {view ? rows.length : '—'} 部作品{!daily && view && ` · ${view.start} 至 ${view.end}`}</span><div className="toolbar-right">
        {daily && view?.previous && today && <button className="button button-outline" onClick={() => setComparing(true)}><GitCompareArrows size={13} />对比前一天</button>}
        {daily && <><span className="muted small">排序</span><select aria-label="作品排序" value={sort} onChange={event => { setSort(event.target.value as 'rank' | 'rising'); setPage(1); }}><option value="rank">官方名次</option><option value="rising">排名上升</option></select></>}
        {daily && today && <a className="button button-outline export-button" href={applicationUrl(`/api/export?${exportQuery}`)} download><ArrowDownToLine size={15} />导出清单</a>}
      </div></div>
      {view && <div className="catalog-freshness" data-testid="catalog-freshness" aria-live="polite"><span>{error ? `更新暂未完成，已保留上次结果：${error}` : loading ? '正在后台核对本站结果，当前内容可继续查看' : '已读取本站最新结果'}{restored && snapshot && ` · 页面保存于 ${dateText(new Date(snapshot.savedAt).toISOString(), true)}`}</span><button className="button button-outline" onClick={onChanged} aria-label="刷新榜单数据"><RefreshCw size={13} />刷新数据</button></div>}
      {error && !view ? <Empty title="暂时无法加载榜单" description={error} action={<button className="button button-soft" onClick={() => setRetry(value => value + 1)}>重新加载</button>} />
        : !view ? <Loading />
          : !view.days.length ? <Empty title={daily ? '当天未采集' : `本${period === 'week' ? '周' : '月'}未采集`} description="本站不补造未采集日期的数据，可选择其他日期。" action={nearest && nearest.date !== anchor ? <button className="button button-soft" onClick={() => onDate(nearest.date)}>查看最近采集日（{nearest.date}）</button> : undefined} />
            : !rows.length ? <Empty title="没有找到匹配的作品" description="试试其他关键词或题材，或切换榜单与日期。" />
              : <div className="table-scroll" aria-busy={loading}><table className="work-table"><thead><tr>
                <th className="rank-cell">{daily ? '官方名次' : '本站排名'}</th><th>作品</th>
                {!daily && <><th className="rank-cell">上榜天数</th><th className="rank-cell">平均名次</th><th className="rank-cell">最高名次</th></>}
                {metricColumns.map(column => <th className="metric-cell" key={column.key}>{column.label}</th>)}
                {daily && <th className="change-cell">排名变化</th>}
                <th className="script-cell">剧本</th>{(platform === 'fanqie' || platform === 'qimao') && <th className="script-cell">原小说</th>}
              </tr></thead><tbody>{pageRows.map(item => <tr key={item.work.id} data-testid="work-row">
                <td className={`rank-cell rank-${item.position && item.position < 4 ? item.position : 'other'}`}>{rankText(item.position)}</td>
                <td><WorkLink work={item.work} onOpen={() => openDetail(item.work.id, board)} /></td>
                {!daily && <><td className="rank-cell">{item.daysOnBoard}</td><td className="rank-cell">{averageText(item.averageRank)}</td><td className="rank-cell">{item.bestRank === null ? '名次未知' : item.bestRank}</td></>}
                {metricColumns.map(column => <td className="metric-cell" key={column.key}><strong>{column.read(item.work)}</strong>{!daily && <small>{monthDay(item.lastDate)}数据</small>}</td>)}
                {daily && <td className="change-cell"><RankChange change={item.work.rankChange} /></td>}
                <td className="script-cell"><ScriptOrTranscribe work={item.work} pending={restored} notify={notify} onChanged={onChanged} /></td>
                {(platform === 'fanqie' || platform === 'qimao') && <td className="script-cell"><OriginalDownload work={item.work} pending={restored} notify={notify} /></td>}
              </tr>)}</tbody></table></div>}
      <div className="table-footer"><span><span className="tiny-dot" />{daily ? '真实采集 · 当天最后一次采集' : '本站按日榜计算，非平台官方 · 指标取作品在本期最后上榜日的数据'}</span><div className="pagination"><span>{rows.length} 部作品</span><button className="icon-button" aria-label="上一页" disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)}><ChevronLeft size={15} /></button><span className="page-number">{shownPage}</span><button className="icon-button" aria-label="下一页" disabled={shownPage >= pageCount} onClick={() => setPage(shownPage + 1)}><ChevronRight size={15} /></button></div></div>
    </>}
  </div>;
}
