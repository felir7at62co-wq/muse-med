import { cn } from '@/lib/cn';

export type AvatarProps = {
  src?: string | null;
  alt?: string;
  /** 没有 src 时, 用 name 首字符做 fallback */
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** placeholder: 灰色虚线占位（用于"AI 生成中"等态） */
  variant?: 'default' | 'placeholder';
  className?: string;
};

const sizeMap: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-caption',
  md: 'w-10 h-10 text-body',
  lg: 'w-14 h-14 text-card-title',
  xl: 'w-20 h-20 text-section-title',
};

export function Avatar({
  src,
  alt,
  name,
  size = 'md',
  variant = 'default',
  className,
}: AvatarProps) {
  const initial = (name || alt || '?').trim().charAt(0).toUpperCase();
  const placeholder = variant === 'placeholder';

  if (src) {
    return (
      <img
        src={src}
        alt={alt || name || ''}
        className={cn(
          'inline-block rounded-full object-cover bg-white/[0.04]',
          sizeMap[size],
          className,
        )}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={alt || name || 'avatar'}
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold select-none',
        sizeMap[size],
        placeholder
          ? 'border border-dashed border-line text-ink-muted bg-transparent'
          : 'bg-primary-subtle text-primary',
        className,
      )}
    >
      {initial}
    </span>
  );
}
