import { createCipheriv, createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { createQimaoApiNovelSource, type QimaoApiNovelOptions } from '../src/server/novels/qimao-api.ts';
import type { Work } from '../src/shared/types.ts';

const origin = 'https://www.qimao.com';
const apiBc = 'https://api-bc.wtzw.com';
const apiKs = 'https://api-ks.wtzw.com';
const sourceId = '12647139';
const zipUrl = 'https://cdn.wtzw.com/bookimg/shuku/book_download/d8/12647139_2.zip';
const observedAt = '2026-11-15T00:00:00.000Z';
const signKey = 'd3dGiJc651gSQ8w1';
const cipherKey = Buffer.from('32343263636238323330643730396531', 'hex');
const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const appHeaders: Record<string, string> = { AUTHORIZATION: '', 'app-version': '73720', 'application-id': 'com.****.reader',
  channel: 'unknown', 'net-env': '1', platform: 'android', 'qm-params': '', reg: '0' };
const appHeaderKeys = ['AUTHORIZATION', 'app-version', 'application-id', 'channel', 'net-env', 'platform', 'qm-params', 'reg'];
const rawTexts: Record<string, string> = { '5001': '这是第一章的测试正文。\n第二段内容。',
  '5002': '<p>第一段&amp;内容</p>\n<p>第二段</p>', '5003': '第三段正文。' };
const expectedTexts: Record<string, string> = { '5001': '这是第一章的测试正文。\n\n第二段内容。',
  '5002': '第一段&内容\n\n第二段', '5003': '第三段正文。' };

function md5(value: string): string { return createHash('md5').update(value).digest('hex'); }
function expectedSign(values: Readonly<Record<string, string>>): string {
  return md5(Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('') + signKey);
}
function signal(): AbortSignal { return new AbortController().signal; }

function encrypt(text: string): string {
  const cipher = createCipheriv('aes-128-cbc', cipherKey, iv);
  return Buffer.concat([iv, cipher.update(Buffer.from(text, 'utf-8')), cipher.final()]).toString('base64');
}
function archiveOf(files: Record<string, Uint8Array>): Uint8Array { return zipSync(files); }
function encryptedArchive(texts: Record<string, string>): Uint8Array {
  return archiveOf(Object.fromEntries(Object.entries(texts).map(([id, text]) => [`${id}.txt`, strToU8(encrypt(text))])));
}

function makeWork(id = sourceId): Work {
  return { id: `qimao:${id}`, sourceId: id, platform: 'qimao', kind: 'novel', origin: 'live', title: '测试七猫小说', author: '测试作者',
    sourceUrl: `${origin}/shuku/${id}/`, description: '简介不能当作正文', coverUrl: null, tags: [], category: '', episodeCount: null,
    wordCount: null, serialStatus: '连载中', publishedAt: null, metrics: [], rank: null, rankChange: null, board: '', observedAt,
    sourceUpdatedAt: null };
}
function workWith(overrides: Partial<Work>): Work { return { ...makeWork(), ...overrides } as Work; }

function baseRows(): Record<string, unknown>[] {
  return [
    { id: '5001', index: '1', title: '第1章 开端', words: '17', chapter_sort: 1, content_md5: '0'.repeat(32) },
    { id: '5002', index: '2', title: '第2章 冲突', words: '9', chapter_sort: 2, content_md5: '0'.repeat(32) },
    { id: '5003', index: '3', title: '第3章 收束', words: '6', chapter_sort: 3, content_md5: '0'.repeat(32) },
  ];
}
function baseBook(apiNumber = sourceId): Record<string, unknown> {
  return { id: apiNumber, title: '测试七猫小说', author: '测试作者', is_over: '0', chapters: '3', latest_chapter_id: '5003',
    latest_chapter_title: '第3章 收束', update_time: '1794619625', source_id: '14' };
}
function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) } });
}
/** Simulates fetch having decoded a compressed JSON body; its content-length describes the encoded bytes. */
function decodedGzipJson(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', 'content-length': '37' } });
}

