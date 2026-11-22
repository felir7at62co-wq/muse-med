"use client";
/**
 * 前贴语料库弹窗。
 *
 * 两类内容:
 *   - 预置(preset): 管理员上传, 全员可见/可用, 普通用户不可编辑
 *   - 自上传(mine): 用户自己的, 可用可编辑; 管理员在"自上传"tab能看到所有用户的(带用户名标签)
 * 两种产出:
 *   - 上传视频 → doubao反推画面内容(第三人称详述)
 *   - 直接上传/粘贴文本
 *勾选/全选后确认 → 把选中的语料 id 回传给父组件, 作生成五条前贴描述的参考上下文。
 *
 * 2026-08 新增: 每张卡片底部展示打标结果(scenario_summary核心设定+ hook_type + theme_tags前2个)
 */
import { useEffect, useRef, useState } from "react";
import { authFetch, isAdmin } from "../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type CorpusItem = {
  id: number;
  user_id: number;
  is_preset: boolean;
  title: string;
  source: "text" | "video";
  content: string;
  video_url?: string;
  status: string;
  error?: string;
  owner_username?: string;
  created_at?: string;
  // 打标字段 (2026-08)
  protagonist_gender?: string;
  protagonist_role?: string;
  theme_tags?: string[];
  hook_type?: string;
  scenario_summary?: string;
  content_rating?: string;
  auto_tagged?: boolean;
};

