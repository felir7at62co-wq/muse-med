import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChartNoAxesCombined, Upload } from 'lucide-react';
import type { Observation, WorkDetail } from '../shared/types';
import { authenticatedFetch, request } from './api';
import { ScriptDownload } from './ScriptDownload';
import { OriginalDownload } from './OriginalDownload';
import { TranscribeStatus } from './Transcribe';
import { compact, dateText, displayTitle, Empty, Loading, metricValue, Modal, OriginBadge, PlatformBadge, Poster, SourceLink, WorkMetadataNotice } from './components';

function Trend({ observations, board }: { observations: Observation[]; board: string }) {
  const [metric, setMetric] = useState('__rank');
  const [range, setRange] = useState('all');
  const [selectedBoard, setSelectedBoard] = useState(board);
  const boards = [...new Set(observations.map((item) => item.board))];
  const options = [...new Map(observations.flatMap((item) => item.metrics).map((item) => [item.key, item])).values()];
  const sorted = useMemo(() => observations.filter((item) => item.board === selectedBoard).sort((a, b) => a.observedAt.localeCompare(b.observedAt)), [observations, selectedBoard]);
  const cutoff = range === 'all' ? null : Date.now() - Number(range) * 86400000;
  const points = sorted.filter((item) => cutoff === null || new Date(item.observedAt).getTime() >= cutoff).map((item) => ({
    date: item.observedAt,
    value: metric === '__rank' ? item.rank : item.metrics.find((entry) => entry.key === metric)?.value ?? null,
  }));
  const valid = points.filter((item) => item.value !== null);
  const rawMin = Math.min(...valid.map((item) => item.value!));
  const rawMax = Math.max(...valid.map((item) => item.value!));
  const padding = rawMax === rawMin ? Math.max(Math.abs(rawMax) * .08, 1) : (rawMax - rawMin) * .15;
  const min = Math.max(0, rawMin - padding);
  const max = rawMax + padding;
  const x = (index: number) => 50 + index / Math.max(points.length - 1, 1) * 480;
  const y = (value: number) => metric === '__rank' ? 28 + (value - min) / (max - min) * 145 : 173 - (value - min) / (max - min) * 145;
  const segments: string[] = [];
  let nextMove = true;
  for (const [index, item] of points.entries()) {
    if (item.value === null) { nextMove = true; continue; }
    segments.push(`${nextMove ? 'M' : 'L'}${x(index)} ${y(item.value)}`);
    nextMove = false;
  }
  return <section className="detail-section">
    <div className="section-title"><h3><ChartNoAxesCombined size={17} />历史趋势</h3><span className="muted small">来自实际采集快照</span></div>
    <div className="chart-filters"><select aria-label="趋势指标" value={metric} onChange={(event) => setMetric(event.target.value)}><option value="__rank">榜单排名</option>{options.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
      {boards.length > 1 && <select aria-label="趋势榜单" value={selectedBoard} onChange={(event) => setSelectedBoard(event.target.value)}>{boards.map((value) => <option key={value}>{value}</option>)}</select>}
      <div className="segmented small-segment">{[['7', '7天'], ['30', '30天'], ['all', '全部']].map(([value, label]) => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>)}</div>
    </div>
    {valid.length < 2 ? <div className="chart-empty"><ChartNoAxesCombined size={27} /><strong>历史数据正在积累</strong><span>至少需要两次有效观测，才展示趋势。缺失数据不会补成零。</span></div> : <div className="trend-chart"><svg viewBox="0 0 560 215" role="img" aria-label={`${metric === '__rank' ? '榜单排名' : options.find((item) => item.key === metric)?.label || '指标'}历史趋势，${valid.length}个有效观测点`}>
      {[0, 1, 2, 3].map((index) => <g key={index}><line x1="50" x2="530" y1={28 + index / 3 * 145} y2={28 + index / 3 * 145} className="chart-grid" strokeDasharray="4 4" /><text x="39" y={32 + index / 3 * 145} textAnchor="end">{compact(metric === '__rank' ? min + index / 3 * (max - min) : max - index / 3 * (max - min))}</text></g>)}
      <path d={segments.join(' ')} className="chart-line" fill="none" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((item, index) => item.value === null ? null : <circle key={item.date + index} cx={x(index)} cy={y(item.value)} r="3.5" className="chart-point" strokeWidth="2"><title>{dateText(item.date, true)}：{compact(item.value)}</title></circle>)}
      {[0, Math.floor((points.length - 1) / 2), points.length - 1].filter((value, index, array) => array.indexOf(value) === index).map((index) => <text key={index} x={x(index)} y="201" textAnchor="middle">{dateText(points[index]?.date)}</text>)}
    </svg><p className="chart-caption">{metric === '__rank' ? '排名数值越小，名次越靠前。' : '不同平台指标保留各自口径，不跨平台相加。'} 同一榜单、同一来源类型内比较。</p></div>}
  </section>;
}

