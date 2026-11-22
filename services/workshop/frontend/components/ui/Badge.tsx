import { cn } from '@/lib/cn';
import { type Tone, toneClasses } from './_statusColors';

export type BadgeProps = {
  tone?: Tone;
  /** soft: 浅底色 + 文字色 (默认) / solid: 实色 / outline: 边框色 */
  variant?: 'soft' | 'solid' | 'outline';
  /** 是否带左侧圆点 */
  withDot?: boolean;
  /** 尺寸 */
  size?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
};

const sizeMap: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-[10px] gap-1 rounded',
  md: 'px-2 py-0.5 text-micro gap-1.5 rounded-md',
};

export function Badge({
  tone = 'muted',
  variant = 'soft',
  withDot,
  size = 'md',
  className,
  children,
}: BadgeProps) {
  const t = toneClasses[tone];
  const variantCls =
    variant === 'soft'
      ? cn(t.bg, t.text)
      : variant === 'solid'
        ? cn(
            tone === 'muted'
              ? 'bg-white/10 text-ink-primary'
              : tone === 'primary'
                ? 'bg-primary text-white'
                : tone === 'cyan'
                  ? 'bg-cyan text-surface-base'
                  : tone === 'success'
                    ? 'bg-success text-white'
                    : tone === 'warning'
                      ? 'bg-warning text-surface-base'
                      : tone === 'danger'
                        ? 'bg-danger text-white'
                        : tone === 'info'
                          ? 'bg-info text-white'
                          : '',
          )
        : cn('bg-transparent border', t.text, t.border);

  return (
    <span
      className={cn(
        'inline-flex items-center font-medium leading-none whitespace-nowrap',
        sizeMap[size],
        variantCls,
        className,
      )}
    >
      {withDot && <span className={cn('w-1.5 h-1.5 rounded-full', t.dot)} />}
      {children}
    </span>
  );
}
