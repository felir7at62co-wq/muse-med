import { setTimeout as delay } from 'node:timers/promises';
import type { CollectionBatch, Metric, Work } from '../../shared/types.ts';
import { DEFAULT_MANAGED_DOUYIN_SOURCES, MAX_DOUYIN_SOURCES } from '../../shared/douyin-sources.ts';
import { sliceText } from '../../shared/text.ts';

const ORIGIN = 'https://jingxuan.douyin.com';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

/** A public video locates an explicitly selected creator, or is monitored on its own. */
export interface DouyinSource {
  videoId: string;
  mode: 'creator' | 'video';
  expectedAuthor?: string;
  expectedAuthorId?: string | null;
  maxVideos?: number;
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

/** The seed videos identify public drama creators; old seed videos are not imported as new posts. */
export const DEFAULT_DOUYIN_SOURCES: readonly DouyinSource[] = DEFAULT_MANAGED_DOUYIN_SOURCES;

export interface DouyinOptions {
  sources?: readonly DouyinSource[];
  maxVideosPerSource?: number;
  requestTimeoutMs?: number;
  requestIntervalMs?: number;
  requestRetries?: number;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onVerifiedSource?: (identity: { author: string; authorId: string | null }) => void;
}

interface VideoDetail {
  id: string;
  title: string;
  author: string;
  authorId: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  plays: number | null;
  likes: number | null;
}

interface Candidate { id: string; title: string; }
export interface PublicDouyinPage { detail: VideoDetail; creatorPosts: Candidate[]; }

/** A blocked or malformed source rejects its batch instead of publishing fake empty data. */
export class DouyinCollectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`抖音公开数据采集失败：${message}`, options);
    this.name = 'DouyinCollectionError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function videoId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{8,30}$/.test(value)) throw new DouyinCollectionError('公开页面没有有效的字符串作品 ID');
  return value;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && /(^|\.)(douyinpic\.com|byteimg\.com)$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function authorId(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/** Parses the official mobile page's inert JSON; it never executes page JavaScript. */
export function parseDouyinPublicPage(html: string, expectedId: string): PublicDouyinPage {
  videoId(expectedId);
  const raw = /<script\b[^>]*>\s*window\._SSR_DATA\s*=\s*([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!raw) throw new DouyinCollectionError('来源未返回作品数据，可能需要在独立浏览器完成访问验证');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/;\s*$/, '')); }
  catch (error) { throw new DouyinCollectionError('公开页面数据格式已变化', { cause: error }); }
  const state = record(record(record(parsed)?.data)?.storeState);
  const detailState = record(state?.detail);
  const forbidden = record(detailState?.isForbiden)?.result;
  if (forbidden === true) throw new DouyinCollectionError('作品被来源限制访问');
  const item = record(record(detailState?.videoData)?.result);
  const title = text(item?.title);
  const author = record(item?.media_user);
  const name = text(author?.screen_name);
  if (!item || !title || !name) throw new DouyinCollectionError('来源没有提供可验证的作品或作者，未用空页面覆盖成功数据');
  if (videoId(item.gid) !== expectedId) throw new DouyinCollectionError('返回作品 ID 与请求不一致');
  const published = typeof item.publish_time === 'number' && Number.isSafeInteger(item.publish_time)
    && item.publish_time > 0 && item.publish_time < 100_000_000_000 ? new Date(item.publish_time * 1000).toISOString() : null;
  const candidateValue = record(record(state?.['user-page'])?.videoList)?.result;
  const creatorPosts: Candidate[] = [];
  if (Array.isArray(candidateValue)) {
    for (const row of candidateValue.slice(0, 100)) {
      const candidate = record(row);
      const candidateTitle = text(candidate?.title);
      if (candidateTitle) creatorPosts.push({ id: videoId(candidate?.gid), title: candidateTitle });
    }
  }
  return {
    detail: { id: expectedId, title, author: name, authorId: authorId(author?.id), coverUrl: imageUrl(item.cover_image_url), publishedAt: published,
      plays: count(item.play_count), likes: count(item.digg_count) },
    creatorPosts,
  };
}

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function failureCode(error: unknown): string | null {
  let current = record(error);
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(current.code)) return current.code;
    current = record(current.cause);
  }
  return error instanceof Error ? error.name : null;
}

function isNetworkFailure(error: unknown): boolean {
  const code = failureCode(error);
  if (code && ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return true;
  if (!(error instanceof Error)) return false;
  const cause = record(error.cause);
  if (cause?.message === 'unexpected redirect') return false;
  return error.name === 'NetworkError' || (error.name === 'TypeError' && (!code || code === 'TypeError')
    && /fetch failed|failed to fetch|networkerror/i.test(error.message));
}

async function rejectResponse(response: Response, message: string): Promise<never> {
  try { await response.body?.cancel(); }
  catch (error) { throw new DouyinCollectionError(message, { cause: error }); }
  throw new DouyinCollectionError(message);
}

async function readHtml(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) return rejectResponse(response, '来源响应超过大小限制');
  if (!response.body) throw new DouyinCollectionError('来源没有返回内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let html = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) {
        try { await reader.cancel(); }
        catch (error) { throw new DouyinCollectionError('来源响应超过大小限制', { cause: error }); }
        throw new DouyinCollectionError('来源响应超过大小限制');
      }
      html += decoder.decode(part.value, { stream: true });
    }
    return html + decoder.decode();
  } finally { reader.releaseLock(); }
}

