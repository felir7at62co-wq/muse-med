import test from 'node:test';
import assert from 'node:assert/strict';
import { HongguoClient } from '../src/client.js';
import { ORIGIN, parseSearchResponse, SearchUnavailableError } from '../src/parser.js';

const options = { query: '二嫁', sourceUrl: `${ORIGIN}/api/search/result?query=%E4%BA%8C%E5%AB%81`, fetchedAt: '2026-11-10T06:00:00Z' };
const drama = (seriesId = '7692391320748297241') => ({ doc_type: 23, name: '合成剧名',
  video_data: { series_id: seriesId, series_title: '合成二嫁短剧', episode_cnt: 55, episode_right_text: '全55集',
    favorite_text: '16.7万收藏', like_text: '29.1万点赞', hot_score_data: { score: 44135136, text: '4413万热度' },
    category_list: [{ category_id: '527', name: '恋爱' }] },
  user_info: { private_placeholder: 'must not return' }, video_list: [{ internal_placeholder: 'must not return' }] });
const data = () => ({ searchList: [drama()], totalCount: '1', pageNum: 1, totalPages: 1, hasMore: false });
const response = (value, extra = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value),
  { headers: { 'content-type': 'application/json; charset=utf-8' }, ...extra });
const client = (fetch, config = {}) => new HongguoClient({ requestIntervalMs: 0, ...config }, { fetch });
const unavailable = error => error instanceof SearchUnavailableError && error.code === 'HONGGUO_SEARCH_UNAVAILABLE';

test('official public JSON retains string identity and distinct displayed metrics without internal fields', () => {
  const result = parseSearchResponse(data(), options), item = result.items[0];
  assert.equal(result.sourceReportedTotal, '1');
  assert.equal(item.seriesId, '7692391320748297241');
  assert.equal(item.title, '合成二嫁短剧');
  assert.equal(item.episodeCount, 55);
  assert.equal(item.collection.value, 167000);
  assert.equal(item.likes.value, 291000);
  assert.equal(item.heat.value, 44130000);
  assert.equal(item.heat.approximate, true);
  assert.deepEqual(item.tags, ['恋爱']);
  assert.equal(item.watchPageUrl, null);
  assert.equal(item.url, `${ORIGIN}/detail?series_id=7692391320748297241`);
  assert.equal(JSON.stringify(result).includes('must not return'), false);
});

test('missing source metrics remain unknown and explicit zero remains known', () => {
  const value = data();
  value.searchList[0].video_data = { series_id: '123', series_title: '无指标样例', like_text: '0点赞', hot_score_data: { score: 999 } };
  const item = parseSearchResponse(value, options).items[0];
  assert.equal(item.collection.value, null);
  assert.equal(item.likes.value, 0);
  assert.equal(item.heat.value, null);
  assert.equal(item.episodeCount, null);
});

test('genuine zero requires explicit coherent first-page totals, not merely an empty list', () => {
  for (const totalPages of [0, 1]) assert.deepEqual(parseSearchResponse({ searchList: [], totalCount: '0',
    pageNum: 1, totalPages, hasMore: false }, options), { items: [], sourceReportedTotal: '0' });
  assert.throws(() => parseSearchResponse({ searchList: [] }, options), unavailable);
  assert.throws(() => parseSearchResponse({ ...data(), searchList: [] }, options), unavailable);
});

for (const field of ['searchList', 'totalCount', 'pageNum', 'totalPages', 'hasMore']) {
  test(`missing ${field} is unavailable rather than a successful empty search`, () => {
    const value = data(); delete value[field];
    assert.throws(() => parseSearchResponse(value, options), unavailable);
  });
}

for (const patch of [
  { status_code: 403 }, { code: 1 }, { Code: 'BLOCKED' }, { BaseResp: { StatusCode: 110001 } },
  { success: false }, { isSuccess: false }, { query: '另一个关键词' }, { pageNum: 2 },
  { totalCount: '9007199254740993' }, { totalCount: 'unknown' }, { totalCount: [1] }, { totalPages: -1 },
  { totalCount: '0' }, { totalPages: 2, hasMore: false }, { totalPages: 1, hasMore: true },
  { totalCount: '20', totalPages: 1, hasMore: false },
]) {
  test(`rejects incoherent or restricted response ${JSON.stringify(patch)}`, () => {
    assert.throws(() => parseSearchResponse({ ...data(), ...patch }, options), unavailable);
  });
}

test('a larger upstream window fails instead of silently truncating unknown coverage', () => {
  assert.throws(() => parseSearchResponse({ ...data(), searchList: Array.from({ length: 11 }, (_, index) => drama(String(index))),
    totalCount: '11', totalPages: 1 }, options), unavailable);
});

for (const [name, row] of [['null row', null], ['missing video', { doc_type: 23 }],
  ['missing ID', { doc_type: 23, video_data: {} }], ['numeric ID', drama(7692391320748297241)],
  ['empty title', { doc_type: 23, video_data: { series_id: '123', series_title: '' } }]]) {
  test(`invalid drama ${name} cannot create a partial passing window`, () => {
    assert.throws(() => parseSearchResponse({ ...data(), searchList: [row] }, options), unavailable);
  });
}

test('unsupported-only rows do not establish zero matches and mixed rows expose only dramas', () => {
  const other = { doc_type: 1, user_info: { name: 'non-drama' } };
  assert.throws(() => parseSearchResponse({ ...data(), searchList: [other] }, options), unavailable);
  const result = parseSearchResponse({ ...data(), searchList: [other, drama()], totalCount: '2' }, options);
  assert.equal(result.items.length, 1);
  assert.equal(result.sourceReportedTotal, '2');
});

