import { cn } from '@/lib/cn';
import { Loader2 } from 'lucide-react';

export type SpinnerProps = {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  /** 屏读文案 */
  label?: string;
};

const sizeMap: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'w-3 h-3',
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-7 h-7',
};

export function Spinner({ size = 'md', className, label = '加载中' }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn('animate-spin text-ink-muted', sizeMap[size], className)}
    />
  );
}
