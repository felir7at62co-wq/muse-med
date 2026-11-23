import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { DataRepository } from '../src/server/repository.ts';
import type { CollectionBatch, Observation, Work } from '../src/shared/types.ts';

const FIRST = '2026-11-13T06:00:00.000Z';
const SECOND = '2026-11-14T06:00:00.000Z';
const THIRD = '2026-11-15T06:00:00.000Z';

function work(sourceId: string, overrides: Partial<Work> = {}): Work {
  return { id: `hongguo:${sourceId}`, sourceId, platform: 'hongguo', kind: 'drama', title: `测试作品 ${sourceId}`,
    author: null, description: '独立内存数据库测试', coverUrl: null, sourceUrl: `https://example.com/works/${sourceId}`,
    tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: 100 }], rank: 10, rankChange: null,
    board: '公开测试榜', origin: 'live', observedAt: FIRST, sourceUpdatedAt: '原榜期', ...overrides };
}

function page(works: Work[]): CollectionBatch {
  return { platform: 'hongguo', works, observedAt: works[0]!.observedAt, coverage: '隔离测试页面，非全库' };
}

async function fixture() {
  const database = new PGlite();
  const repository = new DataRepository(database);
  await repository.initialize({ seedDemo: false });
  await database.query("INSERT INTO data_settings(key,value) VALUES('test_discovery_progress','0'::jsonb)");
  return { database, repository };
}

async function totals(database: PGlite): Promise<{ works: number; observations: number; progress: number }> {
  const result = await database.query<{ works: number; observations: number; progress: number }>(`SELECT
    (SELECT count(*)::int FROM works) AS works,
    (SELECT count(*)::int FROM observations) AS observations,
    (SELECT (value #>> '{}')::int FROM data_settings WHERE key='test_discovery_progress') AS progress`);
  return result.rows[0]!;
}

