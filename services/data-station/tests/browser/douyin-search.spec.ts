import { expect, test, type Page } from '@playwright/test';
import { servePage } from './page-fixture';
import type { DouyinAccount, DouyinPage, DouyinPost } from '../../src/shared/douyin-search';

const mix = { id: '7529749968874113060', name: 'AI短剧系列', episode: 238, episodes: 372 };
function post(id: string, title: string, extra: Partial<DouyinPost> = {}): DouyinPost {
  return { id, title, description: '', url: `https://www.douyin.com/video/${id}`, coverUrl: null, durationMs: 181_000, createdAt: '2026-11-10T12:00:00Z',
    author: { name: '剧场作者', secUid: 'MS4wLjABAAAA-a', handle: null }, stats: { likes: 12_900, comments: 3, shares: 19, saves: null }, mix: null, hongguo: null, ...extra };
}
const account: DouyinAccount = { secUid: 'MS4wLjABAAAA-x', name: '万物有声', handle: 'wanwu', signature: '每天更新鉴宝漫剧', avatarUrl: null, followers: 12_000, posts: 30, url: 'https://www.douyin.com/user/MS4wLjABAAAA-x' };

async function fixture(page: Page, options: { enabled?: boolean } = {}) {
  const searches: string[] = [];
  await servePage(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return json({ id: 'member-a', name: 'member-a', role: 'member', mode: 'local-preview' });
    if (url.pathname === '/api/boards') return json({ boards: [], defaultBoard: null });
    if (url.pathname === '/api/facets') return json({ groups: [] });
    if (url.pathname === '/api/works') return json({ items: [], total: 0, page: 1, limit: 10, categories: [], boards: [] });
    if (url.pathname === '/api/douyin/status') return json({ enabled: options.enabled ?? true });
    if (url.pathname === '/api/douyin/search') {
      searches.push(url.search);
      const q = url.searchParams.get('q');
      if (q === '太快') return json({ error: '一分钟内搜索太多次了，请稍等一会儿再试' }, 429);
      if (url.searchParams.get('type') === 'accounts') return json({ items: [account], cursor: null, hasMore: false } satisfies DouyinPage<DouyinAccount>);
      if (url.searchParams.get('cursor') === '10:session') return json({ items: [post('7570000000000000003', '第二页的作品')], cursor: null, hasMore: false } satisfies DouyinPage<DouyinPost>);
      return json({ items: [
        post('7570000000000000001', '万物有声鉴宝天骄 林默觉醒异能', { mix, hongguo: { workId: 'hongguo:7500000000000000001', title: '万物有声：鉴宝天骄', episodeCount: 65, serialStatus: '已完结' } }),
        post('7570000000000000002', '别的剧的片段'),
      ], cursor: '10:session', hasMore: true } satisfies DouyinPage<DouyinPost>);
    }
    if (url.pathname === '/api/douyin/mix') return json({ items: [post('7570000000000000101', '第1集', { mix: { ...mix, episode: 1 } }), post('7570000000000000102', '第2集', { mix: { ...mix, episode: 2 } })], cursor: null, hasMore: false } satisfies DouyinPage<DouyinPost>);
    if (url.pathname.startsWith('/api/works/')) return json({ error: '作品不存在' }, 404);
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '抖音搜索', exact: true }).click();
  return { searches };
}

test('searches Douyin, pages, opens a series and returns, and marks Hongguo matches', async ({ page }) => {
  const { searches } = await fixture(page);
  await page.getByLabel('抖音搜索词').fill('鉴宝天骄');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByTestId('douyin-post')).toHaveCount(2);
  await expect(page.getByTestId('hongguo-match')).toHaveText('红果有 · 全 65 集');
  await expect(page.getByRole('button', { name: '合集「AI短剧系列」 · 第 238 集 / 共 372 集' })).toBeVisible();
  await expect(page.getByTestId('douyin-post').first()).toContainText('点赞 1.3万');
  await expect(page.getByTestId('douyin-post').first()).toContainText('收藏 —');
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByTestId('douyin-post')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
  expect(searches).toEqual(['?type=posts&q=%E9%89%B4%E5%AE%9D%E5%A4%A9%E9%AA%84', '?type=posts&q=%E9%89%B4%E5%AE%9D%E5%A4%A9%E9%AA%84&cursor=10%3Asession']);

  await page.getByRole('button', { name: /合集「AI短剧系列」/ }).click();
  await expect(page.getByText('合集「AI短剧系列」', { exact: true })).toBeVisible();
  await expect(page.getByTestId('douyin-post')).toHaveCount(2);
  await expect(page.getByTestId('douyin-post').first()).toContainText('第 1 集 / 共 372 集');
  await page.getByRole('button', { name: '返回搜索结果' }).click();
  await expect(page.getByTestId('douyin-post')).toHaveCount(3);

  const detail = page.waitForRequest(request => decodeURIComponent(new URL(request.url()).pathname) === '/api/works/hongguo:7500000000000000001');
  await page.getByTestId('hongguo-match').click();
  await detail;
});

test('searches accounts and shows a refused search as a retryable message', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: '账号', exact: true }).click();
  await page.getByLabel('抖音搜索词').fill('万物有声');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByTestId('douyin-account')).toContainText('抖音号 wanwu');
  await expect(page.getByTestId('douyin-account')).toContainText('粉丝 1.2万');
  await page.getByLabel('抖音搜索词').fill('太快');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('搜索没有完成')).toBeVisible();
  await expect(page.getByText('一分钟内搜索太多次了，请稍等一会儿再试')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
});

test('says so when the deployment has no Douyin search', async ({ page }) => {
  await fixture(page, { enabled: false });
  await expect(page.getByText('抖音搜索尚未开通')).toBeVisible();
  await expect(page.getByLabel('抖音搜索词')).toHaveCount(0);
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  await page.getByLabel('抖音搜索词').fill('鉴宝天骄');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByTestId('douyin-post')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(page.getByRole('link', { name: '打开抖音' }).first()).toBeVisible();
});
