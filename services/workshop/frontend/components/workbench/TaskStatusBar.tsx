"use client";

/**
 * 常驻任务状态栏（v2 草稿页顶栏下方一条）。
 *
 * 为什么要有它 —— 2026-10-06 用户报告「强制重写按钮似乎没有用」，查下去发现
 * 按钮本身是通的，是**看不见**造成的误判：
 *   · v2 页面此前**完全没有轮询**（全页只有一个 mount 拉取），顶栏的 `busy` 只覆盖
 *     启动那一次 HTTP 往返（后台任务，毫秒级返回），一返回按钮就恢复常态；
 *   · 60 集的强制重写在后台串行跑，实测单集 1–12 分钟，一整批要按小时计。
 *   于是：点下去 → 按钮立刻看着没事 → 内容几小时内一个字不变 → 判定"没用" →
 *   再点一次 → 撞 409 → 只飘一个 toast 就没了。
 *
 * ⚠️ 本组件要合并**两套互不相通**的任务机制（这是最容易做漏的地方）：
 *
 *   | 来源 | 覆盖 | 端点 |
 *   |---|---|---|
 *   | 进程内批量任务 | 补全/强制重写（正文、剧本）、直接生成剧本 | `/v1/stages/drafts/{id}/progress` |
 *   | 队列作业 | 精修、去AI味、对话发起的生成/改编 | `/v1/agent/jobs?draft_id=` |
 *
 * 批量生成走 `asyncio.create_task` + `outline.progress`，**不建 AgentJob**；
 * 精修走队列 + 自己那张 RewriteJob。两边的判活口径也不同（批量靠
 * `last_beat_at` 的 180 秒窗口，队列靠租约），所以这里分别读、分别判，不混用阈值。
 */

import * as React from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, Loader2, X, CheckCircle2, Ban,
} from 'lucide-react';
import { authFetch } from '@/lib/auth';
import { cn } from '@/lib/cn';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';
const API = `${BASE}/v1/agent`;

/** 逐集结果的展示口径。state 由后端 batch_gen 的 record_episode 写。 */
type EpRec = { order: number; state: string; reason?: string };

type BatchProgress = {
  stage: string;
  sub_stage: string;
  current: number;
  total: number;
  running: boolean;
  in_memory_running?: boolean;
  last_message: string;
  last_beat_at: string;
  eps?: EpRec[];
  cancel_requested?: boolean;
  /** 后端 draft_activity 汇总的三套机制（见 progress_helper）。2026-10-22 加。 */
  activity?: {
    busy: boolean;
    summary: string;
    approval_pending?: boolean;
    /** 停在审批点的那几轮：哪个会话、用户当时说的话。可能不是眼前打开的那个会话。 */
    approval_runs?: { run_id: number; conversation_id?: number | null; message?: string }[];
    sources?: ActivitySource[];
  };
};

/** 一条「正在跑」的记录。mechanism 决定它是哪套机制，blocks=false 表示不占位（审批点）。 */
type ActivitySource = {
  mechanism: 'inline' | 'queue' | 'rewrite' | 'agent';
  kind: string;
  label: string;
  job_id?: number;
  status?: string;
  current?: number;
  total?: number;
  last_message?: string;
  awaiting_approval?: boolean;
  blocks?: boolean;
  cancel_how?: string;
};

type Job = {
  id: number;
  kind: string;
  status: string;
  progress: number | null;
  progress_note: string | null;
  error?: string | null;
  updated_at?: string | null;
  /** 后端 job_status.describe() —— **判活唯一口径**（排队 / 进行中 / 疑似卡住 / 等你确认 / 终态）。
   *  2026-10-24 之前这里只看 `status`，于是"排队中（一个字没写）"和
   *  "跑了很久"在栏上一模一样，都被画成"生成剧本 0%"。 */
  state?: {
    phase: string; label: string; active: boolean; terminal: boolean; why: string;
    retrying?: boolean; queue_position?: number | null; queued_seconds?: number | null;
    episodes_done?: number | null; episodes_total?: number | null; eta_seconds?: number | null;
  } | null;
};

