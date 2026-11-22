'use client';
import * as React from 'react';
import {
  LayoutDashboard,
  Eye,
  ListTree,
  FileText,
  Clapperboard,
  Video,
  ImageIcon,
  LineChart,
  ShieldAlert,
  Users,
  Download,
  Sparkles,
  Wand2,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  BookOpen,
  MessageSquareQuote,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui';
import { Tooltip } from '@/components/ui/Tooltip';
import type { WorkbenchTab } from './types';

export type WorkbenchSidebarItem = {
  value: WorkbenchTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 角标：数字、状态点、字符串 */
  badge?: React.ReactNode;
  /** 是否禁用（功能依赖未就绪） */
  disabled?: boolean;
  /** 折叠态（64px）下显示的短标签。缺省时用 label —— 超过 3 字必须给。 */
  short?: string;
  /** 分组。与上一项不同则在其上方画一条分隔线。 */
  group?: string;
};

export type WorkbenchSidebarProps = {
  active: WorkbenchTab;
  onChange: (tab: WorkbenchTab) => void;
  /** 各 tab 的角标，按 tab key 提供 */
  badges?: Partial<Record<WorkbenchTab, React.ReactNode>>;
  /** 哪些 tab 禁用 */
  disabledTabs?: WorkbenchTab[];
  className?: string;
  /**
   * 折叠为紧凑态（embed 模式，64px 侧栏）：
   * 图标 + 二字短标签竖排 + 分组分隔线，hover 仍给全名。
   * 曾是"纯图标 + tooltip"，但 tooltip 被 Sidebar 的 overflow-y-auto 横向裁掉
   * （见 Tooltip.tsx 注释），13 个图标零文字零提示，实测无法辨识。
   */
  collapsed?: boolean;
  /**
   * 折叠/展开切换回调。提供时在顶部渲染一个切换按钮。
   * 不提供则不显示切换按钮（如普通桌面工作台）。
   */
  onToggleCollapse?: () => void;
  /**
   * 当前草稿 id。提供时在导航末尾渲染一个「质量」入口，
   * 跳到对话工坊并**带上这部草稿**（`/chat-studio?draft=<id>`）。
   *
   * 去味/精修/体检按入口审计裁定统一收归对话工坊，工作台不再各开 tab；
   * 但"入口保留 ≠ 到处开入口"不等于"在这里找不到它"—— 那样用户只能靠记 URL。
   */
  draftId?: number | string;
  /**
   * 树图导航（PLAN §4.2 L3 / B10）：按「幕 → 集」定位，已渲染好的节点。
   * 不传则不渲染 —— 没有大纲的草稿本来就没有集可分。
   */
  tree?: React.ReactNode;
};

// 注: tab key 必须与 page.tsx 内部的 useState 类型完全一致, 否则点击后主区显示空白
// group: 折叠态(64px)按组画分隔线; short: 折叠态下的短标签(>3 字必须给)。
const ITEMS: Omit<WorkbenchSidebarItem, 'badge' | 'disabled'>[] = [
  // 总览页已合并 分析/安全/角色/人物圣经 四块内容 (v2)
  { value: 'overview', label: '总览', icon: LayoutDashboard, group: 'nav' },
  { value: 'preview', label: '预览', icon: Eye, group: 'nav' },
  { value: 'outline', label: '大纲', icon: ListTree, group: '产物' },
  { value: 'chapters', label: '原文', icon: FileText, group: '产物' },
  { value: 'storyboards', label: '剧本', icon: Clapperboard, group: '产物' },
  { value: 'novel', label: '小说', icon: BookOpen, group: '产物' },
  { value: 'tweet', label: '推文', icon: MessageSquareQuote, group: '产物' },
  { value: 'prompts', label: '提示词', icon: Video, group: '制作' },
  { value: 'images', label: '生图', icon: ImageIcon, group: '制作' },
  { value: 'export', label: '导出', icon: Download, group: '制作' },
  { value: 'extend', label: '续写', icon: Sparkles, group: '工具' },
  { value: 'adapt', label: '改编', icon: Wand2, group: '工具' },
  // ⛔ 2026-09-18 入口审计裁定：整本 AI 精修的独立入口已停用 ——
  //    能力已收归对话工坊的「精修这批」按钮（用户裁定原话："这些功能已经完全被
  //    对话工坊中的精修这批按钮替换，旧逻辑都可以不要"）。替换方覆盖范围圈定与
  //    模型选择，且能看改前/改后对照，比工作台里的独立 tab 更好用。
  //    ⚠️ 后端 /v1/rewrite 保留 —— 对话工坊走的正是它。
  //    恢复：取消本行注释 + 恢复 page.tsx 的 critique tab 渲染段。
  // { value: 'critique', label: '整本AI精修', icon: ScanSearch, short: '精修', group: '工具' },
];

/**
 * WorkbenchSidebar — 草稿工作台二级导航（PLAN §6.2 / 02 号图）
 *
 * 挂在主 Sidebar 的 extra slot 内，sticky 滚动。
 * 两种形态：
 *  - 完整态：纵向列表，图标 + 文字 + 角标
 *  - 折叠态 (collapsed)：图标 + 二字短标签竖排 + 分组分隔线，宽 64px，用于 embed 模式省空间
 */
export function WorkbenchSidebar({
  active,
  onChange,
  badges,
  disabledTabs,
  className,
  collapsed,
  onToggleCollapse,
  draftId,
  tree,
}: WorkbenchSidebarProps) {
  const disabled = new Set(disabledTabs || []);
  return (
    <nav
      className={cn('flex flex-col gap-1', className)}
      aria-label="草稿工作台二级导航"
    >
      {/* 顶部：标题 + 折叠切换按钮 */}
      <div
        className={cn(
          'flex items-center',
          collapsed ? 'justify-center px-0 py-1' : 'justify-between px-3 py-1',
        )}
      >
        {!collapsed && (
          <span className="text-micro text-ink-muted uppercase tracking-wide">
            工作台
          </span>
        )}
        {onToggleCollapse && (
          <Tooltip content={collapsed ? '展开导航' : '折叠导航'} side="right">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="p-1 rounded-md hover:bg-white/[0.06] text-ink-secondary hover:text-ink-primary transition-colors"
              aria-label={collapsed ? '展开导航' : '折叠导航'}
            >
              {collapsed ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
          </Tooltip>
        )}
      </div>

      {ITEMS.map((it, idx) => {
        const Icon = it.icon;
        const isActive = active === it.value;
        const isDisabled = disabled.has(it.value);
        const badge = badges?.[it.value];
        // 折叠态按组分隔：组名变化时在上方补一条细线，帮助纵向定位。
        const newGroup = collapsed && idx > 0 && ITEMS[idx - 1].group !== it.group;
        const btn = (
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => !isDisabled && onChange(it.value)}
            className={cn(
              'group flex rounded-md transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              collapsed
                ? // 竖排：图标在上、短标签在下。宽度撑满 56px 内容区，不再依赖 hover 才知道是什么。
                  'flex-col items-center justify-center gap-0.5 h-12 w-full px-0 text-center'
                : 'items-center gap-2 px-3 h-9 text-body text-left',
              isActive
                ? collapsed
                  ? 'bg-primary-subtle text-primary'
                  : 'bg-primary-subtle text-primary border-l-2 border-primary -ml-px pl-[10px]'
                : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06]',
            )}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {collapsed ? (
              <span className="text-[10px] leading-none tracking-tight">
                {it.short ?? it.label}
              </span>
            ) : (
              <span className="flex-1 truncate">{it.label}</span>
            )}
            {!collapsed && badge != null && badge !== '' && (
              <Badge tone={isActive ? 'primary' : 'muted'} size="sm" variant="soft">
                {badge}
              </Badge>
            )}
          </button>
        );
        if (collapsed) {
          // 折叠态仍保留 tooltip：短标签是缩写(如 精修)，hover 给出全名 + 角标。
          const tip =
            badge != null && badge !== '' ? `${it.label} · ${badge}` : it.label;
          return (
            <React.Fragment key={it.value}>
              {newGroup && <div className="mx-2 border-t border-line my-1" />}
              <Tooltip content={tip} side="right">
                {btn}
              </Tooltip>
            </React.Fragment>
          );
        }
        return <React.Fragment key={it.value}>{btn}</React.Fragment>;
      })}

      {/* 树图导航（B10）：按「幕 → 集」定位。
          放在 tab 列表**之前** —— 左「定位」右「操作」（原则 P5），
          定位是"我要去哪"，比"我要看哪一类"更靠前。 */}
      {tree && (
        <>
          <div className="mx-2 border-t border-line my-2" />
          {tree}
        </>
      )}

      {/* 「质量」常驻入口（PLAN §3.4 / B9）。
          为什么放在导航**末尾**而不是最上面：工作台的 12 个 tab 是"看/改本页产物"，
          这个按钮是"离开本页去另一处干活"—— 性质不同，不该混进上面的分组里抢位置。
          也刻意不做成第 13 个 tab：它不是本页的一个视图，点它是要跳走的。 */}
      {draftId != null && (
        <>
          <div className="mx-2 border-t border-line my-2" />
          <Tooltip content="去味 / 精修 / 体检都在对话工坊，点这里带着本剧过去" side="right">
            <a
              href={`/chat-studio?draft=${draftId}`}
              className={cn(
                'group flex rounded-md transition-colors text-ink-secondary hover:text-primary hover:bg-primary-subtle',
                collapsed
                  ? 'flex-col items-center justify-center gap-0.5 h-12 w-full px-0 text-center'
                  : 'items-center gap-2 px-3 h-9 text-body',
              )}
            >
              <ScanSearch className="w-4 h-4 flex-shrink-0 text-primary/80" />
              {collapsed ? (
                <span className="text-[10px] leading-none tracking-tight">质量</span>
              ) : (
                <span className="flex-1 truncate">质量（去味 / 精修 / 体检）</span>
              )}
            </a>
          </Tooltip>
        </>
      )}
    </nav>
  );
}