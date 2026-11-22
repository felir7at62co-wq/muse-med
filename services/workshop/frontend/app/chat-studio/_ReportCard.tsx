"use client";

// 对话工坊 v3 · 体检报告卡
//
// 这张卡是"体检 → 定点修复"闭环的界面。设计要点：
//
//  1. **贴在对话流里**，不是在另一个页面。用户点「一键体检」→ 卡片出现在气泡下方
//     → 就地勾选 → 就地修。全程不离开对话工坊（用户原话：不能让用户在各个页面
//     之间来回跳转）。
//
//  2. **每条问题都能单独修**。这是它和"整本精修"的根本区别：整本精修是覆写整本、
//     要跑几十分钟；定点修复只改你点的那几条涉及到的集，两分钟出结果。用户看完
//     报告最自然的动作就是"这条先改掉"，所以按钮必须长在每一条上，而不是只在
//     卡头放一个"全修"。
//
//  3. **只回传 issue_id**。内容以服务端 check_reports 为准 —— 前端被篡改也不可能
//     让引擎去修一条凭空捏造的问题。
//
//  4. **改完必复检，数字没降就照实说**。卡片上显示"修前 12 → 修后 7"，这个数字
//     来自复检（后端算的），不是模型自我报告。没降下来时卡片上直接写
//     "这次没改到位"，并给回滚的提示 —— 不假装成功。

import { useMemo, useState } from "react";
import {
  AlertTriangle, Info, ChevronDown, ChevronRight, Wand2, ShieldCheck,
  MinusCircle, Loader2, RotateCcw, CheckCircle2, Square, CheckSquare, MinusSquare,
} from "lucide-react";

export type CheckIssue = {
  id: string;
  level: "error" | "warn" | string;
  code?: string;
  episode?: number | null;
  message: string;
  fix_hint?: string;
  kind?: string;
  kind_label?: string;
};

export type FixResult = {
  before_error?: number; before_warn?: number;
  error?: number; warn?: number;
  touched_eps?: number[];
  report_id?: number;
  improved?: boolean;
  notes?: string[];
};

export type CheckReport = {
  report_id?: number;
  draft_id?: number;
  title?: string;
  scope_label?: string;
  kinds?: string[];
  checks?: Record<string, { error?: number; warn?: number; issues?: CheckIssue[]; ok?: boolean; error_msg?: string }>;
  issues_flat?: CheckIssue[];
  totals?: { error?: number; warn?: number; episodes?: number; scanned?: number };
  elapsed_ms?: number;
};

const SEV_LABEL: Record<string, string> = { error: "硬伤", warn: "提醒", info: "参考" };

/**
 * 类别展示顺序。中文名**优先用后端下发的 `kind_label`**（engine.py 的
 * `KIND_LABEL`），这里只定顺序、并给没有 kind_label 的老报告兜个底。
 * 不再自己维护一份中文映射 —— 那套只写了 4 类，`divergence` 上线后
 * （2026-09-21 起属默认五类）就会在卡上显示成英文键名。
 */
const KIND_ORDER = ["structure", "style", "consistency", "script", "divergence"];
const KIND_FALLBACK: Record<string, string> = {
  structure: "结构体检", style: "文风体检", consistency: "一致性体检",
  script: "剧本体检", divergence: "大纲与稿子分岔",
};

