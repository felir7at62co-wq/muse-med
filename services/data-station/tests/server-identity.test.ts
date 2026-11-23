import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createTrustedProxyIdentity } from '../src/server/identity.ts';
import { createApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { DataRepository } from '../src/server/repository.ts';
import { acquireDatabaseLock } from '../src/server/lock.ts';

const secret = 'a1'.repeat(32);
const publicOrigin = 'https://muse.aigc-pipeline.cn';
const localOrigin = 'http://127.0.0.1:19617';
const identityData = { version: 1, proxySecret: secret, users: [
  { username: 'owner', id: 'person-001', name: '站点管理员', role: 'admin' },
  { username: 'maker', id: 'person-002', name: '制作成员', role: 'member' },
] };
let directory: string;
let sequence = 0;
beforeAll(async () => {
  await mkdir(resolve('.data'), { recursive: true });
  directory = await realpath(await mkdtemp(resolve('.data/server-identity-test-')));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function file(value: unknown = identityData, mode = 0o600): Promise<string> {
  const path = join(directory, `accounts-${sequence++}.json`);
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
  return path;
}
function headers(user = 'maker', key = secret): Record<string, string> {
  return { 'X-Muse-Data-Key': key, 'X-Muse-Data-User': user };
}

describe('private data-station identity file', () => {
  it('accepts private 0600 and group-readable 0640 files without exposing their secret', async () => {
    for (const mode of [0o600, 0o640]) {
      const provider = await createTrustedProxyIdentity(await file(identityData, mode));
      const user = await provider(new Request(localOrigin, { headers: headers('owner') }));
      expect(user).toEqual({ id: 'person-001', name: '站点管理员', role: 'admin' });
      expect(JSON.stringify(user)).not.toContain(secret);
    }
  });

  it.each([
    { ...identityData, version: 2 },
    { ...identityData, proxySecret: 'not-a-secret' },
    { ...identityData, proxySecret: 'f'.repeat(63) },
    { ...identityData, users: [] },
    { ...identityData, users: [{ ...identityData.users[0], role: 'superadmin' }] },
    { ...identityData, users: [{ ...identityData.users[0], username: 'name:password' }] },
    { ...identityData, users: [{ ...identityData.users[0], username: 'a'.repeat(65) }] },
    { ...identityData, users: [{ ...identityData.users[0], id: ' invalid ' }] },
    { ...identityData, users: [{ ...identityData.users[0], name: 'line\nbreak' }] },
    { ...identityData, users: [identityData.users[0], { ...identityData.users[1], id: 'person-001' }] },
    { ...identityData, users: [identityData.users[0], { ...identityData.users[1], username: 'owner' }] },
    { ...identityData, unexpected: true },
    { ...identityData, users: [{ ...identityData.users[0], password: 'never-return-this' }] },
  ])('refuses invalid, ambiguous or undeclared account fields', async value => {
    await expect(createTrustedProxyIdentity(await file(value))).rejects.toThrow('identity JSON is invalid');
  });

  it('rejects public, group-writable, oversized, empty, linked and non-file locations', async () => {
    for (const mode of [0o644, 0o604, 0o660, 0o666]) await expect(createTrustedProxyIdentity(await file(identityData, mode))).rejects.toThrow('private regular file');
    const large = await file(); await writeFile(large, ' '.repeat(1_048_577));
    await expect(createTrustedProxyIdentity(large)).rejects.toThrow('private regular file');
    const empty = await file(); await writeFile(empty, '');
    await expect(createTrustedProxyIdentity(empty)).rejects.toThrow('private regular file');
    const original = await file(), linked = join(directory, 'linked.json'); await symlink(original, linked);
    await expect(createTrustedProxyIdentity(linked)).rejects.toThrow('private regular file');
    await expect(createTrustedProxyIdentity(directory)).rejects.toThrow('private regular file');
    await expect(createTrustedProxyIdentity('relative.json')).rejects.toThrow('private regular file');
  });

  it('uses maps for prototype-like account names and never infers unknown inherited identities', async () => {
    const provider = await createTrustedProxyIdentity(await file({ ...identityData, users: [
      { username: '__proto__', id: 'p1', name: '成员一', role: 'member' },
      { username: 'constructor', id: 'p2', name: '成员二', role: 'member' },
    ] }));
    expect(await provider(new Request(localOrigin, { headers: { ...headers('__proto__'), 'X-Muse-Data-Role': 'admin' } }))).toMatchObject({ id: 'p1', role: 'member' });
    expect(await provider(new Request(localOrigin, { headers: headers('constructor') }))).toMatchObject({ id: 'p2', role: 'member' });
    expect(await provider(new Request(localOrigin, { headers: headers('toString') }))).toBeNull();
  });

  it('rejects absent, malformed, duplicated and incorrect keys before looking up an account', async () => {
    const provider = await createTrustedProxyIdentity(await file());
    for (const key of ['', 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32), 'b1'.repeat(32), `${secret}, ${secret}`]) {
      expect(await provider(new Request(localOrigin, { headers: headers('owner', key) }))).toBeNull();
    }
    expect(await provider(new Request(localOrigin, { headers: { 'X-Muse-Data-User': 'owner', Authorization: 'Basic fake', Cookie: 'role=admin' } }))).toBeNull();
    expect(await provider(new Request(localOrigin, { headers: headers('unknown') }))).toBeNull();
  });

  it('takes an account snapshot at startup and requires reloading for role changes or revocation', async () => {
    const path = await file(), provider = await createTrustedProxyIdentity(path);
    await writeFile(path, JSON.stringify({ ...identityData, users: [{ ...identityData.users[0], role: 'member' }] }));
    expect(await provider(new Request(localOrigin, { headers: headers('owner') }))).toMatchObject({ role: 'admin' });
    const reloaded = await createTrustedProxyIdentity(path);
    expect(await reloaded(new Request(localOrigin, { headers: headers('owner') }))).toMatchObject({ role: 'member' });
    expect(await reloaded(new Request(localOrigin, { headers: headers('maker') }))).toBeNull();
  });
});

describe('server-mode configuration', () => {
  it('keeps local preview the default and requires explicit origin plus private identity file for server mode', async () => {
    expect(resolveConfig({}).mode).toBe('local-preview');
    expect(() => resolveConfig({ MUSE_DATA_MODE: 'server' })).toThrow('requires');
    expect(() => resolveConfig({ MUSE_DATA_MODE: 'server', MUSE_DATA_PUBLIC_ORIGIN: publicOrigin })).toThrow('requires');
    const identityFile = await file();
    const configured = resolveConfig({ MUSE_DATA_MODE: 'server', MUSE_DATA_PUBLIC_ORIGIN: publicOrigin, MUSE_DATA_IDENTITY_FILE: identityFile });
    expect(configured).toMatchObject({ mode: 'server', publicOrigin, identityFile, hostname: '127.0.0.1' });
    expect(() => resolveConfig({ MUSE_DATA_PUBLIC_ORIGIN: publicOrigin, MUSE_DATA_IDENTITY_FILE: identityFile })).toThrow('explicit server');
  });

  it.each(['http://muse.aigc-pipeline.cn', 'https://muse.aigc-pipeline.cn/', 'https://muse.aigc-pipeline.cn/data/',
    'https://user:pass@muse.aigc-pipeline.cn', 'https://muse.aigc-pipeline.cn?query=1', 'https://muse.aigc-pipeline.cn#fragment'])('rejects non-origin public URLs: %s', async origin => {
    expect(() => resolveConfig({ MUSE_DATA_MODE: 'server', MUSE_DATA_PUBLIC_ORIGIN: origin, MUSE_DATA_IDENTITY_FILE: resolve(directory, 'unused.json') })).toThrow('exact HTTPS origin');
  });
});

describe('trusted proxy server requests', () => {
  let database: PGlite, repository: DataRepository, provider: Awaited<ReturnType<typeof createTrustedProxyIdentity>>, staticRoot: string;
  beforeAll(async () => {
    database = new PGlite(); repository = new DataRepository(database); await repository.initialize({ seedDemo: false });
    provider = await createTrustedProxyIdentity(await file());
    staticRoot = join(directory, 'static'); await mkdir(staticRoot);
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Independent data site</title>');
    await writeFile(join(staticRoot, 'app.js'), 'console.log("safe asset");');
  });
  afterAll(async () => { await database.close(); });
  const app = () => createApp({ repository, identity: provider, mode: 'server', publicOrigin, port: 19617, staticRoot }).app;

  it('fails before serving when the identity provider or public origin is missing', () => {
    expect(() => createApp({ repository, mode: 'server', publicOrigin })).toThrow('requires');
    expect(() => createApp({ repository, mode: 'server', identity: provider })).toThrow('requires');
    expect(() => createApp({ repository, mode: 'server', identity: provider, publicOrigin: 'http://invalid.example' })).toThrow('HTTPS origin');
    expect(() => createApp({ repository, identity: provider, publicOrigin })).toThrow('explicit server mode');
  });

  it('protects every static asset, SPA route and unknown path, leaving only exact GET/HEAD health requests public', async () => {
    const server = app();
    for (const path of ['/', '/app.js', '/unknown', '/api/session', '/api/works', '/api/health/', '/api/health-guess', '/api/no-such-route']) {
      const response = await server.request(`${localOrigin}${path}`);
      expect(response.status).toBe(401); expect(response.headers.get('X-Muse-Data-Authenticated')).toBeNull();
    }
    for (const method of ['GET', 'HEAD']) expect((await server.request(`${localOrigin}/api/health`, { method })).status).toBe(200);
    expect((await server.request(`${localOrigin}/api/health`, { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await server.request(`${localOrigin}/app.js`, { headers: headers() })).status).toBe(200);
  });

  it('rejects fake proxy keys, fake identities and forged roles, cookies or authorization headers', async () => {
    const server = app();
    for (const h of [headers('owner', 'b1'.repeat(32)), headers('anonymous'), { Authorization: 'Basic fake', Cookie: 'admin=1', 'X-Muse-Data-Role': 'admin' }]) {
      expect((await server.request(`${localOrigin}/api/session`, { headers: h })).status).toBe(401);
    }
    const member = await server.request(`${localOrigin}/api/session`, { headers: { ...headers(), 'X-Muse-Data-Role': 'admin' } });
    expect(await member.json()).toEqual({ id: 'person-002', name: '制作成员', role: 'member', mode: 'server' });
    expect(member.headers.get('X-Muse-Data-Authenticated')).toBe('1');
  });

  it('allows configured HTTPS-origin writes and preserves member management denials as authenticated 403 responses', async () => {
    const server = app();
    const member = await server.request(`${localOrigin}/api/admin/settings`, { headers: headers() });
    expect(member.status).toBe(403); expect(member.headers.get('X-Muse-Data-Authenticated')).toBe('1');
    const admin = await server.request(`${localOrigin}/api/admin/settings`, { method: 'PUT', headers: { ...headers('owner'), origin: publicOrigin, 'content-type': 'application/json' }, body: '{"intervalHours":12}' });
    expect(admin.status).toBe(200); expect(await admin.json()).toEqual({ intervalHours: 12 });
  });

  it('rejects missing and cross-site origins even with a real identity and ignores forwarded origin headers', async () => {
    const server = app();
    for (const origin of [undefined, 'https://evil.example', localOrigin, 'null']) {
      const h: Record<string, string> = { ...headers('owner'), 'content-type': 'application/json', 'X-Forwarded-Host': 'muse.aigc-pipeline.cn', 'X-Forwarded-Proto': 'https' };
      if (origin !== undefined) h.origin = origin;
      expect((await server.request(`${localOrigin}/api/admin/settings`, { method: 'PUT', headers: h, body: '{"intervalHours":12}' })).status).toBe(403);
    }
    expect((await server.request(`${localOrigin}/api/works`, { headers: { ...headers(), origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('checks both Host and request URL for health, API and static routes without trusting forwarded headers', async () => {
    const server = app();
    for (const path of ['/api/health', '/api/session', '/app.js']) {
      const h = { ...headers('owner'), 'X-Forwarded-Host': '127.0.0.1:19617', 'X-Forwarded-Proto': 'http' };
      expect((await server.request(`https://evil.example${path}`, { headers: { ...h, Host: '127.0.0.1:19617' } })).status).toBe(403);
      expect((await server.request(`${localOrigin}${path}`, { headers: { ...h, Host: 'evil.example' } })).status).toBe(403);
    }
  });

  it('reports real mode and authentication without returning account lists, keys or paths', async () => {
    const server = app(), health = await server.request(`${localOrigin}/api/health`);
    expect(await health.json()).toEqual({ app: 'muse-data-web', mode: 'server', auth: 'trusted-proxy', storage: 'embedded-postgresql' });
    const session = await server.request(`${localOrigin}/api/session`, { headers: headers() });
    const body = await session.text(); expect(body).not.toContain(secret); expect(body).not.toContain('users'); expect(body).not.toContain(directory);
  });
});

it('releases the independent database lock when initialization fails before listening', async () => {
  const path = join(directory, 'failed-start'); await mkdir(path);
  const outside = join(directory, 'not-script-storage'); await mkdir(outside); await symlink(outside, join(path, 'script-files'));
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve('src/server/main.ts')], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, MUSE_DATA_DIRECTORY: path, MUSE_DATA_MODE: 'local-preview', MUSE_DATA_AUTO_COLLECT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Startup failure test timed out')); }, 20_000);
    child.stderr.resume(); child.once('error', reject); child.once('close', status => { clearTimeout(timeout); done(status); });
  });
  expect(code).not.toBe(0);
  await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  const release = await acquireDatabaseLock(path); await release();
});
