import { expect, test, type Page } from '@playwright/test';
import { servePage } from './page-fixture';
import type { DouyinSearchState } from '../../src/shared/douyin-search';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BoardComparison, BoardDayList, BoardPeriod, BoardPeriodView, BookshelfItem, CollectorStatus, Platform, ScriptArtifact, Work } from '../../src/shared/types';
import { PLATFORM_SHORT_LABELS } from '../../src/shared/types';

const at = '2026-11-13T06:00:00.000Z';
const earlierAt = '2026-11-12T06:00:00.000Z';
const works: Work[] = (['hongguo', 'fanqie', 'qimao'] as Platform[]).flatMap((platform, p) => [1, 2].map((n): Work => ({
  id: `${platform}:9000000000000000${p}${n}`, sourceId: `9000000000000000${p}${n}`, platform,
  kind: platform === 'hongguo' || platform === 'douyin' ? 'drama' : 'novel',
  title: `${PLATFORM_SHORT_LABELS[platform]}验收作品${n}`,
  author: '验收作者', description: '独立浏览器测试夹具，不代表线上平台榜单。', coverUrl: 'https://example.invalid/cover.jpg',
  sourceUrl: 'https://example.invalid/work', tags: ['都市', '成长'], category: n === 1 ? '都市' : '古风',
  episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
  metrics: platform === 'douyin' ? [{ key: 'video_plays', label: '精选页播放', value: 100000 }, { key: 'video_likes', label: '精选页点赞', value: 1000 }] : platform === 'fanqie' ? [{ key: 'currentReaders', label: '在读人数', value: 3000 }] : [{ key: 'heat', label: platform === 'qimao' ? '源热度' : '热度', value: n === 1 ? 20000 : null }, { key: 'collection', label: '收藏', value: 1000 }], rank: n, rankChange: null,
  board: `${PLATFORM_SHORT_LABELS[platform]}${n === 1 ? '综合榜' : '新作榜'}`,
  origin: 'live', observedAt: at, sourceUpdatedAt: '11月13日更新',
  topics: platform === 'douyin' && n === 2 ? [] : n === 1 ? [{ id: 'crossing', label: '穿越', group: 'setting', evidence: '平台原标签：穿越', source: 'platform' }, ...(platform === 'hongguo' ? [{ id: 'system', label: '系统', group: 'setting', evidence: '简介出现系统设定', source: 'text' as const }] : [])] : [{ id: 'eighties', label: '八零年代', group: 'era', evidence: '简介出现八零年代', source: 'text' }],
})));
const scriptBytes = Buffer.from('真实文件测试\n第1集：这是浏览器验证用的现有文件。\n');
const script: ScriptArtifact = { id: 'script-hongguo-1', workId: works[0]!.id, fileName: '验收剧本.txt', contentType: 'text/plain', byteLength: scriptBytes.length, sha256: createHash('sha256').update(scriptBytes).digest('hex'), createdAt: at };
works[0]!.script = script;

const collectors: (CollectorStatus & { nextRunAt: string; intervalHours: number })[] = (['hongguo', 'fanqie', 'qimao'] as Platform[]).map(platform => ({
  platform, state: 'success', lastSuccessAt: at, lastAttemptAt: at, message: '测试采集完成', coverage: '公开榜单观察窗口，非全平台作品库', count: 2,
  nextRunAt: '2026-11-13T12:00:00.000Z', intervalHours: 6,
}));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** Day boards on 11-12 and 11-13 (11-13 is the latest), nothing on other days; week and month span both days. */
function periodView(params: URLSearchParams): BoardPeriodView {
  const platform = params.get('platform') as Platform, board = params.get('board')!, period = (params.get('period') ?? 'day') as BoardPeriod;
  const date = params.get('date') ?? '2026-11-13';
  const scoped = works.filter(work => work.platform === platform && work.board === board);
  const base = { platform, board, origin: 'live' as const, period, date };
  if (period !== 'day') return { ...base, start: '2026-11-09', end: period === 'week' ? '2026-11-15' : '2026-11-30', daysInPeriod: period === 'week' ? 7 : 30,
    days: [{ date: '2026-11-12', observedAt: earlierAt }, { date: '2026-11-13', observedAt: at }], previous: null,
    items: scoped.map(work => ({ position: 1, daysOnBoard: 2, averageRank: 2, bestRank: 1, lastDate: '2026-11-13', work })) };
  const day = { start: date, end: date, daysInPeriod: 1 };
  if (date === '2026-11-13') return { ...base, ...day, days: [{ date, observedAt: at }], previous: { date: '2026-11-12', observedAt: earlierAt },
    items: scoped.map(work => ({ position: work.rank, daysOnBoard: 1, averageRank: work.rank, bestRank: work.rank, lastDate: date, work })) };
  if (date === '2026-11-12') return { ...base, ...day, days: [{ date, observedAt: earlierAt }], previous: null,
    items: scoped.map(work => ({ position: 3, daysOnBoard: 1, averageRank: 3, bestRank: 3, lastDate: date, work: { ...work, rank: 3, observedAt: earlierAt } })) };
  return { ...base, ...day, days: [], previous: null, items: [] };
}

