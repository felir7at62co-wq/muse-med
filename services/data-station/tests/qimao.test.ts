import { describe, expect, it, vi } from 'vitest';
import { collectQimao } from '../src/server/collectors/qimao.ts';
import { bookId, parseMetric, parseRankingApi, rankingPageConfig } from '../src/server/collectors/qimao/parser.js';
import { metadataUrl, rankingApiPath, readMetadata } from '../src/server/collectors/qimao/transport.js';

const observedAt = '2026-11-13T06:00:00.000Z';
const longId = '9000000000000001234';
const labels: Record<string, string> = { hot: '大热榜', new: '新书榜', over: '完结榜', collect: '收藏榜', update: '更新榜' };

interface FixtureOptions {
  channel?: string; board?: string; period?: string; id?: string; heat?: string;
  wrongBoard?: boolean; rank?: number; total?: number; month?: string; ids?: string[];
}
function fixture({ channel = 'boy', board = 'hot', period = 'date', id = longId, heat = '123.4 万 热度', wrongBoard = false, rank = 1, total = 1, month = '2026-10', ids = [id] }: FixtureOptions = {}): string {
  return `<!doctype html><title>七猫公开排行榜</title>
    <div class="qm-switch-tab"><span class="item active">${channel === 'boy' ? '男生榜' : '女生榜'}</span></div>
    <div class="child-tabs-item active"><a href="/paihang/${channel}/${wrongBoard ? 'over' : board}/date/">${labels[wrongBoard ? 'over' : board]}</a></div>
    <div class="date-type-tabs"><a class="tab active" href="/paihang/${channel}/${board}/${period}/">${period === 'date' ? '日榜' : '月榜'}</a></div>
    <ol class="rank-list">${ids.map((id, index) => `<li class="rank-list-item"><span class="rank-number">${rank + index}</span>
      <a class="s-book-title" href="https://www.qimao.com/shuku/${id}/">山河样例</a>
      <img src="https://cdn.qimao.com/bookimg/example.jpg">
      <div class="s-book-info"><a href="https://www.qimao.com/zuozhe/example/">样例作者</a><a href="https://www.qimao.com/shuku/a-1/">年代</a> 连载中 12.3万字</div>
      <p class="s-book-intro">只采公开作品简介</p><div class="s-book-update">2026-11-12 08:00:00</div>
      <div class="other-info">${heat}</div></li>`).join('')}</ol>
      <script>window.__NUXT__=(function(){return {pageConfig:{count:"${total}",page:"1",page_size:"20",data_month:"${month}"}};}());</script>
      <script>throw new Error('NEVER_EXECUTE')</script><div class="chapter-body">NEVER_RETURN_CHAPTER</div>`;
}

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function apiRow(id = longId, heat = '123.4') {
  return {
    book_id: id, title: '山河样例', book_url: `https://www.qimao.com/shuku/${id}/`,
    author: '样例作者', category1_name: '年代', category2_name: '年代重生', is_over: '0',
    words_num: '12.3万字', intro: '只采公开作品简介', update_time: '2026-11-12 08:00:00',
    image_link: 'https://cdn.qimao.com/bookimg/example.jpg', number: heat, unit: heat ? '万' : '',
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function apiBody(ids = [longId], page = 1, total = ids.length, month = '2026-10') {
  return { data: { table_data: ids.map(id => apiRow(id)), page_data: { count: String(total), page: String(page), page_size: '20', data_month: month } } };
}

function singleSource(options: Parameters<typeof fixture>[0] = {}): typeof fetch {
  return async value => new URL(String(value)).pathname.startsWith('/paihang/') ? html(fixture(options)) : json(apiBody());
}

const hundredIds = Array.from({ length: 100 }, (_, index) => (BigInt(longId) + BigInt(index)).toString());
function pagedSource(mutate?: (body: ReturnType<typeof apiBody>, page: number) => void, total = 100): typeof fetch {
  return async value => {
    const url = new URL(String(value));
    if (url.pathname.startsWith('/paihang/')) return html(fixture({ ids: hundredIds.slice(0, Math.min(20, total)), total }));
    const page = Number(url.searchParams.get('page'));
    const body = apiBody(hundredIds.slice((page - 1) * 20, Math.min(page * 20, total)), page, total);
    mutate?.(body, page);
    return json(body);
  };
}

describe('Qimao public ranking integration', () => {
  it('keeps cover, identity, words, labels and raw update time without fabricating readers or publication', async () => {
    const result = await collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], now: () => new Date(observedAt), fetch: singleSource() });
    expect(result.works).toHaveLength(1);
    expect(result.works[0]).toMatchObject({
      id: `qimao:${longId}`, sourceId: longId, origin: 'live', kind: 'novel', author: '样例作者',
      coverUrl: 'https://cdn.qimao.com/bookimg/example.jpg', wordCount: 123_000, publishedAt: null,
      sourceUpdatedAt: '2026-11-12 08:00:00', board: '男生榜 · 大热榜 · 日榜', observedAt,
    });
    expect(result.works[0]?.metrics).toEqual([
      { key: 'heat', label: '热度', value: 1_234_000 },
      { key: 'cumulativePopularity', label: '累计人气值', value: null },
      { key: 'readOccurrences', label: '次阅读', value: null },
      { key: 'currentReaders', label: '在读人数', value: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('NEVER_');
    expect(result.coverage).toContain('完整公开分页');
  });

  it('requests sixteen official selections and validates their JSON first pages', async () => {
    const urls: string[] = [];
    const result = await collectQimao({ requestIntervalMs: 0, fetch: async value => {
      const url = new URL(String(value)); urls.push(url.href);
      if (url.pathname.startsWith('/paihang/')) {
        const [, , channel, board, period] = url.pathname.split('/');
        return html(fixture({ channel, board, period }));
      }
      return json(apiBody());
    } });
    expect(urls).toHaveLength(32);
    expect(urls.filter(url => url.includes('/paihang/'))).toHaveLength(16);
    expect(urls.filter(url => url.includes('/qimaoapi/api/rank/'))).toHaveLength(16);
    expect(result.works).toHaveLength(16);
    expect(new Set(result.works.map(work => work.board)).size).toBe(16);
    expect(new Set(result.works.map(work => work.sourceId)).size).toBe(1);
    expect(result.works.map(work => work.board)).toContain('男生榜 · 新书榜');
    expect(result.works.map(work => work.board)).toContain('女生榜 · 完结榜 · 月榜');
    expect(result.works.filter(work => work.board.endsWith('月榜')).every(work => work.sourceUpdatedAt?.startsWith('榜期 2026-10；作品更新 '))).toBe(true);
  });

  it('collects official positions 1 to 100, keeps long IDs exact and pins later requests to the declared month', async () => {
    const fetchPage = vi.fn(pagedSource());
    const result = await collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestIntervalMs: 0, fetch: fetchPage });
    expect(result.works.map(work => work.rank)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(result.works.map(work => work.sourceId)).toEqual(hundredIds);
    expect(result.coverage).toContain('100/100');
    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(fetchPage.mock.calls.slice(1).map(call => new URL(String(call[0])).searchParams.get('date'))).toEqual(Array(5).fill('202610'));
  });

  it('accepts a shorter declared board with a complete partial last page', async () => {
    const result = await collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestIntervalMs: 0, fetch: pagedSource(undefined, 47) });
    expect(result.works).toHaveLength(47);
    expect(result.works.at(-1)?.rank).toBe(47);
    expect(result.coverage).toContain('47/47');
  });

  it('rejects a JSON first page that belongs to a different displayed ranking', async () => {
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestIntervalMs: 0,
      fetch: pagedSource((body, page) => { if (page === 1) body.data.table_data.reverse(); }) })).rejects.toThrow(/ranking_identity_mismatch/);
  });

  it('rejects repeated pages, changed counts or months, missing positions and repeated cross-page identities', async () => {
    const mutations: Array<(body: ReturnType<typeof apiBody>) => void> = [
      body => { body.data.page_data.page = '1'; },
      body => { body.data.page_data.count = '99'; },
      body => { body.data.page_data.data_month = '2026-11'; },
      body => { body.data.page_data.page_size = '10'; },
      body => { body.data.table_data.pop(); },
      body => { body.data.table_data[0] = apiRow(hundredIds[0]!); },
    ];
    for (const mutate of mutations) {
      await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestIntervalMs: 0,
        fetch: pagedSource((body, page) => { if (page === 2) mutate(body); }) })).rejects.toThrow(/pagination_mismatch|duplicate_book_identity/);
    }
  });

  it('rejects malformed API book identities and metadata without using numeric ID coercion', () => {
    const metadata = { channel: 'boy', board: 'hot', period: 'date', sourceUrl: 'https://www.qimao.com/paihang/boy/hot/date/', fetchedAt: observedAt } as const;
    const paging = { page: 1, pageSize: 20, total: 1, month: '2026-10' };
    for (const row of [{ ...apiRow(), book_id: Number(longId) }, { ...apiRow(), book_url: 'https://evil.example/shuku/123/' }, { ...apiRow(), title: '' }]) {
      expect(() => parseRankingApi(JSON.stringify({ data: { ...apiBody().data, table_data: [row] } }), metadata, paging)).toThrow();
    }
    expect(() => rankingPageConfig(fixture({ total: 101 }))).toThrow(/page count/);
    expect(() => rankingPageConfig(fixture({ month: '2026-13' }))).toThrow();
  });

  it('reads Nuxt primitive aliases for count and page size without executing the state expression', () => {
    const body = '<script>window.__NUXT__=(function(a,b,c,d){return {pageConfig:{count:a,page:b,page_size:c,data_month:d},other:NEVER_EXECUTE()};}("100","1","20","2026-10"));</script>';
    expect(rankingPageConfig(body)).toEqual({ total: 100, pageSize: 20, month: '2026-10' });
    expect(() => rankingPageConfig(body.replace('"100","1","20"', 'NEVER_EXECUTE(),"1","20"'))).toThrow();
  });

  it('only generates the observed API path and refuses unavailable monthly boards or extra URL parameters', async () => {
    expect(rankingApiPath({ channel: 'girl', board: 'over', period: 'month', page: 5, month: '202610' })).toBe('/qimaoapi/api/rank/book-list?is_girl=1&rank_type=3&date_type=2&date=202610&page=5');
    expect(() => rankingApiPath({ channel: 'boy', board: 'collect', period: 'month', page: 1 })).toThrow();
    for (const [page, month] of [[6, '202610'], [1, '202613'], [1, '202610&token=secret']] as const) expect(() => rankingApiPath({ channel: 'boy', board: 'hot', period: 'date', page, month })).toThrow();
    const fetchPage = vi.fn<typeof fetch>();
    await expect(collectQimao({ channels: ['boy'], boards: ['collect'], periods: ['month'], fetch: fetchPage })).rejects.toThrow(/no available/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('requires JSON content type on the fixed ranking API and sends no account credentials', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture())).mockResolvedValueOnce(html('<title>安全验证</title>'));
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestIntervalMs: 0, fetch: fetchPage })).rejects.toThrow(/invalid_content_type/);
    expect(fetchPage.mock.calls.every(call => call[1]?.credentials === 'omit' && call[1]?.redirect === 'error')).toBe(true);
  });

  it('retains missing heat as null and zero heat as zero, without treating collection or update ranks as heat', async () => {
    for (const [heat, expected] of [['', null], ['0', 0]] as const) {
      const result = await collectQimao({ channels: ['boy'], boards: ['new'], periods: ['date'], requestIntervalMs: 0, fetch: async value => {
        if (new URL(String(value)).pathname.startsWith('/paihang/')) return html(fixture({ board: 'new' }));
        const body = apiBody(); body.data.table_data[0] = apiRow(longId, heat);
        return json(body);
      } });
      expect(result.works[0]?.metrics[0]?.value).toBe(expected);
    }
    for (const board of ['collect', 'update'] as const) {
      const result = await collectQimao({ channels: ['boy'], boards: [board], periods: ['date'], requestIntervalMs: 0, fetch: async value => {
        if (new URL(String(value)).pathname.startsWith('/paihang/')) return html(fixture({ board, month: '' }));
        return json(apiBody([longId], 1, 1, ''));
      } });
      expect(result.works[0]?.metrics[0]?.value).toBeNull();
    }
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], fetch: singleSource({ month: '' }) })).rejects.toThrow(/no official month/);
    expect(parseMetric('9万次阅读', '累计人气值', observedAt).value).toBeNull();
  });

  it('rejects wrong selected windows, rank gaps, numeric identities and missing title metadata', async () => {
    for (const body of [fixture({ wrongBoard: true }), fixture({ period: 'month' }), fixture({ rank: 2 }), fixture({ id: 'not-an-id' }), '<title>七猫</title>']) {
      await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], fetch: async () => html(body) })).rejects.toThrow(/七猫采集失败/);
    }
    expect(bookId(longId)).toBe(longId);
    expect(() => bookId('https://evil.example/shuku/123/')).toThrow();
    for (const board of ['new', 'over'] as const) {
      await expect(collectQimao({ channels: ['boy'], boards: [board], periods: ['date'], fetch: singleSource({ board, period: 'month' }) })).rejects.toThrow(/selection_mismatch/);
    }
  });

  it('fails atomically when a later window is denied and does not try to bypass access controls', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture())).mockResolvedValueOnce(json(apiBody())).mockResolvedValueOnce(html('denied', 429));
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], requestIntervalMs: 0, fetch: fetchPage })).rejects.toThrow(/access_blocked/);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('rejects redirects, verification pages and non-HTML bodies', async () => {
    const responses = [html('redirect', 302), html('<title>安全验证</title>'), html('{}', 200, { 'content-type': 'application/json' })];
    for (const response of responses) await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], fetch: async () => response })).rejects.toThrow(/七猫采集失败/);
  });

  it('rejects responses that exceed the byte bound or fail their content-length', async () => {
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], maxResponseBytes: 1024, fetch: async () => html('x'.repeat(1025)) })).rejects.toThrow(/response_too_large/);
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], fetch: async () => html(fixture(), 200, { 'content-length': '1' }) })).rejects.toThrow(/response_length_mismatch/);
  });

  it('respects cancellation and refuses invalid size bounds before network activity', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(collectQimao({ signal, fetch: fetchPage })).rejects.toThrow('cancelled');
    await expect(collectQimao({ maxResponseBytes: 1, fetch: fetchPage })).rejects.toThrow(/maxResponseBytes/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('bounds a transport which does not return before the request deadline', async () => {
    await expect(collectQimao({ channels: ['boy'], boards: ['hot'], periods: ['date'], requestTimeoutMs: 100, fetch: async () => new Promise<Response>(() => {}) })).rejects.toThrow(/请求超时/);
  });

  it('limits header compatibility to known framing errors on the fixed metadata origin', async () => {
    expect(() => metadataUrl('/shuku/123-456/')).toThrow();
    expect(() => metadataUrl('https://evil.example/')).toThrow();
    const legacyRequest = vi.fn().mockResolvedValue(fixture());
    const fetchPage = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' } }));
    const response = await readMetadata('/paihang/boy/hot/date/', { maxResponseBytes: 10_000, allowLegacyResponseHeaders: true }, AbortSignal.timeout(1000), { fetch: fetchPage, legacyRequest });
    expect(response.transport).toBe('https_legacy_headers');
    expect(legacyRequest).toHaveBeenCalledTimes(1);
    await expect(readMetadata('/paihang/boy/hot/date/', { maxResponseBytes: 10_000, allowLegacyResponseHeaders: false }, AbortSignal.timeout(1000), { fetch: fetchPage, legacyRequest })).rejects.toThrow('fetch failed');
    expect(legacyRequest).toHaveBeenCalledTimes(1);
  });

  it('allows the observed folded JSON headers without treating unrelated parser or TLS failures as compatibility cases', async () => {
    const path = rankingApiPath({ channel: 'boy', board: 'hot', period: 'date', page: 1, month: '202610' });
    const legacyRequest = vi.fn().mockResolvedValue(JSON.stringify(apiBody()));
    const error = new TypeError('fetch failed', { cause: { name: 'HTTPParserError', message: 'Response does not match the HTTP/1.1 protocol (Unexpected whitespace after header value)', data: ' content-security-policy: upgrade-insecure-requests\r\n' } });
    const config = { maxResponseBytes: 10_000, allowLegacyResponseHeaders: true };
    expect((await readMetadata(path, config, AbortSignal.timeout(1000), { fetch: async () => { throw error; }, legacyRequest })).transport).toBe('https_legacy_headers');
    for (const cause of [{ name: 'HTTPParserError', message: 'Invalid HTTP status', data: '' }, { code: 'CERT_HAS_EXPIRED' }]) {
      await expect(readMetadata(path, config, AbortSignal.timeout(1000), { fetch: async () => { throw new TypeError('fetch failed', { cause }); }, legacyRequest })).rejects.toThrow('fetch failed');
    }
    expect(legacyRequest).toHaveBeenCalledTimes(1);
  });
});
