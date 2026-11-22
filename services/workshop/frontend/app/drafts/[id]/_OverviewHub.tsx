'use client';

/**
 * 总览中心 v4 (方案 B: 仪表盘 + 二级 Tab)
 *
 * 结构:
 *   1) 顶部「创作健康度」仪表盘: 综合评分环 + 4 个 KPI 卡(评级/风险/角色/完播) + 一键生成总览。
 *      数据缺失时 KPI 显示"待生成", 引导点一键生成。
 *   2) 下方二级 Tab: 剧情分析 | 角色图谱 | 安全合规 | 设定圣经, 一次只看一块,
 *      取代旧的"手风琴套手风琴"。Tab 懒挂载, 首次切到才请求数据。
 *
 * 深链: window.location.hash = #analysis|#characters|#safety|#bible 进入对应 Tab。
 * 旧 ?tab=analysis/safety/characters 仍由 page.tsx 重定向到 overview + 对应 hash。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/Tabs';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { ScoreRing } from '@/components/charts/ScoreRing';
import {
  Sparkles, BookMarked, Loader2, RefreshCw, Users2,
  LineChart, ShieldAlert, BookText, CheckCircle2, Clock,
} from 'lucide-react';
import { AnalysisPanel } from './_AnalysisPanel';
import { SafetyPanel } from './_SafetyPanel';
import { CharactersPanel } from './_CharactersPanel';
import { getStoryBible, buildStoryBible, saveStoryBible, type StoryBible } from '@/lib/critique';
import { authFetch } from '@/lib/auth';

const API = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type SubTab = 'analysis' | 'characters' | 'safety' | 'bible';

const GRADE_DESC: Record<string, string> = {
  S: '精品爆款潜质', A: '优质作品', B: '及格线', C: '需重写', D: '建议大改',
};

// ===========================================================================
// 仪表盘数据聚合: 综合评分 / 风险 / 角色 / 完播 / 圣经状态
// ===========================================================================
type DashData = {
  loading: boolean;
  analysisStatus?: string;          // pending/running/done/failed/none
  grade?: string;
  score?: number;
  completion?: 'high' | 'medium' | 'low';
  riskCount?: number;               // 最近一份安全报告未解决数, 退化到风险总数
  riskOverall?: string;             // pass/warning/fail
  charCount?: number;
  relCount?: number;
  hasBible: boolean;
};

function useDashboard(draftId: number, refreshKey: number): DashData {
  const [d, setD] = useState<DashData>({ loading: true, hasBible: false });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // showLoading: 首次/手动刷新时显示"加载概览…"; 轮询时静默更新不闪 loading。
    const fetchOnce = async (showLoading: boolean) => {
      if (showLoading) setD((p) => ({ ...p, loading: true }));
      const out: DashData = { loading: false, hasBible: false };
      // 并行拉四块, 任一失败不影响其它
      const [analysisR, charR, relR, safetyR, bibleR] = await Promise.allSettled([
        authFetch(`${API}/v1/stages/drafts/${draftId}/analysis`),
        authFetch(`${API}/v1/drafts/${draftId}/characters`),
        authFetch(`${API}/v1/drafts/${draftId}/characters/relationships`),
        authFetch(`${API}/v1/drafts/${draftId}/safety-reports`),
        getStoryBible(draftId).then((b) => b).catch(() => null),
      ]);

      if (analysisR.status === 'fulfilled' && analysisR.value.ok) {
        const j = await analysisR.value.json();
        const a = j.analysis;
        if (a) {
          out.analysisStatus = a.status;
          out.grade = a.overall_grade;
          out.score = a.overall_score;
          out.completion = a.audience_json?.completion_rate_predict;
        } else {
          out.analysisStatus = 'none';
        }
      }
      if (charR.status === 'fulfilled' && charR.value.ok) {
        const j = await charR.value.json();
        out.charCount = (j.items || []).length;
      }
      if (relR.status === 'fulfilled' && relR.value.ok) {
        const j = await relR.value.json();
        out.relCount = (j.items || []).length;
      }
      if (safetyR.status === 'fulfilled' && safetyR.value.ok) {
        const j = await safetyR.value.json();
        const latest = (j.items || [])[0];
        if (latest) {
          out.riskOverall = latest.overall;
          out.riskCount = latest.unresolved_count ?? latest.total_issues ?? 0;
        }
      }
      if (bibleR.status === 'fulfilled' && bibleR.value) {
        out.hasBible = ((bibleR.value as StoryBible).characters || []).length > 0;
      }
      if (!alive) return;
      setD(out);

      // 分析仍在 pending/running: 8s 后静默再拉一次, 直到 done/failed/none
      // (解决"从别处触发分析后进总览页看不到进行中/跑完不自动刷新"的问题)
      if (out.analysisStatus === 'pending' || out.analysisStatus === 'running') {
        timer = setTimeout(() => fetchOnce(false), 8000);
      }
    };

    fetchOnce(true);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [draftId, refreshKey]);

  return d;
}

// ---------- KPI 小卡 ----------
function KpiCard({
  icon, label, value, hint, tone = 'default', onClick,
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'danger' | 'muted'; onClick?: () => void;
}) {
  const toneCls = {
    default: 'border-line',
    good: 'border-success/40 bg-success/[0.04]',
    warn: 'border-warning/40 bg-warning/[0.04]',
    danger: 'border-danger/40 bg-danger/[0.04]',
    muted: 'border-line bg-white/[0.02]',
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`text-left rounded-lg border p-3 transition-colors ${toneCls} ${onClick ? 'hover:bg-white/[0.05] cursor-pointer' : 'cursor-default'}`}
    >
      <div className="flex items-center gap-1.5 text-caption text-ink-muted mb-1">
        {icon}<span>{label}</span>
      </div>
      <div className="text-card-title font-semibold text-ink-primary leading-tight">{value}</div>
      {hint && <div className="text-micro text-ink-muted mt-0.5">{hint}</div>}
    </button>
  );
}

// ---------- 顶部仪表盘 ----------
function Dashboard({
  draftId, refreshKey, onGenerateAll, generating, goTab,
}: {
  draftId: number; refreshKey: number; onGenerateAll: () => void; generating: boolean;
  goTab: (t: SubTab) => void;
}) {
  const d = useDashboard(draftId, refreshKey);
  const analysisDone = d.analysisStatus === 'done';
  const analysisRunning = d.analysisStatus === 'pending' || d.analysisStatus === 'running';

  const completionText = d.completion === 'high' ? '🟢 高' : d.completion === 'medium' ? '🟡 中' : d.completion === 'low' ? '🔴 低' : '—';
  const riskTone = d.riskOverall === 'fail' ? 'danger' : d.riskOverall === 'warning' ? 'warn' : (d.riskCount ?? 0) > 0 ? 'warn' : 'good';

  return (
    <Card padding="lg">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-lg font-bold text-ink-primary flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" /> 创作健康度
          </h2>
          <p className="text-caption text-ink-muted mt-0.5">
            一处看全剧情评级 / 风险 / 角色 / 设定。导入剧本的草稿会自动生成, 也可随时一键重算。
          </p>
        </div>
        <Button variant="primary" size="md" loading={generating || analysisRunning}
          disabled={generating || analysisRunning}
          leftIcon={!(generating || analysisRunning) ? <Sparkles className="w-4 h-4" /> : undefined}
          onClick={onGenerateAll}>
          {analysisRunning ? '分析进行中…' : '一键生成 / 刷新全部'}
        </Button>
      </div>

      {d.loading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-ink-muted">
          <Spinner size="md" className="text-primary" /> 加载概览…
        </div>
      ) : (
        <div className="grid md:grid-cols-[auto_1fr] gap-6 items-center">
          {/* 评分环 */}
          <div className="flex flex-col items-center justify-center min-w-[180px]">
            {analysisDone ? (
              <>
                <ScoreRing score={d.score || 0} grade={d.grade || 'C'} size={150} thickness={12} label="综合得分" />
                <div className="mt-2 text-caption text-ink-secondary">
                  {d.grade} 级 · {GRADE_DESC[d.grade || 'C'] || ''}
                </div>
              </>
            ) : analysisRunning ? (
              <div className="flex flex-col items-center text-ink-muted py-6">
                <Loader2 className="w-10 h-10 animate-spin text-primary mb-2" />
                <span className="text-caption">分析进行中…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center text-ink-muted py-6">
                <LineChart className="w-10 h-10 opacity-40 mb-2" />
                <span className="text-caption">尚未分析</span>
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => goTab('analysis')}>去分析 →</Button>
              </div>
            )}
          </div>

          {/* KPI 卡组 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            <KpiCard
              icon={<LineChart className="w-3.5 h-3.5" />} label="剧情评级"
              value={analysisDone ? `${d.grade} (${d.score})` : analysisRunning ? '分析中' : '待生成'}
              hint={analysisDone ? '点开查看爆点/建议' : undefined}
              tone={analysisDone ? 'good' : 'muted'}
              onClick={() => goTab('analysis')}
            />
            <KpiCard
              icon={<ShieldAlert className="w-3.5 h-3.5" />} label="安全风险"
              value={d.riskOverall ? (d.riskCount ?? 0) + ' 项待处理' : '待扫描'}
              hint={d.riskOverall ? (d.riskOverall === 'pass' ? '通过' : d.riskOverall === 'fail' ? '存在严重项' : '有提示') : undefined}
              tone={d.riskOverall ? (riskTone as any) : 'muted'}
              onClick={() => goTab('safety')}
            />
            <KpiCard
              icon={<Users2 className="w-3.5 h-3.5" />} label="角色 / 关系"
              value={(d.charCount ?? 0) > 0 ? `${d.charCount} 角色` : '待生成'}
              hint={(d.charCount ?? 0) > 0 ? `${d.relCount ?? 0} 条关系` : undefined}
              tone={(d.charCount ?? 0) > 0 ? 'good' : 'muted'}
              onClick={() => goTab('characters')}
            />
            <KpiCard
              icon={<BookText className="w-3.5 h-3.5" />} label="设定圣经"
              value={d.hasBible ? '已构建' : '待构建'}
              hint={d.hasBible ? '精修一致性事实源' : undefined}
              tone={d.hasBible ? 'good' : 'muted'}
              onClick={() => goTab('bible')}
            />
            <div className="col-span-2 lg:col-span-4">
              <KpiCard
                icon={<Clock className="w-3.5 h-3.5" />} label="完播率预测"
                value={completionText}
                tone="default"
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ===========================================================================
// 设定圣经 Tab 内容 (从旧 StoryBibleSection 平移, 去掉折叠外壳)
// ===========================================================================
function StoryBibleTab({ draftId, onChanged }: { draftId: number; onChanged?: () => void }) {
  const toast = useToast();
  const [bible, setBible] = useState<StoryBible>({});
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setBible(await getStoryBible(draftId)); } finally { setLoading(false); }
  }, [draftId]);
  useEffect(() => { load(); }, [load]);

  const onBuild = async () => {
    if (!window.confirm('将通读全剧、三模型抽取并裁决出《设定圣经》(世界观/人物/称谓/驱动力/桥段)，可能耗时数十秒。继续？')) return;
    setBuilding(true);
    try {
      const b = await buildStoryBible(draftId);
      setBible(b); toast.success('设定圣经已构建'); onChanged?.();
    } catch (e) { toast.error(`构建失败: ${(e as Error).message}`); }
    finally { setBuilding(false); }
  };
  const onEdit = () => { setDraftText(JSON.stringify(bible, null, 2)); setEditing(true); };
  const onSave = async () => {
    let parsed: StoryBible;
    try { parsed = JSON.parse(draftText); } catch { toast.error('JSON 格式有误'); return; }
    try {
      const b = await saveStoryBible(draftId, parsed);
      setBible(b); setEditing(false); toast.success('已保存圣经'); onChanged?.();
    } catch (e) { toast.error(`保存失败: ${(e as Error).message}`); }
  };

  const world = bible.world || {};
  const cd = bible.core_drive || {};
  const hasBible = (bible.characters || []).length > 0;

  return (
    <div className="space-y-4">
      <Card padding="md" className="flex items-center gap-2 flex-wrap">
        <div className="mr-auto">
          <div className="text-card-title font-semibold text-ink-primary">📖 设定圣经</div>
          <div className="text-caption text-ink-muted">全剧唯一事实源(世界观/正名/称谓/驱动力/桥段)，评审精修优先读取它做一致性校验。</div>
        </div>
        <Button variant="primary" size="sm" loading={building}
          leftIcon={!building ? <BookMarked className="w-3.5 h-3.5" /> : undefined} onClick={onBuild}>
          {hasBible ? '重新构建' : '构建圣经'}
        </Button>
        {hasBible && !editing && <Button variant="ghost" size="sm" onClick={onEdit}>人工微调</Button>}
        {editing && (<>
          <Button variant="primary" size="sm" onClick={onSave}>保存</Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>取消</Button>
        </>)}
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3 h-3" />} onClick={load}>刷新</Button>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
      </Card>

      {editing ? (
        <Card padding="md">
          <textarea
            className="w-full h-96 rounded-md bg-surface-base border border-line p-3 text-caption font-mono"
            value={draftText} onChange={(e) => setDraftText(e.target.value)}
          />
        </Card>
      ) : hasBible ? (
        <Card padding="md" className="space-y-3 text-body">
          <div className="flex flex-wrap gap-2">
            <Badge tone="primary" size="md">世界观: {world.era || '—'}</Badge>
            {world.locale && <Badge tone="muted" size="md">{world.locale}</Badge>}
            {world.tech_level && <Badge tone="muted" size="md">科技 {world.tech_level}</Badge>}
          </div>
          <div>
            <div className="text-caption text-ink-muted mb-1">核心驱动力</div>
            <div className="text-ink-secondary">{cd.protagonist || '—'} — {cd.goal || '—'}
              {(cd.locked_keywords || []).length > 0 && (
                <span className="ml-2 text-caption text-ink-muted">锁定: {(cd.locked_keywords || []).join('、')}</span>
              )}
            </div>
          </div>
          {(world.anachronism_terms || []).length > 0 && (
            <div>
              <div className="text-caption text-ink-muted mb-1">时代违禁词 (精修禁止出现)</div>
              <div className="flex flex-wrap gap-1">
                {(world.anachronism_terms || []).map((t, i) => (
                  <span key={i} className="text-caption px-1.5 py-0.5 rounded bg-danger/10 text-danger">{t}</span>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-caption text-ink-muted mb-1">主要人物名册 ({(bible.characters || []).length})</div>
            <div className="flex flex-wrap gap-1">
              {(bible.characters || []).map((c, i) => (
                <Badge key={i} tone="muted" size="sm" {...({ title: c.identity } as any)}>{c.canonical}</Badge>
              ))}
            </div>
            <div className="text-micro text-ink-muted mt-1">提示: 全员角色与人际关系网请看「角色图谱」Tab。</div>
          </div>
          {(bible.address_matrix || []).length > 0 && (
            <div>
              <div className="text-caption text-ink-muted mb-1">称谓锁定</div>
              <div className="text-caption text-ink-secondary">
                {(bible.address_matrix || []).map((r, i) => (
                  <span key={i} className="mr-2">{r.from}称{r.to}为「{r.term}」</span>
                ))}
              </div>
            </div>
          )}
          {(bible.trope_labels || []).length > 0 && (
            <div>
              <div className="text-caption text-ink-muted mb-1">桥段标签 (去重计数依据)</div>
              <div className="flex flex-wrap gap-1">
                {(bible.trope_labels || []).map((t, i) => (
                  <span key={i} className="text-caption px-1.5 py-0.5 rounded bg-surface-overlay/50 text-ink-secondary">{t}</span>
                ))}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card padding="lg" className="text-center text-ink-muted">
          <BookText className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p className="text-body mb-1">尚未构建设定圣经</p>
          <p className="text-caption">点上方「构建圣经」, 抽取世界观/人物正名/称谓/复仇目标/桥段, 作为精修一致性校验的事实源。</p>
        </Card>
      )}
    </div>
  );
}

// ===========================================================================
// 角色图谱 Tab: 卡库构建按钮 + 全员角色/关系网 (CharactersPanel)
// ===========================================================================
function CharactersTab({ draftId, onChanged }: { draftId: number; onChanged?: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const onBuild = async () => {
    setLoading(true);
    try {
      const r = await authFetch(`${API}/v1/drafts/${draftId}/characters/cards/build`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('角色卡库生成已在后台启动, 约数十秒后点刷新查看');
    } catch (e) { toast.error(`启动失败: ${(e as Error).message}`); }
    finally { setLoading(false); }
  };
  return (
    <div className="space-y-4">
      <Card padding="md" className="flex items-center gap-2 flex-wrap">
        <div className="mr-auto">
          <div className="text-card-title font-semibold text-ink-primary">角色图谱</div>
          <div className="text-caption text-ink-muted">全盘扫描全剧抽取所有角色卡(身份/性格/背景)与人际关系网; 与「设定圣经」侧重主角不同, 这里覆盖全员。</div>
        </div>
        <Button variant="primary" size="sm" loading={loading}
          leftIcon={!loading ? <Users2 className="w-3.5 h-3.5" /> : undefined} onClick={onBuild}>
          一键生成角色卡库
        </Button>
      </Card>
      <CharactersPanel draftId={draftId} />
    </div>
  );
}

// ===========================================================================
// 主组件: 仪表盘 + 二级 Tab
// ===========================================================================
export function OverviewHub({ draftId, draftTitle }: { draftId: number; draftTitle?: string }) {
  const toast = useToast();
  const [tab, setTab] = useState<SubTab>('analysis');
  const [generating, setGenerating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 记录已挂载过的 Tab, 实现懒挂载 + 保活(切回不重新请求)
  const [mounted, setMounted] = useState<Set<SubTab>>(new Set(['analysis']));

  // 进入时按 hash 定位 Tab; 监听 hash 变化(来自 page.tsx 旧 tab 重定向)
  useEffect(() => {
    const apply = () => {
      const h = (typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '') as SubTab;
      if (h === 'analysis' || h === 'characters' || h === 'safety' || h === 'bible') {
        setTab(h);
        setMounted((m) => new Set(m).add(h));
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const goTab = useCallback((t: SubTab) => {
    setTab(t);
    setMounted((m) => new Set(m).add(t));
    try { history.replaceState(null, '', `#${t}`); } catch { /* noop */ }
  }, []);

  const onGenerateAll = async () => {
    if (!window.confirm('将一次性后台生成/刷新: 剧情分析 + 角色卡库 + 设定圣经。可能耗时 1-2 分钟, 完成后点各 Tab 的刷新或重进本页查看。继续？')) return;
    setGenerating(true);
    try {
      await Promise.allSettled([
        authFetch(`${API}/v1/stages/drafts/${draftId}/analysis/start`, { method: 'POST' }),
        authFetch(`${API}/v1/drafts/${draftId}/characters/cards/build`, { method: 'POST' }),
        buildStoryBible(draftId),
      ]);
      toast.success('三项分析已在后台启动, 稍后刷新查看');
      setTimeout(() => setRefreshKey((k) => k + 1), 1500);
    } catch (e) { toast.error(`启动失败: ${(e as Error).message}`); }
    finally { setGenerating(false); }
  };

  const tabItems = [
    { value: 'analysis', label: <span className="inline-flex items-center gap-1.5"><LineChart className="w-3.5 h-3.5" />剧情分析</span> },
    { value: 'characters', label: <span className="inline-flex items-center gap-1.5"><Users2 className="w-3.5 h-3.5" />角色图谱</span> },
    { value: 'safety', label: <span className="inline-flex items-center gap-1.5"><ShieldAlert className="w-3.5 h-3.5" />安全合规</span> },
    { value: 'bible', label: <span className="inline-flex items-center gap-1.5"><BookText className="w-3.5 h-3.5" />设定圣经</span> },
  ];

  return (
    <div className="space-y-4">
      <Dashboard
        draftId={draftId} refreshKey={refreshKey}
        onGenerateAll={onGenerateAll} generating={generating} goTab={goTab}
      />

      <div className="sticky top-2 z-10 bg-surface-base/80 backdrop-blur rounded-lg">
        <Tabs items={tabItems} value={tab} onChange={(v) => goTab(v as SubTab)} variant="segmented" size="md" fullWidth />
      </div>

      {/* 懒挂载: 只渲染访问过的 Tab, 用 hidden 保活避免切回重拉 */}
      <div className={tab === 'analysis' ? '' : 'hidden'}>
        {mounted.has('analysis') && <AnalysisPanel draftId={draftId} draftTitle={draftTitle || `草稿${draftId}`} />}
      </div>
      <div className={tab === 'characters' ? '' : 'hidden'}>
        {mounted.has('characters') && <CharactersTab draftId={draftId} onChanged={() => setRefreshKey((k) => k + 1)} />}
      </div>
      <div className={tab === 'safety' ? '' : 'hidden'}>
        {mounted.has('safety') && <SafetyPanel draftId={draftId} />}
      </div>
      <div className={tab === 'bible' ? '' : 'hidden'}>
        {mounted.has('bible') && <StoryBibleTab draftId={draftId} onChanged={() => setRefreshKey((k) => k + 1)} />}
      </div>
    </div>
  );
}