const boardChip = (page: Page, name: string) => page.getByRole('group', { name: '榜单筛选' }).getByRole('button', { name, exact: true });

async function mockApi(page: Page, options: { role?: 'admin' | 'member'; downloadFailure?: boolean; editPage?: (html: string) => string } = {}) {
  await servePage(page, { edit: options.editPage });
  let shelf: BookshelfItem[] = [];
  let intervalHours = 6;
  let douyinSearch: DouyinSearchState = { perHour: 6, perDay: 100, stopped: false, pausedUntil: '2026-11-13T12:00:00.000Z', lastRiskAt: at, lastHour: 2, lastDay: 40, pauseMinutes: 360 };
  let shelfReads = 0;
  const role = options.role || 'admin';
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return json({ id: 'browser-user', name: '本地预览', role, mode: 'local-preview' });
    if (url.pathname === '/api/admin/settings') {
      if (role !== 'admin') return route.fulfill({ status: 403, body: '{"error":"需要管理员权限"}' });
      if (request.method() === 'PUT') intervalHours = JSON.parse(request.postData() || '{}').intervalHours;
      return json({ intervalHours });
    }
    if (url.pathname === '/api/admin/discovery') return json([]);
    if (url.pathname === '/api/admin/douyin-search') {
      if (role !== 'admin') return route.fulfill({ status: 403, body: '{"error":"只有管理员可以查看抖音搜索"}' });
      if (request.method() === 'PUT') {
        const change = JSON.parse(request.postData() || '{}');
        if (change.resume) douyinSearch = { ...douyinSearch, pausedUntil: null };
        douyinSearch = { ...douyinSearch, ...(change.perHour ? { perHour: change.perHour, perDay: change.perDay } : {}), ...(change.stopped === undefined ? {} : { stopped: change.stopped }) };
      }
      return json(douyinSearch);
    }
    if (url.pathname === '/api/hits/board') return json({ items: [] });
    if (/^\/api\/hits\/[^/]+\/rush$/.test(url.pathname)) return json({ workId: decodeURIComponent(url.pathname.split('/')[3]!), state: 'queued', lane: 'manual', rushAt: at });
    if (url.pathname === '/api/admin/lvpaopao') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"绿泡泡采集尚未配置"}' });
    if (url.pathname === '/api/admin/metric-refresh') return json(['hongguo', 'fanqie', 'qimao'].map(platform => ({ platform, state: 'success', due: 12, refreshed: 40,
      lastRunRefreshed: 20, lastRunFailed: 0, lastAttemptAt: at, lastSuccessAt: at, nextRunAt: at, message: '本轮读取 20 部作品详情：更新指标 20 部；仍待刷新 12 部' })));
    if (/^\/api\/admin\/metric-refresh\/[^/]+\/run$/.test(url.pathname)) return route.fulfill({ status: 202, contentType: 'application/json', body: '{"started":true}' });
    if (url.pathname === '/api/bookshelf') {
      if (request.method() === 'POST') shelf = [{ work: works[0]!, script, downloadedAt: at }];
      if (request.method() === 'POST') return json(shelf[0]);
      shelfReads++;
      return json(shelf.map(item => ({ ...item, work: { ...item.work, metrics: item.work.metrics.map(metric => metric.key === 'heat' ? { ...metric, value: shelfReads > 1 ? 35000 : metric.value } : metric) } })));
    }
    if (url.pathname === '/api/bookshelf/originals') return json([]);
    if (url.pathname.startsWith('/api/bookshelf/')) { shelf = []; return json({ removed: true }); }
    if (/^\/api\/works\/[^/]+\/script$/.test(url.pathname) && request.method() === 'POST') return json(script);
    if (url.pathname === `/api/scripts/${script.id}/download`) return options.downloadFailure ? route.fulfill({ status: 503, body: 'File unavailable' }) : route.fulfill({ status: 200, contentType: 'text/plain', body: scriptBytes });
    if (url.pathname === '/api/collectors') return json(collectors);
    if (url.pathname === '/api/boards') {
      const boards = [...new Set(works.filter(work => work.platform === url.searchParams.get('platform')).map(work => work.board))];
      return json({ boards, defaultBoard: boards[0] ?? null });
    }
    if (/^\/api\/collectors\/[^/]+\/run$/.test(url.pathname)) return route.fulfill({ status: 202, contentType: 'application/json', body: '{"started":true}' });
    if (url.pathname === '/api/export') return route.continue();
    if (url.pathname === '/api/boards/days') return json({ days: [{ date: '2026-11-13', observedAt: at }, { date: '2026-11-12', observedAt: earlierAt }], truncated: false } satisfies BoardDayList);
    if (url.pathname === '/api/boards/period') return json(periodView(url.searchParams));
    if (url.pathname === '/api/boards/compare') {
      const compared = (work: Work) => ({ id: work.id, sourceId: work.sourceId, title: work.title, author: work.author });
      return json({ platform: 'hongguo', board: url.searchParams.get('board')!, origin: 'live', from: url.searchParams.get('from')!, to: url.searchParams.get('to')!, entries: [
        { work: compared(works[0]!), status: 'stayed', fromRank: 3, toRank: 1, rankChange: 2 },
        { work: { id: 'hongguo:9000000000000000099', sourceId: '9000000000000000099', title: '红果新上榜作品', author: null }, status: 'entered', fromRank: null, toRank: 2, rankChange: null },
        { work: compared(works[1]!), status: 'dropped', fromRank: 1, toRank: null, rankChange: null },
      ] } satisfies BoardComparison);
    }
    if (url.pathname === '/api/works' || url.pathname === '/api/facets') {
      const filtered = works.filter(work => (!url.searchParams.get('platform') || work.platform === url.searchParams.get('platform'))
        && (!url.searchParams.get('q') || work.title?.includes(url.searchParams.get('q')!)));
      const scoped = filtered.filter(work => !url.searchParams.get('board') || work.board === url.searchParams.get('board'));
      if (url.pathname === '/api/facets') {
        const definitions = [
          { id: 'setting', label: '故事设定', items: [{ id: 'crossing', label: '穿越' }] },
          { id: 'mechanism', label: '情节元素', items: [{ id: 'system', label: '系统' }, { id: 'zero-topic', label: '无数据题材' }] },
          { id: 'era', label: '时代背景', items: [{ id: 'eighties', label: '八零年代' }] },
          { id: 'classification', label: '分类状态', items: [{ id: 'unclassified', label: '待分类' }] },
        ];
        return json({ groups: definitions.map(group => ({ ...group, items: group.items.map(topic => ({ ...topic, count: scoped.filter(work => topic.id === 'unclassified' ? !work.topics?.length : work.topics?.some(item => item.id === topic.id)).length })) })) });
      }
      const tag = url.searchParams.get('tag');
      const selected = url.searchParams.get('at');
      const items = scoped.filter(work => !tag || (tag === 'unclassified' ? !work.topics?.length : work.topics?.some(topic => topic.id === tag)))
        .map(work => selected === earlierAt ? { ...work, rank: 3, observedAt: earlierAt } : work);
      const batch = url.searchParams.get('board') ? { batch: selected === earlierAt ? { observedAt: earlierAt, previousObservedAt: null } : { observedAt: at, previousObservedAt: earlierAt } } : {};
      return json({ items, total: items.length, page: 1, limit: 10, categories: [...new Set(filtered.map(work => work.category))], boards: [...new Set(filtered.map(work => work.board))], ...batch });
    }
    if (url.pathname.startsWith('/api/works/')) {
      const work = works.find(item => item.id === decodeURIComponent(url.pathname.slice('/api/works/'.length)))!;
      return json({ work, selection: null, observations: ['2026-11-12T06:00:00.000Z', at].map((observedAt, i) => ({ observedAt, board: work.board, rank: i + 1, metrics: work.metrics, origin: 'live' })) });
    }
    if (url.pathname.startsWith('/api/covers/')) return route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
    throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
  });
  return requests;
}

