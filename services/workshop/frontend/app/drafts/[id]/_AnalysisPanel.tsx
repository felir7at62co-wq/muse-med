"use client";
import { authFetch } from "../../../lib/auth";
import { confirmAsync, notifyError } from "@/lib/dialog";
import { downloadWithAuth } from "@/lib/download";
import { useEffect, useState, useRef } from "react";
import { Sparkles, Download, RefreshCw, History, Trash2, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScoreRing } from "@/components/charts/ScoreRing";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

// ---------- 类型 ----------
type Hook = {
  chapter_order: number;
  type: string;
  intensity: number;
  scene_no: string;
  snippet: string;
  comment: string;
  improvement: string;
};
type Risk = {
  category: string;
  severity: "high" | "medium" | "low";
  location: string;
  description: string;
  suggestion: string;
};
type Suggestion = {
  priority: "P0" | "P1" | "P2";
  location: string;
  current_issue: string;
  suggestion: string;
  expected_score_lift: number;
};
type Audience = {
  tags?: string[];
  target_age?: string;
  target_gender?: string;
  target_region?: string;
  completion_rate_predict?: "high" | "medium" | "low";
};
type Analysis = {
  id: number;
  draft_id: number;
  status: "pending" | "running" | "done" | "failed";
  progress_step?: string;
  progress_current?: number;
  progress_total?: number;
  overall_grade?: string;
  overall_score?: number;
  summary?: string;
  scores_json?: { completeness?: number; character?: number; pacing?: number; market?: number };
  hooks_json?: Hook[];
  risks_json?: Risk[];
  audience_json?: Audience;
  suggestions_json?: Suggestion[];
  metrics_json?: any;
  report_md?: string;
  error?: string;
  created_at?: string;
  updated_at?: string;
};

// ---------- 颜色 / 文案 ----------
// 评分梯度: 全部用 token 端点 (warning / primary / info / cyan), 不引裸 yellow/fuchsia
const GRADE_COLOR: Record<string, string> = {
  S: "from-warning to-warning/60",
  A: "from-primary to-cyan",
  B: "from-info to-cyan",
  C: "from-warning/80 to-warning/40",
  D: "from-ink-muted to-ink-secondary",
};
const GRADE_DESC: Record<string, string> = {
  S: "精品爆款潜质",
  A: "优质作品",
  B: "及格线",
  C: "需重写",
  D: "建议大改",
};
const HOOK_TYPE: Record<string, { label: string; bgCls: string }> = {
  opening_hook: { label: "🎬 开场钩", bgCls: "bg-danger/10 border-danger/40 text-danger" },
  twist: { label: "🔄 中段反转", bgCls: "bg-primary/10 border-primary/40 text-primary" },
  cliffhanger: { label: "🎣 结尾悬念", bgCls: "bg-warning/10 border-warning/40 text-warning" },
  emotional_peak: { label: "💥 情绪炸裂", bgCls: "bg-primary/10 border-primary/40 text-primary" },
  iconic_line: { label: "💬 名场面台词", bgCls: "bg-cyan/10 border-cyan/40 text-cyan" },
};
const RISK_CATEGORY: Record<string, string> = {
  audience_loss: "观众流失",
  logic_gap: "逻辑漏洞",
  homogeneous: "同质化",
  character_imbalance: "角色失衡",
  completion_risk: "完播风险",
  safety: "合规风险",
};
const SEVERITY_BG: Record<string, string> = {
  high: "bg-danger/10 border-danger/40",
  medium: "bg-warning/10 border-warning/40",
  low: "bg-surface-base border-line",
};
const SEVERITY_LABEL: Record<string, string> = {
  high: "🔴 严重",
  medium: "🟡 中等",
  low: "🟢 轻微",
};
const PRIORITY_BG: Record<string, string> = {
  P0: "bg-danger/10 border-danger/40",
  P1: "bg-warning/10 border-warning/40",
  P2: "bg-surface-base border-line",
};
const PRIORITY_LABEL: Record<string, string> = {
  P0: "🔴 P0 必改",
  P1: "🟡 P1 推荐",
  P2: "🟢 P2 可选",
};
const STEP_LABEL: Record<string, string> = {
  queued: "排队中",
  metrics: "1/4 程序化指标",
  overall: "2/4 整体评估",
  hooks: "3/5 爆点扫描",
  risks: "4/5 风险与建议",
  report: "5/5 总编诊断报告",
  done: "完成",
};

