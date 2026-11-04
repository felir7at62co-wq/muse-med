import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { QimaoClient, resolveConfig, deduplicate } from '../src/client.js';
import { readMetadata, metadataUrl, readLegacyResponse } from '../src/transport.js';
import { parseRanking } from '../src/parser.js';
import { rankingHtml, libraryHtml, detailHtml } from './fixtures.mjs';

const rank = { channels: ['boy'], boards: ['hot'], periods: ['date'] };
const response = (html, status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html' } });
const client = (fetch, config = {}, extra = {}) => new QimaoClient({ requestIntervalMs: 0, ...config }, { fetch, ...extra });

test('all supported ranking windows retain observations without claiming site-wide coverage', async () => {
  let calls = 0;
  const c = client(async url => { calls++; const [, , channel, board, period] = new URL(url).pathname.split('/'); return response(rankingHtml({ channel, board, period })); });
  try {
    const data = await c.rankings();
    assert.equal(calls, 12); assert.equal(data.items.length, 1); assert.equal(data.items[0].observations.length, 12);
    assert.equal(data.coverage.complete, true); assert.equal(data.coverage.siteWide, false);
    assert.equal(data.coverage.metrics.fields.heat.known, 12); assert.equal(data.coverage.metrics.complete, false);
    assert.ok(data.coverage.pages.every(page => page.paginationVerified === false));
  } finally { await c.dispose(); }
});

test('real library paths and active pages are used, and duplicate pages are not counted twice', async () => {
  const urls = [];
  const c = client(async url => { urls.push(url); const page = Number(/click-(\d+)/.exec(url)[1]); return response(libraryHtml({ page, ids: page < 3 ? [String(100 + page)] : ['102'] })); });
  try {
    const data = await c.rankings({ source: 'library', pages: 3 });
    assert.equal(urls.length, 3); assert.ok(urls[1].endsWith('click-2/'));
    assert.equal(data.items.length, 2); assert.equal(data.coverage.pagesFetched, 2); assert.equal(data.coverage.complete, false);
    assert.equal(data.coverage.failures[0].code, 'duplicate_page');
    assert.equal(data.selection.wordCountBelow, 300000); assert.equal(data.selection.updatedWithinDays, 3);
  } finally { await c.dispose(); }
});

test('later unknown metrics do not erase earlier known observations', () => {
  const a = parseRanking(rankingHtml(), { ...rank, channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'a', fetchedAt: '2026-11-04T01:00:00Z' }).items[0];
  const b = parseRanking(rankingHtml({ heat: '' }), { channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'b', fetchedAt: '2026-11-04T02:00:00Z' }).items[0];
  const [r] = deduplicate([a, b]); assert.equal(r.metrics.heat.value, 100000); assert.equal(r.metrics.heat.observedAt, a.metrics.heat.observedAt);
  assert.equal(r.observations.length, 2); assert.equal(r.observations[1].metrics.heat.value, null);
});

test('an older cached window cannot replace newer metadata or metric observations', () => {
  const newer = parseRanking(rankingHtml({ title: '最新元数据', heat: '20万热度' }), { channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'fresh', fetchedAt: '2026-11-04T02:00:00Z' }).items[0];
  const older = parseRanking(rankingHtml({ title: '旧缓存', heat: '10万热度' }), { channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'cached', fetchedAt: '2026-11-04T01:00:00Z' }).items[0];
  const [result] = deduplicate([newer, older]);
  assert.equal(result.title, '最新元数据'); assert.equal(result.sourceUrl, 'fresh'); assert.equal(result.fetchedAt, newer.fetchedAt);
  assert.equal(result.metrics.heat.value, 200000); assert.equal(result.metrics.heat.observedAt, newer.fetchedAt);
  assert.deepEqual(result.observations.map(value => value.sourceUrl), ['fresh', 'cached']);
});

test('cache expires by TTL and refresh preserves real observation times', async () => {
  let now = 1000000, calls = 0;
  const c = client(async () => { calls++; return response(detailHtml()); }, { cacheTtlMs: 100 }, { now: () => now });
  try {
    const first = await c.detail({ bookId: '101' }); now += 50;
    const cached = await c.detail({ bookId: '101' }); assert.equal(calls, 1); assert.equal(cached.fromCache, true); assert.equal(cached.fetchedAt, first.fetchedAt);
    now += 51; const fresh = await c.detail({ bookId: '101' }); assert.equal(calls, 2); assert.notEqual(fresh.fetchedAt, first.fetchedAt);
    await c.detail({ bookId: '101', refresh: true }); assert.equal(calls, 3);
  } finally { await c.dispose(); }
});

test('search exposes a bounded filtered window, not a global negative result', async () => {
  const c = client(async () => response(rankingHtml()));
  try {
    const data = await c.search({ ...rank, query: '样例作者' }); assert.equal(data.items.length, 1); assert.equal(data.complete, false); assert.equal(data.availableInWindow, 1);
    assert.equal((await c.search({ ...rank, query: '找不到' })).matchedInWindow, 0);
  } finally { await c.dispose(); }
});

test('invalid selections reject before any request, and parser failures are not cached', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return response(calls === 1 ? detailHtml({ id: '999' }) : detailHtml()); });
  try {
    for (const args of [{ pages: 2 }, { source: 'library', channels: ['boy'] }, { boards: ['bad'] }, { refresh: 'yes' }]) await assert.rejects(() => c.rankings(args));
    assert.equal(calls, 0); await assert.rejects(() => c.detail({ bookId: '101' }), /does not match/);
    await c.detail({ bookId: '101' }); assert.equal(calls, 2);
    assert.throws(() => resolveConfig({ unknown: true })); assert.throws(() => resolveConfig({ allowLegacyResponseHeaders: 1 }));
  } finally { await c.dispose(); }
});

