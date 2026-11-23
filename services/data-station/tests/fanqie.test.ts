import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFanqie } from '../src/server/collectors/fanqie.ts';
import { FanqieDetailCache } from '../src/server/collectors/fanqie/cache.ts';
import { parseFanqieDetail, readInitialState, sourceCount } from '../src/server/collectors/fanqie/parser.ts';
import { resolveConfig } from '../src/server/config.ts';

const observedAt = '2026-11-13T07:00:00.000Z';
const version = '1794555000';
const categories = { male: [{ id: '262', name: '都市脑洞' }, { id: '257', name: '玄幻脑洞' }], female: [{ id: '267', name: '现言脑洞' }, { id: '253', name: '古言脑洞' }, { id: '1139', name: '古风世情' }] };
const single = { channels: ['male' as const], boards: ['read' as const], categories: { male: ['262'] }, requestIntervalMs: 0 };
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

function bookId(index = 1): string { return (9000000000000000122n + BigInt(index)).toString(); }
function state(value: unknown): string { return `<html><title>番茄小说官网</title><p>统计时间截止至<!-- -->11-12 24:00</p><script>window.__INITIAL_STATE__=${JSON.stringify(value)};throw new Error('NEVER_EXECUTE');</script></html>`; }
function catalog(): string { return state({ rank: { serverRendered: true, rankVersion: version, rankCategoryTypeList: categories } }); }
function rank(categoryId = '262', size = 1) {
  return { code: 0, data: { rankVersion: version, total_num: size, book_list: Array.from({ length: size }, (_, index) => ({
    bookId: bookId(index + 1), currentPos: index + 1, curent_category_id: Number(categoryId),
    read_count: '235000', readCount: '0', bookName: '\ue400不可直接读', wordNumber: '234567', creationStatus: '1',
    thumbUri: 'https://p9-novel-sign.byteimg.com/novel-pic/fresh.image?sig=current',
  })) } };
}
function detail(id = bookId(), extra: Record<string, unknown> = {}) {
  return { code: 0, recommendations: [{ bookId: '999', bookName: '推荐书不可取' }], data: {
    bookId: id, bookName: '明文小说样例', author: '明文作者', abstract: '公开作品简介；含有 } 和 " 引号。',
    categoryV2: JSON.stringify([{ Name: '都市脑洞' }, { Name: '重生' }]), creationStatus: 1,
    wordNumber: '123456', readCount: 999999999, thumbUrl: 'https://p9-novel-sign.byteimg.com/novel-pic/old.image?sig=old', ...extra,
  } };
}
function html(body: string, status = 200, headers: HeadersInit = {}): Response { return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } }); }
function json(body: unknown): Response { return Response.json(body); }
function fixture(size = 1): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    return url.pathname.startsWith('/rank/') ? html(catalog()) : url.pathname.includes('/rank/') ? json(rank(url.searchParams.get('category_id')!, size)) : json(detail(url.searchParams.get('bookId')!));
  };
}
async function cachePath(): Promise<string> {
  await mkdir('.data', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.data', 'test-fanqie-'));
  directories.push(directory); return join(directory, 'details.json');
}

describe('Fanqie official full rankings and matching plaintext metadata', () => {
  it('collects all 100 official positions, matching plaintext IDs and fresh rank metrics', async () => {
    const calls: string[] = [];
    const result = await collectFanqie({ ...single, now: () => new Date(observedAt), fetch: async input => {
      calls.push(String(input)); return fixture(100)(input);
    } });
    expect(result.works).toHaveLength(100);
    expect(result.works.map(work => work.rank)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(result.works.map(work => work.sourceId)).size).toBe(100);
    const params = new URL(calls[1]!).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ limit: '100', offset: '0', category_id: '262', gender: '1', rankMold: '2', rank_version: version });
    expect(result.works[0]).toMatchObject({
      id: `fanqie:${bookId()}`, sourceId: bookId(), title: '明文小说样例', author: '明文作者', category: '都市脑洞',
      wordCount: 234567, serialStatus: '连载中', publishedAt: null, origin: 'live', observedAt,
      coverUrl: 'https://p9-novel-sign.byteimg.com/novel-pic/fresh.image?sig=current',
      board: '男频 · 阅读榜 · 都市脑洞', sourceUpdatedAt: `统计时间截止至11-12 24:00；官网榜单版本 ${version}`,
      metrics: [{ key: 'currentReaders', label: '在读人数', value: 235000 }],
    });
    expect(result.coverage).toContain('1/1 窗已取全');
    expect(result.coverage.length).toBeLessThan(2000);
    expect(JSON.stringify(result.works)).not.toMatch(/推荐书不可取|NEVER_EXECUTE|\ue400/);
  });

  it('discovers every official category instead of a fixed eight-window subset and deduplicates metadata', async () => {
    const calls: string[] = [];
    const result = await collectFanqie({ requestIntervalMs: 0, fetch: async input => { calls.push(String(input)); return fixture()(input); } });
    expect(calls.filter(url => url.includes('/api/rank/'))).toHaveLength(10);
    expect(calls.filter(url => url.includes('/api/book/info'))).toHaveLength(1);
    expect(result.works).toHaveLength(10);
    expect(new Set(result.works.map(work => work.board)).size).toBe(10);
    expect(calls.filter(url => url.includes('/api/rank/')).every(url => new URL(url).searchParams.get('rank_version') === version)).toBe(true);
    expect(result.coverage).toContain('男频 2 分类、女频 3 分类');
  });

  it('accepts real shorter boards with string totals rather than demanding 100 books', async () => {
    for (const size of [16, 33, 77]) {
      const result = await collectFanqie({ ...single, fetch: async input => {
        const url = new URL(String(input));
        if (url.pathname === '/api/rank/category/list') return json({ ...rank('262', size), data: { ...rank('262', size).data, total_num: String(size) } });
        return fixture()(input);
      } });
      expect(result.works).toHaveLength(size);
      expect(result.coverage).toContain('1 窗官方不足 100 部');
    }
  });

  it('leaves encoded, unsafe and absent counts unknown while retaining zero', async () => {
    for (const [readers, expected] of [['\ue412\ue413', null], ['9999999999999999999999', null], ['0', 0]] as const) {
      const result = await collectFanqie({ ...single, fetch: async input => {
        if (String(input).includes('/api/rank/')) { const response = rank(); response.data.book_list[0]!.read_count = readers; return json(response); }
        return fixture()(input);
      } });
      expect(result.works[0]?.metrics[0]?.value).toBe(expected);
    }
    expect(sourceCount(undefined)).toBeNull(); expect(sourceCount(-1)).toBeNull();
  });

  it('rejects changed versions, incomplete windows, duplicate identities, rank gaps, wrong categories and numeric IDs', async () => {
    const changes: ((response: ReturnType<typeof rank>) => unknown)[] = [
      value => ({ ...value, data: { ...value.data, rankVersion: '1794559999' } }),
      value => ({ ...value, data: { ...value.data, total_num: 100 } }),
      value => ({ ...value, data: { ...value.data, book_list: [...value.data.book_list, { ...value.data.book_list[0], currentPos: 2 }], total_num: 2 } }),
      value => ({ ...value, data: { ...value.data, book_list: [{ ...value.data.book_list[0], currentPos: 2 }] } }),
      value => rank('257'),
      value => ({ ...value, data: { ...value.data, book_list: [{ ...value.data.book_list[0], bookId: Number(bookId()) }] } }),
    ];
    for (const change of changes) await expect(collectFanqie({ ...single, fetch: async input => String(input).includes('/api/rank/') ? json(change(rank())) : fixture()(input) })).rejects.toThrow(/番茄采集失败/);
  });

  it('refuses mismatched or encoded plaintext details instead of taking recommendation objects', async () => {
    for (const page of [detail('999'), detail(bookId(), { bookName: '\ue420未解码' }), detail(bookId(), { author: '\ue420未解码' })]) {
      await expect(collectFanqie({ ...single, fetch: async input => String(input).includes('/api/book/info') ? json(page) : fixture()(input) })).rejects.toThrow(/番茄采集失败/);
    }
  });

  it('distinguishes business refusals from metadata changes without retrying unknown codes or login requests', async () => {
    const requests: string[] = [];
    await expect(collectFanqie({ ...single, fetch: async input => {
      requests.push(String(input));
      return String(input).includes('/api/book/info') ? json({ code: -1, message: `请先登录\nhttps://example.invalid/private?token=hidden ${'x'.repeat(300)}` }) : fixture()(input);
    } })).rejects.toThrow(`官网书籍资料 ${bookId()}返回业务错误 code=-1：请先登录 [来源地址]`);
    expect(requests.filter(url => url.includes('/api/book/info'))).toHaveLength(1);
    const rankingRequests: string[] = [];
    await expect(collectFanqie({ ...single, fetch: async input => {
      rankingRequests.push(String(input));
      return String(input).includes('/api/rank/') ? json({ code: 12345, message: '未知业务错误' }) : fixture()(input);
    } })).rejects.toThrow('code=12345');
    expect(rankingRequests.filter(url => url.includes('/api/rank/'))).toHaveLength(1);
  });

  it('reports failed field paths for successful envelopes while preserving strict ID and name validation', async () => {
    const calls: string[] = [];
    await expect(collectFanqie({ ...single, fetch: async input => {
      calls.push(String(input));
      return String(input).includes('/api/book/info') ? json(detail(bookId(), { categoryV2: null })) : fixture()(input);
    } })).rejects.toThrow(`官网书籍资料 ${bookId()}字段校验失败：data.categoryV2 (invalid_type)`);
    expect(calls.filter(url => url.includes('/api/book/info'))).toHaveLength(1);
  });

  it('retains every official position when a listed book has no public metadata and never caches an invented name', async () => {
    const file = await cachePath(), unavailableId = bookId(2);
    const calls: string[] = [];
    const result = await collectFanqie({ ...single, detailCache: new FanqieDetailCache(file), fetch: async input => {
      calls.push(String(input));
      return String(input).includes(`/api/book/info?bookId=${unavailableId}`) ? json({ code: -1, message: '查无此书', data: {} }) : fixture(2)(input);
    } });
    expect(result.works.map(work => work.rank)).toEqual([1, 2]);
    expect(result.works[0]).toMatchObject({ title: '明文小说样例', metadataStatus: 'verified' });
    expect(result.works[1]).toMatchObject({ sourceId: unavailableId, title: null, author: null, description: '', metadataStatus: 'unavailable',
      category: '都市脑洞', wordCount: 234567, rank: 2, metrics: [{ key: 'currentReaders', label: '在读人数', value: 235000 }],
      coverUrl: 'https://p9-novel-sign.byteimg.com/novel-pic/fresh.image?sig=current' });
    expect(result.works[1]?.metadataNote).toContain('查无此书');
    expect(result.coverage).toContain('明文资料 1/2、资料不可用 1');
    expect(calls.filter(url => url.includes(`/api/book/info?bookId=${unavailableId}`))).toHaveLength(1);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].bookId).toBe(bookId());
    const nextCalls: string[] = [];
    const next = await collectFanqie({ ...single, detailCache: new FanqieDetailCache(file), fetch: async input => {
      nextCalls.push(String(input)); return fixture(2)(input);
    } });
    expect(next.works[1]).toMatchObject({ title: '明文小说样例', metadataStatus: 'verified' });
    expect(nextCalls.filter(url => url.includes('/api/book/info'))).toEqual([`https://fanqienovel.com/api/book/info?bookId=${unavailableId}`]);
  });

  it('does not convert login, verification or differently coded refusals into unavailable metadata', async () => {
    for (const response of [{ code: -1, message: '请先登录' }, { code: -1, message: '请完成访问验证' }, { code: 12345, message: '查无此书' }, { code: -1, message: '查无此书，请登录后再试' }]) {
      await expect(collectFanqie({ ...single, fetch: async input => String(input).includes('/api/book/info') ? json(response) : fixture()(input) })).rejects.toThrow(/返回业务错误/);
    }
  });

  it('checkpoints successful metadata after budget failure and resumes with a new cache instance', async () => {
    const file = await cachePath();
    await expect(collectFanqie({ ...single, maxDetailRequests: 1, detailCache: new FanqieDetailCache(file), fetch: fixture(2) })).rejects.toThrow(/达到预算/);
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(1);
    const calls: string[] = [], progress: string[] = [];
    const result = await collectFanqie({ ...single, maxDetailRequests: 1, detailCache: new FanqieDetailCache(file),
      onProgress: async message => { await Promise.resolve(); progress.push(message); },
      fetch: async input => { calls.push(String(input)); return fixture(2)(input); },
    });
    expect(result.works).toHaveLength(2);
    expect(calls.filter(url => url.includes('/api/book/info'))).toEqual([`https://fanqienovel.com/api/book/info?bookId=${bookId(2)}`]);
    expect(progress.at(-1)).toContain('明文资料 2/2');
    expect(result.coverage).toContain('缓存 1（原始获取时间起有效 24 小时）');
    expect((await readdir(join(file, '..'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('preserves cache timestamps on reuse and fetches expired or future-dated metadata again', async () => {
    const file = await cachePath();
    const first = new FanqieDetailCache(file);
    await collectFanqie({ ...single, now: () => new Date(observedAt), detailCache: first, fetch: fixture() });
    const saved = await readFile(file, 'utf8');
    expect(await new FanqieDetailCache(file).get(bookId(), new Date('2026-11-13T08:00:00Z'))).not.toBeNull();
    expect(await new FanqieDetailCache(file).get(bookId(), new Date('2026-11-14T08:00:00Z'))).toBeNull();
    expect(await new FanqieDetailCache(file).get(bookId(), new Date('2026-11-12T08:00:00Z'))).toBeNull();
    await collectFanqie({ ...single, now: () => new Date('2026-11-13T08:00:00Z'), detailCache: new FanqieDetailCache(file), fetch: fixture() });
    expect(await readFile(file, 'utf8')).toBe(saved);
  });

  it('rejects malformed persisted metadata instead of silently trusting or replacing it', async () => {
    const file = await cachePath(); await writeFile(file, '{"version":1,"entries":[{"bookId":123}]}');
    await expect(new FanqieDetailCache(file).get(bookId(), new Date())).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toContain('"bookId":123');
  });

  it('checkpoints completed metadata on cancellation without returning an incomplete batch', async () => {
    const file = await cachePath(), abort = new AbortController();
    await expect(collectFanqie({ ...single, signal: abort.signal, detailCache: new FanqieDetailCache(file), fetch: async input => {
      const response = await fixture(2)(input);
      if (String(input).includes(`/api/book/info?bookId=${bookId(2)}`)) abort.abort(new Error('cancelled'));
      return response;
    } })).rejects.toThrow('cancelled');
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(1);
  });

  it('reads inert SSR JSON without evaluating expressions and normalizes only bare undefined values', () => {
    expect(readInitialState(state({ value: 'escaped " and }' }))).toEqual({ value: 'escaped " and }' });
    expect(readInitialState('<script>window.__INITIAL_STATE__={"missing":undefined,"array":[undefined,1],"text":"undefined"}</script>')).toEqual({ missing: null, array: [null, 1], text: 'undefined' });
    for (const page of ['<script>window.__INITIAL_STATE__=function(){return {}}</script>', '<script>window.__INITIAL_STATE__={"x":', '<script>window.__INITIAL_STATE__={"bad":undefined||globalThis}</script>', '<title>安全验证</title>']) expect(() => readInitialState(page)).toThrow();
  });

  it('rejects denied, redirected and unexpected response types without retrying restrictions', async () => {
    for (const response of [html('denied', 403), html('redirect', 302), json({})]) {
      const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response);
      await expect(collectFanqie({ ...single, fetch: fetchPage })).rejects.toThrow(/番茄采集失败/);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
    await expect(collectFanqie({ ...single, fetch: async input => String(input).includes('/api/rank/') ? html('login') : fixture()(input) })).rejects.toThrow(/元数据类型/);
  });

  it('retries only transient network or 429/5xx failures with a bounded attempt count', async () => {
    let calls = 0;
    const result = await collectFanqie({ ...single, retryDelayMs: 0, fetch: async input => {
      calls++;
      if (calls === 1) return html('slow down', 429);
      if (calls === 2) return html('unavailable', 503);
      return fixture()(input);
    } });
    expect(result.works).toHaveLength(1);
    expect(calls).toBe(5);
    const down = vi.fn<typeof fetch>().mockImplementation(async () => html('unavailable', 503));
    await expect(collectFanqie({ ...single, retryDelayMs: 0, fetch: down })).rejects.toThrow(/HTTP 503/);
    expect(down).toHaveBeenCalledTimes(3);
    let errors = 0;
    await collectFanqie({ ...single, retryDelayMs: 0, fetch: async input => {
      if (!errors++) throw new TypeError('connection reset');
      return fixture()(input);
    } });
    expect(errors).toBe(4);
  });

  it('bounds actual and declared response bytes', async () => {
    for (const response of [html('x'.repeat(1025)), html('tiny', 200, { 'content-length': '1025' })]) await expect(collectFanqie({ ...single, maxResponseBytes: 1024, fetch: async () => response })).rejects.toThrow(/大小限制/);
  });

  it('stops before network on cancellation and rejects invalid category or request configuration', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    await expect(collectFanqie({ ...single, signal: AbortSignal.abort(new Error('cancelled')), fetch: fetchPage })).rejects.toThrow('cancelled');
    await expect(collectFanqie({ maxResponseBytes: 1, fetch: fetchPage })).rejects.toThrow('maxResponseBytes');
    await expect(collectFanqie({ categories: { male: ['../private'] }, fetch: fetchPage })).rejects.toThrow('categories');
    expect(fetchPage).not.toHaveBeenCalled();
    await expect(collectFanqie({ ...single, categories: { male: ['9999'] }, fetch: fixture() })).rejects.toThrow(/当前频道目录/);
  });

  it('validates server cache TTL, request interval and detail budget configuration', () => {
    const defaults = resolveConfig();
    expect(defaults).toMatchObject({ fanqieDetailCacheHours: 24, fanqieRequestIntervalMs: 250, fanqieDetailBudget: 10_000 });
    expect(defaults.fanqieLatestCategoriesPerCycle).toBe(8);
    for (const values of [{ MUSE_DATA_FANQIE_DETAIL_CACHE_HOURS: '0' }, { MUSE_DATA_FANQIE_DETAIL_CACHE_HOURS: '169' }, { MUSE_DATA_FANQIE_REQUEST_INTERVAL_MS: '0' }, { MUSE_DATA_FANQIE_DETAIL_BUDGET: '20001' }, { MUSE_DATA_FANQIE_LATEST_CATEGORIES_PER_CYCLE: '0' }, { MUSE_DATA_FANQIE_LATEST_CATEGORIES_PER_CYCLE: '101' }]) expect(() => resolveConfig(values)).toThrow();
  });

  it('retains SSR detail parsing without guessed descriptions or dates', () => {
    const page = parseFanqieDetail(state({ page: { ...detail().data, hasFetch: true, creationStatus: 'unknown', abstract: '\ue410encoded', thumbUrl: 'http://invalid.example/cover' } }), bookId());
    expect(page.status).toBeNull(); expect(page.description).toBe(''); expect(page.coverUrl).toBeNull();
  });
});
