/** Static HTML metadata parsing; page JavaScript and chapter bodies are never evaluated or returned. */
import { parse } from 'parse5';
import { z } from 'zod';

export const ORIGIN = 'https://www.qimao.com';
export const CHANNELS = Object.freeze({ boy: '男生榜', girl: '女生榜' });
export const BOARDS = Object.freeze({ hot: '大热榜', new: '新书榜', over: '完结榜', collect: '收藏榜', update: '更新榜' });
export const PERIODS = Object.freeze({ date: '日榜', month: '月榜' });
export const METRIC_LABELS = Object.freeze({ heat: '热度', cumulativePopularity: '累计人气值', readOccurrences: '次阅读' });

/** A sanitized, actionable public metadata failure. */
export class QimaoError extends Error {
  constructor(code, message) { super(message); this.name = 'QimaoError'; this.code = code; }
}

function nodes(root) {
  if (!root) return [];
  const result = [], pending = [root];
  while (pending.length) {
    const node = pending.pop();
    result.push(node);
    if (!['script', 'style', 'template', 'noscript'].includes(node.nodeName)) pending.push(...[...(node.childNodes ?? [])].reverse());
  }
  return result;
}
const attr = (node, name) => node?.attrs?.find(entry => entry.name === name)?.value ?? '';
const has = (node, ...classes) => classes.every(value => attr(node, 'class').split(/\s+/u).includes(value));
const all = (root, predicate) => nodes(root).filter(predicate);
const first = (root, predicate) => nodes(root).find(predicate);
const byClass = (root, ...classes) => first(root, node => has(node, ...classes));
const content = root => root ? nodes(root).filter(node => node.nodeName === '#text').map(node => node.value).join(' ').replace(/\s+/gu, ' ').trim() : '';

function document(html) {
  if (typeof html !== 'string') throw new TypeError('Qimao HTML must be a string');
  const doc = parse(html);
  const title = content(first(doc, node => node.nodeName === 'title'));
  if (/验证码|安全验证|访问过于频繁|Access Denied|WAF|Forbidden/iu.test(title)) throw new QimaoError('access_blocked', 'The public page requires verification or denied this request');
  return doc;
}

/**
 * Normalize only decimal book IDs and canonical official book metadata URLs.
 * @param value Raw book ID or canonical metadata URL.
 * @returns Validated decimal string, preserving large identifiers.
 */
export function bookId(value) {
  if (typeof value !== 'string') throw new QimaoError('invalid_book_id', 'Use a decimal Qimao book ID');
  if (/^\d{1,24}$/u.test(value)) return value;
  let url;
  try { url = new URL(value); } catch (_error) { throw new QimaoError('invalid_book_id', 'Use a decimal Qimao book ID or canonical official book URL'); }
  const match = /^\/shuku\/(\d{1,24})\/$/u.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !match) throw new QimaoError('invalid_book_id', 'Use a canonical official Qimao book URL');
  return match[1];
}

function anchorId(anchor) {
  const href = attr(anchor, 'href');
  try { return bookId(new URL(href, ORIGIN).href); }
  catch (_error) { throw new QimaoError('invalid_book_identity', 'A public metadata card has no canonical Qimao book identity'); }
}

/**
 * Keep the platform label, displayed precision, missing reason and observation time together.
 * @param raw Displayed count, or null when absent.
 * @param label Platform metric name, without substituting another metric.
 * @param observedAt Time at which this page was fetched.
 * @returns An exact decimal-scaled safe integer or an explicitly unknown count.
 */
export function parseMetric(raw, label, observedAt) {
  const result = { label, raw: raw?.trim() || null, value: null, approximate: false, precisionStep: null, observedAt, missingReason: raw?.trim() ? 'unparseable' : 'not_displayed' };
  if (!result.raw) return result;
  const compact = result.raw.replace(/[\s,，]/gu, '');
  const match = /^(\d+(?:\.\d+)?)(万|亿)?([^\d]+)$/u.exec(compact);
  if (!match || match[3] !== label) return result;
  const [whole, fraction = ''] = match[1].split('.');
  if (whole.length + fraction.length > 32) return result;
  const exponent = match[2] === '亿' ? 8 : match[2] === '万' ? 4 : 0;
  const digits = BigInt(whole + fraction), shift = exponent - fraction.length;
  const divisor = 10n ** BigInt(Math.max(0, -shift));
  if (digits % divisor !== 0n) return result;
  const scaled = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / divisor;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return result;
  return { ...result, value: Number(scaled), approximate: Boolean(match[2]), precisionStep: match[2] ? 10 ** shift : 1, missingReason: null };
}

function metricFromText(text, label, observedAt) {
  const raw = text.match(new RegExp(`[\\d.,，]+\\s*(?:万|亿)?\\+?\\s*${label}`, 'u'))?.[0] ?? (text.includes(label) ? label : null);
  return parseMetric(raw, label, observedAt);
}

