'use client';
/**
 * 「设定」面板 —— 写稿时随手要查的东西，集中在一个抽屉里（2026-09-22 用户要求）。
 *
 * ## 它替代了什么
 * 这个位置原来是「完整工具」，点了会跳回**旧工作台** —— 用户说用不到，
 * 而且误触会落到一个风格完全不协调的老页面。v1 本来就要退役，
 * 把出口留在那儿等于给自己埋雷。
 *
 * ## 为什么能做：数据早就在手里，零新端点
 * 工作台已经把整份 `outline` 拉下来了（`fetchDraft`），这里要的全在里面：
 *   世界观   outline.world           （时代/设定/规则）
 *   角色卡   outline.characters      （全部字段照搬，不裁剪）
 *   爽点契约 outline.chapters[].must_have / core_push / stakes / escalation / hook_out
 *   伏笔     outline.chapters[].plant / payoff
 *   账本     outline.state_ledger    （谁死了、揭了什么秘密、用过哪些元素）
 * 所以它纯粹是"把已有数据换个角度铺出来"，不发一个请求。
 *
 * ## 为什么是抽屉不是页签
 * 设定是**边写边查**的参照物，不是产物。做成第六个页签就会和"大纲/原文/剧本"
 * 混为一谈；做成抽屉则可以盖在右栏上、随时关掉，中间的对话始终可见。
 */
import * as React from 'react';
import { X, RefreshCw, Sparkles } from 'lucide-react';
import { authFetch } from '@/lib/auth';
import { notifyError, notifySuccess } from '@/lib/dialog';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

/** 把大纲里任意形状的取值收敛成人话（列表/字典/字符串都可能出现） */
function s2(v: any): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(s2).filter(Boolean).join('、');
  if (typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => (s2(x) ? `${k}:${s2(x)}` : '')).filter(Boolean).join('、');
  }
  return String(v).trim();
}