/** 这条作业是不是"还没轮到"（排队）。排队不该画进度百分比 —— 它不会动。 */
function isQueued(j: Job): boolean {
  return (j.state?.phase || '') === 'queued';
}
/** 心跳断了。这时候不能继续转圈，要明说"疑似卡住、会自动重派"。 */
function isStalled(j: Job): boolean {
  return (j.state?.phase || '') === 'stalled';
}
/** 作业的一行摘要：排队优先说排在第几，其次才是进度。 */
function jobLine(j: Job): string {
  const label = KIND_LABEL[j.kind] || j.kind;
  const s = j.state;
  if (s?.phase === 'queued') {
    return j.state?.queue_position
      ? `${label}：排队中（前面还有 ${j.state.queue_position} 个）`
      : `${label}：排队中`;
  }
  if (s?.phase === 'stalled') return `${label}：疑似卡住`;
  if (s?.episodes_done && s?.episodes_total) return `${label} ${s.episodes_done}/${s.episodes_total} 集`;
  return j.progress != null ? `${label} ${j.progress}%` : label;
}

/** 改编（小说/推文）作业 —— 它在自己的 chapter_adapt_jobs 表里，前两个数据源都读不到 */
type AdaptJob = {
  id: number;
  kind: string;
  status: string;
  total: number | null;
  finished: number | null;
  error?: string;
};

const STAGE_LABEL: Record<string, string> = {
  chapters: '正文',
  storyboards: '剧本',
  outline: '大纲',
  continuation: '续写',
  adaptation: '改编',
};

/** 队列作业 kind → 人话。用"动作"而不是内部名。 */
const KIND_LABEL: Record<string, string> = {
  rewrite_script: '精修',
  deai_apply: '去 AI 味',
  gen_outline: '生成大纲',
  gen_chapters: '生成正文',
  gen_storyboards: '生成剧本',
  adapt_products: '改编（小说/推文）',
  check_script: '体检',
  fix_script: '按问题修改',
};

const ACTIVE_JOB = new Set(['queued', 'running', 'analyzing', 'rewriting', 'pending']);
const ACTIVE_SUB = new Set(['running']);

/**
 * 哪些作业**有**「改前/改后」对照 —— 必须与后端
 * `GET /v1/agent/jobs/{id}/changes` 的接受列表逐字一致
 * （见 agent/routes.py:api_job_changes）。
 * 不一致的后果：栏上给一个"看改动"按钮，点下去返回一句"这类作业没有对照"。
 */
const DIFFABLE_KINDS = new Set([
  'rewrite_script', 'fix_script', 'gen_chapters', 'gen_storyboards', 'deai_apply',
]);

function epStateMeta(s: string): { label: string; cls: string } {
  if (s === 'done') return { label: '完成', cls: 'text-emerald-500' };
  if (s === 'failed') return { label: '失败', cls: 'text-danger' };
  if (s === 'skipped') return { label: '跳过', cls: 'text-ink-muted' };
  return { label: s, cls: 'text-ink-muted' };
}

