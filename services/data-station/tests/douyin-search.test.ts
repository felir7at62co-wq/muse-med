import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { DouyinSearchBudget, DouyinSearchError, DouyinSearchService, DtkReader, douyinAccount, douyinPost, dtkKey, dtkOrigin, hongguoCandidates, titleKey } from '../src/server/douyin-search.ts';
import type { CollectionBatch, Work } from '../src/shared/types.ts';

const at = '2026-11-15T07:00:00.000Z';
const hongguo: Work = {
  id: 'hongguo:7500000000000000001', sourceId: '7500000000000000001', platform: 'hongguo', kind: 'drama', title: '万物有声：鉴宝天骄',
  author: null, description: '', coverUrl: null, sourceUrl: 'https://www.hongguo.com/', tags: [], category: '', episodeCount: 65,
  wordCount: null, serialStatus: '已完结', publishedAt: null, metrics: [], rank: 3, rankChange: null, board: '漫剧热播榜', origin: 'live', observedAt: at, sourceUpdatedAt: null,
};

function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'douyin', content_id: '7570000000000000001', kind: 'video', web_url: 'https://www.douyin.com/video/7570000000000000001?previous_page=search',
    title: '万物有声鉴宝天骄 林默觉醒异能', description: '#万物有声鉴宝天骄完整版 #漫剧推荐', created_at: '2026-11-10T12:00:00Z', duration_ms: 181_000,
    author: { uid: 'author-a', sec_uid: 'MS4wLjABAAAA-author-a', unique_id: 'creator_a', nickname: '剧场作者' },
    stats: { play_count: null, digg_count: 129, comment_count: 3, share_count: 19, collect_count: 36 },
    media: { covers: [{ url: 'https://p3-pc.douyinpic.com/cover.jpeg', urls: [] }] },
    tags: ['万物有声鉴宝天骄完整版', '漫剧推荐'],
    raw: { mix_info: { mix_id: '7529749968874113060', mix_name: 'AI短剧系列', statis: { current_episode: 238, updated_to_episode: 372 } } },
    ...overrides,
  };
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data, error: null, meta: {} }), { status, headers: { 'content-type': 'application/json' } });
}
function refusal(code: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, data: null, error: { code, message: 'private upstream detail' }, meta: {} }), { status });
}

describe('DTK configuration', () => {
  it('accepts only a loopback HTTP origin and a key-shaped secret', () => {
    expect(dtkOrigin('http://127.0.0.1:19580/')).toBe('http://127.0.0.1:19580');
    for (const bad of ['https://127.0.0.1:19580', 'http://10.0.0.1:19580', 'http://127.0.0.1', 'http://127.0.0.1:19580/api', 'http://u:p@127.0.0.1:1']) expect(() => dtkOrigin(bad)).toThrow();
    expect(dtkKey(' dtk_abcdefghijklmnop \n')).toBe('dtk_abcdefghijklmnop');
    expect(() => dtkKey('short')).toThrow();
  });

  it('needs both the origin and an absolute key file, and stays off without them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-data-dtk-'));
    expect(resolveConfig({}, root).dtkOrigin).toBeUndefined();
    expect(() => resolveConfig({ MUSE_DATA_DTK_ORIGIN: 'http://127.0.0.1:19580' }, root)).toThrow(/both/);
    expect(() => resolveConfig({ MUSE_DATA_DTK_ORIGIN: 'http://127.0.0.1:19580', MUSE_DATA_DTK_KEY_FILE: 'key' }, root)).toThrow(/absolute/);
    expect(resolveConfig({ MUSE_DATA_DTK_ORIGIN: 'http://127.0.0.1:19580', MUSE_DATA_DTK_KEY_FILE: '/etc/key' }, root)).toMatchObject({ dtkOrigin: 'http://127.0.0.1:19580', dtkKeyFile: '/etc/key' });
  });
});