interface MockOptions {
  apiNumber?: string;
  book?: Record<string, unknown> | null;
  rows?: Record<string, unknown>[];
  detail?: unknown;
  list?: unknown;
  download?: unknown;
  zip?: Uint8Array;
  zipStatus?: number;
  zipContentLength?: string | null;
  zipContentType?: string;
  apiGzip?: boolean;
}

function mockSource(options: MockOptions = {}, limits: Partial<QimaoApiNovelOptions> = {}) {
  const apiNumber = options.apiNumber ?? sourceId;
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const encode = options.apiGzip ? decodedGzipJson : json;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.origin === apiBc && url.pathname === '/api/v4/book/detail') return encode(options.detail
      ?? { data: { id: apiNumber, type: '0', title: '测试七猫小说',
        book: options.book === null ? null : { ...baseBook(apiNumber), ...(options.book ?? {}) } } });
    if (url.origin === apiKs && url.pathname === '/api/v1/chapter/chapter-list') return encode(options.list
      ?? { data: { id: apiNumber, chapter_lists: options.rows ?? baseRows() } });
    if (url.origin === apiBc && url.pathname === '/api/v1/book/download') return encode(options.download
      ?? { data: { id: apiNumber, link: zipUrl, list: null, type: 'books' } });
    if (url.hostname === 'cdn.wtzw.com' && url.pathname === new URL(zipUrl).pathname) {
      const bytes = options.zip ?? encryptedArchive(rawTexts);
      const headers: Record<string, string> = { 'content-type': options.zipContentType ?? 'application/zip' };
      if (options.zipContentLength !== null) headers['content-length'] = options.zipContentLength ?? String(bytes.byteLength);
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new Response(body, { status: options.zipStatus ?? 200, headers });
    }
    return new Response('unexpected request', { status: 404 });
  });
  const adapter = createQimaoApiNovelSource({ fetch: fetchImpl, requestIntervalMs: 100, now: () => new Date(observedAt), ...limits });
  return { adapter, fetchImpl, calls };
}

function expectSignature(call: { url: URL; init?: RequestInit }): void {
  const params = Object.fromEntries(call.url.searchParams) as Record<string, string>;
  const provided = params.sign;
  delete params.sign;
  expect(provided).toBe(expectedSign(params));
  const headers = call.init?.headers as Record<string, string>;
  expect(headers.sign).toBe(expectedSign(Object.fromEntries(appHeaderKeys.map(key => [key, headers[key]!]))));
  for (const key of appHeaderKeys) expect(headers[key]).toBe(appHeaders[key]);
  expect(call.init?.redirect).toBe('error');
  expect(call.init?.credentials).toBe('omit');
}

