"use client";
import { authFetch } from "../../../lib/auth";
import { notifyError, notifySuccess, notify } from "@/lib/dialog";
import { useEffect, useRef, useState } from "react";
import { Download, Lock, FileText, Film, Cloud, RotateCcw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";
import { Progress } from "@/components/ui/Progress";
import { Badge } from "@/components/ui/Badge";
import { phase5Exports, type ExportJob } from "@/lib/phase5";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type SuggestItem = {
  chapter_order: number;
  title: string;
  locked: boolean;
  has_full_text: boolean;
  has_storyboard: boolean;
  word_count: number;
  suggested_source: "chapter" | "storyboard";
};

type Mode = "auto" | "all_chapter" | "all_storyboard" | "manual";

/**
 * 导出混合 Modal — Phase 5 §12.6.3 重做版,新增异步任务化:
 *   - 「即时下载」(原模式): 同步等服务端生成完毕, 直接 blob 下载
 *   - 「提交后台任务」(新): POST /v1/export-jobs, 把任务塞给 BackgroundTasks,
 *      前端轮询 /v1/export-jobs/{id} 看进度, done 后给 OSS 预签名下载 URL
 *
 * 原同步模式保留, 适合小剧本(<10 集); 大剧本(>=20 集)推荐用后台模式以避免请求超时。
 */
export function ExportMixedModal({
  draftId,
  draftTitle,
  open,
  onClose,
}: {
  draftId: number;
  draftTitle: string;
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("auto");
  const [manual, setManual] = useState<Record<string, "chapter" | "storyboard">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 后台任务状态
  const [jobId, setJobId] = useState<number | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadSuggest() {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/export-source-suggest`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const lst: SuggestItem[] = data.items || [];
      setItems(lst);
      const m: Record<string, "chapter" | "storyboard"> = {};
      for (const it of lst) m[String(it.chapter_order)] = it.suggested_source;
      setManual(m);
    } catch (e: any) {
      setError(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      loadSuggest();
      setMode("auto");
      setJobId(null);
      setJob(null);
    } else {
      // 关闭时清理轮询
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 轮询: jobId 变化时启动
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    async function tick() {
      if (cancelled || !jobId) return;
      try {
        const data = await phase5Exports.get(jobId);
        if (cancelled) return;
        setJob(data);
        if (data.status === "done") {
          notifySuccess("导出完成,可下载");
          return;
        }
        if (data.status === "failed") {
          notifyError("导出失败: " + (data.error || "未知"));
          return;
        }
        // 继续轮询: 1.5s 间隔
        pollTimerRef.current = setTimeout(tick, 1500);
      } catch (e: any) {
        if (cancelled) return;
        // 失败也继续轮询几次, 网络抖动兜底
        pollTimerRef.current = setTimeout(tick, 3000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [jobId]);

  /** 同步导出: 直接 blob 下载 (原行为) */
  async function handleSyncExport() {
    setBusy(true);
    setError(null);
    try {
      const body: any = { mode };
      if (mode === "manual") body.chapter_sources = manual;
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/export-mixed-docx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = r.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      a.download = m ? decodeURIComponent(m[1]) : `${draftTitle}_完整剧本.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e: any) {
      setError(e.message || "导出失败");
      notifyError(e.message || "导出失败");
    } finally {
      setBusy(false);
    }
  }

  /** 异步导出: 提交后台任务 + 轮询 */
  async function handleAsyncExport() {
    setBusy(true);
    setError(null);
    try {
      const config: any = { mode };
      if (mode === "manual") config.chapter_sources = manual;
      const res = await phase5Exports.create({
        draft_id: draftId,
        kind: "mixed_docx",
        config,
      });
      setJobId(res.id);
      setJob({
        id: res.id,
        draft_id: draftId,
        kind: "mixed_docx",
        status: res.status as any,
        progress: 0,
        output_url: "",
        error: "",
      });
      notify(`已提交后台任务 #${res.id}`);
    } catch (e: any) {
      setError(e.message || "提交失败");
      notifyError(e.message || "提交失败");
    } finally {
      setBusy(false);
    }
  }

  function resetJob() {
    setJobId(null);
    setJob(null);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  // 计数
  let cntChapter = 0;
  let cntStory = 0;
  for (const it of items) {
    let s: "chapter" | "storyboard";
    if (mode === "all_chapter") s = "chapter";
    else if (mode === "all_storyboard") s = "storyboard";
    else if (mode === "manual") s = manual[String(it.chapter_order)] || it.suggested_source;
    else s = it.locked ? "chapter" : (it.has_storyboard ? "storyboard" : "chapter");
    if (s === "chapter" && !it.has_full_text && it.has_storyboard) s = "storyboard";
    else if (s === "storyboard" && !it.has_storyboard && it.has_full_text) s = "chapter";
    if (s === "chapter") cntChapter++; else cntStory++;
  }

  // 任务进行中或已完成时的 footer
  const jobActive = !!job;
  const footer = jobActive ? (
    <div className="flex justify-end gap-2 w-full">
      <Button variant="ghost" size="md" leftIcon={<RotateCcw className="w-4 h-4" />} onClick={resetJob}>
        重新配置
      </Button>
      {job?.status === "done" && job.output_url && (
        <Button
          variant="primary"
          size="md"
          leftIcon={<Download className="w-4 h-4" />}
          onClick={() => window.open(job.output_url, "_blank")}
        >
          下载 Word
        </Button>
      )}
      <Button variant="secondary" size="md" onClick={onClose}>关闭</Button>
    </div>
  ) : (
    <div className="flex justify-end gap-2 w-full">
      <Button variant="secondary" size="md" onClick={onClose} disabled={busy}>取消</Button>
      <Button
        variant="ghost"
        size="md"
        loading={busy}
        disabled={items.length === 0}
        leftIcon={!busy ? <Cloud className="w-4 h-4" /> : undefined}
        onClick={handleAsyncExport}
        title="后台生成,大剧本推荐"
      >
        提交后台任务
      </Button>
      <Button
        variant="primary"
        size="md"
        loading={busy}
        disabled={items.length === 0}
        leftIcon={!busy ? <Download className="w-4 h-4" /> : undefined}
        onClick={handleSyncExport}
      >
        {busy ? "导出中..." : "立即下载"}
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Download className="w-5 h-5 text-primary" />
          导出剧本 · 双源混合
        </span>
      }
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-lg p-3 text-sm text-danger">{error}</div>
        )}

        {/* 后台任务进度面板 */}
        {jobActive && job && (
          <Card padding="md" className="border-primary/40 bg-primary/5">
            <div className="flex items-center gap-2 mb-2">
              <Cloud className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold text-ink-primary">后台任务 #{job.id}</span>
              {job.status === "pending" && <Badge tone="muted" size="sm">排队中</Badge>}
              {job.status === "running" && <Badge tone="info" size="sm">运行中</Badge>}
              {job.status === "done" && <Badge tone="success" size="sm">已完成</Badge>}
              {job.status === "failed" && <Badge tone="danger" size="sm">失败</Badge>}
            </div>
            <Progress percent={job.progress || (job.status === "done" ? 100 : 5)} />
            <div className="text-xs text-ink-muted mt-2">
              {job.status === "running" && `进度: ${job.progress || 0}%`}
              {job.status === "pending" && "已加入队列, 等待 worker 处理…"}
              {job.status === "done" && "导出完成, 链接 24 小时内有效"}
              {job.status === "failed" && (job.error || "失败原因未知")}
            </div>
          </Card>
        )}

        {!jobActive && loading ? (
          <div className="flex items-center gap-2 text-ink-secondary text-sm">
            <Spinner size="sm" /> 加载章节信息...
          </div>
        ) : !jobActive ? (
          <>
            {/* 模式选择 */}
            <div className="space-y-2">
              <label className="block text-sm text-ink-primary">导出模式</label>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <ModeRadio checked={mode === "auto"} onChange={() => setMode("auto")} label="🎯 智能模式 (推荐)" desc="已锁定章节用原文,其他章节用 AI 剧本" />
                <ModeRadio checked={mode === "all_chapter"} onChange={() => setMode("all_chapter")} label="📖 全部用原文" desc="所有章节用 ScriptChapter.full_text" />
                <ModeRadio checked={mode === "all_storyboard"} onChange={() => setMode("all_storyboard")} label="🎬 全部用剧本" desc="所有章节用 AI 生成的剧本" />
                <ModeRadio checked={mode === "manual"} onChange={() => setMode("manual")} label="🔧 自定义" desc="逐集勾选每集的内容来源" />
              </div>
            </div>

            {/* 当前选择汇总 */}
            <Card padding="sm" className="bg-surface-base">
              <div className="text-sm flex items-center gap-4 flex-wrap">
                <span className="text-ink-secondary">本次导出:</span>
                <span><FileText className="inline w-4 h-4 text-warning mr-1" />原文 <b>{cntChapter}</b> 集</span>
                <span><Film className="inline w-4 h-4 text-primary mr-1" />剧本 <b>{cntStory}</b> 集</span>
                <span className="ml-auto text-xs text-ink-muted">共 {items.length} 集</span>
              </div>
            </Card>

            {/* 自定义模式: 逐集表 */}
            {mode === "manual" && (
              <div className="border border-line rounded-lg overflow-hidden">
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-base sticky top-0">
                      <tr className="text-ink-primary">
                        <th className="px-3 py-2 text-left">集</th>
                        <th className="px-3 py-2 text-left">标题</th>
                        <th className="px-3 py-2 text-center">状态</th>
                        <th className="px-3 py-2 text-center">来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => {
                        const cur = manual[String(it.chapter_order)] || it.suggested_source;
                        return (
                          <tr key={it.chapter_order} className="border-t border-line">
                            <td className="px-3 py-2 text-ink-secondary">{it.chapter_order}</td>
                            <td className="px-3 py-2 text-ink-primary">
                              {it.title}
                              {it.locked && <Lock className="inline w-3 h-3 ml-1 text-warning" />}
                            </td>
                            <td className="px-3 py-2 text-center text-xs text-ink-muted">
                              <span className={it.has_full_text ? "text-warning" : "text-ink-muted line-through"}>原文</span>
                              {" / "}
                              <span className={it.has_storyboard ? "text-primary" : "text-ink-muted line-through"}>剧本</span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <Select
                                value={cur}
                                onChange={(e) => {
                                  const m = { ...manual, [String(it.chapter_order)]: e.target.value as any };
                                  setManual(m);
                                }}
                                className="!w-24 text-xs"
                              >
                                <option value="chapter" disabled={!it.has_full_text}>原文</option>
                                <option value="storyboard" disabled={!it.has_storyboard}>剧本</option>
                              </Select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <p className="text-xs text-ink-muted">
              💡「立即下载」适合小剧本; 大剧本(20 集以上)推荐「提交后台任务」, 服务端生成后给链接, 不会请求超时。
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function ModeRadio({
  checked, onChange, label, desc,
}: { checked: boolean; onChange: () => void; label: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`text-left p-3 rounded-lg border transition ${
        checked
          ? "bg-primary/10 border-primary/60"
          : "bg-surface-base border-line hover:border-line-strong"
      }`}
    >
      <div className="font-medium text-ink-primary">{label}</div>
      <div className="text-xs text-ink-muted mt-1">{desc}</div>
    </button>
  );
}
