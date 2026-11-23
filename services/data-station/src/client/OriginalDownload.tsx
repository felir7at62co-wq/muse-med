import { useEffect, useRef, useState } from 'react';
import { BookDown, LoaderCircle, RefreshCw } from 'lucide-react';
import type { NovelArtifact, NovelState } from '../shared/novels';
import type { Work } from '../shared/types';
import { authenticatedFetch, captureRequestIdentity, request } from './api';

type Notify = (message: string, error?: boolean) => void;

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1200);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Verifies the immutable original file before allowing the browser to save it. */
async function downloadOriginal(artifact: NovelArtifact, signal: AbortSignal, checkIdentity: () => void): Promise<void> {
  const response = await authenticatedFetch(`/api/originals/${encodeURIComponent(artifact.id)}/download`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`原小说下载失败（${response.status}）`);
  const blob = await response.blob();
  if (blob.size !== artifact.byteLength) throw new Error('原小说文件大小校验失败，请重试');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== artifact.sha256.toLowerCase()) throw new Error('原小说文件校验失败，请联系管理员');
  signal.throwIfAborted(); checkIdentity();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = artifact.fileName;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Saves a verified original, then records it in this member's shelf.
 * A failed shelf write keeps the saved file and reports that the shelf was not updated.
 * @param artifact Published original version.
 * @param signal Cancels the download before the file is saved.
 * @param checkIdentity Throws when the account changed since the action started.
 * @returns Whether the shelf entry was saved, and the message to show.
 */
export async function downloadAndShelveOriginal(artifact: NovelArtifact, signal: AbortSignal, checkIdentity: () => void): Promise<{ shelved: boolean; message: string }> {
  await downloadOriginal(artifact, signal, checkIdentity);
  const saved = artifact.scope === 'complete-book' ? `已下载原小说，共 ${artifact.chapterCount} 章` : `已下载当前已发布的 ${artifact.chapterCount} 章`;
  try {
    await request('/api/bookshelf/originals', { method: 'POST', body: JSON.stringify({ artifactId: artifact.id }) });
    return { shelved: true, message: `${saved}，已加入书架${artifact.scope === 'complete-book' ? '' : '；后续可更新原文'}` };
  } catch (error) {
    return { shelved: false, message: `${saved}，但书架记录未保存：${error instanceof Error ? error.message : '请稍后重试'}` };
  }
}

/** Downloads a shelved original again; a successful download refreshes its download time. */
export function OriginalShelfDownload({ artifact, notify, onChanged }: { artifact: NovelArtifact; notify: Notify; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const result = await downloadAndShelveOriginal(artifact, new AbortController().signal, captureRequestIdentity());
      notify(result.message, !result.shelved);
      if (result.shelved) onChanged();
    } catch (error) { notify(error instanceof Error ? error.message : '原小说下载未完成', true); }
    finally { setBusy(false); }
  };
  return <button className="button button-soft script-download" data-testid="original-shelf-download" disabled={busy} onClick={() => void download()} title={artifact.fileName}>
    {busy ? <LoaderCircle className="spin" size={14} /> : <BookDown size={14} />}{busy ? '下载中…' : '再次下载'}
  </button>;
}

/** Starts an on-demand source check; navigation stops only this view's polling, never the durable job. */
export function OriginalDownload({ work, notify, pending = false }: { work: Work; notify: Notify; pending?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [artifact, setArtifact] = useState<NovelArtifact | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [work.id]);
  const prepare = async (refresh = false) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const { signal } = controller;
    const checkIdentity = captureRequestIdentity();
    setBusy(true); setProgress('核对目录…');
    try {
      let state = await request<NovelState>(`/api/works/${encodeURIComponent(work.id)}/original`, { signal });
      signal.throwIfAborted(); checkIdentity();
      if (!state.available) throw new Error('此平台的原小说下载尚未开启，请联系管理员');
      setArtifact(state.artifact);
      if (refresh || !state.artifact) {
        state = await request<NovelState>(`/api/works/${encodeURIComponent(work.id)}/original/jobs`, { method: 'POST', body: '{}', signal });
        for (;;) {
          signal.throwIfAborted(); checkIdentity();
          const job = state.job;
          if (!job) throw new Error('原小说准备任务没有建立，请重试');
          if (job.state === 'failed') throw new Error(job.message || '原小说尚未完整核对，请稍后重试');
          if (job.state === 'ready') break;
          setProgress(job.state === 'queued' ? '排队准备…' : job.totalChapters ? `核对 ${job.completedChapters}/${job.totalChapters} 章` : '核对目录…');
          await pause(signal);
          state = await request<NovelState>(`/api/works/${encodeURIComponent(work.id)}/original`, { signal });
        }
      }
      if (!state.artifact) throw new Error('原小说文件尚未发布，未下载不完整正文');
      setArtifact(state.artifact); setProgress('校验下载…');
      const result = await downloadAndShelveOriginal(state.artifact, signal, checkIdentity);
      notify(result.message, !result.shelved);
    } catch (error) {
      if (!signal.aborted) notify(error instanceof Error ? error.message : '原小说下载未完成', true);
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); setProgress(''); }
    }
  };
  if (work.kind !== 'novel') return null;
  return <div className="original-download-actions">
    <button className="button button-soft script-download" data-testid="original-download" disabled={pending || busy || !work.title || work.metadataStatus === 'unavailable'} onClick={() => void prepare()}
      title={pending ? '连接后核对原小说状态' : artifact ? `${artifact.chapterCount} 章；核对于 ${new Date(artifact.directoryObservedAt).toLocaleString('zh-CN')}` : '按需核对官方目录，完整后下载原小说文件'}>
      {busy ? <LoaderCircle className="spin" size={14} /> : <BookDown size={14} />}{pending ? '原文待核对' : busy ? progress : '原小说'}
    </button>
    {artifact && <button className="icon-button" disabled={pending || busy} aria-label="更新原小说" title="重新核对已发布章节，保留原有成功文件" onClick={() => void prepare(true)}><RefreshCw size={13} /></button>}
  </div>;
}