export function Detail({ id, board, onClose, isAdmin, notify, onChanged }: { id: string; board?: string; onClose: () => void; isAdmin: boolean; notify: (message: string, error?: boolean) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    request<WorkDetail>(`/api/works/${encodeURIComponent(id)}${board ? `?board=${encodeURIComponent(board)}` : ''}`).then((value) => {
      if (cancelled) return;
      setDetail(value);
    }).catch((reason: Error) => !cancelled && setError(reason.message)).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, board, retry]);
  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData(); form.append('file', file);
      const response = await authenticatedFetch(`/api/works/${encodeURIComponent(id)}/script`, { method: 'POST', credentials: 'same-origin', body: form });
      if (!response.ok) {
        let message = `剧本上传失败（${response.status}）`;
        try { const body: unknown = await response.json(); if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') message = body.error; } catch { /* Preserve the HTTP status when no JSON error is available. */ }
        throw new Error(message);
      }
      setDetail(await request<WorkDetail>(`/api/works/${encodeURIComponent(id)}${board ? `?board=${encodeURIComponent(board)}` : ''}`));
      setFile(null); onChanged(); notify('现有剧本文件已关联');
    } catch (error) { notify(error instanceof Error ? error.message : '上传失败', true); }
    finally { setUploading(false); }
  };
  return <Modal title="作品详情" wide onClose={onClose} testId="work-detail">
    {loading ? <Loading /> : error ? <Empty title="暂时无法读取作品" description={error} action={<button className="button button-soft" onClick={() => setRetry((value) => value + 1)}>重新加载</button>} /> : detail && <div className="detail-content">
      <div className="detail-hero"><Poster work={detail.work} large /><div className="detail-intro"><div className="inline-tags"><PlatformBadge platform={detail.work.platform} /><OriginBadge origin={detail.work.origin} /></div><h2 data-testid="work-title">{displayTitle(detail.work)}</h2><p>{detail.work.author || '作者待补充'}</p><WorkMetadataNotice work={detail.work} /><div className="inline-tags">{detail.work.tags.length > 0 && <small className="raw-tag-label">平台标签</small>}{detail.work.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}</div><div className="detail-source"><SourceLink href={detail.work.sourceUrl} /></div></div></div>
      <section className="detail-script"><div><strong>对应剧本</strong><p>{detail.work.script ? detail.work.script.fileName : '尚未关联真实剧本文件'}</p><TranscribeStatus work={detail.work} notify={notify} /></div><div className="work-download-actions">{(detail.work.script || detail.work.platform !== 'hongguo') && <ScriptDownload script={detail.work.script} notify={notify} onChanged={onChanged} />}<OriginalDownload work={detail.work} notify={notify} /></div></section>
      {isAdmin && <details className="script-upload"><summary>管理剧本文件</summary><p>关联已有的剧本文件，供用户下载。</p><label className="field-label" htmlFor="script-file">选择文件</label><input id="script-file" type="file" accept=".docx,.pdf,.txt,.md" data-testid="script-upload" onChange={event => setFile(event.target.files?.[0] || null)} /><button className="button button-soft" disabled={!file || uploading} onClick={() => void upload()}><Upload size={14} />{uploading ? '上传中…' : '上传并关联'}</button></details>}
      <div className="detail-metrics">{detail.work.metrics.length ? detail.work.metrics.map((metric) => <div key={metric.key}><span>{metric.label}</span><strong>{metricValue(metric)}</strong><small>{metric.value === null ? '来源暂未提供' : '保留平台原始口径'}</small></div>) : <p className="muted">该来源尚未提供可展示的指标。</p>}</div>
      {!!detail.work.topics?.length && <section className="detail-section topic-evidence"><div className="section-title"><h3>细分题材与依据</h3></div><div className="topic-evidence-list">{detail.work.topics.map(topic => <div key={topic.id}><span className="tag">{topic.label}</span><small>{topic.source === 'platform' ? '平台原标签' : '文本线索'}</small><p>{topic.evidence}</p></div>)}</div></section>}
      <Trend observations={detail.observations.filter((item) => item.origin === detail.work.origin)} board={detail.work.board} />
      <section className="detail-section"><div className="section-title"><h3>作品简介</h3></div><p className="description">{detail.work.description || '当前来源暂无简介。'}</p><dl className="detail-facts"><div><dt>{detail.work.kind === 'novel' ? '字数' : '集数'}</dt><dd>{detail.work.kind === 'novel' ? detail.work.wordCount === null ? '未知' : `${compact(detail.work.wordCount)}字` : detail.work.episodeCount === null ? '未知' : `${detail.work.episodeCount}集`}</dd></div><div><dt>分类</dt><dd>{detail.work.category || '待分类'}</dd></div><div><dt>上线日期</dt><dd>{detail.work.publishedAt ? dateText(detail.work.publishedAt) : '未知'}</dd></div><div><dt>状态</dt><dd>{detail.work.serialStatus || '未知'}</dd></div></dl></section>
      <section className="source-receipt"><h4><CalendarDays size={15} />数据来源记录</h4><dl><div><dt>来源作品 ID</dt><dd>{detail.work.sourceId}</dd></div><div><dt>观测榜单</dt><dd>{detail.work.board || '未提供'}</dd></div><div><dt>{board ? '采集时间' : '最后已知观测'}</dt><dd>{dateText(detail.work.observedAt, true)}（北京时间）</dd></div><div><dt>来源更新时间</dt><dd>{detail.work.sourceUpdatedAt ? Number.isNaN(Date.parse(detail.work.sourceUpdatedAt)) ? detail.work.sourceUpdatedAt : dateText(detail.work.sourceUpdatedAt, true) : '来源未提供'}</dd></div></dl>{!board && <p>当前显示最后已知观测，作品可能不在最新榜单中。</p>}<p>缺失值保留为未知；作品同名不代表同一 IP，不自动建立跨平台关联。</p></section>
    </div>}
  </Modal>;
}
