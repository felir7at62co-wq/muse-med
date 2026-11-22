'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

export type TabItem = {
  value: string;
  label: React.ReactNode;
  /** 右上角小角标（数字 / dot） */
  badge?: React.ReactNode;
  disabled?: boolean;
};

export type TabsProps = {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** 视觉变体：line(下划线) / pill(胶囊) / segmented(分段) */
  variant?: 'line' | 'pill' | 'segmented';
  size?: 'sm' | 'md';
  /** 平铺所有 tab 占满宽度 */
  fullWidth?: boolean;
  className?: string;
};

const sizeMap: Record<NonNullable<TabsProps['size']>, string> = {
  sm: 'h-8 text-caption px-3',
  md: 'h-10 text-body px-4',
};

export function Tabs({
  items,
  value,
  onChange,
  variant = 'line',
  size = 'md',
  fullWidth,
  className,
}: TabsProps) {
  const containerCls =
    variant === 'segmented'
      ? 'inline-flex bg-white/[0.04] p-1 rounded-lg border border-line gap-1'
      : variant === 'pill'
        ? 'inline-flex gap-1'
        : 'flex border-b border-line';

  return (
    <div
      role="tablist"
      className={cn(containerCls, fullWidth && 'w-full', className)}
    >
      {items.map((it) => {
        const active = it.value === value;
        const baseBtn = cn(
          'inline-flex items-center justify-center gap-2 font-medium transition-colors',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          sizeMap[size],
          fullWidth && 'flex-1',
        );
        const variantBtn =
          variant === 'segmented'
            ? cn(
                'rounded-md',
                active
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06]',
              )
            : variant === 'pill'
              ? cn(
                  'rounded-full',
                  active
                    ? 'bg-primary-subtle text-primary border border-primary/40'
                    : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06]',
                )
              : cn(
                  '-mb-px border-b-2',
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-ink-secondary hover:text-ink-primary',
                );
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={active}
            disabled={it.disabled}
            onClick={() => onChange(it.value)}
            className={cn(baseBtn, variantBtn)}
          >
            {it.label}
            {it.badge && (
              <span
                className={cn(
                  'inline-flex items-center justify-center text-micro min-w-[18px] h-[18px] px-1 rounded-full',
                  active ? 'bg-primary text-white' : 'bg-white/[0.08] text-ink-muted',
                )}
              >
                {it.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
