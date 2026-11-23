import { setTimeout as delay } from 'node:timers/promises';
import type { CollectionBatch, Work } from '../../shared/types.ts';
import { BOARDS, IncompletePageError, ORIGIN, parseRanking } from './hongguo-parser.js';
import type { Board, RankingEntry } from './hongguo-parser.js';

export const BOARD_LABELS: Record<Board, string> = {
  'hot-drama': '综合热播榜',
  'hot-real-drama': '真人热播榜',
  'hot-ai-drama': 'AI 热播榜',
  'hot-comic-drama': '漫剧热播榜',
  'new-drama': '综合新剧榜',
  'followed-drama': '综合收藏榜',
  'must-watch-drama': '综合必看榜',
};

/** A single bounded, read-only collection. Tests may inject fetch and a clock. */
export interface HongguoOptions {
  boards?: Board[];
  maxPages?: number;
  requestTimeoutMs?: number;
  requestIntervalMs?: number;
  maxResponseBytes?: number;
  incompletePageRetries?: number;
  /** Waits before each repeat of a page answered with HTTP 429 or 5xx; its length is the number of repeats. */
  transientRetryDelaysMs?: number[];
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Each failure rejects the batch so callers keep the previous successful snapshot. */
export class HongguoCollectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`红果采集失败：${message}`, options);
    this.name = 'HongguoCollectionError';
  }
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * Read at most the configured number of bytes, including chunked responses.
 * @param response An already checked official HTML response.
 * @param maxBytes Maximum decoded input bytes before cancellation.
 * @returns Complete HTML; oversized or missing bodies reject the page.
 */
