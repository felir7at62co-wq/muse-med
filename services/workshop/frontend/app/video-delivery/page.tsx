"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import {
  Download, Search, Loader2, ArrowLeft, Tag as TagIcon, Check, Users,
  Link2, X, Film,
} from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/video-delivery`;

type Downloader = {
  user_id: number;
  name: string;
  count: number;
  last_at: string | null;
  is_me: boolean;
};

type VideoItem = {
  id: number;
  title: string;
  original_title: string | null;
  source: string;
  cdn_url: string;
  thumbnail_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  duration: number;
  download_count: number;
  my_download_count: number;
  downloaded_by_me: boolean;
  last_downloaded_at: string | null;
  downloaders: Downloader[];
  tags: string[];
};

function fmtDuration(sec: number): string {
  if (!sec) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "-";
  }
}

// 标签颜色映射(已使用=绿, 已发布=蓝, 待剪辑=橙, 有问题=红, 其它=灰)
function tagClass(tag: string): string {
  if (tag === "已使用") return "bg-green-500/15 text-green-600 border-green-500/30";
  if (tag === "已发布") return "bg-blue-500/15 text-blue-600 border-blue-500/30";
  if (tag === "待剪辑") return "bg-orange-500/15 text-orange-600 border-orange-500/30";
  if (tag === "有问题") return "bg-red-500/15 text-red-600 border-red-500/30";
  return "bg-surface text-ink-secondary border-line";
}

export default function VideoDeliveryPage() {
  if (typeof window !== "undefined" && !getUser()) {
    window.location.href = "/login?from=/video-delivery";
    return null;
  }
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [downloadStatus, setDownloadStatus] = useState("");   // ''|not_downloaded|downloaded_by_me|downloaded_by_others
  const [tagFilter, setTagFilter] = useState("");             // ''|已使用|__untagged__|...
  const [sort, setSort] = useState("latest");                 // latest|most_downloaded|duration|oldest
  const [startHour, setStartHour] = useState("");
  const [endHour, setEndHour] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagPresets, setTagPresets] = useState<string[]>([]);
  const [toast, setToast] = useState<string>("");
  const [dlQueue, setDlQueue] = useState<{ done: number; total: number } | null>(null);
  const [hoverDl, setHoverDl] = useState<number | null>(null);  // 悬浮显示下载人的行id
  const pageSize = 20;
  const toastTimer = useRef<any>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  }

  async function loadVideos() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (keyword) params.set("keyword", keyword);
      if (sourceFilter) params.set("source", sourceFilter);
      if (downloadStatus) params.set("download_status", downloadStatus);
      if (tagFilter) params.set("tag", tagFilter);
      if (sort) params.set("sort", sort);
      if (startHour) {
        const d = new Date(`${startHour}:00+08:00`);
        if (!isNaN(d.getTime())) params.set("start_date", d.toISOString());
      }
      if (endHour) {
        const d = new Date(`${endHour}:59+08:00`);
        if (!isNaN(d.getTime())) params.set("end_date", d.toISOString());
      }
      const res = await fetch(`${API}/list?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setVideos(data.items || []);
      setTotal(data.total || 0);
    } catch (e: any) {
      showToast("加载失败: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadPresets() {
    try {
      const res = await fetch(`${API}/tags/presets`, { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        setTagPresets(d.tags || []);
      }
    } catch {}
  }

  useEffect(() => { loadVideos(); }, [page, keyword, sourceFilter, downloadStatus, tagFilter, sort, startHour, endHour]);
  useEffect(() => { loadPresets(); }, []);

  // 下载: 走 proxy(带中文名 + 进度), 用隐藏 a 触发浏览器原生下载器
  function triggerDownload(v: VideoItem) {
    const url = `${API}/download-proxy/${v.id}?token=${encodeURIComponent(getToken() || "")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${v.title}.mp4`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 3000);
  }

  async function handleBatchDownload() {
    if (selected.size === 0) { showToast("请至少选择一个视频"); return; }
    const ids = Array.from(selected);
    const list = videos.filter((v) => ids.includes(v.id));
    setDlQueue({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      triggerDownload(list[i]);
      setDlQueue({ done: i + 1, total: list.length });
      await new Promise((r) => setTimeout(r, 1200)); // 间隔避免浏览器限流
    }
    setTimeout(() => setDlQueue(null), 2000);
    showToast(`已触发 ${list.length} 个视频下载(中文文件名)`);
    setSelected(new Set());
    // 局部刷新下载计数
    loadVideos();
  }

  async function copyLink(v: VideoItem) {
    const url = `${API}/download-redirect/${v.id}?token=${encodeURIComponent(getToken() || "")}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("链接已复制");
    } catch {
      showToast("复制失败, 请手动复制");
    }
  }

  async function applyTag(jobIds: number[], tag: string, add: boolean) {
    try {
      const res = await fetch(`${API}/tags`, {
        method: add ? "POST" : "DELETE",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: jobIds, tag }),
      });
      if (!res.ok) throw new Error(await res.text());
      showToast(add ? `已标记「${tag}」` : `已取消「${tag}」`);
      loadVideos();
      loadPresets();
    } catch (e: any) {
      showToast("操作失败: " + e.message);
    }
  }

  // 单行切换某标签
  function toggleRowTag(v: VideoItem, tag: string) {
    const has = v.tags.includes(tag);
    applyTag([v.id], tag, !has);
  }

  function toggleSelect(id: number) {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  }
  function toggleAll() {
    if (selected.size === videos.length) setSelected(new Set());
    else setSelected(new Set(videos.map((v) => v.id)));
  }

  const totalPages = Math.ceil(total / pageSize);
  const hasFilter = keyword || sourceFilter || downloadStatus || tagFilter || startHour || endHour;

  return (
    <div className="min-h-screen bg-surface text-ink-primary">
      <UserNav />

      {/* Toast */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-ink-primary text-white rounded-lg shadow-lg text-sm">
          {toast}
        </div>
      )}
      {/* 下载队列进度 */}
      {dlQueue && (
        <div className="fixed top-32 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-primary text-white rounded-lg shadow-lg text-sm flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          下载队列 {dlQueue.done}/{dlQueue.total}
        </div>
      )}

      <div className="max-w-7xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push("/drafts")} className="p-2 rounded-lg hover:bg-surface-elevated transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-semibold">视频交付中心</h1>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-surface-elevated rounded-lg p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <label className="block text-xs text-ink-secondary mb-1">搜索标题</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input type="text" value={keyword}
                  onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
                  placeholder="关键词..."
                  className="w-full pl-10 pr-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">来源</label>
              <select value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm">
                <option value="">全部来源</option>
                <option value="feishu">飞书</option>
                <option value="novel-video">小说转视频</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">排序</label>
              <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm">
                <option value="latest">最新完成</option>
                <option value="most_downloaded">下载最多</option>
                <option value="duration">时长最长</option>
                <option value="oldest">最早完成</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">下载状态</label>
              <select value={downloadStatus} onChange={(e) => { setDownloadStatus(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm">
                <option value="">全部</option>
                <option value="not_downloaded">未下载</option>
                <option value="downloaded_by_me">我已下载</option>
                <option value="downloaded_by_others">他人已下载</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">标签</label>
              <select value={tagFilter} onChange={(e) => { setTagFilter(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm">
                <option value="">全部标签</option>
                <option value="__untagged__">无标签</option>
                {tagPresets.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-secondary mb-1">完成时间起(北京时间)</label>
              <input type="datetime-local" step="3600" value={startHour}
                onChange={(e) => { setStartHour(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm" />
            </div>
          </div>

          {/* 快捷 chips + 清除 */}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button onClick={() => { setDownloadStatus(downloadStatus === "not_downloaded" ? "" : "not_downloaded"); setPage(1); }}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${downloadStatus === "not_downloaded" ? "bg-primary text-white border-primary" : "border-line hover:bg-surface"}`}>
              只看未下载
            </button>
            <button onClick={() => { setTagFilter(tagFilter === "__untagged__" ? "" : "__untagged__"); setPage(1); }}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${tagFilter === "__untagged__" ? "bg-primary text-white border-primary" : "border-line hover:bg-surface"}`}>
              只看未打标
            </button>
            <button onClick={() => { setTagFilter(tagFilter === "已使用" ? "" : "已使用"); setPage(1); }}
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${tagFilter === "已使用" ? "bg-green-500 text-white border-green-500" : "border-line hover:bg-surface"}`}>
              只看已使用
            </button>
            {endHour === "" && startHour !== "" && (
              <input type="datetime-local" step="3600" value={endHour}
                onChange={(e) => { setEndHour(e.target.value); setPage(1); }}
                placeholder="止"
                className="px-2 py-1 bg-surface border border-line rounded text-xs" />
            )}
            {hasFilter && (
              <button onClick={() => { setKeyword(""); setSourceFilter(""); setDownloadStatus(""); setTagFilter(""); setStartHour(""); setEndHour(""); setPage(1); }}
                className="px-3 py-1 rounded-full text-xs border border-line hover:bg-surface flex items-center gap-1">
                <X className="w-3 h-3" /> 清除筛选
              </button>
            )}
          </div>
        </div>

        {/* Video List */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 bg-surface-elevated rounded-lg animate-pulse" />
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="text-center py-16 text-ink-muted">
            {hasFilter ? (
              <div className="space-y-3">
                <div>没有符合筛选条件的视频</div>
                <button onClick={() => { setKeyword(""); setSourceFilter(""); setDownloadStatus(""); setTagFilter(""); setStartHour(""); setEndHour(""); setPage(1); }}
                  className="px-4 py-2 text-sm border border-line rounded-lg hover:bg-surface-elevated">清除筛选</button>
              </div>
            ) : "暂无视频"}
          </div>
        ) : (
          <>
            <div className="bg-surface-elevated rounded-lg overflow-visible mb-4">
              <table className="w-full">
                <thead className="bg-surface border-b border-line">
                  <tr>
                    <th className="px-3 py-3 text-left w-10">
                      <input type="checkbox" checked={selected.size === videos.length && videos.length > 0}
                        onChange={toggleAll} className="rounded border-line focus:ring-primary" />
                    </th>
                    <th className="px-3 py-3 text-left text-sm font-medium">视频</th>
                    <th className="px-3 py-3 text-left text-sm font-medium w-20">时长</th>
                    <th className="px-3 py-3 text-left text-sm font-medium w-24">来源</th>
                    <th className="px-3 py-3 text-left text-sm font-medium">标签</th>
                    <th className="px-3 py-3 text-left text-sm font-medium w-40">下载情况</th>
                    <th className="px-3 py-3 text-left text-sm font-medium w-28">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {videos.map((v) => (
                    <tr key={v.id}
                      className={`hover:bg-surface transition-colors ${v.tags.includes("已使用") ? "opacity-70" : ""}`}>
                      {/* 左侧色条: 我下过=绿(用第一个单元格的左边框, 不占额外列避免错位) */}
                      <td className={`px-3 py-3 border-l-4 ${v.downloaded_by_me ? "border-green-500" : "border-transparent"}`}>
                        <input type="checkbox" checked={selected.has(v.id)}
                          onChange={() => toggleSelect(v.id)} className="rounded border-line focus:ring-primary" />
                      </td>
                      {/* 缩略图 + 标题 */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-3">
                          {v.thumbnail_url ? (
                            <img src={v.thumbnail_url} alt="" className="w-12 h-16 object-cover rounded bg-surface flex-shrink-0"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          ) : (
                            <div className="w-12 h-16 rounded bg-surface flex items-center justify-center flex-shrink-0">
                              <Film className="w-5 h-5 text-ink-muted" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate max-w-[220px]" title={v.title}>{v.title}</div>
                            {v.original_title && v.original_title !== v.title && (
                              <div className="text-xs text-ink-secondary truncate max-w-[220px]" title={v.original_title}>
                                原名: {v.original_title}
                              </div>
                            )}
                            <div className="text-xs text-ink-muted">ID {v.id} · {fmtTime(v.updated_at)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-sm text-ink-secondary">{fmtDuration(v.duration)}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                          v.source === "feishu" ? "bg-primary-subtle text-primary" : "bg-cyan/20 text-cyan"}`}>
                          <TagIcon className="w-3 h-3" />
                          {v.source === "feishu" ? "飞书" : "小说转视频"}
                        </span>
                      </td>
                      {/* 标签 chips + 快捷切换已使用 */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1 flex-wrap">
                          {v.tags.map((t) => (
                            <button key={t} onClick={() => toggleRowTag(v, t)} title="点击取消"
                              className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs border ${tagClass(t)}`}>
                              {t}<X className="w-2.5 h-2.5" />
                            </button>
                          ))}
                          {!v.tags.includes("已使用") && (
                            <button onClick={() => toggleRowTag(v, "已使用")}
                              className="px-2 py-0.5 rounded-full text-xs border border-dashed border-line text-ink-muted hover:text-green-600 hover:border-green-500">
                              + 已使用
                            </button>
                          )}
                        </div>
                      </td>
                      {/* 下载情况: 我下过 + 全站 + 悬浮谁下过 */}
                      <td className="px-3 py-3 relative"
                        onMouseEnter={() => setHoverDl(v.id)} onMouseLeave={() => setHoverDl(null)}>
                        <div className="flex items-center gap-2 text-sm cursor-default">
                          {v.downloaded_by_me ? (
                            <span className="inline-flex items-center gap-1 text-green-600">
                              <Check className="w-3.5 h-3.5" />我下过{v.my_download_count}次
                            </span>
                          ) : (
                            <span className="text-ink-muted">未下载</span>
                          )}
                          <span className="inline-flex items-center gap-1 text-ink-secondary">
                            <Users className="w-3.5 h-3.5" />全站{v.download_count}
                          </span>
                        </div>
                        {/* 悬浮下载人清单 */}
                        {hoverDl === v.id && v.downloaders.length > 0 && (
                          <div className="absolute z-20 top-full left-0 mt-1 w-56 bg-surface-elevated border border-line rounded-lg shadow-xl p-2 text-xs">
                            <div className="text-ink-muted mb-1 px-1">下载记录</div>
                            {v.downloaders.map((d) => (
                              <div key={d.user_id} className="flex items-center justify-between px-1 py-0.5">
                                <span className={d.is_me ? "text-green-600 font-medium" : ""}>
                                  {d.name}{d.is_me ? "(我)" : ""}
                                </span>
                                <span className="text-ink-muted">{d.count}次 · {fmtTime(d.last_at).slice(5, 16)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      {/* 操作 */}
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => triggerDownload(v)} title="下载(中文名)"
                            className="p-1.5 rounded hover:bg-primary-subtle text-primary transition-colors">
                            <Download className="w-4 h-4" />
                          </button>
                          <button onClick={() => copyLink(v)} title="复制下载链接"
                            className="p-1.5 rounded hover:bg-surface text-ink-secondary transition-colors">
                            <Link2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between">
              <div className="text-sm text-ink-secondary">共 {total} 个视频，第 {page}/{totalPages} 页</div>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="px-4 py-2 bg-surface-elevated rounded-lg hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors">上一页</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="px-4 py-2 bg-surface-elevated rounded-lg hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors">下一页</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 底部批量操作条 */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-surface-elevated border border-line rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3">
          <span className="text-sm font-medium">已选 {selected.size} 个</span>
          <div className="w-px h-5 bg-line" />
          <button onClick={handleBatchDownload} disabled={!!dlQueue}
            className="px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 flex items-center gap-1 text-sm transition-colors">
            <Download className="w-4 h-4" />批量下载
          </button>
          <button onClick={() => applyTag(Array.from(selected), "已使用", true)}
            className="px-3 py-1.5 border border-line rounded-lg hover:bg-surface flex items-center gap-1 text-sm transition-colors">
            <Check className="w-4 h-4" />标记已使用
          </button>
          <button onClick={async () => {
            const links = Array.from(selected).map((id) => `${API}/download-redirect/${id}?token=${encodeURIComponent(getToken() || "")}`).join("\n");
            try { await navigator.clipboard.writeText(links); showToast(`已复制 ${selected.size} 条链接`); } catch { showToast("复制失败"); }
          }}
            className="px-3 py-1.5 border border-line rounded-lg hover:bg-surface flex items-center gap-1 text-sm transition-colors">
            <Link2 className="w-4 h-4" />复制链接
          </button>
          <button onClick={() => setSelected(new Set())} className="p-1.5 rounded hover:bg-surface text-ink-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}