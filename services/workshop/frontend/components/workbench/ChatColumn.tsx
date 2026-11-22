'use client';
/**
 * 新版工作台中间栏 —— AI 对话（PLAN §4.5.6 / §4.5.7 / §4.5.8）
 *
 * ## 它与「对话工坊」的关系
 * 对话工坊是**全局**的（左边有会话列表，能跨草稿聊）；这里是**某一部剧内部**的
 * 对话，进来就已经绑定了这份草稿 —— 用户不需要先选剧再聊。
 *
 * 两者共用同一套后端（`/v1/agent/*`）与同一套动作语义，
 * 所以在这里精修/生成/体检的结果，在对话工坊里也同样看得到。
 *
 * ## 气泡规范（§4.5.6，用户 2026-09-19 明确要求）
 * **只有用户消息有气泡**：AI 回复直接铺在页面上。
 * 理由：AI 回复里常嵌产物（报告卡、改写对照），那些已有卡片边框，
 * 再套一层气泡就是"框里套框"；无气泡也更接近**阅读**而非"看消息"。
 *
 * ## 写入草稿（§4.5.8）
 * 主路径是「选中一段 → 拖到右边某一集」，用的是**浏览器原生的拖选中文字**
 * （和 Word 一样：选中、按住、拖走），所以这里**不做拖拽手柄**，
 * 也**不能给正文加 `draggable`** —— 加了浏览器就把按住拖动当拖拽、不再划选文字，
 * "选中一段再拖"这设计会自相矛盾（2026-09-21 反馈：对话文字选不动）。
 *
 * 原生拖拽只带 `text/plain`，所以右侧集块的落点判定必须接受它（见 ScriptPane）。
 *
 * 同时保留**按钮兜底**（用户没意识到能拖时）：
 * 每条 AI 回复下有「写入第 N 集」，有选区就只写选中的那段。
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Send, Loader2, Sparkles, ChevronDown, SquarePen, Wrench, Crosshair, AlertTriangle, History,
  Image as ImageIcon,
} from 'lucide-react';
import { authFetch, getToken } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { notifyError } from '@/lib/dialog';
import {
  usePendingImages, useDropZone, PendingImageStrip, MessageImages, DropOverlay,
  imagesFromClipboard, type MessageImage,
} from '@/components/chat/ChatImages';
import {
  GEN_ACTIONS, CHECK_ACTIONS, FIX_ACTIONS,
  type ActionSpec, type ActionScope,
} from '@/app/chat-studio/_ActionBar';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// ⚠️ 必须有 remark-breaks：Markdown 规范里**单个换行不算换行**（会被当成空格合并）。
// 而 AI 在这里回的常常是剧本——`△特写：…` 与 `角色【语气】: 台词` 每条各占一行、
// 行间只有一个换行符。不加它，整集剧本会被压成一大坨（2026-09-21 用户反馈"换行没了"）。
// 它只把单换行渲染成 <br>，标题/加粗/列表照常解析。
import remarkBreaks from 'remark-breaks';
// ⚠️ 还要 remark-cjk-friendly：CommonMark 判断 `**` 能不能开始加粗时，
// 把中文全角标点算作"标点"，于是 `了**“小说正文版”**，` 这种写法
// （`**` 前是汉字、后是全角引号）不满足 left-flanking 规则 → **整段加粗不生效**，
// 用户看到的就是裸的 `**`。模型写中文时几乎必然这么写，所以这不是边缘情况。
import remarkCjkFriendly from 'remark-cjk-friendly';
import { DiffAwareText, hasDiffBlock } from '@/app/chat-studio/_DiffBlock';
import { markdownToPlainText, looksLikeMarkdown } from '@/lib/markdownPlain';
import ReportCard, { type CheckReport, type FixResult } from '@/app/chat-studio/_ReportCard';
import { ModelSelect } from '@/components/ModelSelect';
import AgentPanel from '@/components/agent/AgentPanel';
import { Bot } from 'lucide-react';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';
const API = `${BASE}/v1/agent`;

/**
 * 后台作业（精修 / 生成 / 定点修复 / 去 AI 味）。
 *
 * ⚠️ 2026-10-07 补。此前这个组件**只处理 delta/done/error 三种 SSE 事件**，
 * 而后端一共发 8 种（check/deai/delta/done/error/fix/job/start）。被丢掉的那几种
 * 恰好全是"作业已启动"的信号，后果是：
 *   · 点「精修这批」→ 聊天里只留一句"已启动"，跑完**页面不会刷新**、
 *     也没有任何进度 —— 用户原话"点了跑完没反应"；
 *   · 点「让 AI 改选中的 N 条」→ 修复作业确实在跑，但按钮不转圈、
 *     卡片上永远看不到"修前 12 → 修后 7"，看着像没生效。
 * 两个症状同一个根因：作业号在这一层被丢了，没人去轮询。
 */
type LiveJob = {
  id: number;
  kind: string;
  /** 人话标签，直接显示（"精修这批"而不是内部名 rewrite_script） */
  label: string;
  status: string;
  progress: number | null;
  note: string | null;
  /** 后端 job_status.describe() —— 判活唯一口径。2026-10-24 起气泡也读它，
   *  否则"排队中（还没轮到）"和"在写"在气泡里长得一模一样。 */
  state?: {
    phase: string; label: string; active: boolean; why: string;
    queue_position?: number | null; episodes_done?: number | null;
    episodes_total?: number | null; eta_seconds?: number | null;
  } | null;
};

/** 作业 kind → 人话。与 TaskStatusBar 的口径保持一致。 */
const JOB_LABEL: Record<string, string> = {
  rewrite_script: '整本精修',
  fix_script: '定点修复',
  gen_outline: '生成大纲',
  gen_chapters: '生成正文',
  gen_storyboards: '生成剧本',
  adapt_products: '改编',
  deai_apply: '去 AI 味',
  deai: '去 AI 味',   // 2026-10-30 前的旧作业（独立清洗稿），只为历史会话里的进度条保留
};

const JOB_ACTIVE = new Set(['queued', 'running', 'analyzing', 'rewriting', 'pending']);

/** 秒 → 人话时长。与 AgentConsole 里的同名函数保持同一口径（三处显示别各写一套）。 */
function humanDur(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} 秒`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分钟`;
  return `${(sec / 3600).toFixed(1)} 小时`;
}

/** 历史列表里的时间：今天只给时分，更早给月-日。 */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 历史抽屉里的错误文案 —— 后端 detail 可能是一大段 JSON，别整段糊在界面上。 */
function hdErrorText(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '未知错误';
  try {
    const j = JSON.parse(s);
    return typeof j?.detail === 'string' ? j.detail : s.slice(0, 120);
  } catch {
    return s.slice(0, 120);
  }
}

type Message = {
  id?: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  pending?: boolean;
  report?: CheckReport | null;
  /** 定点修复的 before→after，挂在体检报告卡上（"修前 12 → 修后 7"） */
  fix?: FixResult | null;
  /** 随这条用户消息发出的图片（与对话工坊同一套，见 components/chat/ChatImages） */
  images?: MessageImage[];
};

/** 历史会话抽屉里的一行（与 /v1/agent/conversations 返回的字段同名）。 */
type ConvBrief = {
  id: number;
  draft_id: number | null;
  title: string;
  /** 归属草稿的标题（后端 IN 查询补的），跨剧列表用它区分"这条属于哪部剧" */
  draft_title?: string | null;
  message_count?: number;
  created_at?: string | null;
  updated_at?: string | null;
};

