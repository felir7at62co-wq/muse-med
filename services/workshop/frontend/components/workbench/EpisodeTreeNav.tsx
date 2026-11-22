'use client';
/**
 * 树图导航 —— 左侧按「幕 → 集」两级展开的工作台定位器（PLAN §4.2 L3 / §4.5.12）
 *
 * ## 它解决什么
 * 工作台左栏此前只有 12 个 tab（"我要看哪一类产物"），没有"**我要看哪一集**"。
 * 用户抱怨"两侧空间浪费"指的正是这个：左栏占着 240px，但只能切换视图类型，
 * 定位到第 37 集仍然要靠主区滚动。
 *
 * 所以本组件补的是**定位**，不是又一个视图 —— 点一集 = 切到对应 tab 并滚到那一集。
 *
 * ## 为什么按「幕」分组而不是平铺
 * 一部 60–100 集的短剧平铺出来是 100 行，比 tab 列表还长，等于没做导航。
 * 分组后才可能一眼看到"第三幕的问题最多"。
 *
 * ⚠️ **幕是我们自己按集号均分的，不是大纲里的字段**（大纲里没有幕这一层）。
 * 所以标题写的是"第 1–15 集"这种**区间**，而不是"第一幕"这种**文学命名**——
 * 用户如果自己按 12 集一集划分幕，我们的"第一幕"会和他的对不上，
 * 而区间是无歧义的。将来大纲真有了幕字段，这里只需改分组函数。
 *
 * ## 状态点沿用 StageChain 的口径
 * 绿=已完成 / 琥珀=过期（上游改了，这份该重做）/ 空心=还没有。
 * **不是禁用**：任何一集都可以点进去，哪怕它还是空的。
 * 与 §4.2 P2「引导不锁动作」一致。
 */
import * as React from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';

/** 一集在树里的状态（由 page.tsx 从 draft + overview 汇总好传进来）。 */
export type TreeEpisode = {
  order: number;
  title?: string;
  /** 大纲里有这一集的纲要 */
  hasOutline: boolean;
  /** 正文已生成 */
  hasChapter: boolean;
  /** 正文已过期 */
  isStale: boolean;
  /** 正文被锁定（用户原文，重写会跳过） */
  locked: boolean;
};

const EXPAND_KEY = 'workbench:treeExpandedActs';

/**
 * 按固定集数把剧切成"幕"。
 *
 * 15 是**区间长度**不是艺术判断：它让一部 60 集的剧变成 4 组、
 * 100 集变成 7 组，都在一屏可扫。真正的幕结构是内容概念，
 * 应该来自大纲（现在没有），不该由前端猜。
 */
const ACT_SIZE = 15;

type Act = { index: number; from: number; to: number; eps: TreeEpisode[] };

function groupIntoActs(eps: TreeEpisode[]): Act[] {
  const acts: Act[] = [];
  for (let i = 0; i < eps.length; i += ACT_SIZE) {
    const slice = eps.slice(i, i + ACT_SIZE);
    acts.push({
      index: acts.length + 1,
      from: slice[0]?.order ?? i + 1,
      to: slice[slice.length - 1]?.order ?? i + ACT_SIZE,
      eps: slice,
    });
  }
  return acts;
}

export type EpisodeTreeNavProps = {
  episodes: TreeEpisode[];
  /** 点某一集 → 去哪个 tab（由 page.tsx 决定：有正文就进原文，只有纲要就进大纲） */
  onPick: (order: number) => void;
  /** 折叠态（embed 的 64px）下不渲染树 —— 那里没有横向空间放集标题 */
  collapsed?: boolean;
};

export function EpisodeTreeNav({
  episodes,
  onPick,
  collapsed,
}: EpisodeTreeNavProps) {
  // 默认只展开**第一幕**：全展开等于把 100 行塞进侧栏，全折叠等于看不见内容。
  // 展开态存 localStorage，且存的是"幕号列表"不是布尔值 —— 用户可能同时展开第 1 幕和第 4 幕。
  const [expanded, setExpanded] = React.useState<number[]>([1]);

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EXPAND_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) {
        setExpanded(parsed);
      }
    } catch {
      /* 隐私模式 / 脏数据：用默认值即可，不影响使用 */
    }
  }, []);

  const toggle = React.useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = prev.includes(idx) ? prev.filter((n) => n !== idx) : [...prev, idx];
      try {
        window.localStorage.setItem(EXPAND_KEY, JSON.stringify(next));
      } catch {
        /* 存不进去只是不持久化 */
      }
      return next;
    });
  }, []);

  const acts = React.useMemo(() => groupIntoActs(episodes), [episodes]);

  // embed 的 64px 折叠态放不下集标题，渲染一个计数就够 ——
  // 那种形态下用户是在别人页面里嵌着看，不是来导航的。
  if (collapsed) {
    return (
      <div className="px-2 py-2 text-center text-[10px] text-ink-muted">
        {episodes.length} 集
      </div>
    );
  }

  if (episodes.length === 0) return null;

  const dotFor = (e: TreeEpisode) => {
    if (e.isStale) return 'bg-warning';           // 过期：最该被看见的一种
    if (e.hasChapter) return 'bg-success';        // 已完成
    if (e.hasOutline) return 'bg-primary/50';     // 只有纲要
    return 'bg-ink-muted/30';                     // 还什么都没有
  };

  return (
    <div className="px-1">
      <div className="px-2 py-1 text-micro text-ink-muted uppercase tracking-wide">
        集导航
      </div>
      {acts.map((act) => {
        const open = expanded.includes(act.index);
        const staleCount = act.eps.filter((e) => e.isStale).length;
        const doneCount = act.eps.filter((e) => e.hasChapter && !e.isStale).length;
        return (
          <div key={act.index}>
            <button
              type="button"
              onClick={() => toggle(act.index)}
              aria-expanded={open}
              className="w-full flex items-center gap-1 px-2 py-1 rounded text-xs text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06] transition-colors"
            >
              <ChevronRight
                className={cn('w-3 h-3 flex-shrink-0 transition-transform', open && 'rotate-90')}
              />
              <span className="truncate">
                第 {act.from}–{act.to} 集
              </span>
              <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 tabular-nums">
                {staleCount > 0 && (
                  <span className="text-warning" title={`${staleCount} 集过期`}>
                    {staleCount}
                  </span>
                )}
                <span className="text-ink-muted" title={`${doneCount}/${act.eps.length} 集已完成`}>
                  {doneCount}/{act.eps.length}
                </span>
              </span>
            </button>

            {open && (
              <div className="ml-3 border-l border-line/60 pl-1">
                {act.eps.map((e) => (
                  <button
                    key={e.order}
                    type="button"
                    onClick={() => onPick(e.order)}
                    title={`第 ${e.order} 集${e.title ? `：${e.title}` : ''}`}
                    className="w-full flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-left text-ink-secondary hover:text-ink-primary hover:bg-white/[0.06] transition-colors"
                  >
                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotFor(e))} />
                    <span className="tabular-nums flex-shrink-0">{e.order}</span>
                    <span className="truncate text-ink-muted">{e.title || ''}</span>
                    {e.locked && (
                      <Lock className="w-2.5 h-2.5 ml-auto flex-shrink-0 text-ink-muted" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
