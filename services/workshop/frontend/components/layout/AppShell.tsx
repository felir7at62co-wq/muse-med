'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Sidebar, type SidebarProps } from './Sidebar';
import { TopBar, type TopBarProps } from './TopBar';
import { BottomTabNav } from './BottomTabNav';
import { Drawer } from '@/components/ui/Drawer';
import { useBreakpoint } from '@/hooks/useBreakpoint';

export type AppShellProps = {
  /** Sidebar 配置（直接透传给 Sidebar），传空则使用默认 5 项导航 */
  sidebar?: Omit<SidebarProps, 'variant'>;
  /** TopBar 配置 */
  topBar?: Omit<TopBarProps, 'onMenuClick'>;
  /** 顶部公告条 */
  announcement?: React.ReactNode;
  /** 是否在 mobile 显示底部 Tab Bar (默认 true) */
  showBottomTab?: boolean;
  /** 是否禁用 Sidebar (登录页等) */
  hideSidebar?: boolean;
  /**
   * 隐藏 Sidebar 一级全局导航 + 品牌 logo, 只保留 sidebar.extra (二级导航)。
   * 用于 embed 模式 (iframe 嵌入的工作台)。
   */
  hideSidebarNav?: boolean;
  /**
   * 覆盖 Sidebar 宽度形态 (collapsed 64px / expanded 240px)。
   * 提供时忽略断点自动判定, 由调用方完全控制 (如 embed 模式的折叠开关)。
   */
  sidebarVariant?: 'expanded' | 'collapsed';
  /** 是否禁用 TopBar */
  hideTopBar?: boolean;
  /** 内容区是否需要内边距 (默认 true) */
  contentPadding?: boolean;
  /** 内容区是否撑满宽度 (默认 false) */
  fluid?: boolean;
  className?: string;
  children: React.ReactNode;
};

/**
 * AppShell — 全局壳 (PLAN §4.1)
 *
 *  桌面布局 (desktop / wide):
 *  ┌───────────────────────────────────────┐
 *  │ Announcement                          │
 *  ├──────────┬────────────────────────────┤
 *  │ Sidebar  │ TopBar                     │
 *  │  240px   ├────────────────────────────┤
 *  │          │ Content                    │
 *  └──────────┴────────────────────────────┘
 *
 *  平板 (tablet): Sidebar 自动 collapsed (64px)
 *  移动 (mobile): Sidebar 改为 Drawer 触发；底部 BottomTabNav
 */
export function AppShell({
  sidebar,
  topBar,
  announcement,
  showBottomTab = true,
  hideSidebar,
  hideSidebarNav,
  sidebarVariant,
  hideTopBar,
  contentPadding = true,
  fluid = false,
  className,
  children,
}: AppShellProps) {
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const isTablet = bp === 'tablet';

  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    // h-screen + overflow-hidden: 外壳锁定为视口高度, 只让内容区 <main> 滚动,
    // 侧边栏/顶栏固定不随内容滚走 (需求1: 修复"滚动文本时左侧工作台+顶部导航一起滚动")。
    <div className={cn('h-screen overflow-hidden flex flex-col bg-surface-base text-ink-primary', className)}>
      {announcement && <div className="flex-shrink-0">{announcement}</div>}

      <div className="flex-1 flex min-h-0">
        {/* desktop / wide / tablet: 固定侧边栏
            embed 模式 (hideSidebarNav): 强制 expanded 固定渲染, 不受窄 iframe 断点影响,
            否则 tablet 会 collapsed 隐藏二级导航 / mobile 会走抽屉导致整块空置 */}
        {!hideSidebar && (!isMobile || hideSidebarNav) && (
          <Sidebar
            variant={
              sidebarVariant ??
              (!hideSidebarNav && isTablet ? 'collapsed' : 'expanded')
            }
            hideNav={hideSidebarNav}
            {...sidebar}
          />
        )}

        {/* mobile: 抽屉版 sidebar (embed 模式不使用抽屉) */}
        {!hideSidebar && isMobile && !hideSidebarNav && (
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            side="left"
            size="sm"
            hideCloseButton
          >
            <Sidebar variant="expanded" {...sidebar} className="border-r-0" />
          </Drawer>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          {!hideTopBar && (
            <TopBar
              {...topBar}
              onMenuClick={isMobile && !hideSidebar ? () => setDrawerOpen(true) : undefined}
            />
          )}

          <main
            className={cn(
              'flex-1 min-h-0 overflow-y-auto kit-scroll',
              contentPadding && 'p-4 desktop:p-6',
            )}
          >
            <div className={cn(fluid ? 'w-full' : 'max-w-content mx-auto w-full')}>{children}</div>
          </main>

          {isMobile && showBottomTab && <BottomTabNav />}
        </div>
      </div>
    </div>
  );
}
