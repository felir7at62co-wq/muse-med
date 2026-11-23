import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFanqieDiscovery } from '../src/server/discovery/fanqie.ts';
import type { FanqieDiscoveryOptions } from '../src/server/discovery/fanqie.ts';
import type { DiscoveryTask } from '../src/server/discovery/crawler.ts';
import { FanqieDetailCache } from '../src/server/collectors/fanqie/cache.ts';

const cycle = '21600000:42';
const observedAt = '2026-11-13T12:00:00.000Z';
const signal = new AbortController().signal;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const id = (index = 1) => (9000000000000000122n + BigInt(index)).toString();
const categories = Array.from({ length: 10 }, (_, index) => ({ category_id: index + 1, label: index % 2 ? '情节' : '主分类', name: `分类${index + 1}` }));
function directory() { return { code: 0, data: categories }; }
function list(size = 18, hasMore = true) { return { code: 0, data: {
  total_count: 10000, has_more: hasMore, book_list: Array.from({ length: size }, (_, index) => ({
    book_id: id(index + 1), last_chapter_time: '1794566695', book_name: '\ue400不可信', author: '\ue410不可信', read_count: '0', word_count: '\ue411',
  })),
} }; }
function detail(bookId = id(), extra: Record<string, unknown> = {}) { return { code: 0, data: {
  bookId, bookName: '已核对小说', author: '真实作者', abstract: '官方明文简介', creationStatus: 1, wordNumber: '123456',
  categoryV2: JSON.stringify([{ Name: '穿越' }, { Name: '系统' }]), thumbUrl: 'https://p6-novel-sign.byteimg.com/cover.jpg', readCount: '0',
  ...extra,
}, recommendations: [{ bookId: id(50), bookName: '推荐不可取' }] }; }
function fixture(): typeof fetch { return async input => {
  const url = new URL(String(input));
  const page = list();
  if (url.searchParams.get('page_index') === '1') page.data.book_list.forEach((row, index) => { row.book_id = id(index + 19); });
  return Response.json(url.pathname.includes('category_list') ? directory() : url.pathname.includes('book_list') ? page : detail(url.searchParams.get('bookId')!));
}; }
function adapter(options: FanqieDiscoveryOptions = {}) { return createFanqieDiscovery({ requestIntervalMs: 0, now: () => new Date(observedAt), fetch: fixture(), ...options }); }
async function first(options: FanqieDiscoveryOptions = {}) { const source = adapter(options); return { source, task: (await source.seeds(cycle, signal))[0]! }; }
async function detailJob() { const { source, task } = await first(); return (await source.handle(task, signal)).next[0]!; }
async function cachePath() {
  await mkdir('.data', { recursive: true }); const directory = await mkdtemp(join(process.cwd(), '.data', 'test-fanqie-discovery-'));
  directories.push(directory); return join(directory, 'details.json');
}
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }

