'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  /** 是否自动随内容增高 */
  autoSize?: boolean;
  /** 最大行数（autoSize 时） */
  maxRows?: number;
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { invalid, autoSize, maxRows = 12, className, onInput, rows = 3, ...rest },
    ref,
  ) {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRef = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    };

    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el || !autoSize) return;
      el.style.height = 'auto';
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
      const max = lineHeight * maxRows;
      el.style.height = Math.min(el.scrollHeight, max) + 'px';
    }, [autoSize, maxRows]);

    React.useEffect(() => {
      if (autoSize) resize();
    }, [autoSize, resize, rest.value]);

    return (
      <textarea
        ref={setRef}
        rows={rows}
        aria-invalid={invalid || undefined}
        onInput={(e) => {
          resize();
          onInput?.(e);
        }}
        className={cn(
          'block w-full rounded-md bg-surface-input border transition-colors',
          'text-ink-primary placeholder:text-ink-muted text-body',
          'px-3 py-2 outline-none resize-y kit-scroll',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid
            ? 'border-line-danger focus:border-line-danger'
            : 'border-line focus:border-line-active',
          autoSize && 'resize-none overflow-hidden',
          className,
        )}
        {...rest}
      />
    );
  },
);
