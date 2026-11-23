/** Discovers public Hongguo category windows without accounts or executable page scripts. */
import { setTimeout as delay } from 'node:timers/promises';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import type { CollectionBatch, Work } from '../../shared/types.ts';
import { HongguoCollectionError, readHongguoHtml } from '../collectors/hongguo.ts';
import { ORIGIN, routeData } from '../collectors/hongguo-parser.js';
import type { DiscoveryTask } from './crawler.ts';
import type { DiscoveryAdapter } from './manager.ts';

/** HTTP limits and injectable transport; the manager owns page budgets and persistence. */
export interface HongguoDiscoveryOptions {
  requestIntervalMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const roots = ['real-drama', 'comic-drama', 'ai-drama'] as const;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pageNumber = positive.max(10_000);
const seriesSchema = z.object({
  series_id: z.string().regex(/^\d{1,30}$/), series_name: z.string().trim().min(1),
  series_cover: z.string().nullable().optional(), series_intro: z.string().default(''), tags: z.array(z.string()).default([]),
  episode_right_text: z.string().nullable().optional(),
  series_episode_info: z.object({ episode_total_cnt: positive.nullable().optional() }).nullable().optional(),
});
const categorySchema = z.object({
  isSuccess: z.literal(true), canonicalUrl: z.string().url(), query: z.object({ page: pageNumber }),
  categoryRoute: z.object({ canonicalPath: z.string(), contentType: z.enum(roots), contentTypeLabel: z.string().min(1),
    displayName: z.string().min(1), enabled: z.literal(true) }),
  recommendList: z.array(seriesSchema).max(100),
  pagination: z.object({ total: nonnegative, pageNum: pageNumber, pageSize: positive.max(100), totalPages: nonnegative.max(10_000) }),
});

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}

/** Accept only the three observed drama types and source-linked topic slugs. */
function categoryUrl(value: string, base: string = ORIGIN): { url: URL; page: number; contentType: string } {
  const url = new URL(value, base);
  const match = /^\/category\/(real-drama|comic-drama|ai-drama)(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/.exec(url.pathname);
  const entries = [...url.searchParams];
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !match
    || entries.length > 1 || entries.some(([key, page]) => key !== 'page' || !/^[1-9]\d{0,4}$/.test(page))) {
    throw new Error('Unsupported official category URL');
  }
  const page = Number(url.searchParams.get('page') ?? 1);
  if (page > 10_000) throw new Error('Category page exceeds supported range');
  url.search = page === 1 ? '' : `?page=${page}`;
  return { url, page, contentType: match[1]! };
}

function taskFor(url: URL): DiscoveryTask {
  const page = Number(url.searchParams.get('page') ?? 1);
  return { url: url.href, uniqueKey: `hongguo:category:${url.pathname}:page:${page}`, data: {} };
}

/** Reads only anchors; scripts, JSON strings and external links cannot add queue entries. */
function categoryLinks(html: string, base: URL): Map<string, URL> {
  const links = new Map<string, URL>();
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if (node.nodeName === 'a' && 'attrs' in node) {
      const href = node.attrs.find(attribute => attribute.name === 'href')?.value;
      if (href) {
        try { const { url } = categoryUrl(href, base.href); links.set(url.href, url); }
        catch (_error) { /* Navigation outside supported public drama categories is not a discovery task. */ }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html));
  return links;
}

function coverUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch (_error) { return null; /* Missing or unsupported artwork is unknown metadata. */ }
}

