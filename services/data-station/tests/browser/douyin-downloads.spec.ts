import { expect, test } from '@playwright/test';
import { servePage } from './page-fixture';
import type { DouyinPage, DouyinPost } from '../../src/shared/douyin-search';
import type { DouyinDownload, DouyinDownloadRequestResult, DouyinDownloadStatus } from '../../src/shared/douyin-downloads';

const mix = { id: '7529749968874113060', name: '鉴宝天骄', episode: 1, episodes: 3 };
const post = (id: string, episode: number): DouyinPost => ({ id, title: `第${episode}集`, description: '', url: `https://www.douyin.com/video/${id}`, coverUrl: null, durationMs: 60_000,
  createdAt: null, author: { name: '作者', secUid: null, handle: null }, stats: { likes: 1, comments: 1, shares: 1, saves: 1 }, mix: { ...mix, episode }, hongguo: null });
const record = (id: string, episode: number, state: DouyinDownload['state'], extra: Partial<DouyinDownload> = {}): DouyinDownload => ({
  id: `00000000-0000-4000-8000-00000000000${episode}`, awemeId: id, mixId: mix.id, mixName: mix.name, episode, title: `第${episode}集`, state,
  key: `download-video-date/douyin/20261115/${mix.id}/video/00${episode}-${id}.mp4`, bytes: state === 'done' ? 12_582_912 : null, sha256: null, error: null, attempts: 1,
  errorCode: null, nextRetryAt: null, cooldownRounds: 0,
  requestedBy: '成员甲', url: state === 'done' ? `https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115/${mix.id}/video/00${episode}-${id}.mp4` : null, createdAt: '2026-11-15T08:00:00.000Z', startedAt: null, finishedAt: state === 'done' ? '2026-11-15T08:01:00.000Z' : null, ...extra });

test('shows a scheduled retry and refreshes it into a download link without resubmitting', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T06:00:00.000Z') });
  let current = record('7570000000000000002', 2, 'queued', { attempts: 3, cooldownRounds: 1,
    errorCode: 'VIDEO_TRANSFER_FAILED', error: '视频地址连接失败', nextRetryAt: '2026-11-17T06:05:00.000Z' });
  let submissions = 0;
  await servePage(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return json({ id: 'member-a', name: '成员甲', role: 'member', mode: 'local-preview' });
    if (url.pathname === '/api/boards') return json({ boards: [], defaultBoard: null });
    if (url.pathname === '/api/facets') return json({ groups: [] });
    if (url.pathname === '/api/works') return json({ items: [], total: 0, page: 1, limit: 10, categories: [], boards: [] });
    if (url.pathname === '/api/douyin/status') return json({ enabled: true });
    if (url.pathname === '/api/douyin/downloads/status') return json({ enabled: true, access: 'public', linkSeconds: 3600, dailyLimit: 50, usedToday: 1, unlimited: false, maxMixEpisodes: 300 } satisfies DouyinDownloadStatus);
    if (url.pathname === '/api/douyin/search') return json({ items: [post(current.awemeId, 2)], cursor: null, hasMore: false } satisfies DouyinPage<DouyinPost>);
    if (url.pathname === '/api/douyin/downloads') {
      if (route.request().method() === 'POST') submissions++;
      return json([current]);
    }
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '抖音搜索', exact: true }).click();
  const log = page.getByTestId('douyin-download-log');
  await expect(log).toContainText('已尝试 3 次');
  await expect(log).toContainText('已冷却 1 轮');
  await expect(log).toContainText('下次自动重试');
  await page.getByLabel('抖音搜索词').fill('鉴宝天骄');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const button = page.getByTestId('douyin-post').first().getByTestId('douyin-download-post');
  await expect(button).toHaveText('等待重试…');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /已尝试 3 次，下次自动重试.*视频地址连接失败/);
  current = record(current.awemeId, 2, 'done', { attempts: 4, cooldownRounds: 1 });
  await page.clock.runFor(8_000);
  await expect(page.getByTestId('douyin-post').first().getByRole('link', { name: '下载' })).toHaveAttribute('href', current.url!);
  await expect(log).toContainText('可下载');
  expect(submissions).toBe(0);
});

