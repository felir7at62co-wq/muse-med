/** Discovers original-fiction windows from Qimao's official rendered library, without chapter requests. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Work } from '../../shared/types.ts';
import { QimaoCollectionError } from '../collectors/qimao.ts';
import { parseQimaoCatalog, type QimaoCatalogCategory, type QimaoCatalogSelection } from '../collectors/qimao/catalog.ts';
import { ORIGIN, QimaoError } from '../collectors/qimao/parser.js';
import { metadataUrl, readMetadata } from '../collectors/qimao/transport.js';
import type { DiscoveryTask } from './crawler.ts';
import type { DiscoveryAdapter } from './manager.ts';

const cycleSchema = z.string().regex(/^\d+:\d+$/).max(80);
const categorySchema = z.object({ parentId: z.string().regex(/^[1-9]\d{0,7}$/), id: z.string().regex(/^[1-9]\d{0,7}$/),
  name: z.string().min(1).max(500), parentName: z.string().min(1).max(500), type: z.enum(['0', '1']) }).strict();
const dataSchema = z.object({ kind: z.literal('catalog'), category: categorySchema.nullable(), order: z.enum(['click', 'update_time']),
  page: z.number().int().min(1).max(10_000), cycle: cycleSchema.nullable(),
  previousSignatures: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20) }).strict();
type TaskData = z.infer<typeof dataSchema>;
/** Source refusals and verification failures that an immediate repeat of the same request cannot fix. */
const deterministic = new Set(['invalid_catalog_metadata', 'access_blocked', 'redirect_rejected', 'invalid_content_type', 'unsupported_encoding', 'response_too_large']);

function retryable(error: unknown): boolean {
  if (error instanceof QimaoError) return !deterministic.has(error.code);
  return !(error instanceof Error && 'retryable' in error && error.retryable === false);
}

