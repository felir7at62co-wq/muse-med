"use client";
import { useEffect, useState, useRef } from "react";
import { confirmAsync, notifyError, notifySuccess } from "@/lib/dialog";
import { Sparkles, Check, Edit3, MessageCircle, Trash2, AlertTriangle, FileText, X, Plus } from "lucide-react";
import { authFetch } from "../../../lib/auth";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Candidate = {
  id: number;
  batch_id: number;
  model_provider: string;
  style_description: string | null;
  user_style_preference: string | null;
  outline: any;
  is_selected: boolean;
  status: "generating" | "ready" | "failed";
  error_message?: string;
  created_at: string;
  updated_at: string;
};

/** 结构化的大纲编辑器,对用户友好 — Phase 3 重做版,接入 UI Kit 表单组件 */
function OutlineFormEditor({
  value, onChange,
}: {
  value: any;
  onChange: (newVal: any) => void;
}) {
  const outline = value || {};
  const chars = outline.characters || [];
  const chapters = outline.chapters || [];

  function update<K extends string>(key: K, v: any) {
    onChange({ ...outline, [key]: v });
  }

  function updateWorld(k: string, v: any) {
    onChange({ ...outline, world: { ...(outline.world || {}), [k]: v } });
  }

  function updateCharacter(idx: number, key: string, v: any) {
    const next = [...chars];
    next[idx] = { ...next[idx], [key]: v };
    update("characters", next);
  }
  function deleteCharacter(idx: number) {
    update("characters", chars.filter((_: any, i: number) => i !== idx));
  }
  function addCharacter() {
    update("characters", [...chars, { name: "新角色", role: "配角", traits: [], appearance: "" }]);
  }

  function updateChapter(idx: number, key: string, v: any) {
    const next = [...chapters];
    next[idx] = { ...next[idx], [key]: v };
    update("chapters", next);
  }
  function deleteChapter(idx: number) {
    const next = chapters.filter((_: any, i: number) => i !== idx);
    next.forEach((ch: any, i: number) => { ch.order = i + 1; });
    update("chapters", next);
  }
  function addChapter() {
    const next = [...chapters, {
      order: chapters.length + 1,
      title: `第${chapters.length + 1}集`,
      synopsis: "",
      must_have: [],
      characters: [],
    }];
    update("chapters", next);
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="text-xs text-primary mb-1 block">📖 剧名</label>
        <Input
          value={outline.title || ""}
          onChange={(e) => update("title", e.target.value)}
          size="sm"
        />
      </div>

      <div>
        <label className="text-xs text-primary mb-1 block">📝 全剧梗概</label>
        <Textarea
          value={outline.synopsis || ""}
          onChange={(e) => update("synopsis", e.target.value)}
          rows={3}
        />
      </div>

      <div className="border border-line rounded p-2">
        <div className="text-xs text-primary mb-2">🌍 世界观</div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="text-xs text-ink-muted">时代</label>
            <Input
              value={outline.world?.era || ""}
              onChange={(e) => updateWorld("era", e.target.value)}
              size="sm"
            />
          </div>
          <div>
            <label className="text-xs text-ink-muted">背景设定</label>
            <Input
              value={outline.world?.setting || ""}
              onChange={(e) => updateWorld("setting", e.target.value)}
              size="sm"
            />
          </div>
        </div>
        <label className="text-xs text-ink-muted">规则(每行一条)</label>
        <Textarea
          value={(outline.world?.rules || []).join("\n")}
          onChange={(e) => updateWorld("rules", e.target.value.split("\n").filter(l => l.trim()))}
          rows={2}
          placeholder="如:修仙者寿元三百年&#10;金钱不能兑换神器"
        />
        {/* 2026-11-04：与「规则」分开的一格 —— 混在一起时模型会把"不能出现的东西"
            当成"要写出来的规则"，写进正文。 */}
        <label className="text-xs text-ink-muted mt-2 block">不出现的元素(每行一条)</label>
        <Textarea
          value={(outline.world?.rules_forbidden || []).join("\n")}
          onChange={(e) => updateWorld("rules_forbidden", e.target.value.split("\n").filter(l => l.trim()))}
          rows={2}
          placeholder="如:没有超自然力量&#10;不出现真实企业名"
        />
      </div>

      {/* 2026-11-04：立项信息（剧名/一句话/受众/卖点/题材定位）。
          这些是立项时就该定下来的东西，此前只存在于故事圣经里、界面上完全看不到，
          用户也没法改 —— 而它们直接决定大纲"这一集给谁看、要兑现哪种爽点"。 */}
      <div className="border border-line rounded p-2">
        <div className="text-xs text-primary mb-2">🎯 立项信息</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-ink-muted">剧名</label>
            <Input value={outline.title || ""} onChange={(e) => update("title", e.target.value)} size="sm" />
          </div>
          <div>
            <label className="text-xs text-ink-muted">题材定位</label>
            <Input value={outline.tone || ""} onChange={(e) => update("tone", e.target.value)} size="sm" />
          </div>
        </div>
        <label className="text-xs text-ink-muted mt-2 block">一句话故事</label>
        <Textarea value={outline.one_liner || ""} onChange={(e) => update("one_liner", e.target.value)} rows={2} />
        <label className="text-xs text-ink-muted mt-2 block">目标受众(性别 / 年龄 / 观看场景 / 想被满足的情绪)</label>
        <div className="grid grid-cols-2 gap-2">
          <Input size="sm" placeholder="女频" value={outline.audience?.gender || ""}
            onChange={(e) => onChange({ ...outline, audience: { ...(outline.audience || {}), gender: e.target.value } })} />
          <Input size="sm" placeholder="25-45" value={outline.audience?.age || ""}
            onChange={(e) => onChange({ ...outline, audience: { ...(outline.audience || {}), age: e.target.value } })} />
          <Input size="sm" placeholder="通勤/睡前" value={outline.audience?.scene || ""}
            onChange={(e) => onChange({ ...outline, audience: { ...(outline.audience || {}), scene: e.target.value } })} />
          <Input size="sm" placeholder="想看被欺负的人当众翻盘" value={outline.audience?.craving || ""}
            onChange={(e) => onChange({ ...outline, audience: { ...(outline.audience || {}), craving: e.target.value } })} />
        </div>
        <label className="text-xs text-ink-muted mt-2 block">核心卖点(每行一条)</label>
        <Textarea
          value={(outline.selling_points || []).join("\n")}
          onChange={(e) => update("selling_points", e.target.value.split("\n").map(x => x.trim()).filter(Boolean))}
          rows={3}
          placeholder="如:真假千金身份大反转&#10;禁欲系大佬无底线独宠"
        />
      </div>

      <div className="border border-line rounded p-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-primary">👥 人物 ({chars.length})</span>
          <Button variant="primary" size="sm" leftIcon={<Plus className="w-3 h-3" />} onClick={addCharacter}>
            添加
          </Button>
        </div>
        <div className="space-y-2">
          {chars.map((ch: any, i: number) => (
            <div key={i} className="p-2 bg-surface-base border border-line rounded">
              <div className="flex items-center gap-1 mb-1">
                <Input
                  value={ch.name || ""}
                  onChange={(e) => updateCharacter(i, "name", e.target.value)}
                  placeholder="姓名"
                  size="sm"
                  className="flex-1"
                />
                <Select
                  value={ch.role || "配角"}
                  onChange={(e) => updateCharacter(i, "role", e.target.value)}
                  size="sm"
                  className="w-20"
                >
                  <option>主角</option>
                  <option>反派</option>
                  <option>配角</option>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<X className="w-3 h-3 text-danger" />}
                  onClick={() => deleteCharacter(i)}
                  className="hover:bg-danger/10"
                >
                  <span className="sr-only">删除</span>
                </Button>
              </div>
              <Input
                value={(ch.traits || []).join(", ")}
                onChange={(e) => updateCharacter(i, "traits", e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                placeholder="特点(逗号分隔,如:聪明,孤傲)"
                size="sm"
                className="mb-1"
              />
              <Textarea
                value={ch.appearance || ""}
                onChange={(e) => updateCharacter(i, "appearance", e.target.value)}
                placeholder="外貌描述"
                rows={2}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="border border-line rounded p-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-primary">📖 分集 ({chapters.length})</span>
          <Button variant="primary" size="sm" leftIcon={<Plus className="w-3 h-3" />} onClick={addChapter}>
            添加
          </Button>
        </div>
        <div className="space-y-2 max-h-80 overflow-auto">
          {chapters.map((ch: any, i: number) => (
            <div key={i} className="p-2 bg-surface-base border border-line rounded">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-xs text-ink-muted px-1 whitespace-nowrap">第{ch.order || i + 1}集</span>
                <Input
                  value={ch.title || ""}
                  onChange={(e) => updateChapter(i, "title", e.target.value)}
                  placeholder="集标题"
                  size="sm"
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<X className="w-3 h-3 text-danger" />}
                  onClick={() => deleteChapter(i)}
                  className="hover:bg-danger/10"
                >
                  <span className="sr-only">删除</span>
                </Button>
              </div>
              <Textarea
                value={ch.synopsis || ""}
                onChange={(e) => updateChapter(i, "synopsis", e.target.value)}
                placeholder="本集剧情"
                rows={2}
                className="mb-1"
              />
              <Textarea
                value={(ch.must_have || []).join("\n")}
                onChange={(e) => updateChapter(i, "must_have", e.target.value.split("\n").filter(l => l.trim()))}
                placeholder="必含事件(每行一条)"
                rows={2}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 多模型大纲预览面板 — Phase 3 重做版,接入 UI Kit。
 *
 * 后端: /v1/stages/drafts/{id}/preview/* (models/candidates/status/generate/select 等)
 *
 * 工作流:
 *   1) 输入剧情概要 + 选文风
 *   2) 多模型并行生成大纲候选
 *   3) 用户选采用某个版本 (如有下游章节/剧本会确认丢弃)
 *   4) 可对单个候选编辑 / 意见重写 / 删除
 */
export function PreviewPanel({
  draftId,
  onSelected,
  userInput,
  onUserInputChange,
}: {
  draftId: number;
  onSelected?: () => void;
  userInput?: string;
  onUserInputChange?: (v: string) => Promise<void>;
}) {
  const [models, setModels] = useState<any[]>([]);
  const [stylePresets, setStylePresets] = useState<string[]>([]);
  const [stylePref, setStylePref] = useState("默认");
  const [customStyle, setCustomStyle] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [batches, setBatches] = useState<number[]>([]);
  const [currentBatch, setCurrentBatch] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [editForm, setEditForm] = useState<Record<number, any>>({});
  const [feedbackOpen, setFeedbackOpen] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [rewriteLoading, setRewriteLoading] = useState<number | null>(null);
  const [pendingSelectCid, setPendingSelectCid] = useState<number | null>(null);
  const [downstreamCount, setDownstreamCount] = useState<{chapter_count: number, storyboard_count: number} | null>(null);
  const [inputEdit, setInputEdit] = useState(userInput || "");
  const [inputDirty, setInputDirty] = useState(false);
  const [syncHint, setSyncHint] = useState("");
  const pollingRef = useRef<any>(null);
  const sigStorageKey = (cid: number) => `previewOutlineSig:${draftId}:${cid}`;

  useEffect(() => {
    setInputEdit(userInput || "");
    setInputDirty(false);
  }, [userInput]);

  async function fetchModels() {
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/models`);
    if (res.ok) {
      const d = await res.json();
      setModels(d.models || []);
      setStylePresets(d.style_presets || []);
    }
  }

  async function fetchCandidates() {
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/candidates`);
    if (res.ok) {
      const d = await res.json();
      const items: Candidate[] = d.items || [];
      setCandidates(items);
      setBatches(d.batches || []);
      if (currentBatch === null && d.latest_batch) setCurrentBatch(d.latest_batch);

      const selected = items.find((c) => c.is_selected && c.status === "ready");
      if (selected && typeof window !== "undefined") {
        const sig = JSON.stringify(selected.outline || {});
        const key = sigStorageKey(selected.id);
        const prev = sessionStorage.getItem(key);
        if (prev !== null && prev !== sig && !editing[selected.id]) {
          setSyncHint("📥 检测到大纲页已更新,预览内容已自动同步");
          setTimeout(() => setSyncHint(""), 4000);
        }
        sessionStorage.setItem(key, sig);
      }
      if (typeof window !== "undefined") {
        items.forEach((c) => {
          if (c.status === "ready") {
            const k = sigStorageKey(c.id);
            if (sessionStorage.getItem(k) === null) {
              sessionStorage.setItem(k, JSON.stringify(c.outline || {}));
            }
          }
        });
      }
    }
  }

  async function fetchStatus() {
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/status`);
    if (res.ok) {
      const d = await res.json();
      setIsGenerating(!d.is_idle);
      return d.is_idle;
    }
    return true;
  }

  function startPolling() {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      const idle = await fetchStatus();
      await fetchCandidates();
      if (idle) stopPolling();
    }, 3000);
  }
  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  useEffect(() => {
    fetchModels();
    fetchCandidates();
    fetchStatus();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  async function saveInputIfDirty() {
    if (inputDirty && onUserInputChange) {
      await onUserInputChange(inputEdit);
      setInputDirty(false);
    }
  }

  async function handleGenerate() {
    await saveInputIfDirty();
    const styleToSend = customStyle.trim() || (stylePref === "默认" ? null : stylePref);
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style_preference: styleToSend }),
    });
    if (res.ok) {
      const d = await res.json();
      setCurrentBatch(d.batch_id);
      setIsGenerating(true);
      fetchCandidates();
      startPolling();
    } else {
      const err = await res.json().catch(() => ({}));
      notifyError(err.detail || "生成失败");
    }
  }

  async function handleSaveEdit(cid: number) {
    const outline = editForm[cid];
    if (!outline) return;
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/candidates/${cid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outline }),
    });
    if (res.ok) {
      const data = await res.json();
      setEditing({ ...editing, [cid]: false });
      if (data.synced_to_draft) {
        setSyncHint("✅ 已同步到大纲页,相关章节/剧本已标记为过期");
        setTimeout(() => setSyncHint(""), 4000);
      }
      fetchCandidates();
      onSelected?.();
    } else notifyError("保存失败");
  }

  async function handleRewrite(cid: number) {
    if (!feedbackText.trim() || rewriteLoading !== null) return;
    setRewriteLoading(cid);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/candidates/${cid}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedbackText }),
      });
      if (res.ok) {
        setFeedbackOpen(null);
        setFeedbackText("");
        await fetchCandidates();
        onSelected?.();
        notifySuccess("已按意见重写");
      } else {
        const d = await res.json().catch(() => ({}));
        notifyError(d?.message || d?.detail || "重写失败");
      }
    } catch (e: any) {
      notifyError(e?.message || "重写失败");
    } finally {
      setRewriteLoading(null);
    }
  }

  async function handleSelect(cid: number, confirmed = false) {
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/candidates/${cid}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_discard_downstream: confirmed }),
    });
    const d = await res.json();
    if (res.ok && d.ok) {
      notifySuccess("已采用此候选,正在跳转大纲页…");
      onSelected?.();
    } else if (d.need_confirm) {
      setPendingSelectCid(cid);
      setDownstreamCount(d.downstream);
    } else {
      notifyError(d.message || "采用失败");
    }
  }

  async function handleDelete(cid: number) {
    if (!(await confirmAsync({ title: "删除此候选", tone: "danger", confirmText: "删除" }))) return;
    const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/preview/candidates/${cid}`, {
      method: "DELETE",
    });
    if (res.ok) fetchCandidates();
  }

  const currentBatchCands = candidates.filter((c) => c.batch_id === currentBatch);
  const modelLabel = (p: string) => models.find((m) => m.provider === p)?.name || p;

  return (
    <div className="space-y-4">
      {syncHint && (
        <div className="p-2 bg-success/10 border border-success/40 text-success text-sm rounded-lg">
          {syncHint}
        </div>
      )}

      {/* 生成控制区 */}
      <Card padding="md">
        <h3 className="text-lg font-semibold mb-3 flex items-center gap-2 text-ink-primary">
          <Sparkles className="w-5 h-5 text-primary" />
          多模型大纲预览
        </h3>

        {onUserInputChange && (
          <div className="mb-3">
            <label className="text-sm text-ink-secondary mb-1 block flex items-center gap-1">
              <FileText className="w-4 h-4" />
              剧情概要(修改后点击生成会按新梗概生成):
            </label>
            <Textarea
              value={inputEdit}
              onChange={(e) => { setInputEdit(e.target.value); setInputDirty(true); }}
              rows={3}
              placeholder="老刑警退休前办最后一案,凶手是徒弟…"
            />
            {inputDirty && (
              <div className="text-xs text-warning mt-1">⚠️ 剧情概要已修改,点"生成"按钮时会保存并按新梗概重新生成</div>
            )}
          </div>
        )}

        <div className="mb-3">
          <label className="text-sm text-ink-secondary mb-1 block">文风偏好(可选):</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {stylePresets.map((s) => (
              <Button
                key={s}
                variant={stylePref === s ? "primary" : "ghost"}
                size="sm"
                onClick={() => setStylePref(s)}
              >
                {s}
              </Button>
            ))}
          </div>
          <Input
            value={customStyle}
            onChange={(e) => setCustomStyle(e.target.value)}
            placeholder="或自定义文风描述(可选)"
            size="md"
          />
        </div>

        <Button
          variant="primary"
          size="md"
          loading={isGenerating}
          leftIcon={!isGenerating ? <Sparkles className="w-4 h-4" /> : undefined}
          onClick={handleGenerate}
        >
          {isGenerating ? "生成中(请耐心等待)…" : "🚀 生成大纲预览"}
        </Button>
      </Card>

      {/* 批次切换 */}
      {batches.length > 0 && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-ink-muted">批次:</span>
          {batches.map((b) => (
            <Button
              key={b}
              variant={currentBatch === b ? "primary" : "ghost"}
              size="sm"
              onClick={() => setCurrentBatch(b)}
            >
              第{b}批
            </Button>
          ))}
        </div>
      )}

      {/* 候选对比(左右) */}
      {currentBatchCands.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {currentBatchCands.map((c) => (
            <Card
              key={c.id}
              padding="md"
              className={c.is_selected ? "border-success ring-2 ring-success/30" : ""}
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-bold text-base text-ink-primary">
                  {c.model_provider === "gemini" ? "🌟" : "🧠"} {modelLabel(c.model_provider)}
                </h4>
                {c.is_selected && (
                  <Badge tone="success" size="sm" withDot>
                    当前采用
                  </Badge>
                )}
              </div>

              {c.status === "generating" && (
                <Badge tone="info" size="md" withDot>正在生成…</Badge>
              )}

              {c.status === "failed" && (
                <div className="p-2 bg-danger/10 border border-danger/40 rounded text-sm text-danger mb-3">
                  ❌ 失败: {c.error_message || "未知错误"}
                </div>
              )}

              {c.status === "ready" && (
                <>
                  {/* 重写失败时后端会保留原大纲、把原因挂在 error_message 上
                      （以前是直接把候选标成 failed，整份能用的大纲跟着"消失"）。 */}
                  {c.error_message && (
                    <div className="p-2 bg-warning/10 border border-warning/40 rounded text-xs text-warning mb-2">
                      ⚠️ {c.error_message.slice(0, 160)}
                    </div>
                  )}
                  {c.style_description && (
                    <div className="mb-2 text-xs text-ink-secondary">
                      <span className="text-primary">📝 文风:</span> {c.style_description}
                    </div>
                  )}

                  {editing[c.id] ? (
                    <OutlineFormEditor
                      value={editForm[c.id]}
                      onChange={(v) => setEditForm({ ...editForm, [c.id]: v })}
                    />
                  ) : (
                    <div className="bg-surface-base/60 rounded border border-line p-3 max-h-96 overflow-auto">
                      <div className="text-sm mb-2 text-ink-primary">
                        <b>{c.outline?.title || "(无标题)"}</b>
                      </div>
                      <div className="text-xs text-ink-secondary mb-2">{c.outline?.synopsis}</div>
                      {c.outline?.characters && (
                        <div className="text-xs mb-2">
                          <div className="text-primary mb-1">👥 人物:</div>
                          {c.outline.characters.map((p: any, i: number) => (
                            <div key={i} className="ml-2 text-ink-secondary">
                              • {p.name} ({p.role}): {(p.traits || []).join(", ")}
                            </div>
                          ))}
                        </div>
                      )}
                      {c.outline?.chapters && (
                        <div className="text-xs">
                          <div className="text-primary mb-1">📖 分集({c.outline.chapters.length}集):</div>
                          {c.outline.chapters.slice(0, 10).map((ch: any) => (
                            <div key={ch.order} className="ml-2 mb-1 text-ink-secondary">
                              <b className="text-ink-primary">第{ch.order}集·{ch.title}</b>: {ch.synopsis}
                            </div>
                          ))}
                          {c.outline.chapters.length > 10 && (
                            <div className="ml-2 text-ink-muted">… 还有{c.outline.chapters.length - 10}集</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {feedbackOpen === c.id && (
                    <div className="mt-3 p-2 bg-surface-base border border-primary/40 rounded">
                      <Textarea
                        value={feedbackText}
                        onChange={(e) => setFeedbackText(e.target.value)}
                        placeholder="例如:加强主角的痛苦经历;增加一个反派角色;节奏加快…"
                        rows={3}
                      />
                      <div className="flex gap-2 mt-2">
                        <Button
                          variant="primary"
                          size="sm"
                          loading={rewriteLoading === c.id}
                          disabled={!feedbackText.trim() || rewriteLoading !== null}
                          onClick={() => handleRewrite(c.id)}
                        >
                          {rewriteLoading === c.id ? "重写中（长剧要几分钟，请勿关闭）…" : "应用意见"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={rewriteLoading === c.id}
                          onClick={() => { setFeedbackOpen(null); setFeedbackText(""); }}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 mt-3">
                    {editing[c.id] ? (
                      <>
                        <Button variant="cyan" size="sm" onClick={() => handleSaveEdit(c.id)}>
                          💾 保存编辑
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditing({ ...editing, [c.id]: false })}>
                          取消
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          leftIcon={<Edit3 className="w-3 h-3" />}
                          onClick={() => {
                            setEditing({ ...editing, [c.id]: true });
                            setEditForm({ ...editForm, [c.id]: JSON.parse(JSON.stringify(c.outline || {})) });
                          }}
                        >
                          手动编辑
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          leftIcon={<MessageCircle className="w-3 h-3" />}
                          onClick={() => setFeedbackOpen(c.id)}
                        >
                          意见重写
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<Check className="w-3 h-3" />}
                          onClick={() => handleSelect(c.id)}
                        >
                          采用此版
                        </Button>
                        {!c.is_selected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Trash2 className="w-3 h-3 text-danger" />}
                            onClick={() => handleDelete(c.id)}
                            className="hover:bg-danger/10"
                          >
                            <span className="sr-only">删除</span>
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {candidates.length === 0 && (
        <Card padding="lg" className="text-center text-ink-secondary py-12">
          <Sparkles className="w-12 h-12 mx-auto mb-3 opacity-50 text-primary" />
          <p>尚未生成任何预览,点击上方按钮开始</p>
        </Card>
      )}

      {/* 采用确认 Modal — 用 UI Kit Modal */}
      <Modal
        open={pendingSelectCid !== null && !!downstreamCount}
        onClose={() => { setPendingSelectCid(null); setDownstreamCount(null); }}
        title={
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-warning" />
            确认替换大纲?
          </span>
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPendingSelectCid(null); setDownstreamCount(null); }}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingSelectCid !== null) handleSelect(pendingSelectCid, true);
                setPendingSelectCid(null);
                setDownstreamCount(null);
              }}
            >
              确认丢弃,采用新大纲
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-secondary mb-3">采用此预览大纲后,将会:</p>
        {downstreamCount && (
          <ul className="text-sm space-y-1">
            {downstreamCount.chapter_count > 0 && (
              <li className="text-danger">❌ 丢弃 {downstreamCount.chapter_count} 个已生成章节</li>
            )}
            {downstreamCount.storyboard_count > 0 && (
              <li className="text-danger">❌ 丢弃 {downstreamCount.storyboard_count} 个已生成剧本</li>
            )}
            <li className="text-success">✅ 新大纲替换当前大纲</li>
            <li className="text-success">✅ 旧大纲保留在历史版本中</li>
          </ul>
        )}
      </Modal>
    </div>
  );
}
