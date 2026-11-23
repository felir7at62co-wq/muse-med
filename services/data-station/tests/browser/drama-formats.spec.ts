import { expect, test, type Page } from '@playwright/test';
import { servePage } from './page-fixture';
import type { BoardDayList, BoardPeriodView, Work } from '../../src/shared/types';

const at = '2026-11-13T06:00:00.000Z';
const BOARDS = ['综合热播榜', '真人热播榜', 'AI 热播榜', '漫剧热播榜', '综合新剧榜', '综合收藏榜', '综合必看榜'];

function work(board: string, rank: number, format: string, title: string): Work {
  const sourceId = `90000000000000${BOARDS.indexOf(board)}${rank}`;
  return {
    id: `hongguo:${sourceId}`, sourceId, platform: 'hongguo', kind: 'drama', title, author: null, description: '剧种筛选浏览器测试夹具。',
    coverUrl: null, sourceUrl: 'https://example.invalid/work', tags: [format, '都市'], category: format, episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: 1000 }], rank, rankChange: null, board,
    origin: 'live', observedAt: at, sourceUpdatedAt: null, topics: [],
  };
}

const works: Work[] = [
  work('综合热播榜', 1, 'AI剧', '综合热播第一'), work('真人热播榜', 1, '真人剧', '真人热播第一'), work('AI 热播榜', 1, 'AI剧', 'AI 热播第一'),
  work('漫剧热播榜', 1, '漫剧', '漫剧热播第一'),
  work('综合新剧榜', 1, 'AI剧', '新剧 AI'), work('综合新剧榜', 2, '真人剧', '新剧真人'), work('综合新剧榜', 3, '漫剧', '新剧漫剧'),
  work('综合新剧榜', 4, '真人剧', '新剧真人二'),
];

async function mockApi(page: Page) {
  await servePage(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/session') return json({ id: 'browser-user', name: '本地预览', role: 'member', mode: 'local-preview' });
    if (url.pathname === '/api/collectors') return json([]);
    if (url.pathname === '/api/bookshelf' || url.pathname === '/api/bookshelf/originals') return json([]);
    if (url.pathname === '/api/boards') return json(url.searchParams.get('platform') === 'hongguo' ? { boards: BOARDS, defaultBoard: '综合热播榜' } : { boards: [], defaultBoard: null });
    if (url.pathname === '/api/boards/days') return json({ days: [{ date: '2026-11-13', observedAt: at }], truncated: false } satisfies BoardDayList);
    if (url.pathname === '/api/boards/period') {
      const board = url.searchParams.get('board')!;
      return json({ platform: 'hongguo', board, origin: 'live', period: 'day', date: '2026-11-13', start: '2026-11-13', end: '2026-11-13', daysInPeriod: 1,
        days: [{ date: '2026-11-13', observedAt: at }], previous: null,
        items: works.filter(item => item.board === board).map(item => ({ position: item.rank, daysOnBoard: 1, averageRank: item.rank, bestRank: item.rank, lastDate: '2026-11-13', work: item })),
      } satisfies BoardPeriodView);
    }
    if (url.pathname.startsWith('/api/covers/')) return route.fulfill({ status: 404, body: '' });
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
}

const formatTab = (page: Page, name: string) => page.getByRole('group', { name: '剧种筛选' }).getByRole('button', { name, exact: true });
const boardChips = (page: Page) => page.getByRole('group', { name: '榜单筛选' }).getByRole('button');
const titles = (page: Page) => page.getByTestId('work-row').locator('td:nth-child(2)');

test('switches Hongguo boards by drama format and filters the boards that rank every format', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(formatTab(page, '全部')).toHaveAttribute('aria-pressed', 'true');
  await expect(boardChips(page)).toHaveText(['综合热播', '真人热播', 'AI 热播', '漫剧热播', '新剧', '收藏', '必看', '全部收录']);
  await expect(titles(page)).toContainText(['综合热播第一']);

  await formatTab(page, '真人剧').click();
  await expect(boardChips(page)).toHaveText(['真人热播', '新剧', '收藏', '必看', '全部收录']);
  await expect(boardChips(page).filter({ hasText: '真人热播' })).toHaveAttribute('aria-pressed', 'true');
  await expect(titles(page)).toContainText(['真人热播第一']);
  await expect(page.getByTestId('format-note')).toHaveCount(0);

  await boardChips(page).filter({ hasText: '新剧' }).click();
  await expect(titles(page)).toHaveCount(2);
  await expect(titles(page)).toContainText(['新剧真人', '新剧真人二']);
  await expect(page.getByTestId('work-row').locator('td').first()).toHaveText('02');
  await expect(page.getByTestId('format-note')).toHaveText('只显示真人剧，名次沿用综合新剧榜全部剧种的排名');

  await formatTab(page, '漫剧').click();
  await expect(boardChips(page).filter({ hasText: '新剧' })).toHaveAttribute('aria-pressed', 'true');
  await expect(titles(page)).toHaveCount(1);
  await expect(titles(page)).toContainText(['新剧漫剧']);

  await formatTab(page, '全部').click();
  await expect(titles(page)).toHaveCount(4);
  await expect(page.getByTestId('format-note')).toHaveCount(0);
});
