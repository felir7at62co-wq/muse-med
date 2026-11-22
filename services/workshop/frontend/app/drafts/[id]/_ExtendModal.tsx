"use client";
import { authFetch } from "../../../lib/auth";
import { confirmAsync, notify, notifyError, notifySuccess } from "@/lib/dialog";
import { useEffect, useState } from "react";
import { Rocket, AlertTriangle, Undo2, Save } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ModelSelect } from "@/components/ModelSelect";
import { phase5ExtendCfg } from "@/lib/phase5";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type ExtendMeta = {
  draft_id: number;
  title: string;
  current_episode_count: number;
  locked_chapter_count: number;
  total_chars: number;
  detected_level: "L1" | "L2" | "L3";
  chapter_word_target: number;
  extensions: Array<{
    task_id: string;
    from_episode: number;
    to_episode: number;
    level: string;
    started_at: string;
    finished_at?: string;
    rolled_back_at?: string;
  }>;
};

const LEVEL_DESC: Record<string, string> = {
  L1: "L1 全文档 — 把已有正文完整喂给模型，效果最佳",
  L2: "L2 摘要档 — 每集摘要 + 最近 3 集完整正文",
  L3: "L3 高度压缩档 — 时间线 + 最近 2 集 + 人物状态卡",
};

// 集纲拆分后的单集条目(可手动调整)
type EpisodeOutlineItem = {
  order: number;
  title: string;
  synopsis: string;
};

/**
 * 续写 Modal — Phase 3 Week 4 重做版,接入 UI Kit (Modal / Card / Button / Input / Select / Textarea / Badge)。
 * 业务逻辑全部保留:加载续写元信息、目标集数/每章字数/模型/引导/高级、回滚最近一次续写。
 */
