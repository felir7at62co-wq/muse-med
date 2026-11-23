import { useEffect, useState } from 'react';
import { LoaderCircle, Zap } from 'lucide-react';
import { JOB_STATE_LABELS, type HitBoard, type TranscriptionJob } from '../shared/hits';
import type { ScriptArtifact, Work } from '../shared/types';
import { request } from './api';
import { ScriptDownload } from './ScriptDownload';

type Notify = (message: string, error?: boolean) => void;
type TranscribableWork = Pick<Work, 'id' | 'sourceId' | 'platform' | 'title'> & { script?: ScriptArtifact | null };

const ACTIVE_STATES: readonly TranscriptionJob['state'][] = ['downloading', 'transcribing', 'checking'];

/** 立即转写 for one Hongguo drama: creates or re-queues its job at the front of the 储备看板 queue. */
export function TranscribeButton({ work, notify, onRushed, disabled = false }: {
  work: TranscribableWork; notify: Notify; onRushed: (job: TranscriptionJob) => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const rush = async () => {
    setBusy(true);
    try {
      const job = await request<TranscriptionJob>(`/api/hits/${encodeURIComponent(work.id)}/rush`, { method: 'POST', body: '{}' });
      setQueued(true);
      notify(`「${work.title ?? work.sourceId}」已排到队首，可在储备看板查看进度`);
      onRushed(job);
    } catch (reason) { notify(reason instanceof Error ? reason.message : '操作失败', true); }
    finally { setBusy(false); }
  };
  return <button className="button button-outline script-transcribe" data-testid="work-transcribe" disabled={disabled || busy || queued}
    onClick={() => void rush()} aria-label={`转写${work.title ?? work.sourceId}`}>
    {busy ? <LoaderCircle className="spin" size={14} /> : <Zap size={13} />}{queued ? '已排队' : busy ? '提交中…' : '转写'}</button>;
}

/** The 剧本 cell: the script download when one exists, otherwise 转写 for Hongguo dramas. */
export function ScriptOrTranscribe({ work, pending = false, notify, onChanged }: {
  work: TranscribableWork; pending?: boolean; notify: Notify; onChanged: () => void;
}) {
  if (work.platform !== 'hongguo' || work.script || pending) return <ScriptDownload script={work.script} pending={pending} notify={notify} onChanged={onChanged} />;
  return <TranscribeButton work={work} notify={notify} onRushed={() => undefined} />;
}

/** Current transcription stage of one Hongguo drama in the detail view, with 转写 while it is not running. */
export function TranscribeStatus({ work, notify }: { work: TranscribableWork; notify: Notify }) {
  const [job, setJob] = useState<TranscriptionJob | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    request<HitBoard>(`/api/hits/board?filter=all&q=${encodeURIComponent(work.sourceId)}&page=1&limit=5`)
      .then(board => { if (!cancelled) setJob(board.items.find(item => item.work.id === work.id)?.job ?? null); })
      .catch(() => { if (!cancelled) setJob(null); });
    return () => { cancelled = true; };
  }, [work.id, work.sourceId]);
  if (work.platform !== 'hongguo' || work.script || job === undefined) return null;
  const progress = job?.progress;
  const episodes = progress?.episode != null && progress.totalEpisodes ? ` · 第 ${progress.episode}/${progress.totalEpisodes} 集` : '';
  const running = job ? ACTIVE_STATES.includes(job.state) : false;
  return <div className="detail-transcribe" data-testid="detail-transcribe">
    <span>{job ? `${JOB_STATE_LABELS[job.state]}${episodes}` : '未转写'}</span>
    {job?.lastError && (job.state === 'failed' || job.state === 'needs-attention') && <small className="hit-error" title={job.lastError.reason}>{job.lastError.reason}</small>}
    {job?.state === 'rejected' && job.review && <small className="hit-review" title={job.review.reason}>复核理由：{job.review.reason}</small>}
    {!running && job?.state !== 'published' && <TranscribeButton work={work} notify={notify} onRushed={setJob} disabled={Boolean(job?.rushAt && job.state === 'queued')} />}
  </div>;
}
