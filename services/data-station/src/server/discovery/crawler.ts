import { BasicCrawler, Configuration, CriticalError, Log, LogLevel, RequestQueueV1 as RequestQueue, RetryRequestError } from '@crawlee/basic';
import { z } from 'zod';
import { platformSchema } from '../../shared/work-schema.ts';
import type { Platform } from '../../shared/types.ts';
import { resolveConfig } from '../config.ts';

/** A stable source task. Data must contain JSON values so it can survive process restarts. */
export interface DiscoveryTask {
  url: string;
  uniqueKey: string;
  data: Record<string, unknown>;
  /** Bounded current-entry details may precede historical backlog; omitted tasks join the tail. */
  priority?: 'front';
}

/** Limits apply to one invocation; completed keys remain deduplicated in the persistent queue. */
export interface DiscoveryQueueOptions {
  directory: string;
  platform: Platform;
  seeds: DiscoveryTask[];
  /** Add all initial seeds ahead of pending work. Defaults to each task's explicit priority. */
  prioritizeSeeds?: boolean;
  maxRequests: number;
  maxRequestsPerMinute: number;
  maxRetries: number;
  signal: AbortSignal;
  /**
   * Persist extracted records before returning any discovered tasks. Honor cancellation and finish cleanup before rejecting.
   * A rejection whose error has `retryable: false` exhausts the task immediately instead of using the remaining retries.
   */
  handle(task: DiscoveryTask, signal: AbortSignal): Promise<DiscoveryTask[]>;
  /** Persist an exhausted task before it is acknowledged. A rejected callback leaves that task pending and rejects the run. */
  onFailed(task: DiscoveryTask, error: Error): Promise<void>;
}

/** Successes and exhausted failures in this invocation, plus all remaining tasks in the platform queue. */
export interface DiscoveryQueueResult { handled: number; failed: number; pending: number; }

const taskSchema = z.object({
  url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  uniqueKey: z.string().min(1).max(500),
  data: z.record(z.string(), z.json()),
  priority: z.literal('front').optional(),
});
const limitsSchema = z.object({
  platform: platformSchema,
  maxRequests: z.number().int().min(1).max(10_000),
  maxRequestsPerMinute: z.number().int().min(1).max(120),
  maxRetries: z.number().int().min(0).max(3),
  prioritizeSeeds: z.boolean().default(false),
});
const activeQueues = new Set<string>();

class DiscoveryCancelled extends RetryRequestError {}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Deterministic source or verification failures opt out of same-run retries with `retryable: false`. */
function retryable(error: unknown): boolean {
  return !(typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === false);
}

/**
 * Runs a single-concurrency, local Crawlee queue under the project's .data directory.
 * Cancellation waits for the adapter to settle and reclaims its task without consuming a retry.
 * Acknowledgements occur after records and discovered tasks are saved; adapters must tolerate replay.
 * @param options Queue location, bounded workload, adapter and cancellation signal.
 * @returns Per-run outcomes and persisted pending task count. Cancellation returns pending work normally.
 */
export async function runDiscoveryQueue(options: DiscoveryQueueOptions): Promise<DiscoveryQueueResult> {
  const limits = limitsSchema.parse(options);
  const seeds = z.array(taskSchema).parse(options.seeds);
  const directory = resolveConfig({ MUSE_DATA_DIRECTORY: options.directory }).dataDirectory;
  const queueName = `discovery-${limits.platform}`;
  const activeKey = `${directory}/${queueName}`;
  if (activeQueues.has(activeKey)) throw new Error(`Discovery queue is already running: ${limits.platform}`);
  activeQueues.add(activeKey);
  try { return await runQueue(options, limits, seeds, directory, queueName); }
  finally { activeQueues.delete(activeKey); }
}

