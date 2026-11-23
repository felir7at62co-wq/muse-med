import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { UserIdentity } from '../shared/types.ts';
import type { DouyinDownloadStatus } from '../shared/douyin-downloads.ts';
import { DouyinSearchError } from './douyin-search.ts';
import { DouyinDownloadError, type DouyinDownloadManager } from './douyin-downloads.ts';

async function answer(context: Context, work: () => Promise<unknown>, created = false): Promise<Response> {
  try { return context.json(await work(), created ? 202 : 200); } catch (error) {
    if (error instanceof DouyinDownloadError || error instanceof DouyinSearchError) return context.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: '请求参数无效' }, 400);
    throw error;
  }
}

/** Registers member Douyin → TOS downloads; without TOS credentials and DTK every route says downloads are not set up. */
export function registerDouyinDownloadRoutes(app: Hono, options: {
  manager?: Pick<DouyinDownloadManager, 'status' | 'list' | 'requestPost' | 'requestMix' | 'link' | 'get'>;
  identity: (request: Request) => Promise<UserIdentity | null>;
  /** Registers `/api/service/douyin/*` for Muse's tool; the global middleware has already checked the service token. */
  service?: boolean;
  /** Registers `/api/muse-client/douyin/*` for desktop Muse; returns the member verified by the global middleware. */
  client?: (request: Request) => Promise<UserIdentity | null>;
  /** Why downloads are off when there is no manager; defaults to 「TOS 未配置」. */
  unavailable?: string;
}): void {
  const { manager } = options;
  const reason = options.unavailable ?? 'TOS 未配置';
  const member = async (c: Context): Promise<UserIdentity | Response> => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    if (!manager) return c.json({ error: `${reason}，暂时不能下载抖音视频` }, 503);
    return user;
  };
  app.get('/api/douyin/downloads/status', async c => {
    if (!manager) return c.json({ enabled: false, reason, access: 'public', linkSeconds: 0, dailyLimit: 0, usedToday: 0, unlimited: false, maxMixEpisodes: 0 } satisfies DouyinDownloadStatus);
    const user = await member(c);
    return user instanceof Response ? user : answer(c, () => manager.status(user));
  });
  app.get('/api/douyin/downloads', async c => {
    const user = await member(c);
    if (user instanceof Response) return user;
    return answer(c, async () => {
      const query = z.object({ mine: z.enum(['0', '1']).default('0'), mixId: z.string().regex(/^\d{1,32}$/).optional(),
        awemeIds: z.string().regex(/^\d{1,32}(?:,\d{1,32}){0,99}$/).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100) }).strict().parse(c.req.query());
      return manager!.list(user, { mine: query.mine === '1', limit: query.limit, ...(query.mixId ? { mixId: query.mixId } : {}),
        ...(query.awemeIds ? { awemeIds: query.awemeIds.split(',') } : {}) });
    });
  });
  app.post('/api/douyin/downloads', async c => {
    const user = await member(c);
    if (user instanceof Response) return user;
    return answer(c, async () => manager!.requestPost(user, z.object({ awemeId: z.string().max(40) }).strict().parse(await c.req.json()).awemeId), true);
  });
  app.post('/api/douyin/downloads/mix', async c => {
    const user = await member(c);
    if (user instanceof Response) return user;
    return answer(c, async () => manager!.requestMix(user, z.object({ mixId: z.string().max(40) }).strict().parse(await c.req.json()).mixId), true);
  });
  /** Redirects a signed-in member to the saved file: a signed link valid for the configured time, or the public address. */
  app.get('/api/douyin/downloads/:id/file', async c => {
    const user = await member(c);
    if (user instanceof Response) return user;
    try {
      const { url } = await manager!.link(c.req.param('id'));
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      return c.redirect(url, 302);
    } catch (error) {
      if (error instanceof DouyinDownloadError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  if (options.client) registerClientRoutes(app, manager, reason, options.client);
  if (!options.service) return;

  // Muse's Douyin tool: the same downloads as the web page, authenticated by the service token.
  // `requestedBy` names the Muse user; each name gets the members' daily limit and appears in the team's download log.
  const requester = z.string().trim().min(1).max(64).refine(value => !/[\p{Cc}]/u.test(value)).default('Muse');
  const serviceUser = (name: string): UserIdentity => ({ id: `muse-service:${name}`, name: `${name}（Muse）`, role: 'member' });
  const off = (c: Context) => c.json({ error: `${reason}，暂时不能下载抖音视频` }, 503);
  app.get('/api/service/douyin/downloads/status', async c => {
    if (!manager) return c.json({ enabled: false, reason, access: 'public', linkSeconds: 0, dailyLimit: 0, usedToday: 0, unlimited: false, maxMixEpisodes: 0 } satisfies DouyinDownloadStatus);
    return answer(c, async () => manager.status(serviceUser(requester.parse(c.req.query('requestedBy') ?? undefined))));
  });
  app.post('/api/service/douyin/downloads', async c => {
    if (!manager) return off(c);
    return answer(c, async () => {
      const body = z.object({ awemeId: z.string().max(40), requestedBy: requester }).strict().parse(await c.req.json());
      return manager.requestPost(serviceUser(body.requestedBy), body.awemeId);
    }, true);
  });
  app.post('/api/service/douyin/downloads/mix', async c => {
    if (!manager) return off(c);
    return answer(c, async () => {
      const body = z.object({ mixId: z.string().max(40), requestedBy: requester }).strict().parse(await c.req.json());
      return manager.requestMix(serviceUser(body.requestedBy), body.mixId);
    }, true);
  });
  app.get('/api/service/douyin/downloads', async c => {
    if (!manager) return off(c);
    return answer(c, async () => {
      const query = z.object({ awemeIds: z.string().regex(/^\d{1,32}(?:,\d{1,32}){0,99}$/).optional(), mixId: z.string().regex(/^\d{1,32}$/).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100) }).strict().refine(value => value.awemeIds || value.mixId, { message: 'awemeIds or mixId is required' }).parse(c.req.query());
      return manager.list(serviceUser('Muse'), { mine: false, limit: query.limit, ...(query.mixId ? { mixId: query.mixId } : {}),
        ...(query.awemeIds ? { awemeIds: query.awemeIds.split(',') } : {}) });
    });
  });
  /** One record with a file link when it is ready: the public address, or a signed link in private mode. */
  app.get('/api/service/douyin/downloads/:id', async c => {
    if (!manager) return off(c);
    return answer(c, async () => {
      const download = await manager.get(c.req.param('id'));
      if (!download) throw new DouyinDownloadError('下载记录不存在', 404);
      return { download, file: download.state === 'done' ? await manager.link(download.id) : null };
    });
  });
}

/**
 * Desktop Muse's Douyin downloads, as the signed-in member: the same records, daily limit and log entries as the web page.
 * The global middleware has already verified `X-Muse-Account-Token` and the member list.
 */
function registerClientRoutes(app: Hono, manager: Pick<DouyinDownloadManager, 'status' | 'list' | 'requestPost' | 'requestMix' | 'link' | 'get'> | undefined,
  reason: string, client: (request: Request) => Promise<UserIdentity | null>): void {
  const user = async (c: Context): Promise<UserIdentity | Response> => {
    const found = await client(c.req.raw);
    if (!found) return c.json({ error: '请先登录 Muse' }, 401);
    if (!manager) return c.json({ error: `${reason}，暂时不能下载抖音视频` }, 503);
    return found;
  };
  app.get('/api/muse-client/douyin/downloads/status', async c => {
    if (!manager) return c.json({ enabled: false, reason, access: 'public', linkSeconds: 0, dailyLimit: 0, usedToday: 0, unlimited: false, maxMixEpisodes: 0 } satisfies DouyinDownloadStatus);
    const member = await user(c);
    return member instanceof Response ? member : answer(c, () => manager.status(member));
  });
  app.post('/api/muse-client/douyin/downloads', async c => {
    const member = await user(c);
    if (member instanceof Response) return member;
    return answer(c, async () => manager!.requestPost(member, z.object({ awemeId: z.string().max(40) }).strict().parse(await c.req.json()).awemeId), true);
  });
  app.post('/api/muse-client/douyin/downloads/mix', async c => {
    const member = await user(c);
    if (member instanceof Response) return member;
    return answer(c, async () => manager!.requestMix(member, z.object({ mixId: z.string().max(40) }).strict().parse(await c.req.json()).mixId), true);
  });
  app.get('/api/muse-client/douyin/downloads', async c => {
    const member = await user(c);
    if (member instanceof Response) return member;
    return answer(c, async () => {
      const query = z.object({ awemeIds: z.string().regex(/^\d{1,32}(?:,\d{1,32}){0,99}$/).optional(), mixId: z.string().regex(/^\d{1,32}$/).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100) }).strict().refine(value => value.awemeIds || value.mixId, { message: 'awemeIds or mixId is required' }).parse(c.req.query());
      return manager!.list(member, { mine: false, limit: query.limit, ...(query.mixId ? { mixId: query.mixId } : {}),
        ...(query.awemeIds ? { awemeIds: query.awemeIds.split(',') } : {}) });
    });
  });
  app.get('/api/muse-client/douyin/downloads/:id', async c => {
    const member = await user(c);
    if (member instanceof Response) return member;
    return answer(c, async () => {
      const download = await manager!.get(c.req.param('id'));
      if (!download) throw new DouyinDownloadError('下载记录不存在', 404);
      return { download, file: download.state === 'done' ? await manager!.link(download.id) : null };
    });
  });
}
