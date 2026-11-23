import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuDirectory } from '../src/server/departments.ts';
import { createMuseSessionIdentity, type MuseAccount } from '../src/server/identity.ts';
import { resolveConfig } from '../src/server/config.ts';
import { displayName } from '../src/shared/types.ts';

const departments = [
  { open_department_id: 'od-hz', parent_department_id: '0', name: '杭州' },
  { open_department_id: 'od-aigc', parent_department_id: 'od-hz', name: 'AIGC制作部' },
  { open_department_id: 'od-jh', parent_department_id: 'od-aigc', name: '用户甲组' },
  { open_department_id: 'od-jh-sub', parent_department_id: 'od-jh', name: '编剧' },
  { open_department_id: 'od-fin', parent_department_id: 'od-hz', name: '财务部' },
];
const members: Record<string, { open_id: string; name: string; department_ids: string[] }[]> = {
  'od-jh': [{ open_id: 'ou-a', name: '用户甲', department_ids: ['od-jh'] }],
  'od-jh-sub': [{ open_id: 'ou-b', name: '编剧甲', department_ids: ['od-jh-sub'] }],
  'od-fin': [{ open_id: 'ou-c', name: '会计乙', department_ids: ['od-fin'] }],
};

describe('Feishu department admission', () => {
  let directory: string, appFile: string, linksFile: string, calls: string[], failing: boolean;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'departments-')));
    appFile = join(directory, 'feishu-app.json'); linksFile = join(directory, 'links.json');
    await writeFile(appFile, JSON.stringify({ appType: 'custom', appId: 'cli_app', appSecret: 'secret-value-123', redirectUri: 'https://x' }));
    await writeFile(linksFile, JSON.stringify({ version: 1, accounts: [
      { username: 'usera', accountId: 'acc-a', feishu: [{ appId: 'cli_app', openId: 'ou-a' }] },
      { username: 'writer', accountId: 'acc-b', feishu: [{ appId: 'other_app', openId: 'ou-x' }, { appId: 'cli_app', openId: 'ou-b' }] },
      { username: 'accountant', accountId: 'acc-c', feishu: [{ appId: 'cli_app', openId: 'ou-c' }] },
      { username: 'gone', accountId: 'acc-d', disabled: true, feishu: [{ appId: 'cli_app', openId: 'ou-a' }] },
    ] }));
    for (const file of [appFile, linksFile]) await chmod(file, 0o640);
    calls = []; failing = false;
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const create = () => new FeishuDirectory({ appFile, linksFile, allowed: ['用户甲组'], intervalMs: 3_600_000, cacheFile: join(directory, 'cache.json'), requestIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (failing) return json({ code: 99991663, msg: 'token invalid' });
      if (url.pathname.endsWith('/tenant_access_token/internal')) {
        expect(JSON.parse(String(init?.body))).toEqual({ app_id: 'cli_app', app_secret: 'secret-value-123' });
        return json({ code: 0, tenant_access_token: 't-1' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t-1');
      if (url.pathname.endsWith('/departments/0/children')) return json({ code: 0, data: { items: departments, has_more: false } });
      if (url.pathname.endsWith('/users/find_by_department')) return json({ code: 0, data: { items: members[url.searchParams.get('department_id')!] ?? [], has_more: false } });
      return json({ code: 404 });
    } });

  it('admits members of the named department and its sub-departments, with their department, through this app only', async () => {
    const feishu = create();
    await feishu.initialize();
    expect(feishu.lookup('usera')).toBeNull();
    await feishu.sync();
    expect(feishu.lookup('usera')).toEqual({ allowed: true, name: '用户甲', department: '用户甲组' });
    expect(feishu.lookup('writer')).toEqual({ allowed: true, name: '编剧甲', department: '编剧' });
    expect(feishu.lookup('accountant')).toEqual({ allowed: false, name: '会计乙', department: '财务部' });
    expect(feishu.lookup('gone')).toBeNull();
    expect(feishu.lookup('stranger')).toBeNull();
    expect(feishu.status()).toMatchObject({ state: 'success', departments: 5, people: 3, admitted: 2, linkedAccounts: 3 });
  });

  it('keeps the last good snapshot when a sync fails, also across restarts', async () => {
    const feishu = create();
    await feishu.initialize();
    await feishu.sync();
    failing = true;
    await feishu.sync();
    expect(feishu.status().state).toBe('failed');
    expect(feishu.lookup('usera')?.allowed).toBe(true);
    const restarted = create();
    await restarted.initialize();
    expect(restarted.lookup('writer')?.department).toBe('编剧');
  });

  it('refuses credential files that are readable by others', async () => {
    await chmod(appFile, 0o644);
    await expect(create().reloadLinks()).rejects.toThrow(/MUSE_DATA_FEISHU_APP_FILE must have mode/);
  });

  it('lets the Muse sign-in admit department members beyond the private list and label everyone', async () => {
    const feishu = create();
    await feishu.initialize();
    await feishu.sync();
    const identityFile = join(directory, 'identities.json');
    await writeFile(identityFile, JSON.stringify({ version: 1, proxySecret: 'f'.repeat(64), users: [{ username: 'accountant', id: 'muse-acc-c', name: '会计乙', role: 'admin' }] }));
    await chmod(identityFile, 0o600);
    const accounts: Record<string, MuseAccount> = { [`${'a'.repeat(20)}`]: { version: 1, accountId: 'acc-a', username: 'usera', admin: false },
      [`${'c'.repeat(20)}`]: { version: 1, accountId: 'acc-c', username: 'accountant', admin: false },
      [`${'s'.repeat(20)}`]: { version: 1, accountId: 'acc-s', username: 'stranger', admin: false } };
    const identity = await createMuseSessionIdentity(identityFile, { cacheMs: 0, directory: feishu, lookup: async token => accounts[token] ?? null });
    const request = (token: string) => new Request('http://127.0.0.1/', { headers: { 'X-Muse-Data-Key': 'f'.repeat(64), cookie: `__Host-muse=${token}` } });
    expect(await identity(request('a'.repeat(20)))).toEqual({ id: 'muse-acc-a', name: '用户甲', role: 'member', department: '用户甲组', muse: { username: 'usera', admin: false } });
    expect(await identity(request('c'.repeat(20)))).toEqual({ id: 'muse-acc-c', name: '会计乙', role: 'admin', department: '财务部', muse: { username: 'accountant', admin: false } });
    expect(await identity(request('s'.repeat(20)))).toEqual({ denied: 'forbidden' });
    expect(displayName({ name: '用户甲', department: '用户甲组' })).toBe('用户甲（用户甲组）');
    expect(displayName({ name: '本地预览' })).toBe('本地预览');
  });

  it('needs the app file, the links file and the departments together', () => {
    expect(resolveConfig({ MUSE_DATA_FEISHU_APP_FILE: '/srv/a.json', MUSE_DATA_FEISHU_LINKS_FILE: '/srv/l.json', MUSE_DATA_ACCESS_DEPARTMENTS: '用户甲组, od-x' }).feishuDirectory)
      .toEqual({ appFile: '/srv/a.json', linksFile: '/srv/l.json', allowed: ['用户甲组', 'od-x'], intervalMs: 3_600_000 });
    expect(() => resolveConfig({ MUSE_DATA_FEISHU_APP_FILE: '/srv/a.json' })).toThrow(/requires/);
    expect(resolveConfig({}).feishuDirectory).toBeUndefined();
  });
});
