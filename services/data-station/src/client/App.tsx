import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownToLine,
  CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  LoaderCircle, RefreshCw, Search, X,
} from 'lucide-react';
import { COLLECTED_LIBRARY, DATA_PLATFORMS, PLATFORM_GLYPHS, PLATFORM_LABELS, type BoardPeriod, type CatalogResponse, type CollectorStatus, type Platform, type SessionInfo, type TopicFacets, type Work } from '../shared/types';
import { advanceRequestIdentity, AUTH_RECHECK_EVENT, AUTH_REJECTED_EVENT, request } from './api';
import { CatalogDisplayCache, catalogStorage, type BoardDirectory } from './catalog-display-cache';
import { dateText, Empty, Loading, OriginBadge, PlatformBadge, WorkLink } from './components';
import { Detail } from './Detail';
import { Bookshelf } from './Bookshelf';
import { ScriptOrTranscribe } from './Transcribe';
import { OriginalDownload } from './OriginalDownload';
import { platformMetricColumns } from './platform-metrics';
import { DiscoveryPanel } from './DiscoveryPanel';
import { BoardPeriodPanel, FormatTabs, boardChipLabel, boardForFormat, formatBoards, orderBoardChips, type DramaFormat } from './BoardPeriod';
import { TopicFilters } from './TopicFilters';
import { applicationUrl } from './url';
import { readPageBootstrap, seedDisplayCache, sessionSchema } from './page-bootstrap';
import { MetricRefreshPanel } from './MetricRefreshPanel';
import { LvpaopaoPanel, LvpaopaoStatusBar } from './Lvpaopao';
import { DouyinSearchPanel } from './DouyinSearchAdmin';
import { HitBoard } from './HitBoard';
import { DouyinSearch } from './DouyinSearch';
import { metricsMeasuredAt } from '../shared/metrics';

type View = 'overview' | 'hits' | 'bookshelf' | 'collectors';
type Notify = (text: string, error?: boolean) => void;
type ScheduledCollector = CollectorStatus & { nextRunAt?: string | null; intervalHours?: number };
const navigation: { id: View; label: string }[] = [
  { id: 'overview', label: '作品数据' },
  { id: 'hits', label: '储备看板' },
  { id: 'bookshelf', label: '我的书架' },
  { id: 'collectors', label: '采集管理' },
];
const collectionLabels: Record<CollectorStatus['state'], string> = { idle: '待采集', running: '采集中', success: '已更新', failed: '采集失败', not_configured: '待接入' };

/** States when a row's metrics were measured; catalog-only works without readings wait for the scheduled detail-page refresh. */
function metricsTime(work: Work): string {
  const measured = metricsMeasuredAt(work);
  return measured ? `指标更新于 ${dateText(measured, true)}` : '指标待自动采集';
}

/** Board choice as chips, or a list when a platform has too many boards for one row of chips. */
function BoardChips({ boards, board, disabled, onSelect }: { boards: string[]; board: string | null; disabled: boolean; onSelect: (board: string) => void }) {
  if (boards.length > 16) return <div className="board-chips"><label className="board-chips-label" htmlFor="active-board">榜单</label><select id="active-board" className="board-select" aria-label="榜单筛选" value={board ?? ''} disabled={disabled || board === null} onChange={event => onSelect(event.target.value)}>{board === null && <option value="">正在读取榜单…</option>}{boards.map(value => <option key={value}>{value}</option>)}<option value={COLLECTED_LIBRARY}>全部收录（持续扩充）</option></select></div>;
  return <div className="board-chips" role="group" aria-label="榜单筛选"><span className="board-chips-label">榜单</span>
    {board === null && <span className="muted small">正在读取榜单…</span>}
    {orderBoardChips(boards).map(value => <button key={value} className={`board-chip${board === value ? ' active' : ''}`} title={value} aria-pressed={board === value} disabled={disabled} onClick={() => onSelect(value)}>{boardChipLabel(value)}</button>)}
    {board !== null && <button className={`board-chip${board === COLLECTED_LIBRARY ? ' active' : ''}`} aria-pressed={board === COLLECTED_LIBRARY} disabled={disabled} onClick={() => onSelect(COLLECTED_LIBRARY)}>全部收录</button>}
  </div>;
}

