import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Film, LoaderCircle, RefreshCw, Search, Zap } from 'lucide-react';
import { JOB_STATE_LABELS, type DouyinTopicCheck, type HitBoard as HitBoardData, type HitBoardFilter, type HitBoardItem, type TranscriptionJob } from '../shared/hits';
import { request } from './api';
import { compact, dateText, Empty, Loading } from './components';
import { ScriptDownload } from './ScriptDownload';

type Notify = (message: string, error?: boolean) => void;

const filters: { id: HitBoardFilter; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'script', label: '有剧本' }, { id: 'active', label: '转写中' },
  { id: 'queued', label: '排队中' }, { id: 'failed', label: '失败 / 待处理' }, { id: 'rejected', label: '复核淘汰' },
];
const laneLabels = { manual: '立即转写', new: '新上榜', backlog: '储备' } as const;
const PAGE_SIZE = 30;
const SEARCH_DELAY_MS = 250;

function stateClass(job: TranscriptionJob | null): string {
  if (!job) return '';
  if (job.state === 'published') return ' state-success';
  if (job.state === 'failed' || job.state === 'needs-attention' || job.state === 'rejected') return ' state-failed';
  if (job.state === 'queued') return '';
  return ' state-running';
}

/** Pipeline stage with episode progress, e.g. 转写中 第 12/65 集. */
function Stage({ item }: { item: HitBoardItem }) {
  const { job } = item;
  if (!job) return <span className="state-pill" data-testid="hit-state"><span />候选</span>;
  const progress = job.progress;
  const episodes = progress?.episode != null && progress.totalEpisodes ? `第 ${progress.episode}/${progress.totalEpisodes} 集` : null;
  const percent = progress?.episode != null && progress.totalEpisodes ? Math.round(progress.episode / progress.totalEpisodes * 100) : null;
  return <div className="hit-stage"><span className={`state-pill${stateClass(job)}`} data-testid="hit-state">{['downloading', 'transcribing', 'checking'].includes(job.state) ? <LoaderCircle size={12} className="spin" /> : <span />}{JOB_STATE_LABELS[job.state]}{episodes && job.state !== 'published' && <> · {episodes}</>}</span>
    {percent !== null && job.state === 'transcribing' && <div className="hit-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>}
    {(job.state === 'failed' || job.state === 'needs-attention') && job.lastError && <small className="hit-error" title={job.lastError.reason}>{job.lastError.reason}</small>}
    {job.state === 'rejected' && job.review && <small className="hit-review" data-testid="hit-review" title={job.review.reason}>复核理由：{job.review.reason}</small>}
    {progress?.message && !['published', 'failed', 'needs-attention'].includes(job.state) && <small className="muted">{progress.message}</small>}
  </div>;
}

/** The Douyin topic gate: views of the exact-name topic, or why it is missing, with a search link and a way to set the topic by hand. */
function DouyinTopic({ check, title, onSet }: { check: DouyinTopicCheck | null; title: string | null; onSet: () => void }) {
  const search = title ? `https://www.douyin.com/search/${encodeURIComponent(title)}?type=general` : null;
  if (!check) return <span className="muted small">未检查</span>;
  const topic = check.hashtagId ? `https://www.douyin.com/hashtag/${check.hashtagId}` : null;
  const label = check.state === 'pass' || check.state === 'below' ? `${compact(check.viewCount)} 播放` : check.state === 'not_found' ? '没有同名话题' : '查询失败';
  return <div className="hit-topic" data-testid="hit-topic">
    <span className={`hit-topic-${check.state}`}>{topic ? <a href={topic} target="_blank" rel="noreferrer noopener">#{check.topicName ?? title} · {label}</a> : label}</span>
    {check.state === 'error' && check.error && <small className="hit-error" title={check.error}>{check.error}</small>}
    {check.manual && <small className="muted">人工指定</small>}
    {(check.state === 'not_found' || check.state === 'error' || check.state === 'below') && <span className="hit-topic-actions">{search && <a href={search} target="_blank" rel="noreferrer noopener">去抖音找</a>}<button className="text-button" onClick={onSet}>指定话题</button></span>}
  </div>;
}

/** Links to the public TOS source videos: the manifest and each episode. */
function Videos({ job }: { job: TranscriptionJob | null }) {
  const videos = job?.videos;
  if (!videos) return <span className="muted small">—</span>;
  const episodes = videos.objects.filter(object => object.kind === 'video');
  return <details className="hit-videos"><summary><Film size={13} />原片 {episodes.length} 个</summary>
    <div><a href={videos.manifest.url} target="_blank" rel="noreferrer">清单 manifest.json<ExternalLink size={12} /></a>
      {episodes.map(object => <a key={object.key} href={object.url} target="_blank" rel="noreferrer">{object.key.split('/').at(-1)}<ExternalLink size={12} /></a>)}</div>
  </details>;
}

/** 储备看板: every drama the loop selected, its transcription stage, and downloads for finished scripts and source videos. */
export function HitBoard({ version, notify, onChanged, openDetail }: { version: number; notify: Notify; onChanged: () => void; openDetail: (id: string) => void }) {
  const [filter, setFilter] = useState<HitBoardFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [board, setBoard] = useState<HitBoardData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [rushing, setRushing] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // An IME (pinyin) composition is not a query yet; searching it would start a slow board read per keystroke.
  const [composing, setComposing] = useState(false);
  const loadingRef = useRef(true);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => { const next = search.trim(); if (next !== query) { setQuery(next); setPage(1); } }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, query, composing]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    loadingRef.current = true;
    request<HitBoardData>(`/api/hits/board?filter=${filter}&page=${page}&limit=${PAGE_SIZE}${query ? `&q=${encodeURIComponent(query)}` : ''}`, { signal: controller.signal })
      .then(value => { if (!cancelled) { setBoard(value); setError(''); } })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => { if (!cancelled) { setLoading(false); loadingRef.current = false; } });
    return () => { cancelled = true; controller.abort(); };
  }, [filter, query, page, version, tick]);
  useEffect(() => {
    // Refresh only when the previous read finished, so a slow board never queues reads behind each other.
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !loadingRef.current) setTick(value => value + 1); }, 30_000);
    return () => clearInterval(timer);
  }, []);
  const rush = async (item: HitBoardItem) => {
    setRushing(item.work.id);
    try { await request(`/api/hits/${encodeURIComponent(item.work.id)}/rush`, { method: 'POST', body: '{}' }); notify(`「${item.work.title ?? item.work.sourceId}」已排到队首`); setTick(value => value + 1); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '操作失败', true); }
    finally { setRushing(null); }
  };
  const setTopic = async (item: HitBoardItem) => {
    const input = window.prompt(`「${item.work.title ?? item.work.sourceId}」的抖音话题编号（话题页地址 douyin.com/hashtag/ 后面的数字）`);
    const hashtagId = input?.trim().match(/(\d{6,32})/)?.[1];
    if (!hashtagId) return;
    try { const check = await request<DouyinTopicCheck>(`/api/hits/${encodeURIComponent(item.work.id)}/douyin-topic`, { method: 'POST', body: JSON.stringify({ hashtagId }) }); notify(`已指定话题：${compact(check.viewCount)} 播放`); setTick(value => value + 1); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '指定话题失败', true); }
  };
  const summary = board?.summary;
  const tiles: [string, string, string][] = summary ? [
    ['剧本储备', String(summary.stock), '部红果剧已有剧本'],
    ['今日新增', String(summary.addedToday), '北京时间今天上架'],
    ['平均出稿', summary.averageHoursToDownload === null ? '—' : `${summary.averageHoursToDownload} 小时`, `入选到可下载，近 ${summary.averageWindowDays} 天`],
    ['失败 / 待处理', String(summary.failures), `复核淘汰 ${summary.rejected} · 排队 ${summary.queued} · 转写中 ${summary.active}`],
  ] : [];
  return <section className="panel hit-board" data-testid="hit-board">
    <div className="panel-heading"><div><h2>储备看板{board && <span className="count-badge">{board.total}</span>}</h2>
      <p>{board ? `自动入选：红果收藏超过 ${compact(board.rules.minCollection)}、${board.rules.requireDouyinPlays ? `抖音同名话题播放超过 ${compact(board.rules.minDouyinPlays)}、` : ''}题材下沉、${board.rules.requireCompleted ? '已完结、' : ''}${board.rules.excludeConfirmedIp ? '没有对应番茄 IP' : ''}；疑似 IP 照常转写并标注。` : '红果爆款剧的自动转写进度与剧本下载。'}</p></div>
      <button className="button button-outline" onClick={() => { setTick(value => value + 1); onChanged(); }}><RefreshCw size={14} />刷新</button></div>
    {summary && <dl className="hit-summary" data-testid="hit-summary">{tiles.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd>{value}</dd><small>{note}</small></div>)}</dl>}
    {board && <p className="hit-selection muted small">选片：{board.selection.message}{board.selection.lastSuccessAt && ` · ${dateText(board.selection.lastSuccessAt, true)}`}</p>}
    <div className="hit-filters"><div className="board-chips" role="group" aria-label="看板筛选">{filters.map(item => <button key={item.id} className={`board-chip${filter === item.id ? ' active' : ''}`} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setPage(1); }}>{item.label}</button>)}</div>
      <label className="board-search hit-search">{loading && query ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}<input type="search" data-testid="hit-search" aria-label="搜索储备看板" placeholder="剧名或红果编号" maxLength={100} value={search}
        onChange={event => setSearch(event.target.value)} onCompositionStart={() => setComposing(true)}
        onCompositionEnd={event => { setComposing(false); setSearch(event.currentTarget.value); }}
        onKeyDown={event => { if (event.key === 'Escape' && !composing) setSearch(''); }} /></label></div>
    {error && board && <div className="facet-error" role="alert">看板更新暂未完成：{error}<button onClick={() => setTick(value => value + 1)}>重试</button></div>}
    {!board ? (error ? <Empty title="看板暂时无法读取" description={error} action={<button className="button button-soft" onClick={() => setTick(value => value + 1)}>重试</button>} /> : <Loading />)
      : !board.items.length ? (query ? <Empty title={`没有找到「${query}」`} description="换个剧名或红果编号试试。" /> : <Empty title={filter === 'script' ? '还没有剧本' : '这个筛选下没有作品'} description="符合条件的红果剧会自动进入排队，转写完成后可在这里下载剧本。" />)
      : <div className="table-scroll" aria-busy={loading}><table className="work-table hit-table"><thead><tr><th>作品</th><th className="metric-cell">收藏</th><th>抖音话题</th><th>进度</th><th>入选</th><th className="script-cell">剧本</th><th>原片</th><th /></tr></thead><tbody>
        {board.items.map(item => {
          const { work, job, evaluation } = item;
          const canRush = !job || ['queued', 'failed', 'needs-attention', 'rejected'].includes(job.state);
          return <tr key={work.id} data-testid="hit-row">
            <td><button className="work-link hit-work" onClick={() => openDetail(work.id)}><span className="work-copy"><strong>{work.title ?? `来源 ID：${work.sourceId}`}</strong>
              <span className="hit-badges">{job && <small className="hit-lane">{laneLabels[job.lane]}</small>}{evaluation?.ip.level === 'suspected' && <small className="hit-ip" title={evaluation.ip.reasons.join('；')}>疑似 IP · 《{evaluation.ip.fanqieTitle}》</small>}{evaluation?.ip.level === 'confirmed' && <small className="hit-ip" title={evaluation.ip.reasons.join('；')}>番茄 IP</small>}{evaluation?.sink.directions.slice(0, 2).map(direction => <small key={direction}>{direction}</small>)}</span>
              <span>{work.episodeCount === null ? '集数待补充' : `${work.episodeCount}集`}{evaluation?.completion === 'completed' ? ' · 已完结' : evaluation?.completion === 'serial' ? ' · 连载' : ''}</span></span></button></td>
            <td className="metric-cell"><strong>{compact(evaluation?.collection?.value)}</strong></td>
            <td><DouyinTopic check={evaluation?.douyin ?? null} title={work.title} onSet={() => void setTopic(item)} /></td>
            <td><Stage item={item} /></td>
            <td><span className="small">{dateText(job?.qualifiedAt ?? evaluation?.evaluatedAt, true)}</span>{job?.publishedAt && <div className="work-observed">出稿 {dateText(job.publishedAt, true)}</div>}</td>
            <td className="script-cell"><ScriptDownload script={item.script} notify={notify} onChanged={onChanged} /></td>
            <td><Videos job={job} /></td>
            <td>{canRush && <button className="button button-outline hit-rush" disabled={rushing !== null || Boolean(job?.rushAt && job.state === 'queued')} onClick={() => void rush(item)} aria-label={`立即转写${work.title ?? work.sourceId}`}><Zap size={13} />{job?.rushAt && job.state === 'queued' ? '已在队首' : rushing === work.id ? '提交中…' : '立即转写'}</button>}</td>
          </tr>;
        })}</tbody></table></div>}
    {board && <div className="table-footer"><span>数据来自转写工人写回的进度；原片存放在公开的 TOS 目录。</span><div className="pagination"><span>{board.total} 部</span><button className="icon-button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} /></button><span className="page-number">{page}</span><button className="icon-button" aria-label="下一页" disabled={page * PAGE_SIZE >= board.total || loading} onClick={() => setPage(value => value + 1)}><ChevronRight size={15} /></button></div></div>}
  </section>;
}
