"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { getUser, getToken } from "../../../../lib/auth";
import { UserNav } from "../../../_UserNav";
import {
  ArrowLeft, Loader2, CheckCircle, XCircle, Clock,
  AlertCircle, Download, RefreshCw, RotateCcw, FileText,
  Zap, Package, BookOpen
} from "lucide-react";
import { Button, Card, Badge, Progress } from "@/components/ui";
import { KanbanView } from "./_KanbanView";
import { OutlineDetailModal } from "./_OutlineDetailModal";
import { DistributeModal } from "./_DistributeModal";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

type ExecutionStep = {
  step_name: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at?: string;
  finished_at?: string;
  duration?: number;
  input?: any;
  output?: any;
  error?: string;
  tokens_used?: number;
};

type Product = {
  id: number;
  product_type: string;
  draft_id?: number;
  parent_id?: number;
  title?: string;
  status: string;
  episode_count?: number;
  episodes?: number;
  completed_episodes?: number;
  words?: number;
  source_label?: string;
  protagonist?: string;
  download_url?: string;
  error?: string;
  created_at: string;
  finished_at?: string;
};

type JobDetail = {
  id: number;
  user_id: number;
  job_type: string;
  status: string;
  source_json: any;
  config_json: any;
  total_products: number;
  finished_products: number;
  failed_products: number;
  validation_json: any;
  retry_count: number;
  max_retries: number;
  error?: string;
  created_at: string;
  finished_at?: string;
  steps: ExecutionStep[];
  products: Product[];
  progress?: { status_message?: string; percent?: number };
  total_tokens?: number;
  total_cost?: number;
  target_episodes?: number;
  target_scripts?: number;
  task_name?: string;
  planned_dist_target_name?: string;
};

const JOB_TYPE_LABELS: Record<string, string> = {
  create_spawn: "从零创作",
  import_spawn: "导入剧本",
  batch_to_video: "批量转视频",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-500",
  running: "bg-blue-500",
  succeeded: "bg-green-500",
  partial_failed: "bg-yellow-500",
  failed: "bg-red-500",
  canceled: "bg-gray-400",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  succeeded: "已完成",
  partial_failed: "部分失败",
  failed: "失败",
  canceled: "已取消",
};

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  outline: "大纲",
  script: "剧本",
  novel: "小说",
  tweet: "推文",
  video: "视频",
};

// 大纲生命周期状态 → 用户友好标签与颜色
const OUTLINE_STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  generated: { label: "质检中", color: "bg-blue-500" },
  analyzed_v1: { label: "质检中", color: "bg-blue-500" },
  repairable_pending: { label: "优化中", color: "bg-yellow-500" },
  optimized_v1: { label: "二轮质检中", color: "bg-blue-500" },
  analyzed_v2: { label: "二轮质检中", color: "bg-blue-500" },
  repairable_pending_v2: { label: "二轮优化中", color: "bg-yellow-500" },
  ready_for_script: { label: "剧本生成中", color: "bg-purple-500" },
  spare: { label: "备用未启用", color: "bg-gray-400" },
  rejected_fatal: { label: "已淘汰", color: "bg-red-500" },
  rejected_fatal_v2: { label: "已淘汰", color: "bg-red-500" },
  generating: { label: "生成中", color: "bg-blue-500" },
  completed: { label: "已完成", color: "bg-green-500" },
  failed: { label: "失败", color: "bg-red-500" },
};

function productStatusDisplay(p: Product) {
  // 大纲: ready_for_script 表示已通过质检、剧本在生成; 剧本完成后回写为 completed
  // 剧本: 用集数进度判断是否真的完成(缺集时给出提示色)
  if (p.product_type === "script") {
    const done = p.completed_episodes ?? 0;
    const total = p.episodes ?? 0;
    if (p.status === "completed") {
      if (total && done < total) {
        return { label: `缺集 ${done}/${total}`, color: "bg-orange-500" };
      }
      return { label: "已完成", color: "bg-green-500" };
    }
    if (p.status === "generating") {
      return { label: total ? `生成中 ${done}/${total}` : "生成中", color: "bg-blue-500" };
    }
  }
  const d = OUTLINE_STATUS_DISPLAY[p.status];
  if (d) return d;
  return p.status === "completed"
    ? { label: "已完成", color: "bg-green-500" }
    : p.status === "failed"
    ? { label: "失败", color: "bg-red-500" }
    : { label: "生成中", color: "bg-blue-500" };
}

