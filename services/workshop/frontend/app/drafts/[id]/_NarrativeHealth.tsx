"use client";
/**
 * 叙事健康度面板 — 事件时间轴 + 实体负荷检测。
 *
 * 见 docs/PLAN-叙事健康度-时间轴与实体负荷.md。
 * 一期: 时间轴只读渲染 + AI 诊断 + 实体负荷分析(只读展示, 不改大纲)。
 * 数据来自后端 narrative 接口(读 state_ledger, 零新表)。
 */
import { useEffect, useState } from "react";
import { authFetch } from "../../../lib/auth";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loader2, Activity, Tag } from "lucide-react";
import { notifyError } from "@/lib/dialog";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

// 事件类型 -> 颜色/中文名
const EVENT_META: Record<string, { color: string; label: string }> = {
  death: { color: "bg-danger/80 text-white", label: "死亡" },
  reveal: { color: "bg-purple-500/80 text-white", label: "揭秘" },
  resolve: { color: "bg-warning/80 text-white", label: "解悬" },
  twist: { color: "bg-orange-500/80 text-white", label: "反转" },
  new_char: { color: "bg-info/80 text-white", label: "新角色" },
};

type TimelineEp = {
  order: number;
  title: string;
  events: { type: string; label: string; weight: number }[];
  load_score: number;
  load_level: "low" | "mid" | "high";
};
type Timeline = {
  episodes: TimelineEp[];
  stats: { mean: number; std: number; mid_threshold: number; high_threshold: number; max_order: number; total_events: number };
  has_ledger: boolean;
};
type Diagnosis = {
  verdict?: string;
  overloaded?: { start: number; end: number; reason: string; suggestion: string }[];
  underloaded?: { start: number; end: number; reason: string; suggestion: string }[];
  moves?: { event: string; from_ep: number; to_ep: number; why: string }[];
};
type Entity = { name: string; type: string; first_episode: number; episodes: number[]; count: number };
type EntityReport = {
  entities: Entity[];
  per_episode_new: Record<string, number>;
  issues: { level: string; code: string; episode: number; message: string }[];
  summary: { total: number; once_only: number; orgs: number };
};

const LEVEL_BAR: Record<string, string> = {
  low: "bg-success/50",
  mid: "bg-warning/60",
  high: "bg-danger/70",
};

