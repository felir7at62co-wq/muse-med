import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/server/app.ts';
import { DataRepository } from '../src/server/repository.ts';
import { CollectionManager } from '../src/server/collection-manager.ts';
import { DiscoveryManager } from '../src/server/discovery/manager.ts';
import { resolve } from 'node:path';

describe('discovery administration before connectors are installed', () => {
  const database = new PGlite();
  const repository = new DataRepository(database);
  const collections = new CollectionManager(repository, {});
  const discovery = new DiscoveryManager(repository, collections, {}, { directory: resolve('.data/test-discovery-unused'), intervalMs: 21_600_000, pageBudget: 2, requestsPerMinute: 30, maxRetries: 1, resumeDelayMs: 60_000 });
  const app = createApp({ repository, manager: collections, discovery, identity: async request => {
    const user = request.headers.get('x-test-user');
    return user ? { id: user, name: user, role: user === 'admin' ? 'admin' : 'member' } : null;
  } }).app;
  const get = (user?: string) => app.request('http://127.0.0.1:4317/api/admin/discovery', { headers: user ? { 'x-test-user': user } : {} });
  const run = (user: string) => app.request('http://127.0.0.1:4317/api/admin/discovery/hongguo/run', { method: 'POST', headers: { 'x-test-user': user, origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }, body: '{}' });
  beforeAll(async () => { await repository.initialize({ seedDemo: false }); await collections.initialize(); await discovery.initialize(); });
  afterAll(async () => { await discovery.stop(); await collections.stop(); await database.close(); });
  it('keeps queue controls private and refuses a missing connector instead of reporting success', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('member')).status).toBe(403);
    expect((await run('member')).status).toBe(403);
    const response = await get('admin');
    expect(response.status).toBe(200);
    const statuses = await response.json();
    expect(statuses).toHaveLength(4);
    expect(statuses.every((value: { state: string }) => value.state === 'not_configured')).toBe(true);
    expect((await run('admin')).status).toBe(503);
    const invalid = await app.request('http://127.0.0.1:4317/api/admin/discovery/hongguo/run', { method: 'POST',
      headers: { 'x-test-user': 'admin', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' }, body: '{"unexpected":true}' });
    expect(invalid.status).toBe(400);
  });
});
