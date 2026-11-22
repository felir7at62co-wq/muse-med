'use client';
/**
 * 新版工作台 —— 三栏：左树图 / 中对话 / 右文稿（PLAN §4.5.7-§4.5.12）
 *
 * ## 这一页解决什么
 * 此前 `/v2/drafts/[id]` 只是 `import DraftDetailPage from '@/app/drafts/[id]/page'`
 * —— 渲染的是**同一个旧组件**，只是把卡片去掉了边框（"无界化"）。
 * 用户要的不是那个：他要的是一个**按方案重新设计的工作台**，
 * 在那里「聊着聊着就把稿子改了」。旧页面的问题是它按"产物类型"组织
 * （总览/大纲/原文/剧本/…14 个 tab），而实际干活的动作是
 * **定位某一集 → 聊 → 落到那一集**，三种动作横跨三个 tab。
 *
 * ## 三栏各管一件事
 *
 *   左 240px   定位：树图「幕 → 集」，挂状态点，可折叠
 *   中 flex    生成：AI 对话（动作栏 + 消息流 + 一键写入）
 *   右 flex    成品：可分页签编辑的最终文稿，可直接改、可一键替换
 *
 * 对应 §4.2 L3「空间即价值」：左"我要去哪"，中"让它干"，右"看结果"。
 *
 * ## 为什么不复用旧工作台组件
 * 旧页面 2272 行、35 个依赖，且状态互相缠绕（tab 切换 / 编辑态 / 弹窗）。
 * 直接搬过来就得再改一遍它，等于把"重构"做成"搬家 + 打补丁"。
 * 所以这一页是**新写的**，只复用**叶子组件**（FullTextEditor 的保存链、
 * 对话流的卡片、scriptText 的解析），不复用页面级的组织方式。
 *
 * ## 旧页面一行不动
 * `/drafts/[id]` 仍是旧工作台，用户随时可切回；`?embed=1` 等既有入口不受影响。
 */
import * as React from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, PanelLeftClose, PanelLeftOpen, Loader2, Rocket, RotateCcw, Type,
  Download, BookOpen, FileDiff,
} from 'lucide-react';
import { UserNav } from '@/app/_UserNav';
import { authFetch } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { confirmAsync, notifyError, notifySuccess } from '@/lib/dialog';
import { WorkbenchTree, type NavEpisode } from '@/components/workbench/WorkbenchTree';
import {
  ScriptPane, PRODUCT_TABS, type ProductKind,
} from '@/components/workbench/ScriptPane';
import { ChatColumn } from '@/components/workbench/ChatColumn';
import { DraftSettingsPanel } from '@/components/workbench/DraftSettingsPanel';
import { WorkbenchSkeleton } from '@/components/workbench/WorkbenchSkeleton';
import { TaskStatusBar } from '@/components/workbench/TaskStatusBar';
import RewriteDiff, { type DiffPayload } from '@/app/chat-studio/_RewriteDiff';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';
const TREE_KEY = 'workbench_v2_tree_collapsed';
const FS_KEY = 'workbench_v2_font_scale';
const FMT_KEY = 'workbench_v2_export_fmt';

/** 导出格式。默认 docx（用户 2026-09-22 裁定），txt/md 同样支持。 */
const FMTS: Array<'docx' | 'txt' | 'md'> = ['docx', 'txt', 'md'];

/**
 * 字号档位（用户 2026-09-21：右上角 5 挡，且"现在的字号有点偏小"）。
 *
 * 5 挡里**默认落在第 3 挡（1.15）**，而不是 1.0 —— 因为用户说现在偏小，
 * 默认值就该比现在大一点；同时仍留了一挡比现在小的（0.9）给想塞更多内容的人。
 * 乘子作用在 `--fs-scale` 上，由 globals.css 的 `.fs-body/.fs-ui/.fs-meta` 消费。
 */
const FS_STEPS = [
  { label: '小', scale: 0.9 },
  { label: '标准', scale: 1 },
  { label: '大', scale: 1.15 },
  { label: '更大', scale: 1.3 },
  { label: '最大', scale: 1.5 },
];
const FS_DEFAULT = 2;