function base(id, title, options) {
  if (!title) throw new QimaoError('invalid_book_identity', 'A public metadata card has no title');
  const metrics = Object.fromEntries(Object.entries(METRIC_LABELS).map(([key, label]) => [key, parseMetric(null, label, options.fetchedAt)]));
  return { bookId: id, title, url: `${ORIGIN}/shuku/${id}/`, author: '', tags: [], description: '', status: null,
    coverUrl: null, wordCount: parseMetric(null, '字', options.fetchedAt), updatedAt: null, metrics, currentReaders: null, goldenPick: null,
    sourceUrl: options.sourceUrl, fetchedAt: options.fetchedAt, observations: [], missingMetrics: [] };
}

function finish(item, observation) {
  item.missingMetrics = Object.entries(item.metrics).filter(([, value]) => value.value === null).map(([field, value]) => ({ field, reason: value.missingReason }));
  item.observations = [{ ...observation, sourceUrl: item.sourceUrl, fetchedAt: item.fetchedAt, metrics: structuredClone(item.metrics) }];
  return item;
}

function categories(root) {
  return [...new Set(all(root, node => node.nodeName === 'a' && /^https:\/\/www\.qimao\.com\/shuku\/a-/u.test(attr(node, 'href'))).map(content).filter(Boolean))];
}

/**
 * Parse one selected ranking's initial SSR window; no unverified rank pagination is implied.
 * @param html Public ranking HTML.
 * @param options Requested channel, board, period and fetch metadata.
 * @returns Verified cards with their original ranking observations.
 */
export function parseRanking(html, options) {
  const doc = document(html), root = byClass(doc, 'rank-list');
  if (!root) throw new QimaoError('page_structure_changed', 'The selected Qimao ranking list is missing');
  const channel = content(byClass(byClass(doc, 'qm-switch-tab'), 'item', 'active'));
  const selectedBoard = byClass(doc, 'child-tabs-item', 'active');
  const selectedLink = first(selectedBoard, node => node.nodeName === 'a');
  const expectedPath = `/paihang/${options.channel}/${options.board}/date/`;
  if (channel !== CHANNELS[options.channel] || content(selectedBoard) !== BOARDS[options.board]
    || attr(selectedLink, 'href') !== expectedPath) throw new QimaoError('selection_mismatch', 'The displayed Qimao channel or ranking differs from the request');
  const periods = byClass(doc, 'date-type-tabs');
  const selectedPeriod = byClass(periods, 'tab', 'active');
  if (['hot', 'new', 'over'].includes(options.board) && (content(selectedPeriod) !== PERIODS[options.period]
    || attr(selectedPeriod, 'href') !== `/paihang/${options.channel}/${options.board}/${options.period}/`)) throw new QimaoError('selection_mismatch', 'The displayed Qimao ranking period differs from the request');
  const cards = all(root, node => has(node, 'rank-list-item'));
  if (!cards.length) throw new QimaoError('page_structure_changed', 'The selected Qimao ranking contains no verified metadata cards');
  const items = cards.map((card, index) => {
    const title = byClass(card, 's-book-title'), id = anchorId(title);
    const rank = Number(content(byClass(card, 'rank-number')));
    if (rank !== index + 1) throw new QimaoError('rank_sequence_mismatch', 'The initial ranking window has a missing or repeated rank');
    const item = base(id, content(title), options), info = byClass(card, 's-book-info');
    const image = first(card, node => node.nodeName === 'img');
    const imagePath = attr(image, 'data-src') || attr(image, 'src');
    if (imagePath) {
      try {
        const imageUrl = new URL(imagePath, ORIGIN);
        if (imageUrl.protocol === 'https:' && !imageUrl.username && !imageUrl.password) item.coverUrl = imageUrl.href;
      } catch (_error) { /* An invalid cover leaves the image unknown without changing book identity. */ }
    }
    item.author = content(first(info, node => node.nodeName === 'a' && attr(node, 'href').includes('/zuozhe/')));
    item.tags = categories(info);
    item.status = content(info).match(/连载中|已完结/u)?.[0] ?? null;
    item.wordCount = metricFromText(content(info), '字', options.fetchedAt);
    item.description = content(byClass(card, 's-book-intro'));
    item.updatedAt = content(byClass(card, 's-book-update')).match(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?/u)?.[0] ?? null;
    item.metrics.heat = metricFromText(content(byClass(card, 'other-info')), '热度', options.fetchedAt);
    return finish(item, { source: 'rank', channel: options.channel, board: options.board, period: options.period, page: 1, rank });
  });
  if (new Set(items.map(item => item.bookId)).size !== items.length) throw new QimaoError('duplicate_book_identity', 'The ranking window repeats a book ID');
  return { items, page: 1, paginationVerified: false };
}

