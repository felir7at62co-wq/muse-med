'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'cyan';
  size?: 'sm' | 'md' | 'lg';
  /** 显示 spinner，自动 disabled */
  loading?: boolean;
  /** 左侧 icon */
  leftIcon?: React.ReactNode;
  /** 右侧 icon */
  rightIcon?: React.ReactNode;
  /** 撑满父容器宽度 */
  fullWidth?: boolean;
};

const variantMap: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover active:brightness-95 shadow-glow/40',
  secondary: 'bg-white/[0.08] text-ink-primary hover:bg-white/[0.14] border border-line',
  ghost: 'bg-transparent text-ink-secondary hover:bg-white/[0.06] hover:text-ink-primary',
  outline: 'bg-transparent text-ink-primary border border-line hover:bg-white/[0.04] hover:border-line-hover',
  danger: 'bg-danger text-white hover:brightness-110 active:brightness-95',
  cyan: 'bg-cyan text-surface-base hover:bg-cyan-hover active:brightness-95',
};

const sizeMap: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-caption gap-1.5 rounded-md',
  md: 'h-10 px-4 text-body gap-2 rounded-md',
  lg: 'h-12 px-5 text-card-title gap-2 rounded-lg',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading,
    leftIcon,
    rightIcon,
    fullWidth,
    className,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center font-medium select-none',
        'transition-colors transition-shadow duration-150',
        'kit-focus-ring',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        variantMap[variant],
        sizeMap[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} className="text-current" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
