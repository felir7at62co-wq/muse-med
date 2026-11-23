import type { Context, Hono } from 'hono';
import type { UserIdentity } from '../shared/types.ts';
import type { DouyinSearchStatus } from '../shared/douyin-search.ts';
import { DouyinSearchError, type DouyinSearchService } from './douyin-search.ts';

async function answer(context: Context, work: () => Promise<unknown>): Promise<Response> {
  try { return context.json(await work()); } catch (error) {
    if (error instanceof DouyinSearchError) return context.json({ error: error.message }, error.status);
    throw error;
  }
}

/** Registers member Douyin search and series listing; without a configured service every read answers 503. */
export function registerDouyinSearchRoutes(app: Hono, options: {
  service?: Pick<DouyinSearchService, 'searchPosts' | 'searchAccounts' | 'mixPosts'>;
  identity: (request: Request) => Promise<UserIdentity | null>;
}): void {
  const { service } = options;
  app.get('/api/douyin/status', c => c.json({ enabled: service !== undefined } satisfies DouyinSearchStatus));
  app.get('/api/douyin/search', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    if (!service) return c.json({ error: '抖音搜索尚未配置' }, 503);
    const type = c.req.query('type') ?? 'posts';
    const keyword = c.req.query('q') ?? '';
    const cursor = c.req.query('cursor');
    if (type === 'posts') return answer(c, () => service.searchPosts(user.id, keyword, cursor));
    if (type === 'accounts') return answer(c, () => service.searchAccounts(user.id, keyword, cursor));
    return c.json({ error: '搜索类型只能是作品或账号' }, 400);
  });
  app.get('/api/douyin/mix', async c => {
    const user = await options.identity(c.req.raw);
    if (!user) return c.json({ error: '请先登录' }, 401);
    if (!service) return c.json({ error: '抖音搜索尚未配置' }, 503);
    return answer(c, () => service.mixPosts(user.id, c.req.query('id') ?? '', c.req.query('cursor')));
  });
}
