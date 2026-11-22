'use client';
import * as React from 'react';
import { authFetch } from '../../lib/auth';
import { Modal, Button, FormField, Input, useToast } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

/**
 * 自动打磨弹窗: 对选中的一批草稿做"分析→优化"循环至收敛。
 * 参数: max_rounds(最多打磨几轮) / target_score(达标分) / target_p0(允许残留P0数)。
 */
export function PolishModal({
  open,
  draftIds,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  draftIds: number[];
  onClose: () => void;
  onSubmitted: (jobId: number) => void;
}) {
  const toast = useToast();
  const [maxRounds, setMaxRounds] = React.useState(3);
  const [targetScore, setTargetScore] = React.useState(80);
  const [targetP0, setTargetP0] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);

  async function submit() {
    if (draftIds.length === 0) return;
    setSubmitting(true);
    try {
      const res = await authFetch(`${BASE}/v1/polish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_ids: draftIds,
          max_rounds: maxRounds,
          target_score: targetScore,
          target_p0: targetP0,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(t || `HTTP ${res.status}`);
      }
      const data = await res.json();
      toast.success(data.message || '自动打磨已启动');
      onSubmitted(data.job_id);
      onClose();
    } catch (e: any) {
      toast.error(`启动失败: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`自动打磨 ${draftIds.length} 个草稿`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || draftIds.length === 0}>
            {submitting ? '启动中…' : '开始打磨'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted leading-relaxed">
          系统会对每个草稿反复做「诊断分析 → 按报告优化」循环，直到
          <b className="text-ink-primary">基本无必改硬伤(P0)且达到目标分</b>，或达到最大轮数为止。
          草稿之间高并发处理，可在下方浮窗查看进度。
        </p>
        <FormField label="最大打磨轮数" hint="每轮 = 一次分析 + 一次优化；达标会提前结束">
          <Input
            type="number"
            min={1}
            max={10}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
          />
        </FormField>
        <FormField label="目标综合分" hint="达到此分且无硬伤即视为达标(0-100)">
          <Input
            type="number"
            min={0}
            max={100}
            value={targetScore}
            onChange={(e) => setTargetScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
          />
        </FormField>
        <FormField label="允许残留 P0(硬伤)数" hint="0 = 必须无硬伤才算达标(推荐)">
          <Input
            type="number"
            min={0}
            value={targetP0}
            onChange={(e) => setTargetP0(Math.max(0, Number(e.target.value) || 0))}
          />
        </FormField>
      </div>
    </Modal>
  );
}

type PolishJob = {
  id: number;
  title: string;
  status: string;
  total: number;
  finished: number;
  failed: number;
  max_rounds: number;
  target_score: number;
  target_p0: number;
  per_draft?: Record<string, any>;
};

/**
 * 自动打磨进度浮窗: 右下角显示进行中/最近的打磨作业，每草稿一行显示轮次/达标状态。
 * 完成后需手动"关闭"，不自动消失(与批量作业浮窗风格一致)。
 */
// localStorage 持久化: 关闭过的打磨作业浮窗, 刷新页面后不再重复出现。
const LS_POLISH_DISMISSED = 'polish_jobs_dismissed';

function loadPolishDismissed(): Set<number> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LS_POLISH_DISMISSED);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}

function savePolishDismissed(s: Set<number>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_POLISH_DISMISSED, JSON.stringify(Array.from(s).slice(-500)));
  } catch {
    /* noop */
  }
}