test('downloads a post or a whole series; each button becomes a direct link once the station has the file', async ({ page }) => {
  const requests: { path: string; body: unknown }[] = [];
  let log: DouyinDownload[] = [record('7570000000000000001', 1, 'done')];
  const publicUrl = (n: number) => `https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115/7529749968874113060/video/00${n}-757000000000000000${n}.mp4`;
  await servePage(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return json({ id: 'member-a', name: '成员甲', role: 'member', mode: 'local-preview' });
    if (url.pathname === '/api/boards') return json({ boards: [], defaultBoard: null });
    if (url.pathname === '/api/facets') return json({ groups: [] });
    if (url.pathname === '/api/works') return json({ items: [], total: 0, page: 1, limit: 10, categories: [], boards: [] });
    if (url.pathname === '/api/douyin/status') return json({ enabled: true });
    if (url.pathname === '/api/douyin/downloads/status') return json({ enabled: true, access: 'public', linkSeconds: 3600, dailyLimit: 50, usedToday: log.length, unlimited: false, maxMixEpisodes: 300 } satisfies DouyinDownloadStatus);
    if (url.pathname === '/api/douyin/search') return json({ items: [post('7570000000000000002', 2)], cursor: null, hasMore: false } satisfies DouyinPage<DouyinPost>);
    if (url.pathname === '/api/douyin/mix') return json({ items: [1, 2, 3].map(n => post(`757000000000000000${n}`, n)), cursor: null, hasMore: false } satisfies DouyinPage<DouyinPost>);
    if (url.pathname === '/api/douyin/downloads' && route.request().method() === 'GET') {
      const ids = url.searchParams.get('awemeIds')?.split(',');
      return json(ids ? log.filter(item => ids.includes(item.awemeId)) : log);
    }
    if (url.pathname === '/api/douyin/downloads' || url.pathname === '/api/douyin/downloads/mix') {
      requests.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (url.pathname.endsWith('/mix')) {
        log = [record('7570000000000000003', 3, 'queued'), record('7570000000000000002', 2, 'downloading'), log.at(-1)!];
        return json({ queued: [log[0]!], existing: [log[1]!, log[2]!], skipped: 0 } satisfies DouyinDownloadRequestResult, 202);
      }
      log = [record('7570000000000000002', 2, 'queued'), ...log];
      return json({ queued: [log[0]!], existing: [], skipped: 0 } satisfies DouyinDownloadRequestResult, 202);
    }
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '抖音搜索', exact: true }).click();
  const logPanel = page.getByTestId('douyin-download-log');
  await expect(logPanel).toContainText('准备好后点「下载」直接获取');
  await expect(logPanel).toContainText('今天已用 1 条');
  await expect(page.getByTestId('douyin-download-row')).toHaveCount(1);
  await expect(page.getByTestId('douyin-download-row').first()).toContainText('可下载');
  await expect(page.getByTestId('douyin-download-row').first().getByRole('link', { name: '下载' })).toHaveAttribute('href', publicUrl(1));
  await expect(page.getByText('TOS')).toHaveCount(0);

  await page.getByLabel('抖音搜索词').fill('鉴宝天骄');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const button = page.getByTestId('douyin-post').first().getByTestId('douyin-download-post');
  await expect(button).toHaveText('下载');
  await button.click();
  await expect(page.getByText('正在准备 1 条，好了按钮会变成「下载」')).toBeVisible();
  await expect(button).toHaveText('准备中…');
  await expect(button).toBeDisabled();
  await expect(page.getByTestId('douyin-download-row')).toHaveCount(2);

  await page.getByRole('button', { name: /合集「鉴宝天骄」/ }).click();
  const episodes = page.getByTestId('douyin-post');
  await expect(episodes.nth(0).getByRole('link', { name: '下载' })).toHaveAttribute('href', publicUrl(1));
  await expect(episodes.nth(1).getByTestId('douyin-download-post')).toHaveText('准备中…');
  await expect(episodes.nth(2).getByTestId('douyin-download-post')).toHaveText('下载');
  await page.getByTestId('douyin-download-mix').click();
  await expect(page.getByText('正在准备 1 条，好了按钮会变成「下载」，2 条已经准备好或在准备中')).toBeVisible();
  await expect(episodes.nth(2).getByTestId('douyin-download-post')).toHaveText('准备中…');
  await expect(page.getByTestId('douyin-download-row')).toHaveCount(3);
  await expect(page.getByTestId('douyin-download-row').first()).toContainText('合集「鉴宝天骄」第 3 集');
  expect(requests).toEqual([{ path: '/api/douyin/downloads', body: { awemeId: '7570000000000000002' } }, { path: '/api/douyin/downloads/mix', body: { mixId: mix.id } }]);
  await page.screenshot({ path: 'artifacts/douyin-downloads-browser.png', fullPage: true });
});

test('says downloads are unavailable when TOS is not configured', async ({ page }) => {
  await servePage(page);
  await page.route('**/api/douyin/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: true }) }));
  await page.route('**/api/douyin/downloads/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ enabled: false, reason: 'TOS 未配置', access: 'public', linkSeconds: 0, dailyLimit: 0, usedToday: 0, unlimited: false, maxMixEpisodes: 0 }) }));
  await page.goto('/');
  await page.getByRole('button', { name: '抖音搜索', exact: true }).click();
  await expect(page.getByTestId('douyin-download-off')).toContainText('TOS 未配置');
  await expect(page.getByTestId('douyin-download-log')).toHaveCount(0);
});
