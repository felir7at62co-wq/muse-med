"use client";
import { authFetch } from "../../../lib/auth";
import { useEffect, useState } from "react";
import {
  ShieldAlert, ShieldCheck, RefreshCw, ChevronDown, ChevronUp,
  Save, History, CheckCircle2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { notify, notifyError, notifySuccess } from "@/lib/dialog";
import { phase5Safety, type SafetyReport, type SafetyRisk } from "@/lib/phase5";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Hit = {
  category: string;
  keyword: string;
  snippet: string;
  severity: "high" | "medium" | "low";
  position: number;
};

type ScanItem = {
  scope: "chapter" | "storyboard";
  chapter_order: number;
  title?: string;
  hits: Hit[];
  summary: string;
};


const SEVERITY_TONE: Record<string, { tone: "danger" | "warning" | "muted"; label: string }> = {
  high: { tone: "danger", label: "🔴 严重" },
  medium: { tone: "warning", label: "🟡 疑似" },
  low: { tone: "muted", label: "🟢 边缘" },
};

const SEVERITY_BG: Record<string, string> = {
  high: "bg-danger/10 border-danger/40",
  medium: "bg-warning/10 border-warning/40",
  low: "bg-surface-base border-line",
};

/**
 * 安全审核面板 — Phase 5 §12.6.2 重做版。
 *
 * 新增持久化能力:
 *   - 「保存为报告」: 把当前扫描结果 POST 到 /v1/drafts/{id}/safety-reports 入库
 *   - 「历史报告」: 列出 GET /v1/drafts/{id}/safety-reports，可点开任一份回看
 *   - 「标记已解决」: 在历史报告中点击 risk → 调用 phase5Safety.resolveRisk
 *
 * ⛔ 2026-09-21 用户裁定：**AI 深度审核已整体下线**（端点返回 410）。
 * 它原本在进入本 Tab 时**自动**对全剧逐集跑一遍（并发 5）——一部 109 集的剧
 * 光打开这个页就是 109 次模型调用，而判据是一份 2025-11 的过时文档。
 * 现在这里只剩**本地关键词扫描**：不花钱、不阻断、用户点了才跑，仅供参考。
 */
export function SafetyPanel({ draftId }: { draftId: number }) {
  // 改为默认展开: 进入「安全合规」Tab 即显示, 不再需要手动点开
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<ScanItem[]>([]);
  const [totalIssues, setTotalIssues] = useState<number | null>(null);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  // 历史报告
  const [reportsExpanded, setReportsExpanded] = useState(false);
  const [reports, setReports] = useState<SafetyReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [activeReport, setActiveReport] = useState<SafetyReport | null>(null);

  async function scan() {
    setLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/safety/scan`);
      if (!r.ok) {
        notifyError(`扫描失败: ${r.status}`);
        return;
      }
      const data = await r.json();
      setResults(data.results || []);
      setTotalIssues(data.total_issues || 0);
    } catch (e) {
      notifyError("扫描请求失败: " + (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  /** 把当前扫描结果持久化为一份报告 */
  async function saveReport() {
    if (results.length === 0) {
      notifyError("请先执行扫描");
      return;
    }
    setSaving(true);
    try {
      // 汇总
      let high = 0, medium = 0, low = 0;
      const risks: any[] = [];
      for (const item of results) {
        for (const h of item.hits) {
          if (h.severity === "high") high++;
          else if (h.severity === "medium") medium++;
          else low++;
          risks.push({
            category: h.category,
            severity: h.severity,
            keyword: h.keyword,
            snippet: h.snippet,
            chapter_order: item.chapter_order,
            position: h.position,
            reason: "",
            suggestion: "",
          });
        }
      }
      const total = high + medium + low;
      const overall = high > 0 ? "fail" : (medium > 0 ? "warning" : "pass");
      const summary = total === 0 ? "扫描未发现风险点" : `共发现 ${total} 个风险点 (高=${high}/中=${medium}/低=${low})`;

      const res = await phase5Safety.create(draftId, {
        scope: "full",
        overall,
        summary,
        high_count: high,
        medium_count: medium,
        low_count: low,
        scores: {},
        risks,
      });
      notifySuccess(`已保存报告 #${res.id} (共 ${res.total} 项)`);
      // 刷新历史
      await loadReports();
    } catch (e) {
      notifyError("保存失败: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function loadReports() {
    setReportsLoading(true);
    try {
      const data = await phase5Safety.list(draftId);
      setReports(data.items || []);
    } catch (e) {
      notifyError("拉取历史报告失败: " + (e as Error).message);
    } finally {
      setReportsLoading(false);
    }
  }

  async function openReport(reportId: number) {
    try {
      const data = await phase5Safety.get(draftId, reportId);
      setActiveReport(data);
    } catch (e) {
      notifyError("打开报告失败: " + (e as Error).message);
    }
  }

  async function resolveRisk(riskId: number) {
    if (!activeReport) return;
    try {
      const res = await phase5Safety.resolveRisk(draftId, riskId);
      // 局部更新
      setActiveReport(prev => {
        if (!prev) return prev;
        const next: SafetyReport = {
          ...prev,
          unresolved_count: res.unresolved,
          risks: (prev.risks || []).map(r => r.id === riskId ? { ...r, is_resolved: true } : r),
        };
        return next;
      });
      // 列表层面也同步 unresolved
      setReports(prev => prev.map(r => r.id === activeReport.id ? { ...r, unresolved_count: res.unresolved } : r));
      notify("已标记为已解决");
    } catch (e) {
      notifyError("操作失败: " + (e as Error).message);
    }
  }

  // 第一次展开时自动扫描 + 拉取历史
  useEffect(() => {
    if (open && results.length === 0 && totalIssues === null) {
      scan();
    }
    if (open && reports.length === 0) {
      loadReports();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 折叠状态:简单按钮触发器
  if (!open) {
    return (
      <div className="mb-4">
        <Button
          variant="secondary"
          size="md"
          leftIcon={<ShieldAlert className="w-4 h-4 text-warning" />}
          rightIcon={<ChevronDown className="w-3 h-3 text-ink-muted" />}
          onClick={() => setOpen(true)}
        >
          内容安全审核
        </Button>
      </div>
    );
  }

  return (
    <Card padding="md" className="mb-4 border-warning/40">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <ShieldAlert className="w-5 h-5 text-warning" />
        <h3 className="text-base font-bold text-warning">内容安全审核</h3>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            leftIcon={!loading ? <RefreshCw className="w-3.5 h-3.5" /> : undefined}
            onClick={scan}
            title="重新扫描所有章节和剧本"
          >
            重新扫描
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            leftIcon={!saving ? <Save className="w-3.5 h-3.5" /> : undefined}
            onClick={saveReport}
            disabled={results.length === 0}
            title="把本次关键词扫描结果保存为永久报告"
          >
            保存为报告
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ChevronUp className="w-3.5 h-3.5" />}
            onClick={() => setOpen(false)}
          >
            收起
          </Button>
        </div>
      </div>

      {loading && results.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-ink-secondary">
          <Spinner size="sm" className="text-warning" />
          正在扫描所有章节和剧本…
        </div>
      )}

      {!loading && totalIssues === 0 && (
        <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/40 rounded-lg text-sm text-success">
          <ShieldCheck className="w-5 h-5" />
          关键词扫描未发现明显违规风险
        </div>
      )}

      {totalIssues !== null && totalIssues > 0 && (
        <p className="mb-3 text-sm text-warning">
          共在 {results.length} 处内容中发现 <strong>{totalIssues}</strong> 个疑似风险点(关键词扫描)。点击下方任意条目查看具体关键词。
        </p>
      )}

      <div className="space-y-2">
        {results.map(item => {
          const key = `${item.scope}-${item.chapter_order}`;
          const isExpanded = expandedItem === key;

          // 严重度统计
          const high = item.hits.filter(h => h.severity === "high").length;
          const medium = item.hits.filter(h => h.severity === "medium").length;
          const low = item.hits.filter(h => h.severity === "low").length;

          // 取每个 category 的命中数
          const byCategory: Record<string, number> = {};
          item.hits.forEach(h => {
            byCategory[h.category] = (byCategory[h.category] || 0) + 1;
          });

          return (
            <div key={key} className="rounded-lg border border-line bg-surface-base/40">
              <button
                onClick={() => setExpandedItem(isExpanded ? null : key)}
                className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-surface-overlay/30 transition rounded-lg"
              >
                <span className="text-sm font-semibold text-ink-primary">
                  第 {item.chapter_order} 章
                  <span className="ml-2 text-xs text-ink-muted">
                    ({item.scope === "chapter" ? "章节正文" : "剧本"})
                  </span>
                </span>
                <div className="flex items-center gap-1.5 ml-auto">
                  {high > 0 && <Badge tone="danger" size="sm">🔴 {high}</Badge>}
                  {medium > 0 && <Badge tone="warning" size="sm">🟡 {medium}</Badge>}
                  {low > 0 && <Badge tone="muted" size="sm">🟢 {low}</Badge>}
                </div>
                {isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-ink-muted" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-ink-muted" />
                )}
              </button>

              {isExpanded && (
                <div className="border-t border-line p-3 space-y-3">
                  {/* 类别分布 */}
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(byCategory).map(([cat, n]) => (
                      <Badge key={cat} tone="info" size="sm" variant="outline">
                        {cat}: <strong className="text-warning ml-1">{n}</strong>
                      </Badge>
                    ))}
                  </div>

                  {/* 命中详情列表(显示具体关键词) */}
                  <div className="space-y-2">
                    {item.hits.slice(0, 30).map((h, i) => {
                      const sty = SEVERITY_TONE[h.severity] || SEVERITY_TONE.medium;
                      const bgCls = SEVERITY_BG[h.severity] || SEVERITY_BG.medium;
                      return (
                        <div key={i} className={`p-2 rounded border ${bgCls} text-xs`}>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge tone={sty.tone} size="sm">{sty.label}</Badge>
                            <span className="text-ink-secondary">[{h.category}]</span>
                            <span className="ml-auto px-1.5 py-0.5 bg-surface-base border border-line rounded font-mono text-warning">
                              "{h.keyword}"
                            </span>
                          </div>
                          <div className="text-ink-secondary leading-relaxed">
                            {h.snippet.split(h.keyword).map((part, pi, arr) => (
                              <span key={pi}>
                                {part}
                                {pi < arr.length - 1 && (
                                  <span className="px-1 bg-warning/30 text-warning font-bold rounded">
                                    {h.keyword}
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {item.hits.length > 30 && (
                      <p className="text-xs text-ink-muted">还有 {item.hits.length - 30} 个命中未展示…</p>
                    )}
                  </div>

                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 历史报告区 */}
      <div className="mt-4 pt-3 border-t border-line">
        <button
          onClick={() => setReportsExpanded(!reportsExpanded)}
          className="w-full flex items-center gap-2 text-sm font-semibold text-ink-primary hover:text-primary transition"
        >
          <History className="w-4 h-4" />
          历史报告
          {reports.length > 0 && (
            <Badge tone="muted" size="sm">{reports.length}</Badge>
          )}
          {reportsExpanded ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
        </button>

        {reportsExpanded && (
          <div className="mt-2 space-y-2">
            {reportsLoading && (
              <div className="flex items-center gap-2 text-xs text-ink-secondary">
                <Spinner size="sm" /> 正在拉取…
              </div>
            )}
            {!reportsLoading && reports.length === 0 && (
              <p className="text-xs text-ink-muted">暂无历史报告。点击「保存为报告」可入库本次扫描结果。</p>
            )}
            {reports.map(r => (
              <div key={r.id} className="rounded-lg border border-line bg-surface-base/40">
                <button
                  onClick={() => activeReport?.id === r.id ? setActiveReport(null) : openReport(r.id)}
                  className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-surface-overlay/30 transition rounded-lg flex-wrap"
                >
                  <span className="text-xs text-ink-muted">#{r.id}</span>
                  <span className="text-xs text-ink-secondary">
                    {r.created_at ? new Date(r.created_at).toLocaleString() : ""}
                  </span>
                  {r.overall === "pass" && <Badge tone="success" size="sm">通过</Badge>}
                  {r.overall === "warning" && <Badge tone="warning" size="sm">疑似</Badge>}
                  {r.overall === "fail" && <Badge tone="danger" size="sm">违规</Badge>}
                  <span className="text-xs text-ink-secondary truncate max-w-[180px]">{r.summary}</span>
                  <span className="ml-auto text-xs">
                    未解决 <strong className={r.unresolved_count > 0 ? "text-warning" : "text-success"}>{r.unresolved_count}</strong> / {r.total_issues}
                  </span>
                  {activeReport?.id === r.id ? <ChevronUp className="w-3 h-3 text-ink-muted" /> : <ChevronDown className="w-3 h-3 text-ink-muted" />}
                </button>

                {activeReport?.id === r.id && activeReport.risks && (
                  <div className="border-t border-line p-3 space-y-1.5">
                    {activeReport.risks.length === 0 && (
                      <p className="text-xs text-ink-muted">报告中无 risk 详情</p>
                    )}
                    {activeReport.risks.map((risk: SafetyRisk) => {
                      const sty = SEVERITY_TONE[risk.severity] || SEVERITY_TONE.medium;
                      const bgCls = SEVERITY_BG[risk.severity] || SEVERITY_BG.medium;
                      return (
                        <div key={risk.id} className={`p-2 rounded border ${bgCls} text-xs ${risk.is_resolved ? "opacity-50" : ""}`}>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge tone={sty.tone} size="sm">{sty.label}</Badge>
                            <span className="text-ink-secondary">[{risk.category}]</span>
                            {risk.chapter_order ? <span className="text-ink-muted">第 {risk.chapter_order} 章</span> : null}
                            {risk.keyword && (
                              <span className="px-1.5 py-0.5 bg-surface-base border border-line rounded font-mono text-warning">
                                "{risk.keyword}"
                              </span>
                            )}
                            <span className="ml-auto">
                              {risk.is_resolved ? (
                                <Badge tone="success" size="sm">
                                  ✓ 已解决
                                </Badge>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  leftIcon={<CheckCircle2 className="w-3 h-3" />}
                                  onClick={() => resolveRisk(risk.id)}
                                >
                                  标记已解决
                                </Button>
                              )}
                            </span>
                          </div>
                          {risk.snippet && (
                            <div className="text-ink-secondary mb-1">
                              <span className="text-ink-muted">原文:</span> "{risk.snippet}"
                            </div>
                          )}
                          {risk.reason && (
                            <div className="text-warning mb-1">
                              <span className="text-ink-muted">违规理由:</span> {risk.reason}
                            </div>
                          )}
                          {risk.suggestion && (
                            <div className="text-success">
                              <span className="text-ink-muted">改写建议:</span> {risk.suggestion}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
