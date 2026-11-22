'use client';
/**
 * 新版草稿列表（/v2/drafts）—— 「全部草稿」的落点
 *
 * ## 它在新版里的位置
 * 新版首页只显示「最近 6 条」，完整列表收在这里（PLAN §4.5 的三态设计：
 * 首页=最近一行条 / 左栏=树图 / 全量=本页）。
 *
 * ## 与旧版列表页的区别
 * 旧版 /drafts 同时承担"首页"和"列表页"两个角色，所以顶着一条 15 张卡的功能横幅。
 * 新版的"开始"已经在首页完成了，所以本页**只做列表** —— 顶部只有标题和筛选，
 * 没有功能入口卡。这也是"极简"的体现：一个页面只做一件事。
 *
 * ## 组件全部复用，不重写
 * DraftCard / FilterBar 等直接取自 components/drafts，避免两套实现分叉。
 * 新版改的是**页面的组织方式**，不是组件本身。
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ArrowLeft } from 'lucide-react';
import { UserNav } from '@/app/_UserNav';
import { AnnouncementBar } from '@/app/_AnnouncementBar';
import { authFetch } from '@/lib/auth';
import { Button, EmptyState, SkeletonCard, useToast, useConfirm } from '@/components/ui';
import { DraftCard } from '@/components/drafts/DraftCard';
import { FilterBar } from '@/components/drafts/FilterBar';
import { DraftCreateDrawer, type DraftCreatePayload } from '@/components/drafts/DraftCreateDrawer';
import { TagsEditor } from '@/app/drafts/_TagsSidebar';
import type { DraftRow, Tag } from '@/components/drafts/types';
import type { DraftStatusFilter, DraftSort, ViewMode } from '@/components/drafts/FilterBar';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export default function V2DraftListPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [drafts, setDrafts] = React.useState<DraftRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<DraftStatusFilter>('all');
  const [sort, setSort] = React.useState<DraftSort>('updated_desc');
  const [tagsMap, setTagsMap] = React.useState<Record<number, Tag[]>>({});
  const tagsLoadedRef = React.useRef(false);
  const [tagEditorId, setTagEditorId] = React.useState<number | null>(null);
  /**
   * 视图模式。**默认网格**（用户 2026-09-20 的诉求就是"多行多列"）。
   *
   * ⚠️ 上一轮我做错了：网格功能做出来了，但默认是 `list`，而切换开关是
   * FilterBar 里一个**只有图标没有文字**的小按钮 —— 用户打开看到的仍是列表，
   * 等于没做。教训：**新做出来的视图要问一句"用户不点任何东西会看到什么"**，
   * 不能因为它"存在"就算交付。
   *
   * 选择会记进 localStorage：用户手动切到列表后，下次回来还是列表
   * （否则每次都要重新切，等于把默认值变成了唯一的可能）。
   */
  const VIEW_KEY = 'drama_drafts_view_mode';
  const [view, setView] = React.useState<ViewMode>('grid');
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'grid' || v === 'list') setView(v);
    } catch { /* 隐私模式读不到就用默认网格 */ }
  }, []);
  function changeView(v: ViewMode) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* 存不进去只是不持久化 */ }
  }
  const [createOpen, setCreateOpen] = React.useState(false);

  const fetchDrafts = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts?all=true`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      // ⚠️ 后端返回 `{items, total}`，不是裸数组。兜底给空数组会让整页
      // 对所有人显示"还没有草稿"，且不报错 —— 见 v2/page.tsx 同处的说明。
      const list: DraftRow[] = Array.isArray(data) ? data : (data.items || []);
      setDrafts(list);
      // 标签：首次加载时批量拉取，避免每次刷新都打一轮请求。
      if (!tagsLoadedRef.current && list.length > 0) {
        tagsLoadedRef.current = true;
        const entries = await Promise.all(
          list.map(async (d) => {
            try {
              const r = await authFetch(`${BASE}/v1/drafts/${d.id}/tags`);
              const t = r.ok ? await r.json() : [];
              return [d.id, Array.isArray(t) ? t : (t.items || [])] as [number, Tag[]];
            } catch { return [d.id, []] as [number, Tag[]]; }
          })
        );
        setTagsMap(Object.fromEntries(entries));
      }
    } catch (e) {
      toast.error({ title: '加载失败', description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void fetchDrafts();
  }, [fetchDrafts]);

  /** 搜索 + 状态筛选 + 排序，本地做（数据量不大，省一次往返） */
  const filtered = React.useMemo(() => {
    let list = drafts.slice();
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (d) =>
          (d.title || '').toLowerCase().includes(q) ||
          (d.user_input || '').toLowerCase().includes(q),
      );
    }
    if (statusFilter === 'favorite') list = list.filter((d) => d.is_favorite);
    else if (statusFilter !== 'all') list = list.filter((d) => d.status === statusFilter);

    if (sort === 'created_desc') {
      list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    } else if (sort === 'title_asc') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
    } else {
      list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    }
    return list;
  }, [drafts, search, statusFilter, sort]);

  async function onCreate(payload: DraftCreatePayload) {
    const res = await authFetch(`${BASE}/v1/stages/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`创建失败 (${res.status})`);
    const d = await res.json();
    if (d?.id) router.push(`/v2/drafts/${d.id}?tab=outline`);
  }

  async function onToggleFavorite(id: number) {
    await authFetch(`${BASE}/v1/stages/drafts/${id}/favorite`, { method: 'POST' });
    void fetchDrafts();
  }

  async function onRename(id: number, title: string) {
    await authFetch(`${BASE}/v1/stages/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    void fetchDrafts();
  }

  async function onResetStatus(id: number) {
    await authFetch(`${BASE}/v1/stages/drafts/${id}/reset-status`, { method: 'POST' });
    void fetchDrafts();
  }

  async function onDelete(d: DraftRow) {
    const ok = await confirm({
      title: `移入回收站：${d.title || '未命名'}？`,
      description: '可在「回收站」恢复，30 天后自动清理。',
      confirmText: '移入回收站',
    });
    if (!ok) return;
    await authFetch(`${BASE}/v1/stages/drafts/${d.id}/trash`, { method: 'POST' });
    toast.success({ title: '已移入回收站' });
    void fetchDrafts();
  }

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      <AnnouncementBar />

      <header className="flex items-center justify-between px-6 h-16">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/v2')}
            className="text-ink-muted hover:text-ink-primary transition-colors"
            aria-label="返回首页"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-base font-semibold">全部草稿</span>
          <span className="text-xs text-ink-muted">{filtered.length} / {drafts.length}</span>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            新建
          </Button>
          <UserNav />
        </div>
      </header>

      {/* ⚠️ 不留左右留白（用户 2026-09-20："不要在左右两侧留空间"）。
          原先这里是 `max-w-[1200px] mx-auto px-6` —— 宽屏下两侧各空一大块，
          而草稿列表是"越多越好看"的东西：把宽度吃满才能一屏放下更多。
          只保留一点内边距（px-3）避免卡片贴着窗口边缘。 */}
      <main className="w-full px-3 pb-24">
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          status={statusFilter}
          onStatusChange={setStatusFilter}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={changeView}
          filteredCount={filtered.length}
          totalCount={drafts.length}
        />

        <div className="mt-4">
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={search || statusFilter !== 'all' ? '没有匹配的草稿' : '还没有草稿'}
              description={
                search || statusFilter !== 'all'
                  ? '试试清空筛选或换个关键词'
                  : '回到首页，写一句就能开始'
              }
              primaryAction={
                <Button onClick={() => router.push('/v2')}>回首页开始</Button>
              }
            />
          ) : (
            /* 密集网格：卡片约 120px 宽（面积约为原 390px 卡的 1/10）。
               列数按断点给足，宽屏一屏能扫到几十部剧 —— 这是"全部草稿"
               这一页存在的意义：找得到、扫得快。
               小卡不带底部按钮，操作仍在列表视图里（同一页可切换）。 */
            <div
              className={
                view === 'grid'
                  ? 'grid gap-2 grid-cols-3 tablet:grid-cols-4 desktop:grid-cols-6 wide:grid-cols-8'
                  : 'space-y-2'
              }
            >
              {filtered.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  tags={tagsMap[d.id] || []}
                  compact={view === 'grid'}
                  onToggleFavorite={() => void onToggleFavorite(d.id)}
                  onRename={() => {
                    const next = window.prompt('重命名草稿', d.title || '');
                    if (next && next.trim()) void onRename(d.id, next.trim());
                  }}
                  onEditTags={() => setTagEditorId(d.id)}
                  onResetStatus={() => void onResetStatus(d.id)}
                  onDelete={() => void onDelete(d)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <DraftCreateDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={onCreate}
      />

      {tagEditorId != null && (
        <TagsEditor
          draftId={tagEditorId}
          onClose={() => setTagEditorId(null)}
          onSaved={() => {
            setTagEditorId(null);
            tagsLoadedRef.current = false;
            void fetchDrafts();
          }}
        />
      )}
    </div>
  );
}