test('opens the catalogue in the Muse page frame with real cover images', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: '数据站', exact: true })).toBeVisible();
  await expect(page.getByTestId('view-navigation').getByRole('button', { name: '作品数据', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('团队选题', { exact: true })).toHaveCount(0);
  await expect(page.getByText('今日风向', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('view-navigation').getByRole('button')).toHaveText(['作品数据', '储备看板', '我的书架', '采集管理']);
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /穿越/ })).toBeVisible();
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /系统/ })).toBeVisible();
  await expect(boardChip(page, '红果综合榜')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '全部榜单', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /八零年代/ })).toHaveCount(0);
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /无数据题材/ })).toHaveCount(0);
  await expect(page.getByTestId('global-search')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '全部平台', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '红果短剧', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: '红果热度', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '收藏', exact: true })).toBeVisible();
  await expect(page.getByTestId('work-row')).toContainText('暂无对比');
  await expect(page.getByRole('button', { name: '下载剧本', exact: true })).toBeEnabled();
  await expect.poll(() => page.getByTestId('work-cover').first().locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(requests.some(url => url.includes('/api/boards/period?') && url.includes('origin=live'))).toBe(true);
  expect(requests.some(url => url.startsWith('GET /api/works?'))).toBe(false);
  expect(requests.some(url => url.includes('/api/selections'))).toBe(false);
  await page.screenshot({ path: 'artifacts/simple-overview-desktop.png', fullPage: true });
});