async function api(path: string, opts: RequestInit = {}) {
  const r = await authFetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

type Props = {
  open: boolean;
  onClose: () => void;
  // 确认勾选: 把选中的语料 id 回传给父组件
  selectedIds: number[];
  onConfirm: (ids: number[]) => void;
};

export default function CorpusModal({ open, onClose, selectedIds, onConfirm }: Props) {
  const admin = isAdmin();
  const [tab, setTab] = useState<"preset" | "mine">("preset");
  const [items, setItems] = useState<CorpusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  //勾选态(跨tab 保留), 用父组件传入的 selectedIds 初始化
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  // 上传态
  const [showUpload, setShowUpload] = useState(false);
  const [uploadKind, setUploadKind] = useState<"text" | "video">("text");
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // 编辑态
  const [editId, setEditId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const pollRef = useRef<any>(null);

  const load = async (t = tab) => {
    setErr(""); setLoading(true);
    try {
      // 预置 tab拉preset; 自上传 tab: 普通用户拉 mine, 管理员拉 all(含全部用户自上传, 但过滤掉预置)
      const scope = t === "preset" ? "preset" : (admin ? "all" : "mine");
      const r = await api(`/v1/frontcut/corpus?scope=${scope}&limit=500`);
      let list: CorpusItem[] = r.items || [];
      // 自上传 tab 只显示非预置
      if (t === "mine") list = list.filter((x) => !x.is_preset);
      setItems(list);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    // 用父组件的已选初始化勾选态
    const init: Record<number, boolean> = {};
    selectedIds.forEach((id) => { init[id] = true; });
    setChecked(init);
    load(tab);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };// eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 有视频还在反推(describing/uploaded)时, 轮询刷新
  useEffect(() => {
    if (!open) return;
    const hasProcessing = items.some((x) => x.status === "uploaded" || x.status === "describing");
    if (hasProcessing) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => load(tab), 5000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, open, tab]);

  // 只允许勾选 status=done 且有内容的
  const usable = (x: CorpusItem) => x.status === "done" && !!(x.content || "").trim();
  const usableItems = items.filter(usable);
  const checkedIds = () => Object.keys(checked).filter((k) => checked[+k]).map(Number);
  const allChecked = usableItems.length > 0 && usableItems.every((x) => checked[x.id]);
  const toggleAll = () => {
    const next = { ...checked };
    if (allChecked) {
      usableItems.forEach((x) => { delete next[x.id]; });
    } else {
      usableItems.forEach((x) => { next[x.id] = true; });
    }
    setChecked(next);
  };

  const uploadText = async () => {
    if (!textContent.trim()) { setErr("内容不能为空"); return; }
    setErr(""); setBusy(true);
    try {
      await api(`/v1/frontcut/corpus/upload-text`, {
        method: "POST",
        body: JSON.stringify({ title: textTitle || "文本语料", content: textContent }),
      });
      setTextTitle(""); setTextContent(""); setShowUpload(false);await load(admin ? tab : "mine");
      if (!admin) setTab("mine");
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  // 支持一次上传多个视频,逐个提交反推
  const uploadVideos = async (files: File[]) => {
    if (!files.length) return;
    setErr(""); setBusy(true);
    const errs: string[] = [];
    for (const file of files) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("title", file.name);
        // FormData 不设Content-Type, 让浏览器带boundary
        const r = await authFetch(`${BASE}/v1/frontcut/corpus/upload-video`, { method: "POST", body: fd });
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);} catch (e: any) {
        errs.push(`${file.name}: ${String(e?.message || e)}`);
      }
    }
    if (errs.length) setErr(`部分失败(${errs.length}/${files.length}):` + errs.join("; "));
    setShowUpload(false);
    // 管理员上传即预置, 普通用户上传即自上传
    const target = admin ? "preset" : "mine";
    setTab(target);
    await load(target);
    setBusy(false);
  };

  const saveEdit = async () => {
    if (editId == null) return;
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      fd.append("title", editTitle);
      fd.append("content", editContent);
      const r = await authFetch(`${BASE}/v1/frontcut/corpus/${editId}`, { method: "PATCH", body: fd });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);setEditId(null);
      await load(tab);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  const del = async (id: number) => {
    if (!confirm("确认删除这条语料?")) return;
    setBusy(true); setErr("");
    try {
      await api(`/v1/frontcut/corpus/${id}`, { method: "DELETE" });
      setChecked((p) => { const n = { ...p }; delete n[id]; return n; });
      await load(tab);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  // 是否可编辑: 管理员全可; 普通用户只能编辑自己的非预置
  const canEdit = (x: CorpusItem) => admin || (!x.is_preset);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 1180, maxWidth: "96vw", height: "90vh", background: "#fff", borderRadius: 12,
        padding: 24, display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,.2)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700}}>语料库</h2>
          <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 20, cursor: "pointer", color: "#888" }}>×</button>
        </div>
        <p style={{ color: "#666", fontSize: 12.5, marginTop: 4 }}>
          勾选的语料将作为「生成五条前贴描述」的参考上下文。可上传视频(自动反推画面)或直接粘贴文本。
        </p>

        {/* Tab 切换 */}
        <div style={{ display: "flex", gap: 8, margin: "12px 0 8px", borderBottom: "1px solid #eee" }}>
          {([["preset", "预置语料"], ["mine", admin ? "自上传(全部用户)" : "我的自上传"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{
                padding: "6px 14px", border: 0, background: "transparent", cursor: "pointer",
                fontSize: 13.5, fontWeight: tab === k ? 700 : 400,
                color: tab === k ? "#2563eb" : "#666",
                borderBottom: tab === k ? "2px solid #2563eb" : "2px solid transparent",
              }}>
              {label}
            </button>
          ))}
          <button onClick={() => { setShowUpload((v) => !v); setErr(""); }}
            style={{ marginLeft: "auto", fontSize: 12.5, color: "#16a34a", background: "transparent", border: 0, cursor: "pointer" }}>
            {showUpload ? "收起上传" : "+ 上传语料"}
          </button>
        </div>

        {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "6px 0" }}>错误: {err}</div>}

        {/* 上传区 */}
        {showUpload && (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 10, background: "#fafafa" }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              {(["text", "video"] as const).map((k) => (
                <label key={k} style={{ fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                  <input type="radio" checked={uploadKind === k} onChange={() => setUploadKind(k)} />
                  {k === "text" ? "直接文本" : "上传视频(自动反推)"}
                </label>
              ))}
              {admin && <span style={{ fontSize: 12, color: "#f59e0b", marginLeft: "auto" }}>管理员上传= 预置(全员可见)</span>}
            </div>
            {uploadKind === "text" ? (
              <>
                <input value={textTitle} onChange={(e) => setTextTitle(e.target.value)} placeholder="标题(可选)"
                  style={{ width: "100%", padding: 7, border: "1px solid #ddd", borderRadius: 6, marginBottom: 8, fontSize: 13 }} />
                <textarea value={textContent} onChange={(e) => setTextContent(e.target.value)} rows={4}
                  placeholder="粘贴参考文本(爆款钩子/题材套路/剧情复述等)"
                  style={{ width: "100%", padding: 8, border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }} /><button onClick={uploadText} disabled={busy || !textContent.trim()}
                  style={{ marginTop: 8, padding: "7px 18px", background: busy || !textContent.trim() ? "#9ca3af" : "#16a34a", color: "#fff", border: 0, borderRadius: 6, cursor: busy ? "default" : "pointer", fontSize: 13 }}>
                  {busy ? "上传中…" : "保存文本语料"}
                </button>
              </>
            ) : (<div>
                <input ref={fileRef} type="file" multiple accept="video/*,.mp4,.mov,.mkv,.webm,.avi"
                  onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; if (fs.length) uploadVideos(fs); }}
                  disabled={busy} style={{ fontSize: 13 }} />
                {busy && <div style={{ fontSize: 12.5, color: "#2563eb", marginTop: 6 }}>上传中…</div>}
              </div>
            )}
          </div>
        )}

        {/* 全选栏 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
          <label style={{ fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={loading || usableItems.length === 0} />
            全选可用({usableItems.filter((x) => checked[x.id]).length}/{usableItems.length})
          </label>
          <span style={{ fontSize: 12, color: "#999" }}>已选合计{checkedIds().length}条</span>
          <button onClick={() => load(tab)} disabled={loading}
            style={{ marginLeft: "auto", fontSize: 12, color: "#2563eb", background: "transparent", border: 0, cursor: "pointer" }}>
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>

        {/* 列表 (9:16竖版卡片grid) */}
        <div style={{ flex: 1, overflow: "auto", padding: 16}}>
          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: "#999", fontSize: 13 }}>加载中…</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#999", fontSize: 13 }}>暂无语料, 点右上「+ 上传语料」添加</div>
          ) : editId !== null ? (
            // 编辑态：全屏居中编辑框
            <div style={{ maxWidth: 600, margin: "0 auto", padding: 20, border: "1px solid #ddd", borderRadius: 8, background: "#fafafa" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>编辑语料</div>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="标题"
                style={{ width: "100%", padding: 8, border: "1px solid #ddd", borderRadius: 6, marginBottom: 10, fontSize: 13 }} />
              <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={8} placeholder="内容"
                style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }} />
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button onClick={saveEdit} disabled={busy}
                  style={{ padding: "8px 20px", background: "#16a34a", color: "#fff", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
                  {busy ? "保存中…" : "保存"}
                </button>
                <button onClick={() => setEditId(null)}
                  style={{ padding: "8px 20px", background: "#f0f0f0", color: "#333", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 13 }}>取消</button>
              </div>
            </div>
          ) : (
            // 卡片grid (9:16竖版, 每行自适应, 最小150px, gap 12px)
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
              {items.map((x) => (
                <div key={x.id} style={{
                  border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff",
                  display: "flex", flexDirection: "column", position: "relative",
                  opacity: !usable(x) ? 0.6 : 1,
                }}>
                  {/*顶部勾选框 */}
                  <div style={{ position: "absolute", top: 6, left: 6, zIndex: 10 }}>
                    <input type="checkbox" checked={!!checked[x.id]} disabled={!usable(x)}
                      onChange={() => setChecked((p) => ({ ...p, [x.id]: !p[x.id] }))}
                      style={{ width: 18, height: 18, cursor: usable(x) ? "pointer" : "default" }} />
                  </div>

                  {/* 9:16 视觉主体区(视频缩略图/文本预览) */}
                  <div style={{ aspectRatio: "9/16", background: x.source === "video" ? "#000" : "#f9fafb", position: "relative", overflow: "hidden" }}>
                    {x.source === "video" && x.video_url ? (
                      <video src={x.video_url} controls preload="metadata"
                        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />
                    ) : x.source === "video" ? (
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 12 }}>
                        {x.status === "describing" || x.status === "uploaded" ? "反推中…" : x.status === "failed" ? "失败" : "无视频"}
                      </div>
                    ) : (
                      <div style={{ padding: 10, fontSize: 11.5, color: "#555", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 12, WebkitBoxOrient: "vertical" }}>
                        {(x.content || "").slice(0, 200) || "(空内容)"}
                      </div>
                    )}
                  </div>

                  {/* 底部信息 + 操作 */}
                  <div style={{ padding: "8px 10px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#333", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {x.title || "未命名"}
                      </div>

                      {/* 核心设定一句话 (打标结果) */}
                      {x.scenario_summary && (
                        <div title={x.scenario_summary} style={{
                          fontSize: 11, color: "#374151", lineHeight: 1.4, marginBottom: 4,
                          overflow: "hidden", textOverflow: "ellipsis",
                          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                        }}>
                          {x.scenario_summary}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 6 }}>
                        <span style={{ fontSize: 10, color: "#888", background: "#f0f0f0", borderRadius: 3, padding: "1px 4px" }}>
                          {x.source === "video" ? "视频" : "文本"}
                        </span>
                        {/*钩子类型 */}
                        {x.hook_type && (
                          <span style={{ fontSize: 10, color: "#7c3aed", background: "#f5f3ff", borderRadius: 3, padding: "1px 4px" }}>
                            {x.hook_type}
                          </span>
                        )}
                        {/* 题材标签(最多2个) */}
                        {(x.theme_tags || []).slice(0, 2).map((t) => (
                          <span key={t} style={{ fontSize: 10, color: "#0f766e", background: "#f0fdf4", borderRadius: 3, padding: "1px 4px" }}>
                            {t}
                          </span>
                        ))}
                        {x.owner_username && (
                          <span style={{ fontSize: 10, color: "#2563eb", background: "#eff6ff", borderRadius: 3, padding: "1px 4px" }}>
                            @{x.owner_username}
                          </span>
                        )}
                        {(x.status === "describing" || x.status === "uploaded") && (
                          <span style={{ fontSize: 10, color: "#f59e0b" }}>…</span>
                        )}{x.status === "failed" && (
                          <span style={{ fontSize: 10, color: "#dc2626" }}>✗</span>
                        )}
                      </div>
                    </div>
                    {canEdit(x) && (
                      <div style={{ display: "flex", gap: 6}}>
                        <button onClick={() => { setEditId(x.id); setEditTitle(x.title || ""); setEditContent(x.content || ""); }}
                          style={{ flex: 1, fontSize: 11, color: "#2563eb", background: "transparent", border: "1px solid #2563eb", borderRadius: 4, padding: "4px 0", cursor: "pointer" }}>
                          编辑
                        </button>
                        <button onClick={() => del(x.id)}
                          style={{ flex: 1, fontSize: 11, color: "#dc2626", background: "transparent", border: "1px solid #dc2626", borderRadius: 4, padding: "4px 0", cursor: "pointer" }}>
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}</div>

        {/* 操作 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
          <button onClick={onClose}
            style={{ padding: "8px 18px", background: "#f0f0f0", color: "#333", border: 0, borderRadius: 6, cursor: "pointer" }}>
            取消
          </button>
          <button onClick={() => { onConfirm(checkedIds()); onClose(); }}
            style={{ padding: "8px 22px", background: "#2563eb", color: "#fff", border: 0, borderRadius: 6, cursor: "pointer" }}>
            确认选择({checkedIds().length})
          </button>
        </div>
      </div>
    </div>
  );
}