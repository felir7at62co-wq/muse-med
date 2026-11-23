import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMuseGatewayLookup, createMuseSessionIdentity, museGatewayOrigin, type MuseAccount } from '../src/server/identity.ts';
import { createApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { DataRepository } from '../src/server/repository.ts';

const secret = 'c3'.repeat(32);
const token = 'session_token_value_1234567890';
const publicOrigin = 'https://muse.aigc-pipeline.cn';
const localOrigin = 'http://127.0.0.1:19617';
const accounts = { version: 1, proxySecret: secret, users: [
  { username: 'userb', id: 'person-001', name: '站点管理员', role: 'admin' },
  { username: '甲组成员', id: 'person-002', name: '甲组成员', role: 'member' },
] };
let directory: string;
let sequence = 0;
beforeAll(async () => {
  await mkdir(resolve('.data'), { recursive: true });
  directory = await realpath(await mkdtemp(resolve('.data/muse-session-test-')));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function file(value: unknown = accounts): Promise<string> {
  const path = join(directory, `accounts-${sequence++}.json`);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
function headers(cookie = `theme=dark; __Host-muse=${token}`, key = secret): Record<string, string> {
  return { 'X-Muse-Data-Key': key, Cookie: cookie };
}
function account(username: string, admin = false): MuseAccount {
  return { version: 1, accountId: `account-${username}`, username, admin };
}

describe('Muse sign-in identity', () => {
  it('maps a listed Muse account to its private role and denies everyone else by reason', async () => {
    const lookup = vi.fn(async (value: string) => value === token ? account('userb', true) : null);
    const provider = await createMuseSessionIdentity(await file(), { lookup, cacheMs: 0 });
    expect(await provider(new Request(localOrigin, { headers: headers() }))).toEqual({ id: 'person-001', name: '站点管理员', role: 'admin',
      muse: { username: 'userb', admin: true } });
    expect(lookup).toHaveBeenCalledWith(token);
    expect(await provider(new Request(localOrigin, { headers: headers(`__Host-muse=${token}`, 'd4'.repeat(32)) }))).toBeNull();
    expect(await provider(new Request(localOrigin, { headers: { Cookie: `__Host-muse=${token}` } }))).toBeNull();
    for (const cookie of ['', 'muse=abc', '__Host-muse=short', '__Host-muse=has space in it 1234']) {
      expect(await provider(new Request(localOrigin, { headers: headers(cookie) }))).toEqual({ denied: 'login' });
    }
    expect(await provider(new Request(localOrigin, { headers: headers(`__Host-muse=${'x'.repeat(30)}`) }))).toEqual({ denied: 'login' });
    const outsider = await createMuseSessionIdentity(await file(), { lookup: async () => account('someone-else', true), cacheMs: 0 });
    expect(await outsider(new Request(localOrigin, { headers: headers() }))).toEqual({ denied: 'forbidden' });
    const member = await createMuseSessionIdentity(await file(), { lookup: async () => account('甲组成员'), cacheMs: 0 });
    expect(await member(new Request(localOrigin, { headers: headers() }))).toMatchObject({ role: 'member', muse: { username: '甲组成员', admin: false } });
    const down = await createMuseSessionIdentity(await file(), { lookup: async () => { throw new Error('gateway down'); }, cacheMs: 0 });
    expect(await down(new Request(localOrigin, { headers: headers() }))).toEqual({ denied: 'unavailable' });
  });

  it('caches accepted and refused accounts for the configured time but never a missing sign-in', async () => {
    const clock = { value: 0 };
    let current: MuseAccount | null = account('userb');
    const lookup = vi.fn(async () => current);
    const provider = await createMuseSessionIdentity(await file(), { lookup, cacheMs: 60_000, now: () => clock.value });
    const ask = () => provider(new Request(localOrigin, { headers: headers() }));
    expect(await ask()).toMatchObject({ id: 'person-001' });
    clock.value = 59_999; expect(await ask()).toMatchObject({ id: 'person-001' });
    expect(lookup).toHaveBeenCalledTimes(1);
    current = null; clock.value = 60_000;
    expect(await ask()).toEqual({ denied: 'login' });
    expect(await ask()).toEqual({ denied: 'login' });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('accepts non-ASCII Muse usernames but keeps duplicate and malformed account files rejected', async () => {
    await expect(createMuseSessionIdentity(await file({ ...accounts, users: [accounts.users[0], { ...accounts.users[1], username: 'userb' }] }), { lookup: async () => null, cacheMs: 0 })).rejects.toThrow();
    await expect(createMuseSessionIdentity(await file({ ...accounts, users: [{ ...accounts.users[0], username: ' userb' }] }), { lookup: async () => null, cacheMs: 0 })).rejects.toThrow();
    await expect(createMuseSessionIdentity(await file(), { lookup: async () => null, cacheMs: -1 })).rejects.toThrow('cache');
  });
});

describe('Muse gateway lookup', () => {
  let server: Server;
  let origin: string;
  const seen: IncomingHttpHeaders[] = [];
  let reply: { status: number; body: string; location?: string } = { status: 200, body: '' };
  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request.headers);
      expect(request.url).toBe('/api/muse/identity');
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.location ? { location: reply.location } : {} });
      response.end(reply.body);
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(async () => { await new Promise(done => server.close(done)); });

  it('sends only the session cookie and public Host, and treats rejected sessions as signed out', async () => {
    const lookup = createMuseGatewayLookup(origin, 'muse.aigc-pipeline.cn', 2_000);
    reply = { status: 200, body: JSON.stringify({ version: 1, accountId: 'a1', username: 'userb', admin: true }) };
    expect(await lookup(token)).toEqual({ version: 1, accountId: 'a1', username: 'userb', admin: true });
    expect(seen.at(-1)).toMatchObject({ host: 'muse.aigc-pipeline.cn', cookie: `__Host-muse=${token}` });
    for (const status of [401, 403]) { reply = { status, body: '{}' }; expect(await lookup(token)).toBeNull(); }
    reply = { status: 303, body: '', location: '/login' }; expect(await lookup(token)).toBeNull();
    reply = { status: 500, body: '{}' }; await expect(lookup(token)).rejects.toThrow('HTTP 500');
    reply = { status: 200, body: '{"version":1}' }; await expect(lookup(token)).rejects.toThrow();
  });

  it('accepts only loopback HTTP gateway origins', () => {
    expect(museGatewayOrigin('http://127.0.0.1:19389')).toBe('http://127.0.0.1:19389');
    for (const value of ['https://127.0.0.1:19389', 'http://example.com:19389', 'http://127.0.0.1:19389/api', 'http://user:pw@127.0.0.1:1']) {
      expect(() => museGatewayOrigin(value)).toThrow();
    }
  });
});

describe('server requests with Muse sign-in', () => {
  let database: PGlite, repository: DataRepository, staticRoot: string;
  beforeAll(async () => {
    database = new PGlite(); repository = new DataRepository(database); await repository.initialize({ seedDemo: false });
    staticRoot = join(directory, 'static'); await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Muse data</title><body><div id="root"></div></body>');
  });
  afterAll(async () => { await database.close(); });
  const app = async (result: MuseAccount | null | Error) => {
    const identity = await createMuseSessionIdentity(await file(), { cacheMs: 0,
      lookup: async () => { if (result instanceof Error) throw result; return result; } });
    return createApp({ repository, identity, mode: 'server', authentication: 'muse-session', publicOrigin, port: 19617, staticRoot }).app;
  };

  it('sends signed-out page loads to Muse sign-in and tells the page client where to go', async () => {
    const server = await app(null);
    const page = await server.request(`${localOrigin}/`, { headers: headers() });
    expect(page.status).toBe(303); expect(page.headers.get('location')).toBe('/login');
    const api = await server.request(`${localOrigin}/api/works`, { headers: headers() });
    expect(api.status).toBe(401); expect(api.headers.get('X-Muse-Data-Login')).toBe('/login');
    const unproxied = await server.request(`${localOrigin}/`, { headers: { Cookie: `__Host-muse=${token}` } });
    expect(unproxied.status).toBe(401); expect(unproxied.headers.get('location')).toBeNull();
  });

  it('shows a notice to signed-in Muse users who are not on the list, and when the gateway is down', async () => {
    const outsider = await app(account('someone-else'));
    const page = await outsider.request(`${localOrigin}/`, { headers: headers() });
    expect(page.status).toBe(403); expect(await page.text()).toContain('数据站尚未对你开放');
    const api = await outsider.request(`${localOrigin}/api/session`, { headers: headers() });
    expect(api.status).toBe(403); expect(api.headers.get('X-Muse-Data-Authenticated')).toBeNull();
    const down = await app(new Error('gateway down'));
    expect((await down.request(`${localOrigin}/`, { headers: headers() })).status).toBe(503);
    expect((await down.request(`${localOrigin}/api/works`, { headers: headers() })).status).toBe(503);
  });

  it('serves listed users with their private role and Muse account for the shared top bar', async () => {
    const server = await app(account('userb', true));
    for (const path of ['/', '/index.html', '/some/spa/route']) {
      const page = await server.request(`${localOrigin}${path}`, { headers: headers() });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<body class="has-muse-bar"><header class="muse-site-bar"');
      const labels = [...html.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(match => match[1]);
      expect(labels).toEqual(['工作台', '我的电脑', '意见箱', '数据站', '用户管理', 'Token 用量', 'userb']);
      expect(html).toContain('<a href="/data/" aria-current="page">数据站</a>');
    }
    const body = await (await server.request(`${localOrigin}/api/session`, { headers: headers() })).text();
    expect(JSON.parse(body)).toEqual({ id: 'person-001', name: '站点管理员', role: 'admin', mode: 'server', muse: { username: 'userb', admin: true } });
    expect(body).not.toContain(token);
    const health = await server.request(`${localOrigin}/api/health`);
    expect(await health.json()).toMatchObject({ auth: 'muse-session' });
  });

  it('omits Muse administrator links for ordinary Muse accounts and escapes the account name', async () => {
    const identity = await createMuseSessionIdentity(await file({ ...accounts, users: [{ ...accounts.users[0], username: '<b>userb</b>' }] }),
      { cacheMs: 0, lookup: async () => account('<b>userb</b>') });
    const server = createApp({ repository, identity, mode: 'server', authentication: 'muse-session', publicOrigin, port: 19617, staticRoot }).app;
    const html = await (await server.request(`${localOrigin}/`, { headers: headers() })).text();
    expect(html).not.toContain('用户管理'); expect(html).toContain('&lt;b&gt;userb&lt;/b&gt;'); expect(html).not.toContain('<b>userb</b>');
  });

  it('requires explicit server mode and a loopback gateway in configuration', async () => {
    expect(() => resolveConfig({ MUSE_DATA_AUTHENTICATION: 'muse-session' })).toThrow('explicit server mode');
    const identityFile = await file();
    const configured = resolveConfig({ MUSE_DATA_MODE: 'server', MUSE_DATA_PUBLIC_ORIGIN: publicOrigin, MUSE_DATA_IDENTITY_FILE: identityFile,
      MUSE_DATA_AUTHENTICATION: 'muse-session' });
    expect(configured).toMatchObject({ authentication: 'muse-session', museGateway: 'http://127.0.0.1:19389', museSessionCacheMs: 60_000 });
    expect(() => resolveConfig({ MUSE_DATA_MODE: 'server', MUSE_DATA_PUBLIC_ORIGIN: publicOrigin, MUSE_DATA_IDENTITY_FILE: identityFile,
      MUSE_DATA_AUTHENTICATION: 'muse-session', MUSE_DATA_MUSE_GATEWAY: 'http://example.com:19389' })).toThrow('loopback');
  });
});