export function ExtendModal({
  draftId,
  open,
  onClose,
  onStarted,
}: {
  draftId: number;
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [meta, setMeta] = useState<ExtendMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 表单
  const [target, setTarget] = useState<number>(0);
  const [chunkSize, setChunkSize] = useState<number>(20);
  const [provider, setProvider] = useState<"gemini" | "deepseek" | "gpt5">("gemini");
  const [forcedLevel, setForcedLevel] = useState<"" | "L1" | "L2" | "L3">("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [wordTarget, setWordTarget] = useState<number>(5000);
  const [userGuidance, setUserGuidance] = useState<string>("");

  // 集纲(用户自备逐集大纲, 可选): 粘贴文本 → 后端拆分预览 → 手动调整 → 随续写提交
  const [epOutlineOpen, setEpOutlineOpen] = useState(false);
  const [epOutlineText, setEpOutlineText] = useState<string>("");
  const [epSplitting, setEpSplitting] = useState(false);
  const [epEpisodes, setEpEpisodes] = useState<EpisodeOutlineItem[]>([]);
  const [epSplitMode, setEpSplitMode] = useState<string>("");

  // 回滚
  const [rollbackBusy, setRollbackBusy] = useState(false);
  // 偏好持久化
  const [cfgSaving, setCfgSaving] = useState(false);

  async function loadMeta() {
    setLoading(true);
    setError(null);
    try {
      // 并发拉 meta + extend-config 用户偏好
      const [r, cfg] = await Promise.all([
        authFetch(`${BASE}/v1/stages/drafts/${draftId}/extend/meta`),
        phase5ExtendCfg.get(draftId).catch(() => null),
      ]);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data: ExtendMeta = await r.json();
      setMeta(data);

      // 用户偏好优先于自动默认值
      if (cfg) {
        const cfgTarget = cfg.default_target_episodes && cfg.default_target_episodes > data.locked_chapter_count
          ? cfg.default_target_episodes
          : Math.max(data.locked_chapter_count + 10, data.current_episode_count + 10);
        setTarget(cfgTarget);
        setChunkSize(cfg.default_chunk_size || 20);
        setWordTarget(cfg.default_word_target || data.chapter_word_target || 5000);
        setProvider(
          cfg.default_provider === "deepseek"
            ? "deepseek"
            : cfg.default_provider === "gpt5"
              ? "gpt5"
              : "gemini"
        );
        setForcedLevel((cfg.forced_level as any) || "");
        setUserGuidance(cfg.user_guidance_template || "");
      } else {
        const defaultTarget = Math.max(data.locked_chapter_count + 10, data.current_episode_count + 10);
        setTarget(defaultTarget);
        setWordTarget(data.chapter_word_target || 5000);
      }
    } catch (e: any) {
      setError(e.message || "加载续写信息失败");
    } finally {
      setLoading(false);
    }
  }

  /** 把当前表单作为偏好持久化, 下次打开自动填充 */
  async function saveAsDefault() {
    setCfgSaving(true);
    try {
      await phase5ExtendCfg.set(draftId, {
        default_target_episodes: target,
        default_chunk_size: chunkSize,
        default_word_target: wordTarget,
        default_provider: provider,
        forced_level: forcedLevel || null,
        user_guidance_template: userGuidance,
      });
      notifySuccess("已保存为该草稿的默认续写偏好");
    } catch (e: any) {
      notifyError("保存失败: " + (e?.message || "未知"));
    } finally {
      setCfgSaving(false);
    }
  }

  useEffect(() => {
    if (open) loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSubmit() {
    if (!meta) return;
    if (target <= meta.locked_chapter_count) {
      setError(`目标集数必须大于当前已有的 ${meta.locked_chapter_count} 集`);
      return;
    }
    if (wordTarget < 1 || wordTarget > 20000) {
      setError("每章字数必须在 1 ~ 20000 之间");
      return;
    }
    // 集纲校验: 有粘贴文本但没成功拆分 → 提醒先预览拆分(避免用户以为集纲已生效)
    if (epOutlineText.trim() && epEpisodes.length === 0) {
      setError("已粘贴集纲但尚未拆分, 请先点「预览拆分」并确认结果 (或清空集纲文本)");
      return;
    }
    const epPayload = epEpisodes
      .filter((e) => e.synopsis.trim())
      .map((e) => ({ order: e.order, title: e.title.trim().slice(0, 60), synopsis: e.synopsis.trim() }));
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/extend/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_episode_count: target,
          chunk_size: chunkSize,
          word_target: wordTarget,
          model_provider: provider,
          forced_level: forcedLevel || null,
          user_guidance: userGuidance.trim(),
          episode_outline: epPayload.length > 0 ? epPayload : null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      notifySuccess("续写任务已启动");
      onStarted();
      onClose();
    } catch (e: any) {
      setError(e.message || "启动失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRollback() {
    if (!meta) return;
    if (!(await confirmAsync({
      title: "回滚最近一次续写",
      description: `这将删除续写产生的章节，恢复到第 ${meta.locked_chapter_count} 集之前的状态`,
      tone: "danger",
      confirmText: "回滚"
    }))) return;
    setRollbackBusy(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/extend/rollback`, { method: "POST" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      notifySuccess(`回滚完成,删除了 ${data.deleted_chapters} 集,恢复到 ${data.restored_episode_count} 集`);
      onStarted();
      onClose();
    } catch (e: any) {
      setError(e.message || "回滚失败");
      notifyError(e.message || "回滚失败");
    } finally {
      setRollbackBusy(false);
    }
  }

  const newCount = meta ? Math.max(0, target - meta.locked_chapter_count) : 0;
  const estMinutes = newCount * 2;
  const hasBackup = !!(meta?.extensions || []).find(e => !e.rolled_back_at);

  // ===== 集纲: 拆分预览 + 手动调整 =====
  async function splitEpisodeOutline() {
    const text = epOutlineText.trim();
    if (!text) return;
    setEpSplitting(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/extend/episode-outline/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const eps: EpisodeOutlineItem[] = (data.episodes || []).map((e: any) => ({
        order: e.order, title: e.title || "", synopsis: e.synopsis || "",
      }));
      setEpEpisodes(eps);
      setEpSplitMode(data.mode || "none");
      if (eps.length === 0) {
        notifyError("未识别到分集标注 (需要\"第N集/第1集/一、/1、\"等格式且至少 2 集), 请检查文本格式");
      } else {
        notifySuccess(`拆分出 ${eps.length} 集 (第 ${eps[0].order}~${eps[eps.length - 1].order} 集), 请检查确认`);
      }
    } catch (e: any) {
      notifyError("拆分失败: " + (e?.message || "未知"));
    } finally {
      setEpSplitting(false);
    }
  }

  function updateEpisode(idx: number, patch: Partial<EpisodeOutlineItem>) {
    setEpEpisodes((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }

  function removeEpisode(idx: number) {
    setEpEpisodes((prev) => prev.filter((_, i) => i !== idx));
  }

  // 与上一集合并(拆错时用): 内容并入上一集, 本集删除
  function mergeEpisodeUp(idx: number) {
    setEpEpisodes((prev) => {
      if (idx <= 0) return prev;
      const next = [...prev];
      next[idx - 1] = {
        ...next[idx - 1],
        synopsis: `${next[idx - 1].synopsis}\n${next[idx].title ? next[idx].title + " " : ""}${next[idx].synopsis}`.trim(),
      };
      next.splice(idx, 1);
      return next;
    });
  }

  function clearEpisodeOutline() {
    setEpOutlineText("");
    setEpEpisodes([]);
    setEpSplitMode("");
  }

  // 集纲覆盖统计 (相对已锁定集数与目标集数)
  const lockedCount = meta?.locked_chapter_count ?? 0;
  const epValid = epEpisodes.filter((e) => e.order > lockedCount && e.order <= target && e.synopsis.trim());
  const epIgnored = epEpisodes.length - epValid.length;
  const epCoveredOrders = new Set(epValid.map((e) => e.order));
  const gapOrders: number[] = [];
  for (let o = lockedCount + 1; o <= target; o++) if (!epCoveredOrders.has(o)) gapOrders.push(o);
  // 空缺集数的连续段描述 (如 "21~25, 28")
  const gapDesc = (() => {
    const segs: string[] = [];
    let s = -1, p = -1;
    for (const o of gapOrders) {
      if (s < 0) { s = o; p = o; continue; }
      if (o === p + 1) { p = o; continue; }
      segs.push(s === p ? `${s}` : `${s}~${p}`);
      s = o; p = o;
    }
    if (s >= 0) segs.push(s === p ? `${s}` : `${s}~${p}`);
    return segs.join(", ");
  })();

  const footer = meta && !loading ? (
    <div className="flex items-center justify-between gap-2 w-full">
      {hasBackup ? (
        <Button
          variant="ghost"
          size="sm"
          loading={rollbackBusy}
          leftIcon={!rollbackBusy ? <Undo2 className="w-4 h-4" /> : undefined}
          onClick={handleRollback}
          className="text-warning hover:text-warning"
          title="删除最近一次续写产生的章节, 回到上一次续写之前的状态"
        >
          {rollbackBusy ? "回滚中..." : "回滚上次续写"}
        </Button>
      ) : <span />}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="md"
          loading={cfgSaving}
          disabled={submitting}
          leftIcon={!cfgSaving ? <Save className="w-4 h-4" /> : undefined}
          onClick={saveAsDefault}
          title="把当前选项保存为该草稿默认续写偏好, 下次打开 Modal 自动填充"
        >
          存为默认
        </Button>
        <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>取消</Button>
        <Button
          variant="primary"
          size="md"
          loading={submitting}
          disabled={newCount <= 0}
          leftIcon={!submitting ? <Rocket className="w-4 h-4" /> : undefined}
          onClick={handleSubmit}
        >
          {submitting ? "启动中..." : `开始续写 ${newCount} 集`}
        </Button>
      </div>
    </div>
  ) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-primary" />
          续写剧本
        </span>
      }
      size="lg"
      footer={footer}
    >
      <div className="space-y-4">
        {loading && (
          <div className="flex items-center gap-2 text-ink-secondary text-sm">
            <Spinner size="sm" /> 加载续写信息...
          </div>
        )}

        {error && (
          <div className="bg-danger/10 border border-danger/40 rounded-lg p-3 text-sm text-danger flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {meta && !loading && (
          <>
            {/* 当前状态 */}
            <Card padding="md" className="bg-surface-base">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-secondary">当前已写就:</span>
                  <span><b>{meta.locked_chapter_count}</b> 集 · {meta.total_chars.toLocaleString()} 字</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-secondary">大纲集数:</span>
                  <span>{meta.current_episode_count}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-ink-secondary">系统检测档位:</span>
                  <Badge tone="info" size="sm">{meta.detected_level}</Badge>
                </div>
                <div className="text-xs text-ink-muted pt-1">{LEVEL_DESC[meta.detected_level]}</div>
              </div>
            </Card>

            {/* 目标集数 */}
            <div>
              <label className="block text-sm text-ink-primary mb-1">目标总集数</label>
              <Input
                type="number"
                value={target}
                onChange={(e) => setTarget(parseInt(e.target.value) || 0)}
                min={meta.locked_chapter_count + 1}
                max={500}
              />
              <div className="text-xs text-ink-muted mt-1">
                将续写 <b className="text-primary">{newCount}</b> 集 (从第 {meta.locked_chapter_count + 1} 集到第 {target} 集)
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {[
                  meta.locked_chapter_count + 10,
                  meta.locked_chapter_count + 30,
                  meta.locked_chapter_count + 50,
                  100,
                  200,
                ]
                  .filter((v, i, arr) => v > meta.locked_chapter_count && arr.indexOf(v) === i)
                  .map((v) => (
                    <Button
                      key={v}
                      variant={target === v ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => setTarget(v)}
                    >
                      {v} 集
                    </Button>
                  ))}
              </div>
            </div>

            {/* 每章字数 */}
            <div>
              <label className="block text-sm text-ink-primary mb-1">
                每章目标字数
                <span className="ml-2 text-xs text-ink-muted">
                  (草稿当前 {meta.chapter_word_target.toLocaleString()} 字; 修改会持久化到草稿)
                </span>
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  type="number"
                  className="!w-32"
                  value={wordTarget || ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") { setWordTarget(0); return; }
                    const n = parseInt(raw);
                    if (!Number.isNaN(n)) setWordTarget(n);
                  }}
                  onBlur={() => {
                    if (!wordTarget) setWordTarget(meta?.chapter_word_target || 5000);
                  }}
                  min={1}
                  max={20000}
                  step={500}
                />
                <span className="text-xs text-ink-muted">字 / 集</span>
                <div className="flex gap-1 ml-1">
                  {[
                    { label: "短篇", v: 3000 },
                    { label: "标准", v: 1500 },
                    { label: "中长", v: 7000 },
                    { label: "长篇", v: 10000 },
                  ].map((p) => (
                    <Button
                      key={p.v}
                      type="button"
                      size="sm"
                      variant={wordTarget === p.v ? "primary" : "secondary"}
                      onClick={() => setWordTarget(p.v)}
                    >
                      {p.label} {p.v}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="text-xs text-ink-muted mt-1">
                生成时允许浮动 ±20% (实际范围 {Math.floor(wordTarget * 0.8).toLocaleString()} ~ {Math.floor(wordTarget * 1.2).toLocaleString()})
              </div>
            </div>

            {/* 模型 */}
            <div>
              <label className="block text-sm text-ink-primary mb-1">模型</label>
              <ModelSelect
                value={provider}
                onChange={(v) => setProvider(v as any)}
                label={null}
                className="w-full"
              />
            </div>

            {/* 集纲 (用户自备逐集大纲, 可选) */}
            <div>
              <button
                type="button"
                onClick={() => setEpOutlineOpen((v) => !v)}
                className="text-sm text-ink-primary hover:text-primary transition flex items-center gap-1.5"
              >
                {epOutlineOpen ? "▾" : "▸"} 集纲 (我自己写好的分集大纲)
                <span className="text-xs text-ink-muted">可选</span>
                {epValid.length > 0 && (
                  <Badge tone="success" size="sm">已采用 {epValid.length} 集</Badge>
                )}
              </button>
              {epOutlineOpen && (
                <div className="mt-2 space-y-2 pl-4 border-l-2 border-line">
                  <div className="text-xs text-ink-muted">
                    粘贴你写好的分集大纲, 用 <b>第N集 / 第1集 / 一、 / 1、</b> 等标注分集
                    (与导入剧本的识别方式相同)。这些集的大纲将<b className="text-primary">直接采用</b>,
                    不再让模型生成; 模型只补写没有集纲的空缺集数。
                  </div>
                  <Textarea
                    value={epOutlineText}
                    onChange={(e) => setEpOutlineText(e.target.value)}
                    rows={6}
                    maxLength={500000}
                    placeholder={
                      "示例:\n\n第11集 危机初现\n林晚发现丈夫深夜外出, 跟踪至码头, 目睹他与神秘人交易...\n\n第12集 身份之谜\n林晚拿到交易照片, 却被丈夫反将一军...\n\n(也支持 \"一、\" \"1、\" \"1.\" 等序号格式)"
                    }
                    className="font-mono leading-relaxed text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button" size="sm" variant="primary"
                      loading={epSplitting}
                      disabled={!epOutlineText.trim()}
                      onClick={splitEpisodeOutline}
                    >
                      {epSplitting ? "拆分中..." : epEpisodes.length > 0 ? "重新拆分" : "预览拆分"}
                    </Button>
                    {(epOutlineText || epEpisodes.length > 0) && (
                      <Button type="button" size="sm" variant="ghost" onClick={clearEpisodeOutline}
                        className="text-danger hover:text-danger">清空集纲</Button>
                    )}
                    <span className="text-xs text-ink-muted">{epOutlineText.length.toLocaleString()} / 500000</span>
                  </div>

                  {/* 拆分结果预览 + 手动调整 */}
                  {epEpisodes.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-xs text-ink-secondary">
                        拆分结果 ({epEpisodes.length} 集) — 可修改集号/标题/内容, 拆错可「并入上一集」:
                      </div>
                      <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                        {epEpisodes.map((e, i) => {
                          const outOfRange = e.order <= lockedCount || e.order > target;
                          return (
                            <div key={i} className={`border rounded-lg p-2 text-xs space-y-1 ${outOfRange ? "border-warning/50 bg-warning/5" : "border-line bg-surface-base"}`}>
                              <div className="flex items-center gap-1.5">
                                <span className="text-ink-muted shrink-0">第</span>
                                <Input
                                  type="number" className="!w-16 !py-0.5 !text-xs"
                                  value={e.order}
                                  onChange={(ev) => updateEpisode(i, { order: parseInt(ev.target.value) || 0 })}
                                  min={1} max={500}
                                />
                                <span className="text-ink-muted shrink-0">集</span>
                                <Input
                                  className="flex-1 !py-0.5 !text-xs"
                                  value={e.title}
                                  placeholder="本集标题(可空)"
                                  maxLength={60}
                                  onChange={(ev) => updateEpisode(i, { title: ev.target.value })}
                                />
                                {i > 0 && (
                                  <Button type="button" size="sm" variant="ghost" onClick={() => mergeEpisodeUp(i)}
                                    title="拆错了: 把本集内容并入上一集">并入上集</Button>
                                )}
                                <Button type="button" size="sm" variant="ghost" onClick={() => removeEpisode(i)}
                                  className="text-danger hover:text-danger" title="删除本集">✕</Button>
                              </div>
                              <Textarea
                                value={e.synopsis}
                                onChange={(ev) => updateEpisode(i, { synopsis: ev.target.value })}
                                rows={2}
                                className="!text-xs leading-relaxed"
                              />
                              {outOfRange && (
                                <div className="text-warning">
                                  ⚠ {e.order <= lockedCount
                                    ? `第 ${e.order} 集已有正文(前 ${lockedCount} 集已锁定), 该条将被忽略`
                                    : `第 ${e.order} 集超出目标 ${target} 集, 该条将被忽略 (可调大目标集数)`}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* 覆盖情况摘要 */}
                      <div className="bg-primary/5 border border-primary/30 rounded-lg p-2 text-xs space-y-0.5">
                        <div>
                          ✅ 集纲直接采用: <b className="text-primary">{epValid.length}</b> 集
                          {epValid.length > 0 && ` (第 ${Math.min(...epValid.map(e => e.order))}~${Math.max(...epValid.map(e => e.order))} 集, 不调用模型生成大纲)`}
                          {epIgnored > 0 && <span className="text-warning"> · {epIgnored} 条被忽略</span>}
                        </div>
                        <div>
                          {gapOrders.length > 0
                            ? <>🤖 模型补写空缺大纲: <b>{gapOrders.length}</b> 集 (第 {gapDesc} 集{userGuidance.trim() ? ", 受剧情走向引导约束" : ""})</>
                            : <>🎉 集纲已覆盖全部续写集数, 无需模型生成大纲</>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 剧情走向引导 */}
            <div>
              <label className="block text-sm text-ink-primary mb-1">
                剧情走向引导
                <span className="ml-2 text-xs text-ink-muted">
                  (可选, 会作为硬约束传给模型{epValid.length > 0 ? "; 已提供集纲时只引导没有集纲的空缺集数" : ""})
                </span>
              </label>
              <Textarea
                value={userGuidance}
                onChange={(e) => setUserGuidance(e.target.value)}
                rows={5}
                maxLength={200000}
                placeholder={
                  "用自然语言描述你希望续写部分怎么发展, 例如:\n\n" +
                  "· 第 11~20 集主角和女二误会激化, 第 20 集出现身世反转\n" +
                  "· 第 21~30 集引入'神秘组织 X'对抗反派, 男主短暂失忆\n" +
                  "· 整体风格: 情感节奏紧凑, 每 5 集来一次爽感反击\n" +
                  "· 结局: 不要悲剧, 主角和女主在最后一集同框收束\n\n" +
                  "留空则按短剧标准节奏自由发挥。"
                }
                className="font-mono leading-relaxed"
              />
              <div className="flex items-center justify-between mt-1">
                <div className="text-xs text-ink-muted">
                  {userGuidance.length === 0
                    ? "未填写时, 模型按短剧标准节奏自由发挥"
                    : "已填写, 模型会优先满足上述走向"}
                </div>
                <div className={`text-xs ${userGuidance.length > 180000 ? "text-warning" : "text-ink-muted"}`}>
                  {userGuidance.length} / 200000
                </div>
              </div>

              {/* 预设模板 */}
              <div className="mt-2 flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setUserGuidance(
                    "整体走向:\n· 中段引入新对手, 主角短暂受挫但绝地反击\n· 每 5 集一次中等冲突, 每 10 集一次大转折\n· 第 " + (meta.locked_chapter_count + 1) + "~" + Math.min(target, meta.locked_chapter_count + 20) + " 集: 推进感情线\n· 最后 5 集: 收束所有伏笔, 主角达成最终目标\n· 结局类型: 圆满收束, 主角阵营全员存活"
                  )}
                >📋 圆满收束模板</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setUserGuidance(
                    "整体走向:\n· 引入新反派势力, 加大主线压力\n· 每集都要有明显的'爽感'反击\n· 中段(约一半位置)出现关键反转\n· 主角逐步揭露身世/异能/秘密身份\n· 最后高潮: 主角以智取胜或绝境翻盘"
                  )}
                >📋 爽感反转模板</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setUserGuidance(
                    "整体走向:\n· 主角与男/女主感情步步推进, 中段经历重大误会\n· 引入第三者(竞争者), 制造情感张力\n· 每 3 集一次甜蜜节点, 每 7 集一次心碎节点\n· 最后 5 集: 误会化解, 双方表白, 共同面对外部反派\n· 结局: HE, 但留一个伏笔为后续做钩子"
                  )}
                >📋 感情主线模板</Button>
                {userGuidance && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setUserGuidance("")}
                    className="text-danger hover:text-danger"
                  >清空</Button>
                )}
              </div>
            </div>

            {/* 高级 */}
            <div>
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="text-sm text-ink-secondary hover:text-ink-primary transition"
              >
                {advancedOpen ? "▾" : "▸"} 高级选项
              </button>
              {advancedOpen && (
                <div className="mt-2 space-y-3 pl-4 border-l-2 border-line">
                  <div>
                    <label className="block text-xs text-ink-secondary mb-1">大纲分批大小 (每批扩写多少集)</label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        className="!w-32"
                        value={chunkSize}
                        onChange={(e) => setChunkSize(parseInt(e.target.value) || 20)}
                        min={5}
                        max={50}
                      />
                      <span className="text-xs text-ink-muted">推荐 15-25, 太大可能出现"中段失忆"</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-ink-secondary mb-1">强制档位 (留空 = 自动检测)</label>
                    <Select
                      className="!w-40"
                      value={forcedLevel}
                      onChange={(e) => setForcedLevel(e.target.value as any)}
                    >
                      <option value="">自动</option>
                      <option value="L1">L1 (全文档)</option>
                      <option value="L2">L2 (摘要档)</option>
                      <option value="L3">L3 (高度压缩)</option>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-warning/10 border border-warning/40 rounded-lg p-3 text-xs text-warning flex gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div>前 {meta.locked_chapter_count} 集将被锁定, 续写过程中不会被修改。</div>
                <div className="mt-1">预估耗时: 约 {estMinutes} 分钟 (取决于模型响应速度)</div>
              </div>
            </div>

            {/* 历史 */}
            {meta.extensions.length > 0 && (
              <Card padding="sm" className="bg-surface-base">
                <div className="text-xs">
                  <div className="text-ink-secondary mb-1">续写历史:</div>
                  <div className="space-y-0.5">
                    {meta.extensions.slice(-3).map((ext, i) => (
                      <div key={i} className="text-ink-muted flex items-center gap-2">
                        <span>第 {ext.from_episode} → {ext.to_episode} 集</span>
                        <Badge tone="muted" size="sm">{ext.level}</Badge>
                        {ext.rolled_back_at && <Badge tone="warning" size="sm">已回滚</Badge>}
                        {ext.finished_at && !ext.rolled_back_at && <Badge tone="success" size="sm">已完成</Badge>}
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
