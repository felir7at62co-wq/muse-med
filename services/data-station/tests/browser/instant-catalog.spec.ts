import { expect, test, type Page } from '@playwright/test';
import type { BoardPeriodView, PageBootstrap, Platform, SessionInfo, Work } from '../../src/shared/types';
import { servePage } from './page-fixture';

const at = '2026-11-13T06:00:00.000Z';

async function fixture(page: Page, admin = false, options: { embed?: SessionInfo } = {}) {
  const state = { actor: { id: 'alice', name: '甲账号', role: admin ? 'admin' : 'member', mode: 'local-preview' } as SessionInfo,
    revision: 1, holdData: false, holdSession: false, failure: 0, worksReads: 0, directoryReads: 0, collectorReads: 0,
    running: false, published: false, collectionStarts: 0, holdCollectors: false, collectorFailure: 0 };
  const dataWaiters: Array<() => void> = [], sessionWaiters: Array<() => void> = [], collectorWaiters: Array<() => void> = [];
  const boards = (platform: string) => [`${platform}综合榜`, `${platform}新作榜`];
  const makeWork = (platform: Platform, board: string, actor: SessionInfo, revision: number): Work => ({
    id: `${platform}:9000000000000000011`, sourceId: '9000000000000000011', platform, kind: 'novel',
    title: `${actor.id}-${board}-版本${revision}`, author: '测试作者', description: '仅隔离浏览器夹具，不是平台数据',
    coverUrl: null, sourceUrl: 'https://example.invalid/work', tags: ['系统'], category: '都市',
    episodeCount: null, wordCount: 100_000, serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: revision }],
    rank: 1, rankChange: null, board, origin: 'live', observedAt: at, sourceUpdatedAt: null,
    topics: [{ id: 'system', label: '系统', group: 'setting', source: 'platform', evidence: '平台标签' }], script: null,
  });
  const periodView = (platform: Platform, board: string, period: string, actor: SessionInfo, revision: number): BoardPeriodView => ({
    platform, board, origin: 'live', period: period as BoardPeriodView['period'], date: '2026-11-13',
    start: '2026-11-13', end: '2026-11-13', daysInPeriod: 1, days: [{ date: '2026-11-13', observedAt: at }], previous: null,
    items: [{ position: 1, daysOnBoard: 1, averageRank: 1, bestRank: 1, lastDate: '2026-11-13', work: makeWork(platform, board, actor, revision) }] });
  // `embed` stands for the account the server confirmed when it rendered the page.
  const embedded = (actor: SessionInfo): PageBootstrap => ({ session: actor, platform: 'hongguo',
    directory: { boards: boards('hongguo'), defaultBoard: boards('hongguo')[0]! }, period: periodView('hongguo', boards('hongguo')[0]!, 'day', actor, state.revision),
    days: { days: [{ date: '2026-11-13', observedAt: at }], truncated: false } });
  await servePage(page, options.embed ? { embed: () => embedded(options.embed!) } : {});
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const actor = { ...state.actor }, revision = state.revision;
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') {
      if (state.holdSession) await new Promise<void>(resolve => sessionWaiters.push(resolve));
      return json(actor);
    }
    if (url.pathname === '/api/collectors') {
      state.collectorReads++;
      if (state.holdCollectors) await new Promise<void>(resolve => collectorWaiters.push(resolve));
      if (state.collectorFailure) return route.fulfill({ status: state.collectorFailure, contentType: 'application/json', body: '{"error":"旧账号权限已变化"}' });
      return json([{ platform: 'hongguo', state: state.running && !state.published ? 'running' : 'success', count: 1,
        lastSuccessAt: state.published ? '2026-11-13T07:00:00.000Z' : at,
        lastAttemptAt: at, message: `进度读取${state.collectorReads}`, coverage: '独立测试范围' }]);
    }
    if (/\/run$/.test(url.pathname)) { state.collectionStarts++; return json({ started: true }); }
    if (['/api/boards', '/api/works', '/api/facets', '/api/boards/period', '/api/boards/days'].includes(url.pathname)) {
      if (url.pathname === '/api/boards') state.directoryReads++;
      // Background reads of the other board are not counted, so a count measures reloads of the shown board.
      if (url.pathname === '/api/works' || url.pathname === '/api/boards/period' && url.searchParams.get('board') === boards(url.searchParams.get('platform')!)[0]) state.worksReads++;
      if (state.holdData) await new Promise<void>(resolve => dataWaiters.push(resolve));
      if (state.failure) return route.fulfill({ status: state.failure, contentType: 'application/json', body: '{"error":"隔离测试请求失败"}' });
      const platform = url.searchParams.get('platform') as Platform;
      const directory = boards(platform);
      if (url.pathname === '/api/boards') return json({ boards: directory, defaultBoard: directory[0] });
      if (url.pathname === '/api/facets') return json({ groups: [{ id: 'setting', label: '设定', items: [{ id: 'system', label: '系统', count: 1 }] }] });
      const board = url.searchParams.get('board') || directory[0]!;
      if (url.pathname === '/api/boards/days') return json({ days: [{ date: '2026-11-13', observedAt: at }], truncated: false });
      if (url.pathname === '/api/boards/period') return json(periodView(platform, board, url.searchParams.get('period') ?? 'day', actor, revision));
      return json({ items: [makeWork(platform, board, actor, revision)], total: 1, page: Number(url.searchParams.get('page') || 1), limit: 10,
        boards: directory, categories: ['都市'] });
    }
    throw new Error(`Unexpected test request: ${url.pathname}`);
  });
  return { state, releaseData: () => { state.holdData = false; dataWaiters.splice(0).forEach(resolve => resolve()); },
    releaseSession: () => { state.holdSession = false; sessionWaiters.splice(0).forEach(resolve => resolve()); },
    releaseCollectors: () => { state.holdCollectors = false; collectorWaiters.splice(0).forEach(resolve => resolve()); },
    pendingSessions: () => sessionWaiters.length };
}

