"use client";
/**
 * 短视频前贴生成工作台 — 四栏布局(跟随主题)。
 * 左: 历史 | 参数 | 5可编辑提示词(可重生) | 5候选视频(与提示词对齐) + 源视频预览 + 成片下载。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authFetch, getToken } from "../../lib/auth";
import { uploadToOss, formatBytes, type UploadProgress } from "../../lib/ossUpload";
import FeishuReverseModal from "../_FeishuReverseModal";
import CorpusModal from "../_CorpusModal";
import { initTheme } from "../../lib/theme";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

const RATIO_OPTIONS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const RESOLUTION_OPTIONS = ["480p", "720p", "1080p"];
// 时长 1~30 秒任意档(2026-08 用户定): ≤15s 单段直出; >15s 后端自动两段式顺序生成+拼接
const DURATION_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

// 状态 → 中文进度文案(让用户知道系统在干活, 不是卡住)
const STATUS_TEXT: Record<string, string> = {
  created: "已创建, 准备中…",
  reversing: "正在反推剧情视频(约40-60秒)…",
  prompting: "反推完成, 正在用5套框架生成提示词…",
  await_pick_prompt: "提示词已就绪, 可编辑后点「生成5条前贴视频」",
  generating: "正在生成前贴视频(每条约1-3分钟, 请耐心等待)…",
  await_pick: "视频已生成, 挑一条导出成片",
  composing: "正在拼接前贴+剧情成片…",
  succeeded: "✅ 成片已生成",
  failed: "❌ 失败",
};

type Cand = { framework_id: string; framework_name: string; prompt?: string; prompt2?: string; seg_seconds?: number[]; narration?: string; narration_audio_url?: string; video_oss_key?: string; video_url?: string; status?: string; error?: string; hd_video_oss_key?: string; hd_video_url?: string; hd_status?: string; hd_error?: string;
  // 两段式(>15s): 每段单独存 TOS, 可分别预览 / 分别重生
  segments?: number;
  seg1_video_url?: string; seg1_status?: string; seg1_error?: string;
  seg2_video_url?: string; seg2_status?: string; seg2_error?: string };
type VoiceRef = { id: number; name: string; audio_url?: string; created_at?: string };
type Job = {
  id: number; status: string; progress: number; error?: string;
  ratio?: string; resolution?: string; duration?: number;
  reverse_summary?: string;
  prompt_candidates?: Cand[];
  video_candidates?: Cand[];
  picked_framework_id?: string;
  final_video_oss_key?: string;
  final_video_url?: string;
  source_video_url?: string;
  created_at?: string;
};

async function api(path: string, opts: RequestInit = {}) {
  const r = await authFetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// 比例字符串 → CSS aspect-ratio
function ratioCss(ratio?: string): string {
  if (!ratio || ratio === "adaptive") return "9/16";
  const m = ratio.match(/(\d+)\s*[:：]\s*(\d+)/);
  return m ? `${m[1]}/${m[2]}` : "9/16";
}

// 比例字符串 → 数值 (宽/高)
function ratioNum(ratio?: string): number {
  const css = ratioCss(ratio);
  const [w, h] = css.split("/").map(Number);
  return w && h ? w / h : 9 / 16;
}

// 预览框最小宽度: 仍以"目标高度预算"反推, 但只作为 flex 的基准/下限 —— 实际宽度由
// 容器可用空间等分决定(见卡片内 flex-1 + basis), 这样右侧不会再留大片空白。
// ⚠️ 不能写死像素宽高 —— 用户可能生成 9:16 / 1:1 / 16:9 / 21:9 任意比例;
// 高度始终由 aspect-ratio 决定, 各比例自适应且同行等高。
function frameBasis(ratio?: string, targetH = 360): number {
  const r = ratioNum(ratio);
  return Math.round(Math.min(Math.max(targetH * r, 190), 460));
}

function nearestRatio(w: number, h: number): string {
  if (!w || !h) return "9:16";
  const target = w / h;
  const cand: [string, number][] = [
    ["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4], ["9:16", 9 / 16], ["21:9", 21 / 9],
  ];
  let best = "9:16", diff = Infinity;
  for (const [name, r] of cand) {
    const d = Math.abs(r - target);
    if (d < diff) { diff = d; best = name; }
  }
  return best;
}

export default function ClipStudioPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [corpusOpen, setCorpusOpen] = useState(false);
  const [corpusIds, setCorpusIds] = useState<number[]>([]);

  const [ossKey, setOssKey] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [resolution, setResolution] = useState("720p");
  const [duration, setDuration] = useState(10);
  const [userRef, setUserRef] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [upProg, setUpProg] = useState<UploadProgress | null>(null);
  const [detectedRatio, setDetectedRatio] = useState("");
  const [refImageKey, setRefImageKey] = useState("");   // 主角形象参考图 OSS key
  const [refImageName, setRefImageName] = useState("");
  const [refUploading, setRefUploading] = useState(false);

  // 参考音色库
  const [voiceRefs, setVoiceRefs] = useState<VoiceRef[]>([]);
  const [voiceRefId, setVoiceRefId] = useState<number | null>(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [playingFid, setPlayingFid] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [editNarrations, setEditNarrations] = useState<Record<string, string>>({});
  const [regenningNar, setRegenningNar] = useState<Record<string, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [picking, setPicking] = useState("");
  // 用户编辑中的提示词(按 framework_id 存草稿), 以及各条重生中状态
  const [editPrompts, setEditPrompts] = useState<Record<string, string>>({});
  const [editPrompts2, setEditPrompts2] = useState<Record<string, string>>({}); // 两段式(>15s)第2段提示词编辑
  const [regenning, setRegenning] = useState<Record<string, boolean>>({});
  // 单条"重新生成提示词"进行中状态(按 framework_id)
  const [regenningPrompt, setRegenningPrompt] = useState<Record<string, boolean>>({});
  // 反推结果默认折叠(很长, 展开会把候选卡片挤到屏幕外)
  const [revOpen, setRevOpen] = useState(false);
  // 左侧历史栏可收起 —— 收起后把宽度全让给视频预览(视频是本页主产物)
  const [navOpen, setNavOpen] = useState(true);
  const pollRef = useRef<any>(null);

  const loadJobs = async () => {
    try { const r = await api(`/v1/frontcut/jobs`); setJobs(r.jobs || []); } catch { /* ignore */ }
  };
  const loadVoiceRefs = async () => {
    try { const r = await api(`/v1/frontcut/voice-refs`); setVoiceRefs(r.voice_refs || []); } catch { /* ignore */ }
  };
  useEffect(() => {
    // 本页是全屏独立布局(不套 AppShell/TopBar), 而主题初始化 initTheme() 只在 TopBar 的 _UserNav 里调;
    // 刷新本页时 _UserNav 不挂载 → data-theme 未设置 → bg-surface-base 回退成黑色。这里主动初始化一次修复。
    initTheme();
    loadJobs(); loadVoiceRefs();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // 上传参考音色到库
  const onPickVoiceRef = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    setErr(""); setVoiceUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name);
      const r = await authFetch(`${BASE}/v1/frontcut/voice-refs`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      await loadVoiceRefs();
      if (j?.voice_ref?.id) setVoiceRefId(j.voice_ref.id);
    } catch (e: any) { setErr("参考音上传失败: " + String(e?.message || e)); }
    finally { setVoiceUploading(false); }
  };

  const deleteVoiceRef = async (id: number) => {
    setErr("");
    try {
      await api(`/v1/frontcut/voice-refs/${id}`, { method: "DELETE" });
      if (voiceRefId === id) setVoiceRefId(null);
      await loadVoiceRefs();
    } catch (e: any) { setErr("删除参考音失败: " + String(e?.message || e)); }
  };

  // 试听: 播放某条前贴视频(静音) + 对应口播音频同步
  const playPreview = (fid: string, videoEl: HTMLVideoElement | null, narrationUrl?: string) => {
    // 停掉上一个口播
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (videoEl) { videoEl.muted = true; videoEl.currentTime = 0; videoEl.play().catch(() => {}); }
    if (narrationUrl) {
      const a = new Audio(narrationUrl);
      audioRef.current = a;
      a.play().catch(() => {});
    }
    setPlayingFid(fid);
  };

  // 各条/各段"重生中"标记的本地兜底: 后端异步任务从收到请求到把 status 写成 generating
  // 有短暂空窗(<1轮询周期), 期间不能因为读到旧的 await_pick 就清掉标记/停轮询,
  // 否则视频框会从"生成中"闪回"待生成"。记下点击时间, 30 秒内一律信任本地标记。
  const regenAtRef = useRef<Record<string, number>>({});
  const REGEN_GRACE_MS = 30000;

  const markRegen = (key: string, on: boolean) => {
    if (on) regenAtRef.current[key] = Date.now();
    else delete regenAtRef.current[key];
    setRegenning((p) => ({ ...p, [key]: on }));
  };

  const startPoll = (jid: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api(`/v1/frontcut/jobs/${jid}`);
        // 后台始终刷新列表; 但只有当用户当前正查看这条 job 时才更新详情视图,
        // 避免用户"新建任务"(job=null)或切到别的 job 后被轮询强行拉回正在跑的这条。
        setJobs((prev) => prev.map((x) => x.id === j.id ? j : x));
        setJob((cur) => (cur && cur.id === jid ? j : cur));

        // 用服务端真实状态收敛本地"重生中"标记: 某个 key 对应的段/整条不再 generating
        // 且已过宽限期 → 清掉。宽限期内保留(后端任务可能还没把 generating 写进库)。
        const vcs: Cand[] = j.video_candidates || [];
        const serverBusy = (key: string): boolean => {
          const m = key.match(/^(.*?)(?:#(\d))?$/);
          const fid = m?.[1] || key;
          const seg = m?.[2] ? Number(m[2]) : 0;
          const c = vcs.find((x) => x.framework_id === fid);
          if (!c) return false;
          if (seg === 1) return c.seg1_status === "generating";
          if (seg === 2) return c.seg2_status === "generating";
          return c.status === "generating";
        };
        setRegenning((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const key of Object.keys(prev)) {
            if (!prev[key]) continue;
            const fresh = Date.now() - (regenAtRef.current[key] || 0) < REGEN_GRACE_MS;
            if (!fresh && !serverBusy(key)) {
              delete next[key];
              delete regenAtRef.current[key];
              changed = true;
            }
          }
          return changed ? next : prev;
        });

        // 仍有本地标记在宽限期内 → 不停轮询(否则会卡在"生成中"不再刷新)
        const anyLocalFresh = Object.keys(regenAtRef.current)
          .some((k) => Date.now() - regenAtRef.current[k] < REGEN_GRACE_MS);
        const anyServerBusy = vcs.some(
          (c) => c.status === "generating" || c.seg1_status === "generating" || c.seg2_status === "generating"
            || c.hd_status === "processing");  // 高清处理中也要持续轮询(刷新页面后靠这里续上)
        if (!anyLocalFresh && !anyServerBusy &&
            ["succeeded", "failed", "await_pick", "await_pick_prompt"].includes(j.status)) {
          clearInterval(pollRef.current);
        }
      } catch { /* ignore */ }
    }, 4000);
  };


  const onPickVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    const token = getToken() || "";
    if (!token) { setErr("未登录或登录已过期"); return; }
    setErr(""); setOssKey(""); setUploading(true); setUpProg(null); setUploadName(file.name); setDetectedRatio("");

    // 本地探测视频宽高 → 自动选最接近比例
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        const rr = nearestRatio(v.videoWidth, v.videoHeight);
        setRatio(rr); setDetectedRatio(`${v.videoWidth}×${v.videoHeight} → ${rr}`);
        URL.revokeObjectURL(url);
      };
      v.src = url;
    } catch { /* 探测失败忽略, 用默认 */ }

    try {
      const ctrl = uploadToOss({ file, token, namespace: "frontcut-src", kind: "auto", concurrency: 4, onProgress: (p) => setUpProg(p) });
      const result = await ctrl.promise;
      setOssKey(result.oss_key);
    } catch (e: any) { setErr("上传失败: " + String(e?.message || e)); setUploadName(""); }
    finally { setUploading(false); }
  };

  const onPickRefImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    await uploadRefImageFile(file);
  };

  // 参考图上传公共逻辑(文件选择 与 粘贴 共用)
  const uploadRefImageFile = async (file: File) => {
    const token = getToken() || "";
    if (!token) { setErr("未登录或登录已过期"); return; }
    setErr(""); setRefImageKey(""); setRefUploading(true); setRefImageName(file.name || "粘贴的图片.png");
    try {
      const ctrl = uploadToOss({ file, token, namespace: "frontcut-refimg", kind: "auto", concurrency: 2 });
      const result = await ctrl.promise;
      setRefImageKey(result.oss_key);
    } catch (e: any) { setErr("参考图上传失败: " + String(e?.message || e)); setRefImageName(""); }
    finally { setRefUploading(false); }
  };

  // 在"参考提示词"文本框里粘贴图片 → 自动作为主角形象参考图上传
  // (方便用微信/飞书/系统截图从视频里截人物, 直接 Ctrl+V)
  const onUserRefPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        e.preventDefault(); // 拦截默认粘贴(不往文本框插入乱码)
        const f = it.getAsFile();
        if (f) {
          const ext = (it.type.split("/")[1] || "png").replace("jpeg", "jpg");
          const named = new File([f], `粘贴截图_${Date.now()}.${ext}`, { type: it.type });
          await uploadRefImageFile(named);
        }
        return; // 只取第一张图
      }
    }
    // 无图片项 → 不拦截, 正常粘贴文本
  };

  const createJob = async () => {
    setErr(""); setBusy(true);
    try {
      if (!ossKey.trim()) throw new Error("请先上传剧情视频");
      const r = await api(`/v1/frontcut/jobs`, {
        method: "POST",
        body: JSON.stringify({
          source_video_oss_key: ossKey.trim(), ratio, resolution, duration,
          user_ref: userRef || null, ref_image_oss_key: refImageKey || null,
          voice_ref_id: voiceRefId, corpus_ids: corpusIds,
        }),
      });
      const j = await api(`/v1/frontcut/jobs/${r.job_id}`);
      setJob(j); setEditPrompts({}); setEditPrompts2({}); await loadJobs(); startPoll(r.job_id);
      setOssKey(""); setUploadName(""); setUserRef(""); setDetectedRatio("");
      setRefImageKey(""); setRefImageName("");
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  const openJob = async (jid: number) => {
    setErr("");
    try {
      const j = await api(`/v1/frontcut/jobs/${jid}`);
      setJob(j); setEditPrompts({}); setEditPrompts2({});
      // 终态也要看是否有段/高清还在跑(否则打开正在高清处理的任务不会自动刷新)
      const busyCand = (j.video_candidates || []).some((c: Cand) =>
        c.status === "generating" || c.seg1_status === "generating" ||
        c.seg2_status === "generating" || c.hd_status === "processing");
      if (busyCand || !["succeeded", "failed", "await_pick", "await_pick_prompt"].includes(j.status)) startPoll(jid);
    } catch (e: any) { setErr(String(e.message || e)); }
  };

  const genVideos = async () => {
    if (!job) return;
    setBusy(true); setErr("");
    try { await api(`/v1/frontcut/jobs/${job.id}/generate-videos`, { method: "POST" }); startPoll(job.id); }
    catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  const regenPrompts = async () => {
    if (!job) return;
    setBusy(true); setErr("");
    try {
      await api(`/v1/frontcut/jobs/${job.id}/regenerate-prompts`, { method: "POST" });
      setEditPrompts({}); setEditPrompts2({});
      startPoll(job.id);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  // 只重新生成某一条提示词(该卡片), 其余不动
  const regenOnePrompt = async (fid: string) => {
    if (!job) return;
    setErr(""); setRegenningPrompt((p) => ({ ...p, [fid]: true }));
    try {
      await api(`/v1/frontcut/jobs/${job.id}/regenerate-one-prompt`, {
        method: "POST",
        body: JSON.stringify({ framework_id: fid }),
      });
      // 轮询刷新; 8 秒后清该条 loading(后台生成通常几秒)
      startPoll(job.id);
      setEditPrompts((prev) => { const n = { ...prev }; delete n[fid]; return n; });
      setEditPrompts2((prev) => { const n = { ...prev }; delete n[fid]; return n; });
      setTimeout(() => setRegenningPrompt((p) => ({ ...p, [fid]: false })), 12000);
    } catch (e: any) { setErr(String(e.message || e)); setRegenningPrompt((p) => ({ ...p, [fid]: false })); }
  };

  // 重新生成视频。segment=1|2 时只重生两段式候选的那一段(另一段不动, 省一半算力);
  // 不传 = 整条重生(单段候选/两段式整条)。
  const regenOne = async (fid: string, segment?: 1 | 2) => {
    if (!job) return;
    const key = segment ? `${fid}#${segment}` : fid;
    setErr(""); markRegen(key, true);
    try {
      await api(`/v1/frontcut/jobs/${job.id}/regenerate-one`, {
        method: "POST",
        body: JSON.stringify({
          framework_id: fid,
          prompt: editPrompts[fid] ?? null,
          prompt2: editPrompts2[fid] ?? null,
          segment: segment ?? null,
        }),
      });
      startPoll(job.id);
    } catch (e: any) { setErr(String(e.message || e)); markRegen(key, false); }
  };

  // 按(可编辑的)口播文案重新合成该条口播音频
  const regenNarration = async (fid: string) => {
    if (!job) return;
    setErr(""); setRegenningNar((p) => ({ ...p, [fid]: true }));
    try {
      await api(`/v1/frontcut/jobs/${job.id}/regenerate-narration`, {
        method: "POST",
        body: JSON.stringify({ framework_id: fid, narration: editNarrations[fid] ?? null }),
      });
      startPoll(job.id);
      setTimeout(() => setRegenningNar((p) => ({ ...p, [fid]: false })), 8000);
    } catch (e: any) { setErr(String(e.message || e)); setRegenningNar((p) => ({ ...p, [fid]: false })); }
  };

  const confirmExport = async (fid: string) => {
    if (!job) return;
    setPicking(fid); setErr("");
    try {
      await api(`/v1/frontcut/jobs/${job.id}/pick`, { method: "POST", body: JSON.stringify({ framework_id: fid }) });
      startPoll(job.id);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setPicking(""); }
  };

  // 对某条前贴视频做高清处理(RunningHub SeedVR2), 结果并存到该候选的高清版
  const upscaleOne = async (fid: string) => {
    if (!job) return;
    setErr("");
    try {
      await api(`/v1/frontcut/jobs/${job.id}/upscale-one`, { method: "POST", body: JSON.stringify({ framework_id: fid }) });
      // 乐观标记该条为 processing, 并启动轮询直到高清完成
      setJob((prev) => prev ? {
        ...prev,
        video_candidates: (prev.video_candidates || []).map((c) =>
          c.framework_id === fid ? { ...c, hd_status: "processing", hd_error: undefined } : c,
        ),
      } : prev);
      // 高清进行时需持续轮询(即使 job 已达终态)
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const j = await api(`/v1/frontcut/jobs/${job.id}`);
          setJobs((prev) => prev.map((x) => x.id === j.id ? j : x));
          setJob((cur) => (cur && cur.id === job.id ? j : cur));
          const hdRunning = (j.video_candidates || []).some((c: Cand) => c.hd_status === "processing");
          if (!hdRunning && ["succeeded", "failed", "await_pick", "await_pick_prompt"].includes(j.status)) {
            clearInterval(pollRef.current);
          }
        } catch { /* ignore */ }
      }, 4000);
    } catch (e: any) { setErr(String(e.message || e)); }
  };

  const ar = ratioCss(job?.ratio || ratio);
  const inputCls = "w-full rounded border border-line bg-surface-base text-ink-primary px-2 py-1.5 text-sm";
  const prompts = job?.prompt_candidates || [];
  const videos = job?.video_candidates || [];
  const rows = prompts.length ? prompts : videos;
  const busyStatus = job && ["created", "reversing", "prompting", "generating", "composing"].includes(job.status);

  return (
    <div className="flex h-[calc(100vh-0px)] text-ink-primary text-sm bg-surface-base">
      <FeishuReverseModal open={feishuOpen} onClose={() => setFeishuOpen(false)} />
      <CorpusModal open={corpusOpen} onClose={() => setCorpusOpen(false)}
        selectedIds={corpusIds} onConfirm={(ids) => setCorpusIds(ids)} />

      {/* 左栏: 历史记录 — 可收起为 32px 窄条, 把宽度让给视频预览 */}
      {navOpen ? (
        <div className="w-[180px] border-r border-line p-3 overflow-auto shrink-0">
          <div className="flex items-center justify-between mb-2 gap-1">
            <button onClick={() => router.push("/")} title="返回主页"
              className="text-xs px-2 py-1 rounded border border-line hover:bg-surface-overlay">← 返回</button>
            <button onClick={() => { setJob(null); setEditPrompts({}); setEditPrompts2({}); }} title="新建任务"
              className="text-xs px-2 py-1 rounded bg-primary text-white">+ 新建</button>
            <button onClick={() => setNavOpen(false)} title="收起历史栏(给视频预览让位)"
              className="text-xs px-1.5 py-1 rounded border border-line hover:bg-surface-overlay">«</button>
          </div>
          <div className="font-semibold mb-2">历史记录</div>
          {jobs.length === 0 && <div className="text-ink-muted text-xs">暂无记录</div>}
          {jobs.map((j) => (
            <div key={j.id} onClick={() => openJob(j.id)}
              className={`px-2.5 py-2 rounded-md mb-1.5 cursor-pointer border ${job?.id === j.id ? "border-primary bg-primary/10" : "border-line bg-surface-base"}`}>
              <div className="text-xs font-semibold">任务 #{j.id}</div>
              <div className="text-[11px] text-ink-muted">{j.status} · {j.progress}%</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="w-[32px] border-r border-line py-3 shrink-0 flex flex-col items-center gap-2">
          <button onClick={() => setNavOpen(true)} title="展开历史栏"
            className="text-xs px-1.5 py-1 rounded border border-line hover:bg-surface-overlay">»</button>
          <div className="text-[10px] text-ink-muted" style={{ writingMode: "vertical-rl" }}>历史记录</div>
        </div>
      )}

      {/* 中栏: 参数设置。打开任务后此栏基本只看状态 → 收窄到 200px 给视频腾地 */}
      <div className={`${job ? "w-[200px]" : "w-[230px]"} border-r border-line p-3 overflow-auto shrink-0`}>
        <div className="flex items-center justify-between mb-3">
          <b>{job ? `任务 #${job.id}` : "新建任务"}</b>
          <button onClick={() => setCorpusOpen(true)}
            className="text-[11px] px-2 py-1 rounded border border-success text-success">
            语料库{corpusIds.length ? ` (${corpusIds.length})` : ""}
          </button>
        </div>

        {!job && (
          <>
            <label className="font-semibold">剧情视频</label>
            <label className="block mt-1.5" style={{ cursor: uploading ? "default" : "pointer" }}>
              <input type="file" accept="video/*,.mp4,.mov,.mkv,.webm,.avi" onChange={onPickVideo} disabled={uploading} className="hidden" />
              <div className="border-2 border-dashed border-line rounded-lg p-3.5 text-center">
                <div className="text-ink-secondary">{uploadName || "点击选择视频上传"}</div>
                {uploading && upProg && (
                  <div className="mt-1.5">
                    <div className="h-1.5 bg-surface-base rounded overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${Math.round((upProg.loaded / upProg.total) * 100)}%` }} />
                    </div>
                    <div className="text-[11px] text-ink-muted mt-1">{Math.round((upProg.loaded / upProg.total) * 100)}% · {formatBytes(upProg.loaded)}/{formatBytes(upProg.total)}</div>
                  </div>
                )}
                {!uploading && ossKey && <div className="text-[11px] text-success mt-1">✅ 已上传</div>}
              </div>
            </label>

            <div className="mt-3 space-y-2.5">
              <div>
                <label className="text-[11px] text-ink-muted">比例{detectedRatio && <span className="text-success"> (自动: {detectedRatio})</span>}</label>
                <select value={ratio} onChange={(e) => setRatio(e.target.value)} className={inputCls}>
                  {RATIO_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-ink-muted">分辨率</label>
                <select value={resolution} onChange={(e) => setResolution(e.target.value)} className={inputCls}>
                  {RESOLUTION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-ink-muted">时长(秒, 1~30)</label>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls}>
                  {DURATION_OPTIONS.map((o) => <option key={o} value={o}>{o} 秒</option>)}
                </select>
                {duration > 15 && <div className="text-[10px] mt-0.5" style={{ color: "#d97706" }}>&gt;15秒将自动分两段顺序生成后拼接</div>}
              </div>
            </div>

            <label className="font-semibold block mt-3">主角形象参考图(可选)</label>
            <label className="block mt-1" style={{ cursor: refUploading ? "default" : "pointer" }}>
              <input type="file" accept="image/*" onChange={onPickRefImage} disabled={refUploading} className="hidden" />
              <div className="border-2 border-dashed border-line rounded-lg p-2.5 text-center text-xs">
                {refUploading ? "上传中…" : refImageName ? `已选: ${refImageName}` : "点击上传主角形象(生成时保持一致)"}
                {!refUploading && refImageKey && <span className="text-success"> ✅</span>}
              </div>
            </label>

            <label className="font-semibold block mt-3">配音参考音色(可选, 语音克隆口播)</label>
            <div className="mt-1 flex gap-1.5 items-center">
              <select value={voiceRefId ?? ""} onChange={(e) => setVoiceRefId(e.target.value ? Number(e.target.value) : null)} className={inputCls}>
                <option value="">不生成口播</option>
                {voiceRefs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              {voiceRefId != null && (
                <button onClick={() => deleteVoiceRef(voiceRefId)} title="删除此参考音"
                  className="text-xs px-2 py-1.5 rounded border border-danger text-danger shrink-0">删</button>
              )}
            </div>
            <label className="block mt-1" style={{ cursor: voiceUploading ? "default" : "pointer" }}>
              <input type="file" accept="audio/*" onChange={onPickVoiceRef} disabled={voiceUploading} className="hidden" />
              <div className="border-2 border-dashed border-line rounded-lg p-2 text-center text-xs">
                {voiceUploading ? "上传中…" : "＋ 上传新参考音色(wav/mp3)"}
              </div>
            </label>

            <label className="font-semibold block mt-3">参考提示词(可选) <span className="font-normal text-[11px] text-ink-muted">— 可直接 Ctrl+V 粘贴截图作为主角形象参考图</span></label>
            <textarea value={userRef} onChange={(e) => setUserRef(e.target.value)} onPaste={onUserRefPaste} rows={3} className={`${inputCls} mt-1`}
              placeholder="输入提示词方向(可选); 粘贴图片会自动上传为主角形象参考图" />

            <button onClick={createJob} disabled={busy || uploading || !ossKey}
              className={`mt-3 w-full py-2 rounded-md text-white ${(busy || uploading || !ossKey) ? "bg-ink-muted cursor-not-allowed" : "bg-primary"}`}>
              {uploading ? "视频上传中…" : busy ? "处理中…" : "开始反推 + 生成提示词"}
            </button>
          </>
        )}

        {job && (
          <div className="text-xs text-ink-secondary">
            {/* 明显的进度提示 */}
            <div className={`rounded-md p-2.5 mb-2 flex items-center gap-2 ${busyStatus ? "bg-primary/10 border border-primary/30" : "bg-surface-base"}`}>
              {busyStatus && <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
              <div>
                <div className="font-semibold text-ink-primary">{STATUS_TEXT[job.status] || job.status}</div>
                <div className="text-[11px] text-ink-muted mt-0.5">进度 {job.progress}%</div>
              </div>
            </div>
            {job.error && <div className="text-danger mt-1.5">{job.error}</div>}
            <div className="mt-1 text-ink-muted">比例 {job.ratio} · {job.resolution} · {job.duration}s</div>
            {job.status === "await_pick_prompt" && (
              <button onClick={genVideos} disabled={busy} className="mt-3 w-full py-2 rounded-md bg-success text-white">
                生成 5 条前贴视频
              </button>
            )}
            {/* 反推结果移到右侧主区顶部横向展示(此处不再重复) */}
          </div>
        )}
        {err && <div className="text-danger mt-3 text-xs">错误: {err}</div>}
      </div>

      {/* 右侧主区: 候选卡片流(左) + 源视频/成片 sticky 侧栏(右) */}
      <div className="flex-1 overflow-auto">
        {!job && <div className="text-ink-muted h-full flex items-center justify-center">← 新建任务或从左侧历史记录选择</div>}

        {job && (
          <div className="flex gap-4 p-4 items-start">
            {/* 主列: 反推结果 + 5 张候选卡片(每张卡片内部横向排布, 提示词与其视频同行对齐) */}
            <div className="flex-1 min-w-0">
            {/* 反推结果: 默认折叠(全文很长), 点击展开 */}
            {job.reverse_summary && (
              <div className="mb-3 border border-line rounded-lg">
                <button onClick={() => setRevOpen((v) => !v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left">
                  <span className="text-xs text-ink-muted">{revOpen ? "▾" : "▸"}</span>
                  <span className="font-semibold text-[13px]">反推结果(完整口播文案)</span>
                  {!revOpen && (
                    <span className="text-[11px] text-ink-muted truncate flex-1">
                      {job.reverse_summary.slice(0, 60)}…
                    </span>
                  )}
                  <span className="text-[11px] text-ink-muted shrink-0">{revOpen ? "收起" : "展开"}</span>
                </button>
                {revOpen && (
                  <div className="px-3 pb-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-secondary max-h-[260px] overflow-auto">
                    {job.reverse_summary}
                  </div>
                )}
              </div>
            )}

            <div className="font-semibold mb-2">5 条候选(提示词 ↔ 视频 同行对应, 可编辑后分别重生)</div>
            <div className="space-y-3">
              {rows.length ? rows.map((c, idx) => {
                  const p = prompts.find((x) => x.framework_id === c.framework_id);
                  const cur = editPrompts[c.framework_id] ?? (p?.prompt || "");
                  const isTwoSeg = !!(p?.prompt2 || "").trim();
                  const cur2 = editPrompts2[c.framework_id] ?? (p?.prompt2 || "");
                  const segSec = p?.seg_seconds && p.seg_seconds.length === 2 ? p.seg_seconds : null;
                  const isRegen = !!regenning[c.framework_id];
                  // 两段式: 段1/段2 各自的重生中标记(key = fid#1 / fid#2), 或后端已写的分段状态
                  const vcRow = videos.find((x) => x.framework_id === c.framework_id);
                  const isRegen1 = !!regenning[`${c.framework_id}#1`] || vcRow?.seg1_status === "generating";
                  const isRegen2 = !!regenning[`${c.framework_id}#2`] || vcRow?.seg2_status === "generating";
                  // 该候选的视频数据 + 各段预览框(宽度由比例反推, 高度统一 ⇒ 任意比例都等高对齐)
                  const vc = vcRow || c;
                  const genning = vc.status === "generating" || !!regenning[c.framework_id];
                  const fw = frameBasis(job.ratio || ratio);
                  // 单帧宽度上限: 框数少时(单段候选只有1个框) flex-grow 会让它独占整个视频区
                  // 变成巨型框(修复前 9:16 单框可撑到 ~806×1433) → 用 maxWidth 封顶(basis 的 1.5 倍,
                  // ≈两段式三框等分时的实际宽度), 单段与两段式候选的框视觉体量一致, 多余空间留白。
                  const fwMax = Math.round(fw * 1.5);
                  const frameSty = { flex: `1 1 ${fw}px`, minWidth: Math.min(fw, 190), maxWidth: fwMax };
                  const segFrame = (n: 1 | 2) => {
                    const url = n === 1 ? vc.seg1_video_url : vc.seg2_video_url;
                    const st = n === 1 ? vc.seg1_status : vc.seg2_status;
                    const em = n === 1 ? vc.seg1_error : vc.seg2_error;
                    const busy = st === "generating" || !!regenning[`${c.framework_id}#${n}`] || (genning && !st);
                    return (
                      <div style={frameSty}>
                        <div className="flex items-center justify-between mb-1 gap-1">
                          <span className="text-[11px] text-ink-muted truncate">
                            段{n}{segSec ? ` · ${segSec[n - 1]}s` : ""}
                          </span>
                          <button onClick={() => regenOne(c.framework_id, n)} disabled={busy}
                            title={`只重新生成段${n}(另一段保留)`}
                            className={`text-[11px] px-1.5 py-0.5 rounded border shrink-0 ${busy ? "border-line text-ink-muted cursor-not-allowed" : "border-primary text-primary"}`}>
                            {busy ? "生成中" : "🔄 重生"}
                          </button>
                        </div>
                        <div className="rounded-md overflow-hidden bg-black flex items-center justify-center"
                          style={{ aspectRatio: ar }}>
                          {url ? (
                            <video id={`fcv-${c.framework_id}-s${n}`} src={url} controls
                              className="w-full h-full object-contain" />
                          ) : busy ? (
                            <div className="text-center text-[11px] text-white/80 px-1">
                              <div className="inline-block w-6 h-6 border-2 border-white/70 border-t-transparent rounded-full animate-spin mb-1" />
                              <div>段{n}生成中…</div>
                            </div>
                          ) : (
                            <span className="text-[11px] px-1 text-center" style={{ color: st === "failed" ? "#f87171" : "#999" }}>
                              {st === "failed" ? `失败: ${(em || "").slice(0, 30)}` : "待生成"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  };
                  return (
                    <div key={"p-" + c.framework_id} className="border border-line rounded-lg p-3">
                      {/* 卡片头: 序号 + 框架名 + 两段式标记 */}
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-5 h-5 shrink-0 rounded-full bg-primary text-white text-[11px] flex items-center justify-center">{idx + 1}</span>
                        <span className="text-xs font-semibold text-primary">{c.framework_name}</span>
                        {isTwoSeg && <span className="text-[10px] font-normal px-1.5 py-0.5 rounded" style={{ color: "#d97706", background: "rgba(217,119,6,.12)" }}>
                          两段式{segSec ? `(${segSec[0]}s+${segSec[1]}s)` : ""} · 分别生成后自动拼接
                        </span>}
                      </div>

                      {/* 卡片体: 左=提示词/口播/按钮(收窄, 让位给视频), 右=该条自己的视频框 */}
                      <div className="flex gap-3 items-start">
                        <div className="w-[300px] shrink-0">
                      {isTwoSeg && <div className="text-[11px] text-ink-muted mb-0.5">段1提示词(开场钩子, {segSec ? `约${segSec[0]}秒` : "前半"})</div>}
                      <textarea
                        value={cur}
                        onChange={(e) => setEditPrompts((prev) => ({ ...prev, [c.framework_id]: e.target.value }))}
                        placeholder={p?.error ? `生成失败: ${p.error}` : "生成中…"}
                        className="w-full rounded border border-line bg-surface-base text-ink-primary px-2.5 py-2 text-[12.5px] leading-relaxed resize-y"
                        style={{ height: isTwoSeg ? 130 : 180 }} />
                      {isTwoSeg && (
                        <>
                          <div className="text-[11px] text-ink-muted mt-1 mb-0.5">段2提示词(切镜后下一幕 → 收束到正片开头, {segSec ? `约${segSec[1]}秒` : "后半"})</div>
                          <textarea
                            value={cur2}
                            onChange={(e) => setEditPrompts2((prev) => ({ ...prev, [c.framework_id]: e.target.value }))}
                            className="w-full rounded border border-line bg-surface-base text-ink-primary px-2.5 py-2 text-[12.5px] leading-relaxed resize-y"
                            style={{ height: 130 }} />
                        </>
                      )}
                      {(p?.narration || p?.narration_audio_url) && (
                        <div className="mt-1.5">
                          <div className="text-[11px] text-ink-muted mb-0.5">前贴口播文案(可编辑后重新配音)</div>
                          <textarea
                            value={editNarrations[c.framework_id] ?? (p?.narration || "")}
                            onChange={(e) => setEditNarrations((prev) => ({ ...prev, [c.framework_id]: e.target.value }))}
                            className="w-full rounded border border-line bg-surface-base text-ink-primary px-2.5 py-1.5 text-[12px] leading-relaxed resize-y"
                            style={{ height: 90 }} />
                          <button onClick={() => regenNarration(c.framework_id)} disabled={!!regenningNar[c.framework_id]}
                            className={`mt-1 w-full py-1 rounded text-[11px] text-white ${regenningNar[c.framework_id] ? "bg-ink-muted cursor-not-allowed" : "bg-primary/80"}`}>
                            {regenningNar[c.framework_id] ? "配音生成中…" : "🎙 按此文案重新配音"}
                          </button>
                        </div>
                      )}
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => regenOnePrompt(c.framework_id)} disabled={!!regenningPrompt[c.framework_id]}
                          className={`flex-1 py-1.5 rounded-md text-xs text-white ${regenningPrompt[c.framework_id] ? "bg-ink-muted cursor-not-allowed" : "bg-primary/70"}`}
                          title="用AI重新生成这一条提示词(复用反推结果, 其余4条不变)">
                          {regenningPrompt[c.framework_id] ? "提示词生成中…" : "✨ 重新生成本条提示词"}
                        </button>
                        {isTwoSeg ? (
                          // 两段式: 拆成两个按钮, 分别只重生对应那一段(另一段产物保留, 省一半算力),
                          // 两段都就绪后后端自动重新拼接出合并成片。
                          <div className="flex-1 flex gap-1.5">
                            <button onClick={() => regenOne(c.framework_id, 1)}
                              disabled={isRegen1 || isRegen || !cur.trim()}
                              title="只重新生成段1(段2保留), 完成后自动重新拼接"
                              className={`flex-1 py-1.5 rounded-md text-xs text-white ${(isRegen1 || isRegen || !cur.trim()) ? "bg-ink-muted cursor-not-allowed" : "bg-primary"}`}>
                              {isRegen1 ? "段1生成中…" : "🔄 重生段1"}
                            </button>
                            <button onClick={() => regenOne(c.framework_id, 2)}
                              disabled={isRegen2 || isRegen || !cur2.trim()}
                              title="只重新生成段2(段1保留), 完成后自动重新拼接"
                              className={`flex-1 py-1.5 rounded-md text-xs text-white ${(isRegen2 || isRegen || !cur2.trim()) ? "bg-ink-muted cursor-not-allowed" : "bg-primary"}`}>
                              {isRegen2 ? "段2生成中…" : "🔄 重生段2"}
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => regenOne(c.framework_id)} disabled={isRegen || !cur.trim()}
                            className={`flex-1 py-1.5 rounded-md text-xs text-white ${isRegen || !cur.trim() ? "bg-ink-muted cursor-not-allowed" : "bg-primary"}`}>
                            {isRegen ? "重新生成中…" : "🔄 按此提示词重新生成视频"}
                          </button>
                        )}
                      </div>
                      {isTwoSeg && (
                        <button onClick={() => regenOne(c.framework_id)}
                          disabled={isRegen || isRegen1 || isRegen2 || !cur.trim() || !cur2.trim()}
                          title="两段一起重新生成(烧两段算力)"
                          className={`mt-1.5 w-full py-1.5 rounded-md text-xs text-white ${(isRegen || isRegen1 || isRegen2 || !cur.trim() || !cur2.trim()) ? "bg-ink-muted cursor-not-allowed" : "bg-primary/60"}`}>
                          {isRegen ? "两段重新生成中…" : "🔄🔄 两段一起重新生成"}
                        </button>
                      )}
                        </div>

                        {/* 右: 该候选自己的视频区 — 段1 / 段2 / 拼接成片 / 高清版 横向并排, 与左侧提示词同卡片同行 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex gap-2 items-start flex-wrap">
                            {isTwoSeg && segFrame(1)}
                            {isTwoSeg && segFrame(2)}
                            <div style={frameSty}>
                              <div className="text-[11px] text-ink-muted mb-1 truncate">
                                {isTwoSeg ? "拼接成片(段1+段2)" : "前贴候选"}
                                {job.picked_framework_id === c.framework_id && <span className="text-success"> ✓已选</span>}
                              </div>
                              <div className={`rounded-md overflow-hidden bg-black flex items-center justify-center ${job.picked_framework_id === c.framework_id ? "ring-2 ring-success" : ""}`}
                                style={{ aspectRatio: ar }}>
                                {vc.video_url ? (
                                  <video id={`fcv-${c.framework_id}`} src={vc.video_url} controls className="w-full h-full object-contain" />
                                ) : genning ? (
                                  <div className="text-center text-[11px] text-white/80 px-1">
                                    <div className="inline-block w-6 h-6 border-2 border-white/70 border-t-transparent rounded-full animate-spin mb-1" />
                                    <div>生成中…</div>
                                  </div>
                                ) : (
                                  <span className="text-[11px] px-1 text-center" style={{ color: vc.status === "failed" ? "#f87171" : "#999" }}>
                                    {vc.status === "failed" ? `失败: ${(vc.error || "").slice(0, 30)}` : "待生成"}
                                  </span>
                                )}
                              </div>
                            </div>
                            {/* 高清版: 有产出或处理中时, 作为与其它框同规格的第4个预览框(不再是操作条里的小缩略图) */}
                            {(vc.hd_status === "done" && vc.hd_video_url) || vc.hd_status === "processing" ? (
                              <div style={frameSty}>
                                <div className="text-[11px] mb-1 truncate text-success">
                                  ✨ 高清版{vc.hd_status === "processing" ? "(处理中)" : ""}
                                </div>
                                <div className="rounded-md overflow-hidden bg-black flex items-center justify-center"
                                  style={{ aspectRatio: ar }}>
                                  {vc.hd_status === "done" && vc.hd_video_url ? (
                                    <video src={vc.hd_video_url} controls className="w-full h-full object-contain" />
                                  ) : (
                                    <div className="text-center text-[11px] text-white/80 px-1">
                                      <div className="inline-block w-6 h-6 border-2 border-white/70 border-t-transparent rounded-full animate-spin mb-1" />
                                      <div>高清处理中…</div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          </div>
                          {/* 成片操作区: 移到视频框下方横向排列 —— 不再占用一列宽度, 三个预览框可吃满整行 */}
                          {vc.video_url && (() => {
                              const hasHd = vc.hd_status === "done" && !!vc.hd_video_url;
                              const picked = job.picked_framework_id === c.framework_id;
                              // 拼接进行中: 以 job.status 为准(拼接是后台任务, 要几分钟;
                              // 之前只看瞬时的 picking → 按钮闪一下就恢复, 用户以为没反应)
                              const composing = job.status === "composing";
                              const exporting = composing && picked;
                              const exportDisabled = !!picking || composing;
                              return (
                                <div className="mt-2 flex gap-1.5 items-center flex-wrap">
                                  <button
                                    onClick={() => playPreview(c.framework_id,
                                      document.getElementById(`fcv-${c.framework_id}`) as HTMLVideoElement | null,
                                      p?.narration_audio_url)}
                                    className="px-3 py-1.5 rounded text-[11px] bg-primary/80 text-white">
                                    {p?.narration_audio_url ? "▶ 试听(静音+口播)" : "▶ 播放(暂无口播)"}
                                  </button>
                                  {!hasHd && (
                                    <button onClick={() => confirmExport(c.framework_id)} disabled={exportDisabled}
                                      className={`px-3 py-1.5 rounded text-white text-[11px] ${exporting ? "bg-warning" : exportDisabled ? "bg-ink-muted cursor-not-allowed" : picked ? "bg-success" : "bg-primary"}`}>
                                      {exporting ? "⏳ 拼接成片中(约1-3分钟)…" : picking === c.framework_id ? "提交中…" : picked ? "✓ 已选" : "选它并导出(对齐口播拼接)"}
                                    </button>
                                  )}
                                  {vc.hd_status === "processing" ? (
                                    <span className="text-[11px] text-warning">⏳ 高清处理中(预览框见右侧)…</span>
                                  ) : hasHd ? (
                                    <>
                                      <span className="text-[11px] text-success">✨ 高清版就绪(预览框见右侧)</span>
                                      <button onClick={() => confirmExport(c.framework_id)} disabled={exportDisabled}
                                        className={`px-3 py-1.5 rounded text-white text-[11px] ${exporting ? "bg-warning" : exportDisabled ? "bg-ink-muted cursor-not-allowed" : picked ? "bg-success" : "bg-primary"}`}>
                                        {exporting ? "⏳ 拼接成片中(约1-3分钟)…" : picking === c.framework_id ? "提交中…" : picked ? "✓ 已选(高清)" : "选它并导出高清版"}
                                      </button>
                                      <a href={vc.hd_video_url} target="_blank" rel="noreferrer" download
                                        className="px-3 py-1.5 rounded text-[11px] bg-success text-white no-underline">⬇ 下载高清</a>
                                      <button onClick={() => upscaleOne(c.framework_id)}
                                        className="px-2 py-1.5 rounded text-[11px] border border-line">重做高清</button>
                                    </>
                                  ) : (
                                    <>
                                      <button onClick={() => upscaleOne(c.framework_id)}
                                        className="px-3 py-1.5 rounded text-[11px] text-white bg-[#7c3aed]">
                                        ✨ 高清处理
                                      </button>
                                      {vc.hd_status === "failed" && (
                                        <span className="text-[11px] text-danger">高清失败: {(vc.hd_error || "").slice(0, 40)}</span>
                                      )}
                                    </>
                                  )}
                                </div>
                              );
                            })()}
                        </div>
                      </div>
                    </div>
                  );
                }) : <div className="text-ink-muted text-xs">尚无提示词, 请稍候…</div>}
            </div>
            </div>

            {/* 右侧栏: 剧情视频预览 + 成片。sticky 固定, 卡片流滚动时始终可见(便于比对) */}
            <div className="w-[220px] shrink-0 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-auto">
              <div className="font-semibold mb-2">剧情视频预览</div>
              <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center mx-auto"
                style={{ aspectRatio: ar, maxWidth: 200, width: "100%" }}>
                {job.source_video_url ? (
                  <video src={job.source_video_url} controls className="w-full h-full object-contain" />
                ) : <span className="text-ink-muted">无预览</span>}
              </div>

              {job.status === "composing" && (
                <div className="mt-3 text-warning flex items-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-warning border-t-transparent rounded-full animate-spin" />
                  正在拼接前贴+剧情…
                </div>
              )}
              {job.status === "succeeded" && job.final_video_url && (
                <div className="mt-4">
                  <div className="font-semibold mb-2 text-success">✅ 成片已生成</div>
                  <div className="rounded-lg overflow-hidden bg-black mx-auto" style={{ aspectRatio: ar, maxWidth: 200, width: "100%" }}>
                    <video src={job.final_video_url} controls className="w-full h-full object-contain" />
                  </div>
                  <a href={job.final_video_url} download={`frontcut_${job.id}.mp4`}
                    className="inline-block mt-2.5 px-5 py-2 rounded-md bg-success text-white no-underline">
                    ⬇ 下载成片
                  </a>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}