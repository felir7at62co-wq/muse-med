import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { resolveConfig } from './config.ts';
import { FeishuDirectory } from './departments.ts';
import { createMuseAccountTokenIdentity, createMuseGatewayLookup, createMuseSessionIdentity, createTrustedProxyIdentity } from './identity.ts';
import { collectHongguo } from './collectors/hongguo.ts';
import { collectQimao } from './collectors/qimao.ts';
import { collectFanqie } from './collectors/fanqie.ts';
import { FanqieDetailCache } from './collectors/fanqie/cache.ts';
import { CollectionManager } from './collection-manager.ts';
import { DataRepository } from './repository.ts';
import { acquireDatabaseLock } from './lock.ts';
import { ScriptLibrary } from './script-library.ts';
import { DiscoveryManager } from './discovery/manager.ts';
import { DATA_PLATFORMS } from '../shared/types.ts';
import { createHongguoDiscovery } from './discovery/hongguo.ts';
import { createFanqieDiscovery } from './discovery/fanqie.ts';
import { createQimaoDiscovery } from './discovery/qimao.ts';
import { MetricRefresher } from './metrics/refresher.ts';
import { createFanqieMetricSource, createHongguoMetricSource, createQimaoMetricSource } from './metrics/sources.ts';
import { NovelLibrary } from './novels/library.ts';
import { NovelDownloadManager } from './novels/manager.ts';
import { createFanqieNovelSource } from './novels/fanqie.ts';
import { createQimaoNovelSource } from './novels/qimao.ts';
import { createQimaoApiNovelSource } from './novels/qimao-api.ts';
import { readHongguoDetail } from './collectors/hongguo-detail.ts';
import { loadHitRules } from './hits/rules.ts';
import { HitStore } from './hits/store.ts';
import { loadEventSecret, StationEventSender } from './hits/station-events.ts';
import { HitSelector } from './hits/selector.ts';
import { loadServiceIdentity } from './hits/service-auth.ts';
import { checkDouyinTopic } from './hits/douyin-topic.ts';
import { DouyinSearchBudget, DouyinSearchService, DtkReader, dtkKey } from './douyin-search.ts';
import { createTosObjectStore, DouyinDownloadManager, readTosCredentials } from './douyin-downloads.ts';
import { LvpaopaoStore } from './lvpaopao/store.ts';
import { feishuSender, loadFeishuWebhook, LvpaopaoWatchdog } from './lvpaopao/watchdog.ts';

const config = resolveConfig();
const service = config.serviceTokenFile ? await loadServiceIdentity(config.serviceTokenFile) : undefined;
const hitRules = await loadHitRules(config.hitRulesFile);
const lvpaopaoService = config.lvpaopaoTokenFile ? await loadServiceIdentity(config.lvpaopaoTokenFile, 'lvpaopao-collector', 'MUSE_DATA_LVPAOPAO_TOKEN_FILE') : undefined;
const lvpaopaoWebhook = config.lvpaopaoAlertWebhookFile ? await loadFeishuWebhook(config.lvpaopaoAlertWebhookFile) : undefined;
// Feishu departments admit members beyond the private list and label everyone's department; the last good sync is kept on disk.
const directory = config.mode === 'server' && config.authentication === 'muse-session' && config.feishuDirectory
  ? new FeishuDirectory({ ...config.feishuDirectory, cacheFile: join(config.dataDirectory, 'feishu-directory.json') }) : undefined;
await mkdir(config.dataDirectory, { recursive: true });
await directory?.initialize();
const identity = config.mode !== 'server' ? undefined : config.authentication === 'muse-session'
  ? await createMuseSessionIdentity(config.identityFile!, { cacheMs: config.museSessionCacheMs, directory,
    lookup: createMuseGatewayLookup(config.museGateway, new URL(config.publicOrigin!).host, 5_000) })
  : await createTrustedProxyIdentity(config.identityFile!);
// Desktop Muse signs in with the member's own Muse account token, checked by the same gateway and member list as the website.
const accountIdentity = config.mode === 'server' && config.authentication === 'muse-session'
  ? await createMuseAccountTokenIdentity(config.identityFile!, { cacheMs: config.museSessionCacheMs, directory,
    lookup: createMuseGatewayLookup(config.museGateway, new URL(config.publicOrigin!).host, 5_000, 'bearer') })
  : undefined;
