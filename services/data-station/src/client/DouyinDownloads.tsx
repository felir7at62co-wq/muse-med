import { useCallback, useEffect, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { DOUYIN_DOWNLOAD_STATE_LABELS, type DouyinDownload, type DouyinDownloadRequestResult, type DouyinDownloadStatus } from '../shared/douyin-downloads';
import { request } from './api';
import { dateText } from './components';
import { applicationUrl } from './url';

type Notify = (text: string, error?: boolean) => void;

/** Reads whether downloads are set up and this member's daily quota; refreshed after each request. */
export function useDouyinDownloadStatus(): [DouyinDownloadStatus | null, () => void] {
  const [status, setStatus] = useState<DouyinDownloadStatus | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    request<DouyinDownloadStatus>('/api/douyin/downloads/status').then(value => { if (!cancelled) setStatus(value); }).catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [version]);
  return [status, useCallback(() => setVersion(value => value + 1), [])];
}

/** Describes a request's outcome in one sentence. */
export function requestSummary(result: DouyinDownloadRequestResult): string {
  const parts = [];
  if (result.queued.length) parts.push(`正在准备 ${result.queued.length} 条，好了按钮会变成「下载」`);
  if (result.existing.length) parts.push(`${result.existing.length} 条已经准备好或在准备中`);
  if (result.skipped) parts.push(`${result.skipped} 集超出今天的额度，明天再点一次补齐`);
  return parts.join('，') || '没有需要下载的作品';
}

const active = (record: DouyinDownload | undefined) => record?.state === 'queued' || record?.state === 'downloading' || record?.state === 'uploading';

/** Address a saved file is fetched from: the public object address, or the station's signed-link redirect in private mode. */
export function fileUrl(record: DouyinDownload): string {
  return record.url ?? applicationUrl(`/api/douyin/downloads/${encodeURIComponent(record.id)}/file`);
}

/**
 * Download states of the listed posts, re-read every 8 seconds while any of them is being prepared.
 * @returns The records by post ID and a function that re-reads them at once.
 */
export function usePostDownloads(ids: string[], enabled: boolean): [Map<string, DouyinDownload>, () => void] {
  const [records, setRecords] = useState(new Map<string, DouyinDownload>());
  const [tick, setTick] = useState(0);
  const key = ids.slice(0, 100).join(',');
  useEffect(() => {
    if (!enabled || !key) { setRecords(new Map()); return; }
    let cancelled = false;
    request<DouyinDownload[]>(`/api/douyin/downloads?awemeIds=${key}&limit=100`)
      .then(value => { if (!cancelled) setRecords(new Map(value.map(record => [record.awemeId, record]))); })
      .catch(() => { /* Buttons keep their last known state; the next poll or click reads again. */ });
    return () => { cancelled = true; };
  }, [key, enabled, tick]);
  const preparing = [...records.values()].some(active);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setTick(value => value + 1); }, 8_000);
    return () => clearInterval(timer);
  }, [preparing]);
  return [records, useCallback(() => setTick(value => value + 1), [])];
}

/**
 * 「下载」 for one post: a link to the saved file once ready, 「准备中」 while the station fetches and stores it,
 * otherwise a button that asks the station to prepare it.
 */
