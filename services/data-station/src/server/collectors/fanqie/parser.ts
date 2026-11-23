import { z } from 'zod';
import type { Work } from '../../../shared/types.ts';

export type FanqieChannel = 'male' | 'female';
export type FanqieBoard = 'read' | 'new';
export const CHANNEL_IDS: Record<FanqieChannel, string> = { male: '1', female: '0' };
export const BOARD_IDS: Record<FanqieBoard, string> = { read: '2', new: '1' };
export const CHANNEL_LABELS: Record<FanqieChannel, string> = { male: '男频', female: '女频' };
export const BOARD_LABELS: Record<FanqieBoard, string> = { read: '阅读榜', new: '新书榜' };
const idSchema = z.string().regex(/^\d{1,30}$/);
const countSchema = z.union([z.string().max(100), z.number().finite()]).nullish();
const categorySchema = z.object({ id: z.string().regex(/^\d{1,8}$/), name: z.string().min(1).max(100) });
const rowSchema = z.object({
  bookId: idSchema, currentPos: z.number().int().positive(),
  curent_category_id: z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d{1,8}$/)]),
  read_count: countSchema,
  wordNumber: countSchema,
  creationStatus: z.union([z.string(), z.number()]).nullish(),
  thumbUri: z.string().nullish(), thumbUrl: z.string().nullish(),
});
const rankStateSchema = z.object({ rank: z.object({
  serverRendered: z.literal(true), book_list: z.array(rowSchema).min(1).max(100),
  defaultPage: z.literal(1), total_num: z.number().int().positive().safe(),
  rankCategoryTypeList: z.object({ male: z.array(categorySchema), female: z.array(categorySchema) }),
}) });
const detailStateSchema = z.object({ page: z.object({
  hasFetch: z.literal(true), bookId: idSchema, bookName: z.string().min(1).max(500),
  author: z.string().max(500), abstract: z.string().max(30_000),
  categoryV2: z.string().optional(), creationStatus: z.union([z.string(), z.number()]).optional(),
  wordNumber: countSchema, thumbUrl: z.string().optional(), thumbUri: z.string().optional(),
}) });

function parseSsrObject(source: string): unknown {
  let normalized = '', quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; normalized += char; continue; }
    if (source.startsWith('undefined', index)) {
      let before = index - 1, after = index + 'undefined'.length;
      while (/\s/.test(source[before] ?? '') && before >= 0) before--;
      while (/\s/.test(source[after] ?? '') && after < source.length) after++;
      if ([':', '[', ','].includes(source[before] ?? '') && [',', '}', ']'].includes(source[after] ?? '')) {
        normalized += 'null';
        index += 'undefined'.length - 1;
        continue;
      }
    }
    normalized += char;
  }
  return JSON.parse(normalized);
}

/** Read a balanced JSON object without evaluating any page script or JavaScript expression. */
export function readInitialState(html: string): unknown {
  if (/<title[^>]*>[^<]*(?:验证码|安全验证|Access Denied|Forbidden)/iu.test(html)) throw new Error('官网要求验证或拒绝访问');
  const assignment = /\bwindow\.__INITIAL_STATE__\s*=\s*/g;
  const match = assignment.exec(html);
  if (!match || html[assignment.lastIndex] !== '{') throw new Error('官网页面没有可验证的结构化数据');
  const start = assignment.lastIndex;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return parseSsrObject(html.slice(start, index + 1));
    }
  }
  throw new Error('官网结构化数据未完整返回');
}

