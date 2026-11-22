'use client';
import * as React from 'react';
import {
  BookOpen,
  MessageSquareQuote,
  Loader2,
  RefreshCw,
  Sparkles,
  Download,
  History,
  Pencil,
  Save,
  X,
  Ruler,
} from 'lucide-react';
import { authFetch } from '../../../lib/auth';
import { Button, useToast } from '@/components/ui';
import { confirmAsync } from '@/lib/dialog';
import { ModelSelect } from '@/components/ModelSelect';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type AdaptKind = 'novel' | 'tweet';

type AdaptItem = {
  chapter_order: number;
  content: string;
  word_count: number;
  version: number;
  user_edited: boolean;
  protagonist: string;
  updated_at?: string;
};

type AdaptJob = {
  id: number;
  kind: string;
  status: string; // running|done|partial|failed|canceled
  model: string;
  protagonist: string;
  total: number;
  finished: number;
  per_ep?: Record<string, any>;
  error?: string;
};


const ACTIVE = new Set(['running', 'pending']);

const KIND_META: Record<AdaptKind, { title: string; icon: React.ReactNode; desc: string }> = {
  novel: {
    title: '小说',
    icon: <BookOpen className="w-5 h-5 text-primary" />,
    desc: '在不改变原文剧情、人物、逻辑的前提下,丰富画面、动作、神态等描写。',
  },
  tweet: {
    title: '推文',
    icon: <MessageSquareQuote className="w-5 h-5 text-primary" />,
    desc: '把原文转写成主角第一人称文本(先由AI 建议主角, 确认后逐章生成)。',
  },
};

const WORD_PRESETS = [
  { label: '短篇', v: 3000 },
  { label: '标准', v: 1500 },
  { label: '中长', v: 7000 },{ label: '长篇', v: 10000 },
];

