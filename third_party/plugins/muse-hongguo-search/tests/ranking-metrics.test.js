import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRanking } from '../src/parser.js';
import { HongguoClient, deduplicate, thresholdStatus } from '../src/client.js';
import { apply } from '../src/index.js';

const origin = 'https://hongguoduanju.com';
const stamp = '2026-11-04T12:00:00Z';
const options = { board: 'hot-comic-drama', page: 1, sourceUrl: `${origin}/rank/hot-comic-drama`, fetchedAt: stamp };
const attribute = value => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');

function rendered({ engagement = '', heat = '200万热度', rank = 1, title = '样例', id = '123', page = 1 } = {}) {
  const route = 'rank_hot-comic-drama/page';
  const root = { loaderData: { [route]: { pageNum: page, canonicalUrl: `${origin}/rank/hot-comic-drama` } } };
  const pending = [route, [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"pending"'] }]];
  return `<script>_ROUTER_DATA = ${JSON.stringify(root)}</script>`
    + `<script data-fn-name="mergeLoaderData" data-fn-args="${attribute(pending)}"></script>`
    + `<article aria-labelledby="rank-title-${id}"><h2 id="rank-title-${id}">${title}</h2>`
    + `<span class="pc-badge-number-fixture">${rank}</span><p class="pc-metrics-fixture">${heat}</p>${engagement}</article>`
    + '<nav aria-label="榜单分页"><a href="/rank/hot-comic-drama">1</a></nav>';
}

function embedded({ collection = '120万收藏', likes = '10万点赞', heat = '200万热度' } = {}) {
  return `<script>_ROUTER_DATA = ${JSON.stringify({ loaderData: { 'rank_hot-comic-drama/page': {
    content: { isSuccess: true, pagination: { pageNum: 1, totalPages: 1 }, rankList: [
      { seriesId: '123', title: '样例', rank: 1, favoriteText: collection, likeText: likes, heatText: heat },
    ] },
  } } })}</script>`;
}

test('rendered cards retain verified identity and heat when engagement counts are absent', () => {
  const result = parseRanking(rendered(), options);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.seriesId, '123');
  assert.equal(item.collection.value, null);
  assert.equal(item.likes.value, null);
  assert.equal(item.heat.value, 2000000);
  assert.deepEqual(item.observation.missingMetrics, [
    { field: 'collection', reason: 'not_displayed' },
    { field: 'likes', reason: 'not_displayed' },
  ]);
  assert.deepEqual(item.observation.heat, item.heat);
});

test('missing metrics do not relax rendered page, title or rank checks', () => {
  assert.throws(() => parseRanking(rendered({ page: 2 }), options), /metadata mismatch/);
  assert.throws(() => parseRanking(rendered({ title: '' }), options), /Missing title/);
  assert.throws(() => parseRanking(rendered({ rank: 2 }), options), /rank sequence changed/);
});

test('a displayed zero remains known when other rendered metrics are absent', () => {
  const [item] = parseRanking(rendered({ engagement: '<ul aria-label="作品互动数据"><li>0收藏</li></ul>', heat: '' }), options).items;
  assert.equal(item.collection.value, 0);
  assert.deepEqual(item.observation.missingMetrics, [
    { field: 'likes', reason: 'not_displayed' },
    { field: 'heat', reason: 'not_displayed' },
  ]);
});

test('embedded observations distinguish missing and unsupported metrics from zero', () => {
  const [item] = parseRanking(embedded({ collection: null, likes: '暂无点赞', heat: '0热度' }), options).items;
  assert.deepEqual(item.observation.missingMetrics, [
    { field: 'collection', reason: 'not_displayed' },
    { field: 'likes', reason: 'unparseable' },
  ]);
  assert.equal(item.observation.heat.value, 0);
  assert.equal(item.observation.likes.raw, '暂无点赞');
});

test('dedup preserves all metric observations and fills earlier unknown display values', () => {
  const missing = parseRanking(embedded({ collection: null, likes: null, heat: null }), options).items;
  const full = parseRanking(embedded(), options).items;
  const changed = parseRanking(embedded({ collection: '110万收藏', likes: '12万点赞', heat: '190万热度' }), options).items;
  const [item] = deduplicate([...missing, ...full, ...changed]);
  assert.equal(item.collection.value, 1100000);
  assert.equal(item.likes.value, 100000);
  assert.equal(item.heat.value, 1900000);
  assert.equal(item.observations.length, 3);
  assert.deepEqual(item.conflicts, [
    { field: 'collection', values: [1100000, 1200000] },
    { field: 'likes', values: [100000, 120000] },
    { field: 'heat', values: [1900000, 2000000] },
  ]);
  assert.equal(thresholdStatus(item, 1000000), 'uncertain');
});

test('ranking coverage separates pages from each metric on every source observation', async t => {
  const client = new HongguoClient({ requestIntervalMs: 0 }, { fetch: async () => new Response(rendered(), { headers: { 'content-type': 'text/html' } }) });
  t.after(() => client.dispose());
  const result = await client.rankings({ boards: ['hot-comic-drama'] });
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.metrics, {
    scope: 'fetched_ranking_observations', observations: 1, complete: false,
    fields: { collection: { known: 0, missing: 1, complete: false }, likes: { known: 0, missing: 1, complete: false }, heat: { known: 1, missing: 0, complete: true } },
  });
});

