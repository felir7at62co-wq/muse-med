'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'bottom' | 'top';

export type PopoverProps = {
  /** 触发节点 (受控或非受控) */
  trigger: React.ReactElement;
  /** 浮层内容 */
  children: React.ReactNode;
  placement?: PopoverPlacement;
  /** 偏移 px */
  offset?: number;
  /** 受控开关 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 是否在点击 trigger 切换 (默认 true) */
  toggleOnTrigger?: boolean;
  /** 内容容器 className */
  contentClassName?: string;
  /** match-trigger-width: 浮层与 trigger 等宽 */
  matchWidth?: boolean;
};

/**
 * 轻量 Popover — 无外部依赖。
 * - trigger 必须是单个 element（forwardRef 接收 ref）
 * - 内容渲染到 document.body 的 portal，避免被 overflow 截断
 */
export function Popover({
  trigger,
  children,
  placement = 'bottom-start',
  offset = 6,
  open: controlledOpen,
  onOpenChange,
  toggleOnTrigger = true,
  contentClassName,
  matchWidth,
}: PopoverProps) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolled;
  const setOpen = (v: boolean) => {
    if (!isControlled) setUncontrolled(v);
    onOpenChange?.(v);
  };

  const triggerRef = React.useRef<HTMLElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 0,
    width: 0,
  });
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const recalc = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ch = contentRef.current?.offsetHeight ?? 0;
    const cw = contentRef.current?.offsetWidth ?? 0;
    let top = 0;
    let left = 0;
    switch (placement) {
      case 'bottom':
        top = r.bottom + offset;
        left = r.left + r.width / 2 - cw / 2;
        break;
      case 'bottom-end':
        top = r.bottom + offset;
        left = r.right - cw;
        break;
      case 'top':
        top = r.top - offset - ch;
        left = r.left + r.width / 2 - cw / 2;
        break;
      case 'top-start':
        top = r.top - offset - ch;
        left = r.left;
        break;
      case 'top-end':
        top = r.top - offset - ch;
        left = r.right - cw;
        break;
      default: // bottom-start
        top = r.bottom + offset;
        left = r.left;
    }
    setPos({ top, left, width: r.width });
  }, [placement, offset]);

  React.useLayoutEffect(() => {
    if (!open) return;
    recalc();
    const onScroll = () => recalc();
    const onResize = () => recalc();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, recalc]);

  // 点击外部关闭
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        contentRef.current?.contains(t) ||
        triggerRef.current?.contains(t)
      )
        return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 把 trigger 增强 onClick + ref
  const triggerNode = React.cloneElement(trigger, {
    ref: (node: HTMLElement) => {
      (triggerRef as React.MutableRefObject<HTMLElement | null>).current = node;
      const origRef = (trigger as any).ref;
      if (typeof origRef === 'function') origRef(node);
      else if (origRef && typeof origRef === 'object')
        (origRef as React.MutableRefObject<unknown>).current = node;
    },
    onClick: (e: React.MouseEvent) => {
      (trigger.props as any).onClick?.(e);
      if (toggleOnTrigger) setOpen(!open);
    },
    'aria-haspopup': true,
    'aria-expanded': open,
  } as any);

  return (
    <>
      {triggerNode}
      {mounted &&
        open &&
        createPortal(
          <div
            ref={contentRef}
            role="dialog"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: matchWidth ? pos.width : undefined,
            }}
            className={cn(
              'kit-z-popover bg-surface-elevated border border-line rounded-lg shadow-overlay',
              'animate-fade-in',
              contentClassName,
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