/**
 * Platform choice of 作品数据: 抖音搜索 first, then the collected platforms with 绿泡泡短剧 beside 红果短剧.
 * Douyin is live search through DTK, not a collected platform, so choosing it shows the search instead of a catalog.
 */
function PlatformTabs({ platform, douyin, onPlatform, onDouyin }: { platform: Platform; douyin: boolean; onPlatform: (value: Platform) => void; onDouyin: () => void }) {
  const tab = (key: string, label: string, active: boolean, dot: string, onClick: () => void) => <button key={key} className={active ? 'active' : ''} aria-pressed={active} onClick={onClick}><span className={`platform-dot dot-${dot}`} />{label}</button>;
  return <div className="platform-tabs" aria-label="平台筛选">
    {tab('douyin-search', '抖音搜索', douyin, 'douyin', onDouyin)}
    {DATA_PLATFORMS.map(value => tab(value, PLATFORM_LABELS[value], !douyin && platform === value, value, () => onPlatform(value)))}
  </div>;
}

function Catalog({ platform, tabs, search, version, openDetail, notify, onChanged, cache }: {
  platform: Platform; tabs: ReactNode;
  search: string; version: number; openDetail: (id: string, board?: string) => void; notify: Notify; onChanged: () => void; cache: CatalogDisplayCache;
}) {
  const selected = useRef(cache.selection(platform)).current;
  const directory = cache.directory(platform)?.value;
  const [snapshot, setSnapshot] = useState<{ query: string; value: CatalogResponse; savedAt: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tag, setTag] = useState(selected?.tag ?? '');
  const [facetSnapshot, setFacetSnapshot] = useState<{ query: string; value: TopicFacets } | null>(null);
  const [facetError, setFacetError] = useState('');
  const [sort, setSort] = useState(selected?.sort ?? (platform === 'douyin' ? 'plays' : 'rank'));
  const [page, setPage] = useState(selected?.page ?? 1);
  const [board, setBoard] = useState<string | null>(selected?.board || directory?.defaultBoard || (directory ? COLLECTED_LIBRARY : null));
  const boardRef = useRef(board);
  boardRef.current = board;
  const [boards, setBoards] = useState<string[]>(directory?.boards ?? []);
  const [boardError, setBoardError] = useState('');
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState<BoardPeriod>(selected?.period ?? 'day');
  const [date, setDate] = useState('');
  const [format, setFormat] = useState<DramaFormat>(platform === 'hongguo' ? selected?.format ?? '' : '');
  const monitoring = platform === 'douyin';
  const searching = Boolean(search.trim());
  const library = board === COLLECTED_LIBRARY;
  const ranking = !monitoring && !searching && !library;
  const listing = board !== null && !ranking;
  const effectiveSort = (searching || library) && !monitoring ? 'recent' : sort;
  const selectBoard = (value: string) => { setBoard(value); setTag(''); setPage(1); };
  useEffect(() => {
    let cancelled = false;
    setBoardError('');
    request<BoardDirectory>(`/api/boards?platform=${platform}`).then(value => {
      if (cancelled) return;
      cache.saveDirectory(platform, value);
      setBoards(value.boards);
      const current = boardRef.current;
      const next = current && (current === COLLECTED_LIBRARY || value.boards.includes(current)) ? current : value.defaultBoard ?? COLLECTED_LIBRARY;
      if (current !== next) selectBoard(next);
    }).catch((reason: Error) => { if (!cancelled) setBoardError(reason.message); });
    return () => { cancelled = true; };
  }, [cache, platform, version, retry]);
  const previousSearch = useRef(search);
  useEffect(() => { if (previousSearch.current !== search) { setPage(1); previousSearch.current = search; } }, [search]);
  useEffect(() => { if (board !== null && !searching) cache.remember(platform, { board, page, tag, sort, period, ...(format ? { format } : {}) }); }, [cache, platform, board, page, tag, sort, period, format, searching]);
  const query = new URLSearchParams({ origin: 'live', sort: effectiveSort, page: String(page), limit: '10' });
  query.set('platform', platform);
  if (board && !searching && !library) query.set('board', board);
  if (search.trim()) query.set('q', search.trim());
  if (tag) query.set('tag', tag);
  const queryText = query.toString();
  const cached = listing ? cache.catalog(queryText) : null;
  const currentSnapshot = snapshot?.query === queryText ? snapshot : cached;
  const catalog = listing ? currentSnapshot?.value ?? null : null;
  const savedAt = currentSnapshot?.savedAt;
  const displayingSaved = Boolean(catalog && snapshot?.query !== queryText);
  useEffect(() => {
    if (!listing) return;
    let cancelled = false;
    setLoading(true); setError('');
    const timer = setTimeout(() => request<CatalogResponse>(`/api/works?${queryText}`).then(value => {
      if (cancelled) return;
      if (page > 1 && (page - 1) * value.limit >= value.total) { setPage(1); return; }
      const savedAt = cache.saveCatalog(queryText, value);
      setSnapshot({ query: queryText, value, savedAt });
    }).catch((reason: Error) => !cancelled && setError(reason.message)).finally(() => !cancelled && setLoading(false)), search ? 220 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cache, queryText, version, retry, search, listing, page]);
  const facetQuery = new URLSearchParams();
  facetQuery.set('platform', platform);
  if (board && !searching && !library) facetQuery.set('board', board);
  if (search.trim()) facetQuery.set('q', search.trim());
  const facetQueryText = facetQuery.toString();
  const facets = facetSnapshot?.query === facetQueryText ? facetSnapshot.value : cache.facet(facetQueryText)?.value ?? { groups: [] };
  useEffect(() => {
    if (!listing) return;
    let cancelled = false;
    setFacetError('');
    const timer = setTimeout(() => request<TopicFacets>(`/api/facets?${facetQueryText}`).then(value => {
      if (!cancelled) { cache.saveFacets(facetQueryText, value); setFacetSnapshot({ query: facetQueryText, value }); }
    }).catch((reason: Error) => { if (!cancelled) setFacetError(reason.message); }), search ? 220 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cache, facetQueryText, version, retry, search, listing]);
  const metricColumns = platformMetricColumns[platform];
  const formats = platform === 'hongguo' && ranking;
  const selectFormat = (value: DramaFormat) => { setFormat(value); if (board !== null) selectBoard(boardForFormat(board, value, boards)); };
  const shownBoards = formats ? formatBoards(boards, format) : boards;
  useEffect(() => {
    if (!formats || board === null || shownBoards.includes(board)) return;
    const next = boardForFormat(board, format, boards);
    if (next !== board) selectBoard(next);
  }, [formats, board, format, boards]);
  const chips = <>{formats && <FormatTabs format={format} disabled={searching} onSelect={selectFormat} />}<BoardChips boards={shownBoards} board={board} disabled={searching} onSelect={selectBoard} /></>;
  return <section className="panel catalog-panel">
    <div className="panel-heading"><div><h2>{searching ? '平台内搜索结果' : library ? `${PLATFORM_LABELS[platform]}作品库` : monitoring ? '抖音作品监测' : '作品榜单'}{listing && <span className="count-badge">{catalog?.total ?? '—'}</span>}</h2><p>{searching ? `搜索${PLATFORM_LABELS[platform]}的全部已采作品；清空关键词可返回所选榜单。` : library ? '查看持续发现与历史补采中已收录的全部作品' : monitoring ? '查看已采集的视频数据与来源' : '按日、周、月查看平台榜单；周榜与月榜由本站按日榜计算'}</p></div>{listing && <a className="button button-outline export-button" href={applicationUrl(`/api/export?${queryText}`)} download><ArrowDownToLine size={15} />导出清单</a>}</div>
    {tabs}
    {platform === 'lvpaopao' && <LvpaopaoStatusBar />}
    {ranking && board !== null ? <>
      {boardError && <div className="facet-error" role="alert">榜单目录更新暂未完成：{boardError}<button onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      <BoardPeriodPanel key={board} platform={platform} board={board} format={formats ? format : ''} boards={orderBoardChips(boards)} chips={chips} period={period} onPeriod={setPeriod} date={date} onDate={setDate} version={version} cache={cache} openDetail={openDetail} notify={notify} onChanged={onChanged} />
    </> : <>
    <div className="board-picker">{chips}<p>{searching ? '正在搜索当前平台的全部已采作品，清空关键词后恢复所选榜单。' : library ? '按最近观测展示该平台已收录的全部作品，包含目录补采和榜单历史；每条保留其实际来源与观测时间。' : monitoring ? '当前为所选创作者的公开视频监测，不代表抖音全站短剧榜。' : '正在读取该平台的榜单目录。'}</p></div>
    {facetError && <div className="facet-error" role="alert">题材更新暂时未完成：{facetError}<button onClick={() => setRetry(value => value + 1)}>重试</button></div>}<TopicFilters groups={facets.groups} selected={tag} onSelect={(id) => { setTag(id); setPage(1); }} />
    <div className="catalog-toolbar"><span className="muted small">当前筛选 {catalog?.total ?? '—'} 部作品{monitoring && ' · 视频粒度，非整剧榜单'}</span><div className="toolbar-right"><span className="muted small">排序</span><select aria-label="作品排序" value={effectiveSort} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(1); }}>{monitoring && <><option value="plays">本库播放排序</option><option value="published">视频发布时间</option></>}<option value="recent">最近采集</option></select></div></div>
    {catalog && <div className="catalog-freshness" data-testid="catalog-freshness" aria-live="polite"><span>{error || boardError ? `更新暂未完成，已保留上次结果：${error || boardError}` : loading ? '正在后台核对本站结果，当前内容可继续查看' : '已读取本站最新结果'}{savedAt && ` · 页面保存于 ${dateText(new Date(savedAt).toISOString(), true)}`}</span><button className="button button-outline" onClick={onChanged} aria-label="刷新榜单数据"><RefreshCw size={13} />刷新数据</button></div>}
    {(error || boardError) && !catalog ? <Empty title="暂时无法加载作品" description={error || boardError} action={<button className="button button-soft" onClick={() => setRetry((value) => value + 1)}>重新加载</button>} /> : board === null || loading && !catalog ? <Loading /> : !catalog?.items.length ? <Empty title={search ? '没有找到匹配的作品' : '这个筛选下还没有作品'} description={'试试其他关键词、平台或榜单，也可在采集管理中查看更新状态。'} /> : <div className="table-scroll" aria-busy={loading}><table className="work-table"><thead><tr><th>作品</th><th>{library ? '平台 / 来源' : monitoring ? '平台 / 数据范围' : '平台 / 榜单'}</th>{metricColumns.map(column => <th className="metric-cell" key={column.key}>{column.label}</th>)}<th className="script-cell">剧本</th>{(platform === 'fanqie' || platform === 'qimao') && <th className="script-cell">原小说</th>}</tr></thead><tbody>{catalog.items.map((work) => {
      return <tr key={work.id} data-testid="work-row"><td><WorkLink work={work} onOpen={() => openDetail(work.id, undefined)} /></td><td><PlatformBadge platform={work.platform} short /><div className="board-label">{work.board || '作品库'}<OriginBadge origin={work.origin} /></div><div className="work-observed">最后已知观测 {dateText(work.observedAt, true)}</div><div className="work-observed" data-testid="metrics-time">{metricsTime(work)}</div></td>{metricColumns.map(column => <td className="metric-cell" key={column.key}><strong>{column.read(work)}</strong></td>)}<td className="script-cell"><ScriptOrTranscribe work={work} pending={displayingSaved} notify={notify} onChanged={onChanged} /></td>{(platform === 'fanqie' || platform === 'qimao') && <td className="script-cell"><OriginalDownload work={work} pending={displayingSaved} notify={notify} /></td>}</tr>;
    })}</tbody></table></div>}
    <div className="table-footer"><span><span className="tiny-dot" />真实采集 · 仅覆盖已访问的榜单与目录</span><div className="pagination"><span>{catalog?.total || 0} 部作品</span><button className="icon-button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} /></button><span className="page-number">{page}</span><button className="icon-button" aria-label="下一页" disabled={!catalog || page * catalog.limit >= catalog.total || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={15} /></button></div></div>
    </>}
  </section>;
}

function Collectors({ statuses, refresh, notify }: { statuses: ScheduledCollector[]; refresh: () => void; notify: Notify }) {
  const [starting, setStarting] = useState<Platform | null>(null);
  const [intervalHours, setIntervalHours] = useState(6);
  const [savedHours, setSavedHours] = useState<number | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { let cancelled = false; request<{ intervalHours: number }>('/api/admin/settings').then(value => { if (!cancelled) { setIntervalHours(value.intervalHours); setSavedHours(value.intervalHours); } }).catch((error: Error) => !cancelled && setSettingsError(error.message)); return () => { cancelled = true; }; }, []);
  const saveSettings = async () => {
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) { setSettingsError('请输入 1–168 之间的整数小时'); return; }
    setSaving(true); setSettingsError('');
    try { const saved = await request<{ intervalHours: number }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ intervalHours }) }); setSavedHours(saved.intervalHours); setIntervalHours(saved.intervalHours); refresh(); notify('采集间隔已更新'); }
    catch (error) { setSettingsError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  const run = async (platform: Platform) => {
    setStarting(platform);
    try {
      await request(`/api/collectors/${platform}/run`, { method: 'POST', body: '{}' });
      refresh();
      notify(`${PLATFORM_LABELS[platform]}采集已启动`);
    } catch (error) { notify(error instanceof Error ? error.message : '启动采集失败', true); }
    finally { setStarting(null); }
  };
  return <>
    <div className="notice collector-notice"><Clock3 size={19} /><div><strong>{savedHours === null ? '正在读取自动采集配置' : `每 ${savedHours} 小时自动采集一次`}</strong><p>各平台独立更新，失败时保留上次成功数据。也可以按需手动刷新。</p></div></div>
    <section className="panel schedule-settings" aria-label="采集更新时间设置"><div><h2>自动采集间隔</h2><p>修改后将重新安排各平台的下次更新时间。</p></div><div className="schedule-controls"><label htmlFor="collection-interval">每</label><input id="collection-interval" type="number" min={1} max={168} step={1} value={intervalHours} onChange={event => setIntervalHours(Number(event.target.value))} aria-label="采集间隔小时" /><span>小时</span><button className="button button-primary" onClick={() => void saveSettings()} disabled={saving || savedHours === null || intervalHours === savedHours}>{saving ? '保存中…' : '保存采集间隔'}</button></div>{settingsError && <p className="settings-error" role="alert">{settingsError}</p>}</section>
    <div className="collectors-grid">{statuses.map((collector) => <article key={collector.platform} className="panel collector-card" data-testid={`collector-${collector.platform}`}>
      <div className="collector-card-top"><span className={`collector-logo logo-${collector.platform}`}>{PLATFORM_GLYPHS[collector.platform]}</span><span className={`state-pill state-${collector.state}`}><span />{collectionLabels[collector.state]}</span></div>
      <h2>{PLATFORM_LABELS[collector.platform]}</h2><p className="collector-description">{collector.coverage || '等待首次采集'}</p>
      <dl><div><dt>已采作品</dt><dd>{collector.count} 部</dd></div><div><dt>最近成功</dt><dd>{dateText(collector.lastSuccessAt, true)}</dd></div><div><dt>下次采集</dt><dd>{collector.nextRunAt ? dateText(collector.nextRunAt, true) : collector.state === 'running' ? '本次采集完成后安排' : '等待调度'}</dd></div></dl>
      <div className={`collector-message${collector.state === 'failed' ? ' message-error' : ''}`}>{collector.state === 'running' && <LoaderCircle size={14} className="spin" />}{collector.message || '等待首次采集'}</div>
      <button className="button button-primary collector-run" disabled={starting !== null || collector.state === 'running' || collector.state === 'not_configured'} onClick={() => void run(collector.platform)} aria-label={`立即采集${PLATFORM_LABELS[collector.platform]}`}><RefreshCw size={15} className={collector.state === 'running' ? 'spin' : ''} />{collector.state === 'running' ? '正在采集…' : starting === collector.platform ? '启动中…' : '立即采集'}</button>
    </article>)}</div>
    <p className="collection-scope-note">榜单覆盖范围以各平台采集结果为准。历史从实际观测开始积累，不补造过去的数据。</p>
    <DouyinSearchPanel notify={notify} />
    <LvpaopaoPanel notify={notify} />
    <DiscoveryPanel notify={notify} onPublished={refresh} />
    <MetricRefreshPanel notify={notify} />
  </>;
}

