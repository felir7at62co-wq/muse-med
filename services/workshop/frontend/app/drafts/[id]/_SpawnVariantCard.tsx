"use client";
import { useEffect, useState } from "react";
import {
  Loader2, Check, X, ArrowRight, Pencil, Save, Wand2, Trash2, ChevronDown, ChevronRight,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";

/**
 * 一个裂变方向的卡片。
 *
 * 两段式裂变下, 方向在「待确认」状态时是可读可改的:
 *   看故事圣经 / 全剧主线 / 人物 / 前 N 集 → 直接改 → 或写一句意见让 AI 重出 →
 *   不满意就砍掉 → 满意了再展开成全 N 集。
 * 「完成」后卡片退回只读, 提供"打开新作"。
 */

export type Chapter = { order?: number; title?: string; synopsis?: string };
export type Character = { name?: string; role?: string; traits?: string[] };

export type Variant = {
  idx: number;
  angle: string;
  pitch: string;
  genre: string;
  twist?: string;
  /** 排队中|预览生成中|生成中|待确认|展开中|完成|失败|已弃用 */
  status: string;
  draft_id?: number | null;
  new_draft_id: number | null;
  title: string;
  synopsis?: string;
  world?: { era?: string; setting?: string; rules?: string[] };
  characters?: Character[];
  preview_chapters?: Chapter[];
  episode_count: number;
  lint?: { error?: number; warn?: number };
  error: string;
  edited?: boolean;
  refined?: number;
};

const BUSY = new Set(["排队中", "预览生成中", "生成中", "展开中"]);

export function SpawnVariantCard({
  v,
  targetEpisodes,
  onPatch,
  onRefine,
  onDrop,
  onOpenDraft,
}: {
  v: Variant;
  targetEpisodes: number;
  onPatch: (idx: number, patch: Record<string, any>) => Promise<void>;
  onRefine: (idx: number, feedback: string) => Promise<void>;
  onDrop: (idx: number) => Promise<void>;
  onOpenDraft?: (draftId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "refine" | "drop">("");
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);

  // 编辑缓冲区
  const [title, setTitle] = useState(v.title || "");
  const [synopsis, setSynopsis] = useState(v.synopsis || "");
  const [chapters, setChapters] = useState<Chapter[]>(v.preview_chapters || []);

  // 服务端刷新(轮询/精修返回)后同步回缓冲区 —— 但正在编辑时不覆盖用户输入
  useEffect(() => {
    if (editing) return;
    setTitle(v.title || "");
    setSynopsis(v.synopsis || "");
    setChapters(v.preview_chapters || []);
  }, [v.title, v.synopsis, v.preview_chapters, editing]);

  const pending = v.status === "待确认";
  const done = v.status === "完成" && (v.draft_id || v.new_draft_id);
  const failed = v.status === "失败";
  const dropped = v.status === "已弃用";
  const busyState = BUSY.has(v.status);
  const draftId = v.draft_id || v.new_draft_id;
  const previewChs = v.preview_chapters || [];

  async function save() {
    setBusy("save");
    try {
      await onPatch(v.idx, {
        title: title.trim() || undefined,
        synopsis,
        chapters: chapters.map((c) => ({
          title: c.title || "",
          synopsis: c.synopsis || "",
        })),
      });
      setEditing(false);
    } finally {
      setBusy("");
    }
  }

  async function refine() {
    setBusy("refine");
    try {
      await onRefine(v.idx, feedback.trim());
      setFeedback("");
      setShowFeedback(false);
    } finally {
      setBusy("");
    }
  }

  async function drop() {
    setBusy("drop");
    try {
      await onDrop(v.idx);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card
      padding="md"
      className={`flex flex-col gap-2 ${
        failed ? "border-danger/40"
          : done ? "border-success/40"
          : dropped ? "border-line opacity-50"
          : pending ? "border-warning/40"
          : ""
      }`}
    >
      {/* ── 头部 ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-ink-primary truncate">
            {v.title || v.angle || `方向 ${v.idx + 1}`}
          </span>
          {v.genre && <Badge tone="muted" size="sm">{v.genre}</Badge>}
          {v.edited && <Badge tone="info" size="sm">已手改</Badge>}
          {!!v.refined && <Badge tone="info" size="sm">已重出 {v.refined} 次</Badge>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {busyState && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
          {busyState && <span className="text-[11px] text-ink-muted">{v.status}</span>}
          {pending && <Badge tone="warning" size="sm">待确认</Badge>}
          {done && <Check className="w-4 h-4 text-success" />}
          {failed && <X className="w-4 h-4 text-danger" />}
          {dropped && <span className="text-[11px] text-ink-muted">已弃用</span>}
        </div>
      </div>

      {v.angle && v.title && v.angle !== v.title && (
        <div className="text-[11px] text-primary">{v.angle}</div>
      )}

      {/* ── 主线(有大纲 synopsis 就用它, 没有才回落到策划期的 pitch) ── */}
      {(v.synopsis || v.pitch) && !editing && (
        <p className="text-xs text-ink-secondary leading-snug">
          {v.synopsis || v.pitch}
        </p>
      )}
      {v.synopsis && v.pitch && !editing && (
        <p className="text-[11px] text-ink-muted leading-snug">卖点: {v.pitch}</p>
      )}
      {failed && v.error && <p className="text-[11px] text-danger">{v.error}</p>}

      {/* ── 编辑态: 标题 + 主线 + 前 N 集 ── */}
      {editing && (
        <div className="space-y-2 border-t border-line pt-2">
          <div>
            <label className="block text-[11px] text-ink-muted mb-0.5">全剧标题</label>
            <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] text-ink-muted mb-0.5">全剧主线</label>
            <Textarea rows={2} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
          </div>
          {chapters.map((c, i) => (
            <div key={i} className="space-y-1">
              <label className="block text-[11px] text-ink-muted">第 {i + 1} 集</label>
              <Input
                size="sm"
                value={c.title || ""}
                placeholder="本集标题"
                onChange={(e) => {
                  const n = [...chapters];
                  n[i] = { ...n[i], title: e.target.value };
                  setChapters(n);
                }}
              />
              <Textarea
                rows={3}
                value={c.synopsis || ""}
                placeholder="本集概要"
                onChange={(e) => {
                  const n = [...chapters];
                  n[i] = { ...n[i], synopsis: e.target.value };
                  setChapters(n);
                }}
              />
            </div>
          ))}
          <div className="text-[11px] text-ink-muted leading-relaxed">
            💡 你在这里的改动会成为后续 {Math.max(0, targetEpisodes - chapters.length)} 集生成时的硬约束。
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={busy === "save"}
              leftIcon={busy !== "save" ? <Save className="w-3 h-3" /> : undefined}
              onClick={save}>
              保存修改
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* ── 只读预览: 人物 + 前 N 集 ── */}
      {!editing && pending && (
        <div className="border-t border-line pt-2">
          <button
            type="button"
            onClick={() => setExpanded((o) => !o)}
            className="w-full flex items-center gap-1 text-[11px] text-ink-muted"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            先看前 {previewChs.length} 集（共 {targetEpisodes} 集）
            {(v.characters?.length || 0) > 0 && ` · ${v.characters!.length} 个主要人物`}
          </button>

          {expanded && (
            <div className="mt-2 space-y-2">
              {v.world?.era && (
                <div className="text-[11px] text-ink-secondary">
                  <span className="text-ink-muted">世界观: </span>
                  {v.world.era}
                  {v.world.setting ? ` · ${v.world.setting}` : ""}
                </div>
              )}
              {(v.characters?.length || 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {v.characters!.map((c, i) => (
                    <Badge key={i} tone="muted" size="sm">
                      {c.name}
                      {c.role ? `·${c.role}` : ""}
                    </Badge>
                  ))}
                </div>
              )}
              {previewChs.map((c, i) => (
                <div key={i} className="text-[11px] leading-relaxed">
                  <div className="text-ink-primary">
                    第{c.order ?? i + 1}集《{c.title}》
                  </div>
                  <div className="text-ink-secondary">{c.synopsis}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 待确认: 操作区 ── */}
      {pending && !editing && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          <Button size="sm" variant="secondary" leftIcon={<Pencil className="w-3 h-3" />}
            onClick={() => { setEditing(true); setExpanded(true); }}>
            手动修改
          </Button>
          <Button size="sm" variant="secondary" leftIcon={<Wand2 className="w-3 h-3" />}
            onClick={() => setShowFeedback((o) => !o)}>
            提意见重出
          </Button>
          <Button size="sm" variant="ghost" loading={busy === "drop"}
            leftIcon={busy !== "drop" ? <Trash2 className="w-3 h-3" /> : undefined}
            onClick={drop}>
            不要这个方向
          </Button>
          {draftId && (
            <Button size="sm" variant="ghost" rightIcon={<ArrowRight className="w-3 h-3" />}
              onClick={() => onOpenDraft?.(draftId)}>
              在草稿页看
            </Button>
          )}
        </div>
      )}

      {pending && showFeedback && !editing && (
        <div className="space-y-1.5">
          <Textarea
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="说清哪里不对, 如: 女主动机太弱, 改成她主动设局 / 第2集反转太早, 往后挪"
          />
          <Button size="sm" variant="primary" loading={busy === "refine"}
            disabled={!feedback.trim()} onClick={refine}>
            按意见重出前 {previewChs.length} 集
          </Button>
        </div>
      )}

      {/* ── 完成态 ── */}
      {done && (
        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] text-ink-muted">
            {v.episode_count} 集大纲已生成
            {(v.lint?.error || 0) > 0 && (
              <span className="text-danger"> · {v.lint!.error} 个硬伤待查</span>
            )}
            {!v.lint?.error && (v.lint?.warn || 0) > 0 && (
              <span className="text-warning"> · {v.lint!.warn} 个提示</span>
            )}
          </span>
          <Button size="sm" variant="primary" rightIcon={<ArrowRight className="w-3 h-3" />}
            onClick={() => draftId && onOpenDraft?.(draftId)}>
            打开新作
          </Button>
        </div>
      )}
    </Card>
  );
}
