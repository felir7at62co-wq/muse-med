'use client';
/**
 * 文稿面板 —— 新版工作台右半页（PLAN §4.5.7 / §4.5.12）
 *
 * ## 它是什么
 * 一份**可以直接改的最终文稿**：左边对话聊出来的东西，落在这里成为成品。
 * 参照用户明确认可的 `_FullTextEditor`（"接近 Word 的纯净编辑区"），
 * 但**不带 iframe、不带杂项面板**。
 *
 * ## 四个页签对应四种真实产物
 * 原文（`script_chapters`）/ 剧本（`script_storyboards`）/
 * 小说 / 推文（`chapter_adaptations` 按 kind 过滤）。
 * 它们各自有表、各自能生成，不是"挑几个 tab 塞进来"。
 *
 * ## 编辑与保存
 * **点正文即进入编辑、失焦即落盘**（用户 2026-09-21 要求），没有「编辑/保存/取消」按钮。
 * - **原文**：保存走新增的 `PUT /chapters/batch`
 *   （此前只有逐章 PATCH，整篇保存要发 N 个请求，半成功状态说不清）
 * - **剧本**：结构是 shots，走已有的 `PUT /storyboards/batch`
 * - **小说/推文**：只读 + 跳转出口。它们没有等价的批量回写接口，
 *   与其造一个"看着能编辑、保存却悄悄失败"的输入框，不如明确只读。
 *   **能编辑的给编辑，不能的给明确出口。**
 *
 * ## 为什么不用「受控 textarea 装整本书」
 * 一部 109 集的剧全文可达几十万字。把整本塞进一个 textarea，
 * 每次按键都触发 React 重渲染，输入会明显卡顿。
 * 所以：**编辑按集进行**（点某一集进入编辑态），列表态只渲染纯文本。
 * 这也是 §4.5.9「无界设计」的形态 —— 集与集之间是一条淡分隔线，不是卡片。
 */
import * as React from 'react';
import {
  Loader2, Save, Check, AlertCircle, RefreshCw, ExternalLink, ClipboardPaste, Sparkles, History, X, Crosshair,
} from 'lucide-react';
import { PasteImportModal } from './PasteImportModal';
import { authFetch } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { notifyError, notifySuccess } from '@/lib/dialog';
import { shotsToText, textToShots, type Shot } from '@/lib/scriptText';
import { markdownToPlainText, looksLikeMarkdown } from '@/lib/markdownPlain';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type ProductKind = 'outline' | 'chapters' | 'storyboards' | 'novel' | 'tweet';

export const PRODUCT_TABS: { key: ProductKind; label: string; unit: string; editable: boolean }[] = [
  // 大纲排在最前：它是整条链的源头，也是"粘贴识别"最常用的地方
  // （从别处拷一段分集大纲过来）。⚠️ 它的"编辑"是**逐集改梗概**，
  // 不是像原文那样整段改 —— 见 load() 里 outline 分支的说明。
  { key: 'outline', label: '大纲', unit: '集', editable: true },
  { key: 'chapters', label: '原文', unit: '章', editable: true },
  { key: 'storyboards', label: '剧本', unit: '集', editable: true },
  // 2026-09-22：小说/推文改为**可编辑**。此前设成只读的理由是"没有批量回写接口"，
  // 但后端其实有 `PATCH /v1/adapt/{kind}/{order}`，且它是 **upsert**
  // （_upsert_adaptation 存历史→覆盖），**空集也能直接写** ——
  // 所以和大纲/正文/剧本一样，空白块点一下就能写，不必先生成再改。
  { key: 'novel', label: '小说', unit: '章', editable: true },
  { key: 'tweet', label: '推文', unit: '条', editable: true },
];

import { locateQuote, hitLabel, type Hit as LocateHit } from '@/lib/locateText';

/** 一集的产物 */
export type Piece = {
  order: number;
  title: string;
  text: string;
  /** 剧本专用的结构化数据（保存时要转回去） */
  shots?: Shot[];
  wordCount?: number;
  isStale?: boolean;
  locked?: boolean;
  /**
   * 大纲专用：「下集钩子」（outline.chapters[].hook_out）。
   *
   * ⚠️ 单独一个字段、**不拼进 text**。text 是可编辑的集正文，点一下变输入框、
   * 失焦就整段写回服务端的 `synopsis` —— 钩子拼进去，用户改一句梗概就会把
   * 钩子也当成梗概存下来，下一轮改写再把它当剧情依据。契约字段必须与正文分开走。
   */
  hook?: { type?: string; strength?: string; leads_to?: string };
};

export type ScriptPaneProps = {
  draftId: number;
  kind: ProductKind;
  onKindChange: (k: ProductKind) => void;
  /**
   * 这部剧**预设**的集数（`script_drafts.episode_count`）。
   *
   * 用来把还没生成的集也摆出来（见 `padToPreset`）：没有它，一部新剧的
   * 大纲/原文页就是一片空白 + 一句"去左边让 AI 生成"，用户想自己动手写
   * 都没有地方落笔（2026-09-21 用户反馈）。
   */
  episodeCount?: number;
  /**
   * 外部要求"插入一段文本到某一集"时的落点。
   * 由父组件（新工作台）在用户点「写入这一集」/ 拖拽落下时设置。
   */
  externalInsert?: { order: number; text: string; nonce: number; mode: 'append' | 'replace' } | null;
  /** 插入被消费后回调，避免重复插入 */
  onExternalInsertDone?: () => void;
  /**
   * 「在右侧定位」指令（2026-10-10）：对话气泡里划选一段文字后传来的原文。
   *
   * 与 `externalInsert` 一样用 nonce 去重 —— 同一段文字连点两次也要重新定位。
   * 只在**当前页签**里找（不跨页签、不自动切页签）：页签是用户的语境，
   * 在"推文"里选一句话却跳到"剧本"去高亮，会让人以为定位错了。
   */
  locate?: { quote: string; nonce: number } | null;
  /** 数据变化后通知父组件刷新左侧树图的状态点 */
  onChanged?: () => void;
  /** 小说/推文空状态里点「按现有正文改写」—— 交给对话栏发一条生成消息 */
  onGenerateAdapt?: (kind: 'novel' | 'tweet') => void;
};

