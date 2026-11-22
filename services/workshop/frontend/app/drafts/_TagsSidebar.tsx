"use client";
import { useEffect, useState } from "react";
import { Tag as TagIcon, Plus, X, Trash2, Check } from "lucide-react";
import { authFetch } from "../../lib/auth";
import { confirmAsync, notifyError } from "@/lib/dialog";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

export type UserTag = {
  id: number;
  name: string;
  color: string;
  count: number;
};

const COLORS = ["#7C3AED", "#EC4899", "#3B82F6", "#10B981", "#F97316", "#EAB308", "#EF4444", "#6366F1"];

/**
 * 标签侧栏 — Phase 3 重做版,接入 UI Kit (Card / Button / Input / IconButton)。
 */
export function TagsSidebar({
  selectedTagId,
  onSelect,
}: {
  selectedTagId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [tags, setTags] = useState<UserTag[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[0]);

  async function fetchTags() {
    const res = await authFetch(`${BASE}/v1/tags`);
    if (res.ok) setTags(await res.json());
  }

  useEffect(() => {
    fetchTags();
  }, []);

  async function createTag() {
    if (!newName.trim()) return;
    const res = await authFetch(`${BASE}/v1/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor }),
    });
    if (res.ok) {
      setNewName("");
      setCreating(false);
      fetchTags();
    } else {
      const err = await res.json().catch(() => ({}));
      notifyError(err.detail || "创建失败");
    }
  }

  async function deleteTag(id: number, name: string) {
    const ok = await confirmAsync({
      title: "删除标签",
      description: `删除标签「${name}」？(草稿不会被删除)`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const res = await authFetch(`${BASE}/v1/tags/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (selectedTagId === id) onSelect(null);
      fetchTags();
    }
  }

  return (
    <Card padding="sm" className="text-sm">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold flex items-center gap-1 text-ink-primary">
          <TagIcon className="w-4 h-4" />
          标签
        </h3>
        <IconButton
          aria-label={creating ? "取消" : "新建标签"}
          size="sm"
          variant="ghost"
          onClick={() => setCreating(!creating)}
        >
          {creating ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </IconButton>
      </div>

      {creating && (
        <div className="mb-3 p-2 bg-surface-base rounded-md border border-line">
          <Input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="标签名"
            onKeyDown={(e) => e.key === "Enter" && createTag()}
            autoFocus
            className="!py-1 text-xs mb-2"
          />
          <div className="flex gap-1 mb-2 flex-wrap">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                className={`w-5 h-5 rounded-full border-2 transition ${newColor === c ? "border-ink-primary" : "border-transparent"}`}
                style={{ background: c }}
                aria-label={`选择颜色 ${c}`}
              />
            ))}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={createTag}
            disabled={!newName.trim()}
            leftIcon={<Check className="w-3 h-3" />}
            className="w-full"
          >
            创建
          </Button>
        </div>
      )}

      <div className="space-y-1">
        <button
          onClick={() => onSelect(null)}
          className={`w-full text-left px-2 py-1 rounded transition ${
            selectedTagId === null ? "bg-primary/15 text-primary" : "hover:bg-surface-base text-ink-primary"
          }`}
        >
          <span className="text-xs">全部</span>
        </button>
        {tags.length === 0 && !creating && (
          <div className="text-xs text-ink-muted text-center py-3">还没有标签</div>
        )}
        {tags.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition ${
              selectedTagId === t.id ? "bg-primary/15 text-primary" : "hover:bg-surface-base text-ink-primary"
            }`}
            onClick={() => onSelect(t.id)}
          >
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.color }} />
            <span className="text-xs truncate flex-1">{t.name}</span>
            <span className="text-xs text-ink-muted">{t.count}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                deleteTag(t.id, t.name);
              }}
              className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-danger/10 rounded transition text-danger"
              title="删除"
              aria-label="删除标签"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 单个草稿标签编辑弹窗 */
export function TagsEditor({
  draftId,
  onClose,
  onSaved,
}: {
  draftId: number;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [allTags, setAllTags] = useState<UserTag[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      authFetch(`${BASE}/v1/tags`).then((r) => r.json()),
      authFetch(`${BASE}/v1/drafts/${draftId}/tags`).then((r) => r.json()),
    ]).then(([all, mine]) => {
      setAllTags(all);
      setSelected(new Set(mine.map((t: UserTag) => t.id)));
    });
  }, [draftId]);

  function toggle(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  async function save() {
    setSaving(true);
    const res = await authFetch(`${BASE}/v1/drafts/${draftId}/tags`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag_ids: [...selected] }),
    });
    setSaving(false);
    if (res.ok) {
      onSaved?.();
      onClose();
    } else notifyError("保存失败");
  }

  const footer = (
    <div className="flex gap-2 w-full">
      <Button variant="secondary" size="md" onClick={onClose} className="flex-1">取消</Button>
      <Button variant="primary" size="md" onClick={save} loading={saving} className="flex-1">保存</Button>
    </div>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <TagIcon className="w-4 h-4" />
          编辑标签
        </span>
      }
      size="sm"
      footer={footer}
    >
      <div className="max-h-60 overflow-auto space-y-1">
        {allTags.length === 0 ? (
          <div className="text-sm text-ink-muted text-center py-6">还没创建过标签,请先到侧边栏创建</div>
        ) : (
          allTags.map((t) => (
            <label
              key={t.id}
              className="flex items-center gap-2 px-2 py-1.5 hover:bg-surface-base rounded cursor-pointer text-ink-primary"
            >
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => toggle(t.id)}
                className="accent-primary"
              />
              <div className="w-3 h-3 rounded-full" style={{ background: t.color }} />
              <span className="text-sm">{t.name}</span>
            </label>
          ))
        )}
      </div>
    </Modal>
  );
}