function matchesSource(title: string, source: DouyinSource): boolean {
  const lower = title.toLocaleLowerCase();
  return (!source.includeKeywords?.length || source.includeKeywords.some(keyword => lower.includes(keyword.toLocaleLowerCase())))
    && (!source.excludeKeywords?.length || !source.excludeKeywords.some(keyword => lower.includes(keyword.toLocaleLowerCase())));
}

function toWork(detail: VideoDetail, observedAt: string): Work {
  const metrics: Metric[] = [
    { key: 'video_plays', label: '精选页播放', value: detail.plays },
    { key: 'video_likes', label: '精选页点赞', value: detail.likes },
    { key: 'video_comments', label: '视频评论', value: null },
    { key: 'video_collections', label: '视频收藏', value: null },
    { key: 'video_shares', label: '视频分享', value: null },
  ];
  const hashtags = [...detail.title.matchAll(/#([^\s#，。！？!?,]{1,30})/g)].map(match => match[1]!);
  return {
    id: `douyin:${detail.id}`, sourceId: detail.id, platform: 'douyin', kind: 'drama',
    title: detail.title.length > 140 ? `${sliceText(detail.title, 0, 139)}…` : detail.title,
    author: detail.author,
    description: `【单条公开视频，非整部剧】${detail.title}`,
    coverUrl: detail.coverUrl, sourceUrl: `${ORIGIN}/m/video/${detail.id}`,
    tags: [...new Set(['单条视频', '非榜单', '抖音精选', ...hashtags])].slice(0, 10),
    category: '短剧创作者公开视频', episodeCount: null, wordCount: null, serialStatus: null,
    publishedAt: detail.publishedAt, metrics, rank: null, rankChange: null,
    board: '公开短剧作品监测（视频粒度，非榜单）', origin: 'live', observedAt, sourceUpdatedAt: null,
  };
}

/**
 * Monitors selected public drama creators' current video windows, never an invented site-wide ranking.
 * Each candidate is read from its own official detail page and verified against the selected creator.
 */
export async function collectDouyin(options: DouyinOptions = {}): Promise<CollectionBatch> {
  const sources = options.sources ?? DEFAULT_DOUYIN_SOURCES;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_DOUYIN_SOURCES) throw new TypeError(`sources must contain 1..${MAX_DOUYIN_SOURCES} public creator or video sources`);
  for (const source of sources) {
    videoId(source.videoId);
    if (!['creator', 'video'].includes(source.mode)) throw new TypeError('Invalid Douyin source mode');
    if (source.expectedAuthorId != null && !/^\d{1,30}$/.test(source.expectedAuthorId)) throw new TypeError('Invalid Douyin expected author ID');
    if (source.maxVideos !== undefined) bounded(source.maxVideos, 'maxVideos', 1, 20);
    for (const values of [source.includeKeywords, source.excludeKeywords]) {
      if (values && (!Array.isArray(values) || values.length > 30 || values.some(value => typeof value !== 'string' || !value || value.length > 80))) throw new TypeError('Invalid Douyin source keywords');
    }
  }
  const limit = bounded(options.maxVideosPerSource ?? 8, 'maxVideosPerSource', 1, 20);
  const timeout = bounded(options.requestTimeoutMs ?? 15_000, 'requestTimeoutMs', 100, 60_000);
  const interval = bounded(options.requestIntervalMs ?? 800, 'requestIntervalMs', 0, 60_000);
  const retries = bounded(options.requestRetries ?? 2, 'requestRetries', 0, 3);
  const retryDelay = bounded(options.retryDelayMs ?? 1000, 'retryDelayMs', 0, 30_000);
  const maxBytes = bounded(options.maxResponseBytes ?? 3_145_728, 'maxResponseBytes', 1024, 8_388_608);
  const fetchPage = options.fetch ?? globalThis.fetch;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const pageCache = new Map<string, PublicDouyinPage>();
  let requestCount = 0;
  const getPage = async (id: string, source: DouyinSource): Promise<PublicDouyinPage> => {
    options.signal?.throwIfAborted();
    const cached = pageCache.get(id);
    if (cached) return cached;
    for (let attempt = 0; attempt <= retries; attempt++) {
      options.signal?.throwIfAborted();
      const wait = attempt > 0 ? Math.max(interval, Math.min(30_000, retryDelay * 2 ** (attempt - 1))) : requestCount > 0 ? interval : 0;
      if (wait) await delay(wait, undefined, { signal: options.signal });
      options.signal?.throwIfAborted();
      requestCount++;
      const deadline = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      let stage: 'fetch' | 'read' | 'parse' = 'fetch';
      let status: number | null = null;
      try {
        const response = await fetchPage(`${ORIGIN}/m/video/${videoId(id)}`, {
          redirect: 'error', signal, headers: { accept: 'text/html', 'user-agent': MOBILE_USER_AGENT },
        });
        status = response.status;
        if (!response.ok) return await rejectResponse(response, `官方公开页面返回 HTTP ${status}，未覆盖旧数据`);
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
          return await rejectResponse(response, '来源没有返回公开 HTML 页面');
        }
        stage = 'read';
        const html = await readHtml(response, maxBytes);
        signal.throwIfAborted();
        stage = 'parse';
        const result = parseDouyinPublicPage(html, id);
        pageCache.set(id, result);
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const retryable = status === 429 || (status !== null && status >= 500 && status <= 599)
          || (!(error instanceof DouyinCollectionError) && stage !== 'parse' && (deadline.aborted || isNetworkFailure(error)));
        if (retryable && attempt < retries) continue;
        const reason = error instanceof DouyinCollectionError ? error.message.replace(/^抖音公开数据采集失败：/, '')
          : deadline.aborted ? '请求超时' : '无法读取官方公开页面，请检查网络或来源访问状态';
        const code = failureCode(error);
        const owner = source.expectedAuthor ? `「${source.expectedAuthor}」` : `定位视频 ${source.videoId}`;
        throw new DouyinCollectionError(`来源 ${owner}（定位视频 ${source.videoId}），视频 ${id}，${stage} 阶段：${reason}（${attempt + 1} 次尝试${code ? `，原因 ${code}` : ''}）`, { cause: error });
      }
    }
    throw new Error('Douyin request attempts exhausted without a result');
  };
  const works = new Map<string, Work>();
  const scopes: string[] = [];
  for (const source of sources) {
    const seed = await getPage(source.videoId, source);
    options.signal?.throwIfAborted();
    if (!source.expectedAuthorId && source.expectedAuthor && seed.detail.author !== source.expectedAuthor) throw new DouyinCollectionError('配置的创作者与公开页面作者不一致');
    if (source.expectedAuthorId && seed.detail.authorId !== source.expectedAuthorId) throw new DouyinCollectionError('配置的作者 ID 与公开页面身份不一致');
    options.onVerifiedSource?.({ author: seed.detail.author, authorId: seed.detail.authorId });
    if (source.mode === 'video') {
      works.set(seed.detail.id, toWork(seed.detail, observedAt));
      scopes.push(`指定视频 ${seed.detail.id}`);
      continue;
    }
    if (!seed.creatorPosts.length) throw new DouyinCollectionError(`「${seed.detail.author}」没有可验证的公开作品窗口`);
    const candidates = [...new Map(seed.creatorPosts.filter(item => matchesSource(item.title, source)).map(item => [item.id, item])).values()].slice(0, source.maxVideos ?? limit);
    if (!candidates.length) throw new DouyinCollectionError(`「${seed.detail.author}」公开窗口没有符合配置范围的作品`);
    for (const candidate of candidates) {
      const page = await getPage(candidate.id, source);
      options.signal?.throwIfAborted();
      if (seed.detail.authorId ? page.detail.authorId !== seed.detail.authorId : page.detail.author !== seed.detail.author) {
        throw new DouyinCollectionError('公开作品窗口包含其他作者，未把推荐流当作该账号的作品');
      }
      if (!matchesSource(page.detail.title, source)) throw new DouyinCollectionError('作品详情与所选内容范围不一致');
      works.set(page.detail.id, toWork(page.detail, observedAt));
    }
    scopes.push(`「${Array.from(seed.detail.author).slice(0, 30).join('')}」公开窗口 ${seed.creatorPosts.length} 条中的 ${candidates.length} 条${source.includeKeywords?.length || source.excludeKeywords?.length ? '（按配置关键词筛选）' : ''}`);
  }
  options.signal?.throwIfAborted();
  if (!works.size) throw new DouyinCollectionError('没有可验证的作品，不能视为零作品成功');
  return {
    platform: 'douyin', observedAt, works: [...works.values()],
    coverage: `${scopes.slice(0, 8).join('；')}${scopes.length > 8 ? `；另 ${scopes.length - 8} 个已配置来源` : ''}；共 ${sources.length} 个来源、${works.size} 条视频，${requestCount} 次官方公开页面请求。仅所选创作者/视频的公开窗口，不是全站短剧榜、全集或全库；播放/点赞为官方精选页单条视频口径，不是全站或整剧汇总，未提供的评论/收藏/分享保持未知。`,
  };
}