test('metric coverage counts repeated source observations before deduplication', async t => {
  const client = new HongguoClient({ requestIntervalMs: 0 }, { fetch: async url => {
    const board = new URL(url).pathname.split('/').at(-1);
    const body = embedded(board === 'hot-comic-drama' ? { likes: null } : {}).replaceAll('rank_hot-comic-drama/page', `rank_${board}/page`);
    return new Response(body, { headers: { 'content-type': 'text/html' } });
  } });
  t.after(() => client.dispose());
  const result = await client.rankings({ boards: ['hot-comic-drama', 'hot-drama'] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].likes.value, 100000);
  assert.equal(result.coverage.metrics.observations, 2);
  assert.deepEqual(result.coverage.metrics.fields.likes, { known: 1, missing: 1, complete: false });
});

test('successful metric coverage does not conceal a missing page', async t => {
  const client = new HongguoClient({ requestIntervalMs: 0, maxPages: 2 }, { fetch: async url => {
    const page = new URL(url).searchParams.get('page');
    return page === '2' ? new Response('blocked', { status: 429 })
      : new Response(embedded().replace('"totalPages":1', '"totalPages":2'), { headers: { 'content-type': 'text/html' } });
  } });
  t.after(() => client.dispose());
  const result = await client.rankings({ boards: ['hot-comic-drama'] });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.pagesFetched, 1);
  assert.equal(result.coverage.pagesExpected, 2);
  assert.equal(result.coverage.metrics.complete, true);
  assert.equal(result.coverage.failures.length, 1);
  assert.doesNotMatch(result.note, /已遍历所有配置范围分页/);
});

test('registered ranking output describes metrics coverage and preserves unknown counts', async t => {
  const definitions = [], cleanups = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(rendered(), { headers: { 'content-type': 'text/html' } }));
  t.after(() => { for (const cleanup of cleanups) cleanup(); });
  apply({ tools: { register: definition => { definitions.push(definition); return () => {}; } }, effect: factory => { cleanups.push(factory()); } }, { requestIntervalMs: 0 });
  const ranking = definitions.find(definition => definition.name === 'hongguo_rankings');
  assert.ok(ranking.output.schema.properties.coverage.properties.metrics);
  const result = await ranking.execute({ boards: ['hot-comic-drama'] }, { signal: new AbortController().signal });
  const [content] = ranking.output.render({}, result);
  const value = JSON.parse(content.text);
  assert.equal(value.coverage.complete, true);
  assert.equal(value.coverage.metrics.complete, false);
  assert.equal(value.items[0].collection.value, null);
  assert.equal(value.items[0].observations[0].missingMetrics.length, 2);
});
