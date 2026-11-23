import { setTimeout as delay } from 'node:timers/promises';
import type { CollectionBatch, Metric, Work } from '../../shared/types.ts';
import { BOARDS, CHANNELS, ORIGIN, PERIODS, QimaoError, parseRanking, parseRankingApi, rankingPageConfig } from './qimao/parser.js';
import type { Board, Channel, Period, QimaoRankingItem } from './qimao/parser.js';
import { rankingApiPath, readMetadata } from './qimao/transport.js';
import type { MetadataConfig } from './qimao/transport.js';

/** Official ranking selections; each selected board collects all declared positions up to 100. */
export interface QimaoOptions {
  channels?: Channel[];
  boards?: Board[];
  periods?: Period[];
  requestTimeoutMs?: number;
  requestIntervalMs?: number;
  maxResponseBytes?: number;
  allowLegacyResponseHeaders?: boolean;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** A failed page rejects the complete batch and never removes the previous successful data. */
export class QimaoCollectionError extends Error {
  /** False when repeating the same request cannot help, such as a verification failure or an access refusal. */
  readonly retryable: boolean;
  constructor(message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(`七猫采集失败：${message}`, options);
    this.name = 'QimaoCollectionError';
    this.retryable = options?.retryable ?? true;
  }
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer in ${minimum}..${maximum}`);
  return value;
}

function choose<T extends string>(value: T[] | undefined, labels: Readonly<Record<T, string>>, name: string): T[] {
  const choices = value ?? Object.keys(labels) as T[];
  if (!Array.isArray(choices) || choices.length === 0 || choices.some(item => !Object.hasOwn(labels, item))) throw new TypeError(`Invalid Qimao ${name}`);
  return [...new Set(choices)];
}

function workFromItem(item: QimaoRankingItem, observedAt: string, board: string, month: string | null): Work {
  const metrics: Metric[] = Object.entries(item.metrics).map(([key, metric]) => ({ key, label: metric.label, value: metric.value }));
  metrics.push({ key: 'currentReaders', label: '在读人数', value: null });
  return {
    id: `qimao:${item.bookId}`, sourceId: item.bookId, platform: 'qimao', kind: 'novel',
    title: item.title, author: item.author || null, description: item.description,
    coverUrl: item.coverUrl, sourceUrl: item.url, tags: item.tags,
    category: item.tags[0] ?? '未分类', episodeCount: null, wordCount: item.wordCount.value,
    serialStatus: item.status, publishedAt: null, metrics,
    rank: item.observations[0]?.rank ?? null, rankChange: null,
    board, origin: 'live', observedAt,
    sourceUpdatedAt: month ? `榜期 ${month}${item.updatedAt ? `；作品更新 ${item.updatedAt}` : ''}` : item.updatedAt,
  };
}

/**
 * Collect complete selected public rankings after aligning JSON page one with the displayed SSR list.
 * @param options Ranking selections, request bounds, cancellation, and test-only transport injection.
 * @returns An atomic batch covering the listed rankings and their declared counts, not the full library.
 */
export async function collectQimao(options: QimaoOptions = {}): Promise<CollectionBatch> {
  const channels = choose(options.channels, CHANNELS, 'channels');
  const boards = choose(options.boards, BOARDS, 'boards');
  const periods = choose(options.periods, PERIODS, 'periods');
  const timeout = integer(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const interval = integer(options.requestIntervalMs ?? 1000, 'requestIntervalMs', 0, 60_000);
  const maxBytes = integer(options.maxResponseBytes ?? 5_242_880, 'maxResponseBytes', 1024, 16_777_216);
  if (options.allowLegacyResponseHeaders !== undefined && typeof options.allowLegacyResponseHeaders !== 'boolean') throw new TypeError('allowLegacyResponseHeaders must be boolean');
  const config: MetadataConfig = { maxResponseBytes: maxBytes, allowLegacyResponseHeaders: options.allowLegacyResponseHeaders ?? true };
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const targets = channels.flatMap(channel => boards.flatMap(board => (['hot', 'new', 'over'].includes(board) ? periods : periods.filter(period => period === 'date')).map(period => ({
    channel, board, period, path: `/paihang/${channel}/${board}/${period}/`,
    label: `${CHANNELS[channel]} · ${BOARDS[board]}${board === 'hot' || period === 'month' ? ` · ${PERIODS[period]}` : ''}`,
  }))));
  if (!targets.length) throw new TypeError('Selected Qimao boards have no available ranking periods');
  const works: Work[] = [];
  let requests = 0;
  const read = async (path: string): Promise<string> => {
    options.signal?.throwIfAborted();
    if (requests++ > 0 && interval > 0) await delay(interval, undefined, { signal: options.signal });
    const deadline = AbortSignal.timeout(timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const page = await readMetadata(path, config, signal, { fetch: options.fetch });
      signal.throwIfAborted();
      return page.html;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = deadline.aborted ? '请求超时' : error instanceof QimaoError ? `${error.code}：${error.message}` : '网络请求未完成';
      throw new QimaoCollectionError(reason, { cause: error });
    }
  };
  const scopes: string[] = [];
  for (const target of targets) {
    try {
      const source = await read(target.path);
      const metadata = { ...target, sourceUrl: ORIGIN + target.path, fetchedAt: observedAt };
      const first = parseRanking(source, metadata);
      const paging = rankingPageConfig(source);
      if (['hot', 'new', 'over'].includes(target.board) && !paging.month) throw new QimaoError('invalid_paging_metadata', 'The selected heat ranking has no official month');
      const apiFirst = parseRankingApi(await read(rankingApiPath({ ...target, page: 1, month: paging.month.replace('-', '') })), metadata, { ...paging, page: 1 });
      if (first.items.length !== apiFirst.items.length || first.items.some((item, index) => item.bookId !== apiFirst.items[index]?.bookId)) {
        throw new QimaoError('ranking_identity_mismatch', 'The JSON ranking does not match the selected website list');
      }
      const items = [...apiFirst.items];
      for (let page = 2; page <= Math.ceil(paging.total / paging.pageSize); page++) {
        const body = await read(rankingApiPath({ ...target, page, month: paging.month.replace('-', '') }));
        items.push(...parseRankingApi(body, metadata, { ...paging, page }).items);
      }
      if (items.length !== paging.total || new Set(items.map(item => item.bookId)).size !== items.length) throw new QimaoError('duplicate_book_identity', 'The ranking pages omit or repeat a book ID');
      works.push(...items.map(item => workFromItem(item, observedAt, target.label, target.period === 'month' ? paging.month : null)));
      scopes.push(`${target.label} ${items.length}/${paging.total}${target.period === 'month' ? `（${paging.month}）` : ''}`);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = error instanceof QimaoError ? `${error.code}：${error.message}` : error instanceof QimaoCollectionError ? error.message.replace(/^七猫采集失败：/u, '') : '榜单元数据无法验证';
      throw new QimaoCollectionError(`${target.label}：${reason}`, { cause: error });
    }
  }
  if (works.length === 0) throw new QimaoCollectionError('没有取得可验证作品，不能视作零作品');
  const unique = new Set(works.map(work => work.id)).size;
  return {
    platform: 'qimao', works, observedAt,
    coverage: `${targets.length} 个官方榜单完整公开分页：${scopes.join('、')}；${unique} 部作品、${works.length} 条榜单观察，${requests} 次元数据读取。每榜最多 100 名，首页与官网逐项核对、分页身份与榜期校验；不是七猫全库。收藏和更新榜名次不作热度，未提供的人气、阅读次数、在读人数保持未知。`,
  };
}