/** Decimal source counts stay unknown when absent, unsafe, or font encoded. */
export function sourceCount(value: string | number | null | undefined): number | null {
  if (value == null || !/^\d+$/.test(String(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export interface FanqieTarget { channel: FanqieChannel; board: FanqieBoard; categoryId: string; }
export interface FanqieRankRow { bookId: string; rank: number; readers: number | null; wordCount?: number | null; status?: string | null; coverUrl?: string | null; }
export interface FanqieWindow { rows: FanqieRankRow[]; category: string; total: number; sourceUpdatedAt: string | null; }
export interface FanqieCatalog { categories: Record<FanqieChannel, { id: string; name: string }[]>; rankVersion: string; sourceUpdatedAt: string | null; }

/** Reads the current official category directory and the version to reuse for every window. */
export function parseFanqieCatalog(html: string): FanqieCatalog {
  const { rank } = z.object({ rank: z.object({
    serverRendered: z.literal(true), rankVersion: z.string().regex(/^\d{1,30}$/),
    rankCategoryTypeList: z.object({ male: z.array(categorySchema).min(1).max(100), female: z.array(categorySchema).min(1).max(100) }),
  }) }).parse(readInitialState(html));
  for (const categories of Object.values(rank.rankCategoryTypeList)) {
    if (new Set(categories.map(category => category.id)).size !== categories.length) throw new Error('官网分类目录包含重复 ID');
  }
  const updated = html.match(/统计时间截止至(?:<!--[\s\S]*?-->)*([^<]{1,80})</u)?.[1]?.trim();
  return { categories: rank.rankCategoryTypeList, rankVersion: rank.rankVersion,
    sourceUpdatedAt: `${updated ? `统计时间截止至${updated}；` : ''}官网榜单版本 ${rank.rankVersion}` };
}

const totalSchema = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d{1,3}$/).transform(Number)]).refine(value => value <= 100);

/** Preserves the official business code and original message without interpreting unknown codes. */
export class FanqieSourceError extends Error {
  constructor(readonly code: number, readonly sourceMessage: string, source: string) {
    const message = sourceMessage.replace(/https?:\/\/\S+/giu, '[来源地址]').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
    super(`${source}返回业务错误 code=${code}${message ? `：${message}` : ''}`);
    this.name = 'FanqieSourceError';
  }
}

function assertBusinessSuccess(value: unknown, source: string): void {
  const result = z.object({ code: z.number().int().safe(), message: z.unknown().optional() }).parse(value);
  if (result.code !== 0) throw new FanqieSourceError(result.code, typeof result.message === 'string' ? result.message : '', source);
}

/** Validates complete official Top100 responses, including genuinely shorter boards and version identity. */
export function parseFanqieApiRanking(value: unknown, target: FanqieTarget, category: string, rankVersion: string, limit: number, sourceUpdatedAt: string | null): FanqieWindow {
  assertBusinessSuccess(value, `官网${CHANNEL_LABELS[target.channel]}${BOARD_LABELS[target.board]}分类 ${target.categoryId}`);
  const { data } = z.object({ code: z.literal(0), data: z.object({
    book_list: z.array(rowSchema).max(100), total_num: totalSchema, rankVersion: z.string().regex(/^\d{1,30}$/),
  }) }).parse(value);
  if (data.rankVersion !== rankVersion) throw new Error('官网榜单版本与本批次不一致');
  if (data.book_list.length !== Math.min(limit, data.total_num)) throw new Error('官网榜单未完整返回所选排名范围');
  const rows = data.book_list.map((row, index) => {
    if (row.currentPos !== index + 1 || String(row.curent_category_id) !== target.categoryId) throw new Error('官网榜单分类或排名与请求不匹配');
    return { bookId: row.bookId, rank: row.currentPos, readers: sourceCount(row.read_count),
      wordCount: sourceCount(row.wordNumber), status: serialStatus(row.creationStatus), coverUrl: coverUrl(row.thumbUrl || row.thumbUri) };
  });
  if (new Set(rows.map(row => row.bookId)).size !== rows.length) throw new Error('官网榜单作品身份重复');
  return { rows, category, total: data.total_num, sourceUpdatedAt };
}

/** Validate the official first-window category and its contiguous rank positions. */
export function parseFanqieRanking(html: string, target: FanqieTarget): FanqieWindow {
  const { rank } = rankStateSchema.parse(readInitialState(html));
  const category = rank.rankCategoryTypeList[target.channel].find(item => item.id === target.categoryId);
  if (!category) throw new Error('官网分类与请求频道不匹配');
  const rows = rank.book_list.map((row, index) => {
    if (row.currentPos !== index + 1 || String(row.curent_category_id) !== target.categoryId) throw new Error('官网榜单分类或排名与请求不匹配');
    return { bookId: row.bookId, rank: row.currentPos, readers: sourceCount(row.read_count) };
  });
  if (new Set(rows.map(row => row.bookId)).size !== rows.length || rows.length > rank.total_num) throw new Error('官网榜单作品身份或总数异常');
  const updated = html.match(/统计时间截止至(?:<!--[\s\S]*?-->)*([^<]{1,80})</u)?.[1]?.trim() ?? null;
  return { rows, category: category.name, total: rank.total_num, sourceUpdatedAt: updated ? `统计时间截止至${updated}` : null };
}

export interface FanqieDetail { title: string; author: string | null; description: string; tags: string[]; wordCount: number | null; status: string | null; coverUrl: string | null; }
export interface FanqieUnavailableDetail { metadataStatus: 'unavailable'; metadataNote: string; }

function serialStatus(value: string | number | null | undefined): string | null {
  return String(value) === '1' ? '连载中' : String(value) === '2' ? '已完结' : null;
}

function coverUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://fanqienovel.com');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch (_error) { return null; }
}

