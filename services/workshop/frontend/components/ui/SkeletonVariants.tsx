import * as React from 'react';
import { cn } from '@/lib/cn';
import { Skeleton } from './Skeleton';

/* ───── SkeletonCard — 用于 DraftCard / 概览卡 等 ───── */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface-elevated p-4 flex flex-col gap-3',
        className,
      )}
    >
      <Skeleton className="w-full aspect-video" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <div className="flex items-center justify-between mt-1">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

/* ───── SkeletonTable — 用于回收站、批量任务等表格 ───── */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface-elevated overflow-hidden',
        className,
      )}
    >
      {/* 表头 */}
      <div
        className="grid gap-4 px-4 py-3 border-b border-line bg-white/[0.02]"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3" />
        ))}
      </div>
      {/* 表行 */}
      <div className="divide-y divide-line/50">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="grid gap-4 px-4 py-3.5"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className="h-4" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───── SkeletonEditor — 用于章节 / 大纲 编辑器 ───── */
export function SkeletonEditor({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface-elevated p-6 flex flex-col gap-4',
        className,
      )}
    >
      <Skeleton className="h-7 w-1/2" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div className="space-y-2 mt-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton
            key={i}
            className={cn('h-3', i % 3 === 2 ? 'w-2/3' : 'w-full')}
          />
        ))}
      </div>
    </div>
  );
}

/* ───── SkeletonList — 用于消息流 / 章节列表 / 记忆列表 ───── */
export function SkeletonList({
  count = 5,
  withAvatar,
  className,
}: {
  count?: number;
  withAvatar?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 p-3 rounded-lg bg-surface-elevated border border-line"
        >
          {withAvatar && <Skeleton circle className="w-9 h-9 flex-shrink-0" />}
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───── SkeletonChart — 用于分析页评分环 / 雷达 / 趋势线 ───── */
export function SkeletonChart({
  variant = 'bar',
  className,
}: {
  variant?: 'bar' | 'ring' | 'line' | 'radar';
  className?: string;
}) {
  if (variant === 'ring') {
    return (
      <div
        className={cn(
          'rounded-xl border border-line bg-surface-elevated p-6 flex flex-col items-center gap-4',
          className,
        )}
      >
        <Skeleton circle className="w-32 h-32" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }
  if (variant === 'radar') {
    return (
      <div
        className={cn(
          'rounded-xl border border-line bg-surface-elevated p-6 flex items-center justify-center aspect-square',
          className,
        )}
      >
        <Skeleton circle className="w-44 h-44" />
      </div>
    );
  }
  if (variant === 'line') {
    return (
      <div
        className={cn(
          'rounded-xl border border-line bg-surface-elevated p-6',
          className,
        )}
      >
        <Skeleton className="w-full h-32" />
      </div>
    );
  }
  /* bar */
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface-elevated p-6 flex items-end gap-2 h-48',
        className,
      )}
    >
      {[40, 70, 30, 90, 60, 80, 50].map((h, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}
