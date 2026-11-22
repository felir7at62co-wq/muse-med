'use client';
/**
 * 新版首页 —— 纯对话起点（PLAN-剧本平台全面升级 §4.5、效果图 133）
 *
 * ## 与旧首页的区别
 * 旧首页是「一条横幅 + 15 张功能卡 + 一张大草稿列表」——用户先要回答
 * "我要用哪个功能"，才能开始干活。
 *
 * 新首页只回答一件事：**你想写点什么。**
 *   - 中央一句问候 + 一个大输入框
 *   - 下面一行「怎么开始」的 Chip
 *   - 再下面一行「最近」
 *
 * ## 为什么 Chip 不做成功能卡
 * 功能卡是"点我去另一个页面"，Chip 是"告诉我你想怎么开始"。
 * 前者是导航，后者是**同一个起点的四种投喂方式** —— 这正是用户说的
 * "新建草稿/导入/反推是不是都可以分类为怎么开始"。
 *
 * 所以前三个 Chip 点下去**不跳页**，而是让输入框进入就绪态或打开对应弹窗；
 * 只有确实需要传文件/贴链接的（导入、批量、反推）才开弹窗，因为绕不开表单。
 *
 * ## 旧页面一行不动
 * 所有旧页面保持原路径，本页在 /v2/ 下。切换器见 components/VersionSwitcher.tsx。
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Download, Video, Upload, ArrowUp, ChevronDown, Loader2,
  Image as ImageIcon, AudioLines,
} from 'lucide-react';
import { UserNav } from '@/app/_UserNav';
import { AnnouncementBar } from '@/app/_AnnouncementBar';
import { authFetch } from '@/lib/auth';
import { useV2Href } from '@/components/VersionSwitcher';
import { ModelSelect } from '@/components/ModelSelect';
import { DraftCreateDrawer, type DraftCreatePayload } from '@/components/drafts/DraftCreateDrawer';
import { ImportScriptModal } from '@/app/drafts/_ImportScriptModal';
import { VideoUploadModal } from '@/app/drafts/_VideoUploadModal';
import { BatchUploadModal } from '@/app/drafts/_BatchUploadModal';
import { useToast } from '@/components/ui';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

/** 首页只显示最近几条 —— 完整列表在左栏树图里（见 §4.5.10 的三态设计） */
const RECENT_LIMIT = 6;

type DraftRow = {
  id: number;
  title: string;
  status?: string;
  cover_url?: string | null;
  updated_at?: string;
  chapter_count?: number;
  storyboard_count?: number;
  [k: string]: any;
};

type Starter = {
  key: string;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 点击后：填进输入框的引导文案（不跳页） */
  seed?: string;
  /** 或者打开某个弹窗 */
  modal?: 'import' | 'batch' | 'video';
};

/**
 * 「怎么开始」的四种投喂方式。
 *
 * 前两个是**输入框预设**（seed），点了不跳页、只是把输入框变成就绪态；
 * 后两个确实需要传文件/贴链接，绕不开表单，所以开弹窗。
 */
const STARTERS: Starter[] = [
  {
    key: 'idea',
    label: '从一句话开始',
    hint: '说清题材、集数、每集字数',
    icon: Sparkles,
    // ⚠️ 预置文本要把**集数与字数**一起带出来（2026-09-22 用户反馈）。
    // 不引导的话所有人都落到默认 30 集 / 900 字，之后才发现不对。
    seed: '写一个关于…的短剧，60 集，每集 900 字',
  },
  {
    key: 'import',
    label: '导入已有剧本',
    hint: '粘贴或上传，自动切分章节',
    icon: Download,
    modal: 'import',
  },
  {
    key: 'video',
    label: '视频反推',
    hint: '从成片反推出剧本',
    icon: Video,
    modal: 'video',
  },
  {
    key: 'batch',
    label: '批量导入文件',
    hint: '一次多个文件，各建一个草稿',
    icon: Upload,
    modal: 'batch',
  },
];

/**
 * 一级工具入口（生图 / 音频）。
 *
 * 它们本来在「更多工具」的下拉里，用户 2026-09-22 要求提权重 ——
 * 这两件事在实际流程里紧跟着剧本走（有了剧本就要配图配音），
 * 藏在二级菜单里等于让人每次多点一下。
 */
