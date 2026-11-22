"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import {
  ArrowLeft, Factory, Loader2, XCircle, Zap,
  RefreshCw, FileUp, Sparkles, Video, Keyboard,
} from "lucide-react";
import { Progress } from "@/components/ui";
import { PipelinePanel } from "./_PipelinePanel";
import { LibraryPanel } from "./_LibraryPanel";
import { UsagePanel } from "./_UsagePanel";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

// ---------- types ----------
type QueueJob = {
  id: number; job_type: string; status: string;
  task_name: string; theme: string;
  planned_scripts?: number; planned_episodes?: number;
  percent?: number; status_message: string;
  total_products: number; finished_products: number;
  failed_products: number; generating_products: number;
  total_tokens: number; error?: string;
  created_at?: string; finished_at?: string;
};
type WorkspaceState = {
  queue: { running: QueueJob[]; pending: QueueJob[]; failed: QueueJob[]; done: QueueJob[] };
  kpi: { jobs: number; success: number; failed: number; success_rate: number; tokens: number; running: number; pending: number };
  providers: Record<string, { ok: number; err: number; last_ok?: string; last_err?: string; last_err_msg?: string; status: string }>;
  node_stats: Array<{ stage: string; calls: number; tokens: number; avg_tokens: number }>;
  provider_usage: Array<{ provider: string; calls: number; tokens: number }>;
  pipeline_runs: Array<{ id: number; pipeline_name: string; status: string; current_step: number; total_steps: number; step_runs: any[]; error?: string }>;
  events: Array<{ ts: string; level: string; text: string }>;
};

const JOB_TYPE_LABELS: Record<string, string> = {
  create_spawn: "从零创作", import_spawn: "导入裂变", batch_to_video: "批量转视频",
};
const STAGE_LABELS: Record<string, string> = {
  brainstorm: "创意", outline: "大纲", check: "质检",
  script: "剧本", novel: "小说", tweet: "推文", other: "未标记",
};
const STAGE_ORDER = ["brainstorm", "outline", "check", "script", "novel", "tweet", "other"];
const fmtTok = (n: number) => n >= 10000 ? (n / 10000).toFixed(1) + "万" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";

// ---------- 左栏: 单个队列任务行 ----------
function QueueRow({ job, selected, onClick }: { job: QueueJob; selected: boolean; onClick: () => void }) {
  const dot = job.status === "running" ? "bg-blue-500 animate-pulse"
    : job.status === "pending" ? "bg-amber-400"
    : job.status === "failed" || job.status === "partial_failed" ? "bg-red-500"
    : "bg-emerald-500";
  return (
    <button
      data-queue-row
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
        selected ? "border-blue-400 bg-blue-50" : "border-transparent hover:bg-slate-100"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <span className="text-[13px] font-medium truncate flex-1">
          {job.task_name || `${JOB_TYPE_LABELS[job.job_type] || job.job_type} #${job.id}`}
        </span>
        <span className="text-[11px] text-slate-400 flex-shrink-0">#{job.id}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 pl-4 text-[11px] text-slate-500">
        <span>{JOB_TYPE_LABELS[job.job_type] || job.job_type}</span>
        {job.status === "running" && job.percent != null && <span className="text-blue-600">{job.percent}%</span>}
        {job.total_products > 0 && (
          <span>{job.finished_products}/{job.planned_scripts || job.total_products}部</span>
        )}
        {job.failed_products > 0 && <span className="text-red-500">败{job.failed_products}</span>}
      </div>
      {job.status === "running" && job.status_message && (
        <div className="pl-4 mt-0.5 text-[11px] text-blue-600 truncate">{job.status_message}</div>
      )}
      {(job.status === "failed" || job.status === "partial_failed") && job.error && (
        <div className="pl-4 mt-0.5 text-[11px] text-red-500 truncate">{job.error}</div>
      )}
    </button>
  );
}

