"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, XCircle, ChevronDown, ChevronUp, X, Factory, Play } from "lucide-react";
import { getToken } from "../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/agent-batch`;

type Item = { draft_id: number; title: string; status: string; step?: string; detail?: string; pending_run_id?: number };
type Job = {
  id: number; title: string; status: string;
  total: number; finished: number; failed: number;
  auto_apply: boolean; action_chain?: string[]; items?: Item[];
  created_at?: string; finished_at?: string;
};

const RUNNING = new Set(["pending", "running"]);

/**
 * 批量运营作业浮动进度面板。
 * - 进页/定时拉 GET /v1/agent-batch(我的作业), 有【运行中】的就显示浮窗并轮询。
 * - 全部跑完后仍展示一小会(供用户看结果), 用户可手动关闭。
 * - 无需用户主动询问 Agent 即可看进度。
 */
export function BatchJobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [resuming, setResuming] = useState<number | null>(null);
  const timer = useRef<any>(null);

  async function resumeJob(id: number) {
    setResuming(id);
    try {
      const token = getToken();
      const r = await fetch(`${API}/${id}/resume`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      await fetchJobs();
    } catch (e: any) {
      alert(`继续失败: ${e?.message || e}`);
    }
  }

  async function cancelJob(id: number) {
    if (!confirm("确定要取消这个批量任务吗?\n会停掉正在跑的评审精修; 已完成的草稿保留, 之后可点「继续」补跑未完成的。")) return;
    try {
      const token = getToken();
      const r = await fetch(`${API}/${id}/cancel`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      await fetchJobs();
    } catch (e: any) {
      alert(`取消失败: ${e?.message || e}`);
    } finally {
      setResuming(null);
    }
  }

  async function fetchJobs() {
    try {
      const token = getToken();
      if (!token) return;
      const r = await fetch(`${API}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const d = await r.json();
      const items: Job[] = d.items || [];
      // 保留: 运行中的 + 所有已结束的(完成/失败/中断)。
      // 已结束的不再按时间自动消失, 一直显示到用户点"确认"(dismiss)为止, 便于确认结果。
      setJobs(items);
    } catch {}
  }

  useEffect(() => {
    fetchJobs();
    timer.current = setInterval(fetchJobs, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const visible = jobs.filter((j) => !dismissed.has(j.id));
  if (visible.length === 0) return null;

  const anyRunning = visible.some((j) => RUNNING.has(j.status));

  return (
    <div className="fixed bottom-4 right-4 z-40 w-96 max-w-[94vw] rounded-xl border border-line bg-surface-elevated shadow-2xl overflow-hidden text-xs">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-surface-base/70 cursor-pointer"
        onClick={() => setOpen((v) => !v)}>
        {anyRunning
          ? <Loader2 className="w-4 h-4 text-primary animate-spin" />
          : <Factory className="w-4 h-4 text-success" />}
        <span className="font-semibold flex-1">
          批量作业 {anyRunning ? "运行中" : "已完成"}
          <span className="text-ink-muted ml-1">({visible.length})</span>
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-ink-muted" /> : <ChevronUp className="w-4 h-4 text-ink-muted" />}
      </div>

      {open && (
        <div className="max-h-[50vh] overflow-y-auto divide-y divide-line/60">
          {visible.map((j) => {
            const pct = j.total > 0 ? Math.round(((j.finished + j.failed) / j.total) * 100) : 0;
            const running = RUNNING.has(j.status);
            return (
              <div key={j.id} className="p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-medium text-ink-primary flex-1 break-words leading-snug" title={j.title}>#{j.id} {j.title}</span>
                  <button onClick={() => setDismissed((s) => new Set(s).add(j.id))}
                    className="p-0.5 hover:bg-surface-overlay rounded" title="关闭">
                    <X className="w-3.5 h-3.5 text-ink-muted" />
                  </button>
                </div>
                {/* 进度条 */}
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
                    <div className={`h-full transition-all duration-500 ${j.failed > 0 ? "bg-warning" : "bg-primary"}`}
                      style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-ink-secondary tabular-nums">{j.finished + j.failed}/{j.total}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                  {running
                    ? <><Loader2 className="w-3 h-3 animate-spin text-primary" />进行中</>
                    : j.failed > 0
                      ? <><XCircle className="w-3 h-3 text-warning" />{j.status}({j.failed}个失败)</>
                      : <><CheckCircle2 className="w-3 h-3 text-success" />全部完成</>}
                  {j.action_chain && <span className="ml-auto">[{j.action_chain.join("→")}]</span>}
                </div>
                {/* 取消按钮: 作业正在跑时显示, 一键停掉(含正在跑的精修) */}
                {running && (
                  <button
                    onClick={() => cancelJob(j.id)}
                    className="mt-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-warning/40 text-warning hover:bg-warning/10">
                    <X className="w-3 h-3" />取消任务
                  </button>
                )}
                {/* 继续按钮: 批次中断(非running非done, 还有未完成)时显示, 从断点补跑 */}
                {!running && j.status !== "done" && (j.finished + j.failed) < j.total && (
                  <div className="mt-1.5 flex justify-end">
                    <button
                      onClick={() => resumeJob(j.id)}
                      disabled={resuming === j.id}
                      className="inline-flex items-center gap-1 rounded bg-primary/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-primary disabled:opacity-50"
                      title="从断点补跑未完成的草稿(已完成的跳过)"
                    >
                      {resuming === j.id
                        ? <><Loader2 className="w-3 h-3 animate-spin" />正在继续…</>
                        : <><Play className="w-3 h-3" />继续(补跑{j.total - j.finished - j.failed})</>}
                    </button>
                  </div>
                )}
                {/* 确认按钮: 作业已结束(非running)时显示, 点击后才从浮窗隐藏, 避免自动消失导致用户没看到结果 */}
                {!running && (
                  <div className="mt-1.5 flex justify-end">
                    <button
                      onClick={() => setDismissed((prev) => new Set(prev).add(j.id))}
                      className="inline-flex items-center gap-1 rounded bg-success/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-success"
                      title="确认已知晓结果, 从此浮窗移除(不影响已完成的作业)"
                    >
                      <CheckCircle2 className="w-3 h-3" />确认
                    </button>
                  </div>
                )}
                {/* 当前正在处理的草稿(最多显示3个 running/待处理) */}
                {running && j.items && (
                  <div className="mt-1.5 space-y-0.5">
                    {j.items.filter((it) => it.status === "running").slice(0, 3).map((it) => (
                      <div key={it.draft_id} className="text-[11px] text-ink-secondary break-words leading-snug">
                        · #{it.draft_id} {it.title}<span className="text-ink-muted"> — {it.step || "处理中"}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* 有待采纳(非全自动精修完成)时提示 */}
                {!running && j.items?.some((it) => it.pending_run_id) && (
                  <div className="mt-1.5 text-[11px] text-warning">
                    有 {j.items.filter((it) => it.pending_run_id).length} 个精修待采纳 — 可对 Agent 说"采纳 job {j.id}"
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}