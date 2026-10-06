/** Model input and credential-free projections for official Douyin page data. */
export const dataProperties = {
  url: { type: 'string', description: 'One user-selected official Douyin HTTPS video or share URL' },
  urls: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Several selected official video/share links; mutually exclusive with url' },
  source: { type: 'string', enum: ['auto', 'public', 'creator'], description: 'Public work page (public or auto), or your normally signed-in creator content page (creator)' },
  includeComments: { type: 'boolean', description: 'Include one observed comment page; the total comment count remains separate' },
  commentCursor: { type: 'string', description: 'The previous result cursor for the same video and source' },
  commentLimit: { type: 'integer', minimum: 1, description: 'Maximum comments in this page, within the deployment limit' },
  download: { type: 'boolean', description: 'Also download this video using the existing verified downloader' },
};

const countNames = ['play_count', 'digg_count', 'comment_count', 'share_count', 'collect_count'];
const reasons = new Set(['not-exposed', 'missing', 'invalid']);
const dataCodes = new Set(['HOST_UNAVAILABLE', 'TRANSPORT_TIMEOUT', 'SESSION_NOT_VISIBLE', 'BUSY',
  'INVALID_REQUEST', 'INVALID_URL', 'INVALID_RESULT', 'CANCELLED', 'WORKSPACE_UNAVAILABLE',
  'UI_UNAVAILABLE', 'LEASE_RELEASED', 'DOCUMENT_CHANGED', 'TARGET_MISMATCH',
  'LOGIN_OR_VERIFICATION_REQUIRED', 'PUBLIC_DATA_UNAVAILABLE', 'CREATOR_DATA_UNAVAILABLE',
  'CREATOR_OWNERSHIP_UNVERIFIED', 'COMMENTS_UNAVAILABLE', 'COMMENTS_CURSOR_UNAVAILABLE', 'EXPIRED']);

