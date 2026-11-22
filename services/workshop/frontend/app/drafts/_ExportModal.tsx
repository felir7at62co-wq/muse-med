'use client';
import * as React from 'react';
import { authFetch } from '../../lib/auth';
import { Modal, Button, useToast } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type ExportMode = 'auto' | 'all_storyboard' | 'all_chapter';

const MODE_OPTIONS: { value: ExportMode; title: string; desc: string }[] = [
  {
    value: 'auto',
    title: '推荐',
    desc: '有剧本的集用剧本，没剧本的集用原文（自动选最佳来源）',
  },
  { value: 'all_storyboard', title: '仅剧本', desc: '每集都用已生成的剧本（分镜）导出' },
  { value: 'all_chapter', title: '仅原文', desc: '每集都用章节原文（full_text）导出' },
];

/**
 * 批量导出弹窗: 对选中草稿各导出一份 Word。
 * 三种模式: 推荐(auto) / 仅剧本(all_storyboard) / 仅原文(all_chapter)。
 */
export function ExportModal({
  open,
  draftIds,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  draftIds: number[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = React.useState<ExportMode>('auto');
  const [submitting, setSubmitting] = React.useState(false);

  async function submit() {
    if (draftIds.length === 0) return;
    setSubmitting(true);
    try {
      // 打包成一个 ZIP: 后台生成所有 docx 塞进一个压缩包, 完成后浮窗自动下载整包
      const res = await authFetch(`${BASE}/v1/export-jobs/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_ids: draftIds, mode }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(t || `HTTP ${res.status}`);
      }
      const data = await res.json();
      toast.success(data.message || '打包任务已提交，完成后自动下载');
      onSubmitted();
      onClose();
    } catch (e: any) {
      toast.error(`导出失败: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`导出 ${draftIds.length} 个草稿`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || draftIds.length === 0}>
            {submitting ? '提交中…' : '开始导出'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted leading-relaxed">
          所有草稿会打包成一个 ZIP 压缩包，可在下方浮窗查看进度，完成后自动下载整包（无需逐个点击）。
        </p>
        {MODE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={
              'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ' +
              (mode === opt.value
                ? 'border-primary bg-primary/[0.08]'
                : 'border-line hover:bg-white/[0.04]')
            }
          >
            <input
              type="radio"
              name="export-mode"
              className="mt-1"
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
            />
            <div className="min-w-0">
              <div className="font-medium text-ink-primary">{opt.title}</div>
              <div className="text-caption text-ink-muted mt-0.5">{opt.desc}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

type ExportJob = {
  id: number;
  draft_id: number;
  kind?: string;
  status: string;
  progress: number;
  output_url?: string | null;
  error?: string | null;
};

// localStorage 持久化: 关闭过的任务 / 已自动下载过的 zip, 刷新页面后不再重复出现或重复下载。
const LS_DISMISSED = 'export_jobs_dismissed';
const LS_DOWNLOADED = 'export_zip_downloaded';

function loadIdSet(key: string): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}

function saveIdSet(key: string, s: Set<number>) {
  if (typeof window === 'undefined') return;
  try {
    // 只保留最近 500 个 id, 防止 localStorage 无限膨胀
    const arr = Array.from(s).slice(-500);
    window.localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* noop */
  }
}

/**
 * 导出进度浮窗: 左下角显示最近的导出任务。
 * - 单部(mixed_docx): 完成后点"下载"。
 * - 批量打包(batch_zip): 完成后自动触发一次浏览器下载(整个 ZIP), 无需用户逐个点。
 * 关闭过的任务、已自动下载过的 zip 都持久化到 localStorage, 刷新页面后不再重复弹出/重复下载。
 */
export function ExportJobsPanel() {
  const [jobs, setJobs] = React.useState<ExportJob[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<number>>(() => loadIdSet(LS_DISMISSED));
  // 已自动下载过的 zip job(持久化), 避免刷新后重复触发下载
  const autoDownloaded = React.useRef<Set<number>>(loadIdSet(LS_DOWNLOADED));

  // dismissed 变化时持久化
  React.useEffect(() => {
    saveIdSet(LS_DISMISSED, dismissed);
  }, [dismissed]);

  async function fetchJobs() {
    try {
      const res = await authFetch(`${BASE}/v1/export-jobs`);
      if (!res.ok) return;
      const data = await res.json();
      const items: ExportJob[] = (Array.isArray(data.items) ? data.items : []).filter(
        (j: any) => j.kind === 'mixed_docx' || j.kind === 'batch_zip' || j.output_url !== undefined,
      );
      setJobs(items);
      // batch_zip 完成即自动下载整包(每个 job 只触发一次, 且持久化避免刷新重复下载)
      for (const j of items) {
        if (
          j.kind === 'batch_zip' &&
          j.status === 'done' &&
          j.output_url &&
          !autoDownloaded.current.has(j.id)
        ) {
          autoDownloaded.current.add(j.id);
          saveIdSet(LS_DOWNLOADED, autoDownloaded.current);
          const a = document.createElement('a');
          a.href = j.output_url;
          a.rel = 'noreferrer';
          a.download = '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      }
    } catch {
      /* noop */
    }
  }

  React.useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 5000);
    return () => clearInterval(t);
  }, []);

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'pending');
  const visible = jobs.filter(
    (j) => j.status === 'running' || j.status === 'pending' || !dismissed.has(j.id),
  );
  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[340px] max-h-[60vh] overflow-auto rounded-lg border border-line bg-surface-raised shadow-lg p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-ink-primary">
          导出任务 {active.length > 0 ? `(进行中 ${active.length})` : ''}
        </div>
        <button
          className="text-xs text-ink-muted hover:underline"
          onClick={() => setDismissed(new Set(jobs.map((j) => j.id)))}
        >
          全部关闭
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {visible.map((j) => (
          <div key={j.id} className="flex items-center justify-between gap-2">
            <span className="text-caption text-ink-secondary truncate">
              {j.kind === 'batch_zip' ? '批量打包(ZIP)' : `草稿#${j.draft_id}`} · {statusLabel(j.status)}
              {j.status === 'running' ? ` ${j.progress}%` : ''}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {j.status === 'done' && j.output_url && (
                <a
                  href={j.output_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  下载
                </a>
              )}
              {j.status === 'failed' && (
                <span className="text-xs text-danger" title={j.error || ''}>
                  失败
                </span>
              )}
              {(j.status === 'done' || j.status === 'failed') && (
                <button
                  className="text-xs text-ink-muted hover:underline"
                  onClick={() => setDismissed((s) => new Set(s).add(j.id))}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function statusLabel(s: string) {
  return (
    {
      pending: '排队中',
      running: '导出中',
      done: '已完成',
      failed: '失败',
    } as Record<string, string>
  )[s] || s;
}