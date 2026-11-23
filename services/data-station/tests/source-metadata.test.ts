import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import type { Work } from '../src/shared/types.ts';

it('retains official rank and metrics with a null title when source details are unavailable', async () => {
  const database = new PGlite();
  try {
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const work: Work = { id: 'fanqie:7682593135821589528', sourceId: '7682593135821589528', platform: 'fanqie', kind: 'novel',
      title: null, author: null, description: '', coverUrl: null, sourceUrl: 'https://fanqienovel.com/page/7682593135821589528',
      tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
      metrics: [{ key: 'currentReaders', label: '在读人数', value: 1234 }], rank: 99, rankChange: null,
      board: '官方测试分类榜', origin: 'live', observedAt: '2026-11-13T10:00:00.000Z', sourceUpdatedAt: '官方榜期',
      metadataStatus: 'unavailable', metadataNote: '官网查无此书，详情暂不可用；保留官方榜单记录。' };
    await repository.ingestBatch({ platform: 'fanqie', works: [work], observedAt: work.observedAt, coverage: '真实ID结构的隔离测试，不访问平台' });
    const { app } = createApp({ repository });
    const catalog = await (await app.request('http://127.0.0.1:4317/api/works?platform=fanqie')).json();
    expect(catalog.items[0]).toMatchObject({ title: null, sourceId: work.sourceId, rank: 99, metadataStatus: 'unavailable', metadataNote: work.metadataNote, topics: [] });
    const detail = await (await app.request(`http://127.0.0.1:4317/api/works/${encodeURIComponent(work.id)}`)).json();
    expect(detail.work.title).toBeNull();
    expect(detail.work.metrics[0].value).toBe(1234);
    expect((await repository.listWorks({ platform: 'fanqie', q: '作品资料暂不可用' })).total).toBe(0);
    const exported = await (await app.request('http://127.0.0.1:4317/api/export?platform=fanqie')).text();
    expect(exported).toContain('"作品资料状态","作品资料说明"');
    expect(exported.split('\r\n')[1]).toMatch(/^"","番茄小说"/);
    expect(exported).toContain('"unavailable"');
    expect(exported).not.toContain('作品资料暂不可用');
    for (const invalid of [{ ...work, metadataStatus: undefined }, { ...work, metadataStatus: 'verified' }, { ...work, metadataNote: '' }, { ...work, metadataNote: '   ' }]) {
      await expect(repository.ingestBatch({ platform: 'fanqie', works: [invalid as Work], observedAt: work.observedAt, coverage: '拒绝无标记空标题' })).rejects.toThrow();
    }
    const next: Work = { ...work, id: 'fanqie:7682593135821589529', sourceId: '7682593135821589529', title: '另一部在榜作品',
      metadataStatus: 'verified', metadataNote: undefined, rank: 1, observedAt: '2026-11-14T10:00:00.000Z' };
    await repository.ingestBatch({ platform: 'fanqie', works: [next], observedAt: next.observedAt, coverage: '下一批榜单，原作品掉榜' });
    expect((await repository.listWorks({ platform: 'fanqie', q: work.sourceId })).items[0]?.title).toBeNull();
    const historical = await app.request(`http://127.0.0.1:4317/api/works/${encodeURIComponent(work.id)}?board=${encodeURIComponent(work.board)}`);
    expect(historical.status).toBe(200);
    expect((await historical.json()).work).toMatchObject({ observedAt: work.observedAt, rank: 99, rankChange: null });
    const retained = await app.request(`http://127.0.0.1:4317/api/works/${encodeURIComponent(work.id)}`);
    expect(retained.status).toBe(200);
    expect((await retained.json()).work.observedAt).toBe(work.observedAt);
  } finally { await database.close(); }
});
