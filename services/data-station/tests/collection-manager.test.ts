import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { CollectionManager, type Collectors } from '../src/server/collection-manager.ts';
import { DataRepository } from '../src/server/repository.ts';
import type { CollectionBatch, CollectorStatus, Platform, Work } from '../src/shared/types.ts';

const HOUR = 3_600_000;
const INITIAL_TIME = Date.parse('2026-11-13T06:00:00.000Z');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function batch(platform: Platform, time: number, rank = 1): CollectionBatch {
  const observedAt = new Date(time).toISOString();
  const work: Work = {
    id: `${platform}:9000000000000000001`, sourceId: '9000000000000000001', platform,
    kind: platform === 'qimao' || platform === 'fanqie' ? 'novel' : 'drama',
    title: `${platform}采集测试作品`, author: null, description: '独立内存数据库测试',
    coverUrl: null, sourceUrl: 'https://example.com/public-metadata', tags: [], category: '',
    episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [{ key: 'sourceCount', label: '来源指标', value: null }], rank, rankChange: null,
    board: '公开测试榜', origin: 'live', observedAt, sourceUpdatedAt: null,
  };
  return { platform, works: [work], observedAt, coverage: '单个明确测试窗口，非全库' };
}

async function status(repository: DataRepository, platform: Platform): Promise<CollectorStatus> {
  const result = (await repository.collectors()).find(item => item.platform === platform);
  if (!result) throw new Error(`Missing ${platform} status`);
  return result;
}

async function fixture(collectors: Collectors, clock: { value: number }, intervalMs = 6 * HOUR) {
  const database = new PGlite();
  const repository = new DataRepository(database);
  await repository.initialize({ seedDemo: false });
  const manager = new CollectionManager(repository, collectors, intervalMs, () => clock.value);
  await manager.initialize();
  return { database, repository, manager };
}

function waitUntilAborted(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
}