const SIDE_TOOLS: Array<[string, string, typeof ImageIcon]> = [
  ['生图', '/image-studio', ImageIcon],
  ['音频生成', '/audio-studio', AudioLines],
];

/** 时间：只显示相对时间，首页不需要精确到秒 */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export default function V2HomePage() {
  const router = useRouter();
  const toast = useToast();
  const draftHref = useV2Href('/drafts');

  const [drafts, setDrafts] = React.useState<DraftRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [idea, setIdea] = React.useState('');
  const [model, setModel] = React.useState('gemini');
  const [sel, setSel] = React.useState<Starter['modal'] | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  /** 正在建草稿（防连点重复建） */
  const [creating, setCreating] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  /** 草稿 id -> 有未读的产物流集合（PLAN §4.2）。红点只看"有没有"，不看条数。 */
  const [unread, setUnread] = React.useState<Record<number, string[]>>({});

  const fetchDrafts = React.useCallback(async () => {
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts?all=true`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      // ⚠️ 后端返回的是 `{items, total}`（router.py:283），**不是裸数组**。
      // 此前这里写 `Array.isArray(list) ? list : []` —— 兜底给了空数组，
      // 于是新版首页对**所有人**都显示"还没有草稿"，而且不报错、静默。
      // v1 列表页一直是对的（`data.items || []`），只有 v2 这两处漏了。
      setDrafts(Array.isArray(data) ? data : (data.items || []));
    } catch {
      // 取不到不阻塞首页 —— 输入框仍然可用，用户能直接开始写
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchDrafts();
  }, [fetchDrafts]);

  /**
   * 拉未读数（PLAN §4.2）。
   *
   * 单独一个 effect 而不是并进 fetchDrafts：未读是"附加信息"，
   * 拉失败不该影响草稿列表本身的渲染。
   *
   * ⚠ 只算有未读的流，值是 0/1 而不是条数 —— 用户无法处理"3 条未读"，
   * 他能做的就是"去看一眼"。红点是存在性标记。见 db/read_state.py。
   */
  React.useEffect(() => {
    if (drafts.length === 0) return;
    const ids = drafts.map((d) => d.id).join(',');
    void (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/drafts/unread?draft_ids=${ids}`);
        if (!r.ok) return;
        const data = await r.json();
        const map: Record<number, string[]> = {};
        for (const [k, v] of Object.entries(data?.items || {})) {
          map[Number(k)] = Object.keys(v as Record<string, number>);
        }
        setUnread(map);
      } catch { /* noop */ }
    })();
  }, [drafts]);

  function pick(s: Starter) {
    if (s.modal) {
      setSel(s.modal);
      return;
    }
    // 输入框预设：不跳页，只把输入框变成就绪态并聚焦
    setIdea(s.seed || '');
    document.getElementById('v2-composer')?.focus();
  }

  /**
   * 用户直接描述了想法 → 建一部草稿，**直接进新版工作台**。
   *
   * ⚠️ 2026-09-20 改：此前这里弹的是**旧的「新建草稿」抽屉**
   * （用户反馈："在对话框中输入问题会弹出旧的创建草稿的窗口"）。
   * 那个抽屉要用户先填标题/集数/字数才肯建 —— 而用户已经在输入框里
   * 把想法说清楚了，再让他填一张表是纯粹的重复劳动。
   *
   * 现在：拿这句话当概要直接建草稿（标题取前几个字），建完立刻进工作台，
   * 让用户在**对话里**把细节聊出来。这也正是新版首页的设计意图
   * （§4.5.2："一句话就够，AI 会扩"）。
   *
   * 想精细设置的用户仍有一处：下面的「更多工具 → 新建草稿」走原来的抽屉。
   */
  async function startFromIdea() {
    const text = idea.trim();
    if (!text) return;
    if (creating) return;
    setCreating(true);
    try {
      // 标题：取首句/前 24 字，去掉换行 —— 用户之后可随时改
      const title = text.split(/[\n。！？!?]/)[0].slice(0, 24) || '未命名';
      const res = await authFetch(`${BASE}/v1/stages/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          user_input: text,
          episode_count: 30,
          chapter_word_target: 900,
          model_provider: model,
        }),
      });
      if (!res.ok) throw new Error(`创建失败 (${res.status})`);
      const d = await res.json();
      if (d?.id) {
        // ⚠️ 用户打的第一句话**不只是标题** —— 它是对 AI 说的话（2026-09-21 反馈）。
        // 改版前它只被截成标题存进 user_input，然后用户落到一个空对话里，
        // 等于他刚说的需求没人接。这里把原话交给工作台，由对话栏当作第一条消息发出去。
        //
        // 走 sessionStorage 而不是 URL 参数：这段可能很长（文本域随便写），
        // 塞进地址栏又丑又有长度上限；而且它是**一次性**的，读完就删，刷新不会重发。
        try {
          sessionStorage.setItem('drama_v2_first_message',
            JSON.stringify({ draftId: d.id, text }));
        } catch { /* 隐私模式就退化成"只当标题"，与改版前一致 */ }
        router.push(`/v2/drafts/${d.id}`);
        return;
      }
      throw new Error('创建成功但没有返回草稿 id');
    } catch (e: any) {
      toast.error({ title: '创建失败', description: e?.message || String(e) });
      setCreating(false);
    }
  }

  async function onCreate(payload: DraftCreatePayload) {
    const res = await authFetch(`${BASE}/v1/stages/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, model_provider: model }),
    });
    if (!res.ok) throw new Error(`创建失败 (${res.status})`);
    const d = await res.json();
    toast.success({ title: '已创建', description: d?.title || '' });
    if (d?.id) router.push(`/v2/drafts/${d.id}?tab=outline`);
  }

  const recent = drafts.slice(0, RECENT_LIMIT);

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      <AnnouncementBar />

      {/* 顶栏：只放 logo 与用户区（含版本切换），刻意极简 */}
      <header className="flex items-center justify-between px-6 h-16">
        <div className="flex items-center gap-2 text-ink-primary">
          <span className="text-lg font-semibold tracking-wide">AI 剧本创作平台</span>
        </div>
        <UserNav />
      </header>

      <main className="max-w-2xl mx-auto px-6 pt-20 desktop:pt-28 pb-24">
        {/* 问候语 */}
        <h1 className="text-center text-3xl leading-10 font-semibold text-ink-primary mb-8 tracking-wide">
          今天想写点什么？
        </h1>

        {/* 输入框 */}
        <div className="rounded-2xl border border-line-strong bg-surface-card focus-within:border-primary/60 transition-colors">
          <textarea
            id="v2-composer"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              // Enter 直接开始，Shift+Enter 换行 —— 与主流对话产品一致
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                startFromIdea();
              }
            }}
            rows={3}
            placeholder={'描述你的故事 —— 说清题材、多少集、每集多少字\n例：都市复仇，女主是律师，60 集，每集 1500 字'}
            className="w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm leading-6 text-ink-primary placeholder:text-ink-muted outline-none"
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            <ModelSelect value={model} onChange={setModel} label={null} showHint={false} compact />
            <div className="flex-1" />
            {/* ⚠️ `creating` 这个 state 早就有，只是**从没接到按钮上** ——
                点下去之后按钮纹丝不动，用户不知道系统收到没有。
                接口本身只要 6ms（实测），但"有没有收到"这件事要在 0ms 就回答。 */}
            <button
              type="button"
              onClick={startFromIdea}
              disabled={creating || !idea.trim()}
              aria-label="开始创作"
              aria-busy={creating}
              title={creating ? '正在创建…' : '开始创作'}
              className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <ArrowUp className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* 怎么开始 */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {STARTERS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => pick(s)}
                title={s.hint}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-line bg-surface-card hover:border-primary/40 hover:bg-surface-card-hover transition-colors text-xs text-ink-secondary"
              >
                <Icon className="w-3.5 h-3.5 text-primary/70" />
                {s.label}
              </button>
            );
          })}
          {/* 生图 / 音频：用户 2026-09-22 要求提权重 ——
              从「更多工具」的下拉里拿出来，与「导入已有剧本」并列。
              它们跳的是独立工作室页面，不是输入框预设，所以样式上用同一种药丸、
              但图标色更淡一点，表示"离开这一页"。 */}
          {SIDE_TOOLS.map(([label, href, Icon]) => (
            <button
              key={href as string}
              type="button"
              onClick={() => router.push(href as string)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-line bg-surface-card hover:border-primary/40 hover:bg-surface-card-hover transition-colors text-xs text-ink-secondary"
            >
              <Icon className="w-3.5 h-3.5 text-ink-muted" />
              {label as string}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-ink-muted hover:text-ink-primary transition-colors"
          >
            更多工具
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* 更多工具：低频入口收在这里，不再平铺占首页 */}
        {moreOpen && (
          <div className="mt-3 flex flex-wrap gap-2">
            {/* 「精细新建」：输入框那条路是"说一句话就直接建、直接进工作台"，
                它会用默认集数/字数。要一次填清标题/集数/每章字数的用户走这里
                （就是原来的新建草稿抽屉）。这是**低频路径**，所以收进折叠区。 */}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="px-3 py-1.5 rounded-lg border border-line bg-surface-card text-xs text-ink-muted hover:text-ink-primary hover:border-line-strong transition-colors"
              title="逐个填写标题、集数、每章字数后再创建"
            >
              精细新建草稿
            </button>
            {/* ⚠️ 这里**必须写死 v1 路径**，不能写 `/v2/...`、也不能过 `useV2Href`。
                下面这 8 个页面**全部只有 v1 版**（/tools/prompt-converter、
                /image-studio…，`app/v2/` 下没有对应目录）。
                `useV2Href` 会把当前版本（默认就是新版）拼成 `/v2/...` ——
                结果与写死前缀**完全一样**，八个入口在新版下全是 404。
                只有等这些页面真的补齐 v2 版，这里才该换成版本感知的跳转。 */}
            {[
              // ⚠️ 生图 / 音频已提到一级入口（见下方 SIDE_TOOLS），这里不再重复。
              ['提示词速转', '/tools/prompt-converter'],
              ['超级 Agent', '/super-agent'],
              ['市场数据', '/market-data'],
              ['我的记忆', '/settings/memories'],
              ['回收站', '/trash'],
            ].map(([label, href]) => (
              <button
                key={href}
                type="button"
                onClick={() => router.push(href)}
                className="px-3 py-1.5 rounded-lg border border-line bg-surface-card text-xs text-ink-muted hover:text-ink-primary hover:border-line-strong transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* 最近 */}
        <div className="mt-12">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-ink-muted">最近</span>
            <button
              type="button"
              onClick={() => router.push(draftHref)}
              className="text-xs text-ink-muted hover:text-primary transition-colors"
            >
              全部草稿 →
            </button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-ink-muted py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
            </div>
          ) : recent.length === 0 ? (
            <p className="text-xs text-ink-muted py-4">还没有草稿 —— 在上面写一句就开始。</p>
          ) : (
            <div className="grid grid-cols-2 tablet:grid-cols-3 gap-2">
              {recent.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => router.push(`/v2/drafts/${d.id}`)}
                  className="text-left rounded-lg border border-line bg-surface-card hover:border-primary/40 transition-colors p-3 min-w-0"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-ink-primary truncate flex-1">
                      {d.title || '未命名'}
                    </span>
                    {unread[d.id]?.length > 0 && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-danger flex-shrink-0"
                        title={`未读：${unread[d.id].join(' · ')}`}
                      />
                    )}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-1 truncate">
                    {relTime(d.updated_at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* 弹窗：复用旧页面的组件，不重写（新版只改入口组织方式） */}

      {/* 「新建草稿」抽屉：输入框那条路已经改成直建 + 进工作台（见 startFromIdea），
          这个抽屉保留给**想精细设置**的用户（标题/集数/每章字数一次填清），
          入口在「更多工具」里。不做成主路径 —— 主路径是"说一句话就开始"。 */}
      <DraftCreateDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={onCreate}
      />
      <ImportScriptModal
        open={sel === 'import'}
        onClose={() => { setSel(null); void fetchDrafts(); }}
      />
      <BatchUploadModal
        open={sel === 'batch'}
        onClose={() => { setSel(null); void fetchDrafts(); }}
        onSuccess={() => { void fetchDrafts(); }}
      />
      <VideoUploadModal
        open={sel === 'video'}
        onClose={() => { setSel(null); void fetchDrafts(); }}
      />
    </div>
  );
}
