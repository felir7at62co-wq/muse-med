"use client";
/**
 * 改前 / 改后 对照块
 *
 * **用户明确要求的形式**（原话：*"之前预设的那种文本块形式左右分别是原文和修改后的文本
 * 似乎并没有实现"*）：左栏原文、右栏改后，并排的两个文本块，逐集列出。
 * 不做 diff 高亮算法 —— 中文长文本的字符级 diff 在窄栏里反而更难读，
 * 用户要的是"我扫一眼就知道改了什么"，并排原文/改后已经够了。
 *
 * 数据来自 `GET /v1/agent/jobs/{id}/changes`：改前取自 `script_episode_history`
 * （精修覆写每集前存的那条），改后是当前 `ScriptChapter.full_text` /
 * `ScriptStoryboard.shots_json` 摊平后的文本。
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";

export type DiffItem = {
  episode: number;
  stage: string;              // chapter | storyboard
  stage_label: string;        // 正文 | 剧本
  before: string;
  after: string;
  before_chars: number;
  after_chars: number;
  truncated: boolean;
  changed: boolean;
};

export type DiffPayload = {
  items: DiffItem[];
  total: number;
  changed_total: number;
  job_id: number;
  kind: string;
  note?: string;
  result?: { scope_label?: string } | null;
};

/** 层级筛选。all = 不筛。 */
type StageFilter = "all" | "chapter" | "storyboard";