await mkdir(config.dataDirectory, { recursive: true });
const releaseLock = await acquireDatabaseLock(config.dataDirectory);
const resources: { database?: PGlite } = {};
try {
  const database = new PGlite(config.dataDirectory);
  resources.database = database;
  const repository = new DataRepository(database);
  await repository.initialize({ seedDemo: config.seedDemo });
  const fanqieCache = new FanqieDetailCache(join(config.dataDirectory, 'fanqie-details.json'), { ttlHours: config.fanqieDetailCacheHours });
  const manager = new CollectionManager(repository, {
    hongguo: signal => collectHongguo({ maxPages: 5, signal }),
    qimao: signal => collectQimao({ signal }),
    fanqie: signal => collectFanqie({ signal, detailCache: fanqieCache,
      requestIntervalMs: config.fanqieRequestIntervalMs, maxDetailRequests: config.fanqieDetailBudget,
      onProgress: async message => {
        await repository.patchCollector('fanqie', { message });
        console.log(`[muse-data-web] ${message}`);
      },
    }),
  }, (await repository.collectionIntervalHours() ?? config.intervalMs / 3_600_000) * 3_600_000, Date.now, { retryDelayMs: config.collectionRetryMs });
  const scripts = new ScriptLibrary(database, join(config.dataDirectory, 'script-files'));
  const novelLibrary = new NovelLibrary(database, join(config.dataDirectory, 'novel-files'), {
    maxChapters: config.novelMaxChapters, maxFileBytes: config.novelMaxFileBytes, maxStorageBytes: config.novelMaxStorageBytes,
  });
  const novels = new NovelDownloadManager(repository, novelLibrary, config.novelEnabled ? {
    fanqie: createFanqieNovelSource({ pythonExecutable: config.novelPython,
      caFile: config.novelCaFile,
      sourceDirectory: join(process.cwd(), 'third_party/fanqie-original'), workerDirectory: join(config.dataDirectory, 'novel-worker'),
      requestTimeoutMs: config.novelRequestTimeoutMs, requestIntervalMs: config.novelRequestIntervalMs,
      maxResponseBytes: config.novelMaxResponseBytes, maxChapterBytes: config.novelMaxChapterBytes,
      callTimeoutMs: config.novelCallTimeoutMs, graceMs: config.novelGraceMs, networkMode: config.novelNetworkMode,
      fullMode: config.novelFullMode }),
    // Full mode reads the official app archive, which covers every published chapter including web-hidden ones.
    qimao: config.novelFullMode ? createQimaoApiNovelSource({ requestIntervalMs: config.qimaoNovelRequestIntervalMs,
      requestTimeoutMs: config.novelRequestTimeoutMs, maxResponseBytes: config.novelMaxResponseBytes,
      maxArchiveBytes: config.novelMaxArchiveBytes, maxUncompressedBytes: config.novelMaxArchiveBytes * 2,
      maxChapterBytes: config.novelMaxChapterBytes }) : createQimaoNovelSource({ requestIntervalMs: config.qimaoNovelRequestIntervalMs,
      requestTimeoutMs: config.novelRequestTimeoutMs, maxResponseBytes: config.novelMaxResponseBytes,
      maxChapterBytes: config.novelMaxChapterBytes, allowLegacyHeaders: config.qimaoNovelAllowLegacyHeaders }),
  } : {}, { maxQueued: config.novelMaxQueued });
  const discovery = new DiscoveryManager(repository, manager, {
    hongguo: createHongguoDiscovery(),
    fanqie: createFanqieDiscovery({ detailCache: fanqieCache, requestIntervalMs: config.fanqieRequestIntervalMs,
      latestCategoriesPerCycle: config.fanqieLatestCategoriesPerCycle }),
    qimao: createQimaoDiscovery({ latestCategoriesPerCycle: config.qimaoLatestCategoriesPerCycle }),
  }, {
    directory: join(config.dataDirectory, 'crawl-queues'), intervalMs: manager.intervalMs,
    pageBudget: config.discoveryPageBudget, requestsPerMinute: config.discoveryRequestsPerMinute,
    maxRetries: config.discoveryMaxRetries, resumeDelayMs: config.discoveryResumeDelayMs,
  });
  const metricRefresh = new MetricRefresher(repository, manager, {
    hongguo: createHongguoMetricSource({ requestTimeoutMs: 15_000, maxResponseBytes: 8_388_608 }),
    fanqie: createFanqieMetricSource({ requestTimeoutMs: 15_000, maxResponseBytes: 1_048_576 }),
    qimao: createQimaoMetricSource({ requestTimeoutMs: 15_000, maxResponseBytes: 5_242_880, allowLegacyResponseHeaders: config.qimaoNovelAllowLegacyHeaders }),
  }, { batchSize: config.metricRefreshBatch, intervalMs: config.metricRefreshIntervalMs, maxAgeMs: config.metricRefreshMaxAgeMs,
    retryMs: config.metricRefreshRetryMs, requestIntervalMs: config.metricRefreshRequestIntervalMs });
  // Every Douyin read goes through the budget, so members' searches and hit selection share one account's limits.
  const dtk = config.dtkOrigin && config.dtkKeyFile
    ? new DouyinSearchBudget(new DtkReader(config.dtkOrigin, dtkKey(await readFile(config.dtkKeyFile, 'utf8'))),
      { ...config.douyinSearchBudget, save: settings => repository.saveDouyinSearchSettings(settings) }) : undefined;
  const savedSearch = dtk ? await repository.douyinSearchSettings() : null;
  if (dtk && savedSearch) {
    try { dtk.restore(savedSearch); }
    catch (error) { console.error('[muse-data-web] saved Douyin search settings ignored:', error instanceof Error ? error.message : 'Error'); }
  }
  const hitStore = new HitStore(database, hitRules);
  const hitSelector = new HitSelector(repository, hitStore, manager, { rules: hitRules, intervalMs: config.hitIntervalMs,
    readDetail: (seriesId, signal) => readHongguoDetail(seriesId, { requestTimeoutMs: hitRules.detail.requestTimeoutMs, maxResponseBytes: 8_388_608 }, signal),
    ...(dtk ? { checkTopic: (title: string, known: { hashtagId: string | null; manual: boolean } | null) => checkDouyinTopic(dtk, title, { minPlays: hitRules.douyin.minPlays,
      searchCount: hitRules.douyin.searchCount, hashtagId: known?.hashtagId ?? null, manual: known?.manual ?? false, now: () => new Date().toISOString() }) } : {}) });
  await manager.initialize();
  await discovery.initialize();
  await metricRefresh.initialize();
  await scripts.initialize();
  await novels.initialize();
  await hitStore.initialize();
  // 储备 changes wake the cloud Muse main Bot; a missing or unreadable secret leaves the push off instead of stopping the station.
  let stationEvents: StationEventSender | undefined;
  if (config.stationEvents) {
    try {
      stationEvents = new StationEventSender(database, { url: new URL(config.stationEvents.url), secret: await loadEventSecret(config.stationEvents.secretFile),
        batchMs: config.stationEvents.batchMs, pollMs: config.stationEvents.pollMs });
      await stationEvents.initialize();
    } catch (error) {
      stationEvents = undefined;
      console.error('[muse-data-web] 储备 push off:', error instanceof Error ? error.message.slice(0, 200) : 'Error');
    }
  }
  const lvpaopao = new LvpaopaoStore(database, repository, { configured: Boolean(lvpaopaoService), offlineMs: config.lvpaopaoOfflineMs, alertsConfigured: Boolean(lvpaopaoWebhook) });
  await lvpaopao.initialize();
  const lvpaopaoWatchdog = new LvpaopaoWatchdog(lvpaopao, lvpaopaoWebhook ? feishuSender(lvpaopaoWebhook) : null);
  const douyinSearch = dtk ? new DouyinSearchService(dtk, (keys, key) => repository.worksByTitle('hongguo', keys, key)) : undefined;
  // Downloads need both the read-only DTK key and the TOS key file; the key values are never logged.
  // A missing or unreadable key file leaves downloads off with 「TOS 未配置」 instead of stopping the station.
  let douyinDownloads: DouyinDownloadManager | undefined;
  let douyinDownloadsUnavailable = !dtk ? '抖音服务未配置' : !config.tosEnvFile ? 'TOS 未配置' : undefined;
  if (dtk && config.tosEnvFile) {
    try {
      const credentials = await readTosCredentials(config.tosEnvFile);
      douyinDownloads = new DouyinDownloadManager(database, dtk, await createTosObjectStore(config.douyinDownload, credentials),
        { ...config.douyinDownload, workDirectory: join(config.dataDirectory, 'douyin-download-work') });
      await douyinDownloads.initialize();
    } catch (error) {
      douyinDownloads = undefined;
      douyinDownloadsUnavailable = 'TOS 未配置';
      console.error('[muse-data-web] Douyin downloads off (TOS 未配置):', error instanceof Error ? error.message.slice(0, 200) : 'Error');
    }
  }
  const { app } = createApp({ repository, manager, discovery, metricRefresh, scripts, douyinSearch, douyinSearchAdmin: dtk, douyinDownloads, douyinDownloadsUnavailable, accountIdentity, directory, mode: config.mode, authentication: config.authentication, publicOrigin: config.publicOrigin, identity, novels: { library: novelLibrary, manager: novels }, hits: { store: hitStore, selector: hitSelector }, service, lvpaopao: { store: lvpaopao, ...(lvpaopaoService ? { service: lvpaopaoService } : {}) }, enabledPlatforms: DATA_PLATFORMS, port: config.port, staticRoot: config.staticRoot });
  const server = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, () => {
    console.log(`Muse 数据 Web · ${config.mode === 'server' ? '独立代理服务' : '本地预览'} http://${config.hostname}:${config.port}`);
    console.log(config.mode === 'server' ? '独立账号与独立数据存储；未接入现有 Muse 服务。' : '独立 PostgreSQL 开发库；未连接现有 Web、公司账号或 Muse 客户端。');
    novels.start();
    directory?.start();
    lvpaopaoWatchdog.start();
    douyinDownloads?.start();
    if (config.autoCollect) { manager.start(); discovery.start(); metricRefresh.start(); }
    if (config.autoCollect && config.hitEnabled) hitSelector.start();
    stationEvents?.start();
  });
  server.on('error', error => {
    console.error('[muse-data-web] listener failed:', 'code' in error ? error.code : error.name);
    void stop().finally(() => { process.exitCode = 1; });
  });
  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    await lvpaopaoWatchdog.stop();
    await discovery.stop();
    await metricRefresh.stop();
    await hitSelector.stop();
    await stationEvents?.stop();
    await novels.stop();
    await directory?.stop();
    await douyinDownloads?.stop();
    await manager.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await database.close();
    await releaseLock();
  }
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
} catch (error) {
  try { await resources.database?.close(); }
  finally { await releaseLock(); }
  throw error;
}