export async function readHongguoHtml(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new HongguoCollectionError('官网响应超过大小限制');
  }
  if (!response.body) throw new HongguoCollectionError('官网没有返回页面内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HongguoCollectionError('官网响应超过大小限制');
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function toWork(row: RankingEntry, observedAt: string): Work {
  return {
    id: `hongguo:${row.seriesId}`,
    sourceId: row.seriesId,
    platform: 'hongguo',
    kind: 'drama',
    title: row.title,
    author: null,
    description: row.description,
    coverUrl: row.coverUrl,
    sourceUrl: row.url,
    tags: row.tags,
    category: row.tags[0] ?? BOARD_LABELS[row.observation.board],
    episodeCount: row.episodeCount,
    wordCount: null,
    serialStatus: null,
    publishedAt: null,
    metrics: [
      { key: 'heat', label: '热度', value: row.heat.value },
      { key: 'collection', label: '收藏', value: row.collection.value },
      { key: 'likes', label: '点赞', value: row.likes.value },
      { key: 'shares', label: '分享', value: row.shares.value },
      { key: 'rating', label: '评分', value: row.rating, unit: '分' },
      { key: 'rating_count', label: '评分人数', value: row.ratingCount.value },
      { key: 'ranking_primary', label: row.rankingPrimary.label, value: row.rankingPrimary.value },
    ],
    rank: row.observation.rank,
    rankChange: null,
    board: BOARD_LABELS[row.observation.board],
    origin: 'live',
    observedAt,
    // This is the website's original update text, not a fabricated ISO timestamp.
    sourceUpdatedAt: row.observation.updateDate,
  };
}

/**
 * Collect supported official ranking pages without cookies, executable scripts or redirects.
 * Duplicate work IDs on different boards are retained as separate board observations.
 *
 * @param options Page bounds, cancellation, and test-only transport injection.
 * @returns An all-or-fail batch limited to the selected boards and fetched pages.
 */
export async function collectHongguo(options: HongguoOptions = {}): Promise<CollectionBatch> {
  const boards = options.boards ?? [...BOARDS];
  if (!Array.isArray(boards) || boards.length === 0 || boards.some(board => !BOARDS.includes(board))) {
    throw new TypeError('boards must be a non-empty list of supported Hongguo boards');
  }
  const selected = [...new Set(boards)];
  const maxPages = boundedInteger(options.maxPages ?? 1, 'maxPages', 1, 5);
  const timeout = boundedInteger(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const interval = boundedInteger(options.requestIntervalMs ?? 1_000, 'requestIntervalMs', 0, 60_000);
  const maxBytes = boundedInteger(options.maxResponseBytes ?? 8_388_608, 'maxResponseBytes', 1024, 16_777_216);
  const retries = boundedInteger(options.incompletePageRetries ?? 1, 'incompletePageRetries', 0, 2);
  // Observed 2026-11-15: the site answers single pages with HTTP 503 at random and the same page loads seconds later.
  const transientDelays = (options.transientRetryDelaysMs ?? [2_000, 5_000, 10_000]).map((value, index) => boundedInteger(value, `transientRetryDelaysMs[${index}]`, 0, 60_000));
  if (transientDelays.length > 5) throw new TypeError('transientRetryDelaysMs allows at most 5 repeats');
  const fetchPage = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const works: Work[] = [];
  let fetchedPages = 0;
  let expectedPages = 0;
  let requests = 0;

  for (const board of selected) {
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, maxPages); page++) {
      const url = new URL(`/rank/${board}`, ORIGIN);
      if (page > 1) url.searchParams.set('page', String(page));
      let parsed: ReturnType<typeof parseRanking> | undefined;
      let transient = 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        options.signal?.throwIfAborted();
        if (requests > 0 && interval > 0) await delay(interval, undefined, { signal: options.signal });
        requests++;
        const timeoutSignal = AbortSignal.timeout(timeout);
        const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        try {
          const response = await fetchPage(url, {
            method: 'GET', redirect: 'error', signal,
            headers: {
              accept: 'text/html',
              'user-agent': 'MuseDataPreview/0.1 (+local read-only ranking collector)',
            },
          });
          if (!response.ok) {
            await response.body?.cancel();
            if ((response.status === 429 || response.status >= 500) && transient < transientDelays.length) {
              await delay(transientDelays[transient++]!, undefined, { signal: options.signal });
              attempt--;
              continue;
            }
            throw new HongguoCollectionError(`${BOARD_LABELS[board]}第 ${page} 页返回 HTTP ${response.status}${transient ? `（已重试 ${transient} 次）` : ''}，未覆盖上次成功数据`);
          }
          const contentType = response.headers.get('content-type') ?? '';
          if (!contentType.toLowerCase().includes('text/html')) {
            await response.body?.cancel();
            throw new HongguoCollectionError(`${BOARD_LABELS[board]}第 ${page} 页没有返回 HTML`);
          }
          const html = await readHongguoHtml(response, maxBytes);
          signal.throwIfAborted();
          parsed = parseRanking(html, { board, page, sourceUrl: url.href, fetchedAt: observedAt });
          break;
        } catch (error) {
          if (error instanceof IncompletePageError && attempt < retries) continue;
          if (options.signal?.aborted) throw error;
          if (error instanceof HongguoCollectionError) throw error;
          const reason = timeoutSignal.aborted ? '请求超时' : error instanceof Error ? error.message : '未知访问错误';
          throw new HongguoCollectionError(`${BOARD_LABELS[board]}第 ${page} 页：${reason}`, { cause: error });
        }
      }
      if (!parsed) throw new HongguoCollectionError(`${BOARD_LABELS[board]}第 ${page} 页数据未完成`);
      totalPages = parsed.totalPages;
      fetchedPages++;
      works.push(...parsed.items.map(row => toWork(row, observedAt)));
    }
    expectedPages += totalPages;
  }
  if (works.length === 0) throw new HongguoCollectionError('公开榜单没有可验证作品，不能视作零作品');
  const uniqueWorks = new Set(works.map(work => work.id)).size;
  const scope = selected.map(board => BOARD_LABELS[board]).join('、');
  const range = fetchedPages < expectedPages ? `，当前仅抓取每榜前 ${maxPages} 页（其余分页未采集）` : '，已取得所选榜单公开分页';
  return {
    platform: 'hongguo', works, observedAt,
    coverage: `${scope}：${fetchedPages}/${expectedPages} 页，${uniqueWorks} 部作品、${works.length} 条榜单观察${range}；不是红果全库，缺失指标保持未知，万/亿展示值可能取整。`,
  };
}