export function AdaptRoom({
  draftId,
  kind,
  initialWordTarget = 900,
}: {
  draftId: number;
  kind: AdaptKind;
  initialWordTarget?: number;
}) {
  const toast = useToast();
  const meta = KIND_META[kind];
  const [model, setModel] = React.useState('deepseek');
  const [items, setItems] = React.useState<AdaptItem[]>([]);
  // 原文已有的集号(含尚未生成本类产物的集) —— 用于渲染空态卡片, 见 fetchChapterOrders
  const [chapterOrders, setChapterOrders] = React.useState<number[]>([]);
  const [job, setJob] = React.useState<AdaptJob | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [protagonist, setProtagonist] = React.useState('');
  const [busyOrder, setBusyOrder] = React.useState<number | null>(null);
  const [editingOrder, setEditingOrder] = React.useState<number | null>(null);
  const [editText, setEditText] = React.useState('');
  const [feedbackFor, setFeedbackFor] = React.useState<number | null>(null);
  const [feedbackText, setFeedbackText] = React.useState('');
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // 字数控制
  const [wordTarget, setWordTarget] = React.useState(initialWordTarget);
  const [wordSaving, setWordSaving] = React.useState(false);
  const [wordEditing, setWordEditing] = React.useState(false);
  const [wordEditVal, setWordEditVal] = React.useState(initialWordTarget);

  React.useEffect(() => {
    setWordTarget(initialWordTarget);
    setWordEditVal(initialWordTarget);
  }, [initialWordTarget]);

  async function saveWordTarget(newVal: number) {
    if (newVal < 500|| newVal > 20000) {
      toast.error('字数范围: 500 ~ 20000');
      return;
    }
    if (newVal === wordTarget) return;
    setWordSaving(true);
    try {
      // ⚠ 必须带 /stages 前缀: PATCH 草稿的路由在 stages_router 上
      // (services/orchestrator/app/stages/router.py, prefix=/v1/stages),
      // /v1/drafts 前缀下只有 overview/tags/prompts 等子路由, 没有草稿本体的 PATCH。
      // 写成 /v1/drafts/{id} 会 404, 用户看到的就是"字数更新失败: HTTP 404"。
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapter_word_target: newVal }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setWordTarget(newVal);
      toast.success(`每章目标字数已更新为 ${newVal} 字`);
    } catch (e: any) {
      toast.error(`字数更新失败: ${e?.message || e}`);
    } finally {
      setWordSaving(false);
    }
  }

  async function fetchData() {
    try {
      const r = await authFetch(`${BASE}/v1/adapt/${kind}?draft_id=${draftId}`);
      if (!r.ok) return;
      const d = await r.json();
      setItems(Array.isArray(d.items) ? d.items : []);
      setJob(d.job || null);
      if (d.job?.protagonist) setProtagonist(d.job.protagonist);
    } catch {
      /* noop */
    }
  }

  /**
   * 拉原文章节号清单, 用于给"还没生成产物的集"也渲染一张空卡片。
   *
   * 为什么需要: 原先只渲染 items(已有产物), 没生成过就整个 tab 只有一句
   * "暂无内容, 点击一键生成" —— 用户想把对话工坊生成的文本手动粘进某一集时
   * 根本没有入口。现在空集也给卡片 + 「手动填写」按钮。
   *
   * ⚠️ 必须带 fields=meta: 这里只用 chapter_order 一个整数,
   * 走全量会连每章 full_text 一起拉(实测单草稿 1.6 MB)然后直接丢弃,
   * 纯 HTTP/1.1 下这段传输会把卡片渲染拖住好几秒。
   */
  async function fetchChapterOrders() {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/chapters?fields=meta`);
      if (!r.ok) return;
      const d = await r.json();
      const list = Array.isArray(d) ? d : (d.items || []);
      setChapterOrders(
        list.map((c: any) => c.chapter_order ?? c.order).filter((n: any) => typeof n === "number")
          .sort((a: number, b: number) => a - b),
      );
    } catch {
      /* noop */
    }
  }

  // 已有产物 + 原文里有但本类还没生成的集(空卡片), 按集号排序
  const displayRows: AdaptItem[] = React.useMemo(() => {
    const byOrder = new Map(items.map((it) => [it.chapter_order, it]));
    const orders = Array.from(new Set([...items.map((i) => i.chapter_order), ...chapterOrders]))
      .sort((a, b) => a - b);
    return orders.map((o) => byOrder.get(o) || ({
      chapter_order: o, content: '', word_count: 0, version: 0,
      user_edited: false, protagonist: '',
    } as AdaptItem));
  }, [items, chapterOrders]);

  React.useEffect(() => {
    fetchData();
    fetchChapterOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, kind]);

  // 对话工坊「一键替换」写入小说/推文后会 postMessage 过来, 只重拉数据不重载页面
  React.useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "drama:draft-updated") return;
      // kind 为空(未知)时也刷新一次, 宁可多拉一次也别让用户看到旧内容
      if (e.data.kind && e.data.kind !== kind) return;
      void fetchData();
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, kind]);

  // 有进行中的作业时轮询
  React.useEffect(() => {
    const isActive = job && ACTIVE.has(job.status);
    if (isActive && !pollRef.current) {
      pollRef.current = setInterval(fetchData, 4000);
    }
    if (!isActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  async function doGenerate(withProtagonist: string) {
    setStarting(true);
    try {
      const r = await authFetch(`${BASE}/v1/adapt/${kind}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: draftId, model, protagonist: withProtagonist }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      toast.success(`已启动一键生成 #${d.job_id}`);
      await fetchData();
    } catch (e: any) {
      toast.error(`启动失败: ${e?.message || e}`);
    } finally {
      setStarting(false);
    }
  }

  async function start() {
    // 已有产物时二次确认(会覆盖,覆盖前每章自动存历史可回滚)
    if (items.length > 0) {
      const ok = await confirmAsync({
        title: `重新一键生成${meta.title}`,
        description: '会逐章重新生成并覆盖现有内容(覆盖前每章自动存历史版本, 可回滚)。',
        confirmText: '开始',
        tone: 'warning',
      });
      if (!ok) return;
    }
    if (kind === 'tweet') {
      // 先让AI 建议主角, 用户确认一次
      setStarting(true);
      try {
        const r = await authFetch(`${BASE}/v1/adapt/tweet/suggest-protagonist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_id: draftId, model }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
        const suggested = d.name || '主角';
        setStarting(false);
        const input = window.prompt(
          `AI 建议以「${suggested}」作为第一人称主角${d.reason ? `(理由: ${d.reason})` : ''}。\n\n确认或修改主角名后开始生成:`,
          suggested,
        );
        if (input == null) return; // 用户取消
        const chosen = input.trim() || suggested;
        setProtagonist(chosen);
        await doGenerate(chosen);
      } catch (e: any) {
        setStarting(false);
        toast.error(`获取主角建议失败: ${e?.message || e}`);
      }
      return;
    }
    await doGenerate('');
  }

  async function downloadExport(fmt: 'txt' | 'md' | 'docx') {
    try {
      const r = await authFetch(`${BASE}/v1/adapt/${kind}/export/${fmt}?draft_id=${draftId}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      // 从 Content-Disposition 解析文件名, 失败则用默认名
      let filename = `${meta.title}.${fmt}`;
      const cd = r.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
      if (m && m[1]) {
        try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(`导出失败: ${e?.message || e}`);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      await authFetch(`${BASE}/v1/adapt/jobs/${job.id}/cancel`, { method: 'POST' });
      toast.success('已取消');
      fetchData();
    } catch {
      toast.error('取消失败');
    }
  }

  async function regenerate(order: number) {
    setBusyOrder(order);
    try {
      const r = await authFetch(
        `${BASE}/v1/adapt/${kind}/${order}/regenerate?draft_id=${draftId}`,
        {
          method: 'POST',headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      toast.success(`第${order}章已重新生成`);
      await fetchData();
    } catch (e: any) {
      toast.error(`重新生成失败: ${e?.message || e}`);
    } finally {
      setBusyOrder(null);
    }
  }

  async function regenerateWithFeedback(order: number) {
    if (!feedbackText.trim()) {
      toast.error('请填写修改意见');
      return;
    }
    setBusyOrder(order);
    try {
      const r = await authFetch(
        `${BASE}/v1/adapt/${kind}/${order}/regenerate-with-feedback?draft_id=${draftId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, feedback: feedbackText }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      toast.success(`第${order}章已按意见重写`);
      setFeedbackFor(null);
      setFeedbackText('');
      await fetchData();
    } catch (e: any) {
      toast.error(`重写失败: ${e?.message || e}`);
    } finally {
      setBusyOrder(null);
    }
  }

  async function saveEdit(order: number) {
    setBusyOrder(order);
    try {
      const r = await authFetch(`${BASE}/v1/adapt/${kind}/${order}?draft_id=${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editText }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('已保存(旧版本已归档)');
      setEditingOrder(null);
      await fetchData();
    } catch (e: any) {
      toast.error(`保存失败: ${e?.message || e}`);
    } finally {
      setBusyOrder(null);
    }
  }

  const isActive = job && ACTIVE.has(job.status);
  const pct = job && job.total ? Math.round((job.finished / job.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {meta.icon}
        <h2 className="text-card-title font-semibold text-ink-primary">{meta.title}</h2>
      </div>
      <p className="text-caption text-ink-muted">{meta.desc}</p>

      {/* 字数控制 - 与章节/剧本页WordCountSettings保持一致 */}
      <div className="px-4 py-3 bg-surface-raised rounded-lg border border-line">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <span className="text-ink-secondary">📏每章目标字数:</span>
          {!wordEditing ? (
            <>
              <span className="px-2.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
                {wordTarget.toLocaleString()} 字
              </span>
              <span className="text-xs text-ink-muted">
                允许范围 {Math.floor(wordTarget * 0.8).toLocaleString()} ~ {Math.floor(wordTarget * 1.2).toLocaleString()} 字
              </span><span className="text-xs text-ink-muted hidden lg:inline ml-auto">※ 仅影响新生成的改编内容</span>
              <button
                onClick={() => { setWordEditVal(wordTarget); setWordEditing(true); }}
                disabled={!!isActive}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-surface-overlay hover:bg-surface-base border border-line rounded disabled:opacity-50"
              >
                <Pencil className="w-3 h-3" /> 修改
              </button>
            </>
          ) : (
            <>
              <input
                type="number"
                value={wordEditVal || ''}
                onChange={(e) => { const n = parseInt(e.target.value); if (!isNaN(n)) setWordEditVal(n); }}
                min={500} max={20000} step={500}
                className="w-24 px-2 py-1 bg-surface-overlay border border-line rounded text-sm"
              />
              <span className="text-xs text-ink-muted">字</span>
              <div className="flex gap-1 flex-wrap">
                {WORD_PRESETS.map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    onClick={() => setWordEditVal(p.v)}
                    className={`px-2 py-0.5 rounded text-xs transition ${wordEditVal === p.v ? 'bg-primary text-white' : 'bg-surface-overlay hover:bg-surface-base text-ink-secondary border border-line'}`}
                  >
                    {p.label} {p.v}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex gap-1.5">
                <button
                  onClick={() => { saveWordTarget(wordEditVal); setWordEditing(false); }}
                  disabled={wordSaving}
                  className="flex items-center gap-1 px-2.5 py-1 bg-primary text-white text-xs rounded disabled:opacity-50"
                >
                  {wordSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 保存
                </button>
                <button onClick={() => setWordEditing(false)} className="px-2.5 py-1 text-xs bg-surface-overlay hover:bg-surface-base border border-line rounded">
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <ModelSelect value={model} onChange={setModel} disabled={!!isActive} />
        {kind === 'tweet' && protagonist && (
          <span className="text-caption text-ink-secondary">
            主角: <b className="text-ink-primary">{protagonist}</b>
          </span>
        )}
        <Button
          onClick={start}
          disabled={starting || !!isActive}
          leftIcon={<Sparkles className="w-4 h-4" />}>
          {isActive ? '生成中…' : starting ? '启动中…' : items.length > 0 ? '重新一键生成' : '一键生成'}
        </Button>
        {isActive && (
          <Button variant="danger" size="sm" onClick={cancel}>
            取消
          </Button>
        )}
        {items.length > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-caption text-ink-muted flex items-center gap-1">
              <Download className="w-3 h-3" /> 导出:
            </span>
            {(['txt', 'md', 'docx'] as const).map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => downloadExport(fmt)}
                className="px-2 py-1 bg-surface-overlay hover:bg-surface-raised rounded text-xs text-ink-secondary"
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 作业进度 */}
      {job && (
        <div className="rounded-lg border border-line bg-surface-raised p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-body font-medium flex items-center gap-2">
              {isActive &&<Loader2 className="w-4 h-4 animate-spin text-warning" />}
              #{job.id} · {job.status}
            </span>
            <span className="text-caption text-ink-muted">
              {job.finished}/{job.total} 章
            </span>
          </div>
          {isActive && (
            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {job.status === 'failed' && (
            <p className="text-caption text-danger">失败: {job.error || '未知错误'}</p>
          )}
        </div>
      )}

      {/* 逐章产物列表。
          已有产物的集用真实数据; 原文里有、但本类产物还没生成的集渲染一张空卡片,
          让用户能直接「手动填写」(把对话工坊生成的文本粘进来), 无需先跑一次生成。 */}
      {displayRows.length === 0 ? (
        <div className="text-center py-12 text-ink-muted text-sm">
          暂无{meta.title}内容, 点击「一键生成」逐章生成。
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {displayRows.map((it) => {
            const editing = editingOrder === it.chapter_order;
            const busy = busyOrder === it.chapter_order;
            const isEmpty = !(it.content || '').trim();
            return (
              <div
                key={it.chapter_order}
                className="rounded-lg border border-line bg-surface-raised p-4 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-body font-semibold text-ink-primary">
                    第{it.chapter_order} 章
                    <span className="ml-2 text-caption text-ink-muted font-normal">
                      {isEmpty ? (
                        <span className="text-ink-muted">尚未生成</span>
                      ) : (
                        <>
                          {it.word_count} 字· v{it.version}
                          {it.user_edited && ' · 已手动编辑'}
                        </>
                      )}
                    </span>
                  </span>
                  <div className="flex items-center gap-1">
                    {!editing && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          leftIcon={busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          onClick={() => regenerate(it.chapter_order)}
                        >
                          {isEmpty ? '生成本章' : '重新生成'}
                        </Button>
                        {!isEmpty && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setFeedbackFor(feedbackFor === it.chapter_order ? null : it.chapter_order);
                              setFeedbackText('');
                            }}
                          >
                            按意见重写
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={<Pencil className="w-3 h-3" />}
                          onClick={() => {
                            setEditingOrder(it.chapter_order);
                            setEditText(it.content);
                          }}
                        >
                          {/* 空态也给编辑入口: 用户常把对话工坊生成的文本直接粘进来 */}
                          {isEmpty ? '手动填写' : '编辑'}
                        </Button>
                      </>
                    )}
                </div>
                </div>

                {feedbackFor === it.chapter_order && !editing && (
                  <div className="p-2 bg-surface-overlay/50 border border-warning/20 rounded">
                    <textarea
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      rows={2}
                      placeholder="如: 增强主角内心戏/ 环境描写再细一点…"
                      className="w-full px-2 py-1 bg-surface-base border border-line rounded text-xs text-ink-primary"
                    />
                <Button
                      variant="primary"
                      size="sm"
                      className="mt-1"
                      disabled={busy || !feedbackText.trim()}
                      onClick={() => regenerateWithFeedback(it.chapter_order)}
                    >
                      {busy ? '重写中…' : '按意见重写本章'}
                    </Button>
                  </div>
                )}

                {editing ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={12}
                      placeholder={isEmpty ? `把${meta.title}正文粘贴到这里, 保存后即成为第${it.chapter_order}章的${meta.title}。` : undefined}
                      className="w-full px-3 py-2 bg-surface-base border border-line rounded text-sm text-ink-primary leading-relaxed"
                    />
                    <div className="flex gap-1.5">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        leftIcon={<Save className="w-3 h-3" />}
                        onClick={() => saveEdit(it.chapter_order)}
                      >
                        保存
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<X className="w-3 h-3" />}
                        onClick={() => setEditingOrder(null)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : isEmpty ? (
                  <p className="text-sm text-ink-muted italic">
                    本章尚无{meta.title}内容 —— 可点「生成本章」由 AI 生成, 或点「手动填写」直接粘贴。
                  </p>
                ) : (
                  <p className="text-sm text-ink-primary whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                    {it.content}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}