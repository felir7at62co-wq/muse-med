'use client';
/**
 * 草稿产物面板 —— 对话工坊右侧「我正在写的那份东西」（PLAN §4.5.7 / B11）
 *
 * ## 它取代了什么
 * 此前右栏是一个 `<iframe src="/jubengongfang/drafts/{id}?embed=1">` —— 把**整个工作台**塞进来，
 * 于是用户拿到的是总览、预览、分析、生图、提示词、导出……一整套后台，
 * 而他此刻想看的只是"我正在写的这份东西"。用户原话：
 * "现在的对话工坊右半侧只是粗暴的把页面塞了进去。"
 *
 * ## 四个页签是怎么定的
 * 它们不是"挑几个 tab 塞过来"，而是**确实存在的四种产物**（各自有表、各自可生成）：
 *
 *   | 页签 | 数据来源 | 可编辑 |
 *   |---|---|---|
 *   | 原文 | `script_chapters.full_text` | 只读（编辑在生成链路里，见下） |
 *   | 剧本 | `script_storyboards.shots_json` | ✅ 走 FullTextEditor |
 *   | 小说 | `chapter_adaptations(kind=novel)` | 只读 |
 *   | 推文 | `chapter_adaptations(kind=tweet)` | 只读 |
 *
 * ## ⚠️ 为什么原文/小说/推文是只读的
 * 「剧本」走 `FullTextEditor` 是因为它有**一整条已存在的回写链路**
 * （全文 → 解析成 shots → `PUT /storyboards/batch`），且格式是结构化的。
 * 另外三种没有等价的回写接口：原文的编辑在生成/精修链路里，
 * 小说/推文的编辑走 `/v1/adapt/{kind}/{order}` 逐章 PATCH。
 *
 * 与其在这里造一个"看着能编辑、保存却悄悄失败"的输入框，
 * 不如明确只读 + 给一个跳去工作台对应 tab 的出口（右上角那个按钮）。
 * **能编辑的给编辑，不能的给明确的出口** —— 这比假装能编辑诚实。
 *
 * ## 为什么不用 iframe 了
 * iframe 是"把旧页面塞进来"的权宜之计，它带来三件事：
 *   1. 样式不统一（iframe 里是另一套滚动条/断点判定）；
 *   2. 滚动嵌套（页面内滚动 + 内容区滚动，滚轮行为错乱）；
 *   3. **无法与左栏交互** —— 这条最要命：PLAN §4.5.8 的"选中文本拖进某一集"
 *      要求左右两侧在同一个文档里，跨 iframe 拖拽做不到。
 * 所以右栏改组件直挂是那条交互的**前置条件**，不是可选优化。
 */
import * as React from 'react';
import { Loader2, ExternalLink, RefreshCw, X } from 'lucide-react';
import { authFetch } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { FullTextEditor } from '@/app/drafts/[id]/_FullTextEditor';
import { type Shot } from '@/lib/scriptText';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type SB = { chapter_order: number; shots_json?: Shot[] | null };

type ProductKind = 'chapters' | 'storyboards' | 'novel' | 'tweet';

const TABS: { key: ProductKind; label: string; unit: string }[] = [
  { key: 'chapters', label: '原文', unit: '章' },
  { key: 'storyboards', label: '剧本', unit: '集' },
  { key: 'novel', label: '小说', unit: '章' },
  { key: 'tweet', label: '推文', unit: '章' },
];

/** 一集/一章的只读内容 */
type Piece = { order: number; title: string; text: string };

export type DraftProductPaneProps = {
  draftId: number;
  /** 草稿标题（头部展示） */
  draftTitle?: string;
  /** 外部说"数据变了，重拉"时 +1。用于替代原 iframe 的 postMessage 回执。 */
  refreshKey?: number;
  /** 关闭分屏。原先这个按钮在外层头部，现在头部归本组件，所以要传进来。 */
  onClose?: () => void;
};

