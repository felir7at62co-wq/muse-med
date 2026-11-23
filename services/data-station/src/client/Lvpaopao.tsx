import { useEffect, useState } from 'react';
import { LoaderCircle, QrCode, RefreshCw } from 'lucide-react';
import { LVPAOPAO_REASONS, type LvpaopaoAction, type LvpaopaoAdminStatus, type LvpaopaoStatus } from '../shared/lvpaopao';
import { request } from './api';
import { dateText } from './components';
import { applicationUrl } from './url';

type Notify = (message: string, error?: boolean) => void;

/** Polls a status endpoint; the login screen refreshes every 20 s, so the panel polls at the same pace. */
function usePolled<T>(path: string, intervalMs: number, retry: number): { value: T | null; error: string } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let closed = false, pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try { const next = await request<T>(path); if (!closed) { setValue(next); setError(''); } }
      catch (reason) { if (!closed) setError(reason instanceof Error ? reason.message : '采集端状态暂时不可用'); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, intervalMs);
    return () => { closed = true; clearInterval(timer); };
  }, [path, intervalMs, retry]);
  return { value, error };
}

/** Collector state above the 绿泡泡 boards, so members can tell missing data from an empty board. */
export function LvpaopaoStatusBar() {
  const { value } = usePolled<LvpaopaoStatus>('/api/lvpaopao/status', 60_000, 0);
  if (!value || (value.state === 'ok' && value.lastSuccessAt)) return null;
  return <div className={`lvpaopao-status${value.needsHuman ? ' lvpaopao-status-alert' : ''}`} role="status" data-testid="lvpaopao-status">
    <strong>{value.label}</strong><span>{value.message}</span>
    {value.lastSuccessAt && <span className="muted small">最近成功 {dateText(value.lastSuccessAt, true)}</span>}
  </div>;
}

/** Administrator panel: collector heartbeat, web QR login and the recent run log with gaps. */
export function LvpaopaoPanel({ notify }: { notify: Notify }) {
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState<LvpaopaoAction | null>(null);
  const { value: status, error } = usePolled<LvpaopaoAdminStatus>('/api/admin/lvpaopao', 20_000, retry);
  const send = async (action: LvpaopaoAction) => {
    setSending(action);
    try {
      await request('/api/admin/lvpaopao/commands', { method: 'POST', body: JSON.stringify({ action }) });
      notify(action === 'start-login' ? '已通知 Mac 发起登录，请留意二维码' : '已通知 Mac 立即采集，下一次心跳时开始');
      setRetry(value => value + 1);
    } catch (reason) { notify(reason instanceof Error ? reason.message : '指令发送失败', true); }
    finally { setSending(null); }
  };
  const pending = new Set(status?.commands.map(command => command.action) ?? []);
  const loggedOut = status?.state === 'waiting-login' || status?.wechat?.loggedIn === false;
  return <section className="panel discovery-panel" data-testid="lvpaopao-panel">
    <div className="panel-heading"><div><h2>绿泡泡采集端（Mac）</h2><p>Mac 上的隔离微信读取绿泡泡榜单和互动数，每 5 分钟报告一次状态。微信掉登录时在这里扫码。</p></div><button className="button button-outline" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />刷新状态</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {status && <div className="lvpaopao-body">
      <div className="discovery-title"><strong>{status.label}</strong><span className={`state-pill ${status.needsHuman ? 'state-failed' : status.state === 'collecting' ? 'state-running' : status.state === 'ok' ? 'state-success' : 'state-idle'}`}>{status.state === 'collecting' && <LoaderCircle size={12} className="spin" />}{status.needsHuman ? '需要处理' : status.state === 'collecting' ? '采集中' : status.state === 'ok' ? '正常' : '等待中'}</span></div>
      <p className="muted small">{status.message}</p>
      <dl className="lvpaopao-facts"><div><dt>最近心跳</dt><dd>{dateText(status.lastHeartbeatAt, true)}</dd></div><div><dt>最近成功</dt><dd>{dateText(status.lastSuccessAt, true)}</dd></div><div><dt>下一时段</dt><dd>{status.nextSlot ? dateText(status.nextSlot, true) : '—'}</dd></div><div><dt>待上传</dt><dd>{status.pendingUploads}</dd></div><div><dt>微信</dt><dd>{!status.wechat ? '—' : !status.wechat.running ? '未运行' : status.wechat.loggedIn === null ? '运行中' : status.wechat.loggedIn ? '已登录' : '未登录'}</dd></div><div><dt>飞书告警</dt><dd>{status.alertsConfigured ? '已配置' : '未配置'}</dd></div></dl>
      {loggedOut && <div className="lvpaopao-login" data-testid="lvpaopao-login">
        {status.loginScreen ? <figure><img src={applicationUrl(`/api/admin/lvpaopao/login-screen?at=${encodeURIComponent(status.loginScreen.capturedAt)}`)} alt="Mac 上隔离微信的登录窗口" /><figcaption>截于 {dateText(status.loginScreen.capturedAt, true)}，约每 20 秒刷新。{status.loginScreen.kind === 'qr' ? '用手机微信扫码登录专用号。' : '窗口显示「进入微信」时，点下方按钮后在手机上确认。'}</figcaption></figure>
          : <p className="muted small"><QrCode size={14} /> 还没有收到登录窗口截图；点「发起登录」让 Mac 打开登录界面。</p>}
      </div>}
      <div className="discovery-actions">
        <button className="button button-primary" disabled={sending !== null || pending.has('start-login') || status.state === 'not_configured'} onClick={() => void send('start-login')}>{pending.has('start-login') ? '等待 Mac 执行登录…' : '发起登录'}</button>
        <button className="button button-outline" disabled={sending !== null || pending.has('collect-now') || status.state === 'not_configured'} onClick={() => void send('collect-now')}>{pending.has('collect-now') ? '等待 Mac 开始采集…' : '立即采集榜单'}</button>
      </div>
      {status.runs.length > 0 && <table className="lvpaopao-runs"><thead><tr><th>时段</th><th>内容</th><th>结果</th><th>说明</th></tr></thead><tbody>{status.runs.map(run => <tr key={run.runId}>
        <td>{dateText(run.slot, true)}</td><td>{run.kind === 'rankings' ? `榜单 ${run.boards} 个` : `互动数 ${run.dramas} 部`}</td>
        <td>{run.status === 'complete' ? '完成' : run.status === 'partial' ? '部分完成' : '未采到'}</td><td>{run.reason ? LVPAOPAO_REASONS[run.reason] ?? run.reason : ''}</td>
      </tr>)}</tbody></table>}
    </div>}
  </section>;
}
