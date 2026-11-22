// ⛔ 2026-09-18 入口审计裁定：评审精修（critique）已停用 —— 验证后完全没有可用性。
// 判据：近 30 天 prod 仅 2 次调用；历史 39 次 / 16 人，最后一次 2026-09-01。
// 它与「整本 AI 精修」都做"AI 审整本 + 改写覆写"，入口高度重叠，用户分不清该点哪个。
// 用户裁定：已被对话工坊的「精修这批」取代，旧逻辑都可以不要。
//
// ⚠️ 本组件当前**未挂载**：工作台的 critique tab 渲染的是 RewriteRoom，不是它
// （见 app/drafts/[id]/page.tsx）。也就是说这个文件本来就是死代码 —— 这与它
// prod 仅 2 次调用的事实吻合。这里保留文件、只加停用标注，不删代码。
//
// 停用口径与后端一致（注释掉使其不可用、不删代码）：
//   后端 10 个评审精修端点已停用（services/orchestrator/app/critique/routes.py）
//   恢复时：取消后端端点注释 + main.py 的 admin_router 注册 + 恢复工作台 tab。
//
// ⚠️ lib/critique.ts 里 story-bible 三个函数不是评审精修的一部分，
//    工作台总览中心 _OverviewHub 在用它们，别跟着一起停。
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '../../../lib/auth';

import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { ModelSelect } from '@/components/ModelSelect';
import { Loader2, ScanSearch, Play, X, Check, RefreshCw, FileDown, PlayCircle } from 'lucide-react';
import {
  type CritiqueRun, type CritiqueIssue,
  startCritique, listCritiqueRuns, getCritiqueResult, applyCritique,
  cancelCritique, isCritiqueActive, downloadCritiqueLog, formatCritiqueText,
  resumeCritique, isCritiqueResumable,
  ROLE_LABEL, THEME_LABEL, modelLabel,
} from '@/lib/critique';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

const SEV_TONE: Record<string, string> = {
  high: 'text-danger', mid: 'text-warning', low: 'text-ink-muted',
};

