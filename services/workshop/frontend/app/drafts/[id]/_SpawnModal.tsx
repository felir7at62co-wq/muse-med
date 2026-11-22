"use client";
import { authFetch } from "../../../lib/auth";
import { notifySuccess, notifyError, confirmAsync } from "@/lib/dialog";
import { useEffect, useRef, useState } from "react";
import { Dna, Sparkles, Loader2, AlertTriangle, Check, Rocket } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { SpawnDnaPanel, type Dna as DnaType } from "./_SpawnDnaPanel";
import { SpawnVariantCard, type Variant } from "./_SpawnVariantCard";
import { ModelSelect } from "@/components/ModelSelect";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Mode = "clone" | "homage" | "inspired";

type SpawnJob = {
  id: number;
  status: string;          // pending|running|preview_ready|done|partial_failed|failed|canceled
  stage: string;           // legacy|preview|expanding|done
  preview_episodes: number;
  mode: Mode;
  count: number;
  total: number;
  finished: number;
  failed: number;
  dna: DnaType;
  variants: Record<string, Variant>;
  error: string;
};

const MODE_META: Record<Mode, { label: string; desc: string }> = {
  clone: {
    label: "近似档",
    desc: "贴近原作框架, 换人物/表层设定, 走量首选",
  },
  homage: {
    label: "同源档（推荐）",
    desc: "保留爆款DNA与情绪节奏, 换全新题材/人物/事件, 每个都是独立新作",
  },
  inspired: {
    label: "灵感档",
    desc: "只借鉴情绪引擎与核心张力, 大胆重编, 看不出改编痕迹",
  },
};

// 模型清单改由后端下发(见 lib/modelCatalog.ts): 三个入口曾各写死一份且互不一致

const ACTIVE = new Set(["pending", "running"]);

/**
 * DNA 裂变工厂 Modal（两段式）:
 *   一句话意图 + 选强度/个数/模型 → 提交后台作业
 *   → ① 先出「故事圣经 + 前 N 集」预览, 停下来等人工确认
 *      (可手改 / 提意见让 AI 重出 / 砍掉不要的方向)
 *   → ② 确认后展开成全 N 集大纲
 *
 * 这样方向不对时只烧了约 1/6 的调用量, 而不是跑满 60 集才发现。
 */
