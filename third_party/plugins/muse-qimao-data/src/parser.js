/** Static HTML metadata parsing; page JavaScript and chapter bodies are never evaluated or returned. */
import { parse } from 'parse5';

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
    wordCount: parseMetric(null, '字', options.fetchedAt), updatedAt: null, metrics, currentReaders: null, goldenPick: null,
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
  const expectedPath = `/paihang/${options.channel}/${options.board}/${options.period}/`;
  if (channel !== CHANNELS[options.channel] || content(selectedBoard) !== BOARDS[options.board]
    || attr(selectedLink, 'href') !== expectedPath) throw new QimaoError('selection_mismatch', 'The displayed Qimao channel or ranking differs from the request');
  const periods = byClass(doc, 'date-type-tabs');
  if (options.board === 'hot' && content(byClass(periods, 'tab', 'active')) !== PERIODS[options.period]) throw new QimaoError('selection_mismatch', 'The displayed Qimao ranking period differs from the request');
  const cards = all(root, node => has(node, 'rank-list-item'));
  if (!cards.length) throw new QimaoError('page_structure_changed', 'The selected Qimao ranking contains no verified metadata cards');
  const items = cards.map((card, index) => {
    const title = byClass(card, 's-book-title'), id = anchorId(title);
    const rank = Number(content(byClass(card, 'rank-number')));
    if (rank !== index + 1) throw new QimaoError('rank_sequence_mismatch', 'The initial ranking window has a missing or repeated rank');
    const item = base(id, content(title), options), info = byClass(card, 's-book-info');
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

/**
 * Parse a verified page of the public recent, short, ongoing book-library filter.
 * @param html Public filtered-library HTML.
 * @param options Requested page number and fetch metadata.
 * @returns Verified cards and the actual selected page, never a global rank.
 */
export function parseLibrary(html, options) {
  const doc = document(html), title = content(first(doc, node => node.nodeName === 'title'));
  if (!['3天内更新', '30万以下', '连载中'].every(mark => title.includes(mark))) throw new QimaoError('selection_mismatch', 'The public library filter differs from recent, short, ongoing books');
  const pager = byClass(doc, 'qm-page');
  const active = Number(content(byClass(pager, 'page-btn', 'num', 'active')));
  if (active !== options.page) throw new QimaoError('page_mismatch', 'The Qimao library returned a different page number');
  const sort = all(doc, node => has(node, 'tab-inner', 'active')).map(content).filter(value => ['按点击量', '按总字数', '最近更新', '按收藏数'].includes(value));
  if (sort.length !== 1 || sort[0] !== '按点击量') throw new QimaoError('selection_mismatch', 'The public library is not sorted by clicks');
  const cards = all(doc, node => node.nodeName === 'li' && has(node, 'qm-cover-text-item'));
  if (!cards.length) throw new QimaoError('page_structure_changed', 'The Qimao library contains no verified metadata cards');
  const items = cards.map((card, index) => {
    const title = first(byClass(card, 's-tit'), node => node.nodeName === 'a');
    const item = base(anchorId(title), content(title), options);
    item.author = content(byClass(card, 's-author'));
    item.tags = [content(byClass(card, 's-category'))].filter(Boolean);
    item.description = content(byClass(card, 's-desc'));
    item.status = content(byClass(card, 's-status')) || null;
    item.wordCount = parseMetric(content(byClass(card, 's-words-num')), '字', options.fetchedAt);
    item.updatedAt = content(byClass(card, 's-update-time')).match(/\d{4}-\d{2}-\d{2}/u)?.[0] ?? null;
    return finish(item, { source: 'library', filter: 'recent_short_ongoing', sort: 'click', page: options.page, positionOnPage: index + 1 });
  });
  if (new Set(items.map(item => item.bookId)).size !== items.length) throw new QimaoError('duplicate_book_identity', 'The public library repeats a book ID within one page');
  const numbers = all(pager, node => has(node, 'page-btn', 'num')).map(content).filter(value => /^\d+$/u.test(value)).map(Number);
  return { items, page: active, maxPage: Math.max(active, ...numbers), paginationVerified: true };
}

/**
 * Read only the requested book's primary metadata; recommendations and chapter bodies cannot supply fields.
 * @param html Public book detail HTML.
 * @param options Requested book ID and fetch metadata.
 * @returns Primary book metadata after checking its visible book identity.
 */
export function parseDetail(html, options) {
  const id = bookId(options.bookId), doc = document(html), root = byClass(doc, 'book-information');
  if (!root) throw new QimaoError('page_structure_changed', 'The Qimao book information panel is missing');
  const chapter = first(byClass(root, 'update-chapter-title'), node => node.nodeName === 'a');
  let chapterUrl;
  try { chapterUrl = new URL(attr(chapter, 'href'), ORIGIN); }
  catch (_error) { throw new QimaoError('book_identity_unverified', 'The primary book panel has no verifiable book identity'); }
  const actual = /^\/shuku\/(\d{1,24})-\d+\/$/u.exec(chapterUrl.pathname)?.[1];
  if (chapterUrl.origin !== ORIGIN || actual !== id) throw new QimaoError('book_id_mismatch', 'The returned Qimao book does not match the requested ID');
  const item = base(id, content(byClass(byClass(root, 'title'), 'txt')), options);
  const author = byClass(doc, 'author-information');
  item.author = content(first(byClass(author, 'author-name') ?? author, node => node.nodeName === 'a' && attr(node, 'href').includes('/zuozhe/')));
  item.tags = categories(byClass(root, 'tags-wrap'));
  item.status = content(byClass(root, 'tags-wrap')).match(/连载中|已完结/u)?.[0] ?? null;
  item.updatedAt = content(byClass(root, 'update-time')) || null;
  item.description = content(byClass(byClass(doc, 'book-introduction'), 'intro'));
  const panelText = content(root);
  item.wordCount = metricFromText(panelText, '字', options.fetchedAt);
  for (const [field, label] of Object.entries(METRIC_LABELS)) item.metrics[field] = metricFromText(panelText, label, options.fetchedAt);
  return finish(item, { source: 'detail', bookId: id });
}
