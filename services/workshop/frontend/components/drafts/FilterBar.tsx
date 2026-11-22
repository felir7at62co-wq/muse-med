'use client';
import * as React from 'react';
import { Search, X, LayoutGrid, List } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input, Select, Button, Tabs, IconButton } from '@/components/ui';

export type DraftStatusFilter = 'all' | 'draft' | 'done' | 'running' | 'favorite';
export type DraftSort = 'updated_desc' | 'created_desc' | 'title_asc' | 'score_desc';
export type ViewMode = 'grid' | 'list';

export type FilterBarProps = {
  search: string;
  onSearchChange: (s: string) => void;
  status: DraftStatusFilter;
  onStatusChange: (v: DraftStatusFilter) => void;
  sort: DraftSort;
  onSortChange: (v: DraftSort) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  /** 按创建时间筛选 (独立条件, 与排序叠加); 空字符串表示不限 */
  dateFrom?: string;
  dateTo?: string;
  onDateFromChange?: (v: string) => void;
  onDateToChange?: (v: string) => void;
  /** 只看"剧本集数 ≥ N"的草稿; 空字符串/0 表示不限 */
  minStoryboards?: string;
  onMinStoryboardsChange?: (v: string) => void;
  /** 只看"最近一次打磨硬伤数为 0"的草稿(与其它筛选 AND 叠加) */
  onlyPolishedClean?: boolean;
  onOnlyPolishedCleanChange?: (v: boolean) => void;
  /** 选中数量；> 0 时显示批量删除 */
  selectedCount?: number;
  onBatchDelete?: () => void;
  /** 选中 > 0 时显示"自动打磨"入口 */
  onAutoPolish?: () => void;
  /** 选中 > 0 时显示"全量剧情分析"入口(跑总览全部分析+打分) */
  onBatchAnalyze?: () => void;
  /** 选中 > 0 时显示"批量导出"入口 */
  onExport?: () => void;
  /** 全选/取消全选(针对当前筛选结果) */
  onToggleSelectAll?: () => void;
  /** 反选: 当前筛选结果里的选中状态反转 */
  onInvertSelection?: () => void;
  /** 当前筛选结果是否已全部选中 */
  allSelected?: boolean;
  /** 显示数量统计：x / y 个 */
  filteredCount: number;
  totalCount: number;
  className?: string;
};

const STATUS_TABS = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '生成中' },
  { value: 'done', label: '已完成' },
  { value: 'draft', label: '构思中' },
  { value: 'favorite', label: '收藏' },
] as const;

