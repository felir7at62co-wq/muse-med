import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { compress } from 'hono/compress';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { platformSchema } from '../shared/work-schema.ts';
import type { CatalogQuery, CollectionBatch, PageBootstrap, Platform, SessionInfo, UserIdentity } from '../shared/types.ts';
import { MUSE_LOGIN_PATH, PLATFORM_LABELS, PLATFORMS } from '../shared/types.ts';
import type { DataRepository } from './repository.ts';
import { CollectionManager, type Collectors } from './collection-manager.ts';
import { CoverCache } from './covers.ts';
import type { ScriptLibrary } from './script-library.ts';
import { registerScriptRoutes } from './script-routes.ts';
import { registerNovelRoutes } from './novels/routes.ts';
import type { NovelLibrary } from './novels/library.ts';
import type { NovelDownloadManager } from './novels/manager.ts';
import { DouyinSourceError, DouyinSourceStore } from './douyin-source-store.ts';
import { registerDouyinSourceRoutes } from './douyin-source-routes.ts';
import { registerDouyinSearchRoutes } from './douyin-search-routes.ts';
import { registerDouyinDownloadRoutes } from './douyin-download-routes.ts';
import type { DouyinDownloadManager } from './douyin-downloads.ts';
import type { DouyinSearchBudget, DouyinSearchService } from './douyin-search.ts';
import { DouyinCollectionError } from './collectors/douyin.ts';
import type { DiscoveryManager } from './discovery/manager.ts';
import type { MetricRefresher } from './metrics/refresher.ts';
import { publicDataOrigin, type IdentityResult } from './identity.ts';
import { withMuseSiteBar } from './muse-site-bar.ts';
import { boardDirectory, buildPageBootstrap, withPageBootstrap, withScripts } from './page-bootstrap.ts';
import { registerHitRoutes, type HitRouteOptions } from './hits/routes.ts';
import type { ServiceIdentity } from './hits/service-auth.ts';
import { registerLvpaopaoRoutes } from './lvpaopao/routes.ts';
import type { LvpaopaoStore } from './lvpaopao/store.ts';

const querySchema = z.object({
  platform: platformSchema.optional(),
  kind: z.enum(['drama', 'novel']).optional(),
  q: z.string().max(200).optional(), category: z.string().max(200).optional(), board: z.string().max(200).optional(),
  tag: z.string().max(120).optional(),
  sort: z.enum(['rank', 'rising', 'recent', 'plays', 'published']).optional(), origin: z.enum(['live', 'demo']).default('live'),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  at: z.string().datetime({ offset: true }).optional(),
}).strict().refine(query => !['plays', 'published'].includes(query.sort ?? '') || query.platform === 'douyin')
  .refine(query => query.at === undefined || Boolean(query.board?.trim()));
const boardScopeSchema = z.object({
  platform: platformSchema, origin: z.enum(['live', 'demo']).default('live'),
  board: z.string().max(200).refine(board => board.trim() !== ''),
});
const batchTime = z.string().datetime({ offset: true });
/** A real Beijing calendar date between 2000 and 2099. */
const calendarDate = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value));
/** Longest wait for first-screen data before a page is served without it; the client then reads the same data over the API. */
const BOOTSTRAP_WAIT_MS = 1500;
/** Vite output under `/assets/` carries a content hash in each file name, so a cached copy never goes stale. */
const HASHED_ASSET_CACHE = 'private, max-age=31536000, immutable';
/** File downloads keep their exact length header; clients verify their size and digest. */
const UNCOMPRESSED_PATHS = /^\/api\/(?:export|scripts\/[^/]+\/download|originals\/[^/]+\/download)$/;
/** Worker routes authenticated by the service token instead of a user. */
const SERVICE_PATH = /^\/api\/service\//;
const SERVICE_SCRIPT_UPLOAD = /^\/api\/service\/hits\/jobs\/[^/]+\/script$/;
/** Desktop Muse routes authenticated by the member's own Muse account token. */
const MUSE_CLIENT_PATH = /^\/api\/muse-client\//;
/** Desktop Muse reaches these member reads and actions as `/api/muse-client/data/<path>`; everything else stays web-only. */
const DESKTOP_DATA_PREFIX = '/api/muse-client/data/';
/** Carries a one-time ticket naming the member verified for a desktop request; it outlives the body-limit's request copy. */
const DESKTOP_MEMBER_HEADER = 'x-muse-data-desktop-member';
const DESKTOP_DATA_ROUTES: readonly { method: 'GET' | 'POST'; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/(?:boards|boards\/period|works|facets|hits\/board|lvpaopao\/status)$/ },
  { method: 'GET', path: /^\/api\/works\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/hits\/jobs\/[^/]+\/events$/ },
  { method: 'GET', path: /^\/api\/scripts\/[^/]+\/download$/ },
  { method: 'POST', path: /^\/api\/hits\/[^/]+\/rush$/ },
];
/** Routes of the 绿泡泡 Mac collector, authenticated by its own token. */
const LVPAOPAO_SERVICE_PATH = /^\/api\/service\/lvpaopao\//;
const selectionSchema = z.object({ status: z.enum(['pending', 'reviewing', 'selected', 'passed']), note: z.string().max(5_000).default('') }).strict();

