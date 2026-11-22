'use client';
import { cn } from '@/lib/cn';
import { X } from 'lucide-react';

export type TagChipProps = {
  label: string;
  /** 自定义颜色（用户标签可能是任意 hex），优先级高于 tone */
  color?: string;
  /** 是否选中 */
  active?: boolean;
  /** 可关闭（带 X） */
  onRemove?: () => void;
  /** 点击 */
  onClick?: () => void;
  size?: 'sm' | 'md';
  className?: string;
};

const sizeMap: Record<NonNullable<TagChipProps['size']>, string> = {
  sm: 'h-6 px-2 text-[11px] gap-1',
  md: 'h-7 px-2.5 text-caption gap-1.5',
};

/**
 * TagChip — 标签芯片
 * - 支持任意自定义色（用户在标签管理里设置的 hex）
 * - 可点击 / 可关闭 / 选中态
 */
export function TagChip({
  label,
  color,
  active,
  onRemove,
  onClick,
  size = 'md',
  className,
}: TagChipProps) {
  // 自定义色: 用 inline style 处理半透明背景 + 实色文字
  const styleProps = color
    ? {
        backgroundColor: hexWithAlpha(color, active ? 0.32 : 0.18),
        color: color,
        borderColor: active ? color : 'transparent',
      }
    : undefined;

  return (
    <span
      onClick={onClick}
      style={styleProps}
      className={cn(
        'inline-flex items-center font-medium rounded-full border transition-colors',
        sizeMap[size],
        !color && (active ? 'bg-primary-subtle text-primary border-primary/40' : 'bg-white/[0.06] text-ink-secondary border-line'),
        onClick && 'cursor-pointer hover:opacity-90',
        className,
      )}
    >
      <span className="truncate max-w-[160px]">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 -mr-1 p-0.5 rounded-full hover:bg-white/10 transition-colors"
          aria-label={`移除 ${label}`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

/** 把 hex 转 rgba */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
