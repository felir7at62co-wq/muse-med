/** Parse only JSON data embedded in public Hongguo pages; never execute page scripts. */
export const ORIGIN = 'https://hongguoduanju.com';
export const BOARDS = Object.freeze(['hot-drama', 'hot-real-drama', 'hot-ai-drama', 'hot-comic-drama', 'new-drama', 'followed-drama', 'must-watch-drama']);
/** The official keyword endpoint's first window; later pages are not enumerated by this plugin. */
export const SEARCH_WINDOW_LIMIT = 10;

/** Public search did not provide a complete, usable response; this is never an empty-result assertion. */
export class SearchUnavailableError extends Error {
  constructor(reason) {
    super(`HONGGUO_SEARCH_UNAVAILABLE: ${reason}`);
    this.name = 'SearchUnavailableError';
    this.code = 'HONGGUO_SEARCH_UNAVAILABLE';
  }
}

export class IncompletePageError extends Error {
  constructor() { super('Public page ended before its streamed data completed'); this.name = 'IncompletePageError'; }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.replace(/\\u002[fF]/g, '/') : '';
const strings = value => Array.isArray(value) ? value.filter(x => typeof x === 'string').map(text) : [];

/** Decode an HTML attribute without interpreting markup or JavaScript. */
export function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
    }
    return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[code.toLowerCase()] ?? whole;
  });
}

/** Read the first balanced JSON object following a known assignment. */
function assignmentObject(html, name) {
  const match = new RegExp(`(?:window\\.)?${name}\\s*=\\s*`).exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (html[start] !== '{') throw new Error(`${name} must contain JSON, not executable code`);
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error(`Truncated ${name} JSON`);
}

/** Extract a route's initial JSON plus streamed loader JSON attributes. */
export function routeData(html, route, { allowPending = false } = {}) {
  const root = assignmentObject(html, '_ROUTER_DATA');
  const initial = root?.loaderData?.[route];
  const result = record(initial) ? { ...initial } : {};
  let found = record(initial);
  const pending = new Set();
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of match[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
    if (attrs['data-fn-name'] !== 'mergeLoaderData') continue;
    const args = JSON.parse(attrs['data-fn-args'] ?? 'null');
    if (!Array.isArray(args) || args[0] !== route) continue;
    if (!Array.isArray(args[1])) throw new Error('Invalid streamed loader entries');
    found = true;
    for (const entry of args[1]) {
      if (!record(entry) || typeof entry.key !== 'string' || !Array.isArray(entry.routerDataFnArgs)
        || typeof entry.routerDataFnArgs[0] !== 'string') throw new Error('Invalid streamed loader JSON');
      if (entry.routerDataFnName === 's') { pending.add(entry.key); continue; }
      if (entry.routerDataFnName !== 'p') throw new Error('Unsupported streamed loader encoding');
      if (entry.routerDataFnArgs[1] != null) throw new Error('Public page loader reported an error');
      pending.delete(entry.key);
      // Fixed own-property definition also makes __proto__ inert.
      Object.defineProperty(result, entry.key, { value: JSON.parse(entry.routerDataFnArgs[0]), enumerable: true, configurable: true });
    }
  }
  if (pending.size && !allowPending) throw new IncompletePageError();
  if (!found) throw new Error(`Public page data missing for ${route}; page changed or access is restricted`);
  return result;
}

/** Preserve count text and distinguish absent/unsupported data from zero. */
export function parseCount(raw, label = '收藏') {
  const original = typeof raw === 'string' ? raw : null;
  const normalized = original?.replace(/\s/g, '').replaceAll(',', '').replaceAll('，', '').replace(new RegExp(`${label}$`), '') ?? '';
  const match = /^(\d+(?:\.\d+)?)(万|亿)?$/.exec(normalized);
  if (!match) return { raw: original, value: null, approximate: false, precisionStep: null };
  const multiplier = match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1;
  if (!match[2] && !/^\d+$/.test(match[1])) return { raw: original, value: null, approximate: false, precisionStep: null };
  const value = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(Math.round(value)) || value < 0) return { raw: original, value: null, approximate: false, precisionStep: null };
  const decimals = (match[1].split('.')[1] ?? '').length;
  return { raw: original, value: Math.round(value), approximate: !!match[2], precisionStep: multiplier / (10 ** decimals) };
}