export function FilterBar({
  search,
  onSearchChange,
  status,
  onStatusChange,
  sort,
  onSortChange,
  view,
  onViewChange,
  dateFrom = '',
  dateTo = '',
  onDateFromChange,
  onDateToChange,
  minStoryboards = '',
  onMinStoryboardsChange,
  onlyPolishedClean = false,
  onOnlyPolishedCleanChange,
  selectedCount = 0,
  onBatchDelete,
  onAutoPolish,
  onBatchAnalyze,
  onExport,
  onToggleSelectAll,
  onInvertSelection,
  allSelected = false,
  filteredCount,
  totalCount,
  className,
}: FilterBarProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索标题或概要..."
            leftIcon={<Search />}
            rightIcon={
              search ? (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  className="text-ink-muted hover:text-ink-primary"
                  aria-label="清空搜索"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : undefined
            }
          />
        </div>
        <Select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as DraftSort)}
          className="w-[160px]"
        >
          <option value="updated_desc">最近更新</option>
          <option value="created_desc">最近创建</option>
          <option value="score_desc">评分从高到低</option>
          <option value="title_asc">标题 A→Z</option>
        </Select>
        <div className="flex items-center gap-1 bg-white/[0.04] border border-line rounded-md p-0.5">
          <IconButton
            aria-label="网格视图"
            size="sm"
            variant={view === 'grid' ? 'subtle' : 'ghost'}
            onClick={() => onViewChange('grid')}
          >
            <LayoutGrid />
          </IconButton>
          <IconButton
            aria-label="列表视图"
            size="sm"
            variant={view === 'list' ? 'subtle' : 'ghost'}
            onClick={() => onViewChange('list')}
          >
            <List />
          </IconButton>
        </div>
        {onToggleSelectAll && filteredCount > 0 && (
          <Button variant="outline" size="sm" onClick={onToggleSelectAll}>
            {allSelected ? '取消全选' : `全选${filteredCount > 0 ? ` (${filteredCount})` : ''}`}
          </Button>
        )}
        {onInvertSelection && filteredCount > 0 && (
          <Button variant="outline" size="sm" onClick={onInvertSelection}>
            反选
          </Button>
        )}
        {/* ⛔ 2026-09-18 入口审计裁定：自动打磨（polish）入口已停用 ——
            验证后完全没有可用性：近 30 天 prod 仅 1 次调用（7 人共 16 次），
            已被对话工坊的「精修这批」取代。后端 /v1/polish 路由已停用，
            此按钮若保留会打到不存在的接口。
            ⚠️ 下方「只看打磨0硬伤」筛选**保留** —— 它只读 last_polish_p0 字段，
               不调后端，历史数据仍可筛。
            恢复：取消本段注释 + 恢复后端 polish_router 注册。 */}
        {/* {selectedCount > 0 && onAutoPolish && (
          <Button variant="primary" size="sm" onClick={onAutoPolish}>
            ✨ 自动打磨 ({selectedCount})
          </Button>
        )} */}
        {selectedCount > 0 && onBatchAnalyze && (
          <Button variant="secondary" size="sm" onClick={onBatchAnalyze}>
            🔍 全量剧情分析 ({selectedCount})
          </Button>
        )}
        {selectedCount > 0 && onExport && (
          <Button variant="secondary" size="sm" onClick={onExport}>
            ⬇ 导出 ({selectedCount})
          </Button>
        )}
        {selectedCount > 0 && onBatchDelete && (
          <Button variant="danger" size="sm" onClick={onBatchDelete}>
            移入回收站 ({selectedCount})
          </Button>
        )}
      </div>
      {/* 创建时间段筛选 (独立条件, 与上方排序叠加) */}
      {(onDateFromChange || onDateToChange) && (
        <div className="flex items-center gap-2 flex-wrap text-caption text-ink-muted">
          <span>按创建时间:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => onDateFromChange?.(e.target.value)}
            className="rounded-md border border-line bg-white/[0.04] px-2 py-1 text-ink-primary"
            aria-label="起始日期"
          />
          <span>~</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => onDateToChange?.(e.target.value)}
            className="rounded-md border border-line bg-white/[0.04] px-2 py-1 text-ink-primary"
            aria-label="结束日期"
          />
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => { onDateFromChange?.(''); onDateToChange?.(''); }}
              className="rounded-md px-2 py-1 text-primary hover:bg-white/[0.06]"
            >
              清除时间
            </button>
          )}
          {onMinStoryboardsChange && (
            <>
              <span className="ml-2">剧本集数 ≥</span>
              <input
                type="number"
                min={0}
                value={minStoryboards}
                onChange={(e) => onMinStoryboardsChange(e.target.value)}
                placeholder="不限"
                className="w-[72px] rounded-md border border-line bg-white/[0.04] px-2 py-1 text-ink-primary"
                aria-label="最少剧本集数"
              />
              <span>集</span>
              {minStoryboards && (
                <button
                  type="button"
                  onClick={() => onMinStoryboardsChange('')}
                  className="rounded-md px-2 py-1 text-primary hover:bg-white/[0.06]"
                >
                  清除
                </button>
              )}
            </>
          )}
          {onOnlyPolishedCleanChange && (
            <label className="ml-2 flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyPolishedClean}
                onChange={(e) => onOnlyPolishedCleanChange(e.target.checked)}
                className="accent-primary"
              />
              <span>仅看打磨后 0 硬伤</span>
            </label>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs
          variant="pill"
          size="sm"
          value={status}
          onChange={(v) => onStatusChange(v as DraftStatusFilter)}
          items={STATUS_TABS as any}
        />
        <span className="text-caption text-ink-muted">
          {filteredCount === totalCount
            ? `共 ${totalCount} 个`
            : `${filteredCount} / ${totalCount} 个`}
        </span>
      </div>
    </div>
  );
}
