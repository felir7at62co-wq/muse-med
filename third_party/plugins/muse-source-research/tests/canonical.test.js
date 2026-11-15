import { describe, it, expect } from 'vitest';
import { canonicalize, compareSnapshots, renderReport } from '../src/canonical.js';

const time = '2026-11-04T10:00:00.000Z';
const later = '2026-11-05T10:00:00.000Z';
const count = value => ({ raw: value === null ? null : `${value}收藏`, value, approximate: false, precisionStep: 1 });
function source(value = 10, observedAt = time) {
  const observation = { board: 'hot-drama', page: 1, fetchedAt: observedAt, collection: count(value), likes: count(null), heat: count(null) };
  return { scope: 'public_rankings', items: [{ seriesId: '101', title: '同名', collection: count(value), likes: count(null), heat: count(null), observations: [observation] }], coverage: { complete: false, failures: [{ page: 2, error: 'missing' }], pages: [{ fetchedAt: observedAt }] } };
}
function snapshot(value, observedAt = time) {
  const sourceResult = source(value, observedAt);
  return { snapshotId: `test-${value}`, platform: 'hongguo', evidenceKind: 'official_public', scope: { boards: ['hot-drama'] }, sourceResult, coverage: sourceResult.coverage, ...canonicalize('hongguo', sourceResult, 'official_public', 100) };
}

