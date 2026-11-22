'use client';
import * as React from 'react';
import { Search, Bell, Menu } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/IconButton';

export type TopBarProps = {
  /** 左侧标题区（草稿名 / 页面名） */
  left?: React.ReactNode;
  /** 中间搜索 / 工具区 */
  center?: React.ReactNode;
  /** 右侧用户菜单 / 通知 */
  right?: React.ReactNode;
  /** mobile 时显示侧边栏开关按钮 */
  onMenuClick?: () => void;
  className?: string;
};

/**
 * TopBar — 顶栏 (PLAN §4.3 / 02 号图)
 *  高度 64px, 左侧一般留给草稿标题/面包屑, 右侧通知 + 用户菜单.
 *  默认中间空槽供页面注入搜索框 / 主操作.
 */
export function TopBar({ left, center, right, onMenuClick, className }: TopBarProps) {
  return (
    <header
      className={cn(
        'h-topbar flex items-center gap-3 px-4 desktop:px-6',
        'border-b border-line bg-surface-elevated/80 backdrop-blur',
        'flex-shrink-0',
        className,
      )}
    >
      {onMenuClick && (
        <IconButton
          aria-label="打开侧边菜单"
          onClick={onMenuClick}
          variant="ghost"
          size="md"
          className="desktop:hidden"
        >
          <Menu />
        </IconButton>
      )}
      <div className="flex-shrink-0 min-w-0 max-w-[40%]">{left}</div>
      <div className="flex-1 min-w-0 flex items-center justify-center">
        {center ?? (
          /* 默认占位：空 div，让右侧靠右 */
          <div />
        )}
      </div>
      <div className="flex-shrink-0 flex items-center gap-1">
        {right ?? (
          <>
            <IconButton aria-label="搜索" variant="ghost">
              <Search />
            </IconButton>
            <IconButton aria-label="通知" variant="ghost">
              <Bell />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}
