"use client";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { confirmAsync, notifyError } from "@/lib/dialog";
import { usePendingImages, useDropZone, PendingImageStrip, MessageImages, DropOverlay,
  imagesFromClipboard, isImageFile, type MessageImage } from "@/components/chat/ChatImages";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { DiffAwareText, hasDiffBlock } from "./_DiffBlock";
import ActionBar, { type ActionSpec, type ActionScope } from "./_ActionBar";
import AgentDrawer from "./_AgentDrawer";
import RewriteDiff from "./_RewriteDiff";
import ReportCard, { type CheckReport, type FixResult } from "./_ReportCard";
import DeaiCard, { type DeaiJobView } from "./_DeaiCard";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import { authFetch, getUser, getToken } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import { OperationCard, AgentOperation } from "../_OperationCard";
import { DraftProductPane } from "@/components/drafts/DraftProductPane";
import { shotsToText, textToShots, type Shot } from "../../lib/scriptText";
import { markdownForClipboard } from "../../lib/markdownPlain";
import { resolveModelValue, type ModelGroup } from "../../lib/modelCatalog";
import { ModelMenu } from "@/components/ModelMenu";
import {
  detectReplaceable, segmentReply, KIND_LABEL, KIND_UNIT, type ReplaceKind,
} from "../../lib/replaceDetect";
import {
  MessageSquare, Plus, Trash2, Edit3, Search, Send, Loader2,
  FileText, Settings, Paperclip, Save, Sparkles, ChevronDown, X,
  RefreshCw, AlertCircle, BookOpen, Globe, StopCircle, Copy, Check,
  RotateCw, Quote, Download, ArrowLeft, History, Cpu, SlidersHorizontal, RotateCcw,
  CornerDownLeft, Undo2, Image as ImageIcon } from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/agent`;

type Conversation = {
  id: number; draft_id: number | null; title: string;
  message_count?: number; created_at?: string; updated_at?: string;
};
type Attachment = { kind: "file" | "chapter"; name: string; size: number; content: string; truncated?: boolean; chapterOrder?: number; docId?: number; chapterCount?: number };
type Message = { id?: number; role: "user" | "assistant" | "system"; content: string; pending?: boolean; operation?: AgentOperation; group_id?: number | null; version?: number; attachedOrder?: number | null;
  // 这条用户消息随附的图片（2026-10-28）。历史回放从后端 messages[].images 来，
  // 刚发出去那一下用本地预览（localUrl），免得再拉一遍。
  images?: MessageImage[];
  // 挂在这条助手消息上的体检报告卡(后端 agent_messages.report_json)。
  // 落库的好处: 刷新页面/换设备回来还能看到上次体检的卡片, 不用重新体检一遍。
  report?: CheckReport | null;
  // 这条报告对应的修复结果(修前→修后的数字), 只存在内存里 —— 它是"这一次操作"
  // 的结果, 不是消息的固有属性, 刷新后重跑复检也没意义(报告已经变了)。
  fix?: FixResult | null;
};
// 精修/生成的**改前→改后对照**（GET /v1/agent/jobs/{id}/changes）。
// 数据来自 script_episode_history（每集被覆写前的原文）与当前内容，逐集列出。
// 用户明确要求的形式：左右并排的文本块，左边原文、右边改后。
type RewriteDiffItem = {
  episode: number; stage: string; stage_label: string;
  before: string; after: string;
  before_chars: number; after_chars: number;
  truncated: boolean; changed: boolean;
};
type RewriteDiff = {
  items: RewriteDiffItem[]; total: number; changed_total: number;
  job_id: number; kind: string; status: string; note?: string;
  result?: { scope_label?: string; applied_eps?: number; rewrite_job_id?: number } | null;
};

// 问答版本组: 编辑重发后同一槽位的多个版本 (v1/v2...), active=当前显示版本
type QaGroup = { versions: number[]; active: number | null };
type DraftBrief = { id: number; title: string };
// source: "script"=草稿剧本(分镜), "chapter"=草稿章节(小说正文)。优先剧本, 剧本为空才用章节。
// locked: 该集在库里的锁位, 仅作展示/调试用 —— **两种锁都不再拦一键替换**,
// 理由见 ReplaceChip 里的注释。
type ChapterBrief = { chapter_order: number; title: string; full_text: string; source: "script" | "chapter"; locked?: boolean };
// 对话模式 (单选): 后端 /v1/agent/modes 返回 key/label/desc, 选中后把对应
// 隐藏提示词框架注入 system prompt (框架对用户不可见)。
type ChatMode = { key: string; label: string; desc: string };
// 可选模型: 由后端 /v1/agent/models 现算下发(model 是真正调用的模型 id,
// label 是它的展示写法)。**不要**在前端写死型号 —— 换 env 后这里会自动跟着变。
type ChatModel = { provider: string; model: string; label: string };
// 生成参数的取值区间, 同样由后端下发, 前端只负责画滑块
type ParamSpec = { default: number; min: number; max: number; step: number };
type ParamSpecs = { temperature: ParamSpec; top_p: ParamSpec; history_turns: ParamSpec };
type GenParams = { temperature: number; top_p: number; history_turns: number };

// 发送框下方原有的「自动精修 / 讨论」开关已删除 —— 它和输入框上方动作栏的「改 · 精修这批」
// 是同一件事的两个入口，用户看到两个开关会以为它们不一样。现在意图只有一个可见的落点：
// 动作栏。想整本精修就点「精修这批」（范围留空 = 整本），想聊就直接打字。

// 接口拿不到时的兜底: 只写厂商名(不带型号), 型号未知就不显示, 免得报错误的版本号
const FALLBACK_MODELS: ChatModel[] = [
  { provider: "gemini", model: "", label: "Gemini" },
  { provider: "deepseek", model: "", label: "DeepSeek" },
  { provider: "gpt5", model: "", label: "GPT" },
  { provider: "grok", model: "", label: "Grok" },
];
// 与后端 routes.py 的 CHAT_TEMP_DEFAULT / CHAT_HISTORY 等保持一致的兜底
const FALLBACK_SPECS: ParamSpecs = {
  temperature: { default: 0.6, min: 0, max: 1.5, step: 0.1 },
  top_p: { default: 1, min: 0.1, max: 1, step: 0.05 },
  history_turns: { default: 10, min: 1, max: 50, step: 1 },
};
// 上下文轮数的"不限"哨兵值(与后端 CHAT_HISTORY_UNLIMITED 一致):
// 传 0 = 整段历史全带上, 不做任何截断。UI 上由"滑块拖到最右一格"产生,
// 不再是独立复选框 —— 见 HistoryTurnsSlider。
const HISTORY_UNLIMITED = 0;
const GEN_PARAMS_KEY = "drama_chat_gen_params";

function specsToParams(sp: ParamSpecs): GenParams {
  return {
    temperature: sp.temperature.default,
    top_p: sp.top_p.default,
    history_turns: sp.history_turns.default,
  };
}

function clampNum(v: number, spec: ParamSpec): number {
  if (!Number.isFinite(v)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, v));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function ChatStudioPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [convs, setConvs] = useState<Conversation[]>([]);
  /**
   * `convs` 的最新值（给 openDraft 用）。
   *
   * 为什么需要它：`openDraft` 是 `useCallback([])` —— 它只在首次渲染时创建一次，
   * 闭包里的 `convs` 永远是最初的空数组。若直接读闭包变量，那么**每次**打开一部
   * 已有会话的草稿都会走"列表里没找到 → 新建会话"那条路，
   * 同一部剧点几次就攒出几个"新对话"。
   */
  const convsRef = useRef<Conversation[]>([]);
  const [convError, setConvError] = useState<string | null>(null);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [rightTab, setRightTab] = useState<"drafts" | "settings">("drafts");
  // 上下文压缩（由设置面板写入）。
  const [compactionOn, setCompactionOn] = useState(true);

  useEffect(() => {
    try {
      setCompactionOn(localStorage.getItem("chat_studio_compaction") !== "0");
    } catch { /* 忽略 */ }
    const onPrefs = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (typeof d.compaction === "boolean") setCompactionOn(d.compaction);
    };
    window.addEventListener("chat-studio-prefs", onPrefs);
    return () => window.removeEventListener("chat-studio-prefs", onPrefs);
  }, []);
  const [drafts, setDrafts] = useState<DraftBrief[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [splitDraftId, setSplitDraftId] = useState<number | null>(null);
  const [loadingConvs, setLoadingConvs] = useState(true);
  /** 会话总数（后端 with_total 给的）。侧栏显示"共 N 个"用它 —— 显示 `convs.length`
   *  会在分页下变成"共 50 个"，看着像全部，正是用户以为"只保留 50 条"的来源。 */
  const [convsTotal, setConvsTotal] = useState(0);
  /** 还有没有下一页（后端按 offset+len < total 算）。 */
  const [hasMoreConvs, setHasMoreConvs] = useState(false);
  const [loadingMoreConvs, setLoadingMoreConvs] = useState(false);
  // ── 动作栏(对话工坊 v3) ──
  // scope: 精修/修复的范围。用户圈了范围就只改这几集, 空 = 整本。
  const [scope, setScope] = useState<ActionScope>({ start_ep: null, end_ep: null, target: 'storyboard' });
  // 正在跑的修复作业(卡片上转圈用)。与 polishJob 分开: 两者可以前后脚发生,
  // 共用一个状态会让"精修跑完后修复的转圈被清掉"。
  const [fixJob, setFixJob] = useState<number | null>(null);
  const fixJobRef = useRef<number | null>(null);
  // 这次修复改的是哪份报告 —— 修完把 before→after 挂回那张卡片上。
  const [fixTarget, setFixTarget] = useState<number | null>(null);
  // 修完的 before→after 必须扛过 refreshMessages。消息刷新是**整条替换**(服务端没有
  // 存"这次修得怎么样"——它描述的是一次操作, 不是一条消息), 所以刷新后本地那张卡会
  // 当场丢掉 before→after, 用户刚看到的"12 → 7"闪一下就不见了。按 report_id 存在
  // ref 里, 刷新时再贴回去。
  const fixResultRef = useRef<Map<number, FixResult>>(new Map());
  // 注：这里曾有一个 pendingAction state（"按钮把一句话填进输入框、等用户按发送"的
  // 中间态）。2026-09 起所有动作按钮（动作栏 / 生成下拉 / 报告卡修复）都是**点击即发**，
  // 结构化意图直接作为 send() 的第二个参数传下去，这个中间态没有存在的理由了。

  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  /** 待发图片（粘贴 / 拖入 / 点选）。上传在加入的那一刻就开始，发送时只带 id。 */
  const pimg = usePendingImages(activeConv?.id ?? null, notifyError);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** 把文件拖到对话区：图片进待发条，文档走原来的解析入库（acceptFiles 是函数声明，已提升）。 */
  const drop = useDropZone((fs) => acceptFiles(fs));
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  // 问答版本组元数据 (group_id -> {versions, active}), 来自 GET /conversations/{id} 的 groups
  const [qaGroups, setQaGroups] = useState<Record<string, QaGroup>>({});
  // 编辑已发消息: 正在编辑的消息下标 + 编辑框内容
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const [chapters, setChapters] = useState<ChapterBrief[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  // 对话模式 (单选): 选中后把对应隐藏提示词框架注入后台 system prompt
  const [modes, setModes] = useState<ChatMode[]>([]);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  // 模型选择: 取值来自后端 /models。从 2026-09-09 起是 "厂商:型号" 编码串
  // (如 "gemini:gemini-3.8-flash"), 老的纯厂商值("gemini")仍然合法 = 该厂商默认型号,
  // 所以 localStorage 里存着旧值的用户不会被卡住。记忆到 localStorage。
  const [provider, setProvider] = useState<string>("gemini");
  const [models, setModels] = useState<ChatModel[]>(FALLBACK_MODELS);
  // 分厂商分组的型号清单(带实测"稳"标), 后端现算下发; 空数组时下拉退回 models 扁平表
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [paramSpecs, setParamSpecs] = useState<ParamSpecs>(FALLBACK_SPECS);
  // 生成参数(温度/top_p/上下文轮数): 每次发消息随请求下发, 后端真下发给模型
  const [genParams, setGenParams] = useState<GenParams>(() => specsToParams(FALLBACK_SPECS));
  // 输入框旁边的两个弹出层(模型下拉 / 参数面板), 同时只开一个
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showParamMenu, setShowParamMenu] = useState(false);
  /**
   * 右栏产物面板的刷新信号（B11）。
   *
   * ## 从 iframe 改成组件之后，这个信号变简单了
   * 之前右栏是 iframe，所以"数据变了"要跨文档传：`postMessage` +
   * 草稿页里的 message 监听。现在面板是同一棵树里的组件，
   * **一个自增的数字就够了** —— 面板把它放进 effect 依赖，变化即重拉。
   * 少了跨文档协议这一层，也就少了一类"消息格式对不上、静默不刷新"的故障。
   */
  const [draftRefreshKey, setDraftRefreshKey] = useState(0);
  function notifyDraftUpdated(_kind?: string, _order?: number | null) {
    setDraftRefreshKey((k) => k + 1);
  }
  // 每条 AI 回复的"段落点选"状态: 消息下标 → {段落下标 → 是否写入}。
  // 只存用户**手动改过**的段, 没改过的跟随自动判断(见 replaceDetect.segmentReply)。
  const [segPicks, setSegPicks] = useState<Record<number, Record<number, boolean>>>({});
  function toggleSeg(msgIdx: number, segIdx: number, cur: boolean) {
    setSegPicks((prev) => ({
      ...prev,
      [msgIdx]: { ...(prev[msgIdx] || {}), [segIdx]: !cur },
    }));
  }
  const composerBarRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem("drama_chat_provider");
      if (v) setProvider(v);
      const raw = localStorage.getItem(GEN_PARAMS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setGenParams((prev) => ({
          temperature: typeof saved.temperature === "number" ? saved.temperature : prev.temperature,
          top_p: typeof saved.top_p === "number" ? saved.top_p : prev.top_p,
          history_turns: typeof saved.history_turns === "number" ? saved.history_turns : prev.history_turns,
        }));
      }
    } catch { /* noop */ }
  }, []);
  function changeProvider(v: string) {
    setProvider(v);
    try { localStorage.setItem("drama_chat_provider", v); } catch { /* noop */ }
  }
  function patchParams(patch: Partial<GenParams>) {
    setGenParams((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(GEN_PARAMS_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }
  function resetParams() {
    const next = specsToParams(paramSpecs);
    setGenParams(next);
    try { localStorage.setItem(GEN_PARAMS_KEY, JSON.stringify(next)); } catch { /* noop */ }
  }
  // 当前选中的型号(分组清单优先); 分组拿不到时退回旧的扁平厂商表
  const currentItem = useMemo(
    () => modelGroups.flatMap((g) => g.models).find((m) => m.value === provider),
    [modelGroups, provider],
  );
  const currentModel = models.find((m) => m.provider === provider.split(":")[0]) || models[0];
  const currentLabel = currentItem?.label || currentModel?.label || provider;

  // 参数是否被改过(非默认): 用于在设置按钮上点一个小圆点提示
  const paramsDirty = useMemo(() => {
    const d = specsToParams(paramSpecs);
    return genParams.temperature !== d.temperature
      || genParams.top_p !== d.top_p
      || genParams.history_turns !== d.history_turns;
  }, [genParams, paramSpecs]);

  // 点空白处关掉模型/参数弹层(和右上角草稿菜单一样的交互习惯)
  useEffect(() => {
    if (!showModelMenu && !showParamMenu) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (composerBarRef.current?.contains(t)) return;
      // 模型菜单是 portal 到 body 的(要盖住弹窗/滚动容器), 不在 composerBar 里。
      // 不排除掉它, mousedown 会先把菜单关掉, 后面的 click 落不到型号上 = 选不中。
      if ((t as HTMLElement)?.closest?.('[role="menu"]')) return;
      setShowModelMenu(false);
      setShowParamMenu(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showModelMenu, showParamMenu]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 版本切换等"原位更新"场景不应把页面滚到底部; 置 true 则跳过下一次自动滚动
  const suppressAutoScrollRef = useRef(false);
  // 「自动精修」当前盯着的作业号。精修是几十集的长任务, 这里只用来:
  //   ① 卡住重复发送（跑着的时候不让再发一条, 否则后端会拒、用户白等一次往返）
  //   ② 跑完后刷新消息（后端会把最终结果回填到那条助手消息里）
  const polishJobRef = useRef<number | null>(null);
  const [polishJob, setPolishJob] = useState<number | null>(null);

  // 生成作业（大纲/正文/剧本）。与精修同一个队列、同一套轮询，但用途不同：
  //   · 用户点「生成」后必须**立刻看到进度**（生成正文要几十分钟，没有进度条
  //     用户只能反复刷新页面或以为死了）—— 这就是用户报的"发起精修后不显示进度"。
  //   · 跑完要刷新内容，并在对话里就地给出改前/改后对照（见 changes 那段）。
  const genJobRef = useRef<number | null>(null);
  const [genJob, setGenJob] = useState<{
    id: number; kind: string; genKind: string | null;
    progress: number | null; note: string | null; status: string;
  } | null>(null);
  const [genDiff, setGenDiff] = useState<RewriteDiff | null>(null);

  // 去 AI 味作业（动作栏的「去 AI 味」）。**与上面三种都不同**：
  //   · 精修/修复会**覆写草稿**，去 AI 味只出一份**独立清洗稿**（DeaiJob.per_ep_json），
  //     草稿一个字节都不动 —— 所以跑完**不需要** notifyDraftUpdated()，分屏不用重拉。
  //   · 它也不走 /v1/agent/jobs（那是 RewriteJob/AgentJob 的表），作业号在
  //     **DeaiJob** 里。前端收到的是独立事件类型 "deai"（见后端 _stream_deai 的注释：
  //     复用 "job" 事件会让前端去拉 /jobs/{id}/changes，必然 404）。
  //   · 进度/结果去 /v1/deai/{id} 拿。这是一份"看得见但不用接管"的东西：
  //     用户想看逐集对照就去「去 AI 味工作室」，在对话里只需要知道它跑到哪了。
  const deaiJobRef = useRef<number | null>(null);
  const [deaiJob, setDeaiJob] = useState<DeaiJobView | null>(null);
  // 历史消息里出现过的去 AI 味作业号 → 卡片数据。为什么要这个：
  //   ① 刷新页面后顶栏那个胶囊没了（它只是"本次会话正在跑"的状态），但对话历史里
  //      那条"已启动去 AI 味 #7"还在 —— 没有卡片，它就是一句死文字，看不出跑没跑完。
  //   ② 用户上次用是三天前，回来想看看洗得怎么样 —— 卡片应当是终态而不是转圈。
  // 所以按作业号懒加载一次，存进 Map（终态不再重拉）。
  const [deaiCards, setDeaiCards] = useState<Record<number, DeaiJobView>>({});
  const deaiFetchedRef = useRef<Set<number>>(new Set());

  // 输入框随内容自动增高: 最小约 2 行, 最大 260px(约 10 行)后内部滚动, 不占满屏幕。
  const INPUT_MAX_H = 260;
  function autoResizeInput() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";                       // 先归零才能正确测量 scrollHeight
    el.style.height = Math.min(el.scrollHeight, INPUT_MAX_H) + "px";
    el.style.overflowY = el.scrollHeight > INPUT_MAX_H ? "auto" : "hidden";
  }
  // input 变化(含发送后清空/引用回填)后同步高度
  useEffect(() => { autoResizeInput(); }, [input]);

  useEffect(() => {
    if (!getUser()) {
      window.location.href = "/jubengongfang/login?from=" + encodeURIComponent("/chat-studio");
      return;
    }
    setAuthed(true);
    setAuthChecked(true);
  }, []);

  useEffect(() => { if (authed) { void loadConvs(); void loadDrafts(); void loadModes(); void loadModels(); } }, [authed]);


  async function loadModels() {
    try {
      const r = await authFetch(`${API}/models`);
      if (!r.ok) return;                      // 拿不到就继续用 FALLBACK_MODELS, 不阻塞聊天
      const d = await r.json();
      const items: ChatModel[] = d.items || [];
      const groups: ModelGroup[] = d.groups || [];
      if (groups.length > 0) {
        setModelGroups(groups);
        // 把记忆的选择对齐到当前清单: 老的纯厂商值升级成带型号的默认值,
        // 型号已下架的退回该厂商默认 —— 否则会出现"显示着旧型号、实际被后端换掉"
        setProvider((cur) => resolveModelValue(cur, { groups, defaults: d.defaults || {} }));
      }
      if (items.length > 0) {
        setModels(items);
        // 记忆的 provider 已被后端下线时回落到默认, 避免请求被静默改成 gemini 却还显示旧名
        // (只在没有分组清单时兜底: 有分组清单时上面已经对齐过了)
        if (groups.length === 0) {
          setProvider((cur) => (items.some((m) => m.provider === cur)
            ? cur : (d.default_provider || items[0].provider)));
        }
      }
      if (d.params?.temperature && d.params?.top_p && d.params?.history_turns) {
        const sp: ParamSpecs = d.params;
        setParamSpecs(sp);
        // 后端区间变了(或本地存着越界的旧值)时把已保存的参数夹回来
        setGenParams((prev) => ({
          temperature: clampNum(prev.temperature, sp.temperature),
          top_p: clampNum(prev.top_p, sp.top_p),
          // 0 = 不限, 是合法值, 不能被夹到 min
          history_turns: prev.history_turns === HISTORY_UNLIMITED
            ? HISTORY_UNLIMITED
            : Math.round(clampNum(prev.history_turns, sp.history_turns)),
        }));
      }
    } catch { /* noop */ }
  }

  async function loadModes() {
    try {
      const r = await authFetch(`${API}/modes`);
      if (r.ok) {
        const d = await r.json();
        setModes(d.items || []);
      }
    } catch {}
  }
  useEffect(() => {
    if (suppressAutoScrollRef.current) { suppressAutoScrollRef.current = false; return; }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 动作栏"范围"下拉需要知道这部剧一共有多少集。不从 chapters 推 —— chapters 走的是
  // "剧本优先、剧本空才回退正文"的二选一逻辑, 而且只装**已生成**的集: 一部还没生成
  // 正文的草稿 chapters 为空, 用户就没法选"第 1-3 集"了, 可他恰恰最需要在这个阶段
  // 圈范围去生成。所以直接问草稿本身(大纲集数 → 剧本集数 → 正文集数, 取最大的那个)。
  const [epCount, setEpCount] = useState<number | null>(null);
  useEffect(() => {
    const did = activeConv?.draft_id;
    if (!did) { setEpCount(null); return; }
    let alive = true;
    void (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${did}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        const outlineEps = (d.outline?.episodes || d.outline?.chapters || []) as any[];
        const n = Math.max(
          outlineEps.length,
          (d.storyboards || []).length,
          (d.chapters || []).length,
        );
        setEpCount(n > 0 ? n : null);
      } catch { /* 取不到就不给下拉, 范围按钮仍可显示"整本" */ }
    })();
    return () => { alive = false; };
  }, [activeConv?.draft_id]);

  // 加载关联草稿的可引用内容 (用于"引用"附件)。
  // 优先关联「草稿剧本」(storyboards/分镜): 把每集 shots_json 拼成可读全文;
  // 只有剧本全为空时, 才回退到「草稿章节」(chapters/小说正文)。
  //
  // 历史坑位(勿回退): 曾用同一个 chapters 列表同时充当"引用素材"和"锁状态来源",
  // 而 chapters 是二选一的 —— 导入类草稿装的是原文且入库即 locked=1, 此时尚无剧本,
  // 于是"替换→剧本"读到了原文的锁, 按钮被误置灰(用户实测到的正是这条)。
  // 现在两种锁都不参与替换判定(见 ReplaceChip), 该串台已无从发生。
  useEffect(() => {
    const did = activeConv?.draft_id;
    if (!did) { setChapters([]); return; }
    void (async () => {
      try {
        // 1) 先尝试草稿剧本
        let scripts: ChapterBrief[] = [];
        const sr = await authFetch(`${BASE}/v1/stages/drafts/${did}/storyboards`);
        if (sr.ok) {
          const sdata = await sr.json();
          const slist = Array.isArray(sdata) ? sdata : (sdata.items || []);
          scripts = slist.map((s: any) => {
            const shots = (s.shots_json || s.shots || []) as Shot[];
            return {
              chapter_order: s.chapter_order ?? s.order ?? 0,
              title: s.title || `第 ${s.chapter_order || 0} 集`,
              full_text: shotsToText(Array.isArray(shots) ? shots : []),
              source: "script" as const,
              locked: !!s.locked,
            };
          }).filter((c: ChapterBrief) => c.full_text.trim());
        }

        if (scripts.length > 0) {
          scripts.sort((a, b) => a.chapter_order - b.chapter_order);
          setChapters(scripts);
          return;
        }
        // 2) 剧本为空 → 引用素材回退到草稿章节(这里才需要 full_text)
        const r = await authFetch(`${BASE}/v1/stages/drafts/${did}/chapters`);
        if (!r.ok) { setChapters([]); return; }
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.items || []);
        setChapters(list.map((c: any) => ({
          chapter_order: c.chapter_order ?? c.order ?? 0,
          title: c.title || `第 ${c.chapter_order || 0} 章`,
          full_text: c.full_text || c.content || "",
          source: "chapter" as const,
          locked: !!c.locked,
        })).filter((c: ChapterBrief) => c.full_text));
      } catch { setChapters([]); }
    })();
  }, [activeConv?.draft_id]);

  async function loadConvs() {
    setLoadingConvs(true);
    setConvError(null);
    setConvsTotal(0);
    try {
      const r = await authFetch(`${API}/conversations?limit=50&offset=0&with_total=true`);
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        setConvError(`HTTP ${r.status}: ${t.slice(0, 200)}`);
        return;
      }
      const data = await r.json();
      const list: Conversation[] = Array.isArray(data) ? data : (data.items || []);
      setConvs(list);
      setConvsTotal(Array.isArray(data) ? list.length : Number(data.total || list.length));
      setHasMoreConvs(Array.isArray(data) ? false : !!data.has_more);
      // 供 openDraft 读"最新一次列表" —— 它要按 draft_id 找已有会话。
      // 用 ref 而不是闭包里的 convs: 深链 effect 只跑一次, 读到的会是首次渲染的
      // 空数组, 于是对已有草稿也新建会话。
      convsRef.current = list;
    } catch (e: any) {
      setConvError(`加载失败: ${e?.message || e}`);
    } finally {
      setLoadingConvs(false);
    }
  }

  /**
   * 侧栏滚到底时再拉一页（每页 50）。
   *
   * ## 为什么要它（2026-10-26 用户反馈）
   * 以前只拉一次 `limit=50` 就完事，第 51 个往后的会话在界面上**根本不存在** ——
   * 用户以为是"只保留 50 条、更早的被删了"。数据一条没删，只是没被列出来。
   *
   * ## 三处必须守住
   * 1. **append 而不是 replace**：`setConvs(list)` 会把已加载的整段冲掉，
   *    表现是"往下滚，上面的会话突然没了"。
   * 2. **按 id 去重**：翻页用 offset 切，但 `updated_at` 会因作业回填而变动，
   *    排序键不稳时同一条可能出现在两页里 —— 重复的 key 会让 React 渲染错行。
   * 3. **`convsRef` 同步**：openDraft 靠它判断"这部草稿有没有会话"，
   *    不同步的话，只在第二页出现的草稿仍会被判成"没有会话"而新建一个空会话。
   */
  const loadMoreConvs = useCallback(async () => {
    if (loadingMoreConvs || !hasMoreConvs) return;
    setLoadingMoreConvs(true);
    try {
      const r = await authFetch(`${API}/conversations?limit=50&offset=${convsRef.current.length}&with_total=true`);
      if (!r.ok) return;
      const data = await r.json();
      const page: Conversation[] = Array.isArray(data) ? data : (data.items || []);
      const seen = new Set(convsRef.current.map((c) => c.id));
      const merged = [...convsRef.current, ...page.filter((c) => !seen.has(c.id))];
      setConvs(merged);
      convsRef.current = merged;
      if (!Array.isArray(data)) setHasMoreConvs(!!data.has_more);
      else setHasMoreConvs(false);
    } catch { /* 滚动加载失败不打断：用户再滚一次就重试，不弹错 */ }
    finally {
      setLoadingMoreConvs(false);
    }
  }, [loadingMoreConvs, hasMoreConvs]);

  /**
   * 一次把剩下的全拉下来（搜索用）。
   *
   * 搜索是在已加载的 `convs` 里过滤的，所以只要还有没加载的页，老对话就搜不到。
   * 这里循环拉到底为止，页数上限兜底防止后端异常时死循环。
   */
  const loadAllConvs = useCallback(async () => {
    setLoadingMoreConvs(true);
    try {
      let merged = convsRef.current;
      let guard = 0;
      while (guard++ < 40) {
        const r = await authFetch(`${API}/conversations?limit=50&offset=${merged.length}&with_total=true`);
        if (!r.ok) break;
        const data = await r.json();
        const page: Conversation[] = Array.isArray(data) ? data : (data.items || []);
        if (!page.length) { setHasMoreConvs(false); break; }
        const seen = new Set(merged.map((c) => c.id));
        const add = page.filter((c) => !seen.has(c.id));
        merged = [...merged, ...add];
        // 后端说没有下一页、或这一页没带来任何新行（排序键不稳导致的重叠）就停
        if (Array.isArray(data) ? false : !data.has_more) { setHasMoreConvs(false); break; }
        if (!add.length) { setHasMoreConvs(false); break; }
        if (!Array.isArray(data) && page.length < 50) { setHasMoreConvs(false); break; }
      }
      setConvs(merged);
      convsRef.current = merged;
    } catch { /* 拉不全就按已加载的搜，不弹错 */ }
    finally {
      setLoadingMoreConvs(false);
    }
  }, []);

  async function loadDrafts() {
    try {
      // ⚠️ 必须带 all=true。后端默认只返 50 条（`limit: int = Query(50)`），
      // 而这份清单有**两个**用途，其中一个是判断"某部草稿在不在列表里"：
      //   · 右栏草稿选择器 —— 只列最近 50 部，够用；
      //   · `?draft=<id>` 深链的存在性校验 —— **不够用**：
      //     草稿超过 50 部的用户（生产 446 用户 / 单用户上百部很常见）从工作台
      //     点「质量」过来时会因为"列表里没有它"被判为无效，表现是**链接点了没反应**，
      //     而且不报错、静默留在当前视图。
      const r = await authFetch(`${BASE}/v1/stages/drafts?all=true`);
      if (r.ok) {
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.items || []);
        setDrafts(list.map((d: any) => ({ id: d.id, title: d.title || "未命名" })));
      }
    } catch {}
    finally {
      // 无论成功失败都置位：失败时停在"没消费深链"是更好的失败方式 ——
      // 用户看到的是一个正常的对话工坊，而不是一个莫名被清空的参数。
      draftsLoadedRef.current = true;
    }
  }

  async function loadConv(id: number) {
    const r = await authFetch(`${API}/conversations/${id}`);
    if (!r.ok) return;
    const data = await r.json();
    const conv = { id: data.id, draft_id: data.draft_id, title: data.title, created_at: data.created_at };
    setActiveConv(conv);
    setEditingIdx(null);
    setMessages((data.messages || []).map((m: any) => ({ id: m.id, role: m.role, content: m.content, group_id: m.group_id, version: m.version, report: m.report || null, images: m.images || [] })));
    setQaGroups(data.groups || {});
    if (conv.draft_id) setSplitDraftId(conv.draft_id);
    // 恢复"精修正在跑"的状态。作业号只存在内存里, 刷新页面就没了 —— 用户刷新后
    // 既看不到顶栏的进度提示, 也拿不到"跑完自动刷新"的轮询, 只能干等或反复重发
    // (重发会被后端拒, 又白等一次往返)。所以打开会话时按草稿查一次在跑的作业。
    // 失败静默: 这只是恢复展示, 拿不到就退化成"没有提示", 不该影响看对话。
    void (async () => {
      if (!conv.draft_id) return;
      try {
        const jr = await authFetch(`${API}/jobs?draft_id=${conv.draft_id}&limit=10`);
        if (!jr.ok) return;
        const jd = await jr.json();
        const running = (jd.items || []).find(
          (j: any) => (j.kind === "rewrite_script" || j.kind === "deai_apply") && ["queued", "running"].includes(j.status));
        if (running) { polishJobRef.current = running.id; setPolishJob(running.id); }
      } catch { /* 见上：拿不到就不提示 */ }
    })();
    const opR = await authFetch(`${API}/operations?conversation_id=${id}&limit=200`);
    if (opR.ok) {
      const opData = await opR.json();
      const opsByMsg: Record<number, AgentOperation> = {};
      for (const op of (opData.items || [])) if (op.message_id) opsByMsg[op.message_id] = op;
      setMessages((prev) => prev.map((m) => m.id && opsByMsg[m.id] ? { ...m, operation: opsByMsg[m.id] } : m));
    }
  }

  async function newConv(draftId: number | null = null) {
    const r = await authFetch(`${API}/conversations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, title: "新对话" }),
    });
    if (r.ok) {
      const data = await r.json();
      await loadConvs();
      await loadConv(data.id);
    }
  }

  async function deleteConv(c: Conversation) {
    if (!(await confirmAsync({ title: `删除「${c.title}」`, tone: "danger", confirmText: "删除" }))) return;
    await authFetch(`${API}/conversations/${c.id}`, { method: "DELETE" });
    if (activeConv?.id === c.id) { setActiveConv(null); setMessages([]); }
    await loadConvs();
  }

  async function rename(c: Conversation, t: string) {
    if (!t.trim() || t === c.title) { setRenamingId(null); return; }
    await authFetch(`${API}/conversations/${c.id}/title`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t.slice(0, 120) }),
    });
    if (activeConv?.id === c.id) setActiveConv({ ...activeConv, title: t });
    setRenamingId(null);
    await loadConvs();
  }

  // 取消当前会话与草稿的关联 → 变成通用 AI 对话; 同时关闭分屏
  async function unassignDraft() {
    if (!activeConv) return;
    const r = await authFetch(`${API}/conversations/${activeConv.id}/draft`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: null }),
    });
    if (r.ok) {
      setActiveConv({ ...activeConv, draft_id: null });
      setSplitDraftId(null);
      setShowAttachMenu(false);
      await loadConvs();
    }
  }

  // 把**当前会话**就地关联到一部草稿（不新建会话、不切会话、不动消息）。
  // 与 openDraft 的区别很重要：openDraft 是"去那部剧的对话"——它会切到该草稿已有的
  // 会话、没有就新建一个，当前聊到一半的内容就留在原会话里了。
  // 而"我刚聊出一段正文，想存进第 3 集"这个场景必须留在原地：所以走 PATCH。
  async function linkDraftToConv(draftId: number): Promise<boolean> {
    if (!activeConv) return false;
    try {
      const r = await authFetch(`${API}/conversations/${activeConv.id}/draft`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_id: draftId }),
      });
      if (!r.ok) return false;
      setActiveConv({ ...activeConv, draft_id: draftId });
      setSplitDraftId(draftId);
      await loadConvs();
      return true;
    } catch { return false; }
  }

  /**
   * 打开某部草稿的会话（有就切过去、没有就新建）。
   *
   * 用 useCallback 稳定引用：`?draft=` 深链的 effect 依赖它，
   * 每次渲染都换一个函数引用会让那个 effect 反复重跑。
   */
  const openDraft = useCallback(async (draftId: number) => {
    setSplitDraftId(draftId);
    const matched = convsRef.current.filter((c) => c.draft_id === draftId);
    if (matched.length > 0) {
      const sorted = [...matched].sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""));
      await loadConv(sorted[0].id);
    } else {
      const r = await authFetch(`${API}/conversations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft_id: draftId, title: "新对话" }),
      });
      if (r.ok) {
        const data = await r.json();
        await loadConvs();
        await loadConv(data.id);
      }
    }
  }, []);

  /**
   * 深链：`/chat-studio?draft=<id>` —— 从草稿工作台的「质量」按钮进来时带上当前草稿。
   *
   * ## 为什么要这个
   * 去味/精修/体检按裁定统一收归对话工坊，工作台只留一个跳转按钮。
   * 但如果跳过来之后**还要用户自己再选一次剧**，那这个入口就是把一件麻烦事
   * 从 A 页搬到了 B 页 —— 用户抱怨的"在几个页面之间来回跳"并没解决。
   *
   * ## 为什么要等 `loadingConvs` 落地
   * `openDraft` 会先按 draft_id 找已有会话，找到就切过去、没有才新建。
   * 列表还没到手时调用，会对每一部已有草稿都走"新建会话"——
   * 同一部剧点几次「质量」就攒出几个「新对话」。
   *
   * ## 为什么用 ref 而不是把 convs 放进依赖数组
   * `convs` 之后每次变更（切会话、重命名、发消息）都会让依赖变化、effect 重跑，
   * 那会把刚手动切到别的会话的用户又拽回这部草稿。`deepLinkDone` 保证只消费一次。
   */
  const deepLinkDone = useRef(false);
  /**
   * `loadDrafts` 是否已经跑完一次。
   *
   * ⚠️ 不能只等 `loadingConvs`：它是**会话列表**的加载态，而存在性校验用的是
   * `drafts`（另一个请求，两者并发发出、先后不定）。会话列表先回来时
   * `drafts` 还是空数组 → "列表里没有这部草稿" 成立 → 深链被静默判为无效。
   * 表现是"点了没反应"，且不报错、极难排查。所以两个加载态都要等。
   */
  const draftsLoadedRef = useRef(false);
  useEffect(() => {
    if (!authed || loadingConvs || !draftsLoadedRef.current || deepLinkDone.current) return;
    const raw = new URLSearchParams(window.location.search).get("draft");
    if (!raw) { deepLinkDone.current = true; return; }
    const want = Number(raw);
    if (!Number.isInteger(want) || want <= 0) { deepLinkDone.current = true; return; }
    // 列表里没有这部草稿（如已进回收站 / 别人的）时不凭空造会话，静默留在当前视图。
    if (!drafts.some((d) => d.id === want)) { deepLinkDone.current = true; return; }
    deepLinkDone.current = true;
    void openDraft(want);
    // 参数消费掉就从地址栏摘掉：否则刷新或分享链接时会被反复拽回同一部剧。
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("draft");
      window.history.replaceState({}, "", u.toString());
    } catch { /* 隐私模式下拿不到 URL 也无妨，只是参数留着 */ }
  }, [authed, loadingConvs, drafts, openDraft]);

  // ===== 附件: 上传文件 =====
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadDocFile(file);
  }

  /** 拖拽 / 粘贴 / 文件选择三个入口共用：图片走图片通道，其余走文档解析。 */
  function acceptFiles(files: File[]) {
    const imgs = files.filter(isImageFile);
    const docs = files.filter((f) => !isImageFile(f));
    if (imgs.length) pimg.add(imgs);
    for (const d of docs) {
      if (/\.(txt|md|markdown|docx|pdf)$/i.test(d.name)) void uploadDocFile(d);
      else notifyError(`「${d.name}」不是支持的格式（图片或 .txt/.md/.docx/.pdf）`);
    }
  }

  async function uploadDocFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      alert("文件超过 10MB 上限");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // 2026-10-10：长文档改为**落盘 + 每轮按需取用**，不再把全文塞进消息。
      // 走这条路径时后端返回 content=""、只给 document_id；正文由后端按用户
      // 点名的章号检索注入。原因是实测 40 万字原文约第 33~35 轮会被剪成占位符、
      // 第 38 轮彻底滑出窗口，模型随后开始自己编（用户报的"40 轮后瞎写"）。
      fd.append("persist", "true");
      if (activeConv?.id) fd.append("conversation_id", String(activeConv.id));
      if (activeConv?.draft_id != null) fd.append("draft_id", String(activeConv.draft_id));
      const token = getToken();
      const r = await fetch(`${API}/parse-file`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: fd,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        alert(`上传失败: HTTP ${r.status} ${t.slice(0, 200)}`);
        return;
      }
      const data = await r.json();
      setPendingAttachments((prev) => [...prev, {
        kind: "file", name: data.filename || file.name,
        size: data.size || file.size, content: data.content || "",
        truncated: !!data.truncated,
        docId: data.document_id, chapterCount: data.chapter_count,
      }]);
    } catch (err: any) {
      alert(`上传失败: ${err?.message || err}`);
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function attachChapter(ch: ChapterBrief) {
    const unit = ch.source === "script" ? "集" : "章";
    setPendingAttachments((prev) => [...prev, {
      kind: "chapter", name: `第 ${ch.chapter_order} ${unit} · ${ch.title}`,
      size: ch.full_text.length, content: ch.full_text,
      // 记住集号: 一键替换在推断不出集号时用它兜底(用户引用了哪集, 多半就想改哪集)
      chapterOrder: ch.chapter_order,
    }]);
    setShowAttachPicker(false);
  }

  function removeAttachment(idx: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // ===== 发消息 =====
  // 动作栏的三个动作(check/fix/rewrite)走同一条 send, 只是多带结构化字段。
  // 前端**不自己判断该调哪个接口** —— 它只是把 action/kinds/scope/issue_ids 原样带上,
  // 由后端 send_message 收口。这样按钮和手打不会出现"手打能用、点按钮不能用"的裂缝。
  type ActionPayload = {
    action: "check" | "fix" | "rewrite" | "generate" | "deai";
    kinds?: string[];
    issue_ids?: string[];
    report_id?: number;
    scope?: ActionScope;
    // novel / tweet 是 2026-09-22 新增的改编产物（走 ChapterAdaptJob 另一套作业表）
    gen_kind?: "outline" | "chapters" | "storyboards" | "novel" | "tweet";
  };

  async function send(overrideInput?: string, act?: ActionPayload) {
    if (!activeConv || sending) return;
    const baseText = (overrideInput ?? input).trim();
    // 图片还在上传：等它传完再发，否则这一轮模型看不到图（id 还没拿到）
    if (pimg.uploading) { notifyError("图片还在上传，稍等一下再发送"); return; }
    // 动作栏按钮（act）是确定性后端分支，不看图 —— 只有手打的对话才带图
    const sendImages = act ? [] : pimg.readyIds;
    if (!baseText && pendingAttachments.length === 0 && sendImages.length === 0) return;
    // 用户点了动作按钮时，act 一定带着结构化意图一起进来（pickAction/pickGen 点击即发）。
    // 手打消息不带 act = 纯对话。**不再有 pendingAction 这个中间态** —— 以前它记着
    // "按钮填了那句话但用户还没发"，现在按钮就是发本身，中间态没有存在的理由，也少了一类
    // "以为是对话、其实被当成体检" 的错配。
    const effective = act ?? undefined;
    // 把附件拼到 user message 前面 (引用块)
    // ⚠️ 已入库的长文档（docId）**只放一行引用**，正文不入消息：
    //    正文进了消息就会随对话历史进上下文，40 万字的原文约第 33~35 轮被剪成
    //    占位符、第 38 轮滑出窗口，模型随后开始自己编。正文改由后端按章号检索。
    //    短片段/章节引用（没有 docId）仍按老样子内联，它们不会撑爆窗口。
    const refs = pendingAttachments.map((a) => {
      const head = a.kind === "file" ? `📎 文件: ${a.name} (${formatBytes(a.size)}${a.truncated ? ", 已截断" : ""})` : `📖 ${a.name}`;
      if (a.docId) {
        const ch = a.chapterCount ? `，共 ${a.chapterCount} 章` : "";
        return `${head}\n（全文已入库${ch}。需要某一章时，在提问里写明章号，我会取那一章的原文。）`;
      }
      return `${head}\n\`\`\`\n${a.content}\n\`\`\``;
    }).join("\n\n");
    const finalText = refs ? `${refs}\n\n${baseText}` : baseText;
    // 本轮引用的章节集号: 一键替换推断不出集号时用它兜底(取最后一个引用的章节)
    const attachedOrder = [...pendingAttachments].reverse()
      .find((a) => a.chapterOrder != null)?.chapterOrder ?? null;

    setInput("");
    setPendingAttachments([]);
    const sentImages: MessageImage[] = sendImages.length ? pimg.takeForSend() : [];
    setSending(true);
    setMessages((prev) => [...prev,
      { role: "user", content: finalText, attachedOrder, images: sentImages },
      { role: "assistant", content: "", pending: true, attachedOrder },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const token = getToken();
      const res = await fetch(`${API}/conversations/${activeConv.id}/messages`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({
          content: finalText, current_draft_id: activeConv.draft_id, mode: selectedMode,
          ...(sentImages.length ? { image_ids: sentImages.map((x) => x.id) } : {}),
          provider, ...genParams, compaction: compactionOn,
          // ⚠ tool_mode 恒为 "off"：日常对话是**纯对话**，模型只回文本，不调工具。
          // 2026-09 用户反馈原话："下命令-agent调用工具-获取结果，操作链显然提升了，
          // bug率也在增加"。检查/精修/生成/去AI味这些能力改由动作栏按钮触发
          // （带 action 字段走确定性后端分支，压根不经过 Agent 循环），
          // 自然语言不再能触发它们。聊出来的文本靠"选中 → 一键写入草稿"落库。
          tool_mode: "off",
          // ⚠ chat_mode 恒为 "chat"：意图**只**由动作栏决定，不再由一个藏在
          // 工具条里的持久开关决定。「自动精修 / 讨论」那个下拉已删除 —— 它和
          // 动作栏的「精修这批」说同一件事，而且它的 polish 值会让用户**随便打
          // 一句话**就触发整本覆写，模式本身还不可见。现在想整本精修就点
          // 「精修这批」（范围留空 = 整本），想聊就直接打字。
          chat_mode: "chat",
          // 动作栏: 只有点按钮时才带这些字段, 手打消息一个都不带 ——
          // 后端看到 action 就改走 check/fix/rewrite 分支, 否则走 chat_mode 老路径。
          ...(effective ? {
            action: effective.action,
            kinds: effective.kinds ?? null,
            issue_ids: effective.issue_ids ?? null,
            report_id: effective.report_id ?? null,
            scope: effective.scope ?? null,
            gen_kind: effective.gen_kind ?? null,
          } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(t); msg = j.detail || j.message || msg; } catch { if (t) msg = t.slice(0, 300); }
        // 精修正在跑时，后端会拒掉再发一条精修（同一部剧同时只允许一个覆写型任务）。
        // 提示里带上正在跑的作业号，用户才知道等的是什么、去哪儿看。
        if (polishJobRef.current) {
          msg += `（当前还有精修作业 #${polishJobRef.current} 在跑，等它跑完再发）`;
        }
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.pending) next[next.length - 1] = { ...last, pending: false, content: `⚠️ 发送失败：${msg}` };
          return next;
        });
        // ⚠️ 失败气泡没有 DB id，refreshMessages 会把它当"本地消息"保留下来 ——
        // 这是有意的（用户必须能读到失败原因）。但也意味着不能靠"刷新"清掉它。
        return;
      }
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const p = JSON.parse(line.slice(6));
            if (p.type === "delta") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.pending) next[next.length - 1] = { ...last, content: last.content + (p.content || "") };
                return next;
              });
            } else if (p.type === "done") {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.pending) next[next.length - 1] = { ...last, pending: false, content: p.full_content || last.content };
                return next;
              });
            } else if (p.type === "job") {
              // 「自动精修」模式: 后端只回了一句话 + 一个作业号, 几十集在后台跑。
              // 记下作业号: 跑着时拦住重复发送, 跑完刷新那条"已启动"消息拿最终结果。
              if (typeof p.job_id === "number") {
                // 生成类事件带 gen_kind（后端 _stream_generate 发的），精修不带。
                // 两条路都要记下来: 它们都是"关掉页面也要跑完"的长任务,
                // 记着作业号才能续上进度、跑完刷新。
                if (p.gen_kind) {
                  genJobRef.current = p.job_id;
                  setGenJob({ id: p.job_id, kind: p.kind || "", genKind: p.gen_kind,
                              progress: 0, note: null, status: "queued" });
                } else {
                  polishJobRef.current = p.job_id;
                  setPolishJob(p.job_id);
                }
              }
            } else if (p.type === "check") {
              // 体检报告: 后端已经把它落库并挂到了刚才那条助手消息上。
              // 本地先把卡片画出来(不等轮询), 再靠 refreshMessages 把它对齐到 DB id。
              const rep = p.report || null;
              if (rep) {
                setMessages((prev) => {
                  const next = [...prev];
                  // 找最近一条已定型的助手消息挂上去 —— 就是刚收到 done 的那条。
                  for (let i = next.length - 1; i >= 0; i--) {
                    const m = next[i];
                    if (m.role === "assistant" && !m.pending) {
                      next[i] = { ...m, report: rep };
                      break;
                    }
                  }
                  return next;
                });
              }
            } else if (p.type === "deai") {
              // 去 AI 味已入队（后端 _stream_deai 发的独立事件类型）。
              // 用 job_id 去重: 断线重连/重复投递同一条事件时不能重复起轮询。
              // already_running=true 表示"你想干的事已经在跑了"，直接把已有作业挂上进度，
              // 不是错误 —— 后端已经用一句人话说清楚了，这里不需要再报错。
              if (typeof p.job_id === "number" && deaiJobRef.current !== p.job_id) {
                const jid: number = p.job_id;
                deaiJobRef.current = jid;
                const seed: DeaiJobView = {
                  id: jid,
                  draftId: typeof p.draft_id === "number" ? p.draft_id : 0,
                  title: p.title || "",
                  status: "running", total: 0, finished: 0, failed: 0, summary: {},
                };
                setDeaiJob(seed);
                // 同时往卡片表里放一份，轮询的每轮都会就地更新它。
                setDeaiCards((prev) => ({ ...prev, [jid]: seed }));
              }
            } else if (p.type === "fix") {
              // 定点修复已入队: 记作业号, 复用精修那套轮询去等结果(下面 fixJob 的 effect)。
              // 用事件里的 job_id 去重: 断线重连/重复投递同一条事件时, 不能重复起轮询。
              if (typeof p.job_id === "number" && fixJobRef.current !== p.job_id) {
                fixJobRef.current = p.job_id;
                setFixJob(p.job_id);
                setFixTarget(p.report_id ?? null);
              }
            } else if (p.type === "error") {
              // 后端错误事件 (如会话条数达上限/模型调用失败): 必须展示,
              // 否则气泡永远停在 pending "...", 用户以为"没有响应"。
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.pending) next[next.length - 1] = { ...last, pending: false, content: `⚠️ ${p.message || "生成失败"}` };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.pending) next[next.length - 1] = { ...last, pending: false, content: (last.content || "") + "\n\n_(已停止生成)_" };
          return next;
        });
      } else {
        // 网络层异常 (断网/请求被拦/连接断开): 也必须让用户看见,
        // 否则气泡永远停在 pending, 用户以为"没反应"却拿不到任何线索。
        console.error(e);
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.pending) next[next.length - 1] = { ...last, pending: false, content: `⚠️ 发送失败：${e?.message || "网络异常"}` };
          return next;
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      void loadConvs();
      void detectIntent(finalText);
      // 拉一次消息列表拿 DB id (否则新发的消息没 id, 无法立即编辑)
      void refreshMessages(activeConv.id);
    }
  }

  function stopGenerating() { abortRef.current?.abort(); }

  // 「自动精修」作业轮询。只在有作业号时跑, 8 秒一次(精修是分钟级的长任务,
  // 没必要更密; 更密只是白打后端)。完成后:
  //   ① 拉一次消息: 后端把最终结果回填到了那条"已启动"的助手消息里
  //   ② 拉一次草稿: 让右侧/分屏看到覆写后的新内容
  // 失败时只停轮询并提示 —— 按精修的铁律, 失败时原稿没动过, 不需要用户做补救。
  const polishConvId = activeConv?.id ?? null;
  // 「精修在跑」这条状态以前只存作业号，界面只显示一个"整本精修中 #N"，**看不到进度**，
  // 用户报"发起精修后似乎并不显示进度"。后端其实一直在 set_progress（"正在精修第10-20集
  // （2/5）"这类），只是前端没消费。这里把它接上：进度百分比 + 后端给的那句人话。
  const [polishState, setPolishState] = useState<{
    id: number; progress: number | null; note: string | null; status: string;
  } | null>(null);
  useEffect(() => {
    const jobId = polishJob;
    if (!jobId || !polishConvId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let terminal = false;
      try {
        const r = await authFetch(`${API}/jobs/${jobId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        setPolishState({ id: jobId, progress: j.progress ?? null,
                         note: j.progress_note ?? null, status: j.status });
        if (j.status === "done" || j.status === "failed" || j.status === "canceled") {
          terminal = true;
          polishJobRef.current = null;
          setPolishJob(null);
          setPolishState(null);
          if (j.status === "done") {
            // 跑完把"改了哪几集、各自改前改后"拉回来，就地画左右对照。
            await loadJobChanges(jobId);
          }
          await refreshMessages(polishConvId);
          if (j.status !== "done") {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `⚠️ 整本精修没有完成（${j.status}）：${j.error || "未给出原因"}\n\n` +
                       "按精修的设计，**失败时草稿内容保持原样**，没有被改坏。",
            }]);
          }
        }
      } catch { /* 网络抖动不停轮询, 下一轮再试 */ }
      if (alive && !terminal) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polishJob, polishConvId]);

  // 拉一次「改前/改后」对照。只在作业终态调用 —— 正文对照动辄几十万字，
  // 放进 3 秒轮询里会把浏览器拖死。
  async function loadJobChanges(jobId: number) {
    try {
      const r = await authFetch(`${API}/jobs/${jobId}/changes`);
      if (!r.ok) return;
      const d = (await r.json()) as RewriteDiff;
      if ((d.items || []).length) setGenDiff(d);
    } catch { /* 对照是锦上添花, 拿不到不影响主流程 */ }
  }

  // 「生成」作业轮询（大纲/正文/剧本）。3 秒一次，因为它的进度对用户是有信息的
  // （"第 12/60 集完成（1843字）"），而不是一个装饰性的转圈。
  useEffect(() => {
    const jobId = genJob?.id ?? null;
    const convId = activeConv?.id ?? null;
    if (!jobId || !convId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let terminal = false;
      try {
        const r = await authFetch(`${API}/jobs/${jobId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        if (j.status === "done" || j.status === "failed" || j.status === "canceled") {
          terminal = true;
          genJobRef.current = null;
          const kind = genJob?.kind || j.kind || "";
          const genKind = genJob?.genKind ?? null;
          setGenJob(null);
          if (j.status === "done" && (kind === "gen_storyboards" || kind === "gen_chapters")) {
            await loadJobChanges(jobId);
          }
          await refreshMessages(convId);
          notifyDraftUpdated();
          if (j.status !== "done") {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `⚠️ 生成没有完成（${j.status}）：${j.error || "未给出原因"}\n\n` +
                       "已经生成的集都在草稿里，没生成的部分原样保留 —— 可以直接再点一次「生成」，"
                       + "已完成的集不会重做。",
            }]);
          } else if (genKind === "outline") {
            const res = (j.result || {}) as any;
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `✅ 大纲已生成（${res.episodes ?? res.chapters ?? "?"} 集`
                + `${res.title ? `，《${res.title}》` : ""}）。`
                + `\n\n结构检查：${res.error_count ?? 0} 个错误、${res.warn_count ?? 0} 个提醒。`
                + "\n\n可以接着点「生成 ▸ 生成正文」，或者直接告诉我哪一集要改。",
            }]);
          } else {
            // 生成的集是**新写**出来的，没有"改前原文"可比 —— 只有那些覆写了已有内容的
            // 集（精修风格的改写）才会有对照。所以这里先说清写了多少，再看有没有对照可看。
            const res = (j.result || {}) as any;
            const made = res.generated ?? null;
            const skipped = res.skipped ?? null;
            // ⚠️ 用户反馈"生成的内容我不能及时查看"：以前这里只有一句"已写入草稿"，
            // 想看结果必须自己去右侧草稿页逐集翻。后端现在每写完一集就把开头存进
            // result.previews，所以这里直接把最近几集的开头贴出来 —— 不用离开对话。
            const previews = Array.isArray(res.previews) ? res.previews : [];
            const head = previews.slice(-3).map((p: any) =>
              `**第${p.order}集${p.title ? `《${p.title}》` : ""}**（${p.chars ?? "?"} 字）\n`
              + `> ${String(p.head || "").replace(/\n/g, "\n> ")}${(p.chars ?? 0) > 240 ? "…" : ""}`
            ).join("\n\n");
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: "✅ 生成完成，内容已写入草稿。"
                + (made != null ? `\n\n本次新写了 **${made}** 集`
                                  + (skipped ? `，跳过已存在的 ${skipped} 集（不重做）。` : "。") : "")
                + (head ? `\n\n最近生成的几集开头：\n\n${head}` : "")
                + "\n\n可以在右侧草稿页逐集查看，或直接告诉我哪一集要改。",
            }]);
          }
          return;
        }
        setGenJob((prev) => prev ? {
          ...prev, progress: j.progress ?? prev.progress,
          note: j.progress_note ?? prev.note, status: j.status,
        } : prev);
      } catch { /* 网络抖动不停轮询, 下一轮再试 */ }
      if (alive && !terminal) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genJob?.id, activeConv?.id]);

  // 「定点修复」作业轮询。比精修短得多(只改点名的几集), 所以 5 秒一次。
  // 完成后把 after{error,warn} 挂回那张报告卡 —— 卡片上就有了"修前 12 → 修后 7"。
  // 数字没降时后端会带 notes 说明"没改到位", 前端照实显示, 不粉饰。
  useEffect(() => {
    const jobId = fixJob;
    const convId = activeConv?.id ?? null;
    if (!jobId || !convId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const r = await authFetch(`${API}/jobs/${jobId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        if (j.status === "done" || j.status === "failed" || j.status === "canceled") {
          fixJobRef.current = null;
          setFixJob(null);
          const res = (j.result || {}) as any;
          const after = res.after || null;
          const rid = after?.report_id ?? fixTarget;
          setFixTarget(null);
          // 把 before→after 挂到对应那张卡片上(按 report_id 找; 找不到就挂最后一条带报告的)。
          const fixRes: FixResult | null = after ? {
            before_error: after.before_error, before_warn: after.before_warn,
            error: after.error, warn: after.warn,
            touched_eps: after.touched_eps, report_id: after.report_id,
            improved: !!res.improved, notes: res.notes || [],
          } : null;
          // 存进 ref: 后面每一次 refreshMessages 都从它贴回来(见 refreshMessages 里的 memFix)。
          if (fixRes && fixRes.report_id) fixResultRef.current.set(fixRes.report_id, fixRes);
          setMessages((prev) => {
            const next = [...prev];
            let hit = -1;
            for (let i = next.length - 1; i >= 0; i--) {
              const rp = next[i].report;
              if (!rp) continue;
              if (rid && rp.report_id === rid) { hit = i; break; }
              if (hit < 0) hit = i;
            }
            if (hit >= 0) next[hit] = { ...next[hit], fix: fixRes };
            return next;
          });
          // 草稿被覆写了: 刷新消息(拿后端回填的最终交代) + 通知分屏重拉草稿
          await refreshMessages(convId);
          notifyDraftUpdated();
          if (j.status !== "done") {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `⚠️ 定点修复没有完成（${j.status}）：${j.error || "未给出原因"}\n\n` +
                       "修复器在每集改写前先存了历史版本，**没改成功的集原稿保持原样**。",
            }]);
          }
          return;
        }
      } catch { /* 网络抖动不停轮询, 下一轮再试 */ }
      if (alive) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixJob, activeConv?.id]);

  // 「去 AI 味」作业轮询。整部剧逐集改写，量级和精修差不多，所以也是 8 秒一次。
  // 与精修/修复的**关键差别**：跑完**不刷新草稿** —— 去 AI 味不改草稿（核心不变量），
  // 结果是一份独立清洗稿。所以这里不调 notifyDraftUpdated()，也不去拉 changes
  // （那是 RewriteJob 的接口）。跑完只把状态收尾，并把结论如实说给用户。
  //
  // ⚠️ 也别在轮询里读 job.per_ep —— 那是几十万字的原文+改写全文，塞进前端会卡死。
  //    要看逐集对照，用户去「去 AI 味工作室」展开看（那里是专门的地方）。
  const deaiConvId = activeConv?.id ?? null;
  useEffect(() => {
    const jobId = deaiJob?.id ?? null;
    if (!jobId || !deaiConvId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let terminal = false;
      try {
        const r = await authFetch(`${BASE}/v1/deai/${jobId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const summary = (j.summary || {}) as any;
        const view: DeaiJobView = {
          id: jobId,
          draftId: j.draft_id ?? deaiJob?.draftId ?? 0,
          title: j.title || deaiJob?.title || "",
          status: j.status, total: j.total ?? 0,
          finished: j.finished ?? 0, failed: j.failed ?? 0,
          summary,
        };
        setDeaiJob((prev) => (prev && prev.id === jobId ? { ...prev, ...view } : prev));
        setDeaiCards((prev) => ({ ...prev, [jobId]: view }));
        if (j.status === "done" || j.status === "failed" || j.status === "canceled") {
          terminal = true;
          deaiJobRef.current = null;
          // 跑完在对话里留一条结论。**不刷草稿**（见上面），只说清洗结果本身。
          if (j.status === "done") {
            const kb = summary.per_kilo_before, ka = summary.per_kilo_after;
            const dens = (kb != null && ka != null)
              ? `每千字 AI 味硬信号：**${kb} → ${ka}**。\n\n` : "";
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `🧽 《${j.title || deaiJob?.title || ""}》去 AI 味清洗完成（作业 #${jobId}）。\n\n`
                + dens
                + (summary.note ? `${summary.note}\n\n` : "")
                + `**你的草稿没有任何改动** —— 清洗结果是一份独立的稿子。\n`
                + `去「去 AI 味工作室」（左侧菜单）可以逐集看原文/去味后对照，也能下载整本清洗稿。\n\n`
                + `两句要如实说的话：上面的数字是**相对分**（改前 vs 改后同一段文本），`
                + `不是任何检测平台的通过率；而且**情绪直说、类型惯例写法不算 AI 味**，`
                + `引擎刻意不动那些地方 —— 看到"还有残留"是正常的。`,
            }]);
          } else {
            setMessages((prev) => [...prev, {
              role: "assistant",
              content: `⚠️ 去 AI 味作业 #${jobId} 没有完成（${j.status}）：${j.error || "未给出原因"}\n\n`
                + `**你的草稿没有任何改动** —— 去 AI 味本来就不碰草稿，所以不存在"被改坏"这一说，直接重新提交即可。`,
            }]);
          }
        }
      } catch { /* 网络抖动不停轮询, 下一轮再试 */ }
      if (alive && !terminal) timer = setTimeout(poll, 8000);
    };
    timer = setTimeout(poll, 3000);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deaiJob?.id, deaiConvId]);

  // ── 动作栏: 点按钮 → **立刻发出去**（2026-09 改）──
  // 以前是 setInput(a.send) + setPendingAction(...)，等用户再按一次发送。
  // 用户原话："一些用户喜欢之前的操作逻辑，即在对话中获取生成结果，然后用高亮选择-
  // 按钮插入的方式把确认的文本写进草稿，而非现在这样下命令-agent调用工具-获取结果，
  // 操作链显然提升了，bug率也在增加。"
  // 所以整条链路一分为二：
  //   · 动作栏按钮 → 带结构化字段直接走后端确定性分支（check/fix/rewrite/generate/deai）
  //   · 手打消息   → 纯对话（tool_mode="off"），聊出来的文本靠选中插入写进草稿
  // 生成类的 send 句子（如"帮我写一版分集大纲。"）照旧当 user_input 进对话流，
  // 这样对话里能看见"我点了什么"，事后也能翻回去看。
  function pickAction(a: ActionSpec) {
    if (!activeConv || sending) return;
    // 没有结构化意图的项不猜（否则会退化成"纯聊天里说了一句该体检"，正是要避免的）
    if (!a.action) return;
    void send(a.send, {
      action: a.action,
      kinds: a.kinds,
      scope: a.action === "rewrite" || a.action === "deai" ? scope : undefined,
      gen_kind: a.action === "generate" ? (a.genKind ?? "outline") : undefined,
    });
  }

  // 「生成 ▾」下拉里选一项。
  // 与 pickAction 已经是同一条路（都是点击即发）—— 生成类原本就要求立刻发，现在统一了。
  // 保留独立函数只是因为下拉项和药丸项分成两处渲染、回调分开传。
  // 生成是"点一下就走"的确定性动作（后端 action="generate" + gen_kind 直接入队），
  // 以前的做法是只塞一句"帮我写一版分集大纲。"进输入框、等用户按回车、再指望
  // Agent 循环读懂 —— 这正是用户报的"这三个命令现在发送后还会报错"。
  // 所以这里照抄下拉里那句 label 当 user_input（对话里总得有一条用户消息），
  // 其余全部交给结构化字段。
  function pickGen(a: ActionSpec) {
    if (!activeConv || sending) return;
    const genKind = a.genKind ?? "outline";
    // ⚠️ 这里以前会在"对话没关联草稿"时把按钮打死，回一句"请先关联草稿再点一次"。
    // 2026-09 用户反馈：他就是要**不碰草稿**直接在对话里写（贴完 60 集细纲就生成），
    // 这句话把唯一的入口堵死了 —— 他反复看到的"没有选定草稿"就是从这来的。
    // 现在不拦：后端缺 draft_id 会自己解析一部（会话已绑的 / 从会话原文导一份 /
    // 新建空草稿），用户全程不需要知道"草稿"这个词。
    // 范围也要带上。以前这里只发 action + gen_kind，用户在上面圈好的
    // 「这批」范围（3~10 集）到了后端就被丢掉，圈了 3~10 集照样按整本跑。
    // 大纲是整本生成的，没有"范围"语义，所以只给正文/剧本带。
    void send(a.label, {
      action: "generate",
      gen_kind: genKind,
      // 大纲整本生成、改编逐章全量，都没有"范围"语义；只有正文/剧本吃范围
      scope: (genKind === "chapters" || genKind === "storyboards") ? scope : undefined,
    });
  }

  // ── 报告卡上的修复动作 ──
  function fixIssues(issueIds: string[], reportId?: number) {
    if (!activeConv || !issueIds.length || sending) return;
    const label = issueIds.length === 1
      ? "让 AI 按体检报告改这一条问题"
      : `让 AI 按体检报告改这 ${issueIds.length} 条问题`;
    void send(label, {
      action: "fix", issue_ids: issueIds,
      report_id: reportId ?? currentReportId(issueIds),
    });
  }

  // 从消息里反查这些 issue 属于哪份报告 —— 只回传 id 和后端用的 report_id,
  // 内容一律以服务端 check_reports 为准(前端连问题正文都不传)。
  function currentReportId(issueIds: string[]): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const rp = messages[i].report;
      if (!rp) continue;
      const ids = new Set((rp.issues_flat || []).map((x) => x.id));
      if (issueIds.some((x) => ids.has(x))) return rp.report_id;
    }
    return undefined;
  }

  // 原位更新消息 (编辑重发/版本切换/元数据刷新): 不触发"滚动到底部"
  function setMessagesNoScroll(updater: (prev: Message[]) => Message[]) {
    suppressAutoScrollRef.current = true;
    setMessages(updater);
  }

  // 轻量刷新消息列表 (拿 DB id / 版本组元数据), 不动分屏与会话状态; 保留已挂载的 operation
  // 历史消息里的去 AI 味作业卡：扫一遍对话内容里的"作业 #N"，按需拉一次作业详情。
  // 为什么靠扫文本而不是给消息加字段：去 AI 味的作业号只存在于助手回执那句话里
  // （对话消息表本来就有 content，为一张进度卡加一列 schema 不值得）。作业号一旦
  // 拉过就记进 deaiFetchedRef，**终态永不重拉**；仍在跑的会随上面的轮询继续更新。
  useEffect(() => {
    if (!activeConv) return;
    const ids = new Set<number>();
    for (const m of messages) {
      if (m.role !== "assistant" || m.pending || !m.content) continue;
      if (!m.content.includes("去 AI 味")) continue;
      for (const mt of m.content.matchAll(/去 AI 味[^\n#]{0,20}?作业?\s*#(\d+)/g)) {
        const n = Number(mt[1]);
        if (Number.isFinite(n) && n > 0) ids.add(n);
      }
      // 排队那条回执里作业号写在加粗括号里："（**#12**）"
      for (const mt of m.content.matchAll(/去 AI 味[\s\S]{0,80}?#(\d+)[\s\S]{0,40}?再提交/g)) {
        const n = Number(mt[1]);
        if (Number.isFinite(n) && n > 0) ids.add(n);
      }
    }
    for (const id of ids) {
      if (deaiFetchedRef.current.has(id)) continue;
      deaiFetchedRef.current.add(id);
      void (async () => {
        try {
          const r = await authFetch(`${BASE}/v1/deai/${id}`);
          if (!r.ok) return;          // 不属于我 / 已删: 后端返回 404, 静默不画卡
          const j = await r.json();
          const view: DeaiJobView = {
            id,
            draftId: j.draft_id ?? 0,
            title: j.title || "",
            status: j.status, total: j.total ?? 0,
            finished: j.finished ?? 0, failed: j.failed ?? 0,
            summary: (j.summary || {}) as any,
          };
          setDeaiCards((prev) => ({ ...prev, [id]: view }));
          // 还在跑的: 顺手挂上顶栏胶囊 + 轮询，让用户回到旧对话也能接着看进度。
          if (view.status === "running" || view.status === "pending") {
            deaiJobRef.current = id;
            setDeaiJob(view);
          }
        } catch { /* 网络抖动: 下次 refreshMessages 会再试(已从 fetched 移除) */
          deaiFetchedRef.current.delete(id);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeConv?.id]);

  async function refreshMessages(convId: number) {
    try {
      const r = await authFetch(`${API}/conversations/${convId}`);
      if (!r.ok) return;
      const data = await r.json();
      setMessagesNoScroll((prev) => {
        const opById: Record<number, AgentOperation> = {};
        for (const m of prev) if (m.id && m.operation) opById[m.id] = m.operation;
        // 体检报告卡同样要保住: 后端 report_json 落库了, 但本地刚跑完的那张卡
        // 若在刷新前一刻还没落库, 直接替换会让卡片当场消失 —— 用户以为白跑了一次。
        const reportById: Record<number, CheckReport> = {};
        const fixById: Record<number, FixResult> = {};
        for (const m of prev) {
          if (m.id && m.report) reportById[m.id] = m.report;
          if (m.id && m.fix) fixById[m.id] = m.fix;
        }
        // 内存里的 before→after 优先级最高: 它比 prev 里挂着的更新(修复刚跑完那一下,
        // 本地已经贴上了, 但 refreshMessages 是整条替换, 不看这里就会丢)。
        const memFix = (m: any): FixResult | null => {
          const rp = m.report as CheckReport | undefined;
          if (!rp) return null;
          return (rp.report_id ? fixResultRef.current.get(rp.report_id) : null)
            ?? fixById[m.id] ?? null;
        };
        const fresh: Message[] = (data.messages || []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content, group_id: m.group_id, version: m.version,
          report: m.report || reportById[m.id] || null,
          fix: memFix(m),
          images: m.images || [],
        }));
        // ⚠️ 只存在于本地的消息必须保留。它们没有 DB id, 因为服务端还没来得及落库
        // (或根本没落成): 发送失败的错误提示、正在流式生成的回复都属于这类。
        // 直接用 DB 列表整体替换会把它们连同报错一起抹掉——用户看到的就是
        // "点发送 → 闪一下 → 什么都没发生", 连失败原因都读不到。实测踩过。
        // ⚠️ 但服务端一旦把同一条落库了, 本地那条就成了重复的幽灵: 用户会看到
        // 一模一样的两条(一条有 id、一条没有)。所以按 (role, content) 去重 ——
        // 服务端已返回同内容的消息时, 丢掉本地那条。实测踩过: "发一条消息出现两个气泡"。
        // ⚠️ 但正在生成中的那条(pending)不能参与去重: 流还没结束, 本地内容是
        // 逐步拼出来的, 与服务端那一刻的半截内容对不上 —— 一旦被"服务端已有同内容"
        // 判成重复而被丢掉, 那个还在往里写字的空气泡就没了(用户看到回复消失)。
        // 所以 pending 一律保留; 已经定了型的本地消息(错误提示等)才按内容去重。
        const freshKeys = new Set(fresh.map((m) => `${m.role}\u0000${m.content}`));
        const localOnly = prev.filter(
          (m) => !m.id && (m.pending || !freshKeys.has(`${m.role}\u0000${m.content}`)));
        return [
          ...fresh.map((m) => (m.id && opById[m.id] ? { ...m, operation: opById[m.id] } : m)),
          ...localOnly,
        ];
      });
      setQaGroups(data.groups || {});
    } catch {}
  }

  // ===== 编辑已发消息 → 重新生成 (问答版本化) =====
  function startEdit(idx: number) {
    if (sending) return;
    const m = messages[idx];
    if (!m || m.role !== "user" || !m.id) return;
    setEditingIdx(idx);
    setEditVal(m.content);
  }

  async function submitEdit(idx: number) {
    if (!activeConv || sending) return;
    const m = messages[idx];
    if (!m?.id) return;
    const newText = editVal.trim();
    if (!newText) return;
    setEditingIdx(null);
    setSending(true);

    // 本地即时更新: 用户气泡换新文本, 其配对回复变 pending (无配对则插入一条)
    const hasReply = messages[idx + 1]?.role === "assistant";
    const targetIdx = idx + 1;
    setMessagesNoScroll((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], content: newText, operation: undefined };
      const pendingMsg: Message = { role: "assistant", content: "", pending: true };
      if (hasReply) next[targetIdx] = pendingMsg;
      else next.splice(targetIdx, 0, pendingMsg);
      return next;
    });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const token = getToken();
      const res = await fetch(`${API}/conversations/${activeConv.id}/messages/${m.id}/edit`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        // tool_mode 与 send() 保持一致（"off" = 纯对话）：编辑重发走的是同一条后端路径，
        // 两处不一致会让"改一句话重发"莫名跑起工具循环。
        body: JSON.stringify({ content: newText, current_draft_id: activeConv.draft_id, mode: selectedMode, provider, ...genParams, compaction: compactionOn, tool_mode: "off", chat_mode: "chat" }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(t); msg = j.detail || j.message || msg; } catch { if (t) msg = t.slice(0, 300); }
        setMessagesNoScroll((prev) => {
          const next = [...prev];
          if (next[targetIdx]?.pending) next[targetIdx] = { ...next[targetIdx], pending: false, content: `⚠️ 编辑重发失败：${msg}` };
          return next;
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const p = JSON.parse(line.slice(6));
            if (p.type === "delta") {
              setMessagesNoScroll((prev) => {
                const next = [...prev];
                const t = next[targetIdx];
                if (t?.pending) next[targetIdx] = { ...t, content: t.content + (p.content || "") };
                return next;
              });
            } else if (p.type === "done") {
              setMessagesNoScroll((prev) => {
                const next = [...prev];
                const t = next[targetIdx];
                if (t?.pending) next[targetIdx] = { ...t, pending: false, content: p.full_content || t.content };
                return next;
              });
            } else if (p.type === "job") {
              if (typeof p.job_id === "number") {
                polishJobRef.current = p.job_id;
                setPolishJob(p.job_id);
              }
            } else if (p.type === "error") {
              setMessagesNoScroll((prev) => {
                const next = [...prev];
                const t = next[targetIdx];
                if (t?.pending) next[targetIdx] = { ...t, pending: false, content: `⚠️ ${p.message || "生成失败"}` };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      // 同 send(): 网络层异常必须可见, 不能让气泡静静停在 pending。
      if (e?.name !== "AbortError") {
        console.error(e);
        setMessagesNoScroll((prev) => {
          const next = [...prev];
          const t = next[targetIdx];
          if (t?.pending) next[targetIdx] = { ...t, pending: false, content: `⚠️ 编辑重发失败：${e?.message || "网络异常"}` };
          return next;
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      // 拿新消息的 DB id + 版本组元数据 (v1/v2 标签)
      void refreshMessages(activeConv.id);
    }
  }

  // 切换一组问答的显示版本 (服务端持久化, 同时影响 LLM 上下文用哪个版本)
  async function switchVersion(groupId: number, version: number) {
    if (!activeConv || sending) return;
    const r = await authFetch(`${API}/conversations/${activeConv.id}/groups/${groupId}/activate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (r.ok) await refreshMessages(activeConv.id);
  }

  async function regenerate(idx: number) {
    // 找到该 assistant 消息对应的上一条 user 消息, 重新发
    if (sending) return;
    let lastUser = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUser = messages[i].content; break; }
    }
    if (!lastUser) return;
    // 砍掉这条 assistant 之后的所有消息 (它本身也砍, 重新生成)
    setMessages((prev) => prev.slice(0, idx));
    await send(lastUser);
  }

  async function detectIntent(userText: string) {
    if (!activeConv) return;
    try {
      const r = await authFetch(`${API}/intent/detect`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_message: userText, conversation_id: activeConv.id, current_draft_id: activeConv.draft_id }),
      });
      if (!r.ok) return;
      const data = await r.json();
      if (data?.operation) {
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && !next[i].pending) {
              next[i] = { ...next[i], operation: data.operation };
              break;
            }
          }
          return next;
        });
      }
      void authFetch(`${API}/conversations/${activeConv.id}/extract`, { method: "POST" }).catch(() => {});
    } catch {}
  }

  function exportConvAsMarkdown() {
    if (!activeConv) return;
    const lines: string[] = [`# ${activeConv.title}`, ""];
    for (const m of messages) {
      lines.push(m.role === "user" ? "## 🧑 用户" : "## 🤖 助手");
      lines.push("", m.content || "", "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeConv.title || "对话").replace(/[/\\?%*:|"<>]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const groups = useMemo(() => {
    const filtered = search ? convs.filter((c) => (c.title || "").toLowerCase().includes(search.toLowerCase())) : convs;
    const sorted = [...filtered].sort((a, b) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || ""));
    const today: Conversation[] = [], yest: Conversation[] = [], older: Conversation[] = [];
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yestStart = todayStart - 86400000;
    for (const c of sorted) {
      const t = (c.updated_at || c.created_at) ? new Date(c.updated_at || c.created_at!).getTime() : 0;
      if (t >= todayStart) today.push(c);
      else if (t >= yestStart) yest.push(c);
      else older.push(c);
    }
    return { today, yest, older, all: sorted };
  }, [convs, search]);

  const activeDraft = useMemo(() => drafts.find((d) => d.id === splitDraftId) || null, [drafts, splitDraftId]);

  // 消息下标 → 去 AI 味作业号（只为画卡片）。同一句话里可能提到两个作业号
  // （"已经有一份 #7 在跑" + "作业号 #12"），按文本出现顺序取**最后一个** ——
  // 回执里最后出现的那个才是"这次的结果"，前面提的是"挡路的那个"。
  const deaiJobAt = useMemo(() => {
    const map = new Map<number, number>();
    messages.forEach((m, i) => {
      if (m.role !== "assistant" || m.pending || !m.content) return;
      if (!m.content.includes("去 AI 味")) return;
      let last: number | null = null;
      for (const mt of m.content.matchAll(/#(\d+)/g)) {
        const n = Number(mt[1]);
        if (Number.isFinite(n) && n > 0) last = n;
      }
      if (last != null) map.set(i, last);
    });
    return map;
  }, [messages]);

  if (!authChecked) {
    return <div className="h-screen flex items-center justify-center bg-surface-base text-ink-primary"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (!authed) return null;

  return (
    <div className="h-screen bg-surface-base text-ink-primary flex flex-col">
      {/* === 顶栏 (统一风格) === */}
      <header className="h-14 flex items-center gap-3 px-4 border-b border-line bg-surface-elevated/80 backdrop-blur shrink-0">
        <button
          onClick={() => router.push("/drafts")}
          className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-overlay text-sm text-ink-secondary hover:text-ink-primary transition"
        >
          <ArrowLeft className="w-4 h-4" />草稿列表
        </button>
        <div className="h-5 w-px bg-line" />
        <h1 className="text-base font-semibold flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" /> 对话工坊
        </h1>
        <span className="hidden md:inline text-xs text-ink-muted">和 AI 自由对话, 直接落地到草稿</span>
        {/* 精修 / 生成正在跑时的顶栏提示。放在这里是因为用户可能已经滚到对话中间，
            而正在跑的作业是"整个页面"级别的状态，不属于某一条消息。

            以前这里只有一个"整本精修中 #N" —— **没有进度**，而「生成正文」要跑
            几十分钟，用户只能反复刷新页面、或者以为它死了（用户原话："发起精修后
            似乎并不显示进度"）。后端一直在 set_progress 写百分比和人话进展
            （"正在精修第10-20集（2/5）"），前端只是没消费。现在两条都显示：
            百分比进度条 + 后端那句进展说明。 */}
        {polishState && (
          <span className="ml-2 px-2 py-0.5 rounded border border-primary/50 bg-primary/10
                           text-primary text-[11px] flex items-center gap-1.5 max-w-[380px]"
                title={polishState.note || "整本精修在后台跑，可以关掉页面；跑完内容直接生效"}>
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="shrink-0">整本精修 #{polishState.id}</span>
            {polishState.progress != null && (
              <span className="w-16 h-1.5 rounded-full bg-primary/20 overflow-hidden shrink-0">
                <span className="block h-full bg-primary transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, polishState.progress))}%` }} />
              </span>
            )}
            <span className="truncate text-primary/80">
              {polishState.note || (polishState.progress != null ? `${polishState.progress}%` : "进行中")}
            </span>
          </span>
        )}
        {genJob && (
          <span className="ml-2 px-2 py-0.5 rounded border border-primary/50 bg-primary/10
                           text-primary text-[11px] flex items-center gap-1.5 max-w-[380px]"
                title={genJob.note || "生成任务在后台跑，可以关掉页面；跑完内容直接写入草稿"}>
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="shrink-0">
              {genJob.kind === "gen_outline" ? "生成大纲"
                : genJob.kind === "gen_chapters" ? "生成正文"
                : genJob.kind === "gen_storyboards" ? "生成剧本" : "生成"} #{genJob.id}
            </span>
            {genJob.progress != null && (
              <span className="w-16 h-1.5 rounded-full bg-primary/20 overflow-hidden shrink-0">
                <span className="block h-full bg-primary transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, genJob.progress))}%` }} />
              </span>
            )}
            <span className="truncate text-primary/80">
              {genJob.note || (genJob.progress != null ? `${genJob.progress}%` : "排队中")}
            </span>
          </span>
        )}
        {deaiJob && (
          // 顶栏胶囊。只显示"跑到哪了"，不显示分数 —— 分数在作业详情里看，
          // 顶栏放数字会诱导用户盯着它追分（而它是相对指标，追它没意义）。
          <span className="ml-2 px-2 py-0.5 rounded border border-warning/50 bg-warning/10
                           text-warning text-[11px] flex items-center gap-1.5 max-w-[380px]"
                title="去 AI 味在后台跑，可以关掉页面。它**不改动草稿**，出的是一份独立清洗稿。">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="shrink-0">去 AI 味 #{deaiJob.id}</span>
            {deaiJob.total > 0 && (
              <span className="w-16 h-1.5 rounded-full bg-warning/20 overflow-hidden shrink-0">
                <span className="block h-full bg-warning transition-all"
                      style={{ width: `${Math.max(0, Math.min(100, Math.round((deaiJob.finished / deaiJob.total) * 100)))}%` }} />
              </span>
            )}
            <span className="truncate text-warning/80">
              {deaiJob.status !== "running" && deaiJob.status !== "pending"
                ? (deaiJob.status === "done" ? "已完成" : deaiJob.status)
                : deaiJob.total > 0
                  ? `${deaiJob.finished}/${deaiJob.total} 集`
                  : "启动中"}
              {deaiJob.failed > 0 ? ` · 失败${deaiJob.failed}` : ""}
            </span>
          </span>
        )}
        <div className="ml-auto"><UserNav /></div>
      </header>
      <div className="flex-1 flex overflow-hidden">
        {/* === 左: 对话列表 === */}
        <aside className="w-64 border-r border-line flex flex-col shrink-0 bg-surface-base">
          <div className="p-3 border-b border-line space-y-2">
            <button
              onClick={() => newConv(null)}
              className="w-full flex items-center justify-center gap-1.5 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-medium transition"
            >
              <Plus className="w-4 h-4" /> 新建对话
            </button>
            <div className="flex items-center gap-1">
              <Search className="w-3.5 h-3.5 text-ink-muted ml-1 shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                /* ⚠️ 搜索必须等所有页都加载完才准。
                   分页只加载了前 N 条，而搜索是在**已加载的那部分**里过滤的
                   （见下面 groups 的 useMemo）。于是在搜索框里打关键词时，
                   第 3 页上的老对话搜不到 —— 用户看到"没有匹配的对话"，
                   又回到"我的记录是不是被删了"那个误解。
                   点一下搜索框就把剩下的都拉下来，比让用户自己滚到底更符合预期。 */
                onFocus={() => { if (hasMoreConvs && !loadingMoreConvs) void loadAllConvs(); }}
                placeholder="搜索..."
                className="flex-1 px-2 py-1 bg-surface-overlay border border-line rounded text-xs outline-none focus:border-primary"
              />
              <button onClick={() => loadConvs()} className="p-1 hover:bg-surface-overlay rounded text-ink-secondary" title="刷新">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* ⚠️ 不能显示 `convs.length`：分页后它就是当前页条数（50），
                用户看到"共 50 个对话"会以为全部就这些 —— 那正是
                "只保留 50 条"这个误解的来源。有总数就显示总数。 */}
            <div className="text-[10px] text-ink-muted px-1">
              {convsTotal > 0
                ? `共 ${convsTotal} 个对话${convs.length < convsTotal ? `（已显示 ${convs.length}）` : ""}`
                : `共 ${convs.length} 个对话`}
            </div>
          </div>
          <div
            className="flex-1 overflow-y-auto"
            /* 滚到底自动拉下一页。判据留了 120px 余量：等真正触底才拉的话，
               用户会先看到一段空白再等请求回来。 */
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) void loadMoreConvs();
            }}
          >
            {loadingConvs ? (
              <div className="p-4 text-center"><Loader2 className="w-4 h-4 animate-spin mx-auto text-ink-muted" /></div>
            ) : convError ? (
              <div className="p-3 text-xs">
                <div className="flex items-start gap-1 text-danger mb-2"><AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="break-all">{convError}</span></div>
                <button onClick={() => loadConvs()} className="px-2 py-1 bg-surface-overlay hover:bg-surface-raised rounded text-[10px]">重试</button>
              </div>
            ) : groups.all.length === 0 ? (
              <div className="p-4 text-center text-ink-muted text-xs">{search ? "没有匹配的对话" : "还没有对话, 点上面新建对话开始"}</div>
            ) : (
              [
                { label: "今天", list: groups.today },
                { label: "昨天", list: groups.yest },
                { label: "更早", list: groups.older },
              ].map((g) => g.list.length > 0 && (
                <div key={g.label}>
                  <div className="px-3 py-1.5 text-[10px] uppercase text-ink-muted font-semibold bg-surface-overlay/40">{g.label} ({g.list.length})</div>
                  {g.list.map((c) => (
                    <ConvRow
                      key={c.id} c={c}
                      active={activeConv?.id === c.id}
                      renaming={renamingId === c.id}
                      renameVal={renameVal}
                      onClick={() => loadConv(c.id)}
                      onStartRename={() => { setRenamingId(c.id); setRenameVal(c.title); }}
                      onRenameChange={setRenameVal}
                      onRenameSubmit={() => rename(c, renameVal)}
                      onRenameCancel={() => setRenamingId(null)}
                      onDelete={() => deleteConv(c)}
                    />
                  ))}
                </div>
              ))
            )}
            {/* 滚动分页的尾巴：加载中 / 到底了。
                "到底了"必须显式写出来 —— 没有它，用户滚到底部看到空白，
                分不清是"加载失败"还是"真的没有了"，于是又回到"是不是删了"。 */}
            {!loadingConvs && !convError && groups.all.length > 0 && !search && (
              <div className="px-3 py-2 text-center text-[10px] text-ink-muted">
                {loadingMoreConvs
                  ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />加载更多…</span>
                  : hasMoreConvs
                    ? <span className="opacity-40">向下滚动加载更多</span>
                    : <span className="opacity-40">已显示全部 {convsTotal || convs.length} 个对话</span>}
              </div>
            )}
          </div>
        </aside>

        {/* === 中: 主聊天区 + 草稿分屏 === */}
        <main className="flex-1 flex min-w-0">
          <div
            className={`relative flex flex-col min-w-0 ${splitDraftId ? "w-1/2 border-r border-line" : "flex-1"}`}
            {...(activeConv ? drop.handlers : {})}
          >
            <DropOverlay show={drop.over} />
            {activeConv ? (
              <>
                {/* 会话头 */}
                <div className="px-4 py-2 border-b border-line flex items-center gap-3 text-sm bg-surface-base">
                  <span className="font-semibold truncate flex-1">{activeConv.title}</span>
                  {/* 模型选择已移到输入框旁边(见下方 composer 工具条), 头部只留会话级操作 */}
                  <button
                    onClick={exportConvAsMarkdown}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay transition"
                    title="导出为 Markdown"
                  >
                    <Download className="w-3.5 h-3.5" />导出
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setShowAttachMenu(!showAttachMenu)}
                      className="flex items-center gap-1 px-2 py-1 bg-surface-raised hover:bg-surface-overlay border border-line rounded text-xs transition"
                    >
                      {activeConv.draft_id ? <BookOpen className="w-3.5 h-3.5 text-primary" /> : <Globe className="w-3.5 h-3.5 text-ink-muted" />}
                      {activeConv.draft_id ? `#${activeConv.draft_id}` : "通用"}
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {showAttachMenu && (
                      <div className="absolute right-0 top-full mt-1 w-64 max-h-80 overflow-y-auto bg-surface-overlay border border-line rounded-md shadow-xl z-10">
                        <button onClick={async () => { setShowAttachMenu(false); await newConv(null); }}
                          className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs border-b border-line flex items-center gap-2">
                          <Globe className="w-3.5 h-3.5 text-ink-muted" />新建通用对话(不关联草稿)
                        </button>
                        {activeConv.draft_id && (
                          <button onClick={unassignDraft}
                            className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs border-b border-line flex items-center gap-2 text-warning">
                            <X className="w-3.5 h-3.5 shrink-0" />取消关联本对话(当作通用对话)
                          </button>
                        )}
                        {drafts.map((d) => (
                          <button key={d.id} onClick={() => { setShowAttachMenu(false); openDraft(d.id); }}
                            className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs flex items-center gap-2 truncate">
                            <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                            <span className="truncate">#{d.id} {d.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* 消息流 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-surface-overlay/30">
                  {messages.length === 0 && (
                    <div className="text-center text-ink-muted mt-20 text-sm">
                      <Sparkles className="w-8 h-8 mx-auto mb-3 text-primary opacity-50" />
                      和 AI 聊聊吧。输入 / 看看可用命令, 或用左下角 📎 上传剧本片段。
                    </div>
                  )}
                  {messages.map((m, i) => (
                    <div key={m.id ?? `tmp-${i}`}>
                      <Bubble
                        m={m} index={i} sending={sending} onRegenerate={() => regenerate(i)}
                        editing={editingIdx === i}
                        editVal={editVal}
                        onEditChange={setEditVal}
                        onStartEdit={() => startEdit(i)}
                        onEditSubmit={() => submitEdit(i)}
                        onEditCancel={() => setEditingIdx(null)}
                        group={m.group_id ? qaGroups[String(m.group_id)] : undefined}
                        onSwitchVersion={(v) => m.group_id && switchVersion(m.group_id, v)}
                        // 高亮"将写入草稿"的段落: 对所有生成完的 AI 回复都启用。
                        // 以前要求已关联草稿 —— 但用户完全可以先圈好段落、再选写进哪部剧
                        // （chip 支持就地关联），先决条件反过来了。
                        highlightSegments={m.role === "assistant" && !m.pending}
                        segPicks={segPicks[i]}
                        onToggleSeg={(segIdx, cur) => toggleSeg(i, segIdx, cur)}
                      />
                      {/* 一键写入草稿: 只对已生成完的 AI 回复出现。
                          ⚠️ 不再要求"已关联草稿" —— 纯对话是对话工坊的日常模式，用户常常
                          先聊出满意的文本、才想到要存进哪部剧。以前这里 draft_id 为空就
                          整块不渲染，等于**在最需要它的场景下把入口藏了起来**。
                          现在没关联时也渲染，chip 自己给「选一部剧」的下拉（选完就地关联，
                          不新建会话、不丢当前上下文）。 */}
                      {m.role === "assistant" && !m.pending && m.content && (
                        <ReplaceChip
                          replyText={m.content}
                          mode={selectedMode}
                          userMsg={findPrevUserMsg(messages, i)}
                          attachedOrder={m.attachedOrder ?? null}
                          splitOrder={null}
                          draftId={activeConv?.draft_id ?? null}
                          chapters={chapters}
                          epCount={epCount}
                          drafts={drafts}
                          onLinkDraft={linkDraftToConv}
                          segPicks={segPicks[i]}
                          onApplied={notifyDraftUpdated}
                        />
                      )}
                      {/* 体检报告卡: 贴在助手气泡下方, 就地勾选/就地修 ——
                          用户全程不离开对话工坊(这是"主体是对话工坊"的落点)。 */}
                      {m.role === "assistant" && !m.pending && m.report && (
                        <ReportCard
                          report={m.report}
                          fix={m.fix ?? null}
                          fixing={!!fixJob}
                          onFix={(ids) => fixIssues(ids, m.report?.report_id)}
                        />
                      )}
                      {/* 去 AI 味作业卡：贴在发过"已启动去 AI 味"的那条助手消息下面。
                          与其他卡片一样，它**不接管对话** —— 用户想问别的可以直接接着问。
                          注意它**没有"应用到草稿"按钮**：去 AI 味不碰草稿，加那个按钮
                          等于暗示草稿被改了（见 _DeaiCard.tsx 的注释）。 */}
                      {m.role === "assistant" && !m.pending && (() => {
                        const jid = deaiJobAt.get(i);
                        const card = jid != null ? deaiCards[jid] : undefined;
                        return card ? <DeaiCard job={card} /> : null;
                      })()}
                      {m.operation && (
                        <OperationCard op={m.operation} onUpdated={(fresh) => {
                          setMessages((prev) => {
                            const next = [...prev]; next[i] = { ...next[i], operation: fresh }; return next;
                          });
                        }} />
                      )}
                    </div>
                  ))}
                  <div ref={messagesEndRef} />

                  {/* 改前 / 改后对照。**用户明确要求的形式**："之前预设的那种文本块形式
                      左右分别是原文和修改后的文本"。数据来自 `GET /jobs/{id}/changes`，
                      只在作业终态拉一次（几十万字，塞进轮询会把浏览器拖死）。
                      贴在消息流末尾而不是某条消息里 —— 它属于"这一次作业"，
                      而作业可能由按钮发起、也可能由上一轮对话触发，挂在某条消息上会错位。 */}
                  {genDiff && (
                    <div className="rounded-lg border border-line bg-surface-raised/40 p-2.5">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[11px] text-ink-muted">
                          作业 #{genDiff.job_id} 对照
                        </span>
                        <button onClick={() => setGenDiff(null)}
                          className="ml-auto text-[11px] text-ink-secondary hover:text-ink-primary
                                     px-1.5 py-0.5 rounded hover:bg-surface-overlay transition">
                          收起
                        </button>
                      </div>
                      <RewriteDiff data={genDiff} />
                    </div>
                  )}
                </div>

                {/* 动作栏: 五个入口(结构/文风/一致性/分镜/一键体检)按**意图**
                    分成 查/改 两组, 长在输入框上方 —— 用户不必去草稿页的五个 tab
                    里找它们。生成类三件事收进了「生成 ▾」下拉（用户要求别那么显眼，
                    真正常用的是「专业方法」里的预设）。 */}
                <ActionBar
                  disabled={!activeConv || sending}
                  busy={!!fixJob || !!polishJob || !!deaiJob}
                  draftId={activeConv?.draft_id ?? null}
                  maxEp={epCount ?? (chapters.length || null)}
                  scope={scope}
                  onScopeChange={setScope}
                  onPick={pickAction}
                  modes={modes}
                  selectedMode={selectedMode}
                  onModeChange={setSelectedMode}
                  genKind={genJob?.genKind === "outline" || genJob?.genKind === "chapters"
                             || genJob?.genKind === "storyboards"
                             ? genJob.genKind : null}
                  genJob={genJob}
                  onGenPick={pickGen}
                />
                <AgentDrawer draftId={activeConv?.draft_id ?? null} />

                {/* 待发送附件预览 */}
                {pendingAttachments.length > 0 && (
                  <div className="border-t border-line bg-surface-base/60 px-3 py-2 flex flex-wrap gap-2">
                    {pendingAttachments.map((a, i) => (
                      <div key={i} className="flex items-center gap-1.5 bg-surface-overlay border border-line rounded px-2 py-1 text-xs max-w-xs">
                        {a.kind === "file" ? <FileText className="w-3.5 h-3.5 text-primary shrink-0" /> : <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />}
                        <span className="truncate">{a.name}</span>
                        <span className="text-ink-muted shrink-0">{a.kind === "file" ? formatBytes(a.size) : `${a.size} 字`}</span>
                        {a.truncated && <span className="text-warning shrink-0">截断</span>}
                        <button onClick={() => removeAttachment(i)} className="hover:bg-danger/15 hover:text-danger rounded p-0.5 shrink-0">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 待发图片 */}
                {pimg.images.length > 0 && (
                  <div className="border-t border-line bg-surface-base/60 px-3 py-2">
                    <PendingImageStrip images={pimg.images} onRemove={pimg.remove} />
                  </div>
                )}

                {/* 输入区 */}
                <div className="p-3 border-t border-line bg-surface-base">
                  <div className="flex gap-2 items-end">
                    {/* 附件按钮 */}
                    <div className="relative">
                      <button
                        onClick={() => setShowAttachPicker(!showAttachPicker)}
                        disabled={sending}
                        className="p-2 rounded-md bg-surface-overlay hover:bg-surface-raised border border-line text-ink-secondary disabled:opacity-50 transition"
                        title="添加附件"
                      >
                        <Paperclip className="w-4 h-4" />
                      </button>
                      {showAttachPicker && (
                        <div className="absolute left-0 bottom-full mb-2 w-72 max-h-80 overflow-y-auto bg-surface-overlay border border-line rounded-md shadow-xl z-20">
                          <button
                            onClick={() => { setShowAttachPicker(false); imageInputRef.current?.click(); }}
                            className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs border-b border-line flex items-center gap-2"
                          >
                            <ImageIcon className="w-3.5 h-3.5 text-primary" />
                            发送图片（也可直接粘贴 / 拖进对话区，≤10MB，最多 10 张）
                          </button>
                          <button
                            onClick={() => { setShowAttachPicker(false); fileInputRef.current?.click(); }}
                            disabled={uploadingFile}
                            className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs border-b border-line flex items-center gap-2 disabled:opacity-50"
                          >
                            <FileText className="w-3.5 h-3.5 text-primary" />
                            {uploadingFile ? "上传中..." : "上传文件 (.txt/.md/.docx/.pdf, ≤10MB)"}
                          </button>
                          {chapters.length > 0 ? (
                            <>
                              <div className="px-3 py-1 text-[10px] uppercase text-ink-muted font-semibold bg-surface-base/40">
                                {chapters[0].source === "script" ? "引用关联草稿剧本" : "引用关联草稿章节"}
                              </div>
                              {chapters.map((ch) => {
                                const unit = ch.source === "script" ? "集" : "章";
                                return (
                                  <button key={ch.chapter_order} onClick={() => attachChapter(ch)}
                                    className="w-full text-left px-3 py-2 hover:bg-surface-base text-xs flex items-center gap-2">
                                    <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                                    <span className="truncate flex-1">第 {ch.chapter_order} {unit} · {ch.title}</span>
                                    <span className="text-ink-muted shrink-0">{ch.full_text.length} 字</span>
                                  </button>
                                );
                              })}
                            </>
                          ) : activeConv?.draft_id ? (
                            <div className="px-3 py-2 text-[11px] text-ink-muted">关联草稿暂无剧本或章节</div>
                          ) : (
                            <div className="px-3 py-2 text-[11px] text-ink-muted">把对话关联草稿后, 这里会列出可引用的剧本(优先)或章节</div>
                          )}
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept=".txt,.md,.markdown,.docx,.pdf,text/plain"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <input
                      type="file"
                      ref={imageInputRef}
                      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                      multiple
                      onChange={(e) => {
                        pimg.add(Array.from(e.target.files || []));
                        e.target.value = "";
                      }}
                      className="hidden"
                    />

                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onPaste={(e) => {
                        // 截图 / 复制的图片直接 Ctrl+V。剪贴板里同时有文字时（从 Word/网页
                        // 复制一段带图的内容）不能吞掉默认行为，否则文字粘不进来。
                        const { files, hasText } = imagesFromClipboard(e);
                        if (!files.length) return;
                        if (!hasText) e.preventDefault();
                        pimg.add(files);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (!sending) void send();
                        }
                      }}
                      // 输入框只有一个身份了：**跟 AI 聊天**。
                      // 以前它还兼职"精修参考意见输入框"（点了「精修这批」后变提示语），
                      // 那个中间态随按钮点击即发一起去掉了。
                      placeholder={sending
                        ? "生成中..."
                        : "跟 AI 聊：让它写、改、出主意 —— 回复里的文本可以选中后写进草稿。Enter 发送 · Shift+Enter 换行"}
                      rows={2}
                      disabled={sending}
                      // 随内容自动增高(min≈2行, max 260px 后内部滚动); resize-none 关闭手动拖拽, 由 JS 控高
                      style={{ minHeight: 56, maxHeight: INPUT_MAX_H }}
                      className="flex-1 px-3 py-2 bg-surface-overlay border border-line rounded-md text-sm resize-none outline-none focus:border-primary leading-relaxed"
                    />

                    {/* 发送/停止按钮 */}
                    {sending ? (
                      <button
                        onClick={stopGenerating}
                        className="px-3 h-10 bg-danger hover:bg-danger/90 text-white rounded-md text-sm font-medium flex items-center gap-1 transition"
                      >
                        <StopCircle className="w-4 h-4" />停止
                      </button>
                    ) : (
                      <button
                        onClick={() => send()}
                        disabled={pimg.uploading || (!input.trim() && pendingAttachments.length === 0 && pimg.readyIds.length === 0)}
                        title={pimg.uploading ? "图片上传中…" : undefined}
                        className="px-3 h-10 bg-primary hover:bg-primary/90 text-white disabled:opacity-50 rounded-md text-sm font-medium flex items-center gap-1 transition"
                      >
                        <Send className="w-4 h-4" />发送
                      </button>
                    )}
                  </div>

                  {/* 输入框下方工具条: 模型切换 + 生成参数(豆包/ChatGPT 式, 就手可及) */}
                  <div ref={composerBarRef} className="flex items-center gap-1.5 mt-2">
                    {/* --- 模型选择 --- */}
                    <div className="relative">
                      <button
                        ref={modelBtnRef}
                        onClick={() => { setShowParamMenu(false); setShowModelMenu((v) => !v); }}
                        className={`flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full border text-xs transition ${showModelMenu ? "bg-surface-raised border-primary/60" : "bg-surface-overlay border-line hover:bg-surface-raised"}`}
                        title={currentItem ? `当前模型: ${currentItem.model}（${currentItem.reason}）` : (currentModel?.model ? `当前模型: ${currentModel.model}` : "选择模型")}
                      >
                        <Cpu className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="text-ink-primary max-w-[9rem] truncate">{currentLabel}</span>
                        <ChevronDown className="w-3 h-3 text-ink-muted" />
                      </button>
                      {/* 两级菜单: 先四个厂商, 移上去才在右侧展开该厂商的型号。
                          清单与"稳"标都来自后端实测; 线路名不下发给用户。
                          modelGroups 为空(清单接口不可达)时退回老的扁平表, 不挡用户干活。 */}
                      {modelGroups.length > 0 ? (
                        <ModelMenu
                          open={showModelMenu}
                          anchorEl={modelBtnRef.current}
                          groups={modelGroups}
                          value={provider}
                          onPick={changeProvider}
                          onClose={() => setShowModelMenu(false)}
                          direction="up"
                        />
                      ) : showModelMenu && (
                        <div className="absolute left-0 bottom-full mb-2 w-72 max-h-[26rem] overflow-y-auto bg-surface-overlay border border-line rounded-lg shadow-xl z-30">
                          {models.map((m) => {
                            const active = m.provider === provider;
                            return (
                              <button
                                key={m.provider}
                                onClick={() => { changeProvider(m.provider); setShowModelMenu(false); }}
                                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-xs transition ${active ? "bg-primary/15" : "hover:bg-surface-base"}`}
                              >
                                <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-primary ${active ? "" : "opacity-0"}`} />
                                <div className="min-w-0 flex-1">
                                  <div className="text-ink-primary font-medium truncate">{m.label}</div>
                                  {m.model && <div className="text-[10px] text-ink-muted font-mono truncate">{m.model}</div>}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* --- 生成参数 --- */}
                    <div className="relative">
                      <button
                        onClick={() => { setShowModelMenu(false); setShowParamMenu((v) => !v); }}
                        className={`flex items-center gap-1 px-2 py-1 rounded-full border text-xs transition ${showParamMenu ? "bg-surface-raised border-primary/60" : "bg-surface-overlay border-line hover:bg-surface-raised"}`}
                        title="生成参数(温度 / top_p / 上下文轮数)"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5 text-ink-secondary" />
                        {paramsDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary" title="参数已调整" />}
                      </button>
                      {showParamMenu && (
                        <div className="absolute left-0 bottom-full mb-2 w-80 bg-surface-overlay border border-line rounded-lg shadow-xl z-30 p-3 space-y-3 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] uppercase text-ink-muted font-semibold">生成参数</span>
                            <button
                              onClick={resetParams}
                              disabled={!paramsDirty}
                              className="flex items-center gap-1 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40 disabled:hover:text-ink-secondary transition"
                            >
                              <RotateCcw className="w-3 h-3" />恢复默认
                            </button>
                          </div>
                          <ParamSlider
                            label="温度 (temperature)"
                            spec={paramSpecs.temperature}
                            value={genParams.temperature}
                            display={genParams.temperature.toFixed(1)}
                            hint="越低越稳、越守规矩; 越高越发散、越敢写。写正文一般 0.6~0.9, 做分析/提取调到 0.2 更可靠。"
                            onChange={(v) => patchParams({ temperature: Number(v.toFixed(2)) })}
                          />
                          <ParamSlider
                            label="核采样 (top_p)"
                            spec={paramSpecs.top_p}
                            value={genParams.top_p}
                            display={genParams.top_p >= paramSpecs.top_p.max ? "默认(不限制)" : genParams.top_p.toFixed(2)}
                            hint="只从概率最高的一小撮词里挑。拉到最右=不下发该参数, 用模型自己的默认; 一般和温度二选一调, 别两个一起压。"
                            onChange={(v) => patchParams({ top_p: Number(v.toFixed(2)) })}
                          />
                          <HistoryTurnsSlider
                            spec={paramSpecs.history_turns}
                            value={genParams.history_turns}
                            onChange={(v) => patchParams({ history_turns: v })}
                          />
                          <div className="text-[10px] text-ink-muted leading-snug border-t border-line pt-2">
                            参数即时生效, 下一条消息就按新值发送; 浏览器本地记忆, 换设备需重设。
                          </div>
                        </div>
                      )}
                    </div>

                    {/* --- 模式切换: 自动精修 / 讨论 ---
                        这两种模式的实质区别（不是话术区别）：
                          · 自动精修 = 你这句话是"参考意见"，直接触发整本 AI 精修
                            （通读全剧诊断 → 分批重写 → 覆写回草稿），不跑对话循环
                          · 讨论 = 对话工坊原来的行为：一问一答，AI 调工具逐处改
                        这两个入口已收进输入框上方的动作栏（「改」组），
                        这里不再重复一个下拉 —— 两个开关说同一件事，用户会以为它们不一样。 */}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-ink-muted">
                <div className="text-center">
                  <MessageSquare className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p>从左侧选一个对话, 或新建一个</p>
                  <p className="text-xs mt-2 text-ink-muted">或在右侧点一个草稿, 自动打开关联对话</p>
                </div>
              </div>
            )}
          </div>

          {/* 草稿产物面板（B11 / PLAN §4.5.7）。
              此前这里是 `<iframe src="/jubengongfang/drafts/{id}?embed=1">` —— 把整个工作台塞进来，
              用户想看"我正在写的那份东西"却拿到一整套后台（总览/预览/分析/生图/
              提示词/导出…）。用户原话："只是粗暴的把页面塞了进去"。

              现在改成一个原生的四页签产物面板（原文/剧本/小说/推文）。
              它同时是 §4.5.8「选中文本拖进某一集」的前置条件 ——
              那条交互要求左右两侧在同一个文档里，跨 iframe 拖拽做不到。 */}
          {splitDraftId && (
            <DraftProductPane
              draftId={splitDraftId}
              draftTitle={activeDraft?.title}
              refreshKey={draftRefreshKey}
              onClose={() => setSplitDraftId(null)}
            />
          )}
        </main>

        {/* === 右: 草稿 + 设置 === */}
        <aside className="w-72 border-l border-line flex flex-col shrink-0 bg-surface-base">
          <div className="flex border-b border-line text-xs">
            {[
              { k: "drafts", icon: <FileText className="w-3.5 h-3.5" />, label: "草稿" },
              { k: "settings", icon: <Settings className="w-3.5 h-3.5" />, label: "设置" },
            ].map((t) => (
              <button key={t.k} onClick={() => setRightTab(t.k as any)}
                className={`flex-1 py-2 flex items-center justify-center gap-1 transition ${rightTab === t.k ? "bg-surface-overlay border-b-2 border-primary text-ink-primary" : "text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay/50"}`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {rightTab === "drafts" && <DraftsPanel drafts={drafts} activeDraftId={activeConv?.draft_id || null} splitDraftId={splitDraftId} onOpenDraft={openDraft} />}
            {rightTab === "settings" && <SettingsPanel />}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 生成参数滑块: 区间/步长全部来自后端下发的 spec, 前端不写死数值。 */
function ParamSlider({ label, spec, value, display, hint, onChange }: {
  label: string; spec: ParamSpec; value: number; display: string; hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-ink-secondary">{label}</span>
        <span className="text-ink-primary font-mono text-[11px]">{display}</span>
      </div>
      <input
        type="range"
        min={spec.min} max={spec.max} step={spec.step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-primary cursor-pointer"
      />
      <div className="text-[10px] text-ink-muted mt-1 leading-snug">{hint}</div>
    </div>
  );
}

/** 上下文轮数滑块: 滑到最右一格自动变成"不限"(与 Poe/Claude.ai 等主流产品一致)。 */
function HistoryTurnsSlider({ spec, value, onChange }: {
  spec: ParamSpec; value: number; onChange: (v: number) => void;
}) {
  // 滑块内部多一格: min..max 为正常轮数, max+step 那一格 = 不限(哨兵 0)
  const sliderMax = spec.max + spec.step;
  const unlimited = value === HISTORY_UNLIMITED;
  const sliderVal = unlimited ? sliderMax : value;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-ink-secondary">上下文轮数</span>
        <span className={`font-mono text-[11px] ${unlimited ? "text-primary font-semibold" : "text-ink-primary"}`}>
          {unlimited ? "不限 ∞" : `${value} 轮`}
        </span>
      </div>
      <input
        type="range"
        min={spec.min} max={sliderMax} step={spec.step}
        value={sliderVal}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v > spec.max ? HISTORY_UNLIMITED : Math.round(v));
        }}
        className="w-full h-1 accent-primary cursor-pointer"
      />
      <div className="flex justify-between text-[9px] text-ink-muted mt-0.5 select-none">
        <span>{spec.min}</span>
        <span>{spec.max}</span>
        <span className={unlimited ? "text-primary" : ""}>∞</span>
      </div>
      <div className="text-[10px] text-ink-muted mt-1 leading-snug">
        每次带上最近多少轮对话。拖到最右 = 不限 —— 整段历史全带上, 长会话可能超出模型上下文而报错, 也更贵。
      </div>
    </div>
  );
}

/** 取某条回复对应的用户提问(向上找最近一条 user 消息), 用于推断集号/目标类型。 */
function findPrevUserMsg(msgs: Message[], idx: number): string {
  for (let i = idx - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i].content || "";
  }
  return "";
}

/**
 * 一键替换 chip: AI 回复下方的「⇥ 替换 → #123 第1集 · 小说」按钮。
 *
 * 设计取舍(见 lib/replaceDetect.ts 顶部注释):
 * - 识别全在客户端完成, 不发 LLM 请求 —— 超级 Agent 那条路正是因为要等
 *   detect_intent 再来一次 LLM 才慢到没人用(dev 库 agent_operations 0 行)。
 * - 直写不确认, 撤销放事后(Gmail 撤回模型)。四类目标的写入端点都会在覆盖前
 *   存历史版本, 所以撤销总是可用。
 */
function ReplaceChip({ replyText, mode, userMsg, attachedOrder, splitOrder, draftId, chapters, epCount, drafts, onLinkDraft, segPicks, onApplied }: {
  replyText: string; mode: string | null; userMsg: string;
  attachedOrder: number | null; splitOrder: number | null;
  // null = 本会话还没关联草稿。此时 chip 先让用户挑一部剧（就地关联，不切会话）。
  draftId: number | null;
  chapters: ChapterBrief[];
  // 这部剧一共有多少集（大纲/剧本/正文取最大值，见 epCount 的注释）。
  // 它比 chapters 大：chapters 只装**已生成**的集，而写入允许落在还没生成的空集上
  // （后端 PATCH chapters/{order} 是 upsert，会先补一份 v1 空快照）。
  epCount: number | null;
  drafts: DraftBrief[];
  onLinkDraft: (draftId: number) => Promise<boolean>;
  segPicks?: Record<number, boolean>;
  onApplied: (kind?: string, order?: number | null) => void;
}) {
  // 用户在本气泡内选中的文字(选中优先: 解决"回复里只有一部分是正文")
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [kind, setKind] = useState<ReplaceKind | null>(null);
  const [order, setOrder] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // 没关联草稿时，展开「选一部剧」的下拉
  const [showDraftPicker, setShowDraftPicker] = useState(false);
  const [linking, setLinking] = useState(false);

  const det = useMemo(
    () => detectReplaceable({ replyText, mode, userMsg, attachedOrder, splitOrder, selectedText, segmentPicks: segPicks }),
    [replyText, mode, userMsg, attachedOrder, splitOrder, selectedText, segPicks],
  );
  // 用户手动改过就用手动值, 否则跟随识别结果
  const effKind = kind ?? det.kind;
  const effOrder = order ?? det.chapterOrder;
  // 目标集是否锁定 —— **两种锁都不再拦替换**(2026-09)。
  //
  // 原文(chapter)刻意不查锁: 库里每一个 script_chapters.locked=1 都是机器打的
  // (导入剧本 router.py:1918/2059/2318、视频流水线 video_pipeline.py:135),
  // 前端从来没有让用户锁章节的入口, lock_chapter 端点无人调用 ——
  // 实测 1973 个章节锁里 1964 个来自 imported 草稿, 正常生成的草稿一个都没有。
  // 那个锁的本意是"批量重生成别覆盖用户成品"(batch_gen.py:122), 而一键替换是
  // 用户此刻的明确指令, 用机器锁去拦它没有道理。
  //
  // 剧本锁(script_storyboards.locked)从本次起也不再查: 它没有任何界面入口能
  // 打开或解除, 现网 7933 行剧本里 0 行处于锁定态, 两个 lock 端点全仓 0 调用方。
  // 后端 patch_storyboard 与历史恢复处的 409 已一并摘除, 前端再拦就成了
  // "提示已锁定、却没有地方解锁"的死角。
  //
  // ⚠️ 但**不清除** locked 的值: export_worker.py:114 用它决定默认导出取原文
  // 还是剧本(`source = "chapter" if chapter_locked else "storyboard"`),
  // 顺手清掉会静默改变导出结果。替换只改内容, 锁位原样保留。

  // 选中文字后立刻反映到按钮上(mouseup 时读取当前 selection)
  function syncSelection(e: React.MouseEvent) {
    const sel = window.getSelection?.();
    const t = sel ? sel.toString().trim() : "";
    // 只认落在本气泡内的选区
    const within = sel && sel.anchorNode && (e.currentTarget as HTMLElement).contains(sel.anchorNode);
    setSelectedText(t && within ? t : null);
  }

  async function apply() {
    // draftId 为空说明本会话还没关联草稿 —— 由 UI 先引导选剧, 这里只做兜底
    if (draftId == null || !effKind || effOrder == null || !det.body) return;
    setState("busy"); setErr(null);
    try {
      let r: Response;
      if (effKind === "storyboard") {
        r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/storyboards/${effOrder}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shots_json: textToShots(det.body) }),
        });
      } else if (effKind === "chapter") {
        r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/chapters/${effOrder}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_text: det.body }),
        });
      } else {
        // novel / tweet: draft_id 走 query, 见 adapt_products/routes.py edit_item
        r = await authFetch(`${BASE}/v1/adapt/${effKind}/${effOrder}?draft_id=${draftId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: det.body }),
        });
      }
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = `HTTP ${r.status}`;
        try { const j = JSON.parse(t); msg = j.detail || j.message || msg; } catch { if (t) msg = t.slice(0, 200); }
        // 曾把 409 一律翻译成"该集剧本已锁定" —— 锁拦截已移除(2026-09), 再硬翻会
        // 掩盖真正的 409(如该草稿有任务正在运行)。直接透传后端 detail。
        setErr(msg); setState("error"); return;
      }
      setState("done");
      onApplied(effKind, effOrder);
    } catch (e: any) {
      setErr(String(e?.message || e).slice(0, 200)); setState("error");
    }
  }

  /** 撤销: 取最近一条历史版本回填。写入时已存快照, 所以总有东西可回。 */
  async function undo() {
    if (draftId == null || !effKind || effOrder == null) return;
    setUndoing(true); setErr(null);
    try {
      if (effKind === "novel" || effKind === "tweet") {
        // adapt 有专门的 history/restore(取 history_id), 比自己 PATCH 回去更稳
        const hr = await authFetch(`${BASE}/v1/adapt/${effKind}/${effOrder}/history?draft_id=${draftId}`);
        const items = hr.ok ? ((await hr.json()).items || []) : [];
        if (!items.length) { setErr("没有可回退的历史版本"); return; }
        const back = await authFetch(`${BASE}/v1/adapt/${effKind}/${effOrder}/history/restore?draft_id=${draftId}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history_id: items[0].id }),
        });
        if (!back.ok) { setErr("撤销失败"); return; }
      } else {
        // 章节/剧本走 episodes 历史接口。注意契约(见 router_m5_enhanced.py):
        //   GET  /episodes/{order}/history?stage=   → 直接返回数组(不是 {items})
        //   POST /episodes/{order}/restore          → body 要 {stage, version}, 不是 history_id
        const stage = effKind === "storyboard" ? "storyboard" : "chapter";
        const hr = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/episodes/${effOrder}/history?stage=${stage}`);
        if (!hr.ok) { setErr("取历史版本失败"); return; }
        const data = await hr.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        if (!items.length) { setErr("没有可回退的历史版本"); return; }
        const rr = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/episodes/${effOrder}/restore`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, version: items[0].version }),
        });
        if (!rr.ok) { setErr("撤销失败"); return; }
      }
      setState("idle");
      onApplied(effKind, effOrder);
    } catch (e: any) {
      setErr(String(e?.message || e).slice(0, 120));
    } finally { setUndoing(false); }
  }

  // 没识别出正文 → 不打扰
  if (!det.body.trim()) return null;

  // 剧本闸门: 目标是剧本但解析不出场次, 硬塞会把整段挤进一个隐式场的 action,
  // 表面成功、结构烂掉。此时给提示而非按钮。
  if (det.storyboardUnparseable) {
    return (
      <div className="ml-1 mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
        <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0" />
        <span>这段不是分镜格式(缺【场】场头), 未提供一键替换。</span>
        <button
          onClick={() => setKind("chapter")}
          className="text-primary hover:underline"
        >改为替换章节正文</button>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="ml-1 mt-1 flex items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1 text-success">
          <Check className="w-3.5 h-3.5" />
          已替换 · 第{effOrder}{effKind ? KIND_UNIT[effKind] : ""} {effKind ? KIND_LABEL[effKind] : ""}
        </span>
        <button onClick={undo} disabled={undoing}
          className="flex items-center gap-1 text-ink-secondary hover:text-ink-primary disabled:opacity-50">
          {undoing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}撤销
        </button>
        {err && <span className="text-danger">{err}</span>}
      </div>
    );
  }

  // ── 还没关联草稿: 先让用户挑一部剧 ──
  // 这是纯对话模式下最常见的路径（先聊出满意的文本，再想存哪）。以前整块不渲染，
  // 用户根本看不出"聊出来的东西能写进草稿"。
  if (draftId == null) {
    return (
      <div className="ml-1 mt-1 relative">
        <button
          onClick={() => setShowDraftPicker((v) => !v)}
          disabled={linking}
          title="把这段文本写进某部剧的某一集（选完就地关联，不会新建对话、不会丢当前聊天）"
          className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-line bg-surface-overlay text-[11px] text-ink-secondary hover:text-ink-primary hover:border-primary/60 hover:bg-surface-raised disabled:opacity-50 transition"
        >
          {linking
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            : <CornerDownLeft className="w-3.5 h-3.5 text-primary" />}
          写进草稿 → 选一部剧
          <ChevronDown className="w-3 h-3" />
        </button>
        {showDraftPicker && (
          <div className="absolute left-0 top-full mt-1 w-64 max-h-64 overflow-y-auto bg-surface-overlay border border-line rounded-lg shadow-xl z-20 p-1">
            <div className="px-2 py-1 text-[10px] text-ink-muted leading-snug">
              选好之后本对话就跟这部剧关联了，接着挑第几集写入（还没生成的空集也能写）。
            </div>
            {drafts.map((d) => (
              <button
                key={d.id}
                onClick={async () => {
                  setLinking(true);
                  const ok = await onLinkDraft(d.id);
                  setLinking(false);
                  setShowDraftPicker(false);
                  if (!ok) setErr("关联失败, 请重试");
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-surface-base text-[11px] flex items-center gap-2 truncate"
              >
                <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="truncate">#{d.id} {d.title}</span>
              </button>
            ))}
            {drafts.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] text-ink-muted">还没有草稿，先去「草稿」页新建一部。</div>
            )}
          </div>
        )}
        <span className="ml-2 text-[10px] text-ink-muted">
          {selectedText ? `选中 ${det.body.length} 字` : `${det.body.length} 字`}
        </span>
        {err && <span className="ml-2 text-[10px] text-danger">{err}</span>}
      </div>
    );
  }

  const ready = effKind != null && effOrder != null;
  const label = effKind != null && effOrder != null
    ? `写入 → #${draftId} 第${effOrder}${KIND_UNIT[effKind]} · ${KIND_LABEL[effKind]}`
    : "写入 → 选择目标";

  // 集号候选：1..epCount 全给（不只给已生成的集）。
  // 后端 PATCH chapters/{order} 是 upsert（stages/router.py patch_chapter：没有这一行
  // 就先写一份 v1 空快照再建行），所以写进"还没生成的集"本来就是支持的 ——
  // 以前这里只列 chapters（已生成的集），把这个能力藏掉了，用户想补空缺无从下手。
  const filled = new Set(chapters.map((c) => c.chapter_order));
  const epChoices = epCount && epCount > 0
    ? Array.from({ length: epCount }, (_, i) => i + 1)
    : chapters.map((c) => c.chapter_order);

  return (
    <div className="ml-1 mt-1" onMouseUp={syncSelection}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <div className="flex items-center rounded-full border border-line bg-surface-overlay overflow-hidden">
            <button
              onClick={apply}
              disabled={!ready || state === "busy"}
              title={ready ? "直接写入草稿, 写入后可撤销" : "先选择替换目标"}
              className="flex items-center gap-1 pl-2.5 pr-2 py-1 text-[11px] text-ink-primary hover:bg-surface-raised disabled:opacity-50 transition"
            >
              {state === "busy"
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                : <CornerDownLeft className="w-3.5 h-3.5 text-primary" />}
              {label}
            </button>
            <button
              onClick={() => setShowPicker((v) => !v)}
              title="改目标"
              className="px-1.5 py-1 border-l border-line text-ink-muted hover:text-ink-primary hover:bg-surface-raised transition"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          </div>
          {showPicker && (
            <div className="absolute left-0 top-full mt-1 w-60 bg-surface-overlay border border-line rounded-lg shadow-xl z-20 p-2 space-y-2">
              <div>
                <div className="text-[10px] uppercase text-ink-muted font-semibold mb-1">替换成</div>
                <div className="flex flex-wrap gap-1">
                  {(["storyboard", "chapter", "novel", "tweet"] as ReplaceKind[]).map((k) => (
                    <button key={k} onClick={() => setKind(k)}
                      className={`px-2 py-0.5 rounded-full text-[11px] border transition ${effKind === k ? "bg-primary text-white border-primary" : "bg-surface-base text-ink-secondary border-line hover:border-primary/50"}`}>
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-ink-muted font-semibold mb-1">第几集</div>
                <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                  {epChoices.map((n) => {
                    const has = filled.has(n);
                    return (
                      <button key={n} onClick={() => { setOrder(n); setShowPicker(false); }}
                        title={has ? `第${n}集已有内容, 写入会覆盖(可撤销)` : `第${n}集还是空的, 写入即补上这一集`}
                        className={`px-2 py-0.5 rounded text-[11px] border transition ${
                          effOrder === n
                            ? "bg-primary text-white border-primary"
                            : has
                              ? "bg-surface-base text-ink-secondary border-line hover:border-primary/50"
                              // 空集用虚线框区分：一眼看出哪几集还没写，这是"补空缺"的入口
                              : "bg-surface-base text-ink-muted border-line border-dashed hover:border-primary/50"
                        }`}>
                        {n}
                      </button>
                    );
                  })}
                  {epChoices.length === 0 && <span className="text-[10px] text-ink-muted">关联草稿暂无可选集</span>}
                </div>
                {epChoices.length > 0 && (
                  <div className="mt-1 text-[10px] text-ink-muted leading-snug">
                    虚线框 = 这一集还是空的，写进去就等于补上它（不用先生成）。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <span className="text-[10px] text-ink-muted">
          {selectedText ? `选中 ${det.body.length} 字` : `${det.body.length} 字`}
          {effKind === "storyboard" && det.sceneCount > 0 && ` · ${det.sceneCount} 场`}
        </span>
        {selectedText && (
          <button onClick={() => setSelectedText(null)}
            className="text-[10px] text-ink-muted hover:text-ink-primary underline">用整段</button>
        )}
        {state === "error" && err && <span className="text-[10px] text-danger">{err}</span>}
      </div>
    </div>
  );
}

/**
 * 带"将写入草稿"高亮的回复正文。
 *
 * 为什么做成段落点选而不是拖拽选区: 气泡是 ReactMarkdown 渲染的, DOM 与原文
 * 不是一一对应(`**粗**` 在 DOM 里没有星号), 拖拽要做 range→原文偏移的反向映射,
 * 跨节点容易错位。段落是 AI 输出的天然单位("改写说明:"必然自成一段), 点一下
 * 就能加/减, 比拖拽准也比拖拽快。段内混排的极少数情况可用划选覆盖。
 */
function SegmentedContent({ content, picks, onToggle }: {
  content: string;
  picks?: Record<number, boolean>;
  onToggle?: (segIdx: number, cur: boolean) => void;
}) {
  const segs = useMemo(() => segmentReply(content), [content]);
  if (segs.length === 0) {
    return (
      <div className="prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkFriendly]}>{content}</ReactMarkdown>
      </div>
    );
  }
  const isOn = (i: number, sg: { suggested: boolean }) =>
    picks && i in picks ? picks[i] : sg.suggested;

  return (
    <div className="space-y-1">
      {segs.map((sg, i) => {
        const on = isOn(i, sg);
        return (
          <div
            key={i}
            className={`group/seg relative rounded px-2 py-1 -mx-1 transition ${
              on ? "bg-primary/15 border-l-2 border-primary" : "opacity-60 border-l-2 border-transparent"
            }`}
          >
            <div className="prose prose-sm prose-invert max-w-none [&_p]:my-0.5 [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:rounded [&_pre]:bg-surface-overlay [&_pre]:border [&_pre]:border-line [&_a]:text-primary [&_table]:text-xs [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkFriendly]}>{sg.raw}</ReactMarkdown>
            </div>
            <button
              onClick={() => onToggle?.(i, on)}
              title={on ? "不写入这一段" : "把这一段也写入"}
              className={`absolute -right-1 top-1 opacity-0 group-hover/seg:opacity-100 transition rounded px-1 text-[10px] leading-4 border ${
                on ? "bg-surface-base border-line text-ink-secondary hover:text-danger"
                   : "bg-primary text-white border-primary"
              }`}
            >
              {on ? "−" : "+"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ConvRow({ c, active, renaming, renameVal, onClick, onStartRename, onRenameChange, onRenameSubmit, onRenameCancel, onDelete }: any) {
  return (
    <div
      onClick={() => !renaming && onClick()}
      className={`group px-3 py-2 cursor-pointer flex items-center gap-1 text-xs border-b border-line/40 transition ${active ? "bg-primary/15" : "hover:bg-surface-overlay/40"}`}
    >
      <div className="flex-1 min-w-0">
        {renaming ? (
          <input
            autoFocus value={renameVal}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onRenameSubmit(); if (e.key === "Escape") onRenameCancel(); }}
            onBlur={onRenameSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-1 py-0.5 bg-surface-overlay border border-primary/50 rounded text-xs outline-none"
          />
        ) : (
          <>
            <div className="truncate text-ink-primary">{c.title}</div>
            <div className="text-[10px] text-ink-muted flex items-center gap-1">
              {c.draft_id ? <><BookOpen className="w-3 h-3" />#{c.draft_id}</> : <><Globe className="w-3 h-3" />通用</>}
              {c.message_count != null && <span>· {c.message_count} 条</span>}
            </div>
          </>
        )}
      </div>
      {!renaming && (
        <div className="opacity-0 group-hover:opacity-100 flex gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); onStartRename(); }} className="p-1 hover:bg-surface-overlay rounded"><Edit3 className="w-3 h-3" /></button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="p-1 hover:bg-danger/40 rounded text-danger"><Trash2 className="w-3 h-3" /></button>
        </div>
      )}
    </div>
  );
}

function Bubble({ m, index, sending, onRegenerate, editing, editVal, onEditChange, onStartEdit, onEditSubmit, onEditCancel, group, onSwitchVersion, highlightSegments, segPicks, onToggleSeg }: {
  m: Message; index: number; sending: boolean; onRegenerate: () => void;
  editing?: boolean; editVal?: string;
  onEditChange?: (v: string) => void;
  onStartEdit?: () => void; onEditSubmit?: () => void; onEditCancel?: () => void;
  group?: QaGroup; onSwitchVersion?: (v: number) => void;
  highlightSegments?: boolean;
  segPicks?: Record<number, boolean>;
  onToggleSeg?: (segIdx: number, cur: boolean) => void;
}) {
  const isUser = m.role === "user";
  const [copied, setCopied] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // 进入编辑态时自动聚焦 + 高度自适应
  useEffect(() => {
    if (editing && editRef.current) {
      const el = editRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 320) + "px";
    }
  }, [editing]);

  function copyText() {
    /**
     * ⚠️ 这里必须转成纯文本再写剪贴板（2026-10-09 用户反馈）。
     *
     * 界面是 `ReactMarkdown` 渲染过的（标题/加粗/列表），但 `m.content` 是
     * **模型原文**（带 `###` `**`）。此前直接把原文写进剪贴板，于是
     * "屏幕上看着没问题、粘到外部全是格式符号" —— 用户就是这么报的。
     *
     * 只改复制这条路，**不动渲染**：界面该有的格式一个不少，
     * 也没碰任何提示词（模型该输出 Markdown 还是照旧输出）。
     */
    const text = markdownForClipboard(m.content || "");
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    // navigator.clipboard 仅在 HTTPS / localhost 可用; 生产是 HTTP, 这里加 execCommand 兜底
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text: string, done: () => void) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch { /* 忽略 */ }
  }

  // 把用户消息里的附件引用块 (📎 文件 / 📖 章节 + ``` 围栏) 折叠展示, 避免长文撑爆对话框
  function renderUserContent(text: string) {
    const re = /(?:📎 文件:|📖)[^\n]*\n```\n[\s\S]*?\n```/g;
    const blocks = text.match(re);
    if (!blocks || blocks.length === 0) {
      return <pre className="whitespace-pre-wrap font-sans m-0">{text || (m.pending ? "..." : "")}</pre>;
    }
    const rest = text.replace(re, "").trim();
    return (
      <div className="space-y-2">
        {blocks.map((b, i) => {
          const headerEnd = b.indexOf("\n");
          const header = b.slice(0, headerEnd);
          const body = b.replace(/^[^\n]*\n```\n/, "").replace(/\n```$/, "");
          return (
            <details key={i} className="rounded border border-white/20 bg-black/10">
              <summary className="cursor-pointer select-none px-2 py-1 text-xs opacity-90">
                {header}（{body.length} 字，点击展开）
              </summary>
              <pre className="whitespace-pre-wrap font-sans m-0 px-2 py-1 text-xs max-h-72 overflow-y-auto">{body}</pre>
            </details>
          );
        })}
        {rest && <pre className="whitespace-pre-wrap font-sans m-0">{rest}</pre>}
      </div>
    );
  }

  // 编辑态: 用户气泡原地变文本框, 修改后"发送"→ 基于新文本重新生成 (旧问答保留为历史版本)
  if (isUser && editing) {
    return (
      <div className="flex justify-end">
        <div className="w-[85%] flex flex-col gap-1.5">
          <textarea
            ref={editRef}
            value={editVal ?? ""}
            onChange={(e) => {
              onEditChange?.(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 320) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEditSubmit?.(); }
              if (e.key === "Escape") onEditCancel?.();
            }}
            className="w-full px-3 py-2 bg-surface-overlay border border-primary/60 rounded-lg text-sm text-ink-primary outline-none focus:border-primary resize-none"
            placeholder="编辑后按 Enter 发送, Esc 取消"
          />
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-[10px] text-ink-muted mr-auto">重新发送后, 旧问答保留为历史版本(v1/v2 可切换)</span>
            <button onClick={onEditCancel}
              className="px-2.5 py-1 rounded text-xs text-ink-secondary hover:bg-surface-overlay border border-line transition">
              取消
            </button>
            <button onClick={onEditSubmit} disabled={!(editVal ?? "").trim()}
              className="px-2.5 py-1 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white rounded text-xs font-medium flex items-center gap-1 transition">
              <Send className="w-3 h-3" />发送
            </button>
          </div>
        </div>
      </div>
    );
  }

  // v1/v2 版本切换标签 (仅在用户气泡上显示一次, 点击整组问答切换)
  const versionTabs = isUser && group && group.versions.length > 1 ? (
    <div className="flex items-center gap-1 justify-end">
      <History className="w-3 h-3 text-ink-muted" />
      {group.versions.map((v) => (
        <button
          key={v}
          onClick={() => !sending && v !== group.active && onSwitchVersion?.(v)}
          disabled={sending}
          title={v === group.active ? `当前版本 v${v}` : `切换到 v${v}`}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition ${
            v === group.active
              ? "bg-primary/20 text-primary border-primary/50"
              : "text-ink-muted border-line hover:text-ink-primary hover:border-primary/40"
          } disabled:opacity-50`}
        >
          v{v}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className={`group flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[85%] flex flex-col gap-1">
        {versionTabs}
        {isUser && m.images && m.images.length > 0 && <MessageImages images={m.images} align="end" />}
        {/* 只发了图没写字：不画一个空的紫色气泡 */}
        {!(isUser && !m.content && m.images && m.images.length > 0) && (
        <div className={`px-3 py-2 rounded-lg text-sm ${isUser ? "bg-primary text-white" : "bg-surface-base text-ink-primary border border-line"}`}>
          {isUser ? (
            renderUserContent(m.content || (m.pending ? "..." : ""))
          ) : m.content ? (
            highlightSegments ? (
              <SegmentedContent content={m.content} picks={segPicks} onToggle={onToggleSeg} />
            ) : hasDiffBlock(m.content) ? (
              // 含改动块 → 普通段落仍用 Markdown 渲染，改动块单独走左右对照
              <div className="prose prose-sm prose-invert max-w-none [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:rounded [&_a]:text-primary [&_table]:text-xs">
                <DiffAwareText
                  text={m.content}
                  renderText={(t) => (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkFriendly]}>{t}</ReactMarkdown>
                  )}
                />
              </div>
            ) : (
              <div className="prose prose-sm prose-invert max-w-none [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:rounded [&_pre]:bg-surface-overlay [&_pre]:border [&_pre]:border-line [&_a]:text-primary [&_table]:text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkFriendly]}>{m.content}</ReactMarkdown>
              </div>
            )
          ) : (m.pending ? <span className="text-ink-muted">...</span> : null)}
          {m.pending && <span className="inline-block ml-1 text-primary animate-pulse">▍</span>}
        </div>
        )}
        {/* 工具条 */}
        {!m.pending && m.content && (
          <div className={`flex items-center gap-1 ${isUser ? "justify-end" : "justify-start"} opacity-0 group-hover:opacity-100 transition`}>
            <button onClick={copyText} className="p-1 hover:bg-surface-overlay rounded text-ink-secondary text-[11px] flex items-center gap-1" title="复制">
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            </button>
            {isUser && !sending && m.id && (
              <button onClick={onStartEdit} className="p-1 hover:bg-surface-overlay rounded text-ink-secondary text-[11px] flex items-center gap-1" title="编辑并重新发送">
                <Edit3 className="w-3 h-3" />
              </button>
            )}
            {!isUser && !sending && (
              <button onClick={onRegenerate} className="p-1 hover:bg-surface-overlay rounded text-ink-secondary text-[11px] flex items-center gap-1" title="重新生成">
                <RotateCw className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DraftsPanel({ drafts, activeDraftId, splitDraftId, onOpenDraft }: {
  drafts: DraftBrief[]; activeDraftId: number | null; splitDraftId: number | null; onOpenDraft: (id: number) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = search ? drafts.filter((d) => d.title.toLowerCase().includes(search.toLowerCase()) || String(d.id).includes(search)) : drafts;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold text-ink-primary mb-2 flex items-center gap-1.5">
        <FileText className="w-3.5 h-3.5 text-primary" />我的草稿 ({drafts.length})
      </h3>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索草稿..."
        className="w-full mb-2 px-2 py-1 bg-surface-overlay border border-line rounded text-xs outline-none focus:border-primary" />
      {activeDraftId && (
        <div className="mb-2 p-2 bg-primary/10 border border-primary/40 rounded text-xs flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5 text-primary shrink-0" />当前对话关联: #{activeDraftId}
        </div>
      )}
      <p className="text-[10px] text-ink-muted mb-2">点击草稿: 自动打开/创建关联对话, 并在中间分屏显示</p>
      {filtered.length === 0 ? (
        <div className="text-xs text-ink-muted py-3 text-center">无匹配草稿</div>
      ) : (
        filtered.slice(0, 200).map((d) => {
          const isSplit = splitDraftId === d.id;
          const isActive = activeDraftId === d.id;
          return (
            <button
              key={d.id} onClick={() => onOpenDraft(d.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-surface-overlay transition flex items-center gap-1 ${isSplit ? "bg-primary/15 text-primary ring-1 ring-primary/40" : isActive ? "bg-primary/15 text-primary" : "text-ink-primary"} truncate`}
              title={`#${d.id} ${d.title}`}
            >
              <BookOpen className="w-3.5 h-3.5 shrink-0 opacity-60" />
              <span className="truncate flex-1">#{d.id} {d.title}</span>
              {isSplit && <span className="text-[10px] text-primary shrink-0">分屏中</span>}
            </button>
          );
        })
      )}
    </div>
  );
}

//: localStorage 键（压缩开关是本机偏好，不写服务端）
const COMPACTION_KEY = "chat_studio_compaction";

function SettingsPanel() {
  const [profile, setProfile] = useState<any>(null);
  const [ci, setCi] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedTip, setSavedTip] = useState(false);
  const [compactionOn, setCompactionOn] = useState(true);

  useEffect(() => {
    try {
      setCompactionOn(localStorage.getItem(COMPACTION_KEY) !== "0");
    } catch { /* localStorage 不可用则用默认值 */ }
    const onPrefs = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (typeof d.compaction === "boolean") setCompactionOn(d.compaction);
    };
    window.addEventListener("chat-studio-prefs", onPrefs);
    return () => window.removeEventListener("chat-studio-prefs", onPrefs);
  }, []);

  function onCompactionChange(v: boolean) {
    setCompactionOn(v);
    try { localStorage.setItem(COMPACTION_KEY, v ? "1" : "0"); } catch {}
    window.dispatchEvent(new CustomEvent("chat-studio-prefs", {
      detail: { compaction: v },
    }));
  }

  useEffect(() => {
    void (async () => {
      const r = await authFetch(`${API}/profile`);
      if (r.ok) {
        const p = await r.json();
        setProfile(p);
        setCi(p.custom_instructions || "");
        setEnabled(p.memory_enabled !== false);
      }
    })();
  }, []);

  async function save() {
    setSaving(true);
    try {
      await authFetch(`${API}/profile`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_instructions: ci || null, memory_enabled: enabled }),
      });
      setSavedTip(true);
      setTimeout(() => setSavedTip(false), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-3 text-xs">
      <h3 className="font-semibold text-ink-primary flex items-center gap-1.5"><Settings className="w-3.5 h-3.5" />对话设置</h3>
      <div>
        <label className="block text-ink-secondary mb-1">自定义指令</label>
        <textarea value={ci} onChange={(e) => setCi(e.target.value)} rows={5}
          className="w-full px-2 py-1.5 bg-surface-overlay border border-line rounded outline-none focus:border-primary"
          placeholder="AI 必须遵守的全局指令..." />
      </div>
      <label className="flex items-start gap-2 p-2 bg-surface-overlay/40 rounded border border-line cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5" />
        <div>
          <div className="font-semibold">启用记忆功能</div>
          <div className="text-ink-muted text-[11px]">关闭后 AI 不再读写长期记忆</div>
        </div>
      </label>

      {/* "自动精修 / 讨论"这个开关已删除 —— 它和输入框上方动作栏的「改 · 精修这批」
          是同一件事的两个入口，用户看到两个开关会以为它们不一样。现在意图只有一个
          可见的落点：动作栏。这里不再指路，也不需要说明文字。 */}

      <label className="flex items-start gap-2 p-2 bg-surface-overlay/40 rounded border border-line cursor-pointer">
        <input type="checkbox" checked={compactionOn} onChange={(e) => onCompactionChange(e.target.checked)} className="mt-0.5" />
        <div>
          <div className="font-semibold">自动压缩上下文</div>
          <div className="text-ink-muted text-[11px]">
            长对话时自动压缩早期内容以保持流畅，关键信息会保留。建议开启
          </div>
        </div>
      </label>
      <button onClick={save} disabled={saving}
        className="w-full py-1.5 bg-primary hover:bg-primary/90 text-white disabled:opacity-50 rounded font-medium flex items-center justify-center gap-1 transition">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        {savedTip ? "✓ 已保存" : "保存"}
      </button>
      <a href="/jubengongfang/settings/memories" className="block text-center py-2 bg-surface-overlay hover:bg-surface-raised border border-line rounded text-primary transition">
        完整记忆管理 →
      </a>
    </div>
  );
}
