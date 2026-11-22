'use client';
/**
 * 阶段链 —— 大纲 → 原文 → 剧本（PLAN §4.2 / 效果图 106、139）
 *
 * ## 最重要的一条：**不置灰、不锁动作**
 * 初版设计把未完成的阶段做成灰色禁用按钮。用户明确否掉了：
 *
 *   "新手引导把未做完或下一步置灰不合理。可以在上面以小红点标注，
 *    而不必强行锁定用户动作。"
 *
 * 这是对的。用户想先写第 20 章再回头补大纲，完全合理 —— 系统没有理由拦他。
 * 所以：**三个阶段永远是可点的彩色按钮**，未完成的只在右上角挂一个红点提示
 * "这里还有活"。红点会消（做完即灭），按钮不会变灰。
 *
 * ## 为什么不用 WorkbenchKpis 那种纯展示条
 * 纯展示的回答是"现在有多少"，而阶段链回答的是"**我下一步该做什么**" ——
 * 后者才是工作台默认视图该回答的问题（设计主线）。
 * 所以它是可点的，点一下就到那一页。
 */
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export type StageKey = 'outline' | 'chapters' | 'storyboards';

export type StageState = {
  key: StageKey;
  label: string;
  /** 已经产出的数量 */
  done: number;
  /** 计划总数（0 表示还没有大纲，无从谈起"总数"） */
  total: number;
  /** 已过期数量（上游变更导致这份是旧的） */
  stale?: number;
  /** 点击后跳到哪个 tab */
  tab: string;
};

export function StageChain({
  stages,
  onNavigate,
  className,
}: {
  stages: StageState[];
  onNavigate: (tab: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2 flex-wrap', className)}>
      {stages.map((s, i) => {
        const complete = s.total > 0 && s.done >= s.total;
        const started = s.done > 0;
        const hasStale = (s.stale || 0) > 0;
        /** 红点 = 这里还有活（没做完 / 有过期）。**它不是禁用理由，只是提示。** */
        const dot = !complete || hasStale;

        return (
          <React.Fragment key={s.key}>
            {i > 0 && <span className="text-ink-muted text-xs px-0.5">→</span>}
            <button
              type="button"
              onClick={() => onNavigate(s.tab)}
              title={
                complete
                  ? `${s.label}已完成（${s.done}/${s.total}），点击查看`
                  : started
                    ? `${s.label}进行中（${s.done}/${s.total}），点击继续`
                    : `${s.label}尚未开始，点击开始`
              }
              className={cn(
                // ⚠ 注意这里**没有** disabled / opacity-50 / cursor-not-allowed 之类的禁用样式
                'relative flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full border text-xs transition-colors',
                complete
                  ? 'border-success/40 bg-success/10 text-success hover:bg-success/15'
                  : hasStale
                    ? 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/20'
                    : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20',
              )}
            >
              <span
                className={cn(
                  'w-4 h-4 rounded-full flex items-center justify-center text-[10px] flex-shrink-0',
                  complete ? 'bg-success text-white' : 'bg-primary/20 text-primary',
                )}
              >
                {complete ? <Check className="w-2.5 h-2.5" /> : i + 1}
              </span>
              <span className="whitespace-nowrap">{s.label}</span>
              {s.total > 0 && (
                <span className="opacity-70 whitespace-nowrap tabular-nums">
                  {s.done}/{s.total}
                </span>
              )}
              {hasStale && (
                <span className="opacity-80 whitespace-nowrap">· {s.stale} 过期</span>
              )}
              {/* 红点：这里还有活。做完即灭，但按钮依然可点。 */}
              {dot && (
                <span
                  className={cn(
                    'absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full',
                    hasStale ? 'bg-warning' : 'bg-danger',
                  )}
                />
              )}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
