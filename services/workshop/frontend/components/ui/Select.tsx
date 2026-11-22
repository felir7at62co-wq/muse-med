'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';

type SelectSize = 'sm' | 'md' | 'lg';

export type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  invalid?: boolean;
  size?: SelectSize;
};

const sizeMap: Record<SelectSize, string> = {
  sm: 'h-8 text-caption',
  md: 'h-10 text-body',
  lg: 'h-12 text-card-title',
};

/**
 * 原生 select 包装。复杂下拉用 DropdownMenu 实现.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        'relative flex items-center w-full rounded-md',
        'bg-surface-input border transition-colors',
        invalid
          ? 'border-line-danger focus-within:border-line-danger'
          : 'border-line focus-within:border-line-active',
        sizeMap[size],
      )}
    >
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex-1 bg-transparent border-0 outline-none appearance-none',
          'text-ink-primary disabled:cursor-not-allowed disabled:opacity-50',
          'pl-3 pr-9 cursor-pointer',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-3 w-4 h-4 text-ink-muted pointer-events-none" />
    </div>
  );
});