export function DownloadButton({ awemeId, record, status, notify, onRequested }: {
  awemeId: string; record: DouyinDownload | undefined; status: DouyinDownloadStatus | null; notify: Notify; onRequested: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!status?.enabled) return null;
  if (record?.state === 'done') return <a className="button button-soft" data-testid="douyin-download-post" href={fileUrl(record)} target="_blank" rel="noreferrer noopener"><Download size={14} />下载</a>;
  if (active(record)) return <button className="button button-outline" data-testid="douyin-download-post" disabled
    title={record?.nextRetryAt ? `已尝试 ${record.attempts} 次，下次自动重试 ${dateText(record.nextRetryAt, true)}${record.error ? `：${record.error}` : ''}` : undefined}>
    {record?.nextRetryAt ? <><RefreshCw size={14} />等待重试…</> : <><LoaderCircle size={14} className="spin" />准备中…</>}</button>;
  const prepare = async () => {
    setBusy(true);
    try {
      const result = await request<DouyinDownloadRequestResult>('/api/douyin/downloads', { method: 'POST', body: JSON.stringify({ awemeId }) });
      notify(requestSummary(result));
      onRequested();
    } catch (error) { notify(error instanceof Error ? error.message : '下载没有开始，请稍后再试', true); }
    finally { setBusy(false); }
  };
  return <button className="button button-outline" data-testid="douyin-download-post" disabled={busy} onClick={() => void prepare()}>
    {busy ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{busy ? '提交中…' : record?.state === 'failed' ? '重新下载' : '下载'}</button>;
}

/** 「下载整部」: prepares every episode of a series in order; each episode's button turns into its download link when ready. */
export function MixDownloadButton({ mixId, status, notify, onRequested }: { mixId: string; status: DouyinDownloadStatus | null; notify: Notify; onRequested: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!status?.enabled) return null;
  const prepare = async () => {
    setBusy(true);
    try {
      const result = await request<DouyinDownloadRequestResult>('/api/douyin/downloads/mix', { method: 'POST', body: JSON.stringify({ mixId }) });
      notify(requestSummary(result));
      onRequested();
    } catch (error) { notify(error instanceof Error ? error.message : '下载没有开始，请稍后再试', true); }
    finally { setBusy(false); }
  };
  return <button className="button button-outline" data-testid="douyin-download-mix" disabled={busy} onClick={() => void prepare()}>
    {busy ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{busy ? '正在列出整部…' : '下载整部'}</button>;
}

const sizeText = (bytes: number | null) => bytes === null ? '' : bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** The team's Douyin download log, newest first, with links to saved files. */
export function DouyinDownloadLog({ status, version }: { status: DouyinDownloadStatus | null; version: number }) {
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<DouyinDownload[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const enabled = status?.enabled === true;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    request<DouyinDownload[]>(`/api/douyin/downloads?limit=100${mine ? '&mine=1' : ''}`)
      .then(value => { if (!cancelled) { setItems(value); setError(''); } })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [enabled, mine, version, tick]);
  const active = items?.some(item => item.state === 'queued' || item.state === 'downloading' || item.state === 'uploading') ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setTick(value => value + 1); }, 8_000);
    return () => clearInterval(timer);
  }, [active]);
  if (!enabled) return status?.reason ? <p className="douyin-note" data-testid="douyin-download-off">抖音下载暂不可用，请联系管理员（{status.reason}）</p> : null;
  return <section className="panel douyin-download-log" data-testid="douyin-download-log">
    <div className="panel-heading"><div><h2>下载记录</h2><p>
      {status.access === 'private' ? `点「下载」取得 ${Math.round(status.linkSeconds / 60)} 分钟内有效的链接。` : '视频由数据站保存，准备好后点「下载」直接获取，全组共用，下过的不再重复下载。'}
      {status.unlimited ? '管理员不限条数。' : `每人每天最多 ${status.dailyLimit} 条，今天已用 ${status.usedToday} 条。`}整部按集数排队，临时失败会冷却后自动重试。</p></div>
      <div className="douyin-log-tools"><label className="checkbox"><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)} />只看我的</label>
        <button className="button button-outline" onClick={() => setTick(value => value + 1)}><RefreshCw size={14} />刷新</button></div></div>
    {error && <div className="facet-error" role="alert">下载记录暂时读不到：{error}</div>}
    {items && !items.length ? <p className="douyin-log-empty muted">还没有下载记录。在搜索结果或合集里点「下载」。</p>
      : items && <div className="table-scroll"><table className="work-table douyin-log-table"><thead><tr><th>作品</th><th>状态</th><th>大小</th><th>请求人</th><th>时间</th><th /></tr></thead><tbody>
        {items.map(item => <tr key={item.id} data-testid="douyin-download-row">
          <td><strong className="douyin-log-title">{item.title || item.awemeId}</strong><div className="work-observed">{item.mixName ? `合集「${item.mixName}」第 ${item.episode ?? '?'} 集` : `作品 ${item.awemeId}`}</div></td>
          <td><span className={`state-pill${item.state === 'done' ? ' state-success' : item.state === 'failed' ? ' state-failed' : item.state === 'queued' ? '' : ' state-running'}`}>
            {item.state === 'downloading' || item.state === 'uploading' ? <LoaderCircle size={12} className="spin" /> : <span />}{item.nextRetryAt ? '等待重试' : DOUYIN_DOWNLOAD_STATE_LABELS[item.state]}</span>
            {item.nextRetryAt && <div className="work-observed">已尝试 {item.attempts} 次 · {item.cooldownRounds ? `已冷却 ${item.cooldownRounds} 轮 · ` : ''}下次自动重试 {dateText(item.nextRetryAt, true)}</div>}
            {item.error && <div className="douyin-log-error" title={item.error}>{item.state === 'queued' ? '将重试：' : ''}{item.error}</div>}</td>
          <td>{sizeText(item.bytes)}</td>
          <td>{item.requestedBy}</td>
          <td><span>{dateText(item.createdAt, true)}</span>{item.finishedAt && <div className="work-observed">完成 {dateText(item.finishedAt, true)}</div>}</td>
          <td>{item.state === 'done' && <a className="button button-soft" href={fileUrl(item)} target="_blank" rel="noreferrer noopener"><Download size={14} />下载</a>}</td>
        </tr>)}</tbody></table></div>}
  </section>;
}
