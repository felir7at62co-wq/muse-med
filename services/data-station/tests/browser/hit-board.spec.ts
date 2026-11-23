import { expect, test } from '@playwright/test';
import type { HitBoard, HitBoardItem, TranscriptionJob } from '../../src/shared/hits';

test('shows the empty stockpile board from the real preview server', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('view-navigation').getByRole('button', { name: '储备看板', exact: true }).click();
  await expect(page.getByTestId('hit-summary')).toContainText('剧本储备');
  await expect(page.getByTestId('hit-summary')).toContainText('平均出稿');
  await expect(page.getByTestId('hit-board')).toContainText('收藏超过 10万');
  await expect(page.getByTestId('hit-board')).toContainText('这个筛选下没有作品');
});

const base = { qualifiedAt: '2026-11-15T01:00:00.000Z', queuedAt: '2026-11-15T01:00:00.000Z', rushAt: null, requestedBy: null, workerId: null, claimedAt: null,
  heartbeatAt: null, leaseExpiresAt: null, attempts: 0, progress: null, videos: null, scriptId: null, checks: null, lastError: null, publishedAt: null,
  createdAt: '2026-11-15T01:00:00.000Z', updatedAt: '2026-11-15T01:00:00.000Z', priority: 300000 } satisfies Partial<TranscriptionJob>;
function item(n: number, job: Partial<TranscriptionJob> | null, extra: Partial<HitBoardItem> = {}): HitBoardItem {
  const sourceId = `760000000000000000${n}`;
  return {
    work: { id: `hongguo:${sourceId}`, sourceId, title: `测试剧${n}`, coverUrl: null, sourceUrl: 'https://hongguoduanju.com/', tags: ['种田'], episodeCount: 65, board: '综合热播榜', observedAt: '2026-11-15T00:00:00.000Z' },
    evaluation: { qualified: true, unmet: [], collection: { value: 320000, measuredAt: '2026-11-15T00:00:00.000Z', source: 'board' }, completion: 'completed', completionMeasuredAt: '2026-11-15T00:00:00.000Z',
      sink: { qualifies: true, blocked: false, score: 8, strongHits: ['种田'], blockHits: [], directions: ['年代文'] },
      ip: n === 2 ? { level: 'suspected', fanqieWorkId: 'fanqie:1', fanqieTitle: '原著小说', reasons: ['主标题相同'] } : { level: 'none', fanqieWorkId: null, fanqieTitle: null, reasons: [] },
      douyin: n === 4 ? { state: 'not_found', keyword: `测试剧${n}`, topicName: null, hashtagId: null, viewCount: null, postCount: null, checkedAt: '2026-11-15T01:00:00.000Z', manual: false, error: null }
        : { state: 'pass', keyword: `测试剧${n}`, topicName: `测试剧${n}`, hashtagId: '1700000000000000001', viewCount: 132000000, postCount: 900, checkedAt: '2026-11-15T01:00:00.000Z', manual: false, error: null },
      evaluatedAt: '2026-11-15T01:00:00.000Z' },
    job: job ? { ...base, workId: `hongguo:${sourceId}`, sourceId, state: 'queued', lane: 'new', ...job } as TranscriptionJob : null,
    script: null, ...extra,
  };
}

