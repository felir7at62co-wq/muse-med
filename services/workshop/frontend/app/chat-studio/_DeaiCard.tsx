'use client';

// 对话工坊 · 去 AI 味作业卡（贴在助手气泡下方）
//
// 存在的理由：用户点了「去 AI 味」之后，对话里只有一段文字回执。而这是个几十集的
// 长任务 —— 没有卡片，用户就不知道它跑到哪了，只能反复去「去 AI 味工作室」看。
//
// 与其他卡片的关键差别（决定了这张卡长什么样）：
//   · 它**没有"应用"按钮**。去 AI 味出的是一份**独立清洗稿**，草稿一个字都不动，
//     所以不存在"要不要应用到草稿"这个选择 —— 加个按钮反而暗示草稿被改了。
//   · 它**不画逐集对照**。per_ep 里是几十万字的原文 + 改写全文，塞进对话流会把
//     页面拖死。要看对照去工作室（那里是专门的、有分页的地方），这里只给一个入口。
//   · 它**不把分数做大**。分数是相对指标（同一文本改前 vs 改后），不是任何检测
//     平台的通过率。把它做成大号红字会诱导用户"追分"，而追分对本引擎毫无意义
//     （见 docs/RESEARCH-去AI感方法论.md）。所以只在一行里如实写密度变化。

import { Eraser, Loader2, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type DeaiJobView = {
  id: number;
  draftId: number;
  title: string;
  status: string;          // running / pending / done / failed / canceled
  total: number;
  finished: number;
  failed: number;
  summary: {
    avg_before?: number; avg_after?: number;
    per_kilo_before?: number; per_kilo_after?: number;
    structure_tally?: Record<string, number>;
    note?: string;
  };
};

/** 结构层症状码 → 中文短标签（与 app/polish/deai_structure.py 的 code 一一对应）。 */
const STRUCT_LABELS: Record<string, string> = {
  R1_节奏: '段落节奏过于均匀',
  R2_段末升华: '段末总结/升华',
  R3_相邻同构: '相邻句同骨架',
  R4_解释腔: '叙述者解释腔',
  R5_收尾: '结尾早一拍',
};

export default function DeaiCard({ job }: { job: DeaiJobView }) {
  const active = job.status === 'running' || job.status === 'pending';
  const done = job.status === 'done';
  const pct = job.total > 0 ? Math.round((job.finished / job.total) * 100) : 0;
  const s = job.summary || {};
  const hasDensity = s.per_kilo_before != null && s.per_kilo_after != null;
  const tally = s.structure_tally && Object.keys(s.structure_tally).length > 0
    ? s.structure_tally : null;

  return (
    <div className="mt-1.5 rounded-lg border border-line bg-surface-raised/40 p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        {active ? (
          <Loader2 className="w-3.5 h-3.5 text-warning animate-spin shrink-0" />
        ) : done ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />
        )}
        <Eraser className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-[12px] text-ink-primary truncate">
          去 AI 味 · {job.title || `草稿#${job.draftId}`}
        </span>
        <span className="text-[11px] text-ink-muted">
          #{job.id}
          {active && job.total > 0 && ` · ${job.finished}/${job.total} 集`}
          {!active && done && job.total > 0 && ` · ${job.total} 集`}
          {job.failed > 0 && ` · 失败 ${job.failed}`}
        </span>
        {/* 独立清洗稿的入口。看逐集对照、下载整本都在那边 —— 那是它的主场，
            对话里只放通行证，不重复实现一套对照。 */}
        <a
          href={`${BASE ? BASE : ''}/deai-studio`}
          className="ml-auto text-[11px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
        >
          下载旧清洗稿 <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {active && (
        <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          {/* 进度未知（还没写 total）时不给宽度，避免画出一条"已经跑满"的假进度条 */}
          <div className="h-full bg-warning transition-all"
               style={{ width: job.total > 0 ? `${pct}%` : '15%' }} />
        </div>
      )}

      {done && (
        <div className="mt-2 flex flex-col gap-1">
          {hasDensity && (
            <div className="text-[11px] text-ink-secondary">
              每千字 AI 味硬信号：<span className="text-warning">{s.per_kilo_before}</span>
              {' → '}<span className="text-success">{s.per_kilo_after}</span>
              <span className="text-ink-muted ml-2">
                （相对分 {s.avg_before ?? '—'} → {s.avg_after ?? '—'}）
              </span>
            </div>
          )}
          <div className="text-[10px] text-ink-muted/80 leading-snug">
            这是**相对分**（同一段文本改前 vs 改后），不是任何检测平台的通过率，
            也不是"AI 生成概率"。分数没归零是正常的：情绪直说、类型惯例写法不算 AI 味，
            引擎刻意不动它们。
          </div>
          {tally && (
            <div className="text-[11px] text-ink-muted">
              仍残留的结构问题：
              {Object.entries(tally).map(([code, n]) => (
                <span key={code} className="mr-2 text-warning">
                  {STRUCT_LABELS[code] || code} ×{n}
                </span>
              ))}
            </div>
          )}
          {s.note && <div className="text-[10px] text-ink-muted/80">{s.note}</div>}
          <div className="text-[11px] text-ink-muted">
            <span className="text-success">你的草稿没有任何改动</span> ——
            清洗结果是一份独立的稿子，不满意直接不用即可。
          </div>
        </div>
      )}

      {!active && !done && (
        <div className="mt-2 text-[11px] text-ink-secondary leading-snug">
          作业没有跑完{job.status ? `（${job.status}）` : ''}。
          <span className="text-ink-muted">
            {' '}去 AI 味**不改动草稿**，所以你的剧本内容没受任何影响，直接重新提交即可。
          </span>
        </div>
      )}
    </div>
  );
}