describe('Qimao app-API original source', () => {
  it('builds a verified directory from the signed app detail and chapter list', async () => {
    const { adapter, calls } = mockSource();
    const directory = await adapter.directory(makeWork(), signal());
    expect(directory).toEqual({ workId: `qimao:${sourceId}`, sourceId, platform: 'qimao', title: '测试七猫小说', author: '测试作者',
      sourceUrl: `${origin}/shuku/${sourceId}/`, observedAt, declaredChapterCount: 3, finished: false, chapters: [
        { id: '5001', index: 1, title: '第1章 开端', sourceUrl: `${origin}/shuku/${sourceId}-5001/`, wordCount: 17, sourceUpdatedAt: null },
        { id: '5002', index: 2, title: '第2章 冲突', sourceUrl: `${origin}/shuku/${sourceId}-5002/`, wordCount: 9, sourceUpdatedAt: null },
        { id: '5003', index: 3, title: '第3章 收束', sourceUrl: `${origin}/shuku/${sourceId}-5003/`, wordCount: 6, sourceUpdatedAt: null },
      ] });
    expect(calls.map(call => `${call.url.host}${call.url.pathname}`)).toEqual(['api-bc.wtzw.com/api/v4/book/detail',
      'api-ks.wtzw.com/api/v1/chapter/chapter-list']);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ id: sourceId, imei_ip: '2937357107', teeny_mode: '0' });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toMatchObject({ chapter_ver: '0', id: sourceId });
    expect(calls[0]!.init?.headers).toMatchObject({ 'user-agent': 'okhttp/3.12.0', accept: 'application/json', 'accept-encoding': 'identity' });
    calls.forEach(expectSignature);
    await adapter.release?.(directory);
  });

  it('accepts a fetch-decoded compressed body whose content-length describes encoded bytes', async () => {
    const { adapter, calls } = mockSource({ apiGzip: true });
    const directory = await adapter.directory(makeWork(), signal());
    expect(directory.chapters).toHaveLength(3);
    expect(calls.length).toBe(2);
    await adapter.release?.(directory);
  });

  it('strips the web _0 suffix for the app identity while preserving the declared work identity', async () => {
    const declared = '14136744_0', apiNumber = '14136744';
    const { adapter, calls } = mockSource({ apiNumber });
    const directory = await adapter.directory(makeWork(declared), signal());
    expect(directory).toMatchObject({ workId: `qimao:${declared}`, sourceId: declared, sourceUrl: `${origin}/shuku/${declared}/` });
    expect(directory.chapters[0]).toMatchObject({ sourceUrl: `${origin}/shuku/${declared}-5001/` });
    expect(calls.map(call => call.url.searchParams.get('id'))).toEqual([apiNumber, apiNumber]);
    calls.forEach(expectSignature);
    await adapter.release?.(directory);
  });

  it('sorts by chapter_sort and maps optional words and epoch update times', async () => {
    const rows = [
      { id: '5003', index: '3', title: '第3章 收束', chapter_sort: 30, words: '6' },
      { id: '5001', index: '1', title: '第1章 开端', chapter_sort: 10, words: 17, update_time: 1794619000 },
      { id: '5002', index: '2', title: '第2章 冲突', chapter_sort: 20 },
    ];
    const { adapter } = mockSource({ rows });
    const directory = await adapter.directory(makeWork(), signal());
    expect(directory.chapters.map(chapter => [chapter.id, chapter.index, chapter.wordCount]))
      .toEqual([['5001', 1, 17], ['5002', 2, null], ['5003', 3, 6]]);
    expect(directory.chapters[0]!.sourceUpdatedAt).toBe(new Date(1_794_619_000_000).toISOString());
    expect(directory.chapters[1]!.sourceUpdatedAt).toBeNull();
    await expect(adapter.chapter(directory, directory.chapters[1]!, signal())).resolves.toBe(expectedTexts['5002']);
    await adapter.release?.(directory);
  });

  it('reports app error envelopes as unavailable without forwarding server-authored text', async () => {
    const detailError = mockSource({ detail: { errors: { id: '0', code: '12010101', level: '1', title: '书籍已下架', details: '书籍已下架' } } });
    const unavailable = await detailError.adapter.directory(makeWork(), signal()).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ code: 'unavailable', message: '七猫该书已下架，原文当前不可用' });
    expect((unavailable as Error).message).not.toContain('书籍已下架，书籍已下架');
    expect(detailError.calls).toHaveLength(1);

    const genericError = mockSource({ detail: { errors: { code: '44010102', title: '参数错误' } } });
    await expect(genericError.adapter.directory(makeWork(), signal())).rejects.toMatchObject({ code: 'unavailable',
      message: '七猫书籍详情接口暂不可用' });

    const listError = mockSource({ list: { errors: { id: '0', code: '12010101', title: '书籍信息获取失败' } } });
    await expect(listError.adapter.directory(makeWork(), signal())).rejects.toMatchObject({ code: 'unavailable',
      message: '七猫章节目录接口暂不可用' });
    expect(listError.calls).toHaveLength(2);
  });

  it.each([
    { detail: { data: { id: sourceId } } },
    { detail: { data: { id: sourceId, book: null } } },
    { detail: { data: { id: sourceId, book: [] } } },
    { list: { data: { id: sourceId } } },
    { list: { data: { id: sourceId, chapter_lists: [] } } },
    { list: { data: { id: sourceId, chapter_lists: 'nope' } } },
  ])('rejects missing or empty app directory payloads as invalid source: %j', async options => {
    const { adapter } = mockSource(options);
    await expect(adapter.directory(makeWork(), signal())).rejects.toMatchObject({ code: 'invalid_source' });
  });

  it.each([
    { book: { id: '12647140' } },
    { book: { title: '' } },
    { book: { title: '   ' } },
    { book: { is_over: '2' } },
    { book: { chapters: '2' } },
    { book: { latest_chapter_id: '9999' } },
    { book: { latest_chapter_title: '第9章 不存在' } },
    { list: { data: { id: '999', chapter_lists: baseRows() } } },
    { rows: baseRows().map((row, index) => index === 1 ? { ...row, id: '5001' } : row) },
    { rows: baseRows().map((row, index) => index === 2 ? { ...row, index: '2' } : row) },
    { rows: baseRows().map((row, index) => index === 1 ? { ...row, chapter_sort: 1 } : row) },
    { rows: baseRows().map((row, index) => index === 1 ? { ...row, title: ' ' } : row) },
  ])('rejects wrong book, count, uniqueness or order in the app directory: %j', async options => {
    const { adapter } = mockSource(options as MockOptions);
    await expect(adapter.directory(makeWork(), signal())).rejects.toMatchObject({ code: 'invalid_source' });
  });

  it('decrypts the whole archive lazily once, converts markup and returns each requested chapter', async () => {
    const { adapter, calls } = mockSource();
    const directory = await adapter.directory(makeWork(), signal());
    expect(calls).toHaveLength(2);
    expect(await adapter.chapter(directory, directory.chapters[0]!, signal())).toBe(expectedTexts['5001']);
    expect(calls).toHaveLength(4);
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toMatchObject({ id: sourceId, source: '1', type: '2', is_vip: '1' });
    expect(calls[3]!.url.href).toBe(zipUrl);
    expect(calls[3]!.init?.headers).toMatchObject({ 'user-agent': 'okhttp/3.12.0' });
    expect(calls[3]!.init?.headers).not.toHaveProperty('cookie');
    expect(await adapter.chapter(directory, directory.chapters[1]!, signal())).toBe(expectedTexts['5002']);
    const copied = structuredClone(directory);
    expect(await adapter.chapter(copied, copied.chapters[2]!, signal())).toBe(expectedTexts['5003']);
    expect(calls).toHaveLength(4);
    [calls[0]!, calls[1]!, calls[2]!].forEach(expectSignature);
    await adapter.release?.(directory);
  });

  it('loads the archive only once for concurrent chapter reads', async () => {
    const { adapter, calls } = mockSource();
    const directory = await adapter.directory(makeWork(), signal());
    const [first, second] = await Promise.all([adapter.chapter(directory, directory.chapters[0]!, signal()),
      adapter.chapter(directory, directory.chapters[1]!, signal())]);
    expect([first, second]).toEqual([expectedTexts['5001'], expectedTexts['5002']]);
    expect(calls).toHaveLength(4);
    await adapter.release?.(directory);
  });

  it('removes embedded documents, decodes entities and strips control characters', async () => {
    const rows = baseRows();
    rows[0] = { ...rows[0]!, words: '2' };
    rows[2] = { ...rows[2]!, words: '4' };
    const zip = encryptedArchive({ '5001': '<style>.hidden{}</style><p>正文</p><iframe src="x">frame</iframe>',
      '5002': rawTexts['5002']!, '5003': '正文\u0001内容' });
    const { adapter } = mockSource({ rows, zip });
    const directory = await adapter.directory(makeWork(), signal());
    expect(await adapter.chapter(directory, directory.chapters[0]!, signal())).toBe('正文');
    expect(await adapter.chapter(directory, directory.chapters[2]!, signal())).toBe('正文内容');
    await adapter.release?.(directory);
  });

  it.each([
    { name: 'missing chapter', zip: encryptedArchive({ '5001': rawTexts['5001']!, '5002': rawTexts['5002']! }) },
    { name: 'extra chapter', zip: encryptedArchive({ ...rawTexts, '5004': '多余正文。' }) },
    { name: 'unexpected file', zip: archiveOf({ '5001.txt': strToU8(encrypt(rawTexts['5001']!)), '5002.txt': strToU8(encrypt(rawTexts['5002']!)),
      '5003.txt': strToU8(encrypt(rawTexts['5003']!)), 'README.txt': strToU8('junk') }) },
    { name: 'short chapter', rows: baseRows().map((row, index) => index === 0 ? { ...row, words: '18' } : row) },
    { name: 'empty chapter', zip: encryptedArchive({ '5001': rawTexts['5001']!, '5002': rawTexts['5002']!, '5003': '' }) },
    { name: 'invalid base64', zip: archiveOf({ '5001.txt': strToU8('not!base64'), '5002.txt': strToU8(encrypt(rawTexts['5002']!)),
      '5003.txt': strToU8(encrypt(rawTexts['5003']!)) }) },
    { name: 'invalid ciphertext', zip: archiveOf({ '5001.txt': strToU8(Buffer.alloc(48, 7).toString('base64')),
      '5002.txt': strToU8(encrypt(rawTexts['5002']!)), '5003.txt': strToU8(encrypt(rawTexts['5003']!)) }) },
    { name: 'not an archive', zip: strToU8('this is not a zip') },
  ])('rejects an inconsistent whole-book archive as invalid source: $name', async options => {
    const { adapter } = mockSource(options as MockOptions);
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it('rejects an archive whose declared chapter bytes exceed the decode budget', async () => {
    const oversized = encryptedArchive({ '5001': '字'.repeat(900), '5002': rawTexts['5002']!, '5003': rawTexts['5003']! });
    const { adapter } = mockSource({ zip: oversized }, { maxUncompressedBytes: 1024 });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it('bounds the returned chapter text independently from the archive byte limits', async () => {
    const { adapter } = mockSource({}, { maxChapterBytes: 8 });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it.each([
    { name: 'missing link', download: { data: { id: sourceId } } },
    { name: 'null link', download: { data: { id: sourceId, link: null } } },
    { name: 'download error', download: { errors: { code: '44010122', title: '全本下载失败' } } },
  ])('reports a missing whole-book cache package as unavailable: $name', async options => {
    const { adapter, calls } = mockSource(options as MockOptions);
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'unavailable',
      message: '七猫暂未生成该书的全本缓存包' });
    expect(calls).toHaveLength(3);
    await adapter.release?.(directory);
  });

  it('rejects a cache package advertised for a different book identity', async () => {
    const { adapter } = mockSource({ download: { data: { id: '999', link: zipUrl } } });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it.each(['http://cdn.wtzw.com/book.zip', 'https://evil.example/book.zip', 'https://cdn.wtzw.com.evil.example/book.zip',
    'https://cdn.wtzw.com:8443/book.zip', 'https://user:pass@cdn.wtzw.com/book.zip', 'not a url'])(
  'rejects an off-whitelist cache link before any download: %s', async link => {
    const { adapter, calls } = mockSource({ download: { data: { id: sourceId, link } } });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(calls).toHaveLength(3);
    await adapter.release?.(directory);
  });

  it.each([
    { name: 'server error', options: { zipStatus: 500 } },
    { name: 'declared oversize', options: { zipContentLength: '999999999' } },
    { name: 'wrong content type', options: { zipContentType: 'text/html' } },
    { name: 'truncated download', options: { zipContentLength: '999999' } },
  ])('reports an unavailable whole-book download: $name', async ({ options }) => {
    const { adapter } = mockSource(options as MockOptions);
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'unavailable' });
    await adapter.release?.(directory);
  });

  it('bounds the downloaded archive bytes even without a declared length', async () => {
    const padded = encryptedArchive({ '5001': '字'.repeat(2000), '5002': rawTexts['5002']!, '5003': rawTexts['5003']! });
    const { adapter } = mockSource({ zip: padded, zipContentLength: null }, { maxArchiveBytes: 1024 });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'unavailable' });
    await adapter.release?.(directory);
  });

  it('rejects a chapter whose normalized body is shorter than the declared words elsewhere in the archive', async () => {
    const zip = encryptedArchive({ '5001': rawTexts['5001']!, '5002': '短文。', '5003': rawTexts['5003']! });
    const { adapter } = mockSource({ zip });
    const directory = await adapter.directory(makeWork(), signal());
    await expect(adapter.chapter(directory, directory.chapters[2]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    await adapter.release?.(directory);
  });

  it('binds reads to the retained directory and clears cached text on release', async () => {
    const { adapter, calls } = mockSource();
    const directory = await adapter.directory(makeWork(), signal());
    await adapter.chapter(directory, directory.chapters[0]!, signal());
    expect(calls).toHaveLength(4);
    await expect(adapter.chapter(directory, { ...directory.chapters[0]!, title: '第1章 篡改' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_source' });
    await expect(adapter.chapter({ ...directory, sourceId: '999' }, directory.chapters[0]!, signal()))
      .rejects.toMatchObject({ code: 'invalid_source' });
    await expect(adapter.chapter(directory, directory.chapters[0]!, AbortSignal.abort(new Error('Stopped')))).rejects.toThrow('Stopped');
    expect(calls).toHaveLength(4);
    await adapter.release?.(directory);
    await expect(adapter.chapter(directory, directory.chapters[0]!, signal())).rejects.toMatchObject({ code: 'invalid_source' });
    expect(calls).toHaveLength(4);
    const again = await adapter.directory(makeWork(), signal());
    expect(await adapter.chapter(again, again.chapters[2]!, signal())).toBe(expectedTexts['5003']);
    expect(calls).toHaveLength(8);
    await adapter.release?.(again);
  });

  it('rejects invalid work identity before any network access', async () => {
    const rejections: Partial<Work>[] = [{ platform: 'fanqie' }, { kind: 'drama' }, { origin: 'demo' }, { id: 'qimao:999' },
      { id: 'qimao:12647139 ' }, { sourceUrl: 'https://evil.example/shuku/12647139/' },
      { sourceUrl: 'https://www.qimao.com/shuku/12647139' }, { sourceId: 'abc' }, { sourceId: '12647139_1' },
      { sourceId: '1'.repeat(25) }];
    for (const overrides of rejections) {
      const { adapter, fetchImpl } = mockSource();
      await expect(adapter.directory(workWith(overrides), signal())).rejects.toMatchObject({ code: 'invalid_source' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects unsafe pacing and byte limits at construction', () => {
    expect(() => createQimaoApiNovelSource({ requestIntervalMs: 99 })).toThrow();
    expect(() => createQimaoApiNovelSource({ requestIntervalMs: 60_001 })).toThrow();
    expect(() => createQimaoApiNovelSource({ requestTimeoutMs: 50 })).toThrow();
    expect(() => createQimaoApiNovelSource({ maxArchiveBytes: 10 })).toThrow();
    expect(() => createQimaoApiNovelSource({ maxChapterBytes: 0 })).toThrow();
    expect(createQimaoApiNovelSource().platform).toBe('qimao');
  });

  it('paces app API requests by the configured interval', async () => {
    const { adapter } = mockSource({}, { requestIntervalMs: 100 });
    const started = Date.now();
    await adapter.directory(makeWork(), signal());
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it('honours caller cancellation and maps request timeouts to unavailable', async () => {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      const target = init?.signal;
      if (!target) { reject(new Error('missing signal')); return; }
      target.addEventListener('abort', () => reject(target.reason), { once: true });
    });
    const controller = new AbortController();
    const aborted = createQimaoApiNovelSource({ fetch: hanging, requestIntervalMs: 100, requestTimeoutMs: 10_000 });
    const running = aborted.directory(makeWork(), controller.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(new Error('Stopped'));
    await expect(running).rejects.toThrow('Stopped');
    const timedOut = createQimaoApiNovelSource({ fetch: hanging, requestIntervalMs: 100, requestTimeoutMs: 100 });
    await expect(timedOut.directory(makeWork(), signal())).rejects.toMatchObject({ code: 'unavailable' });
  });
});
