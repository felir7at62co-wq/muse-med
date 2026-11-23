import { expect, test } from '@playwright/test';
import type { Work } from '../../src/shared/types';

test('exposes only the three active data sources and refuses retired Douyin controls', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '红果短剧', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '番茄小说', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '七猫小说', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '抖音', exact: true })).toHaveCount(0);
  await page.getByTestId('view-navigation').getByRole('button', { name: '采集管理', exact: true }).click();
  await expect(page.getByTestId('collector-douyin')).toHaveCount(0);
  await expect(page.getByTestId('douyin-source-manager')).toHaveCount(0);
  expect((await request.get('/api/admin/douyin/sources')).status()).toBe(410);
  expect((await request.post('/api/collectors/douyin/run', { headers: { origin: 'http://127.0.0.1:4318' }, data: {} })).status()).toBe(410);
});

const missing: Work = { id: 'fanqie:7682593135821589528', sourceId: '7682593135821589528', platform: 'fanqie', kind: 'novel',
  title: null, author: null, description: '', coverUrl: null, sourceUrl: 'https://fanqienovel.com/page/7682593135821589528', tags: [], category: '',
  episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null, metrics: [{ key: 'currentReaders', label: '在读人数', value: 1234 }],
  rank: 99, rankChange: null, board: '官方分类测试榜', origin: 'live', observedAt: '2026-11-13T00:00:00.000Z', sourceUpdatedAt: null,
  metadataStatus: 'unavailable', metadataNote: '官网查无此书，详情暂不可用；保留官方名次与指标。' };

test('shows unavailable source metadata without losing the official position or inventing a title', async ({ page }) => {
  await page.route('**/api/boards?*', async route => {
    if (new URL(route.request().url()).searchParams.get('platform') !== 'fanqie') return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ boards: [missing.board], defaultBoard: missing.board }) });
  });
  await page.route('**/api/works?*', async route => {
    if (new URL(route.request().url()).searchParams.get('platform') !== 'fanqie') return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [missing], total: 1, page: 1, limit: 10, categories: [], boards: [missing.board] }) });
  });
  await page.route('**/api/boards/period?*', async route => {
    if (new URL(route.request().url()).searchParams.get('platform') !== 'fanqie') return route.continue();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ platform: 'fanqie', board: missing.board, origin: 'live', period: 'day', date: '2026-11-13',
      start: '2026-11-13', end: '2026-11-13', daysInPeriod: 1, days: [{ date: '2026-11-13', observedAt: missing.observedAt }], previous: null,
      items: [{ position: 99, daysOnBoard: 1, averageRank: 99, bestRank: 99, lastDate: '2026-11-13', work: missing }] }) });
  });
  await page.route(`**/api/works/${encodeURIComponent(missing.id)}*`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ work: missing, observations: [], selection: null }) }));
  await page.goto('/');
  await page.getByRole('button', { name: '番茄小说', exact: true }).click();
  const row = page.getByTestId('work-row');
  await expect(row).toContainText('作品资料暂不可用');
  await expect(row).toContainText(missing.sourceId);
  await expect(row).toContainText('99');
  await expect(row).toContainText('1,234');
  await row.getByRole('button').first().click();
  await expect(page.getByTestId('work-detail')).toContainText(missing.sourceId);
  await expect(page.getByTestId('work-detail')).toContainText('官网查无此书');
  await page.screenshot({ path: 'artifacts/unavailable-source-metadata-browser.png', fullPage: true });
});
