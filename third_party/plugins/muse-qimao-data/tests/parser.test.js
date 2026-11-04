import test from 'node:test';
import assert from 'node:assert/strict';
import { bookId, parseMetric, parseRanking, parseLibrary, parseDetail } from '../src/parser.js';
import { rankingHtml, libraryHtml, detailHtml } from './fixtures.mjs';

const at = '2026-11-04T12:00:00.000Z';
const options = { channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'https://www.qimao.com/paihang/boy/hot/date/', fetchedAt: at };

test('ranking metadata preserves original metric names and never executes page JavaScript', () => {
  const result = parseRanking(rankingHtml(), options), item = result.items[0];
  assert.equal(item.bookId, '101'); assert.equal(item.author, '样例作者'); assert.equal(item.wordCount.value, 200000);
  assert.equal(item.metrics.heat.value, 100000); assert.equal(item.metrics.heat.label, '热度');
  assert.equal(item.currentReaders, null); assert.equal(item.goldenPick, null);
  assert.equal(item.metrics.readOccurrences.value, null); assert.equal(item.metrics.readOccurrences.missingReason, 'not_displayed');
  assert.equal(result.paginationVerified, false); assert.equal(globalThis.qimaoPageExecuted, undefined);
});

test('wrong active channel, board and period reject rather than relabeling data', () => {
  assert.throws(() => parseRanking(rankingHtml({ channel: 'girl' }), options), /differs/);
  assert.throws(() => parseRanking(rankingHtml({ activeBoard: 'new' }), options), /differs/);
  assert.throws(() => parseRanking(rankingHtml({ period: 'month' }), options), /differs/);
});

test('ranking identity and rank order remain strict', () => {
  assert.throws(() => parseRanking(rankingHtml({ ids: ['101', '101'] }), options), /repeats/);
  assert.throws(() => parseRanking(rankingHtml().replace('rank-number">1', 'rank-number">2'), options), /rank/);
  assert.throws(() => parseRanking(rankingHtml().replaceAll('https://www.qimao.com/shuku/101/', 'https://example.com/shuku/101/'), options), /identity/);
});

test('the public library validates filters, sort and actual page', () => {
  const opts = { page: 2, sourceUrl: 'https://www.qimao.com/shuku/a-a-a-1-1-a-0-click-2/', fetchedAt: at };
  const result = parseLibrary(libraryHtml({ page: 2 }), opts);
  assert.equal(result.paginationVerified, true); assert.equal(result.items[0].observations[0].positionOnPage, 1);
  assert.equal(result.items[0].observations[0].rank, undefined);
  assert.throws(() => parseLibrary(libraryHtml({ page: 1 }), opts), /page number/);
  assert.throws(() => parseLibrary(libraryHtml({ page: 2, title: '七猫首页' }), opts), /filter/);
  assert.throws(() => parseLibrary(libraryHtml({ page: 2, sort: '按收藏数' }), opts), /sort/);
});

test('book detail keeps cumulative reads distinct from current readers and excludes chapter content', () => {
  const result = parseDetail(detailHtml(), { bookId: '101', sourceUrl: 'https://www.qimao.com/shuku/101/', fetchedAt: at });
  assert.equal(result.metrics.cumulativePopularity.value, 82000); assert.equal(result.metrics.readOccurrences.value, 51000);
  assert.equal(result.metrics.readOccurrences.label, '次阅读'); assert.equal(result.currentReaders, null); assert.equal(result.goldenPick, null);
  assert.equal(result.author, '样例作者'); assert.equal(result.description, '公开简介');
  assert.doesNotMatch(JSON.stringify(result), /NEVER_RETURN_CHAPTER_BODY|NEVER_EXECUTE_PAGE_SCRIPT/);
  assert.throws(() => parseDetail(detailHtml({ id: '999' }), { bookId: '101', fetchedAt: at }), /does not match/);
});

test('missing and malformed display counts remain unknown while zero remains zero', () => {
  assert.equal(parseMetric('0次阅读', '次阅读', at).value, 0);
  assert.equal(parseMetric('1.2亿累计人气值', '累计人气值', at).value, 120000000);
  assert.equal(parseMetric('9万+次阅读', '次阅读', at).value, null);
  assert.equal(parseMetric('', '次阅读', at).missingReason, 'not_displayed');
  const result = parseDetail(detailHtml({ popularity: '', reads: '' }), { bookId: '101', fetchedAt: at });
  assert.equal(result.metrics.cumulativePopularity.value, null); assert.equal(result.metrics.readOccurrences.value, null);
});

test('decimal display scaling is exact while fractional or unsafe counters remain unknown', () => {
  assert.equal(parseMetric('0.57万字', '字', at).value, 5700);
  assert.equal(parseMetric('1.13万次阅读', '次阅读', at).value, 11300);
  assert.equal(parseMetric('1.13万次阅读', '次阅读', at).precisionStep, 100);
  assert.equal(parseMetric('1.13次阅读', '次阅读', at).value, null);
  assert.equal(parseMetric('0.00001万次阅读', '次阅读', at).value, null);
  assert.equal(parseMetric('9007199254740991次阅读', '次阅读', at).value, Number.MAX_SAFE_INTEGER);
  assert.equal(parseMetric('9007199254740992次阅读', '次阅读', at).value, null);
  assert.equal(parseMetric(`${'9'.repeat(1000)}万次阅读`, '次阅读', at).value, null);
});

test('verification pages and unverified book URLs reject', () => {
  assert.throws(() => parseRanking('<title>安全验证</title><div>challenge</div>', options), /verification/);
  for (const value of [101, 'https://example.com/shuku/101/', 'https://www.qimao.com/shuku/101/?token=x', 'https://www.qimao.com/shuku/101-987/']) assert.throws(() => bookId(value));
  assert.equal(bookId('https://www.qimao.com/shuku/101/'), '101');
});