describe('durable six-hour collection coordination', () => {
  it('shares the platform lock with discovery and drains discovery cleanup on shutdown', async () => {
    const clock = { value: INITIAL_TIME };
    const started = deferred();
    let aborted = false;
    const { manager, database } = await fixture({ hongguo: async () => batch('hongguo', clock.value) }, clock);
    try {
      expect(await manager.requestTask('hongguo', async signal => {
        started.resolve();
        try { await waitUntilAborted(signal); }
        catch (_error) { aborted = true; }
      })).toBe(true);
      await started.promise;
      expect(await manager.request('hongguo')).toBe(false);
      expect(await manager.requestTask('hongguo', async () => {})).toBe(false);
      await manager.stop();
      expect(aborted).toBe(true);
      expect(await manager.requestTask('hongguo', async () => {})).toBe(false);
    } finally { await manager.stop(); await database.close(); }
  });

  it('releases discovery ownership after a task throws before returning its promise', async () => {
    const clock = { value: INITIAL_TIME };
    const { manager, database } = await fixture({ hongguo: async () => batch('hongguo', clock.value) }, clock);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await manager.requestTask('hongguo', () => { throw new Error('test task failed'); })).toBe(true);
      await manager.waitForIdle();
      expect(await manager.request('hongguo')).toBe(true);
      await manager.waitForIdle();
    } finally { await manager.stop(); await database.close(); error.mockRestore(); }
  });

  it('runs an initial due source and waits six injected-clock hours before the next run', async () => {
    const clock = { value: INITIAL_TIME };
    let calls = 0;
    const { manager, repository, database } = await fixture({ hongguo: async () => { calls++; return batch('hongguo', clock.value); } }, clock);
    try {
      expect(manager.intervalMs).toBe(6 * HOUR);
      await manager.tick();
      expect(calls).toBe(1);
      expect((await status(repository, 'hongguo')).nextRunAt).toBe(new Date(INITIAL_TIME + 6 * HOUR).toISOString());
      clock.value = INITIAL_TIME + 6 * HOUR - 1;
      await manager.tick();
      expect(calls).toBe(1);
      clock.value++;
      await manager.tick();
      expect(calls).toBe(2);
      expect((await status(repository, 'hongguo')).nextRunAt).toBe(new Date(INITIAL_TIME + 12 * HOUR).toISOString());
    } finally { await manager.stop(); await database.close(); }
  });

  it('keeps the persisted next run across a manager restart and resumes when it becomes due', async () => {
    const clock = { value: INITIAL_TIME };
    let calls = 0;
    const collectors: Collectors = { qimao: async () => { calls++; return batch('qimao', clock.value); } };
    const { manager, repository, database } = await fixture(collectors, clock);
    let restarted: CollectionManager | undefined;
    try {
      await manager.tick();
      const expected = (await status(repository, 'qimao')).nextRunAt;
      await manager.stop();
      clock.value += 2 * HOUR;
      const reopened = new DataRepository(database);
      await reopened.initialize({ seedDemo: false });
      restarted = new CollectionManager(reopened, collectors, 6 * HOUR, () => clock.value);
      await restarted.initialize();
      expect((await status(reopened, 'qimao')).nextRunAt).toBe(expected);
      await restarted.tick();
      expect(calls).toBe(1);
      clock.value = INITIAL_TIME + 6 * HOUR;
      await restarted.tick();
      expect(calls).toBe(2);
    } finally { await restarted?.stop(); await manager.stop(); await database.close(); }
  });

  it('admits one job when manual and scheduled attempts overlap on the same source', async () => {
    const clock = { value: INITIAL_TIME };
    const release = deferred();
    let calls = 0;
    const { manager, database } = await fixture({ hongguo: async signal => {
      calls++;
      await Promise.race([release.promise, waitUntilAborted(signal)]);
      return batch('hongguo', clock.value);
    } }, clock);
    try {
      const outcomes = await Promise.all([manager.request('hongguo'), manager.request('hongguo')]);
      expect(outcomes).toEqual([true, false]);
      await manager.tick();
      expect(calls).toBe(1);
      release.resolve();
      await manager.waitForIdle();
      expect(calls).toBe(1);
    } finally { release.resolve(); await manager.stop(); await database.close(); }
  });

  it('rechecks a later source after a manual run completes while the earlier scheduled source is waiting', async () => {
    const clock = { value: INITIAL_TIME };
    const releaseHongguo = deferred();
    const hongguoStarted = deferred();
    const qimaoSaved = deferred();
    let qimaoCalls = 0;
    const { manager, repository, database } = await fixture({
      hongguo: async signal => {
        hongguoStarted.resolve();
        await Promise.race([releaseHongguo.promise, waitUntilAborted(signal)]);
        return batch('hongguo', clock.value);
      },
      qimao: async () => { qimaoCalls++; return batch('qimao', clock.value); },
    }, clock);
    const patch = repository.patchCollector.bind(repository);
    vi.spyOn(repository, 'patchCollector').mockImplementation(async (platform, fields) => {
      await patch(platform, fields);
      if (platform === 'qimao' && fields.state === 'success') qimaoSaved.resolve();
    });
    let ticking: Promise<void> | undefined;
    try {
      ticking = manager.tick();
      await hongguoStarted.promise;
      expect(await manager.request('qimao')).toBe(true);
      await qimaoSaved.promise;
      // The event-loop turn lets the already-persisted manual job finish its promise cleanup.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(qimaoCalls).toBe(1);
      expect(Date.parse((await status(repository, 'qimao')).nextRunAt!)).toBeGreaterThan(clock.value);
      releaseHongguo.resolve();
      await ticking;
      expect(qimaoCalls).toBe(1);
    } finally { releaseHongguo.resolve(); await manager.stop(); await ticking; await database.close(); }
  });

  it('preserves successful records after a source fails and continues with the next due platform', async () => {
    const clock = { value: INITIAL_TIME };
    let qimaoCalls = 0;
    const { manager, repository, database } = await fixture({
      hongguo: async () => { throw new Error('红果测试来源不可用'); },
      qimao: async () => { qimaoCalls++; return batch('qimao', clock.value); },
    }, clock);
    const old = batch('hongguo', INITIAL_TIME - HOUR, 5);
    try {
      await repository.ingestBatch(old);
      await repository.patchCollector('hongguo', { state: 'success', count: 1, coverage: '已有成功范围', lastSuccessAt: old.observedAt });
      await manager.tick();
      const failed = await status(repository, 'hongguo');
      expect(failed).toMatchObject({ state: 'failed', count: 1, coverage: '已有成功范围', lastSuccessAt: old.observedAt });
      expect(failed.message).toContain('上次成功数据已保留');
      expect((await repository.getWork(old.works[0]!.id))?.work.rank).toBe(5);
      expect(qimaoCalls).toBe(1);
      expect((await status(repository, 'qimao')).state).toBe('success');
      await manager.tick();
      expect(qimaoCalls).toBe(1);
    } finally { await manager.stop(); await database.close(); }
  });

  it('retries a failed source after doubling delays bounded by the interval and logs every outcome', async () => {
    const clock = { value: INITIAL_TIME };
    const calls: number[] = [];
    let fail = true;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const database = new PGlite();
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const manager = new CollectionManager(repository, { fanqie: async () => {
      calls.push(clock.value);
      if (fail) throw new Error('番茄采集失败：官网返回 HTTP 503 https://fanqienovel.com/api/rank/category/list?x=1');
      return batch('fanqie', clock.value);
    } }, 6 * HOUR, () => clock.value, { retryDelayMs: 30 * 60_000 });
    await manager.initialize();
    try {
      for (const [failures, delayMinutes] of [[1, 30], [2, 60], [3, 120], [4, 240], [5, 360]] as const) {
        await manager.tick();
        expect(calls).toHaveLength(failures);
        const failed = await status(repository, 'fanqie');
        expect(failed).toMatchObject({ state: 'failed', consecutiveFailures: failures, nextRunAt: new Date(clock.value + delayMinutes * 60_000).toISOString() });
        expect(failed.message).toContain('上次成功数据已保留');
        expect(errors).toHaveBeenLastCalledWith(expect.stringContaining(`番茄小说榜单未发布（连续失败 ${failures} 次`));
        expect(String(errors.mock.lastCall)).not.toContain('fanqienovel.com');
        clock.value += delayMinutes * 60_000 - 1; await manager.tick();
        expect(calls).toHaveLength(failures);
        clock.value += 1;
      }
      fail = false;
      await manager.tick();
      expect(await status(repository, 'fanqie')).toMatchObject({ state: 'success', consecutiveFailures: 0, count: 1,
        nextRunAt: new Date(clock.value + 6 * HOUR).toISOString() });
      expect(logs).toHaveBeenLastCalledWith(expect.stringContaining('番茄小说榜单已发布：1 部作品'));
    } finally { logs.mockRestore(); errors.mockRestore(); await manager.stop(); await database.close(); }
  });

  it('persists an administrator interval change and does not overwrite it when an active job completes', async () => {
    const clock = { value: INITIAL_TIME };
    const release = deferred();
    const started = deferred();
    const collectors: Collectors = { fanqie: async signal => {
      started.resolve();
      await Promise.race([release.promise, waitUntilAborted(signal)]);
      return batch('fanqie', clock.value);
    } };
    const { manager, repository, database } = await fixture(collectors, clock);
    let restarted: CollectionManager | undefined;
    try {
      expect(await manager.request('fanqie')).toBe(true);
      await started.promise;
      await expect(manager.setIntervalHours(0)).rejects.toThrow();
      await expect(manager.setIntervalHours(169)).rejects.toThrow();
      await manager.setIntervalHours(12);
      const expected = new Date(INITIAL_TIME + 12 * HOUR).toISOString();
      expect(await repository.collectionIntervalHours()).toBe(12);
      expect(await status(repository, 'fanqie')).toMatchObject({ state: 'running', intervalHours: 12, nextRunAt: expected });
      release.resolve();
      await manager.waitForIdle();
      expect(await status(repository, 'fanqie')).toMatchObject({ state: 'success', intervalHours: 12, nextRunAt: expected });
      await manager.stop();
      const savedHours = await repository.collectionIntervalHours();
      expect(savedHours).toBe(12);
      restarted = new CollectionManager(repository, collectors, savedHours! * HOUR, () => clock.value);
      await restarted.initialize();
      expect(restarted.intervalMs).toBe(12 * HOUR);
      expect((await status(repository, 'fanqie')).nextRunAt).toBe(expected);
    } finally { release.resolve(); await restarted?.stop(); await manager.stop(); await database.close(); }
  });

  it('cancels only its owned requests and waits for their cleanup before stop resolves', async () => {
    const clock = { value: INITIAL_TIME };
    const started = deferred();
    const aborted = deferred();
    const allowCleanup = deferred();
    const unrelated = new AbortController();
    let cleaned = false, stopped = false;
    const { manager, repository, database } = await fixture({ douyin: async signal => {
      started.resolve();
      await new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted.resolve();
          void allowCleanup.promise.then(() => { cleaned = true; reject(signal.reason); });
        }, { once: true });
      });
      throw new Error('Unreachable after aborted collection');
    } }, clock);
    let stopping: Promise<void> | undefined;
    try {
      await manager.request('douyin');
      await started.promise;
      stopping = manager.stop().then(() => { stopped = true; });
      await aborted.promise;
      expect(stopped).toBe(false);
      expect(cleaned).toBe(false);
      expect(unrelated.signal.aborted).toBe(false);
      allowCleanup.resolve();
      await stopping;
      expect(cleaned).toBe(true);
      expect(stopped).toBe(true);
      expect((await status(repository, 'douyin')).state).toBe('failed');
      await expect(manager.request('douyin')).rejects.toThrow(/正在停止/);
    } finally { allowCleanup.resolve(); await stopping; await manager.stop(); await database.close(); }
  });
});
