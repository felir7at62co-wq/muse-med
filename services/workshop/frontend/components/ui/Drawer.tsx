'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  /** 抽屉位置 */
  side?: 'right' | 'left' | 'bottom';
  /** 宽度 / 底部抽屉时为高度 */
  size?: 'sm' | 'md' | 'lg';
  title?: React.ReactNode;
  description?: React.ReactNode;
  hideCloseButton?: boolean;
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  className?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
};

const sizeMap: Record<'right' | 'left', Record<NonNullable<DrawerProps['size']>, string>> = {
  right: {
    sm: 'w-[400px] max-w-full',
    md: 'w-[520px] max-w-full',
    lg: 'w-[640px] max-w-full',
  },
  left: {
    sm: 'w-[400px] max-w-full',
    md: 'w-[520px] max-w-full',
    lg: 'w-[640px] max-w-full',
  },
};
const bottomSizeMap: Record<NonNullable<DrawerProps['size']>, string> = {
  sm: 'h-[40vh]',
  md: 'h-[60vh]',
  lg: 'h-[80vh]',
};

const animMap: Record<NonNullable<DrawerProps['side']>, string> = {
  right: 'right-0 top-0 h-full animate-slide-in-right',
  left: 'left-0 top-0 h-full animate-slide-in-right',
  bottom: 'left-0 bottom-0 right-0 animate-slide-up',
};

export function Drawer({
  open,
  onClose,
  side = 'right',
  size = 'md',
  title,
  description,
  hideCloseButton,
  closeOnOverlay = true,
  closeOnEsc = true,
  className,
  footer,
  children,
}: DrawerProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || !closeOnEsc) return;
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closeOnEsc, onClose]);

  if (!mounted || !open) return null;

  const sizeCls =
    side === 'bottom' ? cn('w-full', bottomSizeMap[size]) : sizeMap[side][size];

  return createPortal(
    <div
      className="fixed inset-0 kit-z-drawer flex animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
        onClick={closeOnOverlay ? onClose : undefined}
      />
      <div
        className={cn(
          'absolute bg-surface-elevated border-line shadow-overlay flex flex-col',
          side === 'right' && 'border-l rounded-l-xl',
          side === 'left' && 'border-r rounded-r-xl',
          side === 'bottom' && 'border-t rounded-t-xl',
          sizeCls,
          animMap[side],
          className,
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 border-b border-line">
            <div className="flex-1 min-w-0">
              {title && (
                <h2 className="text-section-title text-ink-primary leading-tight">{title}</h2>
              )}
              {description && (
                <p className="mt-1 text-caption text-ink-secondary">{description}</p>
              )}
            </div>
            {!hideCloseButton && (
              <IconButton
                aria-label="关闭"
                size="sm"
                onClick={onClose}
                className="-mr-2 -mt-1"
              >
                <X />
              </IconButton>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto kit-scroll px-6 py-4">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
