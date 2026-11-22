 'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Download,
  Upload,
  Video,
  MessagesSquare,
  Bot,
  Wand2,
  Brain,
  Trash2,
  BarChart3,
  BookOpen,
  Image as ImageIcon,
  AudioLines,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui';
import { isAdmin, canNovelVideo, canVideoDelivery } from '@/lib/auth';

export type QuickActionGridProps = {
  onNew: () => void;
  onImport: () => void;
  onBatchUpload: () => void;
  onVideoUpload: () => void;
  className?: string;
};

type Action = {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  highlight?: boolean;
  onClick?: () => void;
  href?: string;
  adminOnly?: boolean;  // 仅管理员可见
  gate?: () => boolean; // 自定义可见性判断(如按 feature_flag), 挂载后才求值
  /** main = 常显; more = 收进「更多工具」折叠区 */
  tier: 'main' | 'more';
};

/** 折叠区展开状态存这里 —— 老手展开一次后保持，不必每次点开 */
const MORE_OPEN_KEY = 'drafts.quickActions.moreOpen';

/**
 * QuickActionGrid — 首页入口，按**实测用量**分两层
 *
 * ## 为什么要分层（2026-09-17 重排）
 * 这个数组曾经从设计的 8 卡漂到 15 卡、全部同权重平铺，结果是新用户一进来
 * 面对 15 个并列选项无从下手。更糟的是排布和真实用量完全错配 —— 按 prod 库
 * 的功能级统计：
 *   - 生图 186 人 / 86,538 次、音频 80 人 / 5,163 次，是第一、第二大功能，
 *     **却根本没有首页入口**（只在侧栏）；
 *   - 而占着一张首页卡的「短视频流水线」历史总共只有 **1 次**，最后一次
 *     是 2026-07-01。
 *
 * 所以现在的规则是：**常显只留主流程 + 实测高频**，其余一律进折叠区。
 * 往这里加卡前先问一句"它的用量排得进前八吗"，排不进就加到 tier:'more'。
 *
 * ## 分层依据（prod 近 30 天）
 *   main: 新建/导入/批量上传/视频反推(主流程) + 对话工坊 195 人 /
 *         生图 186 人 / 音频 80 人 / 我的记忆 109 人
 *   more: 提示词速转 · Seedance 优化 · 超级 Agent(9 人) · 市场数据(11 人) ·
 *         去 AI 味(新功能，待观察) · 小说转视频(3 人,gate) · 视频交付(3 人,gate) ·
 *         回收站
 *
 * ⚠ 「短视频流水线」/clip-studio 已撤出首页（路由与代码保留，未删）。
 * ⚠ 「内容裂变工厂」/factory 与「前贴生成」/frontcut **已从用户首页撤下**（2026-09-20）。
 *    历史：它们曾是零入口孤儿路由，后来放进折叠区补了入口，
 *    但补完仍是 0 次 —— 所以按用户裁定改为「页面保留、入口只给管理员」，
 *    管理员入口在管理后台的「🧰 内部工具入口」页。
 *    撤入口时**页面与后端一行未动**，`/v1/frontcut/corpus` 尤其不能动（它在被生成链路使用）。
 * ⚠ 开发用页面（组件库演示 /kit-demo、UI 设计稿 /tools/ui-mockups）已**连页面一起删除** ——
 *    它们不是给用户看的东西，藏在 adminOnly 后面也只是让这个列表继续变长。
 *    同类需求以后走本地开发环境，不要再往用户首页加入口。
 */
