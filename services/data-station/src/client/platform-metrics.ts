import type { Platform, Work } from '../shared/types';
import { metricValue } from './components';

export interface MetricColumn { key: string; label: string; read: (work: Work) => string; }
const metric = (key: string) => (work: Work) => {
  const value = work.metrics.find(item => item.key === key);
  return value ? metricValue(value) : '—';
};
const wordCount = (work: Work) => work.wordCount === null ? '—' : `${new Intl.NumberFormat('zh-CN').format(work.wordCount)}字`;
const published = (work: Work) => work.publishedAt === null ? '未知' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(work.publishedAt));
const rankingPrimary = (work: Work) => {
  const value = work.metrics.find(item => item.key === 'ranking_primary');
  return value?.value != null ? `${metricValue(value)} ${value.label}` : '—';
};
export const platformMetricColumns: Record<Platform, MetricColumn[]> = {
  hongguo: [{ key: 'heat', label: '红果热度', read: metric('heat') }, { key: 'collection', label: '收藏', read: metric('collection') }, { key: 'likes', label: '点赞', read: metric('likes') },
    { key: 'shares', label: '分享', read: metric('shares') }, { key: 'rating', label: '评分', read: metric('rating') }, { key: 'ranking_primary', label: '榜单指标', read: rankingPrimary }],
  lvpaopao: [{ key: 'likes', label: '点赞', read: metric('likes') }, { key: 'comments', label: '评论', read: metric('comments') }, { key: 'shares', label: '分享', read: metric('shares') }],
  douyin: [{ key: 'video_plays', label: '精选页播放', read: metric('video_plays') }, { key: 'video_likes', label: '精选页点赞', read: metric('video_likes') }, { key: 'publishedAt', label: '视频发布（含年份）', read: published }],
  qimao: [{ key: 'heat', label: '源热度', read: metric('heat') }, { key: 'cumulativePopularity', label: '累计人气值', read: metric('cumulativePopularity') }, { key: 'wordCount', label: '字数', read: wordCount }],
  fanqie: [{ key: 'currentReaders', label: '在读人数', read: metric('currentReaders') }, { key: 'wordCount', label: '字数', read: wordCount }],
};

/** Reads current platform-native values for the library and bookshelf. */
export function primaryMetrics(work: Work): { key: string; label: string; value: string }[] {
  return platformMetricColumns[work.platform].map(column => ({ key: column.key, label: column.label, value: column.read(work) }));
}
