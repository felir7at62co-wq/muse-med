import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Database, ExternalLink, ImageOff, LoaderCircle, X } from 'lucide-react';
import { PLATFORM_LABELS, PLATFORM_SHORT_LABELS, type DataOrigin, type Metric, type Platform, type Work } from '../shared/types';
import { applicationUrl } from './url';

export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100000000) return `${Number((value / 100000000).toFixed(2))}亿`;
  if (Math.abs(value) >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

export function dateText(value: string | null | undefined, withTime = false): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return '尚未采集';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(new Date(value));
}

export function metricValue(metric: Metric): string {
  return metric.value === null ? '—' : `${compact(metric.value)}${metric.unit || ''}`;
}

/** Displays a missing-title label without changing the stored source title. */
export function displayTitle(work: Pick<Work, 'title'>): string {
  return work.title ?? '作品资料暂不可用';
}

/** Keeps the source identity and availability explanation visible beside missing metadata. */
export function WorkMetadataNotice({ work }: { work: Pick<Work, 'title' | 'sourceId' | 'metadataNote'> }) {
  if (work.title !== null && !work.metadataNote) return null;
  return <span className="work-metadata-notice" data-testid="work-metadata-notice">{work.title === null && <span>来源 ID：{work.sourceId}</span>}{work.metadataNote && <span>{work.metadataNote}</span>}</span>;
}

export function Poster({ work, large = false }: { work: Work; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const url = work.coverUrl ? applicationUrl(`/api/covers/${encodeURIComponent(work.id)}`) : null;
  useEffect(() => { setFailed(false); setLoaded(false); }, [url, work.coverUrl]);
  return <div className={`poster poster-${work.platform}${large ? ' poster-large' : ''}`} data-testid="work-cover">
    {(!url || failed) ? <span className="cover-fallback"><ImageOff size={large ? 25 : 16} aria-hidden="true" /><small>暂无封面</small></span> : <>
      {!loaded && <LoaderCircle className="spin cover-loading" size={large ? 24 : 15} aria-label="加载封面" />}
      <img src={url} alt={`${displayTitle(work)}${work.title === null ? `（来源 ID：${work.sourceId}）` : ''}封面`} loading="eager" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
    </>}
  </div>;
}

export function PlatformBadge({ platform, short = false }: { platform: Platform; short?: boolean }) {
  return <span className={`platform-badge platform-${platform}`}><span />{short ? PLATFORM_SHORT_LABELS[platform] : PLATFORM_LABELS[platform]}</span>;
}

export function OriginBadge({ origin }: { origin: DataOrigin }) {
  return <span className={`origin-badge origin-${origin}`}>{origin === 'live' ? '真实采集' : '示例'}</span>;
}

export function RankChange({ change }: { change: number | null }) {
  if (change === null) return <span className="muted rank-change" title="需要相邻两次均在榜的记录才能比较">暂无对比</span>;
  if (!change) return <span className="muted rank-change">持平</span>;
  return <span className={`rank-change ${change > 0 ? 'up' : 'down'}`}>{change > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{Math.abs(change)}</span>;
}

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Database size={25} strokeWidth={1.5} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Loading({ label = '正在读取数据…' }: { label?: string }) {
  return <div className="loading-state"><LoaderCircle size={20} className="spin" /><span>{label}</span></div>;
}

export function Modal({ title, children, onClose, wide = false, testId }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; testId?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialog.current) {
        const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]')).filter((node) => node.offsetParent !== null);
        if (!nodes.length) return;
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', handle);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handle); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-layer"><div className="modal-scrim" onClick={onClose} /><div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'drawer' : ''}`} data-testid={testId}>
    <div className="modal-heading"><span>{title}</span><button ref={close} className="icon-button" onClick={onClose} aria-label="关闭"><X size={21} /></button></div>{children}
  </div></div>;
}


export function WorkLink({ work, onOpen }: { work: Work; onOpen: (id: string) => void }) {
  return <button className="work-link" onClick={() => onOpen(work.id)}><Poster work={work} /><span className="work-copy"><strong>{displayTitle(work)}</strong><WorkMetadataNotice work={work} /><span>{work.author || '作者待补充'}<i />{work.kind === 'novel' ? `${compact(work.wordCount)}字` : work.episodeCount === null ? '集数待补充' : `${work.episodeCount}集`}</span><span className="work-tags">{work.tags.slice(0, 2).map((tag) => <small key={tag}>{tag}</small>)}</span></span></button>;
}

export function SourceLink({ href, children }: { href: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span className="muted">来源链接待补充</span>;
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{children || '查看原平台'}<ExternalLink size={13} /></a>;
}

export function MoreLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className="text-button" onClick={onClick}>{children}<ChevronRight size={14} /></button>;
}
