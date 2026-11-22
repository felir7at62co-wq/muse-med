"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken, canNovelVideo, isAdmin } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import OverlayEditor, { DEFAULT_ITEMS, DEFAULT_SUBTITLE, type OverlayItem, type Subtitle } from "../novel-video/_OverlayEditor";
import {
  ArrowLeft, Plus, X, Loader2, Table2, PlayCircle, Trash2, Settings2,
  Film, RefreshCw, CheckSquare, Square, Mic, Upload, Download,
} from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/feishu`;
const NV = `${BASE}/v1/novel-video`;

type Cfg = {
  id: number; name: string; app_token: string; table_id: string;
  field_map: Record<string, string>;
  default_ratio: string; default_style_prompt: string; default_per_image_seconds: number;
  overlay_layout: any; cover_enabled: boolean; cover_layout: any;
  voice_oss_keys: string[]; voice_mode?: string; bgm_category: string;
  last_synced_at?: string | null;
};
type JobBrief = {
  id: number; title: string; status: string; progress: number;
  image_count: number; audio_duration: number; video_oss_key?: string | null; error?: string | null;
};
type Shot = { id: number; idx: number; text_segment: string; image_prompt: string; status: string; image_url?: string | null; is_cover?: boolean; };
type JobDetail = { id: number; title: string; status: string; progress: number; image_count: number; audio_duration: number; error?: string | null; video_url?: string | null; shots: Shot[]; };
type Candidate = { record_id: string; name: string; ratio: string; seconds: string; };

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中", audio: "配音中", prompting: "生成提示词", imaging: "生图中",
  await_confirm: "待确认", compositing: "合成中", succeeded: "已完成", failed: "失败", canceled: "已取消",
};
const RATIOS = ["9:16", "16:9", "4:3", "3:4", "1:1"];
const RATIO_WH: Record<string, [number, number]> = { "9:16": [9, 16], "16:9": [16, 9], "4:3": [4, 3], "3:4": [3, 4], "1:1": [1, 1] };

export default function FeishuSyncPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) { window.location.href = "/jubengongfang/login?from=/feishu-sync"; return null; }
    if (!canNovelVideo()) { window.location.href = "/jubengongfang/"; return null; }
  }
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [cfgs, setCfgs] = useState<Cfg[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [jobs, setJobs] = useState<JobBrief[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<JobDetail | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // 配置弹窗
  const [editing, setEditing] = useState<Cfg | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldNames, setFieldNames] = useState<string[]>([]);
  // 配置弹窗内的样式编辑态
  const [ovItems, setOvItems] = useState<OverlayItem[]>(DEFAULT_ITEMS);
  const [ovSub, setOvSub] = useState<Subtitle>(DEFAULT_SUBTITLE);
  const [ovModal, setOvModal] = useState(false);
  const [cvItems, setCvItems] = useState<OverlayItem[]>([
    { id: "cvtitle", text: "{title}", xPct: 0.12, yPct: 0.12, fontPct: 0.09, vertical: false, font: "sans-bold", color: "#ffffff", stroke: "#000000" },
    { id: "cvtags", text: "{tags}/完结", xPct: 0.12, yPct: 0.26, fontPct: 0.045, vertical: false, font: "sans", color: "#ffe08a", stroke: "#000000" },
  ]);
  const [cvModal, setCvModal] = useState(false);
  const [voices, setVoices] = useState<{ id: number; name: string; oss_key: string; gender?: string | null; url?: string | null }[]>([]);
  const [stylePresets, setStylePresets] = useState<{ id: number; name: string; prompt: string }[]>([]);
  // 画风预设 存为/编辑 弹窗态
  const [presetModal, setPresetModal] = useState(false);
  const [presetEditId, setPresetEditId] = useState<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetPrompt, setPresetPrompt] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  // BGM 库(按分类分组) + 上传态; 仅管理员可上传/删除
  const canManageBgm = typeof window !== "undefined" && isAdmin();
  const [bgmGrouped, setBgmGrouped] = useState<Record<string, any[]>>({});
  const [bgmUploading, setBgmUploading] = useState("");

  // 同步任务弹窗
  const [syncModalCfg, setSyncModalCfg] = useState<Cfg | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [candTotal, setCandTotal] = useState(0);
  const [candTableTotal, setCandTableTotal] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const loadCfgs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/configs`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setCfgs(d.configs || []);
    } catch (e: any) { setErr(`配置加载失败: ${e.message}`); }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch(`${NV}/jobs?source=feishu`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setJobs(d.jobs || []);
    } catch (e: any) { setErr(`任务加载失败: ${e.message}`); }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const r = await fetch(`${NV}/jobs/${id}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSel(await r.json());
    } catch (e: any) { setErr(e.message); }
  }, []);

  useEffect(() => { loadCfgs(); loadJobs(); }, [loadCfgs, loadJobs]);
  // 任务列表常驻轮询(每5s), 让后台新建/进行中的任务持续刷新出现
  useEffect(() => {
    const t = setInterval(() => loadJobs(), 5000);
    return () => clearInterval(t);
  }, [loadJobs]);
  useEffect(() => {
    if (selId == null) return;
    loadDetail(selId);
    const t = setInterval(() => loadDetail(selId), 5000);
    return () => clearInterval(t);
  }, [selId, loadDetail]);

  const loadBgm = useCallback(async () => {
    try {
      const r = await fetch(`${NV}/bgm`, { headers: authHeaders() });
      if (r.ok) setBgmGrouped((await r.json()).grouped || {});
    } catch { /* ignore */ }
  }, []);

  const loadPresetsAndVoices = useCallback(async () => {
    try {
      const [rv, rs] = await Promise.all([
        fetch(`${NV}/voices`, { headers: authHeaders() }),
        fetch(`${NV}/style-presets`, { headers: authHeaders() }),
      ]);
      if (rv.ok) setVoices((await rv.json()).voices || []);
      if (rs.ok) setStylePresets((await rs.json()).presets || []);
    } catch { /* ignore */ }
    loadBgm();
  }, [loadBgm]);

  const uploadBgm = async (category: string, files: FileList | null) => {
    if (!files?.length) return;
    setBgmUploading(category); setErr("");
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData(); fd.append("file", f);
        const r = await fetch(`${NV}/bgm/upload?category=${encodeURIComponent(category)}`, {
          method: "POST", headers: authHeaders(), body: fd,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      }
      await loadBgm();
    } catch (e: any) { setErr(`BGM 上传失败: ${e.message}`); }
    finally { setBgmUploading(""); }
  };

  const deleteBgm = async (id: number) => {
    try {
      const r = await fetch(`${NV}/bgm/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadBgm();
    } catch (e: any) { setErr(`删除 BGM 失败: ${e.message}`); }
  };

  // ---------- 配置弹窗 ----------
  const openNewCfg = () => {
    setFieldNames([]);
    setOvItems(DEFAULT_ITEMS); setOvSub(DEFAULT_SUBTITLE);
    setEditing({
      id: 0, name: "飞书自动化", app_token: "", table_id: "", field_map: {},
      default_ratio: "4:3", default_style_prompt: "", default_per_image_seconds: 7,
      overlay_layout: null, cover_enabled: true, cover_layout: null,
      voice_oss_keys: [], voice_mode: "auto", bgm_category: "",
    });
    loadPresetsAndVoices();
  };
  const openEditCfg = (c: Cfg) => {
    setFieldNames([]);
    setEditing({ ...c });
    // 载入已存样式
    const ov = c.overlay_layout || {};
    setOvItems((ov.items || DEFAULT_ITEMS).map((it: any, i: number) => ({
      id: it.id || `ov${i}`, text: it.text || "", xPct: it.xPct ?? 0.03, yPct: it.yPct ?? 0.03,
      fontPct: it.fontPct ?? 0.03, vertical: !!it.vertical, font: it.font || "sans", color: it.color || "#fff", stroke: it.stroke || "#000",
      align: it.align === "center" ? "center" : "left",
    })));
    setOvSub({ ...DEFAULT_SUBTITLE, ...(ov.subtitle || {}) });
    const cv = c.cover_layout || {};
    if (cv.items?.length) {
      setCvItems(cv.items.map((it: any, i: number) => ({
        id: it.id || `cv${i}`, text: it.text || "", xPct: it.xPct ?? 0.12, yPct: it.yPct ?? 0.12,
        fontPct: it.fontPct ?? 0.06, vertical: !!it.vertical, font: it.font || "sans", color: it.color || "#fff", stroke: it.stroke || "#000",
        align: it.align === "center" ? "center" : "left",
      })));
    }
    loadPresetsAndVoices();
  };

  const toggleVoiceInCfg = (oss_key: string) => {
    if (!editing) return;
    const cur = new Set(editing.voice_oss_keys || []);
    cur.has(oss_key) ? cur.delete(oss_key) : cur.add(oss_key);
    setEditing({ ...editing, voice_oss_keys: Array.from(cur) });
  };

  const saveCfg = async () => {
    if (!editing) return;
    setSaving(true); setErr("");
    try {
      const isNew = editing.id === 0;
      const body = {
        name: editing.name || "飞书自动化",
        // app_token/table_id 不传 → 后端用固定的制作表格链接
        // field_map 不传 → 后端用制作表格固定映射
        default_ratio: editing.default_ratio,
        default_style_prompt: editing.default_style_prompt,
        default_per_image_seconds: editing.default_per_image_seconds,
        overlay_layout: {
          items: ovItems.map((it) => ({ text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct, vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke, align: it.align })),
          subtitle: ovSub,
        },
        cover_enabled: editing.cover_enabled,
        cover_layout: editing.cover_enabled ? {
          items: cvItems.map((it) => ({ text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct, vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke, align: it.align })),
        } : null,
        voice_oss_keys: editing.voice_oss_keys || [],
        voice_mode: editing.voice_mode || "custom",
        bgm_category: editing.bgm_category || "",
      };
      const url = isNew ? `${API}/configs` : `${API}/configs/${editing.id}`;
      const r = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      await loadCfgs();
      setEditing(null);
      setMsg("配置已保存"); setTimeout(() => setMsg(""), 2000);
    } catch (e: any) { setErr(`保存失败: ${e.message}`); }
    finally { setSaving(false); }
  };

  // ---------- 画风预设 存为/编辑 ----------
  const openPresetModal = (id: number | null) => {
    if (id == null) {
      setPresetEditId(null); setPresetName(""); setPresetPrompt(editing?.default_style_prompt || "");
    } else {
      const p = stylePresets.find((x) => x.id === id);
      setPresetEditId(id); setPresetName(p?.name || ""); setPresetPrompt(p?.prompt || "");
    }
    setPresetModal(true);
  };
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) { setErr("预设名不能为空"); return; }
    setPresetSaving(true); setErr("");
    try {
      const url = presetEditId == null ? `${NV}/style-presets` : `${NV}/style-presets/${presetEditId}`;
      const method = presetEditId == null ? "POST" : "PUT";
      const r = await fetch(url, {
        method, headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt: presetPrompt || "" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      // 刷新预设列表; 把当前编辑配置的画风填为该预设内容
      const rs = await fetch(`${NV}/style-presets`, { headers: authHeaders() });
      if (rs.ok) setStylePresets((await rs.json()).presets || []);
      if (editing) setEditing({ ...editing, default_style_prompt: d.prompt || "" });
      setPresetModal(false);
    } catch (e: any) { setErr(`保存预设失败: ${e.message}`); }
    finally { setPresetSaving(false); }
  };
  const deletePreset = async (id: number) => {
    try {
      const r = await fetch(`${NV}/style-presets/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const rs = await fetch(`${NV}/style-presets`, { headers: authHeaders() });
      if (rs.ok) setStylePresets((await rs.json()).presets || []);
      setPresetModal(false);
    } catch (e: any) { setErr(`删除预设失败: ${e.message}`); }
  };

  // 一键清空飞书列表所有失败任务
  const [clearingFailed, setClearingFailed] = useState(false);
  const clearFailedJobs = async () => {
    const failedCount = jobs.filter((j) => j.status === "failed").length;
    if (failedCount === 0) { setMsg("当前没有失败的任务"); setTimeout(() => setMsg(""), 2000); return; }
    if (!window.confirm(`确认清空全部 ${failedCount} 个失败任务？此操作不可撤销(不影响进行中/已完成的任务)。`)) return;
    setClearingFailed(true); setErr("");
    try {
      const r = await fetch(`${NV}/jobs/feishu-failed`, { method: "DELETE", headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setMsg(`已清空 ${d.deleted ?? 0} 个失败任务`); setTimeout(() => setMsg(""), 3000);
      await loadJobs();
      if (sel && sel.status === "failed") { setSel(null); setSelId(null); }
    } catch (e: any) { setErr(`清空失败: ${e.message}`); }
    finally { setClearingFailed(false); }
  };

  const removeCfg = async (id: number) => {
    if (!window.confirm("确认删除该同步配置？(不影响已生成任务)")) return;
    try {
      const r = await fetch(`${API}/configs/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadCfgs();
    } catch (e: any) { setErr(`删除失败: ${e.message}`); }
  };

  const testCfg = async (id: number) => {
    setErr(""); setFieldNames([]);
    try {
      const r = await fetch(`${API}/configs/${id}/test`, { method: "POST", headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setFieldNames(d.field_names || []);
      setMsg(`连接成功, 表有 ${d.field_names?.length || 0} 个字段`); setTimeout(() => setMsg(""), 3000);
    } catch (e: any) { setErr(`连接测试失败: ${e.message}`); }
  };

  // ---------- 同步任务弹窗 ----------
  const openSyncModal = async (c: Cfg) => {
    setSyncModalCfg(c); setCandidates([]); setPicked(new Set()); setCandLoading(true); setErr("");
    try {
      const r = await fetch(`${API}/configs/${c.id}/candidates`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setCandidates(d.rows || []); setCandTotal(d.total || 0); setCandTableTotal(d.table_total || 0);
    } catch (e: any) { setErr(`读取候选失败: ${e.message}`); }
    finally { setCandLoading(false); }
  };
  const togglePick = (rid: string) => {
    setPicked((prev) => { const n = new Set(prev); n.has(rid) ? n.delete(rid) : n.add(rid); return n; });
  };
  const pickAll = () => {
    if (picked.size === candidates.length) setPicked(new Set());
    else setPicked(new Set(candidates.map((c) => c.record_id)));
  };
  const runSyncSelected = async () => {
    if (!syncModalCfg || picked.size === 0) { setErr("请先勾选任务"); return; }
    setSyncing(true); setErr("");
    try {
      const r = await fetch(`${API}/configs/${syncModalCfg.id}/sync-selected`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ record_ids: Array.from(picked) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      // 后台处理: 立即关弹窗, 任务会陆续出现在左侧列表(5s 轮询自动刷新)
      setMsg(`已提交 ${d.submitted ?? picked.size} 个任务, 后台生成中(下载/生文案/生图约需数分钟), 完成后自动回写飞书`);
      setTimeout(() => setMsg(""), 6000);
      setSyncModalCfg(null);
      // 稍等一下再刷, 让首批 job 建出来; 之后靠 5s 轮询持续更新
      setTimeout(() => loadJobs(), 1500);
    } catch (e: any) { setErr(`同步失败: ${e.message}`); }
    finally { setSyncing(false); }
  };

  // 补写下载链接: 扫描全表,只对"下载链接列为空且已有成功视频"的行补写,不覆盖已有内容
  const [backfilling, setBackfilling] = useState<number | null>(null);
  const runBackfill = async (c: Cfg) => {
    if (!window.confirm(`补写「${c.name}」的下载链接？\n\n只会补写下载链接列为空、且视频已生成成功的行,不会覆盖已有链接的行。`)) return;
    setBackfilling(c.id); setErr("");
    try {
      const r = await fetch(`${API}/configs/${c.id}/backfill-links`, {
        method: "POST", headers: authHeaders(),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setMsg(`补写完成: 补写 ${d.backfilled ?? 0} 行, 跳过 ${d.skipped ?? 0} 行(已有链接或无成功视频)`);
      setTimeout(() => setMsg(""), 6000);
    } catch (e: any) { setErr(`补写失败: ${e.message}`); }
    finally { setBackfilling(null); }
  };

  const fmtDur = (s?: number) => { if (!s) return "-"; const m = Math.floor(s / 60), sec = s % 60; return `${m}:${String(sec).padStart(2, "0")}`; };

  return (
    <div className="min-h-screen text-ink-primary">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-elevated/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/novel-video")} className="rounded-lg p-2 hover:bg-white/10"><ArrowLeft size={18} /></button>
          <Table2 size={20} className="text-pink-400" />
          <div className="text-sm font-semibold">飞书自动化 · 小说转视频</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={openNewCfg}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:border-pink-400">
            <Settings2 size={15} /> 同步配置
          </button>
          <UserNav />
        </div>
      </div>

      {err && <div className="mx-4 mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</div>}
      {msg && <div className="mx-4 mt-3 rounded-lg bg-green-500/15 px-3 py-2 text-sm text-green-300">{msg}</div>}

      {/* 配置条(横向): 每个配置显示名称+同步任务/编辑/删除 */}
      <div className="mx-4 mt-3 flex flex-wrap gap-2">
        {cfgs.length === 0 && <div className="text-xs text-ink-muted">还没有同步配置，点右上「同步配置」新建。</div>}
        {cfgs.map((c) => (
          <div key={c.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface-card px-3 py-2">
            <span className="text-sm font-medium">{c.name}</span>
            <span className="text-[10px] text-ink-muted">{c.default_ratio} · {c.default_per_image_seconds}s/图 · BGM:{c.bgm_category || "无"} · 音色{c.voice_oss_keys?.length || 0}</span>
            <button onClick={() => openSyncModal(c)}
              className="flex items-center gap-1 rounded-lg bg-pink-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-pink-600">
              <PlayCircle size={13} /> 同步任务
            </button>
            <button onClick={() => runBackfill(c)} disabled={backfilling === c.id}
              title="补写下载链接: 只补空行,不覆盖已有链接"
              className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs hover:border-pink-400 disabled:opacity-50">
              {backfilling === c.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} 补写链接
            </button>
            <button onClick={() => openEditCfg(c)} className="rounded-lg border border-line px-2 py-1 text-xs hover:border-pink-400">编辑</button>
            <button onClick={() => removeCfg(c.id)} className="rounded-lg border border-line px-2 py-1 text-xs text-red-300 hover:border-red-400"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>

      {/* 主体: 左历史(仅飞书任务) + 右画廊 — 向主页看齐 */}
      <div className="flex gap-3 p-3" style={{ height: "calc(100vh - 130px)" }}>
        <div className="w-44 shrink-0 overflow-y-auto">
          <div className="rounded-xl border border-line bg-surface-card p-2">
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-ink-secondary">
              <span>飞书任务</span>
              <div className="flex items-center gap-2">
                <button onClick={clearFailedJobs} disabled={clearingFailed}
                  title="清空全部失败任务"
                  className="flex items-center gap-0.5 text-red-300 hover:text-red-200 disabled:opacity-50">
                  {clearingFailed ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  <span className="text-[10px]">清失败</span>
                </button>
                <button onClick={loadJobs} className="hover:text-ink-primary"><RefreshCw size={12} /></button>
              </div>
            </div>
            <div className="space-y-1">
              {jobs.length === 0 && <div className="px-1 text-xs text-ink-muted">暂无任务</div>}
              {jobs.map((j) => (
                <div key={j.id} onClick={() => setSelId(j.id)}
                  className={`w-full cursor-pointer rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${selId === j.id ? "border-pink-500/50 bg-pink-500/10" : "border-line bg-surface-card hover:bg-surface-card-hover"}`}>
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{j.title}</span>
                    <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${j.status === "succeeded" ? "bg-green-500/20 text-green-300" : j.status === "failed" ? "bg-red-500/20 text-red-300" : "bg-blue-500/20 text-blue-300"}`}>{STATUS_LABEL[j.status] || j.status}</span>
                  </div>
                  {j.status !== "succeeded" && j.status !== "failed" && (
                    <div className="mt-1 h-1 w-full overflow-hidden rounded bg-surface-elevated"><div className="h-full bg-pink-500 transition-all" style={{ width: `${j.progress || 0}%` }} /></div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {!sel && (
            <div className="mt-24 text-center text-sm text-ink-muted">
              <Film size={32} className="mx-auto mb-3 opacity-40" />
              选择左侧任务查看，或用上方配置的「同步任务」勾选飞书表里的行来生成
            </div>
          )}
          {sel && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-card p-3">
                <div className="text-sm font-medium">{sel.title}</div>
                <span className="rounded bg-surface-elevated px-2 py-0.5 text-xs">{STATUS_LABEL[sel.status] || sel.status}</span>
                <span className="text-xs text-ink-secondary">图 {sel.image_count} 张 · 配音 {fmtDur(sel.audio_duration)}</span>
                {sel.status !== "succeeded" && sel.status !== "failed" && (
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface-elevated"><div className="h-full bg-pink-500 transition-all" style={{ width: `${sel.progress || 0}%` }} /></div>
                )}
                {sel.error && <span className="text-xs text-red-300">{sel.error}</span>}
              </div>
              {sel.video_url && (
                <div className="mb-3 rounded-xl border border-line bg-surface-card p-3">
                  {/* 直接下载按钮: 成片链接一就绪即可下载, 无需等待视频在页面内加载完(长视频加载慢, 便于快速取片) */}
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-secondary">成片已就绪</span>
                    <a
                      href={sel.video_url}
                      download={`${sel.title || "video"}.mp4`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-pink-600"
                    >
                      <Download size={14} /> 直接下载
                    </a>
                  </div>
                  <video key={sel.video_url} src={sel.video_url} controls preload="none" className="max-h-[70vh] w-full rounded-lg bg-black" />
                </div>
              )}
              <div className="grid grid-cols-10 gap-1 md:grid-cols-12 lg:grid-cols-14 xl:grid-cols-16">
                {sel.shots.map((sh) => (
                  <div key={sh.id} className="group relative overflow-hidden rounded-lg border border-line bg-surface-card">
                    <div className="relative aspect-[9/16] w-full bg-black/40">
                      {sh.image_url ? (
                        <img src={sh.image_url} alt="" onClick={() => sh.image_url && setLightbox(sh.image_url)}
                          className="h-full w-full cursor-zoom-in object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-ink-muted">
                          {sh.status === "failed" ? <X size={20} className="text-red-400" /> : <Loader2 size={18} className="animate-spin" />}
                        </div>
                      )}
                      <div className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{sh.is_cover ? "封面" : `#${sh.idx + 1}`}</div>
                    </div>
                    <div className="line-clamp-2 p-1 text-[10px] text-ink-muted">{sh.text_segment}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6">
          <img src={lightbox} className="max-h-full max-w-full rounded-lg" referrerPolicy="no-referrer" />
        </div>
      )}

      {/* 同步任务弹窗: 候选行勾选 */}
      {syncModalCfg && (
        <div onClick={() => setSyncModalCfg(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">同步任务 · {syncModalCfg.name}</div>
              <button onClick={() => setSyncModalCfg(null)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="border-b border-line px-4 py-2 text-xs text-ink-secondary">
              未生成的行(下载链接为空、有附件、且不在现有任务中): {candTotal} / 表共 {candTableTotal} 行
              <button onClick={pickAll} className="ml-3 text-pink-300 hover:text-pink-200">
                {picked.size === candidates.length && candidates.length > 0 ? "取消全选" : "全选"}
              </button>
              <span className="ml-2 text-ink-muted">已选 {picked.size}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {candLoading && <div className="py-10 text-center text-sm text-ink-muted"><Loader2 size={18} className="mx-auto animate-spin" /> 读取中…</div>}
              {!candLoading && candidates.length === 0 && <div className="py-10 text-center text-sm text-ink-muted">没有可生成的新行(都已生成或无附件)</div>}
              {!candLoading && candidates.map((c) => (
                <label key={c.record_id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-surface-card">
                  <button type="button" onClick={() => togglePick(c.record_id)} className="shrink-0">
                    {picked.has(c.record_id) ? <CheckSquare size={16} className="text-pink-400" /> : <Square size={16} className="text-ink-muted" />}
                  </button>
                  <span className="flex-1 truncate">{c.name}</span>
                  {c.ratio && <span className="shrink-0 rounded bg-surface-elevated px-1 text-[10px] text-ink-muted">{c.ratio}</span>}
                  {c.seconds && <span className="shrink-0 rounded bg-surface-elevated px-1 text-[10px] text-ink-muted">{c.seconds}s</span>}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <button onClick={() => setSyncModalCfg(null)} className="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-card">取消</button>
              <button onClick={runSyncSelected} disabled={syncing || picked.size === 0}
                className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                {syncing ? <Loader2 size={12} className="inline animate-spin" /> : null} 生成选中 ({picked.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 配置弹窗: 默认样式设置 */}
      {editing && (
        <div onClick={() => setEditing(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">{editing.id === 0 ? "新建同步配置" : "编辑同步配置"}</div>
              <button onClick={() => setEditing(null)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="space-y-3 overflow-y-auto p-4">
              <label className="block">
                <span className="mb-1 block text-[10px] text-ink-muted">配置名</span>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
              </label>
              <div className="rounded-lg bg-surface-card px-2 py-1.5 text-[10px] text-ink-muted">
                目标表已固定为飞书「制作表格」(无需填链接)。字段固定: 附件→文档, 改写剧名←AI剧名, 类型←标签, 下载链接←成片链接, 原小说名←文件名(空才写)。
                {editing.id !== 0 && <button onClick={() => testCfg(editing.id)} className="ml-2 text-pink-300 hover:text-pink-200">测试连接</button>}
                {fieldNames.length > 0 && <div className="mt-1 text-ink-secondary">表字段: {fieldNames.join(" / ")}</div>}
              </div>

              <div className="border-t border-line pt-3 text-[10px] font-medium text-pink-300">默认样式（行内该列为空时用这里，有值以表格为准）</div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-ink-muted">默认比例</span>
                  <select value={editing.default_ratio} onChange={(e) => setEditing({ ...editing, default_ratio: e.target.value })}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 text-xs outline-none">
                    {RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-ink-muted">默认几秒一张图</span>
                  <input type="number" min={2} max={60} value={editing.default_per_image_seconds}
                    onChange={(e) => setEditing({ ...editing, default_per_image_seconds: Math.max(2, Math.min(60, +e.target.value || 7)) })}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 text-xs outline-none" />
                </label>
              </div>

              <div className="block">
                <span className="mb-1 block text-[10px] text-ink-muted">默认画风提示词（可从预设选后编辑；也可存为新预设/编辑已有预设）</span>
                <div className="mb-1 flex gap-1">
                  <select value="" onChange={(e) => { const p = stylePresets.find((x) => x.id === +e.target.value); if (p) setEditing({ ...editing, default_style_prompt: p.prompt }); }}
                    className="min-w-0 flex-1 rounded border border-line bg-surface-card px-2 py-1.5 text-xs outline-none">
                    <option value="">{stylePresets.length ? "选画风预设填入…" : "暂无预设，点右侧＋新建"}</option>
                    {stylePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {stylePresets.length > 0 && (
                    <select value="" onChange={(e) => { if (e.target.value) openPresetModal(+e.target.value); }}
                      className="shrink-0 rounded border border-line bg-surface-card px-1.5 py-1.5 text-xs outline-none" title="编辑已有预设">
                      <option value="">编辑预设…</option>
                      {stylePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  <button type="button" onClick={() => openPresetModal(null)}
                    className="flex shrink-0 items-center gap-1 rounded border border-dashed border-line px-2 py-1.5 text-xs hover:border-pink-400"
                    title="把当前画风文本存为新预设"><Plus size={11} /> 存为</button>
                </div>
                <textarea value={editing.default_style_prompt} rows={2}
                  onChange={(e) => setEditing({ ...editing, default_style_prompt: e.target.value })}
                  placeholder="如: 2D电影感插画, 暖色调" className="w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
              </div>

              {/* 画面文字/字幕样式 */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-ink-muted flex-1">画面文字/字幕样式（{ovItems.length} 条文字）</span>
                <button onClick={() => setOvModal(true)} className="rounded-lg border border-line px-2 py-1 text-xs hover:border-pink-400">编辑</button>
              </div>

              {/* 封面 */}
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-ink-muted flex-1">
                  <input type="checkbox" checked={editing.cover_enabled} onChange={(e) => setEditing({ ...editing, cover_enabled: e.target.checked })} className="accent-pink-500" />
                  生成封面（第一帧）
                </label>
                {editing.cover_enabled && <button onClick={() => setCvModal(true)} className="rounded-lg border border-line px-2 py-1 text-xs hover:border-pink-400">封面样式</button>}
              </div>

              {/* BGM 分类 + 该分类曲库管理 */}
              <div>
                <span className="mb-1 block text-[10px] text-ink-muted">BGM 轮转分类</span>
                <select value={editing.bgm_category} onChange={(e) => setEditing({ ...editing, bgm_category: e.target.value })}
                  className="w-full rounded border border-line bg-surface-card px-2 py-1.5 text-xs outline-none">
                  <option value="">无 BGM</option>
                  <option value="auto">自动(按AI判定的题材选古风/现代)</option>
                  <option value="古风">古风</option>
                  <option value="现代">现代</option>
                </select>
                {editing.bgm_category === "auto" && (
                  <div className="mt-1.5 rounded-lg border border-line p-2 text-[10px] text-ink-muted">
                    自动模式: 每个任务按 AI 分析全文/标题/标签得出的题材(古风或现代), 用对应曲库轮转。下方可管理两个分类的曲库。
                  </div>
                )}
                {/* 选了具体分类 → 显示该分类曲库(可试听; 管理员可上传/删除) */}
                {editing.bgm_category && editing.bgm_category !== "auto" && (
                  <div className="mt-1.5 rounded-lg border border-line p-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px] text-ink-muted">
                      <span className="flex-1">「{editing.bgm_category}」曲库 {(bgmGrouped[editing.bgm_category] || []).length} 首（轮转时按顺序循环）</span>
                      {canManageBgm && (
                        <label className="flex cursor-pointer items-center gap-1 rounded border border-dashed border-line px-2 py-0.5 hover:border-pink-400" title="上传 BGM 到该分类">
                          {bgmUploading === editing.bgm_category ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />} 上传
                          <input type="file" accept="audio/*" multiple className="hidden"
                            onChange={(e) => uploadBgm(editing.bgm_category, e.target.files)} />
                        </label>
                      )}
                    </div>
                    {(bgmGrouped[editing.bgm_category] || []).length === 0 && (
                      <div className="text-[10px] text-ink-muted">该分类暂无 BGM{canManageBgm ? "，点右上「上传」添加" : "（需管理员上传）"}</div>
                    )}
                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      {(bgmGrouped[editing.bgm_category] || []).map((b: any) => (
                        <div key={b.id} className="flex items-center gap-2 rounded border border-line bg-surface-card px-2 py-1 text-xs">
                          <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          {b.url && <audio src={b.url} controls className="h-6 w-28 shrink-0" />}
                          {canManageBgm && (
                            <button type="button" onClick={() => deleteBgm(b.id)} className="shrink-0 text-ink-muted hover:text-red-400" title="删除"><X size={12} /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* auto 模式: 两个分类曲库都展开管理 */}
                {editing.bgm_category === "auto" && ["古风", "现代"].map((cat) => (
                  <div key={cat} className="mt-1.5 rounded-lg border border-line p-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px] text-ink-muted">
                      <span className="flex-1">「{cat}」曲库 {(bgmGrouped[cat] || []).length} 首</span>
                      {canManageBgm && (
                        <label className="flex cursor-pointer items-center gap-1 rounded border border-dashed border-line px-2 py-0.5 hover:border-pink-400" title={`上传 BGM 到${cat}`}>
                          {bgmUploading === cat ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />} 上传
                          <input type="file" accept="audio/*" multiple className="hidden"
                            onChange={(e) => uploadBgm(cat, e.target.files)} />
                        </label>
                      )}
                    </div>
                    {(bgmGrouped[cat] || []).length === 0 && (
                      <div className="text-[10px] text-ink-muted">该分类暂无 BGM{canManageBgm ? "，点右上「上传」添加" : "（需管理员上传）"}</div>
                    )}
                    <div className="max-h-24 space-y-1 overflow-y-auto">
                      {(bgmGrouped[cat] || []).map((b: any) => (
                        <div key={b.id} className="flex items-center gap-2 rounded border border-line bg-surface-card px-2 py-1 text-xs">
                          <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          {b.url && <audio src={b.url} controls className="h-6 w-28 shrink-0" />}
                          {canManageBgm && (
                            <button type="button" onClick={() => deleteBgm(b.id)} className="shrink-0 text-ink-muted hover:text-red-400" title="删除"><X size={12} /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* 音色模式 男/女/自动/自定义 */}
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] text-ink-muted">
                  <span className="flex-1">音色模式（男/女=对应性别池轮转；自动=AI判断每篇主角性别选池；自定义=下方勾选轮转）</span>
                  <button onClick={() => router.push("/novel-video")} className="text-pink-300 hover:text-pink-200" title="去主页上传音色">上传</button>
                </div>
                <div className="mb-1.5 flex gap-1">
                  {[
                    { v: "male", l: "男" },
                    { v: "female", l: "女" },
                    { v: "auto", l: "自动" },
                    { v: "custom", l: "自定义" },
                  ].map((o) => (
                    <button key={o.v} type="button" onClick={() => setEditing({ ...editing, voice_mode: o.v })}
                      className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                        (editing.voice_mode || "custom") === o.v ? "border-pink-500 bg-pink-500/15 text-pink-200"
                          : "border-line bg-surface-card hover:bg-surface-card-hover"
                      }`}>{o.l}</button>
                  ))}
                </div>
                <div className="mb-1.5 text-[10px] text-ink-muted">
                  {(editing.voice_mode || "custom") === "male" && `将在「男」音色池(${voices.filter((v) => v.gender === "male").length} 个)按任务轮转`}
                  {editing.voice_mode === "female" && `将在「女」音色池(${voices.filter((v) => v.gender === "female").length} 个)按任务轮转`}
                  {editing.voice_mode === "auto" && `每篇 AI 分析主角性别, 自动从对应性别池选音色`}
                  {(editing.voice_mode || "custom") === "custom" && `从下方勾选的音色里按任务顺序轮转(不选则用全部音色库)`}
                </div>
                {voices.length === 0 && <div className="text-[10px] text-ink-muted">音色库为空，请先在小说转视频主页上传音色</div>}
                {/* 自定义模式才显示勾选池 */}
                {(editing.voice_mode || "custom") === "custom" && (
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {voices.map((v) => {
                      const on = (editing.voice_oss_keys || []).includes(v.oss_key);
                      return (
                        <div key={v.id} className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-xs ${on ? "border-pink-500/60 bg-pink-500/10" : "border-line bg-surface-card"}`}>
                          <button type="button" onClick={() => toggleVoiceInCfg(v.oss_key)} className="shrink-0">
                            {on ? <CheckSquare size={14} className="text-pink-400" /> : <Square size={14} className="text-ink-muted" />}
                          </button>
                          <Mic size={11} className="shrink-0 text-ink-muted" />
                          <span className="min-w-0 flex-1 truncate">{v.name}</span>
                          <span className={`shrink-0 rounded px-1 text-[9px] ${
                            v.gender === "male" ? "bg-blue-500/20 text-blue-300"
                              : v.gender === "female" ? "bg-pink-500/20 text-pink-300" : "bg-surface-elevated text-ink-muted"
                          }`}>{v.gender === "male" ? "男" : v.gender === "female" ? "女" : "未分类"}</span>
                          {v.url && <audio src={v.url} controls className="h-6 w-24 shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* 非自定义: 只读展示对应池音色, 便于确认 */}
                {(editing.voice_mode || "custom") !== "custom" && voices.length > 0 && (
                  <div className="max-h-28 space-y-1 overflow-y-auto">
                    {voices
                      .filter((v) => editing.voice_mode === "auto" || v.gender === editing.voice_mode)
                      .map((v) => (
                        <div key={v.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-card px-2 py-1 text-xs">
                          <Mic size={11} className="shrink-0 text-ink-muted" />
                          <span className="min-w-0 flex-1 truncate">{v.name}</span>
                          <span className={`shrink-0 rounded px-1 text-[9px] ${
                            v.gender === "male" ? "bg-blue-500/20 text-blue-300"
                              : v.gender === "female" ? "bg-pink-500/20 text-pink-300" : "bg-surface-elevated text-ink-muted"
                          }`}>{v.gender === "male" ? "男" : v.gender === "female" ? "女" : "未分类"}</span>
                          {v.url && <audio src={v.url} controls className="h-6 w-24 shrink-0" />}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <button onClick={() => setEditing(null)} className="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-card">取消</button>
              <button onClick={saveCfg} disabled={saving} className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                {saving ? <Loader2 size={12} className="inline animate-spin" /> : null} 保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 画面文字/字幕样式编辑器(复用主页组件, 自包弹窗外壳) */}
      {ovModal && (
        <div onClick={() => setOvModal(false)} className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">画面文字/字幕样式（比例 {editing?.default_ratio || "4:3"}）</div>
              <button onClick={() => setOvModal(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              <OverlayEditor
                ratioW={RATIO_WH[editing?.default_ratio || "4:3"][0]}
                ratioH={RATIO_WH[editing?.default_ratio || "4:3"][1]}
                items={ovItems} setItems={setOvItems}
                subtitle={ovSub} setSubtitle={setOvSub}
                dark={typeof document !== "undefined" ? !document.documentElement.classList.contains("light") : true}
              />
            </div>
            <div className="flex justify-end border-t border-line px-4 py-3">
              <button onClick={() => setOvModal(false)} className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600">完成</button>
            </div>
          </div>
        </div>
      )}
      {cvModal && (
        <div onClick={() => setCvModal(false)} className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">封面样式（比例 {editing?.default_ratio || "4:3"}） · {"{title}"}=AI剧名 {"{tags}"}=标签</div>
              <button onClick={() => setCvModal(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              <OverlayEditor
                ratioW={RATIO_WH[editing?.default_ratio || "4:3"][0]}
                ratioH={RATIO_WH[editing?.default_ratio || "4:3"][1]}
                items={cvItems} setItems={setCvItems}
                subtitle={DEFAULT_SUBTITLE} setSubtitle={() => {}}
                dark={typeof document !== "undefined" ? !document.documentElement.classList.contains("light") : true}
              />
            </div>
            <div className="flex justify-end border-t border-line px-4 py-3">
              <button onClick={() => setCvModal(false)} className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600">完成</button>
            </div>
          </div>
        </div>
      )}

      {/* 画风预设 存为/编辑 弹窗 */}
      {presetModal && (
        <div onClick={() => setPresetModal(false)} className="fixed inset-0 z-[58] flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-line bg-surface-elevated p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">{presetEditId == null ? "新建画风预设" : "编辑画风预设"}</div>
              <button onClick={() => setPresetModal(false)} className="rounded p-1 hover:bg-white/10"><X size={16} /></button>
            </div>
            <label className="mb-2 block">
              <span className="mb-1 block text-[10px] text-ink-muted">预设名</span>
              <input value={presetName} onChange={(e) => setPresetName(e.target.value)}
                placeholder="如：电影感暖色 / 写实插画 / 国风水墨"
                className="w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-[10px] text-ink-muted">画风提示词</span>
              <textarea value={presetPrompt} onChange={(e) => setPresetPrompt(e.target.value)} rows={5}
                placeholder="全局画风提示词，会拼到每条生图提示词前"
                className="w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
            </label>
            <div className="flex items-center justify-between gap-2">
              {presetEditId != null ? (
                <button onClick={() => deletePreset(presetEditId)}
                  className="rounded-lg border border-red-400/50 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10">删除预设</button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => setPresetModal(false)}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-card">取消</button>
                <button onClick={savePreset} disabled={presetSaving}
                  className="rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                  {presetSaving ? <Loader2 size={12} className="inline animate-spin" /> : null} 保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
