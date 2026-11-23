import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { museGatewayOrigin, privateIdentityFilePath, publicDataOrigin } from './identity.ts';
import { dtkOrigin } from './douyin-search.ts';

/** Validates independent runtime locations and explicit server identity configuration. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env, projectRoot = process.cwd()): {
  hostname: string; port: number; dataDirectory: string; seedDemo: boolean; staticRoot: string; autoCollect: boolean; intervalMs: number;
  collectionRetryMs: number;
  authentication: 'trusted-proxy' | 'muse-session'; museGateway: string; museSessionCacheMs: number;
  mode: 'local-preview' | 'server'; publicOrigin?: string; identityFile?: string;
  fanqieDetailCacheHours: number; fanqieRequestIntervalMs: number; fanqieDetailBudget: number;
  fanqieLatestCategoriesPerCycle: number;
  qimaoLatestCategoriesPerCycle: number;
  novelEnabled: boolean; novelFullMode: boolean; novelPython: string; novelRequestTimeoutMs: number; novelRequestIntervalMs: number;
  novelCaFile?: string;
  qimaoNovelRequestIntervalMs: number; qimaoNovelAllowLegacyHeaders: boolean;
  novelMaxResponseBytes: number; novelMaxChapterBytes: number; novelCallTimeoutMs: number; novelGraceMs: number;
  novelNetworkMode: 'direct' | 'system'; novelMaxChapters: number; novelMaxFileBytes: number; novelMaxStorageBytes: number; novelMaxQueued: number;
  novelMaxArchiveBytes: number;
  discoveryPageBudget: number; discoveryRequestsPerMinute: number; discoveryMaxRetries: number; discoveryResumeDelayMs: number;
  metricRefreshBatch: number; metricRefreshIntervalMs: number; metricRefreshMaxAgeMs: number; metricRefreshRetryMs: number;
  metricRefreshRequestIntervalMs: number;
  /** Feishu department admission: app credentials, Muse account links, admitted departments and sync interval. */
  feishuDirectory?: { appFile: string; linksFile: string; allowed: string[]; intervalMs: number };
  serviceTokenFile?: string; hitRulesFile?: string;
  lvpaopaoTokenFile?: string; lvpaopaoAlertWebhookFile?: string; lvpaopaoOfflineMs: number; hitEnabled: boolean; hitIntervalMs: number;
  /** 储备 job changes pushed to the cloud Muse main Bot; absent leaves the push off. */
  stationEvents?: { url: string; secretFile: string; batchMs: number; pollMs: number };
  /** Private DTK service for Douyin search; absent disables it. */
  dtkOrigin?: string; dtkKeyFile?: string;
  /** Limits on every Douyin search, shared by members and hit selection. */
  douyinSearchBudget: { perHour: number; perDay: number; pauseMs: number };
  /** Douyin → TOS downloads; enabled when both DTK and `tosEnvFile` are set. */
  tosEnvFile?: string;
  douyinDownload: { bucket: string; region: string; endpoint: string; access: 'private' | 'public'; linkSeconds: number; dailyLimit: number;
    maxMixEpisodes: number; maxVideoBytes: number; intervalMs: number; concurrency: number; maxAttempts: number;
    retryDelayMs: number; cooldownMs: number; maxCooldownMs: number };
} {
  const config = z.object({
    MUSE_DATA_HOST: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
    MUSE_DATA_PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
    MUSE_DATA_MODE: z.enum(['local-preview', 'server']).default('local-preview'),
    MUSE_DATA_PUBLIC_ORIGIN: z.string().optional(),
    MUSE_DATA_IDENTITY_FILE: z.string().optional(),
    MUSE_DATA_DIRECTORY: z.string().optional(),
    MUSE_DATA_SEED_DEMO: z.enum(['0', '1']).default('0'),
    MUSE_DATA_AUTO_COLLECT: z.enum(['0', '1']).default('1'),
    MUSE_DATA_INTERVAL_HOURS: z.coerce.number().finite().min(1).max(168).default(6),
    MUSE_DATA_COLLECTION_RETRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    MUSE_DATA_AUTHENTICATION: z.enum(['trusted-proxy', 'muse-session']).default('trusted-proxy'),
    MUSE_DATA_MUSE_GATEWAY: z.string().default('http://127.0.0.1:19389'),
    MUSE_DATA_MUSE_SESSION_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
    MUSE_DATA_FANQIE_DETAIL_CACHE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    MUSE_DATA_FANQIE_REQUEST_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(250),
    MUSE_DATA_FANQIE_DETAIL_BUDGET: z.coerce.number().int().min(1).max(20_000).default(10_000),
    MUSE_DATA_FANQIE_LATEST_CATEGORIES_PER_CYCLE: z.coerce.number().int().min(1).max(100).default(8),
    MUSE_DATA_QIMAO_LATEST_CATEGORIES_PER_CYCLE: z.coerce.number().int().min(1).max(100).default(8),
    MUSE_DATA_NOVEL_ENABLED: z.enum(['0', '1']).default('0'),
    MUSE_DATA_NOVEL_FULL_MODE: z.enum(['0', '1']).default('0'),
    MUSE_DATA_NOVEL_PYTHON: z.string().optional(),
    MUSE_DATA_NOVEL_CA_FILE: z.string().optional(),
    MUSE_DATA_QIMAO_NOVEL_REQUEST_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    MUSE_DATA_QIMAO_NOVEL_ALLOW_LEGACY_HEADERS: z.enum(['0', '1']).default('1'),
    MUSE_DATA_NOVEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
    MUSE_DATA_NOVEL_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    MUSE_DATA_NOVEL_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(33_554_432).default(16_777_216),
    MUSE_DATA_NOVEL_MAX_CHAPTER_BYTES: z.coerce.number().int().min(1024).max(8_388_608).default(2_097_152),
    MUSE_DATA_NOVEL_CALL_TIMEOUT_MS: z.coerce.number().int().min(100).max(1_800_000).default(180_000),
    MUSE_DATA_NOVEL_GRACE_MS: z.coerce.number().int().min(10).max(10_000).default(1000),
    MUSE_DATA_NOVEL_NETWORK_MODE: z.enum(['direct', 'system']).default('direct'),
    MUSE_DATA_NOVEL_MAX_CHAPTERS: z.coerce.number().int().min(1).max(20_000).default(20_000),
    MUSE_DATA_NOVEL_MAX_FILE_BYTES: z.coerce.number().int().min(1024).max(20_971_520).default(20_971_520),
    MUSE_DATA_NOVEL_MAX_STORAGE_BYTES: z.coerce.number().int().min(1_048_576).max(1_073_741_824).default(1_073_741_824),
    MUSE_DATA_NOVEL_MAX_QUEUED: z.coerce.number().int().min(1).max(50).default(50),
    MUSE_DATA_NOVEL_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1_048_576).max(268_435_456).default(67_108_864),
    MUSE_DATA_DISCOVERY_PAGE_BUDGET: z.coerce.number().int().min(1).max(100).default(12),
    MUSE_DATA_DISCOVERY_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(30),
    MUSE_DATA_DISCOVERY_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
    MUSE_DATA_DISCOVERY_RESUME_DELAY_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
    MUSE_DATA_METRIC_REFRESH_BATCH: z.coerce.number().int().min(1).max(500).default(20),
    MUSE_DATA_METRIC_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
    MUSE_DATA_METRIC_REFRESH_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    MUSE_DATA_METRIC_REFRESH_RETRY_HOURS: z.coerce.number().int().min(1).max(168).default(6),
    MUSE_DATA_METRIC_REFRESH_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
    MUSE_DATA_SERVICE_TOKEN_FILE: z.string().optional(),
    MUSE_DATA_FEISHU_APP_FILE: z.string().optional(),
    MUSE_DATA_FEISHU_LINKS_FILE: z.string().optional(),
    MUSE_DATA_ACCESS_DEPARTMENTS: z.string().max(2_000).optional(),
    MUSE_DATA_FEISHU_SYNC_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
    MUSE_DATA_LVPAOPAO_TOKEN_FILE: z.string().optional(),
    MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE: z.string().optional(),
    MUSE_DATA_LVPAOPAO_OFFLINE_MINUTES: z.coerce.number().int().min(5).max(1_440).default(20),
    MUSE_DATA_HIT_RULES_FILE: z.string().optional(),
    MUSE_DATA_HIT_ENABLED: z.enum(['0', '1']).default('1'),
    MUSE_DATA_HIT_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(20),
    MUSE_DATA_STATION_EVENTS_URL: z.string().url().refine(value => /^https?:$/.test(new URL(value).protocol)).optional(),
    MUSE_DATA_STATION_EVENTS_SECRET_FILE: z.string().optional(),
    MUSE_DATA_STATION_EVENTS_BATCH_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    MUSE_DATA_STATION_EVENTS_POLL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
    MUSE_DATA_DTK_ORIGIN: z.string().optional(),
    MUSE_DATA_DTK_KEY_FILE: z.string().optional(),
    MUSE_DATA_DOUYIN_SEARCH_PER_HOUR: z.coerce.number().int().min(1).max(600).default(6),
    MUSE_DATA_DOUYIN_SEARCH_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(100),
    MUSE_DATA_DOUYIN_SEARCH_PAUSE_MINUTES: z.coerce.number().int().min(1).max(10_080).default(360),
    MUSE_DATA_TOS_ENV_FILE: z.string().optional(),
    MUSE_DATA_TOS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).default('muse'),
    MUSE_DATA_TOS_REGION: z.string().regex(/^[a-z0-9-]{2,40}$/).default('cn-beijing'),
    MUSE_DATA_TOS_ENDPOINT: z.string().regex(/^[a-z0-9.-]+\.volces\.com$/).default('tos-cn-beijing.volces.com'),
    MUSE_DATA_DOUYIN_OBJECT_ACCESS: z.enum(['private', 'public']).default('public'),
    MUSE_DATA_DOUYIN_LINK_SECONDS: z.coerce.number().int().min(60).max(604_800).default(3600),
    MUSE_DATA_DOUYIN_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(50),
    MUSE_DATA_DOUYIN_MAX_MIX_EPISODES: z.coerce.number().int().min(1).max(2_000).default(300),
    MUSE_DATA_DOUYIN_MAX_VIDEO_BYTES: z.coerce.number().int().min(1_048_576).max(4_294_967_296).default(1_073_741_824),
    MUSE_DATA_DOUYIN_DOWNLOAD_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(3000),
    MUSE_DATA_DOUYIN_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
    MUSE_DATA_DOUYIN_DOWNLOAD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    MUSE_DATA_DOUYIN_DOWNLOAD_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    MUSE_DATA_DOUYIN_DOWNLOAD_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
    MUSE_DATA_DOUYIN_DOWNLOAD_MAX_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  }).parse(env);
  const server = config.MUSE_DATA_MODE === 'server';
  if (server && (!config.MUSE_DATA_PUBLIC_ORIGIN || !config.MUSE_DATA_IDENTITY_FILE)) throw new Error('Server mode requires MUSE_DATA_PUBLIC_ORIGIN and MUSE_DATA_IDENTITY_FILE');
  if (!server && (config.MUSE_DATA_PUBLIC_ORIGIN !== undefined || config.MUSE_DATA_IDENTITY_FILE !== undefined)) throw new Error('Proxy identity settings require explicit server mode');
  if (!server && config.MUSE_DATA_AUTHENTICATION !== 'trusted-proxy') throw new Error('Muse sign-in requires explicit server mode');
  const publicOrigin = server ? publicDataOrigin(config.MUSE_DATA_PUBLIC_ORIGIN!) : undefined;
  const identityFile = server ? privateIdentityFilePath(config.MUSE_DATA_IDENTITY_FILE!) : undefined;
  const root = realpathSync(projectRoot);
  const allowedRoot = resolve(root, '.data');
  const requested = config.MUSE_DATA_DIRECTORY ?? resolve(allowedRoot, 'preview');
  if (!isAbsolute(requested)) throw new Error('MUSE_DATA_DIRECTORY must be absolute');
  const directory = resolve(requested);
  const rel = relative(allowedRoot, directory);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Preview database must be a child directory of this project .data');
  if (directory.split(sep).some(part => part === '.muse' || part === '.dsh' || /^(production|prod)$/i.test(part))) throw new Error('Muse and production data locations are forbidden');
  // Existing parents may contain symlinks; resolve each before any directory or database creation.
  let ancestor = directory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, directory));
  if (actual !== directory) throw new Error('Symlinked preview database paths are not allowed');
  for (const [name, value] of [['MUSE_DATA_SERVICE_TOKEN_FILE', config.MUSE_DATA_SERVICE_TOKEN_FILE], ['MUSE_DATA_HIT_RULES_FILE', config.MUSE_DATA_HIT_RULES_FILE],
    ['MUSE_DATA_LVPAOPAO_TOKEN_FILE', config.MUSE_DATA_LVPAOPAO_TOKEN_FILE], ['MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE', config.MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE],
    ['MUSE_DATA_STATION_EVENTS_SECRET_FILE', config.MUSE_DATA_STATION_EVENTS_SECRET_FILE]] as const) {
    if (value !== undefined && (!isAbsolute(value) || resolve(value) !== value)) throw new Error(`${name} must be an absolute path`);
  }
  if ((config.MUSE_DATA_STATION_EVENTS_URL === undefined) !== (config.MUSE_DATA_STATION_EVENTS_SECRET_FILE === undefined)) {
    throw new Error('The 储备 push requires both MUSE_DATA_STATION_EVENTS_URL and MUSE_DATA_STATION_EVENTS_SECRET_FILE');
  }
  const feishuParts = [config.MUSE_DATA_FEISHU_APP_FILE, config.MUSE_DATA_FEISHU_LINKS_FILE, config.MUSE_DATA_ACCESS_DEPARTMENTS];
  if (feishuParts.some(value => value !== undefined) && feishuParts.some(value => value === undefined)) throw new Error('Feishu department admission requires MUSE_DATA_FEISHU_APP_FILE, MUSE_DATA_FEISHU_LINKS_FILE and MUSE_DATA_ACCESS_DEPARTMENTS');
  for (const [name, value] of [['MUSE_DATA_FEISHU_APP_FILE', config.MUSE_DATA_FEISHU_APP_FILE], ['MUSE_DATA_FEISHU_LINKS_FILE', config.MUSE_DATA_FEISHU_LINKS_FILE]] as const) {
    if (value !== undefined && (!isAbsolute(value) || resolve(value) !== value)) throw new Error(`${name} must be an absolute path`);
  }
  const allowedDepartments = (config.MUSE_DATA_ACCESS_DEPARTMENTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (config.MUSE_DATA_ACCESS_DEPARTMENTS !== undefined && !allowedDepartments.length) throw new Error('MUSE_DATA_ACCESS_DEPARTMENTS must name at least one department');
  const feishuDirectory = config.MUSE_DATA_FEISHU_APP_FILE && config.MUSE_DATA_FEISHU_LINKS_FILE ? { feishuDirectory: { appFile: config.MUSE_DATA_FEISHU_APP_FILE,
    linksFile: config.MUSE_DATA_FEISHU_LINKS_FILE, allowed: allowedDepartments, intervalMs: config.MUSE_DATA_FEISHU_SYNC_MINUTES * 60_000 } } : {};
  const novelPython = config.MUSE_DATA_NOVEL_PYTHON ?? resolve(root, '.data/novel-runtime/bin/python3');
  if (!isAbsolute(novelPython)) throw new Error('MUSE_DATA_NOVEL_PYTHON must be absolute');
  if (config.MUSE_DATA_NOVEL_CA_FILE !== undefined && !isAbsolute(config.MUSE_DATA_NOVEL_CA_FILE)) throw new Error('MUSE_DATA_NOVEL_CA_FILE must be absolute');
  if ((config.MUSE_DATA_DTK_ORIGIN === undefined) !== (config.MUSE_DATA_DTK_KEY_FILE === undefined)) throw new Error('Douyin search requires both MUSE_DATA_DTK_ORIGIN and MUSE_DATA_DTK_KEY_FILE');
  if (config.MUSE_DATA_DTK_KEY_FILE !== undefined && !isAbsolute(config.MUSE_DATA_DTK_KEY_FILE)) throw new Error('MUSE_DATA_DTK_KEY_FILE must be absolute');
  if (config.MUSE_DATA_TOS_ENV_FILE !== undefined && (!isAbsolute(config.MUSE_DATA_TOS_ENV_FILE) || resolve(config.MUSE_DATA_TOS_ENV_FILE) !== config.MUSE_DATA_TOS_ENV_FILE)) throw new Error('MUSE_DATA_TOS_ENV_FILE must be absolute');
  const douyinDownload = { bucket: config.MUSE_DATA_TOS_BUCKET, region: config.MUSE_DATA_TOS_REGION, endpoint: config.MUSE_DATA_TOS_ENDPOINT,
    access: config.MUSE_DATA_DOUYIN_OBJECT_ACCESS, linkSeconds: config.MUSE_DATA_DOUYIN_LINK_SECONDS, dailyLimit: config.MUSE_DATA_DOUYIN_DAILY_LIMIT,
    maxMixEpisodes: config.MUSE_DATA_DOUYIN_MAX_MIX_EPISODES, maxVideoBytes: config.MUSE_DATA_DOUYIN_MAX_VIDEO_BYTES, intervalMs: config.MUSE_DATA_DOUYIN_DOWNLOAD_INTERVAL_MS,
    concurrency: config.MUSE_DATA_DOUYIN_DOWNLOAD_CONCURRENCY, maxAttempts: config.MUSE_DATA_DOUYIN_DOWNLOAD_MAX_ATTEMPTS,
    retryDelayMs: config.MUSE_DATA_DOUYIN_DOWNLOAD_RETRY_DELAY_MS, cooldownMs: config.MUSE_DATA_DOUYIN_DOWNLOAD_COOLDOWN_MINUTES * 60_000,
    maxCooldownMs: config.MUSE_DATA_DOUYIN_DOWNLOAD_MAX_COOLDOWN_MINUTES * 60_000 };
  if (douyinDownload.maxCooldownMs < douyinDownload.cooldownMs) throw new Error('MUSE_DATA_DOUYIN_DOWNLOAD_MAX_COOLDOWN_MINUTES must be at least MUSE_DATA_DOUYIN_DOWNLOAD_COOLDOWN_MINUTES');
  if (config.MUSE_DATA_DOUYIN_SEARCH_PER_DAY < config.MUSE_DATA_DOUYIN_SEARCH_PER_HOUR) throw new Error('MUSE_DATA_DOUYIN_SEARCH_PER_DAY must be at least MUSE_DATA_DOUYIN_SEARCH_PER_HOUR');
  const douyinSearchBudget = { perHour: config.MUSE_DATA_DOUYIN_SEARCH_PER_HOUR, perDay: config.MUSE_DATA_DOUYIN_SEARCH_PER_DAY, pauseMs: config.MUSE_DATA_DOUYIN_SEARCH_PAUSE_MINUTES * 60_000 };
  const douyinSearch = config.MUSE_DATA_DTK_ORIGIN === undefined ? {} : { dtkOrigin: dtkOrigin(config.MUSE_DATA_DTK_ORIGIN), dtkKeyFile: config.MUSE_DATA_DTK_KEY_FILE };
  return { hostname: config.MUSE_DATA_HOST, port: config.MUSE_DATA_PORT, dataDirectory: directory, seedDemo: config.MUSE_DATA_SEED_DEMO === '1', staticRoot: resolve(root, 'dist'), autoCollect: config.MUSE_DATA_AUTO_COLLECT === '1', intervalMs: config.MUSE_DATA_INTERVAL_HOURS * 3_600_000,
    collectionRetryMs: config.MUSE_DATA_COLLECTION_RETRY_MINUTES * 60_000,
    authentication: config.MUSE_DATA_AUTHENTICATION, museGateway: museGatewayOrigin(config.MUSE_DATA_MUSE_GATEWAY),
    museSessionCacheMs: config.MUSE_DATA_MUSE_SESSION_CACHE_SECONDS * 1_000,
    mode: config.MUSE_DATA_MODE, publicOrigin, identityFile,
    fanqieDetailCacheHours: config.MUSE_DATA_FANQIE_DETAIL_CACHE_HOURS, fanqieRequestIntervalMs: config.MUSE_DATA_FANQIE_REQUEST_INTERVAL_MS, fanqieDetailBudget: config.MUSE_DATA_FANQIE_DETAIL_BUDGET,
    fanqieLatestCategoriesPerCycle: config.MUSE_DATA_FANQIE_LATEST_CATEGORIES_PER_CYCLE,
    qimaoLatestCategoriesPerCycle: config.MUSE_DATA_QIMAO_LATEST_CATEGORIES_PER_CYCLE,
    novelEnabled: config.MUSE_DATA_NOVEL_ENABLED === '1', novelFullMode: config.MUSE_DATA_NOVEL_FULL_MODE === '1', novelPython, novelRequestTimeoutMs: config.MUSE_DATA_NOVEL_REQUEST_TIMEOUT_MS,
    novelCaFile: config.MUSE_DATA_NOVEL_CA_FILE,
    qimaoNovelRequestIntervalMs: config.MUSE_DATA_QIMAO_NOVEL_REQUEST_INTERVAL_MS,
    qimaoNovelAllowLegacyHeaders: config.MUSE_DATA_QIMAO_NOVEL_ALLOW_LEGACY_HEADERS === '1',
    novelRequestIntervalMs: config.MUSE_DATA_NOVEL_REQUEST_INTERVAL_MS, novelMaxResponseBytes: config.MUSE_DATA_NOVEL_MAX_RESPONSE_BYTES,
    novelMaxChapterBytes: config.MUSE_DATA_NOVEL_MAX_CHAPTER_BYTES, novelCallTimeoutMs: config.MUSE_DATA_NOVEL_CALL_TIMEOUT_MS,
    novelGraceMs: config.MUSE_DATA_NOVEL_GRACE_MS, novelNetworkMode: config.MUSE_DATA_NOVEL_NETWORK_MODE,
    novelMaxChapters: config.MUSE_DATA_NOVEL_MAX_CHAPTERS, novelMaxFileBytes: config.MUSE_DATA_NOVEL_MAX_FILE_BYTES,
    novelMaxStorageBytes: config.MUSE_DATA_NOVEL_MAX_STORAGE_BYTES, novelMaxQueued: config.MUSE_DATA_NOVEL_MAX_QUEUED,
    novelMaxArchiveBytes: config.MUSE_DATA_NOVEL_MAX_ARCHIVE_BYTES,
    discoveryPageBudget: config.MUSE_DATA_DISCOVERY_PAGE_BUDGET, discoveryRequestsPerMinute: config.MUSE_DATA_DISCOVERY_REQUESTS_PER_MINUTE,
    discoveryMaxRetries: config.MUSE_DATA_DISCOVERY_MAX_RETRIES, discoveryResumeDelayMs: config.MUSE_DATA_DISCOVERY_RESUME_DELAY_MS,
    metricRefreshBatch: config.MUSE_DATA_METRIC_REFRESH_BATCH, metricRefreshIntervalMs: config.MUSE_DATA_METRIC_REFRESH_INTERVAL_MINUTES * 60_000,
    metricRefreshMaxAgeMs: config.MUSE_DATA_METRIC_REFRESH_MAX_AGE_HOURS * 3_600_000, metricRefreshRetryMs: config.MUSE_DATA_METRIC_REFRESH_RETRY_HOURS * 3_600_000,
    metricRefreshRequestIntervalMs: config.MUSE_DATA_METRIC_REFRESH_REQUEST_INTERVAL_MS, ...douyinSearch, douyinSearchBudget, douyinDownload, ...(config.MUSE_DATA_TOS_ENV_FILE ? { tosEnvFile: config.MUSE_DATA_TOS_ENV_FILE } : {}),
    ...feishuDirectory, serviceTokenFile: config.MUSE_DATA_SERVICE_TOKEN_FILE, hitRulesFile: config.MUSE_DATA_HIT_RULES_FILE,
    lvpaopaoTokenFile: config.MUSE_DATA_LVPAOPAO_TOKEN_FILE, lvpaopaoAlertWebhookFile: config.MUSE_DATA_LVPAOPAO_ALERT_WEBHOOK_FILE,
    lvpaopaoOfflineMs: config.MUSE_DATA_LVPAOPAO_OFFLINE_MINUTES * 60_000,
    hitEnabled: config.MUSE_DATA_HIT_ENABLED === '1', hitIntervalMs: config.MUSE_DATA_HIT_INTERVAL_MINUTES * 60_000,
    ...(config.MUSE_DATA_STATION_EVENTS_URL && config.MUSE_DATA_STATION_EVENTS_SECRET_FILE ? { stationEvents: {
      url: config.MUSE_DATA_STATION_EVENTS_URL, secretFile: config.MUSE_DATA_STATION_EVENTS_SECRET_FILE,
      batchMs: config.MUSE_DATA_STATION_EVENTS_BATCH_SECONDS * 1_000, pollMs: config.MUSE_DATA_STATION_EVENTS_POLL_SECONDS * 1_000,
    } } : {}) };
}