export type ChatColumnProps = {
  draftId: number;
  draftTitle?: string;
  episodeCount: number;
  /** 右栏当前页签 —— 决定 AI 看到的是哪一份稿子（正文/剧本/大纲/小说/推文） */
  kind?: string;
  /** 把 AI 产出写进某一集（右上角写入按钮用） */
  onWriteToEpisode: (order: number, text: string, mode?: 'append' | 'replace') => void;
  /** 在右侧当前页签里定位并高亮一段文字（气泡里划选后点「在右侧定位」） */
  onLocate: (quote: string) => void;
  /** 草稿数据变了（生成/精修完成）时通知外层刷新树图状态 */
  onDraftChanged?: () => void;
  /** 右栏空状态点「按现有正文改写」时转过来 —— 与生成菜单走同一条路 */
  adaptRequest?: { kind: 'novel' | 'tweet'; nonce: number } | null;
  onAdaptRequestDone?: () => void;
};

export function ChatColumn({
  draftId, draftTitle, episodeCount, kind, onWriteToEpisode, onLocate, onDraftChanged,
  adaptRequest, onAdaptRequestDone,
}: ChatColumnProps) {
  const router = useRouter();
  const [convId, setConvId] = React.useState<number | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [booting, setBooting] = React.useState(true);
  /** 提交给后端的模型值，形如 "gemini:__REDACTED__"；纯厂商名也合法 */
  const [provider, setProvider] = React.useState('gemini');
  const [scope, setScope] = React.useState<ActionScope>({ start_ep: null, end_ep: null, target: 'storyboard' });
  const [openGroup, setOpenGroup] = React.useState<'gen' | 'check' | 'fix' | null>(null);
  /** 正在跑的后台作业（精修/生成/修复/去AI味）。轮询它、跑完刷新消息。 */
  const [liveJob, setLiveJob] = React.useState<LiveJob | null>(null);
  /** 超级 Agent 面板（完整能力：三种模式、绑定当前草稿、历史、权限） */
  const [agentOpen, setAgentOpen] = React.useState(false);
  /** 待发图片（粘贴 / 拖入 / 点选），与对话工坊同一套逻辑 */
  const pimg = usePendingImages(convId, notifyError);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const drop = useDropZone((fs) => {
    // 工作台这里只收图片：文档上传在对话工坊，这里拖进别的文件给一句明确的话
    const n = pimg.add(fs);
    if (!n && fs.length) notifyError('这里只能拖入图片（PNG / JPG / WEBP / GIF）');
  });
  /**
   * 历史会话抽屉（跨剧，2026-10-26 用户裁定方案 C）。
   *
   * ## 为什么工作台必须有它
   * 对话工坊左边有会话列表，这里**没有** —— 本组件只认"当前这部草稿的当前会话"。
   * 于是用户在工作台里开过的旧对话，除了正在用的那一个，其余在界面上完全不可达，
   * 看起来就是"对话记录没了"。实测生产上 ATOBE 有 147 个 draft_id 为空的会话、
   * 草稿 2801 下有 2 个，用户只能看到最近的那一条。
   *
   * ## 为什么是**跨剧**而不是只列本剧（用户 2026-10-26 裁定）
   * 只列本剧的话，v2 用户想看别的剧的对话，仍然得绕到头像菜单 → 对话工坊 → 旧版 UI。
   * 用户明确否掉了"在 v2 首页加入口"那条路："让 v2 用户又回到旧版 ui 中，
   * 这不符合 v2 的升级目的"。所以历史抽屉就是 v2 里唯一的历史入口，
   * 必须能覆盖全部会话，而不只是当前这部。
   *
   * ## 点别剧的会话 = 跳到那部剧的工作台，不在这里原地加载
   * ⚠️ 这一条是安全约束，不是偷懒。本组件身上绑着 `draftId`，所有动作
   * （精修/生成/写入某一集/范围选择）都作用于它。把别剧的会话原地加载进来，
   * 「精修这批」就会打到**当前这部剧**身上 —— 用户以为在改 A 剧，实际覆写了 B 剧。
   * 生成/精修都是覆写操作，没有撤销。
   */
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [histConvs, setHistConvs] = React.useState<ConvBrief[]>([]);
  const [histTotal, setHistTotal] = React.useState(0);
  const [histHasMore, setHistHasMore] = React.useState(false);
  const [histLoading, setHistLoading] = React.useState(false);
  const [histError, setHistError] = React.useState<string | null>(null);
  /** 定点修复的结果，按 report_id 存 —— 刷新消息后要贴回对应那张报告卡 */
  const fixResultRef = React.useRef<Map<number, FixResult>>(new Map());

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  /**
   * 从首页「今天想写点什么？」带过来的那句话，会话就绪后自动发出去。
   *
   * ⚠️ 只在**会话是空的**时候发：用户后来再回到这个草稿，不该又被重放一遍。
   * 读出来立刻从 sessionStorage 删掉，所以刷新也不会重发。
   */
  const pendingFirstRef = React.useRef<string>('');
  const firstSentRef = React.useRef(false);

  /** 拉这个草稿的会话；没有就建一个 */
  const boot = React.useCallback(async () => {
    setBooting(true);
    try {
      /*
       * ⚠️ `draft_id` 必须交给**后端**筛（2026-10-26 修）。
       *
       * 原先这里是 `?limit=50` 拉全站最近 50 个再在客户端 `filter(c.draft_id === draftId)`。
       * 两个后果，第二个尤其糟：
       *   · 本剧的会话排在第 50 名之后 → 列表里找不到 → 打开工作台就是"没有对话记录"；
       *   · 找不到就走"新建会话"分支 → 于是每进来一次就**多攒一个空会话**，
       *     旧的还好好躺在库里，但用户再也看不见了（"我的对话没了"）。
       * 后端本来就有 draft_id 参数，只是这里没传。
       */
      const r = await authFetch(`${API}/conversations?draft_id=${draftId}&limit=1&with_total=true`);
      let list: ConvBrief[] = [];
      let total = 0;
      if (r.ok) {
        const d = await r.json();
        list = Array.isArray(d) ? d : (d.items || []);
        total = Array.isArray(d) ? list.length : Number(d.total || list.length);
      }
      setHistTotal(total);

      let cid: number;
      if (list.length) {
        // 后端已按 updated_at DESC 排好，第一条就是最近在用的那个
        cid = list[0].id;
      } else {
        const cr = await authFetch(`${API}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_id: draftId, title: draftTitle ? `${draftTitle}` : '新对话' }),
        });
        if (!cr.ok) throw new Error(`建会话失败 HTTP ${cr.status}`);
        cid = (await cr.json()).id;
        setHistTotal(1);
      }
      setConvId(cid);
      const dr = await authFetch(`${API}/conversations/${cid}`);
      if (dr.ok) {
        const data = await dr.json();
        const loaded = (data.messages || []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content, report: m.report || null,
          images: m.images || [],
        }));
        setMessages(loaded);
        if (loaded.length === 0) {
          try {
            const raw = sessionStorage.getItem('drama_v2_first_message');
            if (raw) {
              const p = JSON.parse(raw);
              if (p && Number(p.draftId) === draftId && String(p.text || '').trim()) {
                pendingFirstRef.current = String(p.text).trim();
              }
              sessionStorage.removeItem('drama_v2_first_message');
            }
          } catch { /* 读不到就当没有 */ }
        }
      }
    } catch (e: any) {
      notifyError('对话加载失败: ' + (e?.message || e));
    } finally {
      setBooting(false);
    }
  }, [draftId, draftTitle]);

  React.useEffect(() => { void boot(); }, [boot]);

  /**
   * 打开历史抽屉时拉第一页（每页 50，**跨剧**）。
   *
   * why 重新拉而不是复用 boot 那一次：boot 只取了 1 条（它只要"最近那个会话"），
   * 拿它当列表会显示成"就 1 个对话"。而且用户在别处新建的会话也要出现，所以现取。
   *
   * ⚠️ 不带 `draft_id`：这是 v2 里**唯一**的历史入口（用户裁定不做"跳回旧版对话工坊"
   * 那个入口），只列本剧就等于别的剧的对话在 v2 里永远看不到。
   */
  const loadHistory = React.useCallback(async () => {
    setHistLoading(true);
    setHistError(null);
    try {
      const r = await authFetch(`${API}/conversations?limit=50&offset=0&with_total=true`);
      if (!r.ok) {
        setHistError(`HTTP ${r.status}`);
        return;
      }
      const d = await r.json();
      const list: ConvBrief[] = Array.isArray(d) ? d : (d.items || []);
      setHistConvs(list);
      setHistTotal(Array.isArray(d) ? list.length : Number(d.total || list.length));
      setHistHasMore(Array.isArray(d) ? false : !!d.has_more);
    } catch (e: any) {
      setHistError(e?.message || String(e));
    } finally {
      setHistLoading(false);
    }
  }, []);

  /** 抽屉滚到底再加一页。append + 按 id 去重，理由同对话工坊（updated_at 会变动）。 */
  const loadMoreHistory = React.useCallback(async () => {
    if (histLoading || !histHasMore) return;
    setHistLoading(true);
    try {
      const r = await authFetch(
        `${API}/conversations?limit=50&offset=${histConvs.length}&with_total=true`);
      if (!r.ok) return;
      const d = await r.json();
      const page: ConvBrief[] = Array.isArray(d) ? d : (d.items || []);
      setHistConvs((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...page.filter((c) => !seen.has(c.id))];
      });
      if (!Array.isArray(d)) setHistHasMore(!!d.has_more);
      else setHistHasMore(false);
    } catch { /* 滚动加载失败不弹错，再滚一次就重试 */ }
    finally {
      setHistLoading(false);
    }
  }, [draftId, histConvs.length, histLoading, histHasMore]);

  React.useEffect(() => {
    if (historyOpen) void loadHistory();
    // 只在"打开"这一刻拉；依赖里不放 loadHistory 会让每次渲染都重跑一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen]);

  /**
   * 点历史里的一条会话。
   *
   * ## 同一部剧 → 原地切换；别的剧 → 跳过去
   * 原地切换只对**同一部 draft** 安全。跨剧原地加载会让本组件身上的 `draftId`
   * 与消息所属的草稿脱钩，而「精修这批」「生成正文」「写入第 N 集」全部作用于
   * `draftId` —— 用户以为在改 A 剧，实际覆写的可能是 B。生成/精修都是覆写操作，
   * 没有撤销。所以跨剧一律走路由，让整页带着新的 draftId 重新挂载。
   */
  const openHistoryConv = React.useCallback(async (c: ConvBrief) => {
    if (c.draft_id && c.draft_id !== draftId) {
      setHistoryOpen(false);
      // 复用当前 URL 的其余参数（如 ?tab=），只换草稿 id
      const qs = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).toString()
        : '';
      router.push(`/v2/drafts/${c.draft_id}${qs ? `?${qs}` : ''}`);
      return;
    }
    setHistoryOpen(false);
    setBooting(true);
    setConvId(c.id);
    try {
      const r = await authFetch(`${API}/conversations/${c.id}`);
      if (!r.ok) { notifyError(`打开会话失败 HTTP ${r.status}`); return; }
      const data = await r.json();
      setMessages((data.messages || []).map((m: any) => ({
        id: m.id, role: m.role, content: m.content, report: m.report || null,
        images: m.images || [],
      })));
    } catch (e: any) {
      notifyError('打开会话失败: ' + (e?.message || e));
    } finally {
      setBooting(false);
    }
  }, [draftId, router]);

  /**
   * 重载消息流 —— 把后端落库的最终交代拿回来。
   *
   * ## 为什么必须有
   * 精修/生成这类长任务，跑完后端会**回填那条"已启动"的助手消息**，把
   * "已启动"换成"精修完成（整本），覆写 42 集"。不重载就永远停在"已启动"，
   * 用户看到的就是"点了跑完没反应"——即使内容其实已经改好了。
   *
   * ## 保住本地的报告卡与修复结果
   * 后端 `report_json` 是落库的，但**刚跑完那一下本地卡片可能还没落库**，
   * 整条替换会让卡片当场消失（用户以为白跑了一次）。所以按消息 id 把本地
   * 已有的 report / fix 带过去，与对话工坊 refreshMessages 的做法一致。
   */
  const reload = React.useCallback(async (cid: number) => {
    try {
      const r = await authFetch(`${API}/conversations/${cid}`);
      if (!r.ok) return;
      const data = await r.json();
      setMessages((prev) => {
        const reportById: Record<number, CheckReport> = {};
        const fixById: Record<number, FixResult> = {};
        for (const m of prev) {
          if (m.id && m.report) reportById[m.id] = m.report;
          if (m.id && m.fix) fixById[m.id] = m.fix;
        }
        const memFix = (m: any): FixResult | null => {
          const rp = m.report as CheckReport | undefined;
          if (!rp) return null;
          return (rp.report_id ? fixResultRef.current.get(rp.report_id) : null)
            ?? fixById[m.id] ?? null;
        };
        const fresh: Message[] = (data.messages || []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content,
          report: m.report || reportById[m.id] || null,
          fix: memFix(m),
          images: m.images || [],
        }));
        // ⚠️ 只存在于本地的消息必须保留：它们没有 DB id，因为服务端还没落库
        // （正在流式生成的回复、发送失败的错误提示都属于这类）。整条替换会把
        // 用户眼前正在看的内容抹掉。
        //
        // ⚠️ 但服务端**一旦把同一条落了库**，本地那条就成了重复的幽灵 ——
        // 用户会看到一模一样的两条（一条有 id、一条没有）。所以按 (role, content)
        // 去重：服务端已返回同内容的消息时，丢掉本地那条。
        //
        // 实测（2026-10-11 用户甲报"截图里有两个「已启动定点修复」块"）：
        // send() 乐观插入的 user+assistant 两条**永远拿不到 id**（SSE 的 done
        // 事件只替换 content，不回填 id），而 send 之后的下一次 reload 必然
        // 已经能从服务端读到这一对了 —— 于是每次用对话下指令、只要等到一次
        // reload（作业跑完必 reload），同一个气泡就必然变成两个。
        //
        // ⚠️ 正在生成中的那条(pending)**不能**参与去重：流还没结束，本地内容是
        // 逐步拼出来的，与服务端那一刻的半截内容对不上 —— 一旦被"服务端已有同内容"
        // 判成重复而被丢掉，那个还在往里写字的空气泡就没了（用户看到回复消失）。
        // 所以 pending 一律保留，只有已经定型的本地消息才按内容去重。
        // 这段判据与对话工坊 src 一致（apps/web/app/chat-studio/page.tsx 的
        // refreshMessages），两处刻意保持同一口径 —— 那边早就踩过同一个坑。
        const freshKeys = new Set(fresh.map((m) => `${m.role}\u0000${m.content}`));
        const localOnly = prev.filter(
          (m) => !m.id && (m.pending || !freshKeys.has(`${m.role}\u0000${m.content}`)));
        return [...fresh, ...localOnly];
      });
      // ⚠️ 这里**不能** clear()。此前 reload 末尾有一句
      // `fixResultRef.current.clear()`，而修复作业跑完的收尾顺序是：
      //     ① fixResultRef.current.set(report_id, fixResult)   ← 先把结果存进 ref
      //     ② await reload(cid)                                ← 紧接着就把它清空
      // 而 ①里那句 setMessages 的 updater 是**延迟执行**的（React 批处理），
      // 等它真正去读 ref 时已经被 ② 清空了 —— 于是"修前 12 → 修后 7"
      // 在界面上永远不出现，即使后端算得好好的。
      // ref 的生命周期应当跟组件走（reload 是"重新对齐消息"，不是"清缓存"）；
      // 按 report_id 存的结果本身就带幂等语义，重复保留没有副作用。
    } catch { /* 重载失败不打扰用户，下一轮轮询还有机会 */ }
  }, []);

  /**
   * 后台作业轮询：跑着时每 3 秒看一次，到终态就收尾。
   *
   * 收尾做三件事，缺一不可（这三件正是"点了没反应"的三个具体表现）：
   *   ① 重载消息 —— 拿后端回填的最终交代（"覆写 42 集"）
   *   ② 通知外层刷新草稿 —— 正文/剧本真的变了，树图与右栏要更新
   *   ③ 失败/取消时明确说出来，而不是静默消失
   */
  React.useEffect(() => {
    const job = liveJob;
    const cid = convId;
    if (!job || !cid) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      let terminal = false;
      try {
        // ⚠️ 去 AI 味**不在 agent_jobs 表里**（它有自己的 deai_jobs），
        // 拿 /v1/agent/jobs/{id} 去问会 404 —— 而 404 会让这个 catch 静默吞掉，
        // 表现成"进度条永远停在 0%"。所以按 kind 分流到各自的端点。
        const isDeai = job.kind === 'deai';
        const url = isDeai ? `${BASE}/v1/deai/${job.id}` : `${API}/jobs/${job.id}`;
        const r = await authFetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const raw = await r.json();
        // deai 包了一层 {ok, job}；agent 作业是平铺的。归一成同一形状再判。
        const j: any = isDeai ? (raw.job || {}) : raw;
        const st: string = String(j.status || '');
        const total = Number(j.total || 0), fin = Number(j.finished || 0);
        if (!alive) return;
        // ⚠️ note 绝不能直接放 `j.summary` —— 去AI味那边 summary 是 **summary_json 对象**，
        // 塞进 React 会抛 "Objects are not valid as a React child" 整栏白屏。
        // 所以只认字符串，其余一律回落到进度数字。
        const noteText = isDeai
          ? `已处理 ${fin}/${total} 集`
          : (typeof j.progress_note === 'string' ? j.progress_note : null);
        setLiveJob((cur) => (cur && cur.id === job.id
          ? { ...cur, status: st,
              progress: isDeai
                ? (total ? Math.round((fin / total) * 100) : null)
                : (j.progress ?? null),
              note: noteText,
              state: isDeai ? null : (j.state ?? cur.state ?? null) }
          : cur));

        if (!JOB_ACTIVE.has(st)) {
          terminal = true;
          // 定点修复：把 before→after 挂到对应那张报告卡上（"修前 12 → 修后 7"）
          if (job.kind === 'fix_script') {
            const res = (j.result || {}) as any;
            const after = res.after || null;
            if (after?.report_id) {
              const fixRes: FixResult = {
                before_error: after.before_error, before_warn: after.before_warn,
                error: after.error, warn: after.warn,
                touched_eps: after.touched_eps, report_id: after.report_id,
                improved: !!res.improved, notes: res.notes || [],
              };
              fixResultRef.current.set(after.report_id, fixRes);
            }
          }
          await reload(cid);
          // 修复/精修/生成/去AI味都改草稿；只有 2026-10-30 前的旧去AI味作业（独立清洗稿）不改。
          if (job.kind !== 'deai') onDraftChanged?.();
          if (job.kind === 'deai_apply' && st === 'done') {
            const res = (j.result || {}) as any;
            const skipped: { ep: number; reason: string }[] = Array.isArray(res.skipped) ? res.skipped : [];
            const lines = [
              `去 AI 味完成：改了 **${res.applied ?? 0}/${res.total ?? 0}** 集`
                + (res.target === 'copy' && res.draft_id ? `，改在副本 **#${res.draft_id}** 里（原稿没动）。` : '。'),
            ];
            if (res.target === 'copy' && res.draft_id) {
              lines.push(`[打开副本 #${res.draft_id}](/v2/drafts/${res.draft_id})`);
            } else if (res.applied) {
              lines.push('点顶部任务栏的「看改动」可以逐集对照改前/改后；不满意的集在历史版本里恢复。');
            }
            if (skipped.length) {
              lines.push('没改的集：' + skipped.slice(0, 8).map((x) => `第${x.ep}集（${x.reason}）`).join('；')
                + (skipped.length > 8 ? ` 等 ${skipped.length} 集` : ''));
            }
            setMessages((prev) => [...prev, { role: 'assistant', content: lines.join('\n\n') }]);
          }
          if (st === 'failed' || st === 'canceled') {
            setMessages((prev) => [...prev, {
              role: 'assistant',
              content: `⚠️ ${job.label}没有完成（${st}）：${j.error || '未给出原因'}\n\n`
                + (job.kind === 'deai'
                    ? '去 AI 味是**独立清洗稿**，原草稿一个字都没动。'
                    : '改写类任务在覆写前都会先存历史版本，**没改成功的部分原稿保持原样**。'),
            }]);
          }
          setLiveJob(null);
        }
      } catch { /* 网络抖动不停轮询，下一轮再试 */ }
      if (alive && !terminal) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveJob?.id, convId]);

  /**
   * 会话就绪后，把首页带过来的第一句话发出去。
   *
   * 放在**独立的 effect** 而不是 boot 里：`send()` 依赖 `convId` 这个 state，
   * 在 boot 内部调用时它还是旧值（setConvId 还没生效），会直接 return。
   */
  React.useEffect(() => {
    if (!convId || booting || firstSentRef.current) return;
    const text = pendingFirstRef.current;
    if (!text) return;
    firstSentRef.current = true;
    pendingFirstRef.current = '';
    void send(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, booting]);

  /**
   * 右栏请求生成小说/推文 —— 直接复用 GEN_ACTIONS 里那两项，
   * 不另写一套参数，保证"空状态点的"和"菜单点的"是同一件事。
   */
  const lastAdaptNonce = React.useRef(0);
  React.useEffect(() => {
    if (!adaptRequest || adaptRequest.nonce === lastAdaptNonce.current) return;
    if (!convId || sending) return;
    lastAdaptNonce.current = adaptRequest.nonce;
    const spec = GEN_ACTIONS.find((a) => a.key === `gen_${adaptRequest.kind}`);
    if (spec) void send(spec.send, spec);
    onAdaptRequestDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adaptRequest, convId, sending]);

  /**
   * 恢复上次选的模型。
   *
   * 清单本身**不在这里拉** —— `ModelSelect` 自己会 `loadModelCatalog()`（带 5 分钟
   * 缓存与在途去重），并在清单到手后把这里的值对齐：纯厂商老值（"gemini"）升级成
   * 该用户的默认型号，已下架的型号退回默认。所以初始值给 "gemini" 就够，
   * 它是合法值（= 用该厂商默认型号），不会出现空白按钮。
   */
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem('drama_chat_provider');
      if (saved) setProvider(saved);
    } catch { /* 隐私模式用默认 */ }
  }, []);

  /**
   * 跟随到底部 —— **只在用户本来就贴着底部时**才跟。
   *
   * ⚠️ 改这版之前是每次 messages 变化就无条件滚到底。而流式输出期间 messages
   * 每收到一个 delta 就变一次 —— 于是用户往上翻去看前面已经输出的内容时，
   * 会被**持续拽回最底下**，整段回复根本没法回读（2026-09-22 用户反馈）。
   *
   * 判据是"当前离底部还有多远"：≤80px 视为在看最新内容，跟随；
   * 一旦用户主动往上滚超过这个距离，就把跟随停掉，直到他自己滚回底部。
   * 这是聊天类产品的通行做法（粘性底部）。
   */
  const stickBottomRef = React.useRef(true);

  const onFlowScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickBottomRef.current) return;
    // 流式期间每帧都在追加内容，用 smooth 会排队积压；贴底跟随用 auto 更跟手
    el.scrollTo({ top: el.scrollHeight, behavior: sending ? 'auto' : 'smooth' });
  }, [messages, sending]);

  /**
   * 发一条消息。SSE 流式，与对话工坊走同一条后端路径。
   *
   * `act` 带着结构化意图（点动作按钮时）—— 后端看到 action 就走
   * check/fix/rewrite/generate 的**确定性分支**，不经过 Agent 循环。
   * 手打消息不带 act，是纯对话。
   */
  async function send(text?: string, act?: Partial<ActionSpec> & { scope?: ActionScope }) {
    if (sending || !convId) return;
    const body = (text ?? input).trim();
    if (pimg.uploading) { notifyError('图片还在上传，稍等一下再发送'); return; }
    // 动作按钮走确定性后端分支，不看图；只有手打的对话才带图
    const withImages = !act && pimg.readyIds.length > 0;
    if (!body && !withImages) return;
    const sentImages: MessageImage[] = withImages ? pimg.takeForSend() : [];

    setInput('');
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: body, images: sentImages },
      { role: 'assistant', content: '', pending: true },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const token = getToken();
      const res = await fetch(`${API}/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: body,
          current_draft_id: draftId,
          provider,
          ...(sentImages.length ? { image_ids: sentImages.map((x) => x.id) } : {}),
          // 右栏当前页签。⚠️ 它定位的是"哪一份稿子"，不是"哪一集" ——
          // 集号由用户自己在话里说（"第7集…"）。同一句"第7集这段太平"，
          // 在原文页指正文、剧本页指分镜、大纲页指契约；不传这个字段，
          // 后端只能永远按正文取数，于是"看着剧本聊剧本，AI 手里是正文"。
          kind,
          // ⚠️ tool_mode 恒为 off：日常对话是纯对话，能力只走动作按钮的确定性分支。
          // 与对话工坊同一口径（见那边 2026-09 的裁定注释）。
          tool_mode: 'off',
          chat_mode: 'chat',
          // 动作按钮带这些字段 → 后端改走确定性分支
          ...(act ? {
            action: act.action,
            kinds: (act as any).kinds ?? null,
            scope: act.scope ?? null,
            // ⚠️ ActionSpec 里的字段名是 **genKind**（驼峰）。
            // 这里原本写的是 `act.gen_kind`，**永远取不到值** → 传 null →
            // 后端 `gen_kind or "outline"` 静默兜底成大纲 →
            // **点「生成正文」「生成剧本」实际都在重新生成大纲**，
            // 而重生成大纲会覆盖用户的分集计划（连同契约与账本）。
            // 2026-09-22 用户实测踩到：点生成剧本、回执却说"已启动生成大纲"。
            gen_kind: (act as any).genKind ?? (act as any).gen_kind ?? null,
            // 体检报告的"让 AI 改这个"：只传 issue id + report id，
            // 问题正文一律以服务端 check_reports 为准（前端不传正文）。
            issue_ids: (act as any).issue_ids ?? null,
            report_id: (act as any).report_id ?? null,
          } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE 事件以空行分隔
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta') {
            acc += ev.content || '';
            setMessages((prev) => {
              const n = [...prev];
              n[n.length - 1] = { ...n[n.length - 1], content: acc, pending: true };
              return n;
            });
          } else if (ev.type === 'done') {
            const full = ev.full_content || acc;
            setMessages((prev) => {
              const n = [...prev];
              n[n.length - 1] = { role: 'assistant', content: full };
              return n;
            });
            // 生成/精修类动作会改草稿 —— 通知外层刷新树图状态点。
            // ⚠️ 注意这只是"收到回执"（作业刚启动，草稿还没变）；真正有意义的那次
            // 刷新在下面 liveJob 轮询到终态时 —— 那才是内容真的被改写完的时刻。
            if (act?.action && act.action !== 'check') onDraftChanged?.();
          } else if (ev.type === 'check') {
            // 体检报告：后端已落库并挂在这条助手消息上。本地先把卡片画出来
            // （不等轮询），再靠 refreshMessages 对齐到 DB id。
            const rep = ev.report || null;
            if (rep) {
              setMessages((prev) => {
                const n = [...prev];
                for (let i = n.length - 1; i >= 0; i--) {
                  if (n[i].role === 'assistant' && !n[i].pending) {
                    n[i] = { ...n[i], report: rep };
                    break;
                  }
                }
                return n;
              });
            }
          } else if (ev.type === 'job' || ev.type === 'fix' || ev.type === 'deai') {
            // 「作业已启动」类事件 —— 记下作业号，交给下面的轮询去等结果。
            // ⚠️ 这一支是本组件此前完全缺失的（见 LiveJob 的注释）：
            // 少了它，精修/修复/去AI味跑完都没人知道。
            if (typeof ev.job_id === 'number') {
              setLiveJob((cur) => (cur?.id === ev.job_id ? cur : {
                id: ev.job_id,
                kind: ev.kind || (ev.type === 'deai' ? 'deai' : ev.type),
                label: JOB_LABEL[ev.kind || ev.type] || '任务',
                status: 'queued',
                progress: null,
                note: null,
              }));
            }
          } else if (ev.type === 'error') {
            throw new Error(ev.message || '模型返回错误');
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setMessages((prev) => {
        const n = [...prev];
        if (n[n.length - 1]?.pending) n[n.length - 1] = { role: 'assistant', content: `（出错：${e?.message || e}）` };
        return n;
      });
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  /** 体检卡上「让 AI 改这个」—— 走 fix 分支，与对话工坊同一套语义 */
  function fixIssues(issueIds: string[], reportId?: number) {
    // ⚠️ 2026-10-08：这两个早退分支以前是**静默 return** —— 用户点"让 AI 改这个"，
    // 界面上什么都不发生，看起来就是"按钮坏了/不可用"（这正是用户报的现象之一）。
    // 现在一律回一句人话，让他知道是"正在忙"还是"报告还没就位"，而不是干等。
    if (!issueIds.length) return;
    if (sending) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: '⚠️ 上一条消息还在发送中，这次修复没有启动。等它发完再点一次。',
      }]);
      return;
    }
    if (!convId) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: '⚠️ 对话还没准备好（正在建会话），这次修复没有启动。稍等一下再点一次。',
      }]);
      return;
    }
    const label = issueIds.length === 1
      ? '让 AI 按体检报告改这一条问题'
      : `让 AI 按体检报告改这 ${issueIds.length} 条问题`;
    void send(label, {
      action: 'fix', issue_ids: issueIds, report_id: reportId,
    } as any);
  }

  /** 从消息里反查 issue 属于哪份报告（用户只点了一条、没带 report_id 时兜底） */
  function reportIdFor(issueIds: string[]): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const rp = messages[i].report;
      if (!rp) continue;
      const ids = new Set((rp.issues_flat || []).map((x) => x.id));
      if (issueIds.some((x) => ids.has(x))) return rp.report_id;
    }
    return undefined;
  }

  function pickAction(a: ActionSpec) {
    setOpenGroup(null);
    void send(a.send, { ...a, scope });
  }

  const scopeLabel = scope.start_ep == null && scope.end_ep == null
    ? '整本'
    : `第 ${scope.start_ep ?? 1}–${scope.end_ep ?? episodeCount} 集`;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative" {...drop.handlers}>
      <DropOverlay show={drop.over} />
      {/* 历史对话抽屉 —— 浮在对话区上方，不挤压消息流（关掉就回到原位） */}
      {historyOpen && (
        <div className="absolute inset-0 z-30 bg-surface-base/95 backdrop-blur-sm flex flex-col">
          <div className="px-3 py-2 border-b border-line flex items-center gap-2 flex-shrink-0">
            <History className="w-4 h-4 text-primary" />
            <span className="fs-ui font-semibold">历史对话</span>
            <span className="fs-meta text-ink-muted">
              {histTotal > 0 ? `共 ${histTotal} 个` : ''}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              className="px-2 py-1 rounded border border-line text-ink-secondary hover:text-ink-primary fs-meta"
            >关闭</button>
          </div>
          <div
            className="flex-1 min-h-0 overflow-y-auto"
            /* 滚到底自动翻页；留 120px 余量，别等真触底才请求 */
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) void loadMoreHistory();
            }}
          >
            {histError ? (
              <div className="p-4 fs-meta text-danger">
                加载失败：{hdErrorText(histError)}
                <button onClick={() => void loadHistory()} className="ml-2 underline">重试</button>
              </div>
            ) : histConvs.length === 0 && !histLoading ? (
              <div className="p-6 text-center fs-meta text-ink-muted">还没有任何对话</div>
            ) : (
              <>
                {histConvs.map((c) => {
                  const here = c.id === convId;
                  // 同一部剧 / 别的剧 / 通用对话（draft_id 为空）
                  const otherDraft = !!c.draft_id && c.draft_id !== draftId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => void openHistoryConv(c)}
                      className={cn(
                        'w-full text-left px-3 py-2 border-b border-line/60 hover:bg-surface-overlay transition',
                        here && 'bg-primary/10',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="fs-ui text-ink-primary truncate flex-1">
                          {c.title || '未命名对话'}
                        </span>
                        {here && <span className="fs-meta text-primary shrink-0">当前</span>}
                        {/* 跨剧的标出归属于哪一部，否则一串同名"新对话"根本分不清 */}
                        {otherDraft && (
                          <span className="fs-meta text-ink-muted shrink-0 truncate max-w-[45%]">
                            {c.draft_title || `#${c.draft_id}`} ↗
                          </span>
                        )}
                        {!c.draft_id && <span className="fs-meta text-ink-muted shrink-0">通用</span>}
                      </div>
                      <div className="fs-meta text-ink-muted mt-0.5">
                        {c.message_count ?? 0} 条消息
                        {c.updated_at ? ` · ${fmtWhen(c.updated_at)}` : ''}
                      </div>
                    </button>
                  );
                })}
                <div className="px-3 py-2 text-center fs-meta text-ink-muted">
                  {histLoading
                    ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />加载更多…</span>
                    : histHasMore
                      ? <span className="opacity-40">向下滚动加载更多</span>
                      : <span className="opacity-40">已显示全部 {histTotal || histConvs.length} 个对话</span>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* 动作栏 —— 按意图分组（生 / 查 / 改），与对话工坊同一套语义 */}
      <div className="px-3 py-2 border-b border-line flex items-center gap-1.5 flex-wrap flex-shrink-0">
        <GroupBtn
          label="生成" icon={<Sparkles className="w-3.5 h-3.5" />}
          open={openGroup === 'gen'} onToggle={() => setOpenGroup(openGroup === 'gen' ? null : 'gen')}
        >
          {GEN_ACTIONS.map((a) => (
            <MenuItem key={a.key} action={a} onPick={pickAction} />
          ))}
        </GroupBtn>

        <GroupBtn
          label="检查" icon={<Wrench className="w-3.5 h-3.5" />}
          open={openGroup === 'check'} onToggle={() => setOpenGroup(openGroup === 'check' ? null : 'check')}
        >
          {CHECK_ACTIONS.map((a) => (
            <MenuItem key={a.key} action={a} onPick={pickAction} />
          ))}
        </GroupBtn>

        <GroupBtn
          label="改写" icon={<SquarePen className="w-3.5 h-3.5" />}
          open={openGroup === 'fix'} onToggle={() => setOpenGroup(openGroup === 'fix' ? null : 'fix')}
        >
          {FIX_ACTIONS.map((a) => (
            <MenuItem key={a.key} action={a} onPick={pickAction} />
          ))}
        </GroupBtn>

        {/* 超级 Agent：让 AI 自己读稿、调用平台能力、检查结果，多步完成一件事。
            手打消息仍是纯对话；需要多步自主执行时才点这里。 */}
        <button
          type="button"
          onClick={() => setAgentOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded border border-primary/40 text-primary hover:bg-primary/10 fs-meta"
          title="交给超级 Agent：读完整部剧再改、体检后修复并复查、改编、裂变、批量处理……"
        >
          <Bot className="w-3.5 h-3.5" />交给 Agent
        </button>

        {/* 本剧历史对话 —— 没有它，除了当前这一个会话，其余在工作台里完全不可达，
            用户会以为"对话记录没了"（见 historyOpen 的注释）。 */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="flex items-center gap-1 px-2 py-1 rounded border border-line hover:border-line-strong text-ink-secondary hover:text-ink-primary fs-meta"
          title={`本剧的历史对话（共 ${histTotal || 1} 个）`}
        >
          <History className="w-3.5 h-3.5" />历史
          {histTotal > 1 && <span className="opacity-60">{histTotal}</span>}
        </button>
        <AgentPanel draftId={draftId} open={agentOpen} onClose={() => setAgentOpen(false)} // 只传用户选定的具体型号；厂商级老值（挂载瞬间 / 清单不可达）交给 Agent 用它自己的默认
          model={provider.includes(':') ? provider : undefined}
          onChanged={() => onDraftChanged?.()} />

        {/* 范围：空 = 整本。放在动作栏里而不是藏进设置 —— 精修"哪几集"
            是用户每次都要确认的事 */}
        <div className="flex items-center gap-1 fs-meta text-ink-muted ml-1">
          <span>范围</span>
          <button
            type="button"
            onClick={() => {
              const s = window.prompt(
                `要改哪几集？填 "起-止"（如 3-8），留空 = 整本（共 ${episodeCount} 集）`,
                scope.start_ep == null ? '' : `${scope.start_ep}-${scope.end_ep ?? episodeCount}`,
              );
              if (s === null) return;
              const t = s.trim();
              if (!t) { setScope({ ...scope, start_ep: null, end_ep: null }); return; }
              const m = t.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
              if (m) setScope({ ...scope, start_ep: Number(m[1]), end_ep: Number(m[2]) });
              else if (/^\d+$/.test(t)) setScope({ ...scope, start_ep: Number(t), end_ep: Number(t) });
            }}
            className="px-1.5 py-0.5 rounded border border-line hover:border-line-strong text-ink-secondary hover:text-ink-primary"
            title="圈定范围：精修/检查只作用于这几集"
          >
            {scopeLabel}
          </button>
          {/* 改哪一层 —— 与对话工坊同一个字段、同一套语义。
              ⚠️ 必须一起改：这是同一份 ActionScope 的第二个入口，只改一处会让
              两条路的行为不一致（用户在工作台选"改正文"，切到对话工坊却变回"改剧本"）。 */}
          <span className="text-ink-muted/70">·</span>
          {([['storyboard', '剧本'], ['chapter', '正文']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setScope({ ...scope, target: k })}
              title={k === 'storyboard'
                ? '精修改这一份：可拍摄的分镜稿'
                : '精修改这一份：正文/原文'}
              className={`px-1.5 py-0.5 rounded border transition ${
                scope.target === k
                  ? 'border-primary/60 text-primary bg-primary/10'
                  : 'border-line text-ink-muted hover:text-ink-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />
      </div>

      {/* 消息流 */}
      <div
        ref={scrollRef}
        onScroll={onFlowScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4"
      >
        {booting ? (
          <div className="h-full flex items-center justify-center text-ink-muted fs-ui gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 准备对话…
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2">
            <Sparkles className="w-7 h-7 text-primary/40" />
            <p className="fs-ui text-ink-muted leading-6 max-w-[260px]">
              在这儿聊就行 ——<br />
              说「生成大纲」「把这集改紧一点」，<br />
              AI 的回答可以一键写进右边任意一集。
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <MessageRow
              key={m.id ?? `t${i}`}
              m={m}
              episodeCount={episodeCount}
              /* 修复作业在跑时，报告卡上的按钮转圈禁用 —— 此前**没有传这个 prop**，
                 ReportCard 里 `fixing` 恒为 undefined，于是点了按钮毫无反馈。 */
              fixing={!!liveJob && liveJob.kind === 'fix_script'}
              onWriteToEpisode={onWriteToEpisode}
              onLocate={onLocate}
              onFix={(ids) => fixIssues(ids, m.report?.report_id ?? reportIdFor(ids))}
            />
          ))
        )}
      </div>

      {/* 作业进度条 —— 精修/生成/修复/去AI味在后台跑时显示。
          ⚠️ 这是本组件此前完全缺失的一块（见 LiveJob 注释）：点「精修这批」之后
          界面只留一句"已启动"，之后几十集在后台跑、跑完也不刷新，用户看到的就是
          "点了跑完没反应"。现在进度、完成、失败都当场可见。
          失败态也留在这里（不自动消失），否则用户错过一眼就再也不知道出过事。 */}
      {liveJob && (
        <div className="px-3 py-1.5 border-t border-line bg-primary/5 flex items-center gap-2 flex-shrink-0">
          {liveJob.state?.phase === 'queued'
            ? <span className="w-3.5 h-3.5 shrink-0 text-ink-muted text-[11px] flex items-center justify-center">⏸</span>
            : liveJob.state?.phase === 'stalled'
              ? <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
              : JOB_ACTIVE.has(liveJob.status)
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                : <span className="w-3.5 h-3.5 shrink-0" />}
          <span className="fs-meta text-ink-primary shrink-0">
            {liveJob.label} #{liveJob.id}
          </span>
          {/* 排队时不画进度条 —— 它不会动，画出来就是"卡在 0%"的样子，
              那正是用户误判成卡死的形状。改成说清排在第几个。 */}
          {liveJob.state?.phase === 'queued' ? (
            <span className="fs-meta text-ink-muted shrink-0">
              {liveJob.state.queue_position ? `排队中（前面还有 ${liveJob.state.queue_position} 个）` : '排队中'}
            </span>
          ) : liveJob.progress != null && (
            <span className="w-24 h-1 rounded bg-surface-base overflow-hidden shrink-0">
              <span className="block h-full bg-primary transition-all"
                style={{ width: `${Math.max(0, Math.min(100, liveJob.progress))}%` }} />
            </span>
          )}
          <span className="fs-meta text-ink-muted truncate">
            {liveJob.state?.phase === 'stalled'
              ? '疑似卡住：执行它的进程没心跳了，队列会自动重新派发'
              : liveJob.note || (liveJob.progress != null ? `${liveJob.progress}%` : '进行中')}
            {liveJob.state?.eta_seconds ? ` · 预计还要约 ${humanDur(liveJob.state.eta_seconds)}` : ''}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={async () => {
              try {
                await authFetch(`${API}/jobs/${liveJob.id}/cancel`, { method: 'POST' });
              } catch { /* 取消失败就等它自己跑完 */ }
            }}
            className="fs-meta px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-danger hover:border-danger/40 shrink-0"
            title="取消这个作业（当前这一步跑完后停下）"
          >
            取消
          </button>
        </div>
      )}

      {/* 输入框 */}
      <div className="p-3 border-t border-line flex-shrink-0">
        {pimg.images.length > 0 && (
          <div className="mb-2"><PendingImageStrip images={pimg.images} onRemove={pimg.remove} /></div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface-card px-2.5 py-2 focus-within:border-primary/60">
          {/* 发图片：也可以直接粘贴截图或把图拖进对话区 */}
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="p-1 rounded text-ink-muted hover:text-ink-primary flex-shrink-0"
            title="发送图片（也可直接粘贴截图 / 拖进对话区）"
            aria-label="发送图片"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <input
            type="file"
            ref={imageInputRef}
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            multiple
            className="hidden"
            onChange={(e) => { pimg.add(Array.from(e.target.files || [])); e.target.value = ''; }}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // 剪贴板里同时有文字时不吞默认行为（从网页/Word 复制带图内容）
              const { files, hasText } = imagesFromClipboard(e);
              if (!files.length) return;
              if (!hasText) e.preventDefault();
              pimg.add(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            rows={2}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            className="flex-1 resize-none bg-transparent fs-body text-ink-primary placeholder:text-ink-muted outline-none max-h-40"
          />

          {/* 模型选择 —— 用户 2026-09-21 要求放回发送键左边。
              这里是"发这条消息用哪个模型"，紧挨发送键才对得上因果；
              放在顶部动作栏时它离发送动作最远、反而像全局设置。

              ⚠️ 用共用的 `ModelSelect`，不要自己撸一个下拉：
              之前这里读的是 `/v1/agent/models` 的 `items`（老的**扁平厂商**清单，
              只有 4 条 = 四个厂商的默认型号），于是"能选的模型"只有 4 个。
              真正的全清单在 `/v1/models/catalog`（42 个型号 × 四家，带后端实测的
              "稳"标），`ModelSelect` + `ModelMenu` 已经把二级菜单、稳标、
              下架型号回落、5 分钟缓存全做好了 —— 其它 8 个入口都用它。
              `variant="bare"` 保持无界（无边框无底色）；`direction="up"` 因为输入框贴着页底。 */}
          <ModelSelect
            value={provider}
            onChange={(v, source) => {
              setProvider(v);
              // 只有用户真的点了才记住 —— 自动对齐时写回会把"当时的平台默认"
              // 钉成这个人的长期选择，此后平台升级默认模型他跟不上（见 ModelSelect 注释）。
              if (source === 'user') {
                try { localStorage.setItem('drama_chat_provider', v); } catch { /* noop */ }
              }
            }}
            label={null}
            showHint={false}
            compact
            variant="bare"
            direction="up"
            className="fs-meta max-w-[150px]"
          />

          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || pimg.uploading || (!input.trim() && pimg.readyIds.length === 0)}
            className="p-1.5 rounded-lg bg-primary text-white disabled:opacity-40 hover:bg-primary-hover transition-colors flex-shrink-0"
            aria-label="发送"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 分组按钮（生成 / 检查 / 改写） */
function GroupBtn({
  label, icon, open, onToggle, children,
}: {
  label: string; icon: React.ReactNode; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded fs-ui transition-colors',
          open ? 'bg-primary-subtle text-primary' : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay',
        )}
      >
        {icon}{label}
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-60 rounded-lg border border-line bg-surface-elevated shadow-lg py-1">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ action, onPick }: { action: ActionSpec; onPick: (a: ActionSpec) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(action)}
      title={action.hint}
      className="block w-full text-left px-3 py-1.5 fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
    >
      <span className="flex items-center gap-1.5">
        {action.label}
        {action.chip && <span className="fs-meta text-ink-muted">{action.chip}</span>}
      </span>
    </button>
  );
}

/**
 * 一条消息。
 *
 * §4.5.6：**用户有气泡、AI 无气泡**（AI 直接铺在页面上）。
 */
function MessageRow({
  m, episodeCount, onWriteToEpisode, onLocate, onFix, fixing,
}: {
  m: Message; episodeCount: number;
  onWriteToEpisode: (order: number, text: string, mode?: 'append' | 'replace') => void;
  onLocate: (quote: string) => void;
  onFix: (issueIds: string[]) => void;
  /** 修复作业在跑 —— 让报告卡上的按钮转圈并禁用 */
  fixing?: boolean;
}) {
  const isUser = m.role === 'user';

  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        {m.images && m.images.length > 0 && <MessageImages images={m.images} align="end" />}
        {/* 只发了图没写字时不画空气泡 */}
        {m.content && (
          <div className="max-w-[85%] rounded-2xl bg-primary/10 border border-primary/20 px-3 py-2 fs-body text-ink-primary whitespace-pre-wrap">
            {m.content}
          </div>
        )}
      </div>
    );
  }

  const wc = m.content.length;

  /**
   * 记住选区 —— 拖拽手柄被按下的那一刻浏览器就把选区清了，
   * 所以在**松手时**先存下来，拖的时候用存的这份。
   */
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [picked, setPicked] = React.useState('');
  function rememberSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setPicked(''); return; }
    if (bodyRef.current && !bodyRef.current.contains(sel.anchorNode)) return;
    setPicked(String(sel).trim());
  }

  return (
    <div className="group">
      {m.report && (
        <div className="mb-2">
          {/* fix 传 m.fix（不再硬编码 null）—— 修复跑完把"修前 12 → 修后 7"贴回卡片。
              此前这里写死 null，即使作业真跑完了也永远看不到对比数字。 */}
          {/* ⚠️ fixing 也必须传。2026-10-08：ChatColumn 这一支一直没传它，
              而对话工坊（chat-studio/page.tsx）传了 —— 同一个 ReportCard，
              两条入口行为不一致：v2 工作台里点了"让 AI 改这个"按钮不转圈、
              也不禁用，用户以为没点上，于是**再点一次**（重复入队）。
              prop 链是 ChatColumn → MessageRow → ReportCard，三段都要在。 */}
          <ReportCard report={m.report} fix={m.fix ?? null} fixing={fixing} onFix={onFix} />
        </div>
      )}

      {m.pending && !m.content ? (
        <div className="flex items-center gap-2 fs-ui text-ink-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 思考中…
        </div>
      ) : (
        /* ⚠️ 这里**不能**加 `draggable`（2026-09-21 用户反馈的 bug）：
           元素一旦可拖，浏览器就把"按住拖动"解释成拖拽而**不是划选文字**，
           于是"选中一段再拖"这个设计自己把自己堵死了 —— 连选都选不出来。
           加 `cursor-text` 也没用，那只改指针样子、不改行为。

           所以：正文只管选，**拖拽交给下面那个手柄**。 */
        <div
          ref={bodyRef}
          onMouseUp={rememberSelection}
          className="cursor-text select-text"
        >
          {hasDiffBlock(m.content) ? (
            <DiffAwareText text={m.content} />
          ) : looksLikeMarkdown(m.content) ? (
            /* 带格式的回复 → 渲染成标题/加粗/列表，而不是把 ### ** 直接摆给用户看
               （用户 2026-09-20 反馈："### ** 等符号令人困惑"）。 */
            /* ⚠️ 不要用 `prose`：本项目**没装** @tailwindcss/typography
               （tailwind.config.ts 的 plugins 是空的），prose 是空类名，
               渲染出来还是"标题和内文一样大、列表没缩进"。
               chat-studio 里那几处 prose 同样没生效 —— 这里直接用子选择器给样式。 */
            /* ⚠️ 子元素字号用 **em**（相对本容器），不用 px、也不能写 `[&_h2]:fs-ui`
               —— `fs-ui` 是自定义类，Tailwind 不会为它生成 `[&_h2]:` 变体，那样写等于没写。
               用 em 才能跟着右上角的字号档位一起缩放。 */
            <div className="fs-body text-ink-primary
                            [&_h1]:text-[1.15em] [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5
                            [&_h2]:text-[1.05em] [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1
                            [&_h3]:text-[1em] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
                            [&_p]:my-1.5
                            [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1.5
                            [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1.5
                            [&_li]:my-0.5
                            [&_strong]:font-semibold
                            [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:rounded [&_code]:text-[0.93em]
                            [&_pre]:bg-surface-overlay [&_pre]:border [&_pre]:border-line [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
                            [&_a]:text-primary [&_a]:underline
                            [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-secondary
                            [&_table]:text-[0.88em] [&_th]:text-left [&_th]:pr-3 [&_td]:pr-3">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCjkFriendly]}>{m.content}</ReactMarkdown>
            </div>
          ) : (
            /* 纯文本保持 pre-wrap：剧本正文对缩进敏感，
               过一遍 Markdown 会把段首空格吃掉。 */
            <div className="fs-body text-ink-primary whitespace-pre-wrap">{m.content}</div>
          )}
        </div>
      )}

      {/* 写入草稿的两条路（§4.5.8）：
          **主路径 = 像 Word 一样直接拖选中的文字** —— 那是浏览器原生行为，
          正文只要不是 draggable、选中后按住拖走即可，不需要任何自制手柄
          （手柄不符合用户习惯，2026-09-21 反馈）。右侧集块接 `text/plain`。
          兜底 = 下面这排集号按钮（没意识到能拖的人）。 */}
      {!m.pending && wc > 20 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap opacity-70 hover:opacity-100 transition-opacity">
          <span className="fs-meta text-ink-muted">
            {picked ? `写入选中的 ${picked.length} 字` : '写入'}
          </span>
          {/* 在右侧定位（2026-10-10）：AI 引用了某段原文让用户去改时，
              不必自己复制了去右边 Ctrl+F —— 划选那段，点这里就直接滚过去并高亮。
              ⚠️ 传的是**划选的那段**（picked），不是整条回复：AI 的回复里
              既有原段落也有改写，用户划哪段找哪段，与「写入」的口径一致。 */}
          {picked && (
            <button
              onClick={() => onLocate(picked)}
              title="在右边当前页签里找到这段文字并高亮"
              className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/40
                         text-primary hover:bg-primary/10 fs-meta transition"
            >
              <Crosshair className="w-3 h-3" /> 在右侧定位
            </button>
          )}
          <WriteTargets
            episodeCount={episodeCount}
            onPick={(o, mode) => onWriteToEpisode(o, markdownToPlainText(picked || m.content), mode)}
          />
          <span className="fs-meta text-ink-muted/70">或选中文字直接拖到右边</span>
        </div>
      )}
    </div>
  );
}

/** 集号快捷选择：最近接触的几集 + 一个"其他"输入 */
function WriteTargets({
  episodeCount, onPick,
}: {
  episodeCount: number; onPick: (order: number, mode: 'append' | 'replace') => void;
}) {
  const [mode, setMode] = React.useState<'append' | 'replace'>('append');
  const recent = React.useMemo(() => {
    const n = Math.min(6, Math.max(1, episodeCount));
    return Array.from({ length: n }, (_, i) => i + 1);
  }, [episodeCount]);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {recent.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o, mode)}
          className="px-1.5 py-0.5 rounded border border-line fs-meta text-ink-secondary hover:border-primary/50 hover:text-primary"
          title={`${mode === 'append' ? '追加到' : '覆盖'}第 ${o} 集`}
        >
          {o}
        </button>
      ))}
      {episodeCount > 6 && (
        <button
          type="button"
          onClick={() => {
            const s = window.prompt(`写入第几集？（共 ${episodeCount} 集）`, '');
            if (!s) return;
            const n = Number(s.trim());
            if (Number.isInteger(n) && n > 0 && n <= episodeCount) onPick(n, mode);
          }}
          className="px-1.5 py-0.5 rounded border border-line fs-meta text-ink-muted hover:text-ink-primary"
        >
          …
        </button>
      )}
      <button
        type="button"
        onClick={() => setMode(mode === 'append' ? 'replace' : 'append')}
        className={cn(
          'px-1.5 py-0.5 rounded border fs-meta',
          mode === 'append'
            ? 'border-line text-ink-muted'
            : 'border-warning/50 text-warning',
        )}
        title="切换：追加到末尾 / 覆盖整集"
      >
        {mode === 'append' ? '追加' : '覆盖'}
      </button>
    </div>
  );
}
