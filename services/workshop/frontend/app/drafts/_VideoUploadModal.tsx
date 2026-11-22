"use client";
import { submitWorkshopVideo } from "@/lib/workshop_video_intake";
import { authFetch, getToken } from "../../lib/auth";
import { draftPath } from "@/components/VersionSwitcher";
import {
  uploadToOss,
  formatBytes,
  formatDuration,
  formatSpeed,
  type UploadController,
  type UploadProgress,
} from "../../lib/ossUpload";
import { useState, useRef, useMemo } from "react";
import { sortByEpisodeNo, reviewEpisodeNames } from "@/lib/episodeOrder";
import {
  Film, X, CheckCircle, AlertCircle, GripVertical,
  Pause, Play,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

/**
 * 列表内拖动排序用的私有 MIME。
 *
 * ⚠️ 不能只靠 text/plain 判断: 从系统拖进来的**视频文件**, text/plain 是空串,
 * `Number("")` 得 0, 于是排序分支会误判成"拖的是第 1 集"并静默执行 moveFile(0, idx) ——
 * 用户本想加一集, 结果集顺序被打乱且毫无提示。用私有 MIME 才能把
 * "内部排序拖拽" 和 "系统文件拖拽" 区分开。
 */
const REORDER_MIME = "application/x-drama-episode-index";

type FileItem = {
  file: File;
  id: string;
  status: "pending" | "uploading" | "paused" | "done" | "failed";
  progress?: UploadProgress;
  error?: string;
  upload_id?: string;
};

/**
 * 从视频文件反推剧本 — Phase 3 重做版,接入 UI Kit。业务逻辑完全保留。
 */
export function VideoUploadModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [title, setTitle] = useState("");
  const [concurrency, setConcurrency] = useState<1 | 2 | 3>(1);
  const [phase, setPhase] = useState<"idle" | "uploading" | "creating" | "done">("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // 系统文件正悬停在投放区上方(用于高亮), 与列表内排序的 dragOverIdx 是两回事
  const [dropActive, setDropActive] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  // 用户拖动排过序 → 之后再加文件不重排已有的(只把新加的这批排好接在后面)
  const [manualOrder, setManualOrder] = useState(false);

  // 入口 Tab: 上传文件 / 贴链接 / 搜索
  const [tab, setTab] = useState<"upload" | "url" | "search">("upload");
  // 贴链接
  const [urlText, setUrlText] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  // 搜索
  const [searchQ, setSearchQ] = useState("");
  const [searchPlatform, setSearchPlatform] = useState<"douyin" | "tiktok" | "kuaishou" | "xiaohongshu">("douyin");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  // 多选反推: key(aweme_id/url) → 集号(1起)
  const [picked, setPicked] = useState<Record<string, number>>({});

  const ctrlsRef = useRef<Map<string, UploadController>>(new Map());
  const serverUpload = useRef<AbortController | null>(null);

  // ===== 贴链接: 从一个或多个链接(每行一个)下载→反推 =====
  async function submitUrls(rawUrls: string[]) {
    const token = getToken() || "";
    if (!token) { setGlobalError("未登录或登录已过期"); return; }
    if (!agree) { setGlobalError("请先勾选同意「仅供个人学习/分析」声明"); return; }
    const urls = rawUrls.map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) { setGlobalError("请粘贴至少一个视频链接"); return; }
    setGlobalError(null);
    setUrlBusy(true);
    try {
      const r = await fetch(`${BASE}/v1/video/from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ urls, title: title.trim() || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      onClose();
      if (data.draft_id) router.push(draftPath(data.draft_id));
    } catch (e: any) {
      setGlobalError(e?.message || "提交失败");
    } finally {
      setUrlBusy(false);
    }
  }

  // 勾选/取消一个结果; 勾选时分配下一个未用集号
  function togglePick(key: string) {
    setPicked((prev) => {
      const next = { ...prev };
      if (key in next) {
        delete next[key];
      } else {
        const used = new Set(Object.values(next));
        let ep = 1;
        while (used.has(ep)) ep++;
        next[key] = ep;
      }
      return next;
    });
  }
  function setEp(key: string, ep: number) {
    setPicked((prev) => ({ ...prev, [key]: ep }));
  }

  // 批量反推: 按用户设定集数排序, 一次性提交为一个多集草稿
  async function submitPicked() {
    const entries = Object.entries(picked);
    if (!entries.length) { setGlobalError("请先勾选至少一个视频"); return; }
    if (!agree) { setGlobalError("请先勾选同意「仅供个人学习/分析」声明"); return; }
    const urls = entries
      .map(([key, ep]) => {
        const r = searchResults.find((x) => (x.aweme_id || x.url) === key);
        return { url: r?.url as string, ep };
      })
      .filter((x) => x.url)
      .sort((a, b) => a.ep - b.ep)
      .map((x) => x.url);
    await submitUrls(urls);
  }

  // ===== 搜索: 多平台(TikHub) =====
  async function runSearch() {
    const token = getToken() || "";
    if (!token || !searchQ.trim()) return;
    setSearchBusy(true);
    setSearchMsg(null);
    setSearchResults([]);
    setPicked({});
    try {
      const r = await fetch(`${BASE}/v1/video/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: searchQ.trim(), platform: searchPlatform, limit: 8 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      if (!data.supported) {
        setSearchMsg(data.message || "该平台暂不支持搜索, 请改用贴链接");
        return;
      }
      setSearchResults(data.results || []);
      if (!(data.results || []).length) setSearchMsg("没有搜到结果, 换个关键词试试");
    } catch (e: any) {
      setSearchMsg(e?.message || "搜索失败");
    } finally {
      setSearchBusy(false);
    }
  }

  /** 收下一批文件(点击选择与拖放共用)。非视频自动剔除并提示。 */
  function addFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    const videoExt = /\.(mp4|mov|mkv|webm|avi|mpeg|mpg|3gp|flv|wmv)$/i;
    const ok: FileItem[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (!videoExt.test(f.name)) { rejected.push(f.name); continue; }
      ok.push({
        file: f,
        id: `${f.name}_${f.size}_${Math.random().toString(36).slice(2, 8)}`,
        status: "pending",
      });
    }
    if (rejected.length) {
      setGlobalError("已忽略非视频文件: " + rejected.join(", "));
    } else {
      setGlobalError(null);
    }
    // 集顺序 = 上传顺序 = 剧情顺序，不能沿用浏览器给的顺序（Windows 多选常是乱的，
    // 2026-10-29 草稿 #3034 因此把第 2–7 集排到了第 94–99 集）。按文件名里的集号排。
    const nameOf = (x: FileItem) => x.file.name;
    const next = manualOrder ? [...files, ...sortByEpisodeNo(ok, nameOf)] : sortByEpisodeNo([...files, ...ok], nameOf);
    setFiles(next);
    if (!title && next.length > 0) {
      setTitle(next[0].file.name.replace(/\.[^.]+$/, ""));
    }
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files || []));
    e.target.value = "";
  }

  function removeFile(id: string) {
    if (phase === "uploading") return;
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function moveFile(from: number, to: number) {
    if (phase !== "idle") return;
    if (from === to || to < 0 || to >= files.length) return;
    setFiles((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setManualOrder(true);
  }

  /** 撤销手动排序，回到按文件名集号的顺序 */
  function resortByEpisode() {
    if (phase !== "idle") return;
    setFiles((prev) => sortByEpisodeNo(prev, (x) => x.file.name));
    setManualOrder(false);
  }

  function appendLog(msg: string) {
    setLogs((prev) => [...prev.slice(-49), msg]);
  }

  function updateFile(id: string, patch: Partial<FileItem>) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function handleSubmit() {
    if (files.length === 0) {
      setGlobalError("请至少选择 1 个视频");
      return;
    }
    const token = getToken() || "";
    if (!token) {
      setGlobalError("未登录或登录已过期, 请重新登录");
      return;
    }

    // 第一次开始前确认集顺序问题（缺集/重号/认不出/手动顺序与集号不符）。
    // 失败后重试时已有集传完，不再重复打断。
    if (orderWarning && !files.some((f) => f.status === "done")
        && !window.confirm(`集顺序请确认：${orderWarning}\n\n仍按列表当前顺序开始反推吗？`)) {
      return;
    }

    setGlobalError(null);
    setPhase("uploading");
    setLogs([]);

    const uploadIds: string[] = [];
    try {
      const controller = new AbortController();
      serverUpload.current = controller;
      const r = await submitWorkshopVideo(
        BASE, token, files.map(item => item.file), title, concurrency, controller.signal, async () => {
        for (let i = 0; i < files.length; i++) {
          const item = files[i];
          if (item.status === "done" && item.upload_id) {
            uploadIds.push(item.upload_id);
            continue;
          }
          updateFile(item.id, { status: "uploading", error: undefined });
          appendLog(`第${i + 1}集 [${item.file.name}] 开始上传 (${formatBytes(item.file.size)})`);

          const ctrl = uploadToOss({
            file: item.file,
            token,
            namespace: "video",
            extra: { episode_index: i + 1 },
            kind: "auto",
            concurrency: 4,
            onProgress: (p) => updateFile(item.id, { progress: p }),
            onLog: (m) => appendLog(`第${i + 1}集 ${m}`),
          });
          ctrlsRef.current.set(item.id, ctrl);
          try {
            const result = await ctrl.promise;
            uploadIds.push(result.upload_id);
            updateFile(item.id, { status: "done", upload_id: result.upload_id });
          } finally {
            ctrlsRef.current.delete(item.id);
          }
        }

        setPhase("creating");
        appendLog(`全部 ${files.length} 集已上传, 正在创建草稿...`);

        return fetch(`${BASE}/v1/video/from-oss`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ upload_ids: uploadIds, title: title.trim() || undefined, concurrency }),
        });
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`创建草稿失败 (${r.status}): ${txt.slice(0, 300)}`);
      }
      const data = await r.json();
      appendLog(`✓ 草稿已创建 (id=${data.draft_id}), 后台反推已启动`);
      setPhase("done");

      setTimeout(() => {
        setFiles([]);
        setTitle("");
        setLogs([]);
        setPhase("idle");
        onClose();
        if (data.draft_id) router.push(draftPath(data.draft_id));
      }, 800);
    } catch (e: any) {
      setPhase("idle");
      const msg = e?.message || "上传失败";
      setGlobalError(msg);
      appendLog(`✗ ${msg}`);
      setFiles((prev) => prev.map((f) => (f.status === "uploading" ? { ...f, status: "failed", error: msg } : f)));
    }
  }

  function pauseFile(id: string) {
    const ctrl = ctrlsRef.current.get(id);
    if (ctrl) {
      ctrl.pause();
      updateFile(id, { status: "paused" });
    }
  }
  function resumeFile(id: string) {
    const ctrl = ctrlsRef.current.get(id);
    if (ctrl) {
      ctrl.resume();
      updateFile(id, { status: "uploading" });
    }
  }
  function cancelAll() {
    serverUpload.current?.abort();
    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();
    ctrlsRef.current.clear();
    setPhase("idle");
    appendLog("已取消所有上传");
  }

  const totalSize = files.reduce((s, f) => s + f.file.size, 0);
  const orderWarning = useMemo(() => {
    if (files.length < 2) return "";
    const names = files.map((f) => f.file.name);
    const parts: string[] = [];
    const review = reviewEpisodeNames(names);
    if (review) parts.push(review);
    const sorted = sortByEpisodeNo(files, (x) => x.file.name);
    if (sorted.some((f, i) => f.id !== files[i].id)) {
      parts.push("当前顺序和文件名里的集号不一致");
    }
    return parts.join("；");
  }, [files]);
  const allDone = files.length > 0 && files.every((f) => f.status === "done");
  const isWorking = phase === "uploading" || phase === "creating";

  const footer = (
    <div className="flex justify-end gap-2 w-full">
      <Button variant="secondary" size="md" onClick={() => { if (!isWorking) onClose(); else cancelAll(); }}>
        {isWorking ? "取消上传" : "取消"}
      </Button>
      <Button
        variant="primary"
        size="md"
        loading={isWorking}
        disabled={isWorking || files.length === 0 || allDone}
        onClick={handleSubmit}
      >
        {phase === "uploading" && "上传中..."}
        {phase === "creating" && "创建草稿..."}
        {phase === "done" && "完成"}
        {phase === "idle" && `开始反推 (${files.length} 集)`}
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={() => { if (!isWorking) onClose(); else cancelAll(); }}
      title={
        <span className="flex items-center gap-2">
          <Film className="w-6 h-6 text-primary" />
          从视频反推剧本
          <span className="text-xs font-normal text-ink-muted ml-2">
            按列表顺序逐集反推
          </span>
        </span>
      }
      size="lg"
      footer={footer}
    >
      <div
        className="space-y-5"
        // 兜底: 浏览器对未处理的文件拖放的默认行为是**直接打开该文件、导航离开当前页**,
        // 用户填到一半的表单会整个丢掉。这里无条件 preventDefault 把它吃掉;
        // 停在「上传文件」页时顺手当作新增, 拖歪一点也能用。
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (tab !== "upload" || isWorking) return;
          addFiles(Array.from(e.dataTransfer.files || []));
        }}
      >
        {/* 入口 Tab: 上传文件 / 贴链接 / 搜索 */}
        <div className="inline-flex rounded-lg border border-line overflow-hidden text-sm">
          {([
            { k: "upload", label: "上传文件" },
            { k: "url", label: "贴链接" },
            { k: "search", label: "搜索" },
          ] as const).map((t) => (
            <button
              key={t.k}
              onClick={() => { setTab(t.k); setGlobalError(null); }}
              className={`px-4 py-1.5 transition ${tab === t.k ? "bg-primary text-white" : "bg-surface-base text-ink-secondary hover:bg-surface-overlay"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 剧名 (三个 Tab 共用) */}
        <div>
          <label className="block text-sm font-semibold mb-2 text-ink-primary">剧名</label>
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isWorking}
            placeholder="请输入剧名 (可选,默认取视频标题/文件名)"
          />
        </div>

        {/* ===== Tab: 贴链接 ===== */}
        {tab === "url" && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold mb-2 text-ink-primary">
                视频链接 (每行一个 = 一集, 按顺序)
              </label>
              <textarea
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                rows={5}
                placeholder={"粘贴抖音/快手/小红书/B站/YouTube 的单条视频链接\n可直接粘贴 App 分享出来的整段文字(含口令), 会自动识别链接\n多集请每行一个"}
                className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm text-ink-primary font-mono"
              />
              <p className="text-xs text-ink-muted mt-1">
                支持单条视频链接; 不要贴主页/合集链接。仅支持抖音、快手、小红书、B站、YouTube。
              </p>
            </div>
            <label className="flex items-start gap-2 text-xs text-ink-secondary cursor-pointer">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
              <span>我确认仅将下载内容用于<strong>个人学习/拆解分析</strong>, 不分发、不商用; 反推完成后系统将自动删除原始视频文件, 仅保留分析文本。</span>
            </label>
            {globalError && (
              <Card padding="sm" className="bg-danger/10 border-danger/40">
                <p className="text-sm text-danger">{globalError}</p>
              </Card>
            )}
            <Button
              variant="primary"
              size="md"
              loading={urlBusy}
              disabled={urlBusy || !agree || !urlText.trim()}
              onClick={() => submitUrls(urlText.split("\n"))}
            >
              {urlBusy ? "提交中…" : "开始下载并反推"}
            </Button>
            <p className="text-xs text-ink-muted">提交后会创建草稿并在后台下载+反推, 进度可在草稿页查看。</p>
          </div>
        )}

        {/* ===== Tab: 搜索 ===== */}
        {tab === "search" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded border border-line overflow-hidden text-xs">
                {(["douyin", "tiktok", "kuaishou", "xiaohongshu"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setSearchPlatform(p)}
                    className={`px-3 py-1.5 ${searchPlatform === p ? "bg-primary text-white" : "bg-surface-base text-ink-secondary"}`}
                  >
                    {p === "douyin" ? "抖音" : p === "tiktok" ? "TikTok" : p === "kuaishou" ? "快手" : "小红书"}
                  </button>
                ))}
              </div>
              <Input
                type="text"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="输入剧名/关键词搜索"
                className="flex-1 min-w-[200px]"
              />
              <Button variant="primary" size="md" loading={searchBusy} disabled={searchBusy || !searchQ.trim()} onClick={runSearch}>
                搜索
              </Button>
            </div>
            <p className="text-xs text-ink-muted">
              多平台短剧检索(TikHub): 抖音/TikTok/快手/小红书。红果为闭源App暂不支持, 请用「贴链接」。
            </p>
            {searchMsg && <p className="text-sm text-warning">{searchMsg}</p>}
            {searchResults.length > 0 && (
              <>
                <p className="text-xs text-ink-muted">勾选多个 = 一部剧的多集，可手动填每集集号，反推时按集号排序合成一个多集草稿。</p>
                <div className="border border-line rounded-md overflow-hidden divide-y divide-line max-h-80 overflow-y-auto">
                  {searchResults.map((r, i) => {
                    const key = r.aweme_id || r.url || String(i);
                    const isPicked = key in picked;
                    return (
                      <div key={i} className={`flex items-center gap-3 px-3 py-2 hover:bg-surface-overlay ${isPicked ? "bg-primary/5" : ""}`}>
                        <input type="checkbox" checked={isPicked} onChange={() => togglePick(key)} className="shrink-0" />
                        {r.cover || r.thumbnail ? (
                          <img src={r.cover || r.thumbnail} alt="" className="w-12 h-16 object-cover rounded shrink-0" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-12 h-16 bg-surface-base rounded shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-ink-primary line-clamp-2" title={r.title}>{r.title || "(无标题)"}</div>
                          <div className="text-xs text-ink-muted truncate">
                            {r.author || r.uploader || ""}{r.duration ? ` · ${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, "0")}` : ""}
                          </div>
                        </div>
                        {isPicked && (
                          <label className="flex items-center gap-1 text-xs text-ink-secondary shrink-0">
                            第
                            <input
                              type="number" min={1} value={picked[key]}
                              onChange={(e) => setEp(key, Math.max(1, Number(e.target.value) || 1))}
                              className="w-12 rounded border border-line bg-surface-base px-1 py-0.5 text-center text-xs"
                            />
                            集
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-xs text-ink-muted">已选 {Object.keys(picked).length} 集</span>
                  <Button variant="primary" size="md" loading={urlBusy}
                    disabled={urlBusy || !agree || !Object.keys(picked).length}
                    onClick={submitPicked}
                    title={!agree ? "请先勾选个人分析声明" : ""}>
                    {urlBusy ? "提交中…" : `反推选中的 ${Object.keys(picked).length} 集`}
                  </Button>
                </div>
              </>
            )}
            <label className="flex items-start gap-2 text-xs text-ink-secondary cursor-pointer">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
              <span>我确认仅将下载内容用于<strong>个人学习/拆解分析</strong>, 不分发、不商用; 反推完成后自动删除原片, 仅留分析文本。</span>
            </label>
          </div>
        )}

        {/* ===== Tab: 上传文件 (原有流程) ===== */}
        {tab === "upload" && (
        <>
        {/* 文件列表 */}
        <div>
          <label className="block text-sm font-semibold mb-2 text-ink-primary">
            视频文件 (已按文件名里的集号排好, 顺序 = 集顺序, 可拖动调整)
          </label>

          {files.length > 0 && (
            <div className="mb-3 border border-line rounded-md overflow-hidden">
              {files.map((f, idx) => {
                const p = f.progress;
                const pct = p ? Math.round((p.loaded / p.total) * 100) : 0;
                return (
                  <div
                    key={f.id}
                    draggable={!isWorking}
                    onDragStart={(e) => e.dataTransfer.setData(REORDER_MIME, String(idx))}
                    onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx); }}
                    onDragLeave={() => setDragOverIdx(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();   // 别再冒泡给外层的"投放即新增"
                      setDragOverIdx(null);
                      // 从系统拖进来的视频 → 当作新增, 不是排序
                      if (e.dataTransfer.files?.length) {
                        if (!isWorking) addFiles(Array.from(e.dataTransfer.files));
                        return;
                      }
                      const raw = e.dataTransfer.getData(REORDER_MIME);
                      if (raw === "") return;          // 不是本列表发起的拖拽, 忽略
                      const from = Number(raw);
                      if (Number.isNaN(from)) return;
                      moveFile(from, idx);
                    }}
                    className={`px-3 py-2 border-b border-line last:border-b-0 transition ${
                      dragOverIdx === idx ? "bg-primary/10" : "hover:bg-surface-base"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <GripVertical className="w-4 h-4 text-ink-muted cursor-move" />
                      <Badge tone="info" size="sm">第{idx + 1}集</Badge>
                      <span className="flex-1 text-sm truncate text-ink-primary" title={f.file.name}>
                        {f.file.name}
                      </span>
                      <span className="text-xs text-ink-muted shrink-0">{formatBytes(f.file.size)}</span>

                      {f.status === "done" && <CheckCircle className="w-4 h-4 text-success" />}
                      {f.status === "failed" && <AlertCircle className="w-4 h-4 text-danger" />}
                      {f.status === "uploading" && (
                        <IconButton aria-label="暂停" size="sm" variant="ghost" onClick={() => pauseFile(f.id)}>
                          <Pause className="w-4 h-4 text-warning" />
                        </IconButton>
                      )}
                      {f.status === "paused" && (
                        <IconButton aria-label="继续" size="sm" variant="ghost" onClick={() => resumeFile(f.id)}>
                          <Play className="w-4 h-4 text-success" />
                        </IconButton>
                      )}
                      {(f.status === "uploading" || f.status === "paused") && (
                        <Spinner size="sm" className={f.status === "uploading" ? "" : "opacity-50"} />
                      )}
                      {!isWorking && f.status !== "done" && (
                        <IconButton aria-label="移除" size="sm" variant="ghost" onClick={() => removeFile(f.id)}>
                          <X className="w-4 h-4 text-ink-muted hover:text-danger" />
                        </IconButton>
                      )}
                    </div>

                    {(f.status === "uploading" || f.status === "paused" || f.status === "done") && p && (
                      <div className="mt-2 ml-6">
                        <div className="h-1.5 bg-surface-base rounded overflow-hidden">
                          <div
                            className={`h-full transition-all ${
                              f.status === "done" ? "bg-success" :
                              f.status === "paused" ? "bg-warning" : "bg-primary"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-ink-muted mt-0.5">
                          <span>
                            {pct}%
                            {p.parts_total > 1 && ` · ${p.parts_done}/${p.parts_total} 片`}
                            {f.status === "uploading" && p.speed > 0 && ` · ${formatSpeed(p.speed)}`}
                          </span>
                          <span>
                            {formatBytes(p.loaded)} / {formatBytes(p.total)}
                            {f.status === "uploading" && p.etaSeconds >= 0 && ` · 剩余 ${formatDuration(p.etaSeconds)}`}
                          </span>
                        </div>
                      </div>
                    )}

                    {f.status === "failed" && f.error && (
                      <div className="mt-1 ml-6 text-xs text-danger">{f.error}</div>
                    )}
                  </div>
                );
              })}
              <div className="px-3 py-2 text-xs text-ink-muted bg-surface-base flex items-center gap-2">
                <span className="flex-1">共 {files.length} 集, 总大小 {formatBytes(totalSize)}</span>
                {manualOrder && !isWorking && (
                  <Button variant="ghost" size="sm" onClick={resortByEpisode}>按集号重新排序</Button>
                )}
              </div>
              {orderWarning && (
                <div className="px-3 py-2 text-xs text-warning bg-warning/10 border-t border-line flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>集顺序请确认：{orderWarning}</span>
                </div>
              )}
            </div>
          )}

          <label
            className="block cursor-pointer"
            onDragOver={(e) => { e.preventDefault(); if (!isWorking) setDropActive(true); }}
            onDragEnter={(e) => { e.preventDefault(); if (!isWorking) setDropActive(true); }}
            onDragLeave={() => setDropActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropActive(false);
              if (isWorking) return;
              addFiles(Array.from(e.dataTransfer.files || []));
            }}
          >
            <input
              type="file"
              accept="video/*,.mp4,.mov,.mkv,.webm,.avi"
              multiple
              onChange={handleFiles}
              disabled={isWorking}
              className="hidden"
            />
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                dropActive ? "border-primary bg-primary/10" : "border-line hover:border-primary"
              }`}
            >
              <p className="text-sm text-ink-primary">
                {dropActive ? "松开即可添加" : "点击或拖放视频文件到这里"}
              </p>
              <p className="text-xs text-ink-muted mt-1">
                支持 mp4 / mov / mkv / webm / avi · 单文件上限 50GB · 支持断点续传
              </p>
            </div>
          </label>

          {/* 大批量场景的出口: 这个弹窗一次只能产出一个草稿 */}
          <button
            type="button"
            disabled={isWorking}
            onClick={() => { onClose(); router.push("/drafts/batch-reverse"); }}
            className="mt-2 w-full text-left text-xs text-ink-muted hover:text-primary disabled:opacity-40 transition-colors"
          >
            视频很多、一个文件夹一部剧？→ <span className="underline">批量文件夹反推</span>
          </button>
        </div>

        {/* 反推并发 */}
        <div className="flex items-center gap-3 text-sm flex-wrap">
          <span className="text-ink-secondary">反推并发</span>
          {([1, 2, 3] as const).map((c) => (
            <Button
              key={c}
              variant={concurrency === c ? "primary" : "secondary"}
              size="sm"
              disabled={isWorking}
              onClick={() => setConcurrency(c)}
            >
              {c} {c === 1 ? "(串行/最稳)" : "(并行/更快)"}
            </Button>
          ))}
        </div>

        {/* 全局错误 */}
        {globalError && (
          <Card padding="sm" className="bg-danger/10 border-danger/40">
            <p className="text-sm text-danger">{globalError}</p>
          </Card>
        )}

        {/* 日志区 */}
        {logs.length > 0 && (
          <div className="bg-surface-base border border-line rounded-md p-3 max-h-32 overflow-y-auto text-[11px] font-mono text-ink-secondary">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        </>
        )}
      </div>
    </Modal>
  );
}