describe('atomic discovery publication and catalog observations', () => {
  it('rolls back records, observations and progress together while retaining the previous parsed snapshot', async () => {
    const { database, repository } = await fixture();
    try {
      const original = work('1');
      await repository.ingestBatch(page([original]));
      const query = vi.spyOn(database, 'query');
      const snapshotReads = () => query.mock.calls.filter(call => call[0] === 'SELECT payload FROM works').length;
      const before = await repository.listWorks({ origin: 'live' });
      expect(snapshotReads()).toBe(1);
      const incoming = page([work('1', { observedAt: SECOND, title: '未提交的更改' }), work('2', { observedAt: SECOND })]);
      const commit = vi.fn(async (transaction: Pick<PGlite, 'query'>, added: number) => {
        expect(added).toBe(1);
        const staged = await transaction.query<{ count: number }>('SELECT count(*)::int AS count FROM works');
        expect(staged.rows[0]!.count).toBe(2);
        await transaction.query("UPDATE data_settings SET value=$1::jsonb WHERE key='test_discovery_progress'", [JSON.stringify(added)]);
        throw new Error('Injected progress publication failure');
      });
      await expect(repository.ingestDiscoveryPage(incoming, commit)).rejects.toThrow('Injected progress publication failure');
      expect(commit).toHaveBeenCalledTimes(1);
      expect(await totals(database)).toEqual({ works: 1, observations: 1, progress: 0 });
      expect((await repository.getWork(original.id))?.work.title).toBe(original.title);
      expect(await repository.getWork('hongguo:2')).toBeNull();
      expect(await repository.listWorks({ origin: 'live' })).toEqual(before);
      expect(snapshotReads()).toBe(1);
    } finally { await database.close(); }
  });

  it('counts unique new identities on retry and adds neither duplicate works nor duplicate history on replay', async () => {
    const { database, repository } = await fixture();
    try {
      await repository.ingestBatch(page([work('1')]));
      const incoming = page([work('1', { observedAt: SECOND }), work('2', { observedAt: SECOND }), work('2', { observedAt: SECOND })]);
      const failedCommit = vi.fn(async (transaction: Pick<PGlite, 'query'>, added: number) => {
        expect(added).toBe(1);
        await transaction.query("UPDATE data_settings SET value='999'::jsonb WHERE key='test_discovery_progress'");
        throw new Error('Retry this page');
      });
      await expect(repository.ingestDiscoveryPage(incoming, failedCommit)).rejects.toThrow('Retry this page');
      expect(await totals(database)).toEqual({ works: 1, observations: 1, progress: 0 });
      const addedCounts: number[] = [];
      const commit = async (transaction: Pick<PGlite, 'query'>, added: number) => {
        addedCounts.push(added);
        await transaction.query(`UPDATE data_settings SET value=to_jsonb((value #>> '{}')::int+$1::int)
          WHERE key='test_discovery_progress'`, [added]);
      };
      expect(await repository.ingestDiscoveryPage(incoming, commit)).toBe(1);
      expect(await totals(database)).toEqual({ works: 2, observations: 3, progress: 1 });
      expect(await repository.ingestDiscoveryPage(incoming, commit)).toBe(0);
      expect(addedCounts).toEqual([1, 0]);
      expect(await totals(database)).toEqual({ works: 2, observations: 3, progress: 1 });
    } finally { await database.close(); }
  });

  it('keeps ranked metrics and their original dates in canonical and selection records while saving newer catalog history', async () => {
    const { database, repository } = await fixture();
    try {
      const original = work('1');
      await repository.ingestBatch(page([original]));
      const ranked = work('1', { observedAt: SECOND, rank: 8, metrics: [{ key: 'heat', label: '热度', value: 200 }], sourceUpdatedAt: '第二榜期' });
      await repository.ingestBatch(page([ranked]));
      await repository.putSelection(ranked.id, 'reviewing', '保留原榜期与指标');
      const before = (await repository.getWork(ranked.id))!;
      expect(before.work.rankChange).toBe(2);
      const catalog = work('1', { board: '', rank: null, metrics: [{ key: 'heat', label: '热度', value: null }],
        title: '目录页的新标题', observedAt: THIRD, sourceUpdatedAt: '目录时间' });
      expect(await repository.ingestDiscoveryPage(page([catalog]), async () => {})).toBe(0);
      const retained = (await repository.getWork(ranked.id))!;
      expect(retained.work).toEqual(before.work);
      expect(retained.observations).toEqual(before.observations);
      expect((await repository.listWorks({ origin: 'live' })).items).toEqual([before.work]);
      expect((await repository.selections())[0]).toMatchObject({
        work: { observedAt: SECOND, sourceUpdatedAt: '第二榜期', rank: 8, metrics: ranked.metrics },
        selection: { status: 'reviewing', note: '保留原榜期与指标' },
      });
      const history = await database.query<{ payload: Observation }>("SELECT payload FROM observations WHERE work_id=$1 AND board=''", [ranked.id]);
      expect(history.rows.map(row => row.payload)).toEqual([{ observedAt: THIRD, board: '', rank: null,
        metrics: catalog.metrics, origin: 'live', sourceUpdatedAt: '目录时间' }]);
      const catalogDetail = (await repository.getWork(ranked.id, ''))!;
      expect(catalogDetail.work).toMatchObject({ board: '', rank: null, rankChange: null,
        metrics: catalog.metrics, observedAt: THIRD, sourceUpdatedAt: '目录时间' });
      expect(catalogDetail.observations).toEqual(history.rows.map(row => row.payload));
      expect((await repository.getWork(ranked.id))?.work).toEqual(before.work);
      expect(await totals(database)).toMatchObject({ works: 1, observations: 3 });
    } finally { await database.close(); }
  });

  it('inserts and refreshes catalog-only works, then promotes a same-time ranking without deleting catalog observations', async () => {
    const { database, repository } = await fixture();
    try {
      const catalog = work('1', { board: '', rank: null, metrics: [], sourceUpdatedAt: null });
      expect(await repository.ingestDiscoveryPage(page([catalog]), async () => {})).toBe(1);
      expect((await repository.getWork(catalog.id))?.work).toMatchObject({ board: '', rank: null, metrics: [], observedAt: FIRST });
      const updated = { ...catalog, title: '更新后的目录标题', observedAt: SECOND };
      expect(await repository.ingestDiscoveryPage(page([updated]), async () => {})).toBe(0);
      expect((await repository.getWork(catalog.id))?.work).toMatchObject({ title: updated.title, board: '', observedAt: SECOND });
      const ranked = work('1', { title: '榜单确认标题', observedAt: SECOND, rank: 3,
        metrics: [{ key: 'heat', label: '热度', value: 500 }], sourceUpdatedAt: '第二榜期' });
      expect(await repository.ingestBatch(page([ranked]))).toBe(1);
      expect((await repository.getWork(catalog.id))?.work).toMatchObject({ title: ranked.title, board: ranked.board,
        rank: 3, metrics: ranked.metrics, observedAt: SECOND, sourceUpdatedAt: '第二榜期' });
      const history = await database.query<{ payload: Observation }>("SELECT payload FROM observations WHERE work_id=$1 AND board='' ORDER BY observed_at", [catalog.id]);
      expect(history.rows.map(row => row.payload.observedAt)).toEqual([FIRST, SECOND]);
      expect(await totals(database)).toMatchObject({ works: 1, observations: 3 });
    } finally { await database.close(); }
  });

  it('rejects invalid or mixed batches before calling the progress callback', async () => {
    const { database, repository } = await fixture();
    try {
      const original = work('1');
      const invalid: CollectionBatch[] = [
        { ...page([original]), works: [] },
        page([{ ...original, platform: 'fanqie' }]),
        page([{ ...original, origin: 'demo' }]),
        page([{ ...original, sourceId: 'demo-invalid' }]),
        { ...page([original]), observedAt: SECOND },
      ];
      const commit = vi.fn(async () => {});
      for (const input of invalid) await expect(repository.ingestDiscoveryPage(input, commit)).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
      expect(await totals(database)).toEqual({ works: 0, observations: 0, progress: 0 });
    } finally { await database.close(); }
  });
});
