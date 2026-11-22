'use client';
/**
 * 粘贴识别弹窗 —— 把一段文本按集号切开写进当前草稿（用户 2026-09-20 要求）
 *
 * ## 流程（与「导入剧本」一致的两步式，不另造一套习惯）
 *   粘贴文本 → **预览切分结果**（可逐条改集号/标题/删除）→ 确认写入
 *
 * ## 为什么必须"先预览"
 * 切分是有判断的：哪一行算集头、集号从几开始、有没有重号断号。
 * 判错了就把用户的稿子拆乱 —— 而"拆错了"这件事在写入之后**很难恢复**
 * （正文会按错的集号散落，用户得逐集挪）。所以先看、再写。
 *
 * ## 两种产物共用这一个弹窗
 *   原文（chapters）：纯字符串切分，零成本、秒出
 *   大纲（outline） ：走 `parse_and_split_outline`，**会调模型**
 *                    （它要处理"第X-Y集"这类区间表述），所以慢且花钱
 * 这一点写在弹窗里告诉用户，免得以为大纲那条卡住了。
 */
import * as React from 'react';
import { Loader2, ClipboardPaste, Trash2, AlertCircle } from 'lucide-react';
import { authFetch } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { notifyError, notifySuccess } from '@/lib/dialog';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type Ep = {
  order: number;
  title: string;
  synopsis: string;
  word_count?: number;
  /** chapters 专用：切出来的正文（写入时用它，不是 synopsis） */
  _content?: string;
};