test('switches day, week and month boards, skips uncollected days and compares with the previous day', async ({ page }) => {
  const requests = await mockApi(page);
  const periodReads = () => requests.filter(url => url.startsWith('GET /api/boards/period?'));
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.getByTestId('board-subtitle')).toContainText('排名变化对比前一天（2026-11-12）');
  await expect(page.getByLabel('统计日期')).toHaveValue('2026-11-13');
  await expect(page.getByRole('group', { name: '榜单周期' }).getByRole('button', { name: '日榜' })).toHaveAttribute('aria-pressed', 'true');
  // The platform's other board is read in the background after the first one renders.
  await expect.poll(() => periodReads().some(url => url.includes(encodeURIComponent('红果新作榜')))).toBe(true);
  const reads = periodReads().length;
  await boardChip(page, '红果新作榜').click();
  await expect(page.getByTestId('work-row')).toContainText('红果验收作品2');
  await boardChip(page, '红果综合榜').click();
  await expect(page.getByTestId('work-row')).toContainText('红果验收作品1');
  expect(periodReads().length).toBe(reads);

  await page.getByRole('group', { name: '榜单周期' }).getByRole('button', { name: '周榜' }).click();
  await expect(page.getByTestId('board-hero')).toContainText('本站按日榜计算，非平台官方');
  await expect(page.getByTestId('board-subtitle')).toContainText('2026-11-09 至 2026-11-15 · 覆盖 2/7 天');
  for (const name of ['本站排名', '上榜天数', '平均名次', '最高名次']) await expect(page.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '排名变化', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('work-row')).toContainText('11月13日数据');
  await expect(page.getByTestId('work-row')).toContainText('2.0');
  expect(periodReads().some(url => url.includes('period=week'))).toBe(true);
  await page.getByRole('group', { name: '榜单周期' }).getByRole('button', { name: '月榜' }).click();
  await expect(page.getByTestId('board-subtitle')).toContainText('覆盖 2/30 天');

  await page.getByRole('group', { name: '榜单周期' }).getByRole('button', { name: '日榜' }).click();
  await page.getByRole('button', { name: '上一个采集日', exact: true }).click();
  await expect(page.getByLabel('统计日期')).toHaveValue('2026-11-12');
  await expect(page.getByTestId('board-subtitle')).toContainText('前一天未采集，不计算排名变化');
  await expect(page.getByTestId('work-row')).toContainText('03');
  await expect(page.getByRole('button', { name: '上一个采集日', exact: true })).toBeDisabled();
  await page.getByLabel('统计日期').fill('2026-11-11');
  await expect(page.getByRole('heading', { name: '当天未采集', exact: true })).toBeVisible();
  await expect(page.getByTestId('board-hero')).toContainText('当天未采集');
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  await page.getByRole('button', { name: '查看最近采集日（2026-11-12）', exact: true }).click();
  await expect(page.getByTestId('work-row')).toContainText('03');
  await page.getByRole('button', { name: '下一个采集日', exact: true }).click();
  await expect(page.getByLabel('统计日期')).toHaveValue('2026-11-13');

  await page.getByRole('searchbox', { name: '搜索本榜单' }).fill('没有的作品');
  await expect(page.getByText('没有找到匹配的作品', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索本榜单' }).fill('验收作品1');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  expect(requests.some(url => url.startsWith('GET /api/works?'))).toBe(false);

  await page.getByRole('button', { name: '对比前一天', exact: true }).click();
  const comparison = page.getByTestId('board-comparison');
  await expect(comparison.getByTestId('comparison-row')).toHaveCount(3);
  await expect(page.getByTestId('work-row')).toHaveCount(0);
  expect(requests.some(url => url.startsWith('GET /api/boards/compare?') && url.includes(`from=${encodeURIComponent(earlierAt)}`) && url.includes(`to=${encodeURIComponent(at)}`))).toBe(true);
  await expect(comparison.getByTestId('comparison-row').first()).toContainText(/03\s*01/);
  await comparison.getByRole('button', { name: /^掉榜/ }).click();
  await expect(comparison.getByTestId('comparison-row')).toHaveCount(1);
  await expect(comparison.getByRole('button', { name: /^掉榜/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(comparison.getByTestId('comparison-row')).toContainText('红果验收作品2');
  await expect(comparison.getByTestId('comparison-row')).toContainText('未上榜');
  await comparison.getByRole('button', { name: /^新上榜/ }).click();
  await expect(comparison.getByTestId('comparison-row')).toContainText('红果新上榜作品');
  await page.screenshot({ path: 'artifacts/board-period-comparison.png', fullPage: true });
  await comparison.getByRole('button', { name: '返回榜单' }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
});

test('filters one unified library by platform, board and topic before opening source evidence', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('topic-filters').getByRole('button', { name: /系统/ }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.getByTestId('topic-filters').getByRole('button', { name: /^系统/ })).toHaveAttribute('aria-pressed', 'true');
  expect(requests.some(url => url.includes('tag=system'))).toBe(false);
  await page.getByRole('button', { name: /清除题材筛选/ }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.getByRole('button', { name: '红果短剧', exact: true }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await boardChip(page, '红果综合榜').click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.getByRole('button', { name: '七猫小说', exact: true }).click();
  await page.getByTestId('global-search').fill('七猫验收作品1');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.getByTestId('work-row').getByRole('button').first().click();
  await expect(page.getByTestId('work-title')).toHaveText('七猫验收作品1');
  expect(requests.some(url => url.includes(`/api/works/${encodeURIComponent(works.find(work => work.title === '七猫验收作品1')!.id)}`) && !url.includes('board='))).toBe(true);
  await expect(page.getByTestId('work-detail')).toContainText('11月13日更新');
  await expect(page.getByTestId('work-detail')).toContainText('平台原标签：穿越');
  await expect(page.getByRole('img', { name: /历史趋势/ })).toBeVisible();
  await expect(page.getByTestId('work-detail').getByRole('textbox')).toHaveCount(0);
  await expect(page.getByTestId('selection-toggle')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('work-detail')).toHaveCount(0);
});

test('searches all collected works in the selected platform and restores its concrete board when cleared', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await expect(boardChip(page, '红果综合榜')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('global-search').fill('红果验收作品2');
  await expect(page.getByRole('heading', { name: /平台内搜索结果/ })).toBeVisible();
  await expect(page.getByTestId('work-row')).toContainText('红果验收作品2');
  await expect(page.getByRole('columnheader', { name: '官方名次', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '排名变化', exact: true })).toHaveCount(0);
  await expect(boardChip(page, '红果综合榜')).toBeDisabled();
  await expect(page.getByRole('combobox', { name: '作品排序' })).toHaveValue('recent');
  const exportUrl = new URL((await page.getByRole('link', { name: '导出清单', exact: true }).getAttribute('href'))!, page.url());
  expect(exportUrl.searchParams.has('board')).toBe(false);
  expect(exportUrl.searchParams.get('platform')).toBe('hongguo');
  expect(requests.some(value => value.startsWith('GET /api/works?') && value.includes('q=') && !value.includes('board='))).toBe(true);
  expect(requests.some(value => value.startsWith('GET /api/facets?') && value.includes('q=') && !value.includes('board='))).toBe(true);
  await page.getByTestId('work-row').getByRole('button').first().click();
  await expect(page.getByTestId('work-title')).toHaveText('红果验收作品2');
  await expect(page.getByTestId('work-detail')).toContainText('最后已知观测');
  await expect(page.getByTestId('detail-transcribe')).toContainText('未转写');
  await expect(page.getByTestId('detail-transcribe').getByTestId('work-transcribe')).toBeEnabled();
  expect(requests.some(value => value.includes(`/api/works/${encodeURIComponent(works.find(work => work.title === '红果验收作品2')!.id)}`) && !value.includes('board='))).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByTestId('global-search').fill('');
  await expect(boardChip(page, '红果综合榜')).toBeEnabled();
  await expect(boardChip(page, '红果综合榜')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: '官方名次', exact: true })).toBeVisible();
  await expect(page.getByTestId('work-row')).toContainText('红果验收作品1');
});

test('opens a concrete board and keeps its directory while searching across active platforms', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await expect(boardChip(page, '红果综合榜')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  expect(new URL(requests.find(url => url.startsWith('GET /api/boards/period?'))!.slice(4), page.url()).searchParams.get('board')).toBe('红果综合榜');
  await boardChip(page, '红果新作榜').click();
  await expect(page.getByTestId('work-row')).toContainText('红果验收作品2');
  const transcribe = page.getByTestId('work-row').getByTestId('work-transcribe');
  await expect(transcribe).toHaveText('转写');
  await transcribe.click();
  await expect(transcribe).toHaveText('已排队');
  expect(requests.some(entry => /^POST \/api\/hits\/hongguo(%3A|:)[^/]+\/rush$/.test(entry))).toBe(true);
  await page.getByTestId('global-search').fill('没有的作品');
  await expect(page.getByText('没有找到匹配的作品', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '榜单筛选' }).getByRole('button')).toHaveCount(3);
  await page.getByTestId('global-search').clear();
  await page.getByRole('button', { name: '七猫小说', exact: true }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.getByRole('columnheader', { name: '官方名次', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '抖音', exact: true })).toHaveCount(0);
});

test('exports the current platform and board and exposes three independently scheduled collectors', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: '番茄小说', exact: true }).click();
  await boardChip(page, '番茄综合榜').click();
  const exportLink = page.getByRole('link', { name: '导出清单', exact: true });
  await expect.poll(async () => new URL((await exportLink.getAttribute('href'))!, page.url()).searchParams.get('board')).toBe('番茄综合榜');
  const exportUrl = new URL((await exportLink.getAttribute('href'))!, page.url());
  expect(exportUrl.searchParams.get('platform')).toBe('fanqie');
  expect(exportUrl.searchParams.get('origin')).toBe('live');
  const downloadPromise = page.waitForEvent('download');
  await exportLink.click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('平台作品ID');
  expect(csv).not.toContain('七猫验收');
  expect(csv).not.toContain('红果短剧');
  expect(csv).not.toContain('抖音');
  const exportedRows = csv.trim().split(/\r?\n/).slice(1);
  expect(exportedRows.every(row => row.includes('番茄小说') && row.includes('番茄综合榜'))).toBe(true);
  await page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true }).click();
  await expect(page.getByText('每 6 小时自动采集一次', { exact: true })).toBeVisible();
  await page.getByRole('spinbutton', { name: '采集间隔小时' }).fill('3');
  await page.getByRole('button', { name: '保存采集间隔', exact: true }).click();
  await expect(page.getByText('每 3 小时自动采集一次', { exact: true })).toBeVisible();
  expect(requests.some(url => url.startsWith('PUT /api/admin/settings'))).toBe(true);
  for (const platform of ['hongguo', 'fanqie', 'qimao']) {
    const card = page.getByTestId(`collector-${platform}`);
    await expect(card).toContainText('下次采集');
    await card.getByRole('button', { name: /立即采集/ }).click();
    await expect(card.getByRole('button', { name: /立即采集/ })).toBeEnabled();
    expect(requests.some(url => url.startsWith(`POST /api/collectors/${platform}/run`))).toBe(true);
  }
  const search = page.getByTestId('douyin-search-panel');
  await expect(search.getByTestId('douyin-search-state')).toContainText('抖音要求验证，暂停到');
  await expect(search).toContainText('2 / 6 次');
  await expect(search).toContainText('40 / 100 次');
  await search.getByRole('button', { name: '已完成验证，解除暂停' }).click();
  await expect(search.getByTestId('douyin-search-state')).toHaveText('正常');
  await search.getByRole('spinbutton', { name: '每小时' }).fill('4');
  await search.getByRole('spinbutton', { name: '每天' }).fill('60');
  await search.getByRole('button', { name: '保存上限' }).click();
  await expect(search).toContainText('2 / 4 次');
  await search.getByRole('button', { name: '暂停搜索' }).click();
  await expect(search.getByTestId('douyin-search-state')).toHaveText('已手动暂停');
  await expect(search.getByRole('button', { name: '恢复搜索' })).toBeVisible();
  expect(requests.filter(url => url.startsWith('PUT /api/admin/douyin-search'))).toHaveLength(3);
  await search.scrollIntoViewIfNeeded();
  await search.screenshot({ path: 'artifacts/douyin-search-panel.png' });
  const refresh = page.getByTestId('metric-refresh-qimao');
  await expect(refresh).toContainText('待刷新');
  await expect(refresh).toContainText('仍待刷新 12 部');
  await refresh.getByRole('button', { name: '立即刷新七猫小说指标', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('七猫小说指标刷新已启动');
  expect(requests.some(url => url.startsWith('POST /api/admin/metric-refresh/qimao/run'))).toBe(true);
  await refresh.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/metric-refresh-panel.png' });
});