export function SpawnModal({
  draftId,
  open,
  onClose,
  onOpenDraft,
  initialWordTarget = 900,
}: {
  draftId: number;
  open: boolean;
  onClose: () => void;
  onOpenDraft?: (newDraftId: number) => void;
  initialWordTarget?: number;
}) {
  const [intent, setIntent] = useState("");
  const [mode, setMode] = useState<Mode>("homage");
  const [count, setCount] = useState(3);
  const [model, setModel] = useState("gemini");
  const [twoStage, setTwoStage] = useState(true);
  const [previewEps, setPreviewEps] = useState(3);
  const [starting, setStarting] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [spawnWordTarget, setSpawnWordTarget] = useState(initialWordTarget);
  const [job, setJob] = useState<SpawnJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setSpawnWordTarget(initialWordTarget); }, [initialWordTarget]);

  useEffect(() => {
    if (open) {
      setError(null);
      void loadLatest();
    } else {
      stopPoll();
      setJob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 有活跃作业时轮询(preview_ready 是稳定态, 停止轮询以免打断用户编辑)
  useEffect(() => {
    const active = job && ACTIVE.has(job.status);
    if (active && !pollRef.current) {
      pollRef.current = setInterval(() => void refreshJob(job!.id), 3000);
    }
    if (!active) stopPoll();
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.id]);

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // 打开时若已有该原作的最近一次裂变作业, 直接续看
  async function loadLatest() {
    try {
      const r = await authFetch(`${BASE}/v1/spawn?source_draft_id=${draftId}`);
      if (!r.ok) return;
      const d = await r.json();
      const items: SpawnJob[] = d.items || [];
      if (items.length > 0) {
        setJob(items[0]);
        setMode(items[0].mode);
        setCount(items[0].count);
      }
    } catch {
      /* noop */
    }
  }

  async function refreshJob(jobId: number) {
    try {
      const r = await authFetch(`${BASE}/v1/spawn/${jobId}`);
      if (r.ok) {
        const d = await r.json();
        setJob(d.job || null);
      }
    } catch {
      /* noop */
    }
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_draft_id: draftId,
          intent: intent.trim(),
          mode,
          count,
          model,
          word_target: spawnWordTarget,
          two_stage: twoStage,
          preview_episodes: previewEps,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      notifySuccess(`已启动裂变作业 #${d.job_id}`);
      await refreshJob(d.job_id);
    } catch (e: any) {
      setError(e?.message || "启动裂变失败");
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      await authFetch(`${BASE}/v1/spawn/${job.id}/cancel`, { method: "POST" });
      await refreshJob(job.id);
    } catch {
      /* noop */
    }
  }

  // ── 预览确认环节的三个动作 ──────────────────────────────────────────
  async function patchVariant(idx: number, patch: Record<string, any>) {
    if (!job) return;
    try {
      const r = await authFetch(`${BASE}/v1/spawn/${job.id}/variants/${idx}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      notifySuccess("修改已保存, 展开时会作为硬约束");
      await refreshJob(job.id);
    } catch (e: any) {
      notifyError(e?.message || "保存失败");
    }
  }

  async function refineVariant(idx: number, feedback: string) {
    if (!job) return;
    try {
      const r = await authFetch(`${BASE}/v1/spawn/${job.id}/variants/${idx}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      notifySuccess("已按你的意见重出预览");
      await refreshJob(job.id);
    } catch (e: any) {
      notifyError(e?.message || "重出失败");
    }
  }

  async function dropVariant(idx: number) {
    if (!job) return;
    const ok = await confirmAsync("确定弃用这个方向? 它的预览草稿会被删除, 不会展开成全集。");
    if (!ok) return;
    try {
      const r = await authFetch(`${BASE}/v1/spawn/${job.id}/variants/${idx}/drop`, {
        method: "POST",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refreshJob(job.id);
    } catch (e: any) {
      notifyError(e?.message || "弃用失败");
    }
  }

  async function expandAll() {
    if (!job) return;
    setExpanding(true);
    try {
      const r = await authFetch(`${BASE}/v1/spawn/${job.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      notifySuccess(`已开始展开 ${(d.expanding || []).length} 个方向`);
      await refreshJob(job.id);
    } catch (e: any) {
      notifyError(e?.message || "展开失败");
    } finally {
      setExpanding(false);
    }
  }

  function resetToForm() {
    stopPoll();
    setJob(null);
  }

  const isActive = job && ACTIVE.has(job.status);
  const variants: Variant[] = job
    ? Object.values(job.variants || {}).sort((a, b) => a.idx - b.idx)
    : [];
  const dna = job?.dna || {};
  const pendingCount = variants.filter((v) => v.status === "待确认").length;
  const isPreviewStage = job?.status === "preview_ready" && pendingCount > 0;
  // 展开后的目标集数(预览阶段 episode_count 存的就是目标全集数)
  const targetEps = variants.find((v) => v.episode_count)?.episode_count || 0;

  const footer = (
    <div className="flex items-center justify-between gap-2 w-full">
      <div className="text-xs text-ink-muted">
        {job
          ? `作业 #${job.id} · ${job.status} · ${job.finished}/${job.total} 完成`
          : "从原作提取「爆款DNA」, 批量裂变出多个各具新意的新作"}
      </div>
      <div className="flex gap-2">
        {isActive && (
          <Button variant="danger" size="sm" onClick={cancel}>
            取消
          </Button>
        )}
        {isPreviewStage && (
          <Button
            variant="primary"
            size="sm"
            loading={expanding}
            leftIcon={!expanding ? <Rocket className="w-4 h-4" /> : undefined}
            onClick={expandAll}
          >
            确认这 {pendingCount} 个方向, 展开全 {targetEps} 集
          </Button>
        )}
        {job && !isActive && !isPreviewStage && (
          <Button variant="secondary" size="sm" onClick={resetToForm}>
            再裂变一批
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Dna className="w-5 h-5 text-primary" />
          DNA 裂变工厂
          <span className="ml-2 text-xs text-ink-muted">
            一部好作品 → 一批同基因的新作
          </span>
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

        {/* ===== 配置表单(无作业, 或点了"再裂变一批") ===== */}
        {!job && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-ink-secondary mb-1">
                创作意图 (可选)
              </label>
              <Textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={2}
                placeholder="一句话说清你想要的方向, 如: 都要更虐的版本 / 换成古装宅斗 / 主角复仇线更强。留空则由 AI 自由发散。"
              />
            </div>

            <div>
              <div className="text-xs text-ink-secondary mb-1.5">裂变强度</div>
              <div className="grid grid-cols-3 gap-2">
                {(Object.keys(MODE_META) as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`text-left rounded-lg border p-2.5 transition ${
                      mode === m
                        ? "border-primary bg-primary/10"
                        : "border-line hover:border-line-strong bg-surface-base"
                    }`}
                  >
                    <div className="text-sm font-medium text-ink-primary flex items-center gap-1">
                      {mode === m && <Check className="w-3.5 h-3.5 text-primary" />}
                      {MODE_META[m].label}
                    </div>
                    <div className="text-[11px] text-ink-muted mt-1 leading-snug">
                      {MODE_META[m].desc}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* 两段式开关 */}
            <div className="px-3 py-2.5 bg-surface-raised rounded-lg border border-line space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={twoStage}
                  onChange={(e) => setTwoStage(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-sm text-ink-primary">先看前几集再决定（推荐）</span>
                  <span className="block text-[11px] text-ink-muted leading-relaxed mt-0.5">
                    先只生成「故事圣经 + 前 N 集」供你确认和修改, 满意后再展开全集。
                    方向不对时只花约六分之一的生成量, 而不是跑满全剧才发现。
                  </span>
                </span>
              </label>
              {twoStage && (
                <div className="flex items-center gap-2 pl-6">
                  <label className="text-xs text-ink-secondary">预览集数</label>
                  <select
                    value={previewEps}
                    onChange={(e) => setPreviewEps(Number(e.target.value))}
                    className="bg-surface-base border border-line rounded px-2 py-1 text-sm"
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>{n} 集</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs text-ink-secondary">裂变个数</label>
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="bg-surface-base border border-line rounded px-2 py-1 text-sm"
                >
                  {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} 个
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <ModelSelect
                  value={model}
                  onChange={setModel}
                  label="模型"
                  compact
                  showHint={false}
                />
              </div>
              <div className="px-4 py-3 bg-surface-raised rounded-lg border border-line w-full">
                <div className="flex items-center gap-3 flex-wrap text-sm">
                  <span className="text-ink-secondary">📏裂变新作每章字数:</span>
                  <span className="px-2.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">{spawnWordTarget.toLocaleString()} 字</span>
                <div className="flex gap-1flex-wrap">
                    {([{l:"短篇",v:3000},{l:"标准",v:5000},{l:"中长",v:7000},{l:"长篇",v:10000}] as {l:string,v:number}[]).map(p => (
                      <button key={p.v} type="button" onClick={() => setSpawnWordTarget(p.v)}
                        className={["px-2 py-0.5 rounded text-xs transition", spawnWordTarget===p.v?"bg-primary text-white":"bg-surface-overlay hover:bg-surface-base text-ink-secondary border border-line"].join(" ")}>
                        {p.l}
                      </button>
                    ))}
                  </div>
<input type="number" min={500} max={20000} step={500} value={spawnWordTarget}
                    onChange={(e) => { const n=parseInt(e.target.value); if(!isNaN(n)&&n>=500) setSpawnWordTarget(n); }}
                    className="w-20 px-2 py-0.5 bg-surface-overlay border border-line rounded text-xs text-ink-primary"
                  />
                <span className="text-xs text-ink-muted">字</span>
                </div>
              </div>
              <Button
                variant="primary"
                className="ml-auto"
                loading={starting}
                leftIcon={!starting ? <Sparkles className="w-4 h-4" /> : undefined}
                onClick={start}
              >
                {starting
                  ? "启动中..."
                  : twoStage
                    ? `先出 ${count} 个方向的前 ${previewEps} 集`
                    : `裂变出 ${count} 个新作`}
              </Button>
            </div>

            <div className="text-[11px] text-ink-muted leading-relaxed border-t border-line pt-3">
              💡 裂变会先提炼原作「为什么好看」的爆款DNA(爽点公式/情绪节奏/关系张力),
              再据此重新创作出多个题材/人物/事件各不相同、但爽感一致的完整新大纲。
              原作不受任何影响。每个满意的新作可继续走「生成正文/剧本」扩成全本。
            </div>
          </div>
        )}

        {/* ===== 作业进行/结果 ===== */}
        {job && (
          <div className="space-y-4">
            {/* DNA 全字段面板 */}
            <SpawnDnaPanel dna={dna} />

            {/* 进度条 */}
            {isActive && (
              <div className="flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-sm text-ink-secondary">
                  {job.stage === "expanding"
                    ? `正在展开全集... ${job.finished}/${job.total}`
                    : job.stage === "preview"
                      ? `正在生成前 ${job.preview_episodes} 集预览... ${job.finished}/${job.total}`
                      : `正在裂变... ${job.finished}/${job.total} 完成`}
                </span>
                <div className="flex-1 h-1.5 bg-surface-base rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${job.total ? (job.finished / job.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* 预览确认引导 */}
            {isPreviewStage && (
              <div className="bg-warning/10 border border-warning/40 rounded-lg p-3 text-xs text-ink-secondary leading-relaxed">
                <span className="font-medium text-warning">
                  {pendingCount} 个方向的前 {job.preview_episodes} 集已就绪, 等你拍板。
                </span>
                <br />
                逐个看下去 —— 可以直接手改标题/主线/前几集, 也可以写一句意见让 AI 重出,
                方向不对就点「不要这个方向」。确认后点右下角展开成全 {targetEps} 集,
                你的所有修改都会成为后续每一集的硬约束。
              </div>
            )}

            {job.status === "failed" && (
              <div className="text-sm text-danger">
                裂变失败: {job.error || "未知错误"}
              </div>
            )}

            {/* 裂变结果卡片 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {variants.map((v) => (
                <SpawnVariantCard
                  key={v.idx}
                  v={v}
                  targetEpisodes={v.episode_count || targetEps}
                  onPatch={patchVariant}
                  onRefine={refineVariant}
                  onDrop={dropVariant}
                  onOpenDraft={onOpenDraft}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}