describe('Douyin result projection', () => {
  it('keeps the series, drops unknown plays and the share-page query, and never invents counts', () => {
    const post = douyinPost(content({ stats: { digg_count: 129, comment_count: null, share_count: -1, collect_count: 36 } }))!;
    expect(post).toMatchObject({
      id: '7570000000000000001', url: 'https://www.douyin.com/video/7570000000000000001', coverUrl: 'https://p3-pc.douyinpic.com/cover.jpeg', durationMs: 181_000,
      author: { name: '剧场作者', secUid: 'MS4wLjABAAAA-author-a', handle: 'creator_a' },
      stats: { likes: 129, comments: null, shares: null, saves: 36 },
      mix: { id: '7529749968874113060', name: 'AI短剧系列', episode: 238, episodes: 372 }, hongguo: null,
    });
    expect(douyinPost(content({ content_id: 'not-an-id' }))).toBeNull();
    expect(douyinPost(content({ web_url: 'https://evil.example/video', raw: undefined }))).toMatchObject({ url: 'https://www.douyin.com/video/7570000000000000001', mix: null });
  });

  it('projects accounts by their stable id', () => {
    expect(douyinAccount({ uid: 'MS4wLjABAAAA-x', sec_uid: 'MS4wLjABAAAA-x', nickname: '万物有声', unique_id: 'wanwu', avatar: { url: 'https://p3.douyinpic.com/a.jpeg' }, stats: { follower_count: 1200, content_count: 30 } }))
      .toEqual({ secUid: 'MS4wLjABAAAA-x', name: '万物有声', handle: 'wanwu', signature: null, avatarUrl: 'https://p3.douyinpic.com/a.jpeg', followers: 1200, posts: 30, url: 'https://www.douyin.com/user/MS4wLjABAAAA-x' });
    expect(douyinAccount({ nickname: 'no id' })).toBeNull();
  });

  it('derives drama-name candidates from the series, 《》 titles, the leading phrase and hashtags without promotion words', () => {
    const post = douyinPost(content({ title: '《超长版》万物有声鉴宝天骄 一口气看完', description: '看《重生之鉴宝大师》', tags: ['万物有声鉴宝天骄后续', '漫剧推荐', '短剧'] }))!;
    expect(hongguoCandidates(post)).toEqual(['ai短剧系列', '重生之鉴宝大师', '万物有声鉴宝天骄', '漫剧推荐']);
    expect(titleKey('万物有声：鉴宝天骄')).toBe('万物有声鉴宝天骄');
  });
});

