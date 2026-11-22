'use client';
import * as React from 'react';
import { FileText, Clapperboard, Users, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Card, Progress } from '@/components/ui';
import type { WorkbenchKpiData } from './types';

export type WorkbenchKpisProps = {
  data: WorkbenchKpiData;
  className?: string;
};

/**
 * WorkbenchKpis — 4 KPI 概览（PLAN §6.3 / 02 号图）
 *
 * 卡片：
 *  1. 章节进度（n / m + 进度条）
 *  2. 剧本数（已生成）
 *  3. 角色数
 *  4. 风险数（>0 时高亮 danger）
 */
export function WorkbenchKpis({ data, className }: WorkbenchKpisProps) {
  const chapPct =
    data.chapters.total > 0
      ? Math.min(100, Math.round((data.chapters.done / data.chapters.total) * 100))
      : 0;

  const items = [
    {
      key: 'chapters',
      label: '原文/小说进度',
      icon: FileText,
      value: `${data.chapters.done} / ${data.chapters.total || '—'}`,
      tone: 'primary' as const,
      progress: data.chapters.total > 0 ? chapPct : null,
    },
    {
      key: 'storyboards',
      label: '剧本数',
      icon: Clapperboard,
      value: data.storyboards,
      tone: 'cyan' as const,
    },
    {
      key: 'characters',
      label: '角色数',
      icon: Users,
      value: data.characters,
      tone: 'success' as const,
    },
    {
      key: 'issues',
      label: '安全风险',
      icon: ShieldAlert,
      value: data.issues,
      tone: data.issues > 0 ? ('danger' as const) : ('muted' as const),
    },
  ];

  const toneBg: Record<string, string> = {
    cyan: 'bg-cyan-subtle text-cyan',
    primary: 'bg-primary-subtle text-primary',
    success: 'bg-success-subtle text-success',
    warning: 'bg-warning-subtle text-warning',
    danger: 'bg-danger-subtle text-danger',
    muted: 'bg-white/[0.06] text-ink-muted',
  };

  return (
    <div className={cn('grid grid-cols-2 tablet:grid-cols-4 gap-3', className)}>
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Card key={it.key} padding="md" className="flex items-start gap-3">
            <div
              className={cn(
                'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
                toneBg[it.tone],
              )}
            >
              <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-page-title text-ink-primary tabular-nums leading-none">
                {it.value}
              </div>
              <div className="text-caption text-ink-muted mt-1">{it.label}</div>
              {typeof it.progress === 'number' && (
                <Progress
                  percent={it.progress}
                  tone="primary"
                  size="xs"
                  className="mt-2"
                />
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