export function QuickActionGrid({
  onNew,
  onImport,
  onBatchUpload,
  onVideoUpload,
  className,
}: QuickActionGridProps) {
  const router = useRouter();

  // isAdmin() 读 localStorage, SSR 时读不到会导致 hydration 不匹配;
  // 用 mounted 门控: 首帧(服务端 & 客户端首次渲染)都不显示 admin 卡, 挂载后再显示。
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // 同理: localStorage 只能在挂载后读, 首帧一律按"收起"渲染避免 hydration 不匹配
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => {
    try {
      setMoreOpen(localStorage.getItem(MORE_OPEN_KEY) === '1');
    } catch {
      /* 隐私模式下 localStorage 可能抛, 保持默认收起即可 */
    }
  }, []);

  function toggleMore() {
    setMoreOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MORE_OPEN_KEY, next ? '1' : '0');
      } catch {
        /* 存不进去不影响本次展开 */
      }
      return next;
    });
  }

  const actions: Action[] = [
    // ---- 常显: 主流程 ----
    { key: 'new', label: '新建草稿', hint: '从一句话开始创作', icon: Plus, highlight: true, onClick: onNew, tier: 'main' },
    { key: 'import', label: '导入剧本/大纲', hint: '已有剧本或大纲直接导入', icon: Download, onClick: onImport, tier: 'main' },
    // ⚠ 标签曾是「批量创建 / AI 批量起稿·打分筛选」, 但 onBatchUpload 打开的是
    //   _BatchUploadModal → POST /v1/stages/drafts/batch-upload(批量上传本地文件)。
    //   真正的 AI 批量起稿是 /v1/batch-create, 两者不是一回事 —— 标签说 A、
    //   点下去是 B, 是实打实的引导错误, 这里按真实行为改回「批量上传」。
    { key: 'batch', label: '批量上传', hint: '多个文件一次建多个草稿', icon: Upload, onClick: onBatchUpload, tier: 'main' },
    { key: 'video', label: '视频反推', hint: 'AI 自动反推剧本', icon: Video, onClick: onVideoUpload, tier: 'main' },

    // ---- 常显: 实测高频 ----
    { key: 'chat', label: '对话工坊', hint: '与 AI 对话生成', icon: MessagesSquare, href: '/chat-studio', tier: 'main' },
    { key: 'image', label: '生图', hint: '文生图 / 图生图 · 高清放大', icon: ImageIcon, href: '/image-studio', tier: 'main' },
    { key: 'audio', label: '音频生成', hint: '台词配音 · 音色选择', icon: AudioLines, href: '/audio-studio', tier: 'main' },
    { key: 'memory', label: '我的记忆', hint: '管理 AI 长期记忆', icon: Brain, href: '/settings/memories', tier: 'main' },

    // ---- 折叠区 ----
    { key: 'prompt', label: '提示词速转', hint: '剧本 → 视频提示词', icon: Wand2, href: '/tools/prompt-converter', tier: 'more' },
    { key: 'seedance-pe', label: 'Seedance 优化', hint: '原始提示词 → 标准结构化', icon: Wand2, href: '/tools/seedance-optimizer', tier: 'more' },
    { key: 'super-agent', label: '超级 Agent', hint: 'AI 总制片人 · 一句话走全流程', icon: Bot, href: '/super-agent', tier: 'more' },
    { key: 'market', label: '市场数据', hint: '抖音/红果/番茄 实时榜单', icon: BarChart3, href: '/market-data', tier: 'more' },
    // 去 AI 味：2026-10-30 起不再有独立页面入口，在剧本工作台对话栏 / 交给 Agent 里发起，直接改在草稿或副本里。
    // ⛔ 2026-09-20：内容裂变工厂 /factory 与 前贴生成 /frontcut 的入口已从这里撤下。
    //    用户原话："这俩页面可以保留，给管理员后台放两个临时入口吧。因为此页面用户暂时不用。"
    //    撤的是**用户可见的入口**，页面与后端一行未动 —— 管理员入口在管理后台
    //    「🧰 内部工具入口」页（apps/admin/src/pages/internal-tools.tsx）。
    //    ⚠️ 将来若要把它们放回首页，改这里即可；别再走"补一个入口又没人用"的老路，
    //       先想清楚给谁用（审计 §8：零入口孤儿之所以零用量，往往不是没人要而是没人找得到，
    //       而这两页的实测是"给了入口也仍然 0 次"）。
    // 小说转视频: 管理员 或 被授权的普通用户(feature_flags.novel_video)可见
    { key: 'novel-video', label: '小说转视频', hint: '小说 → 配音 + AI配图 → 成片', icon: BookOpen, href: '/novel-video', gate: canNovelVideo, tier: 'more' },
    // 视频交付: 管理员 或 被授权的普通用户(feature_flags.video_delivery)可见
    { key: 'video-delivery', label: '视频交付', hint: 'CDN 加速下载成片 · 批量交付', icon: Download, href: '/video-delivery', gate: canVideoDelivery, tier: 'more' },
    { key: 'trash', label: '回收站', hint: '30 天内可恢复', icon: Trash2, href: '/trash', tier: 'more' },
  ];

  // 可见性过滤(挂载后才求值, 避免 SSR/CSR hydration 不匹配):
  // - adminOnly: 仅管理员
  // - gate: 自定义判断(如 canNovelVideo)
  // - 其余: 所有登录用户可见
  const visibleActions = actions.filter((a) => {
    if (!mounted) return !a.adminOnly && !a.gate;
    if (a.adminOnly) return isAdmin();
    if (a.gate) return a.gate();
    return true;
  });

  const mainActions = visibleActions.filter((a) => a.tier === 'main');
  const moreActions = visibleActions.filter((a) => a.tier === 'more');

  function renderCards(list: Action[]) {
    return list.map((a) => {
      const Icon = a.icon;
      const onClick = a.onClick ?? (a.href ? () => router.push(a.href!) : undefined);
      return (
        <Card
          key={a.key}
          interactive
          padding="md"
          onClick={onClick}
          className={cn(
            'flex items-start gap-3 cursor-pointer kit-touch',
            a.highlight &&
              'bg-gradient-to-br from-primary/30 to-cyan/20 border-primary/40 hover:from-primary/40 hover:to-cyan/30',
          )}
        >
          <div
            className={cn(
              'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
              a.highlight
                ? 'bg-primary text-white shadow-glow'
                : 'bg-primary-subtle text-primary',
            )}
          >
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className={cn('text-card-title', 'text-ink-primary truncate')}>{a.label}</div>
            <div className="text-caption text-ink-muted line-clamp-1">{a.hint}</div>
          </div>
        </Card>
      );
    });
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid gap-3 grid-cols-2 tablet:grid-cols-4">{renderCards(mainActions)}</div>

      {moreActions.length > 0 && (
        <>
          <button
            type="button"
            onClick={toggleMore}
            aria-expanded={moreOpen}
            className="flex items-center gap-1.5 text-caption text-ink-muted hover:text-ink-secondary transition-colors kit-touch"
          >
            <ChevronDown
              className={cn('w-4 h-4 transition-transform', moreOpen && 'rotate-180')}
            />
            更多工具（{moreActions.length}）
          </button>
          {moreOpen && (
            <div className="grid gap-3 grid-cols-2 tablet:grid-cols-4">{renderCards(moreActions)}</div>
          )}
        </>
      )}
    </div>
  );
}