describe('DTK reads', () => {
  it('returns a finished answer, or follows a queued task until it settles', async () => {
    const calls: string[] = [];
    const answers = [envelope({ task_id: '0f0e3f4a-1111-4222-8333-944444444444', state: 'queued' }, 202), envelope({ state: 'running' }), envelope({ state: 'done', data: { items: [], has_more: false } })];
    const reader = new DtkReader('http://127.0.0.1:19580', 'dtk_test_key_123456', { fetch: async (url, init) => { calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`); return answers.shift()!; }, sleep: async () => {} });
    await expect(reader.read('search/posts', { keyword: '鉴宝', count: '10' })).resolves.toEqual({ items: [], has_more: false });
    expect(calls[0]).toBe('http://127.0.0.1:19580/api/v1/douyin/search/posts?keyword=%E9%89%B4%E5%AE%9D&count=10&wait=20 Bearer dtk_test_key_123456');
    expect(calls.slice(1).map(call => call.split(' ')[0])).toEqual(Array(2).fill('http://127.0.0.1:19580/api/v1/tasks/0f0e3f4a-1111-4222-8333-944444444444'));
  });

  it('turns DTK refusals into fixed member messages and never forwards upstream text', async () => {
    const cases: Array<[Response, number, RegExp]> = [
      [refusal('IDENTITY_LOGIN_REQUIRED', 503), 503, /可能登录已过期/],
      [refusal('RATE_LIMITED', 429), 429, /太频繁/],
      [refusal('UPSTREAM_RISK_CONTROL', 502), 503, /验证/],
      [refusal('SOMETHING_NEW', 500), 502, /暂时不可用/],
      [new Response('not json', { status: 502 }), 502, /无法识别/],
    ];
    for (const [response, status, message] of cases) {
      const reader = new DtkReader('http://127.0.0.1:19580', 'dtk_test_key_123456', { fetch: async () => response });
      const error = await reader.read('search/posts', { keyword: 'x' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(DouyinSearchError);
      expect(error).toMatchObject({ status, message: expect.stringMatching(message) });
      expect((error as Error).message).not.toContain('private upstream detail');
    }
    const risk = new DtkReader('http://127.0.0.1:19580', 'dtk_test_key_123456', { fetch: async () => refusal('UPSTREAM_RISK_CONTROL', 502) });
    await expect(risk.read('search/posts', {})).rejects.toMatchObject({ code: 'UPSTREAM_RISK_CONTROL' });
    const offline = new DtkReader('http://127.0.0.1:19580', 'dtk_test_key_123456', { fetch: async () => { throw new TypeError('connect ECONNREFUSED'); } });
    await expect(offline.read('search/posts', {})).rejects.toMatchObject({ status: 503 });
    let clock = 0;
    const stuck = new DtkReader('http://127.0.0.1:19580', 'dtk_test_key_123456', { maxWaitMs: 5_000, now: () => clock, sleep: async ms => { clock += ms; },
      fetch: async url => url.includes('/tasks/') ? envelope({ state: 'running' }) : envelope({ task_id: '0f0e3f4a-1111-4222-8333-944444444444' }, 202) });
    await expect(stuck.read('search/posts', {})).rejects.toMatchObject({ status: 504 });
  });
});

describe('Douyin search budget', () => {
  const HOUR = 3_600_000;

  it('caps searches per rolling hour and day and lets other reads through', async () => {
    let clock = 0;
    const reads: string[] = [];
    const budget = new DouyinSearchBudget({ read: async path => { reads.push(path); return { items: [] }; } }, { perHour: 2, perDay: 3, pauseMs: HOUR, now: () => clock });
    await budget.read('search/posts', {});
    await budget.read('search/users', {});
    await expect(budget.read('search/posts', {})).rejects.toMatchObject({ status: 429, code: 'SEARCH_BUDGET', message: expect.stringContaining('每小时 2 次') });
    await budget.read('video', {});
    await budget.read('hashtag', {});
    clock = HOUR;
    await budget.read('search/posts', {});
    await expect(budget.read('search/posts', {})).rejects.toMatchObject({ code: 'SEARCH_BUDGET', message: expect.stringContaining('每天 3 次') });
    expect(budget.state()).toMatchObject({ lastHour: 1, lastDay: 3, pausedUntil: null });
    clock = 24 * HOUR;
    await budget.read('search/posts', {});
    expect(reads).toEqual(['search/posts', 'search/users', 'video', 'hashtag', 'search/posts', 'search/posts']);
  });

  it('stops every search for the pause after Douyin asks for verification', async () => {
    let clock = Date.parse('2026-11-16T02:00:00.000Z');
    let refuse = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const budget = new DouyinSearchBudget({ read: async () => {
      if (refuse) throw new DouyinSearchError('抖音要求验证，暂时无法搜索，请过几分钟再试', 503, 'UPSTREAM_RISK_CONTROL');
      return {};
    } }, { perHour: 10, perDay: 100, pauseMs: 6 * HOUR, now: () => clock });
    await expect(budget.read('search/posts', {})).rejects.toMatchObject({ code: 'UPSTREAM_RISK_CONTROL' });
    refuse = false;
    await expect(budget.read('search/posts', {})).rejects.toMatchObject({ status: 503, code: 'SEARCH_PAUSED', message: expect.stringContaining('16:00') });
    await expect(budget.read('video', {})).resolves.toEqual({});
    expect(budget.state().pausedUntil).toBe('2026-11-16T08:00:00.000Z');
    clock += 6 * HOUR;
    await expect(budget.read('search/posts', {})).resolves.toEqual({});
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    const other = new DouyinSearchBudget({ read: async () => { throw new DouyinSearchError('x', 429, 'RATE_LIMITED'); } }, { perHour: 1, perDay: 1, pauseMs: HOUR });
    await expect(other.read('search/posts', {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(other.state().pausedUntil).toBeNull();
  });

  it('lets the administrator change limits, stop searches and end a pause, and saves the settings', async () => {
    let clock = Date.parse('2026-11-16T02:00:00.000Z');
    const saved: unknown[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let refuse = true;
    const budget = new DouyinSearchBudget({ read: async () => { if (refuse) throw new DouyinSearchError('x', 503, 'UPSTREAM_RISK_CONTROL'); return {}; } },
      { perHour: 6, perDay: 100, pauseMs: 6 * HOUR, now: () => clock, save: async settings => { saved.push(settings); } });
    await expect(budget.read('search/posts', {})).rejects.toMatchObject({ code: 'UPSTREAM_RISK_CONTROL' });
    expect(saved.at(-1)).toEqual({ perHour: 6, perDay: 100, stopped: false, pausedUntil: '2026-11-16T08:00:00.000Z', lastRiskAt: '2026-11-16T02:00:00.000Z' });
    refuse = false;
    expect(await budget.configure({ resume: true, perHour: 3, perDay: 30 })).toMatchObject({ perHour: 3, perDay: 30, pausedUntil: null, lastHour: 1, lastDay: 1, pauseMinutes: 360 });
    await budget.configure({ stopped: true });
    await expect(budget.read('search/users', {})).rejects.toMatchObject({ status: 503, code: 'SEARCH_STOPPED' });
    await expect(budget.read('video', {})).resolves.toEqual({});
    await expect(budget.configure({ perHour: 50 })).rejects.toThrow('Invalid');
    expect(budget.state().perHour).toBe(3);
    const restarted = new DouyinSearchBudget({ read: async () => ({}) }, { perHour: 6, perDay: 100, pauseMs: HOUR, now: () => clock });
    restarted.restore(saved.at(-1) as Parameters<DouyinSearchBudget['restore']>[0]);
    expect(restarted.state()).toMatchObject({ perHour: 3, perDay: 30, stopped: true, pausedUntil: null, lastRiskAt: '2026-11-16T02:00:00.000Z', lastHour: 0 });
    restarted.restore({ perHour: 6, perDay: 100, stopped: false, pausedUntil: '2026-11-16T08:00:00.000Z', lastRiskAt: null });
    await expect(restarted.read('search/posts', {})).rejects.toMatchObject({ code: 'SEARCH_PAUSED' });
    clock += 7 * HOUR;
    await expect(restarted.read('search/posts', {})).resolves.toEqual({});
    expect(() => restarted.restore({ perHour: 0, perDay: 1, stopped: false, pausedUntil: null, lastRiskAt: null })).toThrow('Invalid');
    errors.mockRestore();
  });

  it('serves the search settings to the administrator only and keeps them in the database', async () => {
    const database = new PGlite();
    try {
      const repository = new DataRepository(database);
      await repository.initialize({ seedDemo: false });
      const users: Record<string, { id: string; name: string; role: 'admin' | 'member' }> = { admin: { id: 'a', name: '管理员', role: 'admin' }, member: { id: 'm', name: '成员', role: 'member' } };
      const budget = new DouyinSearchBudget({ read: async () => ({}) }, { perHour: 6, perDay: 100, pauseMs: HOUR, save: settings => repository.saveDouyinSearchSettings(settings) });
      const { app } = createApp({ repository, douyinSearchAdmin: budget, identity: async request => users[request.headers.get('test-user') ?? ''] ?? null });
      const call = (user: string, method = 'GET', body?: unknown) => app.request('http://127.0.0.1:4317/api/admin/douyin-search',
        { method, headers: { 'test-user': user, 'content-type': 'application/json', origin: 'http://127.0.0.1:4317' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect((await call('member')).status).toBe(403);
      expect((await call('member', 'PUT', { stopped: true })).status).toBe(403);
      expect(await (await call('admin')).json()).toMatchObject({ perHour: 6, perDay: 100, stopped: false, pausedUntil: null, lastHour: 0 });
      expect(await (await call('admin', 'PUT', { stopped: true, perHour: 4, perDay: 40 })).json()).toMatchObject({ perHour: 4, perDay: 40, stopped: true });
      expect(await repository.douyinSearchSettings()).toEqual({ perHour: 4, perDay: 40, stopped: true, pausedUntil: null, lastRiskAt: null });
      expect((await call('admin', 'PUT', { perDay: 2 })).status).toBe(400);
      expect((await call('admin', 'PUT', { resume: false })).status).toBe(400);
      expect((await call('admin', 'PUT', { surprise: 1 })).status).toBe(400);
      const { app: off } = createApp({ repository, identity: async () => users.admin! });
      expect((await off.request('http://127.0.0.1:4317/api/admin/douyin-search')).status).toBe(503);
      expect((await off.request('http://127.0.0.1:4317/api/admin/douyin-search', { method: 'PUT', body: '{}', headers: { origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' } })).status).toBe(503);
    } finally { await database.close(); }
  });

  it('refuses invalid limits and reads them from configuration', () => {
    expect(() => new DouyinSearchBudget({ read: async () => ({}) }, { perHour: 0, perDay: 1, pauseMs: 0 })).toThrow('Invalid');
    expect(() => new DouyinSearchBudget({ read: async () => ({}) }, { perHour: 5, perDay: 4, pauseMs: 0 })).toThrow('Invalid');
    expect(resolveConfig({}).douyinSearchBudget).toEqual({ perHour: 6, perDay: 100, pauseMs: 6 * HOUR });
    expect(resolveConfig({ MUSE_DATA_DOUYIN_SEARCH_PER_HOUR: '20', MUSE_DATA_DOUYIN_SEARCH_PER_DAY: '200', MUSE_DATA_DOUYIN_SEARCH_PAUSE_MINUTES: '30' }).douyinSearchBudget)
      .toEqual({ perHour: 20, perDay: 200, pauseMs: 30 * 60_000 });
    expect(() => resolveConfig({ MUSE_DATA_DOUYIN_SEARCH_PER_HOUR: '20', MUSE_DATA_DOUYIN_SEARCH_PER_DAY: '10' })).toThrow(/PER_DAY/);
  });
});

describe('Douyin search service', () => {
  it('matches Hongguo works by drama name and passes the cursor through', async () => {
    const reads: Array<[string, Record<string, string>]> = [];
    const service = new DouyinSearchService({ read: async (path, query) => { reads.push([path, query]); return { items: [content(), content({ content_id: '7570000000000000002', title: '别的剧', tags: [], raw: {} })], cursor: '10:session', has_more: true }; } },
      async (keys, key) => new Map(keys.filter(candidate => candidate === key(hongguo.title!)).map(candidate => [candidate, hongguo])));
    const page = await service.searchPosts('member-a', ' 鉴宝 ', '10:session');
    expect(reads).toEqual([['search/posts', { keyword: '鉴宝', count: '10', include_raw: 'true', cursor: '10:session' }]]);
    expect(page.cursor).toBe('10:session');
    expect(page.items[0]!.hongguo).toEqual({ workId: hongguo.id, title: hongguo.title, episodeCount: 65, serialStatus: '已完结' });
    expect(page.items[1]!.hongguo).toBeNull();
    expect(page.items[0]).not.toHaveProperty('tags');
  });

  it('limits each member per minute and rejects bad input before any upstream read', async () => {
    let clock = 0;
    let reads = 0;
    const service = new DouyinSearchService({ read: async () => { reads++; return { items: [], has_more: false }; } }, async () => new Map(), { perMinute: 2, now: () => clock });
    await service.searchAccounts('member-a', '短剧');
    await service.searchAccounts('member-a', '短剧');
    await expect(service.searchAccounts('member-a', '短剧')).rejects.toMatchObject({ status: 429 });
    await expect(service.searchAccounts('member-b', '短剧')).resolves.toEqual({ items: [], cursor: null, hasMore: false });
    clock = 60_001;
    await expect(service.searchAccounts('member-a', '短剧')).resolves.toBeDefined();
    expect(() => service.searchPosts('member-c', '   ')).toThrow(DouyinSearchError);
    expect(() => service.searchPosts('member-c', 'x', 'bad cursor')).toThrow(DouyinSearchError);
    expect(() => service.mixPosts('member-c', '../1')).toThrow(DouyinSearchError);
    expect(reads).toBe(4);
  });
});

describe('Douyin search routes and title lookup', () => {
  it('finds Hongguo works by normalized title from the station catalog', async () => {
    const database = new PGlite();
    try {
      const repository = new DataRepository(database);
      await repository.initialize({ seedDemo: false });
      await repository.ingestBatch({ platform: 'hongguo', works: [hongguo], coverage: '测试', observedAt: at } satisfies CollectionBatch);
      const found = await repository.worksByTitle('hongguo', ['万物有声鉴宝天骄', '不存在的剧'], titleKey);
      expect([...found.keys()]).toEqual(['万物有声鉴宝天骄']);
      expect(found.get('万物有声鉴宝天骄')!.id).toBe(hongguo.id);
      expect((await repository.worksByTitle('fanqie', ['万物有声鉴宝天骄'], titleKey)).size).toBe(0);
    } finally { await database.close(); }
  });

  it('serves members, maps refusals and reports when search is not configured', async () => {
    const database = new PGlite();
    try {
      const repository = new DataRepository(database);
      await repository.initialize({ seedDemo: false });
      const service = {
        searchPosts: async (member: string, keyword: string) => ({ items: [], cursor: null, hasMore: false, member, keyword }),
        searchAccounts: async () => { throw new DouyinSearchError('抖音搜索太频繁，请稍等一会儿再试', 429); },
        mixPosts: async (_member: string, id: string) => ({ items: [], cursor: null, hasMore: false, id }),
      };
      const get = (app: ReturnType<typeof createApp>['app'], path: string) => app.request(`http://127.0.0.1:4317${path}`);
      const { app } = createApp({ repository, douyinSearch: service as never });
      expect(await (await get(app, '/api/douyin/status')).json()).toEqual({ enabled: true });
      expect(await (await get(app, '/api/douyin/search?type=posts&q=%E9%89%B4%E5%AE%9D')).json()).toMatchObject({ member: 'local-preview', keyword: '鉴宝' });
      const limited = await get(app, '/api/douyin/search?type=accounts&q=x');
      expect([limited.status, await limited.json()]).toEqual([429, { error: '抖音搜索太频繁，请稍等一会儿再试' }]);
      expect((await get(app, '/api/douyin/search?type=videos&q=x')).status).toBe(400);
      expect(await (await get(app, '/api/douyin/mix?id=7529749968874113060')).json()).toMatchObject({ id: '7529749968874113060' });
      const { app: off } = createApp({ repository });
      expect(await (await get(off, '/api/douyin/status')).json()).toEqual({ enabled: false });
      expect((await get(off, '/api/douyin/search?q=x')).status).toBe(503);
    } finally { await database.close(); }
  });

  it('reads the key file the server is configured with', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'muse-data-dtk-key-'));
    await writeFile(join(directory, 'key'), 'dtk_data_station_key_0123\n', { mode: 0o600 });
    const { readFile } = await import('node:fs/promises');
    expect(dtkKey(await readFile(join(directory, 'key'), 'utf8'))).toBe('dtk_data_station_key_0123');
  });
});
