/** HTTP routes of the 绿泡泡 collector: token-authenticated `/api/service/lvpaopao/*` and member/admin status pages. */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { UserIdentity } from '../../shared/types.ts';
import { LVPAOPAO_ACTIONS } from '../../shared/lvpaopao.ts';
import { ackSchema, heartbeatSchema, loginScreenSchema, MAX_LOGIN_SCREEN_BYTES, runSchema } from './contract.ts';
import { LvpaopaoConflictError, type LvpaopaoStore } from './store.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface LvpaopaoRouteOptions {
  store: LvpaopaoStore;
  identity: (request: Request) => Promise<UserIdentity | null>;
}

/**
 * Registers the 绿泡泡 routes. The caller's middleware authenticates `/api/service/lvpaopao/*` with the collector token
 * before these handlers run.
 */
export function registerLvpaopaoRoutes(app: Hono, { store, identity }: LvpaopaoRouteOptions): void {
  app.post('/api/service/lvpaopao/runs', async c => {
    try { return c.json({ accepted: true, ...await store.ingestRun(runSchema.parse(await c.req.json())) }); }
    catch (error) {
      if (error instanceof LvpaopaoConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.post('/api/service/lvpaopao/heartbeat', async c => c.json(await store.heartbeat(heartbeatSchema.parse(await c.req.json()))));
  app.post('/api/service/lvpaopao/commands/:id/ack', async c => {
    ackSchema.parse(await c.req.json());
    return c.json({ removed: await store.acknowledge(z.string().regex(/^c-[0-9a-f-]{36}$/).parse(c.req.param('id'))) });
  });
  app.put('/api/service/lvpaopao/login-screen', async c => {
    const input = loginScreenSchema.parse(await c.req.json());
    const png = Buffer.from(input.png, 'base64');
    if (png.length > MAX_LOGIN_SCREEN_BYTES) return c.json({ error: '截图过大' }, 413);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return c.json({ error: '截图必须是 PNG' }, 400);
    store.putLoginScreen(png, input.capturedAt, input.kind);
    return c.json({ stored: true });
  });
  app.delete('/api/service/lvpaopao/login-screen', c => { store.clearLoginScreen(); return c.json({ removed: true }); });

  app.get('/api/lvpaopao/status', async c => c.json(await store.status()));
  app.get('/api/admin/lvpaopao', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看绿泡泡采集端' }, 403);
    return c.json(await store.adminStatus());
  });
  app.get('/api/admin/lvpaopao/login-screen', async c => {
    if ((await identity(c.req.raw))?.role !== 'admin') return c.json({ error: '只有管理员可以查看登录二维码' }, 403);
    const screen = store.currentLoginScreen();
    if (!screen) return c.json({ error: '当前没有登录截图' }, 404);
    return c.body(new Uint8Array(screen.png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  });
  app.post('/api/admin/lvpaopao/commands', async c => {
    const user = await identity(c.req.raw);
    if (user?.role !== 'admin') return c.json({ error: '只有管理员可以操作绿泡泡采集端' }, 403);
    const { action } = z.object({ action: z.enum(LVPAOPAO_ACTIONS) }).strict().parse(await c.req.json());
    return c.json(await store.enqueue(action, user.name), 202);
  });
}