function id(value) {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error('Invalid or missing string series ID');
  return value;
}
function publicImage(value) {
  try { const url = new URL(text(value)); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
function watchPage(value, seriesId) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(text(value), ORIGIN);
    return url.origin === ORIGIN && new RegExp(`^/player/${seriesId}(?:/\\d+)?$`).test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function baseItem(value) {
  const seriesId = id(value.seriesId ?? value.series_id);
  const title = text(value.title ?? value.series_name);
  if (!title.trim()) throw new Error(`Missing title for series ${seriesId}`);
  return { seriesId, title, url: `${ORIGIN}/detail?series_id=${seriesId}`, urlKind: 'official_detail_page', watchPageUrl: watchPage(value.playHref, seriesId), watchPageKind: 'official_web_player_page_not_video_file', coverUrl: publicImage(value.cover ?? value.series_cover),
    description: text(value.description ?? value.series_intro), tags: strings(value.tags) };
}
function updateDate(data, html) {
  if (typeof data.updatedText === 'string') return data.updatedText;
  const match = html.match(/(\d{1,2}月\d{1,2}日已更新[^<"]*)/);
  return match ? decodeEntities(match[1]) : null;
}

/** A displayed 0–10 rating such as 9.4分 or 评分9.4; anything else is unknown, never zero. */
export function parseRating(raw) {
  const match = typeof raw === 'string' ? /^(?:评分)?(\d{1,2}(?:\.\d{1,2})?)分?$/.exec(raw.replace(/\s/g, '')) : null;
  const value = match ? Number(match[1]) : null;
  return value !== null && value <= 10 ? value : null;
}

/** Preserve the three displayed counts and identify unknown source fields on each observation. */
function rankingMetrics(collection, likes, heat) {
  const metrics = { collection, likes, heat };
  const missingMetrics = Object.entries(metrics).filter(([, count]) => count.value === null)
    .map(([field, count]) => ({ field, reason: count.raw === null ? 'not_displayed' : 'unparseable' }));
  return { ...metrics, missingMetrics };
}

/** Keep the ranking's displayed sort value separate from current interaction counts. */
function rankingPrimary(raw, board) {
  const suffix = board === 'must-watch-drama' ? '最高热度' : board === 'followed-drama' ? '收藏' : '热度';
  const label = suffix === '热度' ? '榜单热度' : suffix === '收藏' ? '榜单收藏' : suffix;
  return { ...parseCount(raw, suffix), label };
}

/** Parse one ranking page, rejecting wrong-page/cached or changed responses. */
export function parseRanking(html, { board, page, sourceUrl, fetchedAt }) {
  if (!BOARDS.includes(board)) throw new Error('Unknown ranking board');
  let data;
  try { data = routeData(html, `rank_${board}/page`); }
  catch (error) {
    if (!(error instanceof IncompletePageError)) throw error;
    return parseRenderedRanking(html, { board, page, sourceUrl, fetchedAt });
  }
  const content = data.content;
  if (!record(content) || content.isSuccess !== true || !Array.isArray(content.rankList)) throw new Error('Ranking data unavailable');
  const pagination = content.pagination;
  if (!record(pagination) || pagination.pageNum !== page || !Number.isInteger(pagination.totalPages)
    || pagination.totalPages < page || pagination.totalPages > 100) throw new Error('Invalid or mismatched ranking pagination');
  const updated = updateDate(data, html);
  const items = content.rankList.map(row => {
    if (!record(row) || !Number.isInteger(row.rank) || row.rank < 1) throw new Error('Invalid ranking entry');
    const metrics = rankingMetrics(parseCount(row.favoriteText), parseCount(row.likeText, '点赞'), parseCount(row.heatText, '热度'));
    const primary = rankingPrimary(row.primaryMetricText, board);
    return { ...baseItem(row), collection: metrics.collection, likes: metrics.likes, heat: metrics.heat, rankingPrimary: primary, scoreText: text(row.scoreText) || null,
      shares: parseCount(row.shareText, '分享'), rating: parseRating(row.scoreText), ratingCount: parseCount(row.scoreCountText, '人评分'),
      // Ranking cards expose preview video links, not the complete episode count.
      episodeCount: null,
      observation: { board, page, rank: row.rank, sourceUrl, fetchedAt, updateDate: updated, sourceFormat: 'embedded_json', ...metrics, rankingPrimary: primary } };
  });
  if (items.length === 0) throw new Error('Ranking page unexpectedly empty');
  return { items, page, totalPages: pagination.totalPages, updateDate: updated };
}

/** Extract only visible text from one known server-rendered card element. */
function visibleMarkup(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
}
function visibleText(html) {
  return decodeEntities(visibleMarkup(html).replace(/<\/(?:li|p|div|h2|a|span)>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
function attr(tag, name) {
  for (const token of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (token[1].toLowerCase() === name) return decodeEntities(token[2] ?? token[3] ?? token[4] ?? '');
  }
  return null;
}
function sourceWatchLink(html, seriesId) {
  for (const link of visibleMarkup(html).matchAll(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const verified = watchPage(attr(link[0], 'href'), seriesId);
    if (verified) return verified;
  }
  return null;
}

/** Recover visible SSR cards when the site's matching streamed JSON promise is unfinished. */
function parseRenderedRanking(html, { board, page, sourceUrl, fetchedAt }) {
  const rendered = visibleMarkup(html);
  if (!/<article\b/i.test(rendered)) throw new IncompletePageError();
  const data = routeData(html, `rank_${board}/page`, { allowPending: true });
  if (data.pageNum !== page || typeof data.canonicalUrl !== 'string' || new URL(data.canonicalUrl).origin !== ORIGIN
    || new URL(data.canonicalUrl).pathname !== `/rank/${board}`) throw new Error('Rendered ranking metadata mismatch');
  const navigation = [...rendered.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)].find(x => attr(x[1], 'aria-label') === '榜单分页');
  if (!navigation) throw new IncompletePageError();
  let totalPages = page;
  for (const link of navigation[2].matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(link[0], 'href');
    if (!href) continue;
    const url = new URL(href, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== `/rank/${board}`) continue;
    const n = Number(url.searchParams.get('page') ?? '1');
    if (Number.isInteger(n) && n > 0 && n <= 100) totalPages = Math.max(totalPages, n);
  }
  const updated = updateDate(data, html);
  const items = [];
  for (const article of rendered.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const labelled = attr(article[1], 'aria-labelledby');
    const seriesId = /^rank-title-(\d{1,30})$/.exec(labelled ?? '')?.[1];
    if (!seriesId) continue;
    const body = article[2];
    const heading = [...body.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi)].find(x => attr(x[1], 'id') === labelled);
    const rankMatch = body.match(/<span\b[^>]*class="[^"]*pc-badge-number-[^"]*"[^>]*>(\d+)<\/span>/);
    if (!heading || !rankMatch) throw new Error('Rendered ranking title or rank missing');
    const rank = Number(rankMatch[1]);
    const engagement = [...body.matchAll(/<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi)].find(x => attr(x[1], 'aria-label') === '作品互动数据');
    const plain = visibleText(engagement?.[2] ?? '');
    const fields = [...(engagement?.[2] ?? '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(row => visibleText(row[1]));
    const metric = label => fields.find(value => value.includes(label)) ?? null;
    const description = body.match(/<p\b[^>]*class="[^"]*pc-description-[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    const categories = body.match(/<p\b[^>]*class="[^"]*pc-categories-[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    const tags = [...categories.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(x => visibleText(x[1]));
    const imageTag = body.match(/<img\b[^>]*>/)?.[0] ?? '';
    const primaryText = visibleText(body.match(/<p\b[^>]*class="[^"]*pc-metrics-[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '') || null;
    const primary = rankingPrimary(primaryText, board);
    const metrics = rankingMetrics(parseCount(metric('收藏')), parseCount(metric('点赞'), '点赞'),
      parseCount(metric('热度') ?? (board === 'must-watch-drama' || board === 'followed-drama' ? null : primaryText), '热度'));
    const base = baseItem({ seriesId, title: visibleText(heading[2]), cover: attr(imageTag, 'src'), description: visibleText(description), tags });
    base.watchPageUrl = sourceWatchLink(body, seriesId);
    items.push({ ...base, collection: metrics.collection, likes: metrics.likes, heat: metrics.heat, rankingPrimary: primary,
      scoreText: plain.match(/评分\d+(?:\.\d+)?/)?.[0] ?? null, episodeCount: null,
      shares: parseCount(metric('分享'), '分享'), rating: parseRating(plain.match(/评分\d+(?:\.\d+)?/)?.[0] ?? null), ratingCount: parseCount(metric('人评分'), '人评分'),
      observation: { board, page, rank, sourceUrl, fetchedAt, updateDate: updated, sourceFormat: 'rendered_html', ...metrics, rankingPrimary: primary } });
  }
  if (items.length === 0) throw new IncompletePageError();
  if (page < totalPages && items.length < 20) throw new IncompletePageError();
  if (items.some((item, index) => item.observation.rank !== (page - 1) * 20 + index + 1) || items.length > 20) throw new Error('Rendered ranking count or rank sequence changed');
  return { items, page, totalPages, updateDate: updated };
}
