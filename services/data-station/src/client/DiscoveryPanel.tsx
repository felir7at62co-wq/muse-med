import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { PLATFORM_LABELS, type DiscoveryStatus } from '../shared/types';
import { request } from './api';
import { dateText } from './components';

const states: Record<DiscoveryStatus['state'], string> = { idle: '等待发现', running: '扩库中', success: '本轮完成', failed: '有待重试', not_configured: '待接入入口' };

/** Administrator-only live queue progress; stored works remain readable during discovery. */
export function DiscoveryPanel({ notify, onPublished }: { notify: (message: string, error?: boolean) => void; onPublished: () => void }) {
  const [statuses, setStatuses] = useState<DiscoveryStatus[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string | null>(null);
  const previous = useRef<DiscoveryStatus[]>([]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let closed = false, pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await request<DiscoveryStatus[]>('/api/admin/discovery');
        if (closed) return;
        const changed = next.some(status => status.lastPublishedAt && previous.current.some(old => old.platform === status.platform && old.lastPublishedAt !== status.lastPublishedAt));
        previous.current = next; setStatuses(next); setError('');
        if (changed) onPublished();
      } catch (reason) { if (!closed) setError(reason instanceof Error ? reason.message : '扩库进度暂时不可用'); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 3500);
    return () => { closed = true; clearInterval(timer); };
  }, [retry, onPublished]);
  const run = async (status: DiscoveryStatus) => {
    setStarting(status.platform);
    try {
      await request(`/api/admin/discovery/${status.platform}/run`, { method: 'POST', body: '{}' });
      setRetry(value => value + 1); notify(`${PLATFORM_LABELS[status.platform]}扩库任务已启动`);
    } catch (reason) { notify(reason instanceof Error ? reason.message : '扩库启动失败', true); }
    finally { setStarting(null); }
  };
  return <section className="panel discovery-panel" data-testid="discovery-panel">
    <div className="panel-heading"><div><h2>持续发现与扩库</h2><p>分批翻页、发现新作品；每页保存成功后继续，失败保留待办和已有数据。</p></div><button className="button button-outline" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />刷新扩库进度</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="discovery-rows">{statuses.map(status => <article key={status.platform} className="discovery-row" data-testid={`discovery-${status.platform}`}>
      <div className="discovery-title"><strong>{PLATFORM_LABELS[status.platform]}</strong><span className={`state-pill state-${status.state}`}>{status.state === 'running' && <LoaderCircle size={12} className="spin" />}{states[status.state]}</span></div>
      <dl><div><dt>累计新增</dt><dd>{status.newWorks}</dd></div><div><dt>本轮新增</dt><dd>{status.lastRunNewWorks}</dd></div><div><dt>已采页</dt><dd>{status.count}</dd></div><div><dt>待处理页</dt><dd>{status.pending}</dd></div><div><dt>待重试页</dt><dd>{status.failed}</dd></div></dl>
      <p className="muted small">{status.message}</p>{status.coverage && <p className="small">{status.coverage}</p>}
      <div className="discovery-actions"><span className="muted small">下次运行 {status.nextRunAt ? dateText(status.nextRunAt, true) : '等待入口配置'}</span><button className="button button-outline" disabled={starting !== null || status.state === 'running' || status.state === 'not_configured'} onClick={() => void run(status)} aria-label={`继续扩充${PLATFORM_LABELS[status.platform]}`}>{starting === status.platform ? '启动中…' : '继续扩充'}</button></div>
    </article>)}</div>
  </section>;
}
