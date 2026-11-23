import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { CollectionManager, type Collectors } from '../src/server/collection-manager.ts';
import { DiscoveryManager, type DiscoveryAdapter } from '../src/server/discovery/manager.ts';
import type { DiscoveryQueueOptions, DiscoveryTask } from '../src/server/discovery/crawler.ts';
import { DataRepository } from '../src/server/repository.ts';
import type { CollectionBatch, DiscoveryStatus, Platform, Work } from '../src/shared/types.ts';

const HOUR = 3_600_000;
const INITIAL = Date.parse('2026-11-13T06:00:00.000Z');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function task(page: number): DiscoveryTask {
  return { url: `https://example.com/public?page=${page}`, uniqueKey: `page:${page}`, data: { page } };
}

function batch(platform: Platform, ids: string[], time = INITIAL): CollectionBatch {
  const observedAt = new Date(time).toISOString();
  const works: Work[] = ids.map(sourceId => ({
    id: `${platform}:${sourceId}`, sourceId, platform,
    kind: platform === 'qimao' || platform === 'fanqie' ? 'novel' : 'drama',
    title: `公开测试作品 ${sourceId}`, author: null, description: '内存数据库分页测试', coverUrl: null,
    sourceUrl: `https://example.com/works/${sourceId}`, tags: [], category: '', episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [], rank: null, rankChange: null,
    board: '公开测试目录', origin: 'live', observedAt, sourceUpdatedAt: null,
  }));
  return { platform, works, observedAt, coverage: '隔离测试公开目录，非全库' };
}

/** Models persistent deduplication and acknowledgements while all SQL writes use real PGlite. */
function queue() {
  const pending = new Map<Platform, Map<string, DiscoveryTask>>();
  const completed = new Map<Platform, Set<string>>();
  const calls: DiscoveryQueueOptions[] = [];
  const run = vi.fn(async (options: DiscoveryQueueOptions) => {
    calls.push(options);
    const pages = pending.get(options.platform) ?? new Map<string, DiscoveryTask>();
    const done = completed.get(options.platform) ?? new Set<string>();
    pending.set(options.platform, pages); completed.set(options.platform, done);
    const enqueue = (tasks: DiscoveryTask[], priority = false) => {
      const first = new Map<string, DiscoveryTask>();
      if (priority) for (const item of tasks) if (!done.has(item.uniqueKey)) first.set(item.uniqueKey, item);
      for (const item of tasks) if (!done.has(item.uniqueKey) && !pages.has(item.uniqueKey)) pages.set(item.uniqueKey, item);
      if (priority) {
        for (const [id, item] of pages) first.set(id, item);
        pages.clear(); for (const [id, item] of first) pages.set(id, item);
      }
    };
    enqueue(options.seeds, options.prioritizeSeeds);
    let handled = 0, failed = 0;
    for (let index = 0; index < options.maxRequests && pages.size; index++) {
      if (options.signal.aborted) break;
      const [id, item] = pages.entries().next().value!;
      try { enqueue(await options.handle(item, options.signal)); handled++; }
      catch (error) {
        if (options.signal.aborted) break;
        await options.onFailed(item, error instanceof Error ? error : new Error('Page failed'));
        failed++;
      }
      pages.delete(id); done.add(id);
    }
    return { handled, failed, pending: pages.size };
  });
  return { run, calls, pending, completed };
}

type Queue = ReturnType<typeof queue>;
type Adapters = Partial<Record<Platform, DiscoveryAdapter>>;

async function fixture(adapters: Adapters, options: { clock?: { value: number }; queue?: Queue; budget?: number; collectors?: Collectors } = {}) {
  const clock = options.clock ?? { value: INITIAL };
  const database = new PGlite();
  const repository = new DataRepository(database);
  await repository.initialize({ seedDemo: false });
  const collections = new CollectionManager(repository, options.collectors ?? {}, 6 * HOUR, () => clock.value);
  const persistentQueue = options.queue ?? queue();
  const managerOptions = { directory: '/unused-injected-discovery-test', intervalMs: 6 * HOUR, pageBudget: options.budget ?? 10,
    requestsPerMinute: 30, maxRetries: 1, resumeDelayMs: 60_000, now: () => clock.value, runQueue: persistentQueue.run };
  const manager = new DiscoveryManager(repository, collections, adapters, managerOptions);
  await manager.initialize();
  return { clock, database, repository, collections, persistentQueue, managerOptions, manager,
    close: async () => { await manager.stop(); await collections.stop(); await manager.waitForIdle(); await database.close(); } };
}

