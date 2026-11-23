import { describe, expect, it } from 'vitest';
import { CatalogDisplayCache } from '../src/client/catalog-display-cache.ts';
import type { BoardPeriodView, CatalogResponse, Work } from '../src/shared/types.ts';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}
const actor = { id: 'alice', role: 'member' as const };
const origin = 'http://127.0.0.1:4318';
const at = '2026-11-13T00:00:00.000Z';
const query = 'origin=live&platform=hongguo&board=综合榜&page=1&limit=10';
const work: Work = { id: 'hongguo:9000000000000000011', sourceId: '9000000000000000011', platform: 'hongguo', kind: 'drama',
  title: '公开作品', author: null, description: '公开简介', coverUrl: null, sourceUrl: 'https://example.invalid/work',
  tags: ['系统'], category: '都市', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
  metrics: [{ key: 'heat', label: '热度', value: null }], rank: 1, rankChange: null, board: '综合榜', origin: 'live', observedAt: at,
  sourceUpdatedAt: null, topics: [], script: { id: 'private-file', workId: 'hongguo:9000000000000000011', fileName: '个人文件.txt',
    contentType: 'text/plain', byteLength: 1, sha256: '0'.repeat(64), createdAt: at } };
const catalog: CatalogResponse = { items: [work], page: 1, limit: 10, total: 1, boards: ['综合榜'], categories: ['都市'] };