const decimal = z.string().regex(/^\d+$/u);
const apiRow = z.object({
  book_id: z.string().regex(/^\d{1,24}$/u), title: z.string().trim().min(1).max(500), book_url: z.string(),
  author: z.string().max(500), category1_name: z.string().max(120), category2_name: z.string().max(120),
  is_over: z.enum(['0', '1']), words_num: z.string().max(100), intro: z.string().max(30_000),
  update_time: z.string().max(100), image_link: z.string().max(2000),
  number: z.string().max(100), unit: z.string().max(10),
});
const apiResponse = z.object({ data: z.object({
  table_data: z.array(apiRow).min(1).max(20),
  page_data: z.object({ count: decimal, page: decimal, page_size: decimal, data_month: z.union([z.literal(''), z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)]) }),
}) });

/**
 * Read official paging metadata and primitive aliases without evaluating the Nuxt state expression.
 * @param html The selected official ranking page.
 * @returns Its bounded count, page size and month, empty for non-monthly collection/update rankings.
 */
export function rankingPageConfig(html) {
  try {
    const assignment = /window\.__NUXT__\s*=\s*\(function\(([^)]*)\)/u.exec(html);
    if (!assignment) throw new Error('Missing official state');
    const end = html.indexOf('</script>', assignment.index);
    if (end < 0) throw new Error('Incomplete official state');
    const source = html.slice(assignment.index, end);
    const args = /\}\(([\s\S]*)\)\);?\s*$/u.exec(source)?.[1];
    if (args === undefined) throw new Error('Missing primitive aliases');
    const values = z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(512).parse(JSON.parse(`[${args}]`));
    const names = assignment[1] ? assignment[1].split(',') : [];
    if (names.length !== values.length || names.some(name => !/^[\w$]+$/u.test(name))) throw new Error('Invalid primitive aliases');
    const aliases = new Map(names.map((name, index) => [name, values[index]]));
    const paging = /pageConfig:\{([^}]*)\}/u.exec(source)?.[1];
    if (!paging) throw new Error('Missing page metadata');
    const read = field => {
      const token = new RegExp(`(?:^|,)${field}:("[^"]*"|[\\w$]+)(?=,|$)`, 'u').exec(paging)?.[1];
      return token?.startsWith('"') ? JSON.parse(token) : aliases.get(token);
    };
    const total = Number(read('count')), pageSize = Number(read('page_size')), month = read('data_month');
    if (!Number.isInteger(total) || total < 1 || total > 100 || pageSize !== 20 || Number(read('page')) !== 1
      || typeof month !== 'string' || month !== '' && !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error('Unsupported page metadata');
    return { total, pageSize, month };
  } catch (_error) {
    throw new QimaoError('invalid_paging_metadata', 'The ranking page has no supported official page count or period');
  }
}

/**
 * Parse one official JSON page, rejecting mismatched paging and noncanonical book identities.
 * Positions follow the website's verified page-offset rendering, not a metric-based local sort.
 * @param body The completed official JSON response.
 * @param options Selected ranking and source metadata.
 * @param expected Page number and paging metadata from the selected HTML list.
 * @returns Verified items and their unchanged page metadata.
 */
export function parseRankingApi(body, options, expected) {
  let data;
  try { ({ data } = apiResponse.parse(JSON.parse(body))); }
  catch (_error) { throw new QimaoError('invalid_ranking_json', 'The official ranking response has invalid metadata fields'); }
  const paging = data.page_data;
  if (Number(paging.page) !== expected.page || Number(paging.page_size) !== expected.pageSize || Number(paging.count) !== expected.total
    || paging.data_month !== expected.month) throw new QimaoError('pagination_mismatch', 'The ranking page, count or period changed during collection');
  const offset = (expected.page - 1) * expected.pageSize;
  if (data.table_data.length !== Math.min(expected.pageSize, expected.total - offset)) throw new QimaoError('pagination_mismatch', 'The ranking page has a missing or extra position');
  const items = data.table_data.map((row, index) => {
    if (bookId(row.book_url) !== row.book_id) throw new QimaoError('invalid_book_identity', 'The ranking book ID differs from its official URL');
    const item = base(row.book_id, row.title, options);
    item.author = row.author;
    item.tags = [...new Set([row.category1_name, row.category2_name].filter(Boolean))];
    item.description = row.intro;
    item.status = row.is_over === '1' ? '已完结' : '连载中';
    item.wordCount = parseMetric(row.words_num, '字', options.fetchedAt);
    item.updatedAt = row.update_time || null;
    if (row.image_link) {
      try {
        const url = new URL(row.image_link);
        if (url.protocol === 'https:' && !url.username && !url.password) item.coverUrl = url.href;
      } catch (_error) { /* Missing cover metadata leaves the verified book identity intact. */ }
    }
    if (['hot', 'new', 'over'].includes(options.board) && row.number) item.metrics.heat = parseMetric(`${row.number}${row.unit}热度`, '热度', options.fetchedAt);
    return finish(item, { source: 'rank', channel: options.channel, board: options.board, period: options.period, page: expected.page, rank: offset + index + 1 });
  });
  if (new Set(items.map(item => item.bookId)).size !== items.length) throw new QimaoError('duplicate_book_identity', 'The ranking JSON page repeats a book ID');
  return { items, page: expected.page, total: expected.total, month: expected.month };
}
