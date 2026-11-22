'use client';
import * as React from 'react';
import { ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Popover, type PopoverPlacement } from './Popover';

export type DropdownItem =
  | {
      type?: 'item';
      label: React.ReactNode;
      icon?: React.ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      onSelect?: () => void;
    }
  | { type: 'separator' }
  | { type: 'label'; label: React.ReactNode };

export type DropdownMenuProps = {
  trigger: React.ReactElement;
  items: DropdownItem[];
  placement?: PopoverPlacement;
  /** 菜单最小宽度 px */
  minWidth?: number;
  className?: string;
};

/**
 * DropdownMenu — 基于 Popover 的下拉菜单。
 * 不支持嵌套子菜单（如需要后续扩展）。
 */
export function DropdownMenu({
  trigger,
  items,
  placement = 'bottom-end',
  minWidth = 200,
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover
      trigger={trigger}
      placement={placement}
      open={open}
      onOpenChange={setOpen}
      contentClassName={cn('p-1', className)}
    >
      <ul role="menu" style={{ minWidth }} className="flex flex-col gap-0.5">
        {items.map((it, idx) => {
          if ((it as any).type === 'separator') {
            return <li key={idx} role="separator" className="my-1 mx-2 border-t border-line" />;
          }
          if ((it as any).type === 'label') {
            return (
              <li
                key={idx}
                className="px-3 py-1.5 text-micro text-ink-muted uppercase tracking-wide"
              >
                {(it as { label: React.ReactNode }).label}
              </li>
            );
          }
          const item = it as Extract<DropdownItem, { type?: 'item' }>;
          return (
            <li key={idx} role="none">
              <button
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.();
                  setOpen(false);
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-md text-body text-left',
                  'transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  item.danger
                    ? 'text-danger hover:bg-danger-subtle'
                    : 'text-ink-primary hover:bg-white/[0.06]',
                )}
              >
                {typeof item.checked === 'boolean' && (
                  <span className="w-4 flex-shrink-0 flex items-center justify-center">
                    {item.checked && <Check className="w-3.5 h-3.5 text-primary" />}
                  </span>
                )}
                {item.icon && (
                  <span className="flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4 text-ink-secondary">
                    {item.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="text-micro text-ink-muted ml-2">{item.shortcut}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

/* 子菜单标志（保留接口，后续扩展） */
export const ChevronRightIcon = ChevronRight;
