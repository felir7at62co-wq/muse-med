"use client";

/**
 * 章节版本历史 Modal
 *
 * 后端: GET  /v1/stages/drafts/{draft_id}/episodes/{order}/history?stage=chapter
 *       POST /v1/stages/drafts/{draft_id}/episodes/{order}/restore  body: { stage:"chapter", version }
 *
 * 数据来源: services/orchestrator/app/db/models.py:ScriptEpisodeHistory (`script_episode_history` 表)
 *
 * 触发时机: 用户点击章节卡片上的「📜 历史版本」按钮。
 * 写入时机: services/orchestrator/app/stages/router.py:patch_chapter (full_text 真的发生变化时,把"修改前"快照写入历史)
 *           或 router_m5_enhanced.py 里的批量重写 / 锁定 / restore。
 */

import { useEffect, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { authFetch } from "../../../lib/auth";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { confirmAsync, notify, notifyError } from "@/lib/dialog";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

export interface ChapterVersionItem {
  id: number;
  draft_id: number;
  episode_order: number;
  stage: string;
  content: { full_text?: string; title?: string } | null;
  version: number;
  created_by: string | null;
  created_at: string | null;
}

interface Props {
  open: boolean;
  draftId: number;
  chapterOrder: number;
  chapterTitle?: string;
  /** 当前章节正文,用于在"差异提示"里显示当前 vs 历史版本字数差 */
  currentText?: string;
  /** 内容阶段: chapter(章节正文) | storyboard(剧本)。默认 chapter。 */
  stage?: "chapter" | "storyboard";
  onClose: () => void;
  /** restore 成功后回调,前端应刷新草稿数据 */
  onRestored?: () => void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function previewText(t: string | undefined, limit = 120): string {
  if (!t) return "(空)";
  const trimmed = t.trim().replace(/\s+/g, " ");
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit) + "…";
}

export function ChapterVersionHistory({
  open,
  draftId,
  chapterOrder,
  chapterTitle,
  currentText = "",
  stage = "chapter",
  onClose,
  onRestored,
}: Props) {
  const stageLabel = stage === "storyboard" ? "剧本" : "章节";
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ChapterVersionItem[]>([]);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function fetchHistory() {
    setLoading(true);
    try {
      const r = await authFetch(
        `${BASE}/v1/stages/drafts/${draftId}/episodes/${chapterOrder}/history?stage=${stage}`
      );
      if (!r.ok) {
        notifyError(`加载历史版本失败 (${r.status})`);
        setItems([]);
        return;
      }
      const data = await r.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      notifyError(`加载历史版本失败: ${(e as Error).message}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      void fetchHistory();
    } else {
      // 关闭后清空展开态,避免下次打开时残留
      setExpanded(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftId, chapterOrder]);

  async function handleRestore(item: ChapterVersionItem) {
    const ok = await confirmAsync({
      title: `恢复到 v${item.version}`,
      description: `当前正文将先存入历史版本,然后用 v${item.version} (${formatTime(item.created_at)}) 覆盖正文。可再恢复回来。`,
      confirmText: "恢复此版本",
      tone: "warning",
    });
    if (!ok) return;

    setRestoringVersion(item.version);
    try {
      const r = await authFetch(
        `${BASE}/v1/stages/drafts/${draftId}/episodes/${chapterOrder}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, version: item.version }),
        }
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        notifyError(`恢复失败: ${err.detail || r.status}`);
        return;
      }
      notify(`已恢复到 v${item.version}`);
      onRestored?.();
      await fetchHistory();
    } catch (e) {
      notifyError(`恢复失败: ${(e as Error).message}`);
    } finally {
      setRestoringVersion(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="inline-flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          {stageLabel}历史版本
          <span className="text-ink-secondary text-sm font-normal">
            第 {chapterOrder} {stage === "storyboard" ? "集" : "章"}
            {chapterTitle ? ` · ${chapterTitle}` : ""}
          </span>
        </span>
      }
      description="保留最近 10 个版本。每次保存编辑或重新生成,系统会把『修改前』内容自动归档到此处。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button
            variant="secondary"
            leftIcon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
            onClick={fetchHistory}
            disabled={loading}
          >
            刷新
          </Button>
        </>
      }
    >
      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="py-12 flex flex-col items-center gap-3 text-ink-secondary">
            <Spinner size="lg" className="text-primary" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="暂无历史版本"
            description="编辑或重新生成本章后,『修改前』的内容会自动归档到这里,可一键恢复。"
          />
        ) : (
          items.map((item) => {
            // 章节: content.full_text 纯文本; 剧本: content 是 shots 数组, 拍平成可读文本
            let text = "";
            if (stage === "storyboard") {
              const shots = Array.isArray(item.content) ? item.content : ((item.content as any)?.shots || []);
              try {
                text = (shots as any[]).map((sh: any, i: number) => {
                  if (typeof sh === "string") return sh;
                  const no = sh.shot_no || sh.scene_no || sh.no || i + 1;
                  const desc = sh.description || sh.action || sh.scene || "";
                  const spk = sh.speaker || sh.character || sh.角色 || "";
                  const line = sh.line || sh.dialogue || sh.台词 || "";
                  let seg = `[${no}] ${desc}`.trim();
                  if (line) seg += spk ? `\n${spk}：${line}` : `\n${line}`;
                  return seg;
                }).join("\n\n");
              } catch { text = JSON.stringify(item.content); }
            } else {
              text = item.content?.full_text || "";
            }
            const isExpanded = expanded === item.version;
            const wordDiff = (currentText?.length || 0) - text.length;
            return (
              <Card key={item.id} padding="md">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone="primary" size="sm">
                        v{item.version}
                      </Badge>
                      <span className="text-xs text-ink-muted">
                        {formatTime(item.created_at)}
                      </span>
                      <Badge
                        tone={item.created_by === "user_edit" ? "info" : "muted"}
                        size="sm"
                      >
                        {item.created_by === "user_edit" ? "用户编辑" : "AI 生成"}
                      </Badge>
                      <span className="text-xs text-ink-muted">
                        {text.length.toLocaleString()} 字
                        {wordDiff !== 0 && currentText && (
                          <span
                            className={
                              wordDiff > 0 ? "text-success ml-1" : "text-warning ml-1"
                            }
                          >
                            ({wordDiff > 0 ? "+" : ""}
                            {wordDiff} vs 当前)
                          </span>
                        )}
                      </span>
                      {item.content?.title &&
                        item.content.title !== chapterTitle && (
                          <span className="text-xs text-ink-muted">
                            旧标题: {item.content.title}
                          </span>
                        )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setExpanded(isExpanded ? null : item.version)
                      }
                    >
                      {isExpanded ? "收起" : "查看"}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={restoringVersion === item.version}
                      onClick={() => handleRestore(item)}
                      leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                    >
                      恢复
                    </Button>
                  </div>
                </div>
                {!isExpanded ? (
                  <p className="text-xs text-ink-secondary line-clamp-2">
                    {previewText(text, 200)}
                  </p>
                ) : (
                  <div className="mt-2 p-3 bg-surface-base/60 border border-line rounded text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto font-mono">
                    {text || "(空)"}
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </Modal>
  );
}