const STEP_LABELS: Record<string, string> = {
  generate_outline: "生成大纲",
  validate_outline: "校验大纲",
  optimize_outline: "优化大纲",
  generate_script: "生成剧本",
  validate_episodes: "校验集数",
  refine_script: "精修剧本",
  spawn_novel: "生成小说",
  spawn_tweet: "生成推文",
  generate_video: "生成视频",
  preprocess_content: "预处理内容",
  parse_structure: "解析结构",
};

export default function JobDetailPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/login?from=/factory";
      return null;
    }
  }

  const router = useRouter();
  const params = useParams();
  const jobId = params.id as string;
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // 产物内容查看弹窗
  const [viewingProduct, setViewingProduct] = useState<{ id: number; type: string; title?: string } | null>(null);
  // 正在补缺的剧本ID
  const [refillingId, setRefillingId] = useState<number | null>(null);
  // 分发弹窗
  const [showDistribute, setShowDistribute] = useState(false);

  // 加载任务详情
  const loadJobDetail = useCallback(async () => {
    try {
      const r = await fetch(`${API}/jobs/${jobId}`, {
        headers: authHeaders(),
      });

      if (!r.ok) {
        if (r.status === 404) {
          throw new Error("任务不存在");
        }
        throw new Error(`HTTP ${r.status}`);
      }

      const data = await r.json();
      setJob(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    loadJobDetail();
  }, [loadJobDetail]);

  // 轮询进行中的任务
  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "pending")) {
      return;
    }

    const timer = setInterval(() => {
      loadJobDetail();
    }, 3000);

    return () => clearInterval(timer);
  }, [job, loadJobDetail]);

  // 重试任务
  const handleRetry = async () => {
    setRetrying(true);
    setError("");

    try {
      const r = await fetch(`${API}/jobs/${jobId}/retry`, {
        method: "POST",
        headers: authHeaders(),
      });

      if (!r.ok) {
        const errData = await r.json().catch(() => ({ detail: "重试失败" }));
        throw new Error(errData.detail || "重试失败");
      }

      // 重新加载
      await loadJobDetail();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRetrying(false);
    }
  };

  // 导出剧本文本(单剧本txt/多剧本zip,由后端生成)
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    if (!job) return;
    setExporting(true);
    try {
      const r = await fetch(`${API}/jobs/${jobId}/export`, { headers: authHeaders() });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "导出失败" }));
        throw new Error(err.detail || "导出失败");
      }
      const blob = await r.blob();
      // 从Content-Disposition解析文件名
      const cd = r.headers.get("Content-Disposition") || "";
      let filename = `factory-job-${jobId}-剧本.docx`;
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      if (m) filename = decodeURIComponent(m[1]);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`❌ 导出失败: ${e.message}`);
    } finally {
      setExporting(false);
    }
  };


  // 剧本补缺: 对照大纲补齐缺失集数
  const handleRefill = async (productId: number) => {
    if (!confirm("将对照大纲分集，为该剧本补齐缺失的集数，确认发起补缺？")) return;
    setRefillingId(productId);
    try {
      const r = await fetch(`${API}/products/${productId}/refill`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "补缺失败" }));
        throw new Error(err.detail || "补缺失败");
      }
      alert("✅ 补缺任务已启动，剧本将逐集补齐，可刷新页面查看进度。");
      await loadJobDetail();
    } catch (e: any) {
      alert(`❌ 补缺失败: ${e.message}`);
    } finally {
      setRefillingId(null);
    }
  };

  // 一键补全集数: 为所有已完成但缺集的剧本批量发起补缺
  const [refillingAll, setRefillingAll] = useState(false);
  const handleRefillAll = async () => {
    if (!job) return;
    const incomplete = job.products.filter(
      (p) => p.product_type === "script" && p.status === "completed" &&
        (p.completed_episodes ?? 0) < (p.episodes ?? 0)
    );
    if (incomplete.length === 0) {
      alert("当前没有需要补缺的剧本");
      return;
    }
    if (!confirm(`共 ${incomplete.length} 部剧本存在集数缺失，将并发为它们补齐缺失集数，确认发起？`)) return;
    setRefillingAll(true);
    try {
      const r = await fetch(`${API}/jobs/${jobId}/refill-all`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "补缺失败" }));
        throw new Error(err.detail || "补缺失败");
      }
      const result = await r.json();
      const names = (result.scripts || []).map((s: any) => `《${s.title}》${s.done}/${s.total}`).join("、");
      alert(`✅ ${result.message}${names ? `\n${names}` : ""}\n补缺进行中，可刷新页面查看进度。`);
      await loadJobDetail();
    } catch (e: any) {
      alert(`❌ 一键补缺失败: ${e.message}`);
    } finally {
      setRefillingAll(false);
    }
  };

  // 同步到草稿
  const handleSyncToDraft = async () => {
    if (!job) return;
    setSyncing(true);
    try {
      const r = await fetch(`${API}/jobs/${jobId}/sync-to-draft`, {
        method: "POST",
        headers: authHeaders(),});
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "同步失败" }));
        throw new Error(err.detail || "同步失败");
      }
      const result = await r.json();
      const count = result.synced?.length || 0;
      alert(`✅ 同步完成！共同步${count} 个剧本到草稿列表，可前往草稿页查看完整内容。`);
      //刷新任务数据以更新 draft_id
      await loadJobDetail();
    } catch (e: any) {
      alert(`❌ 同步失败: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-base">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-base">
        <Card className="p-8 max-w-md">
          <AlertCircle className="w-12 h-12 mx-auto text-red-600 mb-4" />
          <h2 className="text-xl font-semibold text-center mb-2">加载失败</h2>
          <p className="text-center text-ink-secondary mb-4">{error || "未知错误"}</p>
          <Button onClick={() => router.push("/factory")} className="w-full">
            返回主页
          </Button>
        </Card>
      </div>
    );
  }

  const progress = job.total_products > 0
    ? ((job.finished_products + job.failed_products) / job.total_products) * 100
    : 0;

  return (
    <div className="flex h-screen bg-surface-base">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部导航 */}
        <header className="h-topbar border-b border-line flex items-center justify-between px-6 bg-surface-elevated">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/factory")}
              className="gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </Button>
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">任务详情 #{job.id}</h1>
            </div>
          </div>
          <UserNav />
        </header>

        {/* 主体内容 */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-[1600px] mx-auto space-y-6">
            {/* 任务概览 */}
            <Card className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h2 className="text-2xl font-semibold">
                      {job.task_name || JOB_TYPE_LABELS[job.job_type]}
                    </h2>
                    <Badge className={`${STATUS_COLORS[job.status]} text-white`}>
                      {STATUS_LABELS[job.status]}
                    </Badge>
                    {job.task_name && (
                      <span className="text-sm text-ink-secondary">{JOB_TYPE_LABELS[job.job_type]}</span>
                    )}
                    {job.planned_dist_target_name && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 border border-purple-300 text-purple-700">
                        预期分发: {job.planned_dist_target_name}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-ink-secondary space-y-1">
                    <p>创建时间: {new Date(job.created_at.includes("Z") || job.created_at.includes("+") ? job.created_at : job.created_at + "Z").toLocaleString("zh-CN")}</p>
                    {job.finished_at && (
                      <p>完成时间: {new Date(job.finished_at.includes("Z") || job.finished_at.includes("+") ? job.finished_at : job.finished_at + "Z").toLocaleString("zh-CN")}</p>
                    )}
                    {job.finished_at && (
                      <p>
                        耗时:{" "}
                        {Math.round(
                          (new Date(job.finished_at).getTime() -
                            new Date(job.created_at).getTime()) /
                            1000 / 60
                        )}{" "}
                        分钟
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={loadJobDetail}
                    disabled={loading}
                  >
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                  {(job.status === "failed" || job.status === "partial_failed") &&
                    job.retry_count < job.max_retries && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRetry}
                        disabled={retrying}
                      >
                        {retrying ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <RotateCcw className="w-4 h-4 mr-1" />
                        )}
                        重试
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
                    {exporting ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 mr-1" />
                    )}
                    导出剧本
                  </Button>
                  {(() => {
                    const incompleteCount = job.products.filter(
                      (p) => p.product_type === "script" && p.status === "completed" &&
                        (p.completed_episodes ?? 0) < (p.episodes ?? 0)
                    ).length;
                    if (incompleteCount === 0) return null;
                    return (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-orange-600 border-orange-300 hover:bg-orange-50"
                        onClick={handleRefillAll}
                        disabled={refillingAll}
                      >
                        {refillingAll ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <RotateCcw className="w-4 h-4 mr-1" />
                        )}
                        一键补全集数 ({incompleteCount})
                      </Button>
                    );
                  })()}
                  {job.job_type !== "batch_video" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDistribute(true)}
                    >
                      <Zap className="w-4 h-4 mr-1" />
                      分发
                    </Button>
                  )}
                  {job.job_type !== "batch_video" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSyncToDraft}
                      disabled={syncing}
                    >
                      {syncing ? (<Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <BookOpen className="w-4 h-4 mr-1" />
                      )}
                      同步到草稿
                    </Button>
                  )}
                </div>
              </div>

              {/* 进度条 */}
              {job.total_products > 0 && (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span>产物进度</span>
                    <span>
                      {job.finished_products + job.failed_products} / {job.total_products}
                    </span>
                  </div>
                  <Progress percent={progress} />
                  <div className="flex items-center justify-between text-xs text-ink-secondary mt-1">
                    <span className="text-green-600">成功 {job.finished_products}</span>
                    {job.failed_products > 0 && (
                      <span className="text-red-600">失败 {job.failed_products}</span>
                    )}
                  </div>
                </div>
              )}

              {/* Token 统计 */}
              {job.total_tokens && job.total_tokens > 0 && (
                <div className="grid grid-cols-2 gap-4 p-4 bg-surface-elevated rounded-lg">
                  <div>
                    <div className="text-sm text-ink-secondary">Token 消耗</div>
                    <div className="text-xl font-semibold">
                      {job.total_tokens.toLocaleString()}
                    </div>
                  </div>
                  {job.total_cost && (
                    <div>
                      <div className="text-sm text-ink-secondary">预估成本</div>
                      <div className="text-xl font-semibold">
                        ¥{job.total_cost.toFixed(2)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {job.error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{job.error}</span>
                </div>
              )}

              {/* 实时状态消息(任务进行中) */}
              {job.status === "running" && job.progress?.status_message && (
                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2 text-blue-700">
                  <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
                  <span className="text-sm">{job.progress.status_message}</span>
                </div>
              )}
            </Card>

            {/* 执行步骤时间线 */}
            {job.steps && job.steps.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">执行步骤</h3>
                <div className="space-y-4">
                  {job.steps.map((step, index) => {
                    const Icon =
                      step.status === "completed"
                        ? CheckCircle
                        : step.status === "failed"
                        ? XCircle
                        : step.status === "running"
                        ? Loader2
                        : Clock;

                    return (
                      <div key={index} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center ${
                              step.status === "completed"
                                ? "bg-green-100"
                                : step.status === "failed"
                                ? "bg-red-100"
                                : step.status === "running"
                                ? "bg-blue-100"
                                : "bg-gray-100"
                            }`}
                          >
                            <Icon
                              className={`w-5 h-5 ${
                                step.status === "completed"
                                  ? "text-green-600"
                                  : step.status === "failed"
                                  ? "text-red-600"
                                  : step.status === "running"
                                  ? "text-blue-600 animate-spin"
                                  : "text-gray-400"
                              }`}
                            />
                          </div>
                          {index < job.steps.length - 1 && (
                            <div className="w-0.5 h-full min-h-[40px] bg-line mt-2" />
                          )}
                        </div>

                        <div className="flex-1 pb-4">
                          <div className="font-medium">
                            {STEP_LABELS[step.step_name] || step.step_name}
                          </div>
                          <div className="text-sm text-ink-secondary mt-1">
                            {step.started_at && (
                              <span>
                                开始: {new Date(step.started_at).toLocaleTimeString("zh-CN")}
                              </span>
                            )}
                            {step.finished_at && (
                              <span className="ml-4">
                                完成: {new Date(step.finished_at).toLocaleTimeString("zh-CN")}
                              </span>
                            )}
                            {step.duration && (
                              <span className="ml-4">耗时: {step.duration}秒</span>
                            )}
                            {step.tokens_used && (
                              <span className="ml-4">
                                Token: {step.tokens_used.toLocaleString()}
                              </span>
                            )}
                          </div>

                          {step.error && (
                            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                              {step.error}
                            </div>
                          )}

                          {step.output && (
                            <details className="mt-2">
                              <summary className="text-sm text-primary cursor-pointer">
                                查看输出
                              </summary>
                              <pre className="mt-2 p-3 bg-surface-elevated rounded text-xs overflow-auto max-h-40">
                                {JSON.stringify(step.output, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* V4大纲生产看板 - 仅对create_spawn任务显示,任务进行中自动轮询 */}
            {job.job_type === "create_spawn" && (
              <KanbanTraceCard jobId={parseInt(jobId)} jobStatus={job.status} />
            )}

            {/* 作品列表 — 一行一部作品(剧本为主体,大纲为其前置阶段) */}
            {(() => {
              const scripts = job.products.filter((p) => p.product_type === "script");
              const outlines = job.products.filter((p) => p.product_type === "outline");
              // 裂变产物(小说/推文/视频等) — 导入剧本裂变任务的主产物
              const spawned = job.products.filter(
                (p) => !["script", "outline"].includes(p.product_type)
              );
              const others: Product[] = [];
              // 剧本 → 其大纲(parent_id 关联)
              const outlineById = new Map(outlines.map((o) => [o.id, o]));
              const usedOutlineIds = new Set<number>();
              const works = scripts.map((s) => {
                const o = s.parent_id ? outlineById.get(s.parent_id) : undefined;
                if (o) usedOutlineIds.add(o.id);
                return { script: s, outline: o };
              });
              // 没有对应剧本的大纲: 淘汰/备用/仍在质检中
              const orphanOutlines = outlines.filter((o) => !usedOutlineIds.has(o.id));
              return (
            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  作品列表
                </h3>
                <span className="text-sm text-ink-secondary">
                  {works.length} 部作品
                  {job.target_scripts ? ` / 目标 ${job.target_scripts}` : ""}
                  {others.length > 0 ? ` · 其他产物 ${others.length}` : ""}
                </span>
              </div>

              {works.length === 0 && orphanOutlines.length === 0 ? (
                <div className="text-center py-8 text-ink-secondary">
                  暂无产物
                </div>
              ) : (
                <div className="space-y-3">
                  {works.map(({ script: product, outline }) => (
                    <div
                      key={product.id}
                      className="p-4 border border-line rounded-lg hover:border-primary transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">
                              {product.title || `作品 #${product.id}`}
                            </span>
                            <Badge className={`${productStatusDisplay(product).color} text-white`}>
                              {productStatusDisplay(product).label}
                            </Badge>
                          </div>

                          <div className="text-sm text-ink-secondary space-y-1">
                            {(product.episodes || product.completed_episodes) ? (
                              <p className={
                                (product.completed_episodes ?? 0) < (product.episodes ?? 0) && product.status !== "generating"
                                  ? "text-orange-600 font-medium"
                                  : ""
                              }>
                                集数: {product.completed_episodes ?? 0} / {product.episodes ?? "?"}
                                {product.words ? ` · ${product.words.toLocaleString()}字` : ""}
                                {(product.completed_episodes ?? 0) < (product.episodes ?? 0) && product.status !== "generating" && (
                                  <span className="ml-1">⚠️ 缺 {(product.episodes ?? 0) - (product.completed_episodes ?? 0)} 集</span>
                                )}
                              </p>
                            ) : product.episode_count ? (
                              <p>集数: {product.episode_count}</p>
                            ) : null}
                            <p>
                              创建时间:{" "}
                              {new Date(product.created_at.includes("Z")||product.created_at.includes("+")?product.created_at:product.created_at+"Z").toLocaleString("zh-CN")}
                              {outline && (
                                <button
                                  className="ml-3 text-primary hover:underline"
                                  onClick={() => setViewingProduct({ id: outline.id, type: "outline", title: `${outline.title}(大纲)` })}
                                >
                                  查看大纲
                                </button>
                              )}
                            </p>
                          </div>

                          {product.error && (
                            <div className="mt-2 text-sm text-red-600 flex items-center gap-1">
                              <AlertCircle className="w-4 h-4" />
                              {product.error}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col gap-2 ml-4">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setViewingProduct({
                              id: product.id,
                              type: product.product_type,
                              title: product.title,
                            })}
                          >
                            查看内容
                          </Button>
                          {product.product_type === "script" &&
                            product.status === "completed" &&
                            (product.completed_episodes ?? 0) < (product.episodes ?? 0) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-orange-600 border-orange-300 hover:bg-orange-50"
                              disabled={refillingId === product.id}
                              onClick={() => handleRefill(product.id)}
                            >
                              {refillingId === product.id ? (
                                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                              ) : null}
                              补缺集数
                            </Button>
                          )}
                          {product.status === "completed" && product.draft_id && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/drafts/${product.draft_id}`)}
                            >
                              草稿
                            </Button>
                          )}
                          {product.status === "completed" && product.download_url && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => window.open(product.download_url, "_blank")}
                            >
                              <Download className="w-4 h-4 mr-1" />
                              下载
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => router.push(`/factory/products/${product.id}`)}
                          >
                            追溯
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 裂变产物(小说/推文等) — 导入剧本裂变任务的主产物 */}
              {spawned.length > 0 && (
                <div className={works.length > 0 ? "mt-4" : ""}>
                  <div className="text-sm font-medium mb-2">
                    裂变产物 ({spawned.length})
                  </div>
                  <div className="space-y-3">
                    {spawned.map((product) => (
                      <div
                        key={product.id}
                        className="p-4 border border-line rounded-lg hover:border-primary transition-colors"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-medium">
                                {product.title || `产物 #${product.id}`}
                              </span>
                              <Badge className="bg-purple-500 text-white text-xs">
                                {PRODUCT_TYPE_LABELS[product.product_type] || product.product_type}
                              </Badge>
                              <Badge className={`${productStatusDisplay(product).color} text-white`}>
                                {productStatusDisplay(product).label}
                              </Badge>
                            </div>
                            <div className="text-sm text-ink-secondary">
                              {(product.episodes || product.completed_episodes) ? (
                                <span>
                                  进度: {product.completed_episodes ?? 0} / {product.episodes ?? "?"} 章
                                  {product.words ? ` · ${product.words.toLocaleString()}字` : ""}
                                </span>
                              ) : null}
                              {product.source_label && (
                                <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-300 text-slate-600 text-xs">
                                  来源于: {product.source_label}
                                </span>
                              )}
                              {product.protagonist && (
                                <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-300 text-amber-700 text-xs">
                                  第一人称: {product.protagonist}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 ml-4">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setViewingProduct({
                                id: product.id,
                                type: product.product_type,
                                title: product.title,
                              })}
                            >
                              查看内容
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 未产出剧本的大纲(淘汰/备用/质检中) — 折叠收纳,不与作品混排 */}
              {orphanOutlines.length > 0 && (
                <details className="mt-4">
                  <summary className="text-sm text-ink-secondary cursor-pointer hover:text-primary">
                    其他大纲 ({orphanOutlines.length}) — 被淘汰 / 备用 / 未进入剧本阶段
                  </summary>
                  <div className="mt-2 space-y-2">
                    {orphanOutlines.map((o) => (
                      <div
                        key={o.id}
                        className="p-3 border border-line rounded-lg flex items-center justify-between text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span>{o.title || `大纲 #${o.id}`}</span>
                          <Badge className={`${productStatusDisplay(o).color} text-white text-xs`}>
                            {productStatusDisplay(o).label}
                          </Badge>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setViewingProduct({ id: o.id, type: "outline", title: o.title })}
                        >
                          查看
                        </Button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </Card>
              );
            })()}
          </div>
        </main>
      </div>

      {/* 产物内容查看弹窗 */}
      {viewingProduct && (
        <ProductModal
          productId={viewingProduct.id}
          productType={viewingProduct.type}
          title={viewingProduct.title}
          onClose={() => setViewingProduct(null)}
        />
      )}

      {/* 分发到飞书弹窗 */}
      {showDistribute && (
        <DistributeModal jobId={parseInt(jobId)} onClose={() => setShowDistribute(false)} />
      )}
    </div>
  );
}

// V4看板追溯卡片 - 任务进行中每3秒轮询刷新
function KanbanTraceCard({ jobId, jobStatus }: { jobId: number; jobStatus: string }) {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const [traceData, setTraceData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedOutline, setSelectedOutline] = useState<any>(null);

  const loadTrace = useCallback(async () => {
    try {
      const r = await fetch(`${API}/jobs/${jobId}/debug`, { headers: authHeaders() });
      if (r.ok) {
        setTraceData(await r.json());
      }
    } catch (e) {
      console.error("Failed to load trace:", e);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // 首次加载
  useEffect(() => {
    loadTrace();
  }, [loadTrace]);

  // 任务进行中持续轮询看板数据
  useEffect(() => {
    if (jobStatus !== "running" && jobStatus !== "pending") return;
    const timer = setInterval(loadTrace, 3000);
    return () => clearInterval(timer);
  }, [jobStatus, loadTrace]);

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <KanbanView traceData={traceData} onOpenDetail={setSelectedOutline} />
      {selectedOutline && (
        <OutlineDetailModal
          outline={selectedOutline}
          traceData={traceData}
          onClose={() => setSelectedOutline(null)}
        />
      )}
    </>
  );
}

// V2追溯卡片组件(旧版,保留向下兼容)
function V2TraceCard({ jobId }: { jobId: number }) {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const [traceData, setTraceData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expandedOutlines, setExpandedOutlines] = useState<Set<number>>(new Set());
  const [selectedProduct, setSelectedProduct] = useState<any>(null);

  useEffect(() => {
    const loadTrace = async () => {
      try {
        const r = await fetch(`${API}/jobs/${jobId}/debug`, { headers: authHeaders() });
        if (r.ok) {
          setTraceData(await r.json());
        }
      } catch (e) {
        console.error("Failed to load trace:", e);
      } finally {
        setLoading(false);
      }
    };
    loadTrace();
  }, [jobId]);

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  if (!traceData || traceData.mode !== "v2") return null;

  const { outline_generation, chapter_generation, discarded_outlines } = traceData;
  const { raw_outlines, analyzed_results, optimized_outlines } = outline_generation;

  const toggleOutline = (id: number) => {
    const newSet = new Set(expandedOutlines);
    newSet.has(id) ? newSet.delete(id) : newSet.add(id);
    setExpandedOutlines(newSet);
  };

  return (
    <>
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5 text-purple-500" />
          大纲生产追溯(完整质量检查)
        </h3>

        {/* 统计 */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
            <p className="text-xs text-blue-700 mb-1">原始大纲</p>
            <p className="text-2xl font-bold text-blue-900">{raw_outlines.length}</p>
          </div>
          <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200">
            <p className="text-xs text-yellow-700 mb-1">AI分析</p>
            <p className="text-2xl font-bold text-yellow-900">{analyzed_results.length}</p>
          </div>
          <div className="p-3 bg-green-50 rounded-lg border border-green-200">
            <p className="text-xs text-green-700 mb-1">优化采纳</p>
            <p className="text-2xl font-bold text-green-900">{optimized_outlines.length}</p>
          </div>
          <div className="p-3 bg-red-50 rounded-lg border border-red-200">
            <p className="text-xs text-red-700 mb-1">舍弃</p>
            <p className="text-2xl font-bold text-red-900">{discarded_outlines.length}</p>
          </div>
        </div>

        {/* 大纲列表 */}
        <div className="space-y-3">
          {raw_outlines.map((raw: any) => {
            const analysis = analyzed_results.find((a: any) => a.from_product_id === raw.id);
            const optimized = optimized_outlines.find((o: any) => o.from_product_id === analysis?.id);
            const chapters = chapter_generation.chapters.filter((c: any) => c.from_outline_id === (optimized?.id || raw.id));
            
            const isDiscarded = analysis && !analysis.fixable;
            const isAdopted = optimized && chapters.length > 0;
            const isExpanded = expandedOutlines.has(raw.id);

            return (
              <div
                key={raw.id}
                className={`border rounded-lg overflow-hidden ${
                  isDiscarded ? "border-red-300 bg-red-50/30" :
                  isAdopted ? "border-green-300 bg-green-50/30" :
                  "border-gray-300"
                }`}
              >
                <button
                  onClick={() => toggleOutline(raw.id)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-black/5 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 flex-1">
                    <div className="text-lg">{isExpanded ? "▼" : "▶"}</div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">大纲 #{raw.id}</span>
                        {isDiscarded && <Badge className="bg-red-500 text-white text-xs">已舍弃</Badge>}
                        {isAdopted && <Badge className="bg-green-500 text-white text-xs">已采纳 · {chapters.length}个剧本</Badge>}
                        {!isDiscarded && !isAdopted && <Badge className="bg-gray-500 text-white text-xs">处理中</Badge>}
                      </div>
                      <p className="text-xs text-ink-secondary mt-1">{raw.created_at}</p>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-line/30 bg-white space-y-3 pt-3">
                    {/* 原始大纲 */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <h5 className="text-sm font-medium">1. 原始大纲</h5>
                        <Button size="sm" variant="ghost" onClick={() => setSelectedProduct({type: "outline", id: raw.id})}>
                          查看完整内容
                        </Button>
                      </div>
                      <div className="p-2 bg-gray-50 rounded text-xs text-gray-600">
                        {raw.content.substring(0, 150)}...
                      </div>
                    </div>

                    {/* AI判断 */}
                    {analysis && (
                      <div>
                        <h5 className="text-sm font-medium mb-2">2. AI质量判断</h5>
                        <div className={`p-3 rounded border ${
                          analysis.fixable ? "bg-yellow-50 border-yellow-200" : "bg-red-50 border-red-200"
                        }`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-sm font-medium ${
                              analysis.fixable ? "text-yellow-700" : "text-red-700"
                            }`}>
                              {analysis.fixable ? "✓ 可优化" : "✗ 无法修复"}
                            </span>
                          </div>
                          {analysis.issues && analysis.issues.length > 0 && (
                            <ul className="text-xs space-y-1">
                              {analysis.issues.slice(0, 3).map((issue: string, i: number) => (
                                <li key={i} className="text-gray-700">• {issue}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 优化结果 */}
                    {optimized && (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="text-sm font-medium">3. 优化后大纲</h5>
                          <Button size="sm" variant="ghost" onClick={() => setSelectedProduct({type: "outline", id: optimized.id})}>
                            查看完整内容
                          </Button>
                        </div>
                        <div className="p-2 bg-green-50 rounded text-xs text-green-700 border border-green-200">
                          {optimized.content.substring(0, 150)}...
                        </div>
                      </div>
                    )}

                    {/* 剧本 */}
                    {chapters.length > 0 && (
                      <div>
                        <h5 className="text-sm font-medium mb-2">4. 生成的剧本</h5>
                        <div className="space-y-2">
                          {chapters.map((ch: any) => (
                            <div
                              key={ch.id}
                              className="p-2 bg-white rounded border border-line hover:border-primary transition-colors cursor-pointer flex items-center justify-between"
                              onClick={() => setSelectedProduct({type: "script", id: ch.id, title: ch.title})}
                            >
                              <span className="text-sm">{ch.title}</span>
                              <Button size="sm" variant="ghost">查看</Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {selectedProduct && (
        <ProductModal
          productId={selectedProduct.id}
          productType={selectedProduct.type}
          title={selectedProduct.title}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </>
  );
}

// 产物查看模态框
function ProductModal({ productId, productType, title, onClose }: any) {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const [content, setContent] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadContent = async () => {
      try {
        const r = await fetch(`${API}/products/${productId}`, { headers: authHeaders() });
        if (r.ok) {
          const data = await r.json();
          const parsed = typeof data.content === "string" ? JSON.parse(data.content) : data.content;
          setContent(parsed);
        }
      } catch (e) {
        console.error("Failed to load product:", e);
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [productId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-line flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title || `${productType} #${productId}`}</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded transition-colors">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : ["script", "novel", "tweet"].includes(productType) && content?.chapters ? (
            <div className="space-y-6">
              {content.chapters.map((ch: any, i: number) => (
                <div key={i} className="border-b border-line pb-6 last:border-0">
                  <h4 className="text-md font-semibold mb-3">
                    第{ch.order || i+1}集: {ch.title}
                  </h4>
                  <div className="text-sm text-ink-secondary mb-2">字数: {ch.word_count || 0}</div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{ch.content}</div>
                </div>
              ))}
            </div>
          ) : productType === "outline" && content ? (
            <div>
              <h4 className="text-md font-semibold mb-3">{content.title || "大纲"}</h4>
              {content.synopsis && (
                <div className="mb-4">
                  <h5 className="text-sm font-medium mb-2">简介</h5>
                  <p className="text-sm text-gray-700">{content.synopsis}</p>
                </div>
              )}
              {content.chapters && (
                <div>
                  <h5 className="text-sm font-medium mb-2">章节 ({content.chapters.length})</h5>
                  <div className="space-y-2">
                    {content.chapters.map((ch: any, i: number) => (
                      <div key={i} className="p-2 bg-gray-50 rounded text-sm">
                        <div className="font-medium">第{ch.order || i+1}章: {ch.title}</div>
                        <div className="text-xs text-gray-600 mt-1">{ch.summary}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <pre className="text-xs bg-gray-100 p-4 rounded overflow-auto">
              {JSON.stringify(content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