test('client uses only the observed unsigned public endpoint and slices the returned first window locally', async () => {
  const calls = [], c = client(async (url, init) => { calls.push({ url, init }); return response({ ...data(),
    searchList: [drama('123'), drama('456')], totalCount: '2' }); });
  try {
    const result = await c.search({ query: ' 二嫁 & 家庭 ', offset: 1, limit: 1 });
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, '/api/search/result');
    assert.deepEqual([...url.searchParams.keys()], ['query']);
    assert.equal(url.searchParams.get('query'), '二嫁 & 家庭');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.accept, 'application/json');
    assert.equal(Object.keys(calls[0].init.headers).some(name => /cookie|authorization/iu.test(name)), false);
    assert.equal(result.items[0].seriesId, '456');
    assert.equal(result.availableInWindow, 2);
    assert.equal(result.complete, false);
    assert.equal(result.sourceUrl, url.href);
  } finally { c.dispose(); }
});

test('search cache, refresh and bounded eviction retain normal behavior', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return response(data()); }, { maxCacheEntries: 1 });
  try {
    await c.search({ query: '二嫁' });
    assert.equal((await c.search({ query: '二嫁' })).fromCache, true);
    await c.search({ query: '二嫁', refresh: true });
    await c.search({ query: '家庭' });
    assert.equal((await c.search({ query: '二嫁' })).fromCache, false);
    assert.equal(calls, 4);
  } finally { c.dispose(); }
});

for (const sample of [
  () => response('<html><body>正在搜索，请稍候</body></html>', { headers: { 'content-type': 'text/html' } }),
  () => response('<html>not JSON</html>'), () => response({ blocked: true }),
  () => response({ ...data(), status_code: 403 }),
]) {
  test(`bad response ${sample().headers.get('content-type')} is not retried or cached as empty`, async () => {
    let calls = 0;
    const c = client(async () => ++calls === 1 ? sample() : response(data()), { incompletePageRetries: 4 });
    try {
      await assert.rejects(() => c.search({ query: '二嫁' }), unavailable);
      assert.equal(calls, 1);
      assert.equal((await c.search({ query: '二嫁' })).items.length, 1);
      assert.equal(calls, 2);
    } finally { c.dispose(); }
  });
}

test('HTTP restrictions do not trigger unsigned retries or browser/HTML fallbacks', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return response({ blocked: true }, { status: 429 }); }, { incompletePageRetries: 4 });
  try { await assert.rejects(() => c.search({ query: '二嫁' }), /HTTP 429/u); assert.equal(calls, 1); }
  finally { c.dispose(); }
});

test('search refuses foreign, extra-query and credential-bearing endpoints before dispatch', async () => {
  const c = client(async () => { throw Error('network must not run'); });
  try {
    for (const path of ['https://example.com/api/search/result?query=x', '/api/search/context?query=x',
      '/api/search/result?query=x&msToken=forbidden', '/api/search/result?query=x&query=y',
      'https://user:pass@hongguoduanju.com/api/search/result?query=x']) {
      await assert.rejects(() => c.readPage(path, false, undefined, 'json'), /Only supported official public URLs/u);
    }
  } finally { c.dispose(); }
});

test('search shares the existing streamed-response byte ceiling and does not cache oversized JSON', async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }), { maxResponseBytes: 1024 });
  try {
    await assert.rejects(() => c.search({ query: '二嫁' }), /maxResponseBytes/u);
    assert.equal(cancelled, true);
    assert.equal(c.cache.size, 0);
  } finally { c.dispose(); }
});

test('pre-abort and owner disposal reject search without a request', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return response(data()); }), controller = new AbortController();
  controller.abort(Error('caller cancelled'));
  await assert.rejects(() => c.search({ query: '二嫁' }, controller.signal), /caller cancelled/u);
  c.dispose();
  await assert.rejects(() => c.search({ query: '二嫁' }));
  assert.equal(calls, 0);
});

test('an aborted queued search does not release later requests before the active request settles', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const c = client(async () => { if (++calls === 1) { entered.resolve(); await release.promise; } return response(data()); });
  const controller = new AbortController();
  try {
    const first = c.search({ query: '第一个' });
    await entered.promise;
    const cancelled = c.search({ query: '取消的' }, controller.signal);
    const later = c.search({ query: '后来的' });
    controller.abort(Error('queued caller cancelled'));
    await assert.rejects(() => cancelled, /queued caller cancelled/u);
    assert.equal(calls, 1);
    release.resolve();
    await Promise.all([first, later]);
    assert.equal(calls, 2);
  } finally { release.resolve(); c.dispose(); }
});

for (const mode of ['caller', 'owner']) {
  test(`active ${mode} cancellation stops a stalled search body without caching it`, async () => {
    const entered = Promise.withResolvers();
    let cancelled = false;
    const c = client(async () => new Response(new ReadableStream({
      pull() { entered.resolve(); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }));
    const controller = new AbortController();
    try {
      const pending = c.search({ query: '二嫁' }, controller.signal);
      const rejected = assert.rejects(() => pending);
      await entered.promise;
      if (mode === 'caller') controller.abort(Error('caller cancelled body'));
      else c.dispose();
      await rejected;
      assert.equal(cancelled, true);
      assert.equal(c.cache.size, 0);
    } finally { c.dispose(); }
  });
}

test('a stalled keyword body is stopped by the configured request deadline and cancelled', async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/json' } }), { requestTimeoutMs: 100 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(() => c.search({ query: '二嫁' }), error => error.name === 'TimeoutError');
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); c.dispose(); }
});

test('an absent keyword body is unavailable rather than an empty HTML or zero-match result', async () => {
  const c = client(async () => new Response(null, { headers: { 'content-type': 'application/json' } }));
  try { await assert.rejects(() => c.search({ query: '二嫁' }), unavailable); } finally { c.dispose(); }
});
