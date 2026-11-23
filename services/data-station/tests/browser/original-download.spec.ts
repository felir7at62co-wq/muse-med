import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { servePage } from './page-fixture';
import type { NovelArtifact, NovelJob, NovelShelfItem, NovelState } from '../../src/shared/novels';
import type { Work } from '../../src/shared/types';

const at = '2026-11-13T11:00:00.000Z';
const work: Work = { id: 'fanqie:7395464458719464510', sourceId: '7395464458719464510', platform: 'fanqie', kind: 'novel',
  title: '原文下载测试作品', author: '测试作者', description: '独立测试夹具', coverUrl: null, sourceUrl: 'https://fanqienovel.com/page/7395464458719464510',
  tags: [], category: '', episodeCount: null, wordCount: 100, serialStatus: '连载中', publishedAt: null, metrics: [],
  rank: 1, rankChange: null, board: '测试榜单', origin: 'live', observedAt: at, sourceUpdatedAt: null };
const bytes = Buffer.from('原文下载测试作品\n第一章：这是完整性验证用的测试文本。\n');
const artifact: NovelArtifact = { id: 'f26a6af7-26cd-4913-9b91-57d0136f9493', workId: work.id, platform: 'fanqie',
  fileName: '原文下载测试作品-当前已发布1章.txt', contentType: 'text/plain', byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: at, sourceUrl: work.sourceUrl,
  directoryObservedAt: at, chapterCount: 1, scope: 'current-published-directory' };
const job: NovelJob = { id: 'c52052ca-f074-4d02-b069-cab7d26c42eb', workId: work.id, state: 'running', completedChapters: 0,
  totalChapters: 1, createdAt: at, updatedAt: at, errorCode: null, message: '正在核对章节', artifactId: null };

async function fixture(page: Page, options: { queued?: boolean; blocked?: boolean; corrupt?: boolean; delayDownload?: Promise<void>; shelfFailure?: boolean } = {}) {
  let user = 'original-user-a'; let started = false; let checks = 0; let fileRequests = 0; let shelfWrites = 0;
  const events: string[] = [];
  let originals: Array<{ user: string; artifactId: string }> = [];
  await servePage(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/session') return json({ id: user, name: user, role: 'member', mode: 'local-preview' });
    if (path === '/api/boards') return json({ boards: [work.board], defaultBoard: work.board });
    if (path === '/api/facets') return json({ groups: [] });
    if (path === '/api/boards/days') return json({ days: [{ date: '2026-11-13', observedAt: at }], truncated: false });
    if (path === '/api/boards/period') return json({ platform: url.searchParams.get('platform'), board: work.board, origin: 'live', period: 'day', date: '2026-11-13',
      start: '2026-11-13', end: '2026-11-13', daysInPeriod: 1, days: [{ date: '2026-11-13', observedAt: at }], previous: null,
      items: url.searchParams.get('platform') === 'fanqie' ? [{ position: 1, daysOnBoard: 1, averageRank: 1, bestRank: 1, lastDate: '2026-11-13', work }] : [] });
    if (path === '/api/works') return json({ items: url.searchParams.get('platform') === 'fanqie' ? [work] : [], total: url.searchParams.get('platform') === 'fanqie' ? 1 : 0, page: 1, limit: 10, categories: [], boards: [work.board] });
    if (path === `/api/works/${work.id}/original/jobs`) { started = true; return json({ available: true, artifact: null, job: { ...job, state: 'queued' } } satisfies NovelState, 202); }
    if (path === `/api/works/${work.id}/original`) {
      if (options.blocked && started) return json({ available: true, artifact: null, job: { ...job, state: 'failed', errorCode: 'authorization_required', message: '来源有锁定章节，未发布不完整正文' } } satisfies NovelState);
      if (options.queued && (!started || checks++ === 0)) return json({ available: true, artifact: null, job: started ? job : null } satisfies NovelState);
      return json({ available: true, artifact, job: { ...job, state: 'ready', artifactId: artifact.id, completedChapters: 1 } } satisfies NovelState);
    }
    if (path === `/api/originals/${artifact.id}/download`) {
      fileRequests++; events.push('file');
      if (options.delayDownload) await options.delayDownload;
      const body = Buffer.from(bytes); if (options.corrupt) body[0] = body[0]! ^ 1;
      return route.fulfill({ status: 200, contentType: 'text/plain', body });
    }
    if (path === '/api/bookshelf' && route.request().method() === 'POST') { shelfWrites++; return json({ added: true }); }
    if (path === '/api/bookshelf') return json([]);
    if (path === '/api/bookshelf/originals' && route.request().method() === 'POST') {
      events.push('shelf');
      if (options.shelfFailure) return json({ error: '书架暂时不可写' }, 503);
      const { artifactId } = JSON.parse(route.request().postData() || '{}') as { artifactId: string };
      originals = [...originals.filter(entry => entry.user !== user || entry.artifactId !== artifactId), { user, artifactId }];
      return json({ added: true });
    }
    if (path === '/api/bookshelf/originals') return json(originals.filter(entry => entry.user === user)
      .map((): NovelShelfItem => ({ work, artifact, downloadedAt: at, latestArtifactId: artifact.id })));
    if (path === `/api/bookshelf/originals/${artifact.id}` && route.request().method() === 'DELETE') { originals = originals.filter(entry => entry.user !== user); return json({ removed: true }); }
    throw new Error(`Unexpected original-download fixture request ${path}`);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '番茄小说', exact: true }).click();
  await expect(page.getByTestId('original-download')).toBeVisible();
  return { files: () => fileRequests, shelves: () => shelfWrites, originals: () => originals.length, events, setUser: (id: string) => { user = id; } };
}