/** Request bounds and the number of original-fiction category heads revisited each cycle. */
export interface QimaoDiscoveryOptions {
  latestCategoriesPerCycle?: number;
  requestIntervalMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  allowLegacyResponseHeaders?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function path(data: Pick<TaskData, 'category' | 'order' | 'page'>): string {
  return `/shuku/a-${data.category?.parentId ?? 'a'}-${data.category?.id ?? 'a'}-a-a-a-a-${data.order}-${data.page}/`;
}

function job(category: QimaoCatalogCategory | null, order: TaskData['order'], page: number, cycle: string | null, previousSignatures: string[] = []): DiscoveryTask {
  const data: TaskData = { kind: 'catalog', category, order, page, cycle, previousSignatures };
  return { url: metadataUrl(path(data)).href,
    uniqueKey: `qimao:catalog:${category ? `${category.parentId}:${category.id}` : 'all'}:${order}:${page}${cycle ? `:latest:${cycle}` : ''}`,
    data, ...(cycle ? { priority: 'front' as const } : {}) };
}

/**
 * Creates a bounded catalog adapter; the manager owns database publication and queue acknowledgements.
 * @param options Official HTTP bounds and the periodic category rotation budget.
 * @returns Periodic all/latest roots and stable historical pagination tasks, preserving full source IDs.
 */
export function createQimaoDiscovery(options: QimaoDiscoveryOptions = {}): DiscoveryAdapter {
  const latestCategories = bounded(options.latestCategoriesPerCycle ?? 8, 'latestCategoriesPerCycle', 1, 100);
  const interval = bounded(options.requestIntervalMs ?? 1000, 'requestIntervalMs', 0, 60_000);
  const timeout = bounded(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const maxBytes = bounded(options.maxResponseBytes ?? 5_242_880, 'maxResponseBytes', 1024, 16_777_216);
  if (options.allowLegacyResponseHeaders !== undefined && typeof options.allowLegacyResponseHeaders !== 'boolean') throw new TypeError('allowLegacyResponseHeaders must be boolean');
  const now = options.now ?? (() => new Date());
  let requests = 0;
  return {
    platform: 'qimao',
    async seeds(cycle, signal) {
      signal.throwIfAborted(); cycleSchema.parse(cycle);
      return [job(null, 'click', 1, cycle), job(null, 'update_time', 1, cycle)];
    },
    async handle(task, signal) {
      signal.throwIfAborted();
      const data = dataSchema.parse(task.data);
      if (task.url !== metadataUrl(path(data)).href || data.cycle !== null && data.page !== 1
        || data.previousSignatures.length !== Math.min(data.page - 1, 20)) throw new QimaoCollectionError('书库任务参数与规范来源路径不一致', { retryable: false });
      if (requests++ > 0 && interval) await delay(interval, undefined, { signal });
      const deadline = AbortSignal.timeout(timeout), requestSignal = AbortSignal.any([signal, deadline]);
      try {
        const response = await readMetadata(path(data), { maxResponseBytes: maxBytes, allowLegacyResponseHeaders: options.allowLegacyResponseHeaders ?? true }, requestSignal, { fetch: options.fetch });
        requestSignal.throwIfAborted();
        const observedAt = now().toISOString();
        const selection: QimaoCatalogSelection = { parentId: data.category?.parentId ?? null, categoryId: data.category?.id ?? null, order: data.order, page: data.page };
        const parsed = parseQimaoCatalog(response.html, selection, observedAt);
        const signature = createHash('sha256').update(parsed.ids.join(',')).digest('hex');
        if (parsed.ids.length && data.previousSignatures.includes(signature)) throw Object.assign(new Error('书库分页内容与已读页面重复，保留当前任务等待核对'), { retryable: false });
        const category = data.category ? parsed.categories.find(item => item.parentId === data.category!.parentId && item.id === data.category!.id)! : null;
        const next: DiscoveryTask[] = [];
        if (parsed.page < parsed.totalPages) next.push(job(category, data.order, data.page + 1, null, [...data.previousSignatures, signature].slice(-20)));
        const categoryLabel = category ? `${category.parentName} / ${category.name}` : '全部书库';
        if (data.category === null && data.page === 1) {
          const categories = parsed.categories.toSorted((a, b) => Number(a.type) - Number(b.type) || Number(a.parentId) - Number(b.parentId) || Number(a.id) - Number(b.id));
          if (data.order === 'click') next.push(...categories.map(category => job(category, 'click', 1, null)));
          else if (data.cycle) {
            const start = Number(BigInt(data.cycle.split(':')[1]!) * BigInt(latestCategories) % BigInt(categories.length));
            const selected = Array.from({ length: Math.min(latestCategories, categories.length) }, (_, index) => categories[(start + index) % categories.length]!);
            next.push(...selected.map(category => job(category, 'update_time', 1, data.cycle)));
          }
        }
        const pageLabel = parsed.total === 0 ? '当前空目录' : `第 ${parsed.page}/${parsed.totalPages} 页`;
        const coverage = `七猫官方书库「${categoryLabel}」${data.order === 'click' ? '点击排序' : '最近更新'}：${pageLabel}，已核对 ${parsed.items.length} 部原创小说${parsed.excluded ? `，排除 ${parsed.excluded} 部出版分类作品` : ''}；来源声明当前窗口 ${parsed.total} 部，${parsed.categories.length} 个男女原创分类，分类相互重叠；${parsed.page < parsed.totalPages ? '下一页已排队续采' : '当前可见窗口已结束'}，不是七猫全库，也不是官方榜单。`;
        const works: Work[] = parsed.items.map(item => ({
          id: `qimao:${item.book_id}`, sourceId: item.book_id, platform: 'qimao', kind: 'novel', title: item.title,
          author: item.author || null, description: item.intro, coverUrl: item.coverUrl, sourceUrl: item.read_url, tags: item.tags,
          category: item.category2_name, episodeCount: null, wordCount: item.wordCount, serialStatus: item.is_over_txt,
          publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: null }, { key: 'cumulativePopularity', label: '累计人气值', value: null },
            { key: 'readOccurrences', label: '次阅读', value: null }, { key: 'currentReaders', label: '在读人数', value: null }],
          rank: null, rankChange: null, board: '', origin: 'live', observedAt, sourceUpdatedAt: item.update_time_txt || item.update_time || null,
          metadataStatus: 'verified', metadataNote: `官方书库来源：${task.url}；列表身份、书名和分类与同页 Nuxt 状态逐项核对；目录位置不是榜单排名。最近更新时间来自作品原始字段，不是作品发布日期。`,
        }));
        signal.throwIfAborted();
        return { ...(works.length ? { batch: { platform: 'qimao' as const, works, observedAt, coverage } } : {}), next, coverage };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new QimaoCollectionError(`书库 ${path(data)}：${deadline.aborted ? '请求超时' : error instanceof Error ? error.message.slice(0, 300) : '来源元数据未通过校验'}`,
          { cause: error, retryable: deadline.aborted || retryable(error) });
      }
    },
  };
}