describe('canonical source semantics', () => {
  it('preserves Hongguo field-specific source reasons for the selected raw observation', () => {
    const raw = source(null);
    const item = raw.items[0];
    item.collection.raw = '暂无收藏';
    item.observations[0].collection.raw = '暂无收藏';
    item.observations[0].missingMetrics = [{ field: 'collection', reason: 'unparseable' }, { field: 'likes', reason: 'not_displayed' }, { field: 'heat', reason: 'not_displayed' }];
    const other = structuredClone(item.observations[0]);
    other.collection.raw = null; other.fetchedAt = later;
    other.missingMetrics[0].reason = 'not_displayed';
    item.observations.push(other);
    const normalized = canonicalize('hongguo', raw, 'official_public', 10);
    expect(normalized.canonicalItems[0].metrics.collection).toMatchObject({ raw: '暂无收藏', value: null, missingReason: 'unparseable', observedAt: time });
    expect(normalized.canonicalItems[0].metrics.likes).toMatchObject({ raw: null, value: null, missingReason: 'not_displayed' });
    expect(normalized.canonicalItems[0].observations).toEqual(item.observations);
  });

  it('retains Qimao metric-owned reasons independently of observation missingMetrics', () => {
    const missing = { raw: '暂不可用', value: null, missingReason: 'unparseable', observedAt: time };
    const raw = { items: [{ bookId: '101', metrics: { heat: missing }, observations: [{ fetchedAt: time, metrics: { heat: missing }, missingMetrics: [{ field: 'heat', reason: 'not_displayed' }] }] }] };
    expect(canonicalize('qimao', raw, 'official_public', 10).canonicalItems[0].metrics.heat).toMatchObject(missing);
  });

  it('uses platform IDs, retains missing-ID originals and never merges equal titles', () => {
    const raw = source();
    raw.items.push({ ...structuredClone(raw.items[0]), seriesId: '102' }, { title: '同名', collection: count(50) });
    raw.items.push(structuredClone(raw.items[0]));
    const normalized = canonicalize('hongguo', raw, 'official_public', 10);
    expect(normalized.canonicalItems.map(item => item.key)).toEqual(['hongguo:101', 'hongguo:102']);
    expect(normalized.canonicalItems[0].observations).toHaveLength(2);
    expect(normalized.unidentifiedItems).toEqual([raw.items[2]]);
    expect(() => canonicalize('hongguo', raw, 'official_public', 2)).toThrow(/maxItems/);
  });

  it('keeps cached measurement times and negative common-known-field deltas on partial sources', () => {
    const before = snapshot(10), after = snapshot(7, later);
    const change = compareSnapshots(before, after);
    expect(change.comparisons[0].metrics[0]).toMatchObject({ before: 10, after: 7, delta: -3, beforeObservedAt: time, afterObservedAt: later });
    expect(change.excluded).toContainEqual({ key: 'hongguo:101', field: 'likes', reason: 'unknown_value' });
    expect(compareSnapshots(before, snapshot(null, later)).comparisons).toEqual([]);
    expect(compareSnapshots(before, snapshot(10)).comparisons[0].metrics[0]).toMatchObject({ delta: 0, measurementAdvanced: false });
    expect(compareSnapshots(before, snapshot(11)).excluded).toContainEqual({ key: 'hongguo:101', field: 'collection', reason: 'source_observation_conflict' });
  });

  it('rejects mismatched platform, selection, metric labels, units and metric windows', () => {
    const before = snapshot(10), after = snapshot(11, later);
    after.scope = { boards: ['hot-comic-drama'] };
    expect(compareSnapshots(before, after).sameScope).toBe(false);
    after.scope = before.scope;
    for (const [field, value] of [['unit', '热度'], ['label', '在读'], ['semantic', 'app.readers'], ['scope', { board: 'other' }]]) {
      const changed = structuredClone(after);
      changed.canonicalItems[0].metrics.collection[field] = value;
      expect(compareSnapshots(before, changed).comparisons).toEqual([]);
    }
  });

  it('retains real legacy field names and does not invent current-reader semantics', () => {
    const raw = { platform: 'qimao', collectedAt: time, items: [{ id: '101', title: '旧记录', metric_type: 'popularity', metric_value: 15, metric_raw: '15人气值', reads: 20, golden_pick: null }, { id: 999, title: 'numeric ID is ambiguous' }] };
    const normalized = canonicalize('qimao', raw, 'legacy_file', 10);
    expect(normalized.canonicalItems[0].metrics.popularity.semantic).toBe('legacy.popularity');
    expect(normalized.canonicalItems[0].metrics.reads).toMatchObject({ semantic: 'legacy.reads', unit: 'legacy_unspecified' });
    expect(normalized.canonicalItems[0].metrics).not.toHaveProperty('currentReaders');
    expect(normalized.unidentifiedItems).toEqual([raw.items[1]]);
    expect(raw.items[0].golden_pick).toBeNull();
  });

  it('compares Qimao word counts from the original measured window', () => {
    const book = words => ({ items: [{ bookId: '101', title: '样例', wordCount: { label: '字', raw: `${words}字`, value: words, observedAt: words === 10 ? time : later }, metrics: {}, observations: [{ source: 'rank', channel: 'boy', board: 'hot', period: 'date', page: 1, fetchedAt: words === 10 ? time : later, metrics: {} }] }] });
    const q = words => ({ snapshotId: `q-${words}`, platform: 'qimao', evidenceKind: 'official_public', scope: { source: 'rank' }, ...canonicalize('qimao', book(words), 'official_public', 10) });
    expect(compareSnapshots(q(10), q(20)).comparisons[0].metrics).toContainEqual(expect.objectContaining({ field: 'wordCount', delta: 10 }));
  });

  it('escapes source-controlled Markdown, HTML, image syntax and forged links', () => {
    const before = snapshot(10), after = snapshot(11, later);
    after.canonicalItems[0].title = '![x](https://evil.test/image) <img src=x> **bold** `x` [fake](file:///tmp/a)';
    const markdown = renderReport([after], [{ snapshotId: 'id', sha256: 'hash', platform: 'hongguo', evidenceKind: 'official_public' }], [compareSnapshots(before, after)], later);
    expect(markdown).toContain('\\!\\[x\\]\\(https://evil\\.test/image\\)');
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('![x]');
  });

  it('keeps imported metric names as escaped single-line data, including prototype-like keys', () => {
    const raw = { platform: 'qimao', collectedAt: time, items: [{ id: '1', metric_type: 'reads\n\n## injected heading\n![x](https://evil.test)', metric_value: null }, { id: '2', metric_type: '__proto__', metric_value: null }] };
    const normalized = canonicalize('qimao', raw, 'legacy_file', 10);
    expect(Object.keys(normalized.canonicalItems[1].metrics)).toEqual(['__proto__']);
    const document = { snapshotId: 'safe', platform: 'qimao', evidenceKind: 'legacy_file', scope: {}, coverage: {}, ...normalized };
    const markdown = renderReport([document], [], [], time);
    expect(markdown).not.toContain('\n## injected heading');
    expect(markdown).not.toContain('![x]');
    expect(markdown).toContain('\\#\\# injected heading');
  });
});
