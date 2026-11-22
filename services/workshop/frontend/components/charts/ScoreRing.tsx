'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * ScoreRing — 圆环评分图 (PLAN §8 / 08 号设计图)
 *
 * 纯 SVG, 无第三方依赖。
 *  - size: 直径 (px)
 *  - score: 0-100
 *  - 颜色根据分数自动:
 *    >= 80 success / >= 60 primary / >= 40 warning / < 40 danger
 *  - 中央显示数字 + label
 *  - 进度条带渐变
 */
export type ScoreRingProps = {
  score: number;
  /** 直径,默认 160 */
  size?: number;
  /** 环的粗度,默认 12 */
  thickness?: number;
  /** 中央副标题 */
  label?: string;
  /** 显示等级 (S/A/B/C/D) */
  grade?: string;
  className?: string;
};

export function ScoreRing({
  score,
  size = 160,
  thickness = 12,
  label,
  grade,
  className,
}: ScoreRingProps) {
  const safe = Math.max(0, Math.min(100, score));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (safe / 100) * circumference;
  const center = size / 2;

  const colorClass =
    safe >= 80
      ? 'stroke-success'
      : safe >= 60
        ? 'stroke-primary'
        : safe >= 40
          ? 'stroke-warning'
          : 'stroke-danger';

  const gradientId = React.useId();

  return (
    <div className={cn('relative inline-flex flex-col items-center', className)}>
      <svg width={size} height={size} className="transform -rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.6" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="1" />
          </linearGradient>
        </defs>
        {/* 背景环 */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.1"
          strokeWidth={thickness}
        />
        {/* 进度环 */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeWidth={thickness}
          className={cn(colorClass, 'transition-[stroke-dashoffset] duration-700 ease-out')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {grade && (
          <div className="text-xs text-ink-muted uppercase tracking-wider mb-0.5">
            {grade}
          </div>
        )}
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            safe >= 80
              ? 'text-success'
              : safe >= 60
                ? 'text-primary'
                : safe >= 40
                  ? 'text-warning'
                  : 'text-danger',
          )}
        >
          {safe}
        </div>
        {label && (
          <div className="text-xs text-ink-secondary mt-0.5">{label}</div>
        )}
      </div>
    </div>
  );
}