export function CritiqueRoom({ draftId, onApplied }: { draftId: number; onApplied?: () => void }) {
  const toast = useToast();
  const [source, setSource] = useState<'chapter' | 'storyboard'>('chapter');
  // 强度档已删除: 一律全量精修 (圣经三道防线 + 总编辑 + 周期总览)
  const [editorModel, setEditorModel] = useState('gemini');
  const [focus, setFocus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [runs, setRuns] = useState<CritiqueRun[]>([]);
  const [active, setActive] = useState<CritiqueRun | null>(null);
  const [result, setResult] = useState<any>(null);
  const [issuesByEp, setIssuesByEp] = useState<Record<string, CritiqueIssue[]>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // D5.3: 结构性重写计划（结构问题走"改契约 → 重生成该集"，不走行级重写）
  const [restructure, setRestructure] = useState<any>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const loadRestructurePlan = useCallback(async () => {
    setPlanLoading(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/restructure-plan`);
      if (r.ok) {
        const data = await r.json();
        setRestructure(data.restructure_plan || null);
      }
    } catch {
      /* 辅助信息，失败不打断 */
    } finally {
      setPlanLoading(false);
    }
  }, [draftId]);

  const refresh = useCallback(async () => {
    const rs = await listCritiqueRuns(draftId).catch(() => []);
    setRuns(rs);
    const running = rs.find(isCritiqueActive);
    if (running) {
      setActive(running);
    } else if (rs.length && (!active || isCritiqueActive(active))) {
      setActive(rs[0]);
    }
    return rs;
  }, [draftId, active]);

  useEffect(() => {
    refresh();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // 轮询进行中的任务
  useEffect(() => {
    if (active && isCritiqueActive(active) && !timerRef.current) {
      timerRef.current = setInterval(async () => {
        const rs = await refresh();
        const cur = rs.find((r) => r.id === active.id);
        if (cur && !isCritiqueActive(cur) && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          if (cur.status === 'succeeded') loadResult(cur.id);
        }
      }, 3000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const loadResult = useCallback(async (runId: number) => {
    try {
      const r = await getCritiqueResult(runId);
      setResult(r.result);
      setIssuesByEp(r.issues_by_episode || {});
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (active && active.status === 'succeeded') loadResult(active.id);
    else { setResult(null); setIssuesByEp({}); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.status]);

  const onStart = async () => {
    if (!window.confirm(
      `评审精修(全量)将: 抽取/复用设定圣经 → 多模型多身份评审 → 总编辑定向决策 → 编辑改写, ` +
      `并在开始/每10集/结束做全局总览、末尾统一定向补修。\n成本约为常规生成的数十倍, 耗时较长。确定开始？`
    )) return;
    setSubmitting(true);
    try {
      const r = await startCritique(draftId, {
        source, intensity: 'full', editor_model: editorModel, focus: focus || null,
      });
      toast.success(`已启动精修任务 #${r.run_id}`);
      await refresh();
    } catch (e) {
      toast.error(`启动失败: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = async (id: number) => {
    try { await cancelCritique(id); toast.success('已请求停止'); await refresh(); }
    catch (e) { toast.error(`停止失败: ${(e as Error).message}`); }
  };

  const onApply = async (id: number) => {
    if (!window.confirm('将用精修后的稿覆盖对应集（覆盖前自动存历史版本，可在「章节 → 历史版本」回滚）。确定采纳？')) return;
    try {
      const r = await applyCritique(id, null);
      const n = r.applied_episodes.length;
      const skipped = r.skipped_episodes?.length || 0;
      if (n > 0) {
        toast.success(`已采纳并覆盖 ${n} 集${skipped ? `，${skipped} 集解析失败已跳过` : ''}`);
      } else {
        toast.error(skipped ? `采纳失败：${skipped} 集内容解析失败，未覆盖` : '没有可覆盖的改动');
      }
      await refresh();
      onApplied?.();  // 通知父页面重新拉取草稿, 让章节/剧本区显示新内容
    } catch (e) { toast.error(`采纳失败: ${(e as Error).message}`); }
  };

  const onExportLog = async (id: number) => {
    setExporting(true);
    try {
      await downloadCritiqueLog(id);
      toast.success('已开始下载精修过程报告');
    } catch (e) {
      toast.error(`导出失败: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const onResume = async (id: number) => {
    if (!window.confirm('将从已完成的集之后继续精修（已完成的集不会重复消耗）。确定继续？')) return;
    try {
      await resumeCritique(id);
      toast.success(`已从中断点继续 #${id}`);
      await refresh();
    } catch (e) {
      toast.error(`续跑失败: ${(e as Error).message}`);
    }
  };

  const board = active?.progress_json || {};
  const cur = board.current || {};
  const events: any[] = board.events || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ScanSearch className="w-5 h-5 text-primary" />
        <h2 className="text-card-title font-semibold text-ink-primary">评审精修</h2>
        <span className="text-caption text-ink-muted">多模型多身份评审 → 编辑定向改写 → 采纳覆盖</span>
      </div>

      {/* 配置区 */}
      <div className="rounded-lg border border-line bg-white/[0.02] p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-caption text-ink-secondary mb-1">内容源</label>
            <select className="w-full h-9 rounded-md bg-surface-base border border-line px-2 text-body"
              value={source} onChange={(e) => setSource(e.target.value as any)}>
              <option value="chapter">章节正文</option>
              <option value="storyboard">剧本</option>
            </select>
          </div>
          <div>
            <label className="block text-caption text-ink-secondary mb-1">编辑/总编辑模型</label>
            <ModelSelect
              value={editorModel}
              onChange={setEditorModel}
              label={null}
              showHint={false}
              className="w-full h-9"
            />
          </div>
          <div>
            <label className="block text-caption text-ink-secondary mb-1">关注重点（可选）</label>
            <input className="w-full h-9 rounded-md bg-surface-base border border-line px-2 text-body"
              placeholder="如：主攻去AI感 / 逻辑漏洞"
              value={focus} onChange={(e) => setFocus(e.target.value)} />
          </div>
        </div>
        <Button variant="primary" size="lg" className="w-full" loading={submitting}
          leftIcon={!submitting ? <Play className="w-4 h-4" /> : undefined}
          onClick={onStart} disabled={!!(active && isCritiqueActive(active))}>
          {active && isCritiqueActive(active) ? '精修进行中…' : '开始精修'}
        </Button>
        <p className="text-caption text-ink-muted">默认精修全部集；范围将默认覆盖该草稿所有集（后续可加多选）。</p>
      </div>

      {/* D5.3: 结构性重写通路 —— 结构问题改句子修不好，得先改契约再重生成 */}
      <div className="rounded-lg border border-line bg-white/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-body font-medium text-ink-primary">结构性重写</span>
          <span className="text-caption text-ink-muted">
            钩子/升级/伏笔这类**结构问题**，改句子修不好——这里给出集合同的修订方案
          </span>
        </div>
        <Button variant="secondary" size="sm" loading={planLoading} onClick={loadRestructurePlan}>
          {restructure ? '重新分析结构问题' : '分析结构问题'}
        </Button>

        {restructure && (
          <div className="space-y-2">
            <div className="text-caption text-ink-muted">{restructure.note}</div>
            {(restructure.per_episode || []).length === 0 ? (
              <p className="text-caption text-success">
                没有需要改结构的问题 —— 行文层面的问题用上面的常规精修处理即可。
              </p>
            ) : (
              (restructure.per_episode || []).map((p: any) => (
                <div key={p.episode} className="rounded border border-warning/40 bg-warning/5 p-2">
                  <div className="text-caption font-medium text-warning">第 {p.episode} 集</div>
                  <ul className="mt-1 space-y-1">
                    {(p.revisions || []).map((r: any, i: number) => (
                      <li key={i} className="text-caption">
                        <span className="text-ink-secondary font-mono">{r.field}</span>
                        <span className="text-ink-muted"> — {r.reason}</span>
                        <div className="text-ink-secondary">→ {r.suggest}</div>
                        {r.current && (
                          <div className="text-ink-muted">当前：{r.current}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-caption text-ink-muted mt-1">
                    改完契约后，用大纲页的「重新生成此集」重生成该集正文。
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 运行看板 */}
      {active && isCritiqueActive(active) && (
        <div className="rounded-lg border border-line bg-surface-base/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-warning" />
              <span className="text-body font-medium">精修中 #{active.id}</span>
              {cur.episode != null && (
                <span className="text-caption text-ink-muted">
                  第 {cur.episode} 集 · 第 {cur.round} 轮 · {THEME_LABEL[cur.theme] || cur.theme}
                </span>
              )}
            </div>
            <Button variant="ghost" size="sm" leftIcon={<X className="w-3.5 h-3.5" />} onClick={() => onCancel(active.id)}>
              停止
            </Button>
          </div>
          <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-primary to-cyan transition-all" style={{ width: `${active.progress || 0}%` }} />
          </div>
          {(board.review_models || []).length > 0 && (
            <div className="text-caption text-ink-muted">
              评审模型：{(board.review_models || []).map((m: string) => modelLabel(m)).join(' / ')}
            </div>
          )}
          {/* 事件流 (v2: 含圣经/总览/总编辑/补修) */}
          <div className="max-h-56 overflow-y-auto space-y-1 text-caption font-mono">
            {events.slice(-40).reverse().map((ev, i) => (
              <div key={i} className="text-ink-secondary">
                {ev.kind === 'bible_start' && `📖 开始抽取设定圣经 (${ev.episodes} 集)…`}
                {ev.kind === 'bible_done' && `📖 圣经就绪: ${ev.chars} 个角色 · 世界观「${ev.era || '—'}」`}
                {ev.kind === 'overview_start' && `🌐 全局总览[${ev.source}] 扫描 ${(ev.episodes||[]).length} 集…`}
                {ev.kind === 'overview_done' && `🌐 全局总览[${ev.source}] 记账 ${ev.found} 条问题`}
                {ev.kind === 'gate_hits' && `🚦 第${ev.episode}集 确定性闸门命中 ${ev.count} 条`}
                {ev.kind === 'round_start' && `── 第${ev.episode}集 第${ev.round}轮 [${THEME_LABEL[ev.theme] || ev.theme}] 评审`}
                {ev.kind === 'reviewer_done' && `· ${ROLE_LABEL[ev.role] || ev.role} / ${modelLabel(ev.model)} 出 ${ev.count} 条`}
                {ev.kind === 'chief_start' && `🧭 第${ev.episode}集 总编辑综合 ${ev.issues} 条意见…`}
                {ev.kind === 'chief_done' && `🧭 第${ev.episode}集 总编辑定方案 ${ev.plan} 条 (驳回 ${ev.dropped})`}
                {ev.kind === 'editor_done' && `✎ 第${ev.episode}集 编辑执行完成`}
                {ev.kind === 'repair_phase_start' && `🔧 末尾定向补修: ${(ev.episodes||[]).length} 集待修`}
                {ev.kind === 'repair_start' && `🔧 第${ev.episode}集 补修 ${ev.issues} 条遗留问题…`}
                {ev.kind === 'repair_done' && `🔧 第${ev.episode}集 补修完成`}
                {ev.kind === 'repair_phase_done' && `🔧 定向补修阶段结束`}
              </div>
            ))}
          </div>
          {/* 全局总览时间线 */}
          {Array.isArray(board.global_reviews) && board.global_reviews.length > 0 && (
            <div className="text-caption text-ink-muted border-t border-line pt-2">
              <span className="font-medium">全局总览：</span>
              {board.global_reviews.map((g: any, i: number) => (
                <span key={i} className="ml-1">[{g.source} 查{(g.scope||[]).length}集/记{g.found}条]</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 失败/中断: 可断点续跑 */}
      {active && isCritiqueResumable(active) && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-body font-medium text-warning">
                任务 #{active.id} 已中断（{active.status}）· 进度 {active.progress || 0}%
              </span>
            </div>
            <Button variant="primary" size="sm" leftIcon={<PlayCircle className="w-3.5 h-3.5" />}
              onClick={() => onResume(active.id)}>
              从中断点继续
            </Button>
          </div>
          {active.error && (
            <p className="text-caption text-ink-muted">中断原因：{active.error}</p>
          )}
          <p className="text-caption text-ink-muted">
            已完成的集会被自动跳过，仅补未完成的集，不重复消耗。继续后本区会转为运行看板。
          </p>
        </div>
      )}

      {/* 结果区 */}
      {active && active.status === 'succeeded' && result && (
        <div className="rounded-lg border border-line bg-surface-base/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-body font-medium text-success">精修完成 #{active.id}</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" loading={exporting}
                leftIcon={!exporting ? <FileDown className="w-3.5 h-3.5" /> : undefined}
                onClick={() => onExportLog(active.id)}
                title="导出建议/采纳/驳回的完整过程为 Word">
                导出精修过程
              </Button>
              {!active.applied ? (
                <Button variant="primary" size="sm" leftIcon={<Check className="w-3.5 h-3.5" />} onClick={() => onApply(active.id)}>
                  全部采纳并覆盖
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-caption text-success">已采纳覆盖</span>
                  {/* 允许重新采纳: 修复解析后, 之前被跳过的集可再次覆盖(后端幂等, 覆盖前仍存历史版本可回滚) */}
                  <Button variant="ghost" size="sm" leftIcon={<Check className="w-3.5 h-3.5" />} onClick={() => onApply(active.id)}
                    title="再次用精修稿覆盖(用于之前解析失败被跳过、现已修复的集)">
                    重新采纳
                  </Button>
                </div>
              )}
            </div>
          </div>
          {active.applied ? (
            <p className="text-caption text-ink-muted">
              已写回{active.source === 'storyboard' ? '剧本' : '章节'}。如需回滚：到「章节」分页打开对应集 →「历史版本」可恢复精修前的稿。
            </p>
          ) : null}
          {Object.entries(result.episodes || {}).map(([ep, data]: [string, any]) => (
            <div key={ep} className="rounded-md border border-line p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-body font-medium">第 {ep} 集</span>
                {data.changed ? (
                  <span className="text-caption text-success">已优化 · {data.issue_count} 处问题</span>
                ) : (
                  <span className="text-caption text-ink-muted">无改动</span>
                )}
                {Array.isArray(data.curve) && data.curve.length > 1 && (
                  <span className="text-caption text-ink-muted ml-auto" title="逐轮问题数（收敛曲线）">
                    收敛 {data.curve.join(' → ')}
                  </span>
                )}
              </div>
              {data.changed && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-caption text-ink-muted mb-1">原文</div>
                    <pre className="text-caption whitespace-pre-wrap font-sans leading-relaxed bg-surface-overlay/40 rounded p-2 max-h-48 overflow-y-auto">{formatCritiqueText(data.original, data.is_storyboard)}</pre>
                  </div>
                  <div>
                    <div className="text-caption text-ink-muted mb-1">精修后</div>
                    <pre className="text-caption whitespace-pre-wrap font-sans leading-relaxed bg-success/5 rounded p-2 max-h-48 overflow-y-auto">{formatCritiqueText(data.refined, data.is_storyboard)}</pre>
                  </div>
                </div>
              )}
              {(issuesByEp[ep] || []).length > 0 && (
                <details className="text-caption">
                  <summary className="cursor-pointer text-ink-secondary">查看 {issuesByEp[ep].length} 条评审意见</summary>
                  <div className="mt-2 space-y-1">
                    {issuesByEp[ep].map((it, i) => (
                      <div key={i} className="border-l-2 border-line pl-2">
                        <span className={SEV_TONE[it.severity || ''] || ''}>[{it.severity}]</span>
                        {' '}<span className="text-ink-muted">{ROLE_LABEL[it.role || ''] || it.role}·{THEME_LABEL[it.theme || ''] || it.theme}·置信{it.confidence}%</span>
                        <div className="text-ink-secondary">{it.issue}</div>
                        {it.fix_hint && <div className="text-ink-muted">建议：{it.fix_hint}</div>}
                        {/* D5.1: 钩子体检的结构化结果——六变量 + 分数 + 可逐条采纳的策略 */}
                        {it.role_kind === 'hook_audit' && (
                          <HookAudit audit={it} />
                        )}
                        {/* D5.3: 结构问题提示走"改契约重生成"而非行级重写 */}
                        {isStructuralIssue(it) && (
                          <div className="text-warning mt-1">
                            ⚠ 这是**结构问题**，改句子修不好 — 建议先改本集契约再重新生成本集
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 历史任务 */}
      {runs.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-caption text-ink-muted">精修历史</span>
            <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3 h-3" />} onClick={() => refresh()}>刷新</Button>
          </div>
          {runs.map((r) => (
            <button key={r.id} onClick={() => setActive(r)}
              className={`w-full text-left text-caption px-2 py-1.5 rounded hover:bg-white/[0.04] ${active?.id === r.id ? 'bg-white/[0.06]' : ''}`}>
              #{r.id} · {r.source === 'storyboard' ? '剧本' : '章节'} · 全量 · {r.status}
              {r.applied ? ' · 已采纳' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
/** D5.3: 结构性问题码（与后端 critique/restructure.py 的 STRUCTURAL_GATE_CODES 对齐）。 */
const STRUCTURAL_CODES = new Set([
  'value_shift_noop', 'value_shift_repeat', 'escalation_stall',
  'hook_weak', 'hook_missing_leads_to', 'stakes_vague',
  'stakes_too_vague_short', 'stakes_missing', 'promise_overdue',
]);

const STRUCTURAL_KEYWORDS = [
  '没有价值转变', '价值转变', '节奏拖沓', '中段疲软', '钩子', '卡点',
  '失败代价', '升级', '流水账', '开头不够抓人',
];

function isStructuralIssue(it: any): boolean {
  if (!it) return false;
  if (it.role_kind === 'hook_audit') return true;
  if (it.code && STRUCTURAL_CODES.has(it.code)) return true;
  const text = `${it.issue || ''}${it.fix_hint || ''}`;
  return STRUCTURAL_KEYWORDS.some((k) => text.includes(k));
}

/** D5.1: 六变量钩子体检卡。 */
const HOOK_VARS: { key: string; label: string }[] = [
  { key: 'disruption', label: '异常事件' },
  { key: 'info_gap', label: '信息缺口' },
  { key: 'stakes', label: '失败代价' },
  { key: 'conflict', label: '当场冲突' },
  { key: 'promise', label: '爽点承诺' },
  { key: 'open_loop', label: '未闭合问题' },
];

function HookAudit({ audit }: { audit: any }) {
  const vars = audit.variables || {};
  const score = typeof audit.hook_score === 'number' ? audit.hook_score : null;
  const tone =
    score === null ? 'text-ink-secondary'
      : score >= 75 ? 'text-success'
        : score >= 50 ? 'text-warning'
          : 'text-danger';
  return (
    <div className="mt-1.5 p-2 rounded border border-line bg-surface-base/40">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-ink-secondary font-medium">钩子体检</span>
        {score !== null && <span className={`${tone} font-semibold`}>{score} 分</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {HOOK_VARS.map((v) => {
          const raw = vars[v.key];
          const state = typeof raw === 'string' ? raw : raw ? 'ok' : 'missing';
          const mark = state === 'ok' ? '✓' : state === 'weak' ? '△' : '✗';
          const cls = state === 'ok' ? 'text-success' : state === 'weak' ? 'text-warning' : 'text-danger';
          return (
            <span key={v.key} className="text-ink-muted">
              <span className={cls}>{mark}</span> {v.label}
            </span>
          );
        })}
      </div>
      {Array.isArray(audit.rewrite_strategy) && audit.rewrite_strategy.length > 0 && (
        <div className="mt-1.5">
          <div className="text-ink-secondary mb-0.5">可执行的改法（可直接采纳）：</div>
          <ol className="list-decimal list-inside space-y-0.5 text-ink-secondary">
            {audit.rewrite_strategy.map((s: string, i: number) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
