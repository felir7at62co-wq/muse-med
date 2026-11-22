"use client";
import { useState, useEffect, useCallback } from "react";
import { XCircle, Loader2, Send, CheckCircle, AlertCircle, Trash2 } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { getToken } from "../../../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

type DistTarget = {
  id: number;
  name: string;
  url: string;
  field_mapping: Record<string, string>;
};

type PrecheckScript = {
  id: number;
  product_type?: string;
  title: string;
  status: string;
  episodes: number;
  completed_episodes: number;
  episodes_ok: boolean;
  source_label?: string;
  protagonist?: string;
  distributed_to: string[];
};

const ELEMENT_LABELS: Record<string, string> = {
  title: "剧名",
  script: "剧本",
  genre: "类型",
  outline: "大纲(初始创意)",
};

/**
 * 分发弹窗 — 两个子窗口(Tab):
 * 1. 分发确认: 检查剧本数量/集数达标 → 勾选剧本 → 选"分发给谁" → 确认分发
 * 2. 目标配置: 配置飞书多维表格链接 + 字段映射 + 命名(同步到Tab1下拉)
 */
export function DistributeModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const authHeaders = () => ({
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  });

  const [tab, setTab] = useState<"send" | "config">("send");
  const [targets, setTargets] = useState<DistTarget[]>([]);
  const [precheck, setPrecheck] = useState<{ target_scripts?: number; target_episodes?: number; scripts: PrecheckScript[] } | null>(null);
  const [loading, setLoading] = useState(true);

  // Tab1 状态
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null);
  const [selectedScripts, setSelectedScripts] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<any>(null);

  // Tab2 状态
  const [editingId, setEditingId] = useState<number | null>(null); // null=新建
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formMapping, setFormMapping] = useState<Record<string, string>>({ title: "", script: "", genre: "", outline: "" });
  const [feishuFields, setFeishuFields] = useState<{ name: string; type: number }[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [tr, pr] = await Promise.all([
        fetch(`${API}/dist-targets`, { headers: authHeaders() }),
        fetch(`${API}/jobs/${jobId}/dist-precheck`, { headers: authHeaders() }),
      ]);
      if (tr.ok) {
        const ts = await tr.json();
        setTargets(ts);
        if (ts.length > 0) setSelectedTargetId((prev) => prev ?? ts[0].id);
      }
      if (pr.ok) {
        const p = await pr.json();
        setPrecheck(p);
        // 默认勾选所有completed剧本
        setSelectedScripts(new Set(
          (p.scripts || []).filter((s: PrecheckScript) => s.status === "completed").map((s: PrecheckScript) => s.id)
        ));
      }
    } catch (e) {
      console.error("load distribute data failed:", e);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { loadAll(); }, [loadAll]);


  // ===== Tab2: 校验链接并拉表头 =====
  const handlePreview = async () => {
    setPreviewing(true);
    setPreviewErr("");
    setFeishuFields([]);
    try {
      const r = await fetch(`${API}/dist-targets/preview`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: formName || "预览", url: formUrl, field_mapping: {} }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "校验失败" }));
        throw new Error(err.detail || "校验失败");
      }
      const data = await r.json();
      setFeishuFields(data.fields || []);
      // 自动匹配同名表头
      const names = (data.fields || []).map((f: any) => f.name);
      setFormMapping((prev) => {
        const next = { ...prev };
        const auto: Record<string, string> = { title: "剧名", script: "剧本", genre: "类型", outline: "大纲" };
        for (const k of Object.keys(auto)) {
          if (!next[k] && names.includes(auto[k])) next[k] = auto[k];
        }
        return next;
      });
    } catch (e: any) {
      setPreviewErr(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const handleSaveTarget = async () => {
    if (!formName.trim() || !formUrl.trim()) {
      alert("请填写分发对象名称和飞书链接");
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({ name: formName, url: formUrl, field_mapping: formMapping });
      const r = editingId
        ? await fetch(`${API}/dist-targets/${editingId}`, { method: "PUT", headers: authHeaders(), body })
        : await fetch(`${API}/dist-targets`, { method: "POST", headers: authHeaders(), body });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "保存失败" }));
        throw new Error(err.detail || "保存失败");
      }
      const saved = await r.json();
      alert(`✅ 已保存分发目标「${saved.name}」`);
      setEditingId(null);
      setFormName("");
      setFormUrl("");
      setFormMapping({ title: "", script: "", genre: "", outline: "" });
      setFeishuFields([]);
      await loadAll();
      setTab("send");
    } catch (e: any) {
      alert(`❌ 保存失败: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleEditTarget = (t: DistTarget) => {
    setEditingId(t.id);
    setFormName(t.name);
    setFormUrl(t.url);
    setFormMapping({ title: "", script: "", genre: "", outline: "", ...(t.field_mapping || {}) });
    setFeishuFields([]);
    setPreviewErr("");
  };

  const handleDeleteTarget = async (t: DistTarget) => {
    if (!confirm(`确认删除分发目标「${t.name}」？`)) return;
    try {
      const r = await fetch(`${API}/dist-targets/${t.id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error("删除失败");
      await loadAll();
    } catch (e: any) {
      alert(`❌ ${e.message}`);
    }
  };

  // ===== Tab1: 分发 =====
  const handleDistribute = async () => {
    if (!selectedTargetId) {
      alert("请先选择分发给谁(无可选项时请先到「目标配置」新建)");
      return;
    }
    if (selectedScripts.size === 0) {
      alert("请至少勾选一部剧本");
      return;
    }
    const target = targets.find((t) => t.id === selectedTargetId);
    if (!confirm(`将 ${selectedScripts.size} 部剧本分发给「${target?.name}」，确认？`)) return;
    setSending(true);
    setSendResult(null);
    try {
      const r = await fetch(`${API}/jobs/${jobId}/distribute`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ target_id: selectedTargetId, script_ids: Array.from(selectedScripts) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "分发失败");
      setSendResult(data);
      await loadAll();
    } catch (e: any) {
      alert(`❌ 分发失败: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  const toggleScript = (id: number) => {
    setSelectedScripts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 + Tab切换 */}
        <div className="p-4 border-b border-line flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Send className="w-5 h-5 text-primary" /> 分发到飞书
            </h3>
            <div className="flex gap-1">
              <button
                onClick={() => setTab("send")}
                className={`px-3 py-1 rounded-full text-sm border ${tab === "send" ? "bg-primary text-white border-primary" : "border-line text-ink-secondary"}`}
              >
                ① 分发确认
              </button>
              <button
                onClick={() => setTab("config")}
                className={`px-3 py-1 rounded-full text-sm border ${tab === "config" ? "bg-primary text-white border-primary" : "border-line text-ink-secondary"}`}
              >
                ② 目标配置
              </button>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
          ) : tab === "send" ? (
            <SendTab
              precheck={precheck}
              targets={targets}
              selectedTargetId={selectedTargetId}
              setSelectedTargetId={setSelectedTargetId}
              selectedScripts={selectedScripts}
              toggleScript={toggleScript}
              sending={sending}
              sendResult={sendResult}
              onDistribute={handleDistribute}
              gotoConfig={() => setTab("config")}
            />
          ) : (
            <ConfigTab
              targets={targets}
              editingId={editingId}
              formName={formName} setFormName={setFormName}
              formUrl={formUrl} setFormUrl={setFormUrl}
              formMapping={formMapping} setFormMapping={setFormMapping}
              feishuFields={feishuFields}
              previewing={previewing} previewErr={previewErr}
              saving={saving}
              onPreview={handlePreview}
              onSave={handleSaveTarget}
              onEdit={handleEditTarget}
              onDelete={handleDeleteTarget}
              onNew={() => { setEditingId(null); setFormName(""); setFormUrl(""); setFormMapping({ title: "", script: "", genre: "", outline: "" }); setFeishuFields([]); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}


// 子窗口1: 分发确认
function SendTab({
  precheck, targets, selectedTargetId, setSelectedTargetId,
  selectedScripts, toggleScript, sending, sendResult, onDistribute, gotoConfig,
}: any) {
  const scripts: PrecheckScript[] = precheck?.scripts || [];
  const completedCount = scripts.filter((s) => s.status === "completed").length;
  const okCount = scripts.filter((s) => s.episodes_ok).length;
  const targetScripts = precheck?.target_scripts;

  // 按产物类型分组(剧本/小说/推文)
  const TYPE_META: Record<string, { label: string; unit: string; badge: string }> = {
    script: { label: "剧本", unit: "集", badge: "bg-blue-500" },
    novel: { label: "小说", unit: "章", badge: "bg-purple-500" },
    tweet: { label: "推文", unit: "章", badge: "bg-amber-500" },
  };
  const groups = ["script", "novel", "tweet"]
    .map((t) => ({
      type: t,
      meta: TYPE_META[t],
      items: scripts.filter((s) => (s.product_type || "script") === t),
    }))
    .filter((g) => g.items.length > 0);

  const groupToggleAll = (items: PrecheckScript[]) => {
    const ids = items.filter((s) => s.status === "completed").map((s) => s.id);
    const allSelected = ids.every((id: number) => selectedScripts.has(id));
    ids.forEach((id: number) => {
      if (allSelected === selectedScripts.has(id)) toggleScript(id);
    });
  };

  return (
    <div className="space-y-4">
      {/* 总体达标情况 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 bg-surface-elevated rounded-lg text-center">
          <div className="text-2xl font-semibold">{completedCount}{targetScripts ? `/${targetScripts}` : ""}</div>
          <div className="text-xs text-ink-secondary mt-1">完成产物数 / 目标</div>
        </div>
        <div className="p-3 bg-surface-elevated rounded-lg text-center">
          <div className={`text-2xl font-semibold ${okCount < scripts.length ? "text-orange-600" : "text-green-600"}`}>{okCount}/{scripts.length}</div>
          <div className="text-xs text-ink-secondary mt-1">进度达标产物</div>
        </div>
        <div className="p-3 bg-surface-elevated rounded-lg text-center">
          <div className="text-2xl font-semibold">{selectedScripts.size}</div>
          <div className="text-xs text-ink-secondary mt-1">已勾选待分发</div>
        </div>
      </div>

      {/* 产物清单(按类型分组) */}
      <div className="border border-line rounded-lg max-h-[360px] overflow-y-auto">
        {groups.map((g) => (
          <div key={g.type}>
            <div className="sticky top-0 flex items-center justify-between px-3 py-2 bg-surface-elevated border-b border-line">
              <span className="text-sm font-medium flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-white text-xs ${g.meta.badge}`}>{g.meta.label}</span>
                {g.items.length} 部
              </span>
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => groupToggleAll(g.items)}
              >
                全选/取消
              </button>
            </div>
            <div className="divide-y divide-line">
              {g.items.map((s) => (
                <label key={s.id} className="flex items-center gap-3 p-3 hover:bg-surface-elevated cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedScripts.has(s.id)}
                    onChange={() => toggleScript(s.id)}
                    disabled={s.status !== "completed"}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{s.title}</span>
                      {s.status !== "completed" && <Badge className="bg-blue-500 text-white text-xs">生成中</Badge>}
                      {s.episodes_ok
                        ? <span className="text-xs text-green-600">✓ {s.completed_episodes}/{s.episodes}{g.meta.unit}</span>
                        : <span className="text-xs text-orange-600">⚠ 缺{g.meta.unit} {s.completed_episodes}/{s.episodes}</span>}
                      {s.protagonist && (
                        <span className="text-xs text-amber-600">第一人称: {s.protagonist}</span>
                      )}
                    </div>
                    {(s.source_label || s.distributed_to.length > 0) && (
                      <div className="text-xs text-ink-secondary mt-0.5">
                        {s.source_label ? `来源于: ${s.source_label}` : ""}
                        {s.source_label && s.distributed_to.length > 0 ? " · " : ""}
                        {s.distributed_to.length > 0 ? `已分发给: ${s.distributed_to.join("、")}` : ""}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
        {scripts.length === 0 && <div className="p-6 text-center text-sm text-ink-secondary">该任务暂无可分发产物</div>}
      </div>

      {/* 分发给谁 + 确认 */}
      <div className="flex items-center gap-3">
        <span className="text-sm whitespace-nowrap">分发给谁:</span>
        {targets.length === 0 ? (
          <button onClick={gotoConfig} className="text-sm text-primary hover:underline">暂无分发目标，点击去配置 →</button>
        ) : (
          <select
            className="flex-1 border border-line rounded-lg px-3 py-2 text-sm"
            value={selectedTargetId ?? ""}
            onChange={(e) => setSelectedTargetId(Number(e.target.value))}
          >
            {targets.map((t: DistTarget) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <Button onClick={onDistribute} disabled={sending || targets.length === 0 || selectedScripts.size === 0}>
          {sending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
          确认分发 ({selectedScripts.size})
        </Button>
      </div>

      {/* 分发结果 */}
      {sendResult && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm space-y-1">
          <div className="flex items-center gap-1 text-green-700 font-medium">
            <CheckCircle className="w-4 h-4" /> {sendResult.message}（目标: {sendResult.target}）
          </div>
          {(sendResult.failed || []).map((f: any) => (
            <div key={f.id} className="flex items-center gap-1 text-red-600 text-xs">
              <AlertCircle className="w-3 h-3" /> #{f.id} {f.title || ""}: {f.error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 子窗口2: 目标配置(飞书链接 + 字段映射 + 命名)
function ConfigTab({
  targets, editingId,
  formName, setFormName, formUrl, setFormUrl,
  formMapping, setFormMapping,
  feishuFields, previewing, previewErr, saving,
  onPreview, onSave, onEdit, onDelete, onNew,
}: any) {
  return (
    <div className="space-y-5">
      {/* 已有目标列表 */}
      {targets.length > 0 && (
        <div>
          <div className="text-sm font-medium mb-2">已保存的分发目标</div>
          <div className="space-y-2">
            {targets.map((t: DistTarget) => (
              <div key={t.id} className="flex items-center justify-between p-3 border border-line rounded-lg text-sm">
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-ink-secondary truncate">{t.url}</div>
                </div>
                <div className="flex gap-2 ml-3">
                  <Button size="sm" variant="ghost" onClick={() => onEdit(t)}>编辑</Button>
                  <Button size="sm" variant="ghost" className="text-red-500" onClick={() => onDelete(t)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 新建/编辑表单 */}
      <div className="border border-line rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">{editingId ? `编辑目标 #${editingId}` : "新建分发目标"}</div>
          {editingId && <button onClick={onNew} className="text-xs text-primary hover:underline">+ 改为新建</button>}
        </div>

        <div>
          <label className="text-xs text-ink-secondary">分发对象名称(显示在"分发给谁"下拉中)</label>
          <input
            className="w-full border border-line rounded-lg px-3 py-2 text-sm mt-1"
            placeholder="如: A组编剧"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-ink-secondary">飞书多维表格链接(需含 ?table=)</label>
          <div className="flex gap-2 mt-1">
            <input
              className="flex-1 border border-line rounded-lg px-3 py-2 text-sm"
              placeholder="https://xxx.feishu.cn/wiki/xxx?table=tblxxx"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={onPreview} disabled={previewing || !formUrl.trim()}>
              {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : "校验并读表头"}
            </Button>
          </div>
          {previewErr && <div className="text-xs text-red-600 mt-1">{previewErr}</div>}
          {feishuFields.length > 0 && (
            <div className="text-xs text-green-600 mt-1">✓ 连通成功, 读到 {feishuFields.length} 个表头: {feishuFields.map((f: any) => f.name).join(" / ")}</div>
          )}
        </div>

        {/* 字段映射 */}
        <div>
          <label className="text-xs text-ink-secondary">字段映射(左=分发要素, 右=飞书表头; 留空则不分发该要素)</label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {Object.keys(ELEMENT_LABELS).map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-sm w-28 whitespace-nowrap">{ELEMENT_LABELS[k]}</span>
                {feishuFields.length > 0 ? (
                  <select
                    className="flex-1 border border-line rounded px-2 py-1.5 text-sm"
                    value={formMapping[k] || ""}
                    onChange={(e) => setFormMapping({ ...formMapping, [k]: e.target.value })}
                  >
                    <option value="">(不分发)</option>
                    {feishuFields.map((f: any) => (
                      <option key={f.name} value={f.name}>{f.name}{f.type === 17 ? " (附件)" : ""}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="flex-1 border border-line rounded px-2 py-1.5 text-sm"
                    placeholder="飞书表头名"
                    value={formMapping[k] || ""}
                    onChange={(e) => setFormMapping({ ...formMapping, [k]: e.target.value })}
                  />
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-secondary mt-1">提示: "剧本"映射到附件列时自动以 .txt 文件上传; 文本列则直接写入文字</p>
        </div>

        <Button onClick={onSave} disabled={saving} className="w-full">
          {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
          {editingId ? "保存修改" : "保存分发目标"}
        </Button>
      </div>
    </div>
  );
}