async function status(manager: DiscoveryManager, platform: Platform): Promise<DiscoveryStatus> {
  return (await manager.list()).find(item => item.platform === platform)!;
}

function adapter(platform: Platform, handle: DiscoveryAdapter['handle']): DiscoveryAdapter {
  return { platform, seeds: vi.fn(async () => [task(1)]), handle };
}

describe('durable page discovery coordination', () => {
  it('publishes each page before children run and counts only newly stored live identities', async () => {
    const source = adapter('hongguo', async item => {
      if (item.data.page === 2) {
        expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'running', count: 1, newWorks: 2, lastRunNewWorks: 2,
          lastPublishedAt: new Date(INITIAL).toISOString() });
        expect((await f.repository.listWorks({ origin: 'live' })).total).toBe(2);
      }
      return { batch: batch('hongguo', item.data.page === 1 ? ['1', '2'] : ['2', '3']),
        next: item.data.page === 1 ? [task(2)] : [], coverage: `公开测试页 ${item.data.page}，非全库` };
    });
    const f = await fixture({ hongguo: source });
    const ingestion = f.repository.ingestDiscoveryPage.bind(f.repository);
    const addedCounts: number[] = [];
    const counts: number[] = [];
    vi.spyOn(f.repository, 'ingestDiscoveryPage').mockImplementation((input, commit) => ingestion(input, async (client, added) => {
      const stored = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM works WHERE payload->>'platform'=$1 AND payload->>'origin'='live'", [input.platform]);
      counts.push(stored.rows[0]!.count); addedCounts.push(added);
      await commit(client, added);
    }));
    try {
      await f.manager.tick();
      expect(counts).toEqual([2, 3]);
      expect(addedCounts).toEqual([2, 1]);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'success', count: 2, newWorks: 3, lastRunNewWorks: 3,
        pending: 0, failed: 0, lastPublishedAt: new Date(INITIAL + 1).toISOString(), nextRunAt: new Date(INITIAL + 6 * HOUR).toISOString() });
      expect((await f.repository.listWorks({ origin: 'live' })).total).toBe(3);
      expect(f.persistentQueue.calls[0]).toMatchObject({ platform: 'hongguo', maxRequests: 10, maxRequestsPerMinute: 30, maxRetries: 1 });
    } finally { await f.close(); }
  });

  it('rolls back a page when progress publication fails, then retries without missing or duplicating new works', async () => {
    const visits: number[] = [];
    const source = adapter('hongguo', async item => {
      const page = Number(item.data.page); visits.push(page);
      return { batch: batch('hongguo', page === 1 ? ['existing', 'new-1', 'new-1', 'new-2'] : ['new-1', 'new-2']),
        next: page === 1 ? [task(2)] : [], coverage: '原子发布测试目录' };
    });
    const f = await fixture({ hongguo: source }, { budget: 1 });
    try {
      await f.repository.ingestBatch(batch('hongguo', ['existing']));
      await f.repository.listWorks({ origin: 'live' });
      await f.database.exec(`CREATE FUNCTION reject_discovery_progress() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.key='discovery_state_v1:hongguo' AND (NEW.value #>> '{status,count}')::integer > (OLD.value #>> '{status,count}')::integer
          THEN RAISE EXCEPTION 'injected discovery progress failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_discovery_progress BEFORE UPDATE ON data_settings FOR EACH ROW EXECUTE FUNCTION reject_discovery_progress();`);
      await f.manager.tick();
      expect(visits).toEqual([1]);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'failed', count: 0, newWorks: 0, lastRunNewWorks: 0,
        failed: 1, lastPublishedAt: null });
      expect((await f.repository.listWorks({ origin: 'live' })).total).toBe(1);
      expect(await f.repository.countLiveWorks('hongguo')).toBe(1);
      const history = await f.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM observations WHERE work_id LIKE 'hongguo:new-%'");
      expect(history.rows[0]!.count).toBe(0);
      await f.database.exec('DROP TRIGGER reject_discovery_progress ON data_settings; DROP FUNCTION reject_discovery_progress();');
      expect(await status(f.manager, 'hongguo')).toMatchObject({ nextRunAt: new Date(INITIAL + 6 * HOUR).toISOString() });
      f.clock.value = INITIAL + 6 * HOUR; await f.manager.tick();
      expect(visits).toEqual([1, 1]);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'failed', count: 1, newWorks: 2, lastRunNewWorks: 2,
        failed: 1, pending: 2, lastPublishedAt: new Date(f.clock.value).toISOString() });
      expect(await f.repository.countLiveWorks('hongguo')).toBe(3);
      f.clock.value += 60_000; await f.manager.tick();
      expect(visits).toEqual([1, 1, 1]);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ count: 2, newWorks: 2, lastRunNewWorks: 0, pending: 1, failed: 0 });
      f.clock.value += 60_000; await f.manager.tick();
      expect(visits).toEqual([1, 1, 1, 2]);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'success', count: 3, newWorks: 2, lastRunNewWorks: 0, pending: 0, failed: 0 });
      const repeated = await f.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM observations WHERE work_id LIKE 'hongguo:new-%'");
      expect(repeated.rows[0]!.count).toBe(2);
    } finally { await f.close(); }
  });

  it('retries an exhausted page once per cycle with separate round keys instead of on every short resume', async () => {
    let allowSecondPage = false;
    const keys: string[] = [];
    const source = adapter('qimao', async item => {
      if (item.data.page === 2) { keys.push(item.uniqueKey); if (!allowSecondPage) throw new Error('Remote failed'); }
      return { batch: batch('qimao', [String(item.data.page)]), next: item.data.page === 1 ? [task(2), task(3)] : [], coverage: '七猫公开测试三页' };
    });
    const f = await fixture({ qimao: source }, { budget: 2 });
    try {
      await f.manager.tick();
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'failed', count: 1, newWorks: 1, failed: 1, pending: 1,
        lastSuccessAt: null, lastPublishedAt: new Date(INITIAL).toISOString(), nextRunAt: new Date(INITIAL + 60_000).toISOString() });
      const saved = await f.database.query<{ task: DiscoveryTask }>("SELECT task FROM discovery_failures WHERE platform='qimao'");
      expect(saved.rows.map(row => row.task.data)).toEqual([{ page: 2 }]);
      // Unfinished history still resumes after the short delay, but the failed page waits for the next cycle.
      f.clock.value += 60_000; await f.manager.tick();
      expect(keys).toEqual(['page:2']);
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'failed', count: 2, newWorks: 2, failed: 1, pending: 0,
        nextRunAt: new Date(INITIAL + 6 * HOUR).toISOString(), message: expect.stringContaining('待重试 1 页（下个周期或手动继续时重试）') });
      f.clock.value += 60_000; await f.manager.tick();
      expect(keys).toEqual(['page:2']);
      // An administrator's explicit continuation retries the failed page within the same cycle.
      expect(await f.manager.request('qimao')).toBe(true); await f.collections.waitForIdle();
      expect(keys[1]).toMatch(/^retry:qimao:.+:1$/);
      f.clock.value = INITIAL + 6 * HOUR; await f.manager.tick();
      expect(keys[2]).toMatch(/^retry:qimao:.+:2$/);
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'failed', failed: 1, lastRunNewWorks: 0,
        nextRunAt: new Date(INITIAL + 12 * HOUR).toISOString() });
      expect((await f.repository.listWorks({ origin: 'live' })).total).toBe(2);
      allowSecondPage = true; f.clock.value = INITIAL + 12 * HOUR;
      await f.manager.tick();
      expect(keys[3]).toMatch(/^retry:qimao:.+:3$/);
      expect(new Set(keys).size).toBe(4);
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'success', newWorks: 3, failed: 0, lastRunNewWorks: 1 });
      expect(source.seeds).toHaveBeenCalledTimes(3);
    } finally { await f.close(); }
  });

  it('resumes bounded batches at the saved short delay after restart and refreshes keys only in a new cycle', async () => {
    const source = adapter('fanqie', async item => ({ batch: batch('fanqie', [String(item.data.page)]),
      next: item.data.page === 1 ? [task(2)] : [], coverage: '番茄公开目录测试页' }));
    const f = await fixture({ fanqie: source }, { budget: 1 });
    let restarted: DiscoveryManager | undefined;
    let collections: CollectionManager | undefined;
    try {
      await f.manager.tick();
      expect(await status(f.manager, 'fanqie')).toMatchObject({ count: 1, pending: 1, nextRunAt: new Date(INITIAL + 60_000).toISOString() });
      const firstSeed = f.persistentQueue.calls[0]!.seeds[0]!.uniqueKey;
      await f.manager.stop(); await f.collections.stop();
      f.clock.value += 30_000;
      collections = new CollectionManager(f.repository, {});
      restarted = new DiscoveryManager(f.repository, collections, { fanqie: source }, f.managerOptions);
      await restarted.initialize();
      await restarted.tick(); expect(f.persistentQueue.run).toHaveBeenCalledTimes(1);
      f.clock.value += 30_000; await restarted.tick();
      expect(await status(restarted, 'fanqie')).toMatchObject({ count: 2, newWorks: 2, lastRunNewWorks: 1, pending: 0,
        nextRunAt: new Date(INITIAL + 6 * HOUR).toISOString() });
      expect(f.persistentQueue.calls[1]!.seeds[0]!.uniqueKey).toBe(firstSeed);
      expect(source.seeds).toHaveBeenCalledTimes(1);
      f.clock.value = INITIAL + 6 * HOUR; await restarted.tick();
      expect(source.seeds).toHaveBeenCalledTimes(2);
      expect(f.persistentQueue.calls[2]!.seeds[0]!.uniqueKey).not.toBe(firstSeed);
      expect(await status(restarted, 'fanqie')).toMatchObject({ count: 3, newWorks: 2, lastRunNewWorks: 0, pending: 0 });
    } finally { await restarted?.stop(); await collections?.stop(); await f.close(); }
  });

  it('retains published progress and the cursor after queue interruption and recovers a running state on restart', async () => {
    const source = adapter('hongguo', async item => ({ batch: batch('hongguo', [String(item.data.page)]),
      next: item.data.page === 1 ? [task(2)] : [], coverage: '测试公开目录' }));
    const f = await fixture({ hongguo: source }, { budget: 1 });
    const originalRun = f.persistentQueue.run.getMockImplementation()!;
    f.persistentQueue.run.mockImplementationOnce(async options => { await originalRun(options); throw new Error('Queue interrupted'); });
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
    let restarted: DiscoveryManager | undefined;
    try {
      await f.manager.tick();
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'failed', count: 1, newWorks: 1, lastRunNewWorks: 1,
        lastPublishedAt: new Date(INITIAL).toISOString() });
      expect(f.persistentQueue.pending.get('hongguo')!.size).toBe(1);
      await f.manager.stop();
      await f.database.query("UPDATE data_settings SET value=jsonb_set(value,'{status,state}','\"running\"'::jsonb) WHERE key='discovery_state_v1:hongguo'");
      restarted = new DiscoveryManager(f.repository, f.collections, { hongguo: source }, f.managerOptions);
      await restarted.initialize();
      expect(await status(restarted, 'hongguo')).toMatchObject({ state: 'failed', count: 1, newWorks: 1,
        message: expect.stringContaining('上次发现任务中停止') });
      f.clock.value += 60_000; await restarted.tick();
      expect(await status(restarted, 'hongguo')).toMatchObject({ state: 'success', count: 2, newWorks: 2, pending: 0 });
      expect(source.seeds).toHaveBeenCalledTimes(1);
    } finally { logging.mockRestore(); await restarted?.stop(); await f.close(); }
  });

  it('prioritizes fresh cycle entry points while retaining stable unfinished history pages', async () => {
    const visits: string[] = [];
    const source: DiscoveryAdapter = {
      platform: 'qimao',
      seeds: vi.fn(async cycle => [{ ...task(1), data: { page: 1, cycle } }]),
      handle: async item => {
        visits.push(item.data.page === 1 ? `latest:${item.data.cycle}` : 'history:2');
        return { batch: batch('qimao', [item.data.page === 1 ? `latest-${item.data.cycle}` : 'history-2']),
          next: item.data.page === 1 ? [task(2)] : [], coverage: '公开最新入口与历史分页' };
      },
    };
    const f = await fixture({ qimao: source }, { budget: 1 });
    try {
      await f.manager.tick();
      expect([...f.persistentQueue.pending.get('qimao')!.keys()]).toEqual(['page:2']);
      f.clock.value += 6 * HOUR; await f.manager.tick();
      expect(source.seeds).toHaveBeenCalledTimes(2);
      expect(visits).toEqual([`latest:${6 * HOUR}:${Math.floor(INITIAL / (6 * HOUR))}`,
        `latest:${6 * HOUR}:${Math.floor(f.clock.value / (6 * HOUR))}`]);
      expect(f.persistentQueue.calls[1]!.prioritizeSeeds).toBe(true);
      expect([...f.persistentQueue.pending.get('qimao')!.keys()]).toEqual(['page:2']);
      expect(await status(f.manager, 'qimao')).toMatchObject({ count: 2, newWorks: 2, pending: 1 });
      f.clock.value += 60_000; await f.manager.tick();
      expect(visits[2]).toBe('history:2');
      expect(f.persistentQueue.calls[2]!.prioritizeSeeds).toBe(true);
      expect(await status(f.manager, 'qimao')).toMatchObject({ count: 3, newWorks: 3, pending: 0 });
    } finally { await f.close(); }
  });

  it('recovers a crash before the first cycle was saved and regenerates seeds', async () => {
    const source = adapter('hongguo', async () => ({ batch: batch('hongguo', ['1']), next: [], coverage: '公开测试页' }));
    const f = await fixture({ hongguo: source });
    let restarted: DiscoveryManager | undefined;
    try {
      await f.manager.stop();
      await f.database.query("UPDATE data_settings SET value=jsonb_set(value,'{status,state}','\"running\"'::jsonb) WHERE key='discovery_state_v1:hongguo'");
      restarted = new DiscoveryManager(f.repository, f.collections, { hongguo: source }, f.managerOptions);
      await restarted.initialize();
      expect(await status(restarted, 'hongguo')).toMatchObject({ state: 'failed', count: 0, nextRunAt: new Date(INITIAL).toISOString() });
      await restarted.tick();
      expect(source.seeds).toHaveBeenCalledTimes(1);
      expect(await status(restarted, 'hongguo')).toMatchObject({ state: 'success', count: 1, newWorks: 1 });
    } finally { await restarted?.stop(); await f.close(); }
  });

  it('keeps saved fresh entry seeds ahead of historical work after a crash before enqueue', async () => {
    const visits: unknown[] = [];
    const source = adapter('hongguo', async item => {
      visits.push(item.data.page);
      return { next: [], coverage: '公开入口与历史待办' };
    });
    const f = await fixture({ hongguo: source }, { budget: 1 });
    let restarted: DiscoveryManager | undefined;
    try {
      await f.manager.stop();
      const previous = await status(f.manager, 'hongguo');
      const cycle = `${6 * HOUR}:${Math.floor(INITIAL / (6 * HOUR))}`;
      await f.database.query('UPDATE data_settings SET value=value || $1::jsonb WHERE key=$2', [JSON.stringify({
        cycle, complete: false, seeds: [task(1)], status: { ...previous, state: 'running' },
      }), 'discovery_state_v1:hongguo']);
      f.persistentQueue.pending.set('hongguo', new Map([['page:2', task(2)]]));
      restarted = new DiscoveryManager(f.repository, f.collections, { hongguo: source }, f.managerOptions);
      await restarted.initialize();
      expect(await restarted.request('hongguo')).toBe(true);
      await f.collections.waitForIdle();
      expect(visits).toEqual([1]);
      expect(f.persistentQueue.calls[0]?.prioritizeSeeds).toBe(true);
      expect([...f.persistentQueue.pending.get('hongguo')!.keys()]).toEqual(['page:2']);
    } finally { await restarted?.stop(); await f.close(); }
  });

  it('does not hold other platforms behind a blocked or failed platform', async () => {
    const started = deferred(), release = deferred(), qimaoFinished = deferred();
    const f = await fixture({
      hongguo: adapter('hongguo', async () => { started.resolve(); await release.promise; throw new Error('One source failed'); }),
      qimao: adapter('qimao', async () => { qimaoFinished.resolve(); return { batch: batch('qimao', ['1']), next: [], coverage: '公开单页' }; }),
    });
    let ticking: Promise<void> | undefined;
    try {
      ticking = f.manager.tick();
      await started.promise; await qimaoFinished.promise;
      // The sibling workflow has its own publication and persistence work after extraction.
      for (let index = 0; index < 20 && (await status(f.manager, 'qimao')).state !== 'success'; index++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'success', count: 1, newWorks: 1 });
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'running', count: 0 });
      release.resolve(); await ticking;
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'failed', failed: 1 });
    } finally { release.resolve(); await ticking; await f.close(); }
  });

  it('shares the collector lock and rejects overlapping manual and scheduled discovery claims', async () => {
    const releaseRanking = deferred(), releaseDiscovery = deferred(), discoveryStarted = deferred();
    const f = await fixture({ hongguo: adapter('hongguo', async () => {
      discoveryStarted.resolve(); await releaseDiscovery.promise; return { next: [], coverage: '公开页面没有作品' };
    }) }, { collectors: { hongguo: async () => { await releaseRanking.promise; return batch('hongguo', ['ranking']); } } });
    try {
      expect(await f.collections.request('hongguo')).toBe(true);
      expect(await f.manager.request('hongguo')).toBe(false);
      releaseRanking.resolve(); await f.collections.waitForIdle();
      expect(await Promise.all([f.manager.request('hongguo'), f.manager.request('hongguo')])).toEqual([true, false]);
      await discoveryStarted.promise; await f.manager.tick();
      expect(await f.collections.request('hongguo')).toBe(false);
      expect(f.persistentQueue.run).toHaveBeenCalledTimes(1);
      releaseDiscovery.resolve(); await f.manager.waitForIdle();
      expect(await status(f.manager, 'hongguo')).toMatchObject({ count: 1, newWorks: 0, lastPublishedAt: null });
    } finally { releaseRanking.resolve(); releaseDiscovery.resolve(); await f.close(); }
  });

  it('stops its timer without waiting for workflows, then lets CollectionManager abort and join them', async () => {
    const started = deferred(); let observedSignal: AbortSignal | undefined;
    const f = await fixture({ hongguo: adapter('hongguo', async (_task, signal) => {
      observedSignal = signal; started.resolve();
      await new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      return { next: [], coverage: '不会发布' };
    }) });
    try {
      await f.manager.request('hongguo'); await started.promise;
      await f.manager.stop(); expect(observedSignal!.aborted).toBe(false);
      await f.collections.stop(); await f.manager.waitForIdle();
      expect(observedSignal!.aborted).toBe(true);
      expect(await status(f.manager, 'hongguo')).toMatchObject({ state: 'failed', pending: 1, failed: 0, count: 0, newWorks: 0 });
      expect(await f.manager.request('hongguo')).toBe(false);
      expect(f.persistentQueue.pending.get('hongguo')!.size).toBe(1);
    } finally { await f.close(); }
  });

  it('preserves a pending cycle and its tasks when the administrator changes the interval', async () => {
    const source = adapter('fanqie', async item => ({ batch: batch('fanqie', [String(item.data.page)]),
      next: item.data.page === 1 ? [task(2)] : [], coverage: '公开测试页' }));
    const f = await fixture({ fanqie: source }, { budget: 1 });
    try {
      await f.manager.tick();
      const before = await f.database.query<{ value: { cycle: string; seeds: DiscoveryTask[] } }>("SELECT value FROM data_settings WHERE key='discovery_state_v1:fanqie'");
      await f.manager.setIntervalHours(12);
      const after = await f.database.query<{ value: { cycle: string; seeds: DiscoveryTask[]; intervalMs: number } }>("SELECT value FROM data_settings WHERE key='discovery_state_v1:fanqie'");
      expect(after.rows[0]!.value).toMatchObject({ cycle: before.rows[0]!.value.cycle, seeds: before.rows[0]!.value.seeds, intervalMs: 12 * HOUR });
      expect(f.persistentQueue.pending.get('fanqie')!.size).toBe(1);
      f.clock.value += 60_000; await f.manager.tick();
      expect(await status(f.manager, 'fanqie')).toMatchObject({ count: 2, newWorks: 1, pending: 1 });
      expect(source.seeds).toHaveBeenCalledTimes(2);
      expect([...f.persistentQueue.pending.get('fanqie')!.keys()]).toEqual(['page:2']);
      f.clock.value += 60_000; await f.manager.tick();
      expect(await status(f.manager, 'fanqie')).toMatchObject({ count: 3, newWorks: 2, pending: 0 });
      await f.manager.setIntervalHours(24);
      expect((await status(f.manager, 'fanqie')).nextRunAt).toBe(new Date(f.clock.value + 24 * HOUR).toISOString());
      for (const invalid of [0, 1.5, 169]) await expect(f.manager.setIntervalHours(invalid)).rejects.toThrow();
    } finally { await f.close(); }
  });

  it('keeps all platforms visibly unconfigured until explicit adapters exist', async () => {
    const f = await fixture({});
    try {
      expect(await f.manager.list()).toHaveLength(4);
      for (const item of await f.manager.list()) expect(item).toMatchObject({ state: 'not_configured', count: 0, newWorks: 0,
        lastSuccessAt: null, lastPublishedAt: null, nextRunAt: null, coverage: '尚无真实发现覆盖' });
      await f.manager.tick();
      await expect(f.manager.request('hongguo')).rejects.toThrow('尚未配置发现入口');
      expect(f.persistentQueue.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('keeps more than a hundred failed pages, finishes the queue and does not request them again on short resumes', async () => {
    const attempts: number[] = [];
    const source = adapter('qimao', async item => {
      if (item.data.page === 1) return { next: Array.from({ length: 130 }, (_, index) => task(index + 2)), coverage: '七猫公开测试多页' };
      attempts.push(Number(item.data.page));
      throw Object.assign(new Error('Rendered page differs from its state'), { retryable: false });
    });
    const f = await fixture({ qimao: source }, { budget: 200 });
    try {
      await f.manager.tick();
      expect(await status(f.manager, 'qimao')).toMatchObject({ state: 'failed', failed: 130, pending: 0 });
      expect(attempts).toHaveLength(130);
      expect((await f.database.query<{ total: number }>("SELECT count(*)::integer AS total FROM discovery_failures WHERE platform='qimao'")).rows[0]!.total).toBe(130);
      f.clock.value += 60_000; await f.manager.tick();
      f.clock.value += 60_000; await f.manager.tick();
      expect(attempts).toHaveLength(130);
      f.clock.value = INITIAL + 6 * HOUR; await f.manager.tick();
      expect(attempts).toHaveLength(260);
    } finally { await f.close(); }
  });

  it('moves failed pages saved in the earlier settings record into the failure table on start', async () => {
    const f = await fixture({ qimao: adapter('qimao', async () => ({ next: [], coverage: '七猫公开测试' })) });
    try {
      const legacy = [{ task: task(7), round: 1, retryKey: null }, { task: task(8), round: 0, retryKey: 'retry:qimao:legacy:1' }];
      await f.database.query("UPDATE data_settings SET value=jsonb_set(jsonb_set(value,'{failures}',$1::jsonb),'{status,failed}','2') WHERE key='discovery_state_v1:qimao'", [JSON.stringify(legacy)]);
      const restarted = new DiscoveryManager(f.repository, f.collections, { qimao: adapter('qimao', async () => ({ next: [], coverage: '七猫公开测试' })) }, f.managerOptions);
      await restarted.initialize();
      const rows = await f.database.query<{ unique_key: string; round: number; retry_key: string | null }>("SELECT unique_key,round,retry_key FROM discovery_failures WHERE platform='qimao' ORDER BY unique_key");
      expect(rows.rows).toEqual([{ unique_key: 'page:7', round: 1, retry_key: null }, { unique_key: 'page:8', round: 0, retry_key: 'retry:qimao:legacy:1' }]);
      const saved = await f.database.query<{ value: { failures: unknown[] } }>("SELECT value FROM data_settings WHERE key='discovery_state_v1:qimao'");
      expect(saved.rows[0]!.value.failures).toEqual([]);
      expect(await status(restarted, 'qimao')).toMatchObject({ failed: 2 });
    } finally { await f.close(); }
  });

  it('rejects invalid persisted JSON without replacing the record or queue', async () => {
    const f = await fixture({});
    try {
      await f.database.query("UPDATE data_settings SET value=value || '{\"unexpected\":true}'::jsonb WHERE key='discovery_state_v1:hongguo'");
      const restarted = new DiscoveryManager(f.repository, f.collections, {}, f.managerOptions);
      await expect(restarted.initialize()).rejects.toThrow('Invalid saved discovery state: hongguo');
      const saved = await f.database.query<{ value: { unexpected: boolean } }>("SELECT value FROM data_settings WHERE key='discovery_state_v1:hongguo'");
      expect(saved.rows[0]!.value.unexpected).toBe(true);
      expect(f.persistentQueue.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