test('a first visit shows the embedded default board before any request answers', async ({ page }) => {
  const actor: SessionInfo = { id: 'alice', name: '甲账号', role: 'member', mode: 'local-preview' };
  const control = await fixture(page, false, { embed: actor });
  control.state.holdSession = true; control.state.holdData = true;
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('alice-hongguo综合榜-版本1');
  await expect(page.getByRole('group', { name: '榜单筛选' }).getByRole('button', { name: 'hongguo综合榜', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('catalog-freshness')).toContainText('已读取本站最新结果');
  expect(control.state.worksReads).toBe(0);
  control.releaseSession(); control.releaseData();
  await expect.poll(() => control.pendingSessions()).toBe(0);
  await expect(page.getByTestId('work-row')).toContainText('alice-hongguo综合榜-版本1');
  expect(control.state.worksReads).toBe(0);
});

test('the account confirmed after loading replaces embedded data of another account', async ({ page }) => {
  const control = await fixture(page, false, { embed: { id: 'carol', name: '丙账号', role: 'admin', mode: 'local-preview' } });
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('alice-hongguo综合榜-版本1');
  await expect(page.locator('.account')).toContainText('甲账号');
  await expect(page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true })).toHaveCount(0);
  expect((await cacheContent(page)).map(scope => scope.userId)).toEqual(['alice']);
  expect(control.state.worksReads).toBeGreaterThan(0);
});

async function cacheContent(page: Page) {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('muse-data:catalog-display:')).map(key => JSON.parse(localStorage.getItem(key)!)));
}

test('first visit waits for data while a repeat visit restores the selected board before delayed responses', async ({ page }) => {
  const control = await fixture(page);
  control.state.holdData = true;
  await page.goto('/');
  await expect.poll(() => control.state.directoryReads).toBe(1);
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('alice-hongguo综合榜-版本1');
  await page.getByRole('button', { name: '七猫小说', exact: true }).click();
  await page.getByRole('group', { name: '榜单筛选' }).getByRole('button', { name: 'qimao新作榜', exact: true }).click();
  await expect(page.getByTestId('work-row')).toContainText('alice-qimao新作榜-版本1');
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /系统/ })).toBeVisible();
  control.state.holdData = true; control.state.revision = 2;
  await page.reload();
  await expect(page.getByTestId('work-row')).toContainText('alice-qimao新作榜-版本1');
  await expect(page.getByRole('group', { name: '榜单筛选' }).getByRole('button', { name: 'qimao新作榜', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /系统/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '剧本待核对', exact: true })).toBeDisabled();
  await expect(page.locator('.table-scroll')).toHaveCSS('opacity', '1');
  await expect(page.getByTestId('catalog-freshness')).toContainText('页面保存于');
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('alice-qimao新作榜-版本2');
  await expect(page.getByRole('button', { name: '暂无剧本', exact: true })).toBeDisabled();
  expect(control.state.collectionStarts).toBe(0);
  await page.screenshot({ path: 'artifacts/instant-catalog-revisit.png', fullPage: true });
});

