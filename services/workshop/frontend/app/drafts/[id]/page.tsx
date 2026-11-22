"use client";
import { UserNav } from "../../_UserNav";
import { ModelSelect } from "@/components/ModelSelect";
import { vendorLabel } from "@/lib/modelCatalog";
import { authFetch, getUser } from "../../../lib/auth";
import { PreviewPanel } from "./_PreviewPanel";
import { CharacterMapper } from "./_CharacterMapper";
import { VideoRetryPanel } from "./_VideoRetryPanel";
import { ProgressBanner } from "./_ProgressBanner";
import { SafetyPanel } from "./_SafetyPanel";
import { AnalysisPanel } from "./_AnalysisPanel";
import { OverviewHub } from "./_OverviewHub";
import { VideoPromptsPanel } from "./_VideoPromptsPanel";
import ImagePanel from "./_ImagePanel";
import { CharactersPanel } from "./_CharactersPanel";
import { CharacterBiblePanel } from "./_CharacterBiblePanel";
import { ExtendModal } from "./_ExtendModal";
import { AdaptModal } from "./_AdaptModal";
import { SpawnModal } from "./_SpawnModal";
// ⛔ 2026-09-18 入口审计：CritiqueRoom（评审精修）已停用 —— 该 import 是死代码，
//    组件从未被渲染（本文件的 critique tab 渲染的是下面的 RewriteRoom）。
//    这与它 prod 仅 2 次调用的事实吻合：前端本来就不可达。
// import { CritiqueRoom } from "./_CritiqueRoom";
// ⛔ 2026-09-18 入口审计：RewriteRoom（整本 AI 精修的独立入口）已停用 ——
//    能力已收归对话工坊的「精修这批」，本文件不再渲染该 tab（见下方 [STOPPED] 段）。
//    后端 /v1/rewrite 必须保留，对话工坊走的就是它。
// import { RewriteRoom } from "./_RewriteRoom";
import { AdaptRoom } from "./_AdaptRoom";
import { ExportMixedModal } from "./_ExportMixedModal";
import { ChapterVersionHistory } from "./_ChapterVersionHistory";
import { FullTextEditor } from "./_FullTextEditor";
import { NarrativeHealth } from "./_NarrativeHealth";
import { interleaveActionDialogue } from "../../../lib/scriptText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Play, FileText, Zap, Rocket, Download, History, Pencil, Save } from "lucide-react";
import { Tabs as KitTabs } from "@/components/ui/Tabs";
import { Spinner as KitSpinner } from "@/components/ui/Spinner";
import { EpisodeTreeNav, StageChain, WorkbenchShell } from "@/components/workbench";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { confirmAsync, notify, notifyError, notifySuccess } from "@/lib/dialog";
import { downloadWithAuth } from "@/lib/download";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

/**
 * 章节字数控制小面板 — Phase 3 重做版,接入 UI Kit (Card / Button / Input / Badge)。
 *
 * 用途: 显示 + 编辑 draft.chapter_word_target,保存后后端会自动把所有未锁定章节标 stale,
 * 此面板只负责把"已影响多少章"提示给用户,并提供一键批量重生入口。
 */
function WordCountSettings({
  draft,
  onUpdated,
  onTriggerBatchChapters,
}: {
  draft: any;
  onUpdated: () => void;
  onTriggerBatchChapters?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<number>(draft?.chapter_word_target || 5000);
  const [saving, setSaving] = useState(false);
  const [postSaveHint, setPostSaveHint] = useState<{
    count: number;
    oldVal: number;
    newVal: number;
  } | null>(null);

  const current = draft?.chapter_word_target || 900;
  const presets = [
    { label: "短篇", v: 3000 },
    { label: "标准", v: 1500 },
    { label: "中长", v: 7000 },
    { label: "长篇", v: 10000 },
  ];

  async function save(newVal: number) {
    if (newVal < 1 || newVal > 20000) {
      notifyError("字数范围: 1 ~ 20000");
      return;
    }
    if (newVal === current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapter_word_target: newVal }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const affected = (draft.chapters || []).filter((c: any) => !c.locked).length;
      setPostSaveHint({ count: affected, oldVal: current, newVal });
      onUpdated();
      setEditing(false);
    } catch (e) {
      notifyError("保存失败: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="md" className="mb-4">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="text-ink-secondary">📏 每章目标字数:</span>
        {!editing ? (
          <>
            <Badge tone="primary" size="md">
              {current.toLocaleString()} 字
            </Badge>
            <span className="text-xs text-ink-muted">
              允许范围 {Math.floor(current * 0.8).toLocaleString()} ~{" "}
              {Math.floor(current * 1.2).toLocaleString()} 字
            </span>
            <span className="text-xs text-ink-muted hidden lg:inline ml-auto">
              ※ 仅影响新生成或重新生成的章节
            </span>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => {
                setVal(current);
                setEditing(true);
              }}
              className={postSaveHint || current ? "" : "ml-auto"}
            >
              修改
            </Button>
          </>
        ) : (
          <>
            <Input
              type="number"
              value={val || ""}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setVal(0);
                  return;
                }
                const n = parseInt(raw);
                if (!Number.isNaN(n)) setVal(n);
              }}
              onBlur={() => {
                if (!val) setVal(current);
              }}
              min={1}
              max={20000}
              step={500}
              size="sm"
              className="w-28"
            />
            <span className="text-xs text-ink-muted">字</span>
            <div className="flex gap-1 flex-wrap">
              {presets.map((p) => (
                <Button
                  key={p.v}
                  variant={val === p.v ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setVal(p.v)}
                >
                  {p.label} {p.v}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex gap-1.5">
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                leftIcon={!saving ? <Save className="h-3.5 w-3.5" /> : undefined}
                onClick={() => save(val)}
              >
                保存
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </>
        )}
      </div>

      {/* 保存后提示横幅 */}
      {postSaveHint && (
        <div className="mt-3 p-3 bg-primary/10 border border-primary/40 rounded-lg flex items-center gap-3 flex-wrap">
          <span className="text-sm text-ink-primary flex-1 min-w-0">
            ✅ 已将每章字数从{" "}
            <b>{postSaveHint.oldVal.toLocaleString()}</b> 改为{" "}
            <b>{postSaveHint.newVal.toLocaleString()}</b>
            {postSaveHint.count > 0 && (
              <>
                ，并把 <b>{postSaveHint.count}</b> 个未锁定章节标为过期
              </>
            )}
          </span>
          {postSaveHint.count > 0 && onTriggerBatchChapters && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Rocket className="h-3.5 w-3.5" />}
              onClick={() => {
                onTriggerBatchChapters();
                setPostSaveHint(null);
              }}
            >
              立即按新字数批量重生
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPostSaveHint(null)}
          >
            知道了
          </Button>
        </div>
      )}
    </Card>
  );
}

type Draft = {
  id: number;
  title: string;
  user_input: string;
  status: string;
  outline?: any;
  outline_locked?: number;
  chapters?: any[];
  storyboards?: any[];
  episode_count?: number;
  model_provider?: string;
  chapter_word_target?: number;
};

