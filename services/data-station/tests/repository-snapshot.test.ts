import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import type { CollectionBatch, Work } from '../src/shared/types.ts';

function batch(ids: string[], board: string, time: string, title = '作品'): CollectionBatch {
  const works: Work[] = ids.map((sourceId, index) => ({
    id: `qimao:${sourceId}`, sourceId, platform: 'qimao', kind: 'novel', title: `${title} ${sourceId}`, author: null, description: '',
    coverUrl: null, sourceUrl: `https://example.com/${sourceId}`, tags: [], category: '', episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [], rank: board ? index + 1 : null, rankChange: null, board, origin: 'live',
    observedAt: time, sourceUpdatedAt: null,
  }));
  return { platform: 'qimao', works, observedAt: time, coverage: '测试' };
}

describe('in-memory work snapshot', () => {
  it('refreshes only changed works after ingests instead of reloading every work', async () => {
    const database = new PGlite();
    const repository = new DataRepository(database);
    try {
      await repository.initialize({ seedDemo: false });
      await repository.ingestBatch(batch(['1', '2'], '大热榜', '2026-11-14T00:00:00.000Z'));
      expect((await repository.listWorks({ platform: 'qimao', origin: 'live' })).total).toBe(2);
      const query = vi.spyOn(database, 'query');
      await repository.ingestDiscoveryPage(batch(['3'], '', '2026-11-14T01:00:00.000Z', '新发现'), async () => {});
      await repository.ingestBatch(batch(['1'], '大热榜', '2026-11-14T06:00:00.000Z', '改名'));
      const listed = await repository.listWorks({ platform: 'qimao', origin: 'live' });
      expect(listed.total).toBe(3);
      expect(listed.items.map(work => work.title).sort()).toEqual(['作品 2', '改名 1', '新发现 3']);
      const reads = query.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes('SELECT payload FROM works'));
      expect(reads).toEqual(['SELECT payload FROM works WHERE id = ANY($1::text[])']);
      expect(query.mock.calls.find(([sql]) => String(sql).includes('WHERE id = ANY'))![1]).toEqual([['qimao:3', 'qimao:1']]);
    } finally { await database.close(); }
  });

  it('keeps board names cached through catalog pages and refreshes them after a ranked batch', async () => {
    const database = new PGlite();
    const repository = new DataRepository(database);
    try {
      await repository.initialize({ seedDemo: false });
      await repository.ingestBatch(batch(['1'], '大热榜', '2026-11-14T00:00:00.000Z'));
      expect((await repository.listWorks({ platform: 'qimao', origin: 'live' })).boards).toEqual(['大热榜']);
      const query = vi.spyOn(database, 'query');
      await repository.ingestDiscoveryPage(batch(['2'], '', '2026-11-14T01:00:00.000Z'), async () => {});
      expect((await repository.listWorks({ platform: 'qimao', origin: 'live' })).boards).toEqual(['大热榜']);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('SELECT DISTINCT o.board'))).toBe(false);
      await repository.ingestBatch(batch(['2'], '新书榜', '2026-11-14T06:00:00.000Z'));
      expect((await repository.listWorks({ platform: 'qimao', origin: 'live' })).boards).toEqual(['大热榜', '新书榜']);
    } finally { await database.close(); }
  });
});
