import { describe, expect, it, vi } from 'vitest';
import { createQimaoNovelSource } from '../src/server/novels/qimao.ts';
import { createQimaoOriginalReader, originalSourceUrl } from '../src/server/novels/qimao-http.ts';
import { parseQimaoState } from '../src/server/collectors/qimao/state.ts';
import { metadataUrl } from '../src/server/collectors/qimao/transport.js';
import type { Work } from '../src/shared/types.ts';

const origin = 'https://www.qimao.com', bookId = '14136744_0', observedAt = '2026-11-13T12:00:00.000Z';
const body = '来源核验正文第一段。\n\n来源核验正文第二段。';
const fragment = '<p>来源核验正文第一段。</p><p>来源核验正文第二段。</p>';
const work: Work = { id: `qimao:${bookId}`, sourceId: bookId, platform: 'qimao', kind: 'novel', origin: 'live', title: '测试小说', author: '作者',
  sourceUrl: `${origin}/shuku/${bookId}/`, description: '不能把简介当正文', coverUrl: null, tags: [], category: '', episodeCount: null, wordCount: null,
  serialStatus: '连载中', publishedAt: null, metrics: [], rank: null, rankChange: null, board: '', observedAt, sourceUpdatedAt: null };
const signal = () => new AbortController().signal;
function rows() {
  return [1, 2].map(index => ({ id: String(5001 + index), index: String(index), title: `第${index}章 章节标题`, is_vip: '0', words: '20',
    update_time: String(1794468158 + index), chapter_sort: String(index * 10) }));
}
function book() {
  return { book_id: bookId, title: '测试小说', author: '作者', is_over: '0', catalogue_num: '2',
    latest_chapter_id: '5003', latest_chapter_title: '第2章 章节标题', latest_chapter_url: `${origin}/shuku/${bookId}-5003/` };
}
function escape(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function bookHtml(options: { changes?: Record<string, unknown>; mutateScript?: (value: string) => string; domTitle?: string } = {}): string {
  const data = { ...book(), ...options.changes };
  const script = `(function(E,F){E.bookDetail=${JSON.stringify(data)};E.bookIntroData={first_chapter_title:"第1章 章节标题"};E.authorOtherBook=F;F[0]={id:"1"};F[1]={id:"2"};return {state:{common:{bookRelatedInfo:E}},routePath:"/shuku/${bookId}/",error:null};}({},Array(2)))`;
  return `<title>七猫图书信息</title><div class="book-information"><div class="title"><span class="txt">${escape(options.domTitle ?? String(data.title))}</span></div><span class="qm-tag">${data.is_over === '1' ? '完结' : '连载中'}</span></div>
    <a class="author-name">${escape(String(data.author))}</a><script>window.__NUXT__=${options.mutateScript?.(script) ?? script};</script>`;
}
function reader(index = 1) {
  return { state: {
    reader: { currentBookId: bookId, currentChapterId: String(5001 + index), showReaderLimit: false, limitScroll: false,
      bookInfo: { title: '测试小说', author: '作者', chapterTitle: `第${index}章 章节标题` } },
    readerChapterInfo: { chapterInfo: { book_id: bookId, chapter_id: String(5001 + index), book_title: '测试小说', author: '作者',
      title: `第${index}章 章节标题`, index: String(index), words: '20', is_vip: '0', is_over: '0', is_final: index === 2 ? '1' : '0', update_time: '2026-11-13 18:00:00' },
      bookSummary: { book_id: bookId, book_title: '测试小说', author: '作者', is_over: '0' }, chapterData: fragment, showDom: true },
    recommendBookInfo: { chapter: { book_id: '999', chapter_id: '888', is_vip: '1' }, content: '<p>RECOMMEND_ONLY</p>' },
  }, routePath: `/shuku/${bookId}-${5001 + index}/`, error: null };
}
function chapterHtml(options: { index?: number; mutate?: (state: ReturnType<typeof reader>) => void; bodyHtml?: string; title?: string; duplicate?: boolean } = {}): string {
  const index = options.index ?? 1, state = reader(index); options.mutate?.(state);
  const target = `<div class="chapter-detail-wrap"><h2 class="chapter-title">${options.title ?? `第${index}章 章节标题`}</h2><div class="chapter-detail-article">${options.bodyHtml ?? fragment}</div></div>`;
  return `<title>七猫章节阅读</title><p>WHOLE_PAGE_MUST_NOT_RETURN</p>
    <div class="book-recommend"><div class="chapter-detail-wrap"><h2 class="chapter-title">推荐章节</h2><div class="chapter-detail-article"><p>RECOMMEND_ONLY</p></div></div></div>
    ${target}${options.duplicate ? target : ''}<script>window.__NUXT__=(function(){return ${JSON.stringify(state)};}());</script><script>throw new Error('NEVER_EXECUTE');</script>`;
}
function response(text: string, json = false, status = 200): Response { return new Response(text, { status, headers: { 'content-type': json ? 'application/json' : 'text/html' } }); }
function source(options: { book?: Parameters<typeof bookHtml>[0]; rows?: ReturnType<typeof rows>; chapter?: Parameters<typeof chapterHtml>[0] } = {}, limits: Partial<Parameters<typeof createQimaoNovelSource>[0]> = {}) {
  const fetchPage = vi.fn<typeof fetch>().mockImplementation(async value => {
    const url = new URL(String(value));
    if (url.pathname === '/qimaoapi/api/book/chapter-list') return response(JSON.stringify({ data: { chapters: options.rows ?? rows() } }), true);
    if (url.pathname === `/shuku/${bookId}/`) return response(bookHtml(options.book));
    return response(chapterHtml({ index: url.pathname.endsWith('-5003/') ? 2 : 1, ...options.chapter }));
  });
  return { adapter: createQimaoNovelSource({ fetch: fetchPage, requestIntervalMs: 0, now: () => new Date(observedAt), ...limits }), fetchPage };
}

describe('Qimao official original-novel source', () => {
  it('checks exact directory identity and contiguous index while preserving _0 and ignoring chapter_sort as a sequence', async () => {
    const { adapter, fetchPage } = source();
    const directory = await adapter.directory(work, signal());
    expect(directory).toMatchObject({ workId: work.id, sourceId: bookId, platform: 'qimao', observedAt, declaredChapterCount: 2, finished: false });
    expect(directory.chapters.map(chapter => chapter.index)).toEqual([1, 2]);
    expect(directory.chapters[0]).toMatchObject({ id: '5002', wordCount: 20, sourceUpdatedAt: '1794468159', sourceUrl: `${origin}/shuku/${bookId}-5002/` });
    expect(fetchPage.mock.calls.map(([url]) => String(url))).toEqual([work.sourceUrl, `${origin}/qimaoapi/api/book/chapter-list?book_id=${bookId}`]);
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(fetchPage.mock.calls[0]![1]!.headers).not.toHaveProperty('cookie');
    await adapter.release?.(directory);
  });

  it('selects the target state and rendered body even when a different recommended novel appears first', async () => {
    const { adapter, fetchPage } = source(); const directory = await adapter.directory(work, signal());
    const copied = structuredClone(directory);
    expect(await adapter.chapter(copied, copied.chapters[0]!, signal())).toBe(body);
    expect(await adapter.chapter(directory, directory.chapters[1]!, signal())).toBe(body);
    const calls = fetchPage.mock.calls.length;
    await adapter.release?.(copied); await adapter.release?.(directory);
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fetchPage.mock.calls).toHaveLength(calls);
  });

  it.each([
    { book: { changes: { book_id: '14136744' } } }, { book: { changes: { catalogue_num: '3' } } },
    { book: { changes: { latest_chapter_id: '8888' } } }, { book: { domTitle: '错误书名' } },
    { rows: rows().map((row, index) => index ? { ...row, index: '20' } : row) },
    { rows: rows().map(row => ({ ...row, id: '5002' })) }, { rows: rows().slice(0, 1) },
  ])('rejects wrong book, incomplete count, duplicate IDs or missing indices: %j', async options => {
    const { adapter } = source(options); await expect(adapter.directory(work, signal())).rejects.toMatchObject({ code: 'invalid_source' });
  });

  it.each(['is_vip', 'is_lock', 'is_preview'])('rejects restricted directory flag %s rather than fetching free-looking fragments', async field => {
    const values = rows().map((row, index) => index ? { ...row, [field]: '1' } : row);
    const { adapter, fetchPage } = source({ rows: values });
    await expect(adapter.directory(work, signal())).rejects.toMatchObject({ code: 'authorization_required' });
    expect(fetchPage.mock.calls).toHaveLength(2);
  });

  it.each([
    (s: ReturnType<typeof reader>) => { s.state.reader.currentBookId = '999'; },
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterInfo.book_id = '999'; },
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterInfo.chapter_id = '999'; },
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterInfo.index = '10'; },
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterInfo.words = '21'; },
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.bookSummary.book_id = '999'; },
    (s: ReturnType<typeof reader>) => { s.routePath = `/shuku/${bookId}-8888/`; },
  ])('rejects target reader/book/chapter mismatches independently from recommendations', async mutate => {
    const { adapter } = source({ chapter: { mutate } }); const directory = await adapter.directory(work, signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it.each([
    (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterInfo.is_vip = '1'; },
    (s: ReturnType<typeof reader>) => { s.state.reader.showReaderLimit = true; },
  ])('rejects paid, locked and preview reader modes before returning any text', async mutate => {
    const { adapter } = source({ chapter: { mutate } }); const directory = await adapter.directory(work, signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'authorization_required' });
    await adapter.release?.(directory);
  });

  it('does not infer a paywall or book completion from UI scrolling or is_final flags', async () => {
    const { adapter } = source({ chapter: { mutate: state => { state.state.reader.limitScroll = true; state.state.readerChapterInfo.chapterInfo.is_final = '0'; } } });
    const directory = await adapter.directory(work, signal());
    expect(directory.finished).toBe(false);
    expect(await adapter.chapter(directory, directory.chapters[1]!, signal())).toBe(body);
    await adapter.release?.(directory);
    const hidden = source({ chapter: { mutate: state => { state.state.readerChapterInfo.showDom = false; } } });
    const hiddenDirectory = await hidden.adapter.directory(work, signal());
    await expect(hidden.adapter.chapter(hiddenDirectory, hiddenDirectory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await hidden.adapter.release?.(hiddenDirectory);
  });

  it.each([
    { bodyHtml: '<p>短文</p>' }, { title: '错误章节标题' }, { duplicate: true },
    { bodyHtml: '<p>RECOMMEND_ONLY</p>', mutate: (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterData = '<p>RECOMMEND_ONLY</p>'; } },
    { bodyHtml: `<p>${'\uE001'.repeat(30)}</p>`, mutate: (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterData = `<p>${'\uE001'.repeat(30)}</p>`; } },
    { bodyHtml: `<p>${'\uFFFD'.repeat(30)}</p>`, mutate: (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterData = `<p>${'\uFFFD'.repeat(30)}</p>`; } },
    { bodyHtml: `<p>${'\uD800'.repeat(30)}</p>`, mutate: (s: ReturnType<typeof reader>) => { s.state.readerChapterInfo.chapterData = `<p>${'\uD800'.repeat(30)}</p>`; } },
  ])('rejects short, ambiguous, undecoded or mismatched chapter bodies: %j', async options => {
    const { adapter } = source({ chapter: options }); const directory = await adapter.directory(work, signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it('bounds normalized chapter bytes independently from HTTP response bytes', async () => {
    const { adapter } = source({}, { maxChapterBytes: 10 }); const directory = await adapter.directory(work, signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it('rejects changed directory or chapter metadata before network access', async () => {
    const { adapter, fetchPage } = source(); const directory = await adapter.directory(work, signal());
    await expect(adapter.chapter(directory, { ...directory.chapters[0]!, sourceUrl: 'https://evil.example/chapter' }, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(adapter.chapter({ ...directory, sourceId: '14136744' }, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fetchPage.mock.calls).toHaveLength(2); await adapter.release?.(directory);
  });

  it('keeps old metadata endpoints unable to read chapter or full-directory sources', async () => {
    for (const path of [`/shuku/${bookId}-5002/`, `/qimaoapi/api/book/chapter-list?book_id=${bookId}`]) {
      expect(originalSourceUrl(path).origin).toBe(origin); expect(() => metadataUrl(path)).toThrow();
    }
    for (const path of [`https://evil.example/shuku/${bookId}-5002/`, `/shuku/${bookId}-5002/?preview=1`, `/shuku/${bookId}-5002/#x`,
      `/qimaoapi/api/book/chapter-list?book_id=${bookId}&page=2`, '/shuku/14136744_1-5002/', '/shuku/a-a-a-a-a-a-a-click-1/']) expect(() => originalSourceUrl(path)).toThrow();
  });

  it('keeps compatibility requests restricted to observed parser failures and validates cancellation cleanup', async () => {
    const legacyRequest = vi.fn(async () => 'completed-response');
    const defaults = { requestIntervalMs: 0, requestTimeoutMs: 1000, maxResponseBytes: 1024, allowLegacyHeaders: true };
    const error = new TypeError('fetch failed', { cause: { code: 'HPE_INVALID_HEADER_TOKEN' } });
    const path = `/shuku/${bookId}-5002/`;
    expect(await createQimaoOriginalReader({ ...defaults, fetch: async () => { throw error; } }, { legacyRequest })(path, signal())).toBe('completed-response');
    for (const failure of [new Error('TLS failure'), new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } })]) {
      await expect(createQimaoOriginalReader({ ...defaults, fetch: async () => { throw failure; } }, { legacyRequest })(path, signal())).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(createQimaoOriginalReader({ ...defaults, allowLegacyHeaders: false, fetch: async () => { throw error; } }, { legacyRequest })(path, signal())).rejects.toThrow();
    expect(legacyRequest).toHaveBeenCalledTimes(1);
    for (const reply of [response('blocked', false, 403), response('x'.repeat(2048)), response('{}', true)]) {
      await expect(createQimaoOriginalReader({ ...defaults, fetch: async () => reply }, { legacyRequest })(path, signal())).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(legacyRequest).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); let cancelled = false;
    const reader = createQimaoOriginalReader({ ...defaults, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
      cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }) });
    const running = reader(path, abort.signal); await new Promise<void>(resolve => setImmediate(resolve)); abort.abort(new Error('Stopped'));
    await expect(running).rejects.toThrow('Stopped'); expect(cancelled).toBe(true);
  });
});

describe('explicit Qimao literal collection initialization', () => {
  it('allows the observed static collection builder only when explicitly enabled', () => {
    const script = 'window.__NUXT__=(function(E,F){E.chapters=F;F[0]={id:"1"};F[1]={id:"2"};return {book:E};}({},Array(2)));';
    expect(() => parseQimaoState(script)).toThrow();
    expect(parseQimaoState(script, { allowCollectionAliases: true })).toEqual({ book: { chapters: [{ id: '1' }, { id: '2' }] } });
  });

  it.each([
    '(function(Array,E){E.x=Array(1);return E;}({},{}))',
    '(function(F){F[0]={};return F;}(Array(20001)))',
    '(function(F){F[2]={};return F;}(Array(2)))',
    '(function(F){F[0]={};F[0]={};return F;}(Array(1)))',
    '(function(F){F.length=0;return F;}(Array(1)))',
    '(function(F,a){F[a]={};return F;}(Array(1),0))',
    '(function(E){E.x={};E.x={};return E;}({}))',
    '(function(E){E.__proto__={};return E;}({}))',
    '(function(E){E.x=E;return E;}({}))',
    '(function(F){F[0]=F;return F;}(Array(1)))',
    '(function(E){E.x=globalThis.secret;return E;}({}))',
    '(function(E){E.x=fetch("https://evil.example");return E;}({}))',
    '(function(F){return F;}(Array(1)))',
  ])('rejects unsafe initialization without executing it: %s', expression => {
    expect(() => parseQimaoState(`window.__NUXT__=${expression};`, { allowCollectionAliases: true })).toThrow();
  });

  it('rejects exponential alias expansion before returning a graph for consumers', () => {
    const repeated = Array.from({ length: 4000 }, () => 'E').join(',');
    const script = `window.__NUXT__=(function(E){E.text=${JSON.stringify('x'.repeat(5000))};return [${repeated}];}({}));`;
    expect(() => parseQimaoState(script, { allowCollectionAliases: true })).toThrow('expansion');
  });
});