/** A minimal static notice for denied page loads; it links back to the Muse workbench. */
function noticePage(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · Muse</title>`
    + '<style>body{margin:0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1d232d}'
    + 'main{max-width:520px;margin:18vh auto;padding:32px;background:#fff;border:1px solid #dce1e8;border-radius:14px}h1{font-size:22px;font-weight:500;margin:0 0 12px}p{color:#596575;margin:0 0 20px}a{color:#3f59c5}'
    + '@media(prefers-color-scheme:dark){body{background:#15181d;color:#edf1f7}main{background:#1e232b;border-color:#3c4655}p{color:#b3bdcc}a{color:#a8b8ff}}</style>'
    + `</head><body><main><h1>${title}</h1><p>${message}</p><a href="/workbench">返回 Muse 工作台</a></main></body></html>`;
}

function csvCell(value: string | number | null): string {
  const string = value == null ? '' : String(value);
  const safe = /^\s*[=+@\-\t\r]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Creates a loopback API with either a local preview identity or an explicit trusted-proxy account provider. */
export function createApp(options: {
  repository: DataRepository;
  collectHongguo?: () => Promise<CollectionBatch>;
  collectors?: Collectors;
  manager?: CollectionManager;
  port?: number;
  staticRoot?: string;
  covers?: CoverCache;
  scripts?: ScriptLibrary;
  novels?: { library: NovelLibrary; manager: NovelDownloadManager };
  douyinSources?: DouyinSourceStore;
  discovery?: Pick<DiscoveryManager, 'list' | 'request' | 'setIntervalHours'>;
  metricRefresh?: Pick<MetricRefresher, 'list' | 'request'>;
  /** Member Douyin search through the private DTK service; absent answers 503. */
  douyinSearch?: Pick<DouyinSearchService, 'searchPosts' | 'searchAccounts' | 'mixPosts'>;
  /** The shared Douyin search budget, shown and changed on the administrator page; absent answers 503. */
  douyinSearchAdmin?: Pick<DouyinSearchBudget, 'state' | 'configure'>;
  /** Member Douyin → TOS downloads; absent answers 503. */
  douyinDownloads?: Pick<DouyinDownloadManager, 'status' | 'list' | 'requestPost' | 'requestMix' | 'link' | 'get'>;
  /** Why Douyin downloads are off, shown to members, when `douyinDownloads` is absent. */
  douyinDownloadsUnavailable?: string;
  enabledPlatforms?: readonly Platform[];
  identity?: (request: Request) => Promise<IdentityResult>;
  mode?: 'local-preview' | 'server';
  /** Server-mode sign-in source reported by health; Muse sign-in also redirects anonymous page loads to Muse. */
  authentication?: 'trusted-proxy' | 'muse-session';
  publicOrigin?: string;
  /** Daily hit-transcription loop: selection, jobs and the 储备看板. */
  hits?: Pick<HitRouteOptions, 'store' | 'selector'>;
  /** Service identity of the transcription worker; without it `/api/service/*` answers 404. */
  service?: ServiceIdentity;
  /** Desktop Muse sign-in by the member's own account token (`X-Muse-Account-Token`); without it `/api/muse-client/*` answers 404. */
  accountIdentity?: (request: Request) => Promise<IdentityResult>;
  /** Feishu department sync, reported to administrators. */
  directory?: { status(): unknown };
  /** 绿泡泡 collector store and token; without the token `/api/service/lvpaopao/*` answers 404. */
  lvpaopao?: { store: LvpaopaoStore; service?: ServiceIdentity };
}): { app: Hono; waitForCollections: () => Promise<void> } {
  const app = new Hono();
  const mode = options.mode ?? 'local-preview';
  if (mode === 'server' && (!options.identity || !options.publicOrigin)) throw new Error('Server mode requires a trusted identity provider and public origin');
  if (mode === 'local-preview' && options.publicOrigin !== undefined) throw new Error('Public origin requires explicit server mode');
  const publicOrigin = mode === 'server' ? publicDataOrigin(options.publicOrigin!) : undefined;
  const port = options.port ?? 4317;
  const covers = options.covers ?? new CoverCache();
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const manager = options.manager ?? new CollectionManager(options.repository, options.collectors ?? (options.collectHongguo ? { hongguo: options.collectHongguo } : {}));
  const enabledPlatforms = options.enabledPlatforms ?? PLATFORMS;
  const outcomes = new WeakMap<Request, Promise<IdentityResult>>();
  /** Members verified by their Muse account token for desktop requests now being served, by one-time ticket. */
  const desktopMembers = new Map<string, UserIdentity>();
  const outcome = (request: Request): Promise<IdentityResult> => {
    const ticket = request.headers.get(DESKTOP_MEMBER_HEADER);
    // A ticket names only a desktop request this process is serving; any other value is no identity.
    if (ticket !== null) return Promise.resolve(desktopMembers.get(ticket) ?? null);
    const existing = outcomes.get(request);
    if (existing) return existing;
    const resolved = options.identity ? options.identity(request) : mode === 'local-preview'
      ? Promise.resolve<UserIdentity>({ id: 'local-preview', name: '本地预览', role: 'admin' }) : Promise.resolve(null);
    outcomes.set(request, resolved);
    return resolved;
  };
  const identity = async (request: Request): Promise<UserIdentity | null> => {
    const result = await outcome(request);
    return result && 'id' in result ? result : null;
  };
  const authentication = mode === 'server' ? options.authentication ?? 'trusted-proxy' : 'loopback-only';
  const isScriptUpload = (method: string, path: string): boolean => method === 'POST' && /^\/api\/works\/[^/]+\/script$/.test(path);
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };

  const compression = compress();
  app.use('*', (c, next) => UNCOMPRESSED_PATHS.test(c.req.path) ? next() : compression(c, next));
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const host = c.req.header('host') ?? url.host;
    if (!allowedHosts.has(host.toLowerCase()) || !allowedHosts.has(url.host.toLowerCase())) {
      return c.json({ error: mode === 'server' ? '数据站仅接受本机代理连接' : '本地预览仅允许通过 localhost 访问' }, 403);
    }
    for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
    c.header('Cache-Control', 'no-store');
    if (MUSE_CLIENT_PATH.test(c.req.path)) {
      // Desktop Muse: the member's own account token, never a cookie or the shared service token.
      if (!options.accountIdentity) return c.json({ error: '接口未启用' }, 404);
      if (c.req.header('origin')) return c.json({ error: '这个接口不接受浏览器请求' }, 403);
      const result = await options.accountIdentity(c.req.raw);
      if (!result || 'denied' in result) {
        const denied = result && 'denied' in result ? result.denied : 'login';
        if (denied === 'forbidden') return c.json({ error: '你的 Muse 账号还没有开通数据站' }, 403);
        if (denied === 'unavailable') return c.json({ error: '暂时无法确认 Muse 登录，请稍后重试' }, 503);
        return c.json({ error: '请先登录 Muse' }, 401);
      }
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return c.json({ error: '请求需要 application/json' }, 415);
      }
      if (c.req.path.startsWith(DESKTOP_DATA_PREFIX)) {
        // The same member route the web page uses, run as the member the account token named.
        const target = `/api/${c.req.path.slice(DESKTOP_DATA_PREFIX.length)}`;
        if (!DESKTOP_DATA_ROUTES.some(route => route.method === c.req.method && route.path.test(target))) return c.json({ error: '接口不存在' }, 404);
        const headers = new Headers(c.req.raw.headers);
        headers.delete('cookie');
        headers.delete('x-muse-account-token');
        const ticket = crypto.randomUUID();
        headers.set(DESKTOP_MEMBER_HEADER, ticket);
        desktopMembers.set(ticket, result);
        try {
          return await app.fetch(new Request(new URL(`${target}${url.search}`, url), { method: c.req.method, headers, body: c.req.method === 'GET' ? null : await c.req.raw.arrayBuffer() }), c.env);
        } finally {
          desktopMembers.delete(ticket);
        }
      }
      await next();
      for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
      if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
      return;
    }
    if (SERVICE_PATH.test(c.req.path)) {
      // Workers authenticate with the service token only; browsers and user sessions never reach these routes.
      const service = LVPAOPAO_SERVICE_PATH.test(c.req.path) ? options.lvpaopao?.service : options.service;
      if (!service) return c.json({ error: '服务接口未启用' }, 404);
      if (c.req.header('origin')) return c.json({ error: '服务接口不接受浏览器请求' }, 403);
      if (!service.verify(c.req.raw)) { c.header('WWW-Authenticate', 'Bearer'); return c.json({ error: '服务身份无效' }, 401); }
      const multipart = c.req.method === 'POST' && SERVICE_SCRIPT_UPLOAD.test(c.req.path);
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && !multipart && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return c.json({ error: '请求需要 application/json' }, 415);
      }
      await next();
      for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
      if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
      return;
    }
    const api = c.req.path.startsWith('/api/');
    const health = c.req.path === '/api/health' && ['GET', 'HEAD'].includes(c.req.method);
    let authenticatedApi = false;
    if (!health && (mode === 'server' || api)) {
      if (!await identity(c.req.raw)) {
        const result = await outcome(c.req.raw);
        const denied = result && 'denied' in result ? result.denied : null;
        const page = !api && ['GET', 'HEAD'].includes(c.req.method);
        if (denied === 'login') {
          if (page) return c.redirect(MUSE_LOGIN_PATH, 303);
          c.header('X-Muse-Data-Login', MUSE_LOGIN_PATH);
          return c.json({ error: '请先登录 Muse' }, 401);
        }
        if (denied === 'forbidden') return page ? c.html(noticePage('数据站尚未对你开放', '你已登录 Muse，但这个账号还不在数据站名单里。请联系数据站管理员开通。'), 403)
          : c.json({ error: '你的 Muse 账号还没有开通数据站' }, 403);
        if (denied === 'unavailable') return page ? c.html(noticePage('暂时无法确认登录', 'Muse 登录服务暂时没有响应，请稍后刷新重试。'), 503)
          : c.json({ error: '暂时无法确认 Muse 登录，请稍后重试' }, 503);
        return c.json({ error: '请先登录' }, 401);
      }
      if (api) { authenticatedApi = true; c.header('X-Muse-Data-Authenticated', '1'); }
    }
    const origin = c.req.header('origin');
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const desktop = desktopMembers.has(c.req.header(DESKTOP_MEMBER_HEADER) ?? '');
    if ((isWrite && !origin && !desktop) || (origin && origin !== (publicOrigin ?? url.origin))) return c.json({ error: mode === 'server' ? '请从数据站页面发起操作' : '请从本地预览页面发起操作' }, 403);
    const upload = isScriptUpload(c.req.method, c.req.path);
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && !upload && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: '请求需要 application/json' }, 415);
    }
    await next();
    if (authenticatedApi) c.header('X-Muse-Data-Authenticated', '1');
    for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  app.use('/api/*', async (c, next) => {
    const upload = isScriptUpload(c.req.method, c.req.path) || (c.req.method === 'POST' && SERVICE_SCRIPT_UPLOAD.test(c.req.path));
    return bodyLimit({ maxSize: upload ? 20 * 1024 * 1024 + 65_536 : SERVICE_PATH.test(c.req.path) ? 2 * 1024 * 1024 : 32_768, onError: context => context.json({ error: '请求内容过大' }, 413) })(c, next);
  });
  app.onError((error, c) => {
    if (error instanceof DouyinSourceError) return c.json({ error: error.message }, error.status);
    if (error instanceof DouyinCollectionError) return c.json({ error: error.message.slice(0, 400) }, 422);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: '请求参数无效，请检查后重试' }, 400);
    console.error('[muse-data-web] request failed:', error instanceof Error ? error.name : 'Error');
    return c.json({ error: '操作未完成，请稍后重试' }, 500);
  });
  app.get('/api/health', c => c.json({ app: 'muse-data-web', mode, storage: 'embedded-postgresql', auth: authentication }));
  app.get('/api/session', async c => c.json({ ...await identity(c.req.raw), mode }));
  app.get('/api/dashboard', async c => {
    const query = z.object({ origin: z.enum(['live', 'demo']).default('live') }).strict().parse(c.req.query());
    return c.json(await options.repository.dashboard(query));
  });
  app.get('/api/facets', async c => c.json(await options.repository.facets(querySchema.parse(c.req.query()))));
  app.get('/api/boards', async c => {
    const query = z.object({ platform: platformSchema, origin: z.enum(['live', 'demo']).default('live') }).strict().parse(c.req.query());
    return c.json(await boardDirectory(options.repository, query.platform, query.origin));
  });
  app.get('/api/boards/batches', async c => {
    return c.json(await options.repository.boardBatches(boardScopeSchema.strict().parse(c.req.query())));
  });
  app.get('/api/boards/days', async c => {
    return c.json(await options.repository.boardDays(boardScopeSchema.strict().parse(c.req.query())));
  });
  app.get('/api/boards/period', async c => {
    const query = boardScopeSchema.extend({ period: z.enum(['day', 'week', 'month']).default('day'), date: calendarDate.optional() }).strict().parse(c.req.query());
    const view = await options.repository.boardPeriod(query);
    if (!view) return c.json({ error: '该榜单还没有采集记录' }, 404);
    return c.json(await withScripts(view, options.scripts));
  });
  app.get('/api/boards/compare', async c => {
    const query = boardScopeSchema.extend({ from: batchTime, to: batchTime }).strict()
      .refine(value => Date.parse(value.from) < Date.parse(value.to)).parse(c.req.query());
    const comparison = await options.repository.compareBoardBatches(query);
    return comparison ? c.json(comparison) : c.json({ error: '所选采集批次不存在' }, 404);
  });
  app.get('/api/works', async c => {
    const query = querySchema.parse(c.req.query());
    const result = await options.repository.listWorks(query);
    if (query.at && !result.batch) return c.json({ error: '所选采集批次不存在' }, 404);
    const scripts = await options.scripts?.metadataForWorks(result.items.map(work => work.id));
    return c.json({ ...result, items: result.items.map(work => ({ ...work, script: scripts?.[work.id] ?? null })) });
  });
  app.get('/api/works/:id', async c => {
    const board = z.string().max(200).optional().parse(c.req.query('board'));
    const result = await options.repository.getWork(c.req.param('id'), board);
    if (result) result.work.script = await options.scripts?.current(result.work.id) ?? null;
    return result ? c.json(result) : c.json({ error: '作品不存在' }, 404);
  });
  app.get('/api/covers/:id', async c => {
    const detail = await options.repository.getWork(c.req.param('id'));
    if (!detail?.work.coverUrl) return c.json({ error: '来源未提供封面' }, 404);
    try {
      const image = await covers.get(detail.work.coverUrl);
      c.header('Content-Type', image.contentType);
      c.header('Cache-Control', 'private, max-age=21600');
      return c.body(new Uint8Array(image.body));
    } catch {
      return c.json({ error: '封面暂时无法加载，请稍后重试' }, 502);
    }
  });
  app.get('/api/selections', async c => c.json(await options.repository.selections()));
  app.put('/api/selections/:id', async c => {
    const data = selectionSchema.parse(await c.req.json());
    const selection = await options.repository.putSelection(c.req.param('id'), data.status, data.note);
    return selection ? c.json(selection) : c.json({ error: '作品不存在' }, 404);
  });
  app.delete('/api/selections/:id', async c => {
    await options.repository.deleteSelection(c.req.param('id'));
    return c.json({ removed: true });
  });
  app.get('/api/collectors', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看采集管理' }, 403);
    return c.json((await options.repository.collectors()).filter(status => enabledPlatforms.includes(status.platform)));
  });
  app.get('/api/admin/directory', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看部门同步' }, 403);
    return options.directory ? c.json(options.directory.status()) : c.json({ state: 'not_configured', message: '未配置飞书部门放行' });
  });
  app.get('/api/admin/settings', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看采集设置' }, 403);
    return c.json({ intervalHours: manager.intervalMs / 3_600_000 });
  });
  app.put('/api/admin/settings', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以修改采集设置' }, 403);
    const settings = z.object({ intervalHours: z.number().int().min(1).max(168) }).strict().parse(await c.req.json());
    await manager.setIntervalHours(settings.intervalHours);
    await options.discovery?.setIntervalHours(settings.intervalHours);
    return c.json(settings);
  });
  app.get('/api/admin/douyin-search', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看抖音搜索' }, 403);
    if (!options.douyinSearchAdmin) return c.json({ error: '抖音搜索服务未配置' }, 503);
    return c.json(options.douyinSearchAdmin.state());
  });
  app.put('/api/admin/douyin-search', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以修改抖音搜索' }, 403);
    if (!options.douyinSearchAdmin) return c.json({ error: '抖音搜索服务未配置' }, 503);
    const change = z.object({ perHour: z.number().int().min(1).max(600).optional(), perDay: z.number().int().min(1).max(10_000).optional(),
      stopped: z.boolean().optional(), resume: z.literal(true).optional() }).strict().parse(await c.req.json());
    if ((change.perDay ?? options.douyinSearchAdmin.state().perDay) < (change.perHour ?? options.douyinSearchAdmin.state().perHour)) return c.json({ error: '每天上限不能小于每小时上限' }, 400);
    return c.json(await options.douyinSearchAdmin.configure(change));
  });
  app.get('/api/admin/discovery', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看扩库进度' }, 403);
    if (!options.discovery) return c.json({ error: '扩库服务尚未配置' }, 503);
    return c.json((await options.discovery.list()).filter(status => enabledPlatforms.includes(status.platform)));
  });
  app.post('/api/admin/discovery/:platform/run', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以启动扩库' }, 403);
    if (!options.discovery) return c.json({ error: '扩库服务尚未配置' }, 503);
    const platform = platformSchema.parse(c.req.param('platform'));
    if (!enabledPlatforms.includes(platform)) return c.json({ error: '该平台已停止采集' }, 410);
    z.object({}).strict().parse(await c.req.json());
    if (!(await options.discovery.list()).some(status => status.platform === platform && status.state !== 'not_configured')) return c.json({ error: '该平台尚未配置发现入口' }, 503);
    if (!await options.discovery.request(platform)) return c.json({ error: '该平台正在执行任务，请稍候' }, 409);
    return c.json({ started: true }, 202);
  });
  app.get('/api/admin/metric-refresh', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看指标刷新进度' }, 403);
    if (!options.metricRefresh) return c.json({ error: '指标刷新尚未配置' }, 503);
    return c.json((await options.metricRefresh.list()).filter(status => enabledPlatforms.includes(status.platform)));
  });
  app.post('/api/admin/metric-refresh/:platform/run', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以启动指标刷新' }, 403);
    if (!options.metricRefresh) return c.json({ error: '指标刷新尚未配置' }, 503);
    const platform = platformSchema.parse(c.req.param('platform'));
    if (!enabledPlatforms.includes(platform)) return c.json({ error: '该平台已停止采集' }, 410);
    z.object({}).strict().parse(await c.req.json());
    if (!(await options.metricRefresh.list()).some(status => status.platform === platform && status.state !== 'not_configured')) return c.json({ error: '该平台没有作品详情指标来源' }, 503);
    if (!await options.metricRefresh.request(platform)) return c.json({ error: '该平台正在执行任务，请稍候' }, 409);
    return c.json({ started: true }, 202);
  });
  app.post('/api/collectors/:platform/run', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以执行采集' }, 403);
    const platform = platformSchema.parse(c.req.param('platform'));
    if (!enabledPlatforms.includes(platform)) return c.json({ error: '该平台已停止采集' }, 410);
    if (platform === 'lvpaopao' && options.lvpaopao) {
      if (!options.lvpaopao.service) return c.json({ error: '绿泡泡采集端尚未配置' }, 503);
      await options.lvpaopao.store.enqueue('collect-now', (await identity(c.req.raw))!.name);
      return c.json({ started: true }, 202);
    }
    if (!manager.has(platform)) return c.json({ error: '该平台尚未配置真实采集器' }, 503);
    if (!await manager.request(platform)) return c.json({ error: '该平台正在采集，请稍候' }, 409);
    return c.json({ started: true }, 202);
  });
  app.use('/api/admin/douyin/*', async (c, next) => {
    if (!enabledPlatforms.includes('douyin')) return c.json({ error: '数据站已停用抖音采集' }, 410);
    await next();
  });
  registerDouyinSourceRoutes(app, { store: options.douyinSources ?? new DouyinSourceStore(options.repository.database), identity });
  app.get('/api/export', async c => {
    const query: CatalogQuery = querySchema.parse(c.req.query());
    // Bounded to 10,000 rows; pagination controls from a table do not truncate an export silently.
    const result = await options.repository.listWorks({ ...query, page: 1, limit: 10_001 });
    if (query.at && !result.batch) return c.json({ error: '所选采集批次不存在' }, 404);
    if (result.total > 10_000) return c.json({ error: '导出超过 10000 条，请增加筛选条件' }, 400);
    const rows: Array<Array<string | number | null>> = [['作品名称', '平台', '来源', '平台作品ID（文本）', '作者/账号', '类型', '榜单', '排名', '排名变化', '题材', '集数', '字数', '原始链接', '采集时间', '指标名称', '指标数值', '作品资料状态', '作品资料说明']];
    for (const work of result.items) {
      rows.push([work.title, PLATFORM_LABELS[work.platform], work.origin === 'live' ? '真实采集' : '虚构示例', `'${work.sourceId}`, work.author ?? '', work.kind === 'drama' ? '短剧' : '小说', work.board, String(work.rank ?? ''), String(work.rankChange ?? ''), work.tags.join(' / '), String(work.episodeCount ?? ''), String(work.wordCount ?? ''), work.sourceUrl, work.observedAt, work.metrics.map(metric => metric.label).join(' / '), work.metrics.map(metric => metric.value == null ? '未知' : String(metric.value)).join(' / '), work.metadataStatus ?? '', work.metadataNote ?? '']);
    }
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="muse-data-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });
  if (options.scripts) registerScriptRoutes(app, { library: options.scripts, identity, getWork: id => options.repository.getWork(id) });
  if (options.hits) registerHitRoutes(app, { ...options.hits, repository: options.repository, ...(options.scripts ? { scripts: options.scripts } : {}), identity, ...(options.service ? { service: options.service } : {}) });
  if (options.novels) registerNovelRoutes(app, { ...options.novels, identity, getWork: id => options.repository.getWork(id) });
  if (options.lvpaopao) registerLvpaopaoRoutes(app, { store: options.lvpaopao.store, identity });
  registerDouyinSearchRoutes(app, { service: options.douyinSearch, identity });
  registerDouyinDownloadRoutes(app, { manager: options.douyinDownloads, identity, service: Boolean(options.service),
    ...(options.accountIdentity ? { client: async (request: Request) => { const result = await options.accountIdentity!(request); return result && 'id' in result ? result : null; } } : {}), ...(options.douyinDownloadsUnavailable ? { unavailable: options.douyinDownloadsUnavailable } : {}) });
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  if (options.staticRoot) {
    const firstScreen = async (session: SessionInfo): Promise<PageBootstrap | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BOOTSTRAP_WAIT_MS); });
      try { return await Promise.race([buildPageBootstrap(options.repository, options.scripts, session), timeout]); }
      catch (error) {
        // The page still loads; the client reads the same data over the API.
        console.error('[muse-data-web] first-screen data unavailable:', error instanceof Error ? error.name : 'Error');
        return null;
      } finally { clearTimeout(timer); }
    };
    const page = async (request: Request) => {
      const user = await identity(request);
      const html = withMuseSiteBar(await readFile(join(options.staticRoot!, 'index.html'), 'utf8'), user);
      const bootstrap = user ? await firstScreen({ ...user, mode }) : null;
      return bootstrap ? withPageBootstrap(html, bootstrap) : html;
    };
    app.get('/', async c => c.html(await page(c.req.raw)));
    app.get('/index.html', async c => c.html(await page(c.req.raw)));
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.status === 200 && !c.res.headers.get('Content-Type')?.startsWith('text/html')) c.header('Cache-Control', HASHED_ASSET_CACHE);
    });
    app.use('*', serveStatic({ root: options.staticRoot }));
    app.get('*', async c => c.html(await page(c.req.raw)));
  } else {
    app.get('/', c => c.text('Muse 数据 Web API 已启动，请先构建前端。'));
  }
  return { app, waitForCollections: () => manager.waitForIdle() };
}
