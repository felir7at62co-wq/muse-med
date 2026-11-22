"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken, canNovelVideo, isAdmin } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import OverlayEditor, { DEFAULT_ITEMS, DEFAULT_SUBTITLE, type OverlayItem, type Subtitle } from "./_OverlayEditor";
import {
  ArrowLeft, Loader2, Image as ImageIcon, Mic, Film, Plus, X,
  RefreshCw, Play, BookOpen, FileText, Upload, Type, Table2,
} from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/novel-video`;

type Shot = {
  id: number; idx: number; text_segment: string; image_prompt: string;
  status: string; image_url?: string | null; error?: string | null;
  is_cover?: boolean;   // 封面虚拟分镜(id=-1): 只展示, 不可改词/重生成
};
type JobDetail = {
  id: number; title: string; status: string; progress: number;
  image_count: number; audio_duration: number; style_prompt: string;
  error?: string | null; video_url?: string | null; audio_url?: string | null; shots: Shot[];
};
type JobBrief = {
  id: number; title: string; status: string; progress: number;
  image_count: number; audio_duration: number; video_oss_key?: string | null; error?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中", audio: "配音中", prompting: "生成提示词", imaging: "生图中",
  await_confirm: "待确认", compositing: "合成中", succeeded: "已完成", failed: "失败", canceled: "已取消",
};

// 清晰度: 短边像素
const QUALITY: { id: string; label: string; short: number }[] = [
  { id: "1k", label: "1K", short: 1080 },
  { id: "2k", label: "2K", short: 1440 },
  { id: "4k", label: "4K", short: 2160 },
];
// 比例: [w比, h比]
const RATIO: { id: string; label: string; w: number; h: number }[] = [
  { id: "9:16", label: "9:16 竖屏", w: 9, h: 16 },
  { id: "16:9", label: "16:9 横屏", w: 16, h: 9 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "1:1", label: "1:1 方形", w: 1, h: 1 },
];
// 由清晰度(短边)+比例 → 实际宽高(短边对齐到清晰度, 长边按比例放大, 都取偶数)
function resolve(qId: string, rId: string): { w: number; h: number } {
  const q = QUALITY.find((x) => x.id === qId) || QUALITY[0];
  const r = RATIO.find((x) => x.id === rId) || RATIO[0];
  const short = q.short;
  const isPortrait = r.h >= r.w;
  let w: number, h: number;
  if (isPortrait) { w = short; h = Math.round((short * r.h) / r.w); }
  else { h = short; w = Math.round((short * r.w) / r.h); }
  const even = (n: number) => (n % 2 ? n + 1 : n);
  return { w: even(w), h: even(h) };
}

type FileItem = { name: string; text: string; refKeys?: string[] };

export default function NovelVideoPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/jubengongfang/login?from=/novel-video";
      return null;
    }
    // 无"小说转视频"权限的普通用户直接挡回首页(后端也有 require_novel_video 兜底)
    if (!canNovelVideo()) {
      window.location.href = "/jubengongfang/";
      return null;
    }
  }
  // 是否可管理 BGM 素材: 仅管理员(普通授权用户只能选用, 不能上传/删除)
  const canManageBgm = typeof window !== "undefined" && isAdmin();
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [jobs, setJobs] = useState<JobBrief[]>([]);
  const [sel, setSel] = useState<JobDetail | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [autoCompose, setAutoCompose] = useState(false);   // 全自动: 配音+生图+合成一条龙
  const [selectMode, setSelectMode] = useState(false);      // 历史多选模式
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [bgmCategory, setBgmCategory] = useState("");       // "" | 古风 | 现代
  const [bgmMgrOpen, setBgmMgrOpen] = useState(false);       // BGM 管理弹窗
  const [bgmGrouped, setBgmGrouped] = useState<Record<string, any[]>>({});
  const [bgmUploading, setBgmUploading] = useState("");      // 正在上传的分类

  // 表单
  const [novels, setNovels] = useState<string[]>([""]);
  const [fileItems, setFileItems] = useState<FileItem[]>([]);  // 上传文件, 各可有专属垫图
  const [stylePrompt, setStylePrompt] = useState("");
  // 画风提示词预设(命名保存, 下拉复用)
  const [stylePresets, setStylePresets] = useState<{ id: number; name: string; prompt: string }[]>([]);
  const [stylePresetId, setStylePresetId] = useState<number | null>(null);  // 当前选中的预设 id
  const [presetModalOpen, setPresetModalOpen] = useState(false);            // 预设编辑弹窗
  const [presetEditId, setPresetEditId] = useState<number | null>(null);     // 编辑中的预设(null=新建)
  const [presetName, setPresetName] = useState("");
  const [presetPrompt, setPresetPrompt] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [refKeys, setRefKeys] = useState<string[]>([]);        // 默认垫图(多张), 应用到所有未单独设置的任务
  const [voiceKey, setVoiceKey] = useState("");      // 当前选中音色的 oss_key(自定义模式用)
  const [voiceName, setVoiceName] = useState("");
  const [voiceMode, setVoiceMode] = useState<"male" | "female" | "auto" | "custom">("auto");  // 音色模式
  const [voices, setVoices] = useState<{ id: number; name: string; oss_key: string; gender?: string | null; url?: string | null }[]>([]);
  const [ovIdx, setOvIdx] = useState<number | null>(null);     // 正在设置专属垫图的文件下标
  const [quality, setQuality] = useState("1k");
  const [ratio, setRatio] = useState("9:16");
  const [fps, setFps] = useState(30);
  const [perImageSeconds, setPerImageSeconds] = useState(10);  // 每 X 秒一张图([2,60], 后端也会 clamp)
  // 画面文字条目 + 字幕样式(可视化编辑)
  const [overlayItems, setOverlayItems] = useState<OverlayItem[]>(DEFAULT_ITEMS);
  const [subtitle, setSubtitle] = useState<Subtitle>(DEFAULT_SUBTITLE);
  const [overlayModalOpen, setOverlayModalOpen] = useState(false);
  // 封面(视频第一帧): 开关 + 文字布局(占位符 {title}/{tags}) + 样式预设
  const [coverEnabled, setCoverEnabled] = useState(false);
  const [coverItems, setCoverItems] = useState<OverlayItem[]>([
    { id: "cvtitle", text: "{title}", xPct: 0.12, yPct: 0.12, fontPct: 0.09, vertical: false, font: "sans-bold", color: "#ffffff", stroke: "#000000" },
    { id: "cvtags", text: "{tags}/完结", xPct: 0.12, yPct: 0.26, fontPct: 0.045, vertical: false, font: "sans", color: "#ffe08a", stroke: "#000000" },
  ]);
  const [coverModalOpen, setCoverModalOpen] = useState(false);
  const [coverSubtitle, setCoverSubtitle] = useState<Subtitle>(DEFAULT_SUBTITLE);  // 封面不用字幕, 占位满足组件签名
  const [coverPresets, setCoverPresets] = useState<{ id: number; name: string; layout: any }[]>([]);
  const [coverPresetId, setCoverPresetId] = useState<number | null>(null);
  // 画面文字/字幕样式预设(飞书自动化按 `飞书自动化{比例}` 命名匹配)
  const [overlayPresets, setOverlayPresets] = useState<{ id: number; name: string; layout: any }[]>([]);
  const [overlayPresetId, setOverlayPresetId] = useState<number | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);

  const [lightbox, setLightbox] = useState<string | null>(null);
  const [regenId, setRegenId] = useState<number | null>(null);
  // 改提示词重生成
  const [editShot, setEditShot] = useState<Shot | null>(null);
  const [editPrompt, setEditPrompt] = useState("");

  // 上传单张图 → oss_key
  const uploadImage = async (file: File): Promise<string | null> => {
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await fetch(`${API}/upload-image-ref`, { method: "POST", headers: authHeaders(), body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      return d.oss_key;
    } catch (e: any) { setErr(`垫图上传失败: ${e.message}`); return null; }
  };

  // 音色库: 列表加载
  const loadVoices = useCallback(async () => {
    try {
      const r = await fetch(`${API}/voices`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setVoices(d.voices || []);
    } catch (e: any) { setErr(`音色库加载失败: ${e.message}`); }
  }, []);

  // 上传参考音色(可多选): 入音色库, 上传后刷新列表并自动选中最后一个。
  // gender 指定该批音色进入哪个性别池(male/female); 未传则后端按文件名推断。
  const uploadVoice = async (files: FileList | null, gender?: "male" | "female") => {
    if (!files?.length) return;
    setUploadingVoice(true);
    try {
      let lastKey = "", lastName = "";
      const q = gender ? `?gender=${gender}` : "";
      for (const f of Array.from(files)) {
        const fd = new FormData(); fd.append("file", f);
        const r = await fetch(`${API}/upload-voice-ref${q}`, { method: "POST", headers: authHeaders(), body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
        lastKey = d.oss_key; lastName = d.name || f.name;
      }
      await loadVoices();
      if (lastKey) { setVoiceKey(lastKey); setVoiceName(lastName); }
    } catch (e: any) { setErr(`音色上传失败: ${e.message}`); }
    finally { setUploadingVoice(false); }
  };

  // 删除音色库里的一个音色
  const deleteVoice = async (id: number, oss_key: string) => {
    try {
      const r = await fetch(`${API}/voices/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      if (voiceKey === oss_key) { setVoiceKey(""); setVoiceName(""); }
      await loadVoices();
    } catch (e: any) { setErr(`删除音色失败: ${e.message}`); }
  };

  // 画风预设: 列表加载
  const loadStylePresets = useCallback(async () => {
    try {
      const r = await fetch(`${API}/style-presets`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setStylePresets(d.presets || []);
    } catch (e: any) { setErr(`预设加载失败: ${e.message}`); }
  }, []);

  // 选中一个预设 → 把 prompt 填入风格框
  const applyStylePreset = (id: number | null) => {
    setStylePresetId(id);
    if (id == null) return;  // "自定义"不改动当前 prompt
    const p = stylePresets.find((x) => x.id === id);
    if (p) setStylePrompt(p.prompt || "");
  };

  // 打开预设编辑弹窗(id=null 新建; 否则编辑)
  const openPresetModal = (id: number | null) => {
    if (id == null) {
      setPresetEditId(null); setPresetName(""); setPresetPrompt(stylePrompt || "");
    } else {
      const p = stylePresets.find((x) => x.id === id);
      setPresetEditId(id); setPresetName(p?.name || ""); setPresetPrompt(p?.prompt || "");
    }
    setPresetModalOpen(true);
  };

  // 保存预设(新建或更新), 保存后刷新列表并选中它、把 prompt 填入风格框
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) { setErr("预设名不能为空"); return; }
    setPresetSaving(true); setErr("");
    try {
      const url = presetEditId == null ? `${API}/style-presets` : `${API}/style-presets/${presetEditId}`;
      const method = presetEditId == null ? "POST" : "PUT";
      const r = await fetch(url, {
        method, headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt: presetPrompt || "" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      await loadStylePresets();
      setStylePresetId(d.id); setStylePrompt(d.prompt || "");
      setPresetModalOpen(false);
    } catch (e: any) { setErr(`保存预设失败: ${e.message}`); }
    finally { setPresetSaving(false); }
  };

  // 删除预设
  const deletePreset = async (id: number) => {
    try {
      const r = await fetch(`${API}/style-presets/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      if (stylePresetId === id) setStylePresetId(null);
      await loadStylePresets();
      setPresetModalOpen(false);
    } catch (e: any) { setErr(`删除预设失败: ${e.message}`); }
  };

  // 默认垫图: 多张上传
  const onPickDefaultRefs = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadingImg(true);
    try {
      const keys: string[] = [];
      for (const f of Array.from(files)) {
        const k = await uploadImage(f);
        if (k) keys.push(k);
      }
      setRefKeys((prev) => [...prev, ...keys]);
    } finally { setUploadingImg(false); }
  };

  // 某文件的专属垫图: 多张上传
  const onPickFileRefs = async (idx: number, files: FileList | null) => {
    if (!files?.length) return;
    setUploadingImg(true);
    try {
      const keys: string[] = [];
      for (const f of Array.from(files)) {
        const k = await uploadImage(f);
        if (k) keys.push(k);
      }
      setFileItems((arr) => arr.map((x, j) => (j === idx ? { ...x, refKeys: [...(x.refKeys || []), ...keys] } : x)));
    } finally { setUploadingImg(false); }
  };

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/jobs`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setJobs(d.jobs || []);
    } catch (e: any) { setErr(e.message || "加载失败"); }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const r = await fetch(`${API}/jobs/${id}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSel(await r.json());
    } catch (e: any) { setErr(e.message || "详情加载失败"); }
  }, []);

  // 清空所有「失败」任务(普通任务列表, 非飞书): 二次确认后调后端 DELETE /jobs/failed
  const clearFailedJobs = useCallback(async () => {
    const failedCount = jobs.filter((j) => j.status === "failed").length;
    if (failedCount === 0) { setErr("当前没有失败的任务"); return; }
    if (!window.confirm(`确定清空 ${failedCount} 个失败任务? (连带其图片/音频记录, 不可恢复)`)) return;
    try {
      const r = await fetch(`${API}/jobs/failed`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      if (selId && jobs.find((j) => j.id === selId)?.status === "failed") { setSelId(null); setSel(null); }
      await loadJobs();
      setErr(`已清空 ${d.deleted ?? failedCount} 个失败任务`);
    } catch (e: any) { setErr(`清空失败任务出错: ${e.message}`); }
  }, [jobs, selId, loadJobs]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  useEffect(() => {
    if (selId == null) return;
    loadDetail(selId);
    const t = setInterval(() => { loadDetail(selId); loadJobs(); }, 5000);
    return () => clearInterval(t);
  }, [selId, loadDetail, loadJobs]);

  // 多文件: 读取每个文件正文, 每文件 = 一个任务。
  // txt/md 前端直接读; docx/pdf 是二进制, 走后端 /extract-text 提取纯文本。
  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const items: FileItem[] = [];
    for (const f of Array.from(files)) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      try {
        if (ext === "docx" || ext === "pdf") {
          const fd = new FormData(); fd.append("file", f);
          const r = await fetch(`${API}/extract-text`, { method: "POST", headers: authHeaders(), body: fd });
          const d = await r.json();
          if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
          const text = (d.text || "").trim();
          if (!text) { setErr(`${f.name} 未提取到文本(可能是扫描件/纯图片)`); continue; }
          items.push({ name: f.name, text });
        } else {
          items.push({ name: f.name, text: await f.text() });
        }
      } catch (e: any) { setErr(`读取 ${f.name} 失败: ${e.message || e}`); }
    }
    setFileItems((prev) => [...prev, ...items]);
  };

  const createJobs = async () => {
    // 粘贴的多篇(用默认垫图) + 上传的多文件(有专属垫图则用专属, 否则默认)
    const pasted = novels.map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, title: undefined as string | undefined, refKeys }));
    const uploaded = fileItems.filter((x) => x.text.trim()).map((x) => ({
      text: x.text.trim(), title: x.name, refKeys: (x.refKeys && x.refKeys.length) ? x.refKeys : refKeys,
    }));
    const all = [...pasted, ...uploaded];
    if (!all.length) { setErr("请粘贴正文或上传文件"); return; }
    // 音色校验: 自定义模式必须选中一个音色; 男/女/自动模式需对应池非空(后端也会兜底)
    if (voiceMode === "custom" && !voiceKey) { setErr("自定义模式请从音色库选一个音色"); return; }
    if (voiceMode === "male" && voices.filter((v) => v.gender === "male").length === 0) { setErr("「男」音色池为空, 请先上传男声音色"); return; }
    if (voiceMode === "female" && voices.filter((v) => v.gender === "female").length === 0) { setErr("「女」音色池为空, 请先上传女声音色"); return; }
    if (voiceMode === "auto" && voices.length === 0) { setErr("音色库为空, 请先上传音色"); return; }
    const { w, h } = resolve(quality, ratio);
    setCreating(true); setErr("");
    try {
      const body = {
        novels: all.map((n) => ({
          novel_text: n.text,
          title: n.title || undefined,
          style_prompt: stylePrompt,
          ref_image_oss_keys: (n.refKeys && n.refKeys.length) ? n.refKeys : null,
          // 音色: 自定义模式传选中的 oss_key; 男/女/自动模式由后端按 voice_mode 选池, 这里 oss_key 传 null
          voice_mode: voiceMode,
          voice_ref_oss_key: voiceMode === "custom" ? (voiceKey || null) : null,
          overlays: {
            items: overlayItems.map((it) => ({
              text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct,
              vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke,
              align: it.align || "left",
            })),
            subtitle: subtitle,
          },
          width: w, height: h, fps, per_image_seconds: perImageSeconds, image_model: "gpt-image-2",
          cover_enabled: coverEnabled,
          cover_overlays: coverEnabled ? {
            items: coverItems.map((it) => ({
              text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct,
              vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke,
              align: it.align || "left",
            })),
          } : null,
        })),
        auto_compose: autoCompose,
        bgm_category: bgmCategory || null,
      };
      const r = await fetch(`${API}/jobs`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setNovels([""]); setFileItems([]);
      setDrawerOpen(false);
      await loadJobs();
      if (d.job_ids?.length) setSelId(d.job_ids[0]);
    } catch (e: any) { setErr(`创建失败: ${e.message}`); }
    finally { setCreating(false); }
  };

  const regenerate = async (shotId: number, newPrompt?: string | null) => {
    setRegenId(shotId);
    try {
      const r = await fetch(`${API}/shots/${shotId}/regenerate`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ new_prompt: newPrompt ?? null }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (selId) setTimeout(() => loadDetail(selId), 1500);
    } catch (e: any) { setErr(`重生成失败: ${e.message}`); }
    finally { setTimeout(() => setRegenId(null), 1500); }
  };

  // 确认合成 / 重新合成
  const compose = async () => {
    if (!selId) return;
    try {
      const r = await fetch(`${API}/jobs/${selId}/compose`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      setTimeout(() => selId && loadDetail(selId), 800);
    } catch (e: any) { setErr(`合成失败: ${e.message}`); }
  };

  // 重新发起(失败/取消的任务从头重跑, 复用原配置)
  const retryJob = async () => {
    if (!selId) return;
    setErr("");
    try {
      const r = await fetch(`${API}/jobs/${selId}/retry`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      setTimeout(() => { loadJobs(); selId && loadDetail(selId); }, 800);
    } catch (e: any) { setErr(`重新发起失败: ${e.message}`); }
  };

  // 批量下载: 逐个取 OSS 直连下载链接, 分别触发下载(不再后端打包 zip, 避免大文件加载久)。
  // 每个视频用隐藏 iframe 触发(多个 window.location 会互相覆盖), 间隔一点避免浏览器拦截。
  const exportSelected = async () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) { setErr("请先勾选任务"); return; }
    setExporting(true); setErr("");
    let ok = 0;
    try {
      for (const id of ids) {
        try {
          const r = await fetch(`${API}/jobs/${id}/download-url`, { headers: authHeaders() });
          if (!r.ok) continue;
          const d = await r.json();
          if (!d.url) continue;
          const iframe = document.createElement("iframe");
          iframe.style.display = "none";
          iframe.src = d.url;
          document.body.appendChild(iframe);
          // 稍后回收 iframe(下载已由浏览器接管)
          setTimeout(() => iframe.remove(), 60000);
          ok += 1;
          // 间隔, 避免浏览器把连续下载判为弹窗滥用而拦截
          await new Promise((res) => setTimeout(res, 600));
        } catch { /* 跳过失败的, 继续下一个 */ }
      }
      if (ok === 0) setErr("选中的任务没有可下载的成片");
      else { setSelectMode(false); setSelectedIds(new Set()); }
    } finally { setExporting(false); }
  };

  const toggleSel = (id: number) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // 直接下载单个成片: 走后端流式接口(带 Content-Disposition 文件名=任务标题),
  // 避免跨域 OSS URL 的 <a download> 被浏览器忽略而变成"先在页面里加载播放"。
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const downloadOne = async (id: number, _title?: string) => {
    setDownloadingId(id); setErr("");
    try {
      // 先拿"强制下载+指定文件名"的 OSS 预签名 URL, 再让浏览器直连 OSS 下载。
      // 不走后端代理, 避免大视频整块读内存/nginx缓冲导致长时间卡"下载中"。
      const r = await fetch(`${API}/jobs/${id}/download-url`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      if (!d.url) throw new Error("未拿到下载链接");
      // OSS 已带 Content-Disposition: attachment, 直接跳转即触发下载
      window.location.href = d.url;
    } catch (e: any) { setErr(`下载失败: ${e.message}`); }
    finally { setDownloadingId(null); }
  };

  // BGM 管理
  const loadBgm = useCallback(async () => {
    try {
      const r = await fetch(`${API}/bgm`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setBgmGrouped(d.grouped || {});
    } catch (e: any) { setErr(`BGM 加载失败: ${e.message}`); }
  }, []);

  const uploadBgm = async (category: string, files: FileList | null) => {
    if (!files?.length) return;
    setBgmUploading(category);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData(); fd.append("file", f);
        const r = await fetch(`${API}/bgm/upload?category=${encodeURIComponent(category)}`, {
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
      const r = await fetch(`${API}/bgm/${id}`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadBgm();
    } catch (e: any) { setErr(`删除失败: ${e.message}`); }
  };

  useEffect(() => { if (bgmMgrOpen) loadBgm(); }, [bgmMgrOpen, loadBgm]);

  // 封面样式预设: 加载 / 应用 / 存为
  const loadCoverPresets = useCallback(async () => {
    try {
      const r = await fetch(`${API}/cover-presets`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setCoverPresets(d.presets || []);
    } catch (e: any) { setErr(`封面预设加载失败: ${e.message}`); }
  }, []);

  const applyCoverPreset = (id: number | null) => {
    setCoverPresetId(id);
    if (id == null) return;
    const p = coverPresets.find((x) => x.id === id);
    const items = (p?.layout?.items || []) as any[];
    if (items.length) {
      setCoverItems(items.map((it, i) => ({
        id: it.id || `cv${i}`, text: it.text || "", xPct: it.xPct ?? 0.1, yPct: it.yPct ?? 0.1,
        fontPct: it.fontPct ?? 0.06, vertical: !!it.vertical, font: it.font || "sans",
        color: it.color || "#ffffff", stroke: it.stroke || "#000000",
        align: it.align === "center" ? "center" : "left",
      })));
    }
  };

  const saveCoverPreset = async () => {
    const name = (window.prompt("封面样式预设名") || "").trim();
    if (!name) return;
    try {
      const layout = { items: coverItems.map((it) => ({
        text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct,
        vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke,
        align: it.align || "left",
      })) };
      const r = await fetch(`${API}/cover-presets`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, layout }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      await loadCoverPresets();
      setCoverPresetId(d.id);
    } catch (e: any) { setErr(`保存封面预设失败: ${e.message}`); }
  };

  // 画面文字/字幕样式预设: 加载 / 应用 / 存为
  const loadOverlayPresets = useCallback(async () => {
    try {
      const r = await fetch(`${API}/overlay-presets`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setOverlayPresets(d.presets || []);
    } catch (e: any) { setErr(`画面文字预设加载失败: ${e.message}`); }
  }, []);

  const applyOverlayPreset = (id: number | null) => {
    setOverlayPresetId(id);
    if (id == null) return;
    const p = overlayPresets.find((x) => x.id === id);
    const items = (p?.layout?.items || []) as any[];
    setOverlayItems(items.map((it, i) => ({
      id: it.id || `ov${i}`, text: it.text || "", xPct: it.xPct ?? 0.03, yPct: it.yPct ?? 0.03,
      fontPct: it.fontPct ?? 0.03, vertical: !!it.vertical, font: it.font || "sans",
      color: it.color || "#ffffff", stroke: it.stroke || "#000000",
      align: it.align === "center" ? "center" : "left",
    })));
    const sub = p?.layout?.subtitle;
    if (sub) setSubtitle({ ...DEFAULT_SUBTITLE, ...sub });
  };

  const saveOverlayPreset = async () => {
    const name = (window.prompt("画面文字/字幕预设名（飞书自动化请命名为「飞书自动化4:3」）") || "").trim();
    if (!name) return;
    try {
      const layout = {
        items: overlayItems.map((it) => ({
          text: it.text, xPct: it.xPct, yPct: it.yPct, fontPct: it.fontPct,
          vertical: it.vertical, font: it.font, color: it.color, stroke: it.stroke,
          align: it.align || "left",
        })),
        subtitle: subtitle,
      };
      const r = await fetch(`${API}/overlay-presets`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, layout }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      await loadOverlayPresets();
      setOverlayPresetId(d.id);
    } catch (e: any) { setErr(`保存画面文字预设失败: ${e.message}`); }
  };

  // 打开新建任务抽屉时加载音色库 + 画风预设 + 封面预设 + 画面文字预设
  useEffect(() => { if (drawerOpen) { loadVoices(); loadStylePresets(); loadCoverPresets(); loadOverlayPresets(); } }, [drawerOpen, loadVoices, loadStylePresets, loadCoverPresets, loadOverlayPresets]);

  const fmtDur = (s?: number) => {
    if (!s) return "-";
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const preview = resolve(quality, ratio);
  const taskCount = novels.filter((t) => t.trim()).length + fileItems.filter((x) => x.text.trim()).length;

  return (
    <div className="min-h-screen text-ink-primary">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-elevated/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/")} className="rounded-lg p-2 hover:bg-white/10"><ArrowLeft size={18} /></button>
          <BookOpen size={20} className="text-pink-400" />
          <div className="text-sm font-semibold">小说转视频</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => router.push("/feishu-sync")}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:border-pink-400"
            title="飞书多维表格自动转视频">
            <Table2 size={15} /> 飞书自动化
          </button>
          <button onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-pink-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-pink-600">
            <Plus size={15} /> 新建任务
          </button>
          <UserNav />
        </div>
      </div>

      {err && <div className="mx-4 mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</div>}

      {/* 主体: 左窄栏历史 + 主区画廊 (左右各自独立滚动) */}
      <div className="flex gap-3 p-3" style={{ height: "calc(100vh - 57px)" }}>
        {/* 左: 历史(独立滚动, 不跟随右侧图片滚动) */}
        <div className="w-56 shrink-0 overflow-y-auto">
          <div className="rounded-xl border border-line bg-surface-card p-2">
            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-ink-secondary">
              <span>历史任务</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
                  className={selectMode ? "text-pink-300" : "hover:text-ink-primary"}
                  title="多选下载"
                >
                  {selectMode ? "取消" : "多选"}
                </button>
                <button
                  onClick={clearFailedJobs}
                  className="hover:text-red-400"
                  title="清空所有失败任务"
                >
                  清失败
                </button>
                <button onClick={loadJobs} className="hover:text-ink-primary" title="刷新"><RefreshCw size={12} /></button>
              </div>
            </div>
            {/* 多选模式: 全选/导出条 */}
            {selectMode && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-pink-500/30 bg-pink-500/5 px-2 py-1.5 text-[11px]">
                <button
                  onClick={() => {
                    const done = jobs.filter((j) => j.video_oss_key).map((j) => j.id);
                    setSelectedIds((prev) => prev.size === done.length ? new Set() : new Set(done));
                  }}
                  className="text-ink-secondary hover:text-ink-primary"
                >
                  全选成片
                </button>
                <span className="text-ink-muted">已选 {selectedIds.size}</span>
                <button
                  onClick={exportSelected}
                  disabled={exporting || selectedIds.size === 0}
                  className="ml-auto rounded bg-pink-500 px-2 py-0.5 font-medium text-white hover:bg-pink-600 disabled:opacity-50"
                >
                  {exporting ? "下载中…" : "下载选中"}
                </button>
              </div>
            )}
            <div className="space-y-1">
              {jobs.length === 0 && <div className="px-1 text-xs text-ink-muted">暂无任务</div>}
              {jobs.map((j) => (
                <div
                  key={j.id}
                  onClick={() => selectMode ? (j.video_oss_key && toggleSel(j.id)) : setSelId(j.id)}
                  className={`w-full cursor-pointer rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                    (selectMode ? selectedIds.has(j.id) : selId === j.id)
                      ? "border-pink-500/50 bg-pink-500/10" : "border-line bg-surface-card hover:bg-surface-card-hover"
                  }`}>
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {selectMode && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(j.id)}
                          disabled={!j.video_oss_key}
                          onChange={() => j.video_oss_key && toggleSel(j.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="h-3 w-3 shrink-0 accent-pink-500"
                          title={j.video_oss_key ? "" : "无成片, 不可选"}
                        />
                      )}
                      <span className="truncate">{j.title}</span>
                    </div>
                    <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${
                      j.status === "succeeded" ? "bg-green-500/20 text-green-300"
                        : j.status === "failed" ? "bg-red-500/20 text-red-300" : "bg-blue-500/20 text-blue-300"
                    }`}>{STATUS_LABEL[j.status] || j.status}</span>
                  </div>
                  {j.status !== "succeeded" && j.status !== "failed" && (
                    <div className="mt-1 h-1 w-full overflow-hidden rounded bg-surface-elevated">
                      <div className="h-full bg-pink-500 transition-all" style={{ width: `${j.progress || 0}%` }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 主区: 画廊(独立滚动) */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {!sel && (
            <div className="mt-24 text-center text-sm text-ink-muted">
              <Film size={32} className="mx-auto mb-3 opacity-40" />
              选择左侧任务查看，或点右上角「新建任务」
            </div>
          )}
          {sel && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-card p-3">
                <div className="text-sm font-medium">{sel.title}</div>
                <span className="rounded bg-surface-elevated px-2 py-0.5 text-xs">{STATUS_LABEL[sel.status] || sel.status}</span>
                <span className="text-xs text-ink-secondary">图 {sel.image_count} 张 · 配音 {fmtDur(sel.audio_duration)}</span>
                {sel.status !== "succeeded" && sel.status !== "failed" && (
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface-elevated">
                    <div className="h-full bg-pink-500 transition-all" style={{ width: `${sel.progress || 0}%` }} />
                  </div>
                )}
                {sel.error && <span className="text-xs text-red-300">{sel.error}</span>}
                {/* 生图完成待确认, 或已完成想改图重合成 */}
                {(sel.status === "await_confirm" || sel.status === "succeeded") && (
                  <button onClick={compose}
                    className="ml-auto rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-600">
                    {sel.status === "await_confirm" ? "确认并合成视频" : "重新合成视频"}
                  </button>
                )}
                {/* 失败/取消: 一键重新发起(复用原配置, 从头重跑) */}
                {(sel.status === "failed" || sel.status === "canceled") && (
                  <button onClick={retryJob}
                    className="ml-auto flex items-center gap-1 rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-600">
                    <RefreshCw size={12} /> 重新发起
                  </button>
                )}
              </div>
              {sel.status === "await_confirm" && (
                <div className="mb-3 rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
                  图片已全部生成。可对不满意的图点「改词重生成」或「重生成」，满意后点右上「确认并合成视频」。
                </div>
              )}

              {sel.video_url && (
                <div className="mb-3 rounded-xl border border-line bg-surface-card p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Play size={14} className="text-pink-400" />成片</div>
                  <video key={sel.video_url} src={sel.video_url} controls className="max-h-[70vh] w-full rounded-lg bg-black" />
                  <button
                    onClick={() => downloadOne(sel.id, sel.title)}
                    disabled={downloadingId === sel.id}
                    className="mt-2 inline-block text-xs text-pink-300 hover:text-pink-200 disabled:opacity-50"
                  >
                    {downloadingId === sel.id ? "下载中…" : "⬇ 下载成片"}
                  </button>
                </div>
              )}

              <div className="grid grid-cols-10 gap-1 sm:grid-cols-10 md:grid-cols-12 lg:grid-cols-14 xl:grid-cols-16">
                {sel.shots.map((sh) => (
                  <div key={sh.id} className="group relative overflow-hidden rounded-lg border border-line bg-surface-card">
                    <div className="relative aspect-[9/16] w-full bg-black/40">
                      {sh.image_url ? (
                        <img src={sh.image_url} alt=""
                          onClick={() => sh.image_url && setLightbox(sh.image_url)}
                          className="h-full w-full cursor-zoom-in object-cover transition-transform duration-200 group-hover:scale-105"
                          referrerPolicy="no-referrer" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-ink-muted">
                          {sh.status === "failed" ? <X size={20} className="text-red-400" /> : <Loader2 size={18} className="animate-spin" />}
                        </div>
                      )}
                      <div className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                        {sh.is_cover ? "封面" : `#${sh.idx + 1}`}
                      </div>
                      {/* 封面虚拟分镜只展示, 不给改词/重生成按钮(点了会 404); 普通分镜正常给 */}
                      {!sh.is_cover && (
                        <div className="absolute right-1 top-1 flex gap-1">
                          <button onClick={() => { setEditShot(sh); setEditPrompt(sh.image_prompt || sh.text_segment || ""); }}
                            title="改提示词重生成"
                            className="rounded bg-black/70 p-1 text-white hover:bg-pink-500">
                            <FileText size={11} />
                          </button>
                          {/* 措辞统一（审计 §2.4）：原 title 是「直接重新生成」，属被点名
                              要收敛的 5 种叫法之一。这里是图标按钮，title 是它**唯一**
                              的可见标签 —— 更要与平台其它位置说同一个词。
                              「直接」两字不传达任何区别（旁边那颗是「改提示词重生成」，
                              已经由 FileText 图标与 title 区分开了）。 */}
                          <button onClick={() => regenerate(sh.id)} disabled={regenId === sh.id} title="重新生成"
                            className="rounded bg-black/70 p-1 text-white hover:bg-pink-500 disabled:opacity-50">
                            {regenId === sh.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="line-clamp-2 p-1 text-[10px] text-ink-muted">{sh.text_segment}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 新建任务抽屉 */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={() => setDrawerOpen(false)}>
          <div className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface-elevated p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-base font-semibold">新建任务</div>
              <button onClick={() => setDrawerOpen(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>

            {/* ① 内容 */}
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium text-pink-300">① 内容（每篇/每个文件各生成一个视频）</div>
              <label className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-line py-3 text-xs hover:bg-surface-card">
                <Upload size={14} /> 上传文件（可多选 .txt / .md / .docx / .pdf）
                <input type="file"
                  accept=".txt,.md,.docx,.pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
                  multiple className="hidden"
                  onChange={(e) => onPickFiles(e.target.files)} />
              </label>
              {fileItems.length > 0 && (
                <div className="mb-2 space-y-1">
                  {fileItems.map((f, i) => (
                    <div key={i} className="rounded bg-surface-card px-2 py-1 text-xs">
                      <div className="flex items-center gap-1">
                        <FileText size={12} className="shrink-0 text-ink-muted" />
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-ink-muted">{f.text.length}字</span>
                        <label className="shrink-0 cursor-pointer rounded px-1 text-pink-300 hover:text-pink-200" title="为该文件单独设置垫图(覆盖默认)">
                          <ImageIcon size={12} />
                          <input type="file" accept="image/*" multiple className="hidden"
                            onChange={(e) => onPickFileRefs(i, e.target.files)} />
                        </label>
                        <button onClick={() => setFileItems((a) => a.filter((_, j) => j !== i))}
                          className="shrink-0 text-ink-muted hover:text-red-400"><X size={12} /></button>
                      </div>
                      {f.refKeys && f.refKeys.length > 0 && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-pink-300">
                          专属垫图 {f.refKeys.length} 张
                          <button onClick={() => setFileItems((a) => a.map((x, j) => (j === i ? { ...x, refKeys: [] } : x)))}
                            className="text-ink-muted hover:text-red-400">清除</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mb-1 text-[10px] text-ink-muted">或直接粘贴正文：</div>
              {novels.map((t, i) => (
                <div key={i} className="mb-1.5 flex gap-1">
                  <textarea value={t} rows={3}
                    onChange={(e) => setNovels((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={`第 ${i + 1} 篇正文…`}
                    className="flex-1 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
                  {novels.length > 1 && (
                    <button onClick={() => setNovels((arr) => arr.filter((_, j) => j !== i))}
                      className="shrink-0 rounded px-1 text-ink-muted hover:text-red-400"><X size={14} /></button>
                  )}
                </div>
              ))}
              <button onClick={() => setNovels((arr) => [...arr, ""])}
                className="flex items-center gap-1 text-xs text-pink-300 hover:text-pink-200"><Plus size={12} /> 再加一篇</button>
            </div>

            {/* ② 风格 */}
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium text-pink-300">② 风格</div>
              {/* 画风预设: 下拉选择 + 新建/编辑 */}
              <div className="mb-1.5 flex gap-1">
                <select
                  value={stylePresetId ?? ""}
                  onChange={(e) => applyStylePreset(e.target.value ? +e.target.value : null)}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400">
                  <option value="">{stylePresets.length ? "选择画风预设…（或直接在下方编辑）" : "暂无预设，点右侧＋新建"}</option>
                  {stylePresets.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {stylePresetId != null && (
                  <button type="button" onClick={() => openPresetModal(stylePresetId)}
                    className="shrink-0 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs hover:border-pink-400"
                    title="编辑当前预设">编辑</button>
                )}
                <button type="button" onClick={() => openPresetModal(null)}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-line bg-surface-card px-2 py-1.5 text-xs hover:border-pink-400"
                  title="把当前风格文本存为新预设"><Plus size={12} /> 存为预设</button>
              </div>
              <textarea value={stylePrompt}
                onChange={(e) => { setStylePrompt(e.target.value); setStylePresetId(null); }}
                placeholder="全局画风提示词（可选，如：电影感，暖色调，写实插画风）；选预设会填入这里，也可直接编辑" rows={2}
                className="mb-2 w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />

              {/* 默认垫图: 多张网格 */}
              <div className="mb-1 text-[10px] text-ink-muted">默认垫图（多张，控人物一致性；未单独设置的任务都用它）</div>
              <div className="mb-2 flex flex-wrap gap-2">
                {refKeys.map((_, i) => (
                  <div key={i} className="relative flex h-14 w-14 items-center justify-center rounded border border-line bg-surface-card text-[10px] text-ink-muted">
                    图{i + 1}
                    <button onClick={() => setRefKeys((a) => a.filter((_, j) => j !== i))}
                      className="absolute -right-1 -top-1 rounded-full bg-black/70 p-0.5 text-white hover:bg-red-500"><X size={10} /></button>
                  </div>
                ))}
                <label className="flex h-14 w-14 cursor-pointer items-center justify-center rounded border border-dashed border-line text-ink-muted hover:bg-surface-card">
                  {uploadingImg ? <Loader2 size={14} className="animate-spin" /> : <Plus size={16} />}
                  <input type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => onPickDefaultRefs(e.target.files)} />
                </label>
              </div>

              {/* 参考音色: 4 种模式 男/女/自动/自定义 */}
              <div className="mb-1 text-[10px] text-ink-muted">参考音色*（男/女=在对应性别音色池轮转；自动=AI判断主角性别自动选；自定义=手动指定）</div>
              <div className="mb-1.5 flex gap-1">
                {[
                  { v: "male", l: "男" },
                  { v: "female", l: "女" },
                  { v: "auto", l: "自动" },
                  { v: "custom", l: "自定义" },
                ].map((o) => (
                  <button key={o.v} type="button" onClick={() => setVoiceMode(o.v as any)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                      voiceMode === o.v ? "border-pink-500 bg-pink-500/15 text-pink-200"
                        : "border-line bg-surface-card hover:bg-surface-card-hover"
                    }`}>{o.l}</button>
                ))}
              </div>
              {/* 各模式说明 + 池内音色数 */}
              <div className="mb-1.5 text-[10px] text-ink-muted">
                {voiceMode === "male" && `将在「男」音色池(${voices.filter((v) => v.gender === "male").length} 个)按顺序轮转`}
                {voiceMode === "female" && `将在「女」音色池(${voices.filter((v) => v.gender === "female").length} 个)按顺序轮转`}
                {voiceMode === "auto" && `AI 分析每篇主角性别, 自动从对应性别池选音色`}
                {voiceMode === "custom" && `从下方音色库手动选一个固定音色`}
              </div>
              {/* 上传音色(可指定性别) */}
              <div className="mb-2 flex gap-1">
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs hover:bg-surface-card"
                  title="上传音色到「男」池(可多选)">
                  {uploadingVoice ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  传男声
                  <input type="file" accept="audio/*" multiple className="hidden"
                    onChange={(e) => uploadVoice(e.target.files, "male")} />
                </label>
                <label className="flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5 text-xs hover:bg-surface-card"
                  title="上传音色到「女」池(可多选)">
                  {uploadingVoice ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  传女声
                  <input type="file" accept="audio/*" multiple className="hidden"
                    onChange={(e) => uploadVoice(e.target.files, "female")} />
                </label>
              </div>
              {/* 自定义模式: 显示音色库列表供勾选; 每条可改性别归类 + 试听 + 删除 */}
              {voiceMode === "custom" && voices.length > 0 && (
                <div className="mb-2 max-h-40 space-y-1 overflow-y-auto">
                  {voices.map((v) => (
                    <div key={v.id}
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1 text-xs ${
                        voiceKey === v.oss_key ? "border-pink-500/60 bg-pink-500/10" : "border-line bg-surface-card"
                      }`}>
                      <button type="button" onClick={() => { setVoiceKey(v.oss_key); setVoiceName(v.name); }}
                        className="flex min-w-0 flex-1 items-center gap-1 text-left">
                        <Mic size={11} className="shrink-0 text-ink-muted" />
                        <span className="truncate">{v.name}</span>
                        {voiceKey === v.oss_key && <span className="shrink-0 text-[10px] text-pink-300">已选</span>}
                      </button>
                      <span className={`shrink-0 rounded px-1 text-[9px] ${
                        v.gender === "male" ? "bg-blue-500/20 text-blue-300"
                          : v.gender === "female" ? "bg-pink-500/20 text-pink-300" : "bg-surface-elevated text-ink-muted"
                      }`}>{v.gender === "male" ? "男" : v.gender === "female" ? "女" : "未分类"}</span>
                      {v.url && <audio src={v.url} controls className="h-6 w-24 shrink-0" />}
                      <button type="button" onClick={() => deleteVoice(v.id, v.oss_key)}
                        className="shrink-0 text-ink-muted hover:text-red-400" title="从音色库删除"><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              {/* 非自定义模式也展示音色库概览(只读, 便于确认池内有音色) */}
              {voiceMode !== "custom" && voices.length > 0 && (
                <div className="mb-2 max-h-28 space-y-1 overflow-y-auto">
                  {voices.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-card px-2 py-1 text-xs">
                      <Mic size={11} className="shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1 truncate">{v.name}</span>
                      <span className={`shrink-0 rounded px-1 text-[9px] ${
                        v.gender === "male" ? "bg-blue-500/20 text-blue-300"
                          : v.gender === "female" ? "bg-pink-500/20 text-pink-300" : "bg-surface-elevated text-ink-muted"
                      }`}>{v.gender === "male" ? "男" : v.gender === "female" ? "女" : "未分类"}</span>
                      {v.url && <audio src={v.url} controls className="h-6 w-24 shrink-0" />}
                      <button type="button" onClick={() => deleteVoice(v.id, v.oss_key)}
                        className="shrink-0 text-ink-muted hover:text-red-400" title="从音色库删除"><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}

            </div>

            {/* ③ 规格 */}
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium text-pink-300">③ 规格</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">清晰度</span>
                  <select value={quality} onChange={(e) => setQuality(e.target.value)}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 outline-none">
                    {QUALITY.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">比例</span>
                  <select value={ratio} onChange={(e) => setRatio(e.target.value)}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 outline-none">
                    {RATIO.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">帧率</span>
                  <input type="number" value={fps} onChange={(e) => setFps(+e.target.value)}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 outline-none" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ink-muted">每几秒一张图</span>
                  <input type="number" min={2} max={60} value={perImageSeconds}
                    onChange={(e) => setPerImageSeconds(Math.max(2, Math.min(60, +e.target.value || 10)))}
                    className="rounded border border-line bg-surface-card px-2 py-1.5 outline-none" />
                </label>
              </div>
              <div className="mt-1 text-[10px] text-ink-muted">
                实际输出：{preview.w} × {preview.h} @ {fps}fps · 每 {perImageSeconds} 秒切换一张图
                （数值越小图越多、画面越丰富，但生图更贵更慢；范围 2~60 秒）
              </div>
            </div>

            {/* ④ 背景音乐 */}
            <div className="mb-4">
              <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-pink-300">
                <span>④ 背景音乐（可选）</span>
                {canManageBgm && (
                  <button type="button" onClick={() => setBgmMgrOpen(true)}
                    className="text-[10px] text-ink-muted hover:text-pink-300">管理 BGM 素材</button>
                )}
              </div>
              <div className="flex gap-2">
                {[{ v: "", l: "无" }, { v: "古风", l: "古风" }, { v: "现代", l: "现代" }].map((o) => (
                  <button key={o.v} type="button" onClick={() => setBgmCategory(o.v)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                      bgmCategory === o.v ? "border-pink-500 bg-pink-500/15 text-pink-200"
                        : "border-line bg-surface-card hover:bg-surface-card-hover"
                    }`}>{o.l}</button>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-ink-muted">
                选类型后在该池里按顺序轮转选曲(每篇一首, 用完从头); BGM 音量约为配音的 1/3, 不够长自动循环、超出按画面裁剪
              </div>
            </div>

            {/* ⑤ 画面文字 / 字幕(放到规格/比例之后, 符合"先定比例再排文字"的操作逻辑) */}
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium text-pink-300">⑤ 画面文字 / 字幕样式（可选）</div>
              <button type="button" onClick={() => setOverlayModalOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-card py-2.5 text-xs hover:border-pink-400 hover:bg-surface-card-hover">
                <Type size={13} /> 编辑画面文字 / 字幕样式
                <span className="text-ink-muted">（{overlayItems.length} 条文字）</span>
              </button>
              <div className="mt-1 text-[10px] text-ink-muted">在放大编辑器里按当前比例拖拽定位、调字体字号、增删条目；文字中用 {"{min}"} 代表视频时长分钟数</div>
            </div>

            {/* ⑥ 封面(视频第一帧) */}
            <div className="mb-4">
              <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-xs font-medium text-pink-300">
                <input type="checkbox" checked={coverEnabled} onChange={(e) => setCoverEnabled(e.target.checked)}
                  className="h-4 w-4 accent-pink-500" />
                ⑥ 生成封面（视频第一帧）
              </label>
              {coverEnabled && (
                <>
                  <div className="mb-1.5 flex gap-1">
                    <select value={coverPresetId ?? ""} onChange={(e) => applyCoverPreset(e.target.value ? +e.target.value : null)}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400">
                      <option value="">{coverPresets.length ? "选择封面样式预设…" : "暂无预设，可存为"}</option>
                      {coverPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button type="button" onClick={saveCoverPreset}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-line bg-surface-card px-2 py-1.5 text-xs hover:border-pink-400"
                      title="把当前封面样式存为预设"><Plus size={12} /> 存为预设</button>
                  </div>
                  <button type="button" onClick={() => setCoverModalOpen(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-card py-2.5 text-xs hover:border-pink-400 hover:bg-surface-card-hover">
                    <Type size={13} /> 编辑封面样式
                    <span className="text-ink-muted">（{coverItems.length} 条文字）</span>
                  </button>
                  <div className="mt-1 text-[10px] text-ink-muted">AI 读全文生成 4字标题 + 标签 + 封面图；封面文字用占位符 {"{title}"}/{"{tags}"}，合成时替换（"/完结"可自行编辑）</div>
                </>
              )}
            </div>

            <div className="mt-auto pt-2">
              <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-card px-3 py-2 text-xs">
                <input type="checkbox" checked={autoCompose} onChange={(e) => setAutoCompose(e.target.checked)}
                  className="h-4 w-4 accent-pink-500" />
                <span className="font-medium">全自动</span>
                <span className="text-ink-muted">勾选后配音→生图→合成一条龙, 不停在待确认(后端限2并发)</span>
              </label>
              <button onClick={createJobs} disabled={creating || taskCount === 0}
                className="w-full rounded-lg bg-pink-500 px-3 py-2.5 text-sm font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                {creating ? <Loader2 size={14} className="inline animate-spin" /> : <Film size={14} className="inline" />}
                {" "}开始生成{taskCount > 0 ? `（${taskCount} 个任务）` : ""}{autoCompose ? " · 全自动" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 画面文字/字幕 放大编辑器弹窗 */}
      {overlayModalOpen && (
        <div onClick={() => setOverlayModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()}
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">画面文字 / 字幕编辑（比例 {ratio}）</div>
              <button onClick={() => setOverlayModalOpen(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="flex gap-1 border-b border-line px-4 py-2">
              <select value={overlayPresetId ?? ""} onChange={(e) => applyOverlayPreset(e.target.value ? +e.target.value : null)}
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400">
                <option value="">{overlayPresets.length ? "选择画面文字/字幕预设…" : "暂无预设，可存为"}</option>
                {overlayPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="button" onClick={saveOverlayPreset}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-line bg-surface-card px-2 py-1.5 text-xs hover:border-pink-400"
                title="把当前画面文字/字幕样式存为预设(飞书自动化命名为 飞书自动化4:3)"><Plus size={12} /> 存为预设</button>
            </div>
            <div className="overflow-y-auto p-4">
              <OverlayEditor
                ratioW={RATIO.find((r) => r.id === ratio)?.w || 9}
                ratioH={RATIO.find((r) => r.id === ratio)?.h || 16}
                items={overlayItems} setItems={setOverlayItems}
                subtitle={subtitle} setSubtitle={setSubtitle}
                dark={typeof document !== "undefined" ? !document.documentElement.classList.contains("light") : true}
              />
            </div>
            <div className="flex justify-end border-t border-line px-4 py-3">
              <button onClick={() => setOverlayModalOpen(false)}
                className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600">完成</button>
            </div>
          </div>
        </div>
      )}

      {/* 封面样式 放大编辑器弹窗(复用 OverlayEditor; 占位符 {title}/{tags} 在预览里原样显示) */}
      {coverModalOpen && (
        <div onClick={() => setCoverModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()}
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">封面样式编辑（比例 {ratio}） · {"{title}"}=AI标题 {"{tags}"}=AI标签</div>
              <button onClick={() => setCoverModalOpen(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              <OverlayEditor
                ratioW={RATIO.find((r) => r.id === ratio)?.w || 9}
                ratioH={RATIO.find((r) => r.id === ratio)?.h || 16}
                items={coverItems} setItems={setCoverItems}
                subtitle={coverSubtitle} setSubtitle={setCoverSubtitle}
                dark={typeof document !== "undefined" ? !document.documentElement.classList.contains("light") : true}
              />
            </div>
            <div className="flex justify-end border-t border-line px-4 py-3">
              <button onClick={() => setCoverModalOpen(false)}
                className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-600">完成</button>
            </div>
          </div>
        </div>
      )}

      {/* 画风预设 编辑/新建 弹窗 */}
      {presetModalOpen && (
        <div onClick={() => setPresetModalOpen(false)} className="fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-line bg-surface-elevated p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">{presetEditId == null ? "新建画风预设" : "编辑画风预设"}</div>
              <button onClick={() => setPresetModalOpen(false)} className="rounded p-1 hover:bg-white/10"><X size={16} /></button>
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
                  className="rounded-lg border border-danger/50 px-3 py-1.5 text-xs text-danger hover:bg-danger/10">删除预设</button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={() => setPresetModalOpen(false)}
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

      {/* 改提示词重生成 */}
      {editShot && (
        <div onClick={() => setEditShot(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-line bg-surface-elevated p-4 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">改提示词重生成 #{editShot.idx + 1}</div>
              <button onClick={() => setEditShot(null)} className="rounded p-1 hover:bg-white/10"><X size={16} /></button>
            </div>
            <div className="mb-1 text-[10px] text-ink-muted">原文段落：{editShot.text_segment}</div>
            <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={5}
              className="mb-3 w-full rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs outline-none focus:border-pink-400" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditShot(null)} className="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-card">取消</button>
              <button onClick={() => { regenerate(editShot.id, editPrompt); setEditShot(null); }}
                className="rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-pink-600">用新提示词重生成</button>
            </div>
          </div>
        </div>
      )}

      {/* 放大预览 */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <img src={lightbox} alt="" className="max-h-[95vh] max-w-[95vw] rounded-lg object-contain" referrerPolicy="no-referrer" />
          <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><X size={18} /></button>
        </div>
      )}

      {/* BGM 素材管理弹窗 */}
      {bgmMgrOpen && (
        <div onClick={() => setBgmMgrOpen(false)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">BGM 素材管理</div>
              <button onClick={() => setBgmMgrOpen(false)} className="rounded p-1 hover:bg-white/10"><X size={18} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              <div className="mb-3 text-[11px] text-ink-muted">
                上传后自动用 loudnorm 统一响度并转码 mp3。创建任务时选对应类型, 会在池内按顺序轮转选曲。
              </div>
              {["古风", "现代"].map((cat) => (
                <div key={cat} className="mb-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-medium">{cat}<span className="ml-1 text-xs text-ink-muted">({(bgmGrouped[cat] || []).length} 首)</span></div>
                    <label className="flex cursor-pointer items-center gap-1 rounded-lg bg-pink-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-pink-600">
                      {bgmUploading === cat ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                      上传（可多选）
                      <input type="file" accept="audio/*" multiple className="hidden"
                        onChange={(e) => uploadBgm(cat, e.target.files)} />
                    </label>
                  </div>
                  <div className="space-y-1">
                    {(bgmGrouped[cat] || []).length === 0 && (
                      <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-muted">暂无, 点右上「上传」</div>
                    )}
                    {(bgmGrouped[cat] || []).map((b: any, i: number) => (
                      <div key={b.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-card px-2 py-1.5 text-xs">
                        <span className="w-5 shrink-0 text-center text-ink-muted">{i + 1}</span>
                        <span className="flex-1 truncate">{b.name}</span>
                        <span className="shrink-0 text-ink-muted">{fmtDur(b.duration)}</span>
                        {b.url && <audio src={b.url} controls className="h-7 w-40 shrink-0" />}
                        <button onClick={() => deleteBgm(b.id)} className="shrink-0 text-ink-muted hover:text-red-400" title="删除"><X size={14} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