export function PasteImportModal({
  draftId, kind, open, onClose, onApplied,
}: {
  draftId: number;
  kind: 'chapters' | 'outline';
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [text, setText] = React.useState('');
  const [step, setStep] = React.useState<'paste' | 'preview'>('paste');
  const [busy, setBusy] = React.useState(false);
  const [eps, setEps] = React.useState<Ep[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * ⚠️ 2026-10-08 用户反馈：误点弹窗外面的蒙层就会关掉弹窗，而此前开头这段
   * `if (open) 清空一切` 让**再打开时刚粘的内容全没了** —— 一次误触就白干，
   * 粘的是几千字大纲时尤其致命，人还得回去重新复制一遍。
   *
   * 现在**不在每次打开时清空**，只在"编辑目标换了"时重置：换了草稿、
   * 或在「原文 / 大纲」之间切换页签（同一个组件实例会收到不同的 kind）。
   * 那两种情况必须清 —— 留着旧文本更危险，会把原文粘进大纲里。
   *
   * 内容真正被消费掉（写入成功）时才清空，见 doApply。
   * 关窗时组件只是 `return null`、并没有卸载，所以 state 天然还在；
   * 这也是不需要 sessionStorage 的原因。
   */
  const targetKey = `${draftId}:${kind}`;
  const lastTargetRef = React.useRef<string>('');
  React.useEffect(() => {
    if (lastTargetRef.current === targetKey) return;
    lastTargetRef.current = targetKey;
    setStep('paste'); setText(''); setEps([]); setError(null);
    // open 刻意**不在**依赖里：它的变化不该清内容，这正是本次修复的要点。
  }, [targetKey]);

  const label = kind === 'outline' ? '大纲' : '原文';

  async function doPreview() {
    const t = text.trim();
    if (!t) { notifyError('先粘贴一些内容'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/paste/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, kind }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${msg.slice(0, 120)}`);
      }
      const d = await r.json();
      const list: Ep[] = d.episodes || [];
      if (list.length === 0) {
        setError('没能识别出任何集号。支持的写法：第1集 / 第1章 / 第一章 / 一、 / 1、');
        return;
      }
      setEps(list);
      setStep('preview');
    } catch (e: any) {
      setError(e?.message || '识别失败');
    } finally {
      setBusy(false);
    }
  }

  async function doApply() {
    setBusy(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/paste/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, episodes: eps }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const n = d.written?.length ?? d.updated?.length + (d.created?.length || 0) ?? eps.length;
      notifySuccess(`已写入 ${n} ${kind === 'outline' ? '集' : '章'}`);
      /**
       * ⚠️ 写入成功后**必须**清干净，否则会留下"重复写入"的坑。
       *
       * 本次改动让关闭弹窗不再清内容（见上面 lastTargetRef 的注释，为的是
       * 误点蒙层不丢粘贴的稿子）。但这带来一个新后果：写完之后内容还留在
       * state 里，用户再点开「粘贴识别」会看到**上一次**的文本和识别结果，
       * 要是没注意又点一次「识别切分 → 写入」，同一批内容就被写第二遍。
       *
       * 所以"没消费掉"（关窗）保留、"已消费掉"（写成功）清空 —— 这两种情况
       * 语义正好相反，不能都按"保留"处理。
       */
      setText(''); setEps([]); setStep('paste'); setError(null);
      onApplied?.();
      onClose();
    } catch (e: any) {
      notifyError('写入失败: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const dup = (() => {
    const seen = new Set<number>();
    const bad = new Set<number>();
    for (const e of eps) { if (seen.has(e.order)) bad.add(e.order); seen.add(e.order); }
    return bad;
  })();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-line bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <ClipboardPaste className="w-4 h-4 text-primary" />
          <span className="fs-ui font-semibold text-ink-primary">粘贴{label}</span>
          <span className="fs-meta text-ink-muted">
            {step === 'paste' ? '识别集号后自动切分' : `识别出 ${eps.length} 集，可改集号/标题`}
          </span>
          <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink-primary" aria-label="关闭">✕</button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {step === 'paste' ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={14}
                placeholder={
                  kind === 'outline'
                    ? '把分集大纲粘在这里。\n\n支持：第1集：标题 / 第3集 / 一、 / 1、 等写法。'
                    : '把正文粘在这里。\n\n支持：第1章 / 第1集 / 第一章 / 一、 等分集标注。'
                }
                className="w-full px-3 py-2 fs-body rounded-md border border-line bg-surface-card text-ink-primary outline-none focus:border-primary/60 resize-y font-mono"
                autoFocus
              />
              {kind === 'outline' && (
                <p className="mt-2 fs-meta text-ink-muted leading-5">
                  大纲识别会**调用模型**处理「第X-Y集」这类区间表述，所以要等几秒 —— 原文识别是纯文本切分，秒出。
                </p>
              )}
              {error && (
                <p className="mt-2 fs-ui text-danger flex items-start gap-1">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{error}
                </p>
              )}
            </>
          ) : (
            <div className="space-y-2">
              {dup.size > 0 && (
                <p className="fs-ui text-warning flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  集号 {[...dup].join('、')} 重复了 —— 写入会互相覆盖，请先改掉
                </p>
              )}
              {eps.map((e, i) => (
                <div key={i} className="flex items-start gap-2 rounded border border-line bg-surface-card px-2 py-1.5">
                  <input
                    type="number"
                    value={e.order}
                    onChange={(ev) => {
                      const n = Number(ev.target.value);
                      setEps((prev) => prev.map((x, j) => (j === i ? { ...x, order: n } : x)));
                    }}
                    className={cn(
                      'w-14 px-1.5 py-0.5 fs-ui rounded border bg-surface-base text-ink-primary tabular-nums',
                      dup.has(e.order) ? 'border-warning' : 'border-line',
                    )}
                    aria-label="集号"
                  />
                  <div className="flex-1 min-w-0">
                    <input
                      value={e.title}
                      onChange={(ev) => setEps((prev) => prev.map((x, j) => (j === i ? { ...x, title: ev.target.value } : x)))}
                      placeholder="标题（可留空）"
                      className="w-full px-1.5 py-0.5 fs-ui rounded border border-line bg-surface-base text-ink-primary"
                    />
                    <p className="fs-meta text-ink-muted mt-1 line-clamp-2">
                      {(e._content || e.synopsis || '').slice(0, 120)}
                    </p>
                    <p className="fs-meta text-ink-muted mt-0.5">
                      {(e._content || e.synopsis || '').length} 字
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEps((prev) => prev.filter((_, j) => j !== i))}
                    className="p-1 text-ink-muted hover:text-danger"
                    aria-label="删除这一集"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 px-4 py-3 border-t border-line">
          {step === 'preview' && (
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="px-3 py-1.5 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
            >
              返回修改原文
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded fs-ui text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay"
          >
            取消
          </button>
          {step === 'paste' ? (
            <button
              type="button"
              onClick={() => void doPreview()}
              disabled={busy || !text.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded fs-ui bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              识别切分
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void doApply()}
              disabled={busy || eps.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded fs-ui bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              写入 {eps.length} {kind === 'outline' ? '集' : '章'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