async function runQueue(
  options: DiscoveryQueueOptions,
  limits: z.infer<typeof limitsSchema>,
  seeds: DiscoveryTask[],
  directory: string,
  queueName: string,
): Promise<DiscoveryQueueResult> {
  const config = new Configuration({
    purgeOnStart: false,
    persistStorage: true,
    defaultKeyValueStoreId: queueName,
    storageClientOptions: { localDataDirectory: directory, persistStorage: true, writeMetadata: true },
  });
  if (config.get('purgeOnStart')) throw new Error('Discovery requires CRAWLEE_PURGE_ON_START to be unset or false');
  const client = config.getStorageClient();
  const events = config.getEventManager();
  // The application owns one writer. V1 preserves foreground order across bounded process restarts without V2 prefetch unlocks.
  const queue = await RequestQueue.open(queueName, { config, storageClient: client });
  const reclaim = queue.reclaimRequest.bind(queue);
  queue.reclaimRequest = (request, options) => {
    const task = taskSchema.safeParse(request.userData.discoveryTask);
    return reclaim(request, { ...options, forefront: options?.forefront === true || task.success && task.data.priority === 'front' });
  };
  const enqueue = async (tasks: DiscoveryTask[], forefront = false) => {
    const validated = z.array(taskSchema).parse(tasks);
    const first = forefront ? validated : validated.filter(task => task.priority === 'front');
    const last = forefront ? [] : validated.filter(task => task.priority !== 'front');
    for (const [entries, front] of [[first.toReversed(), true], [last, false]] as const) {
      for (const task of entries) await queue.addRequest({ url: task.url, uniqueKey: task.uniqueKey, userData: { discoveryTask: task } }, { forefront: front });
    }
  };
  let handled = 0;
  let failed = 0;
  const crawler = new BasicCrawler({
    requestQueue: queue,
    minConcurrency: 1,
    maxConcurrency: 1,
    maxRequestsPerCrawl: limits.maxRequests,
    maxRequestsPerMinute: limits.maxRequestsPerMinute,
    maxRequestRetries: limits.maxRetries,
    useSessionPool: false,
    statisticsOptions: { persistenceOptions: { enable: false } },
    log: new Log({ level: LogLevel.ERROR, prefix: queueName }),
    async requestHandler({ request }) {
      const stored = taskSchema.safeParse(request.userData.discoveryTask);
      if (!stored.success) throw new CriticalError('Invalid persisted discovery task', { cause: stored.error });
      const task = stored.data;
      try {
        options.signal.throwIfAborted();
        const discovered = await options.handle(task, options.signal);
        options.signal.throwIfAborted();
        await enqueue(discovered);
      } catch (error) {
        if (options.signal.aborted) throw new DiscoveryCancelled('Discovery cancelled; task remains pending');
        const cause = asError(error);
        if (request.retryCount >= limits.maxRetries || !retryable(error)) {
          try { await options.onFailed(task, cause); }
          catch (failure) {
            await queue.reclaimRequest(request, { forefront: true });
            throw new CriticalError('Could not persist exhausted discovery task', { cause: asError(failure) });
          }
          request.noRetry = true;
        }
        // Adapter errors cannot use Crawlee's special error classes to bypass retry limits.
        throw new Error(cause.message, { cause });
      }
      handled++;
    },
    errorHandler({ request }, error) {
      if (error instanceof DiscoveryCancelled) request.retryCount--;
    },
    async failedRequestHandler() { failed++; },
  }, config);
  const stop = () => { crawler.stop('Discovery cancelled'); };
  options.signal.addEventListener('abort', stop, { once: true });
  try {
    // Close owned lifecycle listeners before flushing local queue files.
    await events.init();
    await enqueue(seeds, limits.prioritizeSeeds);
    if (!options.signal.aborted) await crawler.run();
  } finally {
    options.signal.removeEventListener('abort', stop);
    events.emit('aborting');
    await events.close();
    await client.teardown?.();
  }
  const info = await queue.getInfo();
  if (!info) throw new Error('Discovery queue metadata is missing after completion');
  return { handled, failed, pending: info.pendingRequestCount };
}
