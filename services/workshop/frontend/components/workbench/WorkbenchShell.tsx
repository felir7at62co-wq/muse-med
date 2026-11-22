'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Maximize2, Minimize2, Sparkles } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { WorkbenchSidebar } from './WorkbenchSidebar';
import type { WorkbenchTab } from './types';
import { Button } from '@/components/ui/Button';
import { toVersionedHref, getUiVersion } from '@/components/VersionSwitcher';
import { cn } from '@/lib/cn';

export type WorkbenchShellProps = {
  /** 草稿标题, 显示在 TopBar */
  draftTitle?: string;
  /** 草稿 id, 用于返回按钮 */
  draftId?: number | string;
  /** 当前激活 tab */
  tab: WorkbenchTab;
  /** tab 变化回调 */
  onTabChange: (tab: WorkbenchTab) => void;
  /** 各 tab 角标 */
  badges?: Partial<Record<WorkbenchTab, React.ReactNode>>;
  /** 哪些 tab 禁用 */
  disabledTabs?: WorkbenchTab[];
  /** 顶部右侧自定义 (模型选择 / 状态等) */
  topRight?: React.ReactNode;
  /** 顶部公告 */
  announcement?: React.ReactNode;
  /**
   * embed 模式 (如对话工坊右侧 iframe 嵌入的草稿工作台):
   * 隐藏一级全局导航 (草稿/对话工坊/提示词速转/我的记忆/回收站), 只保留工作台二级导航。
   */
  embed?: boolean;
  /**
   * bare 模式 (超级 Agent 右侧分屏): 在 embed 基础上, 彻底隐藏左侧工作台二级导航栏,
   * 把全部宽度让给草稿内容 (用户在 AI 页已有自己的导航/对话, 不需要草稿页的左栏)。
   */
  bare?: boolean;
  /**
   * 内容区是否铺满 (走 AppShell 的 fluid)。
   *
   * 为什么聚焦模式需要它: 内容区默认套着 `max-w-content`(1440px) + 居中,
   * 宽屏下两侧会各留出一大块空白 —— 那恰恰是"聚焦阅读"要消灭的东西。
   * 传 true 才真正把正文吃满。见 §4.5.9 的无界设计。
   */
  fluid?: boolean;
  /** 树图导航节点（B10），已渲染好；不传则左栏只有 tab 列表 */
  tree?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * WorkbenchShell — 工作台壳 (PLAN §6.2 / 02、03 号图)
 *
 * 把传统的"顶部 KitTabs"替换为"左侧 240px Sidebar (一级导航 + 工作台二级分组导航)"。
 * 使用方式:
 *   <WorkbenchShell tab={tab} onTabChange={setTab} draftTitle={draft.title}>
 *     {tab === 'overview' && <Overview/>}
 *     {tab === 'outline' && <Outline/>}
 *     ...
 *   </WorkbenchShell>
 */
/** embed 态二级导航折叠状态的持久化 key（'1' 折叠 / '0' 展开）。 */
const NAV_COLLAPSED_KEY = 'workbench:navCollapsed';

export function WorkbenchShell({
  draftTitle,
  draftId,
  tab,
  onTabChange,
  badges,
  disabledTabs,
  topRight,
  announcement,
  embed,
  bare,
  fluid,
  tree,
  children,
}: WorkbenchShellProps) {
  const router = useRouter();

  /**
   * 聚焦阅读模式（PLAN §4.2 L2「阅读优先」）。
   *
   * 展开成什么: 收起二级导航 + 去掉内容区 1440px 上限, 把宽度全给正文。
   * 这与 embed 的折叠**不是同一件事** —— embed 折叠后仍占 64px 图标条,
   * 而"读正文时不该有任何常驻侧栏", 所以这里整个不渲染 Sidebar。
   *
   * 只放本地 state、**不持久化**: 它是"我此刻在专心读"的临时状态,
   * 记住它会让用户下次进来以为是页面坏了（导航不见了）。
   */
  const [focus, setFocus] = React.useState(false);

  const toggleFocus = React.useCallback(() => setFocus((v) => !v), []);

  /**
   * `F` 键切换聚焦模式。
   *
   * ⚠️ 三个必须挡住的输入场景, 少一个都会让快捷键变成 bug:
   *   1. 正在输入框/文本域里打字 —— 按 F 是在输入内容, 不是快捷键;
   *      草稿工作台的正文就是 `contentEditable` 的, 所以还要查 `isContentEditable`;
   *   2. 按下了 Cmd/Ctrl/Alt —— 那是 `Cmd+F` 查找之类的浏览器快捷键, 不能抢;
   *   3. embed/bare 态不接: 那种情形下工作台是**别人页面里的 iframe**,
   *      在里面按 F 把壳收起会让人莫名其妙, 而且外层根本没有恢复按钮。
   */
  React.useEffect(() => {
    if (embed || bare) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      }
      e.preventDefault();
      toggleFocus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embed, bare, toggleFocus]);

  // embed 模式 (iframe 嵌入): 二级导航默认折叠为紧凑态, 把空间让给草稿正文。
  // 用户可点折叠按钮展开, 选择记在 localStorage —— 对话工坊每换一个草稿, 右侧
  // iframe 的 src 就变了(是新文档), 不持久化的话每次都弹回折叠态, 展开等于白点。
  const [navCollapsed, setNavCollapsed] = React.useState<boolean>(!!embed);

  // 首帧用 SSR 默认值, 挂载后再读 localStorage —— 直接在 useState 初值里读会
  // 导致 hydration mismatch (服务端没有 window)。
  React.useEffect(() => {
    if (!embed) return;
    try {
      const v = window.localStorage.getItem(NAV_COLLAPSED_KEY);
      if (v === '0' || v === '1') setNavCollapsed(v === '1');
    } catch {
      /* 隐私模式 / 禁用 storage: 保持默认折叠即可, 不影响功能 */
    }
  }, [embed]);

  const toggleNav = React.useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 同上, 写不进去只是不持久化 */
      }
      return next;
    });
  }, []);

  return (
    <AppShell
      announcement={announcement}
      hideSidebar={bare || focus}
      hideSidebarNav={embed || bare}
      sidebarVariant={embed && !bare ? (navCollapsed ? 'collapsed' : 'expanded') : undefined}
      fluid={focus}
      sidebar={bare || focus ? undefined : {
        extra: (
          <WorkbenchSidebar
            active={tab}
            onChange={onTabChange}
            badges={badges}
            disabledTabs={disabledTabs}
            draftId={draftId}
            tree={tree}
            collapsed={embed ? navCollapsed : false}
            onToggleCollapse={embed ? toggleNav : undefined}
          />
        ),
      }}
      topBar={{
        left: draftTitle ? (
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(toVersionedHref('/drafts', getUiVersion()))}
              aria-label="返回草稿列表"
              className="!px-2"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <span className="text-ink-muted text-body truncate">草稿 /</span>
            <span className="text-ink-primary font-semibold truncate">{draftTitle}</span>
          </div>
        ) : null,
        right: (
          <div className="flex items-center gap-2">
            {topRight}
            {/* 「质量」常驻入口（PLAN §3.4 / B9）。
                去味、精修、体检三个能力**按裁定统一收归对话工坊**，
                工作台不再各开一个 tab。但"入口保留 ≠ 到处开入口"不等于
                "在工作台里找不到它" —— 那样用户只能靠记 URL。
                所以这里留**一个**常驻按钮，点过去时**带上当前草稿**
                （?draft=<id>，由对话工坊读取并自动关联），
                用户不需要在那边再选一次剧。 */}
            {!embed && !bare && draftId != null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => router.push(`/chat-studio?draft=${draftId}`)}
                title="去味 / 精修 / 体检都在对话工坊，点这里带着本剧过去"
                className="!px-2"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="hidden tablet:inline">质量</span>
              </Button>
            )}
            {/* 聚焦模式开关。embed/bare 态不渲染 —— 那时工作台在别人的 iframe 里,
                收起侧栏既没有意义, 也没有恢复按钮。 */}
            {!embed && !bare && (
              <button
                type="button"
                onClick={toggleFocus}
                aria-pressed={focus}
                title={focus ? '退出聚焦阅读（F）' : '聚焦阅读：收起两侧，正文吃满（F）'}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors',
                  focus
                    ? 'border-primary/50 text-primary bg-primary/10'
                    : 'border-line text-ink-muted hover:text-ink-primary hover:border-line-strong',
                )}
              >
                {focus ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                <span className="hidden tablet:inline">{focus ? '退出聚焦' : '聚焦'}</span>
              </button>
            )}
          </div>
        ),
      }}
    >
      {children}
    </AppShell>
  );
}
