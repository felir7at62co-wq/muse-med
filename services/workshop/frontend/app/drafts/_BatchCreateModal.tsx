'use client';
import * as React from 'react';
import { authFetch } from '../../lib/auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type PerDraft = { step?: string; draft_id?: number | null; title?: string; score?: number | null; error?: string };
type Batch = {
  id: number; name: string; status: string; total: number; finished: number; failed: number;
  mode: string; episodes?: number; words?: number; per_draft: PerDraft[]; created_at?: string;
};

/**
 * 批量创建工厂弹窗。上半部分=进行中/最近批次的进度面板(可持续轮询, 关掉重开也能看到);
 * 下半部分=新建批次表单。二者共存, 满足"既能看进度又能建新批次"。
 */
export function BatchCreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [batches, setBatches] = React.useState<Batch[]>([]);
  const [resuming, setResuming] = React.useState<number | null>(null);
  const [direction, setDirection] = React.useState('');
  const [count, setCount] = React.useState(5);
  const [words, setWords] = React.useState(5000);
  const [episodes, setEpisodes] = React.useState(12);
  const [mode, setMode] = React.useState<'novel' | 'script'>('script');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  const loadBatches = React.useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/v1/batch-create/batches?limit=10`);
      if (r.ok) {
        const d = await r.json();
        setBatches(d.items || []);
      }
    } catch { /* ignore */ }
  }, []);

  // 打开时 + 每 3s 轮询进度(有进行中的批次才需要, 但简单起见常轮询)
  React.useEffect(() => {
    if (!open) return;
    loadBatches();
    const t = setInterval(loadBatches, 3000);
    return () => clearInterval(t);
  }, [open, loadBatches]);

  async function submit() {
    setErr('');
    setBusy(true);
    try {
      const r = await authFetch(`${BASE}/v1/batch-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction: direction.trim(),
          count: Math.max(1, Math.min(100, count)),
          words_per_episode: words,
          episodes,
          mode,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      setDirection('');
      await loadBatches();
    } catch (e: any) {
      setErr(e?.message || '提交失败');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const running = batches.filter((b) => ['pending', 'running'].includes(b.status));
  const recent = batches.filter((b) => !['pending', 'running'].includes(b.status));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-surface-raised p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink-primary">批量创建 · AI 广撒网</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-base">✕</button>
        </div>
        <p className="mb-4 text-xs text-ink-muted">
          一次批量生成多个 AI 原创草稿, 自动跑完「大纲 → {mode === 'novel' ? '小说正文' : '剧本'} → 剧情分析打分」,
          之后在主页按分数从高到低筛出底子好的稿子深入打磨。评审精修请到草稿页手动触发。
        </p>

        {/* ===== 进度面板 ===== */}
        {(running.length > 0 || recent.length > 0) && (
          <div className="mb-4 space-y-2">
            <div className="text-sm font-medium text-ink-secondary">批次进度</div>
            {[...running, ...recent].slice(0, 6).map((b) => {
              const done = b.finished + b.failed;
              const pct = b.total ? Math.round((done / b.total) * 100) : 0;
              return (
                <div key={b.id} className="rounded-lg border border-line bg-surface-base p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-ink-primary">
                      {b.name} <span className="text-ink-muted">#{b.id}</span>
                    </span>
                    <span className={
                      b.status === 'running' ? 'text-primary' :
                      b.status === 'done' ? 'text-success' :
                      b.status === 'pending' ? 'text-ink-muted' : 'text-warning'
                    }>
                      {b.status === 'running' ? '生成中' : b.status === 'done' ? '已完成' :
                       b.status === 'pending' ? '排队中' : b.status === 'partial_failed' ? '部分失败' : '失败'}
                      {' '}{done}/{b.total}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-surface-raised">
                    <div className={`h-full transition-all ${b.status === 'done' ? 'bg-success' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                  </div>
                  {/* 继续按钮: 批次未全部完成(被中断/部分失败/未跑完)时显示, 从断点补跑未完成的 */}
                  {b.status !== 'done' && done < b.total && (
                    <div className="mt-1.5 flex items-center justify-end">
                      <button
                        onClick={async () => {
                          setResuming(b.id);
                          try {
                            const r = await authFetch(`${BASE}/v1/batch-create/${b.id}/resume`, { method: 'POST' });
                            const d = await r.json().catch(() => ({}));
                            if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
                            await loadBatches();
                          } catch (e: any) {
                            alert(`继续失败: ${e?.message || e}`);
                          } finally {
                            setResuming(null);
                          }
                        }}
                        disabled={resuming === b.id || b.status === 'running' || b.status === 'pending'}
                        className="rounded bg-primary/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed"
                        title={b.status === 'running' || b.status === 'pending' ? '正在运行中，无需继续' : '从断点补跑未完成的草稿(已完成的会跳过)'}
                      >
                        {resuming === b.id ? '正在继续…' : b.status === 'running' || b.status === 'pending' ? '运行中' : `继续(补跑${b.total - done})`}
                      </button>
                    </div>
                  )}
                  {/* 每个草稿的状态+分数(网格) */}
                  <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
                    {(b.per_draft || []).map((p, i) => (
                      <div key={i} className="flex items-center justify-between gap-1 rounded bg-surface-raised px-1.5 py-0.5 text-[11px]">
                        <span className="truncate text-ink-secondary" title={p.title || `#${i + 1}`}>
                          {p.title || `稿${i + 1}`}
                        </span>
                        {p.score != null ? (
                          <span className={`shrink-0 font-semibold ${p.score >= 80 ? 'text-success' : p.score >= 60 ? 'text-warning' : 'text-ink-muted'}`}>
                            {p.score}分
                          </span>
                        ) : (
                          <span className="shrink-0 text-ink-muted">{p.error ? '失败' : p.step || '…'}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ===== 新建表单 ===== */}
        <div className="rounded-xl border border-line p-3">
          <div className="mb-2 text-sm font-medium text-ink-secondary">新建批次</div>
          <label className="mb-1 block text-xs text-ink-muted">创作方向 (时代背景 / 粗略情节, 可留空让 AI 自由发挥)</label>
          <textarea
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            rows={3}
            placeholder="例如: 民国上海滩, 女主是报社记者, 卷入一桩悬案, 偏悬疑+情感"
            className="mb-3 w-full rounded-lg border border-line bg-surface-base px-3 py-2 text-sm text-ink-primary"
          />
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-ink-muted">生成数量 (≤100)</label>
              <input type="number" min={1} max={100} value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                className="w-full rounded-lg border border-line bg-surface-base px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-muted">集数</label>
              <input type="number" min={1} max={500} value={episodes}
                onChange={(e) => setEpisodes(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                className="w-full rounded-lg border border-line bg-surface-base px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-muted">每集字数</label>
              <input type="number" min={1} max={20000} value={words}
                onChange={(e) => setWords(Math.max(1, Math.min(20000, Number(e.target.value) || 5000)))}
                className="w-full rounded-lg border border-line bg-surface-base px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-muted">产出形态 (二选一)</label>
              <div className="inline-flex overflow-hidden rounded-lg border border-line text-xs">
                <button onClick={() => setMode('script')} className={`px-3 py-1.5 ${mode === 'script' ? 'bg-primary text-white' : 'bg-surface-base text-ink-secondary'}`}>剧本</button>
                <button onClick={() => setMode('novel')} className={`px-3 py-1.5 ${mode === 'novel' ? 'bg-primary text-white' : 'bg-surface-base text-ink-secondary'}`}>小说</button>
              </div>
            </div>
          </div>
          {err && <p className="mb-2 text-sm text-danger">{err}</p>}
          <button
            onClick={submit}
            disabled={busy}
            className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? '提交中…' : `开始批量创建 ${count} 稿`}
          </button>
          <p className="mt-1.5 text-[11px] text-ink-muted">
            提交后在后台并发生成(并发5), 上方进度面板实时刷新; 关掉弹窗后重新打开也能看到进度。
          </p>
        </div>
      </div>
    </div>
  );
}