test('downloads a verified original beside the script and labels a serial snapshot accurately', async ({ page }) => {
  const api = await fixture(page);
  await expect(page.getByRole('columnheader', { name: '剧本', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '原小说', exact: true })).toBeVisible();
  const ready = page.waitForEvent('download');
  await page.getByTestId('original-download').click();
  const download = await ready;
  expect(download.suggestedFilename()).toBe(artifact.fileName);
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await expect(page.getByText('已下载当前已发布的 1 章，已加入书架；后续可更新原文', { exact: true })).toBeVisible();
  expect(api.files()).toBe(1); expect(api.shelves()).toBe(0);
  expect(api.events).toEqual(['file', 'shelf']);
});

test('keeps a verified original in the bookshelf, downloads it again and removes only the shelf entry', async ({ page }) => {
  const api = await fixture(page);
  const first = page.waitForEvent('download');
  await page.getByTestId('original-download').click();
  await first;
  await expect.poll(api.originals).toBe(1);
  await page.getByTestId('view-navigation').getByRole('button', { name: '我的书架', exact: true }).click();
  const entry = page.getByTestId('bookshelf-original');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText(artifact.fileName);
  await expect(entry).toContainText('已发布 1 章');
  await expect(entry).toContainText('原文下载测试作品');
  await expect(page.getByTestId('bookshelf-originals')).toContainText('原小说');
  await page.screenshot({ path: 'artifacts/bookshelf-originals.png', fullPage: true });
  const again = page.waitForEvent('download');
  await entry.getByTestId('original-shelf-download').click();
  expect(await readFile((await (await again).path())!)).toEqual(bytes);
  await expect(page.getByRole('status')).toContainText('已加入书架');
  expect(api.files()).toBe(2);
  await entry.getByRole('button', { name: '移出书架', exact: true }).click();
  await expect(page.getByTestId('bookshelf-original')).toHaveCount(0);
  await expect(page.getByText('书架里还没有作品', { exact: true })).toBeVisible();
});

test('reports a saved file whose shelf entry could not be written', async ({ page }) => {
  const api = await fixture(page, { shelfFailure: true });
  const ready = page.waitForEvent('download');
  await page.getByTestId('original-download').click();
  expect(await readFile((await (await ready).path())!)).toEqual(bytes);
  await expect(page.getByRole('alert')).toContainText('但书架记录未保存：书架暂时不可写');
  expect(api.originals()).toBe(0);
});

test('shows queued and chapter progress until the complete artifact is published', async ({ page }) => {
  await fixture(page, { queued: true });
  const ready = page.waitForEvent('download');
  await page.getByTestId('original-download').click();
  await expect(page.getByTestId('original-download')).toHaveText('排队准备…');
  await expect(page.getByTestId('original-download')).toHaveText('核对 0/1 章');
  await ready;
  await expect(page.getByTestId('original-download')).toHaveText('原小说');
});

test('shows a locked-chapter failure without requesting or saving a partial file', async ({ page }) => {
  const api = await fixture(page, { queued: true, blocked: true });
  await page.getByTestId('original-download').click();
  await expect(page.getByText('来源有锁定章节，未发布不完整正文', { exact: true })).toBeVisible();
  expect(api.files()).toBe(0); expect(api.originals()).toBe(0);
});

test('rejects corrupted file bytes before a browser download starts', async ({ page }) => {
  const api = await fixture(page, { corrupt: true }); let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.getByTestId('original-download').click();
  await expect(page.getByText('原小说文件校验失败，请联系管理员', { exact: true })).toBeVisible();
  expect(api.files()).toBe(1); expect(downloads).toBe(0); expect(api.originals()).toBe(0);
});

test('does not save a previous account file after identity changes during the request', async ({ page }) => {
  let release!: () => void;
  const delayDownload = new Promise<void>(resolve => { release = resolve; });
  const api = await fixture(page, { delayDownload }); let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.getByTestId('original-download').click();
  await expect.poll(api.files).toBe(1);
  api.setUser('original-user-b');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('original-user-b', { exact: true })).toBeVisible();
  release();
  await page.getByRole('button', { name: '番茄小说', exact: true }).click();
  await expect(page.getByTestId('original-download')).toBeEnabled();
  expect(downloads).toBe(0); expect(api.originals()).toBe(0);
});
