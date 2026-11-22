"use client";
import { authFetch } from "../../lib/auth";
import { confirmAsync, notifyError, notifyWarning } from "@/lib/dialog";
import { useState, useEffect, useRef } from "react";
import { Loader2, Merge, Scissors, Edit2, Trash2, Plus } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Spinner } from "@/components/ui/Spinner";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Chapter = {
  order: number;
  title: string;
  content: string;
};

/**
 * 章节编辑器 — Phase 3 重做版,接入 UI Kit。
 * 业务逻辑全部保留:加载切分预览、章内合并/拆分/改名/删除/添加。
 */
export function ChapterEditor({
  open,
  file,
  onClose,
  onConfirm,
}: {
  open: boolean;
  file: File | null;
  onClose: () => void;
  onConfirm: (chapters: Chapter[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [editingTitleIdx, setEditingTitleIdx] = useState<number | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open && file) {
      loadChapters();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file]);

  async function loadChapters() {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await authFetch(`${BASE}/v1/stages/drafts/batch-upload/split-preview`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        notifyError("加载失败: " + res.status);
        setChapters([]);
        return;
      }
      const data = await res.json();
      setChapters(data.chapters || []);
    } catch (e) {
      notifyError("加载出错: " + e);
      setChapters([]);
    } finally {
      setLoading(false);
    }
  }

  function mergeWithNext(idx: number) {
    if (idx >= chapters.length - 1) return;
    const next = [...chapters];
    const merged = { ...next[idx], content: next[idx].content + "\n\n" + next[idx + 1].content };
    next.splice(idx, 2, merged);
    next.forEach((c, i) => (c.order = i + 1));
    setChapters(next);
  }

  function splitAtCursor(idx: number) {
    if (expanded !== idx || !contentRef.current) {
      notifyWarning("请先展开该章节并将光标放到要拆分的位置");
      return;
    }
    const cursor = contentRef.current.selectionStart;
    const ch = chapters[idx];
    if (cursor <= 0 || cursor >= ch.content.length) {
      notifyWarning("请把光标放在章节内容中间(不是开头或末尾)");
      return;
    }
    const before = ch.content.slice(0, cursor).trim();
    const after = ch.content.slice(cursor).trim();
    if (!before || !after) {
      notifyWarning("拆分后某一部分为空,请调整位置");
      return;
    }
    const next = [...chapters];
    next[idx] = { ...ch, content: before };
    next.splice(idx + 1, 0, { order: 0, title: `${ch.title}-续`, content: after });
    next.forEach((c, i) => (c.order = i + 1));
    setChapters(next);
    setExpanded(null);
  }

  async function deleteChapter(idx: number) {
    const ok = await confirmAsync({
      title: `删除第 ${chapters[idx].order} 章`,
      description: `「${chapters[idx].title}」内容将丢失，不可恢复。`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const next = chapters.filter((_, i) => i !== idx);
    next.forEach((c, i) => (c.order = i + 1));
    setChapters(next);
  }

  function updateContent(idx: number, newContent: string) {
    const next = [...chapters];
    next[idx] = { ...next[idx], content: newContent };
    setChapters(next);
  }

  function addChapter() {
    const next = [...chapters, { order: chapters.length + 1, title: `第${chapters.length + 1}章`, content: "" }];
    setChapters(next);
    setExpanded(next.length - 1);
  }

  function handleConfirm() {
    if (chapters.length === 0) {
      notifyWarning("至少需要1个章节");
      return;
    }
    onConfirm(chapters);
  }

  const footer = (
    <div className="flex gap-2 w-full">
      <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
      <Button variant="primary" size="md" disabled={chapters.length === 0} onClick={handleConfirm} className="flex-1">
        确认 {chapters.length} 章并返回
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          📝 章节编辑
          {file && <span className="text-sm text-ink-secondary font-normal">- {file.name}</span>}
        </span>
      }
      size="lg"
      footer={footer}
    >
      <div className="flex-1">
        {loading ? (
          <div className="py-20 text-center">
            <Spinner size="lg" className="mx-auto mb-4 text-primary" />
            <p className="text-ink-secondary">正在切分章节...</p>
          </div>
        ) : chapters.length === 0 ? (
          <div className="py-20 text-center text-ink-secondary">
            <p>未切分到章节,请返回手动指定集数</p>
          </div>
        ) : (
          <>
            <div className="mb-3 text-sm text-ink-secondary">
              共 <span className="text-primary font-bold">{chapters.length}</span> 章,总字数{" "}
              <span className="text-primary font-bold">{chapters.reduce((sum, c) => sum + c.content.length, 0)}</span>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {chapters.map((ch, idx) => (
                <div key={idx} className="border border-line rounded-md bg-surface-base">
                  <div className="flex items-center gap-2 p-2 flex-wrap">
                    <span className="text-xs text-ink-muted w-12">#{ch.order}</span>
                    {editingTitleIdx === idx ? (
                      <Input
                        value={ch.title}
                        onChange={(e) => {
                          const next = [...chapters];
                          next[idx] = { ...next[idx], title: e.target.value };
                          setChapters(next);
                        }}
                        onBlur={() => setEditingTitleIdx(null)}
                        onKeyDown={(e) => e.key === "Enter" && setEditingTitleIdx(null)}
                        autoFocus
                        className="flex-1 !py-1"
                      />
                    ) : (
                      <span className="flex-1 font-semibold cursor-pointer text-sm text-ink-primary" onClick={() => setExpanded(expanded === idx ? null : idx)}>
                        {ch.title}
                      </span>
                    )}
                    <span className="text-xs text-ink-muted">{ch.content.length}字</span>
                    <div className="flex gap-1 flex-wrap">
                      <Button variant="secondary" size="sm" leftIcon={<Edit2 className="w-3 h-3" />} onClick={() => setEditingTitleIdx(idx)} title="改名">改名</Button>
                      <Button variant="secondary" size="sm" leftIcon={<Scissors className="w-3 h-3" />} onClick={() => setExpanded(idx)} title="从光标拆分(展开后将光标放至要拆分的位置,再点击下方拆分按钮)">拆分</Button>
                      {idx < chapters.length - 1 && (
                        <Button variant="secondary" size="sm" leftIcon={<Merge className="w-3 h-3" />} onClick={() => mergeWithNext(idx)} title="与下一章合并">合并下一章</Button>
                      )}
                      <Button variant="ghost" size="sm" leftIcon={<Trash2 className="w-3 h-3" />} onClick={() => deleteChapter(idx)} className="text-danger hover:text-danger" title="删除整章(内容丢失)">删除</Button>
                    </div>
                  </div>
                  {expanded === idx && (
                    <div className="p-2 border-t border-line">
                      <Textarea
                        ref={expanded === idx ? contentRef : null}
                        value={ch.content}
                        onChange={(e) => updateContent(idx, e.target.value)}
                        rows={12}
                        className="font-mono text-xs leading-relaxed"
                        placeholder="章节内容(可直接编辑,光标位置作为拆分点)"
                      />
                      <div className="flex justify-end mt-2">
                        <Button variant="primary" size="sm" leftIcon={<Scissors className="w-3 h-3" />} onClick={() => splitAtCursor(idx)}>
                          从光标处拆分为两章
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={addChapter}
              className="w-full mt-3 py-2 border-2 border-dashed border-line hover:border-primary rounded-md text-sm text-ink-secondary hover:text-primary flex items-center justify-center gap-1 transition"
            >
              <Plus className="w-4 h-4" /> 在末尾添加新章节
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