describe('account-scoped public catalog display copies', () => {
  it('returns to Hongguo when a saved page points at the retired Douyin source', () => {
    const storage = new MemoryStorage();
    new CatalogDisplayCache(storage, origin, actor).remember('douyin');
    expect(new CatalogDisplayCache(storage, origin, actor).platform).toBe('hongguo');
  });
  it('restores navigation and snapshots without changing the source time or persisting script metadata', () => {
    const storage = new MemoryStorage(); let now = Date.parse(at);
    const first = new CatalogDisplayCache(storage, origin, actor, () => now);
    first.remember('hongguo', { board: '综合榜', page: 1, sort: 'rank', tag: '' });
    first.saveDirectory('hongguo', { boards: ['综合榜'], defaultBoard: '综合榜' });
    first.saveCatalog(query, catalog);
    first.saveFacets('platform=hongguo&board=综合榜', { groups: [{ id: 'setting', label: '设定', items: [{ id: 'system', label: '系统', count: 1 }] }] });
    now += 3600_000;
    const restored = new CatalogDisplayCache(storage, origin, actor, () => now);
    expect(restored.selection('hongguo')?.board).toBe('综合榜');
    expect(restored.directory('hongguo')?.value.defaultBoard).toBe('综合榜');
    expect(restored.facet('platform=hongguo&board=综合榜')?.value.groups[0]?.items[0]?.count).toBe(1);
    expect(restored.catalog(query)).toMatchObject({ savedAt: Date.parse(at), value: { items: [{ observedAt: at }] } });
    expect(restored.catalog(query)?.value.items[0]).not.toHaveProperty('script');
    expect([...storage.values.values()].join('')).not.toContain('个人文件.txt');
  });

  it('partitions accounts, roles and origins and rejects an envelope copied under a different owner key', () => {
    const storage = new MemoryStorage();
    new CatalogDisplayCache(storage, origin, actor).saveCatalog(query, catalog);
    expect(new CatalogDisplayCache(storage, origin, { ...actor, id: 'bob' }).catalog(query)).toBeNull();
    expect(new CatalogDisplayCache(storage, origin, { ...actor, role: 'admin' }).catalog(query)).toBeNull();
    expect(new CatalogDisplayCache(storage, 'http://localhost:4318', actor).catalog(query)).toBeNull();
    const original = [...storage.values.values()][0]!;
    new CatalogDisplayCache(storage, origin, { ...actor, id: 'bob' }).remember('fanqie');
    const bobKey = [...storage.values.keys()].find(key => key.includes('bob'))!;
    storage.setItem(bobKey, original);
    expect(new CatalogDisplayCache(storage, origin, { ...actor, id: 'bob' }).catalog(query)).toBeNull();
    expect(storage.getItem(bobKey)).toBeNull();
  });

  it('does not treat expired or future saved copies as displayable data', () => {
    const storage = new MemoryStorage(); let now = Date.parse(at);
    const cache = new CatalogDisplayCache(storage, origin, actor, () => now);
    cache.saveCatalog(query, catalog);
    now--;
    expect(cache.catalog(query)).toBeNull();
    now = Date.parse(at) + 24 * 3600_000;
    expect(cache.catalog(query)).toBeNull();
  });

  it('rejects broken JSON, old versions, oversized persisted values and incorrect query scope', () => {
    for (const raw of ['{', JSON.stringify({ version: 0 }), 'x'.repeat(2_000_001)]) {
      const storage = new MemoryStorage();
      new CatalogDisplayCache(storage, origin, actor).remember('hongguo');
      const key = [...storage.values.keys()][0]!; storage.setItem(key, raw);
      expect(new CatalogDisplayCache(storage, origin, actor).catalog(query)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
    const cache = new CatalogDisplayCache(new MemoryStorage(), origin, actor);
    cache.saveCatalog(query, { ...catalog, items: [{ ...work, platform: 'fanqie' }] });
    expect(cache.catalog(query)).toBeNull();
    cache.saveCatalog(query, { ...catalog, items: [{ ...work, origin: 'demo' }] });
    expect(cache.catalog(query)).toBeNull();
  });

  it('restores a past board batch only for the query naming that batch time', () => {
    const cache = new CatalogDisplayCache(new MemoryStorage(), origin, actor, () => Date.parse(at));
    const batch = { observedAt: at, previousObservedAt: '2026-11-12T18:00:00.000Z' };
    const historical = `${query}&at=${encodeURIComponent(at)}`;
    cache.saveCatalog(historical, { ...catalog, batch });
    expect(cache.catalog(historical)?.value.batch).toEqual(batch);
    const other = `${query}&at=${encodeURIComponent('2026-11-12T18:00:00.000Z')}`;
    cache.saveCatalog(other, { ...catalog, batch });
    expect(cache.catalog(other)).toBeNull();
    cache.saveCatalog(other, { ...catalog, batch: null });
    expect(cache.catalog(other)).toBeNull();
    cache.saveCatalog(query, { ...catalog, batch: null });
    expect(cache.catalog(query)?.value.batch).toBeNull();
  });

  it('holds board periods in memory for this tab and restores stored copies only for revalidation', () => {
    const storage = new MemoryStorage();
    const cache = new CatalogDisplayCache(storage, origin, actor, () => Date.parse(at));
    const latest = 'platform=hongguo&board=综合榜&origin=live&period=day';
    const view: BoardPeriodView = { platform: 'hongguo', board: '综合榜', origin: 'live', period: 'day', date: '2026-11-13', start: '2026-11-13', end: '2026-11-13',
      daysInPeriod: 1, days: [{ date: '2026-11-13', observedAt: at }], previous: null,
      items: [{ position: 1, daysOnBoard: 1, averageRank: 1, bestRank: 1, lastDate: '2026-11-13', work }] };
    cache.savePeriod(latest, view, 3);
    expect(cache.period(latest)).toMatchObject({ version: 3, value: { items: [{ work: { script: { fileName: '个人文件.txt' } } }] } });
    const restored = new CatalogDisplayCache(storage, origin, actor, () => Date.parse(at)).period(latest);
    expect(restored?.version).toBe(-1);
    expect(restored?.value.items[0]?.work).not.toHaveProperty('script');
    expect([...storage.values.values()].join('')).not.toContain('个人文件.txt');
    cache.savePeriod(`${latest}&date=2026-11-12`, view, 3);
    expect(cache.period(`${latest}&date=2026-11-12`)).toBeNull();
    cache.savePeriod(latest.replace('period=day', 'period=week'), view, 3);
    expect(cache.period(latest.replace('period=day', 'period=week'))).toBeNull();
    cache.clear();
    expect(cache.period(latest)).toBeNull();
  });

  it('shares one in-flight read per key', async () => {
    const cache = new CatalogDisplayCache(new MemoryStorage(), origin, actor);
    let reads = 0;
    const read = () => cache.once('period:1:x', async () => ++reads);
    expect(await Promise.all([read(), read()])).toEqual([1, 1]);
    expect(await read()).toBe(2);
  });

  it('continues in memory when private-mode storage reads, writes or removals fail', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
    const cache = new CatalogDisplayCache(blocked, origin, actor);
    expect(() => cache.saveCatalog(query, catalog)).not.toThrow();
    expect(cache.catalog(query)?.value.total).toBe(1);
    expect(() => cache.clear()).not.toThrow();
  });

  it('bounds pages and total persisted size and cannot be repopulated by a late signed-out response', () => {
    const storage = new MemoryStorage(); const cache = new CatalogDisplayCache(storage, origin, actor);
    for (let page = 1; page <= 20; page++) cache.saveCatalog(query.replace('page=1', `page=${page}`), { ...catalog, page,
      items: Array.from({ length: 10 }, () => ({ ...work, description: 'x'.repeat(30_000) })) });
    expect(new TextEncoder().encode([...storage.values.values()][0]).byteLength).toBeLessThanOrEqual(2_000_000);
    expect(cache.catalog(query)).toBeNull();
    cache.clear(); cache.saveCatalog(query, catalog); cache.remember('fanqie');
    expect(cache.catalog(query)).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
