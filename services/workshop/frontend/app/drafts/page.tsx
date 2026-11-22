'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ImportScriptModal } from './_ImportScriptModal';
import { BatchCreateModal } from './_BatchCreateModal';
import { VideoUploadModal } from './_VideoUploadModal';
// ⛔ 2026-09-18 入口审计：自动打磨(polish)已停用(验证后完全没有可用性)。
//    组件在本文件已不挂载(见下方 [STOPPED] 段)。恢复时取消本行注释。
// import { PolishModal, PolishJobsPanel } from './_PolishModal';
import { ExportModal, ExportJobsPanel } from './_ExportModal';
import { TagsSidebar, TagsEditor } from './_TagsSidebar';
import { UserNav } from '../_UserNav';
import { AnnouncementBar } from '../_AnnouncementBar';
import { authFetch } from '../../lib/auth';

import { AppShell } from '@/components/layout/AppShell';
import {
  Button,
  EmptyState,
  SkeletonCard,
  useToast,
  useConfirm,
} from '@/components/ui';
import {
  DraftCard,
  QuickActionGrid,
  OverviewPanel,
  FilterBar,
  DraftCreateDrawer,
  type DraftCreatePayload,
} from '@/components/drafts';
import {
  computeStats,
  mapDraftStatus,
  type DraftRow,
  type Tag,
} from '@/components/drafts/types';
import type {
  DraftStatusFilter,
  DraftSort,
  ViewMode,
} from '@/components/drafts/FilterBar';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

/**
 * /drafts —— Phase 2 重构版（PLAN §5 + 01 号图）
 *
 * 视觉与交互全面重写，业务接口保留 (兼容旧后端):
 *  - GET    /v1/stages/drafts                  列表
 *  - POST   /v1/stages/drafts                  新建
 *  - PATCH  /v1/stages/drafts/:id              改名
 *  - POST   /v1/stages/drafts/:id/trash        移入回收站
 *  - POST   /v1/stages/drafts/:id/favorite     收藏切换
 *  - POST   /v1/stages/drafts/:id/reset-status 状态重置
 *  - GET    /v1/drafts/:id/tags                列出标签
 */
