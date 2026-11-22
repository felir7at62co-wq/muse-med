'use client';
/**
 * 工作台左栏树图 —— 「幕 → 集」两级定位（PLAN §4.2 L3 / §4.5.12）
 *
 * ## 它解决什么
 * 一屏里只放十几个集名是没有意义的；一部 100 集的剧平铺出来比正文还长。
 * 所以按**幕**分组（每组固定 15 集），展开才能看到集 ——
 * 一眼能看到"哪一幕有问题"，而不是面对 100 行。
 *
 * ⚠️ **幕是按集号均分的，不是大纲里的字段**（大纲没有幕这一层）。
 * 所以标题写"第 1–15 集"这种**区间**，而不是"第一幕"这种**文学命名**：
 * 用户若自己按 12 集划分幕，我们的"第一幕"会和它对不上，区间则无歧义。
 * 将来大纲真有了幕字段，只需改 `groupIntoActs`。
 *
 * ## 状态点沿用全局口径
 * 绿=已完成 / 琥珀=过期 / 蓝=只有纲要 / 灰=还没有。
 * **不是禁用**：任何一集都可点，哪怕还是空的（§4.2 P2 引导不锁动作）。
 */
import * as React from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';

export type NavEpisode = {
  order: number;
  title?: string;
  hasOutline: boolean;
  hasChapter: boolean;
  isStale: boolean;
  locked: boolean;
};

const EXPAND_KEY = 'workbench_v2_tree_expanded';
/** 每幕集数 —— 区间长度而非艺术判断：60 集=4 组、100 集=7 组，都在一屏可扫 */
const ACT_SIZE = 15;

type Act = { index: number; from: number; to: number; eps: NavEpisode[] };

function groupIntoActs(eps: NavEpisode[]): Act[] {
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

export function WorkbenchTree({
  episodes, focusOrder, onPick,
}: {
  episodes: NavEpisode[];
  focusOrder: number | null;
  onPick: (order: number) => void;
}) {
  // 默认展开**含当前焦点的那一幕**；没有焦点时展开第一幕。
  // 默认全展开等于把 100 行塞进 240px 的栏，全折叠等于看不见内容。
  const [expanded, setExpanded] = React.useState<number[]>([]);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(EXPAND_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Array.isArray(p) && p.every((n) => typeof n === 'number')) { setExpanded(p); return; }
      }
    } catch { /* 脏数据用默认值 */ }
    setExpanded([1]);
  }, []);

  // 焦点集落在哪一幕，就保证那一幕是展开的 —— 否则"点了一集但树里看不到它"
  React.useEffect(() => {
    if (focusOrder == null) return;
    const idx = Math.floor((focusOrder - 1) / ACT_SIZE) + 1;
    setExpanded((prev) => {
      if (prev.includes(idx)) return prev;
      const next = [...prev, idx];
      try { localStorage.setItem(EXPAND_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, [focusOrder]);

  const toggle = React.useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = prev.includes(idx) ? prev.filter((n) => n !== idx) : [...prev, idx];
      try { localStorage.setItem(EXPAND_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  const acts = React.useMemo(() => groupIntoActs(episodes), [episodes]);

  if (episodes.length === 0) {
    return (
      <p className="px-3 py-2 fs-meta text-ink-muted leading-5">
        还没有分集大纲 —— 在中间和 AI 说一句「生成大纲」就会出现。
      </p>
    );
  }

  const dotFor = (e: NavEpisode) => {
    if (e.isStale) return 'bg-warning';
    if (e.hasChapter) return 'bg-success';
    if (e.hasOutline) return 'bg-primary/50';
    return 'bg-ink-muted/30';
  };

  return (
    <nav aria-label="集导航">
      {acts.map((act) => {
        const open = expanded.includes(act.index);
        const stale = act.eps.filter((e) => e.isStale).length;
        const done = act.eps.filter((e) => e.hasChapter && !e.isStale).length;
        return (
          <div key={act.index}>
            <button
              type="button"
              onClick={() => toggle(act.index)}
              aria-expanded={open}
              className="w-full flex items-center gap-1 px-2 py-1 fs-meta text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay transition-colors"
            >
              <ChevronRight className={cn('w-3 h-3 flex-shrink-0 transition-transform', open && 'rotate-90')} />
              <span className="truncate">第 {act.from}–{act.to} 集</span>
              <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 tabular-nums">
                {stale > 0 && <span className="text-warning" title={`${stale} 集过期`}>{stale}</span>}
                <span className="text-ink-muted" title={`${done}/${act.eps.length} 已完成`}>
                  {done}/{act.eps.length}
                </span>
              </span>
            </button>

            {open && (
              <div className="ml-3 border-l border-line/60 pl-0.5">
                {act.eps.map((e) => {
                  const active = focusOrder === e.order;
                  return (
                    <button
                      key={e.order}
                      type="button"
                      onClick={() => onPick(e.order)}
                      title={e.locked
                        // ⚠️ 以前这里只有"第N集：标题"，锁图标没有任何解释。
                        // 而 locked 是个**用户无从操作**的字段（导入剧本时后端自动打标，
                        // 前端没有解锁入口），于是导入的草稿每一集都挂着一把
                        // 既没说明、也点不掉的锁 —— 用户只会困惑。
                        // 现在把来龙去脉说清楚。2026-10-06 起「强制重写」已能穿透锁，
                        // 所以这里不再暗示"这集改不了"。
                        ? `第 ${e.order} 集${e.title ? `：${e.title}` : ''}（原文导入时自动标记为已锁定，用于导出时优先取原文。不影响「强制重写」）`
                        : `第 ${e.order} 集${e.title ? `：${e.title}` : ''}`}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'w-full flex items-center gap-1.5 px-2 py-0.5 fs-meta text-left transition-colors',
                        active
                          ? 'bg-primary-subtle text-primary'
                          : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay',
                      )}
                    >
                      <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotFor(e))} />
                      <span className="tabular-nums flex-shrink-0">{e.order}</span>
                      <span className="truncate text-ink-muted">{e.title || ''}</span>
                      {e.locked && <Lock className="w-2.5 h-2.5 ml-auto flex-shrink-0 text-ink-muted" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
