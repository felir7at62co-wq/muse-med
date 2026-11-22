'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

type InputSize = 'sm' | 'md' | 'lg';

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  invalid?: boolean;
  /** 左侧 icon */
  leftIcon?: React.ReactNode;
  /** 右侧 icon (例如 clear 按钮) */
  rightIcon?: React.ReactNode;
  size?: InputSize;
};

const sizeMap: Record<InputSize, string> = {
  sm: 'h-8 text-caption',
  md: 'h-10 text-body',
  lg: 'h-12 text-card-title',
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, leftIcon, rightIcon, size = 'md', className, ...rest },
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
      {leftIcon && (
        <span className="pl-3 pr-1 text-ink-muted flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex-1 bg-transparent border-0 outline-none',
          'text-ink-primary placeholder:text-ink-muted',
          'px-3 disabled:cursor-not-allowed disabled:opacity-50',
          leftIcon && 'pl-1',
          rightIcon && 'pr-1',
          className,
        )}
        {...rest}
      />
      {rightIcon && (
        <span className="pr-3 pl-1 text-ink-muted flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">
          {rightIcon}
        </span>
      )}
    </div>
  );
});