export function TaskStatusBar({
  draftId,
  /** 任务从"在跑"变成"跑完了"时触发 —— 页面拿它刷新正文/剧本。
   *  这是 v2 页此前完全缺失的能力：任务跑完页面不会自己更新。 */
  onFinished,
  /** 点「看改动」时由页面决定怎么展示（复用已有的对照组件）。 */
  onViewChanges,
}: {
  draftId: number;
  onFinished?: () => void;
  onViewChanges?: (jobId: number) => void;
}) {
  const [batch, setBatch] = React.useState<BatchProgress | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [adaptJobs, setAdaptJobs] = React.useState<AdaptJob[]>([]);
  const [expanded, setExpanded] = React.useState(false);
  const [canceling, setCanceling] = React.useState(false);
  const [notice, setNotice] = React.useState<string>('');
  // 用户点过"看改动"之后就不再显示"上次已完成"那一条 —— 否则栏会永远占着版面。
  // 只记内存（不落库）：刷新页面后又出现，符合"这是我刚才那次操作的结果"的直觉。
  const [dismissedDone, setDismissedDone] = React.useState(false);
  // 记住上一次的活跃集合，用来判断"刚刚跑完" → 触发一次刷新。
  const wasActive = React.useRef(false);
  const alive = React.useRef(true);

  const tick = React.useCallback(async () => {
    const [bp, jp, np, tp] = await Promise.allSettled([
      authFetch(`${BASE}/v1/stages/drafts/${draftId}/progress`).then(
        (r) => (r.ok ? r.json() : null)),
      authFetch(`${API}/jobs?draft_id=${draftId}&limit=20`).then(
        (r) => (r.ok ? r.json() : null)),
      // 小说 / 推文改编走自己的表，前两个源都读不到它。
      // ⚠️ 必须带 job_only=1 —— 全量响应会把每章全文都拉回来（一部 60 集的剧
      // 就是几十万字），3 秒一次足以拖死浏览器。
      authFetch(`${BASE}/v1/adapt/novel?draft_id=${draftId}&job_only=true`).then(
        (r) => (r.ok ? r.json() : null)),
      authFetch(`${BASE}/v1/adapt/tweet?draft_id=${draftId}&job_only=true`).then(
        (r) => (r.ok ? r.json() : null)),
    ]);
    if (!alive.current) return;
    if (bp.status === 'fulfilled') setBatch(bp.value);
    if (jp.status === 'fulfilled' && jp.value) setJobs(jp.value.items || []);
    const aj: AdaptJob[] = [];
    for (const res of [np, tp]) {
      if (res.status === 'fulfilled' && res.value?.job) aj.push(res.value.job);
    }
    setAdaptJobs(aj);
  }, [draftId]);

  // 有活跃任务时 3 秒一次；空闲时降到 15 秒 —— 不做无条件高频轮询。
  React.useEffect(() => {
    alive.current = true;
    void tick();
    return () => { alive.current = false; };
  }, [tick]);

  const batchRunning = !!batch?.running;
  const activeJobs = jobs.filter((j) => ACTIVE_JOB.has(j.status));
  const activeAdapt = adaptJobs.filter((j) => ACTIVE_JOB.has(j.status));
  /**
   * 后端汇总的「这部草稿上所有在跑的东西」（三套机制）。
   *
   * ⚠️ 为什么不能只靠上面两个数据源 —— 2026-10-22 生产事故：
   * `/v1/agent/jobs?draft_id=` 只列**当前用户自己的**作业，而协作草稿上
   * 另一个人跑的批量生成、以及**停在审批点的 Agent 会话**（它在库里连作业行都没有），
   * 这里都读不到。于是用户看到一片安静，以为"点了没反应"。
   */
  const activitySources = batch?.activity?.sources || [];
  const approvalPending = !!batch?.activity?.approval_pending;
  const approvalRuns = batch?.activity?.approval_runs || [];
  /** 只有「真正在占位」的那些才算活跃；审批点不占位（后端 blocks=false），单独提示。 */
  const blockingSources = activitySources.filter((s) => s.blocks !== false);
  /**
   * 后端汇总里**上面那些数据源看不到的**部分 —— 主要还是为了"别人在这部草稿上跑的"
   * 和"审批点"。同一件事不要显示两遍：
   *   · inline 由 `batch`（其本身就读 outline.progress）负责；
   *   · queue 里属于**我**的作业由 `jobs` 负责（那边有进度百分比，信息更细）。
   * 不扣掉它们的话，一行里会出现两次「生成正文」。
   */
  const extraSources = blockingSources.filter((s) => {
    if (s.mechanism === 'inline') return false;
    if (s.mechanism === 'queue' && activeJobs.some((j) => j.id === s.job_id)) return false;
    return true;
  });
  const anyActive = batchRunning || activeJobs.length > 0 || activeAdapt.length > 0
    || blockingSources.length > 0;

  React.useEffect(() => {
    const iv = anyActive ? 3000 : 15000;
    const t = setInterval(() => { void tick(); }, iv);
    return () => clearInterval(t);
  }, [anyActive, tick]);

  // 跑完自动刷新一次 —— 让用户不用手点刷新就看到新内容。
  React.useEffect(() => {
    if (wasActive.current && !anyActive) onFinished?.();
    wasActive.current = anyActive;
  }, [anyActive, onFinished]);

  // 「上次任务失败」：没有任何活跃任务时，把最近一条失败/取消的作业留在栏上。
  const lastBad = React.useMemo(() => {
    if (anyActive) return null;
    return jobs.find((j) => j.status === 'failed' || j.status === 'canceled') || null;
  }, [jobs, anyActive]);

  /**
   * 「上次跑完的任务」—— 用来在空闲时**留住"看改动"入口**。
   *
   * ⚠️ 2026-10-08 补。此前这条栏在空闲时直接 `return null`，而"看这次改动了哪些集"
   * 的渲染条件写的是 `lastBad.status === 'canceled'` —— 于是：
   *   · 精修**正常跑完**（done）之后 lastBad 为 null → 整条栏连同按钮一起消失，
   *     用户找不到"看这次改动了哪些集"（原话："这个按钮找不到了"）；
   *   · 只有**被取消**的作业才留按钮 —— 而取消恰恰是没改完的那个，条件正好反了。
   *
   * 这里补一个"最近一条跑完的、且支持对照的作业"，让栏在跑完后继续留着，
   * 直到用户主动点开看过或开始下一个任务。
   */
  const lastDone = React.useMemo(() => {
    if (anyActive || lastBad) return null;
    if (dismissedDone) return null;
    return jobs.find((j) => j.status === 'done' && DIFFABLE_KINDS.has(j.kind)) || null;
  }, [jobs, anyActive, lastBad, dismissedDone]);

  const batchEps = batch?.eps || [];

  async function cancelBatch() {
    setCanceling(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/batch/cancel`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      setNotice(d?.message || (r.ok ? '已请求停止' : '取消失败'));
      setTimeout(() => setNotice(''), 6000);
      void tick();
    } catch {
      setNotice('取消请求失败，请重试');
      setTimeout(() => setNotice(''), 6000);
    } finally {
      setCanceling(false);
    }
  }

  async function cancelJob(jobId: number) {
    setCanceling(true);
    try {
      await authFetch(`${API}/jobs/${jobId}/cancel`, { method: 'POST' });
      setNotice('已请求取消该作业，会在下一次心跳时停下');
      setTimeout(() => setNotice(''), 6000);
      void tick();
    } finally {
      setCanceling(false);
    }
  }

  /** 取消改编作业 —— 它不在 agent_jobs 里，端点也不同（/v1/adapt/jobs/{id}/cancel）。 */
  async function cancelAdapt(jobId: number, kind: string) {
    setCanceling(true);
    try {
      await authFetch(`${BASE}/v1/adapt/jobs/${jobId}/cancel`, { method: 'POST' });
      setNotice(`已请求取消${kind === 'novel' ? '小说' : '推文'}改编，当前这一集跑完后停下`);
      setTimeout(() => setNotice(''), 6000);
      void tick();
    } finally {
      setCanceling(false);
    }
  }

  /** 一行摘要：正在跑什么。 */
  const headline = React.useMemo(() => {
    if (batchRunning) {
      const label = STAGE_LABEL[batch?.stage || ''] || batch?.stage || '任务';
      return `${label}生成中`;
    }
    // 「排队」和「在跑」必须分开说 —— 2026-10-24。
    // 之前这里对所有活跃作业都输出"生成剧本中"，而其中排队的那些
    // **一个字都还没写**，可能还要排两小时。用户看到的"中"其实是"等着"。
    const stalled = activeJobs.filter(isStalled);
    if (stalled.length > 0) {
      return `${KIND_LABEL[stalled[0].kind] || stalled[0].kind}疑似卡住`;
    }
    const queued = activeJobs.filter(isQueued);
    const running = activeJobs.filter((j) => !isQueued(j) && !isStalled(j));
    if (queued.length > 0 && running.length === 0 && activeAdapt.length === 0) {
      const pos = queued[0].state?.queue_position;
      if (queued.length === 1) {
        return pos
          ? `${KIND_LABEL[queued[0].kind] || queued[0].kind}排队中（前面还有 ${pos} 个任务）`
          : `${KIND_LABEL[queued[0].kind] || queued[0].kind}排队中`;
      }
      return `${queued.length} 个任务排队中`;
    }
    // 后端汇总口径优先：它能看见"别人在这部草稿上跑的"和"审批点"，
    // 而下面两个数组只看得到我自己的作业。
    if (blockingSources.length > 0) {
      const s = blockingSources[0];
      const n = blockingSources.length;
      if (n === 1) {
        return `${KIND_LABEL[s.kind] || s.label}中`;
      }
      return `${n} 个任务进行中`;
    }
    const n = activeJobs.length + activeAdapt.length;
    if (n === 1 && activeAdapt.length === 1) {
      const a = activeAdapt[0];
      return `${a.kind === 'novel' ? '小说' : '推文'}改编中`;
    }
    if (n === 1) {
      return `${KIND_LABEL[activeJobs[0].kind] || activeJobs[0].kind}中`;
    }
    if (n > 1) return `${n} 个任务进行中`;
    if (approvalPending) return 'Agent 等你确认';
    return '';
  }, [batchRunning, batch?.stage, blockingSources, activeJobs, activeAdapt, approvalPending]);

  // 完全空闲、也没有失败记录、也没有可看对照的已完成作业、也没有待审批 → 不占版面。
  // ⚠️ lastDone 必须在这里出现：漏掉它，作业一跑完整条栏（连同"看改动"入口）
  // 就消失，用户找不到"看这次改动了哪些集"。
  // ⚠️ approvalPending 同理：停在审批点的 Agent 会话不占位（不能锁死草稿），
  //    但**必须显示**——否则用户看到的就是"点了没反应"，正是 2026-10-22 的事故形态。
  if (!anyActive && !approvalPending && !lastBad && !lastDone && !notice) return null;

  const failed = batchEps.filter((e) => e.state === 'failed');
  const skipped = batchEps.filter((e) => e.state === 'skipped');
  const done = batchEps.filter((e) => e.state === 'done');

  return (
    <div
      className={cn(
        'flex-shrink-0 border-b fs-ui',
        anyActive
          ? 'bg-primary/5 border-primary/20'
          : approvalPending
            ? 'bg-warning/5 border-warning/25'
            : lastBad?.status === 'failed'
              ? 'bg-danger/5 border-danger/25'
              : 'bg-surface-overlay border-line',
      )}
    >
      <div className="px-3 py-1.5 flex items-center gap-2">
        {anyActive
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />
          : approvalPending
            ? <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0" />
            : lastBad?.status === 'failed'
              ? <AlertTriangle className="w-3.5 h-3.5 text-danger flex-shrink-0" />
              : <Ban className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-ink-primary min-w-0"
          title="展开看是哪几集 / 收起"
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <span className="font-medium truncate">
            {headline
              || (lastBad
                    ? (lastBad.status === 'failed' ? '上次任务失败' : '上次任务已取消')
                    : `${KIND_LABEL[lastDone?.kind || ''] || '上次任务'}已完成`)}
          </span>
        </button>

        {batchRunning && (
          <>
            <span className="text-ink-secondary tabular-nums flex-shrink-0">
              {batch?.current ?? 0}/{batch?.total ?? 0}
            </span>
            {/* 进度线：批量的 current/total 是最可靠的完成度 */}
            <span className="w-24 h-1 rounded bg-surface-base overflow-hidden flex-shrink-0">
              <span
                className="block h-full bg-primary transition-all"
                style={{ width: `${batch?.total ? Math.round(((batch.current || 0) / batch.total) * 100) : 0}%` }}
              />
            </span>
          </>
        )}

        {!batchRunning && activeJobs.length > 0 && (
          <span className="text-ink-secondary truncate">
            {activeJobs.map((j) => (
              <span key={j.id} className="mr-2">
                {jobLine(j)}
              </span>
            ))}
          </span>
        )}

        {/* 别人在这部草稿上跑的任务 —— 上面那段只覆盖"我自己的作业"，
            协作草稿上他人发起的作业它读不到（/v1/agent/jobs 按 user_id 过滤）。
            inline 那套由 batch 自己显示，这里用 extraSources 去重，同一件事不显示两遍。 */}
        {!batchRunning && extraSources.length > 0 && (
          <span className="text-ink-secondary truncate">
            {extraSources.map((s, i) => (
              <span key={`src-${s.mechanism}-${s.job_id ?? i}`} className="mr-2">
                {KIND_LABEL[s.kind] || s.label}
                {s.total ? <span className="tabular-nums"> {s.current ?? 0}/{s.total}</span> : null}
              </span>
            ))}
          </span>
        )}

        {activeAdapt.map((a) => (
          <span key={`adapt-n-${a.id}`} className="text-ink-secondary tabular-nums flex-shrink-0">
            {a.kind === 'novel' ? '小说' : '推文'} {a.finished ?? 0}/{a.total ?? 0}
          </span>
        ))}

        {batch?.last_message && !expanded && (
          <span className="text-ink-muted truncate hidden md:inline">{batch.last_message}</span>
        )}

        <span className="flex-1" />

        {batchRunning && (
          <button
            type="button"
            disabled={canceling}
            onClick={() => void cancelBatch()}
            className="px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-danger hover:border-danger/40 disabled:opacity-50 flex-shrink-0"
            title="在当前这一集跑完后停止（单集生成无法中途打断）"
          >
            停止
          </button>
        )}
        {!batchRunning && activeJobs.map((j) => (
          <button
            key={j.id}
            type="button"
            disabled={canceling}
            onClick={() => void cancelJob(j.id)}
            className="px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-danger hover:border-danger/40 disabled:opacity-50 flex-shrink-0"
            title="取消该作业"
          >
            取消
          </button>
        ))}
        {activeAdapt.map((j) => (
          <button
            key={`adapt-${j.id}`}
            type="button"
            disabled={canceling}
            onClick={() => void cancelAdapt(j.id, j.kind)}
            className="px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-danger hover:border-danger/40 disabled:opacity-50 flex-shrink-0"
            title="取消改编，当前这一集跑完后停下"
          >
            取消
          </button>
        ))}
        {!anyActive && onViewChanges && lastDone && (
          <button
            type="button"
            onClick={() => { setDismissedDone(true); onViewChanges(lastDone.id); }}
            className="px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-primary hover:border-primary/60 flex-shrink-0"
            title="看这次改动了哪些集（左边原文、右边改后）"
          >
            看改动
          </button>
        )}
        {!anyActive && onViewChanges && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="px-2 py-0.5 rounded border border-line text-ink-secondary hover:text-ink-primary flex-shrink-0"
          >
            详情
          </button>
        )}
      </div>

      {/* 审批点提示 —— 单独一行说清"下一步该干什么"。
          Agent 停在审批点时不占位（否则一条陈旧的待审批会把草稿锁死），
          但用户必须知道它停在那里、以及去哪儿处理；否则就是"点了没反应"。 */}
      {approvalPending && (
        <div className="px-3 pb-1.5 text-warning flex items-start gap-1.5">
          <span className="flex-shrink-0">·</span>
          <span>
            有 Agent 停在「等你确认」——它还没有执行，所以稿子不会有任何变化。
            请打开对话栏的「交给 Agent」，在那一轮里点确认或拒绝
            {approvalRuns.length > 0 && (
              <>（{approvalRuns.slice(0, 3).map((r) => `「${(r.message || "").slice(0, 24) || `第 ${r.run_id} 轮`}」`).join("、")}
              {approvalRuns.length > 3 ? ` 等 ${approvalRuns.length} 轮` : ""}；不在当前会话的话，到会话列表里找这一句）</>
            )}。
          </span>
        </div>
      )}

      {notice && (
        <div className="px-3 pb-1.5 text-ink-muted">{notice}</div>
      )}

      {/* 展开区：逐集明细 / 失败原因 / 结果链接 */}
      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-line/60 max-h-56 overflow-y-auto">
          {lastBad && !anyActive && (
            <div className="mt-1.5 mb-2 flex items-start gap-2 text-danger">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div>
                  {KIND_LABEL[lastBad.kind] || lastBad.kind} · 作业 #{lastBad.id}
                  {lastBad.status === 'canceled' ? ' 已取消' : ' 失败'}
                </div>
                {lastBad.error && (
                  <div className="text-ink-muted break-words mt-0.5">{lastBad.error}</div>
                )}
                {/* ⚠️ 这里此前写的是 `lastBad.status === 'canceled'` —— **条件反了**。
                    取消的作业恰恰是没改完的那个，真正该给对照入口的是**跑完**的。
                    而跑完的作业走的是下面 lastDone 那一支（旧代码里根本没有它，
                    原因见 lastDone 的注释）。 */}
                {onViewChanges && DIFFABLE_KINDS.has(lastBad.kind) && (
                  <button
                    type="button"
                    onClick={() => onViewChanges(lastBad.id)}
                    className="mt-1 underline decoration-dotted hover:text-ink-primary"
                  >
                    看这次改动了哪些集
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 「上次跑完了」—— 给跑完的作业留一条常驻入口。
              用户报"看这次改动了哪些集"按钮找不到，根因就是旧代码只画失败/取消那一支，
              跑完（done，也就是最常见的情形）什么都不显示。 */}
          {lastDone && !anyActive && (
            <div className="mt-1.5 mb-2 flex items-start gap-2 text-emerald-600">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-ink-primary">
                  {KIND_LABEL[lastDone.kind] || lastDone.kind} · 作业 #{lastDone.id} 已完成
                </div>
                <div className="text-ink-muted mt-0.5">
                  逐集明细在左侧「看改动」，那里是左边原文、右边改后的并排对照。
                </div>
                {onViewChanges && (
                  <button
                    type="button"
                    onClick={() => { setDismissedDone(true); onViewChanges(lastDone.id); }}
                    className="mt-1 underline decoration-dotted hover:text-primary"
                  >
                    看这次改动了哪些集
                  </button>
                )}
              </div>
            </div>
          )}

          {batchEps.length > 0 ? (
            <>
              <div className="text-ink-muted mt-1.5 mb-1">
                本批逐集：
                <span className="text-emerald-500"> {done.length} 完成</span>
                {failed.length > 0 && <span className="text-danger"> · {failed.length} 失败</span>}
                {skipped.length > 0 && <span> · {skipped.length} 跳过</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {batchEps.map((e) => {
                  const m = epStateMeta(e.state);
                  return (
                    <span
                      key={e.order}
                      title={`第${e.order}集 · ${m.label}${e.reason ? ` · ${e.reason}` : ''}`}
                      className={cn('px-1.5 py-0.5 rounded border border-line tabular-nums', m.cls)}
                    >
                      {e.order}
                    </span>
                  );
                })}
              </div>
              {failed.length > 0 && (
                <div className="mt-2 text-danger">
                  失败：
                  {failed.map((e) => `第${e.order}集（${e.reason || '未知原因'}）`).join('、')}
                </div>
              )}
            </>
          ) : anyActive ? (
            <div className="text-ink-muted mt-1.5">逐集明细在跑完第一集后出现。</div>
          ) : (
            <div className="text-ink-muted mt-1.5">没有可显示的明细。</div>
          )}

          {!batchRunning && activeJobs.length > 0 && (
            <div className="mt-2 text-ink-muted">
              精修这类任务可点「看改动」逐集对照（改前/改后），跑完后入口会留在这里。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
