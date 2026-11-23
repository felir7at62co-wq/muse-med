import { useEffect, useState } from 'react';
import { BookDown, BookOpen, FileText, RefreshCw, Trash2 } from 'lucide-react';
import type { NovelShelfItem } from '../shared/novels';
import type { BookshelfItem, Work } from '../shared/types';
import { request } from './api';
import { dateText, Empty, Loading, PlatformBadge, WorkLink } from './components';
import { ScriptDownload } from './ScriptDownload';
import { OriginalShelfDownload } from './OriginalDownload';
import { primaryMetrics } from './platform-metrics';

type Notify = (message: string, error?: boolean) => void;

/** Work name, platform and its latest collected metrics, shared by screenplay and original entries. */
function ShelfWork({ work, openDetail }: { work: Work; openDetail: (id: string) => void }) {
  return <div className="bookshelf-work"><PlatformBadge platform={work.platform} /><WorkLink work={work} onOpen={openDetail} /><small>作品数据更新于 {dateText(work.observedAt, true)}</small>
    <dl className="bookshelf-metrics" data-testid="bookshelf-metrics">{primaryMetrics(work).map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl></div>;
}

function RemoveButton({ busy, onRemove }: { busy: boolean; onRemove: () => void }) {
  return <button className="text-button bookshelf-remove" disabled={busy} onClick={onRemove}><Trash2 size={13} />{busy ? '移出中…' : '移出书架'}</button>;
}

/** States how much of the book a version holds: a complete book, or the chapters published when its directory was checked. */
function originalScope(item: NovelShelfItem): string {
  const { artifact } = item;
  return artifact.scope === 'complete-book' ? `全本 · 共 ${artifact.chapterCount} 章` : `截至 ${dateText(artifact.directoryObservedAt, true)} 已发布 ${artifact.chapterCount} 章`;
}

/** The member's downloaded screenplays and originals; both lists follow the works' latest collected data. */
export function Bookshelf({ version, onChanged, openDetail, notify }: { version: number; onChanged: () => void; openDetail: (id: string) => void; notify: Notify }) {
  const [scripts, setScripts] = useState<BookshelfItem[]>([]);
  const [originals, setOriginals] = useState<NovelShelfItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [originalError, setOriginalError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setOriginalError('');
    const scriptRead = request<BookshelfItem[]>('/api/bookshelf').then(value => { if (!cancelled) setScripts(value); }).catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    const originalRead = request<NovelShelfItem[]>('/api/bookshelf/originals').then(value => { if (!cancelled) setOriginals(value); }).catch((reason: Error) => { if (!cancelled) setOriginalError(reason.message); });
    void Promise.all([scriptRead, originalRead]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version]);
  const remove = async (key: string, path: string) => {
    setRemoving(key);
    try { await request(path, { method: 'DELETE' }); onChanged(); notify('已移出书架'); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '移出失败', true); }
    finally { setRemoving(null); }
  };
  const scriptList = scripts.length > 0 && <div className="bookshelf-section" data-testid="bookshelf-scripts"><h3 className="bookshelf-section-title">剧本<span className="count-badge">{scripts.length}</span></h3><div className="bookshelf-list">{scripts.map(item => <article className="bookshelf-item" key={item.script.id} data-testid="bookshelf-item">
    <ShelfWork work={item.work} openDetail={openDetail} />
    <div className="bookshelf-file"><h3><FileText size={16} />{item.script.fileName}</h3><p>{Math.ceil(item.script.byteLength / 1024)} KB · 文件版本 {dateText(item.script.createdAt, true)}</p><div className="download-record"><span>最近下载</span><strong>{dateText(item.downloadedAt, true)}</strong></div>{item.work.script && item.work.script.id !== item.script.id && <small className="new-script-version">作品已有更新的剧本，可在详情中查看。</small>}</div>
    <div className="bookshelf-actions"><ScriptDownload script={item.script} notify={notify} onChanged={onChanged} label="再次下载" /><RemoveButton busy={removing === `script:${item.script.id}`} onRemove={() => void remove(`script:${item.script.id}`, `/api/bookshelf/${encodeURIComponent(item.script.id)}`)} /></div>
  </article>)}</div></div>;
  const originalList = originals.length > 0 && <div className="bookshelf-section" data-testid="bookshelf-originals"><h3 className="bookshelf-section-title">原小说<span className="count-badge">{originals.length}</span></h3><div className="bookshelf-list">{originals.map(item => <article className="bookshelf-item" key={item.artifact.id} data-testid="bookshelf-original">
    <ShelfWork work={item.work} openDetail={openDetail} />
    <div className="bookshelf-file"><h3><BookDown size={16} />{item.artifact.fileName}</h3><p>{originalScope(item)} · {Math.ceil(item.artifact.byteLength / 1024)} KB · 文件版本 {dateText(item.artifact.createdAt, true)}</p><div className="download-record"><span>最近下载</span><strong>{dateText(item.downloadedAt, true)}</strong></div>{item.latestArtifactId !== item.artifact.id && <small className="new-script-version">这本书已有更新的原小说版本，可在作品列表中下载。</small>}</div>
    <div className="bookshelf-actions"><OriginalShelfDownload artifact={item.artifact} notify={notify} onChanged={onChanged} /><RemoveButton busy={removing === `original:${item.artifact.id}`} onRemove={() => void remove(`original:${item.artifact.id}`, `/api/bookshelf/originals/${encodeURIComponent(item.artifact.id)}`)} /></div>
  </article>)}</div></div>;
  const failed = error && originalError;
  return <section className="panel bookshelf-panel"><div className="panel-heading"><div><h2><BookOpen size={18} />我的书架<span className="count-badge">{scripts.length + originals.length}</span></h2><p>成功下载的剧本和原小说自动加入；作品信息随数据采集更新。</p></div><button className="button button-outline" onClick={onChanged}><RefreshCw size={14} />刷新</button></div>
    {loading ? <Loading /> : failed ? <Empty title="书架暂时无法读取" description={error} action={<button className="button button-soft" onClick={onChanged}>重试</button>} /> : <>
      {(error || originalError) && <div className="facet-error" role="alert">{error ? `剧本书架暂时无法读取：${error}` : `原小说书架暂时无法读取：${originalError}`}<button onClick={onChanged}>重试</button></div>}
      {scriptList}{originalList}
      {!scripts.length && !originals.length && !error && !originalError && <Empty title="书架里还没有作品" description="在作品列表下载真实剧本或原小说后，会自动显示在这里。" />}
    </>}
  </section>;
}
