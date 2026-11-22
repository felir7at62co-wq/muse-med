"use client";
import { authFetch } from "../../../lib/auth";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw, CheckCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type JobInfo = {
  status: string;
  expected_episodes: number;
  finished_episodes: number;
  running_in_bg: boolean;
  failed_orders: number[];
  pending_paths: Record<string, string>;
  can_retry: boolean;
  resumable_orders: number[];
  can_resume: boolean;
};

/**
 * 视频反推失败重试面板 — Phase 3 重做版,接入 UI Kit (Card / Button / Badge / Select)。
 *
 * 后端: GET /v1/video/jobs/{draftId}
 *      + POST /v1/video/drafts/{draftId}/retry-failed  (本地文件还在 → 重推失败集)
 *      + POST /v1/video/drafts/{draftId}/resume        (进程被重启打断 → 断点续跑)
 *
 * 只有反推真的出过状况(有失败集 / 有中断 / 正在跑)才显示,普通草稿完全无感。
 */
export function VideoRetryPanel({ draftId, onChanged }: { draftId: number; onChanged?: () => void }) {
  const [job, setJob] = useState<JobInfo | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [concurrency, setConcurrency] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  const alive = useRef(true);

  async function refresh() {
    try {
      const r = await authFetch(`${BASE}/v1/video/jobs/${draftId}`);
      if (!r.ok) return;
      const data = await r.json();
      if (!alive.current) return;
      setJob({
        status: data.status,
        expected_episodes: data.expected_episodes || 0,
        finished_episodes: data.finished_episodes || 0,
        running_in_bg: !!data.running_in_bg,
        failed_orders: data.failed_orders || [],
        pending_paths: data.pending_paths || {},
        can_retry: !!data.can_retry,
        resumable_orders: data.resumable_orders || [],
        can_resume: !!data.can_resume,
      });
    } catch {}
  }

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [draftId]);

  if (!job) return null;
  // 没有失败集、不能续跑、也不在跑视频反推 → 不显示(普通草稿完全无感)
  if (
    job.failed_orders.length === 0 &&
    !job.can_resume &&
    !job.running_in_bg &&
    job.status !== "video_running"
  ) {
    return null;
  }

  function toggleOrder(o: number) {
    const next = new Set(selected);
    next.has(o) ? next.delete(o) : next.add(o);
    setSelected(next);
  }

  function selectAll() {
    setSelected(new Set(job!.failed_orders));
  }

  function clearSel() {
    setSelected(new Set());
  }

  async function retry() {
    if (!job || (!job.can_retry && !job.running_in_bg)) return;
    setSubmitting(true);
    setError(null);
    setLastMessage(null);
    try {
      const orders = selected.size > 0 ? Array.from(selected).sort((a, b) => a - b) : null;
      const res = await authFetch(`${BASE}/v1/video/drafts/${draftId}/retry-failed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders, concurrency }),
      });
      if (!res.ok) {
        const txt = await res.text();
        setError(`重试失败: ${txt.slice(0, 300)}`);
        return;
      }
      const data = await res.json();
      setLastMessage(`已重新启动反推,共 ${data.count} 集: ${(data.retry_orders || []).join("、")}`);
      setSelected(new Set());
      await refresh();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || "请求失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function resume() {
    setSubmitting(true);
    setResuming(true);
    setError(null);
    setLastMessage(null);
    try {
      const res = await authFetch(`${BASE}/v1/video/drafts/${draftId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrency, redo_done: false }),
      });
      if (!res.ok) {
        const txt = await res.text();
        setError(`续跑失败: ${txt.slice(0, 300)}`);
        return;
      }
      const data = await res.json();
      setLastMessage(
        `已续跑,待补 ${data.count} 集(第${(data.resume_orders || []).join("、")}集),已完成的集不会重跑。`
      );
      setSelected(new Set());
      await refresh();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || "请求失败");
    } finally {
      setSubmitting(false);
      setResuming(false);
    }
  }

  const total = job.expected_episodes || 0;
  const finished = job.finished_episodes || 0;
  const failedCount = job.failed_orders.length;
  const running = job.running_in_bg;
  const resumeCount = job.resumable_orders.length;
  // 中断的反推: 既没有本地失败路径可重试, 也没在跑, 但有素材能接着做
  const interrupted = !running && resumeCount > 0 && job.can_resume;

  return (
    <Card padding="none" className="mb-4 border-warning/40 overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-line">
        <div className="flex items-center gap-2 flex-wrap">
          <RefreshCw className={`w-5 h-5 text-warning ${running ? "animate-spin" : ""}`} />
          <h3 className="text-base font-bold text-ink-primary">视频反推进度</h3>
          <Badge tone="muted" size="sm">
            成功 {finished}/{total || "?"}
          </Badge>
          {failedCount > 0 && (
            <Badge tone="danger" size="sm">失败 {failedCount} 集</Badge>
          )}
          {running && (
            <Badge tone="info" size="sm" withDot>反推中</Badge>
          )}
          {interrupted && (
            <Badge tone="warning" size="sm">已中断</Badge>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        {running && (
          <p className="text-xs text-ink-secondary">
            后台正在反推,可以关闭此页面,反推完成后会自动更新。
          </p>
        )}

        {interrupted && (
          <>
            <p className="text-xs text-ink-secondary">
              这次反推被服务器重启打断了(还剩 {resumeCount} 集没做: 第
              {job.resumable_orders.slice(0, 12).join("、")}
              {resumeCount > 12 ? ` 等 ${resumeCount} 集` : ""}集)。
              <br />
              视频素材还在服务器上,点下面的按钮可以接着做——已完成的 {finished} 集不会重跑,不会重复消耗。
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-ink-muted">并发:</label>
              <Select
                value={String(concurrency)}
                onChange={(e) => setConcurrency(Number(e.target.value) as 1 | 2 | 3)}
                disabled={submitting}
                size="sm"
                className="w-28"
              >
                <option value="1">串行(姓名最准)</option>
                <option value="2">2 并发</option>
                <option value="3">3 并发</option>
              </Select>
              <Button
                variant="primary"
                size="md"
                loading={submitting}
                leftIcon={!submitting ? <RefreshCw className="w-4 h-4" /> : undefined}
                onClick={resume}
                className="ml-auto"
              >
                {submitting && resuming ? "启动中…" : `继续反推剩下的 ${resumeCount} 集`}
              </Button>
            </div>
          </>
        )}

        {failedCount > 0 && !running && (
          <>
            <p className="text-xs text-ink-secondary">
              以下剧集反推失败,视频文件已保留在服务器临时盘,可以一键重推。
            </p>

            <div className="flex flex-wrap gap-2">
              {job.failed_orders.map((o) => {
                const on = selected.has(o);
                return (
                  <button
                    key={o}
                    onClick={() => toggleOrder(o)}
                    className={`px-3 py-1 rounded border text-xs transition ${
                      on
                        ? "bg-warning/20 border-warning text-warning font-semibold"
                        : "bg-surface-base border-line text-ink-secondary hover:border-warning"
                    }`}
                  >
                    第{o}集
                  </button>
                );
              })}
              {failedCount > 1 && (
                <>
                  <Button variant="ghost" size="sm" onClick={selectAll}>全选</Button>
                  {selected.size > 0 && (
                    <Button variant="ghost" size="sm" onClick={clearSel}>清除选择</Button>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-ink-muted">并发:</label>
              <Select
                value={String(concurrency)}
                onChange={(e) => setConcurrency(Number(e.target.value) as 1 | 2 | 3)}
                disabled={submitting}
                size="sm"
                className="w-28"
              >
                <option value="1">串行</option>
                <option value="2">2 并发</option>
                <option value="3">3 并发</option>
              </Select>

              <Button
                variant="primary"
                size="md"
                loading={submitting}
                leftIcon={!submitting ? <RefreshCw className="w-4 h-4" /> : undefined}
                disabled={running}
                onClick={retry}
                className="ml-auto"
              >
                {submitting
                  ? "启动中…"
                  : selected.size > 0
                  ? `重试选中 (${selected.size} 集)`
                  : `一键重试全部 (${failedCount} 集)`}
              </Button>
            </div>
          </>
        )}

        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-lg p-2 text-xs text-danger flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {lastMessage && (
          <div className="bg-success/10 border border-success/40 rounded-lg p-2 text-xs text-success flex items-start gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{lastMessage}</span>
          </div>
        )}
      </div>
    </Card>
  );
}