/** Resolve tool JSON before any browser or media operation. @param {unknown} value Tool JSON. @param {object} settings Resolved deployment limits. @returns {object} Explicit data request. */
export function resolveDataArgs(value, settings) {
  const { maxComments, maxVideos, dataTimeoutMs } = settings;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Douyin data arguments must be an object');
  for (const [key, entry] of Object.entries(value)) {
    const property = dataProperties[key];
    if (!property || (property.type === 'integer' ? !Number.isSafeInteger(entry) : property.type === 'array' ? !Array.isArray(entry) : typeof entry !== property.type)) throw new TypeError(`Invalid Douyin data argument: ${key}`);
  }
  if ((value.url === undefined) === (value.urls === undefined)) throw new TypeError('Choose either url or urls');
  const urls = value.urls ?? [value.url];
  if (!urls.length || urls.length > maxVideos) throw new TypeError(`This deployment accepts one to ${maxVideos} video links per call`);
  for (const link of urls) {
    if (typeof link !== 'string' || !link.trim() || link.length > 8192) throw new TypeError('Provide official HTTPS video/share URLs');
    let url;
    try { url = new URL(link); } catch { throw new TypeError('Provide official HTTPS video/share URLs'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || !['v.douyin.com', 'www.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) throw new TypeError('Provide official HTTPS video/share URLs');
    const modalIds = url.searchParams.getAll('modal_id');
    if (url.hostname === 'v.douyin.com' ? !/^\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)
      : modalIds.length > 1 || !(modalIds.length === 1 && /^\d{10,25}$/u.test(modalIds[0])
        || modalIds.length === 0 && /^\/(?:video|share\/video)\/\d{10,25}\/?$/u.test(url.pathname))) throw new TypeError('Select one specific Douyin work per link');
  }
  const source = value.source ?? 'auto';
  if (!dataProperties.source.enum.includes(source)) throw new TypeError('Choose public, creator or auto data');
  const enabled = value.includeComments ?? false;
  const count = value.commentLimit ?? maxComments;
  if (count < 1 || count > maxComments) throw new TypeError(`This deployment accepts at most ${maxComments} comments per page`);
  if (value.commentCursor !== undefined && (!enabled || urls.length !== 1 || !value.commentCursor || value.commentCursor.length > 1024 || /[\u0000-\u001f]/u.test(value.commentCursor))) throw new TypeError('A comment cursor requires one video and an enabled comment page');
  if (value.commentLimit !== undefined && !enabled) throw new TypeError('A comment limit requires an enabled comment page');
  return { urls: [...urls], single: value.url !== undefined, source, comments: { enabled, count, ...(value.commentCursor === undefined ? {} : { cursor: value.commentCursor }) }, timeoutMs: dataTimeoutMs, download: value.download ?? false };
}

function unavailable(reason) { return { value: null, precision: 'unavailable', reason }; }
function numberOrNull(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function countOf(value) {
  if (value === undefined || value === null) return unavailable('missing');
  if (typeof value !== 'object' || Array.isArray(value)) return unavailable('invalid');
  if (value.precision === 'unavailable') return value.value === null && reasons.has(value.reason) ? unavailable(value.reason) : unavailable('invalid');
  if (!['exact', 'rounded'].includes(value.precision) || numberOrNull(value.value) === null) return unavailable('invalid');
  if (value.precision === 'rounded') {
    if (typeof value.display !== 'string' || !value.display.trim() || value.display.length > 64 || /[\u0000-\u001f]/u.test(value.display)) return unavailable('invalid');
    return { value: value.value, precision: 'rounded', display: value.display };
  }
  return { value: value.value, precision: 'exact' };
}

/** Project bounded page fields; missing counters and public view placeholders remain null. @param {unknown} value Host page result. @param {object} request One resolved video selection. @returns {object} Safe tool result. */
export function projectDataResult(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Douyin data bridge returned invalid fields');
  if (value.status === 'blocked') {
    if (!dataCodes.has(value.code)) throw new Error('Douyin data bridge returned an invalid status');
    return { status: 'blocked', code: value.code };
  }
  if (value.status !== 'ok' || !['public-page', 'creator-page'].includes(value.source)
    || typeof value.targetVideoId !== 'string' || !/^\d{10,25}$/u.test(value.targetVideoId)
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('Douyin data bridge returned invalid page evidence');
  const canonicalTime = value.observedAt.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, milliseconds) => `.${(milliseconds ?? '').padEnd(3, '0')}Z`);
  if (new Date(value.observedAt).toISOString() !== canonicalTime) throw new Error('Douyin data bridge returned invalid observation time');
  if (request.source !== 'auto' && value.source !== `${request.source}-page`) throw new Error('Douyin data bridge returned a different requested source');
  const page = new URL(request.url);
  const pathId = /^\/(?:video|share\/video)\/(\d{10,25})\/?$/u.exec(page.pathname)?.[1];
  const modalIds = page.searchParams.getAll('modal_id');
  if (pathId !== undefined && pathId !== value.targetVideoId || modalIds.length > 1 || modalIds.length === 1 && modalIds[0] !== value.targetVideoId) throw new Error('Douyin data bridge returned a different requested video');
  const rawCounts = value.counts && typeof value.counts === 'object' && !Array.isArray(value.counts) ? value.counts : {};
  const counts = Object.fromEntries(countNames.map(name => [name, countOf(rawCounts[name])]));
  if (value.source === 'public-page' && counts.play_count.value === 0) counts.play_count = unavailable('not-exposed');
  let comments = { status: 'not-requested', items: [], cursor: null, hasMore: null };
  if (request.comments.enabled) {
    const page = value.comments;
    if (!page || typeof page !== 'object' || Array.isArray(page) || !['available', 'blocked'].includes(page.status)) throw new Error('Douyin data bridge did not return the requested comment page');
    if (page.status === 'blocked') {
      if (!['COMMENTS_UNAVAILABLE', 'COMMENTS_CURSOR_UNAVAILABLE'].includes(page.code)) throw new Error('Douyin data bridge returned an invalid comment status');
      comments = { status: 'blocked', items: [], cursor: null, hasMore: null, code: page.code };
    } else {
      if (!Array.isArray(page.items) || page.items.length > request.comments.count || typeof page.hasMore !== 'boolean'
        || page.cursor !== null && (typeof page.cursor !== 'string' || page.cursor.length > 1024 || /[\u0000-\u001f]/u.test(page.cursor))) throw new Error('Douyin data bridge returned an invalid comment page');
      const ids = new Set();
      let textBytes = 0;
      const items = page.items.map(comment => {
        if (!comment || typeof comment !== 'object' || Array.isArray(comment) || typeof comment.id !== 'string' || !/^\d{10,25}$/u.test(comment.id)
          || ids.has(comment.id) || typeof comment.text !== 'string') throw new Error('Douyin data bridge returned invalid comments');
        ids.add(comment.id);
        textBytes += Buffer.byteLength(comment.text, 'utf8');
        if (textBytes > 65536) throw new Error('Douyin data bridge returned excessive comment text');
        return { id: comment.id, text: comment.text, digg_count: numberOrNull(comment.digg_count), create_time: numberOrNull(comment.create_time), reply_comment_total: numberOrNull(comment.reply_comment_total) };
      });
      comments = { status: 'available', items, cursor: page.cursor, hasMore: page.hasMore };
    }
  }
  return { status: comments.status === 'blocked' ? 'partial' : 'ok', source: value.source, targetVideoId: value.targetVideoId, url: `https://www.douyin.com/video/${value.targetVideoId}`, observedAt: value.observedAt, counts, comments };
}
