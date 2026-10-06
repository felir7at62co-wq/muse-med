/** Observe page-data projection, source identity, and bounded comments without credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDataResult, resolveDataArgs } from '../src/data.js';

const url = 'https://www.douyin.com/video/7691637134771391771';
const settings = { maxComments: 20, maxVideos: 20, dataTimeoutMs: 30000 };
const selection = args => {
  const request = resolveDataArgs(args, settings);
  return { url: request.urls[0], source: request.source, comments: request.comments, timeoutMs: request.timeoutMs };
};
const request = selection({ url });
const exact = value => ({ value, precision: 'exact' });
const page = () => ({ status: 'ok', source: 'public-page', targetVideoId: '7691637134771391771', observedAt: '2026-10-06T12:00:00.000Z',
  counts: { play_count: exact(0), digg_count: exact(0), comment_count: exact(14), share_count: { value: 12000, precision: 'rounded', display: '1.2万' }, collect_count: { value: null, precision: 'unavailable', reason: 'not-exposed' } },
  comments: { status: 'not-requested', items: [], cursor: null, hasMore: null } });

test('data input resolves page options and refuses credentials before acquisition', () => {
  assert.deepEqual(resolveDataArgs({ url }, settings), { urls: [url], single: true, source: 'auto', comments: { enabled: false, count: 20 }, timeoutMs: 30000, download: false });
  assert.deepEqual(resolveDataArgs({ url, source: 'creator', includeComments: true, commentCursor: '20', commentLimit: 5, download: true }, settings),
    { urls: [url], single: true, source: 'creator', comments: { enabled: true, count: 5, cursor: '20' }, timeoutMs: 30000, download: true });
  for (const value of [null, [], 'url', {}, { url, cookie: 'never-access' }, { url, includeComments: 1 }, { url, commentLimit: 1.5 }, { url: '' }, { url: 'bad' },
    { url: 'http://www.douyin.com/video/7691637134771391771' }, { url: 'https://user@www.douyin.com/video/7691637134771391771' }, { url: 'https://www.douyin.com:8443/video/7691637134771391771' },
    { url: 'https://other.invalid/video/7691637134771391771' }, { url: 'https://www.douyin.com/' }, { url: 'https://v.douyin.com/' }, { url: 'https://www.douyin.com/?modal_id=1' },
    { url: 'https://www.douyin.com/?modal_id=7691637134771391771&modal_id=7691637134771391771' }, { url: 'x'.repeat(8193) }, { url, source: 'oauth' }, { url, commentLimit: 0, includeComments: true }, { url, commentLimit: 21, includeComments: true },
    { url, commentLimit: 1 }, { url, commentCursor: '20' }, { url, includeComments: true, commentCursor: '' }, { url, includeComments: true, commentCursor: '\n' }, { url, includeComments: true, commentCursor: 'x'.repeat(1025) }]) {
    assert.throws(() => resolveDataArgs(value, settings));
  }
});

test('public view placeholders remain unavailable while other zero and rounded counts remain distinct', () => {
  const input = { ...page(), cookies: 'private', authorization: 'private', signedUrl: 'https://private.invalid/' };
  const output = projectDataResult(input, request);
  assert.deepEqual(output.counts.play_count, { value: null, precision: 'unavailable', reason: 'not-exposed' });
  assert.deepEqual(output.counts.digg_count, exact(0));
  assert.deepEqual(output.counts.share_count, { value: 12000, precision: 'rounded', display: '1.2万' });
  assert.equal(output.url, url);
  assert.equal(output.comments.status, 'not-requested');
  assert.ok(!JSON.stringify(output).includes('private'));
});

test('creator page counters keep exact views and disclose missing or invalid fields', () => {
  const creator = selection({ url, source: 'creator' });
  const input = { ...page(), source: 'creator-page', counts: { play_count: exact(42), digg_count: undefined, comment_count: null, share_count: -1, collect_count: { value: null, precision: 'unavailable', reason: 'missing', raw: 'private' } } };
  const output = projectDataResult(input, creator);
  assert.deepEqual(output.counts.play_count, exact(42));
  assert.deepEqual(output.counts.digg_count, { value: null, precision: 'unavailable', reason: 'missing' });
  assert.deepEqual(output.counts.comment_count, { value: null, precision: 'unavailable', reason: 'missing' });
  assert.deepEqual(output.counts.share_count, { value: null, precision: 'unavailable', reason: 'invalid' });
  assert.deepEqual(output.counts.collect_count, { value: null, precision: 'unavailable', reason: 'missing' });
  for (const value of [[], true, { value: 3, precision: 'unavailable', reason: 'missing' }, { value: null, precision: 'unavailable', reason: 'private' },
    { value: -1, precision: 'exact' }, { value: 1.5, precision: 'exact' }, { value: 1, precision: 'guessed' }, { value: 10, precision: 'rounded' },
    { value: 10, precision: 'rounded', display: '' }, { value: 10, precision: 'rounded', display: 'x'.repeat(65) }, { value: 10, precision: 'rounded', display: '\n' }]) {
    assert.deepEqual(projectDataResult({ ...input, counts: { play_count: value } }, creator).counts.play_count, { value: null, precision: 'unavailable', reason: 'invalid' });
  }
  for (const counts of [undefined, null, [], 'private']) assert.equal(projectDataResult({ ...input, counts }, creator).counts.play_count.value, null);
});

test('the exact requested work and source must match the observed official page', () => {
  for (const value of [null, [], 'private', { status: 'downloaded' }, { ...page(), source: 'oauth' }, { ...page(), targetVideoId: '1' }, { ...page(), targetVideoId: 7691637134771391771 },
    { ...page(), observedAt: undefined }, { ...page(), observedAt: '2026-99-06T12:00:00Z' }, { ...page(), observedAt: '2026-02-31T12:00:00Z' }, { ...page(), observedAt: 'now' }, { ...page(), targetVideoId: '7691637134771391772' }]) assert.throws(() => projectDataResult(value, request));
  assert.throws(() => projectDataResult(page(), selection({ url, source: 'creator' })), /source/);
  const modal = 'https://www.douyin.com/discover?modal_id=7691637134771391771';
  assert.equal(projectDataResult(page(), selection({ url: modal, source: 'public' })).targetVideoId, page().targetVideoId);
  assert.throws(() => projectDataResult(page(), selection({ url: 'https://www.douyin.com/discover?modal_id=7691637134771391772' })), /video/);
  assert.throws(() => projectDataResult(page(), { ...request, url: 'https://www.douyin.com/discover?modal_id=7691637134771391771&modal_id=7691637134771391771' }), /video/);
  assert.equal(projectDataResult(page(), selection({ url: 'https://v.douyin.com/fixture/' })).url, url);
});

test('a bounded comment page preserves totals separately and discards account identifiers', () => {
  const input = { ...page(), comments: { status: 'available', items: [{ id: '7700000000000000001', text: '公开评论', digg_count: 0, create_time: 1791288000, reply_comment_total: null,
    user: { sec_uid: 'private' }, avatar: 'https://private.invalid/', token: 'private' }, { id: '7700000000000000002', text: '', digg_count: -1, create_time: undefined, reply_comment_total: 3 }], cursor: '20', hasMore: true } };
  const output = projectDataResult(input, selection({ url, includeComments: true, commentLimit: 2 }));
  assert.equal(output.counts.comment_count.value, 14);
  assert.equal(output.comments.items.length, 2);
  assert.deepEqual(output.comments.items[0], { id: '7700000000000000001', text: '公开评论', digg_count: 0, create_time: 1791288000, reply_comment_total: null });
  assert.deepEqual(output.comments.items[1], { id: '7700000000000000002', text: '', digg_count: null, create_time: null, reply_comment_total: 3 });
  assert.equal(output.comments.cursor, '20');
  assert.equal(output.comments.hasMore, true);
  assert.ok(!JSON.stringify(output).includes('private'));
  assert.deepEqual(projectDataResult({ ...input, comments: { status: 'available', items: [], cursor: null, hasMore: false } }, selection({ url, includeComments: true })).comments,
    { status: 'available', items: [], cursor: null, hasMore: false });
});

test('blocked comments remain distinct from unavailable video data', () => {
  assert.deepEqual(projectDataResult({ status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED', message: 'private' }, request), { status: 'blocked', code: 'LOGIN_OR_VERIFICATION_REQUIRED' });
  assert.deepEqual(projectDataResult({ ...page(), comments: { status: 'blocked', code: 'COMMENTS_UNAVAILABLE', raw: 'private' } }, selection({ url, includeComments: true })).comments,
    { status: 'blocked', code: 'COMMENTS_UNAVAILABLE', items: [], cursor: null, hasMore: null });
  for (const code of [undefined, '', 'private URL', 'x'.repeat(65)]) assert.throws(() => projectDataResult({ status: 'blocked', code }, request));
  assert.throws(() => projectDataResult({ ...page(), comments: { status: 'blocked', code: 'private URL' } }, selection({ url, includeComments: true })));
});

test('comment pages refuse ambiguous identities and incomplete or excessive results', () => {
  const args = selection({ url, includeComments: true, commentLimit: 2 });
  const comment = { id: '7700000000000000001', text: 'comment' };
  const base = { status: 'available', items: [comment], cursor: null, hasMore: false };
  for (const comments of [undefined, [], { status: 'not-requested' }, { ...base, items: undefined }, { ...base, items: [comment, comment, comment] }, { ...base, hasMore: null },
    { ...base, cursor: undefined }, { ...base, cursor: 1 }, { ...base, cursor: 'x'.repeat(1025) }, { ...base, cursor: '\n' }, { ...base, items: [null] }, { ...base, items: [[]] },
    { ...base, items: [{ id: 7700000000000000001, text: 'comment' }] }, { ...base, items: [{ id: '1', text: 'comment' }] }, { ...base, items: [comment, comment] },
    { ...base, items: [{ ...comment, text: undefined }] }, { ...base, items: [{ ...comment, text: '汉'.repeat(21846) }] }]) assert.throws(() => projectDataResult({ ...page(), comments }, args));
});

test('batches share the deployment limit and keep a comment cursor scoped to one work', () => {
  assert.deepEqual(resolveDataArgs({ urls: [url, url], includeComments: true }, settings), { urls: [url, url], single: false, source: 'auto', comments: { enabled: true, count: 20 }, timeoutMs: 30000, download: false });
  for (const value of [{ url, urls: [url] }, { urls: [] }, { urls: [null] }, { urls: 'private' }, { urls: Array(21).fill(url) }, { urls: [url, url], includeComments: true, commentCursor: '20' }]) assert.throws(() => resolveDataArgs(value, settings));
});

test('verified positive public displays retain their count and precision', () => {
  for (const count of [exact(42), { value: 12000, precision: 'rounded', display: '1.2万' }]) {
    assert.deepEqual(projectDataResult({ ...page(), counts: { play_count: count } }, request).counts.play_count, count);
  }
});
