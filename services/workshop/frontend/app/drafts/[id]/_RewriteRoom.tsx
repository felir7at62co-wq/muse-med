'use client';
import * as React from 'react';
import { Sparkles, Loader2, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { authFetch } from '../../../lib/auth';
import { ModelSelect } from '@/components/ModelSelect';
import { Button, useToast } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type RewriteJob = {
  id: number;
  draft_id: number;
  title: string;
  status: string; // running|analyzing|rewriting|done|failed|canceled
  model: string;
  total: number;
  finished: number;
  per_ep?: Record<string, any>;
  analysis?: string;
  summary?: Record<string, any>;
  error?: string;
  created_at?: string;
  finished_at?: string;
};

function statusLabel(s: string) {
  return (
    {
      running: '启动中',
      analyzing: '通读诊断中',
      rewriting: '全局精修中',
      done: '已完成',
      failed: '失败',
      canceled: '已取消',
    } as Record<string, string>
  )[s] || s;
}

const ACTIVE = new Set(['running', 'pending', 'analyzing', 'rewriting']);

/**
 * 整本 AI 精修面板（替代旧「评审精修」单稿入口）。
 * 一键把整部剧本发给大模型两轮同上下文(先诊断→再按诊断全局精修), 结果直接覆写回草稿。
 * 覆写前每集自动存历史版本, 可在「章节 → 历史版本」回滚。
 */
export function RewriteRoom({ draftId, onApplied }: { draftId: number; onApplied?: () => void }) {
  const toast = useToast();
  const [model, setModel] = React.useState('gpt5');
  const [active, setActive] = React.useState<RewriteJob | null>(null);
  const [starting, setStarting] = React.useState(false);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchLatest() {
    try {
      const r = await authFetch(`${BASE}/v1/rewrite?draft_id=${draftId}`);
      if (!r.ok) return;
      const d = await r.json();
      const items: RewriteJob[] = Array.isArray(d.items) ? d.items : [];
      setActive(items[0] || null);
    } catch {
      /* noop */
    }
  }

  React.useEffect(() => {
    fetchLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // 有进行中的作业时轮询
  React.useEffect(() => {
    const isActive = active && ACTIVE.has(active.status);
    if (isActive && !pollRef.current) {
      pollRef.current = setInterval(fetchLatest, 5000);
    }
    if (!isActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      // 完成瞬间刷新草稿
      if (active && active.status === 'done') onApplied?.();
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.status]);

  async function start() {
    if (
      !window.confirm(
        '整本 AI 精修将把整部剧本发给大模型通读, 先诊断(人称/人物关系/AI味/剧情闭环)再全局精修, ' +
          '结果直接覆写回草稿。\n\n覆写前每集自动存历史版本, 可在「章节 → 历史版本」回滚。\n\n确定开始？',
      )
    )
      return;
    setStarting(true);
    try {
      const r = await authFetch(`${BASE}/v1/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: draftId, model }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      toast.success(`已启动整本精修 #${d.job_id}`);
      await fetchLatest();
    } catch (e: any) {
      toast.error(`启动失败: ${e?.message || e}`);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!active) return;
    try {
      await authFetch(`${BASE}/v1/rewrite/${active.id}/cancel`, { method: 'POST' });
      toast.success('已取消');
      fetchLatest();
    } catch {
      toast.error('取消失败');
    }
  }

  const isActive = active && ACTIVE.has(active.status);
  const pct = active && active.total ? Math.round((active.finished / active.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-primary" />
        <h2 className="text-card-title font-semibold text-ink-primary">整本 AI 精修</h2>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <ModelSelect value={model} onChange={setModel} disabled={!!isActive} />
        <Button onClick={start} disabled={starting || !!isActive} leftIcon={<Sparkles className="w-4 h-4" />}>
          {isActive ? '精修进行中…' : starting ? '启动中…' : '开始整本精修'}
        </Button>
        {isActive && (
          <Button variant="danger" size="sm" onClick={cancel}>
            取消
          </Button>
        )}
      </div>

      {active && (
        <div className="rounded-lg border border-line bg-surface-raised p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {isActive ? (
                <Loader2 className="w-4 h-4 animate-spin text-warning" />
              ) : active.status === 'done' ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-danger" />
              )}
              <span className="text-body font-medium">
                #{active.id} · {statusLabel(active.status)}
              </span>
            </div>
            <span className="text-caption text-ink-muted">
              {active.model} · {active.finished}/{active.total} 集
            </span>
          </div>

          {isActive && (
            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          {active.status === 'done' && (
            <p className="text-caption text-success">
              ✓ 已覆写回草稿(共 {active.summary?.applied_eps ?? active.finished} 集)。如需回滚: 到「章节」分页打开对应集
              →「历史版本」可恢复精修前的稿。
            </p>
          )}
          {active.status === 'failed' && (
            <p className="text-caption text-danger">失败: {active.error || '未知错误'}(原稿未改动)</p>
          )}

          {active.analysis && (
            <details className="mt-1">
              <summary className="text-caption text-primary cursor-pointer">查看 AI 诊断清单</summary>
              <pre className="mt-2 text-caption whitespace-pre-wrap font-sans leading-relaxed bg-surface-overlay rounded p-2 max-h-72 overflow-y-auto">
                {active.analysis}
              </pre>
            </details>
          )}
        </div>
      )}

      <button
        className="self-start text-caption text-ink-muted hover:text-primary flex items-center gap-1"
        onClick={fetchLatest}
      >
        <RefreshCw className="w-3 h-3" /> 刷新状态
      </button>
    </div>
  );
}