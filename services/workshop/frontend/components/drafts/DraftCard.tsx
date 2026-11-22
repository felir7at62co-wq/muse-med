'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Star, MoreVertical, Edit3, Tag as TagIcon, Trash2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  Card,
  DraftStatusBadge,
  Progress,
  IconButton,
  TagChip,
  DropdownMenu,
} from '@/components/ui';
import type { DraftRow, Tag } from './types';
import { mapDraftStatus, getDraftProgress } from './types';
import { draftPath } from '@/components/VersionSwitcher';

/**
 * 把封面 URL 换成缩略图 URL。
 *
 * 原图是 1536×1024 的 PNG、**平均 2MB**，而卡片只显示 ~240px 宽 ——
 * 不为显示一张邮票每次拉 2MB，是列表页卡顿的根因。
 * 后端按 `?w=` 开关返回缩略图（首次生成后落盘缓存）。
 *
 * ⚠️ 只对本服务的绝对路径（`/v1/drafts/uploads/...`）加参数：
 * 外部 URL（对象存储 / CDN）加了 `?w=` 会**打到对方服务器上**，
 * 轻则无效、重则 403。判据是"同源相对路径"。
 */
function thumbUrl(url: string): string {
  if (!url || !url.startsWith('/')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'w=240';
}

export type DraftCardProps = {
  draft: DraftRow;
  tags?: Tag[];
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  onToggleFavorite?: () => void;
  onRename?: () => void;
  onEditTags?: () => void;
  onResetStatus?: () => void;
  onDelete?: () => void;
  className?: string;
  /**
   * 小卡模式（`/v2/drafts` 的密集网格用）。
   *
   * 只留「封面 + 标题 + 一个状态点」，去掉概要/标签/进度条/更多菜单 ——
   * 那些在 ~120px 宽的卡里放不下，硬塞只会变成挤成一团的噪点。
   * 收藏星保留（它是高频动作，且只有一个图标位）。
   */
  compact?: boolean;
};

/**
 * DraftCard — 草稿卡片（PLAN §5.4 + 01 号图）
 *
 * 字段:
 *  - Cover (cover_url 或渐变 fallback)
 *  - 标题 + 收藏星
 *  - StatusBadge
 *  - 概要 (line-clamp-2)
 *  - Tag 列表
 *  - MetaStats (章节/集数/创建/更新)
 *  - Progress 条
 *  - 主操作: 点击进入工作台
 *  - MoreMenu: 改名/标签/重置/移入回收站
 */
export function DraftCard({
  draft,
  tags = [],
  selected,
  onSelectChange,
  onToggleFavorite,
  onRename,
  onEditTags,
  onResetStatus,
  onDelete,
  className,
  compact,
}: DraftCardProps) {
  const router = useRouter();
  const status = mapDraftStatus(draft.status);
  const progress = getDraftProgress(draft);
  const generating = status === 'generating';

  const meta: string[] = [];
  if (draft.chapter_count) meta.push(`${draft.chapter_count} 章`);
  if (draft.expected_chapters) meta.push(`计划 ${draft.expected_chapters} 集`);
  if (draft.storyboard_count) meta.push(`${draft.storyboard_count} 剧本`);

  const onCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, [data-no-nav]')) return;
    // ⚠️ 不要写死 `/drafts/{id}`：本卡片同时被新版列表页（/v2/drafts）复用，
    // 写死的结果是**新版用户点任何一张卡片都被丢回旧版工作台**（切换按钮形同虚设）。
    router.push(draftPath(draft.id));
  };

  /**
   * 封面图层 —— 紧凑模式与普通模式共用。
   *
   * 抽出来而不是在两处各写一遍：里面既有缩略图 URL 转换、又有懒加载与
   * 尺寸占位，重复一份就多一处会漂移的地方（新版列表卡顿正是这种漂移的后果）。
   */
  const coverNode = (
    <div className="relative aspect-[16/9] bg-gradient-to-br from-primary/30 to-cyan/20 overflow-hidden">
      {draft.cover_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbUrl(draft.cover_url)}
          alt={draft.title}
          // 缩略图约 16:9。写死 width/height 让浏览器**在图片到达前就留好位**，
          // 避免列表边加载边跳动（CLS）。
          width={compact ? 240 : 480}
          height={compact ? 135 : 270}
          // ⚠️ 懒加载：一屏几十张卡片时，只有视口内的才去请求。
          // 这是"打开全部草稿卡很久"的第二半 —— 第一半是图太大（见 thumbUrl）。
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center select-none">
          <span className={cn('text-white/30 font-bold', compact ? 'text-lg' : 'text-display')}>
            {(draft.title || '?').charAt(0).toUpperCase()}
          </span>
        </div>
      )}

      {/* 顶部覆盖：选择框 + 收藏 */}
      <div className="absolute top-2 left-2" data-no-nav>
        {onSelectChange && (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={(e) => onSelectChange(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 accent-primary cursor-pointer"
            aria-label={`选择 ${draft.title}`}
          />
        )}
      </div>

      <div className={cn('absolute right-2 flex items-center gap-1', compact ? 'top-1 right-1' : 'top-2')} data-no-nav>
        {!compact && draft.quality_score != null && (
          <span
            className={
              'rounded-md px-1.5 py-0.5 text-[11px] font-semibold ' +
              (draft.quality_score >= 80
                ? 'bg-success/20 text-success'
                : draft.quality_score >= 60
                ? 'bg-warning/20 text-warning'
                : 'bg-white/10 text-ink-muted')
            }
            title="剧情分析综合评分"
          >
            {draft.quality_score}分
          </span>
        )}
        {!compact && <DraftStatusBadge status={status} size="sm" />}
        {/* 小卡里的收藏星要缩：24px 的按钮压在 120px 宽的卡上会盖住封面主体 */}
        {onToggleFavorite && compact && (
          <button
            type="button"
            aria-label={draft.is_favorite ? '取消收藏' : '收藏'}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className="rounded bg-surface-base/60 backdrop-blur p-0.5 leading-none"
          >
            <Star className={cn('w-3 h-3', draft.is_favorite ? 'fill-warning text-warning' : 'text-ink-muted')} />
          </button>
        )}
        {onToggleFavorite && !compact && (
          <IconButton
            aria-label={draft.is_favorite ? '取消收藏' : '收藏'}
            size="sm"
            variant="subtle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className={cn(
              'bg-surface-base/60 backdrop-blur',
              draft.is_favorite && 'text-warning',
            )}
          >
            <Star className={cn(draft.is_favorite && 'fill-warning text-warning')} />
          </IconButton>
        )}
      </div>

      {generating && (
        <div className="absolute bottom-0 left-0 right-0">
          <Progress
            indeterminate={progress === null}
            percent={progress ?? 0}
            tone="primary"
            size="xs"
          />
        </div>
      )}
    </div>
  );

  // ── 小卡模式：只有封面 + 标题 ──
  // 概要/标签/元信息/进度条/底部操作全部去掉 —— 在 ~120px 宽的卡里
  // 它们是噪点而不是信息。要那些信息就用列表视图（同一页面可切换）。
  if (compact) {
    return (
      <Card
        interactive
        padding="none"
        className={cn(
          'flex flex-col overflow-hidden cursor-pointer group',
          selected && 'ring-2 ring-primary',
          className,
        )}
        onClick={onCardClick}
        title={`${draft.title || '(未命名草稿)'}${draft.chapter_count ? ` · ${draft.chapter_count} 章` : ''}`}
      >
        {coverNode}
        <div className="px-1.5 py-1">
          <h3 className="text-[11px] leading-tight text-ink-primary line-clamp-2">
            {draft.title || '(未命名)'}
          </h3>
          {/* 「N 章 · 计划 N 集 · N 剧本」——
              ⚠️ 这行原来只在非 compact 分支有（下方 281 行），而新版 /v2/drafts
              默认就是网格视图(compact)，于是新版卡片上这组数字整个消失了
              （2026-09-24 用户反馈"原版有、V2 没有"）。
              密集网格里空间紧，所以用 10px + 单行截断，不换行不撑高卡片。 */}
          {meta.length > 0 && (
            <p className="text-[10px] leading-tight text-ink-muted mt-0.5 truncate tabular-nums">
              {meta.join(' · ')}
            </p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card
      interactive
      padding="none"
      className={cn(
        'flex flex-col overflow-hidden cursor-pointer',
        selected && 'ring-2 ring-primary',
        className,
      )}
      onClick={onCardClick}
    >
      {coverNode}

      {/* 主体 */}
      <div className="flex flex-col gap-2 p-4 flex-1">
        <h3 className="text-card-title text-ink-primary line-clamp-1">
          {draft.title || '(未命名草稿)'}
        </h3>
        {/* 来源用户标签: 仅管理员视角后端会下发 owner_label, 普通用户看不到 */}
        {draft.owner_label && (
          <span
            className="inline-flex items-center gap-1 self-start rounded-full bg-primary/10 px-2 py-0.5 text-micro text-primary"
            title={`来源用户: ${draft.owner_label}`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            {draft.owner_label}
          </span>
        )}
        {draft.user_input && (
          <p className="text-caption text-ink-muted line-clamp-2 leading-relaxed">
            {draft.user_input}
          </p>
        )}
        {tags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {tags.slice(0, 4).map((t) => (
              <TagChip key={t.id} label={t.name} color={t.color} size="sm" />
            ))}
            {tags.length > 4 && (
              <span className="text-micro text-ink-muted">+{tags.length - 4}</span>
            )}
          </div>
        )}
        {progress !== null && !generating && (
          <Progress percent={progress} tone="primary" size="xs" />
        )}
        <div className="flex items-center justify-between text-micro text-ink-muted mt-auto pt-1">
          <span className="truncate">
            {meta.join(' · ') || '—'}
          </span>
          <span className="flex-shrink-0">
            {formatRelative(draft.updated_at)}
          </span>
        </div>
      </div>

      {/* footer 操作 */}
      <div
        className="flex items-center justify-end gap-1 px-2 pb-2 border-t border-line/40 pt-2"
        data-no-nav
        onClick={(e) => e.stopPropagation()}
      >
        {onResetStatus && generating && (
          <IconButton
            /* 审计 §2.4：同一个按钮此前有**两个名字** —— aria 叫「重置生成状态」、
               title 叫「重置卡住的状态」。读屏用户与鼠标用户看到的是两件事，
               统一为「重置状态」。 */
            aria-label="重置状态"
            size="sm"
            variant="ghost"
            onClick={onResetStatus}
            title="重置状态（把卡住的生成标记清掉，不动已有内容）"
          >
            <RefreshCw />
          </IconButton>
        )}
        {onEditTags && (
          <IconButton aria-label="编辑标签" size="sm" variant="ghost" onClick={onEditTags}>
            <TagIcon />
          </IconButton>
        )}
        {onRename && (
          <IconButton aria-label="改名" size="sm" variant="ghost" onClick={onRename}>
            <Edit3 />
          </IconButton>
        )}
        {onDelete && (
          <DropdownMenu
            trigger={
              <IconButton aria-label="更多" size="sm" variant="ghost">
                <MoreVertical />
              </IconButton>
            }
            items={[
              {
                label: '移入回收站',
                icon: <Trash2 className="w-4 h-4" />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          />
        )}
      </div>
    </Card>
  );
}

/* 简易相对时间 */
function formatRelative(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
