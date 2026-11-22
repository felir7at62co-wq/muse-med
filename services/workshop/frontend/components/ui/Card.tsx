import * as React from 'react';
import { cn } from '@/lib/cn';

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  /** 是否使用玻璃质感（默认 true）；false 用纯 elevated 背景 */
  glass?: boolean;
  /** hover 时是否有抬升动效 */
  interactive?: boolean;
  /** padding 预设：none / sm / md(default) / lg */
  padding?: 'none' | 'sm' | 'md' | 'lg';
};

const padMap: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { glass = true, interactive, padding = 'md', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-line shadow-card',
        glass ? 'kit-card' : 'bg-surface-elevated',
        interactive && 'transition-colors transition-shadow hover:border-line-hover hover:shadow-overlay cursor-pointer',
        padMap[padding],
        className,
      )}
      {...rest}
    />
  );
});

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 mb-3', className)}>
      <div className="flex-1 min-w-0">
        <h3 className="text-card-title text-ink-primary leading-snug">{title}</h3>
        {description && (
          <p className="mt-0.5 text-caption text-ink-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-body text-ink-secondary', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 mt-4 pt-3 border-t border-line',
        className,
      )}
      {...rest}
    />
  );
}