// ---------- 雷达图(SVG) — 复用 token 配色 ----------
function RadarChart({ scores }: { scores: { completeness?: number; character?: number; pacing?: number; market?: number } }) {
  const items = [
    { label: "剧情完整度", v: scores.completeness ?? 0 },
    { label: "角色塑造", v: scores.character ?? 0 },
    { label: "节奏密度", v: scores.pacing ?? 0 },
    { label: "市场潜力", v: scores.market ?? 0 },
  ];
  const cx = 100, cy = 100, R = 70;
  const angles = [-90, 0, 90, 180];
  const points = items.map((it, i) => {
    const r = (it.v / 100) * R;
    const rad = (angles[i] * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  });
  const grid = [0.25, 0.5, 0.75, 1].map(p => p * R);

  return (
    <svg viewBox="0 0 200 200" className="w-full max-w-[260px]">
      {grid.map((r, idx) => (
        <polygon
          key={idx}
          points={angles.map(a => {
            const rad = (a * Math.PI) / 180;
            return `${cx + r * Math.cos(rad)},${cy + r * Math.sin(rad)}`;
          }).join(" ")}
          fill="none"
          stroke="rgba(148,163,184,0.25)"
          strokeWidth="1"
        />
      ))}
      {angles.map((a, i) => {
        const rad = (a * Math.PI) / 180;
        return (
          <line
            key={i}
            x1={cx} y1={cy}
            x2={cx + R * Math.cos(rad)}
            y2={cy + R * Math.sin(rad)}
            stroke="rgba(148,163,184,0.25)"
            strokeWidth="1"
          />
        );
      })}
      <polygon
        points={points.map(p => p.join(",")).join(" ")}
        fill="rgba(124,58,237,0.35)"
        stroke="rgb(124,58,237)"
        strokeWidth="2"
      />
      {points.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3" fill="rgb(124,58,237)" />
      ))}
      {items.map((it, i) => {
        const rad = (angles[i] * Math.PI) / 180;
        const lx = cx + (R + 18) * Math.cos(rad);
        const ly = cy + (R + 18) * Math.sin(rad);
        return (
          <text
            key={i}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="9"
            fill="rgb(203,213,225)"
          >
            {it.label} {it.v}
          </text>
        );
      })}
    </svg>
  );
}

