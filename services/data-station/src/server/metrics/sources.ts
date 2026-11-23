/** Reads a single work's current public metrics from its official detail page, for works that no ranking currently covers. */
import { setTimeout as delay } from 'node:timers/promises';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import type { Metric, Platform, Work } from '../../shared/types.ts';
import { createFanqieMetadataReader } from '../collectors/fanqie/http.ts';
import { sourceCount } from '../collectors/fanqie/parser.ts';
import { readHongguoDetail } from '../collectors/hongguo-detail.ts';
import { parseMetric } from '../collectors/qimao/parser.js';
import { readMetadata } from '../collectors/qimao/transport.js';
import { parseQimaoState } from '../collectors/qimao/state.ts';

/** Metric values read from one detail page and the time the page was fetched. */
export interface MetricReading { metrics: Metric[]; measuredAt: string; }

/** One platform's detail-page metric reader; the refresher owns scheduling, pacing between works and persistence. */
export interface MetricSource {
  platform: Platform;
  /**
   * Reads the work's current metrics.
   * @param work A live work of this platform.
   * @param signal Cancels the request.
   * @returns The reading, or null when the source reports that the work no longer exists.
   * @throws When the page is unavailable or its fields no longer match the expected source data.
   */
  read(work: Work, signal: AbortSignal): Promise<MetricReading | null>;
}

/** HTTP limits shared by the three sources. */
export interface MetricSourceOptions {
  requestTimeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Reads Fanqie's official book information API; `readCount` equals the ranking API's 在读人数 for the same book.
 * @param options HTTP limits and optional test transport.
 * @returns A source recording `currentReaders`.
 */
export function createFanqieMetricSource(options: MetricSourceOptions): MetricSource {
  const read = createFanqieMetadataReader({ allowedPaths: ['/api/book/info'], requestTimeoutMs: options.requestTimeoutMs,
    requestIntervalMs: 0, maxResponseBytes: options.maxResponseBytes, fetch: options.fetch });
  const now = options.now ?? (() => new Date());
  return {
    platform: 'fanqie',
    async read(work, signal) {
      if (work.platform !== 'fanqie' || !/^\d{1,30}$/.test(work.sourceId)) throw new TypeError('Not a Fanqie work');
      const body = z.object({ code: z.number().int(), message: z.string().optional(), data: z.unknown() })
        .parse(JSON.parse(await read(`/api/book/info?bookId=${work.sourceId}`, 'json', signal)));
      const measuredAt = now().toISOString();
      if (body.code === -1 && body.message === '查无此书') return null;
      if (body.code !== 0) throw new Error(`Fanqie book information returned code ${body.code}`);
      const data = z.object({ bookId: z.string(), readCount: z.union([z.string().max(100), z.number().finite()]).nullish() }).parse(body.data);
      if (data.bookId !== work.sourceId) throw new Error('Fanqie book information identity differs from the request');
      return { measuredAt, metrics: [{ key: 'currentReaders', label: '在读人数', value: sourceCount(data.readCount) }] };
    },
  };
}

/**
 * Reads a Hongguo drama's official detail page: 热度 from `hot_score_data.score`, 收藏 and 点赞 from the series counts,
 * 评分 and 评分人数 from `rating` and `rating_count`, and 评论数 from `reviews.total_count`; the page shows no share count.
 * @param options HTTP limits and optional test transport.
 * @returns A source recording `heat`, `collection` and `likes`; a missing count stays null.
 */
export function createHongguoMetricSource(options: MetricSourceOptions): MetricSource {
  return {
    platform: 'hongguo',
    async read(work, signal) {
      if (work.platform !== 'hongguo' || !/^\d{1,30}$/.test(work.sourceId)) throw new TypeError('Not a Hongguo work');
      const detail = await readHongguoDetail(work.sourceId, options, signal);
      if (!detail) return null;
      return { measuredAt: detail.measuredAt, metrics: [
        { key: 'heat', label: '热度', value: detail.heat },
        { key: 'collection', label: '收藏', value: detail.collection },
        { key: 'likes', label: '点赞', value: detail.likes },
        { key: 'rating', label: '评分', value: detail.rating, unit: '分' },
        { key: 'rating_count', label: '评分人数', value: detail.ratingCount },
        { key: 'review_count', label: '评论数', value: detail.reviewCount },
      ] };
    },
  };
}

type Node = DefaultTreeAdapterMap['node'];
/** Visible text of a page, without script, style or template contents. */
function visibleText(html: string): string {
  const parts: string[] = [];
  const pending: Node[] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ('value' in node && node.nodeName === '#text') parts.push(node.value);
    if ('childNodes' in node && !['script', 'style', 'template', 'noscript'].includes(node.nodeName)) pending.push(...node.childNodes.toReversed());
  }
  return parts.join(' ').replace(/[\s,，]/gu, '');
}