function deltaLabel(before: number, after: number): string {
  const d = after - before;
  if (d === 0) return "字数不变";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d} 字`;
}

function OneEpisode({ it, index }: { it: DiffItem; index: number }) {
  // 默认展开**改动过**的集，未改动/字数不变的收起 —— 几十集的剧全展开会糊成一片。
  const [open, setOpen] = useState(it.changed && index < 3);
  return (
    <div className="my-2 rounded-lg border border-line overflow-hidden bg-surface-base/40">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-overlay/40 border-b border-line hover:bg-surface-overlay text-left"
      >
        {open ? <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
              : <ChevronRight className="w-3 h-3 text-ink-muted shrink-0" />}
        <span className="text-ink-primary font-medium">
          第 {it.episode} 集 · {it.stage_label}
        </span>
        <span className={`ml-auto text-[10px] ${it.changed ? "text-success" : "text-ink-muted"}`}>
          {it.changed ? `已改（${it.before_chars} → ${it.after_chars} 字，${deltaLabel(it.before_chars, it.after_chars)}）` : "本次未改动"}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-2 divide-x divide-line">
          <div className="p-3 min-w-0">
            <div className="text-[11px] text-ink-muted mb-1">原文</div>
            <div className="text-sm text-ink-secondary whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
              {it.before || <span className="text-ink-muted">（原本为空）</span>}
            </div>
          </div>
          <div className="p-3 min-w-0">
            <div className="text-[11px] text-success mb-1">改后</div>
            <div className="text-sm text-ink-primary whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
              {it.after || <span className="text-ink-muted">（改后为空）</span>}
            </div>
          </div>
        </div>
      )}
      {open && it.truncated && (
        <div className="px-3 py-1 text-[11px] text-ink-muted border-t border-line">
          这一集太长，这里只显示前 6000 字。要看全文请到草稿页。
        </div>
      )}
    </div>
  );
}

export default function RewriteDiff({ data }: { data: DiffPayload }) {
  const items = data.items || [];
  const [stage, setStage] = useState<StageFilter>("all");
  const [changedOnly, setChangedOnly] = useState(false);
  const [q, setQ] = useState("");

  /**
   * 两个筛选维度都必须**先于**早退判断算出来。
   *
   * 早退那条（"这次没有产生可对照的改动"）说的是"整个作业都没有改动"，
   * 用 `items.length` 判即可；但**筛选后为空**是另一回事 —— 那时要显示
   * "当前筛选下没有结果"，绝不能复用同一条文案，否则用户会以为这次精修白跑了。
   * 2026-10-07 用户就是被同类"消息与事实不符"坑过（报告点名要修的集恰好没被改）。
   */
  // 哪些层级真的存在 —— 只有一种层级时不必给筛选按钮（点了也没变化）
  const stages = useMemo(
    () => Array.from(new Set(items.map((i) => i.stage))),
    [items],
  );
  const shown = useMemo(() => {
    const kw = q.trim();
    return items.filter((i) => {
      if (stage !== "all" && i.stage !== stage) return false;
      if (changedOnly && !i.changed) return false;
      if (kw) {
        // 搜**正文内容**，不是搜集号：用户想找"中秋"那句话在哪一集，
        // 集号他本来就知道。两侧任一命中即算（他想看的那句可能在改后才有/才没）。
        if (!i.before.includes(kw) && !i.after.includes(kw)) return false;
      }
      return true;
    });
  }, [items, stage, changedOnly, q]);

  if (!items.length) {
    return (
      <div className="my-2 rounded-lg border border-line bg-surface-base/40 px-3 py-2 text-xs text-ink-secondary">
        这次没有产生可对照的改动（模型认为无需修改，或作业没有覆写任何一集）。
      </div>
    );
  }
  return (
    <div className="my-2">
      <div className="flex items-center gap-1.5 text-xs text-ink-secondary mb-1">
        <FileDiff className="w-3.5 h-3.5 text-primary shrink-0" />
        <span>
          改前 / 改后对照 —— 共 {data.total} 集，其中{" "}
          <span className="text-ink-primary font-medium">{data.changed_total} 集有改动</span>
          {data.result?.scope_label ? `（范围：${data.result.scope_label}）` : ""}
        </span>
      </div>

      {/* 筛选行。正文与剧本是**两份稿子**，混在一起看要来回滚，
          用户要求拆开（2026-10-07）。层级按钮只在两种都存在时才给。 */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        {stages.length > 1 && (
          <div className="flex items-center rounded border border-line overflow-hidden">
            {([["all", "全部"], ["chapter", "正文"], ["storyboard", "剧本"]] as const)
              .filter(([k]) => k === "all" || stages.includes(k))
              .map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setStage(k)}
                  className={`px-2 py-0.5 text-[11px] border-r border-line last:border-r-0 ${
                    stage === k
                      ? "bg-primary/15 text-ink-primary font-medium"
                      : "text-ink-secondary hover:bg-surface-overlay"
                  }`}
                >
                  {label}
                  {k !== "all" && (
                    <span className="ml-1 text-ink-muted">
                      {items.filter((i) => i.stage === k).length}
                    </span>
                  )}
                </button>
              ))}
          </div>
        )}
        <label className="flex items-center gap-1 text-[11px] text-ink-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)}
            className="accent-primary"
          />
          只看改动过的
        </label>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜正文内容…"
          className="px-2 py-0.5 text-[11px] rounded border border-line bg-surface-base text-ink-primary w-40"
        />
        {shown.length !== items.length && (
          <span className="text-[11px] text-ink-muted">
            显示 {shown.length} / {items.length} 集
            <button
              type="button"
              onClick={() => { setStage("all"); setChangedOnly(false); setQ(""); }}
              className="ml-1 underline decoration-dotted hover:text-ink-primary"
            >
              清除筛选
            </button>
          </span>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface-base/40 px-3 py-2 text-xs text-ink-secondary">
          当前筛选下没有符合条件的集（这次共 {data.total} 集，
          其中 {data.changed_total} 集有改动）。
        </div>
      ) : (
        shown.map((it, i) => <OneEpisode key={`${it.stage}-${it.episode}`} it={it} index={i} />)
      )}
      <div className="text-[10px] text-ink-muted mt-1">
        点标题栏可以收起/展开某一集。原文每集都存了历史版本，可以在草稿页回滚。
      </div>
    </div>
  );
}