export function NarrativeHealth({ draftId, onOutlineChanged }: { draftId: number; onOutlineChanged?: () => void }) {
  const [tab, setTab] = useState<"timeline" | "entity" | "hooks" | "escalation">("timeline");

  // D6: 结构视图数据（来自剧情门禁，零 LLM）
  const [dramaReport, setDramaReport] = useState<any>(null);
  const [structLoading, setStructLoading] = useState(false);

  // 时间轴
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tlLoading, setTlLoading] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [rebalancing, setRebalancing] = useState(false);
  const [editingEp, setEditingEp] = useState<number | null>(null);
  const [editEvents, setEditEvents] = useState<{ type: string; label: string }[]>([]);
  const [savingEvents, setSavingEvents] = useState(false);

  // 实体负荷
  const [entityReport, setEntityReport] = useState<EntityReport | null>(null);
  const [entityAnalyzed, setEntityAnalyzed] = useState(false);
  const [entityLoading, setEntityLoading] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  async function loadTimeline() {
    setTlLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/narrative-timeline`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setTimeline(data.timeline);
    } catch (e) {
      notifyError("加载时间轴失败: " + (e as Error).message);
    } finally {
      setTlLoading(false);
    }
  }

  async function runDiagnose() {
    setDiagnosing(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/narrative-timeline/diagnose`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setDiagnosis(data.diagnosis);
      if (data.timeline) setTimeline(data.timeline);
    } catch (e) {
      notifyError("AI 诊断失败: " + (e as Error).message);
    } finally {
      setDiagnosing(false);
    }
  }

  async function loadEntity() {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/entity-load`);
      if (r.ok) {
        const data = await r.json();
        setEntityReport(data.entity_report || null);
        setEntityAnalyzed(!!data.analyzed);
      }
    } catch { /* silent */ }
  }

  async function runRebalance() {
    setRebalancing(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/narrative-timeline/rebalance`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (data.timeline) setTimeline(data.timeline);
      setDiagnosis(null);
      onOutlineChanged?.();
    } catch (e) {
      notifyError("AI 优化重排失败: " + (e as Error).message);
    } finally {
      setRebalancing(false);
    }
  }

  function openEventEditor(ep: TimelineEp) {
    setEditingEp(ep.order);
    setEditEvents(ep.events.map((e) => ({ type: e.type, label: e.label })));
  }

  async function saveEvents() {
    if (editingEp == null) return;
    setSavingEvents(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/narrative-timeline/events`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episode: editingEp, events: editEvents.filter((e) => e.label.trim()) }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      if (data.timeline) setTimeline(data.timeline);
      setEditingEp(null);
    } catch (e) {
      notifyError("保存事件失败: " + (e as Error).message);
    } finally {
      setSavingEvents(false);
    }
  }

  async function runOptimizeEntities() {
    setOptimizing(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/entity-load/optimize`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setEntityReport(data.entity_report || null);
      setEntityAnalyzed(true);
      onOutlineChanged?.();
    } catch (e) {
      notifyError("AI 减负失败: " + (e as Error).message);
    } finally {
      setOptimizing(false);
    }
  }

  async function runEntity() {
    setEntityLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/entity-load`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setEntityReport(data.entity_report || null);
      setEntityAnalyzed(true);
    } catch (e) {
      notifyError("实体负荷分析失败: " + (e as Error).message);
    } finally {
      setEntityLoading(false);
    }
  }

  useEffect(() => {
    loadTimeline();
    loadEntity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const maxScore = timeline?.episodes.reduce((m, e) => Math.max(m, e.load_score), 0) || 1;

  // D6: 拉取剧情结构门禁数据（钩子链 / 升级曲线）。零 LLM，秒级。
  async function loadStructure() {
    setStructLoading(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/drama-gate`);
      if (res.ok) {
        const data = await res.json();
        setDramaReport(data.drama_report || null);
      }
    } catch {
      /* 静默：此视图为辅助信息，不打断主流程 */
    } finally {
      setStructLoading(false);
    }
  }

  return (
    <Card padding="md" className="mb-4">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h3 className="font-semibold text-ink-primary flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" /> 叙事健康度
        </h3>
        <div className="inline-flex rounded-lg border border-line overflow-hidden text-xs">
          <button
            onClick={() => setTab("timeline")}
            className={`px-3 py-1.5 transition ${tab === "timeline" ? "bg-primary text-white" : "bg-surface-base text-ink-secondary hover:bg-surface-overlay"}`}
          >
            事件时间轴
          </button>
          <button
            onClick={() => setTab("entity")}
            className={`px-3 py-1.5 transition ${tab === "entity" ? "bg-primary text-white" : "bg-surface-base text-ink-secondary hover:bg-surface-overlay"}`}
          >
            实体负荷
          </button>
          <button
            onClick={() => { setTab("hooks"); loadStructure(); }}
            className={`px-3 py-1.5 transition ${tab === "hooks" ? "bg-primary text-white" : "bg-surface-base text-ink-secondary hover:bg-surface-overlay"}`}
          >
            钩子链
          </button>
          <button
            onClick={() => { setTab("escalation"); loadStructure(); }}
            className={`px-3 py-1.5 transition ${tab === "escalation" ? "bg-primary text-white" : "bg-surface-base text-ink-secondary hover:bg-surface-overlay"}`}
          >
            升级曲线
          </button>
        </div>
        <span className="text-xs text-ink-muted ml-auto">诊断事件密度 / 专有名词过载 / 钩子与升级, 帮观众看得懂</span>
      </div>

      {(tab === "hooks" || tab === "escalation") && (
        <StructureView tab={tab} report={dramaReport} loading={structLoading} onRefresh={loadStructure} />
      )}

      {tab === "timeline" && (
        <div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Button variant="secondary" size="sm" onClick={loadTimeline} loading={tlLoading}>
              刷新时间轴
            </Button>
            <Button variant="primary" size="sm" onClick={runDiagnose} loading={diagnosing}>
              🤖 AI 诊断分布
            </Button>
            <Button variant="cyan" size="sm" onClick={runRebalance} loading={rebalancing}
              title="AI 跨集重新分配事件, 均衡节奏, 并回写大纲(受影响集会标为过期, 需重生章节/剧本)">
              ⚖️ AI 优化重排并回写
            </Button>
            {timeline?.stats && (
              <span className="text-xs text-ink-muted">
                均值负荷 {timeline.stats.mean} / 高负荷阈值 {timeline.stats.high_threshold}（红=过载）
              </span>
            )}
          </div>

          {tlLoading && !timeline ? (
            <div className="py-8 text-center text-ink-muted"><Loader2 className="w-5 h-5 animate-spin inline" /> 加载中…</div>
          ) : !timeline || timeline.episodes.length === 0 ? (
            <p className="text-sm text-ink-muted py-6 text-center">暂无时间轴数据（需先有大纲）</p>
          ) : (
            <div className="overflow-x-auto pb-2">
              <div className="flex gap-2 min-w-max items-end" style={{ minHeight: "160px" }}>
                {timeline.episodes.map((ep) => {
                  const barH = Math.max(4, Math.round((ep.load_score / maxScore) * 120));
                  return (
                    <div key={ep.order} className="flex flex-col items-center w-16 flex-shrink-0" title={`第${ep.order}集《${ep.title}》 负荷${ep.load_score}`}>
                      {/* 事件卡堆叠 */}
                      <div className="flex flex-col gap-0.5 w-full mb-1">
                        {ep.events.slice(0, 6).map((e, i) => {
                          const meta = EVENT_META[e.type] || { color: "bg-surface-overlay text-ink-primary", label: e.type };
                          return (
                            <div key={i} className={`text-[9px] px-1 py-0.5 rounded truncate ${meta.color}`} title={`${meta.label}: ${e.label}`}>
                              {e.label}
                            </div>
                          );
                        })}
                        {ep.events.length > 6 && (
                          <div className="text-[9px] text-ink-muted text-center">+{ep.events.length - 6}</div>
                        )}
                      </div>
                      {/* 负荷柱 */}
                      <div className="w-full flex items-end justify-center" style={{ height: "120px" }}>
                        <div className={`w-6 rounded-t ${LEVEL_BAR[ep.load_level]}`} style={{ height: `${barH}px` }} />
                      </div>
                      {/* 集号 + 负荷分 (点击编辑该集事件) */}
                      <button
                        onClick={() => openEventEditor(ep)}
                        className={`text-[10px] mt-1 hover:underline ${ep.load_level === "high" ? "text-danger font-bold" : "text-ink-secondary"}`}
                        title="点击手动增删该集事件"
                      >
                        {ep.order}集·{ep.load_score} ✎
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 手动编辑某集事件的弹层 */}
          {editingEp != null && (
            <div className="mt-3 p-3 border border-primary/40 rounded-lg bg-surface-overlay/40">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-ink-primary">编辑第 {editingEp} 集事件</span>
                <span className="text-[11px] text-ink-muted">仅改时间轴展示/负荷, 不动大纲正文</span>
              </div>
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {editEvents.map((ev, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={ev.type}
                      onChange={(e) => setEditEvents((prev) => prev.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                      className="text-xs px-1.5 py-1 bg-surface-base border border-line rounded"
                    >
                      {Object.entries(EVENT_META).map(([k, m]) => (
                        <option key={k} value={k}>{m.label}</option>
                      ))}
                    </select>
                    <input
                      value={ev.label}
                      onChange={(e) => setEditEvents((prev) => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      placeholder="事件描述, 如'揭穿身份'"
                      className="flex-1 text-xs px-2 py-1 bg-surface-base border border-line rounded text-ink-primary"
                    />
                    <button
                      onClick={() => setEditEvents((prev) => prev.filter((_, j) => j !== i))}
                      className="text-xs px-2 py-1 text-danger hover:bg-danger/10 rounded"
                    >删</button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Button variant="ghost" size="sm" onClick={() => setEditEvents((prev) => [...prev, { type: "twist", label: "" }])}>
                  + 添加事件
                </Button>
                <div className="ml-auto flex gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => setEditingEp(null)}>取消</Button>
                  <Button variant="primary" size="sm" onClick={saveEvents} loading={savingEvents}>保存</Button>
                </div>
              </div>
            </div>
          )}

          {/* AI 诊断结果 */}
          {diagnosis && (
            <div className="mt-4 space-y-2">
              {diagnosis.verdict && (
                <div className="p-2 bg-primary/10 border border-primary/30 rounded text-sm text-ink-primary">
                  🎬 {diagnosis.verdict}
                </div>
              )}
              {(diagnosis.overloaded || []).length > 0 && (
                <div className="text-sm">
                  <div className="font-semibold text-danger mb-1">过载段</div>
                  <ul className="space-y-1">
                    {diagnosis.overloaded!.map((o, i) => (
                      <li key={i} className="text-xs text-ink-secondary pl-2 border-l-2 border-danger/50">
                        第{o.start}-{o.end}集: {o.reason} → <span className="text-ink-primary">{o.suggestion}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(diagnosis.underloaded || []).length > 0 && (
                <div className="text-sm">
                  <div className="font-semibold text-warning mb-1">空洞段</div>
                  <ul className="space-y-1">
                    {diagnosis.underloaded!.map((o, i) => (
                      <li key={i} className="text-xs text-ink-secondary pl-2 border-l-2 border-warning/50">
                        第{o.start}-{o.end}集: {o.reason} → <span className="text-ink-primary">{o.suggestion}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(diagnosis.moves || []).length > 0 && (
                <div className="text-sm">
                  <div className="font-semibold text-primary mb-1">建议事件搬迁</div>
                  <ul className="space-y-1">
                    {diagnosis.moves!.map((m, i) => (
                      <li key={i} className="text-xs text-ink-secondary pl-2 border-l-2 border-primary/50">
                        「{m.event}」从第{m.from_ep}集 → 第{m.to_ep}集: {m.why}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-ink-muted mt-1">※ 二期将支持一键采纳并回写大纲</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "entity" && (
        <div>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Button variant="primary" size="sm" onClick={runEntity} loading={entityLoading} leftIcon={<Tag className="w-3.5 h-3.5" />}>
              {entityAnalyzed ? "重新分析" : "分析实体负荷"}
            </Button>
            {entityAnalyzed && (
              <Button variant="cyan" size="sm" onClick={runOptimizeEntities} loading={optimizing}
                title="AI 合并同类专有名词、把只出现一次的名词改用泛称, 并回写大纲(受影响集会标为过期)">
                🧹 AI 减负并回写
              </Button>
            )}
            {entityReport?.summary && (
              <span className="text-xs text-ink-muted">
                共 {entityReport.summary.total} 个专有名词 / {entityReport.summary.once_only} 个仅出现一次 / {entityReport.summary.orgs} 个组织
              </span>
            )}
          </div>

          {!entityAnalyzed ? (
            <p className="text-sm text-ink-muted py-6 text-center">点击「分析实体负荷」检测专有名词是否过载（1 次 AI 调用）</p>
          ) : !entityReport ? (
            <p className="text-sm text-ink-muted py-6 text-center">暂无数据</p>
          ) : (
            <div className="space-y-3">
              {/* issues */}
              {(entityReport.issues || []).length > 0 && (
                <div className="space-y-1.5">
                  {entityReport.issues.map((it, i) => (
                    <div key={i} className="p-2 bg-warning/10 border border-warning/40 rounded text-sm text-warning">
                      ⚠️ {it.message}
                    </div>
                  ))}
                </div>
              )}
              {/* 实体表 */}
              <div className="max-h-64 overflow-y-auto border border-line rounded">
                <table className="w-full text-xs">
                  <thead className="bg-surface-overlay/50 sticky top-0">
                    <tr className="text-ink-secondary">
                      <th className="text-left px-2 py-1">名称</th>
                      <th className="text-left px-2 py-1">类型</th>
                      <th className="text-left px-2 py-1">首现</th>
                      <th className="text-left px-2 py-1">出现集</th>
                      <th className="text-left px-2 py-1">次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entityReport.entities.map((e, i) => (
                      <tr key={i} className={`border-t border-line/40 ${e.count === 1 ? "bg-warning/5" : ""}`}>
                        <td className="px-2 py-1 text-ink-primary">{e.name}</td>
                        <td className="px-2 py-1">
                          <Badge tone="muted" size="sm">{e.type}</Badge>
                        </td>
                        <td className="px-2 py-1 text-ink-secondary">第{e.first_episode}集</td>
                        <td className="px-2 py-1 text-ink-muted">{e.episodes.join(",")}</td>
                        <td className={`px-2 py-1 ${e.count === 1 ? "text-warning font-semibold" : "text-ink-secondary"}`}>{e.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-muted">※ 黄色行 = 全剧仅出现一次的专有名词，建议合并或改用泛称。二期将支持一键 AI 减负改写。</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
/**
 * D6: 钩子链 / 升级曲线视图。
 *
 * 数据来自 /drama-gate 的 drama_report（零 LLM，秒级）。
 * 这里只做可视化，不触发任何生成——所有修订动作都在别处由用户显式发起。
 */
function StructureView({
  tab,
  report,
  loading,
  onRefresh,
}: {
  tab: "hooks" | "escalation";
  report: any;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (loading) {
    return (
      <p className="text-sm text-ink-muted py-6 text-center flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> 读取结构数据...
      </p>
    );
  }
  if (!report) {
    return (
      <div className="py-6 text-center space-y-3">
        <p className="text-sm text-ink-muted">
          还没有跑过剧情门禁。门禁检查钩子链、升级曲线与伏笔回收，
          <span className="text-success"> 纯本地规则、不计费</span>。
        </p>
        <Button variant="secondary" size="sm" onClick={onRefresh}>读取结构数据</Button>
      </div>
    );
  }

  const issues: any[] = report.issues || [];
  const summary = report.summary || { error: 0, warn: 0, checked: 0 };
  const structure = report.structure || {};
  const chain: any[] = structure.hook_chain || [];
  const curve: any[] = structure.escalation_curve || [];
  const promises: any[] = structure.promises || [];

  const hookCodes = ["hook_chain_break", "hook_type_repeat", "hook_weak",
                     "hook_missing_leads_to", "hook_delay_too_long"];
  const escCodes = ["escalation_stall", "stakes_vague", "stakes_too_vague_short",
                    "stakes_missing",   // 2026-10-11：字段没填，与"写得空泛"分开报
                    "value_shift_noop", "value_shift_repeat", "weak_causality",
                    // 2026-09-19 新增两门：情绪强度跳变 / 权力关系
                    // 归在"升级"页签 —— 它们问的都是"这一集的压迫强度对不对"
                    "emotion_cliff", "power_self", "power_incomplete",
                    "power_focus_vague"];
  const codes = tab === "hooks" ? hookCodes : escCodes;
  const mine = issues.filter((i) => codes.includes(i.code));

  const hint = tab === "hooks"
    ? "每集结尾的悬念是否承接上一集、是否引发下一集；连续 3 集同类型会疲劳"
    : "压迫强度是否在上升；连续 3 集不升级会在中段疲软；情绪强度落差过大也会断裂";

  const maxLevel = curve.reduce((m, c) => Math.max(m, c.level), 0) || 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-ink-muted">{hint}</span>
        <span className="text-xs text-ink-muted ml-auto">
          已检查 {summary.checked || 0} 集 · 结构问题 {summary.error || 0} · 提醒 {summary.warn || 0}
        </span>
      </div>

      {/* 钩子链：逐集列出出口钩与承接关系 */}
      {tab === "hooks" && chain.length > 0 && (
        <div className="space-y-1">
          {chain.map((c, i) => {
            const broken = i > 0 && c.in_mode && c.in_mode !== "有意延迟" &&
              c.responds_to && chain[i - 1]?.leads_to &&
              c.responds_to.slice(0, 6) !== chain[i - 1].leads_to.slice(0, 6) &&
              !chain[i - 1].leads_to.includes(c.responds_to.slice(0, 4));
            const warnRepeat = c.out_type && i >= 2 &&
              chain[i - 1]?.out_type === c.out_type && chain[i - 2]?.out_type === c.out_type;
            return (
              <div
                key={i}
                className={`flex items-start gap-2 p-2 rounded border text-sm ${
                  broken ? "border-danger/50 bg-danger/10"
                    : warnRepeat ? "border-warning/50 bg-warning/10"
                      : "border-line"
                }`}
              >
                <span className="font-mono text-xs text-ink-secondary w-10 shrink-0 pt-0.5">
                  #{c.ep}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {c.out_type
                      ? <Badge>{c.out_type}</Badge>
                      : <span className="text-xs text-ink-muted">（未标注出口钩）</span>}
                    {c.strength && <span className="text-xs text-ink-muted">强度 {c.strength}</span>}
                    {c.in_mode && c.in_mode !== "直接延续" && (
                      <span className="text-xs text-info">{c.in_mode}</span>
                    )}
                    {broken && <span className="text-xs text-danger">断链</span>}
                    {warnRepeat && <span className="text-xs text-warning">类型重复</span>}
                  </div>
                  {c.leads_to && (
                    <div className="text-xs text-ink-muted mt-0.5 truncate">
                      → {c.leads_to}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 升级曲线：强度档位柱状 + 停滞标记 */}
      {tab === "escalation" && curve.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-end gap-1 h-28 border-b border-line pb-1">
            {curve.map((c, i) => {
              const h = c.level < 0 ? 4 : Math.max(8, (c.level + 1) / (maxLevel + 1) * 100);
              const stalled = i >= 3 && !c.is_upgrade && !curve[i - 1].is_upgrade;
              return (
                <div
                  key={i}
                  className="flex-1 flex flex-col justify-end items-center gap-0.5"
                  title={`第${c.ep}集 ${c.label}`}
                >
                  <div
                    className={`w-full rounded-t ${
                      c.level < 0 ? "bg-line"
                        : stalled ? "bg-danger/70"
                          : "bg-success/70"
                    }`}
                    style={{ height: `${h}%` }}
                  />
                  <span className="text-[10px] text-ink-muted">{c.ep}</span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-muted">
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 bg-success/70 rounded-sm inline-block" /> 上升
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 bg-danger/70 rounded-sm inline-block" /> 停滞
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-2 bg-line rounded-sm inline-block" /> 未标注
            </span>
          </div>
        </div>
      )}

      {/* 伏笔台账（两个 tab 都展示，因为它同时影响钩子与升级的判断） */}
      {promises.length > 0 && (
        <div className="pt-1">
          <div className="text-xs text-ink-secondary mb-1">伏笔台账</div>
          <div className="space-y-0.5">
            {promises.map((p, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 text-xs px-2 py-1 rounded border ${
                  p.status === "paid"
                    ? "border-line text-ink-muted"
                    : p.overdue
                      ? "border-danger/50 bg-danger/10 text-danger"
                      : "border-warning/40 text-warning"
                }`}
              >
                <span className="font-mono">{p.id}</span>
                <span className="flex-1 truncate">{p.text}</span>
                <span>第{p.planted_at}集埋</span>
                <span>
                  {p.status === "paid" ? `第${p.paid_at}集收` : p.overdue ? "逾期未收" : "待收"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 问题列表 */}
      {mine.length > 0 && (
        <div className="space-y-2 pt-1">
          {mine.map((it: any, i: number) => (
            <div
              key={i}
              className={`p-2 rounded border text-sm ${
                it.level === "error"
                  ? "border-danger/50 bg-danger/10"
                  : "border-warning/50 bg-warning/10"
              }`}
            >
              <div className={it.level === "error" ? "text-danger" : "text-warning"}>
                {typeof it.episode === "number" ? `第${it.episode}集: ` : ""}{it.message}
              </div>
              {it.fix_hint && (
                <div className="text-xs text-ink-secondary mt-1">→ {it.fix_hint}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {chain.length === 0 && curve.length === 0 && (
        <p className="text-sm text-ink-muted py-4 text-center">
          这份大纲还没有戏剧契约字段，无法绘制钩子链与升级曲线。
          <br />
          <span className="text-xs">
            新版生成的大纲会自动带上；老剧可用「跑剧情门禁」查看字段缺失清单。
          </span>
        </p>
      )}
    </div>
  );
}
