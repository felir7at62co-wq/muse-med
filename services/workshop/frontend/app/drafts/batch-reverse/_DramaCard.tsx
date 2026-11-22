"use client";
/**
 * 批量文件夹反推 — 单个剧的卡片
 *
 * 折叠态: 剧名 / 集数 / 状态 / 进度条
 * 展开态: 集列表, 可拖动改序 (拖完自动重编号 1..N)
 *
 * ⚠ 拖拽用私有 MIME 而不是 text/plain —— 与 _VideoUploadModal 同一个坑:
 * 从系统拖进来的视频文件, text/plain 是空串, `Number("")` 得 0,
 * 于是会被误判成"拖的是第 1 集"并静默重排, 用户毫无察觉。
 */
import { useState } from "react";
import {
  ChevronRight, ChevronDown, GripVertical, CheckCircle, AlertCircle,
  RotateCw, SkipForward, FileVideo,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Progress";
import { Spinner } from "@/components/ui/Spinner";
import { formatBytes } from "@/lib/ossUpload";
import { describeReview, UNGROUPED_TITLE, type DramaGroup } from "@/lib/episodeOrder";
import type { DramaStatus } from "@/lib/batchReverseStore";

export const REORDER_MIME = "application/x-drama-batch-episode-index";

export type EpisodeRuntime = {
  /** 上传进度 0-100 */
  percent: number;
  uploadId?: string;
  error?: string;
};

export type DramaRuntime = {
  status: DramaStatus;
  draftId?: number;
  error?: string;
  /** relPath → 运行时状态 */
  episodes: Record<string, EpisodeRuntime>;
};

const statusMeta: Record<DramaStatus, { label: string; tone: "primary" | "success" | "warning" | "danger" | "muted" | "info" }> = {
  pending:    { label: "等待中",   tone: "muted" },
  uploading:  { label: "上传中",   tone: "primary" },
  uploaded:   { label: "待提交",   tone: "info" },
  submitting: { label: "创建草稿", tone: "info" },
  submitted:  { label: "已提交",   tone: "success" },
  failed:     { label: "失败",     tone: "danger" },
  skipped:    { label: "已跳过",   tone: "muted" },
};

export function DramaCard({
  group,
  runtime,
  selected,
  busy,
  onToggleSelect,
  onReorder,
  onRetry,
  onSkip,
}: {
  group: DramaGroup;
  runtime: DramaRuntime;
  selected: boolean;
  /** 批次正在跑 —— 此时不允许改序/改选中 */
  busy: boolean;
  onToggleSelect: () => void;
  onReorder: (from: number, to: number) => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const meta = statusMeta[runtime.status];
  const needsReview = group.reviewReasons.length > 0;
  const isUngrouped = group.title === UNGROUPED_TITLE;

  const total = group.episodes.length;
  const doneCount = group.episodes.filter(
    (e) => runtime.episodes[e.relPath]?.uploadId,
  ).length;
  const percent = total === 0
    ? 0
    : Math.round(
        group.episodes.reduce(
          (sum, e) => sum + (runtime.episodes[e.relPath]?.percent ?? 0),
          0,
        ) / total,
      );

  const totalBytes = group.episodes.reduce((s, e) => s + e.size, 0);
  // ⚠ 批次一开跑就全面禁止改序 —— 哪怕这个剧还没轮到。
  // 改序会生成新的 group 对象, 而上传队列里握的是开跑那一刻的旧对象,
  // 于是「界面上的集顺序」和「真正提交上去的 upload_ids 顺序」会悄悄分叉。
  const locked = busy;

  return (
    <Card padding="none" className="overflow-hidden">
      {/* ── 折叠行 ── */}
      <div className="flex items-center gap-3 p-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={busy}
          onChange={onToggleSelect}
          className="w-4 h-4 accent-primary shrink-0 disabled:opacity-40"
          aria-label={`选择 ${group.title}`}
        />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          {open
            ? <ChevronDown className="w-4 h-4 text-ink-muted shrink-0" />
            : <ChevronRight className="w-4 h-4 text-ink-muted shrink-0" />}
          <span className="truncate font-medium text-ink-primary">{group.title}</span>
          <span className="text-caption text-ink-muted shrink-0 tabular-nums">
            {total} 集 · {formatBytes(totalBytes)}
          </span>
        </button>

        {needsReview && !isUngrouped && (
          <Badge tone="warning" withDot>需确认</Badge>
        )}
        {isUngrouped && <Badge tone="muted">散装文件</Badge>}
        <Badge tone={meta.tone} withDot={runtime.status !== "pending"}>
          {meta.label}
        </Badge>

        {runtime.status === "submitting" && <Spinner size="sm" />}

        {runtime.status === "submitted" && runtime.draftId && (
          <a
            href={`/drafts/${runtime.draftId}`}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-primary hover:underline shrink-0"
          >
            草稿 #{runtime.draftId} →
          </a>
        )}

        {runtime.status === "failed" && (
          <Button size="sm" variant="secondary" leftIcon={<RotateCw className="w-3 h-3" />} onClick={onRetry}>
            重试
          </Button>
        )}

        {!busy && runtime.status !== "submitted" && runtime.status !== "skipped" && (
          <Button size="sm" variant="ghost" leftIcon={<SkipForward className="w-3 h-3" />} onClick={onSkip}>
            跳过
          </Button>
        )}
      </div>

      {/* ── 进度条 ── */}
      {(runtime.status === "uploading" || runtime.status === "uploaded") && (
        <div className="px-3 pb-2 flex items-center gap-3">
          <Progress percent={percent} className="flex-1" label={`${group.title} 上传进度`} />
          <span className="text-micro text-ink-muted tabular-nums shrink-0">
            {doneCount}/{total}
          </span>
        </div>
      )}

      {/* ── 需确认的原因 ── */}
      {needsReview && !isUngrouped && (
        <div className="px-3 pb-2 flex items-start gap-2 text-caption text-warning">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            {describeReview(group)}
            —— 展开核对集号，拖动可改序（拖完自动重编 1…{total}）
          </span>
        </div>
      )}

      {group.skipped.length > 0 && (
        <div className="px-3 pb-2 text-micro text-ink-muted">
          已跳过 {group.skipped.length} 个非视频文件
          {group.skipped.length <= 4 && `（${group.skipped.join("、")}）`}
        </div>
      )}

      {runtime.error && (
        <div className="px-3 pb-2 text-caption text-danger break-all">{runtime.error}</div>
      )}

      {/* ── 展开: 集列表 ── */}
      {open && (
        <div className="border-t border-line divide-y divide-line/60">
          {group.episodes.map((ep, idx) => {
            const rt = runtime.episodes[ep.relPath];
            return (
              <div
                key={ep.relPath}
                draggable={!locked}
                onDragStart={(e) => {
                  e.dataTransfer.setData(REORDER_MIME, String(idx));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(REORDER_MIME)) return;
                  e.preventDefault();
                  setDragOverIdx(idx);
                }}
                onDragLeave={() => setDragOverIdx((v) => (v === idx ? null : v))}
                onDrop={(e) => {
                  setDragOverIdx(null);
                  if (!e.dataTransfer.types.includes(REORDER_MIME)) return;
                  e.preventDefault();
                  const from = Number(e.dataTransfer.getData(REORDER_MIME));
                  if (Number.isFinite(from) && from !== idx) onReorder(from, idx);
                }}
                className={[
                  "flex items-center gap-2 px-3 py-1.5 text-caption",
                  dragOverIdx === idx ? "bg-primary/10" : "",
                  locked ? "" : "cursor-grab",
                ].join(" ")}
              >
                {!locked && <GripVertical className="w-3.5 h-3.5 text-ink-muted shrink-0" />}
                <span className="w-14 shrink-0 tabular-nums text-ink-secondary">
                  第 {ep.epNo} 集
                </span>
                {!ep.confident && (
                  <span title="集号是按文件名顺序猜的，不是解析出来的">
                    <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0" />
                  </span>
                )}
                <FileVideo className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                <span className="truncate flex-1 text-ink-secondary">{ep.name}</span>
                <span className="text-micro text-ink-muted tabular-nums shrink-0">
                  {formatBytes(ep.size)}
                </span>
                {rt?.uploadId
                  ? <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                  : rt?.error
                    ? <span className="text-micro text-danger shrink-0">失败</span>
                    : rt && rt.percent > 0
                      ? <span className="text-micro text-primary tabular-nums shrink-0 w-9 text-right">
                          {rt.percent}%
                        </span>
                      : <span className="w-9 shrink-0" />}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
