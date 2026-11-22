"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import {
  ArrowLeft, Search, Loader2, RefreshCw, TrendingUp, Flame, Hash,
  Heart, MessageCircle, Play, Download, Sparkles, FileText, Clapperboard,
} from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/tikhub`;

type VideoItem = {
  aweme_id: string;
  desc: string;
  cover?: string;
  play_url?: string;
  share_url?: string;
  duration?: number;
  author?: { nickname?: string };
  statistics?: {
    digg_count?: number; comment_count?: number; share_count?: number;
    collect_count?: number; play_count?: number;
  };
  tags?: string[];
  platform?: string;
  series_id?: string | null;   // 抖音短剧官方剧集ID: 有值=正片, 空=番外/切片/混剪
  item_title?: string;
};

const PLATFORMS: { id: string; label: string }[] = [
  { id: "douyin", label: "抖音" },
  { id: "tiktok", label: "TikTok" },
  { id: "kuaishou", label: "快手" },
  { id: "xiaohongshu", label: "小红书" },
];

function fmtNum(n?: number): string {
  if (n == null) return "-";
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  return String(n);
}

export default function MarketDataPage() {
  if (typeof window !== "undefined" && !getUser()) {
    window.location.href = "/jubengongfang/login?from=/market-data";
    return null;
  }
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [tab, setTab] = useState<"search" | "boards">("search");

  // ---- 搜索 ----
  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState("douyin");
  const [sortType, setSortType] = useState("0");
  const [publishTime, setPublishTime] = useState("0");
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string>("");
  const [onlyOriginal, setOnlyOriginal] = useState(false);  // 只看原片
  const [seriesEps, setSeriesEps] = useState<VideoItem[] | null>(null);  // 按series_id拉全的整部剧各集
  const [seriesLoading, setSeriesLoading] = useState(false);

  const doSearch = useCallback(async () => {
    if (!keyword.trim()) return;
    setLoading(true); setErr(""); setVideos([]);
    try {
      const qs = new URLSearchParams({ keyword: keyword.trim(), platform, sort_type: sortType, publish_time: publishTime });
      const r = await fetch(`${API}/search/videos?${qs}`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      setVideos(d.videos || []);
      if (!(d.videos || []).length) setErr("没有搜到结果，换个关键词或平台试试");
    } catch (e: any) {
      setErr(e.message || "搜索失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, platform, sortType, publishTime]);

  // ---- 混剪/二创判别(启发式, 可能不准) ----
  // 依据用户确认的三条相对可靠信号: 标题/文案关键词、话题标签、系列连续性。
  // 注意: 很多短剧作者自己也发混剪, 靠"作者"判别极易误判, 故不采纳作者维度。
  const MASHUP_WORDS = [
    "混剪", "剪辑", "解说", "盘点", "名场面", "一口气看完", "看完整", "合集",
    "高能", "名台词", "cp向", "CP向", "催泪", "名场景", "带你看", "速看", "精彩片段",
    "泪目", "封神片段", "高燃", "钢筋", "二创", "手撕", "爽点合集", "反转合集",
  ];
  const EP_RE = /(第\s*\d+\s*集|EP\s*\d+|Ep\s*\d+|ep\s*\d+|\b\d{1,3}\b\s*集|全集|完结)/;

  function originalScore(v: VideoItem): { score: number; likely: boolean; reason: string } {
    const desc = (v.desc || "").toLowerCase();
    const rawDesc = v.desc || "";
    const tags = (v.tags || []).join(" ").toLowerCase();
    const hay = desc + " " + tags;
    let score = 0;
    const hitMash = MASHUP_WORDS.filter((w) => hay.includes(w.toLowerCase()));
    if (hitMash.length) score -= 40 + (hitMash.length - 1) * 10;   // 命中混剪词, 强烈降分
    if (EP_RE.test(rawDesc)) score += 30;                          // 分集命名, 强烈指向原片
    // 时长: 原片单集通常较完整(>=50s); 极短(<25s)多为切片
    if (typeof v.duration === "number" && v.duration > 0) {
      const sec = v.duration > 1000 ? v.duration / 1000 : v.duration;
      if (sec >= 50) score += 10;
      else if (sec < 25) score -= 15;
    }
    return { score, likely: score >= 0, reason: hitMash.length ? `疑似:${hitMash.slice(0, 2).join("/")}` : "" };
  }

  // 系列连续性: 同一作者出现 >=3 条且多条带分集命名 → 该作者整体加权为原片倾向
  const seriesAuthors = useMemo(() => {
    const byAuthor: Record<string, number> = {};
    for (const v of videos) {
      const a = v.author?.nickname || "";
      if (a && EP_RE.test(v.desc || "")) byAuthor[a] = (byAuthor[a] || 0) + 1;
    }
    return new Set(Object.entries(byAuthor).filter(([, n]) => n >= 3).map(([a]) => a));
  }, [videos]);

  // "只看原片"判别:
  // 首选【抖音官方短剧标记 series_id】——只有正片剧集才有, 番外/切片/混剪/催更都为空,
  // 这是平台权威标记, 几乎零误判。
  // 兜底(某些结果没返回 series_id 时): 用"分集命名 + 无混剪词 + 非极短切片"的启发式。
  function isLikelyOriginal(v: VideoItem): boolean {
    if (v.series_id) return true;                        // 官方正片剧集, 直接保留
    // 兜底启发式
    const rawDesc = v.desc || "";
    const hay = (rawDesc + " " + (v.tags || []).join(" ")).toLowerCase();
    if (MASHUP_WORDS.some((w) => hay.includes(w.toLowerCase()))) return false;
    let sec = 0;
    if (typeof v.duration === "number" && v.duration > 0) sec = v.duration > 1000 ? v.duration / 1000 : v.duration;
    if (sec > 0 && sec < 25) return false;
    return EP_RE.test(rawDesc);                          // 有明确分集命名才算
  }

  // 若结果里没有任何 series_id(该剧未被平台标为短剧合集), 用兜底启发式; 有则以官方标记为准。
  const hasAnySeriesId = useMemo(() => videos.some((v) => !!v.series_id), [videos]);

  // 点"只看原片": 优先用第一条正片的 series_id 调合集接口拉"整部剧全部集"(召回全,不缺集);
  // 若该剧无 series_id 则退回本地过滤。
  const toggleOnlyOriginal = useCallback(async () => {
    const next = !onlyOriginal;
    setOnlyOriginal(next);
    if (!next) { setSeriesEps(null); return; }
    // 搜索结果里常混入多部剧(每部各占几条)。取"出现次数最多"的 series_id 作为主导剧,
    // 而不是第一条——这样才能精准锁定用户搜的那部剧, 不会拉错剧/混入无关内容。
    const cnt: Record<string, number> = {};
    for (const v of videos) if (v.series_id) cnt[v.series_id] = (cnt[v.series_id] || 0) + 1;
    const entries = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
    const topSid = entries[0]?.[0];
    // 主导剧至少要有2条命中, 否则说明搜索结果太杂(没有明显主剧), 退回本地过滤更稳
    if (!topSid || (entries[0]?.[1] ?? 0) < 2) { setSeriesEps(null); return; }
    setSeriesLoading(true); setErr("");
    try {
      const r = await fetch(`${API}/series/videos?series_id=${encodeURIComponent(topSid)}`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      setSeriesEps(d.videos || []);
    } catch (e: any) {
      setErr(`拉取整部剧失败: ${e.message}（已退回本地筛选）`);
      setSeriesEps(null);
    } finally {
      setSeriesLoading(false);
    }
  }, [onlyOriginal, videos]);

  const visibleVideos = onlyOriginal
    ? (seriesEps && seriesEps.length
        ? seriesEps
        : videos.filter((v) => (hasAnySeriesId ? !!v.series_id : isLikelyOriginal(v))))
    : videos;

  // 下载到本地（仅抖音有稳定无水印地址）
  const downloadLocal = async (v: VideoItem) => {
    setBusyId(v.aweme_id + ":local"); setErr("");
    try {
      const r = await fetch(`${API}/download-url`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ aweme_id: v.aweme_id }),
      });
      const d = await r.json();
      if (!r.ok || !d.download_url) throw new Error(d.detail || "未取得下载地址");
      const a = document.createElement("a");
      a.href = d.download_url; a.download = d.filename || "video.mp4";
      a.target = "_blank"; a.rel = "noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e: any) {
      setErr(`下载到本地失败: ${e.message}（部分平台无直链，请用原视频页保存）`);
    } finally {
      setBusyId("");
    }
  };

  // 下载+反推：mode=reverse(入资产库) / draft(建草稿)
  const downloadReverse = async (v: VideoItem, mode: "reverse" | "draft") => {
    setBusyId(v.aweme_id + ":" + mode); setErr("");
    try {
      const r = await fetch(`${API}/download`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ aweme_id: v.aweme_id, category: "视频市场下载", mode }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      if (mode === "draft" && d.draft_id) {
        router.push(`/drafts/${d.draft_id}`);
      } else {
        alert(`✅ 已下载入库(资产#${d.asset_id})，正在后台反推，稍后可在短视频资产库查看`);
      }
    } catch (e: any) {
      setErr(`操作失败: ${e.message}`);
    } finally {
      setBusyId("");
    }
  };

  // ---- 热榜 ----
  const [boards, setBoards] = useState<any>(null);
  const [boardsLoading, setBoardsLoading] = useState(false);

  const loadBoards = useCallback(async () => {
    setBoardsLoading(true); setErr("");
    try {
      const r = await fetch(`${API}/boards`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      setBoards(await r.json());
    } catch (e: any) {
      setErr(e.message || "热榜加载失败");
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "boards" && !boards) loadBoards();
  }, [tab, boards, loadBoards]);

  const boardList = (arr: any): { word: string; hot?: number }[] =>
    Array.isArray(arr) ? arr : [];

  const isDouyin = platform === "douyin";

  return (
    <div className="min-h-screen text-ink-primary">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-black/30 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/")} className="rounded-lg p-2 hover:bg-white/10"><ArrowLeft size={18} /></button>
          <TrendingUp size={20} className="text-pink-400" />
          <div className="text-sm font-semibold">短视频市场数据</div>
        </div>
        <UserNav />
      </div>

      {/* Tab */}
      <div className="flex gap-2 px-4 pt-4">
        <button onClick={() => setTab("search")} className={`rounded-lg px-4 py-2 text-sm ${tab === "search" ? "bg-pink-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
          <Search size={14} className="mr-1 inline" />视频检索 / 下载
        </button>
        <button onClick={() => setTab("boards")} className={`rounded-lg px-4 py-2 text-sm ${tab === "boards" ? "bg-pink-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
          <Flame size={14} className="mr-1 inline" />热榜 / 选题
        </button>
      </div>

      {err && <div className="mx-4 mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{err}</div>}

      {/* 搜索 Tab */}
      {tab === "search" && (
        <div className="p-4">
          {/* 平台切换 */}
          <div className="mb-2 flex flex-wrap gap-2">
            {PLATFORMS.map((pf) => (
              <button key={pf.id} onClick={() => { setPlatform(pf.id); setVideos([]); }}
                className={`rounded-lg px-3 py-1.5 text-xs ${platform === pf.id ? "bg-pink-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>
                {pf.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={keyword} onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="搜短剧 / 爆款关键词，如：逆袭 战神 短剧"
              className="min-w-[240px] flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-pink-400"
            />
            {isDouyin && (
              <>
                <select value={sortType} onChange={(e) => setSortType(e.target.value)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm">
                  <option value="0">综合排序</option>
                  <option value="1">最多点赞</option>
                  <option value="2">最新发布</option>
                </select>
                <select value={publishTime} onChange={(e) => setPublishTime(e.target.value)} className="rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm">
                  <option value="0">不限时间</option>
                  <option value="1">最近一天</option>
                  <option value="7">最近一周</option>
                  <option value="180">最近半年</option>
                </select>
              </>
            )}
            <button onClick={doSearch} disabled={loading} className="rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white hover:bg-pink-600 disabled:opacity-50">
              {loading ? <Loader2 size={14} className="inline animate-spin" /> : <Search size={14} className="inline" />} 搜索
            </button>
          </div>

          {/* 只看原片筛选(启发式, 可能不准) */}
          {videos.length > 0 && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <button
                onClick={toggleOnlyOriginal}
                disabled={seriesLoading}
                className={`rounded-full px-3 py-1 font-medium transition-colors disabled:opacity-50 ${
                  onlyOriginal ? "bg-pink-500 text-white" : "bg-white/5 text-white/70 hover:bg-white/10"
                }`}
              >
                {seriesLoading ? <Loader2 size={12} className="inline animate-spin" /> : null}
                {onlyOriginal ? " ✓ 只看原片" : "只看原片"}
              </button>
              <span className="text-white/40">
                {onlyOriginal
                  ? (seriesEps && seriesEps.length
                      ? `已按抖音短剧合集拉取整部剧全部 ${seriesEps.length} 集（正片，不缺集）`
                      : `已过滤番外/切片/混剪，剩 ${visibleVideos.length}/${videos.length} 条`)
                  : "点击按抖音官方短剧合集拉取整部剧正片（自动去除番外/混剪/切片）"}
              </span>
            </div>
          )}

          {/* 9:16 竖版卡片网格 — PC 固定每行6个 */}
          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {visibleVideos.map((v) => (
              <div key={v.aweme_id} className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
                <div className="relative aspect-[9/16] w-full bg-black/40">
                  {v.cover
                    ? <img src={v.cover} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                    : <div className="flex h-full items-center justify-center text-white/30"><Clapperboard size={28} /></div>}
                  {/* 底部统计浮层 */}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
                    <div className="flex items-center gap-2 text-[11px] text-white/90">
                      <span className="flex items-center gap-0.5"><Heart size={11} />{fmtNum(v.statistics?.digg_count)}</span>
                      <span className="flex items-center gap-0.5"><MessageCircle size={11} />{fmtNum(v.statistics?.comment_count)}</span>
                      {v.statistics?.play_count != null && <span className="flex items-center gap-0.5"><Play size={11} />{fmtNum(v.statistics?.play_count)}</span>}
                    </div>
                  </div>
                </div>
                <div className="p-1.5">
                  <div className="line-clamp-2 text-[11px] leading-tight">{v.desc || "(无描述)"}</div>
                  <div className="mt-0.5 truncate text-[10px] text-white/50">@{v.author?.nickname || "未知"}</div>
                  {/* 操作 — 一行3个图标按钮, 省空间 */}
                  <div className="mt-1.5 flex gap-1">
                    <button onClick={() => downloadReverse(v, "draft")} disabled={!!busyId} title="反推成草稿"
                      className="flex-1 rounded bg-pink-500/90 px-1 py-1 text-[10px] font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                      {busyId === v.aweme_id + ":draft" ? <Loader2 size={10} className="inline animate-spin" /> : <><FileText size={10} className="inline" /> 草稿</>}
                    </button>
                    <button onClick={() => downloadReverse(v, "reverse")} disabled={!!busyId} title="下载入资产库并反推"
                      className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-50">
                      {busyId === v.aweme_id + ":reverse" ? <Loader2 size={10} className="inline animate-spin" /> : "入库"}
                    </button>
                    <button onClick={() => downloadLocal(v)} disabled={!!busyId} title="下载到本地"
                      className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-white/80 hover:bg-white/10 disabled:opacity-50">
                      {busyId === v.aweme_id + ":local" ? <Loader2 size={10} className="inline animate-spin" /> : <Download size={10} className="inline" />}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {!loading && videos.length === 0 && (
            <div className="mt-16 text-center text-sm text-white/40">
              <Sparkles size={28} className="mx-auto mb-2 opacity-50" />
              选择平台 + 输入关键词，检索爆款短视频
            </div>
          )}
        </div>
      )}

      {/* 热榜 Tab */}
      {tab === "boards" && (
        <div className="p-4">
          <div className="mb-3">
            <button onClick={loadBoards} disabled={boardsLoading} className="rounded-lg bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10">
              <RefreshCw size={14} className={`inline ${boardsLoading ? "animate-spin" : ""}`} /> 刷新
            </button>
          </div>
          {boardsLoading && <div className="text-center text-white/50"><Loader2 className="mx-auto animate-spin" /></div>}

          {/* 短剧热榜（业务强相关，单独置顶，带封面） */}
          {boards?.series?.length > 0 && (
            <div className="mb-4 rounded-xl border border-pink-500/30 bg-pink-500/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Clapperboard size={15} className="text-pink-400" />短剧热榜</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {boards.series.slice(0, 12).map((s: any, i: number) => (
                  <button key={i} onClick={() => { setPlatform("douyin"); setKeyword(s.word); setTab("search"); setTimeout(doSearch, 100); }}
                    className="flex items-center gap-2 rounded-lg bg-white/5 p-2 text-left hover:bg-white/10">
                    {s.cover && <img src={s.cover} alt="" className="h-14 w-9 shrink-0 rounded object-cover" referrerPolicy="no-referrer" />}
                    <div className="min-w-0">
                      <div className="line-clamp-2 text-xs">{s.word}</div>
                      <div className="text-[10px] text-white/40"><Heart size={9} className="inline" /> {fmtNum(s.hot)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 词条榜 — 紧凑多列, 不再横向全屏浪费空间 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { key: "hot_search", label: "抖音热搜榜", icon: Flame },
              { key: "hot_topic", label: "话题热榜", icon: Hash },
              { key: "rising_topic", label: "飙升话题", icon: TrendingUp },
              { key: "hot_challenge", label: "挑战热榜", icon: Sparkles },
            ].map(({ key, label, icon: Icon }) => {
              const list = boardList(boards?.[key]);
              return (
                <div key={key} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Icon size={15} className="text-pink-400" />{label}</div>
                  <ol className="space-y-0.5">
                    {list.length === 0 && <li className="text-[11px] text-white/40">暂无数据</li>}
                    {list.slice(0, 10).map((it, i) => (
                      <li key={i} className="flex items-center justify-between gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-white/5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`w-4 shrink-0 text-center ${i < 3 ? "text-pink-400 font-bold" : "text-white/40"}`}>{i + 1}</span>
                          <button onClick={() => { setPlatform("douyin"); setKeyword(it.word); setTab("search"); setTimeout(doSearch, 100); }}
                            className="truncate text-left hover:text-pink-300" title={it.word}>{it.word}</button>
                        </span>
                        {it.hot != null && <span className="shrink-0 text-white/40">{fmtNum(it.hot)}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}