test('shows all accumulated works without a board filter and restores that view after reload', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await boardChip(page, '全部收录').click();
  await expect(page.getByRole('heading', { name: /红果短剧作品库/ })).toBeVisible();
  await expect(page.getByTestId('work-row')).toHaveCount(2);
  await expect(page.getByTestId('metrics-time').first()).toContainText('指标更新于');
  await expect(page.getByRole('columnheader', { name: '官方名次', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '排名变化', exact: true })).toHaveCount(0);
  expect(requests.some(value => value.startsWith('GET /api/works?') && !new URL(value.slice(4), page.url()).searchParams.has('board'))).toBe(true);
  await page.getByTestId('global-search').fill('红果验收作品1');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.getByTestId('global-search').clear();
  await expect(page.getByTestId('work-row')).toHaveCount(2);
  await page.reload();
  await expect(boardChip(page, '全部收录')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('work-row')).toHaveCount(2);
});

test('follows the Muse header and dark mode when the server renders the Muse header', async ({ page }) => {
  await mockApi(page, { editPage: html => html.replace(/<body([^>]*)>/i, (_tag, attributes: string) => `<body${attributes} class="has-muse-bar"><header class="muse-site-bar" data-testid="muse-site-bar"><div class="muse-site-bar-inner"><a class="muse-site-brand" href="/workbench">Muse</a></div></header>`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.locator('.account')).toHaveCount(0);
  const background = (selector: string) => page.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor);
  expect(await background('body')).toBe('rgb(21, 24, 29)');
  expect(await background('.muse-site-bar')).toBe('rgb(30, 35, 43)');
  expect(await background('.catalog-panel')).toBe('rgb(30, 35, 43)');
});

test('fits a mobile viewport and switches pages from the visible tabs', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('work-row').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true }).click();
  await expect(page.getByTestId('collector-hongguo')).toBeVisible();
  await page.getByTestId('view-navigation').getByRole('button', { name: '作品数据', exact: true }).click();
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/simple-overview-mobile.png', fullPage: true });
});