export default function DraftsPage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();

  const [drafts, setDrafts] = React.useState<DraftRow[]>([]);
  const [tagsMap, setTagsMap] = React.useState<Record<number, Tag[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [view, setView] = React.useState<ViewMode>('grid');
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<DraftStatusFilter>('all');
  const [sort, setSort] = React.useState<DraftSort>('updated_desc');
  const [dateFrom, setDateFrom] = React.useState('');  // 创建时间段起 (yyyy-mm-dd), 独立筛选条件
  const [dateTo, setDateTo] = React.useState('');      // 创建时间段止
  const [minStoryboards, setMinStoryboards] = React.useState(''); // 只看剧本集数≥N; 空=不限
  const [onlyPolishedClean, setOnlyPolishedClean] = React.useState(false); // 只看最近一次打磨硬伤数=0
  const [selectedTagId, setSelectedTagId] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const [createOpen, setCreateOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [batchOpen, setBatchOpen] = React.useState(false);
  const [videoOpen, setVideoOpen] = React.useState(false);
  const [polishOpen, setPolishOpen] = React.useState(false);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [tagEditorId, setTagEditorId] = React.useState<number | null>(null);

  const [renamingId, setRenamingId] = React.useState<number | null>(null);
  const [renameValue, setRenameValue] = React.useState('');

  // 增量渲染(A 方案, 无外部依赖): 全量数据留在内存(搜索/筛选仍是全量),
  // 但 DOM 只渲染前 visibleCount 张卡, 滚到底部哨兵自动 +PAGE。
  // 这样上万条草稿也不会一次性渲染上万个卡片节点把浏览器卡死。
  const PAGE = 60;
  const [visibleCount, setVisibleCount] = React.useState(PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    fetchDrafts();
    // 轮询间隔从 5s 放宽到 20s: 草稿全量(可能数百上千条)每次刷新开销不小,
    // 5s 太激进会造成列表页持续卡顿。20s 足够感知生成进度变化。
    const t = setInterval(fetchDrafts, 20000);
    return () => clearInterval(t);
  }, []);

  // 标签只在首次加载拉一次, 后续轮询不再重复拉 (标签很少变动);
  // 用 ref 防止轮询时反复发起 N 条 /tags 请求拖慢页面。
  const tagsLoadedRef = React.useRef(false);

  async function fetchDrafts() {
    try {
      // all=true: 后端忽略分页返回全部草稿, 避免默认 50 条截断
      // (管理员看全站全部 / 用户草稿过万也不丢)。
      const res = await authFetch(`${BASE}/v1/stages/drafts?all=true`);
      if (!res.ok) return;
      const data = await res.json();
      const list: DraftRow[] = Array.isArray(data) ? data : data.items || [];
      setDrafts(list);
      // 标签仅首次加载拉取一次, 避免每 20s 对数百条草稿各发一个 /tags 请求。
      if (!tagsLoadedRef.current) {
        tagsLoadedRef.current = true;
        const map: Record<number, Tag[]> = {};
        await Promise.all(
          list.map(async (d) => {
            try {
              const r = await authFetch(`${BASE}/v1/drafts/${d.id}/tags`);
              if (r.ok) map[d.id] = await r.json();
            } catch {
              /* noop */
            }
          }),
        );
        setTagsMap(map);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  /* ───── 创建草稿 ───── */
  async function handleCreate(payload: DraftCreatePayload) {
    const res = await authFetch(`${BASE}/v1/stages/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    const draft = await res.json();
    setCreateOpen(false);
    toast.success('草稿已创建，进入大纲生成');
    router.push(`/drafts/${draft.id}?tab=preview`);
  }

  /* ───── 单条操作 ───── */
  async function toggleFavorite(id: number) {
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${id}/favorite`, { method: 'POST' });
      await fetchDrafts();
    } catch {
      toast.error('收藏切换失败');
    }
  }

  async function deleteDraft(d: DraftRow) {
    const ok = await confirm({
      title: `移入回收站：${d.title || '未命名'}？`,
      description: '可在「回收站」恢复，30 天后自动清理。',
      tone: 'danger',
      confirmText: '移入回收站',
    });
    if (!ok) return;
    try {
      await authFetch(`${BASE}/v1/drafts/${d.id}/trash`, { method: 'POST' });
      toast.success('已移入回收站');
      await fetchDrafts();
    } catch {
      toast.error('删除失败');
    }
  }

  async function batchDelete() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `批量移入回收站：${selected.size} 个草稿？`,
      description: '可在「回收站」逐个恢复。',
      tone: 'danger',
      confirmText: `移入 ${selected.size} 个`,
    });
    if (!ok) return;
    let succ = 0;
    for (const id of selected) {
      try {
        const r = await authFetch(`${BASE}/v1/drafts/${id}/trash`, { method: 'POST' });
        if (r.ok) succ++;
      } catch {
        /* noop */
      }
    }
    setSelected(new Set());
    toast.success(`已移入回收站 (${succ}/${selected.size})`);
    await fetchDrafts();
  }

  // 批量「全量剧情分析」: 为每个选中草稿触发总览页的完整分析+打分(scope=full)
  async function batchAnalyze() {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `全量剧情分析：${selected.size} 个草稿？`,
      description: '将为每个草稿运行总览页的完整分析与打分(综合分/钩子/风险/诊断报告)，耗时与费用随集数增加。',
      confirmText: `开始分析 ${selected.size} 个`,
    });
    if (!ok) return;
    let succ = 0;
    for (const id of selected) {
      try {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${id}/analysis/start`, { method: 'POST' });
        if (r.ok) succ++;
      } catch {
        /* noop */
      }
    }
    toast.success(
      `已为 ${succ}/${selected.size} 个草稿启动全量分析。分析在后台进行，进度请到各草稿的「总览」页查看；分析中的草稿会显示「分析中」角标。`,
    );
    // 立即刷新列表, 让卡片上的"分析中"角标尽快出现
    await fetchDrafts();
  }

  async function rename(id: number, newTitle: string) {
    const t = newTitle.trim();
    if (!t) {
      toast.warning('标题不能为空');
      return;
    }
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      setRenamingId(null);
      toast.success('已重命名');
      await fetchDrafts();
    } catch {
      toast.error('重命名失败');
    }
  }

  async function resetStatus(id: number) {
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${id}/reset-status`, { method: 'POST' });
      toast.success('状态已重置');
      await fetchDrafts();
    } catch {
      toast.error('重置失败');
    }
  }

  /* ───── 过滤 + 排序 ───── */
  const filtered = React.useMemo(() => {
    let list = drafts.slice();
    // 收藏置顶（独立排序前提）
    list.sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.title?.toLowerCase().includes(q) || d.user_input?.toLowerCase().includes(q),
      );
    }
    if (statusFilter !== 'all') {
      list = list.filter((d) => {
        const m = mapDraftStatus(d.status);
        if (statusFilter === 'running') return m === 'generating';
        if (statusFilter === 'done') return m === 'completed';
        if (statusFilter === 'draft') return m === 'ideating' || m === 'not_started';
        if (statusFilter === 'favorite') return !!d.is_favorite;
        return true;
      });
    }
    if (selectedTagId !== null) {
      list = list.filter((d) => (tagsMap[d.id] || []).some((t) => t.id === selectedTagId));
    }
    // 创建时间段筛选 (独立条件, 与排序叠加): dateFrom/dateTo 为 yyyy-mm-dd 本地日期
    if (dateFrom) {
      const fromTs = new Date(`${dateFrom}T00:00:00`).getTime();
      list = list.filter((d) => new Date(d.created_at).getTime() >= fromTs);
    }
    if (dateTo) {
      const toTs = new Date(`${dateTo}T23:59:59.999`).getTime();
      list = list.filter((d) => new Date(d.created_at).getTime() <= toTs);
    }
    // 剧本集数筛选 (独立条件): 只看已生成剧本(storyboard)集数 >= minStoryboards 的草稿
    const minSb = parseInt(minStoryboards, 10);
    if (Number.isFinite(minSb) && minSb > 0) {
      list = list.filter((d) => (d.storyboard_count || 0) >= minSb);
    }
    // 打磨0硬伤筛选 (独立条件, 与其它 AND 叠加): 只看最近一次打磨 p0_left === 0 的草稿
    if (onlyPolishedClean) {
      list = list.filter((d) => d.last_polish_p0 === 0);
    }
    // sort
    if (sort === 'created_desc') {
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sort === 'title_asc') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
    } else if (sort === 'score_desc') {
      // 评分从高到低: 有分的在前(降序), 无分的沉底
      list.sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1));
    } else {
      list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }
    // 收藏始终在前
    list.sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0));
    return list;
  }, [drafts, search, statusFilter, sort, selectedTagId, tagsMap, dateFrom, dateTo, minStoryboards, onlyPolishedClean]);

  const stats = React.useMemo(() => computeStats(drafts), [drafts]);

  // 筛选/搜索/排序变化时, 渲染窗口重置回第一页
  React.useEffect(() => {
    setVisibleCount(PAGE);
  }, [search, statusFilter, sort, selectedTagId, view, dateFrom, dateTo, minStoryboards, onlyPolishedClean]);

  // 当前实际渲染的卡片(全量数据的前 visibleCount 个), 滚到底部再加载下一批
  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // 底部哨兵进入视口 → 自动加载下一页(无限滚动)
  React.useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + PAGE, filtered.length));
        }
      },
      { rootMargin: '600px' }, // 提前 600px 预加载, 滚动更顺滑
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, filtered.length]);

  /* ───── 渲染 ───── */
  return (
    <AppShell
      announcement={<AnnouncementBar />}
      sidebar={{
        extra: (
          <TagsSidebar selectedTagId={selectedTagId} onSelect={setSelectedTagId} />
        ),
      }}
      topBar={{
        left: <h1 className="text-section-title text-ink-primary">草稿</h1>,
        right: (
          <div className="flex items-center gap-2">
            <UserNav />
          </div>
        ),
      }}
    >
      <div className="flex flex-col gap-6">
        {/* 创作概览 */}
        <OverviewPanel stats={stats} />

        {/* 8 卡入口 */}
        <QuickActionGrid
          onNew={() => setCreateOpen(true)}
          onImport={() => setImportOpen(true)}
          onBatchUpload={() => setBatchOpen(true)}
          onVideoUpload={() => setVideoOpen(true)}
        />

        {/* 筛选栏 */}
        <FilterBar
          search={search}
          onSearchChange={setSearch}
          status={statusFilter}
          onStatusChange={setStatusFilter}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={setView}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          minStoryboards={minStoryboards}
          onMinStoryboardsChange={setMinStoryboards}
          onlyPolishedClean={onlyPolishedClean}
          onOnlyPolishedCleanChange={setOnlyPolishedClean}
          selectedCount={selected.size}
          onBatchDelete={batchDelete}
          onAutoPolish={() => setPolishOpen(true)}
          onBatchAnalyze={batchAnalyze}
          onExport={() => setExportOpen(true)}
          onToggleSelectAll={() => {
            // 全选/取消全选: 针对当前筛选结果(filtered)的全部草稿
            const allIds = filtered.map((d) => d.id);
            const isAll = allIds.length > 0 && allIds.every((id) => selected.has(id));
            setSelected(isAll ? new Set() : new Set(allIds));
          }}
          onInvertSelection={() => {
            // 反选: 当前筛选结果里的选中状态反转(选中↔未选)
            const ids = filtered.map((d) => d.id);
            setSelected((prev) => {
              const next = new Set(prev);
              for (const id of ids) {
                if (next.has(id)) next.delete(id);
                else next.add(id);
              }
              return next;
            });
          }}
          allSelected={filtered.length > 0 && filtered.every((d) => selected.has(d.id))}
          filteredCount={filtered.length}
          totalCount={drafts.length}
        />

        {/* 草稿列表 */}
        {loading ? (
          <div
            className={
              view === 'grid'
                ? 'grid grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-4 gap-4'
                : 'flex flex-col gap-3'
            }
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            illustration={
              search || statusFilter !== 'all' || selectedTagId !== null
                ? '/brand/empty-no-search-result.webp'
                : '/brand/empty-no-drafts.webp'
            }
            title={search || statusFilter !== 'all' || selectedTagId !== null ? '没有匹配的草稿' : '还没有草稿'}
            description={
              search || statusFilter !== 'all' || selectedTagId !== null
                ? '试试清空筛选或换个关键词'
                : '从一句话开始你的第一个剧本，AI 会生成大纲与章节'
            }
            primaryAction={
              search || statusFilter !== 'all' || selectedTagId !== null ? (
                <Button
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('all');
                    setSelectedTagId(null);
                  }}
                >
                  清空筛选
                </Button>
              ) : (
                <Button onClick={() => setCreateOpen(true)}>新建草稿</Button>
              )
            }
            secondaryAction={
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                导入剧本/大纲
              </Button>
            }
          />
        ) : view === 'grid' ? (
          <>
            <div className="grid grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-3 wide:grid-cols-4 gap-4">
              {visible.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  tags={tagsMap[d.id] || []}
                  selected={selected.has(d.id)}
                  onSelectChange={(s: boolean) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (s) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    });
                  }}
                  onToggleFavorite={() => toggleFavorite(d.id)}
                  onRename={() => {
                    setRenamingId(d.id);
                    setRenameValue(d.title || '');
                  }}
                  onEditTags={() => setTagEditorId(d.id)}
                  onResetStatus={() => resetStatus(d.id)}
                  onDelete={() => deleteDraft(d)}
                />
              ))}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="py-6 text-center text-sm text-ink-muted">
                正在加载更多… (已显示 {visible.length} / {filtered.length})
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {visible.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  tags={tagsMap[d.id] || []}
                  selected={selected.has(d.id)}
                  onSelectChange={(s: boolean) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (s) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    });
                  }}
                  onToggleFavorite={() => toggleFavorite(d.id)}
                  onRename={() => {
                    setRenamingId(d.id);
                    setRenameValue(d.title || '');
                  }}
                  onEditTags={() => setTagEditorId(d.id)}
                  onResetStatus={() => resetStatus(d.id)}
                  onDelete={() => deleteDraft(d)}
                  className="!flex-row max-h-[120px]"
                />
              ))}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="py-6 text-center text-sm text-ink-muted">
                正在加载更多… (已显示 {visible.length} / {filtered.length})
              </div>
            )}
          </>
        )}
      </div>

      {/* Modals & Drawers */}
      <DraftCreateDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreate}
      />
      <ImportScriptModal
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          fetchDrafts();
        }}
      />
      <BatchCreateModal
        open={batchOpen}
        onClose={() => { setBatchOpen(false); fetchDrafts(); }}
      />
      <VideoUploadModal
        open={videoOpen}
        onClose={() => {
          setVideoOpen(false);
          fetchDrafts();
        }}
      />
      {/* ⛔ 2026-09-18 入口审计裁定：自动打磨（polish）已停用（验证后完全没有可用性）。
          PolishModal 的触发按钮已去掉（FilterBar 里同日的 [STOPPED] 段）；
          PolishJobsPanel 必须一起摘掉 —— 它会轮询 /v1/polish，后端路由停用后会一直 404。
          ⚠️ 注意：PolishJobsPanel 与 PolishModal 仍在 _PolishModal.tsx 里完整保留，
             恢复时取消下面注释即可（后端 polish_router 也要一并恢复）。 */}
      {/* <PolishModal
        open={polishOpen}
        draftIds={Array.from(selected)}
        onClose={() => setPolishOpen(false)}
        onSubmitted={() => {
          setSelected(new Set());
        }}
      /> */}
      {/* 自动打磨进度浮窗(右下角常驻, 有进行中/未关闭作业时显示) */}
      {/* <PolishJobsPanel /> */}
      <ExportModal
        open={exportOpen}
        draftIds={Array.from(selected)}
        onClose={() => setExportOpen(false)}
        onSubmitted={() => {
          /* 保留选中, 方便用户导出后继续其它批量操作 */
        }}
      />
      {/* 导出进度浮窗(左下角常驻, 有进行中/未关闭任务时显示) */}
      <ExportJobsPanel />
      {tagEditorId !== null && (
        <TagsEditor
          draftId={tagEditorId}
          onClose={() => setTagEditorId(null)}
          onSaved={fetchDrafts}
        />
      )}

      {/* Rename inline 简易：重命名通过浏览器 prompt 替代——这里直接用 confirm 弹层挂个轻量 modal */}
      {renamingId !== null && (
        <RenameModal
          initial={renameValue}
          onCancel={() => setRenamingId(null)}
          onConfirm={(t) => rename(renamingId, t)}
        />
      )}
    </AppShell>
  );
}

/* ─────────────────── 小工具：重命名 modal ─────────────────── */

import { Modal, Input, FormField } from '@/components/ui';

function RenameModal({
  initial,
  onCancel,
  onConfirm,
}: {
  initial: string;
  onCancel: () => void;
  onConfirm: (val: string) => void;
}) {
  const [val, setVal] = React.useState(initial);
  return (
    <Modal
      open
      onClose={onCancel}
      title="重命名草稿"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(val)} disabled={!val.trim() || val === initial}>
            保存
          </Button>
        </>
      }
    >
      <FormField label="新标题" required>
        <Input value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
      </FormField>
    </Modal>
  );
}