export function ScriptPane({
  draftId,
  kind,
  onKindChange,
  episodeCount = 0,
  externalInsert,
  onExternalInsertDone,
  locate,
  onChanged,
  onGenerateAdapt,
}: ScriptPaneProps) {
  /** 粘贴识别弹窗（原文/大纲共用） */
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pieces, setPieces] = React.useState<Piece[]>([]);
  /** 正在编辑的集号（同时只编辑一集，见文件头"为什么不受控整本"） */
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draftText, setDraftText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  /** 已改未存的集号集合 —— 顶部显示"未保存" */
  const [dirty, setDirty] = React.useState<Set<number>>(new Set());
  /** 正在后台自动保存的集号 —— 失焦即存、没有按钮，状态只能在集头显示 */
  const [autoSaving, setAutoSaving] = React.useState<Set<number>>(new Set());
  /** 刚存好的集号：亮 2 秒对勾。替代每存一次弹一个 toast（改一集弹一次会疯） */
  const [justSaved, setJustSaved] = React.useState<number | null>(null);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  /**
   * 每集的历史版本条数（集号 → 条数）。
   *
   * ## 为什么整本一次取，而不是逐集点开再取
   * 每个块头上要显示"历史 N"。逐块请求就是几十上百个并发，只为一个小角标
   * （见后端 history-summary 的说明）。这里一次拿到，前端算一次。
   *
   * ## 角标为什么**按当前页签过滤**
   * 起初做成"这一集的全部阶段历史"（不传 kind），想法是"用户想知道这集被谁改过"。
   * 实测(2026-10-10, 草稿 654)立刻暴露问题：该草稿只有 storyboard 有历史
   * （每集 6~10 条），于是**推文页签下每个块也挂着"历史 6"**——点进去一条推文
   * 历史都没有，全是剧本。角标就在那撒谎。
   * 页签是用户当前的语境，角标是他判断"这里有没有东西可看"的依据，
   * 两者必须对齐。想看这一集的**全部**阶段改动，进面板后本来就是全量的
   * （面板请求不传 kind，见 loadItems）—— 所以这里过滤不损失任何信息。
   */
  const [histCounts, setHistCounts] = React.useState<Record<string, number>>({});

  /** 正在看历史的集号（null = 面板关着） */
  const [histOrder, setHistOrder] = React.useState<number | null>(null);

  const loadHistoryCounts = React.useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/history-summary?kind=${kind}`);
      if (!r.ok) return;                    // 老后端没有这个端点：静默跳过，不显示角标
      const d = await r.json();
      setHistCounts(d?.counts || {});
    } catch { /* 角标是锦上添花，取不到就不显示，不能因此把正文页整个搞挂 */ }
  }, [draftId, kind]);

  // ── 「在右侧定位」状态（2026-10-10）────────────────────────────────────
  /**
   * 当前定位结果。null = 没有在定位。
   *
   * `hits` 是**全部**命中（可能有十几处），`idx` 是正在看的那一处 ——
   * 用户点「第 2/5 处」翻页时只改 idx，不重新搜。
   */
  const [hitState, setHitState] = React.useState<
    { quote: string; hits: LocateHit[]; idx: number; kind: ProductKind } | null
  >(null);
  /** 没找到时的说明。⚠️ 必须点名当前页签，否则用户不知道该去哪儿找。 */
  const [locateMiss, setLocateMiss] = React.useState<string | null>(null);
  /** 替换输入框的内容（一次只替换高亮的那一处） */
  const [replText, setReplText] = React.useState('');
  /** 上一次处理过的 nonce —— 同一段文字连点两次也要能重新定位 */
  const locateSeen = React.useRef(0);

  /**
   * 滚到某一集的某一段。
   *
   * ⚠️ **不能用 scrollIntoView**（2026-09-22 踩过）：它会把 overflow:hidden 的
   * 祖先也一起滚，表现是三栏并排的页面整体往上跳。只算 rect 差值、自己设 scrollTop。
   * ⚠️ 双 rAF：定位可能要先把某一块从编辑态切回阅读态，那是 React 状态更新，
   * 同步查 DOM 拿不到新节点。
   */
  const scrollToPiece = React.useCallback((order: number, smooth = true) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-piece-order="${order}"]`);
        const box = el?.closest<HTMLElement>('[data-scroll-container="script-pane"]');
        if (!el || !box) return;
        const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: box.scrollTop + delta - 8, behavior: smooth ? 'smooth' : 'auto' });
      });
    });
  }, []);

  // ── 切页签记住"看到第几集"（2026-10-10）──────────────────────────────
  /**
   * 每个页签各自记住"最后看到哪一集"，切回来时回到那一集。
   *
   * ## 为什么必须逐页签记，而不是共用一个
   * 同一集的集号在五个页签里含义不同（大纲第 7 集 / 原文第 7 章 / 剧本第 7 集
   * 是四份不同的稿子）。共用一个集号会串味：在"小说"里看到第 3 章，切到
   * "剧本"却被带到第 3 集 —— 而用户可能是想在剧本里接着第 48 集干活。
   */
  const anchorByKind = React.useRef<Partial<Record<ProductKind, number>>>({});
  /** 切页签后要回到的集号；DOM 就绪后消费掉 */
  const pendingRestore = React.useRef<number | null>(null);
  /** 上一次的页签 —— 用来识别"这是一次切页签" */
  const prevKind = React.useRef<ProductKind>(kind);
  const scrollBox = React.useRef<HTMLDivElement>(null);
  const scrollRaf = React.useRef<number | null>(null);
  /**
   * 加载中不记锚点。
   *
   * ⚠️ 切页签瞬间内容会被换掉，浏览器可能把 scrollTop 夹到 0 并**触发一次
   * scroll 事件** —— 若照记，就会把"我刚切过来的这个页签"记成第 1 集，
   * 把用户上次真正停留的位置冲掉（下次切回来又变成第 1 集）。
   */
  const loadingRef = React.useRef(false);

  /** 滚动时记录"当前顶部是哪一集"。用 rAF 节流，避免每帧都算 rect。 */
  const handleScroll = React.useCallback(() => {
    if (loadingRef.current) return;
    if (scrollRaf.current != null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const box = scrollBox.current;
      if (!box) return;
      const top = box.getBoundingClientRect().top;
      const secs = box.querySelectorAll<HTMLElement>('[data-piece-order]');
      for (const sec of secs) {
        // 取第一个"底边还没滚出容器顶部"的块 = 正在看的这一集。
        // 用 bottom 而不是 top：块很高时它的 top 早已在上方，用 top 会把
        // 正在看的那一集跳过、记成下一集。
        if (sec.getBoundingClientRect().bottom - top > 8) {
          const o = Number(sec.getAttribute('data-piece-order'));
          if (Number.isFinite(o)) anchorByKind.current[kind] = o;
          return;
        }
      }
    });
  }, [kind]);

  // 切页签 → 记下"要回哪儿"（真正的滚动等新列表渲染出来再做）
  React.useEffect(() => {
    if (prevKind.current === kind) return;
    prevKind.current = kind;
    const want = anchorByKind.current[kind];
    pendingRestore.current = want != null ? want : null;
  }, [kind]);

  /**
   * 哪些页签的数据**已经真的换过来了**。
   *
   * ## 为什么不能只看 kind 变了就去回位（2026-10-10 实测踩到）
   * 切页签时 `kind` 立刻变，但 `pieces` 还是**上一个页签的列表**（新数据要等
   * `load()` 回来）。此时按 kind 就去回位，等于拿旧列表的 DOM 滚了一次：
   *   · 位置算出来是新列表里的**另一个集号**（实测 40 → 39）；
   *   · 更糟的是 `pendingRestore` 被这次错误的回位**消费掉了**，新数据到达时
   *     再也没有回位可用，用户就停在浏览器随手保持的位置（实测切回原文停在 12）。
   * 所以回位必须等"当前页签的数据已就位"这个信号 —— 就是 `loadedKind`。
   */
  const [loadedKind, setLoadedKind] = React.useState<ProductKind | null>(null);

  /**
   * 新列表渲染完 → 回到记住的那一集。
   *
   * ⚠️ 必须等 `loadedKind === kind`（当前页签的数据真的换过来了）——
   * 否则会拿旧页签的列表算位置，既滚错地方又把待回位状态白白消费掉。
   *
   * ⚠️ 用**瞬间跳转**而不是 smooth：从第 1 集滑到第 48 集要滚过几万像素，
   * 又慢又晃眼。这里的语义是"回到原处"，不是"带你看过去"。
   */
  React.useEffect(() => {
    if (loadedKind !== kind) return;
    const want = pendingRestore.current;
    if (want == null) return;
    const box = scrollBox.current;
    if (!box) return;
    const secs = [...box.querySelectorAll<HTMLElement>('[data-piece-order]')];
    if (!secs.length) return;
    const orders = secs
      .map((s) => Number(s.getAttribute('data-piece-order')))
      .filter((o) => Number.isFinite(o));
    if (!orders.length) return;
    // 消费掉待回位状态（放在确实要滚之后再清，避免上面任何一条 return 把它吞了）
    pendingRestore.current = null;
    // 夹到最近的可用集号：切到集数更少的产物（小说只生成了 20 章）时，
    // 落到能落到的最后一集，而不是弹回顶部 —— 弹回顶部正是要修的那个毛病。
    let target = want;
    if (!orders.includes(target)) {
      const below = orders.filter((o) => o <= want);
      target = below.length ? Math.max(...below) : Math.min(...orders);
    }
    const el = secs.find((s) => Number(s.getAttribute('data-piece-order')) === target);
    if (!el) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({ top: box.scrollTop + delta - 8 });
    // 回位本身也算"我在这一集"，否则下次切回来又丢
    anchorByKind.current[kind] = target;
  }, [pieces, kind, loadedKind]);

  const tab = PRODUCT_TABS.find((t) => t.key === kind)!;

  /**
   * 把"还没生成的集"补成空白块。
   *
   * ## 为什么必须有（用户 2026-09-21）
   * 一部新剧点进「大纲」或「原文」，库里什么都没有。此前这里显示的是
   * "还没有原文 —— 在左边对话里说「生成正文」" —— 那等于告诉用户
   * **只能让 AI 写、你自己不能写**。而草稿创建时就已经定了集数（预设 N 集），
   * 那 N 集本来就该在这儿摆着，点哪一集就能往里写、能粘贴。
   *
   * 补出来的空块与真实数据**同构**（同一个 order 键），所以保存 / 拖拽落点 /
   * 撤销都不需要特殊分支 —— 保存时后端 upsert 自然会把这一集创建出来。
   *
   * 只补可编辑的产物；小说/推文是改编结果，没生成就是没有，摆一堆空块只是噪音。
   */
  const padToPreset = React.useCallback((list: Piece[]): Piece[] => {
    if (!PRODUCT_TABS.find((t) => t.key === kind)?.editable) return list;
    const maxOrder = list.reduce((m, p) => Math.max(m, p.order || 0), 0);
    const n = Math.max(episodeCount || 0, maxOrder);
    if (n <= 0) return list;
    const byOrder = new Map(list.map((p) => [p.order, p]));
    const out: Piece[] = [];
    for (let o = 1; o <= n; o++) {
      out.push(byOrder.get(o) ?? { order: o, title: '', text: '' });
    }
    return out;
  }, [kind, episodeCount]);

  const load = React.useCallback(async () => {
    if (!draftId) return;
    setLoading(true);
    loadingRef.current = true;      // 见 loadingRef 的注释：加载期间不许记锚点
    setError(null);
    const put = (list: Piece[]) => {
      setPieces(padToPreset(list));
      // 数据已就位 —— 回位 effect 认这个信号（见 loadedKind 的说明）
      setLoadedKind(kind);
    };
    try {
      if (kind === 'storyboards') {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/storyboards`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.items || []);
        put(list.map((s: any) => {
          const shots = (s.shots_json || []) as Shot[];
          return {
            order: s.chapter_order ?? s.order ?? 0,
            title: s.title || `第 ${s.chapter_order ?? s.order} 集`,
            text: shotsToText(shots),
            shots,
            isStale: s.is_stale === 1,
            locked: !!s.locked,
          };
        }));
        return;
      }
      if (kind === 'outline') {
        // 大纲不在独立接口里 —— 它是 script_drafts.outline.chapters，
        // 跟着草稿详情一起回来。所以这里直接读草稿。
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        put(((d?.outline?.chapters) || []).map((ep: any, i: number) => ({
          order: ep.order ?? i + 1,
          title: ep.title || '',
          // 大纲的"正文"就是梗概 + 契约里最该看见的几项。
          // 不把整个契约 JSON 铺出来（那是 _ContractFold 的事）。
          text: ep.synopsis || '',
          // 「下集钩子」单列一块常显（见 Piece.hook 的说明：绝不拼进 text）
          hook: ep.hook_out || undefined,
          isStale: false,
          locked: false,
        })));
        return;
      }
      if (kind === 'chapters') {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/chapters`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.items || []);
        put(list.map((c: any) => ({
          order: c.chapter_order ?? c.order ?? 0,
          title: c.title || `第 ${c.chapter_order ?? c.order} 章`,
          text: c.full_text || c.content || '',
          wordCount: c.word_count,
          isStale: c.is_stale === 1,
          locked: !!c.locked,
        })));
        return;
      }
      // novel / tweet
      const r = await authFetch(`${BASE}/v1/adapt/${kind}?draft_id=${draftId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      put((data?.items || []).map((a: any) => ({
        order: a.chapter_order,
        title: `第 ${a.chapter_order} ${kind === 'novel' ? '章' : '条'}`,
        text: a.content || '',
        wordCount: a.word_count,
      })));
    } catch (e: any) {
      setError(e?.message || '加载失败');
      setPieces([]);
    } finally {
      setLoading(false);
      // 放到下一帧再解禁：`setLoading(false)` 引发的重渲染可能让浏览器再发一次
      // scroll（内容高度变了），那一帧仍属于"这次加载"，不该被记成用户位置。
      requestAnimationFrame(() => { loadingRef.current = false; });
    }
  }, [draftId, kind, padToPreset]);

  React.useEffect(() => { void load(); }, [load]);

  // 历史条数：进页面/切页签/切草稿时拉一次；保存与回滚后也会再拉（见调用点）
  React.useEffect(() => { void loadHistoryCounts(); }, [loadHistoryCounts]);

  // 切页签时退出编辑态：不同页签的集号含义不同，留着会串
  React.useEffect(() => { setEditing(null); setDirty(new Set()); }, [kind]);

  /** 保存一集 */
  const saveOne = React.useCallback(async (order: number, text: string) => {
    if (kind === 'outline') {
      // 大纲的保存走 paste/apply —— 它在服务端只覆盖 title/synopsis 两个字段，
      // **不碰** core_push/stakes/hook_out 等契约字段（那些不该被一次文本编辑抹掉）。
      //
      // ⚠️ `title` 必须**原样带上**：这里编辑的是梗概，标题不在输入框里。
      // 传空字符串的话服务端会当成"用户清空了标题"，把「反击」写成「第2集」——
      // 改一句梗概顺手毁掉标题（2026-09-21 探针抓到）。
      const cur = piecesRef.current.find((p) => p.order === order);
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/paste/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'outline',
          episodes: [{ order, title: cur?.title ?? '', synopsis: text }],
        }),
      });
      if (!r.ok) { notifyError(`保存失败 HTTP ${r.status}`); return false; }
      return true;
    }
    if (kind === 'storyboards') {
      // ⚠️ 这里必须用 `textToShots`（解析**一集的正文**），
      // 不能用 `fullTextToStoryboards`（它要求文本里有 `═══ 第 N 集 ═══` 集头，
      // 那是"整本全文视图"的格式）。本面板是逐集编辑、正文里根本没有集头，
      // 用后者会恒定返回空数组 —— 表现是**剧本怎么改都存不上**，
      // 只弹一句"未识别到内容"（2026-09-21 发现，是上一批我自己写错的）。
      const shots = textToShots(text);
      if (!shots.length && text.trim()) {
        notifyError('没解析出任何镜头 —— 剧本需要「【场 1-1｜…】」这样的场头，或 △ 动作行');
        return false;
      }
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/storyboards/batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ chapter_order: order, shots_json: shots }] }),
      });
      if (!r.ok) { notifyError(`保存失败 HTTP ${r.status}`); return false; }
      const d = await r.json();
      if ((d.skipped || []).includes(order)) {
        notifyError(`第 ${order} 集超出这部剧的集数范围，没写入`);
        return false;
      }
      return true;
    }
    if (kind === 'novel' || kind === 'tweet') {
      // 改编产物逐章保存。PATCH 是 upsert：这一章原本没有记录也能建出来，
      // 所以"空白块直接写"这条路走得通。
      const r = await authFetch(
        `${BASE}/v1/adapt/${kind}/${order}?draft_id=${draftId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
      if (!r.ok) { notifyError(`保存失败 HTTP ${r.status}`); return false; }
      return true;
    }

    // chapters：走批量端点（body 形状与逐章 PATCH 一致，只是可以一次传多集）
    const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/chapters/batch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ chapter_order: order, full_text: text }] }),
    });
    if (!r.ok) { notifyError(`保存失败 HTTP ${r.status}`); return false; }
    return true;
  }, [draftId, kind]);

  /**
   * 结束编辑并落盘 —— 失焦（点别处 / 切页签 / 点另一集）时调用。
   *
   * ## 为什么没有「保存」按钮了（用户 2026-09-21：点击即编辑、失焦即保存）
   * 这一页的形态是"一份可以直接改的文稿"，不是表单。表单才需要"提交"这个动作；
   * 文稿里每多一个按钮，都在提醒用户"你在操作软件"而不是"在写东西"。
   *
   * ## 三件必须处理的事，否则会丢内容
   * 1. **没改就不发请求**：失焦极其频繁（点一下别处就算一次）。原文一集动辄上万字，
   *    白发一轮既慢又白占并发。
   * 2. **先乐观更新本地、再异步落盘**：否则松手那一刻文字会闪回旧值。
   * 3. **失败不清 dirty**：留着"未保存"点和顶部「保存全部」让用户重试。
   *    静默失败 + 清掉标记 = 用户以为存上了、实际没存 —— 这是最坏的结局。
   *
   * ## 为什么用函数式 setEditing
   * 失焦和"点另一集的正文"是连着发生的（blur 先、click 后）。异步回调里直接
   * `setEditing(null)` 会把用户**刚点开的那一集**又关掉。
   */
  function commitEdit() {
    if (editing == null) return;
    const order = editing;
    const text = draftText;
    const orig = pieces.find((p) => p.order === order)?.text ?? '';
    setEditing((cur) => (cur === order ? null : cur));

    if (text === orig) return; // 没动过：连 dirty 都不该变
    // 乐观更新：松手立刻看到自己写的内容
    setPieces((prev) => prev.map((p) =>
      (p.order === order ? { ...p, text, wordCount: text.length } : p)));
    setDirty((d) => new Set(d).add(order));
    setAutoSaving((s) => new Set(s).add(order));

    void (async () => {
      let ok = false;
      try {
        ok = await saveOne(order, text);
      } catch (e: any) {
        notifyError('保存失败: ' + (e?.message || e));
      } finally {
        setAutoSaving((s) => { const n = new Set(s); n.delete(order); return n; });
      }
      if (!ok) return; // dirty 保留 → 顶部「保存全部」可重试
      setDirty((d) => { const n = new Set(d); n.delete(order); return n; });
      if (savedTimer.current) clearTimeout(savedTimer.current);
      setJustSaved(order);
      savedTimer.current = setTimeout(() => setJustSaved(null), 2000);
      onChanged?.();
    })();
  }

  /**
   * Esc：丢掉这次编辑退回原文。
   *
   * ⚠️ **不动 dirty**：这一集可能在编辑之前就因为拖拽写入而"已改未存"，
   * 那份改动还在 pieces 里 —— 把标记清掉会让它变成看不见的未保存内容。
   */
  function discardEdit() {
    setEditing(null);
  }

  /** Ctrl/⌘+S：存下来但**不退出**编辑态（长段落改到一半想存一下） */
  async function saveNow() {
    if (editing == null) return;
    const order = editing;
    setSaving(true);
    try {
      const ok = await saveOne(order, draftText);
      if (ok) {
        setPieces((prev) => prev.map((p) =>
          (p.order === order ? { ...p, text: draftText, wordCount: draftText.length } : p)));
        setDirty((d) => { const n = new Set(d); n.delete(order); return n; });
        notifySuccess(`第 ${order} ${tab.unit}已保存`);
        onChanged?.();
      }
    } catch (e: any) {
      notifyError('保存失败: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  /** 保存全部已改的集 */
  async function saveAll() {
    const orders = [...dirty];
    if (orders.length === 0) return;
    setSaving(true);
    let okCount = 0;
    try {
      for (const o of orders) {
        const p = pieces.find((x) => x.order === o);
        if (!p) continue;
        // 正在编辑的那一集以输入框里的内容为准
        const text = editing === o ? draftText : p.text;
        // eslint-disable-next-line no-await-in-loop
        if (await saveOne(o, text)) okCount++;
      }
      if (okCount) {
        notifySuccess(`已保存 ${okCount} ${tab.unit}`);
        setDirty(new Set());
        setEditing(null);
        await load();
        onChanged?.();
      }
    } finally {
      setSaving(false);
    }
  }

  /**
   * 拖拽落点（§4.5.8 主路径）。
   *
   * 拖拽时右侧**高亮所有可落点**（不是只有一个）—— 用户要能一眼看出
   * "哪些地方可以放"，而不是猜。落点是**集**，不是"文档"。
   */
  const [dropTarget, setDropTarget] = React.useState<number | null>(null);

  /**
   * 拖拽落点的**精确插入位置**（2026-09-22 用户要求）。
   *
   * 改这版之前，拖进来的文字一律追加到那一集**末尾** —— 用户松手的位置
   * 其实已经明确表达了"我要插在这儿"，却被忽略了。
   *
   * `offset` 是字符偏移；`rect` 是那个位置在屏幕上的矩形，用来画插入光标。
   * 光标必须**醒目**（用户原话）：所以画成一条 2px 的主色竖线 + 顶部一个小方块，
   * 并且在闪烁——它要在一屏密密麻麻的正文里一眼可见。
   */
  const [dropCaret, setDropCaret] = React.useState<
    { order: number; offset: number; x: number; y: number; h: number } | null>(null);

  /**
   * 落笔后的**撤销条**（§4.5.8："落下后给一次撤销，5 秒内可撤，避免误拖"）。
   *
   * 存"改之前的那一集内容"，而不是存 diff —— 撤销就是整块还原，
   * 比反向计算一段插入可靠得多（内容里可能本来就含同样的文本）。
   *
   * ⚠️ 用 5 秒自动消失：拖着放着会变成常驻噪音；
   * 但**不自动保存**，所以即使撤销条过期了，用户仍可手动改回（内容还在编辑态里）。
   *
   * ⚠️ 2026-10-09 从"单集"改成"多集"：删除选区可以横跨好几集，
   * 只记一集的旧文本会让撤销把其余几集留在被删掉的状态（半撤销）。
   */
  const [undoBar, setUndoBar] = React.useState<
    { items: { order: number; prevText: string }[]; unit: string; label: string } | null
  >(null);
  const undoTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 供 Ctrl/⌘+Z 用的"上一次插入/删除"记录。
   *
   * ⚠️ 与上面那个 5 秒撤销条**分开存**：撤销条是提示，到点就消失；
   * 而 Ctrl+Z 是肌肉记忆，用户可能在半分钟后才想起来要撤。
   * 插入与删除都是写在 React state 里的（不是原生编辑动作），
   * 所以浏览器自带的撤销栈根本不认这一步 —— 必须自己接
   * （2026-09-22 用户反馈"拖动插入的动作无法用 ctrl z 撤销"）。
   */
  const lastEditRef = React.useRef<{ items: { order: number; prevText: string }[] } | null>(null);
  React.useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  /**
   * 每集一条保存链 —— 保证同一集的写请求**按顺序**发出。
   *
   * ⚠️ 为什么需要：删除是即时落盘的，用户完全可能连按两下（删一段、再删一段）。
   * 若两个 PUT 并发，服务端谁后到不确定 —— 先发的那次如果后到，就把后一次的
   * 结果**覆盖回旧的**（表现是"删了又自己变回来"）。串成一条链即可根治。
   */
  const saveChainRef = React.useRef<Map<number, Promise<unknown>>>(new Map());

  /** 串行落盘一集（走保存链，避免乱序覆盖）。 */
  const persistOne = React.useCallback((order: number, text: string) => {
    const prev = saveChainRef.current.get(order) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => saveOne(order, text));
    saveChainRef.current.set(order, next.catch(() => {}));
    return next;
  }, [saveOne]);

  /** 记一次可撤销的改动（插入 / 删除共用），并亮出 5 秒撤销条。 */
  const rememberEdit = React.useCallback(
    (items: { order: number; prevText: string }[], label: string) => {
      if (!items.length) return;
      lastEditRef.current = { items };
      setUndoBar({ items, unit: tab.unit, label });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndoBar(null), 5000);
    }, [tab.unit]);

  /**
   * 删除选中的正文（Delete / Backspace），或"剪切"（Ctrl/⌘+X）。
   *
   * ## 为什么必须自己接（2026-10-09 用户反馈）
   * 用户要"跨集复制或删除"。实测发现两件事：
   *   · **复制本来就能用** —— Ctrl+C 在跨集选区上正常，浏览器自己就处理了；
   *   · **删除/剪切完全没反应** —— 选区 33 字时按 Delete，总字数 128 → 128；
   *     Ctrl+X 同样是 128 → 128。**连单集内部的选区也删不掉。**
   *
   * 根因：阅读态是 `<pre>`，**不是**可编辑元素。浏览器只在可编辑上下文里
   * 才把 Delete/剪切当成"删除选区"，普通文本节点上它没有这个语义。
   * 而本页的设计是"点一下才进编辑态"（避免上百个 textarea 拖慢滚动），
   * 所以用户**在能跨集选中的状态下，恰恰是按了没有删除能力的阅读态** ——
   * 两个特性相撞，就成了"能选不能删"。
   *
   * ## 修法
   * 自己算"选区与每一块正文的交集"，逐块按字符偏移切开重写。
   * 关键点：
   *   · **按字符偏移算，不按 DOM 节点** —— 片段边界落在文本节点中间是常态；
   *   · 每一块都能独立更新，所以**跨集删除天然支持**（一次改好几集）；
   *   · 走 `rememberEdit`，跨集删除也能**整批撤销**（只记一集会半撤销）。
   *
   * ## 集号/副标题为什么不会被删掉
   * 头部已加 `select-none`，浏览器不会把它的文字纳入选区，而这里又只按
   * `pre` 的文本计算偏移 —— 两道都拦着，正文之外的东西动不了。
   */
  const deleteSelection = React.useCallback((cut: boolean): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const box = document.querySelector('[data-scroll-container="script-pane"]');
    if (!box) return false;
    const sr = sel.getRangeAt(0);
    const anchor = (sr.startContainer.nodeType === 3
      ? sr.startContainer.parentElement : sr.startContainer) as HTMLElement | null;
    // 编辑态不接管：那是个真正的输入框，Delete / 剪切交给浏览器自己处理。
    if (anchor?.closest('textarea, input, [contenteditable="true"]')) return false;
    // 只处理落在文稿区里的选区（左树图、对话栏里的选区不该被这里吃掉）。
    if (!anchor || !box.contains(anchor)) return false;

    const off = (el: Element, node: Node, o: number, len: number) => {
      // 选区边界 → "在这一块里的第几个字"，越界自动夹到两端。
      // 边界在本块之前 → setEnd 落在起点之前、range 塌成空 → 0；
      // 在本块之后 → toString() 拿到全文 → len。正好是我们要的夹取行为。
      const r = document.createRange();
      r.selectNodeContents(el);
      try { r.setEnd(node, o); } catch { return 0; }
      return Math.max(0, Math.min(r.toString().length, len));
    };

    const picked: { order: number; prevText: string; nextText: string }[] = [];
    box.querySelectorAll<HTMLElement>('[data-piece-order]').forEach((sec) => {
      // 便宜的预筛：这一块跟选区有没有交集。没有就跳过昂贵的偏移计算。
      if (!sr.intersectsNode(sec)) return;
      const el = sec.querySelector('pre');
      if (!el) return;
      const full = el.textContent || '';
      if (!full) return;
      const s = off(el, sr.startContainer, sr.startOffset, full.length);
      const e = off(el, sr.endContainer, sr.endOffset, full.length);
      if (e <= s) return;                       // 这一块没被真正选中
      const order = Number(sec.getAttribute('data-piece-order'));
      if (!Number.isFinite(order)) return;
      picked.push({ order, prevText: full, nextText: full.slice(0, s) + full.slice(e) });
    });
    if (!picked.length) return false;

    const apply = () => {
      const map = new Map(picked.map((p) => [p.order, p.nextText]));
      setPieces((prev) => prev.map((p) => (map.has(p.order)
        ? { ...p, text: map.get(p.order)!, wordCount: map.get(p.order)!.length } : p)));
      setDirty((d) => { const n = new Set(d); picked.forEach((p) => n.add(p.order)); return n; });
      rememberEdit(picked.map((p) => ({ order: p.order, prevText: p.prevText })),
                   cut ? '已剪切' : '已删除');
      sel.removeAllRanges();   // DOM 马上会被重渲染替换，先收掉选区免得指向废弃节点

      /**
       * ⚠️ 删除必须**立刻落盘**，不能只改 state。
       *
       * 本组件没有自动保存（只有"失焦才存"的编辑态才存），删除又是在**阅读态**
       * 发生的 —— 不在这里存，用户删完一刷新，删掉的字原样回来，而磁盘上从来
       * 没变过。表现就是"删了没用"，且**看磁盘看不出问题**（因为压根没写）。
       *
       * 走 `persistOne` 的保存链而不是裸 `saveOne`：用户连删两下（删一段、再删一段）
       * 会并发发出两个 PUT，服务端谁后到不确定，先发后到就把后一次的结果覆盖回旧的。
       */
      picked.forEach((p) => {
        void persistOne(p.order, p.nextText).then((ok) => {
          if (!ok) return;   // 失败保留 dirty、顶部「保存全部」可重试（与 commitEdit 同口径）
          setDirty((d) => { const n = new Set(d); n.delete(p.order); return n; });
        }).catch(() => { /* saveOne 内部已提示，dirty 留着 */ });
      });
    };

    if (!cut) { apply(); return true; }
    /**
     * 剪切：**先确认写进剪贴板再删**（写失败就不删）。
     * 反过来做的话，剪贴板写入被拒（权限/失焦）就会变成"东西没了但也没复制到"，
     * 那是最糟的结果 —— 宁可这次剪切不生效，也不能静默吞掉用户的正文。
     */
    try {
      navigator.clipboard?.writeText(sel.toString()).then(apply).catch(() => {
        notifyError('读取剪贴板被拒绝，这次剪切没有执行（可用 Delete 直接删除）');
      });
    } catch {
      notifyError('读取剪贴板被拒绝，这次剪切没有执行（可用 Delete 直接删除）');
    }
    return true;
  }, [rememberEdit, persistOne]);

  /**
   * Delete / Ctrl+X 的接管。
   *
   * ⚠️ 必须判"当前有没有非空选区"再 preventDefault：没有选区时按 Delete
   * 应当什么都不发生，绝不能把整集内容删掉。`deleteSelection` 里已有这层判断。
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isDel = e.key === 'Delete' || e.key === 'Backspace';
      const isCut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x';
      if (!isDel && !isCut) return;
      if (!selHasContent()) return;          // 没选中任何东西 → 完全不管
      if (deleteSelection(isCut)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelection]);

  /**
   * pieces 的同步镜像。
   *
   * ⚠️ 为什么非要它：`setPieces(prev => …)` 的那个函数**不是当场执行的**
   * （React 18 在渲染阶段才跑）。曾经在那个函数里给外层变量赋值来"顺手取出旧内容"，
   * 结果取到的永远是初始值 —— 撤销条因此存了个空字符串，
   * 一点「撤销」就把那一集**清空**了（2026-09-21 探针抓到）。
   * 要读当前值就从 ref 读，别指望 updater 的副作用。
   */
  const piecesRef = React.useRef<Piece[]>([]);
  React.useEffect(() => { piecesRef.current = pieces; }, [pieces]);


  /**
   * 鼠标位置 → 该集正文里的字符偏移 + 屏幕坐标。
   *
   * 拖拽时用它做两件事：画插入光标、决定最终插在第几个字。
   * 正在编辑的那一集是 `<textarea>`：浏览器在 dragover 时**已经把光标移到落点**，
   * 直接读 selectionStart 即可，比自己算更准。
   */
  function caretAtPoint(order: number, clientX: number, clientY: number) {
    const sec = document.querySelector<HTMLElement>(`[data-piece-order="${order}"]`);
    if (!sec) return null;

    const ta = sec.querySelector('textarea');
    if (ta) {
      const r = ta.getBoundingClientRect();
      return { order, offset: ta.selectionStart ?? 0, x: clientX - r.left, y: clientY - r.top, h: 18 };
    }

    const body = sec.querySelector<HTMLElement>('pre, p');
    if (!body) return null;
    const doc = document as any;
    let range: Range | null = null;
    if (typeof doc.caretRangeFromPoint === 'function') {
      range = doc.caretRangeFromPoint(clientX, clientY);
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(clientX, clientY);
      if (pos?.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range || !body.contains(range.startContainer)) return null;

    const probe = document.createRange();
    probe.selectNodeContents(body);
    probe.setEnd(range.startContainer, range.startOffset);
    const offset = probe.toString().length;

    const rect = range.getClientRects()[0] || body.getBoundingClientRect();
    const base = body.getBoundingClientRect();
    return {
      order,
      offset,
      x: Math.round(rect.left - base.left),
      y: Math.round(rect.top - base.top),
      h: Math.round(rect.height || 20),
    };
  }

  /**
   * Ctrl/⌘+Z：撤销上一次"插入"。
   *
   * ⚠️ 只在**焦点不在输入框里**时接管 —— 正在编辑某一集时，
   * Ctrl+Z 应该是 textarea 的原生逐字撤销，那个体验比我们自己做的好得多，
   * 抢过来反而是倒退。
   *
   * 为什么非自己接不可：拖拽插入改的是 React state（pieces），
   * 不是 textarea 里的原生编辑动作 —— 浏览器的撤销栈**根本不知道这一步发生过**，
   * 所以默认按 Ctrl+Z 毫无反应（2026-09-22 用户反馈）。
   */
  const undoLastInsert = React.useCallback(() => {
    const last = lastEditRef.current;
    if (!last) return false;
    // 逐集整块还原。跨集删除会在这里把每一集都放回去，不留"半撤销"。
    setPieces((prev) => {
      const map = new Map(last.items.map((i) => [i.order, i.prevText]));
      return prev.map((p) => (map.has(p.order) ? { ...p, text: map.get(p.order)! } : p));
    });
    setDirty((d) => { const n = new Set(d); last.items.forEach((i) => n.delete(i.order)); return n; });
    /**
     * 撤销也要落盘 —— 与删除**对称**。
     *
     * 删除是即时落盘的（阅读态没有别的保存时机），所以撤销只改 state 就等于
     * "屏幕上回来了、盘上没回来"，一刷新又变回删掉的样子。动作和撤销必须
     * 走同一套持久化，否则两者只有一边是真的。
     */
    last.items.forEach((i) => {
      void persistOne(i.order, i.prevText).then((ok) => {
        if (ok) setDirty((d) => { const n = new Set(d); n.delete(i.order); return n; });
      }).catch(() => { /* 失败保留 dirty，可点「保存全部」重试 */ });
    });
    setUndoBar(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    lastEditRef.current = null;
    return true;
  }, [persistOne]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || t?.isContentEditable) return;
      if (undoLastInsert()) {
        e.preventDefault();
        notifySuccess('已撤销上一次插入');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLastInsert]);

  /**
   * 落点处理：默认追加到该集末尾；按住 Shift = 覆盖整集。
   *
   * ## 为什么要接 `text/plain`（2026-09-21 改）
   * 原来只认私有 MIME `application/x-drama-text` —— 那是"自制拖拽手柄"才会设的。
   * 但用户要的是 **Word 那样直接拖选中的文字**：那是浏览器的原生行为，
   * 原生拖拽只带 `text/plain`。只认私有 MIME 就等于把原生拖拽整个挡掉。
   *
   * 代价是从别处（另一个网页、地址栏）拖文本进来也会被接受 —— 与 Word 一致，
   * 且有 5 秒撤销条兜底，可以接受。**但文件不接**（拖张图进来不该变成乱码）。
   */
  const handleDrop = React.useCallback((order: number, e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData('application/x-drama-text')
      || e.dataTransfer.getData('text/plain');
    if (!raw.trim()) return;
    // 只在"看着像 Markdown"时才剥标记：无条件剥会吃掉剧本正文里的合法字符
    // （破折号开头的台词、单个 * 号等），那是把干净的稿子改坏。
    const text = looksLikeMarkdown(raw) ? markdownToPlainText(raw) : raw;
    const mode: 'append' | 'replace' = e.shiftKey ? 'replace' : 'append';
    const prevText = piecesRef.current.find((p) => p.order === order)?.text ?? '';

    // 松手在哪儿就插在哪儿。取不到精确位置（老浏览器 / 落在空白处）才退回追加末尾。
    const at = dropCaret && dropCaret.order === order ? dropCaret.offset : null;
    const spliced = (base: string) => {
      if (at == null) return base ? `${base}\n\n${text}` : text;
      const i = Math.max(0, Math.min(at, base.length));
      const before = base.slice(0, i);
      const after = base.slice(i);
      // 插入处前后各补一个换行，避免把两句话黏成一行（已有换行就不重复加）
      const lead = before && !before.endsWith('\n') ? '\n' : '';
      const tail = after && !after.startsWith('\n') ? '\n' : '';
      return `${before}${lead}${text}${tail}${after}`;
    };
    setPieces((prev) => prev.map((p) => (p.order !== order ? p : {
      ...p,
      text: mode === 'replace' ? text : spliced(p.text),
    })));
    setDropCaret(null);
    setDirty((d) => new Set(d).add(order));

    // 撤销条 + Ctrl+Z 记录（共用 rememberEdit：提示 5 秒消失，记录不过期）
    rememberEdit([{ order, prevText }], '已落下这一段');
  }, [tab.unit, dropCaret, rememberEdit]);

  /**
   * 外部插入（对话里点「写入这一集」或拖拽落下）。
   *
   * ⚠️ 用 nonce 而不是"内容比对"来判定"这是一次新插入"：
   * 同一段文字被连续插入两次是合法操作（用户可能真要插两遍），
   * 按内容去重会静默吞掉第二次。
   */
  const lastNonceRef = React.useRef<number>(0);
  React.useEffect(() => {
    if (!externalInsert || externalInsert.nonce === lastNonceRef.current) return;
    lastNonceRef.current = externalInsert.nonce;
    const { order, text, mode } = externalInsert;
    // ⚠️ 旧内容从 ref 读、dirty/undoBar 在 updater **外面**设。
    // 在 updater 里做这些事等于"渲染时改别的 state"，且拿不到当前值（见 piecesRef 的说明）。
    const hit = piecesRef.current.find((p) => p.order === order);
    if (!hit) { onExternalInsertDone?.(); return; }
    const nextText = mode === 'replace' ? text : (hit.text ? `${hit.text}\n\n${text}` : text);
    setPieces((prev) => prev.map((p) => (p.order === order ? { ...p, text: nextText } : p)));
    setDirty((d) => new Set(d).add(order));
    // 按钮写入同样给撤销机会：一排小小的集号按钮很容易点错隔壁那一个
    rememberEdit([{ order, prevText: hit.text }], '已写入这一集');
    onExternalInsertDone?.();
  }, [externalInsert, onExternalInsertDone, rememberEdit]);

  /**
   * 消费「在右侧定位」指令：在当前页签里找这段文字 → 滚过去 → 高亮。
   *
   * 依赖数组里**故意不含 pieces** —— 定位是"对当次数据的一次性动作"，
   * 若跟着 pieces 重跑，用户每编辑一个字高亮就重算一次、位置乱跳。
   * 真正需要重算时由父组件递增 nonce（用户重新点一次按钮）。
   */
  React.useEffect(() => {
    if (!locate || locate.nonce === locateSeen.current) return;
    locateSeen.current = locate.nonce;
    const hits = locateQuote(piecesRef.current, locate.quote);
    setReplText('');
    if (!hits.length) {
      setHitState(null);
      // ⚠️ 必须点名当前页签：不说的话用户不知道是"没找到"还是"找的是别处"
      setLocateMiss(
        `当前页签（${tab.label}）里没有这段文字。它可能在别的页签里 —— 先切到那个页签再点一次。`
      );
      return;
    }
    setLocateMiss(null);
    setHitState({ quote: locate.quote, hits, idx: 0, kind });
    scrollToPiece(hits[0].order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate, scrollToPiece, tab.label]);

  /** 翻到第 n 处命中。 */
  const gotoHit = React.useCallback((n: number) => {
    setHitState((st) => {
      if (!st) return st;
      const idx = ((n % st.hits.length) + st.hits.length) % st.hits.length;
      scrollToPiece(st.hits[idx].order);
      return { ...st, idx };
    });
  }, [scrollToPiece]);

  /**
   * 把高亮的那一处替换成输入的内容。
   *
   * 走 `persistOne`（串行保存链）而不是裸 saveOne：用户可能连点两次替换，
   * 两个 PUT 并发时谁后到不确定，后发先至就会把上一次的结果覆盖回旧的。
   * 再调 `rememberEdit` 给撤销机会 —— 替换是改正文，必须能一键撤回。
   */
  const applyReplace = React.useCallback(async () => {
    const st = hitState;
    if (!st) return;
    const h = st.hits[st.idx];
    const piece = piecesRef.current.find((p) => p.order === h.order);
    if (!piece) return;
    const nextText = piece.text.slice(0, h.start) + replText + piece.text.slice(h.end);
    setPieces((prev) => prev.map((p) => (
      p.order === h.order ? { ...p, text: nextText, wordCount: nextText.length } : p
    )));
    rememberEdit([{ order: h.order, prevText: piece.text }], '已替换');
    setHitState(null);
    setLocateMiss(null);
    // 保存态由 persistOne/saveOne 负责（顶部「未保存」与对勾都在那里收尾）
    setDirty((d) => new Set(d).add(h.order));
    const ok = await persistOne(h.order, nextText);
    if (ok) setDirty((d) => { const n = new Set(d); n.delete(h.order); return n; });
  }, [hitState, replText, rememberEdit, persistOne]);

  /** 关掉定位态（高亮、提示、替换栏一起收） */
  const clearLocate = React.useCallback(() => {
    setHitState(null);
    setLocateMiss(null);
    setReplText('');
  }, []);

  return (
    // ⚠️ `min-h-0`：父级是 flex 列容器，flex 项默认 `min-height:auto`
    // （不许压到比内容矮）。少了它，下面那个 overflow-y-auto 会被正文
    // 撑成几万像素高，**右栏就再也滚不动了**（2026-09-21 用户反馈）。
    <div className="flex-1 min-h-0 flex flex-col min-w-0 bg-surface-base">
      {/* 粘贴识别弹窗 —— 挂在最外层，不受内容区滚动影响 */}
      <PasteImportModal
        draftId={draftId}
        kind={kind === 'chapters' ? 'chapters' : 'outline'}
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onApplied={() => { void load(); onChanged?.(); }}
      />
      {/* 头部：页签 + 保存状态 + 全局保存 */}
      <div className="flex items-center gap-2 px-3 border-b border-line flex-shrink-0">
        <div className="flex items-center">
          {PRODUCT_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onKindChange(t.key)}
              className={cn(
                'px-3 py-2 fs-ui transition-colors border-b-2 -mb-px',
                kind === t.key
                  ? 'border-primary text-ink-primary font-medium'
                  : 'border-transparent text-ink-secondary hover:text-ink-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* 「点击即编辑」没有按钮，就得有一句话告诉用户它存在 ——
            否则界面上看不出正文是可改的（去掉「编辑」按钮的代价）。 */}
        {tab.editable && (
          <span className="fs-meta text-ink-muted hidden desktop:inline">
            点正文即可改，点走自动保存（Esc 放弃）
          </span>
        )}
        {/* 粘贴识别：把一段文本按集号切开写进当前草稿。
            原文/大纲两个页签都有 —— 它们都常有"从别处拷一段过来"的需求。 */}
        {(kind === 'chapters' || kind === 'outline') && (
          <button
            type="button"
            onClick={() => setPasteOpen(true)}
            className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
            title={kind === 'chapters' ? '粘贴整段正文，按「第N章」自动切开' : '粘贴分集大纲，自动切开'}
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            粘贴识别
          </button>
        )}
        {dirty.size > 0 && (
          <span className="fs-meta text-warning" title={[...dirty].join('、')}>
            {dirty.size} 处未保存
          </span>
        )}
        {dirty.size > 0 && (
          <button
            type="button"
            onClick={() => void saveAll()}
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded fs-ui bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            保存全部
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="p-1 rounded text-ink-muted hover:text-ink-primary hover:bg-surface-overlay disabled:opacity-50"
          title="重新拉取"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
        {!tab.editable && (
          <a
            href={`/drafts/${draftId}?tab=${kind}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded text-ink-muted hover:text-ink-primary hover:bg-surface-overlay"
            title={`在新窗口打开工作台的「${tab.label}」页（可编辑）`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      {/* 撤销条：刚落笔的 5 秒内可一键还原（§4.5.8） */}
      {undoBar && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/8 border-b border-primary/20 fs-ui flex-shrink-0">
          <span className="text-ink-secondary">
            {undoBar.label}
            {undoBar.items.length === 1
              ? `第 ${undoBar.items[0].order} ${undoBar.unit}`
              : `${undoBar.items.length} ${undoBar.unit}`}
            （尚未保存）
          </span>
          <button
            type="button"
            onClick={() => undoLastInsert()}
            className="text-primary hover:underline font-medium"
          >
            撤销
          </button>
          <button
            type="button"
            onClick={() => setUndoBar(null)}
            className="ml-auto text-ink-muted hover:text-ink-primary"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {/* 「在右侧定位」条（2026-10-10）：对话里划选一段 → 找到并高亮 → 就地替换。
          做成**常驻的一条**而不是飘在正文上的浮层：它承载高亮说明、翻页和替换输入，
          内容多且要能反复操作，浮层会挡住正要看的那段正文。 */}
      {locateMiss && (
        <div className="flex items-start gap-2 px-3 py-2 bg-warning/10 border-b border-warning/30 fs-ui flex-shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-warning mt-0.5 flex-shrink-0" />
          <span className="text-ink-secondary flex-1">{locateMiss}</span>
          <button type="button" onClick={clearLocate}
            className="text-ink-muted hover:text-ink-primary" aria-label="关闭">✕</button>
        </div>
      )}
      {hitState && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/30 fs-ui flex-shrink-0 flex-wrap">
          <Crosshair className="w-3.5 h-3.5 text-warning flex-shrink-0" />
          <span className="text-ink-secondary">
            定位到第 {hitState.hits[hitState.idx].order} {tab.unit}
          </span>
          {/* 匹配质量必须显式说出来：精确命中与"标点不同"与"只六成相同"
              是三件可信度完全不同的事，混成一个样子会让用户拿错版去替换。 */}
          <span
            className={cn(
              'px-1.5 py-0.5 rounded fs-meta',
              hitState.hits[hitState.idx].exact
                ? 'bg-success/15 text-success'
                : 'bg-warning/20 text-warning',
            )}
          >
            {hitLabel(hitState.hits[hitState.idx])}
          </span>
          {hitState.hits.length > 1 && (
            <span className="flex items-center gap-1 text-ink-secondary">
              <button type="button" onClick={() => gotoHit(hitState.idx - 1)}
                className="px-1 rounded hover:bg-surface-overlay" title="上一处">↑</button>
              第 {hitState.idx + 1}/{hitState.hits.length} 处
              <button type="button" onClick={() => gotoHit(hitState.idx + 1)}
                className="px-1 rounded hover:bg-surface-overlay" title="下一处">↓</button>
            </span>
          )}
          <div className="flex-1" />
          <input
            value={replText}
            onChange={(e) => setReplText(e.target.value)}
            placeholder="替换为…（留空 = 删除这段）"
            className="px-2 py-0.5 rounded border border-line bg-surface-base text-ink-primary w-56 fs-meta"
          />
          <button
            type="button"
            onClick={() => void applyReplace()}
            className="px-2 py-0.5 rounded bg-primary text-white hover:bg-primary-hover fs-meta"
            title="替换高亮的这一处，可撤销"
          >
            替换这一处
          </button>
          <button type="button" onClick={clearLocate}
            className="text-ink-muted hover:text-ink-primary" aria-label="结束定位">✕</button>
        </div>
      )}

      {/* 历史版本面板（2026-10-10）。做成**抽屉**而不是弹窗：
          用户要一边看旧版本、一边对照正文，弹窗会把正文盖住。 */}
      {histOrder !== null && (
        <EpisodeHistoryPanel
          draftId={draftId}
          order={histOrder}
          unit={tab.unit}
          kind={kind}
          currentText={pieces.find((p) => p.order === histOrder)?.text || ''}
          onClose={() => setHistOrder(null)}
          onRestored={async () => {
            setHistOrder(null);
            await load();                 // 正文已在服务端变过，重拉
            await loadHistoryCounts();    // 回滚本身也会产生一条新历史
            onChanged?.();
          }}
        />
      )}

      {/* 内容
          data-scroll-container：左树图点集时**只滚这一个容器**的锚点
          （用 scrollIntoView 会连带滚祖先，把中间对话一起顶走） */}
      <div
        ref={scrollBox}
        onScroll={handleScroll}
        data-scroll-container="script-pane"
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {loading && pieces.length === 0 ? (
          <div className="h-full flex items-center justify-center text-ink-muted fs-ui gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 fs-ui">
            <span className="text-danger flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {error}
            </span>
            <button type="button" onClick={() => void load()} className="px-2 py-1 rounded bg-surface-overlay hover:bg-surface-raised">重试</button>
          </div>
        ) : pieces.length === 0 ? (
          <EmptyHint
            kind={kind}
            onPaste={(kind === 'chapters' || kind === 'outline') ? () => setPasteOpen(true) : undefined}
            onGenerate={(kind === 'novel' || kind === 'tweet') && onGenerateAdapt
              ? () => onGenerateAdapt(kind) : undefined}
          />
        ) : (
          <div className="px-4 py-3">
            {pieces.map((p) => (
              <PieceBlock
                key={p.order}
                piece={p}
                kind={kind}
                editing={editing === p.order}
                editable={tab.editable}
                draftText={editing === p.order ? draftText : ''}
                dirty={dirty.has(p.order)}
                autoSaving={autoSaving.has(p.order)}
                justSaved={justSaved === p.order}
                histCount={histCounts[String(p.order)] || 0}
                onOpenHistory={() => setHistOrder(p.order)}
                /* 只给**当前那一处**命中传区间（同一时刻只高亮一处）。
                   其余命中散在别的集里，由"第 n/N 处"翻页切过去。
                   ⚠️ 必须比对 kind：换页签后 hits 里的**字符下标是按旧页签的
                   文本算的**，若继续拿去切新页签的文本，会高亮出一段完全
                   无关的字（下标恰好在范围内就会生效），而且看起来"像找到了"。
                   那是最坏的一种错 —— 静默给出错误答案。 */
                highlight={(() => {
                  if (!hitState || hitState.kind !== kind) return null;
                  const h = hitState.hits[hitState.idx];
                  if (h.order !== p.order) return null;
                  return { start: h.start, end: h.end, exact: h.exact };
                })()}
                onStartEdit={() => {
                  // 点另一集时，上一集先落盘（textarea 的 blur 会先跑，
                  // 这里再兜一次：键盘 Tab 走焦点等路径也要保证不丢）
                  if (editing != null && editing !== p.order) commitEdit();
                  setEditing(p.order);
                  setDraftText(p.text);
                }}
                onChangeText={setDraftText}
                onCommit={commitEdit}
                onDiscard={discardEdit}
                onSaveNow={() => void saveNow()}
                dropActive={dropTarget === p.order}
                onDropOn={(e) => handleDrop(p.order, e)}
                caret={dropCaret && dropCaret.order === p.order ? dropCaret : null}
                onDragOver={(e) => {
                  // 原生拖文字只带 text/plain；文件拖拽带 Files —— 后者一律不接
                  const types = e.dataTransfer.types;
                  const isText = types.includes('application/x-drama-text') || types.includes('text/plain');
                  if (!isText || types.includes('Files')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  if (dropTarget !== p.order) setDropTarget(p.order);
                  setDropCaret(caretAtPoint(p.order, e.clientX, e.clientY));
                }}
                onDragLeave={() => {
                  setDropTarget((cur) => (cur === p.order ? null : cur));
                  setDropCaret((cur) => (cur && cur.order === p.order ? null : cur));
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 一集/一章的块 —— 无界形态（§4.5.9）：淡分隔线 + 标题行，不用卡片。
 *
 * ## 交互：点正文即编辑、失焦即保存（用户 2026-09-21 要求）
 * 没有「编辑 / 保存 / 取消」三连按钮。正文本身就是编辑入口：
 *   点一下 → 变输入框（光标落在**点的那个字**上）
 *   点走   → 自动落盘
 *   Esc    → 丢掉这次改动
 *   ⌘/Ctrl+S → 存但不退出
 *
 * ## 为什么不让它一直是 textarea
 * 一部剧上百集、单集上万字。上百个 textarea 同时挂着会明显拖慢滚动，
 * 而**同时只有一集在编辑**是这一页的既有前提（见文件头）。
 *
 * ## 为什么"选中文字"不算点击
 * 用鼠标划选正文（想复制一段）在 DOM 上也是一次 mouseup。
 * 若不分辨，用户一划选就切进编辑态、选区当场没了。
 * 所以：**只有选区是空的才进编辑**。
 */
function PieceBlock({
  piece, kind, editing, editable, draftText, dirty, autoSaving, justSaved,
  onStartEdit, onChangeText, onCommit, onDiscard, onSaveNow,
  dropActive, onDropOn, onDragOver, onDragLeave, caret,
  histCount, onOpenHistory, highlight,
}: {
  piece: Piece; kind: ProductKind; editing: boolean; editable: boolean;
  draftText: string; dirty: boolean; autoSaving: boolean; justSaved: boolean;
  onStartEdit: () => void; onChangeText: (v: string) => void;
  onCommit: () => void; onDiscard: () => void; onSaveNow: () => void;
  dropActive?: boolean;
  onDropOn?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  /** 拖拽插入光标的位置（相对正文块左上角）；null = 不显示 */
  caret?: { offset: number; x: number; y: number; h: number } | null;
  /** 这一集的历史版本条数。0/undefined = 不显示入口（免得每块挂个"0 版"噪音） */
  histCount?: number;
  /** 点"历史 N"时打开历史抽屉。由父组件持有开合状态 */
  onOpenHistory?: () => void;
  /**
   * 「在右侧定位」命中本块时的区间（相对 `piece.text` 的字符下标，左闭右开）。
   * null = 本块没有被定位。**同一时刻只有一块非 null**。
   */
  highlight?: { start: number; end: number; exact: boolean } | null;
}) {
  const unit = PRODUCT_TABS.find((t) => t.key === kind)!.unit;
  const words = editing ? draftText.length : (piece.wordCount ?? piece.text.length);

  const taRef = React.useRef<HTMLTextAreaElement>(null);
  /** 点击落在正文第几个字 —— 进编辑态后光标要落在那里，不能一律跳到末尾 */
  const caretRef = React.useRef<number | null>(null);
  /** Esc 触发的 blur 不该保存 */
  const discardingRef = React.useRef(false);

  /** 高度跟着内容长 —— 出现滚动条就等于"冒出了一个框"，与"只多一个光标"相悖 */
  const autoGrow = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  React.useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    autoGrow();

    // ⚠️ `focus()` 会把元素**滚进视口** —— 而这里的 textarea 常有几千字、
    // 比一屏还高，于是浏览器把它的**顶部**对齐到可视区，
    // 表现就是"点正文中间，画面却跳到这一章最上面"（2026-09-22 用户反馈）。
    // preventScroll 阻止这次自动滚动；再把容器的 scrollTop 原样写回，
    // 保证从阅读态切到编辑态**画面纹丝不动**。
    const box = ta.closest<HTMLElement>('[data-scroll-container="script-pane"]');
    const keep = box?.scrollTop ?? 0;
    ta.focus({ preventScroll: true });
    if (box && box.scrollTop !== keep) box.scrollTop = keep;

    const at = caretRef.current;
    const pos = at == null ? ta.value.length : Math.min(at, ta.value.length);
    ta.setSelectionRange(pos, pos);
    // setSelectionRange 在部分浏览器里同样会把光标滚进视口，再兜一次
    if (box && box.scrollTop !== keep) box.scrollTop = keep;
    caretRef.current = null;
  }, [editing, autoGrow]);

  React.useEffect(() => { if (editing) autoGrow(); }, [draftText, editing, autoGrow]);

  /**
   * 编辑态里"指针一竖着离开这一块，就立刻结束编辑" —— 2026-10-08 用户反馈的第二个问题。
   *
   * ## 为什么编辑态选不了跨集
   * 正在编辑的那一块是 `<textarea>`，而浏览器规定**选区不能跨越表单控件边界**：
   * 在 textarea 里按下鼠标再怎么拖，选区都被关在这个 textarea 内部。
   * 隔离实验（同一段文本、同样的拖拽轨迹）：
   *   `<pre>`      → 选中 63 字，anchor=第一块 focus=第二块  ✅ 跨得出去
   *   `<textarea>` → 选中 52 字，collapsed=true            ❌ 出不去
   *   `contenteditable` → 同样出不去（它也是独立的编辑宿主）
   * 在真实工作台上也是同一结论：阅读态拖一次能横跨第 1~18 集（37780 字），
   * 编辑态同样的拖拽 `isCollapsed` 直接为真、一个字都没选中。
   *
   * 用户的原话是"**视觉上没有文本框**，但跨集滑动选中做不到" —— 症结恰恰在这：
   * 编辑态被刻意做成和阅读态**长得一模一样**（见下面 textarea 的注释），
   * 于是用户根本看不出自己已经踩进了一个输入框，只会觉得"选中功能坏了"。
   *
   * ## 修法
   * 指针一旦离开这一块的纵向范围，就 `onCommit()` 结束编辑，让它变回普通 `<pre>`。
   * 选区随之不再受控件约束，原生跨块拖选照常工作（实测拖出去后一次就能选到下一集）。
   * 语义上也自洽：**开始划选 = 已经不在打字了**，这正是本页"点走即存"的同一套习惯。
   *
   * ⚠️ 判据必须是**纵向**范围：textarea 的高度就等于这一集的全部内容，
   * 所以"拖到它下面"必然意味着去了下一集；而横向拖出去仍然是同一行里的选字，不该打断。
   */
  /**
   * 已经"因为拖出边界"而提交过的集号。
   *
   * ⚠️ 用 ref 而不是 effect 里的局部变量：`onCommit` 是父组件每次渲染都会新建的
   * 普通函数（不是 useCallback），所以这个 effect 每次渲染都会**重新注册**，
   * 局部变量会跟着重置 —— 闸门形同虚设。挂在组件上的 ref 能跨重新注册存活。
   * 它在"这一块不再处于编辑态"时清空，于是下一次编辑可以重新触发一次。
   *
   * ⚠️ 注意本组件的 `editing` 是**布尔**（父组件已经用 `editing === p.order` 算好了），
   * 集号要用 `piece.order`。写成 `editing` 会静默地拿布尔值当集号用。
   */
  const dragCommittedRef = React.useRef<number | null>(null);
  const order = piece.order;

  React.useEffect(() => {
    if (!editing) { dragCommittedRef.current = null; return; }
    function onMove(e: MouseEvent) {
      if (dragCommittedRef.current === order) return;   // 这次编辑已经交过了
      if (!(e.buttons & 1)) return;   // 只在按住左键拖动时判定，避免悬停误触发
      const ta = taRef.current;
      if (!ta) return;
      const r = ta.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) return;  // 还在本集范围内
      dragCommittedRef.current = order;
      onCommit();
    }
    // 必须挂在 document 上：指针一旦离开这一块，块上的 onMouseMove 就收不到事件了。
    document.addEventListener('mousemove', onMove, true);
    return () => document.removeEventListener('mousemove', onMove, true);
  }, [editing, onCommit, order]);

  /** 用 mouseup 而不是 click：这时才知道用户是"点一下"还是"划选了一段" */
  function onTextMouseUp(e: React.MouseEvent<HTMLElement>) {
    if (!editable || editing || e.button !== 0) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 在划选文字，别抢
    caretRef.current = caretOffsetAt(e.currentTarget, e.clientX, e.clientY);
    onStartEdit();
  }

  return (
    <section
      /* 拖拽落点的锚：对话区把文本拖进来时用这个定位到具体某一集 */
      data-piece-order={piece.order}
      onDrop={onDropOn}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={cn(
        'py-4 border-b border-line/40 last:border-b-0 transition-colors rounded',
        // 落点高亮：拖拽经过时整块泛蓝，明确"松手会放在这里"
        dropActive && 'bg-primary/5 ring-1 ring-primary/40',
      )}
    >
      <header className="flex items-center gap-2 mb-2 select-none"
              /* ⚠️ select-none 不是装饰（2026-10-09 用户反馈）。
                 这一行是"第 N 章 / 副标题 / 32 字 / 保存状态"，它与正文同在一个
                 <section> 里，所以没有任何东西阻止选区把它扫进去。实测从第1块正文
                 拖到第2块正文，选到的是：
                   `标题1号\nAlpha1…\n第 2 章\n32 字\n副`
                 —— 用户要复制的是正文，却把集号、字数、下一章的副标题一起复制走了
                 （原话："会把「第 2 章 聚餐当天傍晚」这种集号和副标题也选择到"）。
                 这些是**界面元信息**，不是文稿内容，本就不该能被选中。 */
      >
        <span className="fs-ui font-semibold text-ink-primary tabular-nums">
          第 {piece.order} {unit}
        </span>
        {/* 标题：数据里常常就是「第N集」这种**与左侧前缀重复**的占位名
            （生成侧没给真标题时就是这么填的）。重复显示会变成
            "第 1 章 第1集"，纯噪音 —— 与集号重复时不显示。 */}
        {!isPlaceholderTitle(piece.title, piece.order, unit) && (
          <span className="fs-meta text-ink-muted truncate">{piece.title}</span>
        )}
        {piece.isStale && (
          <span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0" title="上游已更新，建议重新生成" />
        )}

        {/* 历史版本入口（2026-10-10 用户要求）。
            ⚠️ 常显、不进 hover 菜单 —— 藏在 hover 里的按钮等于用户眼里没这功能
            （本仓已有过这个教训）。没有历史时不显示，免得每块都挂个"0 版"噪音。 */}
        {(histCount || 0) > 0 && onOpenHistory && (
          <button
            type="button"
            onClick={onOpenHistory}
            className="flex items-center gap-1 fs-meta text-ink-muted hover:text-primary flex-shrink-0"
            title={`查看第 ${piece.order} ${unit}的历史版本（可对照、可切换回旧版本）`}
          >
            <History className="w-3 h-3" />
            历史 {histCount}
          </button>
        )}

        <span className="ml-auto fs-meta text-ink-muted tabular-nums flex-shrink-0">{words} 字</span>

        {/* 保存状态 —— 没有按钮了，所以这里必须说清楚"存了没有" */}
        {autoSaving ? (
          <span className="flex items-center gap-1 fs-meta text-ink-muted flex-shrink-0">
            <Loader2 className="w-3 h-3 animate-spin" /> 保存中
          </span>
        ) : justSaved ? (
          <span className="flex items-center gap-1 fs-meta text-success flex-shrink-0">
            <Check className="w-3 h-3" /> 已保存
          </span>
        ) : dirty ? (
          <span className="flex items-center gap-1 fs-meta text-warning flex-shrink-0" title="还没存上，可用顶部「保存全部」重试">
            <span className="w-1.5 h-1.5 rounded-full bg-warning" /> 未保存
          </span>
        ) : null}
      </header>

      {editing ? (
        /* ## 编辑态必须和阅读态**长得一模一样**（用户 2026-09-21：
           "除了出现光标外不要有其他变化"）
           所以这里不是"一个输入框"，而是把同一段文字换成可打字的形态：
           背景透明、无边框、无 outline、字号/行高/字体/内外边距与 <pre> 完全一致，
           高度按内容自动长（不留滚动条、不出现"框"）。
           一旦给它 bg/border，点一下就会蹦出个白盒子 —— 那不是文稿，那是表单。 */
        <textarea
          ref={taRef}
          value={draftText}
          onChange={(e) => onChangeText(e.target.value)}
          onBlur={() => {
            if (discardingRef.current) { discardingRef.current = false; return; }
            onCommit();
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              onSaveNow();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              discardingRef.current = true;
              onDiscard();
            }
          }}
          rows={1}
          spellCheck={false}
          className="inline-editor w-full block p-0 m-0 bg-transparent border-0 outline-none shadow-none resize-none overflow-hidden
                     fs-body text-ink-primary font-sans break-words"
        />
      ) : piece.text ? (
        <div className="relative">
          {caret && <DropCaret {...caret} />}
        <pre
          onMouseUp={onTextMouseUp}
          className={cn(
            'whitespace-pre-wrap break-words fs-body text-ink-primary font-sans m-0',
            // 只改指针形状，不加底色/边框：hover 就变色的话，
            // "点下去"那一刻底色又消失，等于用户点一次看见两次变化。
            editable && 'cursor-text',
          )}
          title={editable ? '点一下就能改，点走自动保存' : undefined}
        >
          {/*
            有定位命中时切成三段渲染，中间那段套 <mark>。
            ⚠️ 拆成多个文本节点**不影响** deleteSelection 取全文 ——
            它读的是 el.textContent，而 textContent 会把子节点拼回同一个串。
            这也是敢这样改的前提（见 deleteSelection 的注释）。
          */}
          {highlight && highlight.start < highlight.end ? (
            <>
              {piece.text.slice(0, highlight.start)}
              <mark
                className={cn(
                  'rounded px-0.5',
                  // 精确命中 = 实底；「相近」= 虚底 + 描边。
                  // 两种视觉必须能一眼分开：用户要拿高亮的那段去做替换，
                  // 把"只六成相同"画得和精确命中一样，等于诱导他改错地方。
                  highlight.exact
                    ? 'bg-warning/40 text-ink-primary'
                    : 'bg-warning/15 text-ink-primary outline-1 outline-dashed outline-warning/70',
                )}
              >
                {piece.text.slice(highlight.start, highlight.end)}
              </mark>
              {piece.text.slice(highlight.end)}
            </>
          ) : piece.text}
        </pre>
        </div>
      ) : (
        <p
          onMouseUp={onTextMouseUp}
          className={cn('fs-body text-ink-muted m-0', editable && 'cursor-text')}
        >
          {editable ? '点这里开始写…' : '（空）'}
        </p>
      )}

      {/* 「下集钩子」—— 大纲页常显，不折在折叠面板里（用户 2026-10-23 要求）。
          ⚠️ 它渲染在可编辑正文**之外**，见 Piece.hook 的说明：
          拼进 piece.text 就会被"失焦保存"当成 synopsis 写回去。
          ⚠️ 没有钩子时也**要显示**（空态提示），否则用户无从判断"AI 忘了写"
          还是"这功能不存在" —— 这正是这一项被提出来时的处境。 */}
      {kind === 'outline' && (
        <div className="mt-2 pl-3 border-l-2 border-primary/30 select-text">
          <div className="fs-meta text-ink-secondary mb-0.5">
            下集钩子
            {piece.hook?.type ? (
              <span className="text-ink-muted">
                {' · '}{piece.hook.type}
                {piece.hook.strength ? `（${piece.hook.strength}）` : ''}
              </span>
            ) : null}
          </div>
          {piece.hook?.leads_to ? (
            <div className="fs-body text-ink-primary">{piece.hook.leads_to}</div>
          ) : (
            <div className="fs-meta text-ink-muted">
              这集还没有钩子。用「补全」重新生成大纲，或让 Agent 单独补这一集的出口钩。
            </div>
          )}
        </div>
      )}
    </section>
  );
}


/**
 * 拖拽插入光标（2026-09-22 用户要求"标记要稍微醒目一些"）。
 *
 * 普通文本光标在一屏密密麻麻的正文里根本看不见，所以这里做了三件事：
 *   1. 2px 主色竖线（比系统光标粗一倍）
 *   2. 上下各一个旋转 45° 的小方块 —— 像"插入夹子"，一眼能定位
 *   3. 0.9s 闪烁，与静止的正文区分开
 *
 * 坐标来自 `caretRangeFromPoint`（相对正文块左上角），所以它落在两个字之间，
 * 而不是某一行的开头 —— 松手插在哪儿，它就显示在哪儿。
 */
function DropCaret({ x, y, h }: { x: number; y: number; h: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-20 animate-breathe"
      style={{ left: x, top: y, width: 2, height: h, background: 'rgb(var(--c-primary))' }}
    >
      <span
        className="absolute"
        style={{ top: -3, left: -3, width: 8, height: 8,
                 background: 'rgb(var(--c-primary))', transform: 'rotate(45deg)' }}
      />
      <span
        className="absolute"
        style={{ bottom: -3, left: -3, width: 8, height: 8,
                 background: 'rgb(var(--c-primary))', transform: 'rotate(45deg)' }}
      />
    </span>
  );
}

/**
 * 当前有没有"非空的、落在文稿区里的"选区。
 *
 * 这是 Delete / Ctrl+X 接管的**安全闸**：没有选区时按 Delete 必须什么都不发生
 * （绝不能把整集内容删掉）。放在模块级是为了让 keydown 那个 effect 不依赖
 * 任何组件状态、可以只注册一次。
 */
function selHasContent(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  if (!sel.toString().length) return false;
  const box = document.querySelector('[data-scroll-container="script-pane"]');
  if (!box) return false;
  const n = sel.getRangeAt(0).startContainer;
  const el = n.nodeType === 3 ? n.parentElement : (n as HTMLElement);
  return !!el && box.contains(el);
}

/**
 * 点击位置对应正文里的第几个字符。
 *
 * 没有它，"点击即编辑"会把光标一律丢到末尾 —— 用户点第 3 行想改第 3 行，
 * 结果光标在一万字之后，这比留着「编辑」按钮更糟。
 *
 * 两个 API 都要试：Chrome/Safari 是 `caretRangeFromPoint`，
 * Firefox 是 `caretPositionFromPoint`。都没有就返回 null（退回末尾）。
 */
function caretOffsetAt(el: HTMLElement, x: number, y: number): number | null {
  try {
    const doc = document as any;
    let range: Range | null = null;
    if (typeof doc.caretRangeFromPoint === 'function') {
      range = doc.caretRangeFromPoint(x, y);
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos?.offsetNode) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range || !el.contains(range.startContainer)) return null;
    // 从块首量到点击处，长度就是字符偏移
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length;
  } catch {
    return null; // 拿不到就退回末尾，不影响编辑本身
  }
}

/**
 * 标题是否是"只是重复了集号"的占位名。
 *
 * 生成侧没给出真标题时会填 `第1集` / `第 1 章` 这类占位，
 * 而本组件头部已经显示「第 N 章」—— 再显示一次就是 "第 1 章 第1集"。
 * 判据放宽到"去掉「第」与单位字之后只剩同一个数字"。
 */
function isPlaceholderTitle(title: string | undefined, order: number, unit: string): boolean {
  if (!title) return true;
  const t = title.replace(/\s/g, "");
  const norm = t.replace(/^第/, "").replace(new RegExp(`[${unit}集条章节]$`), "");
  return norm === String(order);
}

/**
 * 真正"什么都摆不出来"时的提示。
 *
 * ⚠️ 可编辑的产物（大纲/原文/剧本）走到这里只有一种情况：**这部剧连集数都没设**
 * （`episode_count` 为 0）。有集数就一定有 N 个空白块可点可写，
 * 不会再出现"还没有原文 —— 去左边让 AI 生成"那种**把用户挡在门外**的提示
 * （2026-09-21 用户明确否掉）。
 */
function EmptyHint({ kind, onPaste, onGenerate }:
  { kind: ProductKind; onPaste?: () => void; onGenerate?: () => void }) {
  const t = PRODUCT_TABS.find((x) => x.key === kind);
  const label = t?.label || '';
  if (t?.editable) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
        <p className="fs-ui text-ink-muted text-center leading-6 max-w-[320px]">
          这部剧还没设定集数，所以列不出分集。<br />
          直接把{label}粘进来就行 —— 会按集号自动切开并建集。
        </p>
        {onPaste && (
          <button
            type="button"
            onClick={onPaste}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded fs-ui bg-primary text-white hover:bg-primary-hover"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            粘贴{label}
          </button>
        )}
      </div>
    );
  }
  // 小说 / 推文：**空状态就是入口**（PLAN-v2收编与v1退役 §3.2）。
  // 改版前这里写的是"入口在工作台的「小说」页签"——那个地方在 v2 里**不存在**，
  // 等于把用户指到一堵墙上。现在点它 = 在对话里发出「生成小说」。
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-8">
      <p className="fs-ui text-ink-muted text-center leading-6 max-w-[300px]">
        这部剧还没有{label}版<br />
        它由现有正文逐章改写而来，不会改动原稿。
      </p>
      {onGenerate && (
        <button
          type="button"
          onClick={onGenerate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded fs-ui bg-primary text-white hover:bg-primary-hover"
        >
          <Sparkles className="w-3.5 h-3.5" />
          按现有正文改写
        </button>
      )}
    </div>
  );
}

/**
 * 一集的历史版本抽屉（2026-10-10 用户要求）。
 *
 * ## 为什么是抽屉不是弹窗
 * 用户看历史的目的通常是**对照**：这一版和现在这版差在哪、该不该切回去。
 * 弹窗会把正文盖住，逼他"关掉弹窗→回忆刚才看到的内容"，正好废掉对照的意义。
 * 抽屉从右侧滑出，正文留在左边，可以一边看一边比。
 *
 * ## 为什么要显示"谁改的"
 * `created_by` 区分 `ai_generate` / `user_edit` / `restore_old_version`，
 * 这是判断"这一版值不值得切回去"的主要依据 —— 用户手改的那版显然比
 * AI 又跑了一遍的那版更该保留。只显示时间的话，用户根本分不清。
 *
 * ## 数据形态的坑
 * 后端已经把各 stage **不一致的 content 结构**（storyboard 竟有 dict 与裸数组
 * 两种形态）归一成了 `text`。所以这里**只认 `text`**，不要再自己去读
 * `content` —— 那等于把后端刚吸收掉的历史包袱又搬回前端。
 */
function EpisodeHistoryPanel({
  draftId, order, unit, kind, currentText, onClose, onRestored,
}: {
  draftId: number;
  order: number;
  unit: string;
  /** 当前页签（outline/chapters/...）。用于把面板**默认**聚焦到这一阶段的
      历史，与块头上的"历史 N"角标口径一致（角标也是按页签过滤的）。
      ⚠️ 不要拿它去替代"全部阶段"视图 —— 精修会同时写 chapter 与 storyboard，
      用户需要能看到"这集到底被谁改过"，所以给了切换。 */
  kind: ProductKind;
  /** 这一集的**当前**正文，供对照区右侧显示。由父组件传入而不是自己再拉一次 ——
      父组件手里就是最新的（含未保存的编辑），再拉一次反而可能拿到旧值。 */
  currentText: string;
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}) {
  type HistItem = {
    id: number; stage: string; version: number; created_by: string;
    created_at: string | null; chars: number; preview: string;
  };
  const [items, setItems] = React.useState<HistItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  /** 正在左右对照的那一条 —— null 表示只看列表 */
  const [detail, setDetail] = React.useState<{ id: number; text: string; stage: string } | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  /** 只看当前阶段 / 看全部阶段。默认只当前阶段，与角标一致。 */
  const [scope, setScope] = React.useState<'this' | 'all'>('this');

  /** stage → 人话。与后端 TAB_TO_STAGE 的取值对应。 */
  const STAGE_LABEL: Record<string, string> = {
    outline: '大纲', chapter: '原文', storyboard: '剧本',
    novel: '小说', tweet: '推文',
  };
  /** 谁改的 → 人话。判断"这版值不值得切回去"的主要依据。 */
  const BY_LABEL: Record<string, string> = {
    // ⚠️ 这张表要照着**库里真实的取值**写全，不能只列"我以为会有的"那几个。
    // dev 库实测（SELECT stage, created_by, count(*) GROUP BY 1,2）出现过：
    //   ai_generate / ai_rewrite / ai_fix / critique / user_edit / e2e
    // 漏一个的后果是那一行直接显示成 `ai_rewrite` 这种机器码 ——
    // 用户看不懂，而这恰恰是他判断"这版值不值得切回去"的唯一线索。
    // e2e 是端到端测试写进去的脏数据（dev 独有），也一并给人话，免得像乱码。
    ai_generate: 'AI 生成',
    ai_rewrite: 'AI 精修',
    ai_fix: 'AI 修硬伤',
    ai_deai: 'AI 去AI味',
    critique: '体检/点评',
    user_edit: '手动编辑',
    restore_old_version: '回滚产生',
    e2e: '测试数据',
  };

  React.useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr(null); setDetail(null);
      try {
        // scope='this' 时带 kind 只取当前阶段；'all' 时不带，拿这一集的全部阶段。
        // 两条都走同一个端点，差别只在有没有这个查询参数 —— 后端对不传 kind
        // 的语义就是"全都要"（见 list_episode_history）。
        const q = scope === 'this' ? `?kind=${kind}` : '';
        const r = await authFetch(
          `${BASE}/v1/stages/drafts/${draftId}/episodes/${order}/history${q}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (alive) setItems(d?.items || []);
      } catch (e: any) {
        if (alive) setErr(e?.message || '读取历史失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [draftId, order, kind, scope]);

  async function openDetail(id: number) {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/history/${id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setDetail({ id, text: d?.text || '', stage: d?.stage || '' });
    } catch (e: any) {
      notifyError('打开这一版失败: ' + (e?.message || e));
    }
  }

  async function doRestore(id: number) {
    setRestoring(true);
    try {
      const r = await authFetch(
        `${BASE}/v1/stages/drafts/${draftId}/history/${id}/restore`, { method: 'POST' });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${msg.slice(0, 120)}`);
      }
      notifySuccess(`已切换回这一版（当前内容已存为历史，可再切回来）`);
      await onRestored();
    } catch (e: any) {
      notifyError('切换失败: ' + (e?.message || e));
    } finally {
      setRestoring(false);
    }
  }

  const fmt = (s: string | null) => {
    if (!s) return '';
    // 后端给的是 naive UTC（本仓一致口径），转成本地时间显示
    try {
      const d = new Date(s.endsWith('Z') ? s : s + 'Z');
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch { return s; }
  };

  return (
    <div className="flex-shrink-0 border-b border-line bg-surface-overlay/40 max-h-[52vh] overflow-y-auto">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line/60">
        <History className="w-3.5 h-3.5 text-primary" />
        <span className="fs-ui font-semibold text-ink-primary">
          第 {order} {unit} · 历史版本
        </span>
        <span className="fs-meta text-ink-muted">{items.length} 个版本（最多保留 10 个/阶段）</span>
        {/* 范围切换。默认"只看当前页签"，与块头角标同口径 ——
            角标说"历史 6"而面板里混着其它阶段的版本，用户会觉得数字对不上。
            但"全部阶段"不能砍掉：精修同时写 chapter 与 storyboard，
            用户排查"这集到底被谁改过"时需要跨阶段一眼看全。 */}
        <div className="flex items-center rounded border border-line overflow-hidden">
          {([['this', '只看本页签'], ['all', '全部阶段']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setScope(k)}
              className={cn('px-2 py-0.5 fs-meta',
                scope === k ? 'bg-primary/10 text-primary' : 'text-ink-muted hover:text-ink-primary')}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose}
                className="ml-auto p-1 rounded text-ink-muted hover:text-ink-primary"
                aria-label="关闭"><X className="w-3.5 h-3.5" /></button>
      </div>

      {loading ? (
        <div className="px-3 py-4 fs-ui text-ink-muted flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中…
        </div>
      ) : err ? (
        <div className="px-3 py-4 fs-ui text-danger">{err}</div>
      ) : items.length === 0 ? (
        <div className="px-3 py-4 fs-ui text-ink-muted">
          这一{unit}还没有历史版本 —— 重新生成、精修、手动编辑之后才会产生。
        </div>
      ) : (
        <div className="p-3 space-y-1.5">
          {items.map((it) => (
            <div key={it.id}
                 className={cn('rounded border px-2.5 py-1.5 fs-ui',
                   detail?.id === it.id
                     ? 'border-primary/60 bg-primary/5'
                     : 'border-line bg-surface-card')}>
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-surface-overlay fs-meta text-ink-secondary">
                  {STAGE_LABEL[it.stage] || it.stage}
                </span>
                <span className="fs-meta text-ink-muted tabular-nums">v{it.version}</span>
                <span className="fs-meta text-ink-muted">{BY_LABEL[it.created_by] || it.created_by}</span>
                <span className="fs-meta text-ink-muted tabular-nums">{it.chars} 字</span>
                <span className="fs-meta text-ink-muted ml-auto tabular-nums">{fmt(it.created_at)}</span>
                <button type="button"
                        onClick={() => void openDetail(it.id)}
                        className="text-ink-secondary hover:text-primary">
                  {detail?.id === it.id ? '收起' : '对照'}
                </button>
                <button type="button"
                        disabled={restoring}
                        onClick={() => void doRestore(it.id)}
                        className="text-primary hover:underline disabled:opacity-50"
                        title="把这一集切换回这个版本（当前内容会先存成一条新历史，可再切回来）">
                  切回这版
                </button>
              </div>
              <div className="mt-1 text-ink-muted fs-meta line-clamp-2 break-words">
                {it.preview || '（空）'}
              </div>

              {/* 对照区：左=这一版，右=当前正文。两栏而非并排滚动，是为了窄屏也不挤 */}
              {detail?.id === it.id && (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <div className="fs-meta text-ink-muted mb-1">这一版（{STAGE_LABEL[detail.stage] || detail.stage}）</div>
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words fs-body text-ink-secondary rounded border border-line bg-surface-base p-2">
                      {detail.text || '（空）'}
                    </pre>
                  </div>
                  <div>
                    <div className="fs-meta text-ink-muted mb-1">当前</div>
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words fs-body text-ink-primary rounded border border-line bg-surface-base p-2">
                      {currentText || '（空）'}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