test('renders pipeline stages, episode progress, IP labels, video links and 立即转写', async ({ page }) => {
  const directory = 'download-video-date/hongguo/20261115/7600000000000000003/';
  const items = [
    item(1, { state: 'transcribing', lane: 'new', progress: { episode: 12, totalEpisodes: 65, message: null, updatedAt: '2026-11-15T02:00:00.000Z' } }),
    item(2, { state: 'queued', lane: 'backlog' }),
    item(3, { state: 'published', lane: 'new', publishedAt: '2026-11-15T03:00:00.000Z', scriptId: '00000000-0000-4000-8000-000000000001',
      videos: { bucket: 'muse', date: '20261115', directory, directoryUrl: `https://muse.tos-cn-beijing.volces.com/${directory}`,
        manifest: { key: `${directory}manifest.json`, url: `https://muse.tos-cn-beijing.volces.com/${directory}manifest.json` },
        objects: [{ kind: 'video', key: `${directory}video/001.mp4`, url: `https://muse.tos-cn-beijing.volces.com/${directory}video/001.mp4`, bytes: 1, sha256: null, status: 'uploaded' }],
        recordedAt: '2026-11-15T03:00:00.000Z' } },
    { script: { id: '00000000-0000-4000-8000-000000000001', workId: 'hongguo:7600000000000000003', fileName: '测试剧3.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byteLength: 10, sha256: 'a'.repeat(64), createdAt: '2026-11-15T03:00:00.000Z' } }),
    item(4, { state: 'needs-attention', lane: 'backlog', lastError: { at: '2026-11-15T02:00:00.000Z', reason: '程序检查两次未通过', stage: 'checking' } }),
    item(5, { state: 'rejected', lane: 'new', review: { rejectedAt: '2026-11-15T02:30:00.000Z', reason: '校园青春恋爱为主，整体受众偏年轻', workerId: 'w1' } }),
  ];
  const board = (filter: string, q: string | null): HitBoard => {
    const filtered = filter === 'script' ? items.filter(entry => entry.script) : filter === 'rejected' ? items.filter(entry => entry.job?.state === 'rejected') : items;
    const shown = q ? filtered.filter(entry => `${entry.work.title} ${entry.work.sourceId}`.includes(q)) : filtered;
    return { summary: { stock: 1, addedToday: 1, averageHoursToDownload: 2.5, averageWindowDays: 30, failures: 1, rejected: 1, queued: 1, active: 1, candidates: 4 },
      rules: { minCollection: 100000, minDouyinPlays: 50000000, requireDouyinPlays: true, requireCompleted: true, excludeConfirmedIp: true, autoEnqueue: true }, items: shown, total: shown.length, page: 1, limit: 30,
      filter: filter as HitBoard['filter'], selection: { state: 'success', lastAttemptAt: null, lastSuccessAt: '2026-11-15T01:00:00.000Z', nextRunAt: null, evaluated: 9, detailsRead: 3, detailsFailed: 0, enqueued: 2, message: '评估 9 部下沉候选，入选 4 部' },
      generatedAt: '2026-11-15T03:00:00.000Z' };
  };
  let rushed = '';
  const queries: string[] = [];
  await page.route('**/api/hits/board?*', route => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params.get('q') ?? '');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(board(params.get('filter') ?? 'all', params.get('q'))) });
  });
  await page.route('**/api/hits/*/rush', async route => { rushed = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!); await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...items[1]!.job, rushAt: '2026-11-15T04:00:00.000Z', lane: 'manual' }) }); });
  await page.goto('/');
  await page.getByTestId('view-navigation').getByRole('button', { name: '储备看板', exact: true }).click();
  await expect(page.getByTestId('hit-summary')).toContainText('2.5 小时');
  const rows = page.getByTestId('hit-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('转写中 · 第 12/65 集');
  await expect(rows.nth(0).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '18');
  await expect(rows.nth(1)).toContainText('疑似 IP · 《原著小说》');
  await expect(rows.nth(2)).toContainText('可下载');
  await expect(rows.nth(2).getByTestId('script-download')).toBeEnabled();
  await rows.nth(2).getByText('原片 1 个').click();
  await expect(rows.nth(2).getByRole('link', { name: /001\.mp4/ })).toHaveAttribute('href', `https://muse.tos-cn-beijing.volces.com/${directory}video/001.mp4`);
  await expect(rows.nth(3)).toContainText('程序检查两次未通过');
  await expect(rows.nth(4)).toContainText('复核淘汰');
  await expect(rows.nth(4).getByTestId('hit-review')).toHaveText('复核理由：校园青春恋爱为主，整体受众偏年轻');
  await expect(rows.nth(4).getByRole('button', { name: /立即转写/ })).toBeVisible();
  await expect(page.getByTestId('hit-summary')).toContainText('复核淘汰 1');
  await expect(rows.nth(0).getByTestId('hit-topic')).toContainText('1.32亿 播放');
  await expect(rows.nth(3).getByTestId('hit-topic')).toContainText('没有同名话题');
  await expect(rows.nth(3).getByRole('link', { name: '去抖音找' })).toHaveAttribute('href', /douyin\.com\/search\//);
  await expect(page.getByTestId('hit-board')).toContainText('抖音同名话题播放超过 5000万');
  await rows.nth(1).getByRole('button', { name: /立即转写/ }).click();
  await expect.poll(() => rushed).toBe('hongguo:7600000000000000002');
  await page.getByRole('button', { name: '复核淘汰', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试剧5');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.getByTestId('hit-search').fill('测试剧3');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试剧3');
  expect(queries).toContain('测试剧3');
  await page.getByTestId('hit-search').fill('7600000000000000004');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试剧4');
  await page.getByTestId('hit-search').fill('不存在的剧');
  await expect(page.getByTestId('hit-board')).toContainText('没有找到「不存在的剧」');
  await page.getByTestId('hit-search').press('Escape');
  await expect(rows).toHaveCount(5);
  // Pinyin still being composed is not searched; the committed characters are.
  const ime = await page.context().newCDPSession(page);
  await page.getByTestId('hit-search').focus();
  await ime.send('Input.imeSetComposition', { text: 'ceshiju', selectionStart: 7, selectionEnd: 7 });
  await page.waitForTimeout(800);
  expect(queries.filter(value => /ceshi/.test(value))).toEqual([]);
  await ime.send('Input.insertText', { text: '测试剧4' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试剧4');
  expect(queries.filter(value => /ceshi/.test(value))).toEqual([]);
  await page.getByTestId('hit-search').press('Escape');
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: '有剧本', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.screenshot({ path: 'artifacts/hit-board-browser.png', fullPage: true });
});