function nuxtScript(html: string): string {
  const scripts: string[] = [];
  const pending: Node[] = [parse(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.nodeName === 'script' && 'childNodes' in node) {
      const text = node.childNodes.flatMap(child => 'value' in child ? [child.value] : []).join('');
      if (text.includes('window.__NUXT__')) scripts.push(text.trim().replace(/;$/u, ''));
    } else if ('childNodes' in node) pending.push(...node.childNodes);
  }
  if (scripts.length !== 1) throw new Error('Qimao book page state is missing or repeated');
  return scripts[0]!;
}

/**
 * Reads a state count whose unit only appears on the rendered page, e.g. `hot_value: "1935.7"` rendered as 1935.7万累计人气值.
 * @returns The count, or null when the page does not render that value with the label.
 */
function renderedCount(text: string, value: string | null | undefined, label: string, measuredAt: string): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const match = new RegExp(`${value.replace('.', '\\.')}(万|亿)?${label}`, 'u').exec(text);
  return match ? parseMetric(`${value}${match[1] ?? ''}${label}`, label, measuredAt).value : null;
}

const qimaoBook = z.object({ state: z.object({ common: z.object({ bookRelatedInfo: z.object({ bookDetail: z.object({
  book_id: z.string(), hot_value: z.string().nullish(), pursue_count: z.string().nullish(),
}).passthrough() }).passthrough() }).passthrough() }).passthrough() }).passthrough();

/**
 * Reads a Qimao book page: 累计人气值 and 次阅读 come from the page state and keep the unit the page renders with them.
 * The ranking-only 源热度 is not on this page and stays unknown.
 * @param options HTTP limits and optional test transport.
 * @returns A source recording `cumulativePopularity` and `readOccurrences`.
 */
export function createQimaoMetricSource(options: MetricSourceOptions & { allowLegacyResponseHeaders?: boolean }): MetricSource {
  const now = options.now ?? (() => new Date());
  return {
    platform: 'qimao',
    async read(work, signal) {
      if (work.platform !== 'qimao' || !/^\d{1,24}(?:_0)?$/.test(work.sourceId)) throw new TypeError('Not a Qimao work');
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]);
      const { html } = await readMetadata(`/shuku/${work.sourceId}/`, { maxResponseBytes: options.maxResponseBytes,
        allowLegacyResponseHeaders: options.allowLegacyResponseHeaders ?? true }, requestSignal, { fetch: options.fetch });
      const measuredAt = now().toISOString();
      const book = qimaoBook.parse(parseQimaoState(nuxtScript(html), { allowCollectionAliases: true })).state.common.bookRelatedInfo.bookDetail;
      if (book.book_id !== work.sourceId.replace(/_0$/u, '') && book.book_id !== work.sourceId) throw new Error('Qimao book identity differs from the request');
      const text = visibleText(html);
      return { measuredAt, metrics: [
        { key: 'cumulativePopularity', label: '累计人气值', value: renderedCount(text, book.hot_value, '累计人气值', measuredAt) },
        { key: 'readOccurrences', label: '次阅读', value: renderedCount(text, book.pursue_count, '次阅读', measuredAt) },
      ] };
    },
  };
}

/** Waits between two works of one run. */
export async function pace(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (intervalMs > 0) await delay(intervalMs, undefined, { signal });
}
