'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'ghost' | 'subtle' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  /** ARIA 标签必填（仅图标无文字时） */
  'aria-label': string;
  children: React.ReactNode;
};

const variantMap: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost: 'bg-transparent text-ink-secondary hover:bg-white/[0.06] hover:text-ink-primary',
  subtle: 'bg-white/[0.06] text-ink-primary hover:bg-white/[0.12]',
  outline: 'bg-transparent text-ink-primary border border-line hover:bg-white/[0.04]',
  danger: 'bg-transparent text-danger hover:bg-danger-subtle',
};

const sizeMap: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'w-8 h-8 rounded-md [&>svg]:w-4 [&>svg]:h-4',
  md: 'w-10 h-10 rounded-md [&>svg]:w-5 [&>svg]:h-5',
  lg: 'w-12 h-12 rounded-lg [&>svg]:w-6 [&>svg]:h-6',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { variant = 'ghost', size = 'md', loading, className, disabled, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          'inline-flex items-center justify-center transition-colors duration-150',
          'kit-focus-ring kit-touch',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          variantMap[variant],
          sizeMap[size],
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner size={size === 'lg' ? 'md' : 'sm'} className="text-current" /> : children}
      </button>
    );
  },
);