export function PolishJobsPanel() {
  const [jobs, setJobs] = React.useState<PolishJob[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<number>>(() => loadPolishDismissed());

  // dismissed 变化时持久化, 刷新页面后关闭过的作业不再弹出
  React.useEffect(() => {
    savePolishDismissed(dismissed);
  }, [dismissed]);
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const toast = useToast();

  async function fetchJobs() {
    try {
      const res = await authFetch(`${BASE}/v1/polish`);
      if (!res.ok) return;
      const data = await res.json();
      setJobs(Array.isArray(data.items) ? data.items : []);
    } catch {
      /* noop */
    }
  }

  React.useEffect(() => {
    fetchJobs();
    const t = setInterval(fetchJobs, 8000);
    return () => clearInterval(t);
  }, []);

  async function cancelJob(id: number) {
    try {
      await authFetch(`${BASE}/v1/polish/${id}/cancel`, { method: 'POST' });
      toast.success('已取消');
      fetchJobs();
    } catch {
      toast.error('取消失败');
    }
  }

  async function resumeJob(id: number) {
    try {
      const r = await authFetch(`${BASE}/v1/polish/${id}/resume`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || '继续失败');
      toast.success(d.message || '已继续');
      fetchJobs();
    } catch (e: any) {
      toast.error(`继续失败: ${e?.message || e}`);
    }
  }

  // 只显示: 进行中的 + 已完成但未被用户手动关闭的
  const visible = jobs.filter(
    (j) => (j.status === 'running' || j.status === 'pending') || !dismissed.has(j.id),
  );
  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-[360px] max-h-[70vh] overflow-auto">
      {visible.map((j) => {
        const active = j.status === 'running' || j.status === 'pending';
        const per = j.per_draft || {};
        const entries = Object.entries(per);
        return (
          <div
            key={j.id}
            className="rounded-lg border border-line bg-surface-raised shadow-lg p-3 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium text-ink-primary truncate">✨ {j.title}</div>
                <div className="text-caption text-ink-muted mt-0.5">
                  {statusLabel(j.status)} · 完成 {j.finished}/{j.total}
                  {j.failed > 0 && ` · 失败 ${j.failed}`}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  className="text-xs text-primary hover:underline"
                  onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                >
                  {expanded === j.id ? '收起' : '详情'}
                </button>
                {active ? (
                  <button className="text-xs text-danger hover:underline" onClick={() => cancelJob(j.id)}>
                    取消
                  </button>
                ) : (
                  <>
                    {j.status === 'partial_failed' && (
                      <button className="text-xs text-primary hover:underline" onClick={() => resumeJob(j.id)}>
                        继续
                      </button>
                    )}
                    <button
                      className="text-xs text-ink-muted hover:underline"
                      onClick={() => setDismissed((s) => new Set(s).add(j.id))}
                    >
                      关闭
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 进度条 */}
            <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${j.total ? Math.round((j.finished / j.total) * 100) : 0}%` }}
              />
            </div>

            {expanded === j.id && (
              <div className="mt-2 flex flex-col gap-1 max-h-[300px] overflow-auto">
                {entries.map(([did, info]: [string, any]) => {
                  const rounds = info?.rounds || [];
                  const last = rounds[rounds.length - 1];
                  return (
                    <div key={did} className="flex items-center justify-between gap-2 text-caption">
                      <span className="truncate text-ink-secondary" title={info?.title}>
                        {info?.title || `草稿#${did}`}
                      </span>
                      <span className={draftStatusColor(info?.status)}>
                        {draftLine(info, last)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function statusLabel(s: string) {
  return (
    {
      pending: '排队中',
      running: '打磨中',
      done: '已完成',
      partial_failed: '部分中断',
      failed: '失败',
      canceled: '已取消',
    } as Record<string, string>
  )[s] || s;
}

function draftStatusColor(s?: string) {
  if (s === '达标') return 'text-success';
  if (s === '失败' || s === '已取消') return 'text-danger';
  if (s === '已达最大轮') return 'text-warning';
  return 'text-ink-muted';
}

function draftLine(info: any, last: any) {
  const st = info?.status;
  if (st === '达标') {
    const sc = info?.final_score;
    return `第${last?.round ?? '?'}轮达标${sc != null ? ` ${sc}分` : ''} ✓`;
  }
  if (st === '已达最大轮') {
    const p0 = info?.final_p0;
    return `已达最大轮${p0 != null ? ` 剩${p0}个P0` : ''}`;
  }
  if (st === '失败') return '失败';
  if (st === '已取消') return '已取消';
  // 优化中
  return info?.current_step || '优化中…';
}