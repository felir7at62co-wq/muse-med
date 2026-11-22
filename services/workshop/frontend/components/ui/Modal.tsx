'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** 尺寸，对应 PLAN §25.3 */
  size?: 'sm' | 'md' | 'lg';
  /** 隐藏右上角关闭按钮 */
  hideCloseButton?: boolean;
  /** 点击 overlay 是否关闭，默认 true */
  closeOnOverlay?: boolean;
  /** 按 ESC 是否关闭，默认 true */
  closeOnEsc?: boolean;
  className?: string;
  /** 底部按钮区 */
  footer?: React.ReactNode;
  children?: React.ReactNode;
};

const sizeMap: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[480px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[920px]',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  hideCloseButton,
  closeOnOverlay = true,
  closeOnEsc = true,
  className,
  footer,
  children,
}: ModalProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // 锁滚动
  React.useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  // ESC
  React.useEffect(() => {
    if (!open || !closeOnEsc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closeOnEsc, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 kit-z-modal flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
    >
      <div
        className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
        onClick={closeOnOverlay ? onClose : undefined}
      />
      <div
        className={cn(
          'relative w-full bg-surface-elevated rounded-xl border border-line shadow-overlay',
          'flex flex-col max-h-[calc(100vh-32px)] animate-slide-up',
          sizeMap[size],
          className,
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
            <div className="flex-1 min-w-0">
              {title && (
                <h2
                  id="modal-title"
                  className="text-section-title text-ink-primary leading-tight"
                >
                  {title}
                </h2>
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
