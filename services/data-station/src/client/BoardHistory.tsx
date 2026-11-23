import { useEffect, useState } from 'react';
import { GitCompareArrows } from 'lucide-react';
import type { BoardComparison, BoardComparisonEntry, Platform } from '../shared/types';
import { request } from './api';
import { dateText, displayTitle, Empty, Loading, RankChange, WorkMetadataNotice } from './components';

type ComparisonFilter = 'all' | 'up' | 'down' | 'entered' | 'dropped' | 'same' | 'unknown';
const filterLabels: Record<ComparisonFilter, string> = { all: '全部', up: '上升', down: '下降', entered: '新上榜', dropped: '掉榜', same: '持平', unknown: '名次未知' };

function classify(entry: BoardComparisonEntry): Exclude<ComparisonFilter, 'all'> {
  if (entry.status !== 'stayed') return entry.status;
  if (entry.rankChange === null) return 'unknown';
  return entry.rankChange > 0 ? 'up' : entry.rankChange < 0 ? 'down' : 'same';
}

function rankText(rank: number | null, member: boolean): string {
  if (!member) return '未上榜';
  return rank === null ? '名次未知' : String(rank).padStart(2, '0');
}

/** Shows rank moves, new entries and dropped entries between two batches of one live board. */
export function BoardComparisonView({ platform, board, from, to, version, onClose, openDetail }: {
  platform: Platform; board: string; from: string; to: string; version: number;
  onClose: () => void; openDetail: (id: string, board?: string) => void;
}) {
  const query = new URLSearchParams({ platform, board, origin: 'live', from, to }).toString();
  const [snapshot, setSnapshot] = useState<{ query: string; value: BoardComparison } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<ComparisonFilter>('all');
  useEffect(() => {
    let cancelled = false;
    setError('');
    request<BoardComparison>(`/api/boards/compare?${query}`).then(value => { if (!cancelled) setSnapshot({ query, value }); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [query, version, retry]);
  const comparison = snapshot?.query === query ? snapshot.value : null;
  const counts: Record<ComparisonFilter, number> = { all: 0, up: 0, down: 0, entered: 0, dropped: 0, same: 0, unknown: 0 };
  for (const entry of comparison?.entries ?? []) { counts.all++; counts[classify(entry)]++; }
  const rows = (comparison?.entries ?? []).filter(entry => filter === 'all' || classify(entry) === filter);
  if (filter === 'up') rows.sort((a, b) => b.rankChange! - a.rankChange!);
  if (filter === 'down') rows.sort((a, b) => a.rankChange! - b.rankChange!);
  const filters = (Object.keys(filterLabels) as ComparisonFilter[]).filter(value => value !== 'unknown' || counts.unknown > 0);
  return <section className="board-comparison" data-testid="board-comparison" aria-label="批次对比">
    <div className="comparison-heading"><div><h3><GitCompareArrows size={16} />批次对比</h3><p>{dateText(from, true)} → {dateText(to, true)}（北京时间）· 对比该榜完整名单，不受题材筛选影响</p></div><button className="button button-outline" onClick={onClose}>返回榜单</button></div>
    {error && !comparison ? <Empty title="暂时无法对比这两批" description={error} action={<button className="button button-soft" onClick={() => setRetry(value => value + 1)}>重新加载</button>} />
      : !comparison ? <Loading label="正在对比两批采集…" /> : <>
        <div className="segmented comparison-filters" role="group" aria-label="对比筛选">{filters.map(value => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabels[value]}<small>{counts[value]}</small></button>)}</div>
        {error && <div className="facet-error" role="alert">更新暂未完成，已保留上次对比：{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {!rows.length ? <Empty title={`没有${filterLabels[filter]}的作品`} description="可以切换其他分类，或选择另一批次对比。" /> : <div className="table-scroll"><table className="work-table comparison-table"><thead><tr><th>作品</th><th className="rank-cell">{dateText(from, true)}</th><th className="rank-cell">{dateText(to, true)}</th><th className="change-cell">变化</th></tr></thead><tbody>{rows.map(entry => <tr key={entry.work.id} data-testid="comparison-row">
          <td><button className="comparison-work" onClick={() => openDetail(entry.work.id, board)}><strong>{displayTitle(entry.work)}</strong><WorkMetadataNotice work={entry.work} /><span>{entry.work.author || '作者待补充'}</span></button></td>
          <td className="rank-cell">{rankText(entry.fromRank, entry.status !== 'entered')}</td>
          <td className="rank-cell">{rankText(entry.toRank, entry.status !== 'dropped')}</td>
          <td className="change-cell">{entry.status === 'entered' ? <span className="membership-badge entered">新上榜</span> : entry.status === 'dropped' ? <span className="membership-badge dropped">掉榜</span> : entry.rankChange === null ? <span className="muted rank-change" title="至少一批缺少官方名次，不计算变化">名次未知</span> : <RankChange change={entry.rankChange} />}</td>
        </tr>)}</tbody></table></div>}
        <p className="comparison-note">只比较这两次采集各自的名单；中间批次曾掉榜又重返的作品仍按两端名次计算。名次缺失时不计算变化，不补零。</p>
      </>}
  </section>;
}