export default function ReportCard({
  report,
  fix,
  fixing,
  onFix,
}: {
  report: CheckReport;
  fix?: FixResult | null;
  fixing?: boolean;
  onFix: (issueIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showWarn, setShowWarn] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  /** 被展开的同类分组（默认收起 —— 56 条同类问题铺开会把卡淹没） */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  /** 类别筛选：空集 = 全部。与「只看硬伤」是两个独立维度，可叠加。 */
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());

  const issues = useMemo(() => {
    if (report.issues_flat?.length) return report.issues_flat;
    // 兼容: 老报告没有 issues_flat, 从 checks 里现摊一份
    const out: CheckIssue[] = [];
    for (const [k, c] of Object.entries(report.checks || {})) {
      // 老报告没带 kind_label，这里补一份；新报告一律用后端的（见 KIND_ORDER 注释）
      for (const it of (c.issues || [])) out.push({ ...it, kind: k, kind_label: it.kind_label || KIND_FALLBACK[k] || k });
    }
    return out;
  }, [report]);

  // 三档必须分开数。原先 `!== "error"` 把 info 也算进"提醒"，
  // 而 `divergence`（大纲与稿子分岔）产的正是 info，且引擎的 totals.warn
  // 本来就不含它 —— 卡头于是把"参考"报成"提醒"，与后端口径对不上。
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  const infos = issues.filter((i) => i.level === "info");

  /**
   * 类别分组的权威中文名来自**后端**（`engine.py` 的 `KIND_LABEL`，
   * 经 issues_flat 的 kind_label 下发）。前端不再自己写一套 ——
   * 之前那套只覆盖 4 类，`divergence`（2026-09-21 起是默认五类之一）
   * 会原样吐出英文键名。KIND_FALLBACK 仅供没有 kind_label 的老报告兜底。
   */
  const byKind = useMemo(() => {
    const m = new Map<string, { label: string; items: CheckIssue[] }>();
    for (const it of issues) {
      const k = it.kind || "";
      if (!m.has(k)) m.set(k, { label: it.kind_label || KIND_FALLBACK[k] || k || "其他", items: [] });
      m.get(k)!.items.push(it);
    }
    // 固定顺序在前，未列出的按首次出现顺序排后面
    return [...m.entries()].sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a[0]), ib = KIND_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [issues]);

  /** 通过类别筛选 + 严重度筛选之后还要显示的问题 */
  const shown = useMemo(() => {
    let out = issues;
    if (kindFilter.size) out = out.filter((i) => kindFilter.has(i.kind || ""));
    if (!showWarn) out = out.filter((i) => i.level === "error");
    return out;
  }, [issues, kindFilter, showWarn]);

  /**
   * 同类跨集合并：同一个 kind 下 `code` 相同的收成一行（"hook_in_missing ×56"）。
   * 实测草稿 707 的一份 60 条结构报告，这样折叠后只剩 4 行 —— 逐集刷屏的
   * `hook_in_missing` 不再把真正该看的 3 条硬伤挤出视野。
   *
   * 合并**只影响展示**：折叠行的勾选等于全选/全不选该组，回传的仍是逐条 id
   * 数组，后端一个字节都不用改。
   */
  const rows = useMemo(() => {
    const groups = new Map<string, CheckIssue[]>();
    const order: string[] = [];
    for (const it of shown) {
      // 合并键 = kind + code + **文案骨架**。
      //
      // 为什么不能只按 code：`name_drift`（人名漂移）每一条的 message 里
      // 都是**不同的人名对**（"林晚/林婉" vs "张三/张四"），只按 code 合并
      // 会把互不相干的两处漂移挤成一行，而行的正文只显示 `items[0].message`
      // —— 用户看到"名字漂移 ×5"，展开前完全不知道其实是 5 个不同的人，
      // 也没法判断该不该点「全改」。
      //
      // 去掉数字后归并「第X集」这类差异，既保留"同一处问题跨集刷屏"的折叠效果
      // （hook_in_missing 的 56 条文案骨架完全相同），又不会把不同指涉混为一谈。
      const skeleton = (it.message || "").replace(/\d+/g, "#");
      const gk = `${it.kind || ""}\u0000${it.code || it.id}\u0000${skeleton}`;
      if (!groups.has(gk)) { groups.set(gk, []); order.push(gk); }
      groups.get(gk)!.push(it);
    }
    return order.map((gk) => {
      const items = groups.get(gk)!;
      if (items.length === 1) return { key: gk, items, single: true } as const;
      return { key: gk, items, single: false } as const;
    });
  }, [shown]);

  //: 能真正被修复的 id —— 空 id 的问题（LLM 语义层那批）后端取不到，
  //: 点「改这个」只会回一句"报告可能已过期"。与其让用户点了才发现，不如不给他勾。
  const fixable = useMemo(() => shown.filter((i) => !!i.id), [shown]);

  const totals = report.totals || {};
  const noProblem = errs.length === 0 && warns.length === 0;

  /** 报告被截断时漏掉了多少条（后端 MAX_ISSUES=60，按区块截） */
  const truncatedNote = useMemo(() => {
    let hidden = 0;
    for (const c of Object.values(report.checks || {})) {
      const t = Number((c as any).total || 0);
      const n = (c.issues || []).length;
      if (t > n) hidden += t - n;
    }
    return hidden;
  }, [report]);

  const toggle = (id: string) => {
    if (!id) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleMany = (ids: string[]) => {
    const real = ids.filter(Boolean);
    if (!real.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = real.every((x) => next.has(x));
      for (const x of real) { if (allOn) next.delete(x); else next.add(x); }
      return next;
    });
  };
  const toggleAll = () => {
    const ids = fixable.map((i) => i.id);
    setSelected((prev) => (ids.length && ids.every((x) => prev.has(x)) ? new Set() : new Set(ids)));
  };
  const toggleKind = (k: string) => {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /** 一行问题（单条，或合并组展开后的子项）的完整渲染 */
  const renderItem = (it: CheckIssue) => {
    const canFix = !!it.id;
    const on = selected.has(it.id);
    const open = openId === it.id;
    return (
      <div key={it.id || `${it.code}-${it.episode}`} className={`px-3 py-1.5 ${on ? "bg-primary/5" : ""}`}>
        <div className="flex items-start gap-2">
          <button
            onClick={() => toggle(it.id)}
            disabled={!canFix}
            className="mt-0.5 shrink-0 disabled:opacity-30"
            title={canFix ? "勾选后可以单独让 AI 改这一条" : "这条问题没有可定位的编号，无法定点修复"}
          >
            {on ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5 text-ink-muted" />}
          </button>
          {it.level === "error"
            ? <AlertTriangle className="w-3.5 h-3.5 text-danger mt-0.5 shrink-0" />
            : <Info className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {it.episode != null && (
                <span className="text-[10px] px-1 rounded bg-surface-raised border border-line text-ink-secondary shrink-0">
                  第{it.episode}集
                </span>
              )}
              {/* 严重度用文字点出来：过去每条只显示所属类别（kind_label），
                  硬伤与提醒的区别只剩图标颜色，扫一眼分不出轻重。 */}
              <span className={`text-[10px] shrink-0 ${it.level === "error" ? "text-danger" : "text-warning"}`}>
                {SEV_LABEL[it.level] || it.level}
              </span>
              <span className="text-xs text-ink-primary break-words">{it.message}</span>
            </div>
            {(it.fix_hint || it.code) && (
              <button onClick={() => setOpenId(open ? null : it.id)}
                className="text-[10px] text-ink-muted hover:text-primary mt-0.5">
                {open ? "收起" : "怎么改 / 详情"}
              </button>
            )}
            {open && (
              <div className="mt-1 text-[11px] text-ink-secondary bg-surface-base/60 rounded px-2 py-1 leading-snug">
                {it.fix_hint && <div><span className="text-ink-muted">建议改法：</span>{it.fix_hint}</div>}
                {it.code && <div className="text-[10px] text-ink-muted font-mono mt-0.5">{it.code}</div>}
              </div>
            )}
          </div>
          {canFix ? (
            <button
              disabled={fixing}
              onClick={() => onFix([it.id])}
              title="只改这一条涉及到的集：AI 会看到这一集的原文和这条问题，做最小改动，其余一字不碰。"
              className="shrink-0 px-1.5 py-0.5 rounded border border-line hover:border-primary/60 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40 flex items-center gap-1"
            >
              <Wand2 className="w-3 h-3" />改这个
            </button>
          ) : (
            <span className="shrink-0 text-[10px] text-ink-muted" title="这条问题没有编号，无法定点修复；用「整本精修」或重新生成更合适">
              不可定点修
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-1.5 ml-1 mr-1 rounded-lg border border-line bg-surface-overlay/70 overflow-hidden">
      {/* ── 卡头 ── */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-line bg-surface-raised/60">
        <ShieldCheck className={`w-4 h-4 shrink-0 ${errs.length ? "text-danger" : warns.length ? "text-warning" : "text-emerald-500"}`} />
        <button onClick={() => setCollapsed((v) => !v)} className="flex items-center gap-1 text-xs font-semibold text-ink-primary">
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          体检报告
        </button>
        {report.title && <span className="text-xs text-ink-muted truncate">《{report.title}》</span>}
        <span className="text-[10px] text-ink-muted">
          {report.scope_label || "整本"} · 扫了 {totals.scanned ?? totals.episodes ?? 0} 集 · {Math.round((report.elapsed_ms || 0) / 100) / 10}s
        </span>
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          {errs.length > 0 && <span className="text-danger font-medium">{errs.length} 硬伤</span>}
          {warns.length > 0 && <span className="text-warning">{warns.length} 提醒</span>}
          {infos.length > 0 && <span className="text-ink-muted">{infos.length} 参考</span>}
          {noProblem && <span className="text-emerald-500 font-medium">未发现问题</span>}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* ── 类别筛选（按问题性质分组，点选切换；空选 = 全部）── */}
          {byKind.length > 0 && (
            <div className="px-3 py-1.5 flex flex-wrap gap-1.5 border-b border-line/60 items-center">
              <span className="text-[10px] text-ink-muted shrink-0">类别：</span>
              {byKind.map(([k, g]) => {
                const on = kindFilter.has(k);
                const e = g.items.filter((i) => i.level === "error").length;
                const w = g.items.length - e;
                return (
                  <button
                    key={k}
                    onClick={() => toggleKind(k)}
                    title={`只看「${g.label}」的问题（再点一下取消）`}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                      on ? "border-primary/60 bg-primary/10 text-ink-primary"
                         : "border-line text-ink-secondary hover:border-primary/40 hover:text-ink-primary"}`}
                  >
                    {g.label}
                    {e > 0 && <span className="text-danger"> {e} 硬伤</span>}
                    {w > 0 && <span className="text-warning">{" "}{w}</span>}
                  </button>
                );
              })}
              {kindFilter.size > 0 && (
                <button onClick={() => setKindFilter(new Set())}
                  className="text-[10px] text-ink-muted hover:text-primary underline">
                  清除
                </button>
              )}
            </div>
          )}

          {/* ── 各类小计（哪一类最脏）── */}
          <div className="px-3 py-1.5 flex flex-wrap gap-2 border-b border-line/60">
            {Object.entries(report.checks || {}).map(([k, c]) => {
              const n = (c.issues || []).length;
              // 中文名优先取后端下发的 kind_label（issues_flat 每条都带），
              // 老报告没有就回落到同一份兜底表 —— 不在这里另写一套映射。
              const label = issues.find((i) => i.kind === k)?.kind_label || KIND_FALLBACK[k] || k;
              return (
                <span key={k} className="text-[10px] text-ink-muted">
                  {label.replace(/体检$/, "")}
                  ：{c.error ? <span className="text-danger">{c.error} 硬伤</span> : n === 0 ? <span className="text-emerald-500">通过</span> : `${c.warn || 0} 提醒`}
                </span>
              );
            })}

          </div>

          {/* ── 修前 → 修后 ── */}
          {fix && (
            <div className={`px-3 py-2 border-b border-line/60 text-[11px] flex items-center gap-2 flex-wrap ${
              fix.improved ? "bg-emerald-500/5" : "bg-warning/5"}`}>
              {fix.improved
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                : <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />}
              <span className="text-ink-primary">
                修复后复检：硬伤 <b>{fix.before_error ?? "—"}</b> → <b>{fix.error ?? "—"}</b>
                ，提醒 <b>{fix.before_warn ?? "—"}</b> → <b>{fix.warn ?? "—"}</b>
              </span>
              {!!fix.touched_eps?.length && (
                <span className="text-ink-muted">动了 {fix.touched_eps.length} 集（{fix.touched_eps.join("、")}）</span>
              )}
              {fix.improved === false && (
                <span className="text-warning">这次没改到位 —— 原稿已存历史版本，可以回滚，也可以换个说法再让它改一次。</span>
              )}
              {!!fix.notes?.length && (
                <span className="text-ink-muted w-full">{fix.notes.join(" ")}</span>
              )}
            </div>
          )}

          {/* ── 工具条 ── */}
          {!noProblem && (
            <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line/60">
              <button onClick={toggleAll} className="flex items-center gap-1 text-[11px] text-ink-secondary hover:text-ink-primary">
                {fixable.length > 0 && fixable.every((i) => selected.has(i.id))
                  ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                全选（{fixable.length}）
              </button>
              {warns.length > 0 && (
                <button onClick={() => setShowWarn((v) => !v)} className="text-[11px] text-ink-muted hover:text-ink-primary">
                  {showWarn ? "只看硬伤" : `含提醒（+${warns.length}）`}
                </button>
              )}
              <span className="text-[10px] text-ink-muted">
                显示 {shown.length} 条{rows.length !== shown.length && `（合并成 ${rows.length} 行）`}
              </span>
              <button
                disabled={fixing || selected.size === 0}
                onClick={() => onFix(Array.from(selected))}
                className="ml-auto px-2 py-1 rounded-md bg-primary hover:bg-primary/90 text-white text-[11px] font-medium disabled:opacity-40 flex items-center gap-1"
                title="只改选中的这几条涉及到的集，没点到的集一字不碰。改前每集自动存历史版本，可回滚。"
              >
                {fixing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                {fixing ? "修复中…" : `让 AI 改选中的 ${selected.size} 条`}
              </button>
              <button
                disabled={fixing || errs.filter((i) => i.id).length === 0}
                onClick={() => onFix(errs.map((i) => i.id).filter(Boolean))}
                className="px-2 py-1 rounded-md border border-line hover:border-primary/60 text-[11px] text-ink-secondary disabled:opacity-40"
                title="一次把所有硬伤都改掉（提醒类不改）。适合先摸底再来一遍的用法。"
              >
                一键全修硬伤
              </button>
            </div>
          )}

          {/* ── 问题清单 ── */}
          <div className="max-h-80 overflow-y-auto divide-y divide-line/50">
            {rows.map((row) => {
              if (row.single) return renderItem(row.items[0]);

              // ── 同类跨集合并行 ──
              // 逐集刷屏的问题（典型是 hook_in_missing 一报 56 条）收成一行，
              // 让真正该单独看的硬伤不被挤出视野。展开后仍是逐条原件，
              // 勾选/单修的行为一字不变。
              const items = row.items;
              const open = openGroups.has(row.key);
              const errN = items.filter((i) => i.level === "error").length;
              const warnN = items.filter((i) => i.level === "warn").length;
              const infoN = items.length - errN - warnN;
              // 严重度标签按**最高档**，并把其余档位如实列出来 ——
              // 原先只分"有硬伤 / 否则一律叫提醒"，同一 code 下混着 warn 与 info
              // 时组头会说谎（info 被显示成"提醒"）。
              const sevTxt = [
                errN > 0 ? `${errN} 硬伤` : "",
                warnN > 0 ? `${warnN} 提醒` : "",
                infoN > 0 ? `${infoN} 参考` : "",
              ].filter(Boolean).join(" · ");
              const sevCls = errN > 0 ? "text-danger" : warnN > 0 ? "text-warning" : "text-ink-muted";
              const eps = items.map((i) => i.episode).filter((e): e is number => e != null);
              // 集号区间：只在**连续**时才写"第a–b集"。不连续时（如 [2, 61]）
              // 写成区间会被读成"覆盖了 2~61 全部 60 集"，与条数严重不符。
              const uniqEps = Array.from(new Set(eps)).sort((a, b) => a - b);
              const contiguous = uniqEps.every((e, i) => i === 0 || e === uniqEps[i - 1] + 1);
              const epsTxt = uniqEps.length === 0 ? ""
                : uniqEps.length === 1 ? `（第${uniqEps[0]}集）`
                : contiguous ? `（第${uniqEps[0]}–${uniqEps[uniqEps.length - 1]}集 · ${uniqEps.length} 集）`
                : `（${uniqEps.length} 集：第${uniqEps.slice(0, 3).join("、")}${uniqEps.length > 3 ? " 等" : ""}集）`;
              const ids = items.map((i) => i.id);
              const realIds = ids.filter(Boolean);
              const picked = realIds.filter((x) => selected.has(x)).length;
              const on = realIds.length > 0 && picked === realIds.length;
              // 部分选中必须画得出来：二态勾选框会把"我只勾了其中 3 条"
              // 显示成全选，用户再点一下就成了全不选。
              const partial = picked > 0 && !on;
              const label = items[0].kind_label || KIND_FALLBACK[items[0].kind || ""] || "";
              return (
                <div key={row.key} className={on ? "bg-primary/5" : ""}>
                  <div className="px-3 py-1.5 flex items-start gap-2">
                    <button
                      onClick={() => toggleMany(ids)}
                      className="mt-0.5 shrink-0"
                      title={partial
                        ? `已勾选 ${picked}/${realIds.length} 条，点一下补齐这一组`
                        : "勾选后可以一次改掉这一组的全部问题"}
                    >
                      {on ? <CheckSquare className="w-3.5 h-3.5 text-primary" />
                        : partial ? <MinusSquare className="w-3.5 h-3.5 text-primary" />
                        : <Square className="w-3.5 h-3.5 text-ink-muted" />}
                    </button>
                    {errN > 0
                      ? <AlertTriangle className="w-3.5 h-3.5 text-danger mt-0.5 shrink-0" />
                      : <Info className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${warnN > 0 ? "text-warning" : "text-ink-muted"}`} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] shrink-0 ${sevCls}`}>{sevTxt}</span>
                        <span className="text-xs text-ink-primary">
                          {label && <span className="text-ink-muted">{label} · </span>}
                          <span className="font-mono">{items[0].code || "同类"}</span>
                          <span className="text-ink-muted"> × {items.length}</span>
                        </span>
                        <span className="text-[10px] text-ink-muted shrink-0">{epsTxt}</span>
                      </div>
                      <div className="text-[11px] text-ink-secondary break-words mt-0.5">{items[0].message}</div>
                      <button onClick={() => toggleGroup(row.key)}
                        className="text-[10px] text-ink-muted hover:text-primary mt-0.5">
                        {open ? "收起逐集明细" : `展开这 ${items.length} 条`}
                      </button>
                    </div>
                    <button
                      disabled={fixing}
                      onClick={() => onFix(ids.filter(Boolean))}
                      title="一次改掉这一组的全部问题（涉及到的每一集都会存历史版本，可回滚）"
                      className="shrink-0 px-1.5 py-0.5 rounded border border-line hover:border-primary/60 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40 flex items-center gap-1"
                    >
                      <Wand2 className="w-3 h-3" />全改（{ids.filter(Boolean).length}）
                    </button>
                  </div>
                  {open && (
                    <div className="ml-6 border-l border-line/60 divide-y divide-line/40">
                      {items.map(renderItem)}
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="px-3 py-3 text-xs text-ink-muted flex items-center gap-1.5">
                <MinusCircle className="w-3.5 h-3.5" />
                {kindFilter.size
                  ? "选中的类别没有问题。"
                  : showWarn ? "这一类没有问题。" : "没有硬伤（提醒已隐藏）。"}
              </div>
            )}
            {/* ⚠️ 后端每类最多列 60 条（engine.MAX_ISSUES）。被截掉的那些**连"改这个"
                都点不到**（它们不进 issue_index）—— 不说出来，用户会以为报告只有这些。
                dev 实测报告 77：表头"3 硬伤 / 57 提醒"，而 structure 块 total=65。 */}
            {truncatedNote > 0 && (
              <div className="px-3 py-2 text-[10px] text-warning bg-warning/5 border-t border-line/60">
                还有 {truncatedNote} 条同类问题未逐条列出（每类最多显示 60 条，按严重度取前 60）。
                这些条目不在这份清单里，也就无法逐条定点修复 —— 想覆盖全，
                先用「一键全修硬伤」或「整本精修」，再重新体检。
              </div>
            )}
          </div>

          {!!report.report_id && (
            <div className="px-3 py-1 border-t border-line/60 text-[10px] text-ink-muted flex items-center gap-2">
              <RotateCcw className="w-3 h-3" />
              报告 #{report.report_id} · 修复是覆写操作，每集改前自动存历史版本，可在草稿页回滚
            </div>
          )}
        </>
      )}
    </div>
  );
}