export default function V2WorkbenchPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const draftId = Number(id);

  // 初始页签可由 URL 指定（从"更多工具"等处跳进来时带上）
  const initialKind = (searchParams.get('tab') as ProductKind) || 'chapters';

  const [draft, setDraft] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [kind, setKind] = React.useState<ProductKind>(
    PRODUCT_TABS.some((t) => t.key === initialKind) ? initialKind : 'chapters',
  );
  /** 当前聚焦的集号 —— 左树图点选、对话写入都作用于它 */
  const [focusOrder, setFocusOrder] = React.useState<number | null>(null);
  /** 左栏折叠（§4.2 L3：可折叠树图，把空间让给正文） */
  const [treeCollapsed, setTreeCollapsed] = React.useState(false);
  /** 字号档位下标 */
  const [fsIdx, setFsIdx] = React.useState(FS_DEFAULT);
  const [fsOpen, setFsOpen] = React.useState(false);
  /** 导出菜单 + 记住上次选的格式 */
  const [exportOpen, setExportOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [fmt, setFmt] = React.useState<'docx' | 'txt' | 'md'>('docx');

  /** 整本任务是否在跑（生成/重写是后台任务，前端只显示"已启动"） */
  const [busy, setBusy] = React.useState<null | 'gen' | 'rewrite'>(null);

  /** 精修/生成的「改前→改后」对照。由状态栏的"看改动"触发，按需拉取。
   *  ⚠️ 只在用户点开时拉一次 —— 几十万字的对照放进轮询会把浏览器拖死。 */
  const [jobDiff, setJobDiff] = React.useState<DiffPayload | null>(null);

  /** 右栏请求"生成小说/推文" —— 转交对话栏执行（见 ChatColumn.adaptRequest） */
  const [adaptRequest, setAdaptRequest] = React.useState<
    { kind: 'novel' | 'tweet'; nonce: number } | null>(null);

  /** 传给右栏的"外部插入"指令 */
  const [insert, setInsert] = React.useState<
    { order: number; text: string; nonce: number; mode: 'append' | 'replace' } | null
  >(null);
  const insertNonce = React.useRef(0);

  /**
   * 传给右栏的「定位并高亮」指令（2026-10-10）。
   *
   * 与上面 `insert` 同一套 nonce 模式：同一段文字连点两次也要能重新触发，
   * 所以带一个自增 nonce 而不是只传字符串（只传字符串时第二次点击值没变，
   * useEffect 不会重跑，用户会以为按钮失灵）。
   *
   * ⚠️ 刻意**不切页签** —— 用户是在"右边正看着哪个页签"的语境下划选的
   * （见计划里的决策 2）。找不到时由右栏明说"当前页签里没有"，而不是
   * 悄悄跳到另一个产物上高亮 —— 那会让人以为定位错了。
   */
  const [locate, setLocate] = React.useState<{ quote: string; nonce: number } | null>(null);
  const locateNonce = React.useRef(0);

  React.useEffect(() => {
    try {
      setTreeCollapsed(localStorage.getItem(TREE_KEY) === '1');
      // ⚠️ 必须先判 null 再 Number()：`Number(null)` 是 **0**，
      // 而 0 是合法档位下标 —— 直接 Number 会让"从没设置过"被当成"选了最小档"，
      // 于是默认字号反而比现在更小（2026-09-21 探针抓到）。
      const raw = localStorage.getItem(FS_KEY);
      if (raw != null && raw !== '') {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0 && n < FS_STEPS.length) setFsIdx(n);
      }
      const f = localStorage.getItem(FMT_KEY);
      if (f === 'docx' || f === 'txt' || f === 'md') setFmt(f);
    } catch { /* 隐私模式用默认值 */ }
  }, []);

  function changeFs(i: number) {
    setFsIdx(i);
    setFsOpen(false);
    try { localStorage.setItem(FS_KEY, String(i)); } catch { /* 不持久化也能用 */ }
  }

  function toggleTree() {
    setTreeCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(TREE_KEY, next ? '1' : '0'); } catch { /* 不持久化也能用 */ }
      return next;
    });
  }

  const fetchDraft = React.useCallback(async () => {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`);
      if (!r.ok) throw new Error(String(r.status));
      setDraft(await r.json());
    } catch {
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  React.useEffect(() => { void fetchDraft(); }, [fetchDraft]);

  /**
   * 拉一次「改前/改后」对照（精修覆写每集前都会存历史，/changes 就是拿它对比当前稿子）。
   * 只在用户点状态栏的"看改动"时调用一次 —— 不轮询。
   */
  const loadJobDiff = React.useCallback(async (jobId: number) => {
    try {
      const r = await authFetch(`${BASE}/v1/agent/jobs/${jobId}/changes`);
      if (!r.ok) {
        notifyError(`拿不到改动记录（HTTP ${r.status}）`);
        return;
      }
      const d = (await r.json()) as DiffPayload;
      if (!(d.items || []).length) {
        notifyError('这次任务没有留下可比对的改动记录');
        return;
      }
      setJobDiff(d);
    } catch (e: any) {
      notifyError('拿改动记录失败: ' + (e?.message || e));
    }
  }, []);

  /**
   * 树图数据 —— 取自大纲（比 chapters 全：正文只装已生成的集，
   * 还没开写的剧 chapters 为空，而那时恰恰最需要看到"一共有多少集"）。
   */
  const treeEpisodes: NavEpisode[] = React.useMemo(() => {
    const outlineEps = draft?.outline?.chapters || [];
    const chByOrder = new Map<number, any>();
    for (const c of draft?.chapters || []) chByOrder.set(c.chapter_order, c);
    return outlineEps.map((ep: any, i: number) => {
      const order = ep.order ?? i + 1;
      const ch = chByOrder.get(order);
      return {
        order,
        title: ep.title || ch?.title || '',
        hasOutline: true,
        hasChapter: !!ch,
        isStale: ch?.is_stale === 1,
        locked: !!ch?.locked,
      };
    });
  }, [draft?.outline?.chapters, draft?.chapters]);

  /**
   * 过期集数量（PLAN-v2收编与v1退役 §1.1）。
   *
   * ⚠️ **不加「只重生成过期集」按钮** —— 查证过：`regenerate-stale` 端点
   * 根本不生成任何东西（只返回一句"请使用批量生成功能重新生成"），
   * 而「补全全部」的定义本来就是"只补缺失/**已过期**的集"。
   * 所以这是文案问题不是功能缺失：把数量摆出来，让用户知道那个按钮已经管了这件事。
   */
  const staleCount = React.useMemo(
    () => treeEpisodes.filter((e) => e.isStale).length, [treeEpisodes]);

  /**
   * 「补全全部」打哪个端点 —— **必须跟着当前页签走**。
   *
   * ⚠️ 2026-09-22 线上真实故障：用户一部 109 集的剧，剧本只生成到第 73 集，
   * 在**剧本页**点「补全全部」毫无反应。原因是这里原本把端点**写死**成
   * `chapters/batch/start` —— 于是跑的是正文批量，109 集正文全都在，
   * 结果是"共 0 集生成完成, 109 集跳过"，剧本一集都没补。
   * 用户看到的就是"按钮点了没用"，而日志里一切正常。
   *
   * 小说/推文没有 batch/start 端点（改编走 /v1/adapt），所以在那两个页签上
   * 这个按钮不该假装能用 —— 置灰并指回对话里的生成菜单。
   */
  const batchTarget = React.useMemo(() => {
    if (kind === 'storyboards') return { path: 'storyboards', label: '剧本' };
    if (kind === 'novel') return { path: 'adapt', adaptKind: 'novel', label: '小说' };
    if (kind === 'tweet') return { path: 'adapt', adaptKind: 'tweet', label: '推文' };
    return { path: 'chapters', label: '正文' };
  }, [kind]);

  /**
   * 小说/推文的已有集号 —— 它们不在 `draft` 里（右栏自己另取 /v1/adapt/{kind}），
   * 顶栏要显示"还差多少集"就得自己拿一份。只在这两个页签上请求。
   */
  const [adaptDone, setAdaptDone] = React.useState<Set<number>>(new Set());
  React.useEffect(() => {
    const ak = (batchTarget as any)?.adaptKind;
    if (!ak) { setAdaptDone(new Set()); return; }
    let alive = true;
    (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/adapt/${ak}?draft_id=${draftId}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        setAdaptDone(new Set((d.items || [])
          .filter((it: any) => String(it.content || '').trim())
          .map((it: any) => Number(it.chapter_order))));
      } catch { /* 顶栏徽标而已，取不到就当 0，不打扰用户 */ }
    })();
    return () => { alive = false; };
  }, [batchTarget, draftId, draft?.updated_at]);

  /**
   * 当前目标还差多少集（缺失 + 过期）。
   *
   * 把这个数摆在按钮上，是为了让"点了没用"当场可解释：
   * 显示 0 就是真的没有要补的；显示 40 就该补 40 集。
   * 原来只显示 staleCount（且只算正文的过期集），在剧本缺 40 集时是 0，
   * 正好把最需要提示的情况显示成了"没事"。
   */
  const pendingCount = React.useMemo(() => {
    if (!batchTarget) return 0;
    const total = (draft?.outline?.chapters || []).length;
    if (!total) return 0;
    if (batchTarget.path === 'chapters') {
      const by = new Map<number, any>();
      for (const c of draft?.chapters || []) by.set(c.chapter_order, c);
      let n = 0;
      for (let o = 1; o <= total; o++) {
        const c = by.get(o);
        if (!c || !String(c.full_text || '').trim() || c.is_stale === 1) n += 1;
      }
      return n;
    }
    if (batchTarget.path === 'storyboards') {
      const by = new Map<number, any>();
      for (const sb of draft?.storyboards || []) by.set(sb.chapter_order, sb);
      let n = 0;
      for (let o = 1; o <= total; o++) {
        const sb = by.get(o);
        if (!sb || sb.is_stale === 1 || !((sb.shots_json || []).length)) n += 1;
      }
      return n;
    }
    // 小说/推文：改编是**从正文来的**，所以分母是"有正文的集"，
    // 不是大纲集数 —— 正文还没写的集根本无从改编，算进待补数只会让
    // 用户点了之后发现补不动。
    const withText: number[] = (draft?.chapters || [])
      .filter((c: any) => String(c.full_text || '').trim())
      .map((c: any) => Number(c.chapter_order));
    return withText.filter((o) => !adaptDone.has(o)).length;
  }, [draft, batchTarget, adaptDone]);

  /**
   * 点左树图的某一集：把焦点移过去，并让**右栏自己**滚到它。
   *
   * ⚠️ **不能用 `el.scrollIntoView()`**（2026-09-21 用户反馈的 bug 根源）：
   * 它会把该元素**所有能滚的祖先**一起滚到位，包括最外层
   * `h-screen overflow-hidden` 的根容器 —— `overflow:hidden` 只挡鼠标滚轮，
   * **挡不住脚本滚动**。于是整个三栏一起上移：中间的 AI 对话跟着"下滑"，
   * 滑到输入框都看不见的空白处，整栏没法用。
   *
   * 所以这里**只滚右栏那一个容器**：用 rect 差值算出目标位置，
   * 自己设 scrollTop，一个祖先都不碰。
   *
   * ⚠️ 两帧 rAF 再查 DOM：切集是 React 状态更新，
   * 同步查节点时新的 DOM 还没挂上（表现是"点了没反应"）。
   */
  function selectEpisode(order: number) {
    setFocusOrder(order);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-piece-order="${order}"]`);
        const box = el?.closest<HTMLElement>('[data-scroll-container="script-pane"]');
        if (!el || !box) return;
        const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTo({ top: box.scrollTop + delta, behavior: 'smooth' });
      });
    });
  }

  /**
   * 改总集数。
   *
   * ⚠️ **调小是有代价的**：右栏是按"预设集数"把空白集摆出来的，调小之后
   * 超出的集不再出现在列表里。已经写了内容的集不会丢（padToPreset 取
   * `max(预设集数, 现有最大集号)`），但**空的**那些会消失 —— 所以调小时要问一句。
   */
  /**
   * 导出（PLAN-v2收编与v1退役 §5）。
   *
   * ## 为什么按「当前页签」导
   * v2 已经用 `kind` 表达"你在看哪一份稿子"——导出复用同一个语义，
   * 用户不用再选一次"导哪个"。在大纲页点就是导大纲，在原文页点就是导正文。
   *
   * ## 小说/推文走另一条
   * `/v1/adapt/{kind}/export/{fmt}` 三种格式本来就齐全，
   * 不为了"统一"去重写一个已经好用的东西。
   *
   * ## ⚠️ 2026-10-07 修：大纲页签曾导出成正文
   * 这里原本写的是 `kind === 'outline' ? 'chapters' : kind` —— 因为那时后端
   * 统一导出端点**根本没有 outline 这一档**。于是用户在大纲页点「导出当前这份
   * （大纲）」，拿到的文件是**正文**。现在后端已支持 `kind=outline`，这个静默
   * 映射必须去掉：它把"后端不支持"伪装成了"导出成功"。
   */
  async function doExport(scope: 'all' | number) {
    setExportOpen(false);
    await download(
      (kind === 'novel' || kind === 'tweet')
        ? `${BASE}/v1/adapt/${kind}/export/${fmt}?draft_id=${draftId}`
        : `${BASE}/v1/stages/drafts/${draftId}/export`
          + `?kind=${kind}&scope=${scope}&fmt=${fmt}`,
    );
  }

  /** 正文+剧本合并导出（后端 kind=mixed，只支持整本） */
  async function doExportMixed() {
    setExportOpen(false);
    await download(`${BASE}/v1/stages/drafts/${draftId}/export?kind=mixed&scope=all&fmt=${fmt}`);
  }

  /**
   * 下载一个受鉴权保护的文件。
   *
   * ⚠️ 不能直接用 `<a href>`：鉴权是 Authorization 头，`<a>` 带不上，
   * 点下去只会拿到 401。所以走 authFetch 取 blob 再触发下载。
   * 文件名以后端 Content-Disposition 为准（它已经做了 UTF-8 编码）。
   */
  async function download(url: string) {
    try {
      const r = await authFetch(url);
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${t.slice(0, 120)}`);
      }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      a.download = m ? decodeURIComponent(m[1]) : `${draft?.title || '草稿'}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e: any) {
      notifyError('导出失败: ' + (e?.message || e));
    }
  }

  function changeFmt(f: 'docx' | 'txt' | 'md') {
    setFmt(f);
    try { localStorage.setItem(FMT_KEY, f); } catch { /* 不持久化也能用 */ }
  }

  /**
   * 改每集目标字数（`chapter_word_target`）。
   *
   * ⚠️ 2026-10-21 补：v2 收编 v1 时**漏了这个入口**——建草稿时能设，之后再也改不了，
   * 而 v1 工作台一直有。用户反馈"创建了草稿似乎就没法修改字数设定了"。
   *
   * 它只影响**正文 / 小说 / 推文**三份产物；大纲和剧本不由这个字段控制。
   * 后端 PATCH 会顺手把未锁定的章节和剧本标成过期，所以这里必须说清：
   * 已有内容不会立刻变，要让 `补全` 重新生成才会按新字数写。
   */
  async function changeWordTarget() {
    const cur = Number(draft?.chapter_word_target) || 900;
    const input = window.prompt(
      `每集目标字数（当前 ${cur} 字）\n\n`
      + `影响正文、小说、推文的生成。常见档位：900 / 1500 / 3000 / 5000`,
      String(cur));
    if (input === null) return;
    const n = Number(String(input).trim());
    if (!Number.isInteger(n) || n < 1 || n > 20000) {
      notifyError('请填 1–20000 之间的整数');
      return;
    }
    if (n === cur) return;
    if (!window.confirm(
      `把每集目标字数从 ${cur} 改成 ${n} 字吗？\n\n`
      + `· 已写好的正文不会立刻变，下一次生成/补全时才按 ${n} 字写\n`
      + `· 现有正文和剧本会被标为过期，用顶栏「补全」可以让它们按新字数重写\n`
      + `· 已经手动锁定或导入的章节不会被自动改写`)) return;

    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapter_word_target: n }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      notifySuccess(`每集目标字数已改为 ${n} 字，现有正文已标为过期`);
      void fetchDraft();
    } catch (e: any) {
      notifyError('改字数失败: ' + (e?.message || e));
    }
  }

  async function changeEpisodeCount() {    const cur = Number(draft?.episode_count) || 0;
    const input = window.prompt(`这部剧一共多少集？（当前 ${cur} 集）`, String(cur || 30));
    if (input === null) return;
    const n = Number(String(input).trim());
    if (!Number.isInteger(n) || n < 1 || n > 2000) {
      notifyError('请填 1–2000 之间的整数');
      return;
    }
    if (n === cur) return;
    if (n < cur && !window.confirm(
      `要把总集数从 ${cur} 改成 ${n} 吗？\n\n`
      + `已经写了内容的集不会丢；超出的**空白集**会从列表里消失。`)) return;

    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode_count: n }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      notifySuccess(`总集数已改为 ${n} 集`);
      void fetchDraft();
    } catch (e: any) {
      notifyError('改集数失败: ' + (e?.message || e));
      return;
    }

    // ── 改大 = 续写（PLAN-v2收编与v1退役 §4）──
    // 用户心里想的是"我要把这剧从 109 集写到 129 集"，不是"执行一次 extend 作业"。
    // 所以把续写挂在**他本来就要改的那个数字**上，入口数不增加。
    if (n > cur && cur > 0) {
      const add = n - cur;
      if (!window.confirm(
        `多出的 ${add} 集（第 ${cur + 1}–${n} 集）要现在让 AI 续写大纲吗？\n\n`
        + `· 只续大纲，不写正文 —— 正文是最贵的一步，等你看过大纲确认方向再说\n`
        + `· 不要的话先空着，你可以自己写或用「粘贴识别」贴一份进来`)) return;
      try {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/extend/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // outline_only 后端默认就是 true（只扩写大纲），这里显式写出来表明意图
          body: JSON.stringify({ target_episode_count: n, outline_only: true }),
        });
        if (r.status === 409) {
          notifyError('已有任务在跑，等它完成再续写');
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        notifySuccess(
          `已开始续写第 ${cur + 1}–${n} 集的大纲；正文还没写，`
          + `确认方向没问题后用顶栏「补全全部」。`);
        void fetchDraft();
      } catch (e: any) {
        notifyError('续写启动失败: ' + (e?.message || e));
      }
    }
  }

  /**
   * 2026-10-09：生成剧本前的风险探测（零 LLM，一次轻请求）。
   *
   * 返回 null 表示"探测不到"（网络/接口异常）—— 那种情况下**不拦用户**：
   * 探测失败就当作没风险，绝不因为一个辅助提示而挡住正常操作。
   */
  async function checkOutlineRisk(): Promise<{ thin: number; avg: number } | null> {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/density`);
      if (!r.ok) return null;
      const d = await r.json();
      return { thin: d?.counts?.thin ?? 0, avg: d?.avg_synopsis ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * 整本操作（PLAN §4.5.11 原则一：整本的操作归顶部工具条，不散在每一集上）。
   *
   * 这两个都是**后台任务**：HTTP 立即返回，进度由 ProgressBanner 之外的地方看不到，
   * 所以这里只负责"启动 + 告诉用户已启动 + 拉起刷新"，
   * 不假装自己能显示进度（详见下面 fetchDraft 的轮询）。
   */
  async function startBatch(force: boolean) {
    if (!batchTarget) return;
    // 🔴 2026-10-09：生成**剧本**前的软闸门。
    //
    // 用户提问：「导入的大纲信息量过少，导致生成剧本时 AI 还是会胡乱编造」。
    // 实测 51 字梗概 → 4423 字剧本（87 倍）。编造无法完全避免，但可以让它
    // 发生在用户**看得见、改得动**的地方 —— 也就是这里，而不是生成完之后。
    //
    // ⚠️ 只对剧本页签、且**只在"补全缺失"时**拦（force 重写是用户明确的决定，不拦）；
    // ⚠️ 只用 warning 级确认，**不阻断** —— 用户说"直接写"就照写，
    //    我们只负责让他知情，不替他决定。
    if (!force && batchTarget.path === 'storyboards') {
      const risk = await checkOutlineRisk();
      if (risk && risk.thin > 0) {
        const go = await confirmAsync({
          title: '大纲信息量偏低，确认直接生成剧本？',
          description:
            `有 ${risk.thin} 集的大纲只有很短的梗概（平均 ${risk.avg} 字/集）。\n\n` +
            `直接生成剧本时，这些集里会有相当一部分情节由 AI 自行补写 —— ` +
            `补出来的内容不在你的大纲里，可能需要成段重写。\n\n` +
            `建议先去「大纲」页点「补全本集大纲」：补出来的是场景节拍，` +
            `你能逐条看、逐条改，改好了再生成。\n\n` +
            `［继续直接生成］即按现状写。`,
          confirmText: '继续直接生成',
          cancelText: '我先去补大纲',
          tone: 'warning',
        });
        if (!go) {
          // 用户选择先去补大纲 —— 把他送到大纲页，而不是留在这里
          router.push(`/drafts/${draftId}/outline`);
          return;
        }
      }
    }
    setBusy(force ? 'rewrite' : 'gen');
    try {
      const ak = (batchTarget as any).adaptKind as string | undefined;

      // 小说/推文走改编接口（它们没有 batch/start）。
      // ⚠️ 语义要与正文/剧本的按钮**一致**：
      //   补全   → only_missing=true，已有的集一次模型调用都不花
      //   强制重写 → only_missing=false，整本重生
      // 不对齐的话"补全"会把已写好的小说全部覆盖重来，正好与按钮名相反。
      const r = ak
        ? await authFetch(`${BASE}/v1/adapt/${ak}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft_id: draftId, only_missing: !force }),
          })
        : await authFetch(
            `${BASE}/v1/stages/drafts/${draftId}/${batchTarget.path}/batch/start${force ? '?force_regenerate=true' : ''}`,
            { method: 'POST' },
          );
      if (r.status === 409) {
        // ⚠️ 2026-10-22：以前这里写死一句"已有生成任务在跑"，把后端 409 的
        // **真实原因**吞掉了。后端现在会回具体在跑什么（正文批量 12/50、某人的
        // 精修作业、Agent 会话还在跑……），照着它说用户才知道该等还是该停。
        // 旧文案还会把用户引向"联系管理员重置" —— 而多数情况根本不是卡死。
        const d = await r.json().catch(() => null);
        const detail = typeof d?.detail === 'string' ? d.detail
          : (d?.detail?.message || '');
        notifyError(detail || '已有生成任务在跑，等它完成再试；长期没有进展请看顶部状态栏');
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      notifySuccess(force
        ? `已启动：强制重写全部${batchTarget.label}`
        : `已启动：补齐缺失的${batchTarget.label}（本次待补 ${pendingCount} 集）`);
      void fetchDraft();
    } catch (e: any) {
      notifyError('启动失败: ' + (e?.message || e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * 对话里点「写入第 N 集」→ 把文本交给右栏。
   *
   * mode: 'append' 追加（默认，与 §4.5.8 的"落下即插入到该集末尾"一致）
   *       'replace' 覆盖（用户明确要替换整集时）
   */
  function writeToEpisode(order: number, text: string, mode: 'append' | 'replace' = 'append') {
    insertNonce.current += 1;
    setInsert({ order, text, nonce: insertNonce.current, mode });
    setFocusOrder(order);
    // 切到能看见这次写入的页签：有 .shots 结构时用剧本，否则原文
    setKind((k) => (k === 'chapters' || k === 'storyboards' ? k : 'chapters'));
  }

  /**
   * 对话框里划选一段文字 → 在右栏当前页签里定位并高亮。
   *
   * 用 useCallback 稳住引用：右栏的定位 effect 依赖这个函数，若每次渲染都换新的
   * 引用，effect 会反复重跑 —— 表现是"高亮闪一下又回到第一处"。
   */
  const locateInPane = React.useCallback((quote: string) => {
    const q = (quote || '').trim();
    if (!q) return;
    locateNonce.current += 1;
    setLocate({ quote: q, nonce: locateNonce.current });
  }, []);

  // 页面已挂载、客户端还在取数的那一小段（实测冷 7ms / 热 134ms）。
  // ⚠️ 与 loading.tsx 共用**同一个骨架**：两处若一个骨架一个菊花，
  // 用户会看到"骨架 → 转圈 → 内容"的三段跳，比原来的硬切还乱。
  if (loading) {
    return <WorkbenchSkeleton />;
  }

  if (!draft) {
    return (
      <div className="min-h-screen bg-surface-base flex flex-col items-center justify-center gap-3 text-ink-primary">
        <p className="text-lg">草稿不存在或无权访问</p>
        <button
          onClick={() => router.push('/v2/drafts')}
          className="px-4 py-2 rounded-lg bg-primary text-white text-sm hover:bg-primary-hover"
        >
          返回列表
        </button>
      </div>
    );
  }

  return (
    <div
      /* --fs-scale 只影响 .fs-body/.fs-ui/.fs-meta 这三个类的字号（见 globals.css），
         不动栏宽与间距 —— 调字号不该把整页布局一起放大。 */
      style={{ '--fs-scale': FS_STEPS[fsIdx].scale } as React.CSSProperties}
      className="relative h-screen overflow-hidden flex flex-col bg-surface-base text-ink-primary"
    >
      {/* 顶栏：返回 + 标题 + 折叠 + 用户 */}
      <header className="h-14 flex items-center gap-3 px-3 border-b border-line flex-shrink-0">
        <button
          onClick={() => router.push('/v2/drafts')}
          className="p-1.5 rounded hover:bg-surface-overlay text-ink-muted hover:text-ink-primary"
          aria-label="返回草稿列表"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={toggleTree}
          className="p-1.5 rounded hover:bg-surface-overlay text-ink-muted hover:text-ink-primary"
          title={treeCollapsed ? '展开树图' : '折叠树图'}
          aria-label={treeCollapsed ? '展开树图' : '折叠树图'}
        >
          {treeCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        <span className="fs-ui font-semibold truncate max-w-[40%]">{draft.title || '未命名'}</span>
        {/* 总集数可改 —— 2026-09-21 之前建完就定死了（后端 PatchDraftIn 里
            根本没有这个字段），用户想把 30 集改成 60 集只能重新建一部剧。 */}
        <button
          type="button"
          onClick={() => void changeEpisodeCount()}
          className="fs-meta text-ink-muted tabular-nums hover:text-ink-primary underline decoration-dotted underline-offset-4"
          title="改总集数"
        >
          共 {draft.episode_count || 0} 集
        </button>
        {/* 每集目标字数也可改 —— 与上面的总集数同样属于"建完就定死"的设定，
            v1 有、v2 收编时漏了（2026-10-21 用户反馈）。只影响正文/小说/推文。 */}
        <button
          type="button"
          onClick={() => void changeWordTarget()}
          className="fs-meta text-ink-muted tabular-nums hover:text-ink-primary underline decoration-dotted underline-offset-4"
          title="改每集目标字数（影响正文、小说、推文）"
        >
          每集 {draft.chapter_word_target || 900} 字
        </button>
        <div className="flex-1" />

        {/* 整本工具条（§4.5.11 原则一）—— 影响"整本"的动作只在这里出现一次，
            不散落到每一集上（那正是旧工作台"一屏上百个按钮"的成因）。 */}
        <button
          type="button"
          onClick={() => void startBatch(false)}
          disabled={busy !== null || pendingCount === 0}
          className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay disabled:opacity-50"
          title={pendingCount === 0
            ? `${batchTarget.label}已经齐了，没有要补的集`
            : `补齐缺失/已过期的${batchTarget.label}：当前差 ${pendingCount} 集，已有且没过期的跳过`}
        >
          {busy === 'gen' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
          {`补全${batchTarget.label}`}
          {pendingCount > 0 && (
            <span
              className="ml-0.5 px-1 rounded fs-meta bg-warning/15 text-warning tabular-nums"
              aria-label={`还差 ${pendingCount} 集`}
            >
              {pendingCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!window.confirm(
              `强制重写全部：把这部下的${batchTarget.label}全部重写一遍（包括导入时自动标记为"已锁定"的集）。\n\n` +
              '这会产生大量模型调用，且现有内容会被覆盖（每集保留历史版本，可回滚）。确定继续？')) return;
            void startBatch(true);
          }}
          disabled={busy !== null}
          className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-secondary hover:text-danger hover:bg-surface-overlay disabled:opacity-50"
          title={`把这部下的${batchTarget.label}全部重写一遍（含导入的原文），跑完前可在上方状态栏看到进度`}
        >
          {busy === 'rewrite' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          强制重写
        </button>

        {/* 导出（PLAN-v2收编与v1退役 §5）——整本操作归顶栏，一个按钮一个菜单。
            v2 此前**完全没有导出**，用户写完了拿不出去。 */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
            title="导出稿件"
            aria-expanded={exportOpen}
          >
            <Download className="w-3.5 h-3.5" />
            导出
          </button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-40 w-56 rounded-lg border border-line bg-surface-elevated shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => void doExport('all')}
                  className="block w-full text-left px-3 py-1.5 fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
                >
                  导出当前这份（{PRODUCT_TABS.find((t) => t.key === kind)?.label || '正文'}）
                </button>
                {kind !== 'novel' && kind !== 'tweet' && (
                  <button
                    type="button"
                    onClick={() => void doExportMixed()}
                    className="block w-full text-left px-3 py-1.5 fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
                  >
                    正文 + 剧本 合并
                  </button>
                )}
                <div className="my-1 border-t border-line" />
                <div className="px-3 py-1 fs-meta text-ink-muted">格式</div>
                <div className="flex items-center gap-1 px-3 pb-1.5">
                  {FMTS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => changeFmt(f)}
                      className={cn(
                        'px-2 py-0.5 rounded fs-meta border',
                        f === fmt
                          ? 'border-primary/50 text-primary'
                          : 'border-line text-ink-muted hover:text-ink-primary',
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 「设定」—— 世界观、角色卡、账本摘要（PLAN-v2收编与v1退役，2026-09-22 用户要求）。
            数据来源：outline.world + outline.characters + state_ledger + chapters[].must_have。
            纯读显示，零新端点。 */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
            aria-expanded={settingsOpen}
            title="查看世界观、角色卡、账本、爽点/契约"
          >
            <BookOpen className="w-3.5 h-3.5" />
            设定
          </button>
          {settingsOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
              <DraftSettingsPanel
                draft={draft}
                draftId={draftId}
                onClose={() => setSettingsOpen(false)}
                onRefreshed={() => void fetchDraft()}
              />
            </>
          )}
        </div>

        {/* 字号档位（用户 2026-09-21 要求，放页面右上角）。
            5 挡、当前挡打勾、菜单项本身按对应字号显示 —— 这样不用试也知道选了会多大。 */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setFsOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded fs-ui text-ink-muted hover:text-ink-primary hover:bg-surface-overlay"
            title={`界面字号：${FS_STEPS[fsIdx].label}`}
            aria-label="调整字号"
            aria-expanded={fsOpen}
          >
            <Type className="w-3.5 h-3.5" />
            {FS_STEPS[fsIdx].label}
          </button>
          {fsOpen && (
            <>
              {/* 点空白关掉 —— 不加这层，菜单只能靠再点按钮关，很容易留在屏上 */}
              <div className="fixed inset-0 z-30" onClick={() => setFsOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-40 w-36 rounded-lg border border-line bg-surface-elevated shadow-lg py-1">
                {FS_STEPS.map((s, i) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => changeFs(i)}
                    style={{ fontSize: `${Math.round(12 * s.scale)}px` }}
                    className={cn(
                      'flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-surface-overlay',
                      i === fsIdx ? 'text-primary' : 'text-ink-secondary',
                    )}
                  >
                    <span className="w-3 flex-shrink-0">{i === fsIdx ? '✓' : ''}</span>
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <UserNav />
      </header>

      {/* 常驻任务状态栏 —— 顶栏之下、三栏之上。
          ⚠️ 必须是根 flex 列的直接子元素且带 flex-shrink-0：这样它占一条固定高度、
          把剩余高度让给下面的三栏，既不用改 header 的 h-14，也不用动三栏的 flex-1。
          ⚠️ 它是**常驻**的，不随内容滚动 —— 根容器是 h-screen overflow-hidden，
          天然如此（页面里那段"别用 scrollIntoView"的注释正是这条的性质说明）。
          组件在完全空闲时会自己 return null，所以不占版面。 */}
      <TaskStatusBar
        draftId={draftId}
        onFinished={() => void fetchDraft()}
        /* 「跑完看改动」：复用对话工坊那份对照组件，不另造一个。
           精修覆写每集前都会往 script_episode_history 存一条，/jobs/{id}/changes
           就是拿它和当前稿子做左右并排 —— 这正是"结果链接"该指向的东西。 */
        onViewChanges={(jobId) => void loadJobDiff(jobId)}
      />

      {/* 三栏 */}
      <div className="flex-1 flex min-h-0">
        {/* 左：树图 */}
        {!treeCollapsed && (
          <aside className="w-60 flex-shrink-0 border-r border-line overflow-y-auto py-2">
            <WorkbenchTree
              episodes={treeEpisodes}
              focusOrder={focusOrder}
              onPick={selectEpisode}
            />
          </aside>
        )}

        {/* 中：对话
            ⚠️ `min-h-0` 不能省：flex 列容器里的项默认 `min-height:auto`，
            即"不许压到比内容还矮"。省掉它，内层的 overflow-y-auto 会被撑成
            内容高度，**滚动条永远不出现**，溢出的部分只能靠滚祖先看到。 */}
        <div className="flex-1 min-w-0 min-h-0 border-r border-line flex flex-col overflow-hidden">
          <ChatColumn
            draftId={draftId}
            draftTitle={draft.title}
            episodeCount={treeEpisodes.length}
            /* 右栏在看哪一页 —— AI 据此决定"第N集"指的是哪份稿子 */
            kind={kind}
            onWriteToEpisode={writeToEpisode}
            onLocate={locateInPane}
            onDraftChanged={() => void fetchDraft()}
            adaptRequest={adaptRequest}
            onAdaptRequestDone={() => setAdaptRequest(null)}
          />
        </div>

        {/* 右：文稿（同上，min-h-0 是右栏能上下滚的前提） */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <ScriptPane
            draftId={draftId}
            kind={kind}
            onKindChange={setKind}
            /* 预设集数：让还没生成的集也能点开就写。
               取 episode_count 为主，大纲已有的集数兜底（旧草稿可能没写 episode_count）。 */
            episodeCount={Number(draft.episode_count) || treeEpisodes.length || 0}
            externalInsert={insert}
            onExternalInsertDone={() => setInsert(null)}
            locate={locate}
            onChanged={() => void fetchDraft()}
            /* 小说/推文空状态的「按现有正文改写」→ 交给对话栏发一条生成消息，
               与生成菜单里那两项**完全同一条路**（不另开接口、不另起交互） */
            onGenerateAdapt={(k) => setAdaptRequest({ kind: k, nonce: Date.now() })}
          />
        </div>
      </div>

      {/* 「看改动」对照浮层 —— 复用对话工坊那份左右并排的对照组件，不另造一个。
          做成整屏浮层而不是塞进右栏：对照动辄几十万字，挤在栏里没法看。 */}
      {jobDiff && (
        <div className="absolute inset-0 z-50 bg-surface-base/95 backdrop-blur-sm flex flex-col">
          <div className="h-12 flex items-center gap-3 px-4 border-b border-line flex-shrink-0">
            <FileDiff className="w-4 h-4 text-primary" />
            <span className="fs-ui font-semibold">这次任务改了什么</span>
            <span className="fs-meta text-ink-muted">
              作业 #{jobDiff.job_id}
              {jobDiff.result?.scope_label ? ` · ${jobDiff.result.scope_label}` : ''}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setJobDiff(null)}
              className="px-2 py-1 rounded border border-line text-ink-secondary hover:text-ink-primary fs-ui"
            >
              关闭
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            <RewriteDiff data={jobDiff} />
          </div>
        </div>
      )}
    </div>
  );
}
