import { cn } from '@/lib/cn';

export type SkeletonProps = {
  className?: string;
  /** 是否带 shimmer 动画。默认 true */
  animate?: boolean;
  /** 是否圆形（用于头像占位） */
  circle?: boolean;
  /** 行高 px。也可以直接通过 className 控制。 */
  height?: number;
  width?: number | string;
  /** 透传 inline style，便于动态尺寸 */
  style?: React.CSSProperties;
};

/**
 * Skeleton 原子 — 灰色占位块 + shimmer 动画（PLAN §28.1 / 23 号图）
 *
 * 复合骨架（SkeletonCard / SkeletonTable / SkeletonEditor 等）见 Tier 5.
 */
export function Skeleton({
  className,
  animate = true,
  circle,
  height,
  width,
  style,
}: SkeletonProps) {
  return (
    <div
      role="status"
      aria-label="loading"
      style={{ height, width, ...style }}
      className={cn(
        'relative overflow-hidden bg-white/[0.04]',
        circle ? 'rounded-full' : 'rounded-md',
        animate && 'kit-shimmer animate-shimmer',
        className,
      )}
    />
  );
}