test('keeps the saved result after network failure and a manual refresh really reads new data', async ({ page }) => {
  const control = await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('版本1');
  const savedAt = (await cacheContent(page))[0].periods[0].savedAt;
  control.state.failure = 503;
  await page.reload();
  await expect(page.getByTestId('work-row')).toContainText('版本1');
  await expect(page.getByTestId('catalog-freshness')).toContainText('已保留上次结果');
  expect((await cacheContent(page))[0].periods[0].savedAt).toBe(savedAt);
  control.state.failure = 0; control.state.revision = 2;
  const reads = control.state.worksReads;
  await page.getByRole('button', { name: '刷新榜单数据', exact: true }).click();
  await expect(page.getByTestId('work-row')).toContainText('版本2');
  expect(control.state.worksReads).toBeGreaterThan(reads);
});

test('confirms identity before restoring a copy and cannot restore a previous account or role', async ({ page }) => {
  const control = await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('alice-');
  control.state.actor = { ...control.state.actor, id: 'bob', name: '乙账号', role: 'admin' };
  control.state.holdSession = true; control.state.holdData = true;
  await page.reload();
  await expect.poll(control.pendingSessions).toBeGreaterThan(0);
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  control.releaseSession();
  await expect(page.locator('.account')).toContainText('乙账号');
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('bob-');
  // Focus rechecks ownership without reusing a same-ID cache from a different role.
  control.state.actor = { ...control.state.actor, role: 'member' };
  control.state.holdData = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('bob-');
  const scopes = await cacheContent(page);
  expect(scopes.map(scope => [scope.userId, scope.role]).sort()).toEqual([['alice', 'member'], ['bob', 'member']]);
  expect(scopes.find(scope => scope.userId === 'bob').periods[0].value.items[0].work.title).toContain('bob-');
});

for (const status of [401, 403]) test(`removes display copies after a ${status} response`, async ({ page }) => {
  const control = await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  control.state.failure = status;
  await page.getByRole('button', { name: '刷新榜单数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '暂时无法确认账号', exact: true })).toBeVisible();
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  expect(await cacheContent(page)).toHaveLength(0);
});

test('a late authorization failure from the previous identity cannot clear the newly confirmed account', async ({ page }) => {
  const control = await fixture(page, true);
  control.state.holdCollectors = true; control.state.collectorFailure = 403;
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('alice-');
  await expect.poll(() => control.state.collectorReads).toBe(1);
  control.state.actor = { id: 'bob', name: '乙账号', role: 'member', mode: 'local-preview' };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('work-row')).toContainText('bob-');
  const rejectedResponse = page.waitForResponse(response => response.url().endsWith('/api/collectors') && response.status() === 403);
  control.releaseCollectors();
  await (await rejectedResponse).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.account')).toContainText('乙账号');
  await expect(page.getByTestId('work-row')).toContainText('bob-');
  await expect(page.getByRole('heading', { name: '暂时无法确认账号', exact: true })).toHaveCount(0);
  expect((await cacheContent(page)).find(scope => scope.userId === 'bob')).toBeDefined();
});

test('ignores corrupted persisted display data and recovers through an ordinary first load', async ({ page }) => {
  const control = await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('muse-data:catalog-display:')) localStorage.setItem(key, '{'); });
  control.state.holdData = true;
  await page.reload();
  await expect.poll(() => control.state.directoryReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('版本1');
});

test('polls collection progress without repeatedly reloading the catalog and refreshes only on publication', async ({ page }) => {
  const control = await fixture(page, true); control.state.running = true;
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toContainText('版本1');
  const reads = control.state.worksReads, directories = control.state.directoryReads;
  control.state.holdData = true;
  await expect.poll(() => control.state.collectorReads, { timeout: 12_000 }).toBeGreaterThanOrEqual(3);
  expect(control.state.worksReads).toBe(reads);
  expect(control.state.directoryReads).toBe(directories);
  control.state.revision = 2; control.state.published = true;
  await expect.poll(() => control.state.worksReads, { timeout: 12_000 }).toBeGreaterThan(reads);
  await expect(page.getByTestId('work-row')).toContainText('版本1');
  await expect(page.locator('.table-scroll')).toHaveCSS('opacity', '1');
  control.releaseData();
  await expect(page.getByTestId('work-row')).toContainText('版本2');
});
