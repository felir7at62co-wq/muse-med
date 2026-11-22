"use client";
import { authFetch } from "../../../lib/auth";
import { confirmAsync, notifyError } from "@/lib/dialog";
import { useEffect, useMemo, useState } from "react";
import {
  Sparkles, Wand2, RefreshCw, Copy, Check,
  Download, ChevronDown, ChevronUp, Trash2, Pencil, X, Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ShotPromptCard } from "@/components/charts/ShotPromptCard";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { FormField } from "@/components/ui/FormField";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

// ---------- types ----------
type Tpl = {
  id: number;
  key: string;
  label: string;
  kind: "video" | "image";
  provider?: string;
  duration_min: number;
  duration_max: number;
  duration_default: number;
  aspect_ratio?: string;
  notes?: string;
};

type Prompt = {
  id: number;
  chapter_order: number;
  task_index: number;
  duration_s: number;
  source_shot_nos: number[];
  summary?: string;
  video_template_key?: string;
  video_prompt?: string;
  image_template_key?: string;
  image_prompt?: string;
  status: string;
  user_edited: boolean;
  created_at?: string;
  updated_at?: string;
};

/**
 * 视频提示词面板 — Phase 3 重做版,接入 UI Kit (Card / Button / Badge / Input / Textarea / Select / FormField / Spinner / EmptyState)。
 *
 * 后端: /v1/prompt-templates 模板列表 / /v1/drafts/{id}/prompts 任务列表
 *       /v1/drafts/{id}/prompts/plan 规划 / .../render 渲染 / .../{pid}/regenerate 重生 / .../export 导出
 *
 * 工作流:
 *   1) 选视频 + 首帧模板 + 范围 → 点 "规划任务" 触发 LLM 把分镜分组成 N 段视频任务
 *   2) 点 "渲染 prompt" 对每段任务渲染最终 prompt
 *   3) 用户可对单段卡片编辑 / 重生 / 复制 / 删除
 *   4) 全部导出 txt/csv/json
 */
