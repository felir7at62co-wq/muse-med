'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  FileText,
  MessagesSquare,
  Wand2,
  Brain,
  Trash2,
  Sparkles,
  Image as ImageIcon,
  AudioLines,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Sidebar — 一级导航 (PLAN §4.2 / 02、03 号图)
 *
 * 状态:
 *  - expanded: 240px 完整态 (desktop)
 *  - collapsed: 64px 图标式 (tablet)
 *
 * 5 项一级导航 (剧本工坊):
 *   草稿 / 对话工坊 / 提示词速转 / 我的记忆 / 回收站
 *
 * 下半区按页面上下文挂载额外节点(标签筛选 / 工作台二级导航), 通过 footer/extra slot 注入.
 */

export type SidebarVariant = 'expanded' | 'collapsed';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match?: (path: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: '/drafts',
    label: '草稿',
    icon: FileText,
    match: (p) => p === '/drafts' || p.startsWith('/drafts/'),
  },
  {
    href: '/chat-studio',
    label: '对话工坊',
    icon: MessagesSquare,
  },
  {
    href: '/tools/prompt-converter',
    label: '提示词速转',
    icon: Wand2,
  },
  {
    href: '/image-studio',
    label: '生图',
    icon: ImageIcon,
    match: (p) => p === '/image-studio' || p.startsWith('/image-studio'),
  },
  {
    href: '/audio-studio',
    label: '音频生成',
    icon: AudioLines,
    match: (p) => p === '/audio-studio' || p.startsWith('/audio-studio'),
  },
  {
    href: '/billing',
    label: '我的费用',
    icon: Wallet,
    match: (p) => p === '/billing' || p.startsWith('/billing'),
  },
  {
    href: '/settings/memories',
    label: '我的记忆',
    icon: Brain,
  },
  {
    href: '/trash',
    label: '回收站',
    icon: Trash2,
  },
];

export type SidebarProps = {
  variant?: SidebarVariant;
  /** 顶部 logo / 品牌区 */
  logo?: React.ReactNode;
  /** 下半区扩展（草稿首页注入 TagsSidebar，工作台注入二级导航） */
  extra?: React.ReactNode;
  /** 底部（如：折叠按钮） */
  footer?: React.ReactNode;
  /**
   * 隐藏一级全局导航（草稿 / 对话工坊 / 提示词速转 / 我的记忆 / 回收站）+ 品牌 logo。
   * 用于 embed 模式（如对话工坊右侧 iframe 嵌入的草稿工作台），
   * 此时只应显示 extra 里的工作台二级导航，避免出现错位的一级入口。
   */
  hideNav?: boolean;
  className?: string;
};

export function Sidebar({
  variant = 'expanded',
  logo,
  extra,
  footer,
  hideNav,
  className,
}: SidebarProps) {
  const pathname = usePathname() || '/';
  const collapsed = variant === 'collapsed';

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-surface-elevated border-r border-line',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
        'transition-[width] duration-200',
        className,
      )}
      aria-label="主导航"
    >
      {/* logo: embed 模式 (hideNav) 下不显示品牌区 */}
      {!hideNav && (
        <div
          className={cn(
            'flex items-center gap-2 px-4 h-topbar border-b border-line flex-shrink-0',
            collapsed && 'justify-center px-0',
          )}
        >
          {logo ?? (
            <>
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-cyan flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              {!collapsed && (
                <span className="text-card-title font-semibold text-ink-primary truncate">
                  剧本工坊
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* 一级导航: embed 模式 (hideNav) 下不显示, 只保留 extra 里的工作台二级导航 */}
      {!hideNav && (
        <nav className="px-2 py-3 flex flex-col gap-0.5 flex-shrink-0">
          {NAV.map((it) => {
            const active = it.match ? it.match(pathname) : pathname === it.href;
            const Icon = it.icon;
            const inner = (
              <Link
                href={it.href}
                className={cn(
                  'flex items-center gap-3 rounded-md transition-colors',
                  'h-10 px-3',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-primary-subtle text-primary'
                    : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06]',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="text-body truncate">{it.label}</span>}
              </Link>
            );
            if (collapsed) {
              return (
                <Tooltip key={it.href} content={it.label} side="right">
                  {inner}
                </Tooltip>
              );
            }
            return <React.Fragment key={it.href}>{inner}</React.Fragment>;
          })}
        </nav>
      )}

      {/* 下半区扩展
          常规: 仅 expanded 显示 (collapsed tablet 态隐藏二级内容)。
          embed 折叠态 (hideNav + collapsed): 仍渲染 extra, 因为此时 extra 自身是图标态二级导航,
          这正是"折叠为极简图标按钮"的形态。 */}
      {extra && (!collapsed || hideNav) && (
        <>
          {!collapsed && <div className="mx-3 border-t border-line my-1" />}
          <div
            className={cn(
              'flex-1 overflow-y-auto kit-scroll min-h-0',
              collapsed ? 'px-1 py-2' : 'px-3 py-2',
            )}
          >
            {extra}
          </div>
        </>
      )}
      {(!extra || (collapsed && !hideNav)) && <div className="flex-1" />}

      {/* footer */}
      {footer && (
        <div
          className={cn(
            'border-t border-line p-3 flex-shrink-0',
            collapsed && 'flex justify-center',
          )}
        >
          {footer}
        </div>
      )}
    </aside>
  );
}
