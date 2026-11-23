import { useEffect, useState } from 'react';
import { Pause, Play, ShieldCheck } from 'lucide-react';
import type { DouyinSearchState } from '../shared/douyin-search';
import { request } from './api';
import { dateText } from './components';

type Notify = (message: string, error?: boolean) => void;

/** Share of a limit as a bar width, capped at 100%. */
function share(used: number, limit: number): string {
  return `${Math.min(100, Math.round(used / Math.max(1, limit) * 100))}%`;
}

/**
 * Administrator panel for the one signed-in Douyin search account: usage against the hourly and daily limits,
 * the verification pause, a stop switch and the limits themselves.
 */
export function DouyinSearchPanel({ notify }: { notify: Notify }) {
  const [state, setState] = useState<DouyinSearchState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [perHour, setPerHour] = useState('');
  const [perDay, setPerDay] = useState('');
  useEffect(() => {
    let closed = false;
    const load = () => request<DouyinSearchState>('/api/admin/douyin-search')
      .then(value => { if (!closed) { setState(value); setError(''); } })
      .catch((reason: Error) => { if (!closed) setError(reason.message); });
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { closed = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (state) { setPerHour(String(state.perHour)); setPerDay(String(state.perDay)); } }, [state?.perHour, state?.perDay]);
  const change = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { setState(await request<DouyinSearchState>('/api/admin/douyin-search', { method: 'PUT', body: JSON.stringify(body) })); notify(done); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '保存失败', true); }
    finally { setBusy(false); }
  };
  const saveLimits = () => {
    const hour = Number(perHour), day = Number(perDay);
    if (!Number.isInteger(hour) || hour < 1 || hour > 600 || !Number.isInteger(day) || day < hour || day > 10_000) { notify('每小时 1–600 次，每天不少于每小时且不超过 10000 次', true); return; }
    void change({ perHour: hour, perDay: day }, '搜索上限已保存');
  };
  const label = !state ? '正在读取' : state.stopped ? '已手动暂停' : state.pausedUntil ? `抖音要求验证，暂停到 ${dateText(state.pausedUntil, true)}` : '正常';
  const tone = !state ? '' : state.stopped || state.pausedUntil ? 'state-failed' : 'state-success';
  return <section className="panel discovery-panel" data-testid="douyin-search-panel">
    <div className="panel-heading"><div><h2>抖音搜索账号</h2><p>只有一个登录小号。成员的抖音搜索、Muse 里的搜索和储备看板的“抖音话题播放 5000 万”检查都用它，次数算在同一份额度里。已知话题编号的复查和视频下载不算搜索。</p></div></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {state && <div className="lvpaopao-body">
      <div className="discovery-title"><strong>搜索状态</strong><span className={`state-pill ${tone}`} data-testid="douyin-search-state"><span />{label}</span></div>
      {state.pausedUntil && !state.stopped && <p className="muted small">抖音要求这个号做验证后，全站搜索会自动暂停 {state.pauseMinutes} 分钟。在登录这个小号的电脑浏览器里打开抖音搜一次，完成验证后点「已完成验证，解除暂停」。</p>}
      <div className="search-usage">
        <div><span>最近 1 小时</span><strong>{state.lastHour} / {state.perHour} 次</strong><i style={{ width: share(state.lastHour, state.perHour) }} /></div>
        <div><span>最近 24 小时</span><strong>{state.lastDay} / {state.perDay} 次</strong><i style={{ width: share(state.lastDay, state.perDay) }} /></div>
      </div>
      <dl className="lvpaopao-facts"><div><dt>最近一次要求验证</dt><dd>{state.lastRiskAt ? dateText(state.lastRiskAt, true) : '没有记录'}</dd></div></dl>
      <div className="discovery-actions">
        <div className="schedule-controls">
          <label htmlFor="search-per-hour">每小时</label><input id="search-per-hour" type="number" min={1} max={600} value={perHour} onChange={event => setPerHour(event.target.value)} />
          <label htmlFor="search-per-day">每天</label><input id="search-per-day" type="number" min={1} max={10000} value={perDay} onChange={event => setPerDay(event.target.value)} />
          <button className="button button-outline" disabled={busy} onClick={saveLimits}>保存上限</button>
        </div>
        <div className="schedule-controls">
          {state.pausedUntil && <button className="button button-primary" disabled={busy} onClick={() => void change({ resume: true }, '已解除暂停，搜索恢复')}><ShieldCheck size={14} />已完成验证，解除暂停</button>}
          {state.stopped
            ? <button className="button button-primary" disabled={busy} onClick={() => void change({ stopped: false }, '抖音搜索已恢复')}><Play size={14} />恢复搜索</button>
            : <button className="button button-outline" disabled={busy} onClick={() => void change({ stopped: true }, '抖音搜索已暂停')}><Pause size={14} />暂停搜索</button>}
        </div>
      </div>
    </div>}
  </section>;
}
