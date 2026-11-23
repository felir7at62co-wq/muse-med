import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ExternalLink, Layers, Link2, Search, UserRound } from 'lucide-react';
import type { DouyinAccount, DouyinMix, DouyinPage, DouyinPost, DouyinSearchStatus } from '../shared/douyin-search';
import { request } from './api';
import { compact, Empty, Loading } from './components';
import { DouyinDownloadLog, DownloadButton, MixDownloadButton, useDouyinDownloadStatus, usePostDownloads } from './DouyinDownloads';
import type { DouyinDownload } from '../shared/douyin-downloads';
import type { DouyinDownloadStatus } from '../shared/douyin-downloads';

type Notify = (text: string, error?: boolean) => void;
type Source = { type: 'posts' | 'accounts'; keyword: string } | { type: 'mix'; mix: DouyinMix };
type Item = DouyinPost | DouyinAccount;
type Results = { source: Source; items: Item[]; cursor: string | null; hasMore: boolean };

const day = (value: string | null): string => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) : '发布时间未知';
};
const duration = (ms: number | null): string | null => {
  if (!ms) return null;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const counted = (label: string, value: number | null): string => `${label} ${value === null ? '—' : compact(value)}`;

function episodeText(mix: DouyinMix): string {
  if (mix.episode && mix.episodes) return `第 ${mix.episode} 集 / 共 ${mix.episodes} 集`;
  if (mix.episodes) return `共 ${mix.episodes} 集`;
  return mix.episode ? `第 ${mix.episode} 集` : '';
}

function pageUrl(source: Source, cursor: string | null): string {
  const query = new URLSearchParams();
  if (source.type === 'mix') query.set('id', source.mix.id);
  else { query.set('type', source.type); query.set('q', source.keyword); }
  if (cursor) query.set('cursor', cursor);
  return `${source.type === 'mix' ? '/api/douyin/mix' : '/api/douyin/search'}?${query}`;
}

function PostRow({ post, inMix, openDetail, openMix, copy, downloads, record, notify, onRequested }: {
  post: DouyinPost; inMix: boolean; openDetail: (id: string) => void; openMix: (mix: DouyinMix) => void; copy: (url: string) => void;
  downloads: DouyinDownloadStatus | null; record: DouyinDownload | undefined; notify: Notify; onRequested: () => void;
}) {
  const length = duration(post.durationMs);
  return <article className="douyin-post" data-testid="douyin-post">
    <a className="douyin-cover" href={post.url} target="_blank" rel="noreferrer noopener" aria-label={`在抖音打开：${post.title || '作品'}`}>
      {post.coverUrl ? <img src={post.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span>抖音</span>}
      {length && <span className="douyin-duration">{length}</span>}
    </a>
    <div className="douyin-post-body">
      <a className="douyin-post-title" href={post.url} target="_blank" rel="noreferrer noopener">{post.title || post.description || '（作品没有标题）'}</a>
      <div className="douyin-meta"><span>{post.author.name || '作者未知'}</span><span>{day(post.createdAt)}</span><span>{counted('点赞', post.stats.likes)}</span><span>{counted('评论', post.stats.comments)}</span><span>{counted('收藏', post.stats.saves)}</span></div>
      {(post.mix || post.hongguo) && <div className="douyin-chips">
        {post.mix && (inMix ? <span className="douyin-chip"><Layers size={13} />{episodeText(post.mix) || '合集作品'}</span>
          : <button className="douyin-chip" onClick={() => openMix(post.mix!)} title="查看这个合集的全部作品"><Layers size={13} />合集「{post.mix.name || '未命名'}」{episodeText(post.mix) && ` · ${episodeText(post.mix)}`}</button>)}
        {post.hongguo && <button className="douyin-chip douyin-chip-hongguo" data-testid="hongguo-match" onClick={() => openDetail(post.hongguo!.workId)} title={`红果：${post.hongguo.title}`}>红果有{post.hongguo.episodeCount ? ` · 全 ${post.hongguo.episodeCount} 集` : ''}</button>}
      </div>}
    </div>
    <div className="douyin-actions">
      <a className="button button-outline" href={post.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />打开抖音</a>
      <button className="button button-outline" onClick={() => copy(post.url)}><Link2 size={14} />复制链接</button>
      <DownloadButton awemeId={post.id} record={record} status={downloads} notify={notify} onRequested={onRequested} />
    </div>
  </article>;
}

function AccountRow({ account }: { account: DouyinAccount }) {
  return <article className="douyin-account" data-testid="douyin-account">
    <span className="douyin-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <UserRound size={20} />}</span>
    <div className="douyin-post-body">
      <a className="douyin-post-title" href={account.url} target="_blank" rel="noreferrer noopener">{account.name || '未命名账号'}</a>
      <div className="douyin-meta">{account.handle && <span>抖音号 {account.handle}</span>}<span>{counted('粉丝', account.followers)}</span><span>{counted('作品', account.posts)}</span></div>
      {account.signature && <p className="douyin-signature">{account.signature}</p>}
    </div>
    <div className="douyin-actions"><a className="button button-outline" href={account.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />打开主页</a></div>
  </article>;
}

/** Douyin keyword search for members, with series listing and Hongguo matches that open the station's work detail. */
export function DouyinSearch({ openDetail, notify, tabs }: { openDetail: (id: string) => void; notify: Notify; tabs?: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [kind, setKind] = useState<'posts' | 'accounts'>('posts');
  const [input, setInput] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [previous, setPrevious] = useState<Results | null>(null);
  const [pending, setPending] = useState<Source | null>(null);
  const [attempted, setAttempted] = useState<Source | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const [downloads, refreshDownloads] = useDouyinDownloadStatus();
  const [logVersion, setLogVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    request<DouyinSearchStatus>('/api/douyin/status').then(value => { if (!cancelled) setEnabled(value.enabled); }).catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);
  const load = async (source: Source, more: Results | null) => {
    const current = ++sequence.current;
    setPending(source); setAttempted(source); setError('');
    // A new search or series replaces the list, so a failure is not shown beside the previous results.
    if (!more) setResults(null);
    try {
      const page = await request<DouyinPage<Item>>(pageUrl(source, more?.cursor ?? null));
      if (current !== sequence.current) return;
      setResults({ source, items: [...(more?.items ?? []), ...page.items], cursor: page.cursor, hasMore: page.hasMore });
    } catch (reason) {
      if (current === sequence.current) setError(reason instanceof Error ? reason.message : '搜索没有完成，请稍后再试');
    } finally { if (current === sequence.current) setPending(null); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const keyword = input.trim();
    if (!keyword) return;
    setPrevious(null);
    void load({ type: kind, keyword }, null);
  };
  const openMix = (mix: DouyinMix) => { setPrevious(results); void load({ type: 'mix', mix }, null); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const back = () => { sequence.current++; setPending(null); setError(''); setResults(previous); setPrevious(null); };
  const copy = (url: string) => { void navigator.clipboard.writeText(url).then(() => notify('链接已复制'), () => notify('复制失败，请打开抖音后手动复制', true)); };
  const postIds = (results?.items ?? []).flatMap(item => 'id' in item ? [item.id] : []);
  const [records, refreshRecords] = usePostDownloads(postIds, downloads?.enabled === true);
  const requested = () => { refreshDownloads(); refreshRecords(); setLogVersion(value => value + 1); };
  const source = pending ?? results?.source ?? attempted;
  const loadingFirst = pending !== null && (results === null || results.source !== pending);
  const mix = source?.type === 'mix' ? source.mix : null;
  return <section className="panel douyin-panel" data-testid="douyin-search">
    <div className="panel-heading"><div><h2>抖音搜索</h2><p>用数据站的抖音专用账号搜索公开作品和账号。整部剧优先找带「红果有」的结果，从红果拿完整版。</p></div></div>
    {tabs}
    {enabled === false ? <Empty title="抖音搜索尚未开通" description="数据站还没有接上抖音搜索服务，请联系管理员。" /> : <>
      <form className="douyin-search-form" onSubmit={submit}>
        <div className="segmented" role="group" aria-label="搜索类型">
          {(['posts', 'accounts'] as const).map(value => <button key={value} type="button" className={kind === value ? 'active' : ''} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'posts' ? '作品' : '账号'}</button>)}
        </div>
        <label className="board-search douyin-search-input"><Search size={16} /><input aria-label="抖音搜索词" placeholder={kind === 'posts' ? '输入剧名或关键词' : '输入账号名或抖音号'} maxLength={100} value={input} onChange={event => setInput(event.target.value)} /></label>
        <button className="button button-primary" type="submit" disabled={!input.trim() || pending !== null || enabled === null}>搜索</button>
      </form>
      {mix && <div className="douyin-mix-heading"><button className="button button-outline" onClick={back}><ChevronLeft size={14} />返回搜索结果</button><strong>合集「{mix.name || '未命名'}」</strong>{mix.episodes && <span className="muted small">共 {mix.episodes} 集，按作者排的顺序列出</span>}<MixDownloadButton mixId={mix.id} status={downloads} notify={notify} onRequested={requested} /></div>}
      {loadingFirst ? <Loading label="正在搜索抖音，通常需要几秒…" />
        : error && !results ? <Empty title="搜索没有完成" description={error} action={source && <button className="button button-soft" onClick={() => void load(source, null)}>重试</button>} />
          : !results ? <Empty title="输入关键词开始搜索" description="例如剧名「万物有声鉴宝天骄」。结果来自抖音实时搜索，不是数据站已采集的榜单。" />
            : !results.items.length ? <Empty title="没有找到结果" description="换个关键词试试，或者切换到账号搜索。" />
              : <div className="douyin-results" aria-busy={pending !== null}>
                {results.items.map(item => 'secUid' in item && !('id' in item)
                  ? <AccountRow key={item.secUid} account={item} />
                  : <PostRow key={(item as DouyinPost).id} post={item as DouyinPost} inMix={results.source.type === 'mix'} openDetail={openDetail} openMix={openMix} copy={copy} downloads={downloads} record={records.get((item as DouyinPost).id)} notify={notify} onRequested={requested} />)}
                {error && <div className="facet-error" role="alert">{error}<button onClick={() => void load(results.source, results)}>重试</button></div>}
                {results.hasMore && <button className="button button-outline douyin-more" disabled={pending !== null} onClick={() => void load(results.source, results)}>{pending ? '正在加载…' : '加载更多'}</button>}
              </div>}
      <p className="douyin-note">抖音不公开播放量，这里只显示点赞、评论和收藏。每人每分钟最多搜索 20 次。</p>
    </>}
    <DouyinDownloadLog status={downloads} version={logVersion} />
  </section>;
}
