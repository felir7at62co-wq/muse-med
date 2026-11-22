'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileText, MessagesSquare, Wand2, Brain, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * BottomTabNav — mobile (<768) 底部固定 Tab Bar (PLAN §29.2)
 *  仅 5 个核心入口, 与 Sidebar 一致, 但缩为 icon + 短文字
 */

type Item = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match?: (path: string) => boolean;
};

const ITEMS: Item[] = [
  { href: '/drafts', label: '草稿', icon: FileText, match: (p) => p === '/drafts' || p.startsWith('/drafts/') },
  { href: '/chat-studio', label: '对话', icon: MessagesSquare },
  { href: '/tools/prompt-converter', label: '速转', icon: Wand2 },
  { href: '/settings/memories', label: '记忆', icon: Brain },
  { href: '/trash', label: '回收', icon: Trash2 },
];

export type BottomTabNavProps = {
  className?: string;
};

export function BottomTabNav({ className }: BottomTabNavProps) {
  const pathname = usePathname() || '/';
  return (
    <nav
      className={cn(
        'h-bottom-tab flex items-stretch border-t border-line',
        'bg-surface-elevated/95 backdrop-blur',
        'flex-shrink-0',
        className,
      )}
      aria-label="底部导航"
    >
      {ITEMS.map((it) => {
        const active = it.match ? it.match(pathname) : pathname === it.href;
        const Icon = it.icon;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors',
              'kit-touch',
              active ? 'text-primary' : 'text-ink-muted hover:text-ink-secondary',
            )}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[11px] leading-tight">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