function Section({ title, count, children }:
  { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-b border-line/60 last:border-b-0 py-3">
      <h3 className="fs-ui font-semibold text-ink-primary mb-1.5 flex items-center gap-1.5">
        {title}
        {count !== undefined && (
          <span className="fs-meta text-ink-muted tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="fs-meta text-ink-muted">{text}</p>;
}

export function DraftSettingsPanel(
  { draft, draftId, onClose, onRefreshed }:
  { draft: any; draftId: number; onClose: () => void; onRefreshed?: () => void },
) {
  const outline = draft?.outline || {};
  const world = outline.world || {};
  const chars: any[] = Array.isArray(outline.characters) ? outline.characters : [];
  const eps: any[] = Array.isArray(outline.chapters) ? outline.chapters
    : (Array.isArray(outline.episodes) ? outline.episodes : []);
  // ⚠️ 优先读**有效账本**（计划 + 稿子实况覆盖，见 stages/divergence.py）。
  // 只读 state_ledger 的话，用户点完「刷新账本」看到的还是旧的计划值 ——
  // 重建结果写在 state_ledger_effective 里。
  const ledger = outline.state_ledger_effective || outline.state_ledger || {};
  const cum = ledger.cumulative || {};
  const isEffective = !!outline.state_ledger_effective;
  // 「上次重建」—— 用户点完刷新账本后**刷新了页面**就收不到回执了
  // （2026-09-22 反馈："是不是静默丢失了？"）。把时间戳摆出来，
  // 他回到这个面板一眼就能确认那次到底跑没跑完。
  const lastRefresh: string = ledger.refreshed_at || '';
  const lastScanned: number = Number(ledger.refreshed_scanned || 0);

  // 哪几块还是空的 —— 决定要不要显示「补全设定」。
  // 导入/粘贴进来的稿子这几块天生全空（实测 9 部里 8 部），
  // 而在此之前唯一能填上的办法是**重新生成大纲**，那会盖掉分集计划。
  const emptyBlocks = React.useMemo(() => {
    const out: string[] = [];
    if (!(s2(world.era) || s2(world.setting) || (world.rules || []).length)) out.push('世界观');
    if (!chars.length) out.push('角色卡');
    // 与后端 `_has()` 同一套判断：逐**键**看，且列表类只看键在不在。
    // · 逐键：579 那种"有 must_have 但没 core_push"的稿子不能算齐全；
    // · 键在即有：`plant: []` 是"这集没伏笔"的结论，不是空缺 ——
    //   按数组长度判断的话按钮会永远挂在那儿撺掇用户重跑。
    const CK = ['core_push', 'stakes', 'escalation', 'hook_out', 'must_have', 'plant', 'payoff'];
    const hasKey = (ep: any, k: string) => {
      if (!ep || !(k in ep)) return false;
      const v = ep[k];
      return (typeof v === 'object' && v !== null) ? true : !!String(v ?? '').trim();
    };
    if (eps.some((ep: any) => CK.some((k) => !hasKey(ep, k)))) out.push('契约与伏笔');
    return out;
  }, [world, chars, eps]);

  /** 伏笔台账：把每集的 plant / payoff 串成"第几集埋 → 第几集收" */
  const threads = React.useMemo(() => {
    const planted = new Map<string, number>();
    const paid = new Map<string, number>();
    eps.forEach((ep, i) => {
      const order = Number(ep?.order ?? i + 1);
      (Array.isArray(ep?.plant) ? ep.plant : []).forEach((t: any) => {
        const k = s2(t); if (k && !planted.has(k)) planted.set(k, order);
      });
      (Array.isArray(ep?.payoff) ? ep.payoff : []).forEach((t: any) => {
        const k = s2(t); if (k && !paid.has(k)) paid.set(k, order);
      });
    });
    return [...new Set([...planted.keys(), ...paid.keys()])].map((k) => ({
      text: k, plantAt: planted.get(k), payAt: paid.get(k),
    }));
  }, [eps]);

  /** 爽点/冲突：逐集契约里最能代表"这集靠什么抓人"的几项 */
  const beats = React.useMemo(() => eps.map((ep, i) => {
    const order = Number(ep?.order ?? i + 1);
    const hook = ep?.hook_out || {};
    return {
      order,
      title: s2(ep?.title),
      core: s2(ep?.core_push),
      stakes: s2(ep?.stakes),
      escalation: s2(ep?.escalation),
      hook: s2(hook?.type) + (s2(hook?.strength) ? `/${s2(hook.strength)}` : ''),
      must: Array.isArray(ep?.must_have) ? ep.must_have.map(s2).filter(Boolean) : [],
    };
  }).filter((b) => b.core || b.stakes || b.escalation || b.hook || b.must.length), [eps]);

  const [busy, setBusy] = React.useState(false);
  const [filling, setFilling] = React.useState(false);

  /**
   * 从已有正文/剧本/梗概**反推**设定（用户 2026-09-22 要求）。
   *
   * 与「重新生成大纲」的根本区别：**只填空，绝不覆盖**。
   * 已经写着的 core_push 不会被改，标题与梗概完全不碰 ——
   * 所以重复点是安全的，第二次只补第一次没补上的。
   */
  async function backfillSettings() {
    if (filling) return;
    if (!window.confirm(
      `读一遍已有的正文/剧本，把「${emptyBlocks.join('、')}」反推出来填上。\n\n`
      + '· 只填空白项，已经写好的内容一个字都不会改\n'
      + '· 会调用模型（按每 8 集一次），整本几十集需要等一会儿\n'
      + '· 和「重新生成大纲」不同，它不会覆盖你的分集计划')) return;
    setFilling(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/settings/backfill`,
        { method: 'POST' });
      if (r.status === 409) {
        notifySuccess('上一次补全还在进行中，稍等一会儿再回来看就行（不用重复点）。');
        return;
      }
      if (!r.ok) {
        const t = await r.json().catch(() => null);
        throw new Error(t?.detail || `HTTP ${r.status}`);
      }
      const d = await r.json();
      const f = d.filled || {};
      const done: string[] = [];
      if (f.world) done.push('世界观');
      if (f.characters > 0) done.push(`角色卡 ${f.characters} 人`);
      if (f.contracts > 0) done.push(`契约与伏笔 ${f.contracts} 集`);
      notifySuccess(done.length
        ? `已读 ${d.scanned || 0} 集，补上：${done.join('、')}`
        : `已读 ${d.scanned || 0} 集，但没能抽出可填的内容`);
      onRefreshed?.();
    } catch (e: any) {
      notifyError('补全设定失败: ' + (e?.message || e));
    } finally {
      setFilling(false);
    }
  }

  /**
   * 主动重建账本（用户 2026-09-22 要求）。
   *
   * 平时账本是惰性更新的：只补"改过的那几集"。但**整本导入**或**剧情大改**之后，
   * 指纹与粗筛都不足以表达"整本都变了" —— 所以给一个显式按钮做全量重抽。
   *
   * ⚠️ 明确告诉用户它**要调模型**：这件事不做成自动触发，
   * 就是为了不在每次保存后偷偷烧钱。
   */
  async function refreshLedger() {
    if (busy) return;
    if (!window.confirm(
      '重新通读全部正文/剧本，把"谁死了、揭了什么秘密、用过哪些元素"重新算一遍。\n\n'
      + '· 会调用模型（约每 10 集一次），整本几十集需要等一会儿\n'
      + '· 适合"刚导入一整本"或"剧情大改"之后用；平时不用点')) return;
    setBusy(true);
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/ledger/refresh`,
        { method: 'POST' });
      if (r.status === 409) {
        // 上一次重建还在服务端跑（比如用户点完刷新了页面，回执丢了但活还在干）。
        // 这**不是失败** —— 提示它还在跑，别让用户又点一次白烧一遍模型。
        notifySuccess('上一次重建还在进行中，稍等一会儿再回来看就行（不用重复点）。');
        return;
      }
      if (!r.ok) {
        // 后端把"没有正文/剧本可读"这种情况说成人话了，原样转给用户，
        // 别再显示一个让人以为坏了的"覆盖 0 集"。
        const t = await r.json().catch(() => null);
        throw new Error(t?.detail || `HTTP ${r.status}`);
      }
      const d = await r.json();
      const n = d.episodes_tracked || 0;
      notifySuccess(n > 0
        ? `账本已重建：读了 ${d.scanned || 0} 集稿子，记下 ${n} 集的事实`
        : `读了 ${d.scanned || 0} 集稿子，没有抽出可记的事实（死亡/揭秘/悬念/重大桥段）`);
      onRefreshed?.();
    } catch (e: any) {
      notifyError('重建账本失败: ' + (e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="absolute right-0 top-full mt-1 z-40 w-[440px] max-h-[75vh] overflow-y-auto
                 rounded-lg border border-line bg-surface-elevated shadow-2xl"
      role="dialog"
      aria-label="设定"
    >
      <div className="sticky top-0 bg-surface-elevated border-b border-line px-4 py-2 flex items-center gap-2">
        <span className="fs-ui font-semibold text-ink-primary">设定</span>
        <span className="fs-meta text-ink-muted">写稿时随手查，不改任何内容</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-ink-muted hover:text-ink-primary"
          aria-label="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {emptyBlocks.length > 0 && (
        <div className="px-4 pt-3">
          <div className="rounded border border-line/70 bg-surface-overlay/40 px-3 py-2">
            <p className="fs-meta text-ink-secondary leading-5">
              这部剧的<span className="text-ink-primary">{emptyBlocks.join(' / ')}</span>
              还是空的 —— 常见于导入或粘贴进来的稿子。
              可以让 AI 读一遍已有正文把它们反推出来。
            </p>
            <button
              type="button"
              onClick={() => void backfillSettings()}
              disabled={filling}
              className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded fs-meta border border-line
                         text-ink-secondary hover:text-ink-primary hover:border-line-strong disabled:opacity-50"
              title="只填空白项，已经写好的内容不会被改动（要调模型）"
            >
              <Sparkles className={`w-3 h-3 ${filling ? 'animate-spin' : ''}`} />
              {filling ? '补全中…' : '从已有正文补全设定'}
            </button>
          </div>
        </div>
      )}

      <div className="px-4">
        <Section title="世界观">
          {s2(world.era) || s2(world.setting) || (world.rules || []).length ? (
            <div className="space-y-1 fs-meta text-ink-secondary leading-6">
              {s2(world.era) && <p><span className="text-ink-muted">时代：</span>{s2(world.era)}</p>}
              {s2(world.setting) && <p><span className="text-ink-muted">设定：</span>{s2(world.setting)}</p>}
              {Array.isArray(world.rules) && world.rules.length > 0 && (
                <div>
                  <span className="text-ink-muted">规则：</span>
                  <ul className="list-disc pl-5 mt-0.5 space-y-0.5">
                    {world.rules.map((r: any, i: number) => <li key={i}>{s2(r)}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : <Empty text="这部剧还没有世界观设定。" />}
        </Section>

        <Section title="角色卡" count={chars.length || undefined}>
          {chars.length ? (
            <div className="space-y-2">
              {chars.map((c, i) => (
                <div key={i} className="rounded border border-line/60 px-2 py-1.5">
                  <div className="fs-meta text-ink-primary font-medium">
                    {s2(c?.name) || '(无名)'}
                    {s2(c?.role) && <span className="text-ink-muted font-normal">（{s2(c.role)}）</span>}
                  </div>
                  {/* 全部字段照搬 —— 外貌/动机/关键经历都是写人物时真正用得上的 */}
                  {Object.entries(c || {})
                    .filter(([k]) => k !== 'name' && k !== 'role')
                    .map(([k, v]) => (s2(v) ? (
                      <div key={k} className="fs-meta text-ink-secondary leading-5">
                        <span className="text-ink-muted">{k}：</span>{s2(v)}
                      </div>
                    ) : null))}
                </div>
              ))}
            </div>
          ) : <Empty text="大纲里还没有角色表 —— 让 AI 生成大纲时会一并产出。" />}
        </Section>

        <Section title="剧情节奏 · 爽点 · 冲突" count={beats.length || undefined}>
          {beats.length ? (
            <div className="space-y-1.5">
              {beats.map((b) => (
                <div key={b.order} className="fs-meta leading-5">
                  <span className="text-ink-primary tabular-nums">第 {b.order} 集</span>
                  {b.title && <span className="text-ink-muted"> 「{b.title}」</span>}
                  <div className="text-ink-secondary pl-3">
                    {b.core && <div>推进：{b.core}</div>}
                    {b.stakes && <div>代价：{b.stakes}</div>}
                    {b.escalation && <div>升级：{b.escalation}</div>}
                    {b.hook && <div>钩子：{b.hook}</div>}
                    {b.must.length > 0 && <div>必须发生：{b.must.join('；')}</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty text="分集契约还是空的（老草稿常见）。生成/重写大纲后这里会有内容。" />}
        </Section>

        <Section title="伏笔台账" count={threads.length || undefined}>
          {threads.length ? (
            <ul className="space-y-0.5 fs-meta text-ink-secondary">
              {threads.map((t, i) => (
                <li key={i}>
                  <span className="text-ink-primary">{t.text}</span>
                  <span className="text-ink-muted">
                    {' '}—— {t.plantAt ? `第${t.plantAt}集埋` : '没埋'}
                    {' → '}
                    {t.payAt ? `第${t.payAt}集收` : <span className="text-warning">没有安排回收</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : <Empty text="大纲里没有 plant/payoff 字段，暂无伏笔台账。" />}
        </Section>

        <Section title={isEffective ? '世界状态（账本 · 已按稿子校准）' : '世界状态（账本）'}>
          <button
            type="button"
            onClick={() => void refreshLedger()}
            disabled={busy}
            className="mb-2 flex items-center gap-1.5 px-2 py-1 rounded fs-meta border border-line
                       text-ink-secondary hover:text-ink-primary hover:border-line-strong disabled:opacity-50"
            title="重新通读正文/剧本，重建账本（要调模型）"
          >
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
            {busy ? '重建中…' : '刷新账本'}
          </button>
          {lastRefresh && (
            <p className="fs-meta text-ink-muted -mt-1 mb-2">
              上次重建：{lastRefresh.replace('T', ' ')}
              {lastScanned > 0 && `（读了 ${lastScanned} 集）`}
            </p>
          )}
          {(cum.dead || []).length || (cum.revealed_secrets || []).length
            || (cum.open_threads || []).length || (cum.used_elements || []).length ? (
            <div className="space-y-1 fs-meta text-ink-secondary leading-6">
              {(cum.dead || []).length > 0 && (
                <p><span className="text-ink-muted">已死亡：</span>{s2(cum.dead)}</p>)}
              {(cum.alive || []).length > 0 && (
                <p><span className="text-ink-muted">存活：</span>{s2(cum.alive)}</p>)}
              {(cum.revealed_secrets || []).length > 0 && (
                <p><span className="text-ink-muted">已揭穿的秘密：</span>{s2(cum.revealed_secrets)}</p>)}
              {(cum.open_threads || []).length > 0 && (
                <p><span className="text-ink-muted">未决悬念：</span>{s2(cum.open_threads)}</p>)}
              {(cum.used_elements || []).length > 0 && (
                <p><span className="text-ink-muted">已用过的元素：</span>{s2(cum.used_elements)}</p>)}
            </div>
          ) : <Empty text="这部剧还没有状态账本（生成大纲时会建立）。" />}
        </Section>
      </div>
    </div>
  );
}
