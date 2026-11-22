"use client";
import { authFetch } from "../../../lib/auth";
import { notifySuccess } from "@/lib/dialog";
import { useEffect, useRef, useState } from "react";
import { Wand2, AlertTriangle, Sparkles, Check, Loader2, ArrowRight, RefreshCw, Columns2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

// ---- 蓝图结构 (与后端 adaptation_prompts.ANALYZE_PROMPT 输出对齐) ----
type CharItem = { name: string; role?: string; persona?: string };
type RelItem = { a: string; b: string; relation: string; tension?: string; motive?: string };
type BeatItem = { stage?: string; beat?: string; note?: string };
type Blueprint = {
  title?: string;
  logline?: string;
  era?: string;
  locations?: string[];
  central_conflict?: string;
  characters?: CharItem[];
  relations?: RelItem[];
  emotion_beats?: BeatItem[];
};
type Suggestion = { target?: string; issue?: string; advice?: string; patch?: any };

const STEP_LABELS = ["① 分析原作", "② 编辑改编蓝图", "③ 确认并生成"];

/**
 * 改编 Modal — 三步交互式工作流:
 *   step1 分析原作 -> step2 编辑蓝图(+AI建议) -> step3 确认合同 -> SSE 改编大纲+正文 -> 新草稿
 */
export function AdaptModal({
  draftId,
  open,
  onClose,
  onDone,
}: {
  draftId: number;
  open: boolean;
  onClose: () => void;
  onDone?: (newDraftId: number) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);

  // step1
  const [analyzing, setAnalyzing] = useState(false);
  const [origin, setOrigin] = useState<Blueprint | null>(null);   // 原作蓝图(只读基线)
  const [draftBp, setDraftBp] = useState<Blueprint | null>(null); // 用户可编辑改编草案

  // step2 AI 建议
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [overallNote, setOverallNote] = useState<string>("");
  // step2 一键生成改编设定 + 对照视图
  const [proposing, setProposing] = useState(false);
  const [compareMode, setCompareMode] = useState(true); // 默认开启原作↔改编左右对照

  // step3 改编执行（后台作业 + 轮询）
  // 2026-10-18: 改编由 SSE 流改为后台作业。关弹窗/刷新/上线重启都不会再中止改编；
  // 重新打开弹窗会自动接上进行中的作业。
  const [running, setRunning] = useState(false);
  const [pctDone, setPctDone] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [newDraftId, setNewDraftId] = useState<number | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobStatus, setJobStatus] = useState<string>("");
  const [canceling, setCanceling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneNotifiedRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      // 重置 + 自动尝试加载缓存蓝图
      setStep(1);
      setError(null);
      setSuggestions([]);
      setOverallNote("");
      setLogs([]);
      setPctDone(0);
      setNewDraftId(null);
      setJobId(null);
      setJobStatus("");
      void attachActiveJob().then((attached) => { if (!attached) void loadMeta(); });
    } else {
      // 关弹窗只停止轮询，不取消后台改编
      stopPolling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  // 打开弹窗时：这部作品若有进行中的改编作业，直接接上进度
  async function attachActiveJob(): Promise<boolean> {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/jobs/active`);
      if (!r.ok) return false;
      const data = await r.json();
      if (data.job?.id) {
        setStep(3);
        startPolling(data.job.id);
        return true;
      }
    } catch { /* 查不到就按正常流程打开 */ }
    return false;
  }

  function applyJob(j: any) {
    const res = j.result || {};
    setJobStatus(j.status);
    setPctDone(Math.max(0, Math.min(100, j.progress || 0)));
    if (Array.isArray(res.log)) setLogs(res.log);
    if (res.new_draft_id) setNewDraftId(res.new_draft_id);
    const active = j.status === "queued" || j.status === "running";
    setRunning(active);
    if (!active) {
      stopPolling();
      if (j.status === "done" && res.phase !== "canceled") {
        if (doneNotifiedRef.current !== j.id) {
          doneNotifiedRef.current = j.id;
          notifySuccess("改编完成, 已生成新作");
          if (res.new_draft_id && onDone) onDone(res.new_draft_id);
        }
      } else if (j.status === "failed") {
        setError(j.error || "改编失败");
      }
    }
  }

  function startPolling(id: number) {
    stopPolling();
    setJobId(id);
    setRunning(true);
    const tick = async () => {
      try {
        const r = await authFetch(`${BASE}/v1/agent/jobs/${id}`);
        if (r.ok) applyJob(await r.json());
      } catch { /* 网络抖动：下一轮再试 */ }
    };
    void tick();
    pollRef.current = setInterval(tick, 3000);
  }

  async function handleCancel() {
    if (!jobId) return;
    if (!confirm("确定取消改编？已完成的部分会保留在新草稿里。")) return;
    setCanceling(true);
    try {
      await authFetch(`${BASE}/v1/agent/jobs/${jobId}/cancel`, { method: "POST" });
    } finally {
      setCanceling(false);
    }
  }

  useEffect(() => () => stopPolling(), []);

  async function loadMeta() {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/meta`);
      if (r.ok) {
        const data = await r.json();
        if (data.cached_blueprint) {
          setOrigin(data.cached_blueprint);
          setDraftBp(JSON.parse(JSON.stringify(data.cached_blueprint)));
          setStep(2);
        }
      }
    } catch {
      /* 缓存读取失败不阻塞, 用户可手动点分析 */
    }
  }

  async function handleAnalyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/analyze`, {
        method: "POST",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const bp: Blueprint = data.blueprint || {};
      setOrigin(bp);
      setDraftBp(JSON.parse(JSON.stringify(bp)));
      setStep(2);
    } catch (e: any) {
      setError(e.message || "分析原作失败");
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleSuggest() {
    if (!origin || !draftBp) return;
    setSuggesting(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, draft_blueprint: draftBp, scope: "overall" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setSuggestions(data.suggestions || []);
      setOverallNote(data.overall || "");
      if (!(data.suggestions || []).length) {
        notifySuccess("AI 检查通过, 未发现明显连带问题");
      }
    } catch (e: any) {
      setError(e.message || "生成建议失败");
    } finally {
      setSuggesting(false);
    }
  }

  /** 一键让 AI 生成一套全新的改编设定 (覆盖当前草案, 原作蓝图保持不变作为对照) */
  async function handlePropose() {
    if (!origin) return;
    setProposing(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, guidance: (draftBp as any)?.guidance || "" }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const bp: Blueprint = data.blueprint || {};
      // 保留用户已写的自由总纲
      const keepGuidance = (draftBp as any)?.guidance || "";
      setDraftBp({ ...bp, ...(keepGuidance ? { guidance: keepGuidance } as any : {}) });
      setSuggestions([]);
      setOverallNote("");
      setCompareMode(true);
      notifySuccess("已生成全套改编设定, 可与原作对照后再调整");
    } catch (e: any) {
      setError(e.message || "生成改编设定失败");
    } finally {
      setProposing(false);
    }
  }

  /** 采纳一条 patch 建议 (若带 field/value) */
  function adoptSuggestion(s: Suggestion, idx: number) {
    if (s.patch && typeof s.patch === "object" && s.patch.field) {
      const field = String(s.patch.field);
      const value = s.patch.value;
      setDraftBp((prev) => (prev ? { ...prev, [field]: value } : prev));
    }
    setSuggestions((prev) => prev.filter((_, i) => i !== idx));
  }

  /** 构造提交给后端的改编合同 */
  function buildContract() {
    const bp = draftBp || {};
    const name_map: Record<string, string> = {};
    const oc = origin?.characters || [];
    const dc = bp.characters || [];
    // 以索引对齐原作/改编角色, 生成旧名->新名映射
    oc.forEach((o, i) => {
      const nn = dc[i]?.name;
      if (o?.name && nn && o.name !== nn) name_map[o.name] = nn;
    });
    return {
      title: bp.title || "",
      era: bp.era || "",
      locations: bp.locations || [],
      central_conflict: bp.central_conflict || "",
      name_map,
      relations: bp.relations || [],
      characters: bp.characters || [],
      emotion_beats: bp.emotion_beats || [],
      guidance: (bp as any).guidance || "",
    };
  }

  async function handleCommit() {
    if (!draftBp) return;
    setStep(3);
    setRunning(true);
    setError(null);
    setLogs([]);
    setPctDone(0);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/adapt/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: buildContract() }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 409 && data.detail?.job_id) {
        // 已有进行中的改编：直接接上它的进度
        startPolling(data.detail.job_id);
        return;
      }
      if (!r.ok || !data.job_id) throw new Error(data.detail?.message || data.detail || `HTTP ${r.status}`);
      startPolling(data.job_id);
    } catch (e: any) {
      setRunning(false);
      setError(e.message || "改编提交失败");
    }
  }

  // ---------- 编辑器辅助 ----------
  function setBp<K extends keyof Blueprint>(k: K, v: Blueprint[K]) {
    setDraftBp((prev) => (prev ? { ...prev, [k]: v } : prev));
  }
  function setChar(i: number, key: keyof CharItem, v: string) {
    setDraftBp((prev) => {
      if (!prev) return prev;
      const chars = [...(prev.characters || [])];
      chars[i] = { ...chars[i], [key]: v };
      return { ...prev, characters: chars };
    });
  }
  function setRel(i: number, key: keyof RelItem, v: string) {
    setDraftBp((prev) => {
      if (!prev) return prev;
      const rels = [...(prev.relations || [])];
      rels[i] = { ...rels[i], [key]: v };
      return { ...prev, relations: rels };
    });
  }

  const pct = pctDone;

  const footer =
    step === 2 ? (
      <div className="flex items-center justify-between gap-2 w-full">
        <Button
          variant="ghost"
          size="sm"
          loading={suggesting}
          leftIcon={!suggesting ? <Sparkles className="w-4 h-4" /> : undefined}
          onClick={handleSuggest}
        >
          {suggesting ? "AI 检查中..." : "AI 连带检查"}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            leftIcon={<ArrowRight className="w-4 h-4" />}
            onClick={handleCommit}
            disabled={!draftBp}
          >
            确认改编蓝图, 生成新作
          </Button>
        </div>
      </div>
    ) : step === 3 ? (
      <div className="flex justify-end gap-2 w-full">
        {running && (
          <Button variant="secondary" onClick={handleCancel} disabled={canceling || !jobId}>
            {canceling ? "正在取消..." : "取消改编"}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {running ? "后台继续，先关闭" : "关闭"}
        </Button>
        {newDraftId && !running && (
          <Button variant="primary" onClick={() => onDone?.(newDraftId)}>
            打开改编新作
          </Button>
        )}
      </div>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Wand2 className="w-5 h-5 text-primary" />
          改编为新作
          <span className="ml-2 text-xs text-ink-muted">{STEP_LABELS[step - 1]}</span>
        </span>
      }
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-lg p-3 text-sm text-danger flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* ===== step1 分析原作 ===== */}
        {step === 1 && (
          <div className="space-y-4 text-center py-6">
            <div className="text-sm text-ink-secondary">
              改编会先用 AI 提炼原作的人物、人际关系、大纲、中心矛盾与情绪曲线,
              你可逐项修改并获得连带建议, 确认后生成一部全新的剧目(原作不受影响)。
            </div>
            <Button
              variant="primary"
              size="lg"
              loading={analyzing}
              leftIcon={!analyzing ? <Sparkles className="w-4 h-4" /> : undefined}
              onClick={handleAnalyze}
            >
              {analyzing ? "正在分析原作..." : "开始分析原作"}
            </Button>
          </div>
        )}

        {/* ===== step2 编辑蓝图 ===== */}
        {step === 2 && draftBp && (
          <div className="space-y-4">
            {/* 设定方向: 自然语言描述期望, 驱动一键生成 + 作为改编硬约束 (可留空) */}
            <div>
              <label className="block text-xs text-ink-secondary mb-1">
                设定方向 (可选)
              </label>
              <Textarea
                value={(draftBp as any).guidance || ""}
                onChange={(e) => setBp("guidance" as any, e.target.value as any)}
                rows={2}
                placeholder="用一句话描述期望的改编方向, 如: 改成现代都市; 基调更轻喜; 女主从隐忍改为主动反击。留空则由 AI 自由发挥。"
              />
              <div className="text-[11px] text-ink-muted mt-1">
                这里写的方向会指导「AI 一键生成改编设定」, 并作为后续正式改编的硬约束。
              </div>
            </div>

            {/* 工具条: 一键生成改编设定 + 对照开关 */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Button
                variant="primary"
                size="sm"
                loading={proposing}
                leftIcon={!proposing ? <Wand2 className="w-4 h-4" /> : undefined}
                onClick={handlePropose}
                title="按上方设定方向, 让 AI 基于原作生成一套全新的、与原作区分的改编设定, 覆盖下方改编栏"
              >
                {proposing ? "AI 生成改编设定中..." : "AI 一键生成改编设定"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Columns2 className="w-4 h-4" />}
                onClick={() => setCompareMode((v) => !v)}
                title="开启/关闭 原作 ↔ 改编 左右对照"
              >
                {compareMode ? "关闭对照" : "原作对照"}
              </Button>
            </div>

            {/* 原作蓝图参考 (只读, 琥珀色边框与改编区视觉区分) */}
            {compareMode && origin && (
              <Card padding="md" className="bg-warning/5 border-warning/40">
                <div className="text-sm font-medium text-warning mb-2 flex items-center gap-1">
                  📖 原作设定 (只读参考)
                </div>
                <div className="space-y-1.5 text-xs text-ink-secondary">
                  {origin.title && <div><span className="text-ink-muted">标题:</span> {origin.title}</div>}
                  {origin.era && <div><span className="text-ink-muted">时代:</span> {origin.era}</div>}
                  {(origin.locations || []).length > 0 && (
                    <div><span className="text-ink-muted">地点:</span> {(origin.locations || []).join("、")}</div>
                  )}
                  {origin.central_conflict && (
                    <div><span className="text-ink-muted">中心矛盾:</span> {origin.central_conflict}</div>
                  )}
                  {(origin.characters || []).length > 0 && (
                    <div className="pt-1">
                      <div className="text-ink-muted mb-0.5">人物:</div>
                      <div className="flex flex-wrap gap-1">
                        {(origin.characters || []).map((c, i) => (
                          <span key={i} className="px-1.5 py-0.5 bg-warning/10 rounded">
                            {c.name}{c.role ? `·${c.role}` : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(origin.relations || []).length > 0 && (
                    <div className="pt-1">
                      <div className="text-ink-muted mb-0.5">人际关系:</div>
                      <div className="space-y-0.5">
                        {(origin.relations || []).map((r, i) => (
                          <div key={i}>{r.a} —{r.relation}— {r.b}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {compareMode && (
              <div className="text-xs text-primary font-medium flex items-center gap-1 pt-1">
                ✏️ 以下为改编新设定 (可编辑)
              </div>
            )}

            {/* AI 建议区 */}
            {(suggestions.length > 0 || overallNote) && (
              <Card padding="md" className="bg-primary-subtle/40 border-primary/30">
                <div className="text-sm font-medium text-primary mb-2 flex items-center gap-1">
                  <Sparkles className="w-4 h-4" /> AI 连带建议
                </div>
                {overallNote && <div className="text-xs text-ink-secondary mb-2">{overallNote}</div>}
                <div className="space-y-2">
                  {suggestions.map((s, i) => (
                    <div key={i} className="text-xs bg-surface-base rounded-md p-2 flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="text-ink-muted">[{s.target}] {s.issue}</div>
                        <div className="text-ink-primary mt-0.5">→ {s.advice}</div>
                      </div>
                      <Button size="sm" variant="ghost" leftIcon={<Check className="w-3 h-3" />} onClick={() => adoptSuggestion(s, i)}>
                        采纳
                      </Button>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 基础设定 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-ink-secondary mb-1">新作标题</label>
                <Input value={draftBp.title || ""} onChange={(e) => setBp("title", e.target.value)} placeholder="留空则沿用原作标题" />
              </div>
              <div>
                <label className="block text-xs text-ink-secondary mb-1">时代背景</label>
                <Input value={draftBp.era || ""} onChange={(e) => setBp("era", e.target.value)} placeholder="如 现代都市 / 民国 / 架空古代" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">主要地点 (逗号分隔)</label>
              <Input
                value={(draftBp.locations || []).join(", ")}
                onChange={(e) => setBp("locations", e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean))}
              />
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">中心矛盾</label>
              <Textarea value={draftBp.central_conflict || ""} onChange={(e) => setBp("central_conflict", e.target.value)} rows={2} />
            </div>

            {/* 人物 */}
            {(draftBp.characters || []).length > 0 && (
              <div>
                <div className="text-xs text-ink-secondary mb-1">人物 (改名/改设定; 原名见灰字)</div>
                <div className="space-y-2 max-h-48 overflow-auto pr-1">
                  {(draftBp.characters || []).map((c, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <span className="text-xs text-ink-muted w-20 truncate" title={origin?.characters?.[i]?.name}>
                        {origin?.characters?.[i]?.name || "—"}
                      </span>
                      <Input className="!w-28" value={c.name || ""} onChange={(e) => setChar(i, "name", e.target.value)} placeholder="新名" />
                      <Input className="flex-1" value={c.persona || ""} onChange={(e) => setChar(i, "persona", e.target.value)} placeholder="性格/动机" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 人际关系 */}
            {(draftBp.relations || []).length > 0 && (
              <div>
                <div className="text-xs text-ink-secondary mb-1">人际关系 (如 婆媳→姐妹)</div>
                <div className="space-y-2 max-h-40 overflow-auto pr-1">
                  {(draftBp.relations || []).map((rl, i) => (
                    <div key={i} className="flex gap-2 items-center text-xs">
                      <Input className="!w-24" value={rl.a || ""} onChange={(e) => setRel(i, "a", e.target.value)} placeholder="角色A" />
                      <Input className="!w-28" value={rl.relation || ""} onChange={(e) => setRel(i, "relation", e.target.value)} placeholder="关系" />
                      <Input className="!w-24" value={rl.b || ""} onChange={(e) => setRel(i, "b", e.target.value)} placeholder="角色B" />
                      <Input className="flex-1" value={rl.motive || rl.tension || ""} onChange={(e) => setRel(i, "motive", e.target.value)} placeholder="张力/动机" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 情绪曲线 (只读展示, 作为贴合基线) */}
            {(draftBp.emotion_beats || []).length > 0 && (
              <Card padding="sm" className="bg-surface-base">
                <div className="text-xs text-ink-secondary mb-1">情绪曲线节拍 (改编将贴合此骨架)</div>
                <div className="flex flex-wrap gap-1">
                  {(draftBp.emotion_beats || []).map((b, i) => (
                    <Badge key={i} tone="muted" size="sm">{b.stage}:{b.beat}</Badge>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ===== step3 执行 ===== */}
        {step === 3 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {running ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <Check className="w-4 h-4 text-success" />}
              <span>{running ? "正在改编大纲、补场景节拍并逐集生成剧本..."
                : jobStatus === "canceled" ? "改编已取消" : jobStatus === "failed" ? "改编失败" : "改编流程结束"}</span>
            </div>
            {running && (
              <div className="text-xs text-ink-muted">可以关闭这个窗口，改编会在后台继续；重新打开会自动接上进度。</div>
            )}
            {(running || pct > 0) && (
              <div>
                <div className="h-2 bg-surface-base rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-xs text-ink-muted mt-1">{pct}%</div>
              </div>
            )}
            <Card padding="sm" className="bg-surface-base max-h-64 overflow-auto">
              <div className="text-xs font-mono space-y-0.5">
                {logs.length === 0 && <div className="text-ink-muted">等待日志...</div>}
                {logs.map((l, i) => (
                  <div key={i} className="text-ink-secondary">{l}</div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>
    </Modal>
  );
}