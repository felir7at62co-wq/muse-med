import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { sliceText } from '../src/shared/text.ts';
import { classifyTopics } from '../src/server/taxonomy.ts';
import { DataRepository } from '../src/server/repository.ts';
import type { Work } from '../src/shared/types.ts';

describe('text cut for JSON storage', () => {
  it('never separates a surrogate pair at either end', () => {
    expect(sliceText('a🔥b', 2)).toBe('b');
    expect(sliceText('a🔥b', 0, 2)).toBe('a');
    expect(sliceText('a🔥b', 1, 3)).toBe('🔥');
    expect(sliceText('普通文本', -5, 99)).toBe('普通文本');
    expect(sliceText('🔥', 1, 1)).toBe('');
  });

  it('keeps topic evidence well formed beside emoji, so a work with emoji in its synopsis can be stored', async () => {
    // The old evidence window started 12 code units before the match, which here is the second half of 💼.
    const description = `💼${'剧'.repeat(11)}系统觉醒${'🔥'.repeat(14)}`;
    const topics = classifyTopics({ title: '测试', description, tags: [] });
    const evidence = topics.find(topic => topic.id === 'system')!.evidence;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(evidence)).toBe(false);
    expect(evidence).toContain('系统觉醒');
    const database = new PGlite(); const repository = new DataRepository(database);
    try {
      await repository.initialize({ seedDemo: false });
      const observedAt = '2026-11-15T04:00:00.000Z';
      const work: Work = { id: 'fanqie:7704177730291502142', sourceId: '7704177730291502142', platform: 'fanqie', kind: 'novel', title: '改字篡命', author: '作者',
        description, coverUrl: null, sourceUrl: 'https://fanqienovel.com/page/7704177730291502142', tags: [], category: '', episodeCount: null, wordCount: null,
        serialStatus: null, publishedAt: null, metrics: [{ key: 'currentReaders', label: '在读人数', value: null }], rank: null, rankChange: null, board: '', origin: 'live', observedAt, sourceUpdatedAt: null };
      await repository.ingestDiscoveryPage({ platform: 'fanqie', observedAt, coverage: '目录', works: [work] }, async () => {});
      expect((await repository.getWork(work.id))!.work.topics!.find(topic => topic.id === 'system')!.evidence).toBe(evidence);
    } finally { await database.close(); }
  });
});
