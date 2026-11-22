'use client';
import * as React from 'react';
import { FileText, Loader2, CheckCircle2, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui';
import type { DraftStats } from './types';

export type OverviewPanelProps = {
  stats: DraftStats;
  className?: string;
};

/**
 * OverviewPanel — 创作概览 4 KPI（PLAN §5.2 + 01 号图）
 *
 * 4 卡：全部 / 生成中 / 已完成 / 构思中
 */
export function OverviewPanel({ stats, className }: OverviewPanelProps) {
  const items = [
    { key: 'total', label: '全部草稿', value: stats.total, icon: FileText, tone: 'cyan' as const },
    { key: 'generating', label: '生成中', value: stats.generating, icon: Loader2, tone: 'primary' as const, animate: true },
    { key: 'completed', label: '已完成', value: stats.completed, icon: CheckCircle2, tone: 'success' as const },
    { key: 'ideating', label: '构思中', value: stats.ideating, icon: Lightbulb, tone: 'warning' as const },
  ];

  const toneBg: Record<string, string> = {
    cyan: 'bg-cyan-subtle text-cyan',
    primary: 'bg-primary-subtle text-primary',
    success: 'bg-success-subtle text-success',
    warning: 'bg-warning-subtle text-warning',
  };

  return (
    <div className={cn('grid grid-cols-2 tablet:grid-cols-4 gap-3', className)}>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Card key={it.key} padding="md" className="flex items-center gap-3">
            <div
              className={cn(
                'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
                toneBg[it.tone],
              )}
            >
              <Icon className={cn('w-5 h-5', it.animate && it.value > 0 && 'animate-spin')} />
            </div>
            <div className="min-w-0">
              <div className="text-page-title text-ink-primary tabular-nums leading-none">
                {it.value}
              </div>
              <div className="text-caption text-ink-muted mt-1">{it.label}</div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
