"use client";
/**
 * 角色设定（圣经）面板 — 解决续写时人设/立场漂移。
 *
 * - 展示从已写正文抽取的角色花名册 + 角色圣经（立场/性格/动机/关系/说话风格）。
 * - 用户可直接编辑并保存；抽取即默认生效，编辑保存后覆盖。
 * - 「重新抽取」按钮可从最新正文重抽。
 * 数据存于 outline.character_registry / outline.character_bible，续写时作为硬约束注入。
 */
import { useEffect, useState } from "react";
import { RefreshCw, Save, Users2, ScrollText } from "lucide-react";
import {
  characterBible,
  type BibleChar,
  type RegistryChar,
  type Stance,
} from "@/lib/characterBible";
import { Button, Card, Input, Badge, EmptyState, Spinner } from "@/components/ui";
import { notifyError, notifySuccess, confirmAsync } from "@/lib/dialog";

const STANCES: Stance[] = ["正", "反", "中立"];

function stanceTone(s: Stance): "success" | "danger" | "muted" {
  return s === "正" ? "success" : s === "反" ? "danger" : "muted";
}

export function CharacterBiblePanel({ draftId }: { draftId: number }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [bible, setBible] = useState<BibleChar[]>([]);
  const [registry, setRegistry] = useState<RegistryChar[]>([]);
  const [dirty, setDirty] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await characterBible.get(draftId);
      setBible(res.bible?.characters || []);
      setRegistry(res.registry?.characters || []);
      setDirty(false);
    } catch (e: any) {
      notifyError(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [draftId]);

  function patch(idx: number, field: keyof BibleChar, value: any) {
    setBible((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await characterBible.save(draftId, {
        bible: { characters: bible },
      });
      notifySuccess("角色设定已保存，将用于后续续写约束");
      setDirty(false);
    } catch (e: any) {
      notifyError(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleExtract() {
    if (bible.length > 0) {
      const ok = await confirmAsync({
        title: "重新抽取会覆盖当前设定？",
        description: "将从最新章节正文重新抽取角色花名册与人设，覆盖现有内容（含你的手动编辑）。",
        confirmText: "重新抽取",
        tone: "danger",
      });
      if (!ok) return;
    }
    setExtracting(true);
    try {
      const res = await characterBible.extract(draftId);
      setBible(res.bible?.characters || []);
      setRegistry(res.registry?.characters || []);
      setDirty(false);
      notifySuccess(`已抽取 ${res.count} 个角色`);
    } catch (e: any) {
      notifyError(e?.message || "抽取失败");
    } finally {
      setExtracting(false);
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Spinner /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink-primary flex items-center gap-2">
            <ScrollText className="w-5 h-5 text-primary" /> 角色设定（续写约束）
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            共 {bible.length} 个角色 · 立场/性格会作为硬约束注入续写，防止角色名漂移和人设反转
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${extracting ? "animate-spin" : ""}`} />}
            onClick={handleExtract}
            loading={extracting}
          >
            从正文重新抽取
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Save className="w-3.5 h-3.5" />}
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            保存设定
          </Button>
        </div>
      </div>

      {/* 花名册速览 */}
      {registry.length > 0 && (
        <Card>
          <div className="p-4">
            <h3 className="text-sm font-semibold mb-2 text-ink-primary flex items-center gap-2">
              <Users2 className="w-4 h-4 text-primary" /> 角色花名册（权威姓名）
            </h3>
            <div className="flex flex-wrap gap-2">
              {registry.map((c) => (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-base/60 border border-line text-xs"
                  title={c.one_line}
                >
                  <span className="font-medium text-ink-primary">{c.name}</span>
                  {c.aliases?.length > 0 && (
                    <span className="text-ink-muted">({c.aliases.join("/")})</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </Card>
      )}

      {bible.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="w-10 h-10" />}
          title="还没有角色设定"
          description="点击「从正文重新抽取」从已写章节自动生成角色花名册与人设；续写时会自动注入。"
        />
      ) : (
        <div className="space-y-3">
          {bible.map((c, idx) => (
            <Card key={`${c.name}-${idx}`}>
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    value={c.name}
                    onChange={(e) => patch(idx, "name", e.target.value)}
                    className="max-w-[160px] font-semibold"
                    placeholder="角色名"
                  />
                  <div className="flex gap-1">
                    {STANCES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => patch(idx, "stance", s)}
                        className={`px-2 py-1 rounded text-xs border transition ${
                          c.stance === s
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "border-line text-ink-secondary hover:border-primary/40"
                        }`}
                      >
                        {s}派
                      </button>
                    ))}
                  </div>
                  <Badge tone={stanceTone(c.stance)} size="sm">
                    立场：{c.stance}
                  </Badge>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-ink-secondary">性格（逗号分隔）</label>
                    <Input
                      value={(c.traits || []).join("，")}
                      onChange={(e) =>
                        patch(
                          idx,
                          "traits",
                          e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                        )
                      }
                      placeholder="隐忍，护短，表面冷漠"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-ink-secondary">说话风格</label>
                    <Input
                      value={c.speech_style || ""}
                      onChange={(e) => patch(idx, "speech_style", e.target.value)}
                      placeholder="话少，命令式短句"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-ink-secondary">核心动机</label>
                    <Input
                      value={c.motivation || ""}
                      onChange={(e) => patch(idx, "motivation", e.target.value)}
                      placeholder="查清母亲死因"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-ink-secondary">与主角关系</label>
                    <Input
                      value={c.relation || ""}
                      onChange={(e) => patch(idx, "relation", e.target.value)}
                      placeholder="苏晚的契约丈夫"
                    />
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {dirty && (
        <p className="text-xs text-warning">有未保存的修改，记得点「保存设定」。</p>
      )}
    </div>
  );
}