'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export type TooltipProps = {
  content: React.ReactNode;
  /** 子节点必须能接收 ref（或者用 div 包一层） */
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** 延迟显示 ms */
  delay?: number;
  className?: string;
};

/** 触发元素矩形 → 气泡在视口中的定位（含用于居中的 transform）。 */
function place(side: NonNullable<TooltipProps['side']>, r: DOMRect) {
  const GAP = 8;
  switch (side) {
    case 'top':
      return { top: r.top - GAP, left: r.left + r.width / 2, transform: 'translate(-50%, -100%)' };
    case 'bottom':
      return { top: r.bottom + GAP, left: r.left + r.width / 2, transform: 'translate(-50%, 0)' };
    case 'left':
      return { top: r.top + r.height / 2, left: r.left - GAP, transform: 'translate(-100%, -50%)' };
    case 'right':
      return { top: r.top + r.height / 2, left: r.right + GAP, transform: 'translate(0, -50%)' };
  }
}

/**
 * 轻量 Tooltip — 纯 CSS hover/focus + 延迟，无外部依赖。
 *
 * ⚠️ 气泡必须 portal 到 body，不能用 `absolute` 挂在触发元素旁边。
 * 原因（2026-09 实测踩坑）：CSS 规范规定 `overflow` 任一轴为 `auto/scroll` 时，
 * 另一轴的 `visible` 会被强制计算成 `auto`，即**横向同样裁剪**。
 * 折叠态二级导航挂在 `Sidebar.tsx` 的 `overflow-y-auto` 容器里，宽仅 64px，
 * `side="right"` 的气泡起点在容器右边缘之外 → 整个被裁掉，表现为"悬停毫无反应"。
 * `z-index` 救不了：裁剪与层级是两回事。
 * 改为 `position: fixed` + portal 后，任何祖先滚动容器都裁不到它。
 */
export function Tooltip({ content, children, side = 'top', delay = 200, className }: TooltipProps) {
  const [pos, setPos] = React.useState<ReturnType<typeof place> | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => setMounted(true), []);

  const hide = React.useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  }, []);

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      setPos(place(side, el.getBoundingClientRect()));
    }, delay);
  };

  // 气泡是 fixed 定位、脱离文档流的，祖先滚动/窗口变化后位置会失真 → 直接收起。
  React.useEffect(() => {
    if (!pos) return;
    window.addEventListener('scroll', hide, true); // capture: 任意祖先滚动都能收到
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [pos, hide]);

  React.useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <span
      ref={ref}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {mounted && pos
        ? createPortal(
            <span
              role="tooltip"
              style={{ position: 'fixed', top: pos.top, left: pos.left, transform: pos.transform }}
              className={cn(
                'kit-z-tooltip pointer-events-none whitespace-nowrap',
                'px-2 py-1 rounded-md bg-surface-elevated border border-line shadow-overlay',
                'text-caption text-ink-primary animate-fade-in',
                className,
              )}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