test('blocked pages remain failures, and later selected windows can still succeed', async () => {
  const c = client(async url => url.includes('/boy/') ? response('<title>安全验证</title>') : response(rankingHtml({ channel: 'girl' })));
  try {
    const data = await c.rankings({ boards: ['hot'], periods: ['date'] });
    assert.equal(data.coverage.complete, false); assert.equal(data.coverage.failures[0].code, 'access_blocked'); assert.equal(data.items.length, 1);
  } finally { await c.dispose(); }
});

test('legacy headers are confined to the observed parser error and the fixed metadata origin', async () => {
  const config = resolveConfig({ requestIntervalMs: 0 }), signal = new AbortController().signal;
  let legacyCalls = 0;
  const dependencies = { fetch: async () => { throw new TypeError('fetch failed', { cause: { code: 'HPE_INVALID_HEADER_TOKEN' } }); },
    legacyRequest: async url => { legacyCalls++; assert.equal(url.origin, 'https://www.qimao.com'); return rankingHtml(); } };
  assert.equal((await readMetadata('/paihang/boy/hot/date/', config, signal, dependencies)).transport, 'https_legacy_headers');
  await assert.rejects(() => readMetadata('/paihang/boy/hot/date/', { ...config, allowLegacyResponseHeaders: false }, signal, dependencies));
  await assert.rejects(() => readMetadata('/paihang/boy/hot/date/', config, signal, { ...dependencies, fetch: async () => response('blocked', 403) }), /denied/);
  assert.equal(legacyCalls, 1);
  for (const path of ['https://example.com/', '//example.com/', '/shuku/101-987/', '/shuku/101/?cookie=x']) assert.throws(() => metadataUrl(path));
});