test('keeps each platform metric separate and hides management from members', async ({ page }) => {
  const requests = await mockApi(page, { role: 'member' });
  await page.goto('/');
  await expect(page.getByTestId('work-row')).toHaveCount(1);
  await expect(page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '红果热度', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '收藏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '七猫小说', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '源热度', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '字数', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '番茄小说', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '在读人数', exact: true })).toBeVisible();
  await page.getByTestId('work-row').first().getByRole('button').first().click();
  await expect(page.getByTestId('script-upload')).toHaveCount(0);
  expect(requests.some(url => url.includes('/api/admin/') || url.includes('/api/collectors'))).toBe(false);
});

test('downloads an actual verified artifact before adding it to the shelf and supports removal', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('work-row').first().getByRole('button', { name: '下载剧本', exact: true }).click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!)).toEqual(scriptBytes);
  await expect(page.getByRole('status')).toContainText('剧本已下载并加入书架');
  expect(requests.findIndex(url => url.includes(`/api/scripts/${script.id}/download`))).toBeLessThan(requests.findIndex(url => url.startsWith('POST /api/bookshelf')));
  await page.getByTestId('view-navigation').getByRole('button', { name: '我的书架', exact: true }).click();
  await expect(page.getByTestId('bookshelf-item')).toContainText(script.fileName);
  await expect(page.getByTestId('bookshelf-item')).toContainText('最近下载');
  await expect(page.getByTestId('bookshelf-metrics')).toContainText('红果热度');
  await expect(page.getByTestId('bookshelf-metrics')).toContainText('2万');
  await expect(page.getByTestId('bookshelf-metrics')).toContainText('收藏');
  await expect(page.getByTestId('bookshelf-metrics')).toContainText('1,000');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByTestId('bookshelf-metrics')).toContainText('3.5万');
  await expect(page.getByRole('button', { name: '再次下载', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '移出书架', exact: true }).click();
  await expect(page.getByTestId('bookshelf-item')).toHaveCount(0);
});

test('does not add a failed file request to the shelf', async ({ page }) => {
  const requests = await mockApi(page, { downloadFailure: true });
  await page.goto('/');
  await page.getByTestId('work-row').first().getByRole('button', { name: '下载剧本', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('剧本下载失败');
  expect(requests.some(url => url.startsWith('POST /api/bookshelf'))).toBe(false);
});

test('uploads an existing file through an administrator-only multipart form', async ({ page }) => {
  const requests = await mockApi(page);
  await page.goto('/');
  await page.getByTestId('work-row').first().getByRole('button').first().click();
  await page.getByText('管理剧本文件', { exact: true }).click();
  await page.getByTestId('script-upload').setInputFiles({ name: '验收剧本.txt', mimeType: 'text/plain', buffer: scriptBytes });
  const uploadRequest = page.waitForRequest(request => request.url().endsWith('/script') && request.method() === 'POST');
  await page.getByRole('button', { name: '上传并关联', exact: true }).click();
  expect((await uploadRequest).headers()['content-type']).toContain('multipart/form-data; boundary=');
  await expect(page.getByRole('status')).toContainText('现有剧本文件已关联');
  expect(requests.some(url => url.startsWith('POST /api/works/'))).toBe(true);
});
