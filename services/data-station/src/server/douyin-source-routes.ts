import type { Hono } from 'hono';
import { z } from 'zod';
import type { UserIdentity } from '../shared/types.ts';
import { MAX_DOUYIN_SOURCES } from '../shared/douyin-sources.ts';
import { DouyinSourceError, type DouyinSourceStore } from './douyin-source-store.ts';

/** Registers administrator-only source settings and read-only public-source verification. */
export function registerDouyinSourceRoutes(app: Hono, options: {
  store: DouyinSourceStore;
  identity: (request: Request) => Promise<UserIdentity | null>;
}): void {
  app.use('/api/admin/douyin/*', async (c, next) => {
    if ((await options.identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以管理抖音来源' }, 403);
    await next();
  });
  app.get('/api/admin/douyin/sources', async c => c.json({ sources: await options.store.list(), maxSources: MAX_DOUYIN_SOURCES }));
  app.post('/api/admin/douyin/sources/validate', async c => c.json(await options.store.validate(await c.req.json())));
  app.post('/api/admin/douyin/sources', async c => c.json(await options.store.save(await c.req.json()), 201));
  app.put('/api/admin/douyin/sources/:id', async c => {
    const revision = c.req.header('if-match');
    if (!revision) throw new DouyinSourceError('请携带来源版本再保存，或刷新页面后重试', 400);
    z.string().datetime().parse(revision);
    return c.json(await options.store.save(await c.req.json(), c.req.param('id'), revision));
  });
  app.patch('/api/admin/douyin/sources/:id', async c => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json());
    return c.json(await options.store.setEnabled(c.req.param('id'), enabled));
  });
  app.delete('/api/admin/douyin/sources/:id', async c => {
    const removed = await options.store.remove(c.req.param('id'));
    return removed ? c.json({ removed: true }) : c.json({ error: '来源不存在，请刷新列表' }, 404);
  });
}
