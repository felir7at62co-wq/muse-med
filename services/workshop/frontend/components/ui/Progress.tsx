'use client';
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { type Tone, toneClasses } from './_statusColors';
import { Spinner } from './Spinner';
import { IconButton } from './IconButton';

/* ───── 线性进度条 ───── */
export type ProgressProps = {
  /** 0-100；indeterminate 时 percent 忽略 */
  percent?: number;
  indeterminate?: boolean;
  tone?: Tone;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /** 屏读 */
  label?: string;
};

const heightMap: Record<NonNullable<ProgressProps['size']>, string> = {
  xs: 'h-1',
  sm: 'h-1.5',
  md: 'h-2',
};

export function Progress({
  percent = 0,
  indeterminate,
  tone = 'primary',
  size = 'sm',
  className,
  label,
}: ProgressProps) {
  const t = toneClasses[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(Math.max(0, Math.min(100, percent)))}
      className={cn('relative w-full rounded-full overflow-hidden bg-white/[0.06]', heightMap[size], className)}
    >
      {indeterminate ? (
        <div className={cn('absolute inset-y-0 w-1/3 rounded-full animate-shimmer kit-shimmer', t.bg)} />
      ) : (
        <div
          className={cn('h-full rounded-full transition-all duration-300', t.bg)}
          style={{
            width: `${Math.max(0, Math.min(100, percent))}%`,
            backgroundColor: undefined,
          }}
        >
          {/* 用 实色 fill，不用 subtle */}
          <div
            className={cn(
              'h-full rounded-full',
              tone === 'primary' && 'bg-primary',
              tone === 'cyan' && 'bg-cyan',
              tone === 'success' && 'bg-success',
              tone === 'warning' && 'bg-warning',
              tone === 'danger' && 'bg-danger',
              tone === 'info' && 'bg-info',
              tone === 'muted' && 'bg-ink-muted',
            )}
            style={{ width: '100%' }}
          />
        </div>
      )}
    </div>
  );
}

/* ───── ProgressBannerV2 (PLAN §6.4 / 02 号图) ───── */
export type ProgressBannerStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export type ProgressBannerProps = {
  visible?: boolean;
  title: string;
  current?: number;
  total?: number;
  /** 显式覆盖 percent，优先级高于 current/total 计算 */
  percent?: number;
  status?: ProgressBannerStatus;
  /** 当前阶段说明 */
  stage?: string;
  /** 预计剩余 */
  etaSec?: number;
  onCancel?: () => void;
  className?: string;
};

const statusToneMap: Record<ProgressBannerStatus, Tone> = {
  queued: 'info',
  running: 'primary',
  success: 'success',
  error: 'danger',
  canceled: 'muted',
};

const statusLabelMap: Record<ProgressBannerStatus, string> = {
  queued: '等待中',
  running: '执行中',
  success: '已完成',
  error: '失败',
  canceled: '已取消',
};

export function ProgressBanner({
  visible = true,
  title,
  current,
  total,
  percent,
  status = 'running',
  stage,
  etaSec,
  onCancel,
  className,
}: ProgressBannerProps) {
  if (!visible) return null;
  const tone = statusToneMap[status];

  const pct =
    typeof percent === 'number'
      ? percent
      : total && total > 0 && typeof current === 'number'
        ? Math.round((current / total) * 100)
        : 0;
  const indeterminate = status === 'running' && pct === 0 && !current;

  return (
    <div
      className={cn(
        'kit-card rounded-lg border border-line p-4 flex flex-col gap-2 animate-fade-in',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {status === 'running' ? (
          <Spinner size="sm" className="text-primary" />
        ) : (
          <span className={cn('w-2 h-2 rounded-full', toneClasses[tone].dot)} />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-body font-medium text-ink-primary truncate">{title}</span>
            <span className={cn('text-micro px-1.5 py-0.5 rounded', toneClasses[tone].bg, toneClasses[tone].text)}>
              {statusLabelMap[status]}
            </span>
          </div>
          {(stage || etaSec) && (
            <div className="text-caption text-ink-muted mt-0.5 flex items-center gap-2 flex-wrap">
              {stage && <span>{stage}</span>}
              {etaSec && etaSec > 0 && <span>预计剩余 {formatEta(etaSec)}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-caption text-ink-secondary tabular-nums">
            {typeof current === 'number' && typeof total === 'number'
              ? `${current} / ${total}`
              : `${pct}%`}
          </span>
          {onCancel && status === 'running' && (
            <IconButton aria-label="取消任务" size="sm" variant="ghost" onClick={onCancel}>
              <X />
            </IconButton>
          )}
        </div>
      </div>
      <Progress percent={pct} indeterminate={indeterminate} tone={tone} size="sm" />
    </div>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s ? ` ${s}s` : ''}`;
}