export function App() {
  const [view, setView] = useState<View>('overview');
  // The server renders the Muse header, which already names the account, only for Muse sign-in.
  const [museHeader] = useState(() => document.querySelector('.muse-site-bar') !== null);
  const [search, setSearch] = useState('');
  // The page embeds the confirmed account and its default board, so the first render shows data; the account is still re-confirmed below.
  const [initial] = useState(() => {
    const bootstrap = readPageBootstrap();
    if (!bootstrap) return null;
    const cache = new CatalogDisplayCache(catalogStorage(), window.location.origin, bootstrap.session);
    seedDisplayCache(cache, bootstrap, 0);
    return { session: bootstrap.session, cache };
  });
  const [platform, setPlatform] = useState<Platform>(initial?.cache.platform ?? 'hongguo');
  // 抖音搜索 is shown in place of a platform catalog; it is not a remembered platform choice.
  const [douyin, setDouyin] = useState(false);
  const [version, setVersion] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(initial?.session ?? null);
  const [displayCache, setDisplayCache] = useState<CatalogDisplayCache | null>(initial?.cache ?? null);
  const cacheRef = useRef<CatalogDisplayCache | null>(initial?.cache ?? null);
  const sessionSequence = useRef(0);
  const [authError, setAuthError] = useState('');
  const collectorsRef = useRef<ScheduledCollector[]>([]);
  const collectorsSequence = useRef(0);
  const [collectors, setCollectors] = useState<ScheduledCollector[]>([]);
  const [loadError, setLoadError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailBoard, setDetailBoard] = useState<string | undefined>();
  const openDetail = useCallback((id: string, board?: string) => { setDetailId(id); setDetailBoard(board); }, []);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const closeDetail = useCallback(() => setDetailId(null), []);
  const changeView = (next: View) => { setView(next); setSearch(''); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const rejectSession = useCallback(() => {
    advanceRequestIdentity();
    sessionSequence.current++;
    collectorsSequence.current++;
    cacheRef.current?.clear(); cacheRef.current = null;
    setDisplayCache(null); setSession(null); setCollectors([]); collectorsRef.current = [];
    setDetailId(null); setToast(null); setLoadError(''); setAuthError('当前账号或权限已变化，请重新确认账号后查看数据。');
  }, []);
  const verifySession = useCallback(async () => {
    const sequence = ++sessionSequence.current;
    try {
      const value = await request<SessionInfo>('/api/session');
      if (sequence !== sessionSequence.current) return;
      const identity = sessionSchema.safeParse(value);
      if (!identity.success) throw new Error('无法确认当前账号');
      const scope = JSON.stringify([window.location.origin, value.id, value.role]);
      if (cacheRef.current?.scope !== scope) {
        advanceRequestIdentity();
        cacheRef.current?.clear();
        const next = new CatalogDisplayCache(catalogStorage(), window.location.origin, value);
        cacheRef.current = next; setDisplayCache(next); setPlatform(next.platform);
        setView('overview'); setSearch(''); setDetailId(null); setToast(null);
        collectorsSequence.current++; collectorsRef.current = []; setCollectors([]);
      }
      setSession(value); setAuthError('');
    } catch (reason) {
      if (sequence !== sessionSequence.current) return;
      rejectSession();
      setAuthError(reason instanceof Error ? reason.message : '暂时无法确认当前账号');
    }
  }, [rejectSession]);
  useEffect(() => {
    const recheck = () => { void verifySession(); };
    const visible = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener(AUTH_REJECTED_EVENT, rejectSession);
    window.addEventListener(AUTH_RECHECK_EVENT, recheck);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', visible);
    void verifySession();
    return () => { sessionSequence.current++; window.removeEventListener(AUTH_REJECTED_EVENT, rejectSession); window.removeEventListener(AUTH_RECHECK_EVENT, recheck); window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', visible); };
  }, [verifySession, rejectSession]);
  const acceptCollectors = useCallback((sources: ScheduledCollector[]) => {
    const previous = collectorsRef.current;
    const published = sources.some(source => source.lastSuccessAt && previous.some(old => old.platform === source.platform && old.lastSuccessAt !== source.lastSuccessAt));
    collectorsRef.current = sources; setCollectors(sources);
    if (published) refresh();
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    if (session?.role !== 'admin') { setCollectors([]); return; }
    const sequence = ++collectorsSequence.current;
    request<ScheduledCollector[]>('/api/collectors').then(sources => {
      if (!cancelled && sequence === collectorsSequence.current) acceptCollectors(sources);
    }).catch((reason: Error) => { if (!cancelled && sequence === collectorsSequence.current) setLoadError(reason.message); });
    return () => { cancelled = true; };
  }, [version, session?.id, session?.role, acceptCollectors]);
  useEffect(() => { if (session && session.role !== 'admin' && view === 'collectors') setView('overview'); }, [session, view]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 4000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (session?.role !== 'admin' || !collectors.some(item => item.state === 'running')) return;
    let cancelled = false, pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      const sequence = ++collectorsSequence.current;
      request<ScheduledCollector[]>('/api/collectors').then(sources => {
        if (!cancelled && sequence === collectorsSequence.current) acceptCollectors(sources);
      }).catch((reason: Error) => { if (!cancelled && sequence === collectorsSequence.current) setLoadError(reason.message); }).finally(() => { pending = false; });
    }, 3500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session?.role, collectors, acceptCollectors]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); searchInput.current?.focus(); } };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  }, []);
  const platformTabs = displayCache ? <PlatformTabs platform={platform} douyin={douyin}
    onPlatform={value => { displayCache.remember(value); setPlatform(value); setDouyin(false); }} onDouyin={() => { setDouyin(true); setSearch(''); }} /> : null;
  const visibleNavigation = navigation.filter(item => item.id !== 'collectors' || session?.role === 'admin');
  return <div className="app-shell">
    <main className="content">
      <header className="page-heading"><div><h1>数据站</h1><p>跨平台榜单、作品详情与历史趋势</p></div>{!museHeader ? <div className="account"><strong>{session?.name || '正在确认账号'}</strong><span>{session?.department ?? (session?.mode === 'server' ? '独立账号访问' : session ? '本机访问' : '连接中')}</span></div>
        : session?.department ? <div className="account" data-testid="account-department"><strong>{session.name}</strong><span>{session.department}</span></div> : null}</header>
      <nav className="view-tabs" data-testid="view-navigation" aria-label="数据站页面">{visibleNavigation.map((item) => <button key={item.id} onClick={() => changeView(item.id)} aria-current={view === item.id ? 'page' : undefined}>{item.label}</button>)}</nav>
      {view === 'collectors' && session?.role === 'admin' ? <div className="view-heading"><p>设置更新频率，查看最近成功和下次采集时间。</p><button className="button button-outline" onClick={refresh}><RefreshCw size={14} />刷新状态</button></div> : view === 'overview' && !douyin ? <section className="data-search" aria-label="搜索作品库"><Search size={25} strokeWidth={1.65} /><input ref={searchInput} data-testid="global-search" aria-label="搜索作品" placeholder="搜索作品名、作者或关键词" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setSearch(''); }} />{search ? <button className="icon-button" aria-label="清空搜索" onClick={() => setSearch('')}><X size={21} /></button> : <kbd>⌘ K</kbd>}</section> : null}
      {loadError && <div className="notice notice-error" role="alert"><Activity size={17} /><span>读取数据失败：{loadError}</span><button onClick={refresh}>重试</button></div>}
      {!session && (authError ? <Empty title="暂时无法确认账号" description={authError} action={<button className="button button-soft" onClick={() => void verifySession()}>重新确认账号</button>} /> : <Loading />)}
      {view === 'overview' && session && displayCache && (douyin ? <DouyinSearch key={displayCache.scope} openDetail={openDetail} notify={notify} tabs={platformTabs} /> : <Catalog cache={displayCache} key={`${displayCache.scope}:${platform}`} platform={platform} tabs={platformTabs} search={search} version={version} openDetail={openDetail} notify={notify} onChanged={refresh} />)}
      {view === 'hits' && session && displayCache && <HitBoard key={displayCache.scope} version={version} notify={notify} onChanged={refresh} openDetail={openDetail} />}
      {view === 'bookshelf' && session && displayCache && <Bookshelf key={displayCache.scope} version={version} onChanged={refresh} openDetail={openDetail} notify={notify} />}
      {view === 'collectors' && session?.role === 'admin' && displayCache && <Collectors key={displayCache.scope} statuses={collectors} refresh={refresh} notify={notify} />}
      <footer className="page-footer"><span>Muse 数据站<span className="footer-separator">/</span>榜单 · 作品 · 趋势</span><span>数据以原平台为准 · 仅覆盖已采集范围</span></footer>
    </main>
    {detailId && session && displayCache && <Detail key={displayCache.scope} id={detailId} board={detailBoard} onClose={closeDetail} isAdmin={session?.role === 'admin'} notify={notify} onChanged={refresh} />}
    {toast && <div className={`toast${toast.error ? ' toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17} /> : <CheckCircle2 size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={14} /></button></div>}
  </div>;
}
