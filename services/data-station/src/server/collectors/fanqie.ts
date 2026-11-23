import { setTimeout as delay } from 'node:timers/promises';
import { ZodError } from 'zod';
import type { CollectionBatch } from '../../shared/types.ts';
import { BOARD_IDS, BOARD_LABELS, CHANNEL_IDS, FanqieSourceError, fanqieWork, parseFanqieApiRanking, parseFanqieCatalog, parseFanqieDetailApi } from './fanqie/parser.ts';
import type { FanqieBoard, FanqieChannel, FanqieDetail, FanqieTarget, FanqieUnavailableDetail, FanqieWindow } from './fanqie/parser.ts';
import type { FanqieDetailCache } from './fanqie/cache.ts';
import { createFanqieMetadataReader, FanqieCollectionError } from './fanqie/http.ts';
import { sliceText } from '../../shared/text.ts';

/** Official category discovery, complete bounded rankings, and resumable plaintext metadata. */
export interface FanqieOptions {
  channels?: FanqieChannel[];
  boards?: FanqieBoard[];
  categories?: Partial<Record<FanqieChannel, string[]>>;
  perWindowLimit?: number;
  maxDetailRequests?: number;
  requestTimeoutMs?: number;
  requestIntervalMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  detailCache?: FanqieDetailCache;
  onProgress?: (message: string) => void | Promise<void>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export { FanqieCollectionError } from './fanqie/http.ts';

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  return value;
}

function selections<T extends string>(value: T[] | undefined, allowed: Record<T, string>, name: string): T[] {
  const list = value ?? Object.keys(allowed) as T[];
  if (!Array.isArray(list) || !list.length || list.some(item => !Object.hasOwn(allowed, item))) throw new TypeError(`Invalid Fanqie ${name}`);
  return [...new Set(list)];
}