// ---------- 节奏曲线(SVG) ----------
function PacingChart({ hooks, totalChapters }: { hooks: Hook[]; totalChapters: number }) {
  if (totalChapters <= 0) return null;
  const byChapter: Record<number, number> = {};
  hooks.forEach(h => {
    byChapter[h.chapter_order] = (byChapter[h.chapter_order] || 0) + h.intensity;
  });
  const W = 440;
  const H = 100;
  const padX = 28;
  const padY = 12;
  const data: number[] = [];
  for (let i = 1; i <= totalChapters; i++) data.push(byChapter[i] || 0);
  const maxV = Math.max(...data, 5);
  const stepX = (W - padX * 2) / Math.max(1, data.length - 1);

  const points = data.map((v, i) => {
    const x = padX + i * stepX;
    const y = padY + (1 - v / maxV) * (H - padY * 2);
    return [x, y];
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  const fillPath = `${path} L ${points[points.length - 1][0]} ${H - padY} L ${padX} ${H - padY} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="rgba(148,163,184,0.3)" />
      <path d={fillPath} fill="rgba(124,58,237,0.2)" />
      <path d={path} fill="none" stroke="rgb(124,58,237)" strokeWidth="2" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p[0]} cy={p[1]} r="3" fill="rgb(124,58,237)" />
          <text x={p[0]} y={H - 2} textAnchor="middle" fontSize="8" fill="rgb(148,163,184)">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * 剧本分析面板 — Phase 3 重做版,接入 UI Kit (Card / Button / Badge / Spinner / EmptyState)。
 *
 * 后端: GET /v1/stages/drafts/{id}/analysis 拉最新一次
 *       POST /v1/stages/drafts/{id}/analysis/start 启动新一轮
 *       GET /v1/stages/drafts/{id}/analysis/history 历史最多 5 次
 *       GET /v1/stages/drafts/{id}/analysis/{aid} 取特定一次
 *       DELETE 单条
 *
 * 5 个区块: 综合评级 / 爆点分析 / 风险提示 / 受众画像 / 改进建议
 */
export function AnalysisPanel({ draftId, draftTitle }: { draftId: number; draftTitle: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [history, setHistory] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openSection, setOpenSection] = useState<string>("report");
  const pollRef = useRef<any>(null);

  // 初次加载
  useEffect(() => {
    fetchLatest();
    fetchHistory();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // 状态变化时启动/停止轮询
  useEffect(() => {
    if (analysis && (analysis.status === "pending" || analysis.status === "running")) {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => fetchLatest(true), 3000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (analysis?.status === "done" || analysis?.status === "failed") {
        fetchHistory();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.status, analysis?.id]);

  async function fetchLatest(silent: boolean = false) {
    if (!silent) setLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/analysis`);
      if (r.ok) {
        const data = await r.json();
        setAnalysis(data.analysis || null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchHistory() {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/analysis/history`);
      if (r.ok) {
        const data = await r.json();
        setHistory(data.items || []);
      }
    } catch {}
  }

  async function loadSpecific(aid: number) {
    setLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/analysis/${aid}`);
      if (r.ok) {
        const data = await r.json();
        setAnalysis(data.analysis);
      }
    } catch (e) {} finally { setLoading(false); }
  }

  async function startAnalysis() {
    if (!(await confirmAsync({ title: "启动新的剧本分析", description: "将根据所有章节内容评估，需 1-2 分钟", confirmText: "开始分析" }))) return;
    setStarting(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/analysis/start`, { method: "POST" });
      if (!r.ok) {
        const t = await r.text();
        notifyError(`启动失败 (${r.status}): ${t.slice(0, 200)}`);
        return;
      }
      await fetchLatest();
      await fetchHistory();
    } catch (e) {
      notifyError("启动失败: " + (e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function deleteOne(aid: number) {
    if (!(await confirmAsync({ title: "删除分析记录", tone: "danger", confirmText: "删除" }))) return;
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/analysis/${aid}`, { method: "DELETE" });
      if (!r.ok) {
        notifyError("删除失败");
        return;
      }
      await fetchHistory();
      if (analysis?.id === aid) await fetchLatest();
    } catch {}
  }

  async function exportDocx(aid: number) {
    // ⚠ 原先是 window.open 直链。该端点**早就带鉴权**(get_current_user), 而 token 在
    // localStorage 不在 cookie, window.open 带不上 —— 也就是这个导出按钮一直是
    // 401, 只会新开一个标签页显示 {"detail":"..."}。改走 authFetch + blob。
    try {
      await downloadWithAuth(
        `${BASE}/v1/stages/drafts/${draftId}/analysis/${aid}/export-docx`,
        `剧本分析报告_${aid}.docx`,
      );
    } catch (e) {
      notifyError((e as Error).message || "导出失败");
    }
  }

  if (loading && !analysis) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" className="text-primary" />
        <span className="ml-2 text-ink-secondary">加载分析数据…</span>
      </div>
    );
  }

  // 还没分析过
  if (!analysis) {
    return (
      <Card padding="lg" className="text-center py-16">
        <div className="max-w-md mx-auto">
          <Sparkles className="w-20 h-20 mx-auto mb-6 text-primary opacity-60" />
          <h3 className="text-2xl font-bold mb-3 text-ink-primary">📊 剧本分析</h3>
          <p className="text-ink-secondary mb-6 text-sm leading-relaxed">
            AI 将基于所有章节内容,从综合评级、爆点分析、风险提示、受众画像、改进建议 5 个维度全面评估剧本。
          </p>
          <Button
            variant="primary"
            size="lg"
            loading={starting}
            leftIcon={!starting ? <Sparkles className="w-5 h-5" /> : undefined}
            onClick={startAnalysis}
          >
            {starting ? "启动中…" : "🚀 开始分析"}
          </Button>
          <p className="mt-4 text-xs text-ink-muted">预计 1-2 分钟,可随时刷新页面查看进度</p>
        </div>
      </Card>
    );
  }

  // 跑步中
  if (analysis.status === "pending" || analysis.status === "running") {
    const cur = analysis.progress_current || 0;
    const tot = Math.max(1, analysis.progress_total || 1);
    const pct = Math.min(100, Math.round((cur / tot) * 100));
    return (
      <Card padding="lg" className="max-w-2xl mx-auto my-8">
        <div className="flex items-center gap-3 mb-4">
          <Spinner size="md" className="text-primary" />
          <h3 className="text-xl font-bold text-ink-primary">AI 分析进行中…</h3>
          <span className="ml-auto text-sm text-primary">
            {STEP_LABEL[analysis.progress_step || ""] || analysis.progress_step}
          </span>
        </div>
        <div className="w-full bg-surface-base rounded-full h-3 mb-2">
          <div
            className="bg-gradient-to-r from-primary to-cyan h-3 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-ink-muted">{cur} / {tot} ({pct}%)</p>
        <div className="mt-6 grid grid-cols-4 gap-2 text-xs">
          {["metrics", "overall", "hooks", "risks"].map(s => {
            const stepIdx = ["metrics", "overall", "hooks", "risks"].indexOf(analysis.progress_step || "");
            const myIdx = ["metrics", "overall", "hooks", "risks"].indexOf(s);
            const done = stepIdx > myIdx || analysis.progress_step === "done";
            const active = analysis.progress_step === s;
            return (
              <div
                key={s}
                className={`p-2 rounded text-center border ${
                  active
                    ? "bg-primary border-primary text-white"
                    : done
                    ? "bg-success/10 border-success/40 text-success"
                    : "bg-surface-base border-line text-ink-muted"
                }`}
              >
                {STEP_LABEL[s]}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-ink-muted text-center">
          后台运行中,刷新页面或关闭都不会中断,完成后自动展示结果
        </p>
      </Card>
    );
  }

  // 失败
  if (analysis.status === "failed") {
    return (
      <Card padding="lg" className="max-w-2xl mx-auto bg-danger/10 border-danger/40">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="w-6 h-6 text-danger" />
          <h3 className="text-lg font-bold text-danger">分析失败</h3>
        </div>
        <p className="text-sm text-ink-secondary mb-4 font-mono whitespace-pre-wrap">
          {analysis.error || "未知错误"}
        </p>
        <Button variant="primary" size="md" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={startAnalysis}>
          重试
        </Button>
      </Card>
    );
  }

  // ---------- 完成: 展示结果 ----------
  const hooks = analysis.hooks_json || [];
  const risks = analysis.risks_json || [];
  const suggestions = analysis.suggestions_json || [];
  const audience = analysis.audience_json || {};
  const scores = analysis.scores_json || {};
  const metrics = analysis.metrics_json || {};
  const grade = analysis.overall_grade || "C";
  const score = analysis.overall_score || 0;
  const totalChapters = metrics.total_chapters || 0;

  return (
    <div className="space-y-4">
      {/* 顶部操作栏 */}
      <Card padding="md" className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-ink-secondary">
          上次分析: {analysis.created_at ? new Date(analysis.created_at).toLocaleString("zh-CN") : "-"}
          {history.length > 0 && <span className="ml-2 text-xs text-ink-muted">(共 {history.length} 次)</span>}
        </span>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Button
            variant="primary"
            size="sm"
            loading={starting}
            leftIcon={!starting ? <RefreshCw className="w-3 h-3" /> : undefined}
            onClick={startAnalysis}
          >
            重新分析
          </Button>
          <Button
            variant="cyan"
            size="sm"
            leftIcon={<Download className="w-3 h-3" />}
            onClick={() => exportDocx(analysis.id)}
          >
            导出 Word
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<History className="w-3 h-3" />}
            onClick={() => setShowHistory(!showHistory)}
          >
            历史 ({history.length})
          </Button>
        </div>
      </Card>

      {/* 历史下拉 */}
      {showHistory && (
        <Card padding="md">
          <h4 className="text-sm font-semibold mb-2 text-ink-primary">历史分析(最多保留 5 次)</h4>
          {history.length === 0 ? (
            <p className="text-xs text-ink-muted">无历史</p>
          ) : (
            <div className="space-y-1">
              {history.map(h => (
                <div
                  key={h.id}
                  className={`flex items-center gap-2 p-2 rounded text-xs ${
                    analysis.id === h.id
                      ? "bg-primary/10 border border-primary/40"
                      : "bg-surface-base/40 hover:bg-surface-overlay/30 border border-line"
                  }`}
                >
                  <span className="font-mono text-ink-muted">#{h.id}</span>
                  <span className="text-ink-secondary">
                    {new Date(h.created_at || "").toLocaleString("zh-CN")}
                  </span>
                  {h.status === "done" ? (
                    <>
                      <span
                        className={`px-1.5 py-0.5 rounded font-bold bg-gradient-to-r ${GRADE_COLOR[h.overall_grade || "C"]} text-white`}
                      >
                        {h.overall_grade}
                      </span>
                      <span className="text-ink-secondary">{h.overall_score}/100</span>
                    </>
                  ) : (
                    <Badge tone="muted" size="sm">
                      {h.status}
                    </Badge>
                  )}
                  {analysis.id !== h.id && h.status === "done" && (
                    <Button variant="ghost" size="sm" onClick={() => loadSpecific(h.id)} className="ml-auto">
                      查看
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteOne(h.id)}
                    title="删除"
                    leftIcon={<Trash2 className="w-3 h-3 text-danger" />}
                    className="hover:bg-danger/10"
                  >
                    <span className="sr-only">删除</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* 综合评级 */}
      <Section title="🏆 综合评级" id="overview" open={openSection} onToggle={setOpenSection} defaultOpen>
        <div className="grid md:grid-cols-2 gap-6 p-4">
          <div className="flex flex-col items-center">
            <ScoreRing score={score} grade={grade} size={180} thickness={14} label="综合得分" />
            <div className="mt-4 text-center">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/30">
                <span
                  className={`text-sm font-bold bg-gradient-to-r ${GRADE_COLOR[grade]} bg-clip-text text-transparent`}
                >
                  {grade} 级
                </span>
                <span className="text-xs text-ink-secondary">·</span>
                <span className="text-xs text-ink-secondary">{GRADE_DESC[grade]}</span>
              </div>
            </div>
            {analysis.summary && (
              <p className="mt-3 text-sm text-center text-ink-secondary italic max-w-sm">
                "{analysis.summary}"
              </p>
            )}
          </div>
          <div className="flex items-center justify-center">
            <RadarChart scores={scores} />
          </div>
        </div>
      </Section>

      {/* 爆点分析 */}
      <Section
        title={`💥 爆点分析 (${hooks.length} 个钩子)`}
        id="hooks"
        open={openSection}
        onToggle={setOpenSection}
      >
        <div className="p-4">
          {hooks.length === 0 ? (
            <p className="text-sm text-ink-muted">未识别到明显爆点钩子,建议加强冲突和情绪高潮</p>
          ) : (
            <>
              <div className="mb-4">
                <p className="text-xs text-ink-muted mb-2">
                  共 {hooks.length} 个钩子,平均每集 {(hooks.length / Math.max(1, totalChapters)).toFixed(1)} 个 (短剧基准 1.5-2.0)
                </p>
                <div className="bg-surface-base/40 rounded p-3 border border-line">
                  <p className="text-xs text-ink-muted mb-1">节奏曲线(每集钩子总强度)</p>
                  <PacingChart hooks={hooks} totalChapters={totalChapters} />
                </div>
              </div>
              {Array.from(new Set(hooks.map(h => h.chapter_order))).sort((a, b) => a - b).map(order => (
                <div key={order} className="mb-4">
                  <h4 className="text-sm font-bold text-primary mb-2">
                    第 {order} 集 ({hooks.filter(h => h.chapter_order === order).length} 个钩子)
                  </h4>
                  <div className="space-y-2">
                    {hooks.filter(h => h.chapter_order === order).map((h, i) => {
                      const sty = HOOK_TYPE[h.type] || HOOK_TYPE.twist;
                      return (
                        <div key={i} className={`p-2 rounded border ${sty.bgCls}`}>
                          <div className="flex items-center gap-2 mb-1 text-xs flex-wrap">
                            <span className="font-bold">{sty.label}</span>
                            <span>强度 {"⚡".repeat(h.intensity)}</span>
                            <span className="text-ink-muted">场次 {h.scene_no}</span>
                          </div>
                          {h.snippet && <div className="text-xs text-ink-secondary mb-1">"{h.snippet}"</div>}
                          {h.comment && <div className="text-xs text-ink-muted">💡 {h.comment}</div>}
                          {h.improvement && <div className="text-xs text-warning mt-1">📝 优化: {h.improvement}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </Section>

      {/* 总编诊断报告(整剧通读长文) — 核心 */}
      <Section
        title="🩺 总编诊断报告"
        id="report"
        open={openSection}
        onToggle={setOpenSection}
        defaultOpen
      >
        <div className="p-4">
          {analysis.report_md ? (
            <article className="prose prose-invert prose-sm max-w-none
              prose-headings:text-ink-primary prose-h2:text-base prose-h2:mt-5 prose-h2:mb-2
              prose-h2:border-l-2 prose-h2:border-primary prose-h2:pl-2
              prose-p:text-ink-secondary prose-li:text-ink-secondary
              prose-strong:text-ink-primary prose-strong:font-semibold">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{analysis.report_md}</ReactMarkdown>
            </article>
          ) : (
            <p className="text-sm text-ink-muted">
              本次分析未生成诊断报告(可能是旧版分析或生成失败)。点上方「重新分析」可生成整剧深度诊断:连续性硬伤 / 时间线 / 世界观 / 人物 / 结构节奏 / 版权风险 / 必修清单 / 最终评价。
            </p>
          )}
        </div>
      </Section>

      {/* 改进建议(结构化清单, 作为诊断报告的补充) */}
      <Section
        title={`✨ 改进建议清单 (${suggestions.length} 条)`}
        id="suggestions"
        open={openSection}
        onToggle={setOpenSection}
      >
        <div className="p-4 space-y-2">
          {suggestions.length === 0 ? (
            <p className="text-sm text-ink-muted">暂无改进建议</p>
          ) : (
            (["P0", "P1", "P2"] as const).map(pri => {
              const items = suggestions.filter(s => s.priority === pri);
              if (items.length === 0) return null;
              return (
                <div key={pri}>
                  <h4 className="text-xs font-semibold text-ink-secondary mb-1">
                    {PRIORITY_LABEL[pri]} ({items.length})
                  </h4>
                  <div className="space-y-1">
                    {items.map((s, i) => (
                      <div key={i} className={`p-2 rounded border ${PRIORITY_BG[pri]} text-xs`}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-semibold text-ink-primary">{s.location}</span>
                          {s.expected_score_lift > 0 && (
                            <Badge tone="success" size="sm" className="ml-auto">
                              +{s.expected_score_lift} 分
                            </Badge>
                          )}
                        </div>
                        <div className="text-ink-muted mb-1">问题: {s.current_issue}</div>
                        <div className="text-primary">建议: {s.suggestion}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Section>
    </div>
  );
}

// ---------- 小工具 ----------
function Section({
  id,
  title,
  children,
  open,
  onToggle,
  defaultOpen = false,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  open: string;
  onToggle: (id: string) => void;
  defaultOpen?: boolean;
}) {
  const isOpen = open === id || (defaultOpen && open === "");
  return (
    <Card padding="none" className="overflow-hidden">
      <button
        onClick={() => onToggle(isOpen ? "" : id)}
        className="w-full text-left px-4 py-3 flex items-center hover:bg-surface-overlay/30 transition"
      >
        <span className="font-bold text-base text-ink-primary">{title}</span>
        {isOpen ? (
          <ChevronUp className="ml-auto w-4 h-4 text-ink-muted" />
        ) : (
          <ChevronDown className="ml-auto w-4 h-4 text-ink-muted" />
        )}
      </button>
      {isOpen && <div className="border-t border-line">{children}</div>}
    </Card>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-ink-muted w-20 shrink-0">{k}:</span>
      <span className="text-ink-primary">{v}</span>
    </div>
  );
}