/** Uses the official plaintext metadata API and checks the requested book before reusing any fields. */
export function parseFanqieDetailApi(value: unknown, expectedId: string): FanqieDetail {
  assertBusinessSuccess(value, `官网书籍资料 ${expectedId}`);
  const { data } = z.object({ code: z.literal(0), data: detailStateSchema.shape.page.omit({ hasFetch: true }) }).parse(value);
  return parseFanqieDetailFields(data, expectedId);
}

/** Use only the requested book's detail object for readable metadata, never recommendation objects. */
export function parseFanqieDetail(html: string, expectedId: string): FanqieDetail {
  const { page } = detailStateSchema.parse(readInitialState(html));
  return parseFanqieDetailFields(page, expectedId);
}

function parseFanqieDetailFields(page: Omit<z.infer<typeof detailStateSchema>['page'], 'hasFetch'>, expectedId: string): FanqieDetail {
  if (page.bookId !== expectedId) throw new Error('官网详情作品 ID 与请求不匹配');
  if (/[\uE000-\uF8FF]/u.test(page.bookName + page.author)) throw new Error('官网详情名称仍为字体编码，未猜测或替换文字');
  const tags = page.categoryV2
    ? z.array(z.object({ Name: z.string().max(100) })).max(100).parse(JSON.parse(page.categoryV2)).map(item => item.Name).filter(Boolean)
    : [];
  return {
    title: page.bookName, author: page.author || null,
    description: /[\uE000-\uF8FF]/u.test(page.abstract) ? '' : page.abstract,
    tags: [...new Set(tags)], wordCount: sourceCount(page.wordNumber),
    status: serialStatus(page.creationStatus), coverUrl: coverUrl(page.thumbUrl || page.thumbUri),
  };
}

/** Build one ranking observation, keeping rank readership separate from freshly read detail metadata. */
export function fanqieWork(row: FanqieRankRow, window: FanqieWindow, target: FanqieTarget, detail: FanqieDetail | FanqieUnavailableDetail, observedAt: string): Work {
  const verified = 'title' in detail ? detail : null;
  return {
    id: `fanqie:${row.bookId}`, sourceId: row.bookId, platform: 'fanqie', kind: 'novel', title: verified?.title ?? null,
    author: verified?.author ?? null, description: verified?.description ?? '', coverUrl: row.coverUrl ?? verified?.coverUrl ?? null,
    sourceUrl: `https://fanqienovel.com/page/${row.bookId}`,
    tags: [...new Set([window.category, ...(verified?.tags ?? [])])], category: window.category,
    episodeCount: null, wordCount: row.wordCount ?? verified?.wordCount ?? null, serialStatus: row.status ?? verified?.status ?? null, publishedAt: null,
    metrics: [{ key: 'currentReaders', label: '在读人数', value: row.readers }],
    rank: row.rank, rankChange: null,
    board: `${CHANNEL_LABELS[target.channel]} · ${BOARD_LABELS[target.board]} · ${window.category}`,
    origin: 'live', observedAt, sourceUpdatedAt: window.sourceUpdatedAt,
    metadataStatus: verified ? 'verified' : 'unavailable',
    ...('metadataNote' in detail ? { metadataNote: detail.metadataNote } : {}),
  };
}
