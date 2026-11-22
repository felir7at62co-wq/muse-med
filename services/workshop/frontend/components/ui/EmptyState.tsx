import * as React from 'react';
import { cn } from '@/lib/cn';
import { Inbox } from 'lucide-react';

export type EmptyStateProps = {
  /** 自定义图标节点 */
  icon?: React.ReactNode;
  /** 图标用 lucide 名称(默认 Inbox) — 给 icon prop 传更灵活 */
  illustration?: string; // path to webp/svg, 后期 image2 生成的插画
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 主 / 次 双 CTA */
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** 紧凑模式 (内嵌进卡片用) */
  compact?: boolean;
  className?: string;
};

export function EmptyState({
  icon,
  illustration,
  title,
  description,
  primaryAction,
  secondaryAction,
  compact,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 px-4 gap-2' : 'py-16 px-6 gap-3',
        className,
      )}
    >
      {illustration ? (
        <img
          src={illustration}
          alt=""
          className={cn('mb-2 select-none', compact ? 'w-20 h-20' : 'w-40 h-28 object-contain')}
        />
      ) : (
        <div
          className={cn(
            'flex items-center justify-center rounded-full bg-white/[0.04]',
            compact ? 'w-12 h-12' : 'w-16 h-16',
          )}
        >
          {icon ?? (
            <Inbox className={cn(compact ? 'w-6 h-6' : 'w-8 h-8', 'text-ink-muted')} />
          )}
        </div>
      )}
      <h3
        className={cn(
          'text-ink-primary font-semibold',
          compact ? 'text-card-title' : 'text-section-title',
        )}
      >
        {title}
      </h3>
      {description && (
        <p className="max-w-md text-body text-ink-secondary leading-relaxed">{description}</p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-2 flex items-center gap-2 flex-wrap justify-center">
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
