import { spawn } from 'node:child_process';
import { Configuration, RequestQueue } from '@crawlee/basic';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDiscoveryQueue, type DiscoveryQueueOptions, type DiscoveryQueueResult, type DiscoveryTask } from '../src/server/discovery/crawler.ts';

const directories: string[] = [];

async function fixture(): Promise<string> {
  await mkdir(resolve('.data'), { recursive: true });
  const directory = await mkdtemp(resolve('.data', 'discovery-crawler-test-'));
  directories.push(directory);
  return directory;
}

function task(key: string, data: Record<string, unknown> = {}): DiscoveryTask {
  return { url: `https://example.test/public/${key}`, uniqueKey: key, data };
}

function options(directory: string, overrides: Partial<DiscoveryQueueOptions> = {}): DiscoveryQueueOptions {
  return {
    directory, platform: 'qimao', seeds: [task('start')], maxRequests: 20,
    maxRequestsPerMinute: 120, maxRetries: 1, signal: new AbortController().signal,
    handle: async () => [], onFailed: async () => {}, ...overrides,
  };
}

function deferred<T = void>() {
  let release!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

/** A new Node process proves that continuation reads the queue from disk rather than a shared storage cache. */
async function resumeInNewProcess(directory: string, runOptions: {
  seeds?: DiscoveryTask[];
  maxRequests?: number;
  prioritizeSeeds?: boolean;
  discovered?: Record<string, DiscoveryTask[]>;
} = {}): Promise<{ result: DiscoveryQueueResult; keys: string[] }> {
  const moduleUrl = new URL('../src/server/discovery/crawler.ts', import.meta.url).href;
  const script = `
    import { runDiscoveryQueue } from ${JSON.stringify(moduleUrl)};
    const keys = [];
    const runOptions = ${JSON.stringify(runOptions)};
    const result = await runDiscoveryQueue({
      directory: ${JSON.stringify(directory)}, platform: 'qimao', seeds: runOptions.seeds ?? [],
      prioritizeSeeds: runOptions.prioritizeSeeds,
      maxRequests: runOptions.maxRequests ?? 20, maxRequestsPerMinute: 120, maxRetries: 1,
      signal: new AbortController().signal,
      handle: async task => { keys.push(task.uniqueKey); return runOptions.discovered?.[task.uniqueKey] ?? []; },
      onFailed: async (_task, error) => { throw error; },
    });
    console.log(JSON.stringify({ result, keys }));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) throw new Error(`Queue continuation exited ${code}: ${errors}`);
  return JSON.parse(output.trim().split('\n').at(-1)!);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('persistent local Crawlee discovery queue', () => {
  it('resumes an existing V2 queue without losing handled keys or pending work', async () => {
    const directory = await fixture();
    const config = new Configuration({ purgeOnStart: false, persistStorage: true,
      storageClientOptions: { localDataDirectory: directory, persistStorage: true, writeMetadata: true } });
    const client = config.getStorageClient();
    const events = config.getEventManager();
    const queue = await RequestQueue.open('discovery-qimao', { config, storageClient: client });
    await events.init();
    try {
      for (const value of [task('old-completed'), task('old-pending-first'), task('old-pending-second')]) {
        await queue.addRequest({ url: value.url, uniqueKey: value.uniqueKey, userData: { discoveryTask: value } });
      }
      const current = await queue.fetchNextRequest();
      expect(current?.uniqueKey).toBe('old-completed');
      await queue.markRequestHandled(current!);
    } finally { events.emit('aborting'); await events.close(); await client.teardown?.(); }
    const resumed = await resumeInNewProcess(directory, { seeds: [task('old-completed')] });
    expect(resumed.result).toEqual({ handled: 2, failed: 0, pending: 0 });
    expect(resumed.keys.toSorted()).toEqual(['old-pending-first', 'old-pending-second']);
  }, 20_000);

  it('enqueues discovered tasks and deduplicates stable keys independently of URLs', async () => {
    const directory = await fixture();
    const root = task('start');
    const detail = task('detail', { sourceId: '9000000000000000001' });
    const seen: DiscoveryTask[] = [];
    const result = await runDiscoveryQueue(options(directory, { handle: async value => {
      seen.push(value);
      return value.uniqueKey === 'start' ? [detail, { ...detail, url: 'https://example.test/duplicate' }, root, { ...detail, uniqueKey: 'other-key' }] : [];
    } }));
    expect(result).toEqual({ handled: 3, failed: 0, pending: 0 });
    expect(seen).toEqual([root, detail, { ...detail, uniqueKey: 'other-key' }]);
    const second = await runDiscoveryQueue(options(directory, { seeds: [root, detail], handle: async () => { throw new Error('Handled keys must not run again'); } }));
    expect(second).toEqual({ handled: 0, failed: 0, pending: 0 });
  });

  it('leaves discovered tasks on disk at the budget and resumes them in a new process', async () => {
    const directory = await fixture();
    const first = await runDiscoveryQueue(options(directory, {
      maxRequests: 1,
      handle: async () => [task('second'), task('third')],
    }));
    expect(first).toEqual({ handled: 1, failed: 0, pending: 2 });
    const queueDirectory = resolve(directory, 'request_queues', 'discovery-qimao');
    expect((await readdir(queueDirectory)).filter(name => name.endsWith('.json')).length).toBeGreaterThan(2);
    const metadata = JSON.parse(await readFile(resolve(queueDirectory, '__metadata__.json'), 'utf8'));
    expect(metadata).toMatchObject({ name: 'discovery-qimao', pendingRequestCount: 2 });
    const resumed = await resumeInNewProcess(directory);
    expect(resumed).toEqual({ result: { handled: 2, failed: 0, pending: 0 }, keys: ['second', 'third'] });
  }, 20_000);

  it('prioritizes new entry seeds after disk reopen while preserving historical and newly discovered tasks', async () => {
    const directory = await fixture();
    expect(await runDiscoveryQueue(options(directory, {
      maxRequests: 1,
      handle: async () => [task('historical-first'), task('historical-second')],
    }))).toEqual({ handled: 1, failed: 0, pending: 2 });

    const prioritized = await resumeInNewProcess(directory, {
      seeds: [task('new-entry')], maxRequests: 1, prioritizeSeeds: true,
      discovered: { 'new-entry': [task('new-detail')] },
    });
    expect(prioritized).toEqual({ result: { handled: 1, failed: 0, pending: 3 }, keys: ['new-entry'] });

    const resumed = await resumeInNewProcess(directory);
    expect(resumed.result).toEqual({ handled: 3, failed: 0, pending: 0 });
    expect(resumed.keys.toSorted()).toEqual(['historical-first', 'historical-second', 'new-detail']);
  }, 20_000);

  it('finishes current-entry details before historical backlog after a process restart', async () => {
    const directory = await fixture();
    await runDiscoveryQueue(options(directory, {
      maxRequests: 1,
      handle: async () => [task('historical-first'), task('historical-second')],
    }));
    const first: DiscoveryTask = { ...task('latest-detail-first'), priority: 'front' };
    const second: DiscoveryTask = { ...task('latest-detail-second'), priority: 'front' };
    const latest = await resumeInNewProcess(directory, {
      seeds: [task('latest-list')], prioritizeSeeds: true, maxRequests: 1,
      discovered: { 'latest-list': [task('historical-next'), first, second] },
    });
    expect(latest.result).toEqual({ handled: 1, failed: 0, pending: 5 });
    const resumed = await resumeInNewProcess(directory);
    expect(resumed.result).toEqual({ handled: 5, failed: 0, pending: 0 });
    expect(resumed.keys).toEqual(['latest-detail-first', 'latest-detail-second', 'historical-first', 'historical-second', 'historical-next']);
  }, 20_000);

  it('preserves a current-detail retry ahead of remaining history across process restart', async () => {
    const directory = await fixture();
    const latest: DiscoveryTask = { ...task('latest-retry'), priority: 'front' };
    const seen: string[] = [];
    const result = await runDiscoveryQueue(options(directory, {
      seeds: [latest, task('historical-first'), task('historical-second')], maxRequests: 1,
      handle: async value => {
        seen.push(value.uniqueKey);
        if (value.uniqueKey === latest.uniqueKey) throw new Error('Transient current detail unavailable');
        return [];
      },
    }));
    expect(result.failed).toBe(0);
    expect(result.pending).toBeGreaterThan(0);
    expect(seen[0]).toBe('latest-retry');
    const resumed = await resumeInNewProcess(directory);
    expect(resumed.keys[0]).toBe('latest-retry');
    expect(resumed.result.failed).toBe(0);
  }, 20_000);

  it('keeps identical task keys independent across platforms and storage directories', async () => {
    const directory = await fixture();
    const other = await fixture();
    const seen: string[] = [];
    for (const [location, platform] of [[directory, 'qimao'], [directory, 'fanqie'], [other, 'qimao']] as const) {
      const result = await runDiscoveryQueue(options(location, { platform, handle: async value => { seen.push(`${platform}:${value.uniqueKey}`); return []; } }));
      expect(result).toEqual({ handled: 1, failed: 0, pending: 0 });
    }
    expect(seen).toEqual(['qimao:start', 'fanqie:start', 'qimao:start']);
    expect(await readdir(resolve(directory, 'request_queues'))).toEqual(expect.arrayContaining(['discovery-qimao', 'discovery-fanqie']));
    expect(await readdir(resolve(other, 'request_queues'))).toEqual(['discovery-qimao']);
  });

  it('retries transient failures and reports exhausted failures with the original task once', async () => {
    const directory = await fixture();
    const transient = task('transient');
    const exhausted = task('exhausted', { kind: 'search', page: 3 });
    const attempts = new Map<string, number>();
    const onFailed = vi.fn(async (_task: DiscoveryTask, _error: Error) => {});
    const result = await runDiscoveryQueue(options(directory, { seeds: [transient, exhausted], onFailed, handle: async value => {
      const count = (attempts.get(value.uniqueKey) ?? 0) + 1;
      attempts.set(value.uniqueKey, count);
      if (value.uniqueKey === exhausted.uniqueKey || count === 1) throw new Error(`Unavailable ${value.uniqueKey}`);
      return [];
    } }));
    expect(result).toEqual({ handled: 1, failed: 1, pending: 0 });
    expect(attempts).toEqual(new Map([['transient', 2], ['exhausted', 2]]));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(exhausted, expect.objectContaining({ message: 'Unavailable exhausted' }));
  });

  it('ends a task after one attempt when the adapter marks its failure as not retryable', async () => {
    const directory = await fixture();
    const verification = task('verification');
    const handle = vi.fn(async (value: DiscoveryTask) => {
      if (value.uniqueKey === verification.uniqueKey) throw Object.assign(new Error('Rendered metadata differs'), { retryable: false });
      return [];
    });
    const onFailed = vi.fn(async (_task: DiscoveryTask, _error: Error) => {});
    const result = await runDiscoveryQueue(options(directory, { seeds: [verification, task('ok')], maxRetries: 2, handle, onFailed }));
    expect(result).toEqual({ handled: 1, failed: 1, pending: 0 });
    expect(handle.mock.calls.map(([value]) => value.uniqueKey)).toEqual(['verification', 'ok']);
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(verification, expect.objectContaining({ message: 'Rendered metadata differs' }));
  });

  it('keeps an exhausted task pending when its durable failure callback cannot save', async () => {
    const directory = await fixture();
    await expect(runDiscoveryQueue(options(directory, {
      maxRetries: 0,
      handle: async () => { throw new Error('Source failed'); },
      onFailed: async () => { throw new Error('Failure database unavailable'); },
    }))).rejects.toThrow('Could not persist exhausted discovery task');
    expect(await resumeInNewProcess(directory)).toEqual({ result: { handled: 1, failed: 0, pending: 0 }, keys: ['start'] });
  }, 20_000);

  it('waits for cancelled adapter cleanup and restores both its task and untouched work', async () => {
    const directory = await fixture();
    const controller = new AbortController();
    const started = deferred();
    const clean = deferred();
    const onFailed = vi.fn(async () => {});
    let settled = false;
    const running = runDiscoveryQueue(options(directory, {
      seeds: [task('first'), task('untouched')], signal: controller.signal, maxRetries: 0, onFailed,
      handle: async (_value, signal) => {
        started.release();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { void clean.promise.then(() => { reject(signal.reason); }); }, { once: true });
        });
        return [];
      },
    })).then(result => { settled = true; return result; });
    await started.promise;
    controller.abort(new Error('Cancelled by test'));
    await new Promise<void>(resolveTick => setImmediate(resolveTick));
    expect(settled).toBe(false);
    clean.release();
    expect(await running).toEqual({ handled: 0, failed: 0, pending: 2 });
    expect(onFailed).not.toHaveBeenCalled();
    const resumed = await resumeInNewProcess(directory);
    expect(resumed.result).toEqual({ handled: 2, failed: 0, pending: 0 });
    expect(resumed.keys).toEqual(expect.arrayContaining(['first', 'untouched']));
  }, 20_000);

  it('saves seeds without running an adapter when cancellation already happened', async () => {
    const directory = await fixture();
    const controller = new AbortController();
    controller.abort();
    const handle = vi.fn(async () => []);
    expect(await runDiscoveryQueue(options(directory, { signal: controller.signal, handle }))).toEqual({ handled: 0, failed: 0, pending: 1 });
    expect(handle).not.toHaveBeenCalled();
    expect(await resumeInNewProcess(directory)).toEqual({ result: { handled: 1, failed: 0, pending: 0 }, keys: ['start'] });
  }, 20_000);

  it.each([
    { maxRequests: 0 }, { maxRequests: 10_001 }, { maxRequestsPerMinute: 0 },
    { maxRequestsPerMinute: 121 }, { maxRetries: -1 }, { maxRetries: 4 },
  ])('rejects unbounded or invalid workload limits: %o', async invalid => {
    const directory = await fixture();
    await expect(runDiscoveryQueue(options(directory, invalid))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects storage outside project .data and non-JSON tasks before opening a queue', async () => {
    const directory = await fixture();
    await expect(runDiscoveryQueue(options(resolve('storage')))).rejects.toThrow('child directory of this project .data');
    await expect(runDiscoveryQueue(options(directory, { seeds: [task('invalid', { timestamp: new Date() })] }))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});