function extract(html: string, requested: ReturnType<typeof categoryUrl>, observedAt: string): {
  batch?: CollectionBatch; next: DiscoveryTask[]; coverage: string;
} {
  const data = categorySchema.parse(routeData(html, 'category_$'));
  const { url, page, contentType } = requested;
  if (data.canonicalUrl !== url.href || data.categoryRoute.canonicalPath !== url.pathname
    || data.categoryRoute.contentType !== contentType || data.query.page !== page) throw new Error('Category canonical URL or route mismatch');
  const { total, pageNum, pageSize, totalPages } = data.pagination;
  if (pageNum !== page || totalPages !== Math.ceil(total / pageSize) || (total === 0 ? page !== 1 : page > totalPages)) throw new Error('Category pagination mismatch');
  const expected = Math.min(pageSize, total - (page - 1) * pageSize);
  if (data.recommendList.length !== expected) throw new Error('Category page is incomplete');
  if (new Set(data.recommendList.map(row => row.series_id)).size !== data.recommendList.length) throw new Error('Duplicate category series IDs');

  const links = categoryLinks(html, url);
  const next = new Map<string, DiscoveryTask>();
  if (page < totalPages) {
    const following = new URL(url);
    following.search = `?page=${page + 1}`;
    if (!links.has(following.href)) throw new Error('Category next-page link is missing');
    const task = taskFor(following);
    next.set(task.uniqueKey, task);
  }
  for (const candidate of links.values()) {
    if (candidate.pathname === url.pathname || candidate.search || candidate.pathname.split('/').length !== 4) continue;
    const task = taskFor(candidate);
    next.set(task.uniqueKey, task);
  }

  if (total === 0) return { next: [...next.values()],
    coverage: `红果公开分类「${data.categoryRoute.contentTypeLabel} / ${data.categoryRoute.displayName}」当前声明 0 部作品；已核对合法空分类，不发布空作品批次、不清除已有作品，也不代表红果全库为空。` };

  const works: Work[] = data.recommendList.map(row => ({
    id: `hongguo:${row.series_id}`, sourceId: row.series_id, platform: 'hongguo', kind: 'drama',
    title: row.series_name, author: null, description: row.series_intro, coverUrl: coverUrl(row.series_cover),
    sourceUrl: `${ORIGIN}/detail?series_id=${row.series_id}`, tags: row.tags,
    category: row.tags[0] ?? data.categoryRoute.displayName,
    episodeCount: row.series_episode_info?.episode_total_cnt ?? null, wordCount: null,
    serialStatus: row.episode_right_text ?? null, publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: null }, { key: 'collection', label: '收藏', value: null },
      { key: 'likes', label: '点赞', value: null }],
    rank: null, rankChange: null, board: '', origin: 'live', observedAt, sourceUpdatedAt: null,
    metadataNote: `官方分类来源：${url.href}；${data.categoryRoute.contentTypeLabel} / ${data.categoryRoute.displayName}；不是榜单观察。`,
  }));
  const coverage = `红果公开分类「${data.categoryRoute.contentTypeLabel} / ${data.categoryRoute.displayName}」：第 ${page}/${totalPages} 页，${works.length} 部作品；来源声明当前目录窗口 ${total} 部，仅覆盖已采集页面，不是红果全库，也不是热播排名。`;
  return { batch: { platform: 'hongguo', works, observedAt, coverage }, next: [...next.values()], coverage };
}

/**
 * Creates a page-at-a-time adapter. Complete validated batches precede queue acknowledgement.
 * The manager scopes recurring root seeds; discovered topic and pagination keys remain stable.
 * @param options Bounded anonymous HTTP settings and test transport.
 * @returns A Hongguo adapter without database, queue or browser side effects.
 */
export function createHongguoDiscovery(options: HongguoDiscoveryOptions = {}): DiscoveryAdapter {
  const interval = bounded(options.requestIntervalMs ?? 1000, 'requestIntervalMs', 0, 60_000);
  const timeout = bounded(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const maxBytes = bounded(options.maxResponseBytes ?? 8_388_608, 'maxResponseBytes', 1024, 16_777_216);
  const fetchPage = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let requests = 0;
  return {
    platform: 'hongguo',
    async seeds(_cycle, signal) {
      signal.throwIfAborted();
      return roots.map(root => taskFor(new URL(`/category/${root}`, ORIGIN)));
    },
    async handle(task, signal) {
      signal.throwIfAborted();
      const requested = categoryUrl(task.url);
      if (requested.url.href !== task.url) throw new HongguoCollectionError('分类任务 URL 不是规范官方路径');
      if (requests > 0 && interval) await delay(interval, undefined, { signal });
      signal.throwIfAborted();
      requests++;
      const deadline = AbortSignal.timeout(timeout);
      const requestSignal = AbortSignal.any([signal, deadline]);
      try {
        const response = await fetchPage(requested.url, { method: 'GET', redirect: 'error', signal: requestSignal,
          headers: { accept: 'text/html', 'user-agent': 'MuseDataPreview/0.1 (+local read-only category collector)' } });
        if (!response.ok || response.redirected || (response.url && response.url !== requested.url.href)
          || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
          await response.body?.cancel();
          throw new Error(`Category response unavailable (HTTP ${response.status}, HTML required without redirects)`);
        }
        const html = await readHongguoHtml(response, maxBytes);
        requestSignal.throwIfAborted();
        const result = extract(html, requested, now().toISOString());
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const reason = deadline.aborted ? '请求超时' : error instanceof Error ? error.message : '未知页面错误';
        throw new HongguoCollectionError(`分类 ${requested.url.pathname} 第 ${requested.page} 页：${reason}`, { cause: error });
      }
    },
  };
}