describe('Fanqie library discovery and independent plaintext verification', () => {
  it('seeds bounded periodic latest windows for all, male and female plus the official directory', async () => {
    const jobs = await adapter().seeds(cycle, signal);
    expect(jobs).toHaveLength(4);
    expect(jobs.slice(0, 3).map(job => new URL(job.url).searchParams.get('gender'))).toEqual(['-1', '1', '0']);
    expect(jobs.slice(0, 3).every(job => job.priority === 'front' && new URL(job.url).searchParams.get('sort') === '1')).toBe(true);
    expect(new URL(jobs[3]!.url).pathname).toBe('/api/author/book/category_list/v0/');
  });

  it('discovers real category IDs, rotates a bounded latest subset, and reuses stable historical keys', async () => {
    const source = adapter({ latestCategoriesPerCycle: 2 });
    const seeds = await source.seeds(cycle, signal), nextSeeds = await source.seeds('21600000:43', signal);
    const first = await source.handle(seeds[3]!, signal), second = await source.handle(nextSeeds[3]!, signal);
    const periodic = first.next.filter(job => job.priority === 'front');
    expect(periodic).toHaveLength(2);
    expect(periodic.map(job => new URL(job.url).searchParams.get('category_id'))).toEqual(['5', '6']);
    expect(second.next.filter(job => job.priority === 'front').map(job => new URL(job.url).searchParams.get('category_id'))).toEqual(['7', '8']);
    expect(first.next.filter(job => !job.priority).map(job => job.uniqueKey)).toEqual(second.next.filter(job => !job.priority).map(job => job.uniqueKey));
    expect(first.next.filter(job => !job.priority)).toHaveLength(23);
    expect(first.coverage).toContain('分类相互重叠');
    const params = first.next.map(job => new URL(job.url).searchParams);
    expect(new Set(params.map(row => row.get('sort')))).toEqual(new Set(['0', '1', '2']));
    expect(new Set(params.map(row => row.get('creation_status')))).toEqual(new Set(['-1', '1', '2']));
    expect(new Set(params.map(row => row.get('word_count')))).toEqual(new Set(['-1', '0', '1', '2', '3', '4']));
  });

  it('rejects duplicate, encoded and malformed categories before returning queued tasks', async () => {
    for (const data of [[categories[0], categories[0]], [{ ...categories[0], category_id: '123' }], [{ ...categories[0], name: '\ue400分类' }], [{ ...categories[0], label: '未验证标签' }], []]) {
      const source = adapter({ fetch: async () => Response.json({ code: 0, data }) });
      await expect(source.handle((await source.seeds(cycle, signal))[3]!, signal)).rejects.toThrow();
    }
  });

  it('performs one HTTP read per list and queues encoded IDs for independent priority details', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(fixture());
    const { source, task } = await first({ fetch: fetchPage });
    const result = await source.handle(task, signal);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('batch');
    expect(result.next).toHaveLength(19);
    expect(result.next.slice(0, 18).every(job => job.priority === 'front' && job.data.kind === 'detail')).toBe(true);
    expect(result.next[0]).toMatchObject({ url: `https://fanqienovel.com/api/book/info?bookId=${id()}`, data: { bookId: id(), sourceUrl: task.url, cycle } });
    expect(result.next[18]).toMatchObject({ data: { kind: 'list', cycle: null, pageIndex: 1 } });
    expect(result.next[18]?.priority).toBeUndefined();
    expect(result.coverage).toContain('候选 ID');
    expect(JSON.stringify(result.next)).not.toMatch(/[\uE000-\uF8FF]/u);
  });

  it('keeps old-page and detail keys stable while periodic latest details can be revisited', async () => {
    const source = adapter(), a = (await source.seeds(cycle, signal))[0]!, b = (await source.seeds('21600000:43', signal))[0]!;
    const left = await source.handle(a, signal), right = await source.handle(b, signal);
    expect(left.next[0]?.uniqueKey).not.toBe(right.next[0]?.uniqueKey);
    expect(left.next[18]?.uniqueKey).toBe(right.next[18]?.uniqueKey);
    const history = await source.handle(left.next[18]!, signal);
    expect(history.next[0]?.priority).toBeUndefined();
    expect(history.next[0]?.uniqueKey).not.toContain('latest');
  });

  it('publishes only the matching plaintext detail with unknown ranking metrics and string identity', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(fixture());
    const result = await adapter({ fetch: fetchPage }).handle(await detailJob(), signal);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.next).toEqual([]);
    expect(result.batch?.works).toEqual([expect.objectContaining({
      id: `fanqie:${id()}`, sourceId: id(), title: '已核对小说', author: '真实作者', description: '官方明文简介',
      board: '', rank: null, rankChange: null, wordCount: 123456, serialStatus: '连载中', origin: 'live',
      observedAt, sourceUpdatedAt: null, metadataStatus: 'verified', tags: ['穿越', '系统'],
      metrics: [{ key: 'currentReaders', label: '在读人数', value: null }], publishedAt: null,
    })]);
    expect(result.batch?.works[0]?.metadataNote).toContain('官方书库发现来源');
    expect(JSON.stringify(result)).not.toContain('推荐不可取');
  });

  it('keeps an uncategorized verified book as an empty category rather than invalid null', async () => {
    const source = adapter({ fetch: async input => {
      const value = detail(new URL(String(input)).searchParams.get('bookId')!);
      value.data.categoryV2 = '[]';
      return Response.json(value);
    } });
    const result = await source.handle(await detailJob(), signal);
    expect(result.batch?.works[0]?.category).toBe('');
    expect(result.batch?.works[0]?.tags).toEqual([]);
  });

  it('checkpoints each verified detail, reuses its original cache time and refetches expired metadata', async () => {
    const path = await cachePath(), job = await detailJob();
    await adapter({ detailCache: new FanqieDetailCache(path) }).handle(job, signal);
    const saved = await readFile(path, 'utf8');
    expect(JSON.parse(saved).entries).toHaveLength(1);
    expect(JSON.parse(saved).entries[0].fetchedAt).toBe(observedAt);
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(fixture());
    await adapter({ detailCache: new FanqieDetailCache(path), now: () => new Date('2026-11-13T13:00:00Z'), fetch: fetchPage }).handle(job, signal);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(saved);
    await adapter({ detailCache: new FanqieDetailCache(path), now: () => new Date('2026-11-14T13:00:00Z'), fetch: fetchPage }).handle(job, signal);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('accepts short pages with has_more true and stops only at a source end or public page99 cap', async () => {
    const { source, task } = await first({ fetch: async () => Response.json(list(10, true)) });
    expect((await source.handle(task, signal)).next.at(-1)?.data.pageIndex).toBe(1);
    const last: DiscoveryTask = { ...task, url: task.url.replace('page_index=0', 'page_index=98'), data: { ...task.data, cycle: null, pageIndex: 98,
      previousSignatures: Array.from({ length: 98 }, (_, index) => sha(String(index))) } };
    const result = await source.handle(last, signal);
    expect(result.next).toHaveLength(10);
    expect(result.coverage).toContain('99 页窗口上限');
    expect(result.coverage).toContain('尚未取全');
    const ended = await first({ fetch: async () => Response.json(list(4, false)) });
    expect((await ended.source.handle(ended.task, signal)).next).toHaveLength(4);
    const empty = await first({ fetch: async () => Response.json({ code: 0, data: { book_list: [], has_more: false, total_count: 0 } }) });
    expect((await empty.source.handle(empty.task, signal)).next).toEqual([]);
  });

  it('ends a repeated-page history without publishing duplicates or claiming full coverage', async () => {
    const { source, task } = await first({ fetch: async () => Response.json(list()) });
    const result = await source.handle({ ...task, url: task.url.replace('page_index=0', 'page_index=1'), data: { ...task.data, cycle: null, pageIndex: 1,
      previousSignatures: [sha(list().data.book_list.map(row => row.book_id).join(','))] } }, signal);
    expect(result).not.toHaveProperty('batch'); expect(result.next).toEqual([]);
    expect(result.coverage).toContain('重复'); expect(result.coverage).toContain('不认定全库');
  });

  it('rejects duplicate or numeric identities, inconsistent totals, malformed cursors and continued empty pages', async () => {
    const row = list().data.book_list[0]!;
    for (const data of [
      { ...list().data, book_list: [row, row] }, { ...list().data, book_list: [{ ...row, book_id: Number(id()) }] },
      { ...list().data, total_count: 1 }, { ...list().data, book_list: [], has_more: true },
      { ...list().data, has_more: 'true' }, { ...list().data, book_list: [{ ...row, last_chapter_time: 'yesterday' }] },
    ]) {
      const { source, task } = await first({ fetch: async () => Response.json({ code: 0, data }) });
      await expect(source.handle(task, signal)).rejects.toThrow();
    }
  });

  it('does not publish or cache exact source-unavailable details and rejects other restrictions', async () => {
    const job = await detailJob(), path = await cachePath();
    const result = await adapter({ detailCache: new FanqieDetailCache(path), fetch: async () => Response.json({ code: -1, message: '查无此书', data: {} }) }).handle(job, signal);
    expect(result).not.toHaveProperty('batch'); expect(result.coverage).toContain('查无此书');
    await expect(readFile(path)).rejects.toThrow();
    for (const [code, message] of [[-1, '请先登录'], [-1, '请完成访问验证'], [1234, '查无此书'], [-1, '查无此书，请登录后再试']] as const) {
      await expect(adapter({ fetch: async () => Response.json({ code, message }) }).handle(job, signal)).rejects.toThrow(`code=${code}`);
    }
  });

  it('rejects mismatched identities and encoded detail names rather than taking recommendation metadata', async () => {
    const job = await detailJob();
    for (const value of [detail(id(99)), detail(id(), { bookName: '\ue400名称' }), detail(id(), { author: '\ue410作者' })]) {
      await expect(adapter({ fetch: async () => Response.json(value) }).handle(job, signal)).rejects.toThrow();
    }
  });

  it('rejects changed business envelopes and bad JSON without returning successor tasks', async () => {
    for (const response of [Response.json({ code: -1, message: '请登录' }), Response.json({ code: '0', data: list().data }), new Response('{', { headers: { 'content-type': 'application/json' } })]) {
      const { source, task } = await first({ fetch: async () => response });
      await expect(source.handle(task, signal)).rejects.toThrow();
    }
  });

  it('validates durable URLs, source URLs, parameters and pagination before network', async () => {
    const fetchPage = vi.fn<typeof fetch>(), { source, task } = await first({ fetch: fetchPage });
    const job = await detailJob();
    const bad: DiscoveryTask[] = [
      { ...task, url: task.url.replace('fanqienovel.com', 'example.invalid') },
      { ...task, data: { ...task.data, pageIndex: 99 } }, { ...task, data: { ...task.data, pageIndex: 1 } },
      { ...task, data: { ...task.data, partition: { ...Object(task.data.partition), categoryId: '../private' } } },
      { ...task, url: `${task.url}&page_index=0` }, { ...job, data: { ...job.data, sourceUrl: 'https://example.invalid/' } },
      { ...job, data: { ...job.data, bookId: Number(id()) } },
      { ...job, data: { ...job.data, sourceUrl: String(job.data.sourceUrl).replace('page_index=0', 'page_index=99') } },
      { ...job, data: { ...job.data, sourceUrl: `${String(job.data.sourceUrl)}&sort=1` } },
    ];
    for (const invalid of bad) await expect(source.handle(invalid, signal)).rejects.toThrow();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('rejects HTTP restrictions, redirects, unexpected content and oversized bodies', async () => {
    for (const response of [new Response('denied', { status: 403 }), new Response('move', { status: 302 }), new Response('<html>验证</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json' } }), Response.json({}, { headers: { 'content-length': '1025' } })]) {
      const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      const { source, task } = await first({ fetch: fetchPage, maxResponseBytes: 1024 });
      await expect(source.handle(task, signal)).rejects.toThrow();
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
    const redirected = Response.json(list()); Object.defineProperty(redirected, 'url', { value: 'https://example.invalid/' });
    const { source, task } = await first({ fetch: async () => redirected });
    await expect(source.handle(task, signal)).rejects.toThrow(/跳转/);
  });

  it('stops on cancellation before requests and after a response without publishing or caching', async () => {
    const fetchPage = vi.fn<typeof fetch>(), { source, task } = await first({ fetch: fetchPage });
    await expect(source.handle(task, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    await expect(source.seeds(cycle, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(fetchPage).not.toHaveBeenCalled();
    const abort = new AbortController(), job = await detailJob();
    await expect(adapter({ fetch: async () => { abort.abort(new Error('cancelled')); return Response.json(detail()); } }).handle(job, abort.signal)).rejects.toThrow('cancelled');
  });

  it('validates request tuning and cycle identities before use', async () => {
    for (const options of [{ latestCategoriesPerCycle: 0 }, { latestCategoriesPerCycle: 101 }, { requestTimeoutMs: 1 }, { requestIntervalMs: -1 }, { maxResponseBytes: 1 }]) expect(() => adapter(options)).toThrow();
    await expect(adapter().seeds('../invalid', signal)).rejects.toThrow();
  });
});