export function DraftProductPane({
  draftId,
  draftTitle,
  refreshKey = 0,
  onClose,
}: DraftProductPaneProps) {
  const [kind, setKind] = React.useState<ProductKind>('storyboards');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pieces, setPieces] = React.useState<Piece[]>([]);
  const [storyboards, setStoryboards] = React.useState<SB[]>([]);
  /** 每集的字数，用于只读页签的列表视图 */
  const [busy, setBusy] = React.useState(false);

  /**
   * 拉取当前页签的产物。
   *
   * ⚠️ 四个页签的数据源**完全不同**（两张表 + 一个按 kind 过滤的接口），
   * 所以这里按 kind 分支，而不是"拉一份统一数据再裁"。
   * 统一数据听起来更优雅，但那需要后端新开一个聚合接口 ——
   * 而它每次都会把四种产物全查一遍，用户只看其中一个。
   */
  const load = React.useCallback(async () => {
    if (!draftId) return;
    setLoading(true);
    setError(null);
    try {
      if (kind === 'storyboards') {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/storyboards`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const list: SB[] = Array.isArray(data) ? data : (data.items || []);
        setStoryboards(list);
        setPieces([]);
        return;
      }

      if (kind === 'chapters') {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/chapters`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.items || []);
        setPieces(list.map((c: any) => ({
          order: c.chapter_order ?? c.order ?? 0,
          title: c.title || `第 ${c.chapter_order ?? c.order ?? 0} 章`,
          text: c.full_text || c.content || '',
        })));
        setStoryboards([]);
        return;
      }

      // novel / tweet —— 同一个接口按 kind 过滤
      const r = await authFetch(`${BASE}/v1/adapt/${kind}?draft_id=${draftId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const items = data?.items || [];
      setPieces(items.map((a: any) => ({
        order: a.chapter_order,
        title: `第 ${a.chapter_order} ${kind === 'novel' ? '章' : '条'}`,
        text: a.content || '',
      })));
      setStoryboards([]);
    } catch (e: any) {
      setError(e?.message || '加载失败');
      setPieces([]);
      setStoryboards([]);
    } finally {
      setLoading(false);
    }
  }, [draftId, kind]);

  React.useEffect(() => { void load(); }, [load, refreshKey]);

  const unit = TABS.find((t) => t.key === kind)?.unit || '集';
  const count = kind === 'storyboards' ? storyboards.length : pieces.length;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-surface-base">
      {/* 头部：标题 + 页签 + 出口 */}
      <div className="px-3 py-2 border-b border-line flex items-center gap-2 text-xs bg-surface-base/60">
        <span className="font-semibold truncate text-ink-primary" title={draftTitle}>
          #{draftId} {draftTitle || ''}
        </span>
        <span className="text-ink-muted flex-shrink-0 tabular-nums">
          {count > 0 ? `${count} ${unit}` : ''}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="p-1 rounded hover:bg-surface-overlay text-ink-muted hover:text-ink-primary disabled:opacity-50 transition-colors"
          title="重新拉取"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
        {/* 只读页签的出口：要改原文/小说/推文就去工作台对应 tab。
            ⚠️ 这里**不**做"能编辑"的假象 —— 见文件顶部注释。 */}
        <a
          href={`/jubengongfang/drafts/${draftId}?tab=${kind}`}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded hover:bg-surface-overlay text-ink-muted hover:text-ink-primary transition-colors"
          title="在新窗口打开工作台对应页签"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-overlay text-ink-muted hover:text-ink-primary transition-colors"
            title="关闭分屏"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 页签 */}
      <div className="flex border-b border-line text-xs flex-shrink-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setKind(t.key)}
            className={cn(
              'flex-1 py-2 transition-colors',
              kind === t.key
                ? 'bg-surface-overlay border-b-2 border-primary text-ink-primary font-medium'
                : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay/50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {loading && count === 0 ? (
          <div className="flex-1 flex items-center justify-center text-ink-muted text-xs">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载中…
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-ink-muted p-4 text-center">
            <span className="text-danger">加载失败：{error}</span>
            <button type="button" onClick={() => void load()} className="px-2 py-1 rounded bg-surface-overlay hover:bg-surface-raised">
              重试
            </button>
          </div>
        ) : count === 0 ? (
          <EmptyHint kind={kind} />
        ) : kind === 'storyboards' ? (
          /* 剧本：唯一可编辑的一种 —— 复用已存在的全文编辑器与它的回写链路 */
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <FullTextEditor
              draftId={draftId}
              storyboards={storyboards}
              onSaved={() => void load()}
            />
          </div>
        ) : (
          <ReadOnlyList pieces={pieces} />
        )}
      </div>
    </div>
  );
}

/**
 * 只读产物列表。
 *
 * 刻意**不**用 textarea + 保存按钮：那会让人以为能改，
 * 而保存要么没有对应接口、要么得逐章 PATCH（那是工作台的事）。
 * 用可滚动的纯文本块 + 明确的分集边界，一眼看出"这是产物，不是编辑器"。
 */
function ReadOnlyList({ pieces }: { pieces: Piece[] }) {
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4">
      {pieces.map((p) => (
        <div key={p.order}>
          <div className="text-[11px] text-ink-muted mb-1 flex items-center gap-2">
            <span className="font-medium text-ink-secondary">{p.title}</span>
            <span className="tabular-nums">{p.text.length} 字</span>
          </div>
          <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-ink-primary font-sans">
            {p.text || '（空）'}
          </pre>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ kind }: { kind: ProductKind }) {
  const label = TABS.find((t) => t.key === kind)?.label || '';
  const hint =
    kind === 'storyboards'
      ? '还没有剧本 —— 在左侧对话里点「生成剧本」，或去工作台生成。'
      : kind === 'chapters'
        ? '还没有原文 —— 在左侧对话里点「生成正文」，或去工作台生成。'
        : `还没有${label} —— 它由「改编」生成，入口在工作台的${label}页签。`;
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <p className="text-xs text-ink-muted text-center leading-6">{hint}</p>
    </div>
  );
}