test('response size and content checks reject before metadata parsing', async () => {
  const signal = new AbortController().signal, config = resolveConfig({ maxResponseBytes: 1024 });
  await assert.rejects(() => readMetadata('/shuku/101/', config, signal, { fetch: async () => response('x'.repeat(2048)) }), /maxResponseBytes/);
  await assert.rejects(() => readMetadata('/shuku/101/', config, signal, { fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }), /not HTML/);
  await assert.rejects(() => readMetadata('/shuku/101/', config, signal, { fetch: async () => new Response('', { status: 302, headers: { location: 'https://example.com' } }) }), /redirects/);
});

test('legacy response framing rejects short, long and incomplete bodies and conflicting lengths', async () => {
  const config = resolveConfig({ maxResponseBytes: 1024 });
  const stream = (body, length, extra = {}) => Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: 200, headers: { 'content-type': 'text/html', ...(length === undefined ? {} : { 'content-length': String(length) }) },
    rawHeaders: [], complete: true, ...extra,
  });
  assert.equal(await readLegacyResponse(stream('valid', 5), config), 'valid');
  await assert.rejects(() => readLegacyResponse(stream('short', 20), config), /Content-Length/);
  await assert.rejects(() => readLegacyResponse(stream('too long', 2), config), /Content-Length/);
  await assert.rejects(() => readLegacyResponse(stream('body', 4, { complete: false }), config), /complete/);
  await assert.rejects(() => readLegacyResponse(stream('x'.repeat(1100)), config), /maxResponseBytes/);
  await assert.rejects(() => readLegacyResponse(stream('body', 4, { rawHeaders: ['Content-Length', '4', 'content-length', '4'] }), config), /framing/);
  await assert.rejects(() => readLegacyResponse(stream('body', 4, { headers: { 'content-type': 'text/html', 'content-length': '4', 'transfer-encoding': 'chunked' } }), config), /framing/);
});

test('only the observed strict length error can use a completed compatibility response', async () => {
  const config = resolveConfig(), signal = new AbortController().signal;
  let calls = 0;
  const legacyRequest = async () => { calls++; return rankingHtml(); };
  const fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' } }); };
  const result = await readMetadata('/paihang/boy/hot/date/', config, signal, { fetch, legacyRequest });
  assert.equal(result.transport, 'https_legacy_headers'); assert.equal(calls, 1);
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    await assert.rejects(() => readMetadata('/shuku/101/', config, signal, { legacyRequest, fetch: async () => { throw Object.assign(new Error('failed'), { code }); } }));
  }
  await assert.rejects(() => readMetadata('/shuku/101/', config, signal, { legacyRequest, fetch: async () => new Response('short', { headers: { 'content-type': 'text/html', 'content-length': '20' } }) }), /Content-Length/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => readMetadata('/shuku/101/', config, cancelled.signal, { fetch, legacyRequest }));
  assert.equal(calls, 1);
});

test('disposal aborts admitted I/O and waits for its operation to settle', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let observedAbort = false;
  const c = client(async (_url, { signal }) => {
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true }));
  });
  const read = c.detail({ bookId: '101' }); const rejected = assert.rejects(read);
  await started; await c.dispose(); await rejected; assert.equal(observedAbort, true);
  await assert.rejects(() => c.detail({ bookId: '101' }));
});

test('a cancelled queued request settles immediately without admitting its successor early', { timeout: 10000 }, async t => {
  let enterFirst, releaseFirst;
  const entered = new Promise(resolve => { enterFirst = resolve; });
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const c = client(async url => {
    const id = /\/shuku\/(\d+)\//u.exec(url)[1]; calls.push(id);
    if (id === '101') { enterFirst(); await held; }
    return response(detailHtml({ id }));
  });
  t.after(async () => { releaseFirst(); await c.dispose(); });
  const first = c.detail({ bookId: '101' }); await entered;
  const controller = new AbortController();
  const middle = c.detail({ bookId: '102' }, controller.signal);
  const last = c.detail({ bookId: '103' });
  controller.abort(); await assert.rejects(middle);
  assert.deepEqual(calls, ['101']);
  releaseFirst(); await Promise.all([first, last]);
  assert.deepEqual(calls, ['101', '103']);
});