export default function DraftDetailPage() {
  if (typeof window !== "undefined" && !getUser()) { window.location.href = "/jubengongfang/login"; return null; }

  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEmbed = searchParams.get("embed") === "1";
  const isBare = searchParams.get("bare") === "1";  // 超级Agent分屏: 彻底隐藏左侧工作台栏
  const id = params.id as string;
  const initialTab = (searchParams.get("tab") as any) || "outline";

  type Tab = "overview" | "preview" | "outline" | "chapters" | "storyboards" | "novel" | "tweet" | "analysis" | "prompts" | "images" | "characters" | "safety" | "export" | "extend" | "adapt" | "critique";

  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>(initialTab as any);
  const [generating, setGenerating] = useState(false);
  const [generatingOrder, setGeneratingOrder] = useState<number | null>(null);
  const [expandedChapter, setExpandedChapter] = useState<number | null>(null);
  const [editText, setEditText] = useState<string>("");
  const [feedbackText, setFeedbackText] = useState<string>("");
  const [feedbackLoading, setFeedbackLoading] = useState<number | null>(null); // 哪个chapter正在feedback重写
  const [batchGenerating, setBatchGenerating] = useState<'chapters' | 'storyboards' | null>(null);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [directGenerating, setDirectGenerating] = useState(false);
  const [directStage, setDirectStage] = useState<'outline' | 'chapters' | 'storyboards' | null>(null);
  const [expandedInput, setExpandedInput] = useState(false);
  const [generationLogs, setGenerationLogs] = useState<any[]>([]);
  const [showLogs, setShowLogs] = useState(true);
  /**
   * 日志抽屉是否打开。默认关（用户"几乎不看日志"），
   * 但见下面的 effect：**出现 error 级日志时会自动打开**。
   */
  const [logOpen, setLogOpen] = useState(false);
  /** 已经因报错自动弹出过的日志 id —— 避免用户手动关掉后又被同一条错误弹开 */
  const autoOpenedLogRef = useRef<Set<number>>(new Set());
  /**
   * 这份草稿上**有未读**的产物流（PLAN §4.2）。
   * 进对应 tab 时会把它从列表里去掉并上报后端，红点随即消失。
   */
  const [unreadStreams, setUnreadStreams] = useState<string[]>([]);
  const [editingEpisode, setEditingEpisode] = useState<number | null>(null);
  const [lintReport, setLintReport] = useState<any>(null);   // P6: 大纲一致性校验报告
  const [linting, setLinting] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<Set<string>>(new Set()); // 勾选待 AI 修复的 issue id
  const [fixing, setFixing] = useState(false);
  const [epEditTitle, setEpEditTitle] = useState("");
  const [epEditSynopsis, setEpEditSynopsis] = useState("");
  const [extendOpen, setExtendOpen] = useState(false);
  const [adaptOpen, setAdaptOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [exportMixedOpen, setExportMixedOpen] = useState(false);
  // 剧本视图: 分镜(逐条) / 全文(整集文本框, 类Word) — 整页统一, 记忆到 localStorage (需求1)
  const [scriptView, setScriptView] = useState<'shots' | 'fulltext'>('shots');
  useEffect(() => {
    try {
      const v = localStorage.getItem('drama_script_view_mode');
      if (v === 'fulltext' || v === 'shots') setScriptView(v);
    } catch { /* noop */ }
  }, []);

  /**
   * 出现**新的** error 级日志时自动打开日志抽屉。
   *
   * 设计意图（PLAN §4.5.7）：用户几乎不看日志，所以默认收起；
   * 但没人能忽略报错，所以报错必须自己跳出来。
   *
   * ⚠ autoOpenedLogRef 记录"已经为哪条日志弹过"。没有它会出两个问题：
   *   1. 用户手动关掉抽屉后，下一次 setGenerationLogs（轮询会持续更新）
   *      又把它弹开 —— 变成关不掉的骚扰
   *   2. 页面停留期间同一条错误反复弹
   * 记 id 而不是记布尔值，才能做到"新错误才弹、旧错误不重复弹"。
   */
  useEffect(() => {
    const errs = generationLogs.filter((l: any) => l.log_type === 'error' && l.id != null);
    const fresh = errs.filter((l: any) => !autoOpenedLogRef.current.has(l.id));
    if (fresh.length === 0) return;
    for (const l of fresh) autoOpenedLogRef.current.add(l.id);
    // embed（对话工坊内嵌）模式下不弹 —— 那里没有抽屉，弹了会挡住正文
    if (!isEmbed && !isBare) setLogOpen(true);
  }, [generationLogs, isEmbed, isBare]);
  function switchScriptView(v: 'shots' | 'fulltext') {
    setScriptView(v);
    try { localStorage.setItem('drama_script_view_mode', v); } catch { /* noop */ }
  }

  // Sidebar 把"导出"/"续写"也作为 tab 选项暴露, 但它们其实是 modal.
  // 当 tab 切到 export/extend 时, 自动打开对应 modal 并切回业务相关页 (storyboards/chapters),
  // 主区不会因为找不到匹配分支而留白.
  useEffect(() => {
    if (tab === "export") {
      setExportMixedOpen(true);
      setTab("storyboards");
    } else if (tab === "extend") {
      setExtendOpen(true);
      setTab("chapters");
    } else if (tab === "adapt") {
      // "改编"入口已升级为 DNA 裂变工厂: 提取原作爆款DNA→批量裂变出N个各具新意的新作
      setSpawnOpen(true);
      setTab("chapters");
    } else if (tab === "analysis" || tab === "safety" || tab === "characters") {
      // v2: 分析/安全/角色 已合并进"总览"页, 旧深链重定向到总览对应锚点
      const anchor = tab === "characters" ? "characters" : tab;
      setTab("overview");
      if (typeof window !== "undefined") {
        try { history.replaceState(null, "", `#${anchor}`); } catch { /* noop */ }
      }
    }
  }, [tab]);
  const [overview, setOverview] = useState<any>(null);
  /** 章节版本历史 Modal: 当前打开的章节 order, null = 关闭 */
  const [historyForOrder, setHistoryForOrder] = useState<number | null>(null);
  /** 剧本版本历史 Modal: 当前打开的集 order, null = 关闭 */
  const [sbHistoryForOrder, setSbHistoryForOrder] = useState<number | null>(null);

  useEffect(() => {
    fetchDraft();
    fetchLogs();
    fetchOverview();
    void fetchUnread();
    // 每5秒轮询日志和草稿状态
    const interval = setInterval(() => {
      fetchLogs();
      if (draft?.status?.includes("running") || generating) {
        fetchDraft();
        fetchOverview();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [id, draft?.status, generating]);

  async function fetchOverview() {
    try {
      const r = await authFetch(`${BASE}/v1/drafts/${id}/overview`);
      if (r.ok) {
        const data = await r.json();
        setOverview(data);
      }
    } catch (e) { /* silent */ }
  }

  // ⚠️ 必须是 useRef: 写成 `{ current: 0 }` 字面量的话每次 render 都会重置为 0,
  // since_id 永远发不出去, 于是每 5 秒把最近 200 条日志全量重拉一遍
  // (实测单次 ~99 KB, generation_logs 已 31 万行)。这既拖慢页面, 也挤占
  // 纯 HTTP/1.1 下本就只有 6 个的并发连接, 让草稿/卡片请求排在后面。
  const lastLogIdRef = useRef(0);
  async function fetchLogs() {
    try {
      const sinceParam = lastLogIdRef.current > 0 ? `&since_id=${lastLogIdRef.current}` : '';
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/logs?limit=200${sinceParam}`);
      if (res.ok) {
        const data = await res.json();
        const newLogs = data.logs || [];
        if (newLogs.length > 0) {
          if (lastLogIdRef.current === 0) {
            setGenerationLogs(newLogs);
          } else {
            setGenerationLogs(prev => [...prev, ...newLogs]);
          }
          const maxId = Math.max(...newLogs.map((l: any) => l.id));
          lastLogIdRef.current = maxId;
        }
      }
    } catch (e) { /* silent */ }
  }

  async function switchModel(provider: string) {
    // 值形如 "gemini" 或 "gemini:gemini-3.8-flash"。原先这里按三选一硬判文案,
    // 带型号的新值会全部落到 else 分支 → 选了 GPT 却提示"跨世界观模型"。
    const [vendor, model] = provider.split(':');
    // ⚠️ 厂商名必须走 vendorLabel（清单驱动），不能再写三元表达式：
    // 旧写法兜底分支把**所有未知厂商都当 Gemini**，新增第三方分组后
    // 会弹出"切换到 Gemini"而实际切的是 Kimi —— 提示与操作相反。
    const vendorName = vendorLabel(vendor);
    const ok = await confirmAsync({
      title: "切换模型",
      description: `切换到 ${vendorLabel}${model ? ` · ${model}` : ' 默认型号'}？后续新生成内容将使用该模型。`,
      confirmText: "切换",
      tone: "warning",
    });
    if (!ok) return;
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_provider: provider }),
      });
      await fetchDraft();
    } catch (e) { alert('切换失败'); }
  }

  async function fetchDraft() {
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}`);
      if (res.ok) {
        const data = await res.json();
        setDraft(data);
        return data;
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  /** 拉这份草稿的未读产物流（PLAN §4.2）。失败静默 —— 红点缺一个不影响干活。 */
  const fetchUnread = useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/v1/drafts/unread?draft_ids=${id}`);
      if (!r.ok) return;
      const d = await r.json();
      setUnreadStreams(Object.keys(d?.items?.[String(id)] || {}));
    } catch {
      /* noop */
    }
  }, [id]);

  /**
   * 进某个 tab 即视为"看过这一流"：本地立刻消红点 + 上报后端。
   *
   * ⚠ tab → stream 不是一一对应：'novel'/'tweet' 是改编产物，
   *    而 'extend'/'export'/'critique' 是动作不是产物流，不参与。
   *
   * 为什么"进入即已读"而不是"滚到底才已读"：写手习惯反复上下滚动，
   * 要求滚到底会出现"明明看了却没消"的困惑。
   */
  useEffect(() => {
    const tabToStream: Record<string, string> = {
      outline: 'outline',
      chapters: 'chapters',
      storyboards: 'storyboards',
      novel: 'novel',
      tweet: 'tweet',
    };
    const stream = tabToStream[tab];
    if (!stream || !unreadStreams.includes(stream)) return;

    setUnreadStreams((prev) => prev.filter((s) => s !== stream));   // 本地立刻消
    void authFetch(`${BASE}/v1/drafts/${id}/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream }),
    }).catch(() => { /* 上报失败不打扰：下次进入还会再试 */ });
  }, [tab, id, unreadStreams]);

  // 对话工坊「一键替换」写入后会 postMessage 过来, 这里只重新拉数据。
  // ⚠ 刻意不重载整页(父页早期用 iframe key 强制重挂, 会把用户踢回初始 tab 和
  // 滚动位置)。当前 tab / 展开的章节 / 滚动位置全部保持不动。
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;      // 只信同源
      if (e.data?.type !== "drama:draft-updated") return;
      void fetchDraft();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function generateOutline() {
    setGenerating(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/outline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapter_count: draft?.episode_count || 3 }),
      });
      if (res.ok) {
        await fetchDraft();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setGenerating(false);
    }
  }

  async function toggleOutlineLock() {
    const locked = draft?.outline_locked ? 0 : 1;
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/outline/lock?locked=${locked}`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchDraft();
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function generateChapter(order: number) {
    setGeneratingOrder(order);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/chapters/${order}`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchDraft();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setGeneratingOrder(null);
    }
  }

  // collapseAfter: 保存后是否收起编辑卡片(用户点"保存修改"=编辑完毕, 应收起; 但"基于编辑重新生成"内部调用时不收起)
  async function saveChapterEdit(order: number, collapseAfter = false) {
    const savedText = editText; // 快照当前编辑内容, 避免异步过程中被其它逻辑改动
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${id}/chapters/${order}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_text: savedText }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as any));
        throw new Error(err.detail || `HTTP ${r.status}`);
      }
      // 乐观更新: 立即把本地 draft 里该章的 full_text 改成刚保存的内容,
      // 保证收起卡片后预览区(读 existing.full_text)立刻显示最新文本, 不依赖 fetchDraft 的时序/闭包。
      setDraft((prev) => {
        if (!prev) return prev;
        const chapters = (prev.chapters || []).map((c: any) =>
          c.chapter_order === order ? { ...c, full_text: savedText, word_count: savedText.length } : c
        );
        return { ...prev, chapters };
      });
      await fetchLogs();
      // 后端会自动把"修改前"内容写入 script_episode_history (router.patch_chapter),
      // 用户可点击章节上的"📜 历史版本"按钮恢复任意旧版本
      notifySuccess("已保存,旧版本已自动归档");
      if (collapseAfter) setExpandedChapter(null); // 点"保存修改"=编辑完毕, 收起卡片
      // 后台再拉一次权威数据(不阻塞 UI, 乐观值已先显示)
      fetchDraft();
    } catch (e) {
      notifyError("保存失败: " + (e as Error).message);
    }
  }

  async function regenerateChapter(order: number, basedOnEdit: boolean) {
    if (basedOnEdit) {
      // 先保存编辑内容,再重新生成(基于编辑后的版本)
      await saveChapterEdit(order);
    }
    setGeneratingOrder(order);
    try {
      // 先删除现有章节再重新生成
      await authFetch(`${BASE}/v1/stages/drafts/${id}/chapters/${order}`, { method: "DELETE" });
      await authFetch(`${BASE}/v1/stages/drafts/${id}/chapters/${order}`, { method: "POST" });
      await fetchDraft();
    } catch (e) { console.error(e); }
    finally { setGeneratingOrder(null); }
  }

  /**
   * 导出下载。原先这几个入口是 `<a href target="_blank">` 直链, 但 token 存在
   * localStorage、不是 cookie —— 浏览器自己发起的导航**带不上 Authorization**,
   * 端点加鉴权后会变成新开一个标签页显示 `{"detail":"..."}`。
   * 改走 authFetch 取 blob 再触发下载, 顺带能把错误弹成 toast。
   */
  async function exportFile(path: string, fallbackName: string) {
    try {
      await downloadWithAuth(`${BASE}/v1/stages/drafts/${id}${path}`, fallbackName);
    } catch (e) {
      notifyError((e as Error).message || "导出失败");
    }
  }

  async function regenerateWithFeedback(order: number, stage: "chapters" | "storyboards" | "outline" | "preview") {
    if (!feedbackText.trim()) { alert("请输入修改意见"); return; }
    setFeedbackLoading(order);
    try {
      const url = stage === "outline"
        ? `${BASE}/v1/stages/drafts/${id}/outline/episodes/${order}/regenerate-with-feedback`
        : stage === "chapters"
        ? `${BASE}/v1/stages/drafts/${id}/chapters/${order}/regenerate-with-feedback`
        : `${BASE}/v1/stages/drafts/${id}/storyboards/${order}/regenerate-with-feedback`;
      // ⚠ 这里原本是裸 fetch(没有 Authorization) —— 同组件上下几十行的兄弟函数
      // 全是 authFetch, 只有这一处漏了。后端给三个 regenerate-with-feedback 端点
      // 补鉴权后, 漏带 token 会直接 401。
      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedbackText }),
      });
      if (res.ok) {
        const result = await fetchDraft();
        await fetchLogs();
        setFeedbackText("");
        // 如果当前正在编辑的章节被重写,更新editText
        if (stage === "chapters" && expandedChapter === order) {
          const updatedDraft = result || draft;
          const updatedCh = updatedDraft?.chapters?.find((c: any) => c.chapter_order === order);
          if (updatedCh) setEditText(updatedCh.full_text || "");
        }
        // 大纲重写: 把重写后的标题/概要同步进编辑框(否则编辑框仍显示旧内容)
        if (stage === "outline" && editingEpisode === order) {
          const updatedDraft = result || draft;
          const updatedEp = updatedDraft?.outline?.chapters?.find((c: any) => c.order === order);
          if (updatedEp) {
            setEpEditTitle(updatedEp.title || "");
            setEpEditSynopsis(updatedEp.synopsis || "");
          }
        }
      } else {
        const err = await res.json().catch(() => ({}));
        alert("重写失败: " + (err.detail || res.status));
      }
    } catch (e) { alert("请求失败: " + e); }
    finally { setFeedbackLoading(null); }
  }

  async function generateStoryboard(order: number) {
    setGenerating(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/storyboards/${order}`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchDraft();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setGenerating(false);
    }
  }


  async function startBatchGenerate(type: 'chapters' | 'storyboards', forceRegenerate: boolean = false) {
    // 改为后台任务模式:进度条由 ProgressBanner 从 /progress 接口轮询获得,
    // 即使刷新页面或关闭浏览器也能继续看到进度,且不会重复触发(后端 409 保护)
    // forceRegenerate=true 时, 后端会先把所有集标 stale, 再走批量重生。
    // ⚠️ 2026-10-06 修正: 以前只标"未锁定"的集, 而 locked 是用户无从操作的字段
    // (导入剧本时后端自动打标、前端没有解锁入口) —— 对导入的草稿点强制重写
    // 会"已标记 0 个"然后逐集跳过, 一集不写。现在 force 会穿透锁定。
    if (forceRegenerate) {
      const noun = type === 'chapters' ? '所有章节' : '所有剧本';
      const ok = await confirmAsync({
        title: `强制重写全部：${noun}`,
        description: `这会按当前每章字数 ${draft?.chapter_word_target || 900} 字覆盖现有内容（含导入时自动标记为"已锁定"的章节）。操作不可撤销，但每集保留历史版本可回滚。`,
        confirmText: "强制重写全部",
        tone: "danger",
      });
      if (!ok) return;
    }
    const url = type === 'chapters'
      ? `${BASE}/v1/stages/drafts/${id}/chapters/batch/start${forceRegenerate ? '?force_regenerate=true' : ''}`
      : `${BASE}/v1/stages/drafts/${id}/storyboards/batch/start${forceRegenerate ? '?force_regenerate=true' : ''}`;
    try {
      const res = await authFetch(url, { method: "POST" });
      if (!res.ok) {
        const txt = await res.text();
        // 409 = 已有任务在跑
        if (res.status === 409) {
          alert("已有生成任务在运行,请等待当前任务完成");
        } else {
          alert(`启动失败 (${res.status}): ${txt.slice(0, 300)}`);
        }
        return;
      }
      // 立即拉一次草稿,顺手刷新章节/剧本区
      await fetchDraft();
    } catch (e) {
      alert("启动失败: " + (e as Error).message);
    }
  }


  // P6: 触发大纲一致性校验(硬伤检测), 只标注不自动改
  async function runLint() {
    setLinting(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/lint`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setLintReport(data.lint_report || null);
        const s = data.lint_report?.summary || { error: 0, warn: 0 };
        const msg = `校验完成: ${s.error} 个硬伤, ${s.warn} 个提醒`;
        if (s.error > 0) notifyError(msg); else notifySuccess(msg);
      } else {
        notifyError("校验失败");
      }
    } catch (e) {
      notifyError("校验失败: " + (e as Error).message);
    } finally {
      setLinting(false);
    }
  }

  // AI 修改硬伤: 全局视野(把全剧大纲发给AI)+允许跨集修改。
  // fixAll=false: 精修勾选项(勾选必修、其余作参考); fixAll=true: 全量修复所有检测到的问题。
  async function fixSelectedIssues(fixAll = false) {
    const ids = Array.from(selectedIssues);
    if (!fixAll && ids.length === 0) { notifyError("请先勾选要修改的问题"); return; }
    setFixing(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/lint/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_ids: ids, fix_all: fixAll }),
      });
      if (res.ok) {
        const data = await res.json();
        setLintReport(data.lint_report || null);
        setSelectedIssues(new Set());
        await fetchDraft();  // 大纲已被 AI 修改, 刷新展示
        await fetchLogs();
        const fixed = (data.fixed_orders || []).join("、");
        notifySuccess(`AI 已修改第 ${fixed || "?"} 集, 并重新校验`);
      } else {
        const err = await res.json().catch(() => ({} as any));
        notifyError("AI 修改失败: " + (err.detail || `HTTP ${res.status}`));
      }
    } catch (e) {
      notifyError("AI 修改失败: " + (e as Error).message);
    } finally {
      setFixing(false);
    }
  }

  function toggleIssue(issueId: string) {
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId); else next.add(issueId);
      return next;
    });
  }

  async function saveEpisodeEdit(order: number) {
    const savedTitle = epEditTitle, savedSynopsis = epEditSynopsis;
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/outline/episodes/${order}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: savedTitle, synopsis: savedSynopsis }),
      });
      if (res.ok) {
        // 乐观更新: 立即把本地 draft.outline 里该集的标题/概要改成刚保存的值, 收起后立刻显示最新。
        // 注意: 不能再调 fetchDraft() 覆盖——大纲存在 JSON 字段里, 后端刷新可能带回旧值把乐观值冲掉,
        // 表现为"点保存后又回到编辑前"。乐观值即为用户刚提交且已 200 保存成功的内容, 直接采信。
        setDraft((prev) => {
          if (!prev?.outline) return prev;
          const chapters = (prev.outline.chapters || []).map((c: any) =>
            c.order === order ? { ...c, title: savedTitle, synopsis: savedSynopsis } : c
          );
          return { ...prev, outline: { ...prev.outline, chapters } };
        });
        setEditingEpisode(null); // 点"保存"=编辑完毕, 收起编辑卡片
        notifySuccess(`第${order}集大纲已保存`);
      } else {
        const err = await res.json().catch(() => ({} as any));
        notifyError('保存失败: ' + (err.detail || `HTTP ${res.status}`));
      }
    } catch (e) { notifyError('保存失败: ' + (e as Error).message); }
  }

  async function regenerateEpisodeSolo(order: number) {
    const ok = await confirmAsync({
      title: `重新生成第 ${order} 集`,
      description: "现有该集大纲会被替换。",
      confirmText: "重新生成",
      tone: "warning",
    });
    if (!ok) return;
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/outline/episodes/${order}/regenerate-solo`, {
        method: "POST",
      });
      if (res.ok) {
        await fetchDraft();
        await fetchLogs();
        setEditingEpisode(null); // 收起编辑态, 让新大纲直接展示
        notifySuccess('第' + order + '集大纲已重新生成');
      } else {
        const err = await res.json().catch(() => ({} as any));
        notifyError('重新生成失败: ' + (err.detail || `HTTP ${res.status}`));
      }
    } catch (e) { notifyError('失败: ' + (e as Error).message); }
  }

  async function regenerateEpisodeFrom(order: number) {
    const total = draft?.outline?.chapters?.length || 0;
    const ok = await confirmAsync({
      title: `重新生成第 ${order}-${total} 集`,
      description: `共 ${total - order + 1} 集，将在后台运行，期间可以继续编辑其他内容。`,
      confirmText: "开始生成",
      tone: "warning",
    });
    if (!ok) return;
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/outline/regenerate-range`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_order: order, end_order: total }),
      });
      if (res.ok) {
        await fetchDraft();
        alert(`已启动,正在生成${total-order+1}集...`);
      } else { alert('启动失败'); }
    } catch (e) { alert('失败: ' + (e as Error).message); }
  }

  async function startDirectGenerate() {
    if (draft?.status?.includes("generating")) {
      alert("任务已在运行,请等待完成");
      return;
    }
    setDirectGenerating(true);
    setDirectStage('outline');
    setBatchLogs(['🚀 启动后台任务...']);
    setBatchProgress({ current: 0, total: 0 });
    
    // 启动后台任务
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${id}/direct-storyboards/start`, {
        method: 'POST'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('启动失败: ' + (err.detail || res.statusText));
        setDirectGenerating(false);
        return;
      }
      setBatchLogs(prev => [...prev, '✅ 任务已在后台启动,即使关闭页面也会继续运行']);
      await fetchDraft();
    } catch (e) {
      alert('启动失败: ' + (e as Error).message);
      setDirectGenerating(false);
      return;
    }
    
    // 直接生成剧本改用轮询 draft.status 感知进度, 不再走 SSE。
    // (原先这里挂着一段 new EventSource(.../direct-storyboards) 的死代码, 上面
    //  一行 return 就已经短路; 它带不上 Authorization 头, 端点补鉴权后必 401,
    //  留着只会误导, 故删除。要恢复 SSE 请改用 authFetch + res.body.getReader()。)
  }


  // ⚠️ 这两个 useMemo 必须在**所有提前 return 之前**。
  // 放在 `if (loading)` / `if (!draft)` 之后会变成"有时调用、有时不调用"：
  // 首帧 loading=true 时提前 return（hook 没跑），次帧 loading=false 才跑到这里 →
  // React 抛 "Rendered more hooks than during the previous render"，**整页白屏**。
  // 这正是"点任意草稿都报错"的成因，实测复现过（playwright 抓到 pageerror）。
  // 规则：本组件里任何一个 hook 都不许出现在提前 return 之下。
  /**
   * 二级导航上的未读红点。tab key → 小红点。
   *
   * 映射：大纲→outline、原文→chapters、剧本→storyboards、
   *      小说/推文→novel/tweet（改编产物按 kind 分）
   *
   * 样式刻意做成 6px 的小圆点而不是数字 —— 用户无法处理"3 条未读"，
   * 他能做的就是"去看一眼"。见 db/read_state.py 对存在性标记的说明。
   */
  const unreadBadges = useMemo(() => {
    const map: Record<string, React.ReactNode> = {};
    const dot = (
      <span className="w-1.5 h-1.5 rounded-full bg-danger inline-block" />
    );
    for (const st of unreadStreams) {
      const tabKey =
        st === 'outline' ? 'outline'
          : st === 'chapters' ? 'chapters'
            : st === 'storyboards' ? 'storyboards'
              : st === 'novel' ? 'novel'
                : st === 'tweet' ? 'tweet'
                  : null;
      if (tabKey) map[tabKey] = dot;
    }
    return map;
  }, [unreadStreams]);

  /**
   * 树图导航（B10）：把大纲 + 正文的现状汇总成「幕 → 集」两级。
   *
   * 数据全部来自已经拉到的 `draft`，**不新开接口** —— 每 5 秒已有一次轮询，
   * 再为导航单独加一个请求是白费的往返（overview_routes.py 顶部那段注释
   * 讲的正是这个坑）。
   *
   * 集数取自大纲（`outline.chapters`）：它比 `chapters` 全 ——
   * 正文只装了**已生成**的集，一部还没开始写的剧 chapters 为空，
   * 而那时用户恰恰最需要从导航看到"一共有多少集、我要写哪一集"。
   */
  const treeEpisodes = useMemo(() => {
    const outlineEps = draft?.outline?.chapters || [];
    if (outlineEps.length === 0) return [];
    const chByOrder = new Map<number, any>();
    for (const c of draft?.chapters || []) chByOrder.set(c.chapter_order, c);
    return outlineEps.map((ep: any, i: number) => {
      const order = ep.order ?? i + 1;
      const ch = chByOrder.get(order);
      return {
        order,
        title: ep.title || ch?.title || '',
        hasOutline: true,                    // 能出现在这个列表里就说明大纲有它
        hasChapter: !!ch,
        isStale: ch?.is_stale === 1,
        locked: !!ch?.locked,
      };
    });
  }, [draft?.outline?.chapters, draft?.chapters]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <KitSpinner size="lg" className="text-primary" />
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center text-ink-primary">
        <div className="text-center">
          <p className="text-xl mb-4">草稿不存在</p>
          <button
            onClick={() => router.push("/drafts")}
            className="px-6 py-2 bg-primary hover:bg-primary/80 rounded-lg transition"
          >
            返回列表
          </button>
        </div>
      </div>
    );
  }

  /**
   * 日志里的错误统计 —— 手柄上的红点与抽屉里的"N 条错误"都看它。
   * 只统计 error 级（log_type === 'error'），其余类型不算错。
   */
  const logErrorCount = generationLogs.filter((l: any) => l.log_type === 'error').length;
  const logHasError = logErrorCount > 0;


  /**
   * 树图点某一集 → 切到能"看到这一集"的 tab，并滚到它的锚点。
   *
   * 去哪里由**数据现状**决定而不是固定的：
   *   · 有正文 → 「原文」tab（用户想看的多半是正文）
   *   · 只有纲要 → 「大纲」tab（正文还没生成，去原文只会看到空）
   *
   * 滚动用 `requestAnimationFrame` 延后一帧：切 tab 是 React 状态更新，
   * 同步去查 DOM 时新 tab 的节点还没挂上，`querySelector` 会返回 null ——
   * 表现是"点了没反应"，而它其实只是"跑得太早"。
   */
  function pickEpisodeFromTree(order: number) {
    const target = treeEpisodes.find((e: { order: number }) => e.order === order);
    setTab(target?.hasChapter ? 'chapters' : 'outline');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-episode-anchor="${order}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  return (
    <WorkbenchShell
      tab={tab as any}
      onTabChange={(v) => setTab(v as any)}
      draftTitle={draft.title}
      draftId={id}
      tree={
        treeEpisodes.length > 0 ? (
          <EpisodeTreeNav
            episodes={treeEpisodes}
            onPick={pickEpisodeFromTree}
            collapsed={isEmbed}
          />
        ) : null
      }
      embed={isEmbed}
      bare={isBare}
      /* 未读红点（PLAN §4.2）：挂在二级导航对应项上，用户不用逐个 tab 点开
         找"哪里是新的"。数据来自 /v1/drafts/{id}/seen 的姊妹接口。 */
      badges={unreadBadges}
      topRight={
        <>
          <ModelSelect
            value={draft.model_provider || "gemini"}
            onChange={switchModel}
            label={null}
            showHint={false}
            compact
            /* onChange 会弹确认框 + PATCH 草稿, 绝不能在清单到手时自动触发 */
            alignOnLoad={false}
            className="px-2 py-1 text-xs bg-surface-base border border-line-strong rounded max-w-[14rem]"
          />
          <span className="text-xs text-ink-secondary">状态: {draft.status}</span>
          <UserNav />
        </>
      }
    >
      <div className="max-w-full">
        <div className="flex items-center gap-4 mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{draft.title}</h1>
              {draft.outline?.adaptation?.is_adaptation && (
                <a
                  href={draft.outline.adaptation.source_draft_id ? `/drafts/${draft.outline.adaptation.source_draft_id}` : undefined}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 bg-primary/15 border border-primary/40 rounded-full text-primary hover:bg-primary/25 transition"
                  title={draft.outline.adaptation.source_draft_id ? `改编自草稿 #${draft.outline.adaptation.source_draft_id}, 点击查看原作` : "改编作品"}
                >
                  🎭 改编作品{draft.outline.adaptation.source_draft_id ? ` · 源自 #${draft.outline.adaptation.source_draft_id}` : ""}
                </a>
              )}
              {draft.status?.includes("running") && (
                <span className="flex items-center gap-1.5 text-sm px-3 py-1 bg-info/15 border border-info/40 rounded-full text-info animate-pulse">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  AI生成中...
                </span>
              )}
            </div>
            {draft.user_input && draft.user_input.length > 0 && (
              <div className="mt-1">
                <p className={`text-ink-secondary text-sm whitespace-pre-wrap ${expandedInput ? 'max-h-96 overflow-auto' : 'line-clamp-2'}`}>
                  {draft.user_input}
                </p>
                {draft.user_input.length > 120 && (
                  <button
                    onClick={() => setExpandedInput(!expandedInput)}
                    className="text-xs text-primary hover:text-primary mt-1"
                  >
                    {expandedInput ? '▲ 收起' : `▼ 展开全文 (共${draft.user_input.length}字)`}
                  </button>
                )}
              </div>
            )}
          </div>
          {!draft.outline || Object.keys(draft.outline || {}).length === 0 ? (
            <button
              onClick={startDirectGenerate}
              disabled={directGenerating || draft.status?.includes("running") || draft.status?.includes("generating")}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-primary to-cyan hover:opacity-90 disabled:opacity-50 rounded-lg transition text-sm font-semibold text-white"
              title="跳过大纲/章节展示,直接生成剧本(后台仍按顺序生成)"
            >
              {directGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {directGenerating ? '生成中...' : '⚡ 直接生成剧本'}
            </button>
          ) : null}
        </div>

        {/* 阶段链（PLAN §4.2 / 效果图 106）—— 取代原来的纯展示 KPI 条。
            区别：KPI 条回答"现在有多少"，阶段链回答"**我下一步该做什么**"，
            后者才是工作台默认视图该回答的问题。
            ⚠ 三个阶段永远可点，未完成的只用红点提示，**不置灰、不锁动作**。 */}
        {overview?.kpis && (
          <div className="mb-6">
            <StageChain
              onNavigate={(t) => setTab(t as any)}
              stages={[
                {
                  key: 'outline',
                  label: '大纲',
                  /* 大纲阶段看的是"分集大纲出了几集"（draft.outline.chapters），
                     不是章节正文的 KPI —— 后者是下一段的事。 */
                  done: draft.outline?.chapters?.length ?? 0,
                  total: draft.outline?.chapters?.length ?? 0,
                  tab: 'outline',
                },
                {
                  key: 'chapters',
                  label: '原文',
                  done: overview.kpis.chapters?.done ?? 0,
                  total: overview.kpis.chapters?.total ?? 0,
                  stale: overview.kpis.chapters?.stale ?? 0,
                  tab: 'chapters',
                },
                {
                  key: 'storyboards',
                  label: '剧本',
                  done: overview.kpis.storyboards?.done ?? 0,
                  total: overview.kpis.storyboards?.total ?? 0,
                  stale: overview.kpis.storyboards?.stale ?? 0,
                  tab: 'storyboards',
                },
              ]}
            />
          </div>
        )}

        {/* AI 建议横幅 — 来自后端启发式 todos */}
        {overview?.todos && overview.todos.length > 0 && (
          <div className="mb-6 space-y-2">
            {overview.todos.slice(0, 2).map((t: any) => {
              const colorMap: Record<string, string> = {
                info: "border-info/40 bg-info/10 text-info",
                warning: "border-warning/40 bg-warning/10 text-warning",
                success: "border-success/40 bg-success/10 text-success",
              };
              return (
                <div
                  key={t.id}
                  className={`flex items-center justify-between gap-3 p-3 rounded-lg border ${colorMap[t.level] || colorMap.info}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">{t.title}</div>
                    <div className="text-xs text-ink-secondary mt-0.5">{t.description}</div>
                  </div>
                  {t.target_tab && (
                    <button
                      onClick={() => setTab(t.target_tab as any)}
                      className="px-3 py-1.5 text-xs rounded bg-surface-raised hover:bg-surface-overlay border border-border-default text-ink-primary whitespace-nowrap"
                    >
                      {t.action || "前往"} →
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {directGenerating && (
          <div className="mb-6 p-6 bg-surface-base/50 backdrop-blur rounded-xl border border-primary/30">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-6 h-6 animate-spin text-warning" />
              <h3 className="text-lg font-semibold">直接生成剧本中...</h3>
              {batchProgress.total > 0 && (
                <span className="ml-auto text-sm text-warning">{batchProgress.current}/{batchProgress.total}</span>
              )}
            </div>
            <div className="flex items-center gap-2 mb-4">
              <div className={`px-3 py-1 rounded text-sm ${directStage === 'outline' ? 'bg-primary text-white' : 'bg-surface-overlay text-ink-secondary'}`}>1. 大纲</div>
              <div className="flex-1 h-0.5 bg-surface-overlay" />
              <div className={`px-3 py-1 rounded text-sm ${directStage === 'chapters' ? 'bg-primary text-white' : 'bg-surface-overlay text-ink-secondary'}`}>2. 章节</div>
              <div className="flex-1 h-0.5 bg-surface-overlay" />
              <div className={`px-3 py-1 rounded text-sm ${directStage === 'storyboards' ? 'bg-primary text-white' : 'bg-surface-overlay text-ink-secondary'}`}>3. 剧本</div>
            </div>
            {batchProgress.total > 0 && (
              <div className="w-full bg-surface-overlay rounded-full h-2 mb-3">
                <div className="bg-gradient-to-r from-primary to-cyan h-2 rounded-full transition-all" style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }} />
              </div>
            )}
            <div className="max-h-60 overflow-y-auto space-y-1 bg-surface-overlay/50 p-3 rounded">
              {batchLogs.map((log, idx) => (
                <div key={idx} className="text-xs text-ink-primary font-mono">{log}</div>
              ))}
            </div>
          </div>
        )}




        <div className="flex gap-6">
          {/* 左侧:主内容区 */}
          <div className="flex-1 min-w-0">

        {tab === "overview" && (
          <div className="space-y-4">
            <ProgressBanner draftId={Number(id)} onTick={() => { fetchDraft(); }} />
            {/* v2: 总览中心 = 设定圣经 + 剧情分析 + 角色关系 + 安全风险 (折叠分区) */}
            <OverviewHub draftId={Number(id)} draftTitle={draft.title} />
            <div className="flex gap-2 flex-wrap">
              <Button variant="primary" size="md" onClick={() => setTab("outline")}>进入大纲</Button>
              <Button variant="secondary" size="md" onClick={() => setTab("chapters")}>章节</Button>
              <Button variant="secondary" size="md" onClick={() => setTab("storyboards")}>剧本</Button>
            </div>
          </div>
        )}
        {tab === "preview" && (
          <PreviewPanel
            draftId={Number(id)}
            userInput={draft.user_input || ""}
            onUserInputChange={async (v: string) => {
              const res = await authFetch(`${BASE}/v1/stages/drafts/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user_input: v }),
              });
              if (res.ok) {
                await fetchDraft();
              } else {
                throw new Error("保存剧情概要失败");
              }
            }}
            onSelected={async () => {
              await fetchDraft();
              setTab("outline");
            }}
          />
        )}
        {tab === "outline" && (
          <div className="space-y-4">
            <ProgressBanner draftId={Number(id)} onTick={() => { fetchDraft(); }} />
            <VideoRetryPanel draftId={Number(id)} onChanged={fetchDraft} />
            <CharacterMapper
              draftId={Number(id)}
              characters={(draft.outline?.characters as any[]) || []}
              characterMapping={(draft.outline?.character_mapping as Record<string, string>) || {}}
              onApplied={fetchDraft}
            />
            {!draft.outline || Object.keys(draft.outline).length === 0 ? (
              <Card padding="lg" className="text-center py-16">
                <div className="max-w-md mx-auto">
                  <FileText className="w-20 h-20 mx-auto mb-6 text-primary opacity-60" />
                  <h3 className="text-2xl font-bold mb-3 text-ink-primary">开始创作大纲</h3>
                  <p className="text-ink-secondary mb-6 text-sm leading-relaxed">
                    AI将根据您的剧情概要,自动生成{draft.episode_count || 3}集的完整大纲,
                    包括每集标题、剧情概要、关键事件等。
                  </p>
                  <Button
                    variant="primary"
                    size="lg"
                    loading={generating || draft.status?.includes("running")}
                    leftIcon={!(generating || draft.status?.includes("running")) ? <Play className="w-5 h-5" /> : undefined}
                    onClick={generateOutline}
                  >
                    {(generating || draft.status?.includes("running")) ? "AI 生成中…" : "🚀 开始生成大纲"}
                  </Button>
                  {generating && (
                    <p className="mt-4 text-xs text-ink-muted">
                      预计需要 30 秒 - 2 分钟,请耐心等待…
                    </p>
                  )}
                </div>
              </Card>
            ) : (
              <div>
                {/* 大纲信息栏 — "锁定大纲"按钮已移除: 有大纲即可直接生成章节/剧本,
                    无需手动锁定; 改大纲后由"过期(stale)"机制提示重生。 */}
                <Card padding="md" className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-bold text-ink-primary">{draft.outline?.title || draft.title}</h2>
                    <p className="text-sm text-ink-secondary mt-1 line-clamp-2">{draft.outline?.synopsis}</p>
                  </div>
                  <Button
                    variant="primary"
                    size="md"
                    loading={linting}
                    onClick={runLint}
                    title="检测大纲硬伤: 死人复活/元素重复/悬念悬空等, 只标注不自动改"
                  >
                    {linting ? "校验中…" : "🔍 校验硬伤"}
                  </Button>
                </Card>

                {/* P6: 一致性校验报告横幅 + AI修改(勾选后只改勾选项) */}
                {(lintReport || draft.outline?.lint_report) && (() => {
                  const rpt = lintReport || draft.outline?.lint_report;
                  const errCnt = rpt.summary?.error || 0;
                  const warnCnt = rpt.summary?.warn || 0;
                  const issues = rpt.issues || [];
                  const fixableIssues = issues.filter((it: any) => it.id && it.episode);
                  const allFixableSelected = fixableIssues.length > 0 && fixableIssues.every((it: any) => selectedIssues.has(it.id));
                  return (
                    <Card padding="md" className={`mb-4 border ${errCnt > 0 ? "border-danger/50" : warnCnt > 0 ? "border-warning/50" : "border-success/50"}`}>
                      <div className="flex items-center gap-3 text-sm font-medium mb-2 flex-wrap">
                        <span className="text-danger">● {errCnt} 个硬伤</span>
                        <span className="text-warning">● {warnCnt} 个提醒</span>
                        <span className="text-ink-muted text-xs">AI 修改拥有全剧视野, 允许跨集修正; 可勾选精修或一键全量修复</span>
                        {fixableIssues.length > 0 && (
                          <div className="ml-auto flex items-center gap-2">
                            <label className="text-xs text-ink-secondary flex items-center gap-1 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={allFixableSelected}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedIssues(new Set(fixableIssues.map((it: any) => it.id)));
                                  } else {
                                    setSelectedIssues(new Set());
                                  }
                                }}
                              />
                              全选
                            </label>
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={fixing}
                              disabled={selectedIssues.size === 0 || fixing}
                              onClick={() => fixSelectedIssues(false)}
                              title="以勾选项为必修(其余问题作参考), AI 拥有全剧视野可跨集修改, 修完自动重新校验"
                            >
                              {fixing ? "AI 修改中…" : `🤖 修改勾选项 (${selectedIssues.size})`}
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              loading={fixing}
                              disabled={fixing || issues.length === 0}
                              onClick={() => fixSelectedIssues(true)}
                              title="把全剧大纲与全部问题发给 AI, 一次性修复所有硬伤(允许跨集大范围修改), 修完自动重新校验"
                            >
                              {fixing ? "AI 修改中…" : `🛠️ 全量修复 (${issues.length})`}
                            </Button>
                          </div>
                        )}
                      </div>
                      {issues.length > 0 ? (
                        <ul className="space-y-1.5 text-sm max-h-56 overflow-auto">
                          {issues.map((it: any, i: number) => {
                            const fixable = !!(it.id && it.episode);
                            return (
                              <li key={it.id || i} className="flex items-start gap-2">
                                {fixable && (
                                  <input
                                    type="checkbox"
                                    className="mt-1"
                                    checked={selectedIssues.has(it.id)}
                                    onChange={() => toggleIssue(it.id)}
                                  />
                                )}
                                <span className={it.level === "error" ? "text-danger" : "text-warning"}>
                                  [{it.level === "error" ? "硬伤" : "提醒"}] 第{it.episode}集: {it.message}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="text-sm text-success">✓ 未检测到硬伤</p>
                      )}
                    </Card>
                  );
                })()}

                {/* 叙事健康度: 事件时间轴 + 实体负荷检测 */}
                <NarrativeHealth draftId={Number(id)} onOutlineChanged={() => { fetchDraft(); fetchOverview(); }} />

                {/* 角色列表 */}
                {draft.outline?.characters && draft.outline.characters.length > 0 && (
                  <Card padding="md" className="mb-4">
                    <h3 className="font-semibold mb-2 text-ink-primary">👥 角色 ({draft.outline.characters.length})</h3>
                    <div className="flex flex-wrap gap-2">
                      {draft.outline.characters.map((c: any, idx: number) => (
                        <Badge key={idx} tone="primary" size="md" className="cursor-default" {...({ title: c.appearance } as any)}>
                          {c.name} <span className="text-xs text-ink-muted ml-1">({c.role})</span>
                        </Badge>
                      ))}
                    </div>
                  </Card>
                )}

                {/* 集数列表 */}
                <div className="space-y-3">
                  {(draft.outline?.chapters || []).map((ep: any, idx: number) => {
                    const isEditing = editingEpisode === ep.order;
                    return (
                    <Card key={idx} padding="md" data-episode-anchor={ep.order}>
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="text-lg font-semibold flex items-center gap-2">
                          第 {ep.order} 集: {ep.title}
                        </h3>
                        <div className="flex gap-1">
                          <button
                            onClick={() => {
                              if (isEditing) {
                                setEditingEpisode(null);
                              } else {
                                setEditingEpisode(ep.order);
                                setEpEditTitle(ep.title || "");
                                setEpEditSynopsis(ep.synopsis || "");
                              }
                            }}
                            className="text-xs px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded"
                          >
                            {isEditing ? '收起' : '✏️ 编辑'}
                          </button>
                        </div>
                      </div>
                      {isEditing ? (
                        <div className="space-y-2 mt-3 relative">
                          {feedbackLoading === ep.order && (
                            <div className="absolute inset-0 z-20 flex items-center justify-center rounded bg-surface-base/70 backdrop-blur-[1px]">
                              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-elevated border border-line shadow-lg text-sm text-ink-primary">
                                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                                正在按意见重写本集大纲，完成后将自动更新…
                              </div>
                            </div>
                          )}
                          <input
                            type="text"
                            value={epEditTitle}
                            onChange={(e) => setEpEditTitle(e.target.value)}
                            placeholder="标题"
                            disabled={feedbackLoading === ep.order}
                            className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm disabled:opacity-60"
                          />
                          <textarea
                            value={epEditSynopsis}
                            onChange={(e) => setEpEditSynopsis(e.target.value)}
                            rows={4}
                            placeholder="剧情概要"
                            disabled={feedbackLoading === ep.order}
                            className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm disabled:opacity-60"
                          />
                          <div className="flex gap-2">
                            <button onClick={() => saveEpisodeEdit(ep.order)} disabled={feedbackLoading === ep.order} className="px-3 py-1 bg-info hover:bg-info/90 disabled:opacity-50 rounded text-xs text-white">💾 保存</button>
                            <button onClick={() => regenerateEpisodeSolo(ep.order)} disabled={feedbackLoading === ep.order} className="px-3 py-1 bg-primary hover:bg-primary disabled:opacity-50 rounded text-xs">重新生成</button>
                            <button onClick={() => regenerateEpisodeFrom(ep.order)} disabled={feedbackLoading === ep.order} className="px-3 py-1 bg-warning hover:bg-warning/90 disabled:opacity-50 rounded text-xs text-white" title="从这一集往后，按已生成的内容接着写">续写</button>
                          </div>
                          <div className="mt-2 p-2 bg-surface-overlay/50 border border-warning/20 rounded">
                            <textarea
                              value={feedbackText}
                              onChange={(e) => setFeedbackText(e.target.value)}
                              rows={2}
                              placeholder="修改意见,如:'冲突不够强,增加反转'..."
                              disabled={feedbackLoading === ep.order}
                              className="w-full px-2 py-1 bg-surface-base border border-line rounded text-xs text-ink-primary disabled:opacity-60"
                            />
                            <button
                              onClick={() => regenerateWithFeedback(ep.order, "outline")}
                              disabled={feedbackLoading !== null || !feedbackText.trim()}
                              className="mt-1 px-3 py-1 bg-warning hover:bg-warning/90 disabled:opacity-50 rounded text-xs font-semibold flex items-center gap-1"
                            >
                              {feedbackLoading === ep.order ? <><Loader2 className="w-3 h-3 animate-spin" /> 重写中...</> : "🤖 根据意见重写本集大纲"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm text-ink-primary leading-relaxed line-clamp-3">{ep.synopsis}</p>
                          {/* 情绪强度 / 权力关系（2026-09-19 新增）。
                              ⚠️ 必须**在这里**也显示，不能只靠 _ContractFold：
                              那个组件挂在 /drafts/[id]/outline，而那个路由**全站无入口**
                              （零入站链接），用户看大纲就是看这个 tab。
                              只标在这两处等于这两个字段对用户不可见 ——
                              而它们恰恰是门禁 11/12 的判据，被判 warn 时用户得能看到依据。

                              0 = 未标注（老数据），**不显示** —— 那与"强度确实是 1"
                              是两件事，显示成 0 会让人以为这一集很平。 */}
                          {((ep.emotion_intensity || 0) > 0 || ep.power) && (
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                              {(ep.emotion_intensity || 0) > 0 && (
                                <span title="本集情绪峰值强度（1-10），门禁会检查相邻集是否落差过大">
                                  情绪强度{' '}
                                  <span className="tabular-nums text-ink-secondary">
                                    {ep.emotion_intensity}
                                  </span>
                                  <span className="text-ink-muted">/10</span>
                                </span>
                              )}
                              {ep.power && (ep.power.aggressor || ep.power.defender || ep.power.focus) && (
                                <span title="本集的权力关系：谁施压、谁承受、争的是什么">
                                  {ep.power.aggressor || '（未写）'}
                                  <span className="mx-1 text-ink-muted">→</span>
                                  {ep.power.defender || '（未写）'}
                                  {ep.power.focus && (
                                    <span className="ml-1 text-ink-muted">· 争：{ep.power.focus}</span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                          {ep.must_have && ep.must_have.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {ep.must_have.map((item: string, i: number) => (
                                <span key={i} className="text-xs px-2 py-0.5 bg-warning/15 border border-warning/40 rounded text-warning">
                                  {item}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}


        {tab === "chapters" && (
          <div className="space-y-4">
            <ProgressBanner draftId={Number(id)} onTick={() => { fetchDraft(); }} />
            <WordCountSettings
              draft={draft}
              onUpdated={fetchDraft}
              onTriggerBatchChapters={() => startBatchGenerate('chapters')}
            />
            <SafetyPanel draftId={Number(id)} />
            {/* 不再要求锁定大纲: 有大纲(含集) 即可生成章节 */}
            {!(draft.outline?.chapters?.length) ? (
              <Card padding="lg" className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-50 text-ink-muted" />
                <p className="text-ink-secondary">请先生成大纲后再生成章节</p>
              </Card>
            ) : (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-ink-primary">章节列表</h2>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* 续写按钮: 只有当存在已生成章节时才显示 */}
                    {(draft.chapters?.length || 0) > 0 && (
                      <Button
                        variant="secondary"
                        size="md"
                        leftIcon={<Rocket className="w-4 h-4" />}
                        disabled={batchGenerating !== null}
                        onClick={() => setExtendOpen(true)}
                        title="基于已有章节扩写到目标集数"
                      >
                        续写
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      size="md"
                      loading={batchGenerating === 'chapters'}
                      leftIcon={batchGenerating !== 'chapters' ? <Rocket className="w-4 h-4" /> : undefined}
                      disabled={batchGenerating !== null}
                      onClick={() => startBatchGenerate('chapters')}
                      title="只补缺失/已过期的章节, 已存在且未过期的章节跳过"
                    >
                      {batchGenerating === 'chapters' ? '生成中…' : '🚀 全部生成'}
                    </Button>
                    {/* 强制重写: 把所有章节当作 stale 重新写一遍, 适合"调了字数想全部重写"的场景。
                        ⚠️ 2026-10-06 起含导入时自动标记为"已锁定"的章节 —— 那些 lock 用户既看不见入口、
                        也解不开, 却会让旧版按钮"已标记 0 个"然后一集不写。 */}
                    {(draft.chapters?.length || 0) > 0 && (
                      <Button
                        variant="danger"
                        size="md"
                        disabled={batchGenerating !== null}
                        onClick={() => startBatchGenerate('chapters', true)}
                        title={`按当前每章字数 ${draft.chapter_word_target || 900} 强制重写所有章节(含导入的原文), 每集保留历史版本可回滚`}
                      >
                        强制重写全部
                      </Button>
                    )}
                  </div>
                </div>
                {batchGenerating === 'chapters' && (
                  <Card padding="md" className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-ink-primary">生成进度</span>
                      <span className="text-sm text-primary">{batchProgress.current}/{batchProgress.total}</span>
                    </div>
                    <div className="w-full bg-surface-base rounded-full h-2 mb-3">
                      <div className="bg-gradient-to-r from-primary to-cyan h-2 rounded-full transition-all" style={{ width: batchProgress.total ? `${(batchProgress.current / batchProgress.total) * 100}%` : '0%' }} />
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1 bg-surface-base/50 p-2 rounded border border-line">
                      {batchLogs.map((log, idx) => (
                        <div key={idx} className="text-xs text-ink-muted font-mono">{log}</div>
                      ))}
                    </div>
                  </Card>
                )}
                {/* 过期内容提示 */}
                {draft.chapters?.some((c: any) => c.is_stale === 1) && (
                  <div className="mb-3 p-3 bg-warning/10 border border-warning/40 rounded-lg flex items-center justify-between">
                    <span className="text-sm text-warning">⚠️ {draft.chapters.filter((c: any) => c.is_stale === 1).length}个章节已过期(大纲已更新)</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchGenerating !== null}
                      onClick={() => startBatchGenerate('chapters')}
                    >
                      重新生成所有过期章节
                    </Button>
                  </div>
                )}
                {/* ── 无界集列表（PLAN §4.5.9 / 效果图 137）─────────────────────
                    改造前：每集一张 Card（边框+圆角+阴影）+ 标题行同时挂着
                    synopsis 和 5~7 个按钮 → 一屏十几个框，眼睛一直在跳。

                    改造后：
                      · 去掉卡片边框/圆角/阴影，集与集之间只用一条极淡分隔线
                      · 有正文时 **不再显示 synopsis**（用户既然能看到正文，
                        梗概就是冗余信息 —— 这正是用户提的"为什么不直接看正文"）
                      · 全文模态：显示 synopsis（此时它是唯一信息，必须留）
                      · 次要操作收进「⋯」，减少可见元素
                    ─────────────────────────────────────────────────────── */}
                <div className="divide-y divide-line">
                {draft.outline?.chapters?.map((ch: any, idx: number) => {
                  const existing = draft.chapters?.find((c: any) => c.chapter_order === ch.order);
                  return (
                    <div
                      key={idx}
                      /* 树图导航（B10）的滚动落点。属性名带 `data-` 前缀而不是 id：
                         html 的 id 全站唯一，而这里每换一次草稿都会重挂，
                         用 data 属性既避免与页面其它 id 撞车，也方便用选择器批量找。 */
                      data-episode-anchor={ch.order}
                      className="py-6 first:pt-2"
                    >
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="min-w-0">
                          <h3 className="text-base font-semibold text-ink-primary truncate">
                            第 {ch.order} 章：{ch.title}
                          </h3>
                          {/* 梗概只在**没有正文**时显示 —— 有正文时它是冗余 */}
                          {!existing && (
                            <p className="text-sm text-ink-secondary mt-1 line-clamp-2">{ch.synopsis}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {existing && (
                            <span className="text-xs text-ink-muted whitespace-nowrap">
                              {existing.word_count} 字
                            </span>
                          )}
                          {existing?.is_stale === 1 && (
                            <span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" title="大纲已更新，建议重新生成" />
                          )}
                          {/* 生成后自动校验的结论（PLAN §3.3 / B8）—— 零 LLM 自动跑，
                              结论直接标在卡片上，用户不需要手动点「校验」才发现问题。
                              红 = error（疑似生成失败），黄 = warn（字数偏离等）。 */}
                          {existing?.auto_checks?.length > 0 && (
                            <span
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                existing.auto_checks.some((i: any) => i.level === 'error')
                                  ? 'bg-danger'
                                  : 'bg-warning/70'
                              }`}
                              title={existing.auto_checks.map((i: any) => i.message).join('\n')}
                            />
                          )}
                          {existing && (
                            <details className="relative">
                              <summary className="list-none cursor-pointer px-1.5 text-ink-muted hover:text-ink-primary select-none" title="更多操作">⋯</summary>
                              <div className="absolute right-0 top-6 z-20 w-40 rounded-lg border border-line bg-surface-elevated shadow-lg py-1">
                                <button onClick={() => setHistoryForOrder(ch.order)} className="block w-full text-left px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-overlay">历史版本</button>
                                <button onClick={() => regenerateChapter(ch.order, false)} disabled={generatingOrder !== null} className="block w-full text-left px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-overlay disabled:opacity-50">重新生成</button>
                              </div>
                            </details>
                          )}
                        </div>
                      </div>

                      {existing && (
                        /* 正文直接铺开 + 点击即改（PLAN §4.5.12 / 效果图 131）。 */
                        <div className="mt-3">
                          {expandedChapter === ch.order ? (
                            <>
                              <textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                onBlur={() => {
                                  // 失焦自动保存：与原文一致才算"改过"，避免无意义的 PATCH
                                  if (editText !== (existing.full_text || "")) {
                                    void saveChapterEdit(ch.order, false);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setEditText(existing.full_text || "");
                                    setExpandedChapter(null);
                                  } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                                    e.preventDefault();
                                    void saveChapterEdit(ch.order, true);
                                  }
                                }}
                                autoFocus
                                rows={Math.min(40, Math.max(8, Math.ceil((editText.length || 1) / 60)))}
                                className="w-full px-0 py-0 bg-transparent border-0 text-sm leading-7 text-ink-primary resize-none outline-none focus:ring-0"
                                style={{ minHeight: '12rem' }}
                              />
                              <div className="flex items-center gap-2 mt-2 text-xs">
                                <button
                                  onClick={() => void saveChapterEdit(ch.order, true)}
                                  className="px-2.5 py-1 rounded bg-primary text-white hover:bg-primary-hover"
                                >保存 (⌘S)</button>
                                <button
                                  onClick={() => { setEditText(existing.full_text || ""); setExpandedChapter(null); }}
                                  className="px-2.5 py-1 rounded text-ink-muted hover:text-ink-primary"
                                >取消 (Esc)</button>
                                <button
                                  onClick={() => regenerateChapter(ch.order, true)}
                                  disabled={generatingOrder !== null}
                                  className="px-2.5 py-1 rounded text-ink-muted hover:text-ink-primary disabled:opacity-50"
                                  title="保存编辑后，基于编辑文本重新生成"
                                >基于编辑重新生成</button>
                                <span className="ml-auto text-ink-muted">{editText.length} 字</span>
                              </div>
                            </>
                          ) : (
                            <div
                              role="button"
                              tabIndex={0}
                              title="点击即可编辑"
                              onClick={() => {
                                setEditText(existing.full_text || "");
                                setExpandedChapter(ch.order);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setEditText(existing.full_text || "");
                                  setExpandedChapter(ch.order);
                                }
                              }}
                              className="cursor-text text-sm leading-7 text-ink-primary whitespace-pre-wrap rounded -mx-1 px-1 hover:bg-surface-overlay/40 transition-colors"
                            >{existing.full_text}</div>
                          )}

                          {/* 行内意见框：写一句就能重做这一集（不占按钮位） */}
                          <div className="mt-3 flex items-center gap-2 border-b border-line pb-1.5">
                            <input
                              value={feedbackText}
                              onChange={(e) => setFeedbackText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && feedbackText.trim() && feedbackLoading === null) {
                                  void regenerateWithFeedback(ch.order, "chapters");
                                }
                              }}
                              placeholder="说点什么让它改一改…"
                              className="flex-1 bg-transparent border-0 text-xs text-ink-secondary placeholder:text-ink-muted outline-none"
                            />
                            {feedbackLoading === ch.order ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />
                            ) : (
                              <button
                                onClick={() => void regenerateWithFeedback(ch.order, "chapters")}
                                disabled={feedbackLoading !== null || !feedbackText.trim()}
                                className="text-ink-muted hover:text-primary disabled:opacity-40 transition-colors"
                                title="按这条意见重做本集"
                              >↵</button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "storyboards" && (
          <div className="space-y-4">
            <ProgressBanner draftId={Number(id)} onTick={() => { fetchDraft(); }} />
            {/* 剧本页字数控制: 编辑的是与创建草稿时一致的 chapter_word_target(向创建看齐, 可修改)。
                因为"大纲直接生成剧本"会用到该字数, 在此暴露入口, 方便直接生剧本前先调字数。 */}
            <WordCountSettings
              draft={draft}
              onUpdated={fetchDraft}
              onTriggerBatchChapters={() => startBatchGenerate('storyboards', true)}
            />
            <SafetyPanel draftId={Number(id)} />
            {(() => {
              // 剧本页遍历基准 = 章节 + 大纲 + 已生成剧本 三者集号的并集。
              // 修复: 旧逻辑"有章节就只用章节列表"会导致「章节只生成了前N集、
              // 但剧本已按大纲生成了更多集」时, 超出章节范围的剧本(如第11-50集)不显示。
              // 现在无论哪个阶段各生成了多少, 只要某集有剧本/章节/大纲之一, 就会出现在列表里。
              const chapterMap = new Map<number, any>();
              // 1) 大纲铺底(提供标题)
              (draft.outline?.chapters || []).forEach((c: any, i: number) => {
                const ord = c.order ?? (i + 1);
                chapterMap.set(ord, { chapter_order: ord, title: c.title || `第${ord}集`, _fromOutline: true });
              });
              // 2) 章节覆盖(有正文的用章节记录, 保留 full_text/locked 等字段)
              (draft.chapters || []).forEach((c: any) => {
                chapterMap.set(c.chapter_order, { ...c });
              });
              // 3) 剧本兜底: 有剧本但既无章节又无大纲的集号也要能显示
              (draft.storyboards || []).forEach((s: any) => {
                if (!chapterMap.has(s.chapter_order)) {
                  chapterMap.set(s.chapter_order, { chapter_order: s.chapter_order, title: `第${s.chapter_order}集`, _fromStoryboard: true });
                }
              });
              const sbChapters = Array.from(chapterMap.values()).sort((a, b) => a.chapter_order - b.chapter_order);
              (draft as any).__sbChapters = sbChapters;
              return sbChapters.length === 0;
            })() ? (
              <Card padding="lg" className="text-center">
                <FileText className="w-16 h-16 mx-auto mb-4 opacity-50 text-ink-muted" />
                <p className="text-ink-secondary">请先生成大纲(或章节)后再生成剧本</p>
              </Card>
            ) : (
              <div>
                <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold text-ink-primary">剧本列表</h2>
                    {/* 视图切换: 分镜 / 全文(类Word) — 整页统一 (需求1) */}
                    <div className="inline-flex rounded-lg border border-line overflow-hidden text-xs">
                      <button
                        onClick={() => switchScriptView('shots')}
                        className={`px-3 py-1.5 transition ${scriptView === 'shots' ? 'bg-primary text-white' : 'bg-surface-base text-ink-secondary hover:bg-surface-overlay'}`}
                      >
                        分镜视图
                      </button>
                      <button
                        onClick={() => switchScriptView('fulltext')}
                        className={`px-3 py-1.5 transition ${scriptView === 'fulltext' ? 'bg-primary text-white' : 'bg-surface-base text-ink-secondary hover:bg-surface-overlay'}`}
                      >
                        全文视图
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="primary"
                      size="md"
                      loading={batchGenerating === 'storyboards'}
                      leftIcon={batchGenerating !== 'storyboards' ? <Rocket className="w-4 h-4" /> : undefined}
                      disabled={batchGenerating !== null}
                      onClick={() => startBatchGenerate('storyboards')}
                      title="只补缺失/已过期的剧本, 已存在且未过期的章节跳过"
                    >
                      {batchGenerating === 'storyboards' ? '生成中…' : '🚀 全部生成'}
                    </Button>
                    {(draft.storyboards?.length || 0) > 0 && (
                      <Button
                        variant="danger"
                        size="md"
                        disabled={batchGenerating !== null}
                        onClick={() => startBatchGenerate('storyboards', true)}
                        title="强制重写所有剧本(全部覆盖, 每集保留历史版本可回滚)"
                      >
                        强制重写全部
                      </Button>
                    )}
                    <Button
                      variant="cyan"
                      size="md"
                      leftIcon={<Download className="w-4 h-4" />}
                      onClick={() => setExportMixedOpen(true)}
                      title="智能选源:已锁定章节用原文,其他用 AI 剧本;支持自定义"
                    >
                      导出Word(智能/混合)
                    </Button>
                    <button
                      type="button"
                      onClick={() => exportFile('/storyboards-export-all-docx', `${draft?.title || '剧本'}_全部剧本.docx`)}
                      className="px-3 py-1.5 text-xs bg-surface-raised hover:bg-surface-overlay border border-line rounded-lg transition text-ink-secondary"
                      title="把已生成的剧本一次性导出为一个 Word 文档（按集分节）。与左侧「导出Word(智能/混合)」的区别：这个不做选源，统一用 AI 剧本正文。"
                    >全部剧本</button>
                    <button
                      type="button"
                      onClick={() => exportFile('/os-review-export', `${draft?.title || '剧本'}_OS复核清单.docx`)}
                      className="px-3 py-1.5 text-xs bg-surface-raised hover:bg-surface-overlay border border-line rounded-lg transition text-ink-secondary"
                      title="导出转写后仍保留的内心独白(OS)复核清单, 供人工核对是否需进一步改写/删除"
                    >🧠 OS复核清单</button>
                  </div>
                </div>
                {batchGenerating === 'storyboards' && (
                  <Card padding="md" className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-ink-primary">生成进度</span>
                      <span className="text-sm text-primary">{batchProgress.current}/{batchProgress.total}</span>
                    </div>
                    <div className="w-full bg-surface-base rounded-full h-2 mb-3">
                      <div className="bg-gradient-to-r from-primary to-cyan h-2 rounded-full transition-all" style={{ width: batchProgress.total ? `${(batchProgress.current / batchProgress.total) * 100}%` : '0%' }} />
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-1 bg-surface-base/50 p-2 rounded border border-line">
                      {batchLogs.map((log, idx) => (
                        <div key={idx} className="text-xs text-ink-muted font-mono">{log}</div>
                      ))}
                    </div>
                  </Card>
                )}
                {/* 过期剧本提示 */}
                {draft.storyboards?.some((s: any) => s.is_stale === 1) && (
                  <div className="mb-3 p-3 bg-warning/10 border border-warning/40 rounded-lg flex items-center justify-between">
                    <span className="text-sm text-warning">⚠️ {draft.storyboards.filter((s: any) => s.is_stale === 1).length}个剧本已过期(章节已更新)</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={batchGenerating !== null}
                      onClick={() => startBatchGenerate('storyboards')}
                    >
                      重新生成所有过期剧本
                    </Button>
                  </div>
                )}
                {scriptView === 'fulltext' ? (
                  <FullTextEditor
                    draftId={Number(id)}
                    storyboards={(draft.storyboards || []) as any}
                    onSaved={() => { fetchDraft(); fetchOverview(); }}
                    locked={batchGenerating === 'storyboards' || feedbackLoading !== null}
                    lockedHint="正在重新生成剧本，完成后将自动更新全文…"
                  />
                ) : (((draft as any).__sbChapters) || draft.chapters || []).map((ch: any) => {
                  const sb = draft.storyboards?.find((s: any) => s.chapter_order === ch.chapter_order);
                  return (
                    <Card
                      key={ch.chapter_order}
                      padding="lg"
                      className="mb-4"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="text-lg font-semibold">第 {ch.chapter_order} 章：{ch.title}</h3>
                          {sb && (
                            <p className="text-sm text-ink-secondary mt-1">
                              {sb.shots_json?.length || 0} 个镜头
                              {sb.is_stale === 1 && (
                                <span className="ml-2 text-xs px-2 py-0.5 bg-warning/20 border border-warning/40 rounded text-warning">⚠️ 章节已更新,建议重新生成</span>
                              )}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {!sb && (
                            <button
                              onClick={() => generateStoryboard(ch.chapter_order)}
                              disabled={generating}
                              className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/80 disabled:opacity-50 rounded-lg transition text-sm"
                            >
                              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                              生成剧本
                            </button>
                          )}
                          {sb && (
                            <>
                              <button
                                onClick={() => generateStoryboard(ch.chapter_order)}
                                disabled={generating}
                                className="flex items-center gap-2 px-3 py-1 bg-primary hover:bg-primary disabled:opacity-50 rounded text-xs"
                              >
                                🔄 重新生成
                              </button>
                              <button type="button" onClick={() => exportFile(`/storyboards-export-docx/${ch.chapter_order}`, `第${ch.chapter_order}集_剧本.docx`)} className="px-2 py-1 bg-success hover:bg-success/90 rounded text-xs">📄 Word</button>
                              <button type="button" onClick={() => exportFile(`/storyboards-export-txt/${ch.chapter_order}`, `第${ch.chapter_order}集_剧本.txt`)} className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs">📝 TXT</button>
                              <button type="button" onClick={() => exportFile(`/storyboards-export-md/${ch.chapter_order}`, `第${ch.chapter_order}集_剧本.md`)} className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs">📋 MD</button>
                              <button onClick={() => setSbHistoryForOrder(ch.chapter_order)} className="flex items-center gap-1 px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs" title="查看 / 恢复剧本历史版本(含评审精修覆盖前的版本)"><History className="w-3 h-3" /> 历史版本</button>
                            </>
                          )}
                        </div>
                      {sb && (
                        <div className="mt-3 p-3 bg-surface-overlay/50 border border-warning/20 rounded">
                          <label className="text-xs text-warning font-semibold mb-1 block">📝 剧本修改意见:</label>
                          <textarea
                            value={feedbackText}
                            onChange={(e) => setFeedbackText(e.target.value)}
                            rows={2}
                            placeholder="如:'第3场缺少反应镜头,增加女主的特写表情'..."
                            className="w-full px-2 py-1 bg-surface-base border border-line rounded text-xs text-ink-primary"
                          />
                          <button
                            onClick={() => regenerateWithFeedback(ch.chapter_order, "storyboards")}
                            disabled={feedbackLoading !== null || !feedbackText.trim()}
                            className="mt-1 px-3 py-1 bg-warning hover:bg-warning/90 disabled:opacity-50 rounded text-xs font-semibold"
                          >
                            {feedbackLoading === ch.chapter_order ? "重写中..." : "🤖 根据意见重写本章剧本"}
                          </button>
                        </div>
                      )}
                      </div>
                      {sb && sb.shots_json && (
                        <div className="mt-4 space-y-3">
                          {sb.shots_json.map((shot: any, idx: number) => (
                            <div key={idx} className="p-3 bg-surface-overlay/50 rounded-lg border-l-2 border-primary/40">
                              <div className="flex items-start gap-3">
                                <div className="flex-shrink-0 w-14 text-center">
                                  <div className="text-lg font-bold text-primary">
                                    {shot.scene_no || shot.shot_no || idx+1}
                                  </div>
                                </div>
                                <div className="flex-1 space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {shot.time_loc && <span className="px-2 py-0.5 bg-info/15 text-info text-xs rounded">{shot.time_loc}</span>}
                                    {shot.shot_type && <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded">{shot.shot_type}</span>}
                                    <span className="text-sm text-ink-secondary">{shot.location}</span>
                                  </div>
                                  {shot.characters && shot.characters.length > 0 && (
                                    <div className="text-sm text-ink-secondary">
                                      出场：{shot.characters.join("、")}
                                    </div>
                                  )}
                                  {/* 优先用后端有序 elements(动作/对白本就按时序穿插); 无则回退启发式交错 */}
                                  {Array.isArray(shot.elements) && shot.elements.length > 0 ? (
                                    shot.elements.map((el: any, li: number) =>
                                      el.type === "dialogue" ? (
                                        <div key={li} className="mt-1 pl-3 border-l-2 border-primary/40 text-sm text-primary whitespace-pre-wrap break-words leading-relaxed">
                                          {(el.character || "") +
                                            (el.mode ? `(${el.mode})` : "") +
                                            (el.action ? `【${el.action}】` : "") +
                                            (el.character || el.content ? "：" : "") +
                                            (el.content || "")}
                                        </div>
                                      ) : el.type === "action" ? (
                                        <div key={li} className="text-sm text-ink-primary leading-relaxed whitespace-pre-wrap break-words">
                                          {String(el.content || "").startsWith("△") ? el.content : `△${el.content || ""}`}
                                        </div>
                                      ) : el.type === "flashback_start" ? (
                                        <div key={li} className="text-xs text-warning/80 my-1">— 回忆开始 —</div>
                                      ) : el.type === "flashback_end" ? (
                                        <div key={li} className="text-xs text-warning/80 my-1">— 回忆结束 —</div>
                                      ) : null,
                                    )
                                  ) : (
                                    interleaveActionDialogue(shot.action, shot.dialogue).map((ln: any, li: number) =>
                                      ln.type === "action" ? (
                                        <div key={li} className="text-sm text-ink-primary leading-relaxed whitespace-pre-wrap break-words">
                                          △{ln.text}
                                        </div>
                                      ) : (
                                        <div key={li} className="mt-1 pl-3 border-l-2 border-primary/40 text-sm text-primary whitespace-pre-wrap break-words leading-relaxed">
                                          {ln.text}
                                        </div>
                                      ),
                                    )
                                  )}
                                  {shot.notes && (
                                    <div className="text-xs text-ink-muted mt-2">注：{shot.notes}</div>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "characters" && (
          <div className="space-y-6">
            <CharacterBiblePanel draftId={Number(id)} />
            <div className="border-t border-line pt-6">
              <CharactersPanel draftId={Number(id)} />
            </div>
          </div>
        )}
        {tab === "novel" && (
                    <AdaptRoom draftId={Number(id)} kind="novel" initialWordTarget={draft?.chapter_word_target || 900} />
        )}
        {tab === "tweet" && (
          <AdaptRoom draftId={Number(id)} kind="tweet" initialWordTarget={draft?.chapter_word_target || 900} />
        )}
        {tab === "prompts" && (
          <VideoPromptsPanel draftId={Number(id)} />
        )}
        {tab === "images" && (
          <ImagePanel draftId={Number(id)} />
        )}

        {/* ⛔ 2026-09-18 入口审计裁定：整本 AI 精修的**独立入口已停用**。
            理由：该能力已被对话工坊的「精修这批」按钮取代（用户裁定原话：
            "这些功能已经完全被对话工坊中的精修这批按钮替换，旧逻辑都可以不要"）。
            替换方覆盖了范围圈定(scope)与模型选择，且能看改前/改后对照。

            ⚠️ 后端的 /v1/rewrite **必须保留** —— 对话工坊正是走它
            （chat_jobs.start_rewrite，同一套 service、两种投递方式）。
            这里只是不再提供工作台内的独立 tab 入口。

            恢复方式：取消下面注释 + 恢复 WorkbenchSidebar 的 critique 项。 */}
        {/* {tab === "critique" && (
          <RewriteRoom draftId={Number(id)} onApplied={() => { fetchDraft(); fetchOverview(); }} />
        )} */}
        {tab === "analysis" && (
          <AnalysisPanel draftId={Number(id)} draftTitle={draft.title || "未命名"} />
        )}

        {/* 续写弹窗 */}
        <ExtendModal
          draftId={Number(id)}
          open={extendOpen}
          onClose={() => setExtendOpen(false)}
          onStarted={() => { fetchDraft(); fetchLogs(); }}
        />

        {/* 改编弹窗: 分析原作 -> 编辑蓝图 -> 生成改编新作 */}
        <AdaptModal
          draftId={Number(id)}
          open={adaptOpen}
          onClose={() => setAdaptOpen(false)}
          onDone={(newDraftId) => {
            setAdaptOpen(false);
            if (newDraftId) window.location.href = `/jubengongfang/drafts/${newDraftId}`;
          }}
        />

        {/* DNA 裂变工厂: 提取原作爆款DNA → 批量裂变出N个各具新意的完整新作 */}
        <SpawnModal
          draftId={Number(id)}
          open={spawnOpen}
          onClose={() => setSpawnOpen(false)}
          initialWordTarget={draft?.chapter_word_target || 900}
          onOpenDraft={(newDraftId) => {
            if (newDraftId) window.location.href = `/jubengongfang/drafts/${newDraftId}`;
          }}
        />

        {/* 双源混合导出弹窗 */}
        <ExportMixedModal
          draftId={Number(id)}
          draftTitle={draft.title || "未命名"}
          open={exportMixedOpen}
          onClose={() => setExportMixedOpen(false)}
        />

        {/* 章节版本历史 Modal — Phase 3 §37.4.1 落地: script_episode_history 表 */}
        {historyForOrder !== null && (() => {
          const ch = draft.chapters?.find((c: any) => c.chapter_order === historyForOrder);
          const meta = draft.outline?.chapters?.find((c: any) => c.order === historyForOrder);
          return (
            <ChapterVersionHistory
              open={true}
              draftId={Number(id)}
              chapterOrder={historyForOrder}
              chapterTitle={ch?.title || meta?.title}
              currentText={ch?.full_text || ""}
              onClose={() => setHistoryForOrder(null)}
              onRestored={() => {
                fetchDraft();
                fetchLogs();
                // 如果当前正在编辑被恢复的章节,把 editText 同步成新内容
                if (expandedChapter === historyForOrder) {
                  setTimeout(() => {
                    const refreshed = draft.chapters?.find((c: any) => c.chapter_order === historyForOrder);
                    if (refreshed) setEditText(refreshed.full_text || "");
                  }, 200);
                }
              }}
            />
          );
        })()}

        {/* 剧本版本历史 Modal — stage=storyboard, 含评审精修覆盖前版本 */}
        {sbHistoryForOrder !== null && (() => {
          const meta = draft.outline?.chapters?.find((c: any) => c.order === sbHistoryForOrder);
          return (
            <ChapterVersionHistory
              open={true}
              draftId={Number(id)}
              chapterOrder={sbHistoryForOrder}
              chapterTitle={meta?.title}
              stage="storyboard"
              onClose={() => setSbHistoryForOrder(null)}
              onRestored={() => { fetchDraft(); fetchOverview(); }}
            />
          );
        })()}
          </div>

          {/* ── 修改日志：边缘手柄 + 抽屉 + 报错自动弹出（PLAN §4.5.7 / 效果图 105）──
              改造前：右侧 320px 常驻栏 + `<details open>` 默认展开 —— 占着黄金位置，
              而用户明确说"几乎不看修改日志"。
              改造后：
                · 默认收成贴边的一条窄手柄（带圆点表示有新日志 / 红点表示有报错）
                · 点开是**浮层抽屉**，不挤压正文宽度
                · **例外：出现 error 级日志时自动弹出** —— 没人看日志，
                  但没人能忽略报错。这是"不打扰，但该出现时一定出现"。
              embed 模式下完全不渲染（把宽度让给草稿正文）。 */}
          {!isEmbed && (
            <>
              {/* 贴边手柄：常驻但极窄，保证"折叠不等于隐藏"（原则 P4） */}
              <button
                type="button"
                onClick={() => setLogOpen(true)}
                title={
                  logHasError
                    ? `有 ${logErrorCount} 条错误日志，点击查看`
                    : `修改日志（${generationLogs.length}）`
                }
                aria-label="打开修改日志"
                className="fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 py-3 px-1 rounded-l-lg border border-r-0 border-line bg-surface-raised/90 backdrop-blur hover:bg-surface-overlay transition-colors"
              >
                <span className="text-[10px] text-ink-muted [writing-mode:vertical-rl] tracking-wider">
                  日志
                </span>
                {(logHasError || generationLogs.length > 0) && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      logHasError ? 'bg-danger animate-pulse' : 'bg-primary/60'
                    }`}
                  />
                )}
              </button>

              {/* 抽屉：浮层，不占正文宽度 */}
              {logOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[60] bg-black/20"
                    onClick={() => setLogOpen(false)}
                  />
                  <aside className="fixed right-0 top-0 z-[61] h-screen w-[380px] max-w-[85vw] bg-surface-elevated border-l border-line shadow-2xl flex flex-col">
                    <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
                      <span className="text-sm font-semibold text-ink-primary">修改日志</span>
                      <span className="text-xs text-ink-muted">({generationLogs.length})</span>
                      {logHasError && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-danger/15 text-danger">
                          {logErrorCount} 条错误
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setLogOpen(false)}
                        className="ml-auto text-ink-muted hover:text-ink-primary transition-colors"
                        aria-label="关闭"
                      >
                        ✕
                      </button>
                    </header>
                    <div className="flex-1 overflow-y-auto px-4 py-3">
                      {generationLogs.length === 0 ? (
                        <p className="text-xs text-ink-muted">暂无日志，生成/重写后自动记录</p>
                      ) : (
                        <div className="space-y-2">
                          {generationLogs.slice().reverse().slice(0, 50).map((log: any) => (
                            <div key={log.id} className="text-xs border-b border-line/50 pb-2">
                              <div className="flex items-center gap-1 mb-0.5">
                                <span className={`w-2 h-2 rounded-full ${log.log_type === 'error' ? 'bg-danger' : log.log_type === 'done' ? 'bg-success' : log.log_type === 'rag_hit' ? 'bg-cyan' : 'bg-ink-muted'}`} />
                                <span className="text-ink-muted">
                                  {new Date(log.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                                <span className="text-primary font-semibold">[{log.stage}]</span>
                              </div>
                              <div className="text-ink-primary pl-3 whitespace-pre-wrap break-words">{log.message}</div>
                              {log.metadata?.feedback && (
                                <div className="pl-3 mt-1 text-warning/70 italic">💬 意见: {log.metadata.feedback}</div>
                              )}
                              {log.metadata?.sources_text && (
                                <details className="pl-3 mt-1 cursor-pointer">
                                  <summary className="text-cyan hover:text-cyan-hover">📚 召回片段</summary>
                                  <pre className="mt-1 p-1 bg-surface-base rounded text-ink-secondary whitespace-pre-wrap text-[10px] max-h-32 overflow-y-auto">{log.metadata.sources_text}</pre>
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </aside>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </WorkbenchShell>
  );
}
