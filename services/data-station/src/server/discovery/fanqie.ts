/** Discovers official Fanqie library windows and independently verifies each candidate's plaintext metadata. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Work } from '../../shared/types.ts';
import type { FanqieDetailCache } from '../collectors/fanqie/cache.ts';
import { createFanqieMetadataReader, FanqieCollectionError } from '../collectors/fanqie/http.ts';
import { FanqieSourceError, parseFanqieDetailApi } from '../collectors/fanqie/parser.ts';
import type { DiscoveryTask } from './crawler.ts';
import type { DiscoveryAdapter } from './manager.ts';

const ORIGIN = 'https://fanqienovel.com';
const DIRECTORY = '/api/author/book/category_list/v0/';
const LIBRARY = '/api/author/library/book_list/v0/';
const DETAIL = '/api/book/info';
const PAGE_SIZE = 18;
/** The source's public library UI stops at page 99, even when its API still advertises more. */
const LAST_PAGE_INDEX = 98;
const id = z.string().regex(/^\d{1,30}$/);
const categoryId = z.string().regex(/^(?:-1|\d{1,8})$/);
const readable = z.string().trim().min(1).max(100).refine(value => !/[\uE000-\uF8FF]/u.test(value));
const cycleSchema = z.string().regex(/^\d+:\d+$/).max(100);
const partitionSchema = z.object({ gender: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  categoryId, label: readable, sort: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  creationStatus: z.union([z.literal(-1), z.literal(1), z.literal(2)]),
  wordCount: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).strict();
type Partition = z.infer<typeof partitionSchema>;
const directoryTask = z.object({ kind: z.literal('directory'), cycle: cycleSchema }).strict();
const listTask = z.object({ kind: z.literal('list'), partition: partitionSchema, pageIndex: z.number().int().min(0).max(LAST_PAGE_INDEX),
  cycle: cycleSchema.nullable(), previousSignatures: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(LAST_PAGE_INDEX) }).strict();
const detailTask = z.object({ kind: z.literal('detail'), bookId: id, sourceUrl: z.string().url(), label: readable,
  revision: z.string().regex(/^\d{1,15}$/).nullable(), cycle: cycleSchema.nullable() }).strict();
const taskSchema = z.discriminatedUnion('kind', [directoryTask, listTask, detailTask]);
const directorySchema = z.object({ code: z.literal(0), data: z.array(z.object({
  category_id: z.number().int().nonnegative().max(99_999_999), label: z.enum(['主分类', '主题', '角色', '情节']), name: readable,
})).min(1).max(1000) });
const listSchema = z.object({ code: z.literal(0), data: z.object({
  book_list: z.array(z.object({ book_id: id, last_chapter_time: z.string().regex(/^\d{1,15}$/).optional() })).max(PAGE_SIZE),
  has_more: z.boolean(), total_count: z.number().int().nonnegative().safe(),
}) });

/** Transport limits, shared verified-detail cache and bounded periodic category rotation. */
export interface FanqieDiscoveryOptions {
  detailCache?: FanqieDetailCache;
  latestCategoriesPerCycle?: number;
  requestIntervalMs?: number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function libraryUrl(partition: Partition, pageIndex: number): string {
  const params = new URLSearchParams({ page_count: String(PAGE_SIZE), page_index: String(pageIndex), gender: String(partition.gender),
    category_id: partition.categoryId, creation_status: String(partition.creationStatus), word_count: String(partition.wordCount), book_type: '-1', sort: String(partition.sort) });
  return `${ORIGIN}${LIBRARY}?${params}`;
}

function windowKey(partition: Partition): string {
  return `${partition.gender}:${partition.categoryId}:${partition.sort}:${partition.creationStatus}:${partition.wordCount}`;
}

function listJob(partition: Partition, pageIndex: number, cycle: string | null, previousSignatures: string[] = []): DiscoveryTask {
  return { url: libraryUrl(partition, pageIndex), uniqueKey: `fanqie:library:${windowKey(partition)}:${pageIndex}${cycle ? `:latest:${cycle}` : ''}`,
    data: { kind: 'list', partition, pageIndex, cycle, previousSignatures }, ...(cycle ? { priority: 'front' as const } : {}) };
}

function envelope(value: unknown, source: string): void {
  const parsed = z.object({ code: z.number().int().safe(), message: z.unknown().optional() }).parse(value);
  if (parsed.code !== 0) throw new FanqieSourceError(parsed.code, typeof parsed.message === 'string' ? parsed.message : '', source);
}

function allPartition(gender: -1 | 0 | 1 = -1): Partition {
  return { gender, categoryId: '-1', label: gender === 1 ? '男频全部' : gender === 0 ? '女频全部' : '全部书库',
    sort: 1, creationStatus: -1, wordCount: -1 };
}

/** Validates the whole durable task before a same-origin HTTP read, including its embedded discovery URL. */
function validate(task: DiscoveryTask): z.infer<typeof taskSchema> {
  const data = taskSchema.parse(task.data);
  const expected = data.kind === 'directory' ? `${ORIGIN}${DIRECTORY}?gender=-1`
    : data.kind === 'list' ? libraryUrl(data.partition, data.pageIndex) : `${ORIGIN}${DETAIL}?bookId=${data.bookId}`;
  if (task.url !== expected) throw new Error('番茄任务 URL 与已校验参数不一致');
  if (data.kind === 'list' && (data.previousSignatures.length !== data.pageIndex || data.cycle !== null && (data.pageIndex !== 0 || data.partition.sort !== 1))) {
    throw new Error('番茄目录续采页码或最新窗口不一致');
  }
  if (data.kind === 'detail') {
    const source = new URL(data.sourceUrl);
    const pairs = [...source.searchParams];
    const fields = ['page_count', 'page_index', 'gender', 'category_id', 'creation_status', 'word_count', 'book_type', 'sort'];
    if (source.origin !== ORIGIN || source.username || source.password || source.hash || source.pathname !== LIBRARY
      || pairs.length !== fields.length || fields.some(key => source.searchParams.getAll(key).length !== 1)
      || source.searchParams.get('page_count') !== String(PAGE_SIZE) || source.searchParams.get('book_type') !== '-1') throw new Error('番茄发现来源不是受支持的官方书库窗口');
    const partition = partitionSchema.parse({ gender: Number(source.searchParams.get('gender')), categoryId: source.searchParams.get('category_id'),
      label: data.label, sort: Number(source.searchParams.get('sort')), creationStatus: Number(source.searchParams.get('creation_status')), wordCount: Number(source.searchParams.get('word_count')) });
    const index = z.coerce.number().int().min(0).max(LAST_PAGE_INDEX).parse(source.searchParams.get('page_index'));
    if (libraryUrl(partition, index) !== source.href) throw new Error('番茄发现来源参数不是规范路径');
  }
  return data;
}

/**
 * Creates a deterministic public-library adapter; queue and page publication belong to the manager.
 * @param options Bounded public HTTP settings, a shared metadata cache and the latest-category budget.
 * @returns Periodic latest seeds, stable historical windows and one-book plaintext detail tasks.
 */
export function createFanqieDiscovery(options: FanqieDiscoveryOptions = {}): DiscoveryAdapter {
  const latestCategories = bounded(options.latestCategoriesPerCycle ?? 8, 'latestCategoriesPerCycle', 1, 100);
  const read = createFanqieMetadataReader({ allowedPaths: [DIRECTORY, LIBRARY, DETAIL],
    requestIntervalMs: bounded(options.requestIntervalMs ?? 250, 'requestIntervalMs', 0, 60_000),
    requestTimeoutMs: bounded(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000),
    maxResponseBytes: bounded(options.maxResponseBytes ?? 5_242_880, 'maxResponseBytes', 1024, 16_777_216), fetch: options.fetch });
  const now = options.now ?? (() => new Date());
  return {
    platform: 'fanqie',
    async seeds(cycle, signal) {
      signal.throwIfAborted();
      cycleSchema.parse(cycle);
      return [listJob(allPartition(), 0, cycle), listJob(allPartition(1), 0, cycle), listJob(allPartition(0), 0, cycle),
        { url: `${ORIGIN}${DIRECTORY}?gender=-1`, uniqueKey: 'fanqie:categories', data: { kind: 'directory', cycle } }];
    },
    async handle(task, signal) {
      signal.throwIfAborted();
      const data = validate(task);
      try {
        if (data.kind === 'directory') {
          const value: unknown = JSON.parse(await read(`${DIRECTORY}?gender=-1`, 'json', signal));
          envelope(value, '官网书库分类');
          const directory = directorySchema.parse(value).data;
          if (new Set(directory.map(row => row.category_id)).size !== directory.length) throw new Error('官网书库分类 ID 重复');
          const categories = [...directory].sort((a, b) => a.category_id - b.category_id);
          // Rotating source-advertised filters limits periodic work while preserving history's stable queue keys.
          const bucket = BigInt(data.cycle.split(':')[1]!);
          const start = Number(bucket * BigInt(latestCategories) % BigInt(categories.length));
          const selected = Array.from({ length: Math.min(latestCategories, categories.length) }, (_, index) => categories[(start + index) % categories.length]!);
          const partition = (row: typeof categories[number]): Partition => ({ ...allPartition(), categoryId: String(row.category_id), label: `${row.label} · ${row.name}` });
          const periodic = selected.map(row => listJob(partition(row), 0, data.cycle));
          const history = categories.map(row => listJob(partition(row), 0, null));
          // These exact sort/status/word values are advertised by the official library UI.
          for (const sort of [0, 2] as const) for (const gender of [-1, 1, 0] as const) history.push(listJob({ ...allPartition(gender), sort }, 0, null));
          for (const creationStatus of [1, 2] as const) history.push(listJob({ ...allPartition(), creationStatus }, 0, null));
          for (const wordCount of [0, 1, 2, 3, 4] as const) history.push(listJob({ ...allPartition(), wordCount }, 0, null));
          signal.throwIfAborted();
          return { next: [...periodic, ...history], coverage: `番茄官方书库发现 ${categories.length} 个分类/主题/角色/情节入口；本周期滚动复访 ${selected.length} 个最新窗口，历史窗口按已保存队列续采；分类相互重叠，不代表作品总量。` };
        }
        if (data.kind === 'list') {
          const value: unknown = JSON.parse(await read(new URL(task.url).pathname + new URL(task.url).search, 'json', signal));
          envelope(value, '官网书库');
          const page = listSchema.parse(value).data;
          const ids = page.book_list.map(row => row.book_id);
          if (new Set(ids).size !== ids.length || page.total_count < ids.length || page.has_more && !ids.length) throw new Error('官网书库身份重复、数量异常或续采空页');
          const signature = createHash('sha256').update(ids.join(',')).digest('hex');
          if (data.previousSignatures.includes(signature)) return { next: [], coverage: `番茄「${data.partition.label}」第 ${data.pageIndex + 1} 页与已读页面重复，停止该历史窗口；不认定全库采集完成。` };
          const next: DiscoveryTask[] = page.book_list.map(row => {
            const revision = row.last_chapter_time ?? null;
            return { url: `${ORIGIN}${DETAIL}?bookId=${row.book_id}`, uniqueKey: `fanqie:detail:${row.book_id}:${revision ?? 'undated'}${data.cycle ? `:latest:${data.cycle}` : ''}`,
              data: { kind: 'detail', bookId: row.book_id, sourceUrl: task.url, label: data.partition.label, revision, cycle: data.cycle },
              ...(data.cycle ? { priority: 'front' as const } : {}) };
          });
          if (page.has_more && data.pageIndex < LAST_PAGE_INDEX) next.push(listJob(data.partition, data.pageIndex + 1, null, [...data.previousSignatures, signature]));
          const end = !page.has_more ? '来源声明当前窗口已结束' : data.pageIndex === LAST_PAGE_INDEX ? '达到官网可见 99 页窗口上限，API 仍称有更多，尚未取全' : '已保存下一页续采任务';
          signal.throwIfAborted();
          return { next, coverage: `番茄官方书库「${data.partition.label}」第 ${data.pageIndex + 1}/99 页：发现 ${ids.length} 个候选 ID，API 声明窗口 ${page.total_count} 部；${end}。列表字体编码不入库，待逐部明文核对；目录位置不是榜单名次，也不是小说全库。` };
        }
        const fetchedAt = now();
        let detail = await options.detailCache?.get(data.bookId, fetchedAt);
        if (!detail) {
          try {
            detail = parseFanqieDetailApi(JSON.parse(await read(`${DETAIL}?bookId=${data.bookId}`, 'json', signal)), data.bookId);
          } catch (error) {
            if (!(error instanceof FanqieSourceError) || error.code !== -1 || error.sourceMessage !== '查无此书') throw error;
            return { next: [], coverage: `番茄候选 ${data.bookId}：官网详情返回“查无此书”（code=-1）；未创建猜测书名或覆盖旧资料，周期最新任务会再次核对。` };
          }
          signal.throwIfAborted();
          await options.detailCache?.put(data.bookId, detail, fetchedAt);
          await options.detailCache?.flush();
        }
        signal.throwIfAborted();
        const observedAt = fetchedAt.toISOString();
        const work: Work = { id: `fanqie:${data.bookId}`, sourceId: data.bookId, platform: 'fanqie', kind: 'novel',
          title: detail.title, author: detail.author, description: detail.description, coverUrl: detail.coverUrl,
          sourceUrl: `${ORIGIN}/page/${data.bookId}`, tags: detail.tags, category: detail.tags[0] ?? '',
          episodeCount: null, wordCount: detail.wordCount, serialStatus: detail.status, publishedAt: null,
          metrics: [{ key: 'currentReaders', label: '在读人数', value: null }], rank: null, rankChange: null, board: '', origin: 'live',
          observedAt, sourceUpdatedAt: null, metadataStatus: 'verified',
          metadataNote: `官方书库发现来源：${data.sourceUrl}；${data.label}。明文详情按作品 ID 核对${options.detailCache ? `，可能复用原始获取时间起 ${options.detailCache.ttlHours} 小时内的资料缓存` : ''}；目录位置不是榜单名次。` };
        const coverage = `番茄候选 ${data.bookId} 已核对官方明文资料；来源为「${data.label}」书库窗口，不包含榜单排名/在读数据，不采小说正文，不代表全库。`;
        return { batch: { platform: 'fanqie', works: [work], observedAt, coverage }, next: [], coverage };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new FanqieCollectionError(`书库${data.kind === 'detail' ? `资料 ${data.bookId}` : data.kind === 'list' ? `第 ${data.pageIndex + 1} 页` : '分类'}：${error instanceof Error ? error.message.slice(0, 250) : '元数据未通过校验'}`, { cause: error },
          !(error instanceof FanqieCollectionError) || error.retryable);
      }
    },
  };
}