// ---------- 左栏: 队列分组 ----------
function QueueGroup({ title, color, jobs, selectedId, onSelect, defaultOpen = true }: {
  title: string; color: string; jobs: QueueJob[];
  selectedId: number | null; onSelect: (id: number) => void; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (jobs.length === 0) return null;
  return (
    <div>
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold text-slate-500 uppercase tracking-wide hover:text-slate-700">
        <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
        {title} ({jobs.length})
        <span className="ml-auto">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="space-y-0.5 mb-1">
          {jobs.map((j) => (
            <QueueRow key={j.id} job={j} selected={selectedId === j.id} onClick={() => onSelect(j.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 右栏: 监控中心 ----------
function MonitorRail({ ws }: { ws: WorkspaceState | null }) {
  if (!ws) return <div className="p-4 text-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" /></div>;
  const provs = Object.entries(ws.providers || {});
  const nodeStats = [...(ws.node_stats || [])].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  return (
    <div className="space-y-4 text-[13px]">
      {/* AI 资源 */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">AI 资源</h3>
        {provs.length === 0 ? (
          <p className="text-slate-400 text-xs px-1">重启后暂无调用记录</p>
        ) : (
          <div className="space-y-1">
            {provs.map(([name, h]) => (
              <div key={name} className="flex items-center gap-2 px-1" title={h.last_err_msg || ""}>
                <span className={`w-2 h-2 rounded-full ${h.status === "error" ? "bg-red-500" : "bg-emerald-500"}`} />
                <span className="font-medium">{name}</span>
                <span className="ml-auto text-slate-400 text-xs">✓{h.ok}{h.err > 0 && <span className="text-red-500 ml-1">✗{h.err}</span>}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 节点统计(近7日) */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">节点用量 · 7日</h3>
        {nodeStats.length === 0 ? <p className="text-slate-400 text-xs px-1">暂无数据</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-slate-400 text-left">
              <th className="font-normal pb-1">阶段</th>
              <th className="font-normal pb-1 text-right">调用</th>
              <th className="font-normal pb-1 text-right">tokens</th>
            </tr></thead>
            <tbody>
              {nodeStats.map((n) => (
                <tr key={n.stage} className="border-t border-slate-100">
                  <td className="py-1">{STAGE_LABELS[n.stage] || n.stage}</td>
                  <td className="py-1 text-right text-slate-500">{n.calls}</td>
                  <td className="py-1 text-right font-mono">{fmtTok(n.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 模型用量(近7日, 表格替代饼图) */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">模型用量 · 7日</h3>
        {(ws.provider_usage || []).length === 0 ? <p className="text-slate-400 text-xs px-1">暂无数据</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-slate-400 text-left">
              <th className="font-normal pb-1">模型</th>
              <th className="font-normal pb-1 text-right">调用</th>
              <th className="font-normal pb-1 text-right">tokens</th>
            </tr></thead>
            <tbody>
              {ws.provider_usage.map((p) => (
                <tr key={p.provider} className="border-t border-slate-100">
                  <td className="py-1">{p.provider}</td>
                  <td className="py-1 text-right text-slate-500">{p.calls}</td>
                  <td className="py-1 text-right font-mono">{fmtTok(p.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 实时日志 */}
      <section>
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">事件流</h3>
        <div className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
          {(ws.events || []).map((e, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] leading-4">
              <span className="text-slate-400 flex-shrink-0 font-mono">{fmtTime(e.ts)}</span>
              <span className={
                e.level === "error" ? "text-red-600"
                : e.level === "success" ? "text-emerald-600"
                : e.level === "debug" ? "text-slate-400"
                : "text-slate-600"
              }>{e.text}</span>
            </div>
          ))}
          {(ws.events || []).length === 0 && <p className="text-slate-400 text-xs">暂无事件</p>}
        </div>
      </section>
    </div>
  );
}

// ---------- 中间工作区: 选中任务详情(节点式) ----------
function JobWorkspace({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/jobs/${jobId}`, { headers: authHeaders() });
      if (r.ok) setDetail(await r.json());
    } catch {} finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { setLoading(true); setDetail(null); load(); }, [load]);
  useEffect(() => {
    if (!detail || (detail.status !== "running" && detail.status !== "pending")) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [detail, load]);

  const act = async (path: string, label: string) => {
    setActing(label);
    try {
      const r = await fetch(`${API}/jobs/${jobId}/${path}`, { method: "POST", headers: authHeaders() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `${label}失败`);
      setMsg(`✓ ${d.message || label + "已提交"}`);
      setTimeout(() => setMsg(""), 3000);
      load();
    } catch (e: any) { setMsg(`✗ ${e.message}`); setTimeout(() => setMsg(""), 4000); }
    finally { setActing(""); }
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  if (!detail) return <div className="py-16 text-center text-slate-400 text-sm">任务加载失败</div>;

  const products: any[] = detail.products || [];
  const scripts = products.filter((p) => p.product_type === "script");
  const outlines = products.filter((p) => p.product_type === "outline");
  const novels = products.filter((p) => p.product_type === "novel");
  const tweets = products.filter((p) => p.product_type === "tweet");
  const doneOf = (arr: any[]) => arr.filter((p) => p.status === "completed").length;

  // 推导节点链: create_spawn: 大纲→剧本→(小说/推文); import_spawn: 源剧本→小说/推文
  const cfg = detail.config_json || {};
  const importSources: number = (cfg.import_sources || []).length;
  const spawnCfg = cfg.spawn_config || {};
  const isImport = detail.job_type === "import_spawn";
  // import_spawn 计划产物总数 = 源剧本数 × 每部数量(逐部串行创建, 用计划数做分母)
  const plannedNovels = isImport && spawnCfg.novel?.enabled ? importSources * (spawnCfg.novel.count || 1) : novels.length;
  const plannedTweets = isImport && spawnCfg.tweet?.enabled ? importSources * (spawnCfg.tweet.count || 1) : tweets.length;

  const nodes: Array<{ key: string; label: string; total: number; done: number; failed: number; active: boolean }> = [];
  if (detail.job_type === "create_spawn") {
    nodes.push({ key: "outline", label: "创意+大纲", total: outlines.length, done: doneOf(outlines), failed: outlines.filter((p: any) => p.status === "failed").length, active: outlines.some((p: any) => !["completed", "failed", "rejected_fatal", "rejected_fatal_v2", "spare"].includes(p.status)) });
  }
  if (isImport) {
    // 源剧本是输入, 恒为已就绪
    nodes.push({ key: "source", label: "源剧本", total: importSources, done: importSources, failed: 0, active: false });
  } else {
    nodes.push({ key: "script", label: "剧本", total: detail.target_scripts || scripts.length, done: doneOf(scripts), failed: scripts.filter((p: any) => p.status === "failed").length, active: scripts.some((p: any) => p.status === "generating") });
  }
  if (novels.length > 0 || (isImport && spawnCfg.novel?.enabled)) {
    nodes.push({ key: "novel", label: "小说", total: plannedNovels, done: doneOf(novels), failed: novels.filter((p: any) => p.status === "failed").length, active: novels.some((p: any) => p.status === "generating") });
  }
  if (tweets.length > 0 || (isImport && spawnCfg.tweet?.enabled)) {
    nodes.push({ key: "tweet", label: "推文", total: plannedTweets, done: doneOf(tweets), failed: tweets.filter((p: any) => p.status === "failed").length, active: tweets.some((p: any) => p.status === "generating") });
  }

  const isActive = detail.status === "running" || detail.status === "pending";

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      {/* 头部: 名称 + 操作 */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <h2 className="text-base font-semibold">
          {detail.task_name || JOB_TYPE_LABELS[detail.job_type] || detail.job_type}
          <span className="text-slate-400 font-normal text-sm ml-2">#{detail.id}</span>
        </h2>
        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
          detail.status === "running" ? "bg-blue-100 text-blue-700"
          : detail.status === "completed" || detail.status === "succeeded" ? "bg-emerald-100 text-emerald-700"
          : detail.status === "pending" ? "bg-amber-100 text-amber-700"
          : "bg-red-100 text-red-700"
        }`}>{detail.status}</span>
        {detail.total_tokens > 0 && <span className="text-[11px] text-slate-400 font-mono">{fmtTok(detail.total_tokens)} tok</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {isActive && (
            <button onClick={() => act("stop", "停止")} disabled={!!acting}
              className="px-2.5 py-1 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">停止</button>
          )}
          {!isActive && (
            <>
              <button onClick={() => act("resume", "恢复")} disabled={!!acting}
                className="px-2.5 py-1 text-xs rounded border border-slate-200 hover:border-blue-400 disabled:opacity-50">恢复卡住</button>
              <button onClick={() => act("refill-all", "补缺")} disabled={!!acting}
                className="px-2.5 py-1 text-xs rounded border border-slate-200 hover:border-blue-400 disabled:opacity-50">补缺集</button>
            </>
          )}
          <button onClick={() => router.push(`/factory/jobs/${jobId}`)}
            className="px-2.5 py-1 text-xs rounded border border-slate-200 hover:border-blue-400">完整详情 →</button>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><XCircle className="w-4 h-4" /></button>
        </div>
      </div>
      {msg && <div className="mb-2 text-xs px-2 py-1 rounded bg-slate-50 border border-slate-200">{msg}</div>}
      {detail.error && (
        <div className="mb-3 text-xs px-2 py-1.5 rounded bg-red-50 border border-red-200 text-red-700">{detail.error}</div>
      )}

      {/* 状态消息 + 进度 */}
      {isActive && (detail.progress?.status_message || detail.progress?.percent != null) && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-blue-600 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />{detail.progress?.status_message || "执行中"}
            </span>
            {detail.progress?.percent != null && <span className="font-mono">{detail.progress.percent}%</span>}
          </div>
          {detail.progress?.percent != null && <Progress percent={detail.progress.percent} size="sm" />}
        </div>
      )}

      {/* 节点链 */}
      <div className="flex items-stretch gap-1 mb-4 overflow-x-auto">
        {nodes.map((n, i) => (
          <div key={n.key} className="flex items-center gap-1 flex-shrink-0">
            {i > 0 && <span className="text-slate-300">→</span>}
            <div className={`px-3 py-2 rounded-md border min-w-[104px] ${
              n.failed > 0 && n.done < n.total ? "border-red-300 bg-red-50"
              : n.active ? "border-blue-400 bg-blue-50"
              : n.total > 0 && n.done >= n.total ? "border-emerald-300 bg-emerald-50"
              : "border-slate-200 bg-slate-50"
            }`}>
              <div className="text-xs font-semibold flex items-center gap-1">
                {n.active && <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
                {n.label}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                {n.done}/{n.total || "?"}
                {n.failed > 0 && <span className="text-red-500 ml-1">✗{n.failed}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 产物简表: 剧本 + 裂变产物(小说/推文) */}
      {(() => {
        const rows = [...scripts, ...novels, ...tweets];
        if (rows.length === 0) return null;
        const typeLabel: Record<string, string> = { script: "剧本", novel: "小说", tweet: "推文" };
        return (
          <table className="w-full text-xs">
            <thead><tr className="text-slate-400 text-left border-b border-slate-100">
              <th className="font-normal py-1">产物</th>
              <th className="font-normal py-1">类型</th>
              <th className="font-normal py-1 text-right">章/集</th>
              <th className="font-normal py-1 text-right">字数</th>
              <th className="font-normal py-1 text-right">状态</th>
            </tr></thead>
            <tbody>
              {rows.map((p: any) => (
                <tr key={p.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer"
                  onClick={() => router.push(`/factory/products/${p.id}`)}>
                  <td className="py-1.5 max-w-[300px] truncate">{p.title || `产物${p.id}`}</td>
                  <td className="py-1.5 text-slate-500">{typeLabel[p.product_type] || p.product_type}</td>
                  <td className="py-1.5 text-right font-mono">
                    <span className={(p.completed_episodes ?? 0) < (p.episodes ?? 0) ? "text-orange-600" : ""}>
                      {p.completed_episodes ?? 0}/{p.episodes ?? "?"}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono">{p.words ? (p.words / 10000).toFixed(1) + "万" : "-"}</td>
                  <td className="py-1.5 text-right">
                    <span className={
                      p.status === "completed" ? "text-emerald-600"
                      : p.status === "failed" ? "text-red-500"
                      : "text-blue-600"
                    }>{p.status === "completed" ? "完成" : p.status === "failed" ? "失败"
                      : p.status === "generating" ? "生成中" : p.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })()}
    </div>
  );
}

// ---------- 主页面: 三栏控制台 ----------
type TabKey = "production" | "assets" | "cost";

export default function FactoryPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/login?from=/factory";
      return null;
    }
  }

  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [ws, setWs] = useState<WorkspaceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<TabKey>("production");
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [queueFilter, setQueueFilter] = useState("");
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedJob;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/workspace-state`, { headers: authHeaders() });
      if (r.ok) setWs(await r.json());
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 轮询: 有活动任务5秒, 否则15秒
  useEffect(() => {
    const hasActive = !!ws && (ws.queue.running.length > 0 || ws.queue.pending.length > 0
      || ws.pipeline_runs.some((r) => r.status === "running"));
    const t = setInterval(load, hasActive ? 5000 : 15000);
    return () => clearInterval(t);
  }, [ws, load]);

  // 队列扁平化(供 J/K 导航)
  const flatQueue: QueueJob[] = ws
    ? [...ws.queue.running, ...ws.queue.pending, ...ws.queue.failed, ...ws.queue.done]
      .filter((j) => !queueFilter
        || String(j.id).includes(queueFilter)
        || (j.task_name || "").toLowerCase().includes(queueFilter.toLowerCase())
        || (j.theme || "").toLowerCase().includes(queueFilter.toLowerCase()))
    : [];
  const flatQueueRef = useRef<QueueJob[]>([]);
  flatQueueRef.current = flatQueue;

  // ---------- 快捷键 ----------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "n": case "N":
          e.preventDefault(); router.push("/factory/create-spawn"); break;
        case "r": case "R":
          e.preventDefault(); load(); break;
        case "/":
          e.preventDefault();
          (document.getElementById("queue-search") as HTMLInputElement)?.focus(); break;
        case "j": case "J": case "k": case "K": {
          e.preventDefault();
          const list = flatQueueRef.current;
          if (list.length === 0) break;
          const cur = list.findIndex((x) => x.id === selectedRef.current);
          const down = e.key === "j" || e.key === "J";
          const next = cur === -1 ? 0 : Math.max(0, Math.min(list.length - 1, cur + (down ? 1 : -1)));
          setSelectedJob(list[next].id);
          break;
        }
        case "Enter":
          if (selectedRef.current) router.push(`/factory/jobs/${selectedRef.current}`);
          break;
        case "Escape":
          setSelectedJob(null); setShowHelp(false); break;
        case "1": setTab("production"); break;
        case "2": setTab("assets"); break;
        case "3": setTab("cost"); break;
        case "m": case "M": setMonitorOpen((v) => !v); break;
        case "?": setShowHelp((v) => !v); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatQueue.length, router, load]);

  const kpi = ws?.kpi;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* ===== 顶栏: 品牌 + Tab + KPI + 快速启动 ===== */}
      <header className="h-12 flex-shrink-0 border-b border-slate-200 bg-white flex items-center gap-3 px-3">
        <button onClick={() => router.push("/drafts")}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500" title="返回草稿">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1.5">
          <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <Factory className="w-4 h-4 text-white" />
          </span>
          <span className="font-bold text-sm hidden md:inline">裂变工厂</span>
        </div>

        {/* Tab */}
        <nav className="flex items-center gap-0.5 ml-2">
          {([["production", "生产"], ["assets", "资产"], ["cost", "成本"]] as [TabKey, string][]).map(([k, label], i) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-[13px] rounded-md font-medium transition-colors ${
                tab === k ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
              }`} title={`快捷键 ${i + 1}`}>{label}</button>
          ))}
        </nav>

        {/* 紧凑 KPI */}
        {kpi && (
          <div className="hidden lg:flex items-center gap-3 ml-4 text-[12px] font-mono text-slate-600">
            <span title="今日任务">任务 <b>{kpi.jobs}</b></span>
            <span className="text-emerald-600" title="今日成功">成 <b>{kpi.success}</b></span>
            {kpi.failed > 0 && <span className="text-red-500" title="今日失败">败 <b>{kpi.failed}</b></span>}
            <span title="今日Token">tok <b>{fmtTok(kpi.tokens)}</b></span>
            {kpi.running > 0 && (
              <span className="text-blue-600 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /><b>{kpi.running}</b> 运行中
              </span>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* 快速启动 */}
          <button onClick={() => router.push("/factory/create-spawn")} title="从零创作 (N)"
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium">
            <Sparkles className="w-3.5 h-3.5" />创作
          </button>
          <button onClick={() => router.push("/factory/import-spawn")} title="导入裂变"
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-slate-200 hover:border-green-400 font-medium">
            <FileUp className="w-3.5 h-3.5 text-green-600" />裂变
          </button>
          <button onClick={() => router.push("/factory/batch-video")} title="批量转视频"
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-md border border-slate-200 hover:border-purple-400 font-medium">
            <Video className="w-3.5 h-3.5 text-purple-600" />视频
          </button>
          <button onClick={load} disabled={loading} title="刷新 (R)"
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
          <button onClick={() => setShowHelp(!showHelp)} title="快捷键 (?)"
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
            <Keyboard className="w-4 h-4" />
          </button>
          <button onClick={() => setMonitorOpen(!monitorOpen)} title="监控栏 (M)"
            className={`p-1.5 rounded text-slate-500 ${monitorOpen ? "bg-slate-100" : "hover:bg-slate-100"}`}>
            <Zap className="w-4 h-4" />
          </button>
          <UserNav />
        </div>
      </header>

      {/* 快捷键帮助浮层 */}
      {showHelp && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setShowHelp(false)}>
          <div className="bg-white rounded-lg p-5 w-[380px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Keyboard className="w-4 h-4" />快捷键</h3>
            <div className="grid grid-cols-2 gap-y-1.5 text-[13px]">
              {[["N", "新建创作任务"], ["R", "刷新数据"], ["/", "搜索队列"], ["J / K", "队列下/上选择"],
                ["Enter", "打开任务详情页"], ["Esc", "取消选中/关浮层"], ["1 / 2 / 3", "切换 生产/资产/成本"],
                ["M", "开关监控栏"], ["?", "本帮助"]].map(([k, d]) => (
                <div key={k} className="contents">
                  <kbd className="justify-self-start px-1.5 py-0.5 bg-slate-100 rounded text-xs font-mono border border-slate-200">{k}</kbd>
                  <span className="text-slate-600">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== 主体三栏 ===== */}
      <div className="flex-1 flex overflow-hidden">
        {/* --- 左栏: 生产队列(仅生产tab显示) --- */}
        {tab === "production" && (
          <aside className="w-[290px] flex-shrink-0 border-r border-slate-200 bg-white flex flex-col">
            <div className="p-2 border-b border-slate-100">
              <input
                id="queue-search"
                value={queueFilter}
                onChange={(e) => setQueueFilter(e.target.value)}
                placeholder="搜索队列 (/)  ·  J/K 选择"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md focus:border-blue-400 focus:ring-1 focus:ring-blue-200 outline-none"
              />
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {!ws ? (
                <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
              ) : (
                <>
                  <QueueGroup title="运行中" color="bg-blue-500" selectedId={selectedJob} onSelect={setSelectedJob}
                    jobs={ws.queue.running.filter((j) => flatQueue.includes(j))} />
                  <QueueGroup title="等待" color="bg-amber-400" selectedId={selectedJob} onSelect={setSelectedJob}
                    jobs={ws.queue.pending.filter((j) => flatQueue.includes(j))} />
                  <QueueGroup title="异常" color="bg-red-500" selectedId={selectedJob} onSelect={setSelectedJob}
                    jobs={ws.queue.failed.filter((j) => flatQueue.includes(j))} />
                  <QueueGroup title="历史" color="bg-emerald-500" selectedId={selectedJob} onSelect={setSelectedJob}
                    jobs={ws.queue.done.filter((j) => flatQueue.includes(j))} />
                  {flatQueue.length === 0 && (
                    <p className="text-center text-xs text-slate-400 py-8">无匹配任务</p>
                  )}
                </>
              )}
            </div>
          </aside>
        )}

        {/* --- 中间: 动态工作区 --- */}
        <main className="flex-1 overflow-y-auto p-4">
          {tab === "production" && (
            <div className="max-w-[1100px] mx-auto space-y-4">
              {selectedJob ? (
                <JobWorkspace jobId={selectedJob} onClose={() => setSelectedJob(null)} />
              ) : (
                <div className="bg-white rounded-lg border border-dashed border-slate-300 py-10 text-center text-sm text-slate-400">
                  ← 从队列选择任务查看 Pipeline 详情 (J/K 键选择, Enter 打开完整页)
                </div>
              )}
              {/* 自动化流水线 */}
              <PipelinePanel />
            </div>
          )}
          {tab === "assets" && (
            <div className="max-w-[1300px] mx-auto">
              <LibraryPanel />
            </div>
          )}
          {tab === "cost" && (
            <div className="max-w-[1100px] mx-auto">
              <UsagePanel />
            </div>
          )}
        </main>

        {/* --- 右栏: 监控中心(可折叠) --- */}
        {monitorOpen && (
          <aside className="w-[270px] flex-shrink-0 border-l border-slate-200 bg-white overflow-y-auto p-3">
            <MonitorRail ws={ws} />
          </aside>
        )}
      </div>
    </div>
  );
}

