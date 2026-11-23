import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { PLATFORM_LABELS, type MetricRefreshStatus } from '../shared/types';
import { request } from './api';
import { dateText } from './components';

const states: Record<MetricRefreshStatus['state'], string> = { idle: '等待刷新', running: '刷新中', success: '本轮完成', failed: '部分失败', not_configured: '无详情来源' };

/** Administrator-only progress of the scheduled detail-page metric refresh for catalog-only works. */
export function MetricRefreshPanel({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [statuses, setStatuses] = useState<MetricRefreshStatus[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let closed = false, pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try { const next = await request<MetricRefreshStatus[]>('/api/admin/metric-refresh'); if (!closed) { setStatuses(next); setError(''); } }
      catch (reason) { if (!closed) setError(reason instanceof Error ? reason.message : '指标刷新进度暂时不可用'); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => { closed = true; clearInterval(timer); };
  }, [retry]);
  const run = async (status: MetricRefreshStatus) => {
    setStarting(status.platform);
    try { await request(`/api/admin/metric-refresh/${status.platform}/run`, { method: 'POST', body: '{}' }); setRetry(value => value + 1); notify(`${PLATFORM_LABELS[status.platform]}指标刷新已启动`); }
    catch (reason) { notify(reason instanceof Error ? reason.message : '指标刷新启动失败', true); }
    finally { setStarting(null); }
  };
  return <section className="panel discovery-panel" data-testid="metric-refresh-panel">
    <div className="panel-heading"><div><h2>作品指标自动刷新</h2><p>只在分类或书库中发现、尚未上榜的作品，定时读取作品详情页的热度、收藏、在读等指标；先补从未取得指标的作品，再轮流更新最旧的。</p></div><button className="button button-outline" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />刷新进度</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="discovery-rows">{statuses.map(status => <article key={status.platform} className="discovery-row" data-testid={`metric-refresh-${status.platform}`}>
      <div className="discovery-title"><strong>{PLATFORM_LABELS[status.platform]}</strong><span className={`state-pill state-${status.state}`}>{status.state === 'running' && <LoaderCircle size={12} className="spin" />}{states[status.state]}</span></div>
      <dl><div><dt>待刷新</dt><dd>{status.due}</dd></div><div><dt>本轮更新</dt><dd>{status.lastRunRefreshed}</dd></div><div><dt>本轮失败</dt><dd>{status.lastRunFailed}</dd></div><div><dt>累计更新</dt><dd>{status.refreshed}</dd></div></dl>
      <p className="muted small">{status.message}</p>
      <div className="discovery-actions"><span className="muted small">下次运行 {status.nextRunAt ? dateText(status.nextRunAt, true) : '无详情来源'}</span><button className="button button-outline" disabled={starting !== null || status.state === 'running' || status.state === 'not_configured'} onClick={() => void run(status)} aria-label={`立即刷新${PLATFORM_LABELS[status.platform]}指标`}>{starting === status.platform ? '启动中…' : '立即刷新'}</button></div>
    </article>)}</div>
  </section>;
}