/** Collects every selected official category at one version; incomplete attempts only checkpoint metadata. */
export async function collectFanqie(options: FanqieOptions = {}): Promise<CollectionBatch> {
  const channels = selections(options.channels, CHANNEL_IDS, 'channels');
  const boards = selections(options.boards, BOARD_IDS, 'boards');
  const perWindow = integer(options.perWindowLimit ?? 100, 'perWindowLimit', 1, 100);
  const detailBudget = integer(options.maxDetailRequests ?? 10_000, 'maxDetailRequests', 1, 20_000);
  const timeout = integer(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const interval = integer(options.requestIntervalMs ?? 250, 'requestIntervalMs', 0, 60_000);
  const maximum = integer(options.maxResponseBytes ?? 5_242_880, 'maxResponseBytes', 1024, 16_777_216);
  const retries = integer(options.maxRetries ?? 2, 'maxRetries', 0, 3);
  const retryDelay = integer(options.retryDelayMs ?? 1000, 'retryDelayMs', 0, 60_000);
  for (const categories of Object.values(options.categories ?? {})) {
    if (!Array.isArray(categories) || !categories.length || categories.length > 100 || categories.some(id => !/^\d{1,8}$/.test(id))) throw new TypeError('Fanqie categories must be decimal official category IDs');
  }
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  let detailRequests = 0, cached = 0;

  const reader = createFanqieMetadataReader({ allowedPaths: ['/rank/1_2_262', '/api/rank/category/list', '/api/book/info'],
    requestTimeoutMs: timeout, requestIntervalMs: interval, maxResponseBytes: maximum, fetch: options.fetch });
  const readOnce = (path: string, format: 'html' | 'json') => reader(path, format, options.signal);

  const read = async (path: string, format: 'html' | 'json'): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      try { return await readOnce(path, format); }
      catch (error) {
        if (options.signal?.aborted || !(error instanceof FanqieCollectionError) || !error.retryable || attempt >= retries) throw error;
        await delay(retryDelay * 2 ** attempt, undefined, { signal: options.signal });
      }
    }
  };

  const windows: Array<{ target: FanqieTarget; window: FanqieWindow }> = [];
  const details = new Map<string, FanqieDetail>();
  const unavailable = new Map<string, FanqieUnavailableDetail>();
  let activeSource = '官网分类目录';
  try {
    const catalog = parseFanqieCatalog(await read('/rank/1_2_262', 'html'));
    const targets = channels.flatMap(channel => {
      const categoryIds = options.categories?.[channel] ?? catalog.categories[channel].map(item => item.id);
      if (categoryIds.some(id => !catalog.categories[channel].some(category => category.id === id))) throw new FanqieCollectionError('所选分类不在官网当前频道目录中');
      return boards.flatMap(board => [...new Set(categoryIds)].map(categoryId => ({ channel, board, categoryId })));
    });
    if (targets.length > 200) throw new FanqieCollectionError('官网分类数量超过本批次 200 个窗口上限');
    for (const target of targets) {
      const params = new URLSearchParams({ app_id: '2503', rank_list_type: '3', offset: '0', limit: String(perWindow),
        category_id: target.categoryId, rank_version: catalog.rankVersion, gender: CHANNEL_IDS[target.channel], rankMold: BOARD_IDS[target.board] });
      const category = catalog.categories[target.channel].find(item => item.id === target.categoryId)!;
      activeSource = `官网${target.channel}/${target.board}分类 ${target.categoryId}`;
      const window = parseFanqieApiRanking(JSON.parse(await read(`/api/rank/category/list?${params}`, 'json')), target, category.name, catalog.rankVersion, perWindow, catalog.sourceUpdatedAt);
      windows.push({ target, window });
      if (windows.length % 10 === 0 || windows.length === targets.length) await options.onProgress?.(`番茄榜单 ${windows.length}/${targets.length}；官网版本 ${catalog.rankVersion}；尚未发布本批次`);
    }
    const rows = new Map(windows.flatMap(({ window }) => window.rows.map(row => [row.bookId, row] as const)));
    for (const row of rows.values()) {
      options.signal?.throwIfAborted();
      activeSource = `官网书籍资料 ${row.bookId}`;
      const previous = await options.detailCache?.get(row.bookId, now());
      if (previous) { details.set(row.bookId, previous); cached++; }
      else {
        if (detailRequests >= detailBudget) throw new FanqieCollectionError(`本轮详情请求达到预算 ${detailBudget}，已核验资料已缓存，下轮继续；未发布不完整榜单`);
        detailRequests++;
        try {
          const detail = parseFanqieDetailApi(JSON.parse(await read(`/api/book/info?bookId=${row.bookId}`, 'json')), row.bookId);
          details.set(row.bookId, detail);
          await options.detailCache?.put(row.bookId, detail, now());
        } catch (error) {
          if (!(error instanceof FanqieSourceError) || error.code !== -1 || error.sourceMessage !== '查无此书') throw error;
          unavailable.set(row.bookId, { metadataStatus: 'unavailable', metadataNote: '官网详情接口返回“查无此书”（code=-1）；保留官方榜单位置和指标，书名作者未知，下轮重新核对。' });
        }
      }
      const processed = details.size + unavailable.size;
      if (processed % 25 === 0 || processed === rows.size) await options.onProgress?.(`番茄榜单 ${windows.length}/${targets.length}；明文资料 ${details.size}/${rows.size}（缓存 ${cached}，新取 ${details.size - cached}，资料不可用 ${unavailable.size}）；已处理 ${processed}；尚未发布本批次`);
    }
    const works = windows.flatMap(({ target, window }) => window.rows.map(row => fanqieWork(row, window, target, details.get(row.bookId) ?? unavailable.get(row.bookId)!, observedAt)));
    if (!works.length) throw new FanqieCollectionError('没有取得可验证作品，不能视作零作品');
    const complete = windows.filter(({ window }) => window.rows.length === window.total).length;
    const shorter = windows.filter(({ window }) => window.total < perWindow).length;
    const scope = channels.map(channel => `${channel === 'male' ? '男频' : '女频'} ${new Set(targets.filter(target => target.channel === channel).map(target => target.categoryId)).size} 分类`).join('、');
    return { platform: 'fanqie', works, observedAt,
      coverage: `${scope}，${windows.length} 个官方${boards.map(board => BOARD_LABELS[board]).join('/')}窗口；所选范围前 ${perWindow} 名，${complete}/${windows.length} 窗已取全（${shorter} 窗官方不足 ${perWindow} 部）；排名观察 ${works.length} 条、作品 ${rows.size} 部，明文资料 ${details.size}/${rows.size}、资料不可用 ${unavailable.size}。官网版本 ${catalog.rankVersion}，榜单名次/在读本批刷新；匹配 ID 明文资料新取 ${details.size - cached}、缓存 ${cached}${options.detailCache ? `（原始获取时间起有效 ${options.detailCache.ttlHours} 小时）` : ''}。不是小说全库，不采正文；不推断未取榜型或历史。` };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const reason = error instanceof ZodError
      ? `${activeSource}字段校验失败：${error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || '(响应)'} (${issue.code})`).join('、')}`
      : error instanceof Error ? sliceText(error.message.replace(/^番茄采集失败：/, ''), 0, 200) : '官网元数据未通过校验';
    throw new FanqieCollectionError(`${reason}；已核验明文资料 ${details.size} 部（复用 ${cached}，本轮新取 ${details.size - cached}）${options.detailCache ? '，缓存供下轮继续' : ''}；未发布本批次`, { cause: error });
  } finally {
    await options.detailCache?.flush();
  }
}
