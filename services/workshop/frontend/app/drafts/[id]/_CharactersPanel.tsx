"use client";
/**
 * 角色管理 Panel (Phase 5 §12.6.1)
 *
 * 功能:
 *  - 列表展示草稿下的所有角色 (头像 + 名称 + role + traits)
 *  - 新建/编辑/删除 角色 (Modal)
 *  - 关系列表展示 (from→to + relation_type + strength)
 *  - 一致性警告列表 (resolved 切换)
 */
import { useEffect, useState } from "react";
import { Plus, Edit3, Trash2, Sparkles, Users, AlertTriangle, RefreshCw } from "lucide-react";
import {
  phase5Characters,
  phase5Relationships,
  phase5Warnings,
  type Character,
  type Relationship,
} from "@/lib/phase5";
import { Button, Card, Modal, Input, Textarea, Badge, EmptyState, Spinner, IconButton, Avatar, TagChip } from "@/components/ui";
import { confirmAsync } from "@/lib/dialog";
import { notifyError, notifySuccess } from "@/lib/dialog";
import { RelationshipGraph } from "@/components/charts/RelationshipGraph";

export function CharactersPanel({ draftId }: { draftId: number }) {
  const [chars, setChars] = useState<Character[]>([]);
  const [rels, setRels] = useState<Relationship[]>([]);
  const [warnings, setWarnings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Character | null>(null);
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [c, r, w] = await Promise.all([
        phase5Characters.list(draftId),
        phase5Relationships.list(draftId),
        phase5Warnings.list(draftId),
      ]);
      setChars(c.items);
      setRels(r.items);
      setWarnings(w.items);
    } catch (e: any) {
      notifyError(`加载失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [draftId]);

  /** §12.6.7 触发后端启发式角色一致性扫描, 完成后轮询一次 warnings */
  async function handleScan() {
    setScanning(true);
    try {
      await phase5Warnings.scan(draftId);
      notifySuccess("扫描已触发, 数秒后自动刷新告警列表");
      // 简单延迟后刷新
      setTimeout(async () => {
        try {
          const w = await phase5Warnings.list(draftId);
          setWarnings(w.items);
        } catch {}
        setScanning(false);
      }, 3000);
    } catch (e: any) {
      notifyError(`扫描失败: ${e?.message || e}`);
      setScanning(false);
    }
  }

  async function handleResolveWarning(wid: number) {
    try {
      await phase5Warnings.resolve(draftId, wid);
      setWarnings(prev => prev.map(w => w.id === wid ? { ...w, resolved: true } : w));
    } catch (e: any) {
      notifyError(`操作失败: ${e?.message || e}`);
    }
  }

  async function handleDelete(c: Character) {
    if (!(await confirmAsync({ title: `删除角色 ${c.name}？`, tone: "danger", confirmText: "删除" }))) return;
    try {
      await phase5Characters.remove(draftId, c.id);
      notifySuccess("已删除");
      refresh();
    } catch (e: any) {
      notifyError(`删除失败: ${e?.message || e}`);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Spinner /></div>;
  }

  return (
    <div className="space-y-4">
      {/* 头部操作 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-primary flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" /> 角色卡库
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            共 {chars.length} 名角色 · {rels.length} 条关系
            {warnings.filter((w) => !w.resolved).length > 0 && (
              <span className="ml-2 text-warning">⚠ {warnings.filter((w) => !w.resolved).length} 条一致性警告</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={refresh}>
            刷新
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<AlertTriangle className="w-3.5 h-3.5" />}
            onClick={handleScan}
            loading={scanning}
            disabled={chars.length === 0}
            title="启动启发式角色一致性扫描, 比对每章描写是否与角色设定冲突"
          >
            一致性扫描
          </Button>
          <Button variant="primary" size="sm" leftIcon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreating(true)}>
            新建角色
          </Button>
        </div>
      </div>

      {/* 角色列表 */}
      {chars.length === 0 ? (
        <EmptyState
          icon={<Users className="w-10 h-10" />}
          title="还没有角色"
          description="点击右上角新建角色, 角色信息会用于 AI 一致性检测和角色头像生成"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {chars.map((c) => (
            <Card key={c.id} className="hover:border-primary/40 transition">
              <div className="p-4 flex gap-3">
                <Avatar src={c.avatar_url || undefined} name={c.name} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-ink-primary truncate">{c.name}</span>
                    {c.role && <Badge tone="primary" size="sm">{c.role}</Badge>}
                  </div>
                  {c.appearance && (
                    <p className="text-xs text-ink-secondary line-clamp-2 mb-1">外貌: {c.appearance}</p>
                  )}
                  {c.personality && (
                    <p className="text-xs text-ink-secondary line-clamp-2 mb-1">性格: {c.personality}</p>
                  )}
                  {c.traits && c.traits.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {c.traits.slice(0, 4).map((t) => (
                        <TagChip key={t} label={t} />
                      ))}
                    </div>
                  )}
                  <div className="flex gap-1 mt-3">
                    <IconButton size="sm" variant="ghost" onClick={() => setEditing(c)} aria-label="编辑">
                      <Edit3 className="w-3.5 h-3.5" />
                    </IconButton>
                    <IconButton size="sm" variant="ghost" onClick={() => handleDelete(c)} aria-label="删除">
                      <Trash2 className="w-3.5 h-3.5" />
                    </IconButton>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 关系网图 (PLAN §15 / 15 号设计图) — chars≥2 时展示 */}
      {chars.length >= 2 && (
        <Card>
          <div className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-ink-primary">关系网</h3>
            <div className="flex items-center justify-center bg-surface-base/40 rounded-lg p-2 border border-line">
              <RelationshipGraph
                characters={chars.map((c) => ({
                  id: c.id,
                  name: c.name,
                  role: c.role,
                  avatar_url: c.avatar_url,
                }))}
                relationships={rels.map((r) => ({
                  from_character_id: r.from,
                  to_character_id: r.to,
                  relation_type: r.type,
                  strength: r.strength,
                  description: r.description,
                }))}
                size={520}
              />
            </div>
            {/* 颜色图例 */}
            <div className="mt-3 flex items-center gap-3 flex-wrap text-xs">
              <span className="text-ink-muted">边色:</span>
              {[
                { label: "家人", color: "#10b981" },
                { label: "恋人", color: "#ec4899" },
                { label: "朋友", color: "#3b82f6" },
                { label: "敌人", color: "#ef4444" },
                { label: "同事", color: "#94a3b8" },
                { label: "其他", color: "#7c3aed" },
              ].map((it) => (
                <span key={it.label} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block w-3 h-0.5 rounded"
                    style={{ background: it.color }}
                  />
                  <span className="text-ink-secondary">{it.label}</span>
                </span>
              ))}
              <span className="ml-auto text-ink-muted">主角=紫色虚线圈</span>
            </div>
          </div>
        </Card>
      )}

      {/* 关系列表 */}
      {rels.length > 0 && (
        <Card>
          <div className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-ink-primary">角色关系 ({rels.length})</h3>
            <div className="space-y-1">
              {rels.map((r) => {
                const from = chars.find((c) => c.id === r.from);
                const to = chars.find((c) => c.id === r.to);
                return (
                  <div key={r.id} className="flex items-center gap-2 text-sm py-1.5">
                    <span className="text-ink-primary">{from?.name || `#${r.from}`}</span>
                    <span className="text-ink-muted">→</span>
                    <span className="text-ink-primary">{to?.name || `#${r.to}`}</span>
                    <Badge tone="primary" size="sm">{r.type || "未命名"}</Badge>
                    <span className="text-xs text-ink-muted">强度 {r.strength}</span>
                    {r.description && <span className="text-xs text-ink-secondary">· {r.description}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* 一致性警告 */}
      {warnings.length > 0 && (
        <Card>
          <div className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-ink-primary flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              一致性警告 ({warnings.filter((w: any) => !w.resolved).length})
            </h3>
            <div className="space-y-2">
              {warnings.map((w: any) => (
                <div key={w.id} className={`p-3 rounded border ${w.resolved ? "border-line opacity-50" : "border-warning/40 bg-warning/5"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge tone={w.severity === "high" ? "danger" : w.severity === "medium" ? "warning" : "muted"} size="sm">
                      {w.severity}
                    </Badge>
                    <span className="font-semibold text-sm text-ink-primary">{w.character_name}</span>
                    <span className="text-xs text-ink-muted">章节 {(w.chapter_orders || []).join(",")}</span>
                  </div>
                  <p className="text-xs text-ink-primary">{w.description}</p>
                  {w.suggestion && <p className="text-xs text-ink-secondary mt-1">建议: {w.suggestion}</p>}
                  {!w.resolved && (
                    <div className="mt-2">
                      <Button size="sm" variant="ghost" onClick={() => handleResolveWarning(w.id)}>
                        标记为已解决
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* 创建/编辑 modal */}
      {(creating || editing) && (
        <CharacterEditModal
          draftId={draftId}
          character={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CharacterEditModal({
  draftId,
  character,
  onClose,
  onSaved,
}: {
  draftId: number;
  character: Character | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!character;
  const [name, setName] = useState(character?.name || "");
  const [role, setRole] = useState(character?.role || "");
  const [appearance, setAppearance] = useState(character?.appearance || "");
  const [personality, setPersonality] = useState(character?.personality || "");
  const [backstory, setBackstory] = useState(character?.backstory || "");
  const [traitsText, setTraitsText] = useState((character?.traits || []).join(", "));
  const [avatarUrl, setAvatarUrl] = useState(character?.avatar_url || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) {
      notifyError("请填写角色名");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        role: role.trim(),
        appearance: appearance.trim(),
        personality: personality.trim(),
        backstory: backstory.trim(),
        avatar_url: avatarUrl.trim(),
        traits: traitsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        sort_order: character?.sort_order || 0,
      };
      if (isEdit) {
        await phase5Characters.update(draftId, character!.id, body);
      } else {
        await phase5Characters.create(draftId, body);
      }
      notifySuccess(isEdit ? "已更新" : "已创建");
      onSaved();
    } catch (e: any) {
      notifyError(`保存失败: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? `编辑角色: ${character!.name}` : "新建角色"} size="lg">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-ink-secondary">角色名 *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如: 林清欢" />
          </div>
          <div>
            <label className="text-xs text-ink-secondary">角色定位</label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如: 女主 / 男主 / 反派" />
          </div>
        </div>
        <div>
          <label className="text-xs text-ink-secondary">外貌描述</label>
          <Textarea value={appearance} onChange={(e) => setAppearance(e.target.value)} rows={2} placeholder="身高、长相、衣着特征..." />
        </div>
        <div>
          <label className="text-xs text-ink-secondary">性格描述</label>
          <Textarea value={personality} onChange={(e) => setPersonality(e.target.value)} rows={2} placeholder="性格特征、说话风格..." />
        </div>
        <div>
          <label className="text-xs text-ink-secondary">背景故事</label>
          <Textarea value={backstory} onChange={(e) => setBackstory(e.target.value)} rows={3} placeholder="角色背景、成长经历..." />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-ink-secondary">标签 (逗号分隔)</label>
            <Input value={traitsText} onChange={(e) => setTraitsText(e.target.value)} placeholder="冷静, 聪明, 善良" />
          </div>
          <div>
            <label className="text-xs text-ink-secondary">头像 URL (可手填或后续 image2 生成)</label>
            <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://..." />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {isEdit ? "保存修改" : "创建角色"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