export function VideoPromptsPanel({ draftId }: { draftId: number }) {
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [items, setItems] = useState<Prompt[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);

  const [videoKey, setVideoKey] = useState<string>("");
  const [imageKey, setImageKey] = useState<string>("");
  const [scope, setScope] = useState<"all" | "single">("all");
  const [scopeChapter, setScopeChapter] = useState<number>(1);

  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "plan" | "render">("");
  const [collapsedChapters, setCollapsedChapters] = useState<Set<number>>(new Set());
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const videoTpls = tpls.filter((t) => t.kind === "video");
  const imageTpls = tpls.filter((t) => t.kind === "image");

  // chapters in items
  const chapters = useMemo(() => {
    const set = new Set<number>();
    items.forEach((it) => set.add(it.chapter_order));
    return Array.from(set).sort((a, b) => a - b);
  }, [items]);

  const itemsByChapter = useMemo(() => {
    const m = new Map<number, Prompt[]>();
    for (const it of items) {
      if (!m.has(it.chapter_order)) m.set(it.chapter_order, []);
      m.get(it.chapter_order)!.push(it);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.task_index - b.task_index);
    return m;
  }, [items]);

  useEffect(() => {
    loadTemplates();
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // 跑任务时轮询
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => loadItems(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  async function loadTemplates() {
    try {
      const r = await authFetch(`${BASE}/v1/prompt-templates`);
      const d = await r.json();
      const all: Tpl[] = d.items || [];
      setTpls(all);
      if (!videoKey && all.find((t) => t.kind === "video")) {
        setVideoKey(all.find((t) => t.kind === "video")!.key);
      }
      if (!imageKey && all.find((t) => t.kind === "image")) {
        setImageKey(all.find((t) => t.kind === "image")!.key);
      }
    } catch (e) {
      pushLog(`模板加载失败: ${e}`);
    }
  }

  async function loadItems() {
    setLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${draftId}/prompts`);
      const d = await r.json();
      setItems(d.items || []);
      setRunning(!!d.running);
    } catch (e) {
      pushLog(`列表加载失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  function pushLog(msg: string) {
    setLogs((p) => [...p.slice(-50), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }

  function chapterPayload(): number[] | null {
    if (scope === "all") return null;
    return [scopeChapter];
  }

  async function runPlan() {
    if (!videoKey) {
      notifyError("请先选视频模型");
      return;
    }
    setBusy("plan");
    pushLog(`▶ 规划: 模板=${videoKey} 范围=${scope === "all" ? "全集" : `第${scopeChapter}章`}`);
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapter_orders: chapterPayload(),
          video_template_key: videoKey,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      pushLog(`✓ 已发起规划: ${d.message}`);
      setRunning(true);
      await loadItems();
    } catch (e: any) {
      pushLog(`✗ 规划失败: ${e.message || e}`);
    } finally {
      setBusy("");
    }
  }

  async function runRender() {
    if (!videoKey && !imageKey) {
      notifyError("请至少选择视频模型或首帧图模型其一");
      return;
    }
    setBusy("render");
    pushLog(
      `▶ 渲染: 视频=${videoKey || "(无)"} 首帧=${imageKey || "(无)"} 范围=${scope === "all" ? "全集" : `第${scopeChapter}章`}`,
    );
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapter_orders: chapterPayload(),
          video_template_key: videoKey || null,
          image_template_key: imageKey || null,
          skip_user_edited: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      pushLog(`✓ 已发起渲染: ${d.message}`);
      setRunning(true);
      await loadItems();
    } catch (e: any) {
      pushLog(`✗ 渲染失败: ${e.message || e}`);
    } finally {
      setBusy("");
    }
  }

  async function regenerate(p: Prompt) {
    pushLog(`▶ 重生任务 ${p.task_index} (Ch${p.chapter_order})`);
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/${p.id}/regenerate`, {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      pushLog(`✓ 重生完成`);
      await loadItems();
    } catch (e: any) {
      pushLog(`✗ 重生失败: ${e.message || e}`);
    }
  }

  async function patchPrompt(id: number, patch: Partial<Prompt>) {
    try {
      await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await loadItems();
    } catch (e: any) {
      pushLog(`✗ 保存失败: ${e.message || e}`);
    }
  }

  async function deletePrompt(p: Prompt) {
    if (
      !(await confirmAsync({
        title: `删除任务 ${p.task_index} (Ch${p.chapter_order})`,
        tone: "danger",
        confirmText: "删除",
      }))
    )
      return;
    try {
      await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/${p.id}`, { method: "DELETE" });
      pushLog(`✓ 已删除任务 ${p.task_index}`);
      await loadItems();
    } catch (e: any) {
      pushLog(`✗ 删除失败: ${e.message || e}`);
    }
  }

  function toggleChapter(co: number) {
    setCollapsedChapters((p) => {
      const n = new Set(p);
      if (n.has(co)) n.delete(co);
      else n.add(co);
      return n;
    });
  }

  function copyToClipboard(text: string, id: number) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  async function exportAll(format: "txt" | "csv" | "json") {
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${draftId}/prompts/export?format=${format}`);
      const d = await r.json();
      let text = "";
      let mime = "text/plain";
      if (format === "json") {
        text = JSON.stringify(d.items, null, 2);
        mime = "application/json";
      } else if (format === "csv") {
        text = d.csv || "";
        mime = "text/csv";
      } else {
        text = d.text || "";
      }
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `prompts-${draftId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      pushLog(`✗ 导出失败: ${e.message || e}`);
    }
  }

  return (
    <div className="space-y-4">
      {/* ===== 工具栏 ===== */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="视频模型" className="min-w-[200px]">
            <Select value={videoKey} onChange={(e) => setVideoKey(e.target.value)} size="md">
              <option value="">— 选择 —</option>
              {videoTpls.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label} ({t.duration_min}-{t.duration_max}s)
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="首帧图模型 (可选)" className="min-w-[180px]">
            <Select value={imageKey} onChange={(e) => setImageKey(e.target.value)} size="md">
              <option value="">— 不生成首帧 —</option>
              {imageTpls.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="范围">
            <div className="flex gap-2">
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value as any)}
                size="md"
                className="w-24"
              >
                <option value="all">全集</option>
                <option value="single">单章</option>
              </Select>
              {scope === "single" && (
                <Input
                  type="number"
                  min={1}
                  value={scopeChapter}
                  onChange={(e) => setScopeChapter(Number(e.target.value) || 1)}
                  size="md"
                  className="w-20"
                />
              )}
            </div>
          </FormField>

          <div className="flex-1" />

          <Button
            variant="primary"
            size="md"
            loading={busy === "plan"}
            leftIcon={busy !== "plan" ? <Sparkles className="w-4 h-4" /> : undefined}
            disabled={busy !== "" || running || !videoKey}
            onClick={runPlan}
            title="先把分镜分组成视频任务 (调 LLM)"
          >
            1) 规划任务
          </Button>

          <Button
            variant="cyan"
            size="md"
            loading={busy === "render"}
            leftIcon={busy !== "render" ? <Wand2 className="w-4 h-4" /> : undefined}
            disabled={busy !== "" || running || (!videoKey && !imageKey) || items.length === 0}
            onClick={runRender}
            title="对已规划的任务渲染最终 prompt (调 LLM)。可只选首帧图模型,不选视频模型"
          >
            2) 渲染 prompt
          </Button>

          <div className="flex gap-1">
            <Button
              variant="secondary"
              size="md"
              leftIcon={<Download className="w-3.5 h-3.5" />}
              disabled={items.length === 0}
              onClick={() => exportAll("txt")}
            >
              txt
            </Button>
            <Button
              variant="secondary"
              size="md"
              leftIcon={<Download className="w-3.5 h-3.5" />}
              disabled={items.length === 0}
              onClick={() => exportAll("csv")}
            >
              csv
            </Button>
            <Button
              variant="secondary"
              size="md"
              leftIcon={<Download className="w-3.5 h-3.5" />}
              disabled={items.length === 0}
              onClick={() => exportAll("json")}
            >
              json
            </Button>
          </div>
        </div>

        {/* 状态行 */}
        <div className="flex items-center gap-3 text-xs text-ink-secondary">
          {running ? (
            <span className="flex items-center gap-1.5 text-warning">
              <Spinner size="sm" />
              后台任务运行中, 自动刷新中…
            </span>
          ) : (
            <span>
              共 {items.length} 段视频任务, 跨 {chapters.length} 章
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RefreshCw className="w-3 h-3" />}
            onClick={loadItems}
            className="ml-auto"
          >
            刷新
          </Button>
        </div>

        {/* 日志条 */}
        {logs.length > 0 && (
          <div className="text-[11px] font-mono text-ink-muted max-h-24 overflow-auto bg-surface-base/40 rounded p-2 border border-line">
            {logs.slice(-8).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </Card>

      {/* ===== 任务列表 ===== */}
      {loading && items.length === 0 && (
        <Card padding="lg" className="flex items-center gap-2 justify-center text-ink-secondary">
          <Spinner size="md" /> 加载中…
        </Card>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          title="还没有规划过"
          description="选好视频模型和首帧图模型 → 点 1) 规划任务 即可开始。"
        />
      )}

      {chapters.map((co) => {
        const arr = itemsByChapter.get(co) || [];
        const collapsed = collapsedChapters.has(co);
        const totalDuration = arr.reduce((s, p) => s + p.duration_s, 0);
        return (
          <Card key={co} padding="none" className="overflow-hidden">
            <button
              onClick={() => toggleChapter(co)}
              className="w-full flex items-center justify-between px-4 py-3 bg-surface-raised hover:bg-surface-overlay transition"
            >
              <div className="flex items-center gap-3 text-sm">
                <span className="font-semibold text-ink-primary">第 {co} 章</span>
                <Badge tone="muted" size="sm">
                  {arr.length} 段 / 共 {totalDuration}s
                </Badge>
              </div>
              {collapsed ? (
                <ChevronDown className="w-4 h-4 text-ink-muted" />
              ) : (
                <ChevronUp className="w-4 h-4 text-ink-muted" />
              )}
            </button>
            {!collapsed && (
              <div className="divide-y divide-line">
                {arr.map((p) => (
                  <PromptCard
                    key={p.id}
                    p={p}
                    onPatch={(patch) => patchPrompt(p.id, patch)}
                    onRegenerate={() => regenerate(p)}
                    onDelete={() => deletePrompt(p)}
                    onCopy={(text) => copyToClipboard(text, p.id)}
                    copied={copiedId === p.id}
                  />
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================
// 单段任务卡片
// ============================================================

function PromptCard({
  p,
  onPatch,
  onRegenerate,
  onDelete,
  onCopy,
  copied,
}: {
  p: Prompt;
  onPatch: (patch: any) => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onCopy: (text: string) => void;
  copied: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [vp, setVp] = useState(p.video_prompt || "");
  const [ip, setIp] = useState(p.image_prompt || "");
  const [dur, setDur] = useState(p.duration_s);

  useEffect(() => {
    setVp(p.video_prompt || "");
    setIp(p.image_prompt || "");
    setDur(p.duration_s);
  }, [p.id, p.video_prompt, p.image_prompt, p.duration_s]);

  const dirty = vp !== (p.video_prompt || "") || ip !== (p.image_prompt || "") || dur !== p.duration_s;

  return (
    <div className="px-4 py-4 hover:bg-surface-raised/30 transition">
      {/* 头部 */}
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="primary" size="sm">任务 {p.task_index}</Badge>
          <Badge tone="info" size="sm">{p.duration_s}s</Badge>
          <span className="text-ink-secondary">
            来源镜:{" "}
            <code className="bg-surface-base border border-line px-1 py-0.5 rounded text-ink-primary">
              {p.source_shot_nos.join(",")}
            </code>
          </span>
          {p.video_template_key && (
            <span className="text-ink-muted">→ {p.video_template_key}</span>
          )}
          {p.user_edited && <Badge tone="warning" size="sm">已编辑</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!vp}
            onClick={() => onCopy(vp || "")}
            title="复制视频 prompt"
            leftIcon={
              copied ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <Copy className="w-4 h-4" />
              )
            }
          >
            <span className="sr-only">复制</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!p.video_template_key}
            onClick={onRegenerate}
            title="重生(基于已规划)"
            leftIcon={<RefreshCw className="w-4 h-4" />}
          >
            <span className="sr-only">重生</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing((v) => !v)}
            title="编辑"
            leftIcon={editing ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
          >
            <span className="sr-only">编辑</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            title="删除"
            leftIcon={<Trash2 className="w-4 h-4 text-danger" />}
            className="hover:bg-danger/10"
          >
            <span className="sr-only">删除</span>
          </Button>
        </div>
      </div>

      {/* 摘要 */}
      {p.summary && <div className="text-sm text-ink-secondary mb-3 italic">{p.summary}</div>}

      {/* 视频 prompt */}
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-ink-muted">视频 prompt</span>
          {editing && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-ink-muted">时长</span>
              <Input
                type="number"
                min={1}
                max={15}
                value={dur}
                onChange={(e) => setDur(Math.max(1, Math.min(15, Number(e.target.value) || 5)))}
                size="sm"
                className="w-16"
              />
              <span className="text-ink-muted">秒</span>
            </div>
          )}
        </div>
        {editing ? (
          <Textarea
            value={vp}
            onChange={(e) => setVp(e.target.value)}
            rows={Math.min(20, Math.max(5, vp.split("\n").length))}
            className="font-mono"
          />
        ) : p.video_prompt ? (
          <div className="space-y-2">
            {/* PLAN §11 / 11 号设计图 — 7 字段拆分卡 */}
            <ShotPromptCard
              prompt={p.video_prompt}
              planJson={(p as any).plan_json}
              duration={p.duration_s}
              shotNos={p.source_shot_nos as any}
            />
            {/* 原始 prompt (折叠展开, 默认收起) */}
            <details className="text-xs">
              <summary className="cursor-pointer text-ink-muted hover:text-ink-primary py-1 select-none">
                查看原始 prompt 文本
              </summary>
              <pre className="mt-1 text-sm whitespace-pre-wrap bg-surface-base/60 border border-line rounded px-3 py-2 max-h-48 overflow-auto font-mono text-ink-primary">
                {p.video_prompt}
              </pre>
            </details>
          </div>
        ) : (
          <pre className="text-sm whitespace-pre-wrap bg-surface-base/60 border border-line rounded px-3 py-2 max-h-48 overflow-auto font-mono text-ink-muted italic">
            (尚未渲染)
          </pre>
        )}
      </div>

      {/* 图片 prompt */}
      {(p.image_template_key || p.image_prompt) && (
        <div>
          <div className="text-xs text-ink-muted mb-1">
            首帧图 prompt ({p.image_template_key})
          </div>
          {editing ? (
            <Textarea
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              rows={3}
              className="font-mono"
            />
          ) : (
            <pre className="text-sm whitespace-pre-wrap bg-surface-base/60 border border-line rounded px-3 py-2 max-h-32 overflow-auto font-mono text-ink-secondary">
              {p.image_prompt || <span className="text-ink-muted italic">(无)</span>}
            </pre>
          )}
        </div>
      )}

      {/* 编辑保存按钮 */}
      {editing && (
        <div className="flex justify-end gap-2 mt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setVp(p.video_prompt || "");
              setIp(p.image_prompt || "");
              setDur(p.duration_s);
              setEditing(false);
            }}
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty}
            leftIcon={<Check className="w-3.5 h-3.5" />}
            onClick={() => {
              const patch: any = {};
              if (vp !== (p.video_prompt || "")) patch.video_prompt = vp;
              if (ip !== (p.image_prompt || "")) patch.image_prompt = ip;
              if (dur !== p.duration_s) patch.duration_s = dur;
              onPatch(patch);
              setEditing(false);
            }}
          >
            保存
          </Button>
        </div>
      )}
    </div>
  